'use strict';
/**
 * End-to-end test: starts the real server against a temp data folder and a fake SMTP server.
 * Run with:  npm test
 */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const SMTP_PORT = 2500 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hitzone-test-'));
const mails = [];

// ---- fake SMTP server (captures messages) ----
const smtp = net.createServer((sock) => {
  let inData = false;
  let buf = '';
  let msg = '';
  sock.write('220 fake ESMTP\r\n');
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          mails.push(msg);
          msg = '';
          sock.write('250 queued\r\n');
        } else msg += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
      } else if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250 8BITMIME\r\n');
      else if (/^MAIL FROM|^RCPT TO/i.test(line)) sock.write('250 ok\r\n');
      else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
      else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
      else sock.write('250 ok\r\n');
    }
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token = '';
const api = async (method, url, body, auth) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.arrayBuffer() };
};

function decodeMail(raw) {
  // decode base64 text parts so we can assert on content
  const parts = raw.split(/\r\n--[^\r\n]+\r\n/);
  return parts
    .map((p) => {
      const [head, ...rest] = p.split('\r\n\r\n');
      const body = rest.join('\r\n\r\n');
      if (/Content-Transfer-Encoding: base64/i.test(head)) return head + '\n' + Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('latin1');
      return p;
    })
    .join('\n----\n');
}

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

