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

function addDays(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

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

function one(sql, ...args) {
  return db.prepare(sql).get(...args);
}

function all(sql, ...args) {
  return db.prepare(sql).all(...args);
}

function run(sql, ...args) {
  return db.prepare(sql).run(...args);
}

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
);CREATE TABLE IF NOT EXISTS drivers(
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
);CREATE TABLE IF NOT EXISTS payments(
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
);CREATE TABLE IF NOT EXISTS settlement_entries(
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
);function tableColumns(table) {
  return new Set(all(`PRAGMA table_info(${table})`).map(x => x.name));
}

function ensureColumn(table, name, def) {
  const cols = tableColumns(table);
  if (!cols.has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
  }
}

// Safe upgrades from our earlier PouchesVic database.
[
  ['territories','archived','INTEGER NOT NULL DEFAULT 0'],
  ['pricing_tiers','unit_price_cents','INTEGER'],
  ['delivery_zones','fee_cents','INTEGER'],
  ['delivery_zones','geojson',"TEXT DEFAULT ''"],
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
  run(`UPDATE pricing_tiers
       SET unit_price_cents=CAST(ROUND(unit_price*100) AS INTEGER)
       WHERE unit_price_cents IS NULL`);

  run(`UPDATE delivery_zones
       SET fee_cents=CAST(ROUND(fee*100) AS INTEGER)
       WHERE fee_cents IS NULL`);

  run(`UPDATE territory_products
       SET local_price_override_cents=CAST(ROUND(local_price_override*100) AS INTEGER)
       WHERE local_price_override IS NOT NULL
       AND local_price_override_cents IS NULL`);

  run(`UPDATE settlement_rules
       SET amount_cents=CAST(ROUND(amount*100) AS INTEGER)
       WHERE amount_cents IS NULL`);

  run(`UPDATE orders
       SET subtotal_cents=CAST(ROUND(subtotal*100) AS INTEGER)
       WHERE subtotal_cents=0 AND subtotal!=0`);

  run(`UPDATE orders
       SET delivery_fee_cents=CAST(ROUND(delivery_fee*100) AS INTEGER)
       WHERE delivery_fee_cents=0 AND delivery_fee!=0`);

  run(`UPDATE orders
       SET total_cents=CAST(ROUND(total*100) AS INTEGER)
       WHERE total_cents=0 AND total!=0`);

  run(`UPDATE orders
       SET pre_discount_total_cents=subtotal_cents+delivery_fee_cents
       WHERE pre_discount_total_cents=0`);

  run(`UPDATE orders
       SET customer_discount_cents=MAX(0,pre_discount_total_cents-total_cents)
       WHERE customer_discount_cents=0`);

  run(`UPDATE orders
       SET zone_fee_snapshot_cents=CAST(ROUND(zone_fee_snapshot*100) AS INTEGER)
       WHERE zone_fee_snapshot_cents=0 AND zone_fee_snapshot!=0`);

  run(`UPDATE orders
       SET zone_fee_override_cents=CAST(ROUND(zone_fee_override*100) AS INTEGER)
       WHERE zone_fee_override IS NOT NULL
       AND zone_fee_override_cents IS NULL`);

  run(`UPDATE order_items
       SET unit_price_cents=CAST(ROUND(unit_price*100) AS INTEGER)
       WHERE unit_price_cents=0 AND unit_price!=0`);

  run(`UPDATE order_items
       SET line_total_cents=CAST(ROUND(line_total*100) AS INTEGER)
       WHERE line_total_cents=0 AND line_total!=0`);

  run(`UPDATE order_adjustments
       SET amount_cents=CAST(ROUND(amount*100) AS INTEGER)
       WHERE amount_cents=0 AND amount!=0`);
}

backfillMoneyColumns();
`);function setSetting(key, value) {
  run(
    `INSERT INTO settings(key,value,updated_at)
     VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    key,
    String(value),
    now()
  );
}

function getSetting(key, fallback = '') {
  return one(`SELECT value FROM settings WHERE key=?`, key)?.value ?? fallback;
}

