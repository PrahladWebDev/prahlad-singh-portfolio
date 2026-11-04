'use strict';
/**
 * Portfolio API
 *  - GET  /api/presence      Server-Sent Events: live visitors online + wave events
 *  - GET  /api/wave          total waves        POST /api/wave   add a wave
 *  - GET  /api/guestbook     entries            POST /api/guestbook   sign the guestbook
 *  - DELETE /api/guestbook/:id   (admin token)
 *  - POST /api/contact       sends the contact form to your Gmail
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT) || 4000;
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
const MAIL_TO = process.env.MAIL_TO || GMAIL_USER;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const SITE_URL = (process.env.SITE_URL || 'https://prahladsingh.in').replace(/\/+$/, '');

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ───────────────────────── persistence (tiny JSON file) ─────────────────────────
let store = { waves: 0, guestbook: [] };
try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  store.waves = Number(raw.waves) || 0;
  store.guestbook = Array.isArray(raw.guestbook) ? raw.guestbook : [];
} catch (_) { /* first run */ }

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(store), (err) => {
      if (err) return console.error('save failed', err.message);
      fs.rename(tmp, DATA_FILE, (e) => e && console.error('rename failed', e.message));
    });
  }, 400);
}
process.on('SIGTERM', () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(store)); } catch (_) {} process.exit(0); });
process.on('SIGINT', () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(store)); } catch (_) {} process.exit(0); });

// ───────────────────────── helpers ─────────────────────────
const app = express();
app.set('trust proxy', 1); // behind nginx
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '5kb' }));

app.use((req, res, next) => {
  if (ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

const clean = (v, max) => String(v == null ? '' : v)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .replace(/\s+\n/g, '\n').trim().slice(0, max);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 120;
const ipKey = (req) => crypto.createHash('sha256').update(String(req.ip)).digest('hex').slice(0, 16);

// simple in-memory rate limiter: allow `max` hits per `windowMs` per ip+bucket
const hits = new Map();
function limit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = bucket + ':' + ipKey(req);
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      res.setHeader('Retry-After', Math.ceil((windowMs - (now - arr[0])) / 1000));
      return res.status(429).json({ ok: false, error: 'Slow down a little and try again soon.' });
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) { const f = arr.filter((t) => now - t < 3600e3); f.length ? hits.set(k, f) : hits.delete(k); }
}, 10 * 60e3).unref();

// ───────────────────────── mail ─────────────────────────
let transporter = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });
  transporter.verify().then(
    () => console.log('Gmail SMTP ready for', GMAIL_USER),
    (e) => console.error('Gmail SMTP check failed:', e.message)
  );
} else {
  console.warn('GMAIL_USER / GMAIL_APP_PASSWORD not set - emails are disabled.');
}

async function sendMail({ subject, text, html, replyTo }) {
  if (!transporter) throw new Error('mail not configured');
  return transporter.sendMail({
    from: `"Portfolio" <${GMAIL_USER}>`,
    to: MAIL_TO,
    replyTo: replyTo || undefined,
    subject,
    text,
    html
  });
}

// ───────────────────────── presence (SSE) ─────────────────────────
// A "visitor" = one browser (id from localStorage); several tabs count once.
const clients = new Set();               // active SSE responses
const visitors = new Map();              // visitorId -> open connection count

const onlineCount = () => visitors.size;
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch (_) {} }
}

app.get('/api/presence', (req, res) => {
  const vid = clean(req.query.id, 40).replace(/[^\w-]/g, '') || crypto.randomBytes(6).toString('hex');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // tell nginx not to buffer
  });
  res.write('retry: 4000\n\n');

  clients.add(res);
  const before = visitors.size;
  visitors.set(vid, (visitors.get(vid) || 0) + 1);
  res.write(`event: hello\ndata: ${JSON.stringify({ online: onlineCount(), waves: store.waves })}\n\n`);
  if (visitors.size !== before) broadcast('presence', { online: onlineCount() });

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
    const n = (visitors.get(vid) || 1) - 1;
    if (n <= 0) { visitors.delete(vid); broadcast('presence', { online: onlineCount() }); }
    else visitors.set(vid, n);
  });
});

app.get('/api/online', (_req, res) => res.json({ online: onlineCount() }));

