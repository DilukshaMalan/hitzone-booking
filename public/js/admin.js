'use strict';
injectChrome('admin');

const A = { settings: null, tab: 'requests', pending: 0, today: null, day: null, timer: null };
const call = (path, opts = {}) => api(path, { ...opts, auth: true });
const todayStr = () => A.today || new Date().toISOString().slice(0, 10);
const shiftDate = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/* ---------------- auth ---------------- */
function showLogin(msg) {
  localStorage.removeItem('hz_admin');
  clearInterval(A.timer);
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  const box = $('#login-error');
  box.textContent = msg || '';
  box.classList.toggle('hidden', !msg);
  document.title = 'Admin — HITZONE';
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('button', e.target);
  btn.disabled = true;
  try {
    const res = await api('/api/admin/login', { method: 'POST', body: { password: $('#pw').value } });
    localStorage.setItem('hz_admin', res.token);
    sessionStorage.setItem('hz_defpw', res.usingDefaultPassword ? '1' : '');
    $('#pw').value = '';
    await startApp();
  } catch (err) {
    const box = $('#login-error');
    box.textContent = err.message;
    box.classList.remove('hidden');
  } finally { btn.disabled = false; }
});

$('#btn-logout').addEventListener('click', () => showLogin());

function guard(err) {
  if (err.status === 401) { showLogin('Your session expired. Please sign in again.'); return true; }
  toast(err.message, 'error');
  return false;
}

/* ---------------- app shell ---------------- */
async function startApp() {
  try {
    A.settings = (await call('/api/admin/settings')).settings;
  } catch (err) { return guard(err); }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await refreshAll();
  clearInterval(A.timer);
  A.timer = setInterval(() => { if (!document.hidden) refreshStats({ announce: true }); }, 30000);
}

async function refreshAll() {
  await refreshStats();
  await renderTab();
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.stop(ctx.currentTime + 0.18);
  } catch (_) { /* ignore */ }
}

async function refreshStats({ announce = false } = {}) {
  let data;
  try { data = await call('/api/admin/stats'); } catch (err) { return guard(err); }
  const s = data.stats;
  A.today = s.today;
  if (announce && s.pending > A.pending) {
    toast(`New booking request! (${s.pending} waiting)`, 'ok');
    beep();
    if (A.tab === 'requests') renderRequests();
  }
  A.pending = s.pending;
  document.title = `${s.pending ? `(${s.pending}) ` : ''}Admin — HITZONE`;
  const cnt = $('#req-count');
  cnt.textContent = s.pending;
  cnt.classList.toggle('hidden', !s.pending);

  const stats = $('#stats');
  stats.innerHTML = '';
  const card = (k, v, cls) => stats.append(h('div', { class: `stat ${cls || ''}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)));
  card('Waiting for you', String(s.pending), s.pending ? 'alert' : '');
  card('Today (confirmed)', String(s.todayCount));
  card('Upcoming', String(s.upcoming));
  card('This month', fmtMoney(s.monthRevenue, s.currency));

  const banners = $('#banners');
  banners.innerHTML = '';
  if (sessionStorage.getItem('hz_defpw')) banners.append(h('div', { class: 'banner red' }, '⚠ You are using the default admin password. Set ADMIN_PASSWORD in the .env file and restart the server before going live.'));
  if (!data.emailConfigured) banners.append(h('div', { class: 'banner' }, '✉ Email is not set up yet — notifications are saved to data/outbox.log instead of being sent. See README → "Email notifications".'));
  else if (!data.adminEmails.length) banners.append(h('div', { class: 'banner' }, '✉ No owner email set. Add ADMIN_EMAIL to the .env file to receive booking alerts.'));
  else banners.append(h('div', { class: 'banner ok' }, `✉ New requests are emailed to ${data.adminEmails.join(', ')}`));
}

/* ---------------- tabs ---------------- */
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  A.tab = b.dataset.tab;
  $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  renderTab();
});

async function renderTab() {
  for (const t of ['requests', 'schedule', 'all', 'settings']) $(`#pane-${t}`).classList.toggle('hidden', t !== A.tab);
  if (A.tab === 'requests') await renderRequests();
  if (A.tab === 'schedule') await renderSchedule();
  if (A.tab === 'all') await renderAll();
  if (A.tab === 'settings') renderSettings();
}

/* ---------------- shared bits ---------------- */
function waLink(b) {
  if (!b.whatsapp) return null;
  const when = `${longDate(b.date)}, ${fmtRange(b.start, b.end)}`;
  const text = b.status === 'confirmed'
    ? `Hi ${b.name}, your HITZONE booking ${b.ref} is confirmed for ${when}. See you at the arena! Receipt: ${location.origin}/receipt.html?ref=${b.ref}`
    : `Hi ${b.name}, this is HITZONE Indoor Cricket Arena about your booking request ${b.ref} (${when}).`;
  return `https://wa.me/${b.whatsapp}?text=${encodeURIComponent(text)}`;
}

async function doAction(b, action, { confirmText } = {}) {
  if (confirmText && !window.confirm(confirmText)) return;
  try {
    await call(`/api/admin/bookings/${b.ref}/${action}`, { method: 'POST' });
    toast({ confirm: 'Booking confirmed — customer notified', decline: 'Request declined', cancel: 'Cancelled — slot is free again', checkin: 'Marked as arrived' }[action], 'ok');
    await refreshAll();
  } catch (err) { guard(err); }
}

function actionButtons(b) {
  const out = [];
  if (b.status === 'pending') {
    out.push(h('button', { class: 'btn btn-sm btn-ok', type: 'button', onclick: () => doAction(b, 'confirm') }, 'Confirm'));
    out.push(h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => doAction(b, 'decline', { confirmText: `Decline ${b.name}'s request? They will be notified by email.` }) }, 'Decline'));
  }
  if (b.status === 'confirmed' && !b.checkedInAt && b.type !== 'block') out.push(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => doAction(b, 'checkin') }, 'Arrived'));
  if (['confirmed', 'blocked'].includes(b.status)) out.push(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => doAction(b, 'cancel', { confirmText: b.status === 'blocked' ? 'Remove this block?' : `Cancel ${b.name}'s booking?` }) }, b.status === 'blocked' ? 'Unblock' : 'Cancel'));
  if (b.status === 'pending') out.push(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => doAction(b, 'cancel', { confirmText: `Cancel ${b.name}'s request?` }) }, 'Cancel'));
  return out;
}