function nextOrderNo() {
  const tx = db.transaction(() => {
    const row = one(`SELECT value FROM counters WHERE key='order_no'`);
    const next = (row?.value || 1000) + 1;

    run(
      `INSERT INTO counters(key,value)
       VALUES('order_no',?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      next
    );

    return next;
  });

  return tx();
}

function ensureTerritoryProduct(territoryId, productId) {
  const existing = one(
    `SELECT * FROM territory_products WHERE territory_id=? AND product_id=?`,
    territoryId,
    productId
  );

  if (existing) return existing;

  const t = now();

  run(
    `INSERT INTO territory_products(
      id, territory_id, product_id, inventory, listed, featured,
      local_price_override, local_price_override_cents, sort_order, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    id(),
    territoryId,
    productId,
    0,
    0,
    0,
    null,
    null,
    0,
    t
  );

  return one(
    `SELECT * FROM territory_products WHERE territory_id=? AND product_id=?`,
    territoryId,
    productId
  );
}

function inventoryBalance(territoryId, productId) {
  const row = one(
    `SELECT inventory FROM territory_products WHERE territory_id=? AND product_id=?`,
    territoryId,
    productId
  );

  return row ? int(row.inventory) : 0;
}

function recordInventoryMovement({
  territoryId,
  productId,
  qtyDelta,
  movementType,
  orderId = null,
  driverId = null,
  note = '',
  createdByRole = 'system',
  createdByDriverId = null
}) {
  const delta = int(qtyDelta);

  ensureTerritoryProduct(territoryId, productId);

  const current = inventoryBalance(territoryId, productId);
  const next = current + delta;

  if (next < 0) {
    throw new Error('Inventory cannot go below zero');
  }

  const t = now();

  run(
    `UPDATE territory_products
     SET inventory=?, updated_at=?
     WHERE territory_id=? AND product_id=?`,
    next,
    t,
    territoryId,
    productId
  );

  run(
    `INSERT INTO inventory_movements(
      id, territory_id, product_id, order_id, driver_id,
      movement_type, qty_delta, balance_after, note,
      created_by_role, created_by_driver_id, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id(),
    territoryId,
    productId,
    orderId,
    driverId,
    movementType,
    delta,
    next,
    text(note),
    createdByRole,
    createdByDriverId,
    t
  );

  return next;
}

function addOrderEvent({
  orderId,
  eventType,
  message = '',
  data = {},
  attention = false,
  reviewed = false,
  pinned = false,
  visibleToCustomer = false,
  createdByRole = 'system',
  createdByDriverId = null
}) {
  run(
    `INSERT INTO order_events(
      id, order_id, event_type, message, data_json,
      attention, reviewed, pinned, visible_to_customer,
      created_by_role, created_by_driver_id, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id(),
    orderId,
    text(eventType),
    text(message),
    jsonText(data || {}),
    bool(attention),
    bool(reviewed),
    bool(pinned),
    bool(visibleToCustomer),
    text(createdByRole) || 'system',
    createdByDriverId || null,
    now()
  );
}

function addPayment({
  orderId = null,
  territoryId,
  driverId = null,
  method = 'cash',
  amountCents = 0,
  destinationType = 'driver',
  destinationDriverId = null,
  status = 'received',
  note = '',
  createdByRole = 'admin',
  createdByDriverId = null
}) {
  const amount = Math.max(0, int(amountCents));

  run(
    `INSERT INTO payments(
      id, order_id, territory_id, driver_id, method,
      amount_cents, destination_type, destination_driver_id,
      status, note, created_by_role, created_by_driver_id, created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id(),
    orderId,
    territoryId,
    driverId,
    text(method) || 'cash',
    amount,
    text(destinationType) || 'driver',
    destinationDriverId || null,
    text(status) || 'received',
    text(note),
    text(createdByRole) || 'admin',
    createdByDriverId || null,
    now()
  );
}

function activeTerritoryBySlug(slug) {
  return one(
    `SELECT * FROM territories
     WHERE slug=? AND active=1 AND archived=0`,
    text(slug)
  );
}

function priceTierForQty(territoryId, qty) {
  const tiers = all(
    `SELECT * FROM pricing_tiers
     WHERE territory_id=? AND active=1
     ORDER BY sort_order,min_qty`,
    territoryId
  );

  const q = Math.max(1, int(qty, 1));

  const tier =
    tiers.find(x => q >= x.min_qty && (x.max_qty == null || q <= x.max_qty)) ||
    tiers[tiers.length - 1];

  if (!tier) return 0;

  return tier.unit_price_cents != null
    ? int(tier.unit_price_cents)
    : cents(tier.unit_price);
}

function effectiveProductPriceCents(territoryId, productId, totalQty) {
  const tp = one(
    `SELECT * FROM territory_products
     WHERE territory_id=? AND product_id=?`,
    territoryId,
    productId
  );

  if (tp?.local_price_override_cents != null) {
    return int(tp.local_price_override_cents);
  }

  if (tp?.local_price_override != null) {
    return cents(tp.local_price_override);
  }

  return priceTierForQty(territoryId, totalQty);
}// ---------- Seed / defaults ----------
function setting(key, fallback = '') {
  return getSetting(key, fallback);
}

function seed() {
  const t = now();

  if (one('SELECT COUNT(*) c FROM territories').c === 0) {
    const vic = id();
    const kel = id();
    const pg = id();

    const insT = db.prepare(`
      INSERT INTO territories(
        id,name,slug,active,archived,domain,currency,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `);

    insT.run(vic,'Victoria','victoria',1,0,'pouchesvic.com','CAD',t,t);
    insT.run(kel,'Kelowna','kelowna',1,0,'','CAD',t,t);
    insT.run(pg,'Prince George','prince-george',1,0,'','CAD',t,t);

    const insTier = db.prepare(`
      INSERT INTO pricing_tiers(
        id,territory_id,min_qty,max_qty,
        unit_price,unit_price_cents,active,sort_order
      ) VALUES(?,?,?,?,?,?,?,?)
    `);

    for (const tid of [vic,kel,pg]) {
      [
        [1,9,1500],
        [10,19,1350],
        [20,null,1250]
      ].forEach((x,i) => {
        insTier.run(
          id(),
          tid,
          x[0],
          x[1],
          dollars(x[2]),
          x[2],
          1,
          i
        );
      });
    }

    const green = id();
    const orange = id();
    const pink = id();

    const insZ = db.prepare(`
      INSERT INTO delivery_zones(
        id,territory_id,name,color_label,
        fee,fee_cents,free_at_qty,active,
        description,rule_notes,geojson,sort_order
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    insZ.run(
      green,
      vic,
      'Green',
      'Green',
      10,
      1000,
      10,
      1,
      'Core Victoria / closest delivery area',
      'Initial Victoria Green rules. Add or edit the actual map polygon in the Boss Control Room.',
      '',
      0
    );

    insZ.run(
      orange,
      vic,
      'Orange',
      'Orange',
      15,
      1500,
      null,
      1,
      'Outer Victoria / Westshore and mid-north area',
      'Initial Victoria Orange rules. Add or edit the actual map polygon in the Boss Control Room.',
      '',
      1
    );

    insZ.run(
      pink,
      vic,
      'Pink',
      'Pink',
      20,
      2000,
      null,
      1,
      'Farthest regular Victoria delivery area',
      'Initial Victoria Pink rules. Add or edit the actual map polygon in the Boss Control Room.',
      '',
      2
    );

    insZ.run(
      id(),kel,'Local','Local',
      0,0,null,1,
      'Default editable zone',
      'Set Kelowna boundaries and fees in Admin.',
      '',0
    );

    insZ.run(
      id(),pg,'Local','Local',
      0,0,null,1,
      'Default editable zone',
      'Set Prince George boundaries and fees in Admin.',
      '',0
    );

    const d1 = id();
    const d2 = id();

    const insD = db.prepare(`
      INSERT INTO drivers(
        id,territory_id,name,active,archived,role,
        email,phone,customer_contact_number,
        notes,pin_hash,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    insD.run(
      d1,vic,'Victoria Driver 1',
      1,0,'operations_admin',
      '','','',
      'Victoria supervisor/settlement driver',
      '',t,t
    );

    insD.run(
      d2,vic,'Victoria Driver 2',
      1,0,'driver',
      '','','',
      'Victoria subordinate driver',
      '',t,t
    );

    insD.run(
      id(),kel,'Kelowna Driver',
      1,0,'driver',
      '','','','',
      '',t,t
    );

    insD.run(
      id(),pg,'Prince George Driver',
      1,0,'driver',
      '','','','',
      '',t,t
    );

    const insR = db.prepare(`
      INSERT INTO settlement_rules(
        id,territory_id,name,active,archived,rule_type,
        from_driver_id,to_driver_id,zone_id,
        amount,amount_cents,notes,sort_order,
        created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    insR.run(
      id(),vic,
      'Driver 2 pays Driver 1 per can',
      1,0,
      'per_can_driver_to_driver',
      d2,d1,null,
      10,1000,
      'Driver 2 pays Driver 1 $10 for every can sold. Editable.',
      0,t,t
    );

    insR.run(
      id(),vic,
      'Driver 1 pays Boss per can',
      1,0,
      'per_can_driver_to_boss',
      d1,null,null,
      9,900,
      'Boss settles weekly with Driver 1 at $9 per can. Editable.',
      1,t,t
    );

    insR.run(
      id(),vic,
      'Driver 2 Orange fee share to Driver 1',
      1,0,
      'zone_fee_driver_to_driver',
      d2,d1,orange,
      5,500,
      'On Driver 2 Orange deliveries, $5 of the charged fee is owed to Driver 1.',
      2,t,t
    );

    insR.run(
      id(),vic,
      'Driver 2 Pink fee share to Driver 1',
      1,0,
      'zone_fee_driver_to_driver',
      d2,d1,pink,
      5,500,
      'On Driver 2 Pink deliveries, $5 of the charged fee is owed to Driver 1.',
      3,t,t
    );

    insR.run(
      id(),vic,
      'Green fee goes to Driver 1',
      1,0,
      'zone_fee_to_driver',
      null,d1,green,
      0,0,
      'Amount 0 means use the actual delivery fee charged.',
      4,t,t
    );
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
    customer_discount_label: 'Customer Appreciation    customer_discount_label: 'Customer Appreciation Discount',

    age_acknowledgement_text:
      'I confirm that I meet the legal age requirement for this purchase.',

    store_support_email: '',
    store_support_phone: ''
  };

  for (const [key,value] of Object.entries(defaults)) {
    if (!one(`SELECT 1 FROM settings WHERE key=?`, key)) {
      setSetting(key,value);
    }
  } 
if (!one(`SELECT 1 FROM counters WHERE key='order_no'`)) {
    run(
      `INSERT INTO counters(key,value)
       VALUES('order_no',1000)`
    );
  }
}

seed();
