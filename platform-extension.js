'use strict';

// PouchesVic platform extension
// Loaded before server.js with: node -r ./platform-extension.js server.js
// Adds business-neutral configuration, barcode inventory, marketplace-ready schema,
// and customer-support -> driver live update notifications without rewriting the core server.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const webpush = require('web-push');
const { URL } = require('url');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'pouchesvic.db');
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://pouchesvic.com').replace(/\/$/, '');
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ORDER_EMAIL_FROM = process.env.ORDER_EMAIL_FROM || '';
const ORDER_EMAIL_REPLY_TO = process.env.ORDER_EMAIL_REPLY_TO || '';
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PORT = Number(process.env.PORT || 3000);
const PHOTO_DIR = path.join(DATA_DIR, 'order-photos');
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const adminSessions = new Map();
let db = null;
let platformReady = false;

function now() { return new Date().toISOString(); }
function id() { return crypto.randomUUID(); }
function text(v) { return v == null ? '' : String(v).trim(); }
function int(v, d = 0) { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : d; }
function bool(v) { return v ? 1 : 0; }
function jsonText(v) { return JSON.stringify(v == null ? null : v); }
function safeJson(v, d = null) { try { return JSON.parse(v); } catch { return d; } }
function hash(v) { return crypto.createHash('sha256').update(String(v)).digest('hex'); }
function token(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function displayStrength(value) {
  const s = text(value);
  if (!s) return '';
  if (/mg\s*$/i.test(s)) return s.replace(/\s*mg\s*$/i, ' mg');
  return /^\d+(?:\.\d+)?$/.test(s) ? `${s} mg` : s;
}

function openDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}
function one(sql, ...args) { return openDb().prepare(sql).get(...args); }
function all(sql, ...args) { return openDb().prepare(sql).all(...args); }
function run(sql, ...args) { return openDb().prepare(sql).run(...args); }
function tableExists(name) { return !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name); }
function columns(table) { return new Set(all(`PRAGMA table_info(${table})`).map(x => x.name)); }
function ensureColumn(table, name, def) {
  if (!tableExists(table)) return;
  if (!columns(table).has(name)) openDb().exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}

function ensurePlatform() {
  if (platformReady) return true;
  if (!tableExists('products') || !tableExists('orders') || !tableExists('settings')) return false;

  // Generic product fields are additive. Existing nicotine fields remain untouched for compatibility.
  [
    ['products','generic_name',"TEXT DEFAULT ''"],
    ['products','category',"TEXT DEFAULT ''"],
    ['products','variant',"TEXT DEFAULT ''"],
    ['products','sku',"TEXT DEFAULT ''"],
    ['products','barcode',"TEXT DEFAULT ''"],
    ['products','barcode_format',"TEXT DEFAULT ''"],
    ['products','unit_label',"TEXT DEFAULT ''"],
    ['products','business_id',"TEXT DEFAULT 'primary'"],
    ['products','seller_id','TEXT'],
    ['products','attributes_json',"TEXT DEFAULT '{}'"],
    ['orders','support_updated_at','TEXT'],
    ['orders','fulfillment_type',"TEXT DEFAULT 'delivery'"],
    ['orders','seller_id','TEXT'],
    ['orders','tip_cents','INTEGER NOT NULL DEFAULT 0'],
    ['orders','tip_recipient_type',"TEXT NOT NULL DEFAULT 'driver'"],
    ['orders','tip_recipient_driver_id','TEXT']
  ].forEach(x => ensureColumn(...x));

  openDb().exec(`
    CREATE TABLE IF NOT EXISTS platform_businesses(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_modules(
      module_key TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      readiness TEXT NOT NULL DEFAULT 'installed',
      config_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_sellers(
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL DEFAULT 'primary',
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      contact_name TEXT DEFAULT '',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      payout_config_json TEXT NOT NULL DEFAULT '{}',
      permissions_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(business_id) REFERENCES platform_businesses(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS platform_seller_locations(
      id TEXT PRIMARY KEY,
      seller_id TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT DEFAULT '',
      lat REAL,
      lng REAL,
      fulfillment_json TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(seller_id) REFERENCES platform_sellers(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS platform_scanner_integrations(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_platform_scanner_hash ON platform_scanner_integrations(token_hash);
    CREATE TABLE IF NOT EXISTS platform_order_photos(
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      territory_id TEXT NOT NULL,
      driver_id TEXT,
      stage TEXT NOT NULL DEFAULT 'general',
      caption TEXT DEFAULT '',
      storage_provider TEXT NOT NULL DEFAULT 'local',
      storage_key TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_platform_order_photos_order ON platform_order_photos(order_id,status,created_at);
    CREATE INDEX IF NOT EXISTS idx_platform_order_photos_driver ON platform_order_photos(driver_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
    CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
    CREATE INDEX IF NOT EXISTS idx_products_seller ON products(seller_id);

    CREATE TABLE IF NOT EXISTS platform_territory_config(
      territory_id TEXT PRIMARY KEY,
      announcement_enabled INTEGER NOT NULL DEFAULT 0,
      announcement_text TEXT DEFAULT '',
      help_enabled INTEGER NOT NULL DEFAULT 0,
      help_heading TEXT DEFAULT 'Need help?',
      help_text TEXT DEFAULT '',
      help_contact TEXT DEFAULT '',
      help_contact_action TEXT NOT NULL DEFAULT 'sms',
      updated_at TEXT NOT NULL,
      FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS platform_product_ratings(
      product_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      rating REAL NOT NULL DEFAULT 5,
      review_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS platform_customers(
      id TEXT PRIMARY KEY,
      display_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      address TEXT DEFAULT '',
      normalized_phone TEXT DEFAULT '',
      normalized_email TEXT DEFAULT '',
      normalized_address TEXT DEFAULT '',
      loyalty_stars INTEGER NOT NULL DEFAULT 0,
      loyalty_label TEXT DEFAULT '',
      admin_confirmed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_order_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_platform_customers_phone ON platform_customers(normalized_phone);
    CREATE INDEX IF NOT EXISTS idx_platform_customers_email ON platform_customers(normalized_email);
    CREATE INDEX IF NOT EXISTS idx_platform_customers_address ON platform_customers(normalized_address);
    CREATE TABLE IF NOT EXISTS platform_customer_orders(
      order_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      territory_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY(customer_id) REFERENCES platform_customers(id) ON DELETE CASCADE,
      FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_platform_customer_orders_customer ON platform_customer_orders(customer_id,created_at);
    CREATE TABLE IF NOT EXISTS platform_customer_notes(
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      order_id TEXT,
      note TEXT NOT NULL,
      created_by_role TEXT NOT NULL DEFAULT 'admin',
      created_by_driver_id TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES platform_customers(id) ON DELETE CASCADE,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL,
      FOREIGN KEY(created_by_driver_id) REFERENCES drivers(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_platform_customer_notes_customer ON platform_customer_notes(customer_id,archived,created_at);
    CREATE TABLE IF NOT EXISTS platform_zone_overrides(
      id TEXT PRIMARY KEY,
      territory_id TEXT NOT NULL,
      match_type TEXT NOT NULL,
      match_value TEXT DEFAULT '',
      customer_id TEXT,
      zone_id TEXT NOT NULL,
      fee_cents INTEGER,
      note TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE,
      FOREIGN KEY(customer_id) REFERENCES platform_customers(id) ON DELETE CASCADE,
      FOREIGN KEY(zone_id) REFERENCES delivery_zones(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_platform_zone_overrides_lookup ON platform_zone_overrides(territory_id,active,match_type,match_value);
    CREATE TABLE IF NOT EXISTS platform_order_notification_recipients(
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_order_notification_deliveries(
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempted_at TEXT NOT NULL,
      sent_at TEXT,
      error TEXT DEFAULT '',
      UNIQUE(order_id,recipient_id),
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_platform_order_notification_order ON platform_order_notification_deliveries(order_id,status);
    CREATE TABLE IF NOT EXISTS platform_social_links(
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL DEFAULT 'custom',
      label TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_display_config(
      id TEXT PRIMARY KEY,
      show_social_links INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS platform_settlement_periods(
      id TEXT PRIMARY KEY, territory_id TEXT NOT NULL, driver_id TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL DEFAULT 'open',
      starting_inventory INTEGER, actual_ending_inventory INTEGER,
      snapshot_json TEXT NOT NULL DEFAULT '{}', closed_at TEXT, reopened_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE RESTRICT,
      FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_settlement_open ON platform_settlement_periods(territory_id,driver_id) WHERE status='open';
    CREATE TABLE IF NOT EXISTS platform_settlement_transactions(
      id TEXT PRIMARY KEY, period_id TEXT NOT NULL, territory_id TEXT NOT NULL, driver_id TEXT NOT NULL,
      kind TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0, amount_cents INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '', created_by_role TEXT NOT NULL DEFAULT 'admin', created_at TEXT NOT NULL,
      FOREIGN KEY(period_id) REFERENCES platform_settlement_periods(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_platform_settlement_tx ON platform_settlement_transactions(period_id,created_at);
    CREATE TABLE IF NOT EXISTS platform_settlement_audit(
      id TEXT PRIMARY KEY, period_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
      snapshot_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
      FOREIGN KEY(period_id) REFERENCES platform_settlement_periods(id) ON DELETE CASCADE
    );
  `);
  ensureColumn('platform_customers','archived_at','TEXT');

  const t = now();
  if (!one("SELECT 1 FROM platform_businesses WHERE id='primary'")) {
    run(`INSERT INTO platform_businesses(id,name,slug,active,config_json,created_at,updated_at)
         VALUES('primary','Pouches Vic','pouches-vic',1,?,?,?)`, jsonText(defaultProfile()), t, t);
  }
  const modules = defaultModules();
  for (const [key, meta] of Object.entries(modules)) {
    if (!one('SELECT 1 FROM platform_modules WHERE module_key=?', key)) {
      run('INSERT INTO platform_modules(module_key,enabled,readiness,config_json,updated_at) VALUES(?,?,?,?,?)',
        key, bool(meta.enabled), meta.readiness, jsonText(meta.config || {}), t);
    }
  }
  if (!one("SELECT 1 FROM platform_display_config WHERE id='primary'")) run("INSERT INTO platform_display_config(id,show_social_links,updated_at) VALUES('primary',0,?)", t);
  if (!one('SELECT 1 FROM platform_order_notification_recipients LIMIT 1')) {
    run('INSERT INTO platform_order_notification_recipients(id,email,enabled,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)', id(), 'vicpouches@protonmail.com', 1, 0, t, t);
  }
  platformReady = true;
  try { backfillExistingCustomers(); } catch (e) { console.error('Platform customer backfill skipped:', e.message); }
  return true;
}