function contactLine(b) {
  const parts = [];
  if (b.phone) parts.push(h('a', { href: `tel:${b.phone}` }, `📞 ${b.phone}`));
  const wa = waLink(b);
  if (wa) parts.push(h('a', { href: wa, target: '_blank', rel: 'noopener' }, 'WhatsApp'));
  if (b.email) parts.push(h('a', { href: `mailto:${b.email}` }, `✉ ${b.email}`));
  return parts;
}

/* ---------------- requests ---------------- */
async function renderRequests() {
  const pane = $('#pane-requests');
  let list;
  try { list = (await call('/api/admin/bookings?status=pending')).bookings; } catch (err) { return guard(err); }
  pane.innerHTML = '';
  if (!list.length) {
    pane.append(h('div', { class: 'empty-state' }, h('div', { style: 'font-size:2rem' }, '🏏'), h('b', {}, 'No requests waiting'), h('p', { style: 'margin:6px 0 0' }, 'New booking requests will appear here and in your email.')));
    return;
  }
  for (const b of list) {
    pane.append(h('div', { class: 'card req' },
      h('div', {},
        h('div', { class: 'when' }, `${mediumDate(b.date)} · ${fmtRange(b.start, b.end)}`),
        h('div', { style: 'margin-top:2px' }, h('b', {}, b.name), ` · ${hoursLabel(b.hours)} · `, h('b', {}, fmtMoney(b.amount, b.currency)), ` · ${b.players} player${b.players === 1 ? '' : 's'}`),
        h('div', { class: 'meta' }, ...contactLine(b), h('span', {}, `Ref ${b.ref}`), h('span', {}, `Requested ${new Date(b.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`)),
        b.notes ? h('div', { class: 'notes' }, `“${b.notes}”`) : null),
      h('div', { class: 'row-actions' }, ...actionButtons(b))));
  }
}

