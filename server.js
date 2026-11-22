require('dotenv').config();
const express = require('express'), cors = require('cors'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken'), crypto = require('crypto'), path = require('path'), Razorpay = require('razorpay');
const db = require('./db'), { send, wrap, devMode } = require('./mail');

const E = process.env, APP_URL = E.APP_URL || 'http://localhost:3000';
if (!E.JWT_SECRET) { console.error('Missing JWT_SECRET. Copy .env.example to .env and set it.'); process.exit(1); }
const rzp = E.RAZORPAY_KEY_ID && E.RAZORPAY_KEY_SECRET ? new Razorpay({ key_id: E.RAZORPAY_KEY_ID, key_secret: E.RAZORPAY_KEY_SECRET }) : null;

// ---------- helpers ----------
const Q = (sql, ...a) => db.prepare(sql).get(...a), A = (sql, ...a) => db.prepare(sql).all(...a), R = (sql, ...a) => db.prepare(sql).run(...a);
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest('hex');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = fn => (q, s, n) => Promise.resolve(fn(q, s, n)).catch(n);
const sign = u => jwt.sign({ id: u.id, role: u.role }, E.JWT_SECRET, { expiresIn: '7d' });
const pub = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const notify = (uid, msg) => R('INSERT INTO notifications(user_id,msg) VALUES(?,?)', uid, msg);
const notifyAdmins = msg => A("SELECT id FROM users WHERE role='admin'").forEach(a => notify(a.id, msg));
const notifyCustomers = msg => A("SELECT id FROM users WHERE role='user'").forEach(u => notify(u.id, msg));
const STATUS = ['Placed', 'Preparing', 'Out for delivery', 'Delivered', 'Cancelled'];
const priceOf = d => {
  const o = Q('SELECT MAX(o.pct) pct FROM offers o JOIN offer_items i ON i.offer_id=o.id WHERE o.active=1 AND i.dish_id=?', d.id);
  return o && o.pct ? Math.round(d.price * (100 - o.pct) / 100) : d.price;
};
const ended = b => b.status === 'Confirmed' && (b.done || Date.now() > new Date(`${b.date}T${b.time}`).getTime() + 2 * 3600 * 1000);

// ---------- seed ----------
if (E.ADMIN_EMAIL && E.ADMIN_PASSWORD && !Q('SELECT id FROM users WHERE email=?', E.ADMIN_EMAIL.toLowerCase()))
  R('INSERT INTO users(name,email,pass,role) VALUES(?,?,?,?)', 'Admin', E.ADMIN_EMAIL.toLowerCase(), bcrypt.hashSync(E.ADMIN_PASSWORD, 10), 'admin');
if (!Q('SELECT id FROM menus')) {
  const seed = require('./seed');
  seed.menus.forEach(m => R('INSERT INTO menus(name) VALUES(?)', m));
  seed.dishes.forEach(d => R('INSERT INTO dishes(name,price,menu,emoji,descr,ingredients,method) VALUES(?,?,?,?,?,?,?)', ...d.slice(0,3), d[3], d[4], d[5], d[6]));
}

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: E.CORS_ORIGIN || true }));

function markPaid(rzpOrderId, paymentId) {
  const r = R("UPDATE orders SET pay_status='paid', rzp_payment_id=? WHERE rzp_order_id=? AND pay_status!='paid'", paymentId || null, rzpOrderId);
  if (!r.changes) return;
  const o = Q('SELECT * FROM orders WHERE rzp_order_id=?', rzpOrderId);
  orderPlaced(o);
}
function orderPlaced(o) {
  const u = Q('SELECT * FROM users WHERE id=?', o.user_id);
  notify(o.user_id, `Order #${o.id} confirmed (${o.method === 'online' ? 'paid online' : 'cash on delivery'}). We will update you here.`);
  notifyAdmins(`New order #${o.id} from ${u.name} (Rs ${o.total}, ${o.method})`);
  const rows = JSON.parse(o.items).map(i => `<li>${i.qty} x ${esc(i.name)} - Rs ${i.price * i.qty}</li>`).join('');
  send({ to: u.email, subject: `PeakFoods order #${o.id} confirmed`, html: wrap('Thank you for your order', `<ul>${rows}</ul><p><b>Total: Rs ${o.total}</b> (${o.method === 'online' ? 'paid online' : 'pay on delivery'})</p><p>Delivering to: ${esc(o.address)}</p>`) });
}

