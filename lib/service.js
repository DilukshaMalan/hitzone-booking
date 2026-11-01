'use strict';
/** Booking business rules: availability, validation, status changes, stats. */
const crypto = require('crypto');
const { store } = require('./store');
const { toMin, fromMin, nowIn, addDays, dayNum, isValidDate, isValidTime, isValidEnd, isValidCloseTime, durationText } = require('./util');

class ApiError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

const ACTIVE = new Set(['pending', 'confirmed', 'blocked']);
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function settings() {
  return store.settings;
}

function newRef() {
  for (;;) {
    let r = 'HZ-';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) r += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
    if (!store.bookings.some((b) => b.ref === r)) return r;
  }
}

const step = (s = settings()) => s.stepMinutes || 15;
const is24h = (s = settings()) => s.openTime === '00:00' && s.closeTime === '24:00';
const minBooking = (s = settings()) => s.minBookingMinutes || step(s);

/** Round up to the next point on the booking grid (e.g. 14:07 -> 14:15 on a 15-minute grid). */
const ceilToStep = (m, s = settings()) => Math.ceil(m / step(s)) * step(s);

/** Absolute minutes of a booking relative to midnight of `date` (can be negative / > 1440). */
function relRange(b, date) {
  const off = (dayNum(b.date) - dayNum(date)) * 1440;
  return [off + toMin(b.start), off + toMin(b.end)];
}

/** Active bookings that touch `date` or spill over from the day before / into the next day. */
function nearbyBookings(date, ignoreRef) {
  return store.bookings.filter(
    (b) => ACTIVE.has(b.status) && b.ref !== ignoreRef && Math.abs(dayNum(b.date) - dayNum(date)) <= 1
  );
}

function overlapsRange(date, startMin, endMin, ignoreRef) {
  return nearbyBookings(date, ignoreRef).some((b) => {
    const [bs, be] = relRange(b, date);
    return bs < endMin && be > startMin;
  });
}

function isPast(date, startMin, s = settings()) {
  const now = nowIn(s.timezone);
  if (date < now.date) return true;
  if (date === now.date && startMin < now.minutes + s.minNoticeMinutes) return true;
  return false;
}

function bookableRange(s = settings()) {
  const today = nowIn(s.timezone).date;
  return { today, last: addDays(today, s.advanceBookingDays) };
}

/** Is the day after `date` somewhere a booking may run into? (24-hour arenas only) */
function nextDayUsable(date, s, { admin = false } = {}) {
  const next = addDays(date, 1);
  if (s.closedDates.includes(next)) return false;
  if (!admin && next > bookableRange(s).last) return false;
  return true;
}

/** Merge touching / overlapping [start,end) windows (sorted copy). */
function mergeWindows(list) {
  const out = [];
  for (const w of [...list].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && w.start <= last.end && w.kind === last.kind) last.end = Math.max(last.end, w.end);
    else out.push({ ...w });
  }
  return out;
}

/**
 * Availability for one date, as time windows (minutes from 00:00 of that date; 1440+ = after midnight).
 *  unavailable: [{start,end,kind}] kind = booked | closed | past   (never contains customer details)
 *  free:        [{start,end}]  everything that is left, 0..2880
 *  bookable:    [{start,end}]  free windows long enough for the shortest booking and starting in this day
 */
