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
let store = { waves: 0, guestbook: [], countries: {}, likes: {}, sections: {}, game: { plays: 0, best: 0, hist: [] } };
try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  store.waves = Number(raw.waves) || 0;
  store.guestbook = Array.isArray(raw.guestbook) ? raw.guestbook : [];
  store.countries = raw.countries && typeof raw.countries === 'object' ? raw.countries : {};
  store.likes = raw.likes && typeof raw.likes === 'object' ? raw.likes : {};
  store.sections = raw.sections && typeof raw.sections === 'object' ? raw.sections : {};
  if (raw.game && typeof raw.game === 'object') store.game = { plays: Number(raw.game.plays) || 0, best: Number(raw.game.best) || 0, hist: Array.isArray(raw.game.hist) ? raw.game.hist.map((n) => Number(n) || 0) : [] };
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

let geoip = null;
try { geoip = require('geoip-lite'); } catch (_) { console.warn('geoip-lite not installed - visitor map will only work behind Cloudflare (CF-IPCountry).'); }

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
const visitorCountry = new Map();        // visitorId -> ISO country (only while online, never saved)
const lastCounted = new Map();           // visitorId -> time of last counted visit (memory only)

const onlineCount = () => visitors.size;
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch (_) {} }
}

// Country only. The IP is looked up and thrown away, it is never stored or logged.
function countryOf(req) {
  const h = String(req.get('cf-ipcountry') || req.get('x-country') || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(h) && h !== 'XX' && h !== 'T1') return h;
  if (geoip) {
    try { const g = geoip.lookup(req.ip); if (g && /^[A-Z]{2}$/.test(g.country)) return g.country; } catch (_) {}
  }
  return null;
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
  const isNew = !visitors.has(vid);
  visitors.set(vid, (visitors.get(vid) || 0) + 1);
  if (isNew) {
    const cc = countryOf(req);
    if (cc) {
      visitorCountry.set(vid, cc);
      const now = Date.now();
      if (now - (lastCounted.get(vid) || 0) > 30 * 60e3) {   // one visit per browser per 30 min
        lastCounted.set(vid, now);
        store.countries[cc] = (store.countries[cc] || 0) + 1;
        saveSoon();
      }
    }
  }
  res.write(`event: hello\ndata: ${JSON.stringify({ online: onlineCount(), waves: store.waves })}\n\n`);
  if (visitors.size !== before) broadcast('presence', { online: onlineCount() });

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
    const n = (visitors.get(vid) || 1) - 1;
    if (n <= 0) { visitors.delete(vid); visitorCountry.delete(vid); broadcast('presence', { online: onlineCount() }); }
    else visitors.set(vid, n);
  });
});
setInterval(() => {
  const cut = Date.now() - 2 * 3600e3;
  for (const [k, t] of lastCounted) if (t < cut && !visitors.has(k)) lastCounted.delete(k);
}, 30 * 60e3).unref();

// visits per country + which countries have someone online right now
app.get('/api/countries', (_req, res) => {
  const online = {};
  for (const cc of visitorCountry.values()) online[cc] = (online[cc] || 0) + 1;
  const codes = new Set([...Object.keys(store.countries), ...Object.keys(online)]);
  const list = [...codes].map((code) => ({ code, count: store.countries[code] || 0, online: online[code] || 0 }))
    .sort((a, b) => b.count - a.count);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, total: list.reduce((n, c) => n + c.count, 0), countries: list });
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

// ───────────────────────── project likes ─────────────────────────
// One heart per project per visitor is enforced in the browser; the server just counts and rate-limits.
app.get('/api/likes', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, likes: store.likes }); });
app.post('/api/likes/:slug', limit('like', 30, 60e3), (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) return res.status(400).json({ ok: false, error: 'bad project' });
  if (!(slug in store.likes) && Object.keys(store.likes).length >= 100) return res.status(400).json({ ok: false, error: 'unknown project' });
  store.likes[slug] = (store.likes[slug] || 0) + 1;
  saveSoon();
  res.json({ ok: true, slug, likes: store.likes[slug] });
});