// Razorpay webhook: needs the RAW body, so it is registered before express.json()
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['x-razorpay-signature'];
  if (!E.RAZORPAY_WEBHOOK_SECRET || !sig || !safeEq(hmac(E.RAZORPAY_WEBHOOK_SECRET, req.body), sig)) return res.status(400).end();
  const ev = JSON.parse(req.body), p = ev.payload && ev.payload.payment && ev.payload.payment.entity;
  const oid = (p && p.order_id) || (ev.payload && ev.payload.order && ev.payload.order.entity.id);
  if (oid && (ev.event === 'payment.captured' || ev.event === 'order.paid')) markPaid(oid, p && p.id);
  if (oid && ev.event === 'payment.failed') R("UPDATE orders SET pay_status='failed' WHERE rzp_order_id=? AND pay_status!='paid'", oid);
  res.json({ ok: true });
});

app.use(express.json({ limit: '2mb' }));

const auth = (req, res, next) => {
  try {
    const p = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), E.JWT_SECRET);
    const u = Q('SELECT * FROM users WHERE id=?', p.id); if (!u) throw 0;
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Please log in' }); }
};
const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

// ---------- auth + password recovery ----------
app.post('/api/auth/register', limiter, h(async (q, s) => {
  const { name, email, password } = q.body || {}, em = String(email || '').trim().toLowerCase();
  if (!name || !/^\S+@\S+\.\S+$/.test(em) || String(password || '').length < 8) return s.status(400).json({ error: 'Name, valid email and a password of 8+ characters are required' });
  if (Q('SELECT id FROM users WHERE email=?', em)) return s.status(409).json({ error: 'That email is already registered' });
  const id = R('INSERT INTO users(name,email,pass) VALUES(?,?,?)', String(name).trim(), em, bcrypt.hashSync(password, 10)).lastInsertRowid;
  const u = Q('SELECT * FROM users WHERE id=?', id);
  notifyAdmins('New customer signed up: ' + u.name);
  send({ to: em, subject: 'Welcome to PeakFoods', html: wrap('Welcome, ' + esc(u.name), '<p>Your account is ready. Order delivery or book a table any time.</p>') });
  s.status(201).json({ token: sign(u), user: pub(u) });
}));

app.post('/api/auth/login', limiter, h(async (q, s) => {
  const { email, password } = q.body || {};
  const u = Q('SELECT * FROM users WHERE email=?', String(email || '').trim().toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ''), u.pass)) return s.status(401).json({ error: 'Wrong email or password' });
  s.json({ token: sign(u), user: pub(u) });
}));

// Forgot password: emails a one-time link that expires in 30 minutes. Same reply whether or not the email exists.
app.post('/api/auth/forgot', limiter, h(async (q, s) => {
  const u = Q('SELECT * FROM users WHERE email=?', String((q.body || {}).email || '').trim().toLowerCase());
  if (u) {
    const raw = crypto.randomBytes(32).toString('hex');
    R('DELETE FROM reset_tokens WHERE user_id=?', u.id);
    R('INSERT INTO reset_tokens(user_id,hash,exp) VALUES(?,?,?)', u.id, sha(raw), Date.now() + 30 * 60 * 1000);
    const link = `${APP_URL}/reset.html?token=${raw}`;
    if (devMode) console.log('[dev] password reset link:', link);
    send({ to: u.email, subject: 'Reset your PeakFoods password', html: wrap('Password reset', `<p>Hi ${esc(u.name)}, tap the button within 30 minutes to choose a new password.</p><p><a href="${link}" style="background:#f2a100;color:#10213a;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Reset password</a></p><p style="color:#666">If you did not ask for this, you can ignore this email.</p>`) });
  }
  s.json({ ok: true, message: 'If that email is registered, a reset link has been sent.' });
}));

app.post('/api/auth/reset', limiter, h(async (q, s) => {
  const { token, password } = q.body || {};
  if (String(password || '').length < 8) return s.status(400).json({ error: 'Password must be 8+ characters' });
  const t = Q('SELECT * FROM reset_tokens WHERE hash=?', sha(String(token || '')));
  if (!t || t.exp < Date.now()) return s.status(400).json({ error: 'This reset link is invalid or has expired' });
  R('UPDATE users SET pass=? WHERE id=?', bcrypt.hashSync(password, 10), t.user_id);
  R('DELETE FROM reset_tokens WHERE user_id=?', t.user_id);
  const u = Q('SELECT * FROM users WHERE id=?', t.user_id);
  send({ to: u.email, subject: 'Your PeakFoods password was changed', html: wrap('Password changed', '<p>Your password was just changed. If this was not you, reset it again right away.</p>') });
  s.json({ ok: true });
}));

