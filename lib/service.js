'use strict';
/** Booking business rules: availability, validation, status changes, stats. */
const crypto = require('crypto');
const { store } = require('./store');
const { toMin, fromMin, nowIn, addDays, isValidDate, isValidTime, isValidCloseTime } = require('./util');

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

/** All slot starts for the day, e.g. [{start:'09:30', end:'10:30'}, ...] */
function generateSlots(s = settings()) {
  const slots = [];
  const step = s.slotMinutes;
  for (let t = toMin(s.openTime); t + step <= toMin(s.closeTime); t += step) {
    slots.push({ start: fromMin(t), end: fromMin(t + step) });
  }
  return slots;
}

function slotPrice(s = settings()) {
  return Math.round((s.pricePerHour * s.slotMinutes) / 60);
}

function overlaps(date, startMin, endMin, ignoreRef) {
  return store.bookings.some(
    (b) =>
      b.date === date &&
      ACTIVE.has(b.status) &&
      b.ref !== ignoreRef &&
      toMin(b.start) < endMin &&
      toMin(b.end) > startMin
  );
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

function getAvailability(date) {
  const s = settings();
  if (!isValidDate(date)) throw new ApiError(400, 'Invalid date', 'date');
  const { today, last } = bookableRange(s);
  const closed = s.closedDates.includes(date);
  const outOfRange = date < today || date > last;
  const price = slotPrice(s);
  const slots = generateSlots(s).map(({ start, end }) => {
    let status = 'available';
    if (closed || date > last) status = 'closed';
    else if (isPast(date, toMin(start), s)) status = 'past';
    else if (overlaps(date, toMin(start), toMin(end))) status = 'booked';
    return { start, end, status, price };
  });
  return { date, closed, outOfRange, slots };
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

/** Validate chosen slot starts and return {date,start,end,hours,amount,slotStarts}. */
function resolveSlots(date, slotStarts, { skipPast = false } = {}) {
  const s = settings();
  if (!isValidDate(date)) throw new ApiError(400, 'Please choose a valid date.', 'date');
  if (!Array.isArray(slotStarts) || !slotStarts.length) throw new ApiError(400, 'Please choose at least one time slot.', 'slots');
  if (!skipPast) {
    const { today, last } = bookableRange(s);
    if (date < today) throw new ApiError(400, 'That date has already passed.', 'date');
    if (date > last) throw new ApiError(400, `Bookings open up to ${s.advanceBookingDays} days in advance.`, 'date');
  }
  if (s.closedDates.includes(date)) throw new ApiError(400, 'The arena is closed on that date.', 'date');

  const grid = new Set(generateSlots(s).map((x) => x.start));
  const starts = [...new Set(slotStarts.map(String))].sort();
  for (const t of starts) if (!isValidTime(t) || !grid.has(t)) throw new ApiError(400, 'One of the chosen time slots is not valid.', 'slots');
  for (let i = 1; i < starts.length; i++) {
    if (toMin(starts[i]) - toMin(starts[i - 1]) !== s.slotMinutes) {
      throw new ApiError(400, 'Please choose one continuous time period (back-to-back slots).', 'slots');
    }
  }
  const hours = (starts.length * s.slotMinutes) / 60;
  if (hours > s.maxHoursPerBooking) throw new ApiError(400, `You can book up to ${s.maxHoursPerBooking} hours at a time.`, 'slots');

  const startMin = toMin(starts[0]);
  const endMin = toMin(starts[starts.length - 1]) + s.slotMinutes;
  if (!skipPast && isPast(date, startMin, s)) throw new ApiError(409, 'That time has already passed. Please pick a later slot.', 'slots');
  if (overlaps(date, startMin, endMin)) throw new ApiError(409, 'Sorry, one of those slots was just taken. Please pick another time.', 'slots');

  return {
    date,
    start: fromMin(startMin),
    end: fromMin(endMin),
    hours,
    amount: Math.round(hours * s.pricePerHour),
    slots: starts,
  };
}

function createBooking(input, { admin = false } = {}) {
  const s = settings();
  const type = admin && ['walkin', 'block'].includes(input.type) ? input.type : 'online';
  const resolved = resolveSlots(input.date, input.slots, { skipPast: admin });

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
    upcoming: confirmed.filter((b) => b.date > now.date || (b.date === now.date && toMin(b.end) > now.minutes)).length,
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
    slotMinutes: s.slotMinutes,
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
  if (input.slotMinutes !== undefined) {
    next.slotMinutes = int(input.slotMinutes, 30, 120, 'slotMinutes');
    if (![30, 60, 90, 120].includes(next.slotMinutes)) throw new ApiError(400, 'Slot length must be 30, 60, 90 or 120 minutes.', 'slotMinutes');
  }
  if (input.openTime !== undefined) {
    if (!isValidTime(input.openTime)) throw new ApiError(400, 'Opening time is not valid.', 'openTime');
    next.openTime = input.openTime;
  }
  if (input.closeTime !== undefined) {
    if (!isValidCloseTime(input.closeTime)) throw new ApiError(400, 'Closing time is not valid.', 'closeTime');
    next.closeTime = input.closeTime;
  }
  if (toMin(next.closeTime) - toMin(next.openTime) < next.slotMinutes) {
    throw new ApiError(400, 'Closing time must be after opening time (same day).', 'closeTime');
  }
  if (input.maxHoursPerBooking !== undefined) next.maxHoursPerBooking = int(input.maxHoursPerBooking, 1, 12, 'maxHoursPerBooking');
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
  generateSlots,
};