/* ---------------- daily schedule ---------------- */
async function renderSchedule() {
  const pane = $('#pane-schedule');
  if (!A.day) A.day = todayStr();
  pane.innerHTML = '';
  const input = h('input', { type: 'date', value: A.day, onchange: (e) => { if (e.target.value) { A.day = e.target.value; renderSchedule(); } } });
  pane.append(h('div', { class: 'day-nav' },
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { A.day = shiftDate(A.day, -1); renderSchedule(); } }, '←'),
    input,
    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { A.day = shiftDate(A.day, 1); renderSchedule(); } }, '→'),
    h('button', { class: 'btn btn-sm btn-dark', type: 'button', onclick: () => { A.day = todayStr(); renderSchedule(); } }, 'Today'),
    h('h2', {}, longDate(A.day))));
  let data;
  try { data = await call(`/api/admin/day?date=${A.day}`); } catch (err) { return guard(err); }
  if (data.closed) pane.append(h('div', { class: 'banner' }, 'This date is marked as closed in Settings.'));
  const wrap = h('div', { class: 'sched' });
  for (const r of data.rows) {
    if (r.type === 'free') {
      const mins = r.end - r.start;
      wrap.append(h('div', { class: 's free' },
        h('div', { class: 'time' }, `${fmtMin(r.start)} – ${fmtEndMin(r.end)}`),
        h('div', { class: 'free-label' }, `Free · ${hoursLabel(mins / 60)}`),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => openNewModal({ date: A.day, start: hhmm(r.start), end: hhmm(r.end % 1440), type: 'walkin' }) }, '+ Walk-in'),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => openNewModal({ date: A.day, start: hhmm(r.start), end: hhmm(r.end % 1440), type: 'block' }) }, 'Block'))));
    } else {
      const b = r.booking;
      const note = r.fromPrevDay ? ' · started the day before' : minutes(b.end) > 1440 ? ' · continues after midnight' : '';
      wrap.append(h('div', { class: `s ${b.status}` },
        h('div', { class: 'time' }, fmtRange(b.start, b.end)),
        h('div', { class: 'who' }, b.type === 'block' ? (b.name || 'Blocked') : b.name,
          h('small', {}, (b.type === 'block' ? (b.notes || 'Blocked — not bookable') : `${hoursLabel(b.hours)} · ${fmtMoney(b.amount, b.currency)} · ${b.ref}${b.checkedInAt ? ' · ✓ arrived' : ''}${b.type === 'walkin' ? ' · walk-in' : ''}`) + note)),
        h('div', { class: 'row-actions' }, h('span', { class: `badge ${b.status}` }, b.status), ...actionButtons(b),
          b.type !== 'block' ? h('a', { class: 'btn btn-sm btn-ghost', href: `/receipt.html?ref=${b.ref}` }, 'Receipt') : null)));
    }
  }
  pane.append(wrap);
}

