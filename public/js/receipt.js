'use strict';
injectChrome('receipt');

const root = $('#root');
const params = new URLSearchParams(location.search);
const ref = (params.get('ref') || '').trim().toUpperCase();
let timer = null;
let lastStatus = null;

const STATUS = {
  pending: { badge: 'Awaiting confirmation', title: 'Request received', text: 'We will confirm your slot shortly. This page updates automatically — keep it open or come back with your QR code.' },
  confirmed: { badge: 'Confirmed', title: "You're booked!", text: 'Show this QR code at the arena when you arrive.' },
  declined: { badge: 'Not confirmed', title: "Sorry, we couldn't confirm this slot", text: 'Please choose another time and send a new request.' },
  cancelled: { badge: 'Cancelled', title: 'This booking was cancelled', text: 'You are welcome to book another time.' },
};

function renderLookup(message) {
  root.innerHTML = '';
  const last = (() => { try { return localStorage.getItem('hz_last_ref'); } catch (_) { return null; } })();
  const input = h('input', { type: 'text', id: 'ref-input', placeholder: 'HZ-XXXXXX', maxlength: 9, autocomplete: 'off', 'aria-label': 'Booking reference', value: last || '' });
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); const v = input.value.trim().toUpperCase(); if (v) location.href = `/receipt.html?ref=${encodeURIComponent(v)}`; } },
    input, h('button', { class: 'btn', type: 'submit' }, 'Find'));
  root.append(h('div', { class: 'lookup' },
    h('h2', {}, 'Find your booking'),
    h('p', { class: 'muted' }, message || 'Enter the reference from your confirmation (it looks like HZ-7K3M9P), or scan the QR code on your receipt.'),
    form,
    last ? h('p', { class: 'hint' }, 'Your most recent booking: ', h('a', { href: `/receipt.html?ref=${last}` }, last)) : null,
    h('p', { style: 'margin-top:20px' }, h('a', { class: 'btn btn-dark', href: '/book.html' }, 'Make a new booking'))));
  input.focus();
}

function icsFor(b, cfg) {
  const d = b.date.replace(/-/g, '');
  const t = (x) => x.replace(':', '') + '00';
  const endMin = minutes(b.end); // can be 1440 (midnight) or more (next day)
  const nd = new Date(`${b.date}T00:00:00Z`); nd.setUTCDate(nd.getUTCDate() + Math.floor(endMin / 1440));
  const endDay = nd.toISOString().slice(0, 10).replace(/-/g, '');
  const endTime = t(hhmm(endMin % 1440));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HITZONE//Booking//EN', 'BEGIN:VEVENT',
    `UID:${b.ref}@hitzone`, `DTSTAMP:${stamp}`, `DTSTART:${d}T${t(b.start)}`, `DTEND:${endDay}T${endTime}`,
    'SUMMARY:HITZONE Indoor Cricket', `DESCRIPTION:Booking ${b.ref} - ${hoursLabel(b.hours)}`,
    `LOCATION:${(cfg.contact && cfg.contact.address) || b.arena}`, 'END:VEVENT', 'END:VCALENDAR',
  ];
  return new Blob([lines.join('\r\n')], { type: 'text/calendar' });
}

function row(label, value, cls) {
  return h('div', {}, h('dt', {}, label), h('dd', { class: cls || '' }, value));
}

