const fileService = require('../services/fileService');
const ApiResponse = require('../utils/apiResponse');
const logger = require('../utils/logger');
const { minioClient, FILES_BUCKET } = require('../config/minio');
const { resolveInlineContentType } = require('../utils/viewableFiles');

const uploadFile = async (req, res, next) => {
  try {
    if (!req.file) {
      return ApiResponse.badRequest(res, 'No file provided');
    }

    // Daily upload limit is now enforced by enforceUploadLimit, BEFORE the
    // multipart body is even read (see middleware/upload.js) — a user over
    // their limit is rejected instantly instead of after streaming their
    // whole file across the internet for nothing. No check needed here.
    const isAdmin = req.user.role === 'admin';

    const file = await fileService.saveFileMetadata(req.file, req.user._id, isAdmin);

    return ApiResponse.created(
      res,
      {
        file: {
          id: file._id,
          originalName: file.originalName,
          size: file.size,
          mimeType: file.mimeType,
          shareToken: file.shareToken,
          expiresAt: file.expiresAt,
          uploadedAt: file.uploadedAt,
          shareUrl: file.shareToken
            ? `${process.env.FRONTEND_URL}/share/${file.shareToken}`
            : null,
          isViewable: file.isViewable,
        },
      },
      'File uploaded successfully'
    );
  } catch (err) {
    // The upload middleware already streamed the object into MinIO by the
    // time this runs (there's no local temp file anymore). If something
    // fails after that — e.g. the Mongo write — clean up the now-orphaned
    // MinIO object instead of the old fs.unlinkSync(req.file.path).
    if (req.file && req.file.filename) {
      try {
        await minioClient.removeObject(FILES_BUCKET, req.file.filename);
      } catch (rmErr) {
        logger.error('Failed to cleanup MinIO object after upload error:', rmErr);
      }
    }
    next(err);
  }
};

const downloadFile = async (req, res, next) => {
  try {
    const { token } = req.params;
    const file = await fileService.getFileByToken(token);

    if (!file) {
      return ApiResponse.notFound(res, 'File not found or link has expired');
    }

    let objectStream;
    try {
      objectStream = await minioClient.getObject(FILES_BUCKET, file.path);
    } catch (err) {
      logger.error(`Object missing from MinIO: ${file.path}`, err);
      return ApiResponse.error(res, 'File not available on server', 500);
    }

    await fileService.incrementDownloadCount(file._id);

    logger.info({
      event: 'download',
      fileId: file._id,
      shareToken: token,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // ?view=1 renders the file inline in the browser (used by the "View"
    // button in the UI) instead of forcing a download. Only honored for
    // file types recognized as safely viewable.
    const wantsInline = ['1', 'true'].includes(String(req.query.view || '').toLowerCase());
    const canViewInline = wantsInline && !!file.isViewable;

    const filename = encodeURIComponent(file.originalName);
    const disposition = canViewInline
      ? `inline; filename="${filename}"; filename*=UTF-8''${filename}`
      : `attachment; filename="${filename}"; filename*=UTF-8''${filename}`;

    res.set({
      'Content-Type': canViewInline
        ? resolveInlineContentType(file.mimeType, file.isViewable)
        : file.mimeType || 'application/octet-stream',
      'Content-Disposition': disposition,
      'Content-Length': file.size,
      'X-Content-Type-Options': 'nosniff',
    });

    objectStream.on('error', (err) => {
      logger.error(`Read stream error for file ${file._id}:`, err);
      if (!res.headersSent) {
        ApiResponse.error(res, 'Error reading file', 500);
      }
    });

    objectStream.pipe(res);
  } catch (err) {
    next(err);
  }
};

const deleteFile = async (req, res, next) => {
  try {
    const { id } = req.params;
    const isAdmin = req.user.role === 'admin';
    await fileService.deleteFile(id, req.user._id, isAdmin);
    return ApiResponse.success(res, null, 'File deleted successfully');
  } catch (err) {
    next(err);
  }
};

const getMyFiles = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const search = req.query.search || '';

    const result = await fileService.getUserFiles(req.user._id, page, limit, search);
    return ApiResponse.paginated(res, result.files, result.pagination, 'Files fetched');
  } catch (err) {
    next(err);
  }
};

const generateShareLink = async (req, res, next) => {
  try {
    const { id } = req.params;
    const isAdmin = req.user.role === 'admin';
    const newToken = await fileService.generateNewShareLink(id, req.user._id, isAdmin);
    const shareUrl = `${process.env.FRONTEND_URL}/share/${newToken}`;
    return ApiResponse.success(res, { shareToken: newToken, shareUrl }, 'Share link generated');
  } catch (err) {
    next(err);
  }
};

const getFileInfo = async (req, res, next) => {
  try {
    const { token } = req.params;
    const file = await fileService.getFileByToken(token);

    if (!file) {
      return ApiResponse.notFound(res, 'File not found or link has expired');
    }

    return ApiResponse.success(
      res,
      {
        originalName: file.originalName,
        size: file.size,
        mimeType: file.mimeType,
        downloadCount: file.downloadCount,
        uploadedAt: file.uploadedAt,
        expiresAt: file.expiresAt,
        ownerName: file.owner?.name || 'Unknown',
        isViewable: file.isViewable,
      },
      'File info fetched'
    );
  } catch (err) {
    next(err);
  }
};

const getUserDashboard = async (req, res, next) => {
  try {
    const data = await fileService.getUserDashboardData(req.user._id);
    return ApiResponse.success(res, data, 'Dashboard data fetched');
  } catch (err) {
    next(err);
  }
};

const checkUploadLimit = async (req, res, next) => {
  try {
    const limitData = await fileService.checkUserUploadLimit(req.user._id);
    return ApiResponse.success(res, limitData, 'Upload limit status');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  uploadFile,
  downloadFile,
  deleteFile,
  getMyFiles,
  generateShareLink,
  getFileInfo,
  getUserDashboard,
  checkUploadLimit,
};