// ───────────────────────── wave counter ─────────────────────────
app.get('/api/wave', (_req, res) => res.json({ waves: store.waves }));
app.post('/api/wave', limit('wave', 5, 60e3), (_req, res) => {
  store.waves += 1;
  saveSoon();
  broadcast('wave', { waves: store.waves });
  res.json({ ok: true, waves: store.waves });
});

// ───────────────────────── guestbook (moderated) ─────────────────────────
// New entries start as pending (approved:false) and are hidden until you approve
// them from the link in the notification email. Older entries without the flag stay visible.
const isApproved = (e) => e.approved !== false;
const publicEntry = (e) => ({ id: e.id, name: e.name, message: e.message, at: e.at });

// signed links so only the email recipient can approve/delete (key = ADMIN_TOKEN)
const sign = (id, action) =>
  crypto.createHmac('sha256', ADMIN_TOKEN).update(id + ':' + action).digest('hex').slice(0, 32);
const validSig = (id, action, sig) => {
  if (!ADMIN_TOKEN || !/^(approve|delete)$/.test(action)) return false;
  const want = sign(id, action);
  const got = String(sig || '');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
};
const modLink = (id, action) => `${SITE_URL}/api/guestbook/moderate?id=${id}&action=${action}&sig=${sign(id, action)}`;

app.get('/api/guestbook', (req, res) => {
  const n = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const visible = store.guestbook.filter(isApproved);
  res.json({ ok: true, total: visible.length, entries: visible.slice(-n).reverse().map(publicEntry) });
});

app.post('/api/guestbook', limit('gb', 2, 10 * 60e3), (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true, pending: true }); // honeypot: pretend success to bots
  const name = clean(b.name, 40);
  const message = clean(b.message, 280);
  if (!name || !message) return res.status(400).json({ ok: false, error: 'Please add your name and a message.' });
  if (/https?:\/\/|www\./i.test(message)) return res.status(400).json({ ok: false, error: 'Links are not allowed in the guestbook.' });

  const entry = { id: crypto.randomBytes(6).toString('hex'), name, message, at: new Date().toISOString(), approved: false };
  store.guestbook.push(entry);
  if (store.guestbook.length > 500) store.guestbook.splice(0, store.guestbook.length - 500);
  saveSoon();

  if (transporter && ADMIN_TOKEN) {
    const approve = modLink(entry.id, 'approve');
    const del = modLink(entry.id, 'delete');
    const btn = (href, label, bg) => `<a href="${href}" style="display:inline-block;padding:12px 22px;margin:0 8px 8px 0;border-radius:8px;background:${bg};color:#fff;text-decoration:none;font-weight:bold;font-family:Arial,sans-serif">${label}</a>`;
    sendMail({
      subject: `Guestbook (needs approval): ${name}`,
      text: `${name} wrote in your guestbook:\n\n${message}\n\nAPPROVE: ${approve}\n\nDELETE: ${del}\n`,
      html: `<p><b>${esc(name)}</b> wrote in your guestbook (hidden until you approve):</p>` +
            `<blockquote style="border-left:3px solid #ccc;margin:0 0 16px;padding:4px 14px">${esc(message).replace(/\n/g, '<br>')}</blockquote>` +
            btn(approve, 'Approve', '#1a9d6c') + btn(del, 'Delete', '#d64545')
    }).catch((e) => console.error('guestbook mail failed:', e.message));
  } else {
    console.warn('Guestbook entry is pending but cannot be emailed (mail or ADMIN_TOKEN missing).');
  }
  res.json({ ok: true, pending: true, message: 'Thanks! Your note will appear once it has been approved.' });
});

