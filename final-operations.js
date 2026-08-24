'use strict';

// Final operations service. This is the single transactional owner for scheduling,
// driver membership/oversight, free and personal cans, swaps, and pending totals.

module.exports = function createFinalOperations({ db, companyStock, now, id, text, int, bool, jsonText, safeJson, addOrderEvent }) {
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const columns = table => new Set(all(`PRAGMA table_info(${table})`).map(row => row.name));
  const ensureColumn = (table, name, definition) => { if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`); };
  const setting = (key, fallback = '') => one('SELECT value FROM settings WHERE key=?', key)?.value ?? fallback;
  const setSetting = (key, value) => run(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, key, String(value), now());
  const localParts = (date, timezone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year:'numeric', month:'2-digit', day:'2-digit', weekday:'short', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  const localDate = (date, timezone) => { const p=localParts(date,timezone); return `${p.year}-${p.month}-${p.day}`; };
  const weekdayIndex = value => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(value);
  const minuteLabel = value => { const h=Math.floor(value/60),m=value%60,ap=h>=12?'PM':'AM',hh=h%12||12; return `${hh}:${String(m).padStart(2,'0')} ${ap}`; };
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(text(value));

  function installSchema() {
    [
      ['territories','timezone',"TEXT DEFAULT 'America/Vancouver'"],
      ['territories','scheduling_configured','INTEGER NOT NULL DEFAULT 0'],
      ['drivers','personal_use_rate_cents','INTEGER NOT NULL DEFAULT 1000'],
      ['drivers','personal_rate_driver_editable','INTEGER NOT NULL DEFAULT 0'],
      ['orders','schedule_type',"TEXT NOT NULL DEFAULT 'legacy'"],
      ['orders','requested_delivery_date','TEXT'],
      ['orders','requested_window_start','TEXT'],
      ['orders','requested_window_end','TEXT'],
      ['orders','requested_window_label',"TEXT DEFAULT ''"],
      ['orders','territory_timezone_snapshot',"TEXT DEFAULT ''"],
      ['orders','outside_hours_message',"TEXT DEFAULT ''"],
      ['orders','manual_location','INTEGER NOT NULL DEFAULT 0'],
      ['orders','meeting_instructions',"TEXT DEFAULT ''"],
      ['orders','location_confirmed','INTEGER NOT NULL DEFAULT 1'],
      ['orders','final_total_pending','INTEGER NOT NULL DEFAULT 0'],
      ['orders','verified_address',"TEXT DEFAULT ''"],
      ['platform_order_notification_recipients','territory_id','TEXT'],
      ['platform_settlement_transactions','rate_cents','INTEGER NOT NULL DEFAULT 0'],
      ['platform_settlement_transactions','action_id','TEXT'],
      ['platform_settlement_transactions','financial_effect',"TEXT NOT NULL DEFAULT ''"],
      ['platform_settlement_periods','calculated_amount_cents','INTEGER'],
      ['platform_settlement_periods','final_direction',"TEXT DEFAULT ''"],
      ['platform_settlement_periods','final_amount_cents','INTEGER'],
      ['platform_settlement_periods','adjustment_cents','INTEGER NOT NULL DEFAULT 0'],
      ['platform_settlement_periods','adjustment_reason',"TEXT DEFAULT ''"],
    ].forEach(row => { try { ensureColumn(...row); } catch (error) { if (!/no such table/i.test(error.message)) throw error; } });
    db.exec(`
      CREATE TABLE IF NOT EXISTS territory_weekly_hours(
        id TEXT PRIMARY KEY, territory_id TEXT NOT NULL, weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
        open_minute INTEGER NOT NULL CHECK(open_minute BETWEEN 0 AND 1439), close_minute INTEGER NOT NULL CHECK(close_minute BETWEEN 1 AND 1440),
        active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE,
        CHECK(close_minute>open_minute)
      );
      CREATE INDEX IF NOT EXISTS idx_weekly_hours_territory_day ON territory_weekly_hours(territory_id,weekday,active,open_minute);
      CREATE TABLE IF NOT EXISTS driver_territory_memberships(
        driver_id TEXT NOT NULL, territory_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'driver', active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(driver_id,territory_id),
        FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE CASCADE, FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS order_watchers(
        order_id TEXT NOT NULL, driver_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'oversight', created_at TEXT NOT NULL,
        PRIMARY KEY(order_id,driver_id), FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE, FOREIGN KEY(driver_id) REFERENCES drivers(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS territory_dispatch_rules(
        id TEXT PRIMARY KEY, territory_id TEXT NOT NULL, zone_id TEXT, primary_driver_id TEXT NOT NULL, watcher_driver_id TEXT,
        require_verified_location INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE, FOREIGN KEY(zone_id) REFERENCES delivery_zones(id) ON DELETE CASCADE,
        FOREIGN KEY(primary_driver_id) REFERENCES drivers(id) ON DELETE RESTRICT, FOREIGN KEY(watcher_driver_id) REFERENCES drivers(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS operational_actions(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, territory_id TEXT NOT NULL, order_id TEXT, actor_role TEXT NOT NULL,
        actor_driver_id TEXT, recipient_type TEXT DEFAULT '', recipient_driver_id TEXT, note TEXT DEFAULT '',
        financial_effect TEXT NOT NULL DEFAULT 'none', total_amount_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
        FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE RESTRICT, FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE SET NULL,
        FOREIGN KEY(actor_driver_id) REFERENCES drivers(id) ON DELETE SET NULL, FOREIGN KEY(recipient_driver_id) REFERENCES drivers(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operational_actions_order ON operational_actions(order_id,kind,created_at);
      CREATE INDEX IF NOT EXISTS idx_operational_actions_driver ON operational_actions(actor_driver_id,kind,created_at);
      CREATE TABLE IF NOT EXISTS operational_action_lines(
        id TEXT PRIMARY KEY, action_id TEXT NOT NULL, product_id TEXT NOT NULL, line_role TEXT NOT NULL,
        qty INTEGER NOT NULL DEFAULT 0, inventory_delta INTEGER NOT NULL DEFAULT 0, rate_cents_snapshot INTEGER NOT NULL DEFAULT 0,
        amount_cents INTEGER NOT NULL DEFAULT 0, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
        FOREIGN KEY(action_id) REFERENCES operational_actions(id) ON DELETE CASCADE, FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS order_promotional_free_cans(
        order_id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE, product_id TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE, FOREIGN KEY(action_id) REFERENCES operational_actions(id) ON DELETE CASCADE,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS settlement_corrections(
        id TEXT PRIMARY KEY, period_id TEXT NOT NULL, original_snapshot_json TEXT NOT NULL, corrected_snapshot_json TEXT NOT NULL,
        reason TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(period_id) REFERENCES platform_settlement_periods(id) ON DELETE CASCADE
      );
    `);
  }

  function migrateAndSeed() {
    const stamp=now();
    let sooke=one("SELECT * FROM territories WHERE lower(slug)='sooke' OR lower(name)='sooke' LIMIT 1");
    if(!sooke){
      const sid=id(); run(`INSERT INTO territories(id,name,slug,active,archived,domain,currency,created_at,updated_at,timezone,scheduling_configured) VALUES(?,?,?,1,0,'','CAD',?,?,?,0)`,sid,'Sooke','sooke',stamp,stamp,'America/Vancouver');
      sooke=one('SELECT * FROM territories WHERE id=?',sid);
      const victoria=one("SELECT id FROM territories WHERE slug='victoria'");
      if(victoria){ for(const tier of all('SELECT * FROM pricing_tiers WHERE territory_id=? ORDER BY sort_order',victoria.id)) run('INSERT INTO pricing_tiers(id,territory_id,min_qty,max_qty,unit_price,unit_price_cents,active,sort_order) VALUES(?,?,?,?,?,?,?,?)',id(),sid,tier.min_qty,tier.max_qty,tier.unit_price,tier.unit_price_cents,tier.active,tier.sort_order); }
    }
    run("UPDATE territories SET timezone='America/Vancouver' WHERE slug IN ('victoria','sooke') AND COALESCE(timezone,'')=''");
    if(setting('final_patch_personal_rates_v1','')!=='done'){
      run('UPDATE drivers SET personal_use_rate_cents=1000 WHERE personal_use_rate_cents IS NULL OR personal_use_rate_cents<0');
      const victoria=one("SELECT id FROM territories WHERE slug='victoria'");
      if(victoria) run("UPDATE drivers SET personal_use_rate_cents=900,personal_rate_driver_editable=1 WHERE territory_id=? AND lower(trim(name))='victoria driver 1'",victoria.id);
      setSetting('final_patch_personal_rates_v1','done');
    }
    run("UPDATE products SET brand='VELO',updated_at=updated_at WHERE lower(trim(brand))='velo' AND brand<>'VELO'");
    for(const driver of all('SELECT id,territory_id FROM drivers')) run(`INSERT INTO driver_territory_memberships(driver_id,territory_id,role,active,created_at,updated_at) VALUES(?,?, 'driver',1,?,?) ON CONFLICT(driver_id,territory_id) DO NOTHING`,driver.id,driver.territory_id,stamp,stamp);
    const victoria=one("SELECT id FROM territories WHERE slug='victoria'"), driver1=victoria?one("SELECT id FROM drivers WHERE territory_id=? AND lower(trim(name))='victoria driver 1' AND archived=0",victoria.id):null;
    if(sooke&&driver1) run(`INSERT INTO driver_territory_memberships(driver_id,territory_id,role,active,created_at,updated_at) VALUES(?,?,'supervisor',1,?,?) ON CONFLICT(driver_id,territory_id) DO UPDATE SET role='supervisor',active=1,updated_at=excluded.updated_at`,driver1.id,sooke.id,stamp,stamp);
    const driver3=victoria?one("SELECT id FROM drivers WHERE territory_id=? AND lower(trim(name)) IN ('driver 3','victoria driver 3') AND archived=0 ORDER BY created_at LIMIT 1",victoria.id):null;
    if(sooke&&driver3) run(`INSERT INTO driver_territory_memberships(driver_id,territory_id,role,active,created_at,updated_at) VALUES(?,?,'driver',1,?,?) ON CONFLICT(driver_id,territory_id) DO UPDATE SET active=1,updated_at=excluded.updated_at`,driver3.id,sooke.id,stamp,stamp);
    if(sooke&&driver3){
      const dispatch=one('SELECT id FROM territory_dispatch_rules WHERE territory_id=? AND zone_id IS NULL AND active=1 ORDER BY created_at LIMIT 1',sooke.id);
      if(!dispatch)run(`INSERT INTO territory_dispatch_rules(id,territory_id,zone_id,primary_driver_id,watcher_driver_id,require_verified_location,active,created_at,updated_at) VALUES(?,?,NULL,?,?,1,1,?,?)`,id(),sooke.id,driver3.id,driver1?.id||null,stamp,stamp);
    }
    if(sooke) for(const product of all('SELECT id FROM products')) companyStock.ensureTerritoryProduct(sooke.id,product.id);
    if(victoria && columns('platform_order_notification_recipients').has('territory_id')) run("UPDATE platform_order_notification_recipients SET territory_id=? WHERE lower(email)='vicpouches@protonmail.com' AND territory_id IS NULL",victoria.id);
  }

  function scheduleConfig(territoryId, dateValue='') {
    const territory=one('SELECT * FROM territories WHERE id=? AND active=1 AND archived=0',territoryId); if(!territory) throw new Error('Delivery area unavailable');
    const timezone=text(territory.timezone)||'America/Vancouver', serverNow=new Date(), today=localDate(serverNow,timezone), requested=validDate(dateValue)?dateValue:today;
    const parts=localParts(new Date(`${requested}T12:00:00Z`),timezone), weekday=weekdayIndex(parts.weekday);
    const rows=all('SELECT * FROM territory_weekly_hours WHERE territory_id=? AND weekday=? AND active=1 ORDER BY open_minute,sort_order',territoryId,weekday);
    const current=localParts(serverNow,timezone),currentMinute=Number(current.hour)*60+Number(current.minute),windows=[];
    for(const row of rows) for(let start=int(row.open_minute);start+30<=int(row.close_minute);start+=30){ if(requested===today&&start<=currentMinute)continue; windows.push({start_minute:start,end_minute:start+30,start:`${String(Math.floor(start/60)).padStart(2,'0')}:${String(start%60).padStart(2,'0')}`,end:`${String(Math.floor((start+30)/60)%24).padStart(2,'0')}:${String((start+30)%60).padStart(2,'0')}`,label:`${minuteLabel(start)}–${minuteLabel(start+30)}`}); }
    return {territory:{id:territory.id,name:territory.name,slug:territory.slug,timezone,scheduling_configured:!!territory.scheduling_configured},server_now:serverNow.toISOString(),local_today:today,date:requested,windows,setup_needed:!territory.scheduling_configured||!all('SELECT 1 FROM territory_weekly_hours WHERE territory_id=? AND active=1 LIMIT 1',territoryId).length};
  }

  function validateSchedule(body, territory) {
    const timezone=text(territory.timezone)||'America/Vancouver', type=text(body.schedule_type);
    if(type==='outside_hours'){
      const message=text(body.outside_hours_message); if(!message) throw new Error('Tell us when you need delivery outside normal hours.');
      const date=validDate(body.requested_delivery_date)?text(body.requested_delivery_date):localDate(new Date(),timezone);
      return {type,date,start:null,end:null,label:'Outside-hours request',timezone,message};
    }
    if(type!=='window') throw new Error('Choose a delivery date and 30-minute time window, or request delivery outside normal hours.');
    const date=text(body.requested_delivery_date),start=text(body.requested_window_start),end=text(body.requested_window_end);
    if(!validDate(date)||!/^\d{2}:\d{2}$/.test(start)||!/^\d{2}:\d{2}$/.test(end)) throw new Error('Choose a valid delivery date and time window.');
    const config=scheduleConfig(territory.id,date),match=config.windows.find(x=>x.start===start&&x.end===end); if(!match) throw new Error('That delivery window is no longer available. Please choose another time.');
    return {type,date,start,end,label:match.label,timezone,message:''};
  }

  function saveSchedule(territoryId, body) {
    const territory=one('SELECT * FROM territories WHERE id=?',territoryId); if(!territory)throw new Error('Delivery area not found.');
    const timezone=text(body.timezone)||text(territory.timezone)||'America/Vancouver';
    try{new Intl.DateTimeFormat('en-CA',{timeZone:timezone}).format(new Date());}catch{throw new Error('Choose a valid IANA timezone.');}
    const hours=Array.isArray(body.hours)?body.hours:[];
    for(const row of hours){const day=int(row.weekday,-1),open=int(row.open_minute,-1),close=int(row.close_minute,-1);if(day<0||day>6||open<0||close>1440||close<=open)throw new Error('Each open period needs a valid day, opening time and closing time.');}
    db.transaction(()=>{
      run('DELETE FROM territory_weekly_hours WHERE territory_id=?',territoryId);
      const stamp=now();
      hours.forEach((row,index)=>run('INSERT INTO territory_weekly_hours(id,territory_id,weekday,open_minute,close_minute,active,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?)',id(),territoryId,int(row.weekday),int(row.open_minute),int(row.close_minute),index,stamp,stamp));
      run('UPDATE territories SET timezone=?,scheduling_configured=?,updated_at=? WHERE id=?',timezone,hours.length?1:0,stamp,territoryId);
    })();
    return {timezone,scheduling_configured:hours.length>0,hours:all('SELECT * FROM territory_weekly_hours WHERE territory_id=? ORDER BY weekday,open_minute',territoryId)};
  }

  function applyOrderDetails(orderId, body, territory, schedule) {
    const manual=bool(body.manual_location),meeting=text(body.meeting_instructions); if(manual&&!meeting) throw new Error('Tell us where to meet you.');
    run(`UPDATE orders SET schedule_type=?,requested_delivery_date=?,requested_window_start=?,requested_window_end=?,requested_window_label=?,territory_timezone_snapshot=?,outside_hours_message=?,manual_location=?,meeting_instructions=?,location_confirmed=?,final_total_pending=?,verified_address=?,updated_at=? WHERE id=?`,schedule.type,schedule.date,schedule.start,schedule.end,schedule.label,schedule.timezone,schedule.message,manual,meeting,manual?0:1,manual?1:0,manual?'':text(body.address),now(),orderId);
    if(manual) addOrderEvent(orderId,'location_needs_confirmation','Location needs confirmation',{meeting_instructions:meeting},{attention:1,created_by_role:'system',visible_to_customer:true});
    if(schedule.type==='outside_hours') addOrderEvent(orderId,'outside_hours_request','Outside-hours delivery requested',{message:schedule.message,date:schedule.date},{attention:1,created_by_role:'system',visible_to_customer:true});
  }

  function memberships(driverId){return all(`SELECT m.*,t.name territory_name,t.slug territory_slug FROM driver_territory_memberships m JOIN territories t ON t.id=m.territory_id WHERE m.driver_id=? AND m.active=1 AND t.active=1 AND t.archived=0 ORDER BY CASE m.role WHEN 'supervisor' THEN 0 ELSE 1 END,t.name`,driverId);}
  function canAccessOrder(driverId,order){return order.assigned_driver_id===driverId||!!one('SELECT 1 FROM order_watchers WHERE order_id=? AND driver_id=?',order.id,driverId);}
  function assignByVerifiedZone(orderId) {
    const order=one('SELECT * FROM orders WHERE id=?',orderId); if(!order||order.manual_location||!order.location_confirmed||!order.zone_id)return order;
    const rule=one(`SELECT * FROM territory_dispatch_rules WHERE territory_id=? AND (zone_id=? OR zone_id IS NULL) AND active=1 ORDER BY CASE WHEN zone_id=? THEN 0 ELSE 1 END LIMIT 1`,order.territory_id,order.zone_id,order.zone_id); if(!rule)return order;
    run('UPDATE orders SET assigned_driver_id=?,updated_at=? WHERE id=?',rule.primary_driver_id,now(),orderId);
    if(rule.watcher_driver_id) run(`INSERT OR IGNORE INTO order_watchers(order_id,driver_id,role,created_at) VALUES(?,?, 'oversight',?)`,orderId,rule.watcher_driver_id,now());
    return one('SELECT * FROM orders WHERE id=?',orderId);
  }

  function createAction({kind,territoryId,orderId=null,actorRole,actorDriverId=null,recipientType='',recipientDriverId=null,note='',financialEffect='none',totalAmount=0,lines=[]}){
    const actionId=id(),stamp=now();
    run(`INSERT INTO operational_actions(id,kind,territory_id,order_id,actor_role,actor_driver_id,recipient_type,recipient_driver_id,note,financial_effect,total_amount_cents,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,actionId,kind,territoryId,orderId,actorRole,actorDriverId,recipientType,recipientDriverId,note,financialEffect,int(totalAmount),stamp);
    for(const line of lines) run(`INSERT INTO operational_action_lines(id,action_id,product_id,line_role,qty,inventory_delta,rate_cents_snapshot,amount_cents,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,id(),actionId,line.productId,line.role,int(line.qty),int(line.delta),int(line.rate),int(line.amount),jsonText(line.metadata||{}),stamp);
    return actionId;
  }
  function openPeriod(territoryId,driverId){let p=one("SELECT * FROM platform_settlement_periods WHERE territory_id=? AND driver_id=? AND status='open'",territoryId,driverId);if(p)return p;const last=one("SELECT closed_at FROM platform_settlement_periods WHERE territory_id=? AND driver_id=? AND status='closed' ORDER BY closed_at DESC LIMIT 1",territoryId,driverId),pid=id(),stamp=now();run("INSERT INTO platform_settlement_periods(id,territory_id,driver_id,started_at,status,created_at,updated_at) VALUES(?,?,?,?,'open',?,?)",pid,territoryId,driverId,last?.closed_at||stamp,stamp,stamp);return one('SELECT * FROM platform_settlement_periods WHERE id=?',pid);}

  function adminFree(body){
    const territoryId=text(body.territory_id),productId=text(body.product_id),qty=Math.max(0,int(body.qty)),source=text(body.source)||'territory'; if(!productId||!qty)throw new Error('Choose a product and quantity.');
    return db.transaction(()=>{ if(source==='company') companyStock.adjustCompanyReserve({productId,qtyDelta:-qty,movementType:'admin_free_cans',note:text(body.note)||'Free cans',role:'admin'}); else {if(!territoryId)throw new Error('Choose where the cans are now.');companyStock.adjustTerritory({territoryId,productId,qtyDelta:-qty,movementType:'admin_free_cans',note:text(body.note)||'Free cans',role:'admin'});} const tid=territoryId||one('SELECT id FROM territories WHERE active=1 AND archived=0 ORDER BY name LIMIT 1')?.id;const actionId=createAction({kind:'admin_free_cans',territoryId:tid,actorRole:'admin',recipientType:text(body.recipient_type)||'self',recipientDriverId:text(body.recipient_driver_id)||null,note:text(body.note),lines:[{productId,role:'free',qty,delta:-qty}]});return {ok:true,action_id:actionId,amount_cents:0};})();
  }
  function takeForSelf(driver,body){
    const territoryId=text(body.territory_id)||driver.territory_id,productId=text(body.product_id),qty=Math.max(0,int(body.qty)); if(!memberships(driver.id).some(x=>x.territory_id===territoryId))throw new Error('You do not have access to that area.');if(!productId||!qty)throw new Error('Choose a product and quantity.');
    const rate=Math.max(0,int(driver.personal_use_rate_cents,1000)),amount=qty*rate;
    return db.transaction(()=>{companyStock.adjustTerritory({territoryId,productId,qtyDelta:-qty,movementType:'driver_take_for_self',note:text(body.note)||'Take for self',role:'driver',driverSourceId:driver.id});const actionId=createAction({kind:'take_for_self',territoryId,actorRole:'driver',actorDriverId:driver.id,recipientType:'self',recipientDriverId:driver.id,note:text(body.note),financialEffect:'personal_use_charge',totalAmount:amount,lines:[{productId,role:'personal_use',qty,delta:-qty,rate,amount}]});const period=openPeriod(territoryId,driver.id);run(`INSERT INTO platform_settlement_transactions(id,period_id,territory_id,driver_id,kind,qty,amount_cents,note,created_by_role,created_at,rate_cents,action_id,financial_effect) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,id(),period.id,territoryId,driver.id,'taken_for_self',qty,amount,text(body.note)||'Take for self','driver',now(),rate,actionId,'personal_use_charge');return {ok:true,action_id:actionId,qty,rate_cents:rate,amount_cents:amount};})();
  }
  function promotionalCan(driver,orderId,body){
    const order=one('SELECT * FROM orders WHERE id=?',orderId);if(!order||!canAccessOrder(driver.id,order))throw new Error('Order not found.');if(one('SELECT 1 FROM order_promotional_free_cans WHERE order_id=?',orderId))throw new Error('This customer transaction already has its one promotional free can.');const productId=text(body.product_id);if(!productId)throw new Error('Choose a product.');
    return db.transaction(()=>{companyStock.adjustTerritory({territoryId:order.territory_id,productId,qtyDelta:-1,movementType:'customer_promotional_free_can',orderId,driverId:order.assigned_driver_id,note:text(body.note)||'Customer promotional can',role:'driver',driverSourceId:driver.id});const actionId=createAction({kind:'customer_promotional_free_can',territoryId:order.territory_id,orderId,actorRole:'driver',actorDriverId:driver.id,recipientType:'customer',note:text(body.note),lines:[{productId,role:'promotion',qty:1,delta:-1}]});run('INSERT INTO order_promotional_free_cans(order_id,action_id,product_id,created_at) VALUES(?,?,?,?)',orderId,actionId,productId,now());addOrderEvent(orderId,'customer_promotional_free_can','Driver gave one promotional can',{product_id:productId,action_id:actionId},{created_by_role:'driver',created_by_driver_id:driver.id,visible_to_customer:false});return {ok:true,action_id:actionId,qty:1,amount_cents:0};})();
  }
  function swap(driver,orderId,body){
    const order=one('SELECT * FROM orders WHERE id=?',orderId);if(!order||!canAccessOrder(driver.id,order))throw new Error('Order not found.');const returnedProduct=text(body.returned_product_id),replacementProduct=text(body.replacement_product_id),returned=Math.max(0,int(body.returned_qty)),resellable=Math.max(0,int(body.resellable_qty)),nonresellable=Math.max(0,int(body.nonresellable_qty)),replacement=Math.max(0,int(body.replacement_qty));if(!returnedProduct||!replacementProduct||!returned||!replacement)throw new Error('Choose returned and replacement products and quantities.');if(resellable+nonresellable!==returned)throw new Error('Resellable plus non-resellable cans must equal the returned quantity.');
    return db.transaction(()=>{if(resellable)companyStock.adjustTerritory({territoryId:order.territory_id,productId:returnedProduct,qtyDelta:resellable,movementType:'swap_resellable_return',orderId,driverId:order.assigned_driver_id,note:text(body.note)||'Customer swap',role:'driver',driverSourceId:driver.id});companyStock.adjustTerritory({territoryId:order.territory_id,productId:replacementProduct,qtyDelta:-replacement,movementType:'swap_replacement',orderId,driverId:order.assigned_driver_id,note:text(body.note)||'Customer swap',role:'driver',driverSourceId:driver.id});const actionId=createAction({kind:'swap_cans',territoryId:order.territory_id,orderId,actorRole:'driver',actorDriverId:driver.id,recipientType:'customer',note:text(body.note),lines:[{productId:returnedProduct,role:'returned_resellable',qty:resellable,delta:resellable,metadata:{returned_qty:returned}},{productId:returnedProduct,role:'returned_nonresellable',qty:nonresellable,delta:0},{productId:replacementProduct,role:'replacement',qty:replacement,delta:-replacement}]});addOrderEvent(orderId,'swap_cans','Driver completed a can swap',{action_id:actionId,returned,resellable,nonresellable,replacement},{created_by_role:'driver',created_by_driver_id:driver.id});return {ok:true,action_id:actionId,amount_cents:0};})();
  }
  function recordOffsite(orderId, body, actorRole, actorDriverId=null){
    const order=one('SELECT * FROM orders WHERE id=?',orderId);if(!order)throw new Error('Off-site order not found.');
    const lines=all('SELECT product_id,qty,line_total_cents FROM order_items WHERE order_id=?',orderId).filter(x=>x.product_id).map(x=>({productId:x.product_id,role:'offsite_sale',qty:x.qty,delta:-int(x.qty),amount:int(x.line_total_cents),metadata:{payment_method:text(body.payment_method),payment_destination:text(body.payment_destination)||'driver'}}));
    return createAction({kind:'offsite_sale',territoryId:order.territory_id,orderId,actorRole,actorDriverId,recipientType:'customer',note:text(body.note)||text(body.payment_note),financialEffect:'real_sale',totalAmount:int(order.total_cents),lines});
  }
  function setFinalTotal(orderId,body,actorRole,driverId=null){
    const order=one('SELECT * FROM orders WHERE id=?',orderId);if(!order)throw new Error('Order not found.');const qty=int(one('SELECT COALESCE(SUM(qty),0) qty FROM order_items WHERE order_id=?',orderId)?.qty),zoneId=text(body.zone_id);let zone=null,delivery;
    if(zoneId){zone=one('SELECT * FROM delivery_zones WHERE id=? AND territory_id=? AND active=1',zoneId,order.territory_id);if(!zone)throw new Error('Choose an active delivery area for this order.');delivery=int(zone.fee_cents??Math.round(Number(zone.fee||0)*100));if(zone.free_at_qty!=null&&qty>=int(zone.free_at_qty))delivery=0;}else if(body.delivery_fee_cents!=null){delivery=Math.max(0,int(body.delivery_fee_cents));}else throw new Error('Choose a delivery area or enter a delivery fee.');
    const normal=zone?int(zone.fee_cents??Math.round(Number(zone.fee||0)*100)):delivery,pre=int(order.subtotal_cents)+delivery,step=Math.max(1,int(setting('round_down_to_cents','500'),500)),total=Math.floor(pre/step)*step,discount=Math.max(0,pre-total),savings=Math.max(0,normal-delivery);
    run(`UPDATE orders SET zone_id=?,zone_name_snapshot=?,zone_fee_snapshot_cents=?,normal_delivery_fee_cents=?,delivery_fee_cents=?,delivery_fee=?,pre_discount_total_cents=?,customer_discount_cents=?,total_cents=?,total=?,delivery_savings_cents=?,delivery_discount_reason=?,final_total_pending=0,location_confirmed=?,updated_at=? WHERE id=?`,zone?.id||null,zone?.name||'',normal,normal,delivery,delivery/100,pre,discount,total,total/100,savings,savings?(zone?.name||'Delivery reward'):'',zone?1:order.location_confirmed,now(),orderId);
    addOrderEvent(orderId,'final_total_confirmed',`Final delivery total confirmed`,{zone_id:zone?.id||null,delivery_fee_cents:delivery,total_cents:total},{attention:0,created_by_role:actorRole,created_by_driver_id:driverId,visible_to_customer:true});return one('SELECT * FROM orders WHERE id=?',orderId);
  }
  function updatePersonalRate(actor,driverId,body){const target=one('SELECT * FROM drivers WHERE id=?',driverId);if(!target)throw new Error('Driver not found.');if(actor.role==='driver'&&(actor.id!==target.id||!target.personal_rate_driver_editable))throw new Error('Only Victoria Driver 1 can change a personal-use rate from the Driver app.');const rate=Math.max(0,int(body.personal_use_rate_cents));run('UPDATE drivers SET personal_use_rate_cents=?,updated_at=? WHERE id=?',rate,now(),driverId);return one('SELECT id,name,personal_use_rate_cents,personal_rate_driver_editable FROM drivers WHERE id=?',driverId);}

  installSchema(); migrateAndSeed();
  return { scheduleConfig,saveSchedule,validateSchedule,applyOrderDetails,memberships,canAccessOrder,assignByVerifiedZone,adminFree,takeForSelf,promotionalCan,swap,recordOffsite,setFinalTotal,updatePersonalRate };
};
