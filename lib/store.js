'use strict';
/**
 * Local JSON-file storage (no database needed).
 *  - data/settings.json  : price, opening hours, contact details ... (safe to edit by hand)
 *  - data/bookings.json  : every booking / block
 * Writes are atomic (temp file + rename) and a dated backup is kept in data/backups/.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const BOOKINGS_FILE = path.join(DATA_DIR, 'bookings.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const DEFAULT_SETTINGS = {
  businessName: 'HITZONE Indoor Cricket Arena',
  tagline: 'Come. Play. Hit. Repeat.',
  currency: 'LKR',
  pricePerHour: 5500,
  openTime: '00:00',
  closeTime: '24:00', // open 24 hours
  stepMinutes: 15, // customers can pick any start / end time on a 15-minute grid
  minBookingMinutes: 60, // shortest booking customers can make
  maxHoursPerBooking: 4,
  advanceBookingDays: 30,
  minNoticeMinutes: 30,
  timezone: 'Asia/Colombo',
  autoConfirm: false,
  closedDates: [],
  paymentNote: 'Please pay at the arena before you start playing.',
  contact: { phone: '', whatsapp: '', email: '', address: '', mapUrl: '' },
  settingsVersion: 3,
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Never overwrite a file we cannot parse - tell the owner clearly instead.
    throw new Error(`${path.basename(file)} is not valid JSON (${err.message}). Fix it or restore from data/backups/.`);
  }
}

function dailyBackup(file) {
  try {
    if (!fs.existsSync(file)) return;
    ensureDir(BACKUP_DIR);
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(BACKUP_DIR, `${path.basename(file, '.json')}-${stamp}.json`);
    if (!fs.existsSync(dest)) fs.copyFileSync(file, dest);
  } catch (_) {
    /* backups are best-effort */
  }
}

function writeJson(file, data) {
  ensureDir(DATA_DIR);
  dailyBackup(file);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function mergeSettings(saved) {
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    contact: { ...DEFAULT_SETTINGS.contact, ...((saved && saved.contact) || {}) },
  };
}

const savedSettings = readJson(SETTINGS_FILE, null);
const store = {
  settings: mergeSettings(savedSettings || {}),
  bookings: readJson(BOOKINGS_FILE, []),
  saveSettings() {
    writeJson(SETTINGS_FILE, this.settings);
  },
  saveBookings() {
    writeJson(BOOKINGS_FILE, this.bookings);
  },
};

if (!Array.isArray(store.bookings)) throw new Error('bookings.json must contain a JSON array ([]).');
if (!fs.existsSync(SETTINGS_FILE)) store.saveSettings(); // write defaults on first run

// One-time upgrade of installs made with the old 1-hour slots -> 30-minute steps, 1-hour minimum.
// Existing bookings are untouched (they all start on the hour, which is still on the new grid).
if (savedSettings && (savedSettings.settingsVersion || 1) < 2) {
  store.settings.slotMinutes = 30;
  store.settings.minBookingMinutes = 60;
  store.settings.settingsVersion = 2;
  store.saveSettings();
  console.log('[settings] Upgraded to 30-minute booking steps (minimum booking 1 hour).');
}
// v3: free start/end times on a 15-minute grid replace fixed slots (slotMinutes is no longer used).
if (savedSettings && (savedSettings.settingsVersion || 1) < 3) {
  store.settings.stepMinutes = 15;
  store.settings.minBookingMinutes = store.settings.minBookingMinutes || 60;
  delete store.settings.slotMinutes;
  store.settings.settingsVersion = 3;
  store.saveSettings();
  console.log('[settings] Upgraded to free start/end times (15-minute steps).');
}
if (!fs.existsSync(BOOKINGS_FILE)) store.saveBookings();

module.exports = { store, DEFAULT_SETTINGS };