async function renderTicket(b, cfg) {
  const st = STATUS[b.status] || STATUS.pending;
  root.innerHTML = '';
  const showQr = b.status === 'pending' || b.status === 'confirmed';
  const ticket = h('article', { class: 'ticket', 'aria-label': 'Booking receipt' },
    h('div', { class: 'ticket-top' }, h('div', { class: 'brand-text' }, 'HITZONE'), h('div', { class: 'sub' }, 'INDOOR CRICKET ARENA')),
    h('div', { class: 'ticket-body' },
      h('div', { class: 'ticket-status' },
        h('span', { class: `badge ${b.status}` }, b.status === 'pending' ? h('span', { class: 'pulse' }) : null, st.badge),
        h('div', { class: 'big' }, st.title),
        h('p', {}, st.text)),
      h('dl', {},
        row('Reference', b.ref, 'ref'),
        row('Name', b.name),
        row('Date', longDate(b.date)),
        row('Time', fmtRange(b.start, b.end)),
        row('Duration', hoursLabel(b.hours)),
        b.players > 1 ? row('Players', String(b.players)) : null,
        b.phone ? row('Phone', b.phone) : null,
        row('Total', fmtMoney(b.amount, b.currency)),
        b.checkedIn ? row('Check-in', 'Arrived ✓') : null)),
    showQr ? h('div', { class: 'ticket-qr' },
      h('div', { class: 'qr-box' }, h('img', { src: `/api/qr/${b.ref}.svg`, alt: `QR code for booking ${b.ref}`, width: 190, height: 190 })),
      h('p', {}, b.status === 'confirmed' ? 'Scan or show this code at the front desk' : 'This code becomes valid once your booking is confirmed')) : null,
    h('div', { class: 'ticket-note' }, b.paymentNote));
  root.append(ticket);

  const actions = h('div', { class: 'receipt-actions' });
  actions.append(h('button', { class: 'btn btn-dark', type: 'button', onclick: () => window.print() }, 'Print / Save as PDF'));
  if (b.status === 'confirmed' || b.status === 'pending') {
    actions.append(h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => {
      const a = h('a', { href: URL.createObjectURL(icsFor(b, cfg)), download: `hitzone-${b.ref}.ics` });
      document.body.append(a); a.click(); a.remove();
    } }, 'Add to calendar'));
    const msg = `My HITZONE booking ${b.ref}: ${longDate(b.date)}, ${fmtRange(b.start, b.end)}. Receipt: ${location.origin}/receipt.html?ref=${b.ref}`;
    actions.append(h('a', { class: 'btn btn-ghost', target: '_blank', rel: 'noopener', href: `https://wa.me/?text=${encodeURIComponent(msg)}` }, 'Share on WhatsApp'));
  }
  actions.append(h('a', { class: 'btn btn-ghost', href: '/book.html' }, b.status === 'declined' || b.status === 'cancelled' ? 'Choose another time' : 'Book another slot'));
  root.append(actions);

  if (lastStatus && lastStatus !== b.status && b.status === 'confirmed') toast('Your booking has been confirmed! 🎉', 'ok');
  lastStatus = b.status;
  renderAdminStrip(b);
}

/* If the owner is signed in to the admin panel, scanning a customer's QR shows quick actions. */
async function renderAdminStrip(b) {
  const old = $('.admin-strip');
  if (old) old.remove();
  if (!localStorage.getItem('hz_admin')) return;
  let full;
  try {
    const res = await api(`/api/admin/bookings?q=${encodeURIComponent(b.ref)}`, { auth: true });
    full = res.bookings.find((x) => x.ref === b.ref);
  } catch (_) { return; }
  if (!full) return;
  const act = async (action) => {
    try { await api(`/api/admin/bookings/${b.ref}/${action}`, { method: 'POST', auth: true }); toast('Done', 'ok'); load(); } catch (e) { toast(e.message, 'error'); }
  };
  const strip = h('div', { class: 'admin-strip no-print' }, h('b', {}, 'Staff'), `${full.name} · `, h('a', { href: `tel:${full.phone}`, style: 'color:#fff' }, full.phone || 'no phone'));
  if (full.status === 'pending') {
    strip.append(h('button', { class: 'btn btn-sm btn-ok', onclick: () => act('confirm') }, 'Confirm'), h('button', { class: 'btn btn-sm btn-danger', onclick: () => act('decline') }, 'Decline'));
  }
  if (full.status === 'confirmed' && !full.checkedInAt) strip.append(h('button', { class: 'btn btn-sm', onclick: () => act('checkin') }, 'Mark as arrived'));
  if (full.checkedInAt) strip.append(h('span', {}, '✓ Arrived'));
  root.prepend(strip);
}

async function load() {
  try {
    const [{ booking }, cfg] = await Promise.all([api(`/api/bookings/${encodeURIComponent(ref)}`), getConfig()]);
    await renderTicket(booking, cfg);
    clearTimeout(timer);
    if (booking.status === 'pending') timer = setTimeout(load, 15000);
  } catch (err) {
    if (err.status === 404) renderLookup(`We couldn't find a booking with reference "${ref}". Please check it and try again.`);
    else root.replaceChildren(h('div', { class: 'lookup' }, h('p', {}, err.message), h('button', { class: 'btn', onclick: load }, 'Try again')));
  }
}

if (ref) load();
else renderLookup();