app.get('/api/me', auth, (q, s) => s.json({ user: pub(q.user) }));

// ---------- menu ----------
app.get('/api/menu', (q, s) => s.json({
  menus: A('SELECT * FROM menus ORDER BY id'),
  dishes: A('SELECT d.*, (SELECT COUNT(*) FROM likes l WHERE l.dish_id=d.id) likes FROM dishes d WHERE d.active=1 ORDER BY d.id').map(d => ({ ...d, offer_price: priceOf(d) })),
}));
const DISH_FIELDS = ['name', 'price', 'menu', 'emoji', 'img', 'descr', 'ingredients', 'method', 'active'];
app.post('/api/admin/dishes', auth, admin, h(async (q, s) => {
  const b = q.body || {};
  if (!b.name || !(+b.price > 0) || !b.menu) return s.status(400).json({ error: 'name, price and menu are required' });
  const id = R('INSERT INTO dishes(name,price,menu,emoji,img,descr,ingredients,method) VALUES(?,?,?,?,?,?,?,?)', b.name, +b.price, b.menu, b.emoji || '🍽️', b.img || '', b.descr || '', b.ingredients || '', b.method || '').lastInsertRowid;
  s.status(201).json(Q('SELECT * FROM dishes WHERE id=?', id));
}));
app.put('/api/admin/dishes/:id', auth, admin, h(async (q, s) => {
  const keys = DISH_FIELDS.filter(k => k in (q.body || {}));
  if (!keys.length) return s.status(400).json({ error: 'Nothing to update' });
  R(`UPDATE dishes SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`, ...keys.map(k => q.body[k]), q.params.id);
  s.json(Q('SELECT * FROM dishes WHERE id=?', q.params.id));
}));
app.delete('/api/admin/dishes/:id', auth, admin, (q, s) => { R('DELETE FROM dishes WHERE id=?', q.params.id); s.json({ ok: true }); });
app.post('/api/admin/menus', auth, admin, h(async (q, s) => {
  const n = String((q.body || {}).name || '').trim();
  if (!n) return s.status(400).json({ error: 'Menu name required' });
  if (Q('SELECT id FROM menus WHERE name=?', n)) return s.status(409).json({ error: 'Menu already exists' });
  s.status(201).json({ id: R('INSERT INTO menus(name) VALUES(?)', n).lastInsertRowid, name: n });
}));
app.delete('/api/admin/menus/:id', auth, admin, (q, s) => {
  const m = Q('SELECT * FROM menus WHERE id=?', q.params.id);
  if (m) { R('DELETE FROM dishes WHERE menu=?', m.name); R('DELETE FROM menus WHERE id=?', m.id); }
  s.json({ ok: true });
});

// ---------- special offers (in-app notification + email to every customer) ----------
app.get('/api/offers', (q, s) => s.json(A('SELECT * FROM offers WHERE active=1 ORDER BY id DESC').map(o => ({
  ...o, dishes: A('SELECT d.* FROM dishes d JOIN offer_items i ON i.dish_id=d.id WHERE i.offer_id=?', o.id).map(d => ({ ...d, offer_price: priceOf(d) })),
}))));
app.post('/api/admin/offers', auth, admin, h(async (q, s) => {
  const { title, descr = '', pct, dishIds } = q.body || {};
  if (!title || !(+pct >= 1 && +pct <= 90) || !Array.isArray(dishIds) || !dishIds.length) return s.status(400).json({ error: 'title, pct (1-90) and dishIds are required' });
  const id = R('INSERT INTO offers(title,descr,pct) VALUES(?,?,?)', title, descr, +pct).lastInsertRowid;
  dishIds.forEach(d => R('INSERT INTO offer_items(offer_id,dish_id) VALUES(?,?)', id, d));
  notifyCustomers(`🔥 New offer: ${title} - ${pct}% off. Open Offers to order.`);
  const emails = A("SELECT email FROM users WHERE role='user'").map(u => u.email);
  const html = wrap('🔥 ' + esc(title), `<p><b>${+pct}% off</b></p><p>${esc(descr)}</p><p><a href="${APP_URL}" style="background:#f2a100;color:#10213a;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Order now</a></p>`);
  (async () => { for (let i = 0; i < emails.length; i += 40) await send({ bcc: emails.slice(i, i + 40), subject: `PeakFoods offer: ${title} - ${pct}% off`, html }); })();
  s.status(201).json({ id, emailed: emails.length });
}));
app.patch('/api/admin/offers/:id/toggle', auth, admin, (q, s) => { R('UPDATE offers SET active=1-active WHERE id=?', q.params.id); s.json({ ok: true }); });
app.delete('/api/admin/offers/:id', auth, admin, (q, s) => { R('DELETE FROM offers WHERE id=?', q.params.id); s.json({ ok: true }); });

