/* Shared helpers for every page: DOM utils, API client, formatting, header/footer, toasts. */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

/** Tiny hyperscript: h('div', {class:'x', onclick: fn}, 'text', childNode) - text is always escaped. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only used with trusted, static strings
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, { method = 'GET', body, auth } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth) {
    const t = localStorage.getItem('hz_admin');
    if (t) headers.Authorization = `Bearer ${t}`;
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (_) {
    const e = new Error('Cannot reach the server. Check your internet connection and try again.');
    e.network = true;
    throw e;
  }
  let data = {};
  try { data = await res.json(); } catch (_) { /* ignore */ }
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.status = res.status;
    e.field = data.field;
    throw e;
  }
  return data;
}

const pad2 = (n) => String(n).padStart(2, '0');
const fmtMoney = (n, cur = 'LKR') => `${cur} ${Number(n).toLocaleString('en-US')}`;
function fmt12(t) {
  const [hh, mm] = t.split(':').map(Number);
  if (hh === 24) return `12:${pad2(mm)} AM`;
  return `${hh % 12 || 12}:${pad2(mm)} ${hh >= 12 ? 'PM' : 'AM'}`;
}
const dateObj = (s) => new Date(`${s}T00:00:00Z`);
const longDate = (s) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(dateObj(s));
const mediumDate = (s) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(dateObj(s));
const dowOf = (s) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' }).format(dateObj(s));
const domOf = (s) => String(dateObj(s).getUTCDate());
const monOf = (s) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short' }).format(dateObj(s));
const hoursText = (c) => (c.openTime === '00:00' && c.closeTime === '24:00' ? '24 hours' : `${fmt12(c.openTime)} – ${fmt12(c.closeTime)}`);
const hoursLabel = (n) => `${n} hour${n === 1 ? '' : 's'}`;
const minutes = (t) => { const [a, b] = t.split(':').map(Number); return a * 60 + b; };
const waDigits = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); if (d.startsWith('0')) d = '94' + d.slice(1); return d; };

function toast(msg, type = '') {
  let box = $('.toasts');
  if (!box) { box = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${type}`, role: 'status' }, msg);
  box.append(t);
  setTimeout(() => t.remove(), 4200);
}

let _config;
async function getConfig() {
  if (!_config) _config = await api('/api/config');
  return _config;
}

const ICONS = {
  sun: '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  sunset: '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M17 18a5 5 0 0 0-10 0M12 9V2M4.2 10.2l1.4 1.4M1 18h2M21 18h2M18.4 11.6l1.4-1.4M23 22H1M16 5l-4 4-4-4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  pin: '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  card: '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
};

function injectChrome(active) {
  const header = $('#site-header');
  if (header) {
    header.className = 'site-header';
    header.innerHTML = '';
    header.append(
      h('div', { class: 'container' },
        h('a', { class: 'brand', href: '/', 'aria-label': 'HITZONE home' },
          h('img', { src: '/images/favicon.svg', alt: '', width: 38, height: 38 }),
          h('span', { class: 'brand-text' }, 'HITZONE', h('span', { class: 'brand-sub' }, 'INDOOR CRICKET ARENA'))),
        h('nav', { class: 'nav', 'aria-label': 'Main' },
          h('a', { href: '/#how', class: active === 'home' ? 'active' : '' }, 'How it works'),
          h('a', { href: '/#pricing' }, 'Pricing'),
          h('a', { href: '/#gallery' }, 'Gallery'),
          h('a', { href: '/receipt.html', class: active === 'receipt' ? 'active' : '' }, 'My booking'),
          h('a', { href: '/book.html', class: 'btn' }, 'Book now'))));
  }
  const footer = $('#site-footer');
  if (footer) {
    footer.className = 'site-footer';
    footer.innerHTML = '';
    const contactList = h('ul', {});
    footer.append(
      h('div', { class: 'container' },
        h('div', { class: 'grid' },
          h('div', {},
            h('div', { class: 'brand-text', style: 'font-size:2rem;display:inline-block' }, 'HITZONE'),
            h('p', { style: 'margin:8px 0 0;color:#b9c3e6' }, 'A premium indoor cricket facility. Play, practice, compete and enjoy the game — regardless of the weather.'),
            h('p', { style: 'font-family:var(--font-display);font-style:italic;color:var(--gold-3);margin-top:12px' }, 'Come. Play. Hit. Repeat.')),
          h('div', {}, h('h4', {}, 'Quick links'),
            h('ul', {},
              h('li', {}, h('a', { href: '/book.html' }, 'Book a slot')),
              h('li', {}, h('a', { href: '/receipt.html' }, 'Find my booking')),
              h('li', {}, h('a', { href: '/#pricing' }, 'Pricing & hours')),
              h('li', {}, h('a', { href: '/#contact' }, 'Contact')))),
          h('div', {}, h('h4', {}, 'Visit us'), contactList)),
        h('div', { class: 'small' },
          h('span', {}, `© ${new Date().getFullYear()} HITZONE Indoor Cricket Arena. Developed by CW Investments (Pvt) Ltd.`),
          h('a', { href: '/admin.html' }, 'Staff login'))));
    getConfig().then((c) => {
      const k = c.contact || {};
      if (k.address) contactList.append(h('li', {}, k.address));
      if (k.phone) contactList.append(h('li', {}, h('a', { href: `tel:${k.phone.replace(/\s/g, '')}` }, k.phone)));
      if (k.email) contactList.append(h('li', {}, h('a', { href: `mailto:${k.email}` }, k.email)));
      contactList.append(h('li', {}, `Open ${hoursText(c)}`));
    }).catch(() => {});
  }
}
