const fs = require('fs');

const SNIFF_BYTES = 8000; // same order of magnitude git/most editors use for binary detection

const isImageVideoAudioOrPdf = (mimeType) => {
  if (!mimeType) return false;
  return (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('video/') ||
    mimeType.startsWith('audio/') ||
    mimeType === 'application/pdf'
  );
};

// Generic binary-vs-text detection by inspecting the actual bytes, the same
// way editors/terminals decide whether to render a file as text: a NUL byte
// almost never appears in real text, and a high ratio of other non-printable
// control bytes indicates binary content. This works for ANY text-like file
// regardless of extension (.env, .yml, .conf, a code file with no extension,
// etc.) without needing to maintain a list of known extensions.
const isTextBuffer = (buffer) => {
  if (buffer.length === 0) return true; // empty file, harmless to render

  let suspicious = 0;
  const len = Math.min(buffer.length, SNIFF_BYTES);

  for (let i = 0; i < len; i++) {
    const byte = buffer[i];
    if (byte === 0) return false; // NUL byte -> treat as binary immediately
    // Allow common whitespace control chars: tab(9), LF(10), CR(13)
    const isAllowedControl = byte === 9 || byte === 10 || byte === 13;
    const isControlRange = byte < 32 || byte === 127;
    if (isControlRange && !isAllowedControl) suspicious++;
  }

  // If more than ~5% of sampled bytes look like binary control characters,
  // treat the file as binary rather than text.
  return suspicious / len < 0.05;
};

// Decide viewability from a mimeType plus a small sample buffer. Used by the
// streaming upload pipeline, which captures the first SNIFF_BYTES of the
// file as it flows through to MinIO/ClamAV — no disk read required.
const detectIsViewableFromBuffer = (buffer, mimeType) => {
  if (isImageVideoAudioOrPdf(mimeType)) return true;
  if (mimeType && mimeType.startsWith('text/')) return true;
  return isTextBuffer(buffer || Buffer.alloc(0));
};

// Back-compat: sniffs a file already sitting on disk. No longer used by the
// upload pipeline itself (see detectIsViewableFromBuffer above), kept for
// anything else that still hands this a local path.
const detectIsViewable = (filePath, mimeType) => {
  if (isImageVideoAudioOrPdf(mimeType)) return true;
  if (mimeType && mimeType.startsWith('text/')) return true;

  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, SNIFF_BYTES, 0);
    fs.closeSync(fd);
    return isTextBuffer(buffer.subarray(0, bytesRead));
  } catch (err) {
    return false;
  }
};

// Resolve the Content-Type to serve when rendering a file inline. For
// text-like files whose browser-reported mimeType is missing or generic
// (application/octet-stream), fall back to text/plain so the browser
// renders it instead of downloading it.
const resolveInlineContentType = (mimeType, isViewable) => {
  if (isImageVideoAudioOrPdf(mimeType)) return mimeType;
  if (mimeType && mimeType.startsWith('text/')) return mimeType;
  if (isViewable) return 'text/plain; charset=utf-8';
  return mimeType || 'application/octet-stream';
};

module.exports = {
  detectIsViewable,
  detectIsViewableFromBuffer,
  isTextBuffer,
  resolveInlineContentType,
  SNIFF_BYTES,
};