(async () => {
  await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: tmp,
      ADMIN_PASSWORD: 'test-pass',
      ADMIN_EMAIL: 'owner@example.com',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(SMTP_PORT),
      SMTP_SECURE: 'false',
      MAIL_FROM: 'HITZONE <bookings@hitzone.test>',
      BASE_URL: 'https://hitzone.example',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => (serverLog += d));
  child.stderr.on('data', (d) => (serverLog += d));

  try {
    for (let i = 0; i < 40; i++) {
      try { await fetch(BASE + '/api/config'); break; } catch (_) { await sleep(150); }
    }

    // --- config & availability
    let r = await api('GET', '/api/config');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.pricePerHour, 5500);
    ok('config returns price 5500');

    const date = r.data.lastBookableDate; // far enough in the future to never be "past"
    r = await api('GET', `/api/availability?date=${date}`);
    assert.strictEqual(r.data.slots.length, 24);
    assert(r.data.slots.every((s) => s.status === 'available'));
    ok('24 hourly slots (open 24 hours), all available on a future day');

    r = await api('GET', '/api/availability?date=2020-01-01');
    assert(r.data.slots.every((s) => s.status === 'past'));
    ok('past dates are not bookable');

    // --- booking validation
    const good = { date, slots: ['18:00', '19:00'], name: 'Nuwan Perera', phone: '077 123 4567', email: 'nuwan@example.com', players: 6, notes: 'Birthday <b>game</b>' };
    r = await api('POST', '/api/bookings', { ...good, slots: ['18:00', '20:00'] });
    assert.strictEqual(r.status, 400);
    ok('non-continuous slots rejected');
    r = await api('POST', '/api/bookings', { ...good, phone: '123' });
    assert.strictEqual(r.status, 400);
    ok('bad phone rejected');
    r = await api('POST', '/api/bookings', { ...good, slots: ['09:00', '10:00', '11:00', '12:00', '13:00'] });
    assert.strictEqual(r.status, 400);
    ok('max hours per booking enforced');
    r = await api('POST', '/api/bookings', { ...good, date: '2020-01-01' });
    assert.strictEqual(r.status, 400);
    ok('past date rejected');

    r = await api('POST', '/api/bookings', good);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const ref = r.data.booking.ref;
    assert.match(ref, /^HZ-[A-Z0-9]{6}$/);
    assert.strictEqual(r.data.booking.status, 'pending');
    assert.strictEqual(r.data.booking.amount, 11000);
    assert.strictEqual(r.data.booking.start, '18:00');
    assert.strictEqual(r.data.booking.end, '20:00');
    ok(`booking created ${ref}: 2h = LKR 11,000, pending`);

    r = await api('POST', '/api/bookings', { ...good, slots: ['19:00', '20:00'], name: 'Someone Else' });
    assert.strictEqual(r.status, 409);
    ok('overlapping booking rejected (409)');

    r = await api('GET', `/api/availability?date=${date}`);
    const st = Object.fromEntries(r.data.slots.map((s) => [s.start, s.status]));
    assert.strictEqual(st['18:00'], 'booked');
    assert.strictEqual(st['19:00'], 'booked');
    assert.strictEqual(st['20:00'], 'available');
    assert.strictEqual(st['17:00'], 'available');
    ok('availability shows booked slots');

    // --- emails
    await sleep(800);
    assert.strictEqual(mails.length, 2, `expected 2 emails, got ${mails.length}`);
    const adminMail = decodeMail(mails.find((m) => /RCPT|To: owner@example.com/.test(m)));
    assert(/To: owner@example\.com/.test(mails[0]) || /To: owner@example\.com/.test(mails[1]));
    assert(adminMail.includes('Nuwan Perera') && adminMail.includes(ref));
    const htmlPart = adminMail.split('Content-Type: text/html')[1] || '';
    assert(!htmlPart.includes('<b>game</b>'), 'notes must be HTML-escaped in the HTML email');
    assert(htmlPart.includes('Birthday &lt;b&gt;game&lt;/b&gt;'));
    ok('owner got a notification email (HTML-escaped)');
    const custMail = mails.find((m) => /To: nuwan@example\.com/.test(m));
    assert(custMail && /Content-ID: <bookingqr@hitzone>/.test(custMail) && /Content-Type: image\/png/.test(custMail));
    ok('customer got "request received" email with QR attachment');

    // --- receipt + QR
    r = await api('GET', `/api/bookings/${ref}`);
    assert.strictEqual(r.status, 200);
    assert(r.data.booking.phone.includes('567') && !r.data.booking.phone.includes('123'));
    assert(!JSON.stringify(r.data).includes('nuwan@example.com'));
    ok('public receipt masks phone & email');
    r = await api('GET', `/api/qr/${ref}.png`);
    assert.strictEqual(Buffer.from(r.data).slice(1, 4).toString(), 'PNG');
    r = await api('GET', `/api/qr/${ref}.svg`);
    assert.strictEqual(r.status, 200);
    fs.writeFileSync(path.join(tmp, 'sample-qr.png'), Buffer.from((await api('GET', `/api/qr/${ref}.png`)).data));
    ok('QR code endpoints work');

    // --- admin
    r = await api('GET', '/api/admin/bookings');
    assert.strictEqual(r.status, 401);
    r = await api('POST', '/api/admin/login', { password: 'nope' });
    assert.strictEqual(r.status, 401);
    r = await api('POST', '/api/admin/login', { password: 'test-pass' });
    assert.strictEqual(r.status, 200);
    token = r.data.token;
    ok('admin login (wrong password rejected)');

    r = await api('GET', '/api/admin/stats', null, true);
    assert.strictEqual(r.data.stats.pending, 1);
    r = await api('POST', `/api/admin/bookings/${ref}/confirm`, null, true);
    assert.strictEqual(r.data.booking.status, 'confirmed');
    r = await api('POST', `/api/admin/bookings/${ref}/confirm`, null, true);
    assert.strictEqual(r.status, 409);
    ok('admin can confirm once');
    await sleep(600);
    assert.strictEqual(mails.length, 3);
    assert(/Subject: .*/.test(mails[2]));
    assert(decodeMail(mails[2]).includes('confirmed'));
    ok('customer got "confirmed" email');

    r = await api('POST', '/api/admin/bookings', { type: 'block', date, slots: ['09:00'], name: 'Net maintenance' }, true);
    assert.strictEqual(r.data.booking.status, 'blocked');
    r = await api('POST', '/api/bookings', { ...good, slots: ['09:00'] });
    assert.strictEqual(r.status, 409);
    ok('admin can block a slot; customers cannot book it');

    r = await api('POST', '/api/admin/bookings', { type: 'walkin', date, slots: ['14:00', '15:00'], name: 'Walk-in Kamal', phone: '0712223344' }, true);
    assert.strictEqual(r.data.booking.status, 'confirmed');
    assert.strictEqual(r.data.booking.amount, 11000);
    ok('walk-in booking is confirmed immediately');

    r = await api('POST', `/api/admin/bookings/${ref}/checkin`, null, true);
    assert(r.data.booking.checkedInAt);
    r = await api('POST', `/api/admin/bookings/${ref}/cancel`, null, true);
    assert.strictEqual(r.data.booking.status, 'cancelled');
    r = await api('GET', `/api/availability?date=${date}`);
    assert.strictEqual(r.data.slots.find((s) => s.start === '18:00').status, 'available');
    ok('check-in works; cancel frees the slot again');

    r = await api('PUT', '/api/admin/settings', { pricePerHour: 6000 }, true);
    assert.strictEqual(r.data.settings.pricePerHour, 6000);
    // midnight: last slot of the day ends at 24:00 (12:00 AM)
    r = await api('POST', '/api/bookings', { ...good, slots: ['23:00'], name: 'Late Night' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.booking.end, '24:00');
    r = await api('POST', '/api/bookings', { ...good, slots: ['00:00', '01:00'], name: 'Early Bird' });
    assert.strictEqual(r.status, 200);
    ok('midnight hours (00:00 and 23:00-24:00) can be booked');
    r = await api('PUT', '/api/admin/settings', { openTime: '00:00', closeTime: '24:00' }, true);
    assert.strictEqual(r.status, 200);
    r = await api('PUT', '/api/admin/settings', { openTime: '23:00', closeTime: '09:00' }, true);
    assert.strictEqual(r.status, 400);
    ok('settings update & validation');

    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'bookings.json'), 'utf8'));
    assert.strictEqual(saved.length, 5);
    ok('bookings are saved in data/bookings.json');

    // --- static + safety
    let res = await fetch(BASE + '/');
    assert.strictEqual(res.status, 200);
    res = await fetch(BASE + '/..%2f..%2fserver.js');
    assert([403, 404].includes(res.status));
    res = await fetch(BASE + '/.env');
    assert([403, 404].includes(res.status));
    ok('static files served; path traversal & dotfiles blocked');

    console.log(`\nAll ${passed} checks passed. (sample QR: ${path.join(tmp, 'sample-qr.png')})`);
  } catch (err) {
    console.error('\nFAILED:', err.message);
    console.error('--- server log ---\n' + serverLog);
    process.exitCode = 1;
  } finally {
    child.kill();
    smtp.close();
  }
})();
