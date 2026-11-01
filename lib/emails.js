'use strict';
/** Email templates (HTML + plain text). */
const { esc, fmt12, fmtEnd, fmtRange, longDate, money, durationText } = require('./util');

const GOLD = '#B8860B';
const NAVY = '#0F1B3D';
const IVORY = '#FBF8F1';

function row(label, value) {
  return (
    `<tr><td style="padding:8px 0;color:#7a6a3a;font-size:13px;width:38%;vertical-align:top">${esc(label)}</td>` +
    `<td style="padding:8px 0;color:${NAVY};font-size:15px;font-weight:600">${value}</td></tr>`
  );
}

function layout({ title, intro, rows, button, qrCid, footer, badge }) {
  const btn = button
    ? `<p style="text-align:center;margin:26px 0 8px"><a href="${esc(button.url)}" style="background:${NAVY};color:#fff;text-decoration:none;padding:13px 26px;border-radius:999px;font-weight:600;font-size:15px;display:inline-block">${esc(button.label)}</a></p>`
    : '';
  const qr = qrCid
    ? `<p style="text-align:center;margin:18px 0 0"><img src="cid:${qrCid}" width="170" height="170" alt="Booking QR code" style="border:6px solid #fff;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,.12)"><br><span style="font-size:12px;color:#7a6a3a">Show this QR code at the arena</span></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#efe9da;padding:24px 12px;font-family:Segoe UI,Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:${IVORY};border-radius:18px;overflow:hidden;border:1px solid #e3d6b0">
<tr><td style="background:${NAVY};padding:22px 28px;text-align:center">
<div style="font-family:Georgia,serif;font-size:28px;letter-spacing:4px;color:#E8C468;font-weight:700">HITZONE</div>
<div style="font-size:11px;letter-spacing:4px;color:#d9c48a;margin-top:4px">INDOOR CRICKET ARENA</div></td></tr>
<tr><td style="padding:28px">
${badge ? `<p style="margin:0 0 12px"><span style="background:${badge.bg};color:${badge.fg};padding:5px 12px;border-radius:999px;font-size:12px;font-weight:700;letter-spacing:.5px">${esc(badge.text)}</span></p>` : ''}
<h1 style="margin:0 0 10px;font-family:Georgia,serif;font-size:24px;color:${NAVY}">${esc(title)}</h1>
<p style="margin:0 0 18px;color:#3b4565;font-size:15px;line-height:1.55">${intro}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e3d6b0;border-bottom:1px solid #e3d6b0">${rows.join('')}</table>
${btn}${qr}
<p style="margin:26px 0 0;color:#7a6a3a;font-size:12px;line-height:1.5;text-align:center">${footer || ''}</p>
</td></tr></table>
<p style="font-size:11px;color:#8d8467;margin:14px 0 0">Come. Play. Hit. Repeat.</p>
</td></tr></table></body></html>`;
}

function bookingRows(b) {
  return [
    row('Reference', `<span style="color:${GOLD};letter-spacing:1px">${esc(b.ref)}</span>`),
    row('Date', esc(longDate(b.date))),
    row('Time', `${esc(fmtRange(b.start, b.end))} (${durationText(b.hours)})`),
    row('Total', esc(money(b.amount, b.currency))),
  ];
}

function bookingText(b) {
  return [
    `Reference: ${b.ref}`,
    `Date:      ${longDate(b.date)}`,
    `Time:      ${fmtRange(b.start, b.end)} (${durationText(b.hours)})`,
    `Total:     ${money(b.amount, b.currency)}`,
  ].join('\n');
}

const receiptUrl = (baseUrl, b) => `${baseUrl}/receipt.html?ref=${encodeURIComponent(b.ref)}`;

