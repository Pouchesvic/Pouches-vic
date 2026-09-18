'use strict';

// Exact physical storefront inventory by delivery driver. Company Stock remains
// the territory/accounting source of truth; this layer records which driver
// physically holds the customer-sellable/reserved cans.
module.exports = function createDriverInventory({ db, companyStock, now, id, text, int, jsonText }) {
  const one=(sql,...args)=>db.prepare(sql).get(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  const setting=(key,fallback='')=>one('SELECT value FROM settings WHERE key=?',key)?.value ?? fallback;
  const setSetting=(key,value)=>run(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,key,String(value),now());

  db.exec(`
    CREATE TABLE IF NOT EXISTS driver_inventory(
      driver_id TEXT NOT NULL,
      territory_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      sellable_qty INTEGER NOT NULL DEFAULT 0 CHECK(sellable_qty>=0),
      reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK(reserved_qty>=0),
      check_stock_qty INTEGER NOT NULL DEFAULT 0 CHECK(check_stock_qty>=0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(driver_id,territory_id,product_id),
      FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE CASCADE,
      FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_driver_inventory_area_product ON driver_inventory(territory_id,product_id);
    CREATE TABLE IF NOT EXISTS driver_inventory_reservations(
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      order_item_id TEXT,
      driver_id TEXT NOT NULL,
      territory_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK(qty>0),
      status TEXT NOT NULL DEFAULT 'reserved',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY(order_item_id) REFERENCES order_items(id) ON DELETE SET NULL,
      FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE RESTRICT,
      FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_driver_inv_res_order ON driver_inventory_reservations(order_id,status);
    CREATE TABLE IF NOT EXISTS driver_inventory_movements(
      id TEXT PRIMARY KEY,
      driver_id TEXT NOT NULL,
      territory_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      order_id TEXT,
      movement_type TEXT NOT NULL,
      sellable_delta INTEGER NOT NULL DEFAULT 0,
      reserved_delta INTEGER NOT NULL DEFAULT 0,
      check_stock_delta INTEGER NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE RESTRICT,
      FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE RESTRICT,
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT,
      FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL
    );
  `);

  function validLocalDriver(territoryId,driverId){return driverId&&!!one(`SELECT d.id FROM drivers d JOIN driver_territory_memberships m ON m.driver_id=d.id AND m.territory_id=? AND m.active=1 WHERE d.id=? AND d.active=1 AND d.archived=0`,territoryId,driverId);}
  function primaryDriver(territoryId) {
    const territory=one('SELECT * FROM territories WHERE id=?',territoryId);if(!territory)return null;
    if(validLocalDriver(territoryId,territory.main_driver_id))return territory.main_driver_id;
    if(validLocalDriver(territoryId,territory.default_driver_id))return territory.default_driver_id;
    return one(`SELECT d.id FROM drivers d JOIN driver_territory_memberships m ON m.driver_id=d.id AND m.territory_id=? AND m.active=1 WHERE d.active=1 AND d.archived=0 ORDER BY CASE WHEN d.role='operations_admin' OR m.role='supervisor' THEN 0 ELSE 1 END,d.created_at,d.name LIMIT 1`,territoryId)?.id||null;
  }

  function ensureRow(driverId,territoryId,productId){
    let row=one('SELECT * FROM driver_inventory WHERE driver_id=? AND territory_id=? AND product_id=?',driverId,territoryId,productId);
    if(!row){run('INSERT INTO driver_inventory(driver_id,territory_id,product_id,sellable_qty,reserved_qty,check_stock_qty,updated_at) VALUES(?,?,?,0,0,0,?)',driverId,territoryId,productId,now());row=one('SELECT * FROM driver_inventory WHERE driver_id=? AND territory_id=? AND product_id=?',driverId,territoryId,productId);}
    return row;
  }
  function movement(driverId,territoryId,productId,type,{sellable=0,reserved=0,check=0,orderId=null,note='',metadata={}}={}){
    run('INSERT INTO driver_inventory_movements(id,driver_id,territory_id,product_id,order_id,movement_type,sellable_delta,reserved_delta,check_stock_delta,note,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id(),driverId,territoryId,productId,orderId,type,int(sellable),int(reserved),int(check),text(note),jsonText(metadata),now());
  }
  function change(driverId,territoryId,productId,{sellable=0,reserved=0,check=0,type='adjustment',orderId=null,note='',metadata={}}={}){
    const row=ensureRow(driverId,territoryId,productId),nextSell=int(row.sellable_qty)+int(sellable),nextRes=int(row.reserved_qty)+int(reserved),nextCheck=int(row.check_stock_qty)+int(check);
    if(nextSell<0)throw new Error('That driver does not have enough available cans.');
    if(nextRes<0)throw new Error('That driver does not have enough reserved cans.');
    if(nextCheck<0)throw new Error('CHECK STOCK quantity cannot go below zero.');
    run('UPDATE driver_inventory SET sellable_qty=?,reserved_qty=?,check_stock_qty=?,updated_at=? WHERE driver_id=? AND territory_id=? AND product_id=?',nextSell,nextRes,nextCheck,now(),driverId,territoryId,productId);
    movement(driverId,territoryId,productId,type,{sellable,reserved,check,orderId,note,metadata});
    return {sellable_qty:nextSell,reserved_qty:nextRes,check_stock_qty:nextCheck};
  }

  function companyQuantities(territoryId,productId){
    const row=companyStock.ensureTerritoryProduct(territoryId,productId);
    return {sellable:int(row.linked_sellable_qty)+int(row.independent_sellable_qty),reserved:int(row.linked_reserved_qty)+int(row.independent_reserved_qty)};
  }
  function reconcileProduct(territoryId,productId){
    const primary=primaryDriver(territoryId);if(!primary)return;
    const cq=companyQuantities(territoryId,productId),rows=all('SELECT * FROM driver_inventory WHERE territory_id=? AND product_id=? ORDER BY CASE WHEN driver_id=? THEN 0 ELSE 1 END,driver_id',territoryId,productId,primary);
    let sell=rows.reduce((s,r)=>s+int(r.sellable_qty),0);
    if(sell<cq.sellable)change(primary,territoryId,productId,{sellable:cq.sellable-sell,type:'unallocated_stock_assigned',note:'Available stock assigned to primary storefront driver'});
    else if(sell>cq.sellable){let excess=sell-cq.sellable;for(const r of rows){const take=Math.min(excess,int(r.sellable_qty));if(take){change(r.driver_id,territoryId,productId,{sellable:-take,type:'territory_stock_reconciled',note:'Driver allocation reconciled to territory stock'});excess-=take;}if(!excess)break;}if(excess)throw new Error('Driver inventory cannot reconcile because reserved stock would be affected.');}
  }
  function reconcileTerritory(territoryId){for(const p of all('SELECT product_id FROM territory_products WHERE territory_id=?',territoryId))reconcileProduct(territoryId,p.product_id);}

  function seed(){
    if(setting('driver_inventory_v1_seeded','')==='done')return;
    db.transaction(()=>{
      for(const t of all('SELECT id FROM territories WHERE active=1 AND archived=0'))for(const p of all('SELECT product_id FROM territory_products WHERE territory_id=?',t.id)){
        const primary=primaryDriver(t.id);if(!primary)continue;const q=companyQuantities(t.id,p.product_id);if(q.sellable)change(primary,t.id,p.product_id,{sellable:q.sellable,type:'initial_driver_allocation',note:'Initial storefront allocation'});
      }
      // Existing active reservations belong to their currently assigned drivers.
      for(const r of all(`SELECT r.order_id,r.order_item_id,r.territory_id,r.product_id,SUM(r.qty) qty,o.assigned_driver_id
        FROM order_inventory_reservations r JOIN orders o ON o.id=r.order_id WHERE r.status='reserved' AND o.assigned_driver_id IS NOT NULL
        GROUP BY r.order_id,r.order_item_id,r.territory_id,r.product_id,o.assigned_driver_id`)){
        const driver=r.assigned_driver_id;ensureRow(driver,r.territory_id,r.product_id);
        // Company sellable already excludes this reservation, so reserved is additive here.
        change(driver,r.territory_id,r.product_id,{reserved:int(r.qty),type:'existing_order_reservation_import',orderId:r.order_id,note:'Imported active reservation'});
        run("INSERT INTO driver_inventory_reservations(id,order_id,order_item_id,driver_id,territory_id,product_id,qty,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'reserved',?,?)",id(),r.order_id,r.order_item_id,driver,r.territory_id,r.product_id,int(r.qty),now(),now());
      }
      setSetting('driver_inventory_v1_seeded','done');
    })();
  }
  seed();

  function storefrontDriver(territoryId,{lane='',qty=0}={}){
    const t=one('SELECT * FROM territories WHERE id=?',territoryId);if(!t)return null;const max=Math.max(1,int(t.small_order_max_qty,4)),main=validLocalDriver(territoryId,t.main_driver_id)?t.main_driver_id:primaryDriver(territoryId),small=validLocalDriver(territoryId,t.small_orders_driver_id)?t.small_orders_driver_id:null;
    if(small&&(text(lane)==='small'||(!text(lane)&&int(qty)>0&&int(qty)<=max)))return small;return main||small||null;
  }
  function laneAllowed(territoryId,lane,qty){const t=one('SELECT small_orders_driver_id,small_order_max_qty FROM territories WHERE id=?',territoryId);if(!t)return false;const max=Math.max(1,int(t.small_order_max_qty,4)),small=validLocalDriver(territoryId,t.small_orders_driver_id);if(!small)return text(lane)!=='small'&&int(qty)>=1;return text(lane)==='small'?int(qty)>=1&&int(qty)<=max:int(qty)>max;}

  function available(driverId,territoryId,productId){reconcileProduct(territoryId,productId);return int(ensureRow(driverId,territoryId,productId).sellable_qty);}
  function snapshot(territoryId,driverId){reconcileTerritory(territoryId);return all(`SELECT di.*,p.brand,p.flavor,p.strength,p.image FROM driver_inventory di JOIN products p ON p.id=di.product_id WHERE di.territory_id=? AND di.driver_id=? ORDER BY p.brand,p.flavor`,territoryId,driverId);}

  function reserveItem({orderId,orderItemId,territoryId,productId,qty,driverId,note=''}){
    const q=Math.max(0,int(qty));if(!q)return null;reconcileProduct(territoryId,productId);if(available(driverId,territoryId,productId)<q)throw new Error('That driver does not have enough of this product.');
    change(driverId,territoryId,productId,{sellable:-q,reserved:q,type:'order_reservation',orderId,note});
    const rid=id();run("INSERT INTO driver_inventory_reservations(id,order_id,order_item_id,driver_id,territory_id,product_id,qty,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'reserved',?,?)",rid,orderId,orderItemId,driverId,territoryId,productId,q,now(),now());return rid;
  }
  function releaseOrder(orderId,note='Order cancelled'){
    const rows=all("SELECT * FROM driver_inventory_reservations WHERE order_id=? AND status='reserved'",orderId);for(const r of rows){change(r.driver_id,r.territory_id,r.product_id,{sellable:int(r.qty),reserved:-int(r.qty),type:'order_cancellation_release',orderId,note});run("UPDATE driver_inventory_reservations SET status='released',updated_at=? WHERE id=?",now(),r.id);}return rows.length;
  }
  function finalizeOrder(orderId){
    const rows=all("SELECT * FROM driver_inventory_reservations WHERE order_id=? AND status='reserved'",orderId);for(const r of rows){change(r.driver_id,r.territory_id,r.product_id,{reserved:-int(r.qty),type:'completed_sale',orderId,note:'Completed delivery'});run("UPDATE driver_inventory_reservations SET status='sold',updated_at=? WHERE id=?",now(),r.id);}return rows.length;
  }
  function holdMissing(orderId,driverId,productId,qty,note='Can\'t find'){
    let remaining=Math.max(0,int(qty));if(!remaining)throw new Error('Choose how many cans cannot be found.');const rows=all("SELECT * FROM driver_inventory_reservations WHERE order_id=? AND driver_id=? AND product_id=? AND status='reserved' ORDER BY created_at,id",orderId,driverId,productId);if(rows.reduce((s,r)=>s+int(r.qty),0)<remaining)throw new Error('Can\'t Find quantity is higher than the cans reserved on this order.');
    for(const r of rows){const take=Math.min(remaining,int(r.qty));if(!take)continue;change(driverId,r.territory_id,productId,{reserved:-take,check:take,type:'check_stock',orderId,note});if(take===int(r.qty))run("UPDATE driver_inventory_reservations SET status='check_stock',updated_at=? WHERE id=?",now(),r.id);else{run('UPDATE driver_inventory_reservations SET qty=qty-?,updated_at=? WHERE id=?',take,now(),r.id);run("INSERT INTO driver_inventory_reservations(id,order_id,order_item_id,driver_id,territory_id,product_id,qty,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'check_stock',?,?)",id(),r.order_id,r.order_item_id,r.driver_id,r.territory_id,r.product_id,take,now(),now());}remaining-=take;if(!remaining)break;}return int(qty);
  }
  function resolveCheckStock({driverId,territoryId,productId,qty,found,note=''}){
    const q=Math.max(0,int(qty));if(!q)throw new Error('Enter a quantity.');const row=ensureRow(driverId,territoryId,productId);if(int(row.check_stock_qty)<q)throw new Error('That is more than the CHECK STOCK quantity.');if(found)change(driverId,territoryId,productId,{sellable:q,check:-q,type:'check_stock_found',note:note||'Stock found'});else change(driverId,territoryId,productId,{check:-q,type:'check_stock_confirmed_missing',note:note||'Confirmed missing'});return ensureRow(driverId,territoryId,productId);
  }
  function canReassign(orderId,targetDriverId){const order=one('SELECT * FROM orders WHERE id=?',orderId);if(!order)return{ok:false,reason:'Order not found.'};for(const r of all("SELECT product_id,SUM(qty) qty FROM driver_inventory_reservations WHERE order_id=? AND status='reserved' GROUP BY product_id",orderId)){if(available(targetDriverId,order.territory_id,r.product_id)<int(r.qty))return{ok:false,reason:'The selected driver does not have every product needed for this order.',product_id:r.product_id,needed:int(r.qty),available:available(targetDriverId,order.territory_id,r.product_id)};}return{ok:true};}
  function reassignOrder(orderId,targetDriverId){const rows=all("SELECT * FROM driver_inventory_reservations WHERE order_id=? AND status='reserved'",orderId);if(rows.length&&rows.every(r=>r.driver_id===targetDriverId))return true;const check=canReassign(orderId,targetDriverId);if(!check.ok)throw new Error(check.reason);db.transaction(()=>{for(const r of rows){if(r.driver_id===targetDriverId)continue;change(r.driver_id,r.territory_id,r.product_id,{sellable:int(r.qty),reserved:-int(r.qty),type:'reassign_release',orderId,note:'Order reassigned'});change(targetDriverId,r.territory_id,r.product_id,{sellable:-int(r.qty),reserved:int(r.qty),type:'reassign_reserve',orderId,note:'Order reassigned'});run('UPDATE driver_inventory_reservations SET driver_id=?,updated_at=? WHERE id=?',targetDriverId,now(),r.id);}})();return true;}

  function addSellable({driverId,territoryId,productId,qty,type='driver_stock_add',orderId=null,note=''}){
    const q=Math.max(0,int(qty));if(!q)throw new Error('Enter a quantity.');return change(driverId,territoryId,productId,{sellable:q,type,orderId,note});
  }

  function removeSellable({driverId,territoryId,productId,qty,type='driver_stock_removal',orderId=null,note=''}){
    const q=Math.max(0,int(qty));if(!q)throw new Error('Enter a quantity.');reconcileProduct(territoryId,productId);if(available(driverId,territoryId,productId)<q)throw new Error('That driver does not have enough available cans.');return change(driverId,territoryId,productId,{sellable:-q,type,orderId,note});
  }

  function transfer({fromDriverId,toDriverId,fromTerritoryId,toTerritoryId,productId,qty,note=''}){
    const q=Math.max(0,int(qty));if(!q)throw new Error('Enter a quantity to move.');reconcileProduct(fromTerritoryId,productId);if(available(fromDriverId,fromTerritoryId,productId)<q)throw new Error('The source driver does not have enough available cans.');
    db.transaction(()=>{change(fromDriverId,fromTerritoryId,productId,{sellable:-q,type:'driver_handoff_out',note});if(fromTerritoryId!==toTerritoryId)companyStock.transferTerritorySellable({fromTerritoryId,toTerritoryId,productId,qty:q,movementType:'driver_cross_area_transfer',note,role:'admin'});change(toDriverId,toTerritoryId,productId,{sellable:q,type:'driver_handoff_in',note});})();return true;
  }

  return {primaryDriver,storefrontDriver,laneAllowed,reconcileProduct,reconcileTerritory,available,snapshot,reserveItem,releaseOrder,finalizeOrder,holdMissing,resolveCheckStock,addSellable,removeSellable,canReassign,reassignOrder,transfer,ensureRow};
};
