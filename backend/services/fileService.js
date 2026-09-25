const File = require('../models/File');
const User = require('../models/User');
const Video = require('../models/Video');
const CleanupLog = require('../models/CleanupLog');
const { generateShareToken } = require('../utils/tokenGenerator');
const logger = require('../utils/logger');
const { minioClient, FILES_BUCKET } = require('../config/minio');

const DAILY_UPLOAD_LIMIT = 2;
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

const checkUserUploadLimit = async (userId) => {
  const windowStart = new Date(Date.now() - ROLLING_WINDOW_MS);
  const uploadCount = await File.countDocuments({
    owner: userId,
    uploadedAt: { $gte: windowStart },
    isAdminFile: false,
  });
  return {
    count: uploadCount,
    remaining: Math.max(0, DAILY_UPLOAD_LIMIT - uploadCount),
    limitReached: uploadCount >= DAILY_UPLOAD_LIMIT,
  };
};

// By the time this runs, the upload middleware (see middleware/upload.js)
// has already streamed the file into MinIO and scanned it with ClamAV
// concurrently — this just records the result in Mongo.
const saveFileMetadata = async (fileData, userId, isAdmin) => {
  const expiresAt = isAdmin ? null : new Date(Date.now() + ROLLING_WINDOW_MS);

  const shareToken = await generateUniqueShareToken();

  const file = await File.create({
    owner: userId,
    originalName: fileData.originalname,
    storedName: fileData.filename,
    path: fileData.filename, // MinIO object key within FILES_BUCKET
    mimeType: fileData.mimetype,
    size: fileData.size,
    shareToken,
    expiresAt,
    isAdminFile: isAdmin,
    isViewable: fileData.isViewable,
    uploadedAt: new Date(),
  });

  // Update user storage usage
  await User.findByIdAndUpdate(userId, {
    $inc: { usedStorage: fileData.size },
  });

  logger.info(`File uploaded to MinIO: ${fileData.filename} by user ${userId}, size: ${fileData.size}`);
  return file;
};

const generateUniqueShareToken = async () => {
  let token;
  let exists = true;
  while (exists) {
    token = generateShareToken();
    exists = await File.exists({ shareToken: token });
  }
  return token;
};