// ───────────────────────── section popularity + private stats page ─────────────────────────
// Counts how often each section is opened (no IPs, no identifiers). Only you can read it, via /api/stats.
const SECTION_IDS = ['about', 'skills', 'experience', 'projects', 'store', 'github', 'education', 'contact'];
const istDay = (offsetDays = 0) => new Date(Date.now() + 19800000 - offsetDays * 864e5).toISOString().slice(0, 10);

app.post('/api/sections/:id', limit('sec', 40, 60e3), (req, res) => {
  const id = String(req.params.id || '');
  if (!SECTION_IDS.includes(id)) return res.status(400).json({ ok: false });
  const rec = store.sections[id] || (store.sections[id] = { total: 0, days: {} });
  rec.total += 1;
  const d = istDay();
  rec.days[d] = (rec.days[d] || 0) + 1;
  const keep = istDay(35);
  for (const k of Object.keys(rec.days)) if (k < keep) delete rec.days[k];
  saveSoon();
  res.json({ ok: true });
});

app.get('/api/stats/data', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ ok: false });
  const days7 = Array.from({ length: 7 }, (_, i) => istDay(i));
  const sections = SECTION_IDS.map((id) => {
    const r = store.sections[id] || { total: 0, days: {} };
    return { id, total: r.total, today: r.days[istDay()] || 0, week: days7.reduce((n, d) => n + (r.days[d] || 0), 0) };
  }).sort((a, b) => b.week - a.week || b.total - a.total);
  const countries = Object.entries(store.countries).map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count);
  const likes = Object.entries(store.likes).map(([slug, count]) => ({ slug, count })).sort((a, b) => b.count - a.count);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true, online: onlineCount(), waves: store.waves, sections,
    visits: countries.reduce((n, c) => n + c.count, 0), countries: countries.slice(0, 8), likes: likes.slice(0, 8),
    guestbook: { approved: store.guestbook.filter(isApproved).length, pending: store.guestbook.filter((e) => !isApproved(e)).length }
  });
});

