'use strict';

const pad = (n) => String(n).padStart(2, '0');

const toMin = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};

const fromMin = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;

function fmt12(t) {
  const [h, m] = String(t).split(':').map(Number);
  if (h === 24) return `12:${pad(m)} AM`; // end of day = midnight
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${pad(m)} ${ap}`;
}

/** Current local date (YYYY-MM-DD) and minutes-since-midnight in the arena's timezone. */
function nowIn(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10),
  };
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isValidTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** Closing time may be 24:00 (midnight) for arenas open all day. */
function isValidCloseTime(s) {
  return s === '24:00' || isValidTime(s);
}

function longDate(s) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${s}T00:00:00Z`));
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(n, currency = 'LKR') {
  return `${currency} ${Number(n).toLocaleString('en-US')}`;
}

/** Sri Lankan style numbers -> international digits for wa.me links. */
function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '94' + d.slice(1);
  return d;
}

module.exports = { pad, toMin, fromMin, fmt12, nowIn, addDays, isValidDate, isValidTime, isValidCloseTime, longDate, esc, money, waNumber };
