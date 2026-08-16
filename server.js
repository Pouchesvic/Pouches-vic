const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'pouchesvic.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://pouchesvic.com').replace(/\/$/, '');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ORDER_EMAIL_FROM = process.env.ORDER_EMAIL_FROM || '';
const ORDER_EMAIL_REPLY_TO = process.env.ORDER_EMAIL_REPLY_TO || '';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function now() { return new Date().toISOString(); }
function id() { return crypto.randomUUID(); }
function token(bytes = 24) { return crypto.randomBytes(bytes).toString('hex'); }
function bool(v) { return v ? 1 : 0; }
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function int(v, d = 0) { const n = Math.trunc(num(v, d)); return Number.isFinite(n) ? n : d; }
function text(v) { return v == null ? '' : String(v).trim(); }
function lower(v) { return text(v).toLowerCase(); }
function cents(v) { return Math.round(num(v) * 100); }
function dollars(c) { return Number(c || 0) / 100; }
function clampInt(v, min = 0) { return Math.max(min, int(v)); }
function safeJson(v, d = null) { try { return JSON.parse(v); } catch { return d; } }
function jsonText(v) { return JSON.stringify(v == null ? null : v); }
function htmlEscape(s) { return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function money(c) { return `$${dollars(c).toFixed(2)}`; }
function normalizePhone(v) { return text(v); }
function hashPin(pin) { return crypto.createHash('sha256').update(`pv-driver:${text(pin)}`).digest('hex'); }
function weekStartMonday(dateLike = new Date()) {
  const d = new Date(dateLike);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function isoDate(d) { return new Date(d).toISOString().slice(0, 10); }
function roundNearest(value, step) {
  step = Math.abs(int(step));
  if (!step) return int(value);
  return Math.round(Number(value) / step) * step;
}
function roundDown(value, step) {
  step = Math.abs(int(step));
  if (!step) return int(value);
  return Math.floor(Number(value) / step) * step;
}

function one(sql, ...args) { return db.prepare(sql).get(...args); }
function all(sql, ...args) { return db.prepare(sql).all(...args); }
function run(sql, ...args) { return db.prepare(sql).run(...args); }

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS territories(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  domain TEXT DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'CAD',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pricing_tiers(
  id TEXT PRIMARY KEY,
  territory_id TEXT NOT NULL,
  min_qty INTEGER NOT NULL,
  max_qty INTEGER,
  unit_price REAL NOT NULL,
  unit_price_cents INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS delivery_zones(
  id TEXT PRIMARY KEY,
  territory_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color_label TEXT DEFAULT '',
  fee REAL NOT NULL DEFAULT 0,
  fee_cents INTEGER,
  free_at_qty INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT DEFAULT '',
  rule_notes TEXT DEFAULT '',
  geojson TEXT DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS products(
  id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  flavor TEXT NOT NULL,
  strength TEXT DEFAULT '',
  image TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS territory_products(
  id TEXT PRIMARY KEY,
  territory_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  inventory INTEGER NOT NULL DEFAULT 0,
  listed INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0,
  local_price_override REAL,
  local_price_override_cents INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(territory_id, product_id),
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS drivers(
  id TEXT PRIMARY KEY,
  territory_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'driver',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  customer_contact_number TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  pin_hash TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS settlement_rules(
  id TEXT PRIMARY KEY,
  territory_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  rule_type TEXT NOT NULL,
  from_driver_id TEXT,
  to_driver_id TEXT,
  zone_id TEXT,
  amount REAL NOT NULL DEFAULT 0,
  amount_cents INTEGER,
  notes TEXT DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE RESTRICT,
  FOREIGN KEY(from_driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
  FOREIGN KEY(to_driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
  FOREIGN KEY(zone_id) REFERENCES delivery_zones(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS delivery_windows(
  id TEXT PRIMARY KEY,
  territory_id TEXT NOT NULL,
  label TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  days_json TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,0]',
  active INTEGER NOT NULL DEFAULT 1,
  capacity INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY,
  order_no INTEGER,
  territory_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'web',
  status TEXT NOT NULL DEFAULT 'new',
  customer_token TEXT UNIQUE,
  customer_name TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  customer_email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  address_lat REAL,
  address_lng REAL,
  delivery_notes TEXT DEFAULT '',
  delivery_window_id TEXT,
  delivery_window_label TEXT DEFAULT '',
  zone_id TEXT,
  zone_name_snapshot TEXT DEFAULT '',
  zone_fee_snapshot REAL NOT NULL DEFAULT 0,
  zone_fee_snapshot_cents INTEGER NOT NULL DEFAULT 0,
  zone_fee_override REAL,
  zone_fee_override_cents INTEGER,
  zone_override_note TEXT DEFAULT '',
  assigned_driver_id TEXT,
  created_by_driver_id TEXT,
  created_by_role TEXT DEFAULT 'customer',
  payment_method TEXT DEFAULT '',
  payment_note TEXT DEFAULT '',
  subtotal REAL NOT NULL DEFAULT 0,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  delivery_fee REAL NOT NULL DEFAULT 0,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  pre_discount_total_cents INTEGER NOT NULL DEFAULT 0,
  customer_discount_cents INTEGER NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  rounding_adjustment REAL NOT NULL DEFAULT 0,
  inventory_applied INTEGER NOT NULL DEFAULT 1,
  confirmation_email_status TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  FOREIGN KEY(territory_id) REFERENCES territories(id),
  FOREIGN KEY(zone_id) REFERENCES delivery_zones(id) ON DELETE SET NULL,
  FOREIGN KEY(assigned_driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
  FOREIGN KEY(created_by_driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
  FOREIGN KEY(delivery_window_id) REFERENCES delivery_windows(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS order_items(
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  product_id TEXT,
  product_name_snapshot TEXT NOT NULL,
  brand_snapshot TEXT DEFAULT '',
  strength_snapshot TEXT DEFAULT '',
  qty INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  line_total REAL NOT NULL,
  line_total_cents INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS payments(
  id TEXT PRIMARY KEY,
  order_id TEXT,
  territory_id TEXT NOT NULL,
  driver_id TEXT,
  method TEXT NOT NULL DEFAULT 'cash',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  destination_type TEXT NOT NULL DEFAULT 'driver',
  destination_driver_id TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  note TEXT DEFAULT '',
  created_by_role TEXT DEFAULT 'admin',
  created_by_driver_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL,
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE RESTRICT,
  FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
  FOREIGN KEY(destination_driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
  FOREIGN KEY(created_by_driver_id) REFERENCES drivers(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS inventory_movements(
  id TEXT PRIMARY KEY,
  territory_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  order_id TEXT,
  driver_id TEXT,
  movement_type TEXT NOT NULL,
  qty_delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  note TEXT DEFAULT '',
  created_by_role TEXT DEFAULT 'system',
  created_by_driver_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE RESTRICT,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL,
  FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
  FOREIGN KEY(created_by_driver_id) REFERENCES drivers(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS order_events(
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT DEFAULT '',
  data_json TEXT DEFAULT '{}',
  attention INTEGER NOT NULL DEFAULT 0,
  reviewed INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  visible_to_customer INTEGER NOT NULL DEFAULT 0,
  created_by_role TEXT DEFAULT 'system',
  created_by_driver_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY(created_by_driver_id) REFERENCES drivers(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS order_adjustments(
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  affects_inventory INTEGER NOT NULL DEFAULT 0,
  product_id TEXT,
  qty_delta INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS settlement_entries(
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  territory_id TEXT NOT NULL,
  source_driver_id TEXT,
  target_type TEXT NOT NULL,
  target_driver_id TEXT,
  entry_type TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  rate_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  rule_name TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(order_id, entry_type, source_driver_id, target_type, target_driver_id, rule_name),
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE RESTRICT,
  FOREIGN KEY(source_driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
  FOREIGN KEY(target_driver_id) REFERENCES drivers(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS weekly_settlements(
  id TEXT PRIMARY KEY,
  territory_id TEXT NOT NULL,
  driver_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  exact_send_to_boss_cents INTEGER NOT NULL DEFAULT 0,
  rounded_send_to_boss_cents INTEGER NOT NULL DEFAULT 0,
  settlement_rounding_cents INTEGER NOT NULL DEFAULT 0,
  driver_keeps_cents INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(territory_id, driver_id, week_start)
);
CREATE TABLE IF NOT EXISTS settlement_adjustments(
  id TEXT PRIMARY KEY,
  territory_id TEXT NOT NULL,
  driver_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  direction TEXT NOT NULL DEFAULT 'boss_credit',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE RESTRICT,
  FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS reviews(
  id TEXT PRIMARY KEY,
  territory_id TEXT,
  order_id TEXT,
  customer_name TEXT DEFAULT '',
  rating INTEGER NOT NULL DEFAULT 5,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE SET NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY,
  territory_id TEXT,
  order_id TEXT,
  customer_name TEXT DEFAULT '',
  customer_email TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE SET NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS counters(
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
`);

function tableColumns(table) { return new Set(all(`PRAGMA table_info(${table})`).map(x => x.name)); }
function ensureColumn(table, name, def) {
  const cols = tableColumns(table);
  if (!cols.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}

// Safe upgrades from earlier PouchesVic builds.
[
  ['territories','archived','INTEGER NOT NULL DEFAULT 0'],
  ['pricing_tiers','unit_price_cents','INTEGER'],
  ['delivery_zones','fee_cents','INTEGER'],
  ['delivery_zones','geojson',"TEXT DEFAULT ''"],
  ['territories','operating_hours','TEXT DEFAULT \'\''],
  ['territories','same_day_text','TEXT DEFAULT \'SAME-DAY DELIVERY\''],
  ['territories','payment_note_text','TEXT DEFAULT \'No upfront payment — pay when your order arrives.\''],
  ['products','archived','INTEGER NOT NULL DEFAULT 0'],
  ['territory_products','local_price_override_cents','INTEGER'],
  ['drivers','archived','INTEGER NOT NULL DEFAULT 0'],
  ['drivers','customer_contact_number',"TEXT DEFAULT ''"],
  ['drivers','pin_hash',"TEXT DEFAULT ''"],
  ['settlement_rules','archived','INTEGER NOT NULL DEFAULT 0'],
  ['settlement_rules','amount_cents','INTEGER'],
  ['settlement_rules','created_at','TEXT'],
  ['settlement_rules','updated_at','TEXT'],
  ['orders','source',"TEXT NOT NULL DEFAULT 'web'"],
  ['orders','customer_token','TEXT'],
  ['orders','address_lat','REAL'],
  ['orders','address_lng','REAL'],
  ['orders','delivery_window_id','TEXT'],
  ['orders','delivery_window_label',"TEXT DEFAULT ''"],
  ['orders','zone_fee_snapshot_cents','INTEGER NOT NULL DEFAULT 0'],
  ['orders','zone_fee_override_cents','INTEGER'],
  ['orders','created_by_driver_id','TEXT'],
  ['orders','created_by_role',"TEXT DEFAULT 'customer'"],
  ['orders','subtotal_cents','INTEGER NOT NULL DEFAULT 0'],
  ['orders','delivery_fee_cents','INTEGER NOT NULL DEFAULT 0'],
  ['orders','pre_discount_total_cents','INTEGER NOT NULL DEFAULT 0'],
  ['orders','customer_discount_cents','INTEGER NOT NULL DEFAULT 0'],
  ['orders','total_cents','INTEGER NOT NULL DEFAULT 0'],
  ['orders','inventory_applied','INTEGER NOT NULL DEFAULT 1'],
  ['orders','confirmation_email_status',"TEXT DEFAULT ''"],
  ['orders','updated_at','TEXT'],
  ['orders','cancelled_at','TEXT'],
  ['order_items','unit_price_cents','INTEGER NOT NULL DEFAULT 0'],
  ['order_items','line_total_cents','INTEGER NOT NULL DEFAULT 0'],
  ['order_adjustments','amount_cents','INTEGER NOT NULL DEFAULT 0']
].forEach(x => ensureColumn(...x));

function backfillMoneyColumns() {
  run(`UPDATE pricing_tiers SET unit_price_cents=CAST(ROUND(unit_price*100) AS INTEGER) WHERE unit_price_cents IS NULL`);
  run(`UPDATE delivery_zones SET fee_cents=CAST(ROUND(fee*100) AS INTEGER) WHERE fee_cents IS NULL`);
  run(`UPDATE territory_products SET local_price_override_cents=CAST(ROUND(local_price_override*100) AS INTEGER) WHERE local_price_override IS NOT NULL AND local_price_override_cents IS NULL`);
  run(`UPDATE settlement_rules SET amount_cents=CAST(ROUND(amount*100) AS INTEGER) WHERE amount_cents IS NULL`);
  run(`UPDATE orders SET subtotal_cents=CAST(ROUND(subtotal*100) AS INTEGER) WHERE subtotal_cents=0 AND subtotal!=0`);
  run(`UPDATE orders SET delivery_fee_cents=CAST(ROUND(delivery_fee*100) AS INTEGER) WHERE delivery_fee_cents=0 AND delivery_fee!=0`);
  run(`UPDATE orders SET total_cents=CAST(ROUND(total*100) AS INTEGER) WHERE total_cents=0 AND total!=0`);
  run(`UPDATE orders SET pre_discount_total_cents=subtotal_cents+delivery_fee_cents WHERE pre_discount_total_cents=0`);
  run(`UPDATE orders SET customer_discount_cents=MAX(0,pre_discount_total_cents-total_cents) WHERE customer_discount_cents=0`);
  run(`UPDATE orders SET zone_fee_snapshot_cents=CAST(ROUND(zone_fee_snapshot*100) AS INTEGER) WHERE zone_fee_snapshot_cents=0 AND zone_fee_snapshot!=0`);
  run(`UPDATE orders SET zone_fee_override_cents=CAST(ROUND(zone_fee_override*100) AS INTEGER) WHERE zone_fee_override IS NOT NULL AND zone_fee_override_cents IS NULL`);
  run(`UPDATE order_items SET unit_price_cents=CAST(ROUND(unit_price*100) AS INTEGER) WHERE unit_price_cents=0 AND unit_price!=0`);
  run(`UPDATE order_items SET line_total_cents=CAST(ROUND(line_total*100) AS INTEGER) WHERE line_total_cents=0 AND line_total!=0`);
  run(`UPDATE order_adjustments SET amount_cents=CAST(ROUND(amount*100) AS INTEGER) WHERE amount_cents=0 AND amount!=0`);
}
backfillMoneyColumns();

// ---------- Seed ----------
function setting(key, fallback = '') { const r = one('SELECT value FROM settings WHERE key=?', key); return r ? r.value : fallback; }
function setSetting(key, value) { run('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', key, String(value), now()); }

function seed() {
  const t = now();
  if (one('SELECT COUNT(*) c FROM territories').c === 0) {
    const vic = id(), kel = id(), pg = id();
    const insT = db.prepare(`INSERT INTO territories(id,name,slug,active,archived,domain,currency,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`);
    insT.run(vic,'Victoria','victoria',1,0,'pouchesvic.com','CAD',t,t);
    insT.run(kel,'Kelowna','kelowna',1,0,'','CAD',t,t);
    insT.run(pg,'Prince George','prince-george',1,0,'','CAD',t,t);

    const insTier = db.prepare(`INSERT INTO pricing_tiers(id,territory_id,min_qty,max_qty,unit_price,unit_price_cents,active,sort_order) VALUES(?,?,?,?,?,?,?,?)`);
    for (const tid of [vic,kel,pg]) [[1,9,1500],[10,19,1350],[20,null,1250]].forEach((x,i)=>insTier.run(id(),tid,x[0],x[1],dollars(x[2]),x[2],1,i));

    const green=id(), orange=id(), pink=id();
    const insZ=db.prepare(`INSERT INTO delivery_zones(id,territory_id,name,color_label,fee,fee_cents,free_at_qty,active,description,rule_notes,geojson,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    insZ.run(green,vic,'Green','Green',10,1000,10,1,'Core Victoria / closest delivery area','Initial Victoria Green rules. Add/edit the actual polygon in Boss Control Room.','',0);
    insZ.run(orange,vic,'Orange','Orange',15,1500,null,1,'Outer Victoria / Westshore and mid-north area','Initial Victoria Orange rules. Add/edit the actual polygon in Boss Control Room.','',1);
    insZ.run(pink,vic,'Pink','Pink',20,2000,null,1,'Farthest regular Victoria delivery area','Initial Victoria Pink rules. Add/edit the actual polygon in Boss Control Room.','',2);
    insZ.run(id(),kel,'Local','Local',0,0,null,1,'Default editable zone','Set Kelowna boundaries/fees in Admin.','',0);
    insZ.run(id(),pg,'Local','Local',0,0,null,1,'Default editable zone','Set Prince George boundaries/fees in Admin.','',0);

    const d1=id(), d2=id();
    const insD=db.prepare(`INSERT INTO drivers(id,territory_id,name,active,archived,role,email,phone,customer_contact_number,notes,pin_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insD.run(d1,vic,'Victoria Driver 1',1,0,'operations_admin','','','','Victoria supervisor/settlement driver','',t,t);
    insD.run(d2,vic,'Victoria Driver 2',1,0,'driver','','','','Victoria subordinate driver','',t,t);
    insD.run(id(),kel,'Kelowna Driver',1,0,'driver','','','','','',t,t);
    insD.run(id(),pg,'Prince George Driver',1,0,'driver','','','','','',t,t);

    const insR=db.prepare(`INSERT INTO settlement_rules(id,territory_id,name,active,archived,rule_type,from_driver_id,to_driver_id,zone_id,amount,amount_cents,notes,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insR.run(id(),vic,'Driver 2 pays Driver 1 per can',1,0,'per_can_driver_to_driver',d2,d1,null,10,1000,'Driver 2 pays Driver 1 $10 for every can sold.',0,t,t);
    insR.run(id(),vic,'Driver 1 pays Boss per can',1,0,'per_can_driver_to_boss',d1,null,null,9,900,'Boss settles weekly only with Driver 1. Editable.',1,t,t);
    insR.run(id(),vic,'Driver 2 Orange fee share to Driver 1',1,0,'zone_fee_driver_to_driver',d2,d1,orange,5,500,'On Driver 2 Orange deliveries, $5 of charged fee is owed to Driver 1.',2,t,t);
    insR.run(id(),vic,'Driver 2 Pink fee share to Driver 1',1,0,'zone_fee_driver_to_driver',d2,d1,pink,5,500,'On Driver 2 Pink deliveries, $5 of charged fee is owed to Driver 1.',3,t,t);
    insR.run(id(),vic,'Green fee goes to Driver 1',1,0,'zone_fee_to_driver',null,d1,green,0,0,'Amount 0 means use the actual charged delivery fee.',4,t,t);
  }

  const defaults = {
    round_down_to_cents: '500',
    settlement_round_nearest_cents: '500',
    shipping_enabled: 'false',
    payment_cash_enabled: 'true',
    payment_etransfer_enabled: 'true',
    payment_card_enabled: 'false',
    payment_paypal_enabled: 'false',
    mapbox_public_token: '',
    order_email_enabled: 'true',
    customer_discount_label: 'Customer Appreciation Discount',
    age_acknowledgement_text: 'I confirm that I meet the legal age requirement for this purchase.',
    store_support_email: '',
    store_support_phone: ''
  };
  for (const [k,v] of Object.entries(defaults)) if (!one('SELECT 1 FROM settings WHERE key=?',k)) setSetting(k,v);
  if (!one("SELECT 1 FROM counters WHERE key='order_no'")) run("INSERT INTO counters(key,value) VALUES('order_no',1000)");
}
seed();

// ---------- Session helpers ----------
const adminSessions = new Map();
const driverSessions = new Map();
function pruneSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [k,v] of adminSessions) if (v.created < cutoff) adminSessions.delete(k);
  for (const [k,v] of driverSessions) if (v.created < cutoff) driverSessions.delete(k);
}
setInterval(pruneSessions, 15 * 60 * 1000).unref();
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i=p.indexOf('='); if(i>-1) out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim()); });
  return out;
}
function adminSession(req) { const tok=parseCookies(req).pv_session; return tok && adminSessions.get(tok); }
function driverSession(req) { const tok=parseCookies(req).pv_driver_session; return tok && driverSessions.get(tok); }
function requireAdmin(req,res) { if(!adminSession(req)){ send(res,401,{error:'Unauthorized'}); return false; } return true; }
function requireDriver(req,res) { const s=driverSession(req); if(!s){ send(res,401,{error:'Driver login required'}); return null; } return s; }

// ---------- HTTP helpers ----------
function send(res,status,body,type='application/json; charset=utf-8',headers={}) {
  res.writeHead(status,{ 'Content-Type':type, 'X-Content-Type-Options':'nosniff', ...headers });
  if (Buffer.isBuffer(body)) return res.end(body);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function bodyJson(req) {
  return new Promise((resolve,reject)=>{
    let d='';
    req.on('data',c=>{ d+=c; if(d.length>3_000_000){ reject(new Error('Request too large')); req.destroy(); } });
    req.on('end',()=>{ try { resolve(d?JSON.parse(d):{}); } catch(e){ reject(new Error('Invalid JSON')); } });
    req.on('error',reject);
  });
}
function serve(res,file) {
  const p=path.join(__dirname,file);
  if(!fs.existsSync(p)) return send(res,404,'Not found','text/plain; charset=utf-8');
  send(res,200,fs.readFileSync(p),'text/html; charset=utf-8',{'Cache-Control':'no-store'});
}
function publicTerritory(slug) { return one('SELECT * FROM territories WHERE slug=? AND active=1 AND archived=0',slug); }
function nextOrderNo() {
  return db.transaction(()=>{
    const r=one("SELECT value FROM counters WHERE key='order_no'");
    const n=(r?.value||1000)+1;
    run("INSERT OR REPLACE INTO counters(key,value) VALUES('order_no',?)",n);
    return n;
  })();
}

// ---------- Geography ----------
function pointInRing(point, ring) {
  const [x,y]=point; let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const xi=Number(ring[i][0]), yi=Number(ring[i][1]);
    const xj=Number(ring[j][0]), yj=Number(ring[j][1]);
    const intersects=((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||Number.EPSILON)+xi);
    if(intersects) inside=!inside;
  }
  return inside;
}
function pointInPolygon(point, polygon) {
  if(!Array.isArray(polygon)||!polygon.length) return false;
  if(!pointInRing(point,polygon[0])) return false;
  for(let i=1;i<polygon.length;i++) if(pointInRing(point,polygon[i])) return false;
  return true;
}
function pointInGeoJSON(lng,lat,geojsonText) {
  const g=typeof geojsonText==='string'?safeJson(geojsonText):geojsonText;
  if(!g) return false;
  let geom=g.type==='Feature'?g.geometry:g;
  if(!geom) return false;
  const p=[Number(lng),Number(lat)];
  if(geom.type==='Polygon') return pointInPolygon(p,geom.coordinates);
  if(geom.type==='MultiPolygon') return geom.coordinates.some(poly=>pointInPolygon(p,poly));
  return false;
}
function detectZone(tid,lng,lat) {
  if(!Number.isFinite(Number(lng))||!Number.isFinite(Number(lat))) return null;
  const zones=all('SELECT * FROM delivery_zones WHERE territory_id=? AND active=1 ORDER BY sort_order,name',tid);
  return zones.find(z=>text(z.geojson) && pointInGeoJSON(Number(lng),Number(lat),z.geojson)) || null;
}

// ---------- Inventory ----------
function ensureTerritoryProduct(tid,pid) {
  let r=one('SELECT * FROM territory_products WHERE territory_id=? AND product_id=?',tid,pid);
  if(!r){
    const t=now();
    run(`INSERT INTO territory_products(id,territory_id,product_id,inventory,listed,featured,local_price_override,local_price_override_cents,sort_order,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,id(),tid,pid,0,0,0,null,null,0,t);
    r=one('SELECT * FROM territory_products WHERE territory_id=? AND product_id=?',tid,pid);
  }
  return r;
}
function applyInventoryMovement({territory_id,product_id,qty_delta,movement_type,order_id=null,driver_id=null,note='',created_by_role='system',created_by_driver_id=null}) {
  const row=ensureTerritoryProduct(territory_id,product_id);
  const next=row.inventory+int(qty_delta);
  if(next<0) throw new Error('Not enough inventory');
  const t=now();
  run('UPDATE territory_products SET inventory=?,updated_at=? WHERE territory_id=? AND product_id=?',next,t,territory_id,product_id);
  run(`INSERT INTO inventory_movements(id,territory_id,product_id,order_id,driver_id,movement_type,qty_delta,balance_after,note,created_by_role,created_by_driver_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id(),territory_id,product_id,order_id,driver_id,movement_type,int(qty_delta),next,text(note),created_by_role,created_by_driver_id,t);
  return next;
}

// ---------- Pricing / order math ----------
function priceFor(tiers,qty) {
  const tier=tiers.find(x=>qty>=x.min_qty && (x.max_qty==null || qty<=x.max_qty)) || tiers[tiers.length-1];
  return tier ? int(tier.unit_price_cents ?? cents(tier.unit_price)) : 0;
}
function calculateOrder({territory,items,zone,delivery_fee_override_cents=null}) {
  const tiers=all('SELECT * FROM pricing_tiers WHERE territory_id=? AND active=1 ORDER BY sort_order,min_qty',territory.id);
  const qty=items.reduce((s,x)=>s+x.q,0);
  const defaultUnit=priceFor(tiers,qty);
  let subtotal=0;
  for(const x of items){
    const override=x.p.local_price_override_cents!=null ? int(x.p.local_price_override_cents) : (x.p.local_price_override!=null ? cents(x.p.local_price_override) : null);
    x.unit_cents=override!=null ? override : defaultUnit;
    x.line_cents=x.unit_cents*x.q;
    subtotal+=x.line_cents;
  }
  let delivery=zone ? int(zone.fee_cents ?? cents(zone.fee)) : 0;
  if(zone && zone.free_at_qty!=null && qty>=zone.free_at_qty) delivery=0;
  if(delivery_fee_override_cents!=null) delivery=Math.max(0,int(delivery_fee_override_cents));
  const pre=subtotal+delivery;
  const roundStep=int(setting('round_down_to_cents','500'),500);
  const total=roundDown(pre,roundStep);
  const discount=Math.max(0,pre-total);
  return {qty,subtotal_cents:subtotal,delivery_fee_cents:delivery,pre_discount_total_cents:pre,customer_discount_cents:discount,total_cents:total};
}
function resolveCart(territory,cart,{allow_unlisted=false}={}) {
  const out=[];
  for(const x of Array.isArray(cart)?cart:[]){
    const q=clampInt(x.qty);
    if(!q) continue;
    const p=one(`SELECT p.id,p.brand,p.flavor,p.strength,p.active,p.archived,tp.inventory,tp.listed,tp.local_price_override,tp.local_price_override_cents
      FROM products p LEFT JOIN territory_products tp ON tp.product_id=p.id AND tp.territory_id=?
      WHERE p.id=?`,territory.id,text(x.product_id));
    if(!p || !p.active || p.archived) throw new Error('A product is no longer available');
    if(!allow_unlisted && !p.listed) throw new Error(`${p.brand} ${p.flavor} is not currently listed`);
    if(int(p.inventory)<q) throw new Error(`${p.brand} ${p.flavor} has only ${int(p.inventory)} available`);
    out.push({p,q});
  }
  if(!out.length) throw new Error('Order is empty');
  return out;
}
function addOrderEvent(order_id,event_type,message,data={},opts={}) {
  run(`INSERT INTO order_events(id,order_id,event_type,message,data_json,attention,reviewed,pinned,visible_to_customer,created_by_role,created_by_driver_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id(),order_id,event_type,text(message),jsonText(data),bool(opts.attention),bool(opts.reviewed),bool(opts.pinned),bool(opts.visible_to_customer),opts.created_by_role||'system',opts.created_by_driver_id||null,now());
}
function insertPayment({order_id=null,territory_id,driver_id=null,method='cash',amount_cents=0,destination_type='driver',destination_driver_id=null,status='received',note='',created_by_role='admin',created_by_driver_id=null}) {
  if(!int(amount_cents)) return null;
  const pid=id();
  run(`INSERT INTO payments(id,order_id,territory_id,driver_id,method,amount_cents,destination_type,destination_driver_id,status,note,created_by_role,created_by_driver_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    pid,order_id,territory_id,driver_id,text(method)||'cash',int(amount_cents),text(destination_type)||'driver',destination_driver_id||null,text(status)||'received',text(note),created_by_role,created_by_driver_id,now());
  return pid;
}

function createOrderCore(b,{source='web',created_by_role='customer',created_by_driver_id=null,allow_unlisted=false,auto_complete=false}={}) {
  const territory=publicTerritory(text(b.territory_slug)||'victoria') || one('SELECT * FROM territories WHERE id=? AND active=1 AND archived=0',text(b.territory_id));
  if(!territory) throw new Error('Territory unavailable');
  const items=resolveCart(territory,b.items,{allow_unlisted});

  let zone=null;
  if(b.zone_id) zone=one('SELECT * FROM delivery_zones WHERE id=? AND territory_id=? AND active=1',text(b.zone_id),territory.id);
  if(!zone && b.address_lng!=null && b.address_lat!=null) zone=detectZone(territory.id,num(b.address_lng),num(b.address_lat));
  const deliveryOverride=b.delivery_fee_cents!=null?int(b.delivery_fee_cents):(b.delivery_fee!=null?cents(b.delivery_fee):null);
  const math=calculateOrder({territory,items,zone,delivery_fee_override_cents:deliveryOverride});
  const oid=id(), ono=nextOrderNo(), created=now(), ctoken=token(20);
  const status=auto_complete?'completed':(text(b.status)||'new');
  const completed=status==='completed'?created:null;

  const tx=db.transaction(()=>{
    run(`INSERT INTO orders(id,order_no,territory_id,source,status,customer_token,customer_name,customer_phone,customer_email,address,address_lat,address_lng,delivery_notes,delivery_window_id,delivery_window_label,zone_id,zone_name_snapshot,zone_fee_snapshot,zone_fee_snapshot_cents,zone_fee_override,zone_fee_override_cents,zone_override_note,assigned_driver_id,created_by_driver_id,created_by_role,payment_method,payment_note,subtotal,subtotal_cents,delivery_fee,delivery_fee_cents,pre_discount_total_cents,customer_discount_cents,total,total_cents,rounding_adjustment,inventory_applied,confirmation_email_status,created_at,updated_at,completed_at,cancelled_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      oid,ono,territory.id,source,status,ctoken,text(b.customer_name),normalizePhone(b.customer_phone),text(b.customer_email),text(b.address),b.address_lat==null?null:num(b.address_lat),b.address_lng==null?null:num(b.address_lng),text(b.delivery_notes),b.delivery_window_id||null,text(b.delivery_window_label),zone?.id||null,zone?.name||'',dollars(zone?int(zone.fee_cents??cents(zone.fee)):0),zone?int(zone.fee_cents??cents(zone.fee)):0,deliveryOverride==null?null:dollars(deliveryOverride),deliveryOverride,text(b.zone_override_note),b.assigned_driver_id||created_by_driver_id||null,created_by_driver_id,created_by_role,text(b.payment_method),text(b.payment_note),dollars(math.subtotal_cents),math.subtotal_cents,dollars(math.delivery_fee_cents),math.delivery_fee_cents,math.pre_discount_total_cents,math.customer_discount_cents,dollars(math.total_cents),math.total_cents,dollars(math.total_cents-math.pre_discount_total_cents),1,'',created,created,completed,null);

    for(const x of items){
      run(`INSERT INTO order_items(id,order_id,product_id,product_name_snapshot,brand_snapshot,strength_snapshot,qty,unit_price,unit_price_cents,line_total,line_total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        id(),oid,x.p.id,x.p.flavor,x.p.brand,x.p.strength,x.q,dollars(x.unit_cents),x.unit_cents,dollars(x.line_cents),x.line_cents);
      applyInventoryMovement({territory_id:territory.id,product_id:x.p.id,qty_delta:-x.q,movement_type:source==='web'?'web_sale':source,order_id:oid,driver_id:b.assigned_driver_id||created_by_driver_id||null,note:`Order #${ono}`,created_by_role,created_by_driver_id});
    }

    const paymentAmount=b.payment_amount_cents!=null?int(b.payment_amount_cents):(b.payment_amount!=null?cents(b.payment_amount):0);
    if(paymentAmount){
      insertPayment({order_id:oid,territory_id:territory.id,driver_id:b.assigned_driver_id||created_by_driver_id||null,method:b.payment_method||'cash',amount_cents:paymentAmount,destination_type:b.payment_destination||'driver',destination_driver_id:b.payment_destination_driver_id||null,status:b.payment_status||'received',note:b.payment_note||'',created_by_role,created_by_driver_id});
    }

    addOrderEvent(oid,'order_created',`Order #${ono} created`,{source,qty:math.qty,total_cents:math.total_cents},{created_by_role,created_by_driver_id,visible_to_customer:source==='web'});
    if(math.customer_discount_cents>0) addOrderEvent(oid,'customer_appreciation_discount',`${setting('customer_discount_label','Customer Appreciation Discount')}: ${money(math.customer_discount_cents)}`,{discount_cents:math.customer_discount_cents},{created_by_role:'system',visible_to_customer:true});
  });
  tx();
  if(status==='completed') snapshotSettlementForOrder(oid);
  return orderFull(oid);
}

function cancelOrder(oid,{role='admin',driver_id=null,note=''}={}) {
  const o=one('SELECT * FROM orders WHERE id=?',oid);
  if(!o) throw new Error('Order not found');
  if(o.status==='cancelled') return orderFull(oid);
  const items=all('SELECT * FROM order_items WHERE order_id=?',oid);
  db.transaction(()=>{
    if(o.inventory_applied){
      for(const it of items) if(it.product_id) applyInventoryMovement({territory_id:o.territory_id,product_id:it.product_id,qty_delta:it.qty,movement_type:'order_cancel_return',order_id:oid,driver_id:o.assigned_driver_id,note:`Cancelled order #${o.order_no}`,created_by_role:role,created_by_driver_id:driver_id});
    }
    run(`UPDATE orders SET status='cancelled',inventory_applied=0,cancelled_at=?,completed_at=NULL,updated_at=? WHERE id=?`,now(),now(),oid);
    run('DELETE FROM settlement_entries WHERE order_id=?',oid);
    addOrderEvent(oid,'cancelled',note||'Order cancelled',{}, {attention:1,created_by_role:role,created_by_driver_id:driver_id,visible_to_customer:true});
  })();
  return orderFull(oid);
}

// ---------- Settlement engine ----------
function orderQty(oid) { return int(one('SELECT COALESCE(SUM(qty),0) q FROM order_items WHERE order_id=?',oid)?.q); }
function snapshotSettlementForOrder(oid) {
  const o=one('SELECT * FROM orders WHERE id=?',oid);
  if(!o || o.status!=='completed' || !o.assigned_driver_id) return;
  const qty=orderQty(oid);
  const rules=all('SELECT * FROM settlement_rules WHERE territory_id=? AND active=1 AND archived=0 ORDER BY sort_order',o.territory_id);
  db.transaction(()=>{
    run('DELETE FROM settlement_entries WHERE order_id=?',oid);
    for(const r of rules){
      let amount=0, targetType='', targetDriver=null, entryType='';
      const rate=int(r.amount_cents??cents(r.amount));
      if(r.rule_type==='per_can_driver_to_boss' && r.from_driver_id===o.assigned_driver_id){ amount=qty*rate; targetType='boss'; entryType='per_can_to_boss'; }
      else if(r.rule_type==='per_can_driver_to_driver' && r.from_driver_id===o.assigned_driver_id){ amount=qty*rate; targetType='driver'; targetDriver=r.to_driver_id; entryType='per_can_to_driver'; }
      else if(r.rule_type==='zone_fee_driver_to_driver' && r.from_driver_id===o.assigned_driver_id && r.zone_id===o.zone_id){ amount=Math.min(rate,int(o.delivery_fee_cents)); targetType='driver'; targetDriver=r.to_driver_id; entryType='zone_fee_to_driver'; }
      else if(r.rule_type==='zone_fee_to_driver' && r.zone_id===o.zone_id && r.to_driver_id){ amount=rate===0?int(o.delivery_fee_cents):Math.min(rate,int(o.delivery_fee_cents)); targetType='driver'; targetDriver=r.to_driver_id; entryType='zone_fee_to_driver'; }
      if(amount>0){
        run(`INSERT OR IGNORE INTO settlement_entries(id,order_id,territory_id,source_driver_id,target_type,target_driver_id,entry_type,qty,rate_cents,amount_cents,rule_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
          id(),oid,o.territory_id,o.assigned_driver_id,targetType,targetDriver,entryType,qty,rate,amount,r.name,now());
      }
    }
  })();
}
function settlementRange(weekStart) {
  const ws=weekStart?new Date(`${weekStart}T00:00:00.000Z`):weekStartMonday();
  return {start:isoDate(ws),end:isoDate(addDays(ws,6)),startIso:ws.toISOString(),endExclusive:addDays(ws,7).toISOString()};
}
function weeklySettlement(tid,driverId,weekStart) {
  const range=settlementRange(weekStart);
  const closed=one('SELECT * FROM weekly_settlements WHERE territory_id=? AND driver_id=? AND week_start=?',tid,driverId,range.start);
  if(closed?.status==='closed') return {...safeJson(closed.snapshot_json,{}),closed:true,settlement_id:closed.id};

  const orders=all(`SELECT * FROM orders WHERE territory_id=? AND assigned_driver_id=? AND status='completed' AND completed_at>=? AND completed_at<? ORDER BY completed_at`,tid,driverId,range.startIso,range.endExclusive);
  for(const o of orders) if(!one('SELECT 1 FROM settlement_entries WHERE order_id=? LIMIT 1',o.id)) snapshotSettlementForOrder(o.id);
  const orderIds=orders.map(o=>o.id);
  const placeholders=orderIds.map(()=>'?').join(',');
  let cans=0, orderSales=0, driverCollected=0, bossDirect=0;
  for(const o of orders){ cans+=orderQty(o.id); orderSales+=int(o.total_cents); }
  const pays=orderIds.length?all(`SELECT * FROM payments WHERE order_id IN (${placeholders}) AND status='received'`,...orderIds):[];
  for(const p of pays){ if(p.destination_type==='boss') bossDirect+=int(p.amount_cents); else if(p.destination_type==='driver' && (!p.destination_driver_id || p.destination_driver_id===driverId)) driverCollected+=int(p.amount_cents); }
  const entries=orderIds.length?all(`SELECT * FROM settlement_entries WHERE order_id IN (${placeholders}) AND source_driver_id=?`,...orderIds,driverId):[];
  const bossDue=entries.filter(x=>x.target_type==='boss').reduce((s,x)=>s+int(x.amount_cents),0);
  const owesDrivers=entries.filter(x=>x.target_type==='driver').reduce((s,x)=>s+int(x.amount_cents),0);
  const adjustments=all('SELECT * FROM settlement_adjustments WHERE territory_id=? AND driver_id=? AND week_start=? ORDER BY created_at',tid,driverId,range.start);
  let bossAdjustment=0;
  for(const a of adjustments){
    if(a.direction==='boss_credit') bossAdjustment-=int(a.amount_cents);
    else if(a.direction==='boss_charge') bossAdjustment+=int(a.amount_cents);
  }
  const exactSendToBoss=Math.max(0,bossDue-bossDirect+bossAdjustment);
  const roundStep=int(setting('settlement_round_nearest_cents','500'),500);
  const roundedSendToBoss=roundNearest(exactSendToBoss,roundStep);
  const settlementRounding=roundedSendToBoss-exactSendToBoss;
  const driverKeeps=driverCollected-roundedSendToBoss-owesDrivers;
  return {
    closed:false,
    territory_id:tid,driver_id:driverId,week_start:range.start,week_end:range.end,
    cans,order_count:orders.length,order_sales_cents:orderSales,driver_collected_cents:driverCollected,boss_direct_cents:bossDirect,
    boss_due_cents:bossDue,owes_other_drivers_cents:owesDrivers,boss_adjustment_cents:bossAdjustment,
    exact_send_to_boss_cents:exactSendToBoss,rounded_send_to_boss_cents:roundedSendToBoss,settlement_rounding_cents:settlementRounding,driver_keeps_cents:driverKeeps,
    orders:orders.map(o=>({id:o.id,order_no:o.order_no,source:o.source,total_cents:o.total_cents,completed_at:o.completed_at,customer_name:o.customer_name})),
    payments:pays,entries,adjustments
  };
}
function closeWeeklySettlement(tid,driverId,weekStart) {
  const snap=weeklySettlement(tid,driverId,weekStart);
  if(snap.closed) return snap;
  const sid=id(),t=now();
  run(`INSERT INTO weekly_settlements(id,territory_id,driver_id,week_start,week_end,status,exact_send_to_boss_cents,rounded_send_to_boss_cents,settlement_rounding_cents,driver_keeps_cents,snapshot_json,closed_at,created_at,updated_at)
    VALUES(?,?,?,?,?,'closed',?,?,?,?,?,?,?,?) ON CONFLICT(territory_id,driver_id,week_start) DO UPDATE SET status='closed',week_end=excluded.week_end,exact_send_to_boss_cents=excluded.exact_send_to_boss_cents,rounded_send_to_boss_cents=excluded.rounded_send_to_boss_cents,settlement_rounding_cents=excluded.settlement_rounding_cents,driver_keeps_cents=excluded.driver_keeps_cents,snapshot_json=excluded.snapshot_json,closed_at=excluded.closed_at,updated_at=excluded.updated_at`,
    sid,tid,driverId,snap.week_start,snap.week_end,snap.exact_send_to_boss_cents,snap.rounded_send_to_boss_cents,snap.settlement_rounding_cents,snap.driver_keeps_cents,jsonText({...snap,closed:true}),t,t,t);
  return {...snap,closed:true};
}

// ---------- Email ----------
function orderStatusUrl(o){ return `${PUBLIC_BASE_URL}/order/${encodeURIComponent(o.customer_token)}`; }
function smsHref(number,message=''){ const n=text(number).replace(/[^+\d]/g,''); return n?`sms:${n}${message?`?&body=${encodeURIComponent(message)}`:''}`:''; }
function orderConfirmationHtml(o) {
  const items=o.items.map(x=>`<tr><td style="padding:6px 0">${htmlEscape(x.brand_snapshot)} ${htmlEscape(x.product_name_snapshot)} ${htmlEscape(x.strength_snapshot)}</td><td style="text-align:center">${x.qty}</td><td style="text-align:right">${money(x.line_total_cents)}</td></tr>`).join('');
  const discount=o.customer_discount_cents>0?`<tr><td colspan="2" style="padding-top:8px">${htmlEscape(setting('customer_discount_label','Customer Appreciation Discount'))}</td><td style="text-align:right;padding-top:8px">-${money(o.customer_discount_cents)}</td></tr>`:'';
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#171717"><h2>Order #${o.order_no} confirmed</h2><p>Thanks${o.customer_name?`, ${htmlEscape(o.customer_name)}`:''}. We received your order.</p><table style="width:100%;max-width:560px;border-collapse:collapse">${items}<tr><td colspan="2" style="padding-top:12px">Subtotal</td><td style="text-align:right;padding-top:12px">${money(o.subtotal_cents)}</td></tr><tr><td colspan="2">Delivery</td><td style="text-align:right">${money(o.delivery_fee_cents)}</td></tr>${discount}<tr><td colspan="2" style="font-weight:bold;padding-top:8px">TOTAL</td><td style="font-weight:bold;text-align:right;padding-top:8px">${money(o.total_cents)}</td></tr></table><p><strong>Delivery address:</strong> ${htmlEscape(o.address||'Not provided')}</p><p><a href="${orderStatusUrl(o)}">View your live order / contact your driver</a></p><p style="font-size:12px;color:#666">If a driver has not been assigned yet, their contact button will appear on your live order page once assigned.</p></body></html>`;
}
async function sendOrderConfirmation(oid) {
  const o=orderFull(oid);
  if(!o || !text(o.customer_email)) return {skipped:true,reason:'No customer email'};
  if(setting('order_email_enabled','true')!=='true') return {skipped:true,reason:'Email disabled'};
  if(!RESEND_API_KEY || !ORDER_EMAIL_FROM) return {skipped:true,reason:'Email service not configured'};
  try{
    const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:ORDER_EMAIL_FROM,to:[o.customer_email],subject:`PouchesVic order #${o.order_no} confirmed`,html:orderConfirmationHtml(o),...(ORDER_EMAIL_REPLY_TO?{reply_to:ORDER_EMAIL_REPLY_TO}:{})})});
    const body=await r.text();
    if(!r.ok) throw new Error(`Email provider ${r.status}: ${body.slice(0,300)}`);
    run("UPDATE orders SET confirmation_email_status='sent',updated_at=? WHERE id=?",now(),oid);
    addOrderEvent(oid,'confirmation_email','Order confirmation email sent',{}, {created_by_role:'system'});
    return {ok:true};
  }catch(e){
    run("UPDATE orders SET confirmation_email_status='failed',updated_at=? WHERE id=?",now(),oid);
    addOrderEvent(oid,'confirmation_email_failed',e.message,{}, {attention:1,created_by_role:'system'});
    return {ok:false,error:e.message};
  }
}

// ---------- Read models ----------
function territorySnapshot(tid) {
  const territory=one('SELECT * FROM territories WHERE id=? AND active=1 AND archived=0',tid);
  if(!territory) return null;
  const tiers=all('SELECT id,min_qty,max_qty,COALESCE(unit_price_cents,CAST(ROUND(unit_price*100) AS INTEGER)) unit_price_cents,active,sort_order FROM pricing_tiers WHERE territory_id=? AND active=1 ORDER BY sort_order,min_qty',tid);
  const zones=all('SELECT id,name,color_label,COALESCE(fee_cents,CAST(ROUND(fee*100) AS INTEGER)) fee_cents,free_at_qty,description,geojson,sort_order FROM delivery_zones WHERE territory_id=? AND active=1 ORDER BY sort_order,name',tid);
  const products=all(`SELECT p.id,p.brand,p.flavor,p.strength,p.image,tp.inventory,tp.listed,tp.featured,tp.local_price_override_cents,tp.sort_order
    FROM territory_products tp JOIN products p ON p.id=tp.product_id
    WHERE tp.territory_id=? AND tp.listed=1 AND p.active=1 AND p.archived=0 AND tp.inventory>0
    ORDER BY tp.featured DESC,tp.sort_order,p.brand,p.flavor`,tid);
  const windows=all('SELECT id,label,start_time,end_time,days_json,capacity,sort_order FROM delivery_windows WHERE territory_id=? AND active=1 ORDER BY sort_order,start_time',tid);
  return {territory,tiers,zones,products,windows,settings:{mapbox_public_token:setting('mapbox_public_token',''),payment_cash_enabled:setting('payment_cash_enabled','true')==='true',payment_etransfer_enabled:setting('payment_etransfer_enabled','true')==='true',customer_discount_label:setting('customer_discount_label','Customer Appreciation Discount'),age_acknowledgement_text:setting('age_acknowledgement_text','')}};
}
function adminBootstrap() {
  return {territories:all('SELECT * FROM territories ORDER BY archived,name'),settings:Object.fromEntries(all('SELECT key,value FROM settings').map(x=>[x.key,x.value]))};
}
function territoryAdmin(tid) {
  const territory=one('SELECT * FROM territories WHERE id=?',tid); if(!territory) return null;
  return {
    territory,
    tiers:all('SELECT *,COALESCE(unit_price_cents,CAST(ROUND(unit_price*100) AS INTEGER)) resolved_unit_price_cents FROM pricing_tiers WHERE territory_id=? ORDER BY active DESC,sort_order,min_qty',tid),
    zones:all('SELECT *,COALESCE(fee_cents,CAST(ROUND(fee*100) AS INTEGER)) resolved_fee_cents FROM delivery_zones WHERE territory_id=? ORDER BY active DESC,sort_order,name',tid),
    drivers:all('SELECT * FROM drivers WHERE territory_id=? ORDER BY archived,active DESC,name',tid),
    rules:all(`SELECT r.*,fd.name from_driver_name,td.name to_driver_name,z.name zone_name FROM settlement_rules r LEFT JOIN drivers fd ON fd.id=r.from_driver_id LEFT JOIN drivers td ON td.id=r.to_driver_id LEFT JOIN delivery_zones z ON z.id=r.zone_id WHERE r.territory_id=? ORDER BY r.archived,r.sort_order,r.name`,tid),
    products:all(`SELECT p.*,tp.id territory_product_id,tp.inventory,tp.listed,tp.featured,tp.local_price_override,tp.local_price_override_cents,tp.sort_order FROM products p LEFT JOIN territory_products tp ON tp.product_id=p.id AND tp.territory_id=? ORDER BY p.archived,p.brand,p.flavor`,tid),
    windows:all('SELECT * FROM delivery_windows WHERE territory_id=? ORDER BY active DESC,sort_order,start_time',tid),
    orders:all(`SELECT o.*,d.name driver_name,(SELECT COALESCE(SUM(qty),0) FROM order_items i WHERE i.order_id=o.id) cans,(SELECT COUNT(*) FROM order_events e WHERE e.order_id=o.id AND e.attention=1 AND e.reviewed=0) attention_count FROM orders o LEFT JOIN drivers d ON d.id=o.assigned_driver_id WHERE o.territory_id=? ORDER BY o.created_at DESC LIMIT 300`,tid),
    inventory:all(`SELECT p.id product_id,p.brand,p.flavor,p.strength,p.image,p.archived,tp.inventory,tp.listed,tp.featured,tp.updated_at FROM products p LEFT JOIN territory_products tp ON tp.product_id=p.id AND tp.territory_id=? ORDER BY p.archived,p.brand,p.flavor`,tid)
  };
}
function orderFull(oid) {
  const order=one(`SELECT o.*,t.name territory_name,d.name driver_name,d.customer_contact_number FROM orders o JOIN territories t ON t.id=o.territory_id LEFT JOIN drivers d ON d.id=o.assigned_driver_id WHERE o.id=?`,oid);
  if(!order)return null;
  return {...order,items:all('SELECT * FROM order_items WHERE order_id=?',oid),payments:all('SELECT * FROM payments WHERE order_id=? ORDER BY created_at',oid),events:all('SELECT * FROM order_events WHERE order_id=? ORDER BY created_at',oid),adjustments:all('SELECT * FROM order_adjustments WHERE order_id=? ORDER BY created_at',oid)};
}
function publicOrderByToken(tok) {
  const o=one(`SELECT o.id,o.order_no,o.status,o.customer_token,o.customer_name,o.address,o.delivery_notes,o.delivery_window_label,o.zone_name_snapshot,o.subtotal_cents,o.delivery_fee_cents,o.customer_discount_cents,o.total_cents,o.created_at,o.completed_at,d.name driver_name,d.customer_contact_number FROM orders o LEFT JOIN drivers d ON d.id=o.assigned_driver_id WHERE o.customer_token=?`,tok);
  if(!o)return null;
  const items=all('SELECT product_name_snapshot,brand_snapshot,strength_snapshot,qty,line_total_cents FROM order_items WHERE order_id=?',o.id);
  const events=all('SELECT event_type,message,created_at FROM order_events WHERE order_id=? AND visible_to_customer=1 ORDER BY created_at',o.id);
  const msg=`Hi, this is ${o.customer_name||'a customer'} regarding PouchesVic order #${o.order_no}. I need to make a change or ask a question about my current order.`;
  return {...o,items,events,text_driver_href:o.customer_contact_number?smsHref(o.customer_contact_number,msg):''};
}

// ---------- Admin save helpers ----------
function saveTerritoryEntity(kind,tid,b) {
  const t=now();
  if(kind==='tier'){
    const priceC=b.unit_price_cents!=null?int(b.unit_price_cents):cents(b.unit_price);
    if(b.id) run(`UPDATE pricing_tiers SET min_qty=?,max_qty=?,unit_price=?,unit_price_cents=?,active=?,sort_order=? WHERE id=? AND territory_id=?`,int(b.min_qty),b.max_qty===''||b.max_qty==null?null:int(b.max_qty),dollars(priceC),priceC,bool(b.active),int(b.sort_order),b.id,tid);
    else run(`INSERT INTO pricing_tiers(id,territory_id,min_qty,max_qty,unit_price,unit_price_cents,active,sort_order) VALUES(?,?,?,?,?,?,?,?)`,id(),tid,int(b.min_qty),b.max_qty===''||b.max_qty==null?null:int(b.max_qty),dollars(priceC),priceC,bool(b.active??true),int(b.sort_order));
  }
  if(kind==='zone'){
    const feeC=b.fee_cents!=null?int(b.fee_cents):cents(b.fee);
    const geo=typeof b.geojson==='object'?jsonText(b.geojson):text(b.geojson);
    if(b.id) run(`UPDATE delivery_zones SET name=?,color_label=?,fee=?,fee_cents=?,free_at_qty=?,active=?,description=?,rule_notes=?,geojson=?,sort_order=? WHERE id=? AND territory_id=?`,text(b.name),text(b.color_label),dollars(feeC),feeC,b.free_at_qty===''||b.free_at_qty==null?null:int(b.free_at_qty),bool(b.active),text(b.description),text(b.rule_notes),geo,int(b.sort_order),b.id,tid);
    else run(`INSERT INTO delivery_zones(id,territory_id,name,color_label,fee,fee_cents,free_at_qty,active,description,rule_notes,geojson,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,id(),tid,text(b.name),text(b.color_label),dollars(feeC),feeC,b.free_at_qty===''||b.free_at_qty==null?null:int(b.free_at_qty),bool(b.active??true),text(b.description),text(b.rule_notes),geo,int(b.sort_order));
  }
  if(kind==='driver'){
    if(b.id){
      const pinClause=text(b.pin)?',pin_hash=?':'';
      const args=[text(b.name),bool(b.active),text(b.role)||'driver',text(b.email),normalizePhone(b.phone),normalizePhone(b.customer_contact_number),text(b.notes),t];
      if(text(b.pin))args.push(hashPin(b.pin)); args.push(b.id,tid);
      run(`UPDATE drivers SET name=?,active=?,role=?,email=?,phone=?,customer_contact_number=?,notes=?,updated_at=?${pinClause} WHERE id=? AND territory_id=?`,...args);
    } else run(`INSERT INTO drivers(id,territory_id,name,active,archived,role,email,phone,customer_contact_number,notes,pin_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,id(),tid,text(b.name),bool(b.active??true),0,text(b.role)||'driver',text(b.email),normalizePhone(b.phone),normalizePhone(b.customer_contact_number),text(b.notes),text(b.pin)?hashPin(b.pin):'',t,t);
  }
  if(kind==='rule'){
    const amountC=b.amount_cents!=null?int(b.amount_cents):cents(b.amount);
    if(b.id) run(`UPDATE settlement_rules SET name=?,active=?,rule_type=?,from_driver_id=?,to_driver_id=?,zone_id=?,amount=?,amount_cents=?,notes=?,sort_order=?,updated_at=? WHERE id=? AND territory_id=?`,text(b.name),bool(b.active),text(b.rule_type),b.from_driver_id||null,b.to_driver_id||null,b.zone_id||null,dollars(amountC),amountC,text(b.notes),int(b.sort_order),t,b.id,tid);
    else run(`INSERT INTO settlement_rules(id,territory_id,name,active,archived,rule_type,from_driver_id,to_driver_id,zone_id,amount,amount_cents,notes,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,id(),tid,text(b.name),bool(b.active??true),0,text(b.rule_type),b.from_driver_id||null,b.to_driver_id||null,b.zone_id||null,dollars(amountC),amountC,text(b.notes),int(b.sort_order),t,t);
  }
  if(kind==='window'){
    if(b.id) run(`UPDATE delivery_windows SET label=?,start_time=?,end_time=?,days_json=?,active=?,capacity=?,sort_order=?,updated_at=? WHERE id=? AND territory_id=?`,text(b.label),text(b.start_time),text(b.end_time),jsonText(Array.isArray(b.days)?b.days:safeJson(b.days_json,[1,2,3,4,5,6,0])),bool(b.active),b.capacity==null||b.capacity===''?null:int(b.capacity),int(b.sort_order),t,b.id,tid);
    else run(`INSERT INTO delivery_windows(id,territory_id,label,start_time,end_time,days_json,active,capacity,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,id(),tid,text(b.label),text(b.start_time),text(b.end_time),jsonText(Array.isArray(b.days)?b.days:[1,2,3,4,5,6,0]),bool(b.active??true),b.capacity==null||b.capacity===''?null:int(b.capacity),int(b.sort_order),t,t);
  }
}
function archiveEntity(kind,tid,eid) {
  if(kind==='driver') run('UPDATE drivers SET archived=1,active=0,updated_at=? WHERE id=? AND territory_id=?',now(),eid,tid);
  else if(kind==='territory') run('UPDATE territories SET archived=1,active=0,updated_at=? WHERE id=?',now(),tid);
  else if(kind==='rule') run('UPDATE settlement_rules SET archived=1,active=0,updated_at=? WHERE id=? AND territory_id=?',now(),eid,tid);
  else if(kind==='product') run('UPDATE products SET archived=1,active=0,updated_at=? WHERE id=?',now(),eid);
  else if(kind==='tier') run('DELETE FROM pricing_tiers WHERE id=? AND territory_id=?',eid,tid);
  else if(kind==='zone') run('UPDATE delivery_zones SET active=0 WHERE id=? AND territory_id=?',eid,tid);
  else if(kind==='window') run('UPDATE delivery_windows SET active=0,updated_at=? WHERE id=? AND territory_id=?',now(),eid,tid);
  else throw new Error('Unknown entity type');
}

// ---------- Server ----------
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host}`);
  try{
    if(url.pathname==='/'||url.pathname==='/index.html'||url.pathname.startsWith('/order/')) return serve(res,'index.html');
    if(url.pathname==='/admin'||url.pathname==='/admin.html') return serve(res,'admin.html');
    if(url.pathname==='/health') return send(res,200,{ok:true,time:now(),db:DB_FILE,email_configured:!!(RESEND_API_KEY&&ORDER_EMAIL_FROM)});

    // Public
    if(url.pathname==='/api/public/territories'&&req.method==='GET') return send(res,200,all('SELECT id,name,slug,domain FROM territories WHERE active=1 AND archived=0 ORDER BY name'));
    const pubTerr=url.pathname.match(/^\/api\/public\/territory\/([^/]+)$/);
    if(pubTerr&&req.method==='GET'){
      const terr=publicTerritory(decodeURIComponent(pubTerr[1])); if(!terr)return send(res,404,{error:'Territory not found'});
      return send(res,200,territorySnapshot(terr.id));
    }
    if(url.pathname==='/api/public/zone-detect'&&req.method==='POST'){
      const b=await bodyJson(req); const terr=publicTerritory(text(b.territory_slug)||'victoria'); if(!terr)return send(res,404,{error:'Territory not found'});
      const z=detectZone(terr.id,num(b.lng),num(b.lat)); return send(res,200,{zone:z?{id:z.id,name:z.name,color_label:z.color_label,fee_cents:int(z.fee_cents??cents(z.fee)),free_at_qty:z.free_at_qty}:null});
    }
    if(url.pathname==='/api/public/orders'&&req.method==='POST'){
      const b=await bodyJson(req);
      if(!b.age_acknowledged) return send(res,400,{error:'Age acknowledgement is required'});
      if(!text(b.customer_email)||!text(b.customer_phone)||!text(b.address)) return send(res,400,{error:'Email, cell number and delivery address are required'});
      const o=createOrderCore(b,{source:'web',created_by_role:'customer'});
      sendOrderConfirmation(o.id).catch(console.error);
      return send(res,201,{id:o.id,order_no:o.order_no,total_cents:o.total_cents,customer_discount_cents:o.customer_discount_cents,status_url:orderStatusUrl(o)});
    }
    const pubOrder=url.pathname.match(/^\/api\/public\/orders\/token\/([^/]+)$/);
    if(pubOrder&&req.method==='GET'){
      const o=publicOrderByToken(decodeURIComponent(pubOrder[1])); if(!o)return send(res,404,{error:'Order not found'}); return send(res,200,o);
    }
    if(url.pathname==='/api/public/reviews'&&req.method==='GET') return send(res,200,all("SELECT customer_name,rating,body,created_at FROM reviews WHERE status='published' ORDER BY created_at DESC LIMIT 50"));
    if(url.pathname==='/api/public/reviews'&&req.method==='POST'){
      const b=await bodyJson(req); if(!text(b.body))return send(res,400,{error:'Review is empty'});
      run(`INSERT INTO reviews(id,territory_id,order_id,customer_name,rating,body,status,created_at,updated_at) VALUES(?,?,?,?,? ,?,'pending',?,?)`,id(),b.territory_id||null,b.order_id||null,text(b.customer_name),Math.min(5,Math.max(1,int(b.rating,5))),text(b.body),now(),now());
      return send(res,201,{ok:true,status:'pending'});
    }
    if(url.pathname==='/api/public/messages'&&req.method==='POST'){
      const b=await bodyJson(req); if(!text(b.body))return send(res,400,{error:'Message is empty'});
      run(`INSERT INTO messages(id,territory_id,order_id,customer_name,customer_email,customer_phone,subject,body,status,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'new',0,?,?)`,id(),b.territory_id||null,b.order_id||null,text(b.customer_name),text(b.customer_email),normalizePhone(b.customer_phone),text(b.subject),text(b.body),now(),now());
      return send(res,201,{ok:true});
    }

    // Admin auth
    if(url.pathname==='/api/admin/login'&&req.method==='POST'){
      const b=await bodyJson(req); if(text(b.password)!==ADMIN_PASSWORD)return send(res,401,{error:'Wrong password'});
      const tok=token(); adminSessions.set(tok,{role:'super_admin',created:Date.now()});
      return send(res,200,{ok:true},'application/json; charset=utf-8',{'Set-Cookie':`pv_session=${tok}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`});
    }
    if(url.pathname==='/api/admin/logout'&&req.method==='POST'){
      const tok=parseCookies(req).pv_session;if(tok)adminSessions.delete(tok);
      return send(res,200,{ok:true},'application/json; charset=utf-8',{'Set-Cookie':'pv_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});
    }
    if(url.pathname.startsWith('/api/admin/')&&!requireAdmin(req,res)) return;

    if(url.pathname==='/api/admin/bootstrap'&&req.method==='GET') return send(res,200,adminBootstrap());
    if(url.pathname==='/api/admin/settings'&&req.method==='PUT'){
      const b=await bodyJson(req); for(const [k,v] of Object.entries(b)) setSetting(k,typeof v==='object'?jsonText(v):String(v)); return send(res,200,{ok:true});
    }
    const ta=url.pathname.match(/^\/api\/admin\/territories\/([^/]+)$/);
    if(ta&&req.method==='GET'){ const data=territoryAdmin(decodeURIComponent(ta[1]));if(!data)return send(res,404,{error:'Not found'});return send(res,200,data); }
    if(url.pathname==='/api/admin/territories'&&req.method==='POST'){
      const b=await bodyJson(req),tid=id(),t=now();
      run('INSERT INTO territories(id,name,slug,active,archived,domain,currency,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',tid,text(b.name),text(b.slug),bool(b.active??true),0,text(b.domain),'CAD',t,t);
      [[1,9,1500],[10,19,1350],[20,null,1250]].forEach((x,i)=>run('INSERT INTO pricing_tiers(id,territory_id,min_qty,max_qty,unit_price,unit_price_cents,active,sort_order) VALUES(?,?,?,?,?,?,?,?)',id(),tid,x[0],x[1],dollars(x[2]),x[2],1,i));
      return send(res,201,{id:tid});
    }
    const saveMatch=url.pathname.match(/^\/api\/admin\/territories\/([^/]+)\/(tier|zone|driver|rule|window)$/);
    if(saveMatch&&req.method==='POST'){ const b=await bodyJson(req); saveTerritoryEntity(saveMatch[2],decodeURIComponent(saveMatch[1]),b); return send(res,200,{ok:true}); }
    const archMatch=url.pathname.match(/^\/api\/admin\/territories\/([^/]+)\/(driver|rule|product|tier|zone|window)\/([^/]+)$/);
    if(archMatch&&req.method==='DELETE'){ archiveEntity(archMatch[2],decodeURIComponent(archMatch[1]),decodeURIComponent(archMatch[3])); return send(res,200,{ok:true}); }
    const terrDelete=url.pathname.match(/^\/api\/admin\/territories\/([^/]+)$/);
    if(terrDelete&&req.method==='DELETE'){ archiveEntity('territory',decodeURIComponent(terrDelete[1]),null); return send(res,200,{ok:true}); }

    const storefrontInfo=url.pathname.match(/^\/api\/admin\/territories\/([^/]+)\/storefront-info$/);
    if(storefrontInfo&&req.method==='PUT'){
      const b=await bodyJson(req),tid=decodeURIComponent(storefrontInfo[1]);
      run('UPDATE territories SET operating_hours=?,same_day_text=?,payment_note_text=?,updated_at=? WHERE id=?',
        text(b.operating_hours),text(b.same_day_text)||'SAME-DAY DELIVERY',text(b.payment_note_text)||'No upfront payment — pay when your order arrives.',now(),tid);
      return send(res,200,{ok:true});
    }

    // Products and inventory
    if(url.pathname==='/api/admin/products'&&req.method==='POST'){
      const b=await bodyJson(req),pid=id(),t=now();
      run('INSERT INTO products(id,brand,flavor,strength,image,notes,active,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,1,0,?,?)',pid,text(b.brand),text(b.flavor),text(b.strength),text(b.image),text(b.notes),t,t);
      return send(res,201,{id:pid});
    }
    const prodEdit=url.pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
    if(prodEdit&&req.method==='PUT'){
      const b=await bodyJson(req); run('UPDATE products SET brand=?,flavor=?,strength=?,image=?,notes=?,active=?,archived=?,updated_at=? WHERE id=?',text(b.brand),text(b.flavor),text(b.strength),text(b.image),text(b.notes),bool(b.active??true),bool(b.archived??false),now(),decodeURIComponent(prodEdit[1])); return send(res,200,{ok:true});
    }
    const tp=url.pathname.match(/^\/api\/admin\/territories\/([^/]+)\/product\/([^/]+)$/);
    if(tp&&req.method==='PUT'){
      const b=await bodyJson(req),tid=decodeURIComponent(tp[1]),pid=decodeURIComponent(tp[2]),t=now(); ensureTerritoryProduct(tid,pid);
      const override=b.local_price_override_cents!=null?int(b.local_price_override_cents):(b.local_price_override===''||b.local_price_override==null?null:cents(b.local_price_override));
      run('UPDATE territory_products SET listed=?,featured=?,local_price_override=?,local_price_override_cents=?,sort_order=?,updated_at=? WHERE territory_id=? AND product_id=?',bool(b.listed),bool(b.featured),override==null?null:dollars(override),override,int(b.sort_order),t,tid,pid);
      return send(res,200,{ok:true});
    }
    if(url.pathname==='/api/admin/inventory/receive'&&req.method==='POST'){
      const b=await bodyJson(req),tid=text(b.territory_id),pid=text(b.product_id),q=clampInt(b.qty); if(!tid||!pid||!q)throw new Error('Territory, product and quantity are required');
      const balance=db.transaction(()=>applyInventoryMovement({territory_id:tid,product_id:pid,qty_delta:q,movement_type:'receive_stock',note:text(b.note)||'Stock received',created_by_role:'admin'}))();
      if(b.listed!=null) run('UPDATE territory_products SET listed=?,updated_at=? WHERE territory_id=? AND product_id=?',bool(b.listed),now(),tid,pid);
      return send(res,201,{ok:true,balance});
    }
    if(url.pathname==='/api/admin/inventory/adjust'&&req.method==='POST'){
      const b=await bodyJson(req),delta=int(b.qty_delta); if(!text(b.reason))throw new Error('Reason is required');
      const balance=db.transaction(()=>applyInventoryMovement({territory_id:text(b.territory_id),product_id:text(b.product_id),qty_delta:delta,movement_type:'manual_adjustment',note:text(b.reason),created_by_role:'admin'}))();
      return send(res,201,{ok:true,balance});
    }
    if(url.pathname==='/api/admin/inventory/movements'&&req.method==='GET'){
      const tid=text(url.searchParams.get('territory_id')); const pid=text(url.searchParams.get('product_id'));
      let sql=`SELECT m.*,p.brand,p.flavor,p.strength,d.name driver_name,o.order_no FROM inventory_movements m JOIN products p ON p.id=m.product_id LEFT JOIN drivers d ON d.id=m.driver_id LEFT JOIN orders o ON o.id=m.order_id WHERE 1=1`,args=[];
      if(tid){sql+=' AND m.territory_id=?';args.push(tid);} if(pid){sql+=' AND m.product_id=?';args.push(pid);} sql+=' ORDER BY m.created_at DESC LIMIT 500';
      return send(res,200,all(sql,...args));
    }

    // Admin off-site / quick sale
    if(url.pathname==='/api/admin/quick-sale'&&req.method==='POST'){
      const b=await bodyJson(req); const o=createOrderCore(b,{source:text(b.source)||'offsite',created_by_role:'admin',allow_unlisted:true,auto_complete:b.status!=='open'}); return send(res,201,o);
    }

    // Admin orders
    const ord=url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if(ord&&req.method==='GET'){ const o=orderFull(decodeURIComponent(ord[1]));if(!o)return send(res,404,{error:'Not found'});return send(res,200,o); }
    if(ord&&req.method==='PUT'){
      const oid=decodeURIComponent(ord[1]),b=await bodyJson(req),o=one('SELECT * FROM orders WHERE id=?',oid);if(!o)return send(res,404,{error:'Not found'});
      if(text(b.status)==='cancelled') return send(res,200,cancelOrder(oid,{role:'admin',note:text(b.note)}));
      const oldStatus=o.status; const status=text(b.status)||o.status; const driver=b.assigned_driver_id===undefined?o.assigned_driver_id:(b.assigned_driver_id||null);
      let delivery=b.delivery_fee_cents!=null?Math.max(0,int(b.delivery_fee_cents)):(b.delivery_fee!=null?Math.max(0,cents(b.delivery_fee)):int(o.delivery_fee_cents));
      const pre=int(o.subtotal_cents)+delivery; const total=roundDown(pre,int(setting('round_down_to_cents','500'),500)); const discount=Math.max(0,pre-total);
      const completed=status==='completed'?(o.completed_at||now()):(status==='cancelled'?null:o.completed_at);
      run(`UPDATE orders SET status=?,assigned_driver_id=?,delivery_fee=?,delivery_fee_cents=?,pre_discount_total_cents=?,customer_discount_cents=?,total=?,total_cents=?,rounding_adjustment=?,payment_method=?,payment_note=?,zone_override_note=?,completed_at=?,updated_at=? WHERE id=?`,status,driver,dollars(delivery),delivery,pre,discount,dollars(total),total,dollars(total-pre),text(b.payment_method)||o.payment_method,text(b.payment_note)||o.payment_note,text(b.zone_override_note)||o.zone_override_note,completed,now(),oid);
      if(driver!==o.assigned_driver_id) addOrderEvent(oid,'driver_assigned',driver?'Driver assigned':'Driver unassigned',{driver_id:driver},{created_by_role:'admin',visible_to_customer:true});
      if(oldStatus!==status) addOrderEvent(oid,'status',`Status changed to ${status}`,{from:oldStatus,to:status},{created_by_role:'admin',visible_to_customer:true});
      if(status==='completed') snapshotSettlementForOrder(oid);
      return send(res,200,orderFull(oid));
    }
    const cancel=url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/cancel$/);
    if(cancel&&req.method==='POST'){ const b=await bodyJson(req); return send(res,200,cancelOrder(decodeURIComponent(cancel[1]),{role:'admin',note:text(b.note)})); }
    const pay=url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/payments$/);
    if(pay&&req.method==='POST'){
      const oid=decodeURIComponent(pay[1]),o=one('SELECT * FROM orders WHERE id=?',oid);if(!o)throw new Error('Order not found'); const b=await bodyJson(req);
      const p=insertPayment({order_id:oid,territory_id:o.territory_id,driver_id:o.assigned_driver_id,method:b.method,amount_cents:b.amount_cents!=null?int(b.amount_cents):cents(b.amount),destination_type:b.destination_type||'driver',destination_driver_id:b.destination_driver_id||null,status:b.status||'received',note:b.note,created_by_role:'admin'});
      addOrderEvent(oid,'payment','Payment recorded',{payment_id:p},{created_by_role:'admin'}); return send(res,201,{ok:true,id:p});
    }
    const evt=url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/events$/);
    if(evt&&req.method==='POST'){ const b=await bodyJson(req); addOrderEvent(decodeURIComponent(evt[1]),text(b.event_type)||'note',text(b.message),b.data||{}, {attention:b.attention,pinned:b.pinned,visible_to_customer:b.visible_to_customer,created_by_role:'admin'}); return send(res,201,{ok:true}); }
    const evtPatch=url.pathname.match(/^\/api\/admin\/events\/([^/]+)$/);
    if(evtPatch&&req.method==='PUT'){ const b=await bodyJson(req); run('UPDATE order_events SET reviewed=?,pinned=? WHERE id=?',bool(b.reviewed),bool(b.pinned),decodeURIComponent(evtPatch[1])); return send(res,200,{ok:true}); }

    // Settlements
    const settle=url.pathname.match(/^\/api\/admin\/territories\/([^/]+)\/drivers\/([^/]+)\/settlement$/);
    if(settle&&req.method==='GET') return send(res,200,weeklySettlement(decodeURIComponent(settle[1]),decodeURIComponent(settle[2]),text(url.searchParams.get('week_start'))||undefined));
    if(settle&&req.method==='POST'){ const b=await bodyJson(req); return send(res,200,closeWeeklySettlement(decodeURIComponent(settle[1]),decodeURIComponent(settle[2]),text(b.week_start)||undefined)); }
    const sadj=url.pathname.match(/^\/api\/admin\/territories\/([^/]+)\/drivers\/([^/]+)\/settlement-adjustments$/);
    if(sadj&&req.method==='POST'){ const b=await bodyJson(req); const ws=settlementRange(text(b.week_start)||undefined).start; run('INSERT INTO settlement_adjustments(id,territory_id,driver_id,week_start,amount_cents,direction,note,created_at) VALUES(?,?,?,?,?,?,?,?)',id(),decodeURIComponent(sadj[1]),decodeURIComponent(sadj[2]),ws,b.amount_cents!=null?Math.abs(int(b.amount_cents)):Math.abs(cents(b.amount)),text(b.direction)||'boss_credit',text(b.note),now()); return send(res,201,{ok:true}); }

    // Reviews/messages admin
    if(url.pathname==='/api/admin/reviews'&&req.method==='GET') return send(res,200,all('SELECT * FROM reviews ORDER BY created_at DESC'));
    const review=url.pathname.match(/^\/api\/admin\/reviews\/([^/]+)$/);
    if(review&&req.method==='PUT'){ const b=await bodyJson(req); run('UPDATE reviews SET status=?,updated_at=? WHERE id=?',text(b.status)||'pending',now(),decodeURIComponent(review[1])); return send(res,200,{ok:true}); }
    if(review&&req.method==='DELETE'){ run('DELETE FROM reviews WHERE id=?',decodeURIComponent(review[1])); return send(res,200,{ok:true}); }
    if(url.pathname==='/api/admin/messages'&&req.method==='GET') return send(res,200,all('SELECT * FROM messages ORDER BY pinned DESC,created_at DESC'));
    const msg=url.pathname.match(/^\/api\/admin\/messages\/([^/]+)$/);
    if(msg&&req.method==='PUT'){ const b=await bodyJson(req); run('UPDATE messages SET status=?,pinned=?,updated_at=? WHERE id=?',text(b.status)||'read',bool(b.pinned),now(),decodeURIComponent(msg[1])); return send(res,200,{ok:true}); }
    if(msg&&req.method==='DELETE'){ run('DELETE FROM messages WHERE id=?',decodeURIComponent(msg[1])); return send(res,200,{ok:true}); }

    // Driver auth and app API
    if(url.pathname==='/api/driver/login'&&req.method==='POST'){
      const b=await bodyJson(req); const d=one('SELECT * FROM drivers WHERE id=? AND active=1 AND archived=0',text(b.driver_id)); if(!d||!d.pin_hash||d.pin_hash!==hashPin(b.pin))return send(res,401,{error:'Wrong driver or PIN'});
      const tok=token();driverSessions.set(tok,{driver_id:d.id,territory_id:d.territory_id,created:Date.now()});
      return send(res,200,{ok:true,driver:{id:d.id,name:d.name,territory_id:d.territory_id}},'application/json; charset=utf-8',{'Set-Cookie':`pv_driver_session=${tok}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`});
    }
    if(url.pathname==='/api/driver/logout'&&req.method==='POST'){
      const tok=parseCookies(req).pv_driver_session;if(tok)driverSessions.delete(tok); return send(res,200,{ok:true},'application/json; charset=utf-8',{'Set-Cookie':'pv_driver_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});
    }
    if(url.pathname.startsWith('/api/driver/')){
      const s=requireDriver(req,res); if(!s)return;
      const driver=one('SELECT * FROM drivers WHERE id=?',s.driver_id); if(!driver)return send(res,401,{error:'Driver unavailable'});
      if(url.pathname==='/api/driver/bootstrap'&&req.method==='GET'){
        return send(res,200,{driver,territory:one('SELECT * FROM territories WHERE id=?',driver.territory_id),products:all(`SELECT p.id,p.brand,p.flavor,p.strength,tp.inventory,tp.listed FROM products p JOIN territory_products tp ON tp.product_id=p.id WHERE tp.territory_id=? AND p.active=1 AND p.archived=0 ORDER BY p.brand,p.flavor`,driver.territory_id),orders:all(`SELECT o.*,(SELECT COALESCE(SUM(qty),0) FROM order_items i WHERE i.order_id=o.id) cans FROM orders o WHERE o.assigned_driver_id=? AND o.status NOT IN ('cancelled') ORDER BY CASE WHEN o.status='new' THEN 0 WHEN o.status='picked_up' THEN 1 WHEN o.status='on_the_way' THEN 2 ELSE 3 END,o.created_at DESC LIMIT 150`,driver.id)});
      }
      if(url.pathname==='/api/driver/quick-sale'&&req.method==='POST'){
        const b=await bodyJson(req); b.territory_id=driver.territory_id;b.assigned_driver_id=driver.id; const o=createOrderCore(b,{source:text(b.source)||'driver_offsite',created_by_role:'driver',created_by_driver_id:driver.id,allow_unlisted:true,auto_complete:b.status!=='open'}); return send(res,201,o);
      }
      const dord=url.pathname.match(/^\/api\/driver\/orders\/([^/]+)$/);
      if(dord&&req.method==='GET'){ const o=orderFull(decodeURIComponent(dord[1]));if(!o||o.assigned_driver_id!==driver.id)return send(res,404,{error:'Not found'});return send(res,200,o); }
      if(dord&&req.method==='PUT'){
        const oid=decodeURIComponent(dord[1]),o=one('SELECT * FROM orders WHERE id=?',oid);if(!o||o.assigned_driver_id!==driver.id)return send(res,404,{error:'Not found'}); const b=await bodyJson(req);
        if(text(b.status)==='cancelled')return send(res,200,cancelOrder(oid,{role:'driver',driver_id:driver.id,note:text(b.note)}));
        const status=text(b.status)||o.status; const completed=status==='completed'?(o.completed_at||now()):o.completed_at;
        run('UPDATE orders SET status=?,completed_at=?,updated_at=? WHERE id=?',status,completed,now(),oid);
        addOrderEvent(oid,'driver_update',text(b.note)||`Driver changed status to ${status}`,{status},{attention:status!=='completed',created_by_role:'driver',created_by_driver_id:driver.id,visible_to_customer:true});
        if(status==='completed')snapshotSettlementForOrder(oid); return send(res,200,orderFull(oid));
      }
      const dp=url.pathname.match(/^\/api\/driver\/orders\/([^/]+)\/payments$/);
      if(dp&&req.method==='POST'){
        const oid=decodeURIComponent(dp[1]),o=one('SELECT * FROM orders WHERE id=?',oid);if(!o||o.assigned_driver_id!==driver.id)return send(res,404,{error:'Not found'}); const b=await bodyJson(req);
        const pid=insertPayment({order_id:oid,territory_id:o.territory_id,driver_id:driver.id,method:b.method,amount_cents:b.amount_cents!=null?int(b.amount_cents):cents(b.amount),destination_type:b.destination_type||'driver',destination_driver_id:b.destination_driver_id||null,status:b.status||'received',note:b.note,created_by_role:'driver',created_by_driver_id:driver.id});
        addOrderEvent(oid,'driver_payment','Driver recorded a payment',{payment_id:pid},{attention:1,created_by_role:'driver',created_by_driver_id:driver.id}); return send(res,201,{ok:true,id:pid});
      }
      const de=url.pathname.match(/^\/api\/driver\/orders\/([^/]+)\/events$/);
      if(de&&req.method==='POST'){ const oid=decodeURIComponent(de[1]),o=one('SELECT * FROM orders WHERE id=?',oid);if(!o||o.assigned_driver_id!==driver.id)return send(res,404,{error:'Not found'}); const b=await bodyJson(req); addOrderEvent(oid,text(b.event_type)||'driver_note',text(b.message),b.data||{}, {attention:b.attention??true,visible_to_customer:b.visible_to_customer,created_by_role:'driver',created_by_driver_id:driver.id}); return send(res,201,{ok:true}); }
      const dinv=url.pathname.match(/^\/api\/driver\/orders\/([^/]+)\/inventory-adjustment$/);
      if(dinv&&req.method==='POST'){
        const oid=decodeURIComponent(dinv[1]),o=one('SELECT * FROM orders WHERE id=?',oid);if(!o||o.assigned_driver_id!==driver.id)return send(res,404,{error:'Not found'}); const b=await bodyJson(req); if(!text(b.note))throw new Error('A short note is required');
        const balance=db.transaction(()=>applyInventoryMovement({territory_id:o.territory_id,product_id:text(b.product_id),qty_delta:int(b.qty_delta),movement_type:text(b.movement_type)||'driver_order_adjustment',order_id:oid,driver_id:driver.id,note:text(b.note),created_by_role:'driver',created_by_driver_id:driver.id}))();
        addOrderEvent(oid,'driver_inventory_change',text(b.note),{product_id:b.product_id,qty_delta:int(b.qty_delta)},{attention:1,created_by_role:'driver',created_by_driver_id:driver.id}); return send(res,201,{ok:true,balance});
      }
      if(url.pathname==='/api/driver/settlement'&&req.method==='GET') return send(res,200,weeklySettlement(driver.territory_id,driver.id,text(url.searchParams.get('week_start'))||undefined));
    }

    return send(res,404,{error:'Not found'});
  }catch(e){
    console.error(e);
    return send(res,400,{error:e.message||'Request failed'});
  }
});

server.listen(PORT,'0.0.0.0',()=>console.log(`Pouches Vic running on ${PORT}`));