// ---------- orders + Razorpay ----------
// The server calculates the price itself. The browser only sends dish ids and quantities.
app.post('/api/orders', auth, h(async (q, s) => {
  const { items, address, phone, branch = '', method = 'online' } = q.body || {};
  if (!Array.isArray(items) || !items.length || !address || String(phone || '').length < 8) return s.status(400).json({ error: 'items, address and phone are required' });
  if (!['online', 'cod'].includes(method)) return s.status(400).json({ error: 'method must be online or cod' });
  if (method === 'online' && !rzp) return s.status(503).json({ error: 'Online payments are not configured on this server' });
  let sub = 0; const lines = [];
  for (const it of items) {
    const d = Q('SELECT * FROM dishes WHERE id=? AND active=1', it.id), qty = Math.max(1, Math.min(50, +it.qty | 0));
    if (!d) return s.status(400).json({ error: `Dish ${it.id} is not available` });
    const price = priceOf(d); sub += price * qty; lines.push({ id: d.id, name: d.name, qty, price });
  }
  const fee = +(E.DELIVERY_FEE || 30), total = sub + fee;
  const id = R('INSERT INTO orders(user_id,items,subtotal,fee,total,address,phone,branch,method) VALUES(?,?,?,?,?,?,?,?,?)', q.user.id, JSON.stringify(lines), sub, fee, total, address, phone, branch, method).lastInsertRowid;
  if (method === 'cod') { orderPlaced(Q('SELECT * FROM orders WHERE id=?', id)); return s.status(201).json({ orderId: id, total }); }
  let ro;
  try { ro = await rzp.orders.create({ amount: total * 100, currency: 'INR', receipt: 'pf_' + id }); }
  catch (e) { R('DELETE FROM orders WHERE id=?', id); console.error('Razorpay order failed:', e.message || e); return s.status(502).json({ error: 'Could not start the payment. Check the Razorpay keys and try again.' }); }
  R('UPDATE orders SET rzp_order_id=? WHERE id=?', ro.id, id);
  s.status(201).json({ orderId: id, total, razorpay: { key: E.RAZORPAY_KEY_ID, orderId: ro.id, amount: ro.amount, currency: 'INR' } });
}));

// Browser calls this after Razorpay Checkout succeeds. The signature is checked on the server.
app.post('/api/payments/verify', auth, h(async (q, s) => {
  const { razorpay_order_id: o, razorpay_payment_id: p, razorpay_signature: sig } = q.body || {};
  const ord = Q('SELECT * FROM orders WHERE rzp_order_id=? AND user_id=?', String(o), q.user.id);
  if (!ord) return s.status(404).json({ error: 'Order not found' });
  if (!E.RAZORPAY_KEY_SECRET || !sig || !safeEq(hmac(E.RAZORPAY_KEY_SECRET, o + '|' + p), sig)) return s.status(400).json({ error: 'Invalid payment signature' });
  markPaid(o, p); s.json({ ok: true });
}));

app.get('/api/orders', auth, (q, s) => {
  const rows = q.user.role === 'admin' ? A('SELECT o.*, u.name customer FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.id DESC') : A('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC', q.user.id);
  s.json(rows.map(o => ({ ...o, items: JSON.parse(o.items) })));
});
app.patch('/api/admin/orders/:id', auth, admin, h(async (q, s) => {
  const st = (q.body || {}).status, o = Q('SELECT * FROM orders WHERE id=?', q.params.id);
  if (!o || !STATUS.includes(st)) return s.status(400).json({ error: 'Valid order id and status required' });
  R('UPDATE orders SET status=? WHERE id=?', st, o.id);
  notify(o.user_id, `Order #${o.id} is now: ${st}.`);
  const u = Q('SELECT * FROM users WHERE id=?', o.user_id);
  send({ to: u.email, subject: `PeakFoods order #${o.id}: ${st}`, html: wrap('Order update', `<p>Your order #${o.id} is now <b>${st}</b>.</p>`) });
  s.json({ ok: true });
}));

