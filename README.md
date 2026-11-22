# PeakFoods

Restaurant backend with login, **password recovery by email**, menu and special offers (with email blasts), table booking, reviews, notifications and **Razorpay payments**. Node.js + Express + SQLite.

Everything is in this one project, front end and back end:
- `public/index.html` is the PeakFoods website. It talks to the API for login, menu, offers, orders, Razorpay payment, table booking, reviews, likes, notifications and the admin panel.
- `public/reset.html` is the page the password-reset email links to.
- `public/pay-demo.html` is a tiny stand-alone payment test page.
- `server.js`, `db.js`, `mail.js`, `seed.js` are the server (Express + SQLite).

## Run locally
```bash
npm install
cp .env.example .env     # then edit .env (set JWT_SECRET, admin login)
npm start                # open http://localhost:3000
```
With `SMTP_HOST` empty, emails are printed in the console (the password reset link too), so you can test without an email account.

First start: the admin account from `ADMIN_EMAIL` / `ADMIN_PASSWORD` is created and 12 sample dishes are added. Log in with that admin account to manage everything; customers use Sign up.

## 1. Email (password recovery, offers, order updates)
Fill the `SMTP_*` values in `.env`. Easiest options:
- **Gmail**: turn on 2-step verification, create an *App password*, use `smtp.gmail.com`, port `587`.
- **Brevo / Resend / Mailgun**: any SMTP login works.

Emails sent: welcome, password reset link (valid 30 minutes, one use), password changed, order confirmed and status changes, booking confirmed or declined, special offers (sent to all customers in batches of 40 using BCC).

## 2. Razorpay payments
1. Razorpay Dashboard > Account & Settings > API Keys > generate **Test** keys. Put them in `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
2. Dashboard > Webhooks > add `https://YOUR-SITE/api/payments/webhook`, choose events `payment.captured`, `payment.failed`, `order.paid`, and set the same secret as `RAZORPAY_WEBHOOK_SECRET`.
3. Test at `/pay-demo.html` with Razorpay test cards. Switch to Live keys only after KYC is approved.

How it works: the browser sends dish ids and quantities, the **server calculates the price** (including offers), creates the Razorpay order, and the order is marked paid only after the payment signature is verified (`/api/payments/verify`) or the signed webhook arrives. Cash on delivery (`method: "cod"`) is also supported.

## Deploy on Render
Push to GitHub, then Render > New > Blueprint > pick the repo (uses `render.yaml`). Add the env values from `.env.example`, set `APP_URL` to your Render URL. SQLite needs a persistent disk (included in `render.yaml`; Render disks need a paid plan). On a free plan the database resets on every deploy, so use a paid disk or move to Postgres.

## API (JSON, send `Authorization: Bearer <token>` after login)
| Method | Path | Who |
|---|---|---|
| POST | /api/auth/register, /login | public |
| POST | /api/auth/forgot `{email}`, /reset `{token,password}` | public |
| GET | /api/me | user |
| GET | /api/menu, /api/offers, /api/reviews, /api/top | public |
| GET/POST | /api/likes/mine, /api/likes/:dishId | user (likes unlock after a booking visit or a delivered order) |
| POST | /api/orders/:id/pay (retry an unpaid online order) | user |
| POST | /api/orders `{items:[{id,qty}],address,phone,branch,method}` | user |
| POST | /api/payments/verify, /api/payments/webhook | user / Razorpay |
| GET | /api/orders, /api/bookings, /api/notifications | user (admin sees all orders and bookings) |
| POST | /api/bookings `{branch,date,time,guests,note}`, /api/reviews, /api/notifications/read | user |
| POST/PUT/DELETE | /api/admin/dishes, /api/admin/menus, /api/admin/offers | admin |
| PATCH | /api/admin/orders/:id `{status}`, /api/admin/bookings/:id `{status,done}` | admin |
| GET/PATCH/DELETE | /api/admin/users | admin |
| POST | /api/admin/announce `{message}` | admin |

Reviews are accepted only after a confirmed booking time has passed (booked time + 2 hours) or the admin marks the visit finished.

## Notes
- Delivery fee is `DELIVERY_FEE` in `.env` (default 30). The page shows 30, so change both if you change it.
- The four branches (names and map positions) are listed in `public/index.html` (`const BR=`).
- The page uses relative URLs (`/api/...`), so open it from this server, not as a loose file.

## Security notes
Never commit `.env`. Change the admin password after first login. Passwords are hashed with bcrypt, reset tokens are stored hashed, auth routes are rate limited.