function defaultProfile() {
  return {
    generic_business_mode: false,
    business_name: 'Pouches Vic',
    business_tagline: 'LOCAL • SIMPLE • FAST',
    hero_title: 'YOUR POUCHES. RIGHT HERE.',
    shop_button: 'SHOP POUCHES',
    service_label: 'LOCAL POUCH SERVICE',
    product_group_label: 'BRAND',
    product_name_label: 'FLAVOUR',
    variant_label: 'STRENGTH (MG)',
    item_singular: 'can',
    item_plural: 'cans',
    // Entry gate and checkout acknowledgement are intentionally separate.
    entry_age_gate_enabled: true,
    entry_age_gate_title: '19+ ONLY',
    entry_age_gate_text: 'You must be 19 or older to enter this site.',
    address_first_enabled: true,
    address_autocomplete_enabled: true,
    loyalty_badges_enabled: true,
    age_gate_enabled: true, // legacy alias; kept for older saved config
    age_acknowledgement_text: 'I confirm that I have valid ID and meet the legal age requirement for this purchase.'
  };
}
function defaultModules() {
  return {
    local_delivery: { enabled: true, readiness: 'installed' },
    driver_dispatch: { enabled: true, readiness: 'installed' },
    barcode_inventory: { enabled: true, readiness: 'installed' },
    customer_support_updates: { enabled: true, readiness: 'installed' },
    customer_history: { enabled: true, readiness: 'installed' },
    delivery_zone_overrides: { enabled: true, readiness: 'installed' },
    product_ratings: { enabled: false, readiness: 'installed_off' },
    delivery_method_step: { enabled: false, readiness: 'installed_off' },
    order_photos: { enabled: true, readiness: 'installed', config: { max_photos_per_order: 8, driver_can_delete: true, require_pickup_before_on_the_way: false, require_delivery_before_completed: false, storage_provider: 'local' } },
    pickup: { enabled: false, readiness: 'installed_off' },
    shipping: { enabled: false, readiness: 'installed_off' },
    external_courier: { enabled: false, readiness: 'installed_off' },
    external_scanner_api: { enabled: false, readiness: 'installed_off' },
    marketplace: { enabled: false, readiness: 'socket_ready' },
    multi_seller: { enabled: false, readiness: 'socket_ready' }
  };
}
function getProfile() {
  ensurePlatform();
  const row = one("SELECT config_json,name FROM platform_businesses WHERE id='primary'");
  return { ...defaultProfile(), ...(safeJson(row?.config_json, {}) || {}), business_name: safeJson(row?.config_json, {})?.business_name || row?.name || 'Pouches Vic' };
}
function getModules() {
  ensurePlatform();
  const out = {};
  for (const r of all('SELECT * FROM platform_modules ORDER BY module_key')) {
    out[r.module_key] = { enabled: !!r.enabled, readiness: r.readiness, config: safeJson(r.config_json, {}) || {} };
  }
  return out;
}
function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(v).toLowerCase()); }
function validHttpUrl(v) { try { const u = new URL(text(v)); return ['http:','https:'].includes(u.protocol) && !!u.hostname; } catch { return false; } }
function socialMasterEnabled() { return !!one("SELECT show_social_links FROM platform_display_config WHERE id='primary'")?.show_social_links; }
function allSocialLinks() { return all('SELECT * FROM platform_social_links ORDER BY sort_order,id').map(x => ({ ...x, enabled: !!x.enabled })); }
function publicSocialLinks() {
  if (!socialMasterEnabled()) return [];
  return allSocialLinks().filter(x => x.enabled && validHttpUrl(x.url)).map(x => ({ id:x.id, platform:x.platform, label:x.label, url:x.url }));
}
function notificationRecipients() { return all('SELECT * FROM platform_order_notification_recipients ORDER BY sort_order,email').map(x => ({ ...x, enabled: !!x.enabled })); }
function platformConfig() { return { profile: getProfile(), modules: getModules(), integrations: { mapbox_public_token: tableExists('settings') ? (one("SELECT value FROM settings WHERE key='mapbox_public_token'")?.value || '') : '' }, show_social_links: socialMasterEnabled(), social_links: publicSocialLinks() }; }
function adminPlatformConfig() { return { ...platformConfig(), notification_recipients: notificationRecipients(), social_links: allSocialLinks() }; }

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function rememberAdminCookie(setCookie) {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const value of values.filter(Boolean)) {
    const m = String(value).match(/(?:^|;\s*)(?:pv_session|pv_admin_session)=([^;]+)/);
    if (m && m[1]) adminSessions.set(decodeURIComponent(m[1]), Date.now());
  }
}
function adminAuthorized(req) {
  const cookies = parseCookies(req);
  const tok = cookies.pv_session || cookies.pv_admin_session;
  if (!tok) return false;
  const created = adminSessions.get(tok);
  if (!created) return false;
  if (Date.now() - created > ADMIN_SESSION_TTL_MS) { adminSessions.delete(tok); return false; }
  return true;
}
function forgetAdmin(req) {
  const cookies = parseCookies(req);
  const tok = cookies.pv_session || cookies.pv_admin_session;
  if (tok) adminSessions.delete(tok);
}