/* ---------------- all bookings ---------------- */
const F = { status: 'all', range: 'upcoming', q: '' };
async function renderAll() {
  const pane = $('#pane-all');
  pane.innerHTML = '';
  const sel = (opts, cur, onchange) => h('select', { onchange: (e) => onchange(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
  const search = h('input', { type: 'search', placeholder: 'Search name, phone, reference…', value: F.q, oninput: (e) => { F.q = e.target.value; clearTimeout(search._t); search._t = setTimeout(load, 250); } });
  const csvBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Export CSV');
  pane.append(h('div', { class: 'toolbar' },
    sel([['upcoming', 'Upcoming'], ['past', 'Past'], ['all', 'All dates']], F.range, (v) => { F.range = v; load(); }),
    sel([['all', 'All statuses'], ['pending', 'Pending'], ['confirmed', 'Confirmed'], ['declined', 'Declined'], ['cancelled', 'Cancelled'], ['blocked', 'Blocked']], F.status, (v) => { F.status = v; load(); }),
    search, csvBtn));
  const holder = h('div', {});
  pane.append(holder);

  let rows = [];
  async function load() {
    const p = new URLSearchParams();
    if (F.status !== 'all') p.set('status', F.status);
    if (F.range === 'upcoming') p.set('from', todayStr());
    if (F.range === 'past') p.set('to', shiftDate(todayStr(), -1));
    if (F.q.trim()) p.set('q', F.q.trim());
    try { rows = (await call(`/api/admin/bookings?${p}`)).bookings; } catch (err) { return guard(err); }
    if (F.range === 'past') rows.reverse();
    holder.innerHTML = '';
    if (!rows.length) { holder.append(h('div', { class: 'empty-state' }, 'No bookings match these filters.')); return; }
    const tbody = h('tbody', {});
    for (const b of rows) {
      tbody.append(h('tr', {},
        h('td', {}, h('span', { class: 'ref' }, b.type === 'block' ? '—' : b.ref)),
        h('td', {}, mediumDate(b.date)),
        h('td', {}, fmtRange(b.start, b.end)),
        h('td', {}, h('b', {}, b.name || '—'), b.phone ? h('div', { class: 'muted', style: 'font-size:.82rem' }, b.phone) : null),
        h('td', {}, b.type === 'block' ? '—' : hoursLabel(b.hours)),
        h('td', {}, b.type === 'block' ? '—' : fmtMoney(b.amount, b.currency)),
        h('td', {}, h('span', { class: `badge ${b.status}` }, b.status), b.type === 'walkin' ? h('div', { class: 'muted', style: 'font-size:.75rem' }, 'walk-in') : null),
        h('td', {}, h('div', { class: 'row-actions', style: 'justify-content:flex-start' }, ...actionButtons(b)))));
    }
    holder.append(h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', {}, h('tr', {}, ['Ref', 'Date', 'Time', 'Customer', 'Hours', 'Amount', 'Status', ''].map((x) => h('th', {}, x)))), tbody)));
    holder.append(h('p', { class: 'hint' }, `${rows.length} booking${rows.length === 1 ? '' : 's'} · confirmed total ${fmtMoney(rows.filter((r) => r.status === 'confirmed').reduce((s, r) => s + r.amount, 0), A.settings.currency)}`));
  }
  csvBtn.addEventListener('click', () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Ref', 'Type', 'Status', 'Date', 'Start', 'End', 'Hours', 'Amount', 'Name', 'Phone', 'Email', 'Players', 'Notes', 'Created'];
    const lines = [head.join(',')].concat(rows.map((b) => [b.ref, b.type, b.status, b.date, b.start, b.end, b.hours, b.amount, b.name, b.phone, b.email, b.players, b.notes, b.createdAt].map(esc).join(',')));
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' })), download: `hitzone-bookings-${todayStr()}.csv` });
    document.body.append(a); a.click(); a.remove();
  });
  await load();
}

/* ---------------- settings ---------------- */
function renderSettings() {
  const pane = $('#pane-settings');
  pane.innerHTML = '';
  const s = A.settings;
  const field = (label, input, help) => h('div', { class: 'field' }, h('label', {}, label), input, help ? h('div', { class: 'help' }, help) : null);
  const num = (name, v, min, max) => h('input', { type: 'number', name, value: v, min, max });
  const closed = new Set(s.closedDates);
  const chips = h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' });
  const drawChips = () => {
    chips.innerHTML = '';
    [...closed].sort().forEach((d) => chips.append(h('span', { class: 'badge blocked', style: 'cursor:pointer;padding:6px 12px', title: 'Click to remove', onclick: () => { closed.delete(d); drawChips(); } }, `${mediumDate(d)} ✕`)));
    if (!closed.size) chips.append(h('span', { class: 'muted', style: 'font-size:.85rem' }, 'No closed dates.'));
  };
  drawChips();
  const closedInput = h('input', { type: 'date', style: 'width:auto' });
  const form = h('form', { class: 'card', novalidate: true },
    h('h3', {}, 'Pricing & hours'),
    h('label', { class: 'switch', style: 'margin-bottom:14px' }, h('input', { type: 'checkbox', name: 'open24', checked: s.openTime === '00:00' && s.closeTime === '24:00' }), h('span', {}, h('b', {}, 'Open 24 hours'), h('div', { class: 'muted', style: 'font-size:.85rem' }, 'Every hour of the day can be booked. Turn off to set opening and closing times.'))),
    h('div', { class: 'settings-grid' },
      field(`Price per hour (${s.currency})`, num('pricePerHour', s.pricePerHour, 0, 1000000)),
      field('Opening time', h('input', { type: 'time', name: 'openTime', value: s.openTime })),
      field('Closing time', h('input', { type: 'time', name: 'closeTime', value: s.closeTime === '24:00' ? '' : s.closeTime }), 'Same day, e.g. 22:30'),
      field('Time step', h('select', { name: 'stepMinutes' }, [5, 10, 15, 30, 60].map((m) => h('option', { value: m, selected: m === (s.stepMinutes || 15) }, `${m} minutes`))), 'Customers can start and finish on this step, e.g. 15 = 3:00, 3:15, 3:30…'),
      field('Shortest booking', h('select', { name: 'minBookingMinutes' }, [30, 45, 60, 90, 120].map((m) => h('option', { value: m, selected: m === s.minBookingMinutes }, hoursLabel(m / 60)))), 'Customers cannot book less than this online. You can still add shorter ones yourself.'),
      field('Max hours per booking', num('maxHoursPerBooking', s.maxHoursPerBooking, 1, 12)),
      field('Book up to (days ahead)', num('advanceBookingDays', s.advanceBookingDays, 1, 365)),
      field('Minimum notice (minutes)', num('minNoticeMinutes', s.minNoticeMinutes, 0, 1440), 'Stops last-second online bookings.')),
    h('div', { style: 'margin-top:16px' }, h('label', { class: 'switch' }, h('input', { type: 'checkbox', name: 'autoConfirm', checked: s.autoConfirm }), h('span', {}, h('b', {}, 'Confirm bookings automatically'), h('div', { class: 'muted', style: 'font-size:.85rem' }, 'Off = you approve every request first (recommended while you are starting out).')))),
    h('h3', { style: 'margin-top:26px' }, 'Closed dates'),
    h('p', { class: 'muted', style: 'margin:0 0 8px;font-size:.9rem' }, 'Holidays or maintenance days when nobody can book.'),
    h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, closedInput, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { if (closedInput.value) { closed.add(closedInput.value); closedInput.value = ''; drawChips(); } } }, 'Add date')),
    chips,
    h('h3', { style: 'margin-top:26px' }, 'Contact details (shown on the website)'),
    h('div', { class: 'settings-grid' },
      field('Phone', h('input', { type: 'text', name: 'c_phone', value: s.contact.phone, placeholder: '+94 77 123 4567' })),
      field('WhatsApp number', h('input', { type: 'text', name: 'c_whatsapp', value: s.contact.whatsapp, placeholder: '0771234567' })),
      field('Public email', h('input', { type: 'email', name: 'c_email', value: s.contact.email }), 'Also used for booking alerts if ADMIN_EMAIL is not set.'),
      field('Address', h('input', { type: 'text', name: 'c_address', value: s.contact.address })),
      field('Google Maps link', h('input', { type: 'text', name: 'c_mapUrl', value: s.contact.mapUrl, placeholder: 'https://maps.google.com/…' }))),
    h('div', { class: 'field', style: 'margin-top:16px' }, h('label', {}, 'Payment note (shown to customers)'), h('textarea', { name: 'paymentNote', maxlength: 300 }, s.paymentNote)),
    h('div', { id: 'set-err', class: 'form-error hidden', role: 'alert' }),
    h('div', { style: 'margin-top:20px' }, h('button', { class: 'btn', type: 'submit' }, 'Save settings')));
  const sync24 = () => { form.elements.openTime.disabled = form.elements.closeTime.disabled = form.elements.open24.checked; };
  form.elements.open24.addEventListener('change', sync24);
  sync24();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    const all = f.open24.checked;
    const body = {
      pricePerHour: f.pricePerHour.value, openTime: all ? '00:00' : f.openTime.value, closeTime: all ? '24:00' : f.closeTime.value, stepMinutes: f.stepMinutes.value, minBookingMinutes: f.minBookingMinutes.value,
      maxHoursPerBooking: f.maxHoursPerBooking.value, advanceBookingDays: f.advanceBookingDays.value, minNoticeMinutes: f.minNoticeMinutes.value,
      autoConfirm: f.autoConfirm.checked, closedDates: [...closed], paymentNote: f.paymentNote.value,
      contact: { phone: f.c_phone.value, whatsapp: f.c_whatsapp.value, email: f.c_email.value, address: f.c_address.value, mapUrl: f.c_mapUrl.value },
    };
    const err = $('#set-err');
    err.classList.add('hidden');
    try {
      A.settings = (await call('/api/admin/settings', { method: 'PUT', body })).settings;
      toast('Settings saved', 'ok');
    } catch (ex) {
      if (ex.status === 401) return guard(ex);
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  });
  pane.append(form);
}

