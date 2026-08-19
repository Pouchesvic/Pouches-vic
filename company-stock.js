'use strict';

// Additive Company Stock + Product Library layer. The legacy territory_products.inventory
// column remains the compatibility read model for customer-sellable availability.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function createCompanyStock({ db, now, id, text, int, bool, jsonText, safeJson }) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const tableColumns = table => new Set(all(`PRAGMA table_info(${table})`).map(row => row.name));
  const ensureColumn = (table, name, definition) => {
    if (!tableColumns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  const norm = value => text(value).toLowerCase().replace(/\s+/g, ' ');
  const stockColumn = (pool, bucket) => `${pool}_${bucket}_qty`;
  const validPool = pool => ['linked', 'independent'].includes(pool) ? pool : null;
  const activeTerritoryId = () => one('SELECT id FROM territories ORDER BY archived,active DESC,created_at,name LIMIT 1')?.id;
  const setting = (key, fallback = '') => one('SELECT value FROM settings WHERE key=?', key)?.value ?? fallback;
  const setSetting = (key, value) => run(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, key, String(value), now());

  function installSchema() {
    [
      ['products','catalog_key',"TEXT DEFAULT ''"],
      ['products','series',"TEXT DEFAULT ''"],
      ['products','catalog_image',"TEXT DEFAULT ''"],
      ['products','catalog_source_json',"TEXT DEFAULT '{}'"],
      ['products','catalog_seeded_at','TEXT'],
      ['territory_products','linked_sellable_qty','INTEGER NOT NULL DEFAULT 0'],
      ['territory_products','linked_reserved_qty','INTEGER NOT NULL DEFAULT 0'],
      ['territory_products','linked_held_qty','INTEGER NOT NULL DEFAULT 0'],
      ['territory_products','independent_sellable_qty','INTEGER NOT NULL DEFAULT 0'],
      ['territory_products','independent_reserved_qty','INTEGER NOT NULL DEFAULT 0'],
      ['territory_products','independent_held_qty','INTEGER NOT NULL DEFAULT 0'],
      ['territory_products','stock_model_initialized','INTEGER NOT NULL DEFAULT 0'],
      ['orders','inventory_model',"TEXT NOT NULL DEFAULT 'legacy'"],
      ['orders','inventory_finalized','INTEGER NOT NULL DEFAULT 0'],
      ['inventory_movements','scope',"TEXT NOT NULL DEFAULT 'territory'"],
      ['inventory_movements','pool',"TEXT NOT NULL DEFAULT 'legacy'"],
      ['inventory_movements','previous_qty','INTEGER'],
      ['inventory_movements','resulting_qty','INTEGER'],
      ['inventory_movements','related_pool',"TEXT DEFAULT ''"],
      ['inventory_movements','metadata_json',"TEXT DEFAULT '{}'"],
    ].forEach(row => ensureColumn(...row));
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_products_catalog_key
        ON products(catalog_key) WHERE COALESCE(catalog_key,'')<>'';
      CREATE TABLE IF NOT EXISTS company_product_stock(
        product_id TEXT PRIMARY KEY,
        reserve_qty INTEGER NOT NULL DEFAULT 0 CHECK(reserve_qty>=0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS company_stock_brand_policies(
        brand_key TEXT PRIMARY KEY,
        brand_label TEXT NOT NULL,
        linked_default INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS company_stock_product_policies(
        product_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'inherit' CHECK(mode IN ('inherit','linked','independent')),
        updated_at TEXT NOT NULL,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS order_inventory_reservations(
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        order_item_id TEXT NOT NULL,
        territory_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        pool TEXT NOT NULL CHECK(pool IN ('linked','independent')),
        qty INTEGER NOT NULL CHECK(qty>0),
        status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','sold','released')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(order_item_id,pool),
        FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
        FOREIGN KEY(order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
        FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE RESTRICT,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_order_inventory_reservations_order
        ON order_inventory_reservations(order_id,status);
      CREATE INDEX IF NOT EXISTS idx_order_inventory_reservations_stock
        ON order_inventory_reservations(territory_id,product_id,pool,status);
      CREATE INDEX IF NOT EXISTS idx_inventory_movements_scope_pool
        ON inventory_movements(scope,pool,created_at);
    `);
    if (!one("SELECT 1 FROM settings WHERE key='company_stock_default_linked'")) setSetting('company_stock_default_linked', 'true');
  }

  function ensureCompanyProduct(productId) {
    const stamp = now();
    run(`INSERT OR IGNORE INTO company_product_stock(product_id,reserve_qty,created_at,updated_at)
      VALUES(?,0,?,?)`, productId, stamp, stamp);
    return one('SELECT * FROM company_product_stock WHERE product_id=?', productId);
  }

  function ensureTerritoryProduct(territoryId, productId) {
    let row = one('SELECT * FROM territory_products WHERE territory_id=? AND product_id=?', territoryId, productId);
    if (!row) {
      const stamp = now();
      run(`INSERT INTO territory_products(
        id,territory_id,product_id,inventory,listed,featured,local_price_override,local_price_override_cents,sort_order,updated_at,
        linked_sellable_qty,linked_reserved_qty,linked_held_qty,independent_sellable_qty,independent_reserved_qty,independent_held_qty,stock_model_initialized
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id(), territoryId, productId, 0, 0, 0, null, null, 0, stamp, 0, 0, 0, 0, 0, 0, 1);
      row = one('SELECT * FROM territory_products WHERE territory_id=? AND product_id=?', territoryId, productId);
    }
    ensureCompanyProduct(productId);
    return row;
  }

  function syncLegacyInventory(territoryId, productId) {
    const row = one('SELECT * FROM territory_products WHERE territory_id=? AND product_id=?', territoryId, productId);
    if (!row) return 0;
    const available = int(row.linked_sellable_qty) + int(row.independent_sellable_qty);
    run('UPDATE territory_products SET inventory=?,updated_at=? WHERE territory_id=? AND product_id=?', available, now(), territoryId, productId);
    return available;
  }

  function migrateLegacyInventory() {
    const migrate = db.transaction(() => {
      const rows = all('SELECT * FROM territory_products WHERE stock_model_initialized=0 ORDER BY territory_id,product_id');
      for (const row of rows) {
        const openItems = all(`SELECT i.id order_item_id,i.order_id,i.qty,o.created_at
          FROM order_items i JOIN orders o ON o.id=i.order_id
          WHERE o.territory_id=? AND i.product_id=? AND o.inventory_applied=1
            AND o.status NOT IN ('completed','cancelled')
            AND NOT EXISTS(SELECT 1 FROM order_inventory_reservations r WHERE r.order_item_id=i.id)
          ORDER BY o.created_at,i.id`, row.territory_id, row.product_id);
        const reserved = openItems.reduce((sum, item) => sum + Math.max(0, int(item.qty)), 0);
        run(`UPDATE territory_products SET linked_sellable_qty=?,linked_reserved_qty=?,linked_held_qty=0,
          independent_sellable_qty=0,independent_reserved_qty=0,independent_held_qty=0,stock_model_initialized=1,updated_at=?
          WHERE id=?`, Math.max(0, int(row.inventory)), reserved, now(), row.id);
        for (const item of openItems) {
          run(`INSERT OR IGNORE INTO order_inventory_reservations(
            id,order_id,order_item_id,territory_id,product_id,pool,qty,status,created_at,updated_at
          ) VALUES(?,?,?,?,?,'linked',?,'reserved',?,?)`,
            id(), item.order_id, item.order_item_id, row.territory_id, row.product_id, int(item.qty), item.created_at || now(), now());
          run("UPDATE orders SET inventory_model='pooled_v1' WHERE id=?", item.order_id);
        }
        ensureCompanyProduct(row.product_id);
        syncLegacyInventory(row.territory_id, row.product_id);
      }
      for (const product of all('SELECT id FROM products')) ensureCompanyProduct(product.id);
    });
    migrate();
  }

  function seedCatalog() {
    const file = path.join(__dirname, 'product-catalog.json');
    if (!fs.existsSync(file)) return { counts: {}, seeded: 0, matched: 0 };
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const signatureCounts = new Map();
    for (const sku of manifest.products || []) {
      const signature = [norm(sku.brand), norm(sku.flavor), norm(sku.strength)].join('|');
      signatureCounts.set(signature, (signatureCounts.get(signature) || 0) + 1);
    }
    let seeded = 0, matched = 0;
    db.transaction(() => {
      for (const sku of manifest.products || []) {
        let product = one('SELECT * FROM products WHERE catalog_key=?', sku.catalog_key);
        if (product) {
          run(`UPDATE products SET catalog_image=?,catalog_source_json=?,updated_at=? WHERE id=?`,
            sku.local_image, jsonText(sku), product.updated_at || now(), product.id);
        } else {
          const signature = [norm(sku.brand), norm(sku.flavor), norm(sku.strength)].join('|');
          const candidates = all(`SELECT * FROM products WHERE COALESCE(catalog_key,'')=''`).filter(row =>
            norm(row.brand) === norm(sku.brand) && norm(row.flavor) === norm(sku.flavor) && norm(row.strength) === norm(sku.strength));
          if (signatureCounts.get(signature) === 1 && candidates.length === 1) {
            product = candidates[0];
            run(`UPDATE products SET catalog_key=?,series=CASE WHEN COALESCE(series,'')='' THEN ? ELSE series END,
              catalog_image=?,catalog_source_json=?,catalog_seeded_at=?,image=CASE WHEN COALESCE(image,'')='' THEN ? ELSE image END
              WHERE id=?`, sku.catalog_key, sku.series, sku.local_image, jsonText(sku), now(), sku.local_image, product.id);
            matched++;
          } else {
            const productId = `cat_${crypto.createHash('sha256').update(sku.catalog_key).digest('hex').slice(0, 24)}`;
            const stamp = now();
            run(`INSERT INTO products(
              id,brand,flavor,strength,image,notes,active,archived,created_at,updated_at,catalog_key,series,catalog_image,catalog_source_json,catalog_seeded_at
            ) VALUES(?,?,?,?,?,?,1,0,?,?,?,?,?,?,?)`,
              productId, sku.brand, sku.flavor, sku.strength, sku.local_image, sku.notes || '', stamp, stamp,
              sku.catalog_key, sku.series || '', sku.local_image, jsonText(sku), stamp);
            product = one('SELECT * FROM products WHERE id=?', productId);
            seeded++;
          }
        }
        if (!product) product = one('SELECT * FROM products WHERE catalog_key=?', sku.catalog_key);
        ensureCompanyProduct(product.id);
        for (const territory of all('SELECT id FROM territories')) ensureTerritoryProduct(territory.id, product.id);
      }
    })();
    return { counts: manifest.counts || {}, seeded, matched, version: manifest.catalog_version_date };
  }

  function poolPolicy(productId) {
    const product = one('SELECT id,brand FROM products WHERE id=?', productId);
    if (!product) throw new Error('Product not found');
    const override = one('SELECT mode FROM company_stock_product_policies WHERE product_id=?', productId)?.mode || 'inherit';
    if (override !== 'inherit') return { mode: override, source: 'product' };
    const brand = one('SELECT linked_default FROM company_stock_brand_policies WHERE brand_key=?', norm(product.brand));
    if (brand) return { mode: brand.linked_default ? 'linked' : 'independent', source: 'brand' };
    return { mode: setting('company_stock_default_linked', 'true') === 'true' ? 'linked' : 'independent', source: 'system' };
  }

  function recordMovement({ territoryId, productId, orderId = null, driverId = null, movementType, delta, balanceAfter,
    previousQty = null, resultingQty = null, note = '', role = 'system', driverSourceId = null,
    scope = 'territory', pool = 'legacy', relatedPool = '', metadata = {} }) {
    const anchor = territoryId || activeTerritoryId();
    if (!anchor) throw new Error('At least one territory is required for inventory history');
    run(`INSERT INTO inventory_movements(
      id,territory_id,product_id,order_id,driver_id,movement_type,qty_delta,balance_after,note,created_by_role,created_by_driver_id,created_at,
      scope,pool,previous_qty,resulting_qty,related_pool,metadata_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id(), anchor, productId, orderId, driverId, movementType, int(delta), int(balanceAfter), text(note), role, driverSourceId, now(),
      scope, pool, previousQty == null ? null : int(previousQty), resultingQty == null ? null : int(resultingQty), relatedPool, jsonText(metadata));
  }

  function updateBucket(territoryId, productId, pool, bucket, delta, movement) {
    if (!validPool(pool) || !['sellable','reserved','held'].includes(bucket)) throw new Error('Invalid inventory pool');
    const row = ensureTerritoryProduct(territoryId, productId);
    const column = stockColumn(pool, bucket);
    const before = int(row[column]), after = before + int(delta);
    if (after < 0) throw new Error(`Not enough ${pool} ${bucket} stock`);
    run(`UPDATE territory_products SET ${column}=?,updated_at=? WHERE territory_id=? AND product_id=?`, after, now(), territoryId, productId);
    const available = syncLegacyInventory(territoryId, productId);
    recordMovement({ territoryId, productId, delta, balanceAfter: available, previousQty: before, resultingQty: after,
      pool: `${pool}_${bucket}`, ...movement });
    return after;
  }

  function updateReserve(productId, delta, movement) {
    const row = ensureCompanyProduct(productId), before = int(row.reserve_qty), after = before + int(delta);
    if (after < 0) throw new Error('Not enough Company Reserve stock');
    run('UPDATE company_product_stock SET reserve_qty=?,updated_at=? WHERE product_id=?', after, now(), productId);
    recordMovement({ productId, delta, balanceAfter: after, previousQty: before, resultingQty: after,
      scope: 'company', pool: 'company_reserve', ...movement });
    return after;
  }

  function reserveOrderItem({ orderId, orderItemId, territoryId, productId, qty, driverId = null, note = '' }) {
    const requested = Math.max(0, int(qty));
    const row = ensureTerritoryProduct(territoryId, productId);
    if (int(row.linked_sellable_qty) + int(row.independent_sellable_qty) < requested) throw new Error('Not enough customer-sellable inventory');
    let remaining = requested;
    for (const pool of ['linked','independent']) {
      const current = one('SELECT * FROM territory_products WHERE territory_id=? AND product_id=?', territoryId, productId);
      const take = Math.min(remaining, int(current[stockColumn(pool, 'sellable')]));
      if (!take) continue;
      updateBucket(territoryId, productId, pool, 'sellable', -take, {
        movementType: 'order_reservation', orderId, driverId, note, role: 'system', relatedPool: `${pool}_reserved`, metadata: { order_item_id: orderItemId }
      });
      updateBucket(territoryId, productId, pool, 'reserved', take, {
        movementType: 'order_reservation', orderId, driverId, note, role: 'system', relatedPool: `${pool}_sellable`, metadata: { order_item_id: orderItemId }
      });
      const stamp = now();
      run(`INSERT INTO order_inventory_reservations(id,order_id,order_item_id,territory_id,product_id,pool,qty,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'reserved',?,?)`, id(), orderId, orderItemId, territoryId, productId, pool, take, stamp, stamp);
      remaining -= take;
    }
    run("UPDATE orders SET inventory_model='pooled_v1',inventory_finalized=0 WHERE id=?", orderId);
  }

  function releaseOrder(orderId, { role = 'system', driverId = null, note = '' } = {}) {
    const reservations = all("SELECT * FROM order_inventory_reservations WHERE order_id=? AND status='reserved' ORDER BY created_at,id", orderId);
    for (const reservation of reservations) {
      updateBucket(reservation.territory_id, reservation.product_id, reservation.pool, 'reserved', -reservation.qty, {
        movementType: 'order_cancellation_release', orderId, driverId, note, role, relatedPool: `${reservation.pool}_sellable`, metadata: { reservation_id: reservation.id }
      });
      updateBucket(reservation.territory_id, reservation.product_id, reservation.pool, 'sellable', reservation.qty, {
        movementType: 'order_cancellation_release', orderId, driverId, note, role, relatedPool: `${reservation.pool}_reserved`, metadata: { reservation_id: reservation.id }
      });
      run("UPDATE order_inventory_reservations SET status='released',updated_at=? WHERE id=?", now(), reservation.id);
    }
    return reservations.length;
  }

  function finalizeOrder(orderId, { role = 'system', driverId = null } = {}) {
    const order = one('SELECT * FROM orders WHERE id=?', orderId);
    if (!order || order.inventory_finalized) return 0;
    const reservations = all("SELECT * FROM order_inventory_reservations WHERE order_id=? AND status='reserved' ORDER BY created_at,id", orderId);
    for (const reservation of reservations) {
      updateBucket(reservation.territory_id, reservation.product_id, reservation.pool, 'reserved', -reservation.qty, {
        movementType: 'completed_sale', orderId, driverId, note: `Completed order #${order.order_no}`, role,
        metadata: { reservation_id: reservation.id }
      });
      run("UPDATE order_inventory_reservations SET status='sold',updated_at=? WHERE id=?", now(), reservation.id);
    }
    run('UPDATE orders SET inventory_finalized=1 WHERE id=?', orderId);
    return reservations.length;
  }

  function adjustTerritory({ territoryId, productId, qtyDelta, movementType = 'manual_correction', orderId = null,
    driverId = null, note = '', role = 'system', driverSourceId = null, preferredPool = '' }) {
    const delta = int(qtyDelta);
    if (!delta) return syncLegacyInventory(territoryId, productId);
    ensureTerritoryProduct(territoryId, productId);
    if (delta > 0) {
      const pool = validPool(preferredPool) || poolPolicy(productId).mode;
      updateBucket(territoryId, productId, pool, 'sellable', delta, {
        movementType, orderId, driverId, note, role, driverSourceId
      });
    } else {
      let remaining = -delta;
      const order = validPool(preferredPool) ? [preferredPool] : ['linked','independent'];
      for (const pool of order) {
        const row = one('SELECT * FROM territory_products WHERE territory_id=? AND product_id=?', territoryId, productId);
        const take = Math.min(remaining, int(row[stockColumn(pool, 'sellable')]));
        if (!take) continue;
        updateBucket(territoryId, productId, pool, 'sellable', -take, {
          movementType, orderId, driverId, note, role, driverSourceId
        });
        remaining -= take;
      }
      if (remaining) throw new Error('Not enough sellable inventory');
    }
    return syncLegacyInventory(territoryId, productId);
  }

  function receive(body) {
    const productId = text(body.product_id), qty = Math.max(0, int(body.qty));
    if (!productId || !qty) throw new Error('Product and a positive quantity are required');
    const target = text(body.target) || 'company_reserve';
    const note = text(body.note) || 'Shipment received';
    return db.transaction(() => {
      if (target === 'company_reserve') {
        updateReserve(productId, qty, { movementType: 'shipment_received', note, role: 'admin' });
      } else {
        const territoryId = text(body.territory_id);
        if (!territoryId) throw new Error('Choose a territory');
        const pool = target === 'independent_territory' ? 'independent' : 'linked';
        const sellable = Math.min(qty, Math.max(0, int(body.sellable_qty)));
        if (sellable) updateBucket(territoryId, productId, pool, 'sellable', sellable, { movementType: 'shipment_received', note, role: 'admin' });
        if (qty - sellable) updateBucket(territoryId, productId, pool, 'held', qty - sellable, { movementType: 'shipment_received', note, role: 'admin' });
      }
      if (body.listed != null && body.territory_id) run('UPDATE territory_products SET listed=?,updated_at=? WHERE territory_id=? AND product_id=?', bool(body.listed), now(), text(body.territory_id), productId);
      return productSummary(productId, text(body.territory_id));
    })();
  }

  function allocate(body) {
    const productId = text(body.product_id), territoryId = text(body.territory_id), qty = Math.max(0, int(body.qty));
    if (!productId || !territoryId || !qty) throw new Error('Product, territory and quantity are required');
    return db.transaction(() => {
      const transferId = id(), note = text(body.note) || 'Allocated from Company Reserve';
      updateReserve(productId, -qty, { movementType: 'territory_allocation', note, role: 'admin', relatedPool: 'linked_held', metadata: { transfer_id: transferId, territory_id: territoryId } });
      updateBucket(territoryId, productId, 'linked', 'held', qty, { movementType: 'territory_allocation', note, role: 'admin', relatedPool: 'company_reserve', metadata: { transfer_id: transferId } });
      return productSummary(productId, territoryId);
    })();
  }

  function holdOrRelease(body) {
    const productId = text(body.product_id), territoryId = text(body.territory_id), pool = validPool(text(body.pool));
    const action = text(body.action), qty = Math.max(0, int(body.qty));
    if (!productId || !territoryId || !pool || !qty || !['hold','release'].includes(action)) throw new Error('Choose product, territory, pool, action and quantity');
    return db.transaction(() => {
      const from = action === 'hold' ? 'sellable' : 'held', to = action === 'hold' ? 'held' : 'sellable';
      const movementType = action === 'hold' ? 'stock_held_back' : 'stock_released';
      const transferId = id(), note = text(body.note) || (action === 'hold' ? 'Held back from customers' : 'Released for customer sale');
      updateBucket(territoryId, productId, pool, from, -qty, { movementType, note, role: 'admin', relatedPool: `${pool}_${to}`, metadata: { transfer_id: transferId } });
      updateBucket(territoryId, productId, pool, to, qty, { movementType, note, role: 'admin', relatedPool: `${pool}_${from}`, metadata: { transfer_id: transferId } });
      return productSummary(productId, territoryId);
    })();
  }

  function takeUnreserved(territoryId, productId, qty, movement) {
    let remaining = qty, held = 0, sellable = 0;
    for (const bucket of ['held','sellable']) {
      const row = one('SELECT * FROM territory_products WHERE territory_id=? AND product_id=?', territoryId, productId);
      const take = Math.min(remaining, int(row[stockColumn('linked', bucket)]));
      if (!take) continue;
      updateBucket(territoryId, productId, 'linked', bucket, -take, { ...movement, relatedPool: movement.relatedPool });
      if (bucket === 'held') held += take; else sellable += take;
      remaining -= take;
    }
    if (remaining) throw new Error('The source territory does not own enough unreserved linked stock');
    return { held, sellable };
  }

  function transfer(body) {
    const productId = text(body.product_id), qty = Math.max(0, int(body.qty));
    const fromType = text(body.from_type), toType = text(body.to_type);
    const fromTerritory = text(body.from_territory_id), toTerritory = text(body.to_territory_id);
    if (!productId || !qty || !['reserve','territory'].includes(fromType) || !['reserve','territory'].includes(toType) || (fromType === toType && fromType === 'reserve')) throw new Error('Choose a valid linked-stock transfer');
    return db.transaction(() => {
      const transferId = id(), note = text(body.note) || 'Linked stock transfer';
      if (fromType === 'reserve') {
        if (!toTerritory) throw new Error('Choose the destination territory');
        updateReserve(productId, -qty, { movementType: 'company_reserve_transfer', note, role: 'admin', relatedPool: 'linked_held', metadata: { transfer_id: transferId, territory_id: toTerritory } });
        updateBucket(toTerritory, productId, 'linked', 'held', qty, { movementType: 'company_reserve_transfer', note, role: 'admin', relatedPool: 'company_reserve', metadata: { transfer_id: transferId } });
      } else {
        if (!fromTerritory) throw new Error('Choose the source territory');
        takeUnreserved(fromTerritory, productId, qty, { movementType: 'territory_transfer', note, role: 'admin', metadata: { transfer_id: transferId }, relatedPool: toType === 'reserve' ? 'company_reserve' : 'linked_held' });
        if (toType === 'reserve') {
          updateReserve(productId, qty, { movementType: 'company_reserve_transfer', note, role: 'admin', relatedPool: 'linked', metadata: { transfer_id: transferId, territory_id: fromTerritory } });
        } else {
          if (!toTerritory || toTerritory === fromTerritory) throw new Error('Choose a different destination territory');
          updateBucket(toTerritory, productId, 'linked', 'held', qty, { movementType: 'territory_transfer', note, role: 'admin', relatedPool: 'linked', metadata: { transfer_id: transferId, from_territory_id: fromTerritory } });
        }
      }
      return productSummary(productId, toTerritory || fromTerritory);
    })();
  }

  function convert(body) {
    const productId = text(body.product_id), territoryId = text(body.territory_id), qty = Math.max(0, int(body.qty));
    const direction = text(body.direction);
    if (!body.confirmed) throw new Error('Confirm the quantity conversion first');
    if (!productId || !territoryId || !qty || !['linked_to_independent','independent_to_linked'].includes(direction)) throw new Error('Choose a valid stock conversion');
    return db.transaction(() => {
      const from = direction === 'linked_to_independent' ? 'linked' : 'independent';
      const to = direction === 'linked_to_independent' ? 'independent' : 'linked';
      let remaining = qty;
      const transferId = id(), note = text(body.note) || direction.replaceAll('_', ' '), moved = { held: 0, sellable: 0 };
      for (const bucket of ['held','sellable']) {
        const row = ensureTerritoryProduct(territoryId, productId), take = Math.min(remaining, int(row[stockColumn(from, bucket)]));
        if (!take) continue;
        updateBucket(territoryId, productId, from, bucket, -take, { movementType: direction, note, role: 'admin', relatedPool: `${to}_${bucket}`, metadata: { transfer_id: transferId } });
        moved[bucket] += take; remaining -= take;
      }
      if (remaining) throw new Error(`Not enough unreserved ${from} stock to convert`);
      for (const bucket of ['held','sellable']) if (moved[bucket]) updateBucket(territoryId, productId, to, bucket, moved[bucket], { movementType: direction, note, role: 'admin', relatedPool: `${from}_${bucket}`, metadata: { transfer_id: transferId } });
      return productSummary(productId, territoryId);
    })();
  }

  function territoryBreakdown(territoryId, productId) {
    const row = ensureTerritoryProduct(territoryId, productId);
    const linked = {
      sellable: int(row.linked_sellable_qty), reserved: int(row.linked_reserved_qty), held: int(row.linked_held_qty)
    };
    const independent = {
      sellable: int(row.independent_sellable_qty), reserved: int(row.independent_reserved_qty), held: int(row.independent_held_qty)
    };
    linked.physical = linked.sellable + linked.reserved + linked.held;
    independent.physical = independent.sellable + independent.reserved + independent.held;
    return { territory_id: territoryId, listed: !!row.listed, featured: !!row.featured, local_price_override_cents: row.local_price_override_cents,
      linked, independent, customer_sellable: linked.sellable + independent.sellable };
  }

  function productSummary(productId, selectedTerritoryId = '') {
    const product = one('SELECT * FROM products WHERE id=?', productId);
    if (!product) throw new Error('Product not found');
    const territories = all('SELECT id,name,slug FROM territories WHERE archived=0 ORDER BY name').map(territory => ({
      ...territory, ...territoryBreakdown(territory.id, productId)
    }));
    const companyReserve = int(ensureCompanyProduct(productId).reserve_qty);
    const linkedAllocations = territories.reduce((sum, territory) => sum + territory.linked.physical, 0);
    const selected = territories.find(territory => territory.id === selectedTerritoryId) || null;
    return {
      ...product,
      image: product.image || product.catalog_image || '/product-images/catalog-placeholder.webp',
      catalog_image: product.catalog_image || '/product-images/catalog-placeholder.webp',
      policy: poolPolicy(productId),
      company: { reserve: companyReserve, linked_allocations: linkedAllocations, linked_physical: companyReserve + linkedAllocations },
      territories,
      selected_territory: selected,
    };
  }

  function catalogList(selectedTerritoryId = '') {
    const products = all('SELECT * FROM products ORDER BY archived,brand,flavor,strength');
    const territories = all('SELECT id,name,slug FROM territories WHERE archived=0 ORDER BY name');
    const territoryRows = all('SELECT * FROM territory_products');
    const companyRows = new Map(all('SELECT * FROM company_product_stock').map(row => [row.product_id, row]));
    const territoryRowsByKey = new Map(territoryRows.map(row => [`${row.territory_id}\u0000${row.product_id}`, row]));
    const productPolicies = new Map(all('SELECT product_id,mode FROM company_stock_product_policies').map(row => [row.product_id, row.mode]));
    const brandPolicies = new Map(all('SELECT brand_key,linked_default FROM company_stock_brand_policies').map(row => [row.brand_key, row.linked_default]));
    const systemDefault = setting('company_stock_default_linked', 'true') === 'true' ? 'linked' : 'independent';

    const policyFor = product => {
      const override = productPolicies.get(product.id) || 'inherit';
      if (override !== 'inherit') return { mode: override, source: 'product' };
      if (brandPolicies.has(norm(product.brand))) return { mode: brandPolicies.get(norm(product.brand)) ? 'linked' : 'independent', source: 'brand' };
      return { mode: systemDefault, source: 'system' };
    };
    const breakdownFor = (territory, product) => {
      const row = territoryRowsByKey.get(`${territory.id}\u0000${product.id}`) || {};
      const linked = { sellable: int(row.linked_sellable_qty), reserved: int(row.linked_reserved_qty), held: int(row.linked_held_qty) };
      const independent = { sellable: int(row.independent_sellable_qty), reserved: int(row.independent_reserved_qty), held: int(row.independent_held_qty) };
      linked.physical = linked.sellable + linked.reserved + linked.held;
      independent.physical = independent.sellable + independent.reserved + independent.held;
      return { ...territory, listed: !!row.listed, featured: !!row.featured, local_price_override_cents: row.local_price_override_cents ?? null,
        linked, independent, customer_sellable: linked.sellable + independent.sellable };
    };

    return {
      catalog: products.map(product => {
        const productTerritories = territories.map(territory => breakdownFor(territory, product));
        const companyReserve = int(companyRows.get(product.id)?.reserve_qty);
        const linkedAllocations = productTerritories.reduce((sum, territory) => sum + territory.linked.physical, 0);
        return {
          ...product,
          image: product.image || product.catalog_image || '/product-images/catalog-placeholder.webp',
          catalog_image: product.catalog_image || '/product-images/catalog-placeholder.webp',
          policy: policyFor(product),
          company: { reserve: companyReserve, linked_allocations: linkedAllocations, linked_physical: companyReserve + linkedAllocations },
          territories: productTerritories,
          selected_territory: productTerritories.find(territory => territory.id === selectedTerritoryId) || null,
        };
      }),
      territories,
      config: config(),
      manifest: catalogSeedResult,
    };
  }

  function config() {
    return {
      system_default_linked: setting('company_stock_default_linked', 'true') === 'true',
      brand_defaults: all('SELECT * FROM company_stock_brand_policies ORDER BY brand_label'),
    };
  }

  function history({ territoryId = '', productId = '', limit = 300 } = {}) {
    let sql = `SELECT m.*,p.brand,p.flavor,p.strength,p.series,t.name territory_name,o.order_no
      FROM inventory_movements m JOIN products p ON p.id=m.product_id
      LEFT JOIN territories t ON t.id=m.territory_id LEFT JOIN orders o ON o.id=m.order_id WHERE 1=1`;
    const args = [];
    if (territoryId) { sql += ' AND m.territory_id=?'; args.push(territoryId); }
    if (productId) { sql += ' AND m.product_id=?'; args.push(productId); }
    sql += ' ORDER BY m.created_at DESC LIMIT ?'; args.push(Math.min(1000, Math.max(1, int(limit, 300))));
    return all(sql, ...args);
  }

  function editProduct(productId, body) {
    const product = one('SELECT * FROM products WHERE id=?', productId);
    if (!product) throw new Error('Product not found');
    const image = text(body.image);
    if (image && !/^\/product-images\/[a-z0-9._-]+$/i.test(image) && !/^https:\/\//i.test(image)) throw new Error('Use a local product image path or an HTTPS image URL');
    run(`UPDATE products SET brand=?,flavor=?,strength=?,series=?,image=?,notes=?,active=?,archived=?,updated_at=? WHERE id=?`,
      text(body.brand), text(body.flavor), text(body.strength).replace(/\s*mg\s*$/i, ''), text(body.series), image,
      text(body.notes), bool(body.active ?? product.active), bool(body.archived ?? product.archived), now(), productId);
    return productSummary(productId, text(body.territory_id));
  }

  async function handleAdminApi(req, res, url, { send, bodyJson }) {
    if (!url.pathname.startsWith('/api/admin/company-stock')) return false;
    if (url.pathname === '/api/admin/company-stock/catalog' && req.method === 'GET') {
      send(res, 200, catalogList(text(url.searchParams.get('territory_id')))); return true;
    }
    if (url.pathname === '/api/admin/company-stock/history' && req.method === 'GET') {
      send(res, 200, history({ territoryId: text(url.searchParams.get('territory_id')), productId: text(url.searchParams.get('product_id')), limit: int(url.searchParams.get('limit'), 300) })); return true;
    }
    if (url.pathname === '/api/admin/company-stock/config' && req.method === 'PUT') {
      const body = await bodyJson(req); setSetting('company_stock_default_linked', body.system_default_linked ? 'true' : 'false'); send(res, 200, config()); return true;
    }
    if (url.pathname === '/api/admin/company-stock/brand-policy' && req.method === 'PUT') {
      const body = await bodyJson(req), label = text(body.brand); if (!label) throw new Error('Brand is required');
      run(`INSERT INTO company_stock_brand_policies(brand_key,brand_label,linked_default,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(brand_key) DO UPDATE SET brand_label=excluded.brand_label,linked_default=excluded.linked_default,updated_at=excluded.updated_at`, norm(label), label, bool(body.linked_default), now());
      send(res, 200, config()); return true;
    }
    if (url.pathname === '/api/admin/company-stock/product-policy' && req.method === 'PUT') {
      const body = await bodyJson(req), productId = text(body.product_id), mode = text(body.mode);
      if (!['inherit','linked','independent'].includes(mode) || !one('SELECT 1 FROM products WHERE id=?', productId)) throw new Error('Choose a valid product policy');
      run(`INSERT INTO company_stock_product_policies(product_id,mode,updated_at) VALUES(?,?,?)
        ON CONFLICT(product_id) DO UPDATE SET mode=excluded.mode,updated_at=excluded.updated_at`, productId, mode, now());
      send(res, 200, productSummary(productId, text(body.territory_id))); return true;
    }
    const productEdit = url.pathname.match(/^\/api\/admin\/company-stock\/products\/([^/]+)$/);
    if (productEdit && req.method === 'PUT') { const body = await bodyJson(req); send(res, 200, editProduct(decodeURIComponent(productEdit[1]), body)); return true; }
    const operations = {
      '/api/admin/company-stock/receive': receive,
      '/api/admin/company-stock/allocate': allocate,
      '/api/admin/company-stock/hold': holdOrRelease,
      '/api/admin/company-stock/transfer': transfer,
      '/api/admin/company-stock/convert': convert,
    };
    if (operations[url.pathname] && req.method === 'POST') { send(res, 200, operations[url.pathname](await bodyJson(req))); return true; }
    send(res, 404, { error: 'Company Stock endpoint not found' }); return true;
  }

  installSchema();
  migrateLegacyInventory();
  const catalogSeedResult = seedCatalog();

  return {
    ensureTerritoryProduct,
    syncLegacyInventory,
    reserveOrderItem,
    releaseOrder,
    finalizeOrder,
    adjustTerritory,
    catalogList,
    productSummary,
    history,
    handleAdminApi,
    catalogSeedResult,
  };
};
