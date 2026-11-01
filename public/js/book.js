'use strict';
injectChrome('book');

/*
 * Free start / end time booking.
 * The server tells us, for the chosen date, which windows are unavailable (booked / closed / passed)
 * and which are free. All times here are "minutes from 00:00 of the chosen date" - values above 1440
 * mean after midnight (the next day).
 */
const state = { cfg: null, date: null, av: null, startMin: null, endMin: null, calendar: [] };
const el = {
  strip: $('#date-strip'), dateInput: $('#date-input'), slotsArea: $('#slots-area'), duration: $('#duration'),
  durRange: $('#dur-range'), durChips: $('#dur-chips'),
  timeAside: $('#time-aside'), pDetails: $('#p-details'), form: $('#form'), submit: $('#submit'), formError: $('#form-error'),
  tlTrack: $('#tl-track'), tlTicks: $('#tl-ticks'), tlHint: $('#tl-hint'), dayLists: $('#day-lists'),
  listBooked: $('#list-booked'), listFree: $('#list-free'), pickArea: $('#pick-area'), selStart: $('#sel-start'), selEnd: $('#sel-end'), pickMsg: $('#pick-msg'),
  sumEmpty: $('#sum-empty'), sumList: $('#sum-list'), sumDate: $('#sum-date'), sumTime: $('#sum-time'), sumDur: $('#sum-dur'),
  sumRate: $('#sum-rate'), sumTotal: $('#sum-total'), sumNote: $('#sum-note'),
  bar: $('#mobile-bar'), mbWhen: $('#mb-when'), mbTotal: $('#mb-total'), mbBtn: $('#mb-btn'),
};

const DAY = 1440;
const step = () => (state.av && state.av.stepMinutes) || state.cfg.stepMinutes || 15;
const priceFor = (mins) => Math.round((mins / 60) * state.cfg.pricePerHour);

/** The bookable window (free, long enough) that contains minute `t`, or null. */
function windowAt(t) {
  const av = state.av;
  if (!av) return null;
  return av.bookable.find((w) => t >= w.start && t < w.end) || null;
}

/** Every start time the customer may choose (on the step grid, inside a free window, with room for the shortest booking). */
function validStarts() {
  const av = state.av;
  const out = [];
  if (!av) return out;
  for (const w of av.bookable) {
    for (let t = w.start; t + av.minMinutes <= w.end && t < DAY; t += av.stepMinutes) out.push(t);
  }
  return out;
}

/** Every end time allowed for a given start. */
function validEnds(start) {
  const av = state.av;
  const w = windowAt(start);
  if (!w) return [];
  const out = [];
  const limit = Math.min(w.end, start + av.maxMinutes);
  for (let t = start + av.minMinutes; t <= limit; t += av.stepMinutes) out.push(t);
  return out;
}

const spanText = (a, b) => `${fmtMin(a)} – ${fmtEndMin(b)}`;

/* ---------------- dates ---------------- */
function renderDates() {
  el.strip.innerHTML = '';
  for (const d of state.calendar) {
    let dot = '';
    let label = `${longDate(d.date)}, ${hoursLabel(d.freeMinutes / 60)} available`;
    if (d.closed) { dot = 'closed'; label = `${longDate(d.date)}, closed`; }
    else if (d.freeMinutes === 0) { dot = 'full'; label = `${longDate(d.date)}, fully booked`; }
    else if (d.freeMinutes <= 180) dot = 'few'; // 3 hours or less left
    const chip = h('button', {
      type: 'button', class: `date-chip${d.date === state.date ? ' selected' : ''}`, role: 'option',
      'aria-selected': String(d.date === state.date), 'aria-label': label, disabled: d.closed,
      onclick: () => selectDate(d.date),
    }, h('div', { class: 'dow' }, dowOf(d.date)), h('div', { class: 'dom' }, domOf(d.date)), h('div', { class: 'mon' }, monOf(d.date)), h('span', { class: `dot ${dot}` }));
    chip.dataset.date = d.date;
    el.strip.append(chip);
  }
  const sel = $('.date-chip.selected', el.strip);
  if (sel) sel.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}