const getUserFiles = async (userId, page = 1, limit = 10, search = '') => {
  const query = { owner: userId, isExpired: false };
  const videoQuery = { uploadedBy: userId };

  if (search) {
    query.originalName = { $regex: search, $options: 'i' };
    videoQuery.originalName = { $regex: search, $options: 'i' };
  }

  const [files, videos] = await Promise.all([
    File.find(query).sort({ uploadedAt: -1 }).lean(),
    Video.find(videoQuery).sort({ uploadedAt: -1 }).lean(),
  ]);

  // Files and videos live in separate collections, so merge + sort + paginate in memory
  const combined = [
    ...files.map((f) => ({ ...f, itemType: 'file' })),
    ...videos.map((v) => ({ ...v, itemType: 'video' })),
  ].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

  const total = combined.length;
  const skip = (page - 1) * limit;
  const paged = combined.slice(skip, skip + limit);

  return {
    files: paged,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
};

const getFileByToken = async (shareToken) => {
  const file = await File.findOne({ shareToken, isExpired: false }).populate(
    'owner',
    'name email'
  );

  if (!file) return null;

  if (file.hasExpired()) {
    await markFileExpired(file);
    return null;
  }

  return file;
};

const incrementDownloadCount = async (fileId) => {
  await File.findByIdAndUpdate(fileId, { $inc: { downloadCount: 1 } });
};

const deleteFile = async (fileId, userId, isAdmin = false) => {
  const query = isAdmin ? { _id: fileId } : { _id: fileId, owner: userId };
  const file = await File.findOne(query);

  if (!file) {
    throw Object.assign(new Error('File not found or access denied'), { statusCode: 404 });
  }

  const reason = isAdmin ? 'manual_admin' : 'manual_user';
  await performFileDeletion(file, reason);

  logger.info(`File deleted: ${file.storedName} by ${isAdmin ? 'admin' : 'user'} ${userId}`);
  return file;
};

const performFileDeletion = async (file, reason) => {
  // Delete from MinIO. removeObject is idempotent — it doesn't error if the
  // object is already gone, so this also cleans up cases where a previous
  // delete partially failed.
  let fsStatus = 'success';
  try {
    await minioClient.removeObject(FILES_BUCKET, file.path);
  } catch (err) {
    logger.error(`Failed to delete object from MinIO: ${file.path}`, err);
    fsStatus = 'partial';
  }

  // Update user storage
  await User.findByIdAndUpdate(file.owner, {
    $inc: { usedStorage: -Math.abs(file.size) },
  });

  // Create cleanup log
  await CleanupLog.create({
    fileId: file._id,
    userId: file.owner,
    originalName: file.originalName,
    storedName: file.storedName,
    fileSize: file.size,
    reason,
    status: fsStatus,
    deletedAt: new Date(),
  });

  // Delete MongoDB document
  await File.findByIdAndDelete(file._id);
};

const markFileExpired = async (file) => {
  await File.findByIdAndUpdate(file._id, { isExpired: true });
};

const generateNewShareLink = async (fileId, userId, isAdmin = false) => {
  const query = isAdmin ? { _id: fileId } : { _id: fileId, owner: userId };
  const file = await File.findOne(query);

  if (!file) {
    throw Object.assign(new Error('File not found'), { statusCode: 404 });
  }

  if (file.isExpired) {
    throw Object.assign(new Error('File has expired'), { statusCode: 410 });
  }

  const newToken = await generateUniqueShareToken();
  await File.findByIdAndUpdate(fileId, { shareToken: newToken });

  return newToken;
};

const getUserDashboardData = async (userId) => {
  const now = new Date();
  const windowStart = new Date(Date.now() - ROLLING_WINDOW_MS);
  const todayStart = new Date(now.setHours(0, 0, 0, 0));

  const [user, totalFiles, uploadsToday, uploadsInWindow, totalDownloads, videoStats] = await Promise.all([
    User.findById(userId),
    File.countDocuments({ owner: userId, isExpired: false }),
    File.countDocuments({ owner: userId, uploadedAt: { $gte: todayStart } }),
    File.countDocuments({ owner: userId, uploadedAt: { $gte: windowStart }, isAdminFile: false }),
    File.aggregate([
      { $match: { owner: userId } },
      { $group: { _id: null, total: { $sum: '$downloadCount' } } },
    ]),
    Video.aggregate([
      { $match: { uploadedBy: userId } },
      { $group: { _id: null, total: { $sum: '$size' }, count: { $sum: 1 } } },
    ]),
  ]);

  const [recentFilesRaw, recentVideosRaw] = await Promise.all([
    File.find({ owner: userId, isExpired: false })
      .sort({ uploadedAt: -1 })
      .limit(5)
      .lean(),
    Video.find({ uploadedBy: userId })
      .sort({ uploadedAt: -1 })
      .limit(5)
      .lean(),
  ]);

  const recentFiles = [
    ...recentFilesRaw.map((f) => ({ ...f, itemType: 'file' })),
    ...recentVideosRaw.map((v) => ({ ...v, itemType: 'video' })),
  ]
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .slice(0, 5);

  const totalVideos = videoStats[0]?.count || 0;
  const videoStorageUsed = videoStats[0]?.total || 0;
  const isAdmin = user.role === 'admin';

  return {
    storageUsed: user.usedStorage + videoStorageUsed,
    totalFiles: totalFiles + totalVideos,
    totalVideos,
    videoStorageUsed,
    uploadsToday,
    unlimitedUploads: isAdmin,
    remainingUploads: isAdmin ? null : Math.max(0, DAILY_UPLOAD_LIMIT - uploadsInWindow),
    uploadLimit: isAdmin ? null : DAILY_UPLOAD_LIMIT,
    totalDownloads: totalDownloads[0]?.total || 0,
    recentFiles,
    activeShareLinks: recentFiles.filter((f) => f.shareToken).length,
  };
};

module.exports = {
  checkUserUploadLimit,
  saveFileMetadata,
  getUserFiles,
  getFileByToken,
  incrementDownloadCount,
  deleteFile,
  performFileDeletion,
  generateNewShareLink,
  getUserDashboardData,
};