function send(res, code, value, type = 'application/json; charset=utf-8', headers = {}) {
  const body = type.startsWith('application/json') ? JSON.stringify(value) : String(value);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.setEncoding('utf8');
    req.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > limit) { reject(new Error('Request too large')); req.destroy(); } else data += chunk; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function injectHtml(file, scriptPath) {
  const p = path.join(__dirname, file);
  let html = fs.readFileSync(p, 'utf8');
  if (scriptPath && !html.includes(scriptPath)) {
    const scriptFile=path.join(__dirname,scriptPath.replace(/^\//,'')),version=fs.existsSync(scriptFile)?Math.trunc(fs.statSync(scriptFile).mtimeMs):Date.now();
    html = html.replace('</body>', `<script src="${scriptPath}?v=${version}"></script></body>`);
  }
  return html;
}
function serveFile(res, file, type) {
  const p = path.join(__dirname, file);
  if (!fs.existsSync(p)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  send(res, 200, fs.readFileSync(p, 'utf8'), type);
}

function saveConfig(body) {
  ensurePlatform();
  const current = getProfile();
  const next = { ...current, ...(body.profile || {}) };
  const allowedProfile = {
    generic_business_mode: !!next.generic_business_mode,
    business_name: text(next.business_name) || 'Business',
    business_tagline: text(next.business_tagline),
    hero_title: text(next.hero_title),
    shop_button: text(next.shop_button),
    service_label: text(next.service_label),
    product_group_label: text(next.product_group_label) || 'GROUP',
    product_name_label: text(next.product_name_label) || 'PRODUCT',
    variant_label: text(next.variant_label) || 'VARIANT',
    item_singular: text(next.item_singular) || 'item',
    item_plural: text(next.item_plural) || 'items',
    entry_age_gate_enabled: next.entry_age_gate_enabled !== false,
    entry_age_gate_title: text(next.entry_age_gate_title) || '19+ ONLY',
    entry_age_gate_text: text(next.entry_age_gate_text) || 'You must be 19 or older to enter this site.',
    address_first_enabled: next.address_first_enabled !== false,
    address_autocomplete_enabled: next.address_autocomplete_enabled !== false,
    loyalty_badges_enabled: next.loyalty_badges_enabled !== false,
    age_gate_enabled: next.entry_age_gate_enabled !== false,
    age_acknowledgement_text: text(next.age_acknowledgement_text) || 'I confirm that I have valid ID and meet the legal age requirement for this purchase.'
  };
  run("UPDATE platform_businesses SET name=?,config_json=?,updated_at=? WHERE id='primary'", allowedProfile.business_name, jsonText(allowedProfile), now());
  if (body.integrations && Object.prototype.hasOwnProperty.call(body.integrations, 'mapbox_public_token')) {
    const tok = text(body.integrations.mapbox_public_token);
    run(`INSERT INTO settings(key,value,updated_at) VALUES('mapbox_public_token',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, tok, now());
  }

  const requested = body.modules || {};
  const currentModules = getModules();
  for (const [key, value] of Object.entries(requested)) {
    if (!currentModules[key]) continue;
    // Marketplace and multi-seller are intentionally socket-ready, not activatable yet.
    if (['marketplace','multi_seller'].includes(key)) continue;
    run('UPDATE platform_modules SET enabled=?,config_json=?,updated_at=? WHERE module_key=?',
      bool(value?.enabled), jsonText(value?.config || currentModules[key].config || {}), now(), key);
  }
  if (Array.isArray(body.notification_recipients)) {
    const seen = new Set(), keep = [];
    body.notification_recipients.forEach((x, index) => {
      const email = text(x.email).toLowerCase();
      if (!validEmail(email)) throw new Error(`Invalid notification email: ${email || '(blank)'}`);
      if (seen.has(email)) throw new Error(`Duplicate notification email: ${email}`);
      seen.add(email);
      const rid = text(x.id) || id(), t = now(); keep.push(rid);
      if (one('SELECT 1 FROM platform_order_notification_recipients WHERE id=?', rid)) run('UPDATE platform_order_notification_recipients SET email=?,enabled=?,sort_order=?,updated_at=? WHERE id=?', email,bool(x.enabled),index,t,rid);
      else run('INSERT INTO platform_order_notification_recipients(id,email,enabled,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)', rid,email,bool(x.enabled),index,t,t);
    });
    const existing = all('SELECT id FROM platform_order_notification_recipients');
    for (const row of existing) if (!keep.includes(row.id)) run('DELETE FROM platform_order_notification_recipients WHERE id=?', row.id);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'show_social_links')) {
    run("UPDATE platform_display_config SET show_social_links=?,updated_at=? WHERE id='primary'", bool(body.show_social_links), now());
  }
  if (Array.isArray(body.social_links)) {
    const allowed = new Set(['facebook','instagram','tiktok','x','youtube','custom']), keep = [];
    body.social_links.forEach((x, index) => {
      const platform = allowed.has(text(x.platform).toLowerCase()) ? text(x.platform).toLowerCase() : 'custom';
      const url = text(x.url), label = text(x.label) || (platform === 'x' ? 'X' : platform[0].toUpperCase()+platform.slice(1));
      if (url && !validHttpUrl(url)) throw new Error(`Invalid social URL for ${label}`);
      const sid = text(x.id) || id(), t = now(); keep.push(sid);
      if (one('SELECT 1 FROM platform_social_links WHERE id=?', sid)) run('UPDATE platform_social_links SET platform=?,label=?,url=?,enabled=?,sort_order=?,updated_at=? WHERE id=?', platform,label,url,bool(x.enabled),index,t,sid);
      else run('INSERT INTO platform_social_links(id,platform,label,url,enabled,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', sid,platform,label,url,bool(x.enabled),index,t,t);
    });
    const existing = all('SELECT id FROM platform_social_links');
    for (const row of existing) if (!keep.includes(row.id)) run('DELETE FROM platform_social_links WHERE id=?', row.id);
  }
  return adminPlatformConfig();
}

function ensureTerritoryProduct(territoryId, productId) {
  let tp = one('SELECT * FROM territory_products WHERE territory_id=? AND product_id=?', territoryId, productId);
  if (!tp) {
    const t = now();
    run(`INSERT INTO territory_products(id,territory_id,product_id,inventory,listed,featured,local_price_override,local_price_override_cents,sort_order,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`, id(), territoryId, productId, 0, 0, 0, null, null, 0, t);
    tp = one('SELECT * FROM territory_products WHERE territory_id=? AND product_id=?', territoryId, productId);
  }
  return tp;
}
function productByBarcode(barcode, territoryId = '') {
  ensurePlatform();
  const code = text(barcode);
  if (!code) return null;
  const p = one(`SELECT * FROM products WHERE barcode=? AND active=1 AND archived=0 ORDER BY updated_at DESC LIMIT 1`, code);
  if (!p) return null;
  const tp = territoryId ? ensureTerritoryProduct(territoryId, p.id) : null;
  return { ...p, inventory: tp?.inventory ?? null, listed: tp ? !!tp.listed : null, territory_id: territoryId || null };
}
function receiveByBarcode({ barcode, territory_id, qty, note = '', created_by_role = 'admin' }) {
  ensurePlatform();
  const q = Math.max(1, int(qty, 1));
  const tid = text(territory_id);
  const p = productByBarcode(barcode, tid);
  if (!p) return { found: false, barcode: text(barcode) };
  const tx = openDb().transaction(() => {
    const tp = ensureTerritoryProduct(tid, p.id);
    const balance = int(tp.inventory) + q;
    run('UPDATE territory_products SET inventory=?,updated_at=? WHERE territory_id=? AND product_id=?', balance, now(), tid, p.id);
    run(`INSERT INTO inventory_movements(id,territory_id,product_id,order_id,driver_id,movement_type,qty_delta,balance_after,note,created_by_role,created_by_driver_id,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id(), tid, p.id, null, null, 'barcode_receive', q, balance, text(note) || `Barcode receive ${text(barcode)}`, created_by_role, null, now());
    return balance;
  });
  const balance = tx();
  return { found: true, product: productByBarcode(barcode, tid), received: q, balance };
}
function createProductFromBarcode(body) {
  ensurePlatform();
  const barcode = text(body.barcode);
  if (!barcode) throw new Error('Barcode is required');
  if (one('SELECT 1 FROM products WHERE barcode=? AND active=1 AND archived=0', barcode)) throw new Error('That barcode is already assigned');
  const name = text(body.name);
  if (!name) throw new Error('Product name is required');
  const category = text(body.category) || 'Product';
  const variant = text(body.variant);
  const pid = id(), t = now();
  run(`INSERT INTO products(id,brand,flavor,strength,image,notes,active,archived,created_at,updated_at,generic_name,category,variant,sku,barcode,barcode_format,unit_label,business_id,seller_id,attributes_json)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      pid, category, name, variant, text(body.image), text(body.notes), 1, 0, t, t,
      name, category, variant, text(body.sku), barcode, text(body.barcode_format), text(body.unit_label), 'primary', body.seller_id || null, jsonText(body.attributes || {}));
  const tid = text(body.territory_id);
  if (tid) {
    ensureTerritoryProduct(tid, pid);
    if (body.listed != null) run('UPDATE territory_products SET listed=?,updated_at=? WHERE territory_id=? AND product_id=?', bool(body.listed), now(), tid, pid);
    const starting = Math.max(0, int(body.starting_stock));
    if (starting) receiveByBarcode({ barcode, territory_id: tid, qty: starting, note: 'Starting stock from barcode setup' });
  }
  return productByBarcode(barcode, tid);
}
function assignBarcode(body) {
  ensurePlatform();
  const pid = text(body.product_id), barcode = text(body.barcode);
  if (!pid || !barcode) throw new Error('Product and barcode are required');
  const conflict = one('SELECT id FROM products WHERE barcode=? AND id<>? AND active=1 AND archived=0', barcode, pid);
  if (conflict) throw new Error('That barcode is already assigned to another product');
  run(`UPDATE products SET barcode=?,barcode_format=?,sku=COALESCE(NULLIF(?,''),sku),updated_at=? WHERE id=?`, barcode, text(body.barcode_format), text(body.sku), now(), pid);
  return one('SELECT * FROM products WHERE id=?', pid);
}

function listScannerIntegrations() {
  ensurePlatform();
  return all('SELECT id,name,active,created_at,last_used_at FROM platform_scanner_integrations ORDER BY created_at DESC');
}
function createScannerIntegration(name) {
  ensurePlatform();
  const raw = `pvscan_${token(30)}`;
  const iid = id();
  run('INSERT INTO platform_scanner_integrations(id,name,token_hash,active,created_at,last_used_at) VALUES(?,?,?,?,?,NULL)', iid, text(name) || 'Scanner integration', hash(raw), 1, now());
  return { id: iid, name: text(name) || 'Scanner integration', token: raw };
}
function scannerAuthorized(req) {
  ensurePlatform();
  const auth = String(req.headers.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const row = one('SELECT * FROM platform_scanner_integrations WHERE token_hash=? AND active=1', hash(m[1]));
  if (row) run('UPDATE platform_scanner_integrations SET last_used_at=? WHERE id=?', now(), row.id);
  return row || null;
}

function photoPolicy() {
  ensurePlatform();
  const m = getModules().order_photos || {};
  const c = m.config || {};
  return {
    enabled: m.enabled !== false,
    max_photos_per_order: Math.max(1, Math.min(20, int(c.max_photos_per_order, 8))),
    driver_can_delete: c.driver_can_delete !== false,
    require_pickup_before_on_the_way: !!c.require_pickup_before_on_the_way,
    require_delivery_before_completed: !!c.require_delivery_before_completed,
    storage_provider: text(c.storage_provider) || 'local'
  };
}
function coreDriverFromCookie(req) {
  return new Promise(resolve => {
    const cookie = String(req.headers.cookie || '');
    if (!cookie.includes('pv_driver_session=')) return resolve(null);
    const r = http.request({ hostname: '127.0.0.1', port: PORT, path: '/api/driver/bootstrap', method: 'GET', headers: { Cookie: cookie, Accept: 'application/json' } }, rr => {
      let data = '';
      rr.setEncoding('utf8');
      rr.on('data', c => data += c);
      rr.on('end', () => {
        if (rr.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(data)?.driver || null); } catch { resolve(null); }
      });
    });
    r.on('error', () => resolve(null));
    r.setTimeout(4000, () => { r.destroy(); resolve(null); });
    r.end();
  });
}
function safePhotoRow(row) {
  if (!row) return null;
  return {
    id: row.id, order_id: row.order_id, territory_id: row.territory_id, driver_id: row.driver_id,
    stage: row.stage, caption: row.caption, mime_type: row.mime_type, size_bytes: row.size_bytes,
    status: row.status, created_at: row.created_at, updated_at: row.updated_at, archived_at: row.archived_at,
    content_url: `/api/platform/photos/${encodeURIComponent(row.id)}/content`
  };
}
function listOrderPhotos(orderId, { includeArchived = false } = {}) {
  ensurePlatform();
  const statuses = includeArchived ? "('active','archived')" : "('active')";
  return all(`SELECT * FROM platform_order_photos WHERE order_id=? AND status IN ${statuses} ORDER BY created_at DESC`, orderId).map(safePhotoRow);
}
function photoFilePath(row) {
  const key = text(row?.storage_key);
  if (!key || key.includes('..') || path.isAbsolute(key)) throw new Error('Invalid photo storage key');
  const full = path.join(PHOTO_DIR, key);
  const root = path.resolve(PHOTO_DIR) + path.sep;
  if (!path.resolve(full).startsWith(root)) throw new Error('Invalid photo storage path');
  return full;
}
function parseImageDataUrl(value) {
  const m = String(value || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!m) throw new Error('Photo must be a JPEG, PNG, or WebP image');
  const buf = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buf.length) throw new Error('Photo is empty');
  if (buf.length > MAX_PHOTO_BYTES) throw new Error('Photo is too large after compression');
  return { mime: m[1].toLowerCase(), buffer: buf };
}
function addPhotoEvent(orderId, message, data, driverId = null) {
  if (!tableExists('order_events')) return;
  run(`INSERT INTO order_events(id,order_id,event_type,message,data_json,attention,reviewed,pinned,visible_to_customer,created_by_role,created_by_driver_id,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id(), orderId, 'order_photo', message, jsonText(data || {}), 0, 0, 0, 0, driverId ? 'driver' : 'admin', driverId, now());
}
function createOrderPhoto(order, driver, body) {
  const policy = photoPolicy();
  if (!policy.enabled) throw new Error('Order photos are switched off');
  const activeCount = int(one("SELECT COUNT(*) c FROM platform_order_photos WHERE order_id=? AND status='active'", order.id)?.c);
  if (activeCount >= policy.max_photos_per_order) throw new Error(`This order already has the maximum of ${policy.max_photos_per_order} photos`);
  const stage = ['general','pickup','delivery'].includes(text(body.stage)) ? text(body.stage) : 'general';
  const img = parseImageDataUrl(body.image_data_url);
  const pid = id();
  const ext = img.mime === 'image/png' ? 'png' : img.mime === 'image/webp' ? 'webp' : 'jpg';
  const storageKey = `${order.id}/${pid}.${ext}`;
  const row = { id: pid, storage_key: storageKey };
  const full = photoFilePath(row);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, img.buffer, { flag: 'wx' });
  const t = now();
  try {
    run(`INSERT INTO platform_order_photos(id,order_id,territory_id,driver_id,stage,caption,storage_provider,storage_key,mime_type,size_bytes,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, pid, order.id, order.territory_id, driver.id, stage, text(body.caption), 'local', storageKey, img.mime, img.buffer.length, 'active', t, t);
  } catch (e) { try { fs.unlinkSync(full); } catch {} throw e; }
  addPhotoEvent(order.id, `Driver added ${stage} photo`, { photo_id: pid, stage }, driver.id);
  return safePhotoRow(one('SELECT * FROM platform_order_photos WHERE id=?', pid));
}
function deletePhotoFile(row) { try { const full = photoFilePath(row); if (fs.existsSync(full)) fs.unlinkSync(full); } catch {} }
function adminPhotoAction(photoId, action) {
  const row = one('SELECT * FROM platform_order_photos WHERE id=?', photoId);
  if (!row) throw new Error('Photo not found');
  const t = now();
  if (action === 'archive') run("UPDATE platform_order_photos SET status='archived',archived_at=?,updated_at=? WHERE id=?", t, t, photoId);
  else if (action === 'restore') run("UPDATE platform_order_photos SET status='active',archived_at=NULL,updated_at=? WHERE id=?", t, photoId);
  else if (action === 'delete') { deletePhotoFile(row); run("UPDATE platform_order_photos SET status='deleted',deleted_at=?,updated_at=? WHERE id=?", t, t, photoId); }
  else throw new Error('Unknown photo action');
  addPhotoEvent(row.order_id, `Admin ${action}d order photo`, { photo_id: photoId, action });
  return { ok: true };
}
function photoRequirementState(orderId) {
  const p = photoPolicy();
  const rows = listOrderPhotos(orderId);
  return {
    policy: p,
    pickup_count: rows.filter(x => x.stage === 'pickup').length,
    delivery_count: rows.filter(x => x.stage === 'delivery').length,
    general_count: rows.filter(x => x.stage === 'general').length
  };
}
async function authorizePhotoContent(req, row) {
  if (adminAuthorized(req)) return true;
  const driver = await coreDriverFromCookie(req);
  if (!driver) return false;
  const order = one('SELECT assigned_driver_id FROM orders WHERE id=?', row.order_id);
  return order?.assigned_driver_id === driver.id;
}

function sendDriverUpdatePush(orderId, summary) {
  ensurePlatform();
  const order = one('SELECT * FROM orders WHERE id=?', orderId);
  if (!order?.assigned_driver_id) return Promise.resolve({ sent: 0 });
  const pub = one("SELECT value FROM settings WHERE key='webpush_vapid_public'")?.value || '';
  const priv = one("SELECT value FROM settings WHERE key='webpush_vapid_private'")?.value || '';
  if (!pub || !priv || !tableExists('push_subscriptions')) return Promise.resolve({ sent: 0 });
  webpush.setVapidDetails(PUBLIC_BASE_URL, pub, priv);
  const subs = all('SELECT * FROM push_subscriptions WHERE driver_id=?', order.assigned_driver_id);
  const payload = JSON.stringify({
    title: `ORDER #${order.order_no} UPDATED`,
    body: summary || 'Delivery information changed. Open the order for the latest instructions.',
    order_id: order.id,
    order_no: order.order_no,
    url: `/driver?order=${encodeURIComponent(order.id)}`
  });
  return Promise.all(subs.map(async row => {
    const sub = safeJson(row.subscription_json, null);
    if (!sub) return false;
    try { await webpush.sendNotification(sub, payload, { TTL: 60 * 60, urgency: 'high' }); return true; }
    catch (e) {
      if ([404,410].includes(int(e.statusCode))) run('DELETE FROM push_subscriptions WHERE id=?', row.id);
      else console.error('Support update push failed:', e.message);
      return false;
    }
  })).then(x => ({ sent: x.filter(Boolean).length }));
}
function supportOrder(orderId) {
  ensurePlatform();
  const o = one(`SELECT o.*,d.name driver_name,d.phone driver_phone,d.customer_contact_number driver_customer_contact_number
                 FROM orders o LEFT JOIN drivers d ON d.id=o.assigned_driver_id WHERE o.id=?`, orderId);
  if (!o) return null;
  o.support_events = all(`SELECT id,event_type,message,data_json,created_by_role,created_at
                          FROM order_events WHERE order_id=? AND event_type='support_update' ORDER BY created_at DESC LIMIT 20`, orderId)
    .map(e => ({ ...e, data: safeJson(e.data_json, {}) }));
  return o;
}
async function applySupportUpdate(orderId, body) {
  ensurePlatform();
  const before = supportOrder(orderId);
  if (!before) throw new Error('Order not found');
  const address = body.address === undefined ? before.address : text(body.address);
  const deliveryNotes = body.delivery_notes === undefined ? before.delivery_notes : text(body.delivery_notes);
  const supportNote = text(body.support_note);
  const changes = {};
  if (address !== before.address) changes.address = { from: before.address, to: address };
  if (deliveryNotes !== before.delivery_notes) changes.delivery_notes = { from: before.delivery_notes, to: deliveryNotes };
  if (supportNote) changes.support_note = supportNote;
  if (!Object.keys(changes).length) return { order: before, changed: false, push: { sent: 0 } };
  const t = now();
  openDb().transaction(() => {
    run('UPDATE orders SET address=?,delivery_notes=?,support_updated_at=?,updated_at=? WHERE id=?', address, deliveryNotes, t, t, orderId);
    run(`INSERT INTO order_events(id,order_id,event_type,message,data_json,attention,reviewed,pinned,visible_to_customer,created_by_role,created_by_driver_id,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, id(), orderId, 'support_update', supportNote || 'Customer support updated delivery information', jsonText(changes), 1, 0, 1, 0, 'admin', null, t);
  })();
  const parts = [];
  if (changes.address) parts.push('address');
  if (changes.delivery_notes) parts.push('delivery instructions');
  const summary = parts.length ? `${parts.join(' and ')} updated. Open the order for the latest details.` : 'Customer support added an order update.';
  const push = body.notify_driver === false ? { sent: 0 } : await sendDriverUpdatePush(orderId, summary);
  return { order: supportOrder(orderId), changed: true, push };
}

function genericProductList() {
  ensurePlatform();
  return all(`SELECT id,brand,flavor,strength,generic_name,category,variant,sku,barcode,barcode_format,unit_label,archived
              FROM products WHERE active=1 AND archived=0 ORDER BY brand,flavor`);
}

// ---------- Accountless customers, delivery exceptions, storefront controls ----------
function normalizePhoneKey(v) {
  const digits = text(v).replace(/\D/g, '');
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
}
function normalizeEmailKey(v) { return text(v).toLowerCase(); }
function normalizeAddressKey(v) {
  return text(v).toLowerCase().replace(/\b(canada|bc|british columbia)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function normalizeNameKey(v) { return text(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function normalizeStreetKey(v) {
  let first = text(v).split(',')[0].toLowerCase();
  first = first.replace(/^\s*(?:unit\s+[a-z0-9-]+\s+|#\s*[a-z0-9-]+\s+)?/i, '');
  first = first.replace(/^\s*\d+[a-z]?[-/]?\d*[a-z]?\s+/i, '');
  return first.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function customerPublicBadge(c, previousOrders) {
  if (!c) return null;
  const stars = Math.max(0, Math.min(5, int(c.loyalty_stars)));
  const label = text(c.loyalty_label) || (stars ? 'Loyal Customer' : 'Returning Customer');
  return { returning_customer: previousOrders > 0, previous_order_count: Math.max(0, int(previousOrders)), order_count: Math.max(0, int(previousOrders)) + 1, loyalty_stars: stars, loyalty_label: label, admin_confirmed: !!c.admin_confirmed };
}
function findCustomer(contact = {}) {
  ensurePlatform();
  const phone = normalizePhoneKey(contact.customer_phone ?? contact.phone);
  const email = normalizeEmailKey(contact.customer_email ?? contact.email);
  const address = normalizeAddressKey(contact.address);
  const name = normalizeNameKey(contact.customer_name ?? contact.name);
  let c = null;
  if (phone && phone.length >= 7) c = one('SELECT * FROM platform_customers WHERE archived_at IS NULL AND normalized_phone=? ORDER BY admin_confirmed DESC,updated_at DESC LIMIT 1', phone);
  if (!c && email) c = one('SELECT * FROM platform_customers WHERE archived_at IS NULL AND normalized_email=? ORDER BY admin_confirmed DESC,updated_at DESC LIMIT 1', email);
  if (!c && address && name) c = one('SELECT * FROM platform_customers WHERE archived_at IS NULL AND normalized_address=? AND lower(display_name)=? ORDER BY admin_confirmed DESC,updated_at DESC LIMIT 1', address, text(contact.customer_name ?? contact.name).toLowerCase());
  return c;
}
function createCustomerFromContact(contact = {}) {
  const cid = id(), t = now();
  run(`INSERT INTO platform_customers(id,display_name,phone,email,address,normalized_phone,normalized_email,normalized_address,loyalty_stars,loyalty_label,admin_confirmed,created_at,updated_at,last_order_at)
       VALUES(?,?,?,?,?,?,?,?,0,'',0,?,?,NULL)`, cid, text(contact.customer_name ?? contact.name), text(contact.customer_phone ?? contact.phone), text(contact.customer_email ?? contact.email), text(contact.address), normalizePhoneKey(contact.customer_phone ?? contact.phone), normalizeEmailKey(contact.customer_email ?? contact.email), normalizeAddressKey(contact.address), t, t);
  return one('SELECT * FROM platform_customers WHERE id=?', cid);
}
function ensureCustomerForOrder(orderId) {
  ensurePlatform();
  const existingLink = one('SELECT customer_id FROM platform_customer_orders WHERE order_id=?', orderId);
  if (existingLink) return one('SELECT * FROM platform_customers WHERE id=?', existingLink.customer_id);
  const o = one('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) return null;
  let c = findCustomer(o) || createCustomerFromContact(o);
  const prior = int(one('SELECT COUNT(*) c FROM platform_customer_orders WHERE customer_id=?', c.id)?.c);
  const t = now();
  run('INSERT OR IGNORE INTO platform_customer_orders(order_id,customer_id,territory_id,created_at) VALUES(?,?,?,?)', o.id, c.id, o.territory_id, o.created_at || t);
  run(`UPDATE platform_customers SET display_name=?,phone=?,email=?,address=?,normalized_phone=?,normalized_email=?,normalized_address=?,updated_at=?,last_order_at=? WHERE id=?`,
    text(o.customer_name) || c.display_name, text(o.customer_phone) || c.phone, text(o.customer_email) || c.email, text(o.address) || c.address,
    normalizePhoneKey(o.customer_phone) || c.normalized_phone, normalizeEmailKey(o.customer_email) || c.normalized_email, normalizeAddressKey(o.address) || c.normalized_address,
    t, o.created_at || t, c.id);
  c = one('SELECT * FROM platform_customers WHERE id=?', c.id);
  return { ...c, _previous_order_count: prior };
}
function backfillExistingCustomers() {
  if (!tableExists('platform_customer_orders') || !tableExists('orders')) return;
  const rows = all(`SELECT id FROM orders WHERE id NOT IN (SELECT order_id FROM platform_customer_orders) AND (COALESCE(customer_phone,'')<>'' OR COALESCE(customer_email,'')<>'' OR COALESCE(address,'')<>'') ORDER BY created_at`);
  for (const r of rows) ensureCustomerForOrder(r.id);
}
function linkOrderToCustomer(orderId) {
  const c = ensureCustomerForOrder(orderId);
  if (!c) return null;
  const count = int(one('SELECT COUNT(*) c FROM platform_customer_orders WHERE customer_id=?', c.id)?.c);
  const previous = Math.max(0, count - 1);
  return { customer: c, ...customerPublicBadge(c, previous) };
}
function customerSummaryForOrder(orderId, { includeNotes = false } = {}) {
  let c = ensureCustomerForOrder(orderId);
  if (!c) return { recognized: false, returning_customer: false, previous_order_count: 0, order_count: 1, notes: [] };
  if (c._previous_order_count != null) c = one('SELECT * FROM platform_customers WHERE id=?', c.id);
  const count = int(one('SELECT COUNT(*) c FROM platform_customer_orders WHERE customer_id=?', c.id)?.c);
  const current = one('SELECT created_at FROM platform_customer_orders WHERE order_id=?', orderId);
  const before = current ? int(one('SELECT COUNT(*) c FROM platform_customer_orders WHERE customer_id=? AND created_at<?', c.id, current.created_at)?.c) : Math.max(0, count - 1);
  const badge = customerPublicBadge(c, before) || {};
  const result = { recognized: true, customer_id: c.id, display_name: c.display_name, ...badge, order_count: count };
  if (includeNotes) result.notes = all(`SELECT n.id,n.order_id,n.note,n.created_by_role,n.created_by_driver_id,n.created_at,d.name driver_name
    FROM platform_customer_notes n LEFT JOIN drivers d ON d.id=n.created_by_driver_id
    WHERE n.customer_id=? AND n.archived=0 ORDER BY n.created_at DESC LIMIT 12`, c.id);
  return result;
}
function addCustomerNote(customerId, orderId, note, role, driverId = null) {
  const body = text(note);
  if (!body) throw new Error('Write a short customer note first');
  const nid = id();
  run('INSERT INTO platform_customer_notes(id,customer_id,order_id,note,created_by_role,created_by_driver_id,archived,created_at) VALUES(?,?,?,?,?,?,0,?)', nid, customerId, orderId || null, body, role || 'admin', driverId || null, now());
  return one('SELECT * FROM platform_customer_notes WHERE id=?', nid);
}
function ensureTerritoryConfig(territoryId) {
  let r = one('SELECT * FROM platform_territory_config WHERE territory_id=?', territoryId);
  if (!r) {
    run(`INSERT INTO platform_territory_config(territory_id,announcement_enabled,announcement_text,help_enabled,help_heading,help_text,help_contact,help_contact_action,updated_at)
         VALUES(?,0,'',0,'Need help?','','','sms',?)`, territoryId, now());
    r = one('SELECT * FROM platform_territory_config WHERE territory_id=?', territoryId);
  }
  return r;
}
function publicTerritoryPlatform(slug) {
  const terr = one('SELECT id,name,slug FROM territories WHERE slug=? AND active=1 AND archived=0', text(slug));
  if (!terr) return null;
  const cfg = ensureTerritoryConfig(terr.id);
  const modules = getModules();
  const ratings = modules.product_ratings?.enabled ? all(`SELECT r.product_id,r.rating,r.review_count FROM platform_product_ratings r
    JOIN territory_products tp ON tp.product_id=r.product_id WHERE tp.territory_id=? AND r.enabled=1 AND tp.listed=1`, terr.id) : [];
  return { territory: terr, storefront: { announcement_enabled: !!cfg.announcement_enabled, announcement_text: cfg.announcement_text, help_enabled: !!cfg.help_enabled, help_heading: cfg.help_heading, help_text: cfg.help_text, help_contact: cfg.help_contact, help_contact_action: cfg.help_contact_action }, ratings };
}
function saveTerritoryPlatform(territoryId, b) {
  if (!one('SELECT 1 FROM territories WHERE id=?', territoryId)) throw new Error('City not found');
  ensureTerritoryConfig(territoryId);
  const action = ['sms','tel','none'].includes(text(b.help_contact_action)) ? text(b.help_contact_action) : 'sms';
  run(`UPDATE platform_territory_config SET announcement_enabled=?,announcement_text=?,help_enabled=?,help_heading=?,help_text=?,help_contact=?,help_contact_action=?,updated_at=? WHERE territory_id=?`,
    bool(b.announcement_enabled), text(b.announcement_text), bool(b.help_enabled), text(b.help_heading) || 'Need help?', text(b.help_text), text(b.help_contact), action, now(), territoryId);
  return publicTerritoryPlatform(one('SELECT slug FROM territories WHERE id=?', territoryId).slug);
}
function pointInRingPlatform(point, ring) {
  const [x,y] = point; let inside = false;
  for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const xi=Number(ring[i][0]), yi=Number(ring[i][1]), xj=Number(ring[j][0]), yj=Number(ring[j][1]);
    const hit=((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||Number.EPSILON)+xi);
    if(hit) inside=!inside;
  }
  return inside;
}
function pointInGeoJSONPlatform(lng, lat, value) {
  const g = typeof value === 'string' ? safeJson(value, null) : value;
  const geom = g?.type === 'Feature' ? g.geometry : g;
  const point = [Number(lng), Number(lat)];
  const polygon = poly => Array.isArray(poly) && poly.length && pointInRingPlatform(point, poly[0]) && !poly.slice(1).some(r=>pointInRingPlatform(point,r));
  if (geom?.type === 'Polygon') return polygon(geom.coordinates);
  if (geom?.type === 'MultiPolygon') return geom.coordinates.some(p=>polygon(p));
  return false;
}
function naturalZone(territoryId, lng, lat) {
  if (!Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))) return null;
  return all('SELECT * FROM delivery_zones WHERE territory_id=? AND active=1 ORDER BY sort_order,name', territoryId)
    .find(z => text(z.geojson) && pointInGeoJSONPlatform(Number(lng), Number(lat), z.geojson)) || null;
}
function matchingZoneOverride(territoryId, contact = {}) {
  if (!getModules().delivery_zone_overrides?.enabled) return null;
  const customer = findCustomer(contact);
  if (customer) {
    const byCustomer = one(`SELECT z.*,d.name zone_name,d.color_label,d.fee_cents zone_fee_cents,d.fee zone_fee,d.free_at_qty
      FROM platform_zone_overrides z JOIN delivery_zones d ON d.id=z.zone_id
      WHERE z.territory_id=? AND z.active=1 AND z.match_type='customer' AND z.customer_id=? ORDER BY z.updated_at DESC LIMIT 1`, territoryId, customer.id);
    if (byCustomer) return byCustomer;
  }
  const addr = normalizeAddressKey(contact.address);
  if (addr) {
    const exact = one(`SELECT z.*,d.name zone_name,d.color_label,d.fee_cents zone_fee_cents,d.fee zone_fee,d.free_at_qty
      FROM platform_zone_overrides z JOIN delivery_zones d ON d.id=z.zone_id
      WHERE z.territory_id=? AND z.active=1 AND z.match_type='address' AND z.match_value=? ORDER BY z.updated_at DESC LIMIT 1`, territoryId, addr);
    if (exact) return exact;
  }
  const street = normalizeStreetKey(contact.address);
  if (street) {
    const streetMatch = one(`SELECT z.*,d.name zone_name,d.color_label,d.fee_cents zone_fee_cents,d.fee zone_fee,d.free_at_qty
      FROM platform_zone_overrides z JOIN delivery_zones d ON d.id=z.zone_id
      WHERE z.territory_id=? AND z.active=1 AND z.match_type='street' AND z.match_value=? ORDER BY z.updated_at DESC LIMIT 1`, territoryId, street);
    if (streetMatch) return streetMatch;
  }
  return null;
}
function resolveDeliveryQuote(body) {
  const terr = one('SELECT * FROM territories WHERE slug=? AND active=1 AND archived=0', text(body.territory_slug) || 'victoria');
  if (!terr) throw new Error('Delivery area unavailable');
  const override = matchingZoneOverride(terr.id, body);
  let zone = null;
  if (override) zone = one('SELECT * FROM delivery_zones WHERE id=? AND territory_id=? AND active=1', override.zone_id, terr.id);
  if (!zone && body.lng != null && body.lat != null) zone = naturalZone(terr.id, body.lng, body.lat);
  if (!zone) return { territory: { id: terr.id, name: terr.name, slug: terr.slug }, serviceable: false, zone: null, override: null };
  const baseFee = int(zone.fee_cents ?? Math.round(Number(zone.fee || 0) * 100));
  const feeOverride = override && override.fee_cents != null ? int(override.fee_cents) : null;
  const qty = Array.isArray(body.items) ? body.items.reduce((sum,x)=>sum+Math.max(0,int(x.qty ?? x.quantity ?? x.q)),0) : Math.max(0,int(body.qty));
  let finalFee = baseFee, reason = '';
  if (feeOverride != null) {
    finalFee = Math.max(0,feeOverride);
    if (finalFee < baseFee) reason = text(override.note) || 'VIP Customer Discount';
  } else if (text(zone.name).toLowerCase() === 'green' && qty >= 10) {
    finalFee = 0;
    reason = '10+ Can Delivery Reward';
  }
  const savings = Math.max(0,baseFee-finalFee);
  return {
    territory: { id: terr.id, name: terr.name, slug: terr.slug }, serviceable: true,
    zone: { id: zone.id, name: zone.name, color_label: zone.color_label, fee_cents: finalFee, base_fee_cents: baseFee, delivery_savings_cents: savings, delivery_discount_reason: savings ? reason : '', free_at_qty: text(zone.name).toLowerCase() === 'green' ? 10 : null },
    override: override ? { id: override.id, applied: true, fee_cents: feeOverride, note: text(override.note) } : null
  };
}
function corePublicPost(pathname, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body || {});
    const q = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'POST', headers: { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(raw), 'X-PV-Platform-Internal':'1' } }, r => {
      let data=''; r.setEncoding('utf8'); r.on('data', c=>data+=c); r.on('end',()=>{
        let parsed={}; try{parsed=data?JSON.parse(data):{};}catch{parsed={error:data||'Core request failed'};}
        resolve({ status:r.statusCode || 500, body:parsed });
      });
    });
    q.on('error', reject); q.end(raw);
  });
}
async function createPublicPlatformOrder(body) {
  if (!body.age_acknowledged) throw new Error('ID / age acknowledgement is required');
  const quote = resolveDeliveryQuote(body);
  if (!quote.serviceable) throw new Error('That address is outside the current delivery area');
  const trusted = { ...body, zone_id: quote.zone.id };
  delete trusted.delivery_fee; delete trusted.delivery_fee_cents;
  if (body.lat != null && body.lng != null) { trusted.address_lat = Number(body.lat); trusted.address_lng = Number(body.lng); }
  trusted.delivery_fee_cents = int(quote.zone.fee_cents);
  trusted.delivery_discount_reason = text(quote.zone.delivery_discount_reason);
  if (quote.override?.applied) trusted.zone_override_note = `Saved delivery exception${quote.override.note ? ': '+quote.override.note : ''}`;
  const core = await corePublicPost('/api/public/orders', trusted);
  if (core.status < 200 || core.status >= 300) return core;
  const linked = linkOrderToCustomer(core.body.id);
  if (text(body.fulfillment_type) && one('SELECT 1 FROM orders WHERE id=?', core.body.id)) run('UPDATE orders SET fulfillment_type=?,updated_at=? WHERE id=?', text(body.fulfillment_type), now(), core.body.id);
  return { status: core.status, body: { ...core.body, customer_status: linked ? { returning_customer: linked.returning_customer, previous_order_count: linked.previous_order_count, order_count: linked.order_count } : null, delivery_override_applied: !!quote.override?.applied } };
}
function saveZoneOverride(territoryId, b) {
  const type = ['address','street','customer'].includes(text(b.match_type)) ? text(b.match_type) : 'address';
  const zone = one('SELECT id FROM delivery_zones WHERE id=? AND territory_id=? AND active=1', text(b.zone_id), territoryId);
  if (!zone) throw new Error('Choose a valid delivery zone');
  let customerId = null, value = '';
  if (type === 'customer') {
    customerId = text(b.customer_id);
    if (!customerId || !one('SELECT 1 FROM platform_customers WHERE id=?', customerId)) throw new Error('Choose a customer');
  } else {
    if (!text(b.match_value)) throw new Error(type === 'street' ? 'Enter the street' : 'Enter the exact address');
    value = type === 'street' ? normalizeStreetKey(b.match_value) : normalizeAddressKey(b.match_value);
  }
  const oid = text(b.id) || id(), t = now();
  const fee = b.fee_cents === '' || b.fee_cents == null ? null : Math.max(0, int(b.fee_cents));
  if (one('SELECT 1 FROM platform_zone_overrides WHERE id=?', oid)) {
    run(`UPDATE platform_zone_overrides SET match_type=?,match_value=?,customer_id=?,zone_id=?,fee_cents=?,note=?,active=?,updated_at=? WHERE id=? AND territory_id=?`, type,value,customerId,text(b.zone_id),fee,text(b.note),bool(b.active ?? true),t,oid,territoryId);
  } else {
    run(`INSERT INTO platform_zone_overrides(id,territory_id,match_type,match_value,customer_id,zone_id,fee_cents,note,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, oid,territoryId,type,value,customerId,text(b.zone_id),fee,text(b.note),bool(b.active ?? true),t,t);
  }
  return one(`SELECT z.*,d.name zone_name,c.display_name customer_name,c.phone customer_phone FROM platform_zone_overrides z JOIN delivery_zones d ON d.id=z.zone_id LEFT JOIN platform_customers c ON c.id=z.customer_id WHERE z.id=?`, oid);
}
function listZoneOverrides(territoryId) {
  return all(`SELECT z.*,d.name zone_name,c.display_name customer_name,c.phone customer_phone FROM platform_zone_overrides z JOIN delivery_zones d ON d.id=z.zone_id LEFT JOIN platform_customers c ON c.id=z.customer_id WHERE z.territory_id=? ORDER BY z.active DESC,z.updated_at DESC`, territoryId);
}
function customerAdminList(territoryId = '', q = '') {
  backfillExistingCustomers();
  const query = `%${text(q).toLowerCase()}%`;
  let rows = all(`SELECT c.*,(SELECT COUNT(*) FROM platform_customer_orders co WHERE co.customer_id=c.id) order_count,
    (SELECT MAX(o.created_at) FROM platform_customer_orders co JOIN orders o ON o.id=co.order_id WHERE co.customer_id=c.id) last_order
    FROM platform_customers c
    WHERE c.archived_at IS NULL AND (?='' OR lower(c.display_name) LIKE ? OR lower(c.phone) LIKE ? OR lower(c.email) LIKE ? OR lower(c.address) LIKE ?)
    ORDER BY COALESCE(last_order,c.updated_at) DESC LIMIT 250`, text(q), query, query, query, query);
  if (territoryId) rows = rows.filter(c => !!one(`SELECT 1 FROM platform_customer_orders co WHERE co.customer_id=? AND co.territory_id=? LIMIT 1`, c.id, territoryId));
  return rows;
}
function customerAdminDetail(customerId) {
  const c = one('SELECT * FROM platform_customers WHERE id=?', customerId);
  if (!c) return null;
  return { ...c,
    order_count: int(one('SELECT COUNT(*) c FROM platform_customer_orders WHERE customer_id=?', customerId)?.c),
    orders: all(`SELECT o.id,o.order_no,o.territory_id,o.status,o.total_cents,o.address,o.created_at FROM platform_customer_orders co JOIN orders o ON o.id=co.order_id WHERE co.customer_id=? ORDER BY o.created_at DESC LIMIT 50`, customerId),
    notes: all(`SELECT n.*,d.name driver_name FROM platform_customer_notes n LEFT JOIN drivers d ON d.id=n.created_by_driver_id WHERE n.customer_id=? AND n.archived=0 ORDER BY n.created_at DESC LIMIT 50`, customerId)
  };
}
function updateCustomer(customerId, b) {
  const c = one('SELECT * FROM platform_customers WHERE id=?', customerId); if (!c) throw new Error('Customer not found');
  const name = b.display_name === undefined ? c.display_name : text(b.display_name), phone = b.phone === undefined ? c.phone : text(b.phone), email = b.email === undefined ? c.email : text(b.email), address = b.address === undefined ? c.address : text(b.address);
  run(`UPDATE platform_customers SET display_name=?,phone=?,email=?,address=?,normalized_phone=?,normalized_email=?,normalized_address=?,loyalty_stars=?,loyalty_label=?,admin_confirmed=?,updated_at=? WHERE id=?`,
    name,phone,email,address,normalizePhoneKey(phone),normalizeEmailKey(email),normalizeAddressKey(address),Math.max(0,Math.min(5,int(b.loyalty_stars ?? c.loyalty_stars))),text(b.loyalty_label ?? c.loyalty_label),bool(b.admin_confirmed ?? c.admin_confirmed),now(),customerId);
  return customerAdminDetail(customerId);
}
function archiveCustomer(customerId) {
  const c = one('SELECT * FROM platform_customers WHERE id=?', customerId);
  if (!c) throw new Error('Customer not found');
  if (!c.archived_at) run('UPDATE platform_customers SET archived_at=?,updated_at=? WHERE id=?', now(), now(), customerId);
  return { ok:true, archived:true, customer_id:customerId };
}
function mergeCustomers(targetId, sourceId) {
  if (targetId === sourceId) throw new Error('Choose two different customer records');
  const target = one('SELECT * FROM platform_customers WHERE id=?', targetId), source = one('SELECT * FROM platform_customers WHERE id=?', sourceId);
  if (!target || !source) throw new Error('Customer record not found');
  openDb().transaction(()=>{
    run('UPDATE platform_customer_orders SET customer_id=? WHERE customer_id=?', targetId,sourceId);
    run('UPDATE platform_customer_notes SET customer_id=? WHERE customer_id=?', targetId,sourceId);
    run("UPDATE platform_zone_overrides SET customer_id=? WHERE customer_id=? AND match_type='customer'", targetId,sourceId);
    run('DELETE FROM platform_customers WHERE id=?', sourceId);
  })();
  return customerAdminDetail(targetId);
}
function saveProductRating(productId, b) {
  if (!one('SELECT 1 FROM products WHERE id=?', productId)) throw new Error('Product not found');
  const rating = Math.max(1, Math.min(5, Number(b.rating) || 5));
  const count = Math.max(0, int(b.review_count));
  const enabled=b.enabled===undefined?1:bool(b.enabled);
  run(`INSERT INTO platform_product_ratings(product_id,enabled,rating,review_count,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET enabled=excluded.enabled,rating=excluded.rating,review_count=excluded.review_count,updated_at=excluded.updated_at`, productId,enabled,rating,count,now());
  if(enabled) run("UPDATE platform_modules SET enabled=1,updated_at=? WHERE module_key='product_ratings'",now());
  return one('SELECT * FROM platform_product_ratings WHERE product_id=?', productId);
}

function businessOrderNotificationHtml(order) {
  const items = all('SELECT * FROM order_items WHERE order_id=? ORDER BY rowid', order.id);
  const money = cents => new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD'}).format((Number(cents)||0)/100);
  const itemRows = items.map(x => `<tr><td style="padding:8px 0;border-bottom:1px solid #ddd">${int(x.qty)} × ${escapeHtml(x.brand_snapshot)} ${escapeHtml(x.product_name_snapshot)}${x.strength_snapshot?` • ${escapeHtml(displayStrength(x.strength_snapshot))}`:''}</td><td style="padding:8px 0;border-bottom:1px solid #ddd;text-align:right">${money(x.line_total_cents)}</td></tr>`).join('');
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#171717"><div style="max-width:640px;margin:auto"><h1>New order #${escapeHtml(order.order_no)}</h1><p><b>Status:</b> ${escapeHtml(order.status)}<br><b>Placed:</b> ${escapeHtml(order.created_at)}<br><b>Source:</b> ${escapeHtml(order.source)}</p><h2>Customer</h2><p><b>${escapeHtml(order.customer_name||'Customer')}</b><br>${escapeHtml(order.customer_phone||'')}${order.customer_email?`<br>${escapeHtml(order.customer_email)}`:''}</p><p><b>Delivery address</b><br>${escapeHtml(order.address||'')}</p>${order.delivery_notes?`<p><b>Delivery instructions</b><br>${escapeHtml(order.delivery_notes)}</p>`:''}${order.delivery_window_label?`<p><b>Delivery window:</b> ${escapeHtml(order.delivery_window_label)}</p>`:''}<table style="width:100%;border-collapse:collapse">${itemRows}<tr><td style="padding-top:12px">Products</td><td style="padding-top:12px;text-align:right">${money(order.subtotal_cents)}</td></tr><tr><td>Delivery${order.zone_name_snapshot?` • ${escapeHtml(order.zone_name_snapshot)}`:''}</td><td style="text-align:right">${money(order.delivery_fee_cents)}</td></tr>${int(order.customer_discount_cents)>0?`<tr><td>Discount</td><td style="text-align:right">−${money(order.customer_discount_cents)}</td></tr>`:''}<tr><td style="font-size:18px;font-weight:bold;padding-top:9px">TOTAL</td><td style="font-size:18px;font-weight:bold;padding-top:9px;text-align:right">${money(order.total_cents)}</td></tr></table><p><b>Payment:</b> ${escapeHtml(order.payment_method||'Not specified')}${order.payment_note?`<br>${escapeHtml(order.payment_note)}`:''}</p><p><a href="${PUBLIC_BASE_URL}/admin">Open Control Room</a></p></div></body></html>`;
}
async function sendBusinessNewOrderNotifications(orderId) {
  if (!ensurePlatform()) return { sent:0, skipped:0 };
  const order = one('SELECT * FROM orders WHERE id=?', orderId);
  if (!order) return { sent:0, skipped:0 };
  const recipients = notificationRecipients().filter(x => x.enabled && validEmail(x.email));
  let sent = 0, skipped = 0;
  for (const recipient of recipients) {
    const deliveryId = id(), attempted = now();
    const inserted = run(`INSERT OR IGNORE INTO platform_order_notification_deliveries(id,order_id,recipient_id,email,status,attempted_at,sent_at,error) VALUES(?,?,?,?,?, ?,NULL,'')`, deliveryId,order.id,recipient.id,recipient.email,'pending',attempted);
    if (!inserted.changes) { skipped++; continue; }
    if (!RESEND_API_KEY || !ORDER_EMAIL_FROM) {
      run("UPDATE platform_order_notification_deliveries SET status='not_configured',error=? WHERE id=?", 'RESEND_API_KEY or ORDER_EMAIL_FROM missing', deliveryId);
      continue;
    }
    try {
      const response = await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:ORDER_EMAIL_FROM,to:[recipient.email],subject:`New PouchesVic order #${order.order_no}`,html:businessOrderNotificationHtml(order),...(ORDER_EMAIL_REPLY_TO?{reply_to:ORDER_EMAIL_REPLY_TO}:{})})});
      if (!response.ok) throw new Error(`Email provider returned ${response.status}: ${(await response.text()).slice(0,300)}`);
      run("UPDATE platform_order_notification_deliveries SET status='sent',sent_at=?,error='' WHERE id=?", now(), deliveryId); sent++;
    } catch (e) {
      run("UPDATE platform_order_notification_deliveries SET status='failed',error=? WHERE id=?", text(e.message).slice(0,500), deliveryId);
      console.error(`Business order notification failed for ${recipient.email}:`, e.message);
    }
  }
  return { sent, skipped };
}

// Core invokes this hook only from successful order-creation routes. Delivery rows make
// repeated calls idempotent; later status/payment updates never invoke this hook.
globalThis.pvNotifyNewOrder = sendBusinessNewOrderNotifications;

// ---------- Boss-first settlement periods ----------
function openSettlementPeriod(territoryId, driverId) {
  let p=one("SELECT * FROM platform_settlement_periods WHERE territory_id=? AND driver_id=? AND status='open' ORDER BY started_at DESC LIMIT 1",territoryId,driverId);
  if(p)return p;
  const last=one("SELECT closed_at FROM platform_settlement_periods WHERE territory_id=? AND driver_id=? AND status='closed' ORDER BY closed_at DESC LIMIT 1",territoryId,driverId),t=now(),pid=id();
  run("INSERT INTO platform_settlement_periods(id,territory_id,driver_id,started_at,status,created_at,updated_at) VALUES(?,?,?,?,'open',?,?)",pid,territoryId,driverId,last?.closed_at||t,t,t);
  return one('SELECT * FROM platform_settlement_periods WHERE id=?',pid);
}
function platformOrderQty(orderId){return int(one('SELECT COALESCE(SUM(qty),0) q FROM order_items WHERE order_id=?',orderId)?.q);}
function platformSettlementEntries(orders){
  const entries=[];
  for(const o of orders){
    const qty=platformOrderQty(o.id),rules=all('SELECT * FROM settlement_rules WHERE territory_id=? AND active=1 AND archived=0 ORDER BY sort_order',o.territory_id);
    for(const r of rules){
      let amount=0,targetType='',targetDriver=null,entryType='';const rate=int(r.amount_cents);
      if(r.rule_type==='per_can_driver_to_boss'&&r.from_driver_id===o.assigned_driver_id){amount=qty*rate;targetType='boss';entryType='per_can_to_boss';}
      else if(r.rule_type==='per_can_driver_to_driver'&&r.from_driver_id===o.assigned_driver_id){amount=qty*rate;targetType='driver';targetDriver=r.to_driver_id;entryType='per_can_to_driver';}
      else if(r.rule_type==='zone_fee_driver_to_driver'&&r.from_driver_id===o.assigned_driver_id&&r.zone_id===o.zone_id){amount=Math.min(rate,int(o.delivery_fee_cents));targetType='driver';targetDriver=r.to_driver_id;entryType='zone_fee_to_driver';}
      else if(r.rule_type==='zone_fee_to_driver'&&r.zone_id===o.zone_id&&r.to_driver_id){amount=rate===0?int(o.delivery_fee_cents):Math.min(rate,int(o.delivery_fee_cents));targetType='driver';targetDriver=r.to_driver_id;entryType='zone_fee_to_driver';}
      if(amount>0)entries.push({order_id:o.id,territory_id:o.territory_id,source_driver_id:o.assigned_driver_id,target_type:targetType,target_driver_id:targetDriver,entry_type:entryType,qty,rate_cents:rate,amount_cents:amount,rule_name:r.name});
    }
  }
  return entries;
}
function settlementPeriodReport(period) {
  const end=period.status==='closed'?(period.ended_at||period.closed_at):now(),driver=one('SELECT id,name FROM drivers WHERE id=?',period.driver_id);
  const orders=all("SELECT * FROM orders WHERE territory_id=? AND assigned_driver_id=? AND status='completed' AND completed_at>=? AND completed_at<=? ORDER BY completed_at",period.territory_id,period.driver_id,period.started_at,end);
  const ids=orders.map(x=>x.id),ph=ids.map(()=>'?').join(','),tx=all('SELECT * FROM platform_settlement_transactions WHERE period_id=? ORDER BY created_at',period.id);
  const entries=platformSettlementEntries(orders);
  const pays=ids.length?all(`SELECT * FROM payments WHERE order_id IN (${ph}) AND status='received'`,...ids):[];
  const webQty=orders.filter(o=>o.source==='web').reduce((s,o)=>s+platformOrderQty(o.id),0),offsiteOrderQty=orders.filter(o=>o.source!=='web').reduce((s,o)=>s+platformOrderQty(o.id),0);
  const manualOffsite=tx.filter(x=>x.kind==='offsite_sale').reduce((s,x)=>s+int(x.qty),0),selfQty=tx.filter(x=>x.kind==='taken_for_self').reduce((s,x)=>s+int(x.qty),0),otherQty=tx.filter(x=>x.kind==='other_adjustment').reduce((s,x)=>s+int(x.qty),0);
  const accountable=webQty+offsiteOrderQty+manualOffsite+selfQty+otherQty;
  const bossOrderShare=entries.filter(x=>x.source_driver_id===period.driver_id&&x.target_type==='boss').reduce((s,x)=>s+int(x.amount_cents),0);
  const bossRate=int(one("SELECT amount_cents FROM settlement_rules WHERE territory_id=? AND from_driver_id=? AND rule_type='per_can_driver_to_boss' AND active=1 AND archived=0 ORDER BY sort_order LIMIT 1",period.territory_id,period.driver_id)?.amount_cents);
  const manualBossShare=(manualOffsite+selfQty+otherQty)*bossRate,bossShare=bossOrderShare+manualBossShare;
  const confirmedBossPayments=pays.filter(x=>x.method==='etransfer'&&x.destination_type==='boss').reduce((s,x)=>s+int(x.amount_cents),0),manualBossCredits=tx.filter(x=>x.kind==='boss_credit').reduce((s,x)=>s+int(x.amount_cents),0),bossCredit=confirmedBossPayments+manualBossCredits;
  const netBossDue=bossShare-bossCredit,sendToBoss=Math.max(0,netBossDue),bossOwesDriver=Math.max(0,-netBossDue),cashInHand=pays.filter(x=>x.method==='cash'&&x.destination_type==='driver'&&(!x.destination_driver_id||x.destination_driver_id===period.driver_id)).reduce((s,x)=>s+int(x.amount_cents),0)+tx.filter(x=>x.kind==='cash_collected').reduce((s,x)=>s+int(x.amount_cents),0);
  const owesDrivers=entries.filter(x=>x.source_driver_id===period.driver_id&&x.target_type==='driver').reduce((s,x)=>s+int(x.amount_cents),0),receivesDrivers=entries.filter(x=>x.target_driver_id===period.driver_id&&x.source_driver_id!==period.driver_id).reduce((s,x)=>s+int(x.amount_cents),0),driverKeeps=cashInHand+bossOwesDriver+receivesDrivers-sendToBoss-owesDrivers;
  const deliveryFees=orders.reduce((s,o)=>s+int(o.delivery_fee_cents),0),tips=orders.reduce((s,o)=>s+int(o.tip_cents),0),driverTips=orders.filter(o=>o.tip_recipient_type!=='other_driver'&&(!o.tip_recipient_driver_id||o.tip_recipient_driver_id===period.driver_id)).reduce((s,o)=>s+int(o.tip_cents),0);
  const starting=period.starting_inventory==null?null:int(period.starting_inventory),expected=starting==null?null:starting-accountable,actual=period.actual_ending_inventory==null?null:int(period.actual_ending_inventory);
  return {period:{...period},driver,closed:period.status==='closed',started_at:period.started_at,ended_at:end,sold_website:webQty,sold_off_website:offsiteOrderQty+manualOffsite,taken_for_self:selfQty,other_adjustments:otherQty,accountable_items:accountable,boss_rate_cents:bossRate,boss_share_before_credits_cents:bossShare,boss_credit_cents:bossCredit,send_to_boss_cents:sendToBoss,boss_owes_driver_cents:bossOwesDriver,cash_in_driver_hands_cents:cashInHand,driver_keeps_cents:driverKeeps,owes_other_drivers_cents:owesDrivers,receives_from_drivers_cents:receivesDrivers,delivery_fees_cents:deliveryFees,tips_cents:tips,driver_tips_cents:driverTips,starting_inventory:starting,expected_ending_inventory:expected,actual_ending_inventory:actual,variance:actual==null||expected==null?null:actual-expected,orders:orders.map(o=>({id:o.id,order_no:o.order_no,source:o.source,qty:platformOrderQty(o.id),completed_at:o.completed_at,total_cents:o.total_cents,delivery_fee_cents:o.delivery_fee_cents,tip_cents:o.tip_cents})),payments:pays,transactions:tx,entries};
}
function settlementDashboard(territoryId){const drivers=all('SELECT id,name,role FROM drivers WHERE territory_id=? AND active=1 AND archived=0 ORDER BY name',territoryId);return{drivers:drivers.map(d=>settlementPeriodReport(openSettlementPeriod(territoryId,d.id))),history:all("SELECT p.*,d.name driver_name FROM platform_settlement_periods p JOIN drivers d ON d.id=p.driver_id WHERE p.territory_id=? AND p.status='closed' ORDER BY p.closed_at DESC LIMIT 100",territoryId).map(x=>({...x,snapshot:safeJson(x.snapshot_json,{})}))};}
function closeSettlementPeriod(periodId,body){const p=one("SELECT * FROM platform_settlement_periods WHERE id=? AND status='open'",periodId);if(!p)throw new Error('Open settlement not found');if(body.actual_ending_inventory!==undefined)run('UPDATE platform_settlement_periods SET actual_ending_inventory=?,updated_at=? WHERE id=?',int(body.actual_ending_inventory),now(),periodId);const fresh=one('SELECT * FROM platform_settlement_periods WHERE id=?',periodId),snap=settlementPeriodReport(fresh),t=now();run("UPDATE platform_settlement_periods SET status='closed',ended_at=?,closed_at=?,snapshot_json=?,updated_at=? WHERE id=?",t,t,jsonText({...snap,closed:true}),t,periodId);run("INSERT INTO platform_settlement_audit(id,period_id,action,reason,snapshot_json,created_at) VALUES(?,?,'closed',?,?,?)",id(),periodId,text(body.reason)||'Settlement closed',jsonText(snap),t);return{...snap,closed:true};}
function reopenSettlementPeriod(periodId,reason){const why=text(reason);if(!why)throw new Error('A reason is required to reopen a settlement');const p=one("SELECT * FROM platform_settlement_periods WHERE id=? AND status='closed'",periodId);if(!p)throw new Error('Closed settlement not found');if(one("SELECT 1 FROM platform_settlement_periods WHERE territory_id=? AND driver_id=? AND status='open'",p.territory_id,p.driver_id))throw new Error('Close the current open period before reopening this one');const t=now();run("UPDATE platform_settlement_periods SET status='open',ended_at=NULL,closed_at=NULL,reopened_at=?,updated_at=? WHERE id=?",t,t,periodId);run("INSERT INTO platform_settlement_audit(id,period_id,action,reason,snapshot_json,created_at) VALUES(?,?,'reopened',?,?,?)",id(),periodId,why,p.snapshot_json,t);return settlementPeriodReport(one('SELECT * FROM platform_settlement_periods WHERE id=?',periodId));}

async function handlePlatform(req, res, url) {
  if (!ensurePlatform()) return send(res, 503, { error: 'Platform extension is still starting' });

  if (url.pathname === '/api/platform/public/config' && req.method === 'GET') {
    return send(res, 200, platformConfig());
  }
  const publicTerritoryUi = url.pathname.match(/^\/api\/platform\/public\/territory\/([^/]+)$/);
  if (publicTerritoryUi && req.method === 'GET') {
    const x = publicTerritoryPlatform(decodeURIComponent(publicTerritoryUi[1]));
    return x ? send(res, 200, x) : send(res, 404, { error: 'City unavailable' });
  }
  if (url.pathname === '/api/platform/public/delivery-quote' && req.method === 'POST') {
    return send(res, 200, resolveDeliveryQuote(await readBody(req)));
  }
  if (url.pathname === '/api/platform/public/orders' && req.method === 'POST') {
    const result = await createPublicPlatformOrder(await readBody(req));
    return send(res, result.status, result.body);
  }

  const photoContent = url.pathname.match(/^\/api\/platform\/photos\/([^/]+)\/content$/);
  if (photoContent && req.method === 'GET') {
    const row = one('SELECT * FROM platform_order_photos WHERE id=? AND status<>\'deleted\'', decodeURIComponent(photoContent[1]));
    if (!row) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    if (!(await authorizePhotoContent(req, row))) return send(res, 401, 'Unauthorized', 'text/plain; charset=utf-8');
    const full = photoFilePath(row);
    if (!fs.existsSync(full)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'Content-Type': row.mime_type || 'image/jpeg', 'Content-Length': fs.statSync(full).size, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' });
    return fs.createReadStream(full).pipe(res);
  }

  const driverCustomer = url.pathname.match(/^\/api\/driver\/platform\/orders\/([^/]+)\/customer$/);
  if (driverCustomer && req.method === 'GET') {
    const driver = await coreDriverFromCookie(req);
    if (!driver) return send(res, 401, { error: 'Please sign in to the driver app again' });
    const oid = decodeURIComponent(driverCustomer[1]);
    const order = one('SELECT id FROM orders WHERE id=? AND assigned_driver_id=?', oid, driver.id);
    if (!order) return send(res, 404, { error: 'Order not found' });
    return send(res, 200, customerSummaryForOrder(oid, { includeNotes: true }));
  }
  const driverCustomerNote = url.pathname.match(/^\/api\/driver\/platform\/orders\/([^/]+)\/customer-notes$/);
  if (driverCustomerNote && req.method === 'POST') {
    const driver = await coreDriverFromCookie(req);
    if (!driver) return send(res, 401, { error: 'Please sign in to the driver app again' });
    const oid = decodeURIComponent(driverCustomerNote[1]);
    const order = one('SELECT id FROM orders WHERE id=? AND assigned_driver_id=?', oid, driver.id);
    if (!order) return send(res, 404, { error: 'Order not found' });
    const summary = customerSummaryForOrder(oid, { includeNotes: false });
    if (!summary.customer_id) throw new Error('Customer record unavailable');
    const b = await readBody(req); addCustomerNote(summary.customer_id, oid, b.note, 'driver', driver.id);
    return send(res, 201, customerSummaryForOrder(oid, { includeNotes: true }));
  }

  const driverPhotos = url.pathname.match(/^\/api\/driver\/platform\/orders\/([^/]+)\/photos$/);
  if (driverPhotos) {
    const driver = await coreDriverFromCookie(req);
    if (!driver) return send(res, 401, { error: 'Please sign in to the driver app again' });
    const oid = decodeURIComponent(driverPhotos[1]);
    const order = one('SELECT * FROM orders WHERE id=? AND assigned_driver_id=?', oid, driver.id);
    if (!order) return send(res, 404, { error: 'Order not found' });
    if (req.method === 'GET') return send(res, 200, { photos: listOrderPhotos(oid), ...photoRequirementState(oid) });
    if (req.method === 'POST') return send(res, 201, createOrderPhoto(order, driver, await readBody(req, 8 * 1024 * 1024)));
  }
  const driverPhotoDelete = url.pathname.match(/^\/api\/driver\/platform\/photos\/([^/]+)$/);
  if (driverPhotoDelete && req.method === 'DELETE') {
    const driver = await coreDriverFromCookie(req);
    if (!driver) return send(res, 401, { error: 'Please sign in to the driver app again' });
    const row = one('SELECT p.*,o.assigned_driver_id FROM platform_order_photos p JOIN orders o ON o.id=p.order_id WHERE p.id=?', decodeURIComponent(driverPhotoDelete[1]));
    if (!row || row.assigned_driver_id !== driver.id || row.driver_id !== driver.id || row.status !== 'active') return send(res, 404, { error: 'Photo not found' });
    if (!photoPolicy().driver_can_delete) return send(res, 403, { error: 'Driver photo deletion is switched off by Admin' });
    deletePhotoFile(row);
    const t = now();
    run("UPDATE platform_order_photos SET status='deleted',deleted_at=?,updated_at=? WHERE id=?", t, t, row.id);
    addPhotoEvent(row.order_id, 'Driver deleted order photo', { photo_id: row.id }, driver.id);
    return send(res, 200, { ok: true });
  }

  // External scanner/webhook API. Disabled until Boss creates a token and turns it on.
  if (url.pathname === '/api/platform/scanner/receive' && req.method === 'POST') {
    const modules = getModules();
    if (!modules.external_scanner_api?.enabled) return send(res, 403, { error: 'External scanner API is switched off' });
    const integration = scannerAuthorized(req);
    if (!integration) return send(res, 401, { error: 'Invalid scanner token' });
    const body = await readBody(req);
    const result = receiveByBarcode({ ...body, created_by_role: 'scanner_api', note: text(body.note) || `External scanner: ${integration.name}` });
    return send(res, result.found ? 200 : 404, result.found ? result : { ...result, error: 'Barcode not registered' });
  }

  if (!url.pathname.startsWith('/api/admin/platform/')) return false;
  if (!adminAuthorized(req)) return send(res, 401, { error: 'Please sign in to the Control Room again' });

  if (url.pathname === '/api/admin/platform/config' && req.method === 'GET') return send(res, 200, adminPlatformConfig());
  if (url.pathname === '/api/admin/platform/config' && req.method === 'PUT') return send(res, 200, saveConfig(await readBody(req)));
  if (url.pathname === '/api/admin/platform/products' && req.method === 'GET') return send(res, 200, genericProductList());

  const terrStorefront = url.pathname.match(/^\/api\/admin\/platform\/territories\/([^/]+)\/storefront$/);
  if (terrStorefront && req.method === 'GET') {
    const tid=decodeURIComponent(terrStorefront[1]),terr=one('SELECT slug FROM territories WHERE id=?',tid); if(!terr)return send(res,404,{error:'City not found'});
    return send(res,200,publicTerritoryPlatform(terr.slug));
  }
  if (terrStorefront && req.method === 'PUT') return send(res,200,saveTerritoryPlatform(decodeURIComponent(terrStorefront[1]),await readBody(req)));

  const zoneOverrides = url.pathname.match(/^\/api\/admin\/platform\/territories\/([^/]+)\/zone-overrides$/);
  if (zoneOverrides && req.method === 'GET') return send(res,200,listZoneOverrides(decodeURIComponent(zoneOverrides[1])));
  if (zoneOverrides && req.method === 'POST') return send(res,201,saveZoneOverride(decodeURIComponent(zoneOverrides[1]),await readBody(req)));
  const zoneOverride = url.pathname.match(/^\/api\/admin\/platform\/zone-overrides\/([^/]+)$/);
  if (zoneOverride && req.method === 'DELETE') { run('DELETE FROM platform_zone_overrides WHERE id=?',decodeURIComponent(zoneOverride[1])); return send(res,200,{ok:true}); }

  if (url.pathname === '/api/admin/platform/customers' && req.method === 'GET') return send(res,200,customerAdminList(text(url.searchParams.get('territory_id')),text(url.searchParams.get('q'))));
  const adminCustomer = url.pathname.match(/^\/api\/admin\/platform\/customers\/([^/]+)$/);
  if (adminCustomer && req.method === 'GET') { const x=customerAdminDetail(decodeURIComponent(adminCustomer[1])); return x?send(res,200,x):send(res,404,{error:'Customer not found'}); }
  if (adminCustomer && req.method === 'PUT') return send(res,200,updateCustomer(decodeURIComponent(adminCustomer[1]),await readBody(req)));
  if (adminCustomer && req.method === 'DELETE') return send(res,200,archiveCustomer(decodeURIComponent(adminCustomer[1])));
  const adminCustomerNote = url.pathname.match(/^\/api\/admin\/platform\/customers\/([^/]+)\/notes$/);
  if (adminCustomerNote && req.method === 'POST') { const cid=decodeURIComponent(adminCustomerNote[1]); if(!one('SELECT 1 FROM platform_customers WHERE id=?',cid))return send(res,404,{error:'Customer not found'}); const b=await readBody(req); addCustomerNote(cid,b.order_id||null,b.note,'admin',null); return send(res,201,customerAdminDetail(cid)); }
  const adminCustomerMerge = url.pathname.match(/^\/api\/admin\/platform\/customers\/([^/]+)\/merge$/);
  if (adminCustomerMerge && req.method === 'POST') { const b=await readBody(req); return send(res,200,mergeCustomers(decodeURIComponent(adminCustomerMerge[1]),text(b.source_customer_id))); }
  const adminCustomerNoteDelete = url.pathname.match(/^\/api\/admin\/platform\/customer-notes\/([^/]+)$/);
  if (adminCustomerNoteDelete && req.method === 'DELETE') { run('UPDATE platform_customer_notes SET archived=1 WHERE id=?',decodeURIComponent(adminCustomerNoteDelete[1])); return send(res,200,{ok:true}); }

  const productRating = url.pathname.match(/^\/api\/admin\/platform\/products\/([^/]+)\/rating$/);
  if (productRating && req.method === 'PUT') return send(res,200,saveProductRating(decodeURIComponent(productRating[1]),await readBody(req)));
  if (productRating && req.method === 'DELETE') { run('DELETE FROM platform_product_ratings WHERE product_id=?',decodeURIComponent(productRating[1])); return send(res,200,{ok:true}); }
  if (url.pathname === '/api/admin/platform/product-ratings' && req.method === 'GET') return send(res,200,all(`SELECT p.id product_id,p.brand,p.flavor,p.strength,r.rating,r.review_count,r.enabled FROM products p LEFT JOIN platform_product_ratings r ON r.product_id=p.id WHERE p.active=1 AND p.archived=0 ORDER BY p.brand,p.flavor`));

  const settlementDash=url.pathname.match(/^\/api\/admin\/platform\/territories\/([^/]+)\/settlements$/);
  if(settlementDash&&req.method==='GET')return send(res,200,settlementDashboard(decodeURIComponent(settlementDash[1])));
  const settlementPeriod=url.pathname.match(/^\/api\/admin\/platform\/settlement-periods\/([^/]+)$/);
  if(settlementPeriod&&req.method==='PUT'){
    const pid=decodeURIComponent(settlementPeriod[1]),p=one("SELECT * FROM platform_settlement_periods WHERE id=? AND status='open'",pid);if(!p)throw new Error('Open settlement not found');const b=await readBody(req);
    run('UPDATE platform_settlement_periods SET starting_inventory=?,actual_ending_inventory=?,updated_at=? WHERE id=?',b.starting_inventory===''||b.starting_inventory==null?null:int(b.starting_inventory),b.actual_ending_inventory===''||b.actual_ending_inventory==null?null:int(b.actual_ending_inventory),now(),pid);return send(res,200,settlementPeriodReport(one('SELECT * FROM platform_settlement_periods WHERE id=?',pid)));
  }
  const settlementTx=url.pathname.match(/^\/api\/admin\/platform\/settlement-periods\/([^/]+)\/transactions$/);
  if(settlementTx&&req.method==='POST'){
    const pid=decodeURIComponent(settlementTx[1]),p=one("SELECT * FROM platform_settlement_periods WHERE id=? AND status='open'",pid);if(!p)throw new Error('Open settlement not found');const b=await readBody(req),allowed=new Set(['offsite_sale','taken_for_self','boss_credit','other_adjustment','cash_collected']);if(!allowed.has(text(b.kind)))throw new Error('Choose a valid settlement entry');if(!text(b.note))throw new Error('A note is required');run('INSERT INTO platform_settlement_transactions(id,period_id,territory_id,driver_id,kind,qty,amount_cents,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)',id(),pid,p.territory_id,p.driver_id,text(b.kind),Math.max(0,int(b.qty)),Math.max(0,int(b.amount_cents)),text(b.note),now());return send(res,201,settlementPeriodReport(p));
  }
  const settlementClose=url.pathname.match(/^\/api\/admin\/platform\/settlement-periods\/([^/]+)\/close$/);
  if(settlementClose&&req.method==='POST')return send(res,200,closeSettlementPeriod(decodeURIComponent(settlementClose[1]),await readBody(req)));
  const settlementReopen=url.pathname.match(/^\/api\/admin\/platform\/settlement-periods\/([^/]+)\/reopen$/);
  if(settlementReopen&&req.method==='POST'){const b=await readBody(req);return send(res,200,reopenSettlementPeriod(decodeURIComponent(settlementReopen[1]),b.reason));}

  const adminOrderCustomer = url.pathname.match(/^\/api\/admin\/platform\/orders\/([^/]+)\/customer$/);
  if (adminOrderCustomer && req.method === 'GET') { const oid=decodeURIComponent(adminOrderCustomer[1]); if(!one('SELECT 1 FROM orders WHERE id=?',oid))return send(res,404,{error:'Order not found'}); return send(res,200,customerSummaryForOrder(oid,{includeNotes:true})); }

  const lookup = url.pathname.match(/^\/api\/admin\/platform\/barcode\/lookup\/([^/]+)$/);
  if (lookup && req.method === 'GET') {
    const tid = text(url.searchParams.get('territory_id'));
    const p = productByBarcode(decodeURIComponent(lookup[1]), tid);
    return p ? send(res, 200, { found: true, product: p }) : send(res, 200, { found: false, barcode: decodeURIComponent(lookup[1]) });
  }
  if (url.pathname === '/api/admin/platform/barcode/assign' && req.method === 'POST') return send(res, 200, assignBarcode(await readBody(req)));
  if (url.pathname === '/api/admin/platform/barcode/create' && req.method === 'POST') return send(res, 201, createProductFromBarcode(await readBody(req)));
  if (url.pathname === '/api/admin/platform/barcode/receive' && req.method === 'POST') {
    const result = receiveByBarcode(await readBody(req));
    return send(res, result.found ? 200 : 404, result.found ? result : { ...result, error: 'Barcode not registered' });
  }

  if (url.pathname === '/api/admin/platform/scanner-integrations' && req.method === 'GET') return send(res, 200, listScannerIntegrations());
  if (url.pathname === '/api/admin/platform/scanner-integrations' && req.method === 'POST') {
    const body = await readBody(req); return send(res, 201, createScannerIntegration(body.name));
  }
  const scannerDelete = url.pathname.match(/^\/api\/admin\/platform\/scanner-integrations\/([^/]+)$/);
  if (scannerDelete && req.method === 'DELETE') {
    run('UPDATE platform_scanner_integrations SET active=0 WHERE id=?', decodeURIComponent(scannerDelete[1]));
    return send(res, 200, { ok: true });
  }

  const adminPhotos = url.pathname.match(/^\/api\/admin\/platform\/orders\/([^/]+)\/photos$/);
  if (adminPhotos && req.method === 'GET') {
    const oid = decodeURIComponent(adminPhotos[1]);
    if (!one('SELECT 1 FROM orders WHERE id=?', oid)) return send(res, 404, { error: 'Order not found' });
    return send(res, 200, { photos: listOrderPhotos(oid, { includeArchived: true }), ...photoRequirementState(oid) });
  }
  const adminPhoto = url.pathname.match(/^\/api\/admin\/platform\/photos\/([^/]+)$/);
  if (adminPhoto && req.method === 'PUT') {
    const b = await readBody(req); return send(res, 200, adminPhotoAction(decodeURIComponent(adminPhoto[1]), text(b.action)));
  }

  const support = url.pathname.match(/^\/api\/admin\/platform\/orders\/([^/]+)\/support$/);
  if (support && req.method === 'GET') {
    const o = supportOrder(decodeURIComponent(support[1]));
    return o ? send(res, 200, o) : send(res, 404, { error: 'Order not found' });
  }
  if (support && req.method === 'PUT') {
    return send(res, 200, await applySupportUpdate(decodeURIComponent(support[1]), await readBody(req)));
  }

  return send(res, 404, { error: 'Not found' });
}

// Keep server-generated new-order push wording business-neutral when generic mode is enabled.
const originalSendNotification = webpush.sendNotification.bind(webpush);
webpush.sendNotification = async function(subscription, payload, options) {
  try {
    if (payload && ensurePlatform()) {
      const profile = getProfile();
      if (profile.generic_business_mode) {
        const parsed = JSON.parse(payload);
        if (typeof parsed.title === 'string') parsed.title = parsed.title.replace(/Pouches Vic/gi, profile.business_name);
        if (typeof parsed.body === 'string') {
          parsed.body = parsed.body.replace(/\b1 cans\b/gi, `1 ${profile.item_singular}`)
            .replace(/\b(\d+) cans\b/gi, `$1 ${profile.item_plural}`);
        }
        payload = JSON.stringify(parsed);
      }
    }
  } catch {}
  return originalSendNotification(subscription, payload, options);
};

const originalCreateServer = http.createServer.bind(http);
http.createServer = function patchedCreateServer(listener) {
  const wrapped = async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Capture the existing server's successful admin login cookie so platform admin APIs
    // share the same login experience without changing core auth code.
    const originalWriteHead = res.writeHead;
    const originalSetHeader = res.setHeader;
    res.setHeader = function(name, value) {
      if (url.pathname === '/api/admin/login' && String(name).toLowerCase() === 'set-cookie') rememberAdminCookie(value);
      return originalSetHeader.call(this, name, value);
    };
    res.writeHead = function(statusCode, ...args) {
      if (url.pathname === '/api/admin/login' && Number(statusCode) >= 200 && Number(statusCode) < 300) {
        for (const a of args) if (a && typeof a === 'object') rememberAdminCookie(a['Set-Cookie'] || a['set-cookie']);
        try { rememberAdminCookie(res.getHeader('set-cookie')); } catch {}
      }
      return originalWriteHead.call(this, statusCode, ...args);
    };
    if (url.pathname === '/api/admin/logout') forgetAdmin(req);

    try {
      if (req.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin.html')) {
        return send(res, 200, injectHtml('admin.html', '/platform-admin.js'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && (url.pathname === '/driver' || url.pathname === '/driver.html')) {
        return send(res, 200, injectHtml('driver.html', '/platform-driver.js'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/order/'))) {
        return send(res, 200, injectHtml('index.html', '/platform-storefront.js'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/scanner') return serveFile(res, 'scanner.html', 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/platform-admin.js') return serveFile(res, 'platform-admin.js', 'application/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/platform-driver.js') return serveFile(res, 'platform-driver.js', 'application/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/platform-storefront.js') return serveFile(res, 'platform-storefront.js', 'application/javascript; charset=utf-8');

      if (url.pathname.startsWith('/api/platform/') || url.pathname.startsWith('/api/admin/platform/') || url.pathname.startsWith('/api/driver/platform/')) {
        return await handlePlatform(req, res, url);
      }
    } catch (e) {
      console.error('Platform extension error:', e);
      if (!res.headersSent) return send(res, 400, { error: e.message || 'Platform request failed' });
      return res.end();
    }
    return listener(req, res);
  };
  return originalCreateServer(wrapped);
};

// server.js creates the core schema synchronously after this preload returns.
setImmediate(() => {
  try { ensurePlatform(); }
  catch (e) { console.error('Platform extension startup:', e.message); }
});