async function loadCalendar() {
  const data = await api(`/api/calendar?from=${state.cfg.today}&days=14`);
  state.calendar = data.days;
}

async function selectDate(date) {
  state.date = date;
  el.dateInput.value = date;
  state.startMin = null;
  state.endMin = null;
  if (!state.calendar.some((d) => d.date === date)) {
    // a date beyond the strip: show it as an extra chip at the end
    state.calendar.push({ date, closed: false, freeMinutes: 1440 });
    state.calendar.sort((a, b) => a.date.localeCompare(b.date));
  }
  renderDates();
  await loadDay();
}

async function loadDay({ silent = false } = {}) {
  if (!silent) {
    el.slotsArea.innerHTML = '';
    el.slotsArea.append(h('div', { class: 'skeleton' }));
    el.pickArea.classList.add('hidden');
    el.dayLists.classList.add('hidden');
  }
  try {
    const av = await api(`/api/availability?date=${state.date}`);
    state.av = av;
    // if someone else took the time we had selected in the meantime, clear the selection
    if (state.startMin != null && !selectionIsValid()) {
      state.startMin = null; state.endMin = null;
      toast('That time was just booked by someone else. Please choose again.', 'error');
    }
    const cal = state.calendar.find((d) => d.date === state.date);
    if (cal) { cal.freeMinutes = av.freeMinutes; cal.closed = av.closed; renderDates(); }
    renderDay();
  } catch (err) {
    state.av = null;
    el.slotsArea.innerHTML = '';
    el.slotsArea.append(h('div', { class: 'slots-empty' }, err.message, ' ', h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => loadDay() }, 'Retry')));
  }
  renderSummary();
}

function selectionIsValid() {
  if (state.startMin == null || state.endMin == null) return false;
  return validStarts().includes(state.startMin) && validEnds(state.startMin).includes(state.endMin);
}

/* ---------------- day view: timeline, lists, pickers ---------------- */
function renderTicks() {
  el.tlTicks.innerHTML = '';
  for (let hr = 0; hr <= 24; hr += 3) el.tlTicks.append(h('span', { class: hr % 6 ? 'minor' : '', style: `left:${(hr / 24) * 100}%` }, fmtMin(hr * 60).replace(':00', '')));
}

const pct = (m) => (Math.min(Math.max(m, 0), DAY) / DAY) * 100;

function renderTimeline() {
  const av = state.av;
  el.tlTrack.innerHTML = '';
  el.tlTrack.classList.toggle('is-empty', !av.bookable.length);
  for (const w of av.unavailable) {
    if (w.start >= DAY) continue;
    const left = pct(w.start);
    const width = pct(w.end) - left;
    const title = w.kind === 'booked' ? `Booked ${spanText(w.start, w.end)}` : w.kind === 'past' ? 'Already passed' : 'Closed';
    const seg = h('div', { class: `tl-seg ${w.kind}`, style: `left:${left}%;width:${width}%`, title }, width > 9 ? (w.kind === 'booked' ? 'Booked' : w.kind === 'past' ? 'Passed' : 'Closed') : '');
    el.tlTrack.append(seg);
  }
  if (state.startMin != null && state.endMin != null) {
    const left = pct(state.startMin);
    const width = pct(state.endMin) - left;
    const over = state.endMin > DAY;
    el.tlTrack.append(h('div', { class: `tl-sel${over ? ' over' : ''}`, style: `left:${left}%;width:${width}%` }, width > 12 ? hoursLabel((state.endMin - state.startMin) / 60) : ''));
  }
}