app.get('/api/stats', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Portfolio stats</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,Arial,sans-serif;background:#0e1526;color:#e9ecf6;padding:20px}
.w{max-width:680px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}.sub{color:#8f9ab8;font-size:13px;margin-bottom:18px}
.card{background:#162038;border-radius:14px;padding:18px;margin-bottom:14px}h2{font-size:12px;letter-spacing:1.5px;color:#8f9ab8;margin:0 0 12px;font-weight:700}
input,button{font:inherit;padding:12px;border-radius:10px;border:0}input{width:100%;background:#0e1526;color:#fff;margin-bottom:10px}
button{background:#f2a93b;color:#14100a;font-weight:700;cursor:pointer;width:100%}
.row{display:grid;grid-template-columns:96px 1fr 76px;gap:10px;align-items:center;margin:9px 0;font-size:14px}
.bar{height:12px;border-radius:99px;background:#0e1526;overflow:hidden}.bar i{display:block;height:100%;background:#f2a93b;border-radius:99px}
.n{text-align:right;color:#cfd6ec;font-variant-numeric:tabular-nums}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.k{background:#0e1526;border-radius:12px;padding:12px}.k b{display:block;font-size:22px}.k span{font-size:11px;color:#8f9ab8}
.tip{font-size:13px;color:#cfd6ec;line-height:1.5}.err{color:#ff7b7b;font-size:13px;min-height:1em}</style></head><body><div class="w">
<h1>Portfolio stats</h1><div class="sub">Private. Needs your ADMIN_TOKEN.</div>
<div class="card" id="login"><input id="tok" type="password" placeholder="ADMIN_TOKEN" autocomplete="current-password"><button id="go">Open stats</button><div class="err" id="err"></div></div>
<div id="out" hidden></div></div>
<script>
const $=(i)=>document.getElementById(i);
const nm={about:'About',skills:'Skills',experience:'Experience',projects:'Projects',store:'Web Store',github:'GitHub',education:'Education',contact:'Contact'};
const flag=(c)=>String.fromCodePoint(...[...c].map((x)=>127397+x.charCodeAt(0)));
let rn=null;try{rn=new Intl.DisplayNames(['en'],{type:'region'})}catch(e){}
function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function bars(card,items,label,val,max){items.forEach((it)=>{const r=el('div','row');r.append(el('span','',label(it)));const b=el('div','bar');const i=el('i');i.style.width=(max?Math.max(2,val(it)/max*100):0)+'%';b.append(i);r.append(b,el('span','n',val(it).toLocaleString('en-IN')));card.append(r)})}
function show(d){const o=$('out');o.textContent='';
 const g=el('div','card');const gr=el('div','grid');
 [[d.online,'online now'],[d.visits,'visits (all time)'],[d.waves,'waves'],[d.guestbook.pending+' / '+d.guestbook.approved,'guestbook pending / live']].forEach(([a,b])=>{const k=el('div','k');k.append(el('b','',String(a)),el('span','',b));gr.append(k)});g.append(gr);o.append(g);
 const s=el('div','card');s.append(el('h2','','SECTIONS OPENED, LAST 7 DAYS (ALL TIME ON THE RIGHT)'));
 const mx=Math.max(1,...d.sections.map((x)=>x.week));
 d.sections.forEach((x)=>{const r=el('div','row');r.append(el('span','',nm[x.id]||x.id));const b=el('div','bar');const i=el('i');i.style.width=Math.max(x.week?2:0,x.week/mx*100)+'%';b.append(i);r.append(b,el('span','n',x.week+' · '+x.total));s.append(r)});
 const top=d.sections.find((x)=>x.id!=='about');if(top&&top.week>0){s.append(el('div','tip','Most opened after About this week: '+(nm[top.id]||top.id)+'. If it is far down the sidebar, consider moving it up.'))}
 o.append(s);
 if(d.countries.length){const c=el('div','card');c.append(el('h2','','TOP COUNTRIES'));bars(c,d.countries,(x)=>flag(x.code)+' '+(rn?rn.of(x.code):x.code),(x)=>x.count,d.countries[0].count);o.append(c)}
 if(d.likes.length){const c=el('div','card');c.append(el('h2','','MOST LIKED PROJECTS'));bars(c,d.likes,(x)=>x.slug,(x)=>x.count,d.likes[0].count);o.append(c)}
 o.hidden=false;$('login').hidden=true}
async function load(t){const r=await fetch('/api/stats/data',{headers:{Authorization:'Bearer '+t},cache:'no-store'});if(!r.ok)throw 0;const d=await r.json();sessionStorage.setItem('ps-stats',t);try{localStorage.setItem('ps-owner','1')}catch(e){}show(d)}
$('go').onclick=()=>load($('tok').value.trim()).catch(()=>{$('err').textContent='Wrong token.'});
$('tok').onkeydown=(e)=>{if(e.key==='Enter')$('go').click()};
const saved=sessionStorage.getItem('ps-stats');if(saved)load(saved).catch(()=>{});
</script></body></html>`);
});

// ───────────────────────── Bug Squash mini-game (scores only, no names) ─────────────────────────
const GAME_MAX = 60;
app.get('/api/game', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, plays: store.game.plays, best: store.game.best }); });
app.post('/api/game/score', limit('game', 12, 60e3), (req, res) => {
  const score = Math.floor(Number((req.body || {}).score));
  if (!Number.isFinite(score) || score < 0 || score > GAME_MAX) return res.status(400).json({ ok: false });
  const g = store.game;
  while (g.hist.length <= GAME_MAX) g.hist.push(0);
  let below = 0;
  for (let i = 0; i < score; i++) below += g.hist[i];
  const beat = g.plays > 0 ? Math.round((below / g.plays) * 100) : 0;   // % of earlier players this score beat
  g.hist[score] += 1; g.plays += 1; if (score > g.best) g.best = score;
  saveSoon();
  res.json({ ok: true, plays: g.plays, best: g.best, beat });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, online: onlineCount(), mail: !!transporter }));

app.use('/api', (_req, res) => res.status(404).json({ ok: false }));

app.listen(PORT, '127.0.0.1', () => console.log(`Portfolio API on 127.0.0.1:${PORT}`));