// Review page. GET only shows a confirm button (mail scanners that prefetch links can't change anything).
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:Arial,sans-serif;background:#0e1526;color:#e9ecf6;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
.c{background:#162038;border-radius:14px;padding:26px;max-width:460px;width:100%}h1{font-size:18px;margin:0 0 14px}
blockquote{margin:0 0 18px;padding:8px 14px;border-left:3px solid #f2a93b;background:#0e1526;border-radius:6px;overflow-wrap:anywhere;white-space:pre-wrap}
button{width:100%;padding:14px;border:0;border-radius:10px;color:#fff;font-size:16px;font-weight:bold}.a{background:#1a9d6c}.d{background:#d64545}p{margin:0}</style></head><body><div class="c">${body}</div></body></html>`;

app.get('/api/guestbook/moderate', (req, res) => {
  const id = clean(req.query.id, 20), action = clean(req.query.action, 10), sig = clean(req.query.sig, 64);
  res.setHeader('Cache-Control', 'no-store');
  if (!validSig(id, action, sig)) return res.status(403).send(page('Invalid link', '<h1>Invalid or expired link</h1>'));
  const e = store.guestbook.find((x) => x.id === id);
  if (!e) return res.send(page('Not found', '<h1>This entry no longer exists</h1><p>It was already deleted.</p>'));
  const isDel = action === 'delete';
  if (!isDel && isApproved(e)) return res.send(page('Approved', '<h1>Already approved ✓</h1><p>It is visible on the site.</p>'));
  res.send(page('Moderate guestbook',
    `<h1>${isDel ? 'Delete' : 'Approve'} this entry?</h1><p><b>${esc(e.name)}</b></p><blockquote>${esc(e.message)}</blockquote>` +
    `<form method="post" action="${SITE_URL}/api/guestbook/moderate"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="action" value="${esc(action)}"><input type="hidden" name="sig" value="${esc(sig)}">` +
    `<button class="${isDel ? 'd' : 'a'}" type="submit">${isDel ? 'Yes, delete it' : 'Yes, approve it'}</button></form>`));
});

app.post('/api/guestbook/moderate', (req, res) => {
  const id = clean(req.body.id, 20), action = clean(req.body.action, 10), sig = clean(req.body.sig, 64);
  res.setHeader('Cache-Control', 'no-store');
  if (!validSig(id, action, sig)) return res.status(403).send(page('Invalid link', '<h1>Invalid or expired link</h1>'));
  const i = store.guestbook.findIndex((x) => x.id === id);
  if (i === -1) return res.send(page('Done', '<h1>Already removed ✓</h1>'));
  if (action === 'delete') { store.guestbook.splice(i, 1); saveSoon(); return res.send(page('Deleted', '<h1>Deleted ✓</h1><p>The entry is gone.</p>')); }
  store.guestbook[i].approved = true; saveSoon();
  res.send(page('Approved', '<h1>Approved ✓</h1><p>It is now visible in the guestbook.</p>'));
});

// admin helpers (Bearer ADMIN_TOKEN)
const isAdmin = (req) => {
  const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return !!ADMIN_TOKEN && given.length === ADMIN_TOKEN.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(ADMIN_TOKEN));
};
app.get('/api/guestbook/pending', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok: false });
  res.json({ ok: true, entries: store.guestbook.filter((e) => !isApproved(e)) });
});
app.delete('/api/guestbook/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok: false });
  const i = store.guestbook.findIndex((e) => e.id === req.params.id);
  if (i === -1) return res.status(404).json({ ok: false });
  store.guestbook.splice(i, 1);
  saveSoon();
  res.json({ ok: true });
});

// ───────────────────────── contact form -> Gmail ─────────────────────────
app.post('/api/contact', limit('contact', 3, 10 * 60e3), async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot
  const name = clean(b.name, 80);
  const message = clean(b.message, 2000);
  const email = clean(b.email, 120);
  if (!name || !message) return res.status(400).json({ ok: false, error: 'Name and message are required.' });
  if (email && !isEmail(email)) return res.status(400).json({ ok: false, error: 'That email address looks invalid.' });
  if (!transporter) return res.status(503).json({ ok: false, error: 'Email is not available right now.' });

  try {
    await sendMail({
      subject: `Portfolio enquiry from ${name}`,
      replyTo: email || undefined,
      text: `${message}\n\n— ${name}${email ? ' <' + email + '>' : ''}`,
      html: `<p>${esc(message).replace(/\n/g, '<br>')}</p><hr><p><b>${esc(name)}</b>${email ? ' &lt;' + esc(email) + '&gt;' : ''}<br><span style="color:#888">sent from prahladsingh.in</span></p>`
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('contact mail failed:', e.message);
    res.status(502).json({ ok: false, error: 'Could not send the email right now.' });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, online: onlineCount(), mail: !!transporter }));

app.use('/api', (_req, res) => res.status(404).json({ ok: false }));

app.listen(PORT, '127.0.0.1', () => console.log(`Portfolio API on 127.0.0.1:${PORT}`));
