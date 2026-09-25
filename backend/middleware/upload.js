const multer = require('multer');
const path = require('path');
const { PassThrough } = require('stream');
const { generateStoredFilename } = require('../utils/tokenGenerator');
const { scanStream, isScanEnabled, isFailOpen } = require('../services/virusScanService');
const { detectIsViewableFromBuffer, SNIFF_BYTES } = require('../utils/viewableFiles');
const { minioClient, FILES_BUCKET } = require('../config/minio');
const fileService = require('../services/fileService');
const logger = require('../utils/logger');

// Streams the incoming multipart file straight into MinIO while
// simultaneously feeding the same bytes to ClamAV — instead of the old
// path of: write to local disk -> read it back for the virus scan -> read
// it AGAIN to push into MinIO -> delete the temp file. That was three full
// passes over the file, done one after another, which is why large uploads
// were slow enough to trip nginx's read timeout. Now there's exactly one
// pass, and the scan + MinIO upload happen at the same time.
class MinioClamStorage {
  _handleFile(req, file, cb) {
    const storedName = generateStoredFilename(file.originalname);

    // Passive tap on the source stream: tracks total size and captures the
    // first few KB for the "View" button's text/binary sniff. This doesn't
    // drive flow control itself — the two pipe() calls below do — it just
    // rides along on the same chunks.
    let total = 0;
    const sniffChunks = [];
    let sniffedBytes = 0;
    file.stream.on('data', (chunk) => {
      total += chunk.length;
      if (sniffedBytes < SNIFF_BYTES) {
        const take = chunk.subarray(0, SNIFF_BYTES - sniffedBytes);
        sniffChunks.push(take);
        sniffedBytes += take.length;
      }
    });

    const toMinio = new PassThrough();
    file.stream.pipe(toMinio);
    const uploadPromise = minioClient.putObject(FILES_BUCKET, storedName, toMinio, {
      'Content-Type': file.mimetype,
    });

    let scanPromise = Promise.resolve({ clean: true, signature: null });
    if (isScanEnabled()) {
      const toClam = new PassThrough();
      file.stream.pipe(toClam);
      scanPromise = scanStream(toClam).catch((scanErr) => {
        if (isFailOpen()) {
          logger.warn(
            `VIRUS_SCAN_FAIL_OPEN=true — allowing unscanned upload "${file.originalname}" (${scanErr.code || 'ERR'})`
          );
          return { clean: true, signature: null };
        }
        throw scanErr;
      });
    }

    Promise.all([uploadPromise, scanPromise])
      .then(([, scanResult]) => {
        if (!scanResult.clean) {
          logger.warn(
            `Infected upload blocked: "${file.originalname}" (${scanResult.signature}) by user ${req.user?._id}, ip ${req.ip}`
          );
          return minioClient
            .removeObject(FILES_BUCKET, storedName)
            .catch((rmErr) => logger.error(`Failed to remove infected object ${storedName}:`, rmErr))
            .then(() => {
              const err = new Error(
                `Upload rejected: "${file.originalname}" contains malware (${scanResult.signature})`
              );
              err.statusCode = 422;
              cb(err);
            });
        }

        const sniffBuffer = Buffer.concat(sniffChunks, sniffedBytes);
        cb(null, {
          filename: storedName,
          size: total,
          mimetype: file.mimetype,
          isViewable: detectIsViewableFromBuffer(sniffBuffer, file.mimetype),
        });
      })
      .catch((err) => {
        // The MinIO upload or the scan itself failed outright (not "found a
        // virus" — an actual error). Best-effort cleanup of whatever MinIO
        // may have already received, then map to a sensible status code.
        minioClient
          .removeObject(FILES_BUCKET, storedName)
          .catch(() => {})
          .then(() => {
            if (err.code === 'SCAN_SIZE_LIMIT') {
              err.statusCode = 413;
              err.message = 'This file is too large for the virus scanner';
            } else if (err.code && String(err.code).startsWith('SCAN_')) {
              err.statusCode = 503;
              err.message = 'Virus scanner is temporarily unavailable. Please try again later.';
              logger.error(`Virus scan failed for "${file.originalname}" (${err.code}): ${err.message}`);
            } else if (!err.statusCode) {
              err.statusCode = 500;
            }
            cb(err);
          });
      });
  }

  _removeFile(req, file, cb) {
    // Called by multer if something later in the chain errors after
    // _handleFile already succeeded. removeObject is idempotent, so this is
    // safe even if the object was already cleaned up above.
    minioClient
      .removeObject(FILES_BUCKET, file.filename)
      .then(() => cb(null))
      .catch((err) => cb(err));
  }
}

// All file types (.js, .exe, etc.) are accepted — safety comes from the
// virus scan instead of an extension/MIME blocklist.
const fileFilter = (req, file, cb) => {
  // Path traversal prevention
  const sanitizedName = path.basename(file.originalname);
  if (sanitizedName !== file.originalname && file.originalname.includes('..')) {
    const err = new Error('Invalid filename');
    err.statusCode = 400;
    return cb(err);
  }

  cb(null, true);
};

// Runs BEFORE the multipart body is read at all, so a user who's already at
// their daily cap gets rejected instantly instead of after streaming their
// whole file across the internet and into MinIO for nothing.
const enforceUploadLimit = async (req, res, next) => {
  if (req.user?.role === 'admin') return next();
  try {
    const { limitReached } = await fileService.checkUserUploadLimit(req.user._id);
    if (limitReached) {
      const err = new Error('Daily upload limit reached. You can upload 2 files per 24-hour period.');
      err.statusCode = 429;
      return next(err);
    }
    next();
  } catch (err) {
    next(err);
  }
};

const createUploadMiddleware = (req, res, next) => {
  const isAdmin = req.user?.role === 'admin';
  const maxSize = isAdmin
    ? Infinity
    : parseInt(process.env.MAX_FILE_SIZE_USER) || 524288000; // 500MB default

  const upload = multer({
    storage: new MinioClamStorage(),
    fileFilter,
    limits: isAdmin ? {} : { fileSize: maxSize },
  }).single('file');

  upload(req, res, (err) => {
    if (err) return next(err);
    next();
  });
};

module.exports = { createUploadMiddleware, enforceUploadLimit };