function renderLists() {
  const av = state.av;
  el.listBooked.innerHTML = '';
  el.listFree.innerHTML = '';
  const booked = av.unavailable.filter((w) => w.kind === 'booked' && w.start < DAY);
  if (!booked.length) el.listBooked.append(h('li', { class: 'none', style: 'background:none;padding:0;font-weight:400;color:var(--muted)' }, 'Nothing booked yet'));
  for (const w of booked) el.listBooked.append(h('li', {}, spanText(w.start, w.end)));
  if (!av.bookable.length) el.listFree.append(h('li', { style: 'background:none;padding:0;font-weight:400;color:var(--muted)' }, 'No free time left'));
  for (const w of av.bookable) {
    // show where the free time stops; free time that runs on into the next morning is shown up to midnight
    const end = w.end >= 2 * DAY ? DAY : w.end;
    el.listFree.append(h('li', {}, w.start <= 0 && end >= DAY ? 'Whole day (24 hours)' : spanText(w.start, end)));
  }
}

function renderPickers() {
  const av = state.av;
  const starts = validStarts();
  el.pickArea.classList.toggle('hidden', !starts.length);
  if (!starts.length) return;
  // start box
  el.selStart.innerHTML = '';
  el.selStart.append(h('option', { value: '' }, 'Choose start…'));
  for (const t of starts) el.selStart.append(h('option', { value: String(t), selected: t === state.startMin }, fmtMin(t)));
  el.selStart.value = state.startMin == null ? '' : String(state.startMin);
  // end box
  el.selEnd.innerHTML = '';
  if (state.startMin == null) {
    el.selEnd.disabled = true;
    el.selEnd.append(h('option', { value: '' }, 'Pick a start first'));
  } else {
    el.selEnd.disabled = false;
    el.selEnd.append(h('option', { value: '' }, 'Choose end…'));
    for (const t of validEnds(state.startMin)) {
      el.selEnd.append(h('option', { value: String(t), selected: t === state.endMin }, `${fmtEndMin(t)} · ${hoursLabel((t - state.startMin) / 60)}`));
    }
    el.selEnd.value = state.endMin == null ? '' : String(state.endMin);
  }
  // message
  el.pickMsg.classList.remove('bad');
  if (state.startMin == null) el.pickMsg.textContent = `Shortest booking ${hoursLabel(av.minMinutes / 60)}, longest ${hoursLabel(av.maxMinutes / 60)}. Finish after midnight? Choose an end time marked “(next day)”.`;
  else if (state.endMin == null) el.pickMsg.textContent = 'Now choose the time you want to finish.';
  else el.pickMsg.textContent = '';
  renderQuickLengths();
}

function renderQuickLengths() {
  const av = state.av;
  const show = state.startMin != null;
  el.duration.classList.toggle('hidden', !show);
  if (!show) return;
  el.durRange.textContent = state.endMin != null ? `· ${spanText(state.startMin, state.endMin)}` : '';
  el.durChips.innerHTML = '';
  const ends = validEnds(state.startMin);
  for (const t of ends) {
    const len = t - state.startMin;
    if (len % 30) continue; // quick chips every 30 minutes; exact 15-minute ends are in the End box
    const on = t === state.endMin;
    el.durChips.append(h('button', {
      type: 'button', class: `dchip${on ? ' on' : ''}`, 'aria-pressed': String(on),
      onclick: () => { state.endMin = t; renderDay(); renderSummary(); },
    }, h('b', {}, hoursLabel(len / 60)), h('small', {}, fmtMoney(priceFor(len), state.cfg.currency))));
  }
  if (!el.durChips.children.length) el.duration.classList.add('hidden');
}

function renderDay() {
  const av = state.av;
  el.slotsArea.innerHTML = '';
  renderTicks();
  el.timeAside.textContent = av.closed ? 'Closed' : `${hoursLabel(av.freeMinutes / 60)} free`;
  if (av.closed) {
    el.slotsArea.append(h('div', { class: 'slots-empty' }, 'The arena is closed on this date. Please choose another day.'));
  } else if (!av.bookable.length) {
    el.slotsArea.append(h('div', { class: 'slots-empty', style: 'margin-bottom:16px' }, 'No free time on this date — it is fully booked or has passed. Try another date.'));
  }
  el.dayLists.classList.toggle('hidden', av.closed);
  renderTimeline();
  if (!av.closed) renderLists();
  renderPickers();
}