// ---------- table bookings ----------
app.post('/api/bookings', auth, h(async (q, s) => {
  const { branch, date, time, guests, note = '' } = q.body || {};
  if (!branch || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '') || !(+guests > 0)) return s.status(400).json({ error: 'branch, date (YYYY-MM-DD), time (HH:MM) and guests are required' });
  const id = R('INSERT INTO bookings(user_id,branch,date,time,guests,note) VALUES(?,?,?,?,?,?)', q.user.id, branch, date, time, +guests, note).lastInsertRowid;
  notify(q.user.id, `Booking #${id} requested at ${branch} on ${date}, ${time}.`);
  notifyAdmins(`New booking #${id}: ${q.user.name}, ${guests} guests, ${branch} ${date} ${time}`);
  s.status(201).json({ id });
}));
app.get('/api/bookings', auth, (q, s) => s.json(q.user.role === 'admin'
  ? A('SELECT b.*, u.name customer, (SELECT COUNT(*) FROM reviews r WHERE r.booking_id=b.id) reviewed FROM bookings b JOIN users u ON u.id=b.user_id ORDER BY b.id DESC')
  : A('SELECT b.*, (SELECT COUNT(*) FROM reviews r WHERE r.booking_id=b.id) reviewed FROM bookings b WHERE b.user_id=? ORDER BY b.id DESC', q.user.id)));
app.patch('/api/admin/bookings/:id', auth, admin, h(async (q, s) => {
  const b = Q('SELECT * FROM bookings WHERE id=?', q.params.id); if (!b) return s.status(404).json({ error: 'Not found' });
  const u = Q('SELECT * FROM users WHERE id=?', b.user_id), { status, done } = q.body || {};
  if (['Confirmed', 'Declined'].includes(status)) {
    R('UPDATE bookings SET status=? WHERE id=?', status, b.id);
    notify(b.user_id, `Booking #${b.id} at ${b.branch} on ${b.date} is ${status.toLowerCase()}.`);
    send({ to: u.email, subject: `PeakFoods booking ${status.toLowerCase()}`, html: wrap('Table booking ' + status, `<p>${esc(b.branch)}, ${b.date} at ${b.time}, ${b.guests} guests.</p>`) });
  }
  if (done) { R('UPDATE bookings SET done=1 WHERE id=?', b.id); notify(b.user_id, `Thanks for visiting ${b.branch}. Please rate your food and service.`); }
  s.json({ ok: true });
}));

// ---------- reviews (allowed after the booking time is over) ----------
app.post('/api/reviews', auth, h(async (q, s) => {
  const { booking_id, food, service, note = '' } = q.body || {};
  const b = Q('SELECT * FROM bookings WHERE id=? AND user_id=?', booking_id, q.user.id);
  if (!b || !ended(b)) return s.status(403).json({ error: 'You can review after your booking time is over' });
  if (Q('SELECT id FROM reviews WHERE booking_id=?', b.id)) return s.status(409).json({ error: 'Already reviewed' });
  if (![food, service].every(n => Number.isInteger(+n) && +n >= 1 && +n <= 5)) return s.status(400).json({ error: 'food and service must be 1-5' });
  R('INSERT INTO reviews(user_id,booking_id,food,service,note) VALUES(?,?,?,?,?)', q.user.id, b.id, +food, +service, note);
  notifyAdmins(`New review from ${q.user.name}: food ${food}/5, service ${service}/5`);
  s.status(201).json({ ok: true });
}));
app.get('/api/reviews', (q, s) => s.json(A('SELECT r.*, u.name, b.branch FROM reviews r JOIN users u ON u.id=r.user_id JOIN bookings b ON b.id=r.booking_id ORDER BY r.id DESC')));

// ---------- notifications ----------
app.get('/api/notifications', auth, (q, s) => s.json(A('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100', q.user.id)));
app.post('/api/notifications/read', auth, (q, s) => { R('UPDATE notifications SET read=1 WHERE user_id=?', q.user.id); s.json({ ok: true }); });

