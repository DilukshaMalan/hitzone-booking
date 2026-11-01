'use strict';
/**
 * HITZONE Indoor Cricket Arena - booking website server.
 * Zero dependencies: only Node.js built-in modules.   Start with:  node server.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------- tiny .env loader (real environment variables win) ----------
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const qr = require('./lib/qr');
const { store } = require('./lib/store');
const svc = require('./lib/service');
const emails = require('./lib/emails');
const mailer = require('./lib/mailer');
const { ApiError } = svc;
const { waNumber, addDays, isValidDate } = require('./lib/util');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'hitzone2026';
const USING_DEFAULT_PASSWORD = !process.env.ADMIN_PASSWORD;
// anti-spam: booking requests allowed per visitor per hour (counts failed attempts too)
const BOOKING_LIMIT_PER_HOUR = parseInt(process.env.BOOKING_LIMIT_PER_HOUR || '20', 10);
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';

// ---------- helpers ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new ApiError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new ApiError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (TRUST_PROXY && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    return true;
  }
  arr.push(now);
  hits.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.some((t) => now - t < 3600e3)) hits.delete(k);
}, 600e3).unref();

function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '');
  const proto = TRUST_PROXY && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0] : 'http';
  let host = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${PORT}`;
  if (!/^[\w.\-:[\]]+$/.test(host)) host = `localhost:${PORT}`;
  return `${proto}://${host}`;
}

// ---------- admin auth ----------
const sessions = new Map(); // token -> expiry
const SESSION_MS = 12 * 3600e3;

function checkPassword(input) {
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) {
    sessions.delete(token);
    throw new ApiError(401, 'Please sign in again.');
  }
}

// ---------- notifications ----------
function adminRecipients() {
  const fromEnv = (process.env.ADMIN_EMAIL || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  if (store.settings.contact.email) return [store.settings.contact.email];
  return process.env.SMTP_USER ? [process.env.SMTP_USER] : [];
}

function qrAttachment(b, base) {
  const url = `${base}/receipt.html?ref=${encodeURIComponent(b.ref)}`;
  return [{ cid: 'bookingqr@hitzone', filename: `${b.ref}-qr.png`, contentType: 'image/png', content: qr.toPNG(url, { scale: 5, margin: 3 }) }];
}

function fireAndForget(promise) {
  promise.catch((err) => console.error('[notify] unexpected error:', err.message));
}

function notifyNewBooking(b, base) {
  const s = store.settings;
  const to = adminRecipients();
  if (to.length) fireAndForget(mailer.sendMail({ to, ...emails.adminNewRequest(b, s, base) }));
  else console.warn('[notify] No ADMIN_EMAIL set - the owner was not emailed about', b.ref);
  if (b.email) {
    fireAndForget(mailer.sendMail({ to: b.email, ...emails.customerReceived(b, s, base, 'bookingqr@hitzone'), attachments: qrAttachment(b, base) }));
  }
}

function notifyStatusChange(b, action, base) {
  if (!b.email || b.type !== 'online') return;
  const s = store.settings;
  if (action === 'confirm') {
    fireAndForget(mailer.sendMail({ to: b.email, ...emails.customerConfirmed(b, s, base, 'bookingqr@hitzone'), attachments: qrAttachment(b, base) }));
  } else if (action === 'decline') {
    fireAndForget(mailer.sendMail({ to: b.email, ...emails.customerDeclined(b, s, base, false) }));
  } else if (action === 'cancel') {
    fireAndForget(mailer.sendMail({ to: b.email, ...emails.customerDeclined(b, s, base, true) }));
  }
}

function adminView(b) {
  return { ...b, whatsapp: waNumber(b.phone) };
}

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler, ...opts });

route('GET', '/api/config', () => svc.publicConfig());

route('GET', '/api/availability', ({ query }) => svc.getAvailability(query.get('date')));

route('GET', '/api/calendar', ({ query }) => {
  const cfg = svc.publicConfig();
  let from = query.get('from') || cfg.today;
  if (!isValidDate(from) || from < cfg.today) from = cfg.today;
  const days = Math.min(Math.max(parseInt(query.get('days') || '14', 10) || 14, 1), 60);
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    if (date > cfg.lastBookableDate) break;
    const a = svc.getAvailability(date);
    out.push({ date, closed: a.closed, freeMinutes: a.freeMinutes });
  }
  return { days: out };
});

route('POST', '/api/bookings', async ({ req, res }) => {
  if (limited(`book:${clientIp(req)}`, BOOKING_LIMIT_PER_HOUR, 3600e3)) throw new ApiError(429, 'Too many requests. Please try again later.');
  const body = await readBody(req);
  const b = svc.createBooking(body);
  const base = baseUrl(req);
  notifyNewBooking(b, base);
  return { booking: svc.publicView(b), receiptUrl: `/receipt.html?ref=${b.ref}` };
});

route('GET', '/api/bookings/(HZ-[A-Za-z0-9]{6})', ({ params }) => {
  const b = svc.findBooking(params[0]);
  if (!b || b.type === 'block') throw new ApiError(404, 'Booking not found');
  return { booking: svc.publicView(b) };
});

route('GET', '/api/qr/(HZ-[A-Za-z0-9]{6})\\.(svg|png)', ({ req, res, params }) => {
  const b = svc.findBooking(params[0]);
  if (!b || b.type === 'block') throw new ApiError(404, 'Booking not found');
  const url = `${baseUrl(req)}/receipt.html?ref=${encodeURIComponent(b.ref)}`;
  const png = params[1] === 'png';
  const payload = png ? qr.toPNG(url, { scale: 8 }) : Buffer.from(qr.toSVG(url));
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': png ? 'image/png' : 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
  res.end(payload);
  return null; // already sent
});

route('POST', '/api/admin/login', async ({ req }) => {
  if (limited(`login:${clientIp(req)}`, 10, 15 * 60e3)) throw new ApiError(429, 'Too many attempts. Try again in a few minutes.');
  const body = await readBody(req);
  if (!checkPassword(body.password)) throw new ApiError(401, 'Wrong password.');
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_MS);
  return { token, usingDefaultPassword: USING_DEFAULT_PASSWORD };
});

route('GET', '/api/admin/stats', ({ req }) => {
  requireAdmin(req);
  return { stats: svc.stats(), emailConfigured: mailer.isConfigured(), adminEmails: adminRecipients() };
});

route('GET', '/api/admin/bookings', ({ req, query }) => {
  requireAdmin(req);
  const list = svc.listBookings({ from: query.get('from'), to: query.get('to'), status: query.get('status'), q: query.get('q') });
  return { bookings: list.map(adminView) };
});

route('GET', '/api/admin/day', ({ req, query }) => {
  requireAdmin(req);
  const date = query.get('date');
  if (!isValidDate(date)) throw new ApiError(400, 'Invalid date');
  const day = svc.getDaySchedule(date);
  const rows = day.rows.map((r) => (r.type === 'booking' ? { type: 'booking', fromPrevDay: r.fromPrevDay, booking: adminView(r.booking) } : r));
  return { date, closed: day.closed, rows };
});

route('POST', '/api/admin/bookings', async ({ req }) => {
  requireAdmin(req);
  const body = await readBody(req);
  const b = svc.createBooking(body, { admin: true });
  return { booking: adminView(b) };
});

route('POST', '/api/admin/bookings/(HZ-[A-Za-z0-9]{6})/(confirm|decline|cancel|checkin)', ({ req, params }) => {
  requireAdmin(req);
  const b = svc.applyAction(params[0], params[1]);
  notifyStatusChange(b, params[1], baseUrl(req));
  return { booking: adminView(b) };
});

route('GET', '/api/admin/settings', ({ req }) => {
  requireAdmin(req);
  return { settings: store.settings };
});

route('PUT', '/api/admin/settings', async ({ req }) => {
  requireAdmin(req);
  const body = await readBody(req);
  return { settings: svc.updateSettings(body) };
});

// ---------- static files ----------
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const pretty = { '/book': '/book.html', '/admin': '/admin.html', '/receipt': '/receipt.html' };
  if (pretty[rel]) rel = pretty[rel];
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || path.basename(file).startsWith('.')) {
    res.writeHead(403, SECURITY_HEADERS);
    return res.end('Forbidden');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>404</h1><p>Page not found.</p><a href="/">Back to HITZONE</a>');
    }
    const ext = path.extname(file).toLowerCase();
    const isAsset = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico'].includes(ext);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': isAsset ? 'public, max-age=86400' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    res.writeHead(400);
    return res.end('Bad request');
  }
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      try {
        const result = await r.handler({ req, res, query: url.searchParams, params: m.slice(1) });
        if (result !== null && !res.writableEnded) sendJson(res, 200, result);
      } catch (err) {
        if (err instanceof ApiError) sendJson(res, err.status, { error: err.message, field: err.field });
        else {
          console.error('[error]', err);
          sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
        }
      }
      return;
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, SECURITY_HEADERS);
    return res.end('Method not allowed');
  }
  try {
    serveStatic(req, res, pathname);
  } catch (_) {
    res.writeHead(400);
    res.end('Bad request');
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => `http://${i.address}:${PORT}`);
    console.log('\n  HITZONE booking site is running');
    console.log(`  Website : http://localhost:${PORT}`);
    console.log(`  Admin   : http://localhost:${PORT}/admin.html`);
    if (lan.length) console.log(`  On phone (same Wi-Fi): ${lan.join('  ')}`);
    console.log(`  Emails  : ${mailer.isConfigured() ? 'SMTP configured' : 'SMTP NOT configured - emails are saved to data/outbox.log (see README)'}`);
    if (USING_DEFAULT_PASSWORD) console.log('  WARNING : using the default admin password. Set ADMIN_PASSWORD in .env before going live!');
    console.log('');
  });
}

module.exports = { server };