/** Tap the timeline: choose that spot as the start time (snapped to the step, inside the nearest free time). */
el.tlTrack.addEventListener('click', (e) => {
  if (!state.av || !state.av.bookable.length) return;
  const rect = el.tlTrack.getBoundingClientRect();
  const raw = ((e.clientX - rect.left) / rect.width) * DAY;
  const st = step();
  let t = Math.min(DAY - st, Math.max(0, Math.floor(raw / st) * st));
  const starts = validStarts();
  if (!starts.includes(t)) {
    // tapped on a booked / closed part, or too close to the end of a free window: say so instead of failing silently
    const nearest = starts.reduce((best, s) => (best == null || Math.abs(s - raw) < Math.abs(best - raw) ? s : best), null);
    if (nearest == null || Math.abs(nearest - raw) > 90) return toast('That part of the day is not available. Tap a green area.', 'error');
    t = nearest;
  }
  setStart(t);
});

function setStart(t) {
  state.startMin = t;
  const ends = validEnds(t);
  if (!ends.includes(state.endMin)) state.endMin = ends.length ? ends[0] : null; // default: the shortest booking
  renderDay();
  renderSummary();
}

el.selStart.addEventListener('change', () => {
  if (el.selStart.value === '') { state.startMin = null; state.endMin = null; renderDay(); renderSummary(); return; }
  setStart(parseInt(el.selStart.value, 10));
});
el.selEnd.addEventListener('change', () => {
  state.endMin = el.selEnd.value === '' ? null : parseInt(el.selEnd.value, 10);
  renderDay();
  renderSummary();
});

/* ---------------- summary ---------------- */
function currentSelection() {
  if (state.startMin == null || state.endMin == null || !state.av || !selectionIsValid()) return null;
  const mins = state.endMin - state.startMin;
  return { mins, hrs: mins / 60, total: priceFor(mins), range: spanText(state.startMin, state.endMin) };
}

function renderSummary() {
  const sel = currentSelection();
  const cur = state.cfg.currency;
  el.pDetails.classList.toggle('locked', !sel);
  el.sumEmpty.classList.toggle('hidden', !!sel);
  el.sumList.classList.toggle('hidden', !sel);
  document.body.classList.toggle('has-bar', !!sel);
  el.bar.classList.toggle('show', !!sel);
  if (!sel) {
    el.sumTotal.textContent = fmtMoney(0, cur);
    return;
  }
  el.sumDate.textContent = mediumDate(state.date);
  el.sumTime.textContent = sel.range;
  el.sumDur.textContent = hoursLabel(sel.hrs);
  el.sumRate.textContent = `${fmtMoney(state.cfg.pricePerHour, cur)} / hour`;
  el.sumTotal.textContent = fmtMoney(sel.total, cur);
  el.mbWhen.textContent = `${mediumDate(state.date)} · ${sel.range}`;
  el.mbTotal.textContent = fmtMoney(sel.total, cur);
}

/* ---------------- form ---------------- */
function setErr(field, msg) {
  const box = $(`[data-err="${field}"]`);
  const input = el.form.elements[field];
  if (box) box.textContent = msg || '';
  if (input) input.classList.toggle('invalid', !!msg);
}

function validate() {
  const f = el.form.elements;
  let ok = true;
  const name = f.name.value.trim();
  const digits = f.phone.value.replace(/\D/g, '');
  const email = f.email.value.trim();
  setErr('name', name.length < 2 ? 'Please enter your name.' : '');
  setErr('phone', digits.length < 9 || digits.length > 15 ? 'Enter a valid phone number, e.g. 077 123 4567.' : '');
  setErr('email', email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? 'That email address does not look right.' : '');
  if (name.length < 2 || digits.length < 9 || digits.length > 15 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))) ok = false;
  if (!ok) { const bad = $('.invalid', el.form); if (bad) bad.focus(); }
  return ok;
}

