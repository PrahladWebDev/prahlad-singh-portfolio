const net = require('net');
const fs = require('fs');
const { Transform, pipeline } = require('stream');

/**
 * Minimal ClamAV client (clamd INSTREAM protocol) — no extra npm packages.
 *
 * Config (all optional, read at call time):
 *   VIRUS_SCAN_ENABLED    default "true"  — set "false" to turn scanning off
 *   VIRUS_SCAN_FAIL_OPEN  default "false" — "true" = allow upload if clamd is down/errors
 *   CLAMAV_SOCKET         default /var/run/clamav/clamd.ctl (Ubuntu/Debian default)
 *   CLAMAV_HOST           if set, connect over TCP instead of the unix socket
 *   CLAMAV_PORT           default 3310 (only used with CLAMAV_HOST)
 *   CLAMAV_TIMEOUT_MS     default 300000 (5 min) total time allowed per scan
 */

const DEFAULT_SOCKET = '/var/run/clamav/clamd.ctl';
const CHUNK_SIZE = 64 * 1024;

const isScanEnabled = () =>
  String(process.env.VIRUS_SCAN_ENABLED ?? 'true').toLowerCase() !== 'false';

const isFailOpen = () =>
  String(process.env.VIRUS_SCAN_FAIL_OPEN ?? 'false').toLowerCase() === 'true';

const scanError = (message, code) => Object.assign(new Error(message), { code });

const openConnection = () => {
  if (process.env.CLAMAV_HOST) {
    return net.createConnection({
      host: process.env.CLAMAV_HOST,
      port: parseInt(process.env.CLAMAV_PORT, 10) || 3310,
    });
  }
  return net.createConnection({ path: process.env.CLAMAV_SOCKET || DEFAULT_SOCKET });
};

// clamd INSTREAM framing: each chunk is prefixed with its length as a 4-byte
// big-endian integer, and the stream ends with a zero-length chunk.
const createFrameTransform = () =>
  new Transform({
    transform(chunk, _enc, cb) {
      const len = Buffer.allocUnsafe(4);
      len.writeUInt32BE(chunk.length, 0);
      cb(null, Buffer.concat([len, chunk]));
    },
    flush(cb) {
      cb(null, Buffer.alloc(4)); // zero-length terminator
    },
  });

const parseReply = (reply) => {
  // Examples:  "stream: OK"
  //            "stream: Eicar-Test-Signature FOUND"
  //            "INSTREAM size limit exceeded. ERROR"
  if (/\bFOUND$/.test(reply)) {
    const signature = reply
      .replace(/^stream:\s*/i, '')
      .replace(/\s*FOUND$/, '')
      .replace(/[^\w.\-/ ]/g, '')
      .trim();
    return { clean: false, signature: signature || 'Unknown' };
  }
  if (/\bOK$/.test(reply)) {
    return { clean: true, signature: null };
  }
  if (/size limit exceeded/i.test(reply)) {
    throw scanError(
      'File exceeds clamd StreamMaxLength — raise it in /etc/clamav/clamd.conf',
      'SCAN_SIZE_LIMIT'
    );
  }
  throw scanError(`Unexpected clamd reply: ${reply}`, 'SCAN_ERROR');
};

/**
 * Scans any readable stream by relaying it to clamd live.
 * Resolves { clean: true } or { clean: false, signature }.
 * Rejects (err.code = SCAN_* or a socket error code) if the scan couldn't be completed.
 */
const scanStream = (sourceStream) =>
  new Promise((resolve, reject) => {
    const timeoutMs = parseInt(process.env.CLAMAV_TIMEOUT_MS, 10) || 300000;
    const socket = openConnection();
    const received = [];
    let settled = false;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };

    const timer = setTimeout(
      () => settle(reject, scanError('ClamAV scan timed out', 'SCAN_TIMEOUT')),
      timeoutMs
    );

    socket.on('data', (d) => received.push(d));

    // clamd replies, then closes the connection — evaluate the reply on close.
    socket.on('close', () => {
      const reply = Buffer.concat(received).toString('utf8').replace(/\0/g, '').trim();
      if (!reply) {
        return settle(reject, scanError('ClamAV closed the connection without a reply', 'SCAN_ERROR'));
      }
      try {
        settle(resolve, parseReply(reply));
      } catch (err) {
        settle(reject, err);
      }
    });

    // If clamd already replied (e.g. size-limit error) a later RST/EPIPE is
    // harmless — 'close' will handle the reply. Otherwise it's a real failure.
    socket.on('error', (err) => {
      if (!received.length) settle(reject, err);
    });

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      pipeline(
        sourceStream,
        createFrameTransform(),
        socket,
        (err) => {
          if (err && !received.length) settle(reject, err);
        }
      );
    });
  });

/**
 * Back-compat: scans a file already sitting on disk. No longer used by the
 * upload pipeline itself (which scans the live stream via scanStream while
 * it's also being relayed to MinIO), kept for anything else that still
 * hands this a local path.
 */
const scanFile = (filePath) => scanStream(fs.createReadStream(filePath));

module.exports = { scanFile, scanStream, isScanEnabled, isFailOpen };
