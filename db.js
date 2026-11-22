const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || './data.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created INTEGER DEFAULT (strftime('%s','now')));
CREATE TABLE IF NOT EXISTS reset_tokens(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, hash TEXT NOT NULL, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS menus(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS dishes(id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL, menu TEXT NOT NULL, emoji TEXT DEFAULT '🍽️', img TEXT DEFAULT '', descr TEXT DEFAULT '', ingredients TEXT DEFAULT '', method TEXT DEFAULT '', active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS offers(id INTEGER PRIMARY KEY, title TEXT NOT NULL, descr TEXT DEFAULT '', pct INTEGER NOT NULL, active INTEGER DEFAULT 1, created INTEGER DEFAULT (strftime('%s','now')));
CREATE TABLE IF NOT EXISTS offer_items(offer_id INTEGER REFERENCES offers(id) ON DELETE CASCADE, dish_id INTEGER REFERENCES dishes(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), items TEXT NOT NULL, subtotal INTEGER, fee INTEGER, total INTEGER, address TEXT, phone TEXT, branch TEXT, method TEXT, status TEXT DEFAULT 'Placed', pay_status TEXT DEFAULT 'pending', rzp_order_id TEXT, rzp_payment_id TEXT, created INTEGER DEFAULT (strftime('%s','now')));
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), branch TEXT, date TEXT, time TEXT, guests INTEGER, note TEXT, status TEXT DEFAULT 'Pending', done INTEGER DEFAULT 0, created INTEGER DEFAULT (strftime('%s','now')));
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), booking_id INTEGER UNIQUE REFERENCES bookings(id), food INTEGER, service INTEGER, note TEXT, created INTEGER DEFAULT (strftime('%s','now')));
CREATE TABLE IF NOT EXISTS likes(user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, dish_id INTEGER REFERENCES dishes(id) ON DELETE CASCADE, PRIMARY KEY(user_id,dish_id));
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, msg TEXT NOT NULL, read INTEGER DEFAULT 0, created INTEGER DEFAULT (strftime('%s','now')));
`);
module.exports = db;