/* ---------------- new booking / block modal ---------------- */
function openNewModal(pre = {}) {
  let type = pre.type || 'walkin';
  const stepSec = (A.settings.stepMinutes || 15) * 60;
  const date = h('input', { type: 'date', value: pre.date || todayStr() });
  const start = h('input', { type: 'time', step: stepSec, value: pre.start || '' });
  const end = h('input', { type: 'time', step: stepSec, value: pre.end || '' });
  const lenNote = h('div', { class: 'muted', style: 'font-size:.85rem;margin-top:6px' });
  const updateLen = () => {
    if (!start.value || !end.value) { lenNote.textContent = ''; return; }
    let d = minutes(end.value) - minutes(start.value);
    if (d <= 0) d += 1440;
    lenNote.textContent = `${hoursLabel(d / 60)}${minutes(end.value) <= minutes(start.value) ? ' (ends after midnight)' : ''}`;
  };
  start.addEventListener('input', updateLen);
  end.addEventListener('input', updateLen);
  updateLen();
  const name = h('input', { type: 'text', maxlength: 60 });
  const phone = h('input', { type: 'tel', maxlength: 20, placeholder: 'optional' });
  const notes = h('input', { type: 'text', maxlength: 300 });
  const err = h('div', { class: 'form-error hidden', role: 'alert' });
  const custFields = h('div', { class: 'form-grid' },
    h('div', { class: 'field' }, h('label', {}, 'Customer name'), name),
    h('div', { class: 'field' }, h('label', {}, 'Phone'), phone));
  const notesField = h('div', { class: 'field', style: 'margin-top:12px' }, h('label', {}, 'Note'), notes);
  const title = h('h2', {});
  const segWalk = h('button', { type: 'button', class: 'on', onclick: () => setType('walkin') }, 'Walk-in booking');
  const segBlock = h('button', { type: 'button', onclick: () => setType('block') }, 'Block time');
  const help = h('p', { class: 'muted', style: 'font-size:.9rem;margin:8px 0 14px' });
  function setType(t) {
    type = t;
    segWalk.classList.toggle('on', t === 'walkin');
    segBlock.classList.toggle('on', t === 'block');
    custFields.classList.toggle('hidden', t === 'block');
    title.textContent = t === 'walkin' ? 'New walk-in booking' : 'Block time';
    help.textContent = t === 'walkin' ? 'Records a confirmed booking for someone at the desk or on the phone.' : 'Makes the time unavailable online (maintenance, private event, tournament…).';
    notes.placeholder = t === 'block' ? 'Reason, e.g. Net maintenance' : 'optional';
  }
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) back.remove(); } });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Save');
  const form = h('form', { class: 'modal', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    if (!start.value || !end.value) { err.textContent = 'Please choose a start and an end time.'; err.classList.remove('hidden'); return; }
    submit.disabled = true;
    try {
      await call('/api/admin/bookings', { method: 'POST', body: { type, date: date.value, start: start.value, end: end.value, name: name.value, phone: phone.value, notes: notes.value } });
      back.remove();
      toast(type === 'block' ? 'Time blocked' : 'Walk-in booking saved', 'ok');
      A.day = date.value;
      await refreshAll();
    } catch (ex) {
      if (ex.status === 401) { back.remove(); return guard(ex); }
      err.textContent = ex.message;
      err.classList.remove('hidden');
    } finally { submit.disabled = false; }
  } },
  title, h('div', { class: 'seg' }, segWalk, segBlock), help,
  h('div', { class: 'form-grid' },
    h('div', { class: 'field' }, h('label', {}, 'Date'), date),
    h('div', { class: 'field' }, h('label', {}, 'Start time'), start),
    h('div', { class: 'field' }, h('label', {}, 'End time'), end)),
  lenNote,
  h('div', { style: 'height:12px' }), custFields, notesField, err,
  h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => back.remove() }, 'Cancel'), submit));
  back.append(form);
  document.body.append(back);
  setType(type);
  (type === 'block' ? notes : name).focus();
}
$('#btn-new').addEventListener('click', () => openNewModal());

/* ---------------- boot ---------------- */
if (localStorage.getItem('hz_admin')) startApp();
