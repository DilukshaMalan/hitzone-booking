'use strict';
/**
 * Tiny zero-dependency SMTP mailer (supports SMTPS on 465 and STARTTLS on 587).
 * If SMTP is not configured, emails are written to data/outbox.log so nothing is lost
 * and the site still works during development.
 */
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');

function cfg() {
  const e = process.env;
  return {
    host: e.SMTP_HOST || '',
    port: parseInt(e.SMTP_PORT || '587', 10),
    secure: String(e.SMTP_SECURE || '').toLowerCase() === 'true' || e.SMTP_PORT === '465',
    user: e.SMTP_USER || '',
    pass: e.SMTP_PASS || '',
    from: e.MAIL_FROM || e.SMTP_USER || 'bookings@hitzone.local',
    rejectUnauthorized: String(e.SMTP_ALLOW_SELF_SIGNED || '').toLowerCase() !== 'true',
  };
}

function isConfigured() {
  return !!cfg().host;
}

function b64Lines(buf) {
  return buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
}

function encodeHeader(str) {
  if (/^[\x20-\x7e]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

function addrOnly(a) {
  const m = /<([^>]+)>/.exec(a);
  return (m ? m[1] : a).trim();
}

function buildMime({ from, to, subject, text, html, attachments = [] }) {
  const id = crypto.randomBytes(12).toString('hex');
  const domain = (addrOnly(from).split('@')[1] || 'hitzone.local').replace(/[^\w.-]/g, '');
  const relB = `rel_${id}`;
  const altB = `alt_${id}`;
  const lines = [];
  lines.push(`From: ${from}`);
  lines.push(`To: ${Array.isArray(to) ? to.join(', ') : to}`);
  lines.push(`Subject: ${encodeHeader(subject)}`);
  lines.push(`Date: ${new Date().toUTCString().replace('GMT', '+0000')}`);
  lines.push(`Message-ID: <${id}@${domain}>`);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/related; boundary="${relB}"`);
  lines.push('');
  lines.push(`--${relB}`);
  lines.push(`Content-Type: multipart/alternative; boundary="${altB}"`);
  lines.push('');
  lines.push(`--${altB}`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(b64Lines(Buffer.from(text || '', 'utf8')));
  lines.push(`--${altB}`);
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(b64Lines(Buffer.from(html || '', 'utf8')));
  lines.push(`--${altB}--`);
  for (const a of attachments) {
    lines.push(`--${relB}`);
    lines.push(`Content-Type: ${a.contentType}; name="${a.filename}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-ID: <${a.cid}>`);
    lines.push(`Content-Disposition: inline; filename="${a.filename}"`);
    lines.push('');
    lines.push(b64Lines(a.content));
  }
  lines.push(`--${relB}--`);
  lines.push('');
  return lines.join('\r\n');
}

/** Minimal line-based SMTP conversation over a (possibly upgraded) socket. */
class SmtpSession {
  constructor(socket) {
    this.setSocket(socket);
    this.waiters = [];
    this.buffer = '';
    this.lines = [];
  }
  setSocket(socket) {
    this.socket = socket;
    this.buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new Error('SMTP connection closed')));
    socket.setTimeout(25000, () => this.fail(new Error('SMTP timeout')));
  }
  fail(err) {
    this.error = this.error || err;
    const w = this.waiters.splice(0);
    w.forEach((x) => x.reject(this.error));
  }
  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\r\n')) >= 0 || (idx = this.buffer.indexOf('\n')) >= 0) {
      const sepLen = this.buffer[idx] === '\r' ? 2 : 1;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + sepLen);
      this.lines.push(line);
      // a final line looks like "250 text" (space after code)
      if (/^\d{3}( |$)/.test(line)) {
        const block = this.lines.splice(0);
        const w = this.waiters.shift();
        if (w) w.resolve({ code: parseInt(line.slice(0, 3), 10), lines: block });
        else this.pending = { code: parseInt(line.slice(0, 3), 10), lines: block };
      }
    }
  }
  read() {
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      return Promise.resolve(p);
    }
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  async expect(okCodes) {
    const res = await this.read();
    if (!okCodes.includes(res.code)) {
      throw new Error(`SMTP error ${res.code}: ${res.lines.join(' | ')}`);
    }
    return res;
  }
  async cmd(line, okCodes) {
    this.socket.write(line + '\r\n');
    return this.expect(okCodes);
  }
}