// ---------- admin: users + announcements ----------
app.get('/api/admin/users', auth, admin, (q, s) => s.json(A('SELECT id,name,email,role,created FROM users ORDER BY id')));
app.patch('/api/admin/users/:id/role', auth, admin, (q, s) => {
  if (+q.params.id !== q.user.id) R("UPDATE users SET role=CASE role WHEN 'admin' THEN 'user' ELSE 'admin' END WHERE id=?", q.params.id);
  s.json({ ok: true });
});
app.delete('/api/admin/users/:id', auth, admin, (q, s) => { if (+q.params.id !== q.user.id) R('DELETE FROM users WHERE id=?', q.params.id); s.json({ ok: true }); });
app.post('/api/admin/announce', auth, admin, (q, s) => {
  const m = String((q.body || {}).message || '').trim();
  if (!m) return s.status(400).json({ error: 'message required' });
  notifyCustomers(m); s.json({ ok: true });
});

// ---------- extra endpoints used by the website ----------
app.get('/api/admin/dishes', auth, admin, (q, s) => s.json(A('SELECT d.*, (SELECT COUNT(*) FROM likes l WHERE l.dish_id=d.id) likes FROM dishes d ORDER BY d.id').map(d => ({ ...d, offer_price: priceOf(d) }))));
app.get('/api/admin/offers', auth, admin, (q, s) => s.json(A('SELECT * FROM offers ORDER BY id DESC').map(o => ({
  ...o, dishes: A('SELECT d.* FROM dishes d JOIN offer_items i ON i.dish_id=d.id WHERE i.offer_id=?', o.id),
}))));
app.get('/api/top', (q, s) => {
  const c = {};
  A("SELECT items FROM orders WHERE status!='Cancelled' AND (method='cod' OR pay_status='paid')").forEach(o => JSON.parse(o.items).forEach(i => { c[i.name] = (c[i.name] || 0) + i.qty; }));
  s.json(Object.entries(c).map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty).slice(0, 4));
});
app.get('/api/likes/mine', auth, (q, s) => s.json(A('SELECT dish_id FROM likes WHERE user_id=?', q.user.id).map(r => r.dish_id)));
app.post('/api/likes/:dishId', auth, h(async (q, s) => {
  const ok = A('SELECT * FROM bookings WHERE user_id=?', q.user.id).some(ended) || Q("SELECT id FROM orders WHERE user_id=? AND status='Delivered'", q.user.id);
  if (!ok) return s.status(403).json({ error: 'Likes unlock after your table booking time is over' });
  if (!Q('SELECT id FROM dishes WHERE id=?', q.params.dishId)) return s.status(404).json({ error: 'Dish not found' });
  const had = Q('SELECT 1 x FROM likes WHERE user_id=? AND dish_id=?', q.user.id, q.params.dishId);
  if (had) R('DELETE FROM likes WHERE user_id=? AND dish_id=?', q.user.id, q.params.dishId); else R('INSERT INTO likes(user_id,dish_id) VALUES(?,?)', q.user.id, q.params.dishId);
  s.json({ liked: !had });
}));
app.post('/api/orders/:id/pay', auth, (q, s) => {
  const o = Q('SELECT * FROM orders WHERE id=? AND user_id=?', q.params.id, q.user.id);
  if (!o || o.method !== 'online' || o.pay_status === 'paid' || !o.rzp_order_id) return s.status(400).json({ error: 'Nothing to pay for this order' });
  s.json({ razorpay: { key: E.RAZORPAY_KEY_ID, orderId: o.rzp_order_id, amount: o.total * 100, currency: 'INR' } });
});
app.delete('/api/admin/reviews/:id', auth, admin, (q, s) => { R('DELETE FROM reviews WHERE id=?', q.params.id); s.json({ ok: true }); });

app.get('/api/health', (q, s) => s.json({ ok: true, payments: !!rzp, email: !devMode }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((e, q, s, n) => { console.error(e); s.status(500).json({ error: 'Something went wrong' }); });
app.listen(E.PORT || 3000, () => console.log(`PeakFoods running on ${APP_URL}  (payments: ${rzp ? 'on' : 'off'}, email: ${devMode ? 'dev/console' : 'SMTP'})`));