el.form.addEventListener('input', (e) => { if (e.target.name) setErr(e.target.name, ''); el.formError.classList.add('hidden'); });

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const sel = currentSelection();
  if (!sel) return toast('Please choose a time first.', 'error');
  if (!validate()) return;
  const f = el.form.elements;
  el.submit.disabled = true;
  el.mbBtn.disabled = true;
  const label = el.submit.textContent;
  el.submit.textContent = 'Sending…';
  el.formError.classList.add('hidden');
  try {
    const res = await api('/api/bookings', {
      method: 'POST',
      body: { date: state.date, start: hhmm(state.startMin), end: hhmm(state.endMin), name: f.name.value, phone: f.phone.value, email: f.email.value, players: f.players.value, notes: f.notes.value },
    });
    try {
      localStorage.setItem('hz_contact', JSON.stringify({ name: f.name.value, phone: f.phone.value, email: f.email.value }));
      localStorage.setItem('hz_last_ref', res.booking.ref);
    } catch (_) { /* private mode */ }
    location.href = res.receiptUrl;
  } catch (err) {
    el.submit.disabled = false;
    el.mbBtn.disabled = false;
    el.submit.textContent = label;
    if (err.field && el.form.elements[err.field]) setErr(err.field, err.message);
    el.formError.textContent = err.message;
    el.formError.classList.remove('hidden');
    if (err.status === 409 || err.field === 'start' || err.field === 'end') {
      state.startMin = null; state.endMin = null;
      await loadDay();
      $('#p-time').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
});

/* mobile bottom bar: "Continue" scrolls to details, then becomes "Request booking" */
let detailsVisible = false;
new IntersectionObserver((entries) => {
  detailsVisible = entries[0].isIntersecting && entries[0].intersectionRatio > 0.35;
  el.mbBtn.textContent = detailsVisible ? 'Send request' : 'Continue';
}, { threshold: [0, 0.35, 0.6] }).observe(el.pDetails);
el.mbBtn.addEventListener('click', () => {
  if (detailsVisible) el.form.requestSubmit();
  else { el.pDetails.scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(() => el.form.elements.name.focus({ preventScroll: true }), 500); }
});

/* ---------------- init ---------------- */
(async function init() {
  try {
    state.cfg = await getConfig();
    el.dateInput.min = state.cfg.today;
    el.dateInput.max = state.cfg.lastBookableDate;
    el.submit.textContent = state.cfg.autoConfirm ? 'Confirm my booking' : 'Send booking request';
    $('#submit-note').textContent = state.cfg.autoConfirm ? 'Your booking is confirmed instantly and your QR receipt is ready.' : 'No payment now. We will confirm your request shortly — your QR receipt is ready right away.';
    el.sumNote.textContent = state.cfg.paymentNote;
    try {
      const saved = JSON.parse(localStorage.getItem('hz_contact') || 'null');
      if (saved) { el.form.elements.name.value = saved.name || ''; el.form.elements.phone.value = saved.phone || ''; el.form.elements.email.value = saved.email || ''; }
    } catch (_) { /* ignore */ }
    await loadCalendar();
    const wanted = new URLSearchParams(location.search).get('date');
    const first = (wanted && /^\d{4}-\d{2}-\d{2}$/.test(wanted) && wanted >= state.cfg.today && wanted <= state.cfg.lastBookableDate && wanted)
      || (state.calendar.find((d) => !d.closed && d.freeMinutes > 0) || state.calendar[0] || { date: state.cfg.today }).date;
    await selectDate(first);
    setInterval(() => { if (!document.hidden && state.date) loadDay({ silent: true }); }, 60000);
  } catch (err) {
    el.slotsArea.append(h('div', { class: 'slots-empty' }, err.message));
  }
})();

el.dateInput.addEventListener('change', () => {
  const v = el.dateInput.value;
  if (!v) return;
  if (v < state.cfg.today || v > state.cfg.lastBookableDate) { toast(`Please choose a date up to ${state.cfg.advanceBookingDays} days ahead.`, 'error'); el.dateInput.value = state.date; return; }
  selectDate(v);
});
