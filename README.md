# HITZONE Indoor Cricket Arena – Booking Website

Online slot booking for your arena: customers pick a date and time, send a request, and get a **receipt with a QR code**. You get an **email alert** for every request and approve it from an admin panel. No database and **no `npm install`** needed – bookings are stored in plain files inside `data/`.

## 1. Run it (2 minutes)

1. Install **Node.js 18 or newer** from https://nodejs.org (one time).
2. Open this folder and start the server:
   - Windows: double-click **`start.bat`**
   - Mac/Linux: run `./start.sh` (or `node server.js`)
3. Open **http://localhost:3000** (customers) and **http://localhost:3000/admin.html** (you).
   Default admin password: `hitzone2026` – **change it** (step 2).

To test on your phone, use the "On phone (same Wi‑Fi)" address printed in the window.

## 2. Set your password and email alerts

Copy `.env.example` to a new file named **`.env`** and fill it in:

| Setting | What it does |
|---|---|
| `ADMIN_PASSWORD` | Your admin panel password |
| `ADMIN_EMAIL` | Where "new booking request" emails go |
| `SMTP_HOST / PORT / USER / PASS` | The mailbox that sends the emails |
| `BASE_URL` | Your public web address (so links/QR in emails work). Leave empty while testing |

**Gmail:** turn on 2‑Step Verification → Google Account → Security → *App passwords* → create one → paste it as `SMTP_PASS` (use `smtp.gmail.com`, port `587`).

Until email is set up, every email is saved to `data/outbox.log`, so nothing is lost. The admin dashboard shows a banner telling you whether email is working.

## 3. How a booking works

1. Customer opens **Book now**, picks a date, taps a start time (and a later slot or **+** for more hours – back‑to‑back only), enters name and phone (email optional but recommended).
2. They land on their **receipt** (reference like `HZ-7K3M9P`, QR code, print / PDF, add to calendar, share on WhatsApp). Status: *Awaiting confirmation*.
3. **You get an email** and see it in **Admin → Requests**. Tap **Confirm** (or **Decline**). The customer is emailed (with the QR code) and their receipt page updates by itself.
4. At the arena, scan the QR with your phone while signed in to the admin panel → the receipt opens with a **Mark as arrived** button.

Slots are held as soon as a request is sent, so two people can never book the same time. Want instant bookings without approval? Admin → Settings → *Confirm bookings automatically*.

## 4. Admin panel

- **Requests** – approve/decline with one tap; call, WhatsApp or email the customer.
- **Daily schedule** – every slot of the day; add a **walk‑in** or **block** time (maintenance, tournaments).
- **All bookings** – search, filter, **export CSV** for your accounts.
- **Settings** – price per hour (LKR 5,500), **Open 24 hours** switch (or set opening/closing times), slot length, max hours, closed dates, contact details, payment note.

## 5. Your data (local files)

Everything lives in `data/`:

- `settings.json` – price, hours, contact details (you can edit by hand; restart afterwards)
- `bookings.json` – all bookings
- `backups/` – an automatic daily copy of each file

Back up the `data` folder regularly. Do not edit `bookings.json` while the server is running.

## 6. Making it public

Run it on a computer/server that stays on and put it behind a domain (e.g. a small VPS with nginx + HTTPS, or any Node host with a **persistent disk** – hosts that wipe files on restart will lose bookings). Then set `BASE_URL`, `ADMIN_PASSWORD` and `TRUST_PROXY=true`.

## 7. Check the contact details

Open Admin → Settings and fill in your **phone, WhatsApp, address and map link** – they appear on the website. The site is set up as **open 24 hours** (Settings → *Open 24 hours*). Pictures in `public/images/` are illustrations; swap in real photos of the arena any time (keep the file names).

## Project layout

```
server.js            web server + API
lib/                 booking rules, QR generator, email sender, storage
public/              website (index, book, receipt, admin) + css, js, images
data/                settings.json, bookings.json (your data)
test/run-tests.js    automatic checks  ->  node test/run-tests.js
```

## Later upgrades

Online card payment (e.g. PayHere), SMS/WhatsApp alerts, and moving from files to a database (SQLite/PostgreSQL) when volume grows – the booking rules are isolated in `lib/service.js` to make that easy.
