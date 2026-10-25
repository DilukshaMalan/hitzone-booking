'use strict';
injectChrome('book');

const state = { cfg: null, date: null, slots: [], start: -1, count: 0, loading: false, calendar: [] };
const el = {
  strip: $('#date-strip'), dateInput: $('#date-input'), slotsArea: $('#slots-area'), duration: $('#duration'),
  durOut: $('#dur-out'), durRange: $('#dur-range'), minus: $('#dur-minus'), plus: $('#dur-plus'), hint: $('#slot-hint'),
  timeAside: $('#time-aside'), pDetails: $('#p-details'), form: $('#form'), submit: $('#submit'), formError: $('#form-error'),
  sumEmpty: $('#sum-empty'), sumList: $('#sum-list'), sumDate: $('#sum-date'), sumTime: $('#sum-time'), sumDur: $('#sum-dur'),
  sumRate: $('#sum-rate'), sumTotal: $('#sum-total'), sumNote: $('#sum-note'),
  bar: $('#mobile-bar'), mbWhen: $('#mb-when'), mbTotal: $('#mb-total'), mbBtn: $('#mb-btn'),
};

const maxSlots = () => Math.max(1, Math.floor((state.cfg.maxHoursPerBooking * 60) / state.cfg.slotMinutes));
const hoursOf = (n) => (n * state.cfg.slotMinutes) / 60;
const isFree = (i) => state.slots[i] && state.slots[i].status === 'available';

/* ---------------- dates ---------------- */
function renderDates() {
  el.strip.innerHTML = '';
  for (const d of state.calendar) {
    let dot = '';
    let label = `${longDate(d.date)}, ${d.available} slots available`;
    if (d.closed) { dot = 'closed'; label = `${longDate(d.date)}, closed`; }
    else if (d.available === 0) { dot = 'full'; label = `${longDate(d.date)}, fully booked`; }
    else if (d.available <= 3) dot = 'few';
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

async function selectDate(date, { keepSelection = false } = {}) {
  state.date = date;
  el.dateInput.value = date;
  if (!keepSelection) { state.start = -1; state.count = 0; }
  if (!state.calendar.some((d) => d.date === date)) {
    // a date beyond the strip: show it as an extra chip at the end
    state.calendar.push({ date, closed: false, available: 99, total: 99 });
    state.calendar.sort((a, b) => a.date.localeCompare(b.date));
  }
  renderDates();
  await loadSlots();
}

async function loadSlots({ silent = false } = {}) {
  if (!silent) {
    el.slotsArea.innerHTML = '';
    const grid = h('div', { class: 'slots' });
    for (let i = 0; i < 8; i++) grid.append(h('div', { class: 'skeleton' }));
    el.slotsArea.append(grid);
  }
  try {
    const data = await api(`/api/availability?date=${state.date}`);
    const before = state.start >= 0 ? state.slots.slice(state.start, state.start + state.count).map((s) => s.start) : [];
    state.slots = data.slots;
    // if someone else took our selected slot in the meantime, clear the selection
    if (before.length) {
      const idx = state.slots.findIndex((s) => s.start === before[0]);
      const stillOk = idx >= 0 && before.every((_, k) => isFree(idx + k));
      if (!stillOk) { state.start = -1; state.count = 0; toast('A slot you selected was just booked by someone else. Please choose again.', 'error'); }
    }
    // refresh the dot for this date
    const cal = state.calendar.find((d) => d.date === state.date);
    if (cal) { cal.available = state.slots.filter((s) => s.status === 'available').length; cal.closed = data.closed; renderDates(); }
    renderSlots(data);
  } catch (err) {
    el.slotsArea.innerHTML = '';
    el.slotsArea.append(h('div', { class: 'slots-empty' }, err.message, ' ', h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => loadSlots() }, 'Retry')));
  }
  renderSummary();
}

/* ---------------- slots ---------------- */
function periodOf(start) {
  const m = minutes(start);
  if (m < 6 * 60) return ['Night', 'moon'];
  if (m < 12 * 60) return ['Morning', 'sun'];
  if (m < 17 * 60) return ['Afternoon', 'sunset'];
  return ['Evening', 'moon'];
}

function renderSlots(data) {
  el.slotsArea.innerHTML = '';
  const free = state.slots.filter((s) => s.status === 'available').length;
  el.timeAside.textContent = data && data.closed ? 'Closed' : `${free} slot${free === 1 ? '' : 's'} free`;
  if (data && data.closed) {
    el.slotsArea.append(h('div', { class: 'slots-empty' }, 'The arena is closed on this date. Please choose another day.'));
    return;
  }
  if (!state.slots.length) {
    el.slotsArea.append(h('div', { class: 'slots-empty' }, 'No slots available for this date.'));
    return;
  }
  if (free === 0) el.slotsArea.append(h('div', { class: 'slots-empty', style: 'margin-bottom:16px' }, 'This day is fully booked or has passed. Try another date.'));
  const groups = new Map();
  state.slots.forEach((s, i) => {
    const [name, icon] = periodOf(s.start);
    if (!groups.has(name)) groups.set(name, { icon, items: [] });
    groups.get(name).items.push(i);
  });
  for (const [name, g] of groups) {
    const grid = h('div', { class: 'slots', role: 'group', 'aria-label': `${name} slots` });
    for (const i of g.items) {
      const s = state.slots[i];
      const selected = state.start >= 0 && i >= state.start && i < state.start + state.count;
      const unavailable = s.status !== 'available';
      const sub = s.status === 'booked' ? 'Booked' : s.status === 'past' ? 'Passed' : s.status === 'closed' ? 'Closed' : `to ${fmt12(s.end)}`;
      const btn = h('button', {
        type: 'button', class: `slot${selected ? ' selected' : ''}${s.status === 'booked' ? ' booked' : ''}`,
        disabled: unavailable, 'aria-pressed': String(selected),
        'aria-label': `${fmt12(s.start)} to ${fmt12(s.end)}, ${unavailable ? s.status : selected ? 'selected' : 'available'}`,
        onclick: () => onSlot(i),
      }, h('span', { class: 't' }, fmt12(s.start)), h('span', { class: 's' }, sub));
      btn.dataset.i = String(i);
      grid.append(btn);
    }
    const title = h('h3', {}, h('span', { html: ICONS[g.icon] }), name);
    el.slotsArea.append(h('div', { class: 'period' }, title, grid));
  }
}