function getAvailability(date) {
  const s = settings();
  if (!isValidDate(date)) throw new ApiError(400, 'Invalid date', 'date');
  const { today, last } = bookableRange(s);
  const closed = s.closedDates.includes(date);
  const outOfRange = date < today || date > last;
  const END = 2880; // the planning horizon: this day + the whole next day
  const bad = [];

  if (closed || date > last) bad.push({ start: 0, end: END, kind: 'closed' });
  else if (date < today) bad.push({ start: 0, end: END, kind: 'past' });
  else {
    if (!is24h(s)) {
      bad.push({ start: 0, end: toMin(s.openTime), kind: 'closed' });
      bad.push({ start: toMin(s.closeTime), end: END, kind: 'closed' });
    } else if (!nextDayUsable(date, s)) {
      bad.push({ start: 1440, end: END, kind: 'closed' });
    }
    if (date === today) {
      const now = nowIn(s.timezone);
      bad.push({ start: 0, end: ceilToStep(now.minutes + s.minNoticeMinutes, s), kind: 'past' });
    }
    for (const b of nearbyBookings(date)) {
      const [bs, be] = relRange(b, date);
      const start = Math.max(0, bs);
      const end = Math.min(END, be);
      if (end > start) bad.push({ start, end, kind: 'booked' });
    }
  }

  const unavailable = mergeWindows(bad.filter((w) => w.end > w.start));
  // free = complement of the union of all unavailable windows
  const union = [];
  for (const w of [...unavailable].sort((a, b) => a.start - b.start)) {
    const l = union[union.length - 1];
    if (l && w.start <= l.end) l.end = Math.max(l.end, w.end);
    else union.push({ start: w.start, end: w.end });
  }
  const free = [];
  let cur = 0;
  for (const w of union) {
    if (w.start > cur) free.push({ start: cur, end: w.start });
    cur = Math.max(cur, w.end);
  }
  if (cur < END) free.push({ start: cur, end: END });

  const bookable = free
    .map((w) => ({ start: ceilToStep(w.start, s), end: w.end - ((w.end) % step(s)) }))
    .filter((w) => w.start < 1440 && w.end - w.start >= minBooking(s))
    .map((w) => ({ start: w.start, end: w.end }));

  const dayMinutes = bookable.reduce((sum, w) => sum + Math.max(0, Math.min(w.end, 1440) - w.start), 0);
  return {
    date,
    closed,
    outOfRange,
    stepMinutes: step(s),
    minMinutes: minBooking(s),
    maxMinutes: Math.round(s.maxHoursPerBooking * 60),
    pricePerHour: s.pricePerHour,
    unavailable,
    free,
    bookable,
    freeMinutes: dayMinutes,
  };
}

/** The admin's view of one day: bookings and free gaps in time order. */
function getDaySchedule(date) {
  const s = settings();
  if (!isValidDate(date)) throw new ApiError(400, 'Invalid date', 'date');
  const from = is24h(s) ? 0 : toMin(s.openTime);
  const to = is24h(s) ? 1440 : toMin(s.closeTime);
  const todays = nearbyBookings(date)
    .map((b) => ({ b, r: relRange(b, date) }))
    .filter(({ r }) => r[0] < 1440 && r[1] > 0)
    .sort((x, y) => x.r[0] - y.r[0]);
  const rows = [];
  let cur = from;
  for (const { b, r } of todays) {
    if (r[0] > cur) rows.push({ type: 'free', start: cur, end: Math.min(r[0], to) });
    rows.push({ type: 'booking', booking: b, fromPrevDay: r[0] < 0 });
    cur = Math.max(cur, Math.min(r[1], 1440));
  }
  if (cur < to) rows.push({ type: 'free', start: cur, end: to });
  return { date, closed: s.closedDates.includes(date), rows: rows.filter((x) => x.type !== 'free' || x.end > x.start) };
}