/** To the arena owner: a new request arrived. */
function adminNewRequest(b, s, baseUrl) {
  const adminUrl = `${baseUrl}/admin.html`;
  const auto = b.status === 'confirmed';
  const subject = `${auto ? 'New booking' : 'New booking request'} ${b.ref} – ${longDate(b.date)}, ${fmt12(b.start)}–${fmtEnd(b.end)}`;
  const rows = [
    ...bookingRows(b),
    row('Name', esc(b.name)),
    row('Phone', `<a href="tel:${esc(b.phone)}" style="color:${NAVY}">${esc(b.phone)}</a>`),
    row('Email', b.email ? esc(b.email) : '<span style="color:#999;font-weight:400">not given</span>'),
    row('Players', String(b.players)),
  ];
  if (b.notes) rows.push(row('Notes', esc(b.notes)));
  const html = layout({
    title: auto ? 'New booking (auto-confirmed)' : 'New booking request',
    intro: auto
      ? `${esc(b.name)} booked a slot and it was confirmed automatically.`
      : `${esc(b.name)} has requested a slot. Open the admin panel to <b>confirm</b> or <b>decline</b> it.`,
    rows,
    button: { url: adminUrl, label: auto ? 'Open admin panel' : 'Review request' },
    badge: auto ? { text: 'CONFIRMED', bg: '#DFF3E4', fg: '#1E6B3A' } : { text: 'NEEDS YOUR ACTION', bg: '#FFF1CC', fg: '#8A5A00' },
    footer: 'This message was sent automatically by your HITZONE booking website.',
  });
  const text = `${subject}\n\n${bookingText(b)}\nName:      ${b.name}\nPhone:     ${b.phone}\nEmail:     ${b.email || '-'}\nPlayers:   ${b.players}\n${b.notes ? `Notes:     ${b.notes}\n` : ''}\nAdmin panel: ${adminUrl}\n`;
  return { subject, html, text };
}

/** To the player: we received your request (or it was auto-confirmed). */
function customerReceived(b, s, baseUrl, qrCid) {
  const auto = b.status === 'confirmed';
  const url = receiptUrl(baseUrl, b);
  const subject = auto ? `Booking confirmed – ${b.ref} | ${s.businessName}` : `We received your booking request – ${b.ref}`;
  const html = layout({
    title: auto ? 'Your booking is confirmed!' : 'Request received',
    intro: auto
      ? `Hi ${esc(b.name)}, your slot at ${esc(s.businessName)} is confirmed. See you on the pitch!`
      : `Hi ${esc(b.name)}, thanks for choosing ${esc(s.businessName)}. We have your request and will confirm it shortly — you will get another email as soon as it is approved.`,
    rows: bookingRows(b),
    button: { url, label: 'View receipt' },
    qrCid,
    badge: auto ? { text: 'CONFIRMED', bg: '#DFF3E4', fg: '#1E6B3A' } : { text: 'AWAITING CONFIRMATION', bg: '#FFF1CC', fg: '#8A5A00' },
    footer: esc(s.paymentNote),
  });
  const text = `${subject}\n\nHi ${b.name},\n${auto ? 'Your booking is confirmed.' : 'We received your request and will confirm it shortly.'}\n\n${bookingText(b)}\n\nReceipt & QR code: ${url}\n\n${s.paymentNote}\n`;
  return { subject, html, text };
}

function customerConfirmed(b, s, baseUrl, qrCid) {
  const url = receiptUrl(baseUrl, b);
  const subject = `Booking confirmed – ${b.ref} | ${s.businessName}`;
  const html = layout({
    title: 'Your booking is confirmed!',
    intro: `Hi ${esc(b.name)}, good news — your slot at ${esc(s.businessName)} has been confirmed. Show the QR code below when you arrive.`,
    rows: bookingRows(b),
    button: { url, label: 'View receipt' },
    qrCid,
    badge: { text: 'CONFIRMED', bg: '#DFF3E4', fg: '#1E6B3A' },
    footer: esc(s.paymentNote),
  });
  const text = `${subject}\n\nHi ${b.name},\nYour booking is confirmed.\n\n${bookingText(b)}\n\nReceipt & QR code: ${url}\n\n${s.paymentNote}\n`;
  return { subject, html, text };
}

function customerDeclined(b, s, baseUrl, cancelled = false) {
  const subject = `${cancelled ? 'Booking cancelled' : 'Booking request not available'} – ${b.ref}`;
  const contact = s.contact.phone ? ` You can call us on ${esc(s.contact.phone)}.` : '';
  const html = layout({
    title: cancelled ? 'Your booking was cancelled' : "Sorry, we couldn't confirm that slot",
    intro: `Hi ${esc(b.name)}, ${cancelled ? 'your booking has been cancelled.' : 'unfortunately we could not confirm your request for this time.'} Please pick another time on our website.${contact}`,
    rows: bookingRows(b),
    button: { url: `${baseUrl}/book.html`, label: 'Choose another time' },
    badge: { text: cancelled ? 'CANCELLED' : 'NOT CONFIRMED', bg: '#FBE0E0', fg: '#8B1E1E' },
    footer: `${esc(s.businessName)}`,
  });
  const text = `${subject}\n\nHi ${b.name},\n${cancelled ? 'Your booking has been cancelled.' : 'We could not confirm your request for this time.'}\n\n${bookingText(b)}\n\nBook another time: ${baseUrl}/book.html\n`;
  return { subject, html, text };
}

module.exports = { adminNewRequest, customerReceived, customerConfirmed, customerDeclined };