function rangeFree(a, b) {
  for (let k = a; k <= b; k++) if (!isFree(k)) return false;
  return true;
}

function onSlot(i) {
  const keyboardUser = !!(document.activeElement && document.activeElement.matches && document.activeElement.matches(':focus-visible'));
  const max = maxSlots();
  const s0 = state.start;
  const n = state.count;
  if (s0 < 0) { state.start = i; state.count = 1; }
  else if (i >= s0 && i < s0 + n) {
    if (n === 1 && i === s0) { state.start = -1; state.count = 0; }
    else state.count = i - s0 + 1;
  } else if (i > s0 + n - 1) {
    const need = i - s0 + 1;
    if (need <= max && rangeFree(s0, i)) state.count = need;
    else if (need > max && rangeFree(s0, i)) { toast(`Maximum ${state.cfg.maxHoursPerBooking} hours per booking.`); state.start = i; state.count = 1; }
    else { state.start = i; state.count = 1; }
  } else { // i < s0
    const need = s0 + n - i;
    if (need <= max && rangeFree(i, s0 + n - 1)) { state.start = i; state.count = need; }
    else { state.start = i; state.count = 1; }
  }
  renderSlots();
  renderSummary();
  // the grid is redrawn on every tap: put keyboard focus back on the slot that was used
  const again = $(`.slot[data-i="${i}"]`);
  if (keyboardUser && again && !again.disabled) again.focus({ preventScroll: true });
}

el.plus.addEventListener('click', () => {
  if (state.start < 0) return;
  const next = state.start + state.count;
  if (state.count >= maxSlots()) return toast(`Maximum ${state.cfg.maxHoursPerBooking} hours per booking.`);
  if (!isFree(next)) return toast('The next slot is not available.', 'error');
  state.count++;
  renderSlots(); renderSummary();
});
el.minus.addEventListener('click', () => {
  if (state.start < 0 || state.count <= 1) return;
  state.count--;
  renderSlots(); renderSummary();
});

/* ---------------- summary ---------------- */
function currentSelection() {
  if (state.start < 0 || !state.slots[state.start]) return null;
  const first = state.slots[state.start];
  const last = state.slots[state.start + state.count - 1];
  const hrs = hoursOf(state.count);
  return { first, last, hrs, total: Math.round(hrs * state.cfg.pricePerHour) };
}

function renderSummary() {
  const sel = currentSelection();
  const cur = state.cfg.currency;
  el.pDetails.classList.toggle('locked', !sel);
  el.duration.classList.toggle('hidden', !sel);
  el.sumEmpty.classList.toggle('hidden', !!sel);
  el.sumList.classList.toggle('hidden', !sel);
  document.body.classList.toggle('has-bar', !!sel);
  el.bar.classList.toggle('show', !!sel);
  if (!sel) {
    el.sumTotal.textContent = fmtMoney(0, cur);
    el.hint.classList.remove('hidden');
    return;
  }
  el.hint.classList.add('hidden');
  const range = `${fmt12(sel.first.start)} – ${fmt12(sel.last.end)}`;
  el.durOut.textContent = hoursLabel(sel.hrs);
  el.durRange.textContent = range;
  el.minus.disabled = state.count <= 1;
  el.plus.disabled = state.count >= maxSlots() || !isFree(state.start + state.count);
  el.sumDate.textContent = mediumDate(state.date);
  el.sumTime.textContent = range;
  el.sumDur.textContent = hoursLabel(sel.hrs);
  el.sumRate.textContent = `${fmtMoney(state.cfg.pricePerHour, cur)} / hour`;
  el.sumTotal.textContent = fmtMoney(sel.total, cur);
  el.mbWhen.textContent = `${mediumDate(state.date)} · ${range}`;
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
  const slots = state.slots.slice(state.start, state.start + state.count).map((s) => s.start);
  el.submit.disabled = true;
  el.mbBtn.disabled = true;
  const label = el.submit.textContent;
  el.submit.textContent = 'Sending…';
  el.formError.classList.add('hidden');
  try {
    const res = await api('/api/bookings', {
      method: 'POST',
      body: { date: state.date, slots, name: f.name.value, phone: f.phone.value, email: f.email.value, players: f.players.value, notes: f.notes.value },
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
    if (err.status === 409 || err.field === 'slots') {
      state.start = -1; state.count = 0;
      await loadSlots();
      el.slotsArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      || (state.calendar.find((d) => !d.closed && d.available > 0) || state.calendar[0] || { date: state.cfg.today }).date;
    await selectDate(first);
    setInterval(() => { if (!document.hidden && state.date) loadSlots({ silent: true }); }, 60000);
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