// ---------- validation helpers ----------
function cleanText(v, max) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanPhone(v) {
  const raw = String(v ?? '').trim();
  const digits = raw.replace(/[^\d]/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return (raw.startsWith('+') ? '+' : '') + digits;
}

function cleanEmail(v) {
  const e = String(v ?? '').trim().toLowerCase();
  if (!e) return '';
  if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
  return e;
}

/**
 * Validate a free start / end time and return {date,start,end,hours,amount}.
 * `end` earlier than (or equal to) `start` means "after midnight" (e.g. 22:00 -> 01:00).
 */
function resolveRange(date, start, end, { admin = false } = {}) {
  const s = settings();
  const st = step(s);
  if (!isValidDate(date)) throw new ApiError(400, 'Please choose a valid date.', 'date');
  if (!isValidTime(start)) throw new ApiError(400, 'Please choose a start time.', 'start');
  if (!isValidEnd(end)) throw new ApiError(400, 'Please choose an end time.', 'end');
  if (!admin) {
    const { today, last } = bookableRange(s);
    if (date < today) throw new ApiError(400, 'That date has already passed.', 'date');
    if (date > last) throw new ApiError(400, `Bookings open up to ${s.advanceBookingDays} days in advance.`, 'date');
  }
  if (s.closedDates.includes(date)) throw new ApiError(400, 'The arena is closed on that date.', 'date');

  const startMin = toMin(start);
  let endMin = toMin(end);
  if (endMin <= startMin) endMin += 1440;
  if (startMin % st || endMin % st) throw new ApiError(400, `Times must be on a ${st}-minute step (for example 3:00 or 3:15).`, 'start');

  const minutes = endMin - startMin;
  if (!admin && minutes < minBooking(s)) {
    throw new ApiError(400, `The shortest booking is ${durationText(minBooking(s) / 60)}. Please choose a later end time.`, 'end');
  }
  if (minutes > s.maxHoursPerBooking * 60) throw new ApiError(400, `You can book up to ${s.maxHoursPerBooking} hours at a time.`, 'end');

  if (!is24h(s)) {
    if (startMin < toMin(s.openTime) || endMin > toMin(s.closeTime)) {
      throw new ApiError(400, `We are open ${fromMin(toMin(s.openTime))} to ${fromMin(toMin(s.closeTime))}. Please choose a time inside opening hours.`, 'end');
    }
  } else if (endMin > 1440 && !nextDayUsable(date, s, { admin })) {
    throw new ApiError(400, 'That booking would run into a day the arena is closed or not yet open for booking. Please end by midnight.', 'end');
  }
  if (!admin && isPast(date, startMin, s)) throw new ApiError(409, 'That time has already passed. Please pick a later start time.', 'start');
  if (overlapsRange(date, startMin, endMin)) {
    throw new ApiError(409, 'Sorry, that time overlaps another booking. Please check the free times and choose again.', 'start');
  }
  const hours = minutes / 60;
  return { date, start: fromMin(startMin), end: fromMin(endMin), hours, amount: Math.round(hours * s.pricePerHour) };
}

function createBooking(input, { admin = false } = {}) {
  const s = settings();
  const type = admin && ['walkin', 'block'].includes(input.type) ? input.type : 'online';
  const resolved = resolveRange(input.date, input.start, input.end, { admin });

  let name = cleanText(input.name, 60);
  let phone = '';
  let email = '';
  let players = 1;
  const notes = cleanText(input.notes, 300);

  if (type === 'block') {
    name = name || 'Blocked';
  } else {
    if (name.length < 2) throw new ApiError(400, 'Please enter your name.', 'name');
    if (type === 'online' || input.phone) {
      phone = cleanPhone(input.phone);
      if (!phone) throw new ApiError(400, 'Please enter a valid phone number (e.g. 077 123 4567).', 'phone');
    }
    if (input.email) {
      email = cleanEmail(input.email);
      if (email === null) throw new ApiError(400, 'That email address does not look right.', 'email');
    }
    players = parseInt(input.players, 10);
    if (!Number.isFinite(players) || players < 1) players = 1;
    players = Math.min(players, 30);
  }

  const now = new Date().toISOString();
  let status = 'pending';
  if (type === 'block') status = 'blocked';
  else if (type === 'walkin' || s.autoConfirm) status = 'confirmed';

  const booking = {
    ref: newRef(),
    type,
    status,
    ...resolved,
    pricePerHour: s.pricePerHour,
    currency: s.currency,
    name,
    phone,
    email,
    players,
    notes,
    createdAt: now,
    updatedAt: now,
  };
  if (status === 'confirmed') booking.confirmedAt = now;
  store.bookings.push(booking);
  store.saveBookings();
  return booking;
}

function findBooking(ref) {
  return store.bookings.find((b) => b.ref === String(ref || '').toUpperCase());
}

function applyAction(ref, action) {
  const b = findBooking(ref);
  if (!b) throw new ApiError(404, 'Booking not found');
  const now = new Date().toISOString();
  const need = (...statuses) => {
    if (!statuses.includes(b.status)) throw new ApiError(409, `This booking is already ${b.status}.`);
  };
  switch (action) {
    case 'confirm':
      need('pending');
      b.status = 'confirmed';
      b.confirmedAt = now;
      break;
    case 'decline':
      need('pending');
      b.status = 'declined';
      break;
    case 'cancel':
      need('pending', 'confirmed', 'blocked');
      b.status = 'cancelled';
      break;
    case 'checkin':
      need('confirmed');
      b.checkedInAt = now;
      break;
    default:
      throw new ApiError(400, 'Unknown action');
  }
  b.updatedAt = now;
  store.saveBookings();
  return b;
}

// ---------- views ----------
function maskPhone(p) {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  return `••• ••• ${d.slice(-3)}`;
}

function maskEmail(e) {
  if (!e) return '';
  const [u, d] = e.split('@');
  return `${u[0]}•••@${d}`;
}

function publicView(b) {
  const s = settings();
  return {
    ref: b.ref,
    status: b.status,
    type: b.type,
    date: b.date,
    start: b.start,
    end: b.end,
    hours: b.hours,
    amount: b.amount,
    currency: b.currency,
    name: b.type === 'block' ? 'Reserved' : b.name,
    players: b.players,
    phone: maskPhone(b.phone),
    email: maskEmail(b.email),
    checkedIn: !!b.checkedInAt,
    createdAt: b.createdAt,
    arena: s.businessName,
    paymentNote: s.paymentNote,
  };
}

function listBookings({ from, to, status, q } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return store.bookings
    .filter((b) => (!from || b.date >= from) && (!to || b.date <= to))
    .filter((b) => !status || status === 'all' || b.status === status)
    .filter(
      (b) =>
        !needle ||
        b.ref.toLowerCase().includes(needle) ||
        (b.name || '').toLowerCase().includes(needle) ||
        (b.phone || '').replace(/\D/g, '').includes(needle.replace(/\D/g, '') || '\u0000') ||
        (b.email || '').includes(needle)
    )
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

function stats() {
  const s = settings();
  const now = nowIn(s.timezone);
  const month = now.date.slice(0, 7);
  const confirmed = store.bookings.filter((b) => b.status === 'confirmed');
  return {
    today: now.date,
    pending: store.bookings.filter((b) => b.status === 'pending').length,
    todayCount: confirmed.filter((b) => b.date === now.date).length,
    upcoming: confirmed.filter((b) => b.date > now.date || (b.date === now.date && toMin(b.end) > now.minutes) || (dayNum(b.date) === dayNum(now.date) - 1 && toMin(b.end) > 1440 + now.minutes)).length,
    monthRevenue: confirmed.filter((b) => b.date.startsWith(month)).reduce((sum, b) => sum + b.amount, 0),
    monthHours: confirmed.filter((b) => b.date.startsWith(month)).reduce((sum, b) => sum + b.hours, 0),
    currency: s.currency,
  };
}

function publicConfig() {
  const s = settings();
  const { today, last } = bookableRange(s);
  return {
    businessName: s.businessName,
    tagline: s.tagline,
    currency: s.currency,
    pricePerHour: s.pricePerHour,
    openTime: s.openTime,
    closeTime: s.closeTime,
    stepMinutes: step(s),
    minBookingMinutes: minBooking(s),
    maxHoursPerBooking: s.maxHoursPerBooking,
    advanceBookingDays: s.advanceBookingDays,
    autoConfirm: s.autoConfirm,
    closedDates: s.closedDates,
    paymentNote: s.paymentNote,
    contact: s.contact,
    today,
    lastBookableDate: last,
  };
}

function updateSettings(input) {
  const s = store.settings;
  const next = { ...s, contact: { ...s.contact } };
  const int = (v, min, max, field) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n) || n < min || n > max) throw new ApiError(400, `${field} must be between ${min} and ${max}.`, field);
    return n;
  };
  if (input.pricePerHour !== undefined) next.pricePerHour = int(input.pricePerHour, 0, 1000000, 'pricePerHour');
  if (input.stepMinutes !== undefined) {
    next.stepMinutes = int(input.stepMinutes, 5, 60, 'stepMinutes');
    if (![5, 10, 15, 30, 60].includes(next.stepMinutes)) throw new ApiError(400, 'Time step must be 5, 10, 15, 30 or 60 minutes.', 'stepMinutes');
  }
  if (input.openTime !== undefined) {
    if (!isValidTime(input.openTime)) throw new ApiError(400, 'Opening time is not valid.', 'openTime');
    next.openTime = input.openTime;
  }
  if (input.closeTime !== undefined) {
    if (!isValidCloseTime(input.closeTime)) throw new ApiError(400, 'Closing time is not valid.', 'closeTime');
    next.closeTime = input.closeTime;
  }
  if (toMin(next.closeTime) - toMin(next.openTime) < (next.stepMinutes || 15)) {
    throw new ApiError(400, 'Closing time must be after opening time (same day).', 'closeTime');
  }
  if (input.maxHoursPerBooking !== undefined) next.maxHoursPerBooking = int(input.maxHoursPerBooking, 1, 12, 'maxHoursPerBooking');
  if (input.minBookingMinutes !== undefined) next.minBookingMinutes = int(input.minBookingMinutes, 15, 720, 'minBookingMinutes');
  // the shortest booking must fit the time step (e.g. 50 min on a 15-minute grid is rounded up to 60)
  next.stepMinutes = next.stepMinutes || 15;
  next.minBookingMinutes = Math.max(next.stepMinutes, Math.ceil((next.minBookingMinutes || next.stepMinutes) / next.stepMinutes) * next.stepMinutes);
  if (next.minBookingMinutes > next.maxHoursPerBooking * 60) throw new ApiError(400, 'The shortest booking cannot be longer than the maximum booking.', 'minBookingMinutes');
  if (input.advanceBookingDays !== undefined) next.advanceBookingDays = int(input.advanceBookingDays, 1, 365, 'advanceBookingDays');
  if (input.minNoticeMinutes !== undefined) next.minNoticeMinutes = int(input.minNoticeMinutes, 0, 1440, 'minNoticeMinutes');
  if (input.autoConfirm !== undefined) next.autoConfirm = !!input.autoConfirm;
  if (input.businessName !== undefined) next.businessName = cleanText(input.businessName, 80) || s.businessName;
  if (input.paymentNote !== undefined) next.paymentNote = cleanText(input.paymentNote, 300);
  if (input.closedDates !== undefined) {
    if (!Array.isArray(input.closedDates) || !input.closedDates.every(isValidDate)) throw new ApiError(400, 'Closed dates must be YYYY-MM-DD.', 'closedDates');
    next.closedDates = [...new Set(input.closedDates)].sort();
  }
  if (input.contact && typeof input.contact === 'object') {
    for (const k of ['phone', 'whatsapp', 'email', 'address', 'mapUrl']) {
      if (input.contact[k] !== undefined) next.contact[k] = cleanText(input.contact[k], 200);
    }
    if (next.contact.mapUrl && !/^https?:\/\//i.test(next.contact.mapUrl)) throw new ApiError(400, 'Map link must start with http:// or https://', 'mapUrl');
  }
  store.settings = next;
  store.saveSettings();
  return next;
}

module.exports = {
  ApiError,
  getAvailability,
  createBooking,
  findBooking,
  applyAction,
  publicView,
  listBookings,
  stats,
  publicConfig,
  updateSettings,
  getDaySchedule,
};