function connect(c) {
  return new Promise((resolve, reject) => {
    const opts = { host: c.host, port: c.port, servername: c.host, rejectUnauthorized: c.rejectUnauthorized };
    const sock = c.secure ? tls.connect(opts) : net.connect({ host: c.host, port: c.port });
    sock.once(c.secure ? 'secureConnect' : 'connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

async function smtpSend(c, mail) {
  const sock = await connect(c);
  const s = new SmtpSession(sock);
  try {
    await s.expect([220]);
    let ehlo = await s.cmd('EHLO hitzone.local', [250]);
    if (!c.secure && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
      await s.cmd('STARTTLS', [220]);
      sock.removeAllListeners('data');
      sock.removeAllListeners('close');
      sock.removeAllListeners('error');
      const secured = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: sock, servername: c.host, rejectUnauthorized: c.rejectUnauthorized }, () => resolve(t));
        t.once('error', reject);
      });
      s.setSocket(secured);
      ehlo = await s.cmd('EHLO hitzone.local', [250]);
    }
    if (c.user) {
      const caps = ehlo.lines.join(' ').toUpperCase();
      if (caps.includes('AUTH') && caps.includes('PLAIN')) {
        const token = Buffer.from(`\0${c.user}\0${c.pass}`).toString('base64');
        await s.cmd(`AUTH PLAIN ${token}`, [235]);
      } else {
        await s.cmd('AUTH LOGIN', [334]);
        await s.cmd(Buffer.from(c.user).toString('base64'), [334]);
        await s.cmd(Buffer.from(c.pass).toString('base64'), [235]);
      }
    }
    await s.cmd(`MAIL FROM:<${addrOnly(c.from)}>`, [250]);
    const recipients = Array.isArray(mail.to) ? mail.to : [mail.to];
    for (const r of recipients) await s.cmd(`RCPT TO:<${addrOnly(r)}>`, [250, 251]);
    await s.cmd('DATA', [354]);
    const body = buildMime({ ...mail, from: c.from })
      .split('\r\n')
      .map((l) => (l.startsWith('.') ? '.' + l : l))
      .join('\r\n');
    s.socket.write(body + '\r\n.\r\n');
    await s.expect([250]);
    try { s.socket.write('QUIT\r\n'); } catch (_) { /* ignore */ }
    s.socket.end();
    return true;
  } catch (err) {
    try { s.socket.destroy(); } catch (_) { /* ignore */ }
    throw err;
  }
}

function logLine(file, text) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, file), text + '\n');
  } catch (_) { /* ignore */ }
}

/**
 * Send an email. Never throws: failures are logged to data/mail-errors.log.
 * Returns { sent: boolean, mode: 'smtp'|'outbox', error? }
 */
async function sendMail(mail) {
  const to = Array.isArray(mail.to) ? mail.to.filter(Boolean) : [mail.to].filter(Boolean);
  if (!to.length) return { sent: false, mode: 'none', error: 'no recipient' };
  const m = { ...mail, to };
  if (!isConfigured()) {
    logLine(
      'outbox.log',
      `\n===== ${new Date().toISOString()} =====\nTO: ${to.join(', ')}\nSUBJECT: ${mail.subject}\n\n${mail.text || ''}\n` +
        `(SMTP not configured - fill in .env to send real emails)\n`
    );
    return { sent: false, mode: 'outbox' };
  }
  try {
    await smtpSend(cfg(), m);
    return { sent: true, mode: 'smtp' };
  } catch (err) {
    logLine('mail-errors.log', `${new Date().toISOString()} to=${to.join(',')} subject="${mail.subject}" error=${err.message}`);
    console.error('[mail] failed:', err.message);
    return { sent: false, mode: 'smtp', error: err.message };
  }
}

module.exports = { sendMail, isConfigured, buildMime };
