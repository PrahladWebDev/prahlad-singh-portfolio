const express = require('express');
const router = express.Router();
const {
  uploadFile,
  downloadFile,
  deleteFile,
  getMyFiles,
  generateShareLink,
  getFileInfo,
  getUserDashboard,
  checkUploadLimit,
} = require('../controllers/fileController');
const { authenticate, userOrAdmin } = require('../middleware/auth');
const { createUploadMiddleware, enforceUploadLimit } = require('../middleware/upload');
const { uploadLimiter, downloadLimiter } = require('../middleware/rateLimiter');

// Public routes
router.get('/share/:token/info', getFileInfo);
router.get('/share/:token', downloadLimiter, downloadFile);

// Protected routes
router.use(authenticate);

// enforceUploadLimit runs BEFORE createUploadMiddleware so a user already at
// their daily cap is rejected before their file is streamed across the
// internet, instead of after.
router.post('/upload', uploadLimiter, enforceUploadLimit, createUploadMiddleware, uploadFile);
router.get('/my-files', getMyFiles);
router.delete('/:id', deleteFile);
router.post('/:id/share-link', generateShareLink);
router.get('/dashboard/stats', getUserDashboard);
router.get('/upload-limit', checkUploadLimit);

module.exports = router;
