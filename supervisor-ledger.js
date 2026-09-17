'use strict';

// Private Victoria supervisor accounting. It does not mutate orders, payments or
// inventory. Balances are derived from completed orders and actual received
// customer payments, with separate permanent clearing records.
module.exports = function createSupervisorLedger({ db, now, id, text, int }) {
  const one=(sql,...args)=>db.prepare(sql).get(...args);
  const all=(sql,...args)=>db.prepare(sql).all(...args);
  const run=(sql,...args)=>db.prepare(sql).run(...args);
  const setting=(key,fallback='')=>one('SELECT value FROM settings WHERE key=?',key)?.value ?? fallback;
  const setSetting=(key,value)=>run(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,key,String(value),now());
  db.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_account_clears(
      id TEXT PRIMARY KEY,
      territory_id TEXT NOT NULL,
      supervisor_driver_id TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK(account_type IN ('subordinate','company')),
      source_driver_id TEXT,
      signed_amount_cents INTEGER NOT NULL,
      payable_amount_cents INTEGER NOT NULL DEFAULT 0,
      discarded_rounding_cents INTEGER NOT NULL DEFAULT 0,
      note TEXT DEFAULT '',
      created_by_role TEXT NOT NULL,
      created_by_driver_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE RESTRICT,
      FOREIGN KEY(supervisor_driver_id) REFERENCES drivers(id) ON DELETE RESTRICT,
      FOREIGN KEY(source_driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
      FOREIGN KEY(created_by_driver_id) REFERENCES drivers(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_supervisor_clears_scope ON supervisor_account_clears(territory_id,supervisor_driver_id,account_type,source_driver_id,created_at);
  `);
  const columns=table=>new Set(all(`PRAGMA table_info(${table})`).map(x=>x.name));
  const add=(table,name,def)=>{if(!columns(table).has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`)};
  add('orders','supervisor_rate_cents_snapshot','INTEGER');
  add('orders','company_rate_cents_snapshot','INTEGER');
  add('supervisor_account_clears','payable_amount_cents','INTEGER NOT NULL DEFAULT 0');
  add('supervisor_account_clears','discarded_rounding_cents','INTEGER NOT NULL DEFAULT 0');
  if(setting('supervisor_account_v1','')!=='done'){setSetting('supervisor_account_v1','done');}

  function victoria(){return one("SELECT * FROM territories WHERE slug='victoria'");}
  function supervisor(){const tid=victoria()?.id;if(!tid)return null;const configured=text(setting('victoria_driver_1_id',''));return configured?one('SELECT * FROM drivers WHERE id=?',configured):one("SELECT * FROM drivers WHERE territory_id=? AND lower(trim(name))='victoria driver 1' LIMIT 1",tid);}
  function subordinateRate(qty){qty=int(qty);return qty>=20?1050:qty>=10?1200:1400;}
  function roundTowardZero5(value){const sign=value<0?-1:1;return sign*Math.floor(Math.abs(int(value))/500)*500;}
  function snapshotOrder(orderId){const o=one('SELECT * FROM orders WHERE id=?',orderId);if(!o||o.status!=='completed'||!o.assigned_driver_id)return null;const v=victoria(),sup=supervisor();if(!v||!sup||o.territory_id!==v.id)return null;const qty=int(one('SELECT COALESCE(SUM(qty),0) q FROM order_items WHERE order_id=?',orderId)?.q);const sub=o.assigned_driver_id===sup.id?null:subordinateRate(qty),company=900;run('UPDATE orders SET supervisor_rate_cents_snapshot=COALESCE(supervisor_rate_cents_snapshot,?),company_rate_cents_snapshot=COALESCE(company_rate_cents_snapshot,?),updated_at=? WHERE id=?',sub,company,now(),orderId);return one('SELECT * FROM orders WHERE id=?',orderId);}
  function companyReceipts(orderId){return int(one("SELECT COALESCE(SUM(amount_cents),0) c FROM payments WHERE order_id=? AND status='received' AND lower(destination_type) IN ('boss','company')",orderId)?.c);}
  function orderRow(o,sup){const qty=int(one('SELECT COALESCE(SUM(qty),0) q FROM order_items WHERE order_id=?',o.id)?.q),companyRate=int(o.company_rate_cents_snapshot,900)||900,subRate=o.assigned_driver_id===sup.id?0:(int(o.supervisor_rate_cents_snapshot)||subordinateRate(qty)),received=companyReceipts(o.id);return{id:o.id,order_no:o.order_no,driver_id:o.assigned_driver_id,completed_at:o.completed_at,qty,company_rate_cents:companyRate,company_gross_cents:qty*companyRate,subordinate_rate_cents:subRate,subordinate_gross_cents:qty*subRate,company_received_cents:received,total_cents:int(o.total_cents)};}
  function report(){
    const v=victoria(),sup=supervisor();if(!v||!sup)return{enabled:false};
    const orders=all("SELECT * FROM orders WHERE territory_id=? AND status='completed' AND assigned_driver_id IS NOT NULL ORDER BY completed_at,id",v.id);orders.forEach(o=>snapshotOrder(o.id));const rows=orders.map(o=>orderRow(one('SELECT * FROM orders WHERE id=?',o.id),sup.id));
    const driverIds=[...new Set(rows.filter(x=>x.driver_id!==sup.id).map(x=>x.driver_id))];
    const subordinates=driverIds.map(driverId=>{const tx=rows.filter(x=>x.driver_id===driverId),gross=tx.reduce((s,x)=>s+x.subordinate_gross_cents,0),credits=tx.reduce((s,x)=>s+x.company_received_cents,0),clears=int(one("SELECT COALESCE(SUM(signed_amount_cents),0) c FROM supervisor_account_clears WHERE territory_id=? AND supervisor_driver_id=? AND account_type='subordinate' AND source_driver_id=?",v.id,sup.id,driverId)?.c),exact=gross-credits-clears,rounded=roundTowardZero5(exact),driver=one('SELECT id,name FROM drivers WHERE id=?',driverId);return{driver,gross_cents:gross,company_received_cents:credits,cleared_cents:clears,exact_balance_cents:exact,payable_cents:rounded,direction:rounded>=0?'driver_owes_supervisor':'supervisor_owes_driver',transactions:tx};});
    const companyGross=rows.reduce((s,x)=>s+x.company_gross_cents,0),companyCredits=rows.reduce((s,x)=>s+x.company_received_cents,0),companyClears=int(one("SELECT COALESCE(SUM(signed_amount_cents),0) c FROM supervisor_account_clears WHERE territory_id=? AND supervisor_driver_id=? AND account_type='company'",v.id,sup.id)?.c),companyExact=companyGross-companyCredits-companyClears,companyPayable=roundTowardZero5(companyExact);
    return{enabled:true,territory:{id:v.id,name:v.name},supervisor:{id:sup.id,name:sup.name},subordinates,company:{gross_cents:companyGross,company_received_cents:companyCredits,cleared_cents:companyClears,exact_balance_cents:companyExact,payable_cents:companyPayable,direction:companyPayable>=0?'send_to_company':'company_owes_supervisor',transactions:rows},clears:all('SELECT * FROM supervisor_account_clears WHERE territory_id=? AND supervisor_driver_id=? ORDER BY created_at DESC LIMIT 200',v.id,sup.id)};
  }
  function clearAccount({accountType,sourceDriverId=null,note='',createdByRole,createdByDriverId=null}){const r=report();if(!r.enabled)throw new Error('Supervisor accounts are not configured.');let signed;if(accountType==='company')signed=int(r.company.exact_balance_cents);else{const x=r.subordinates.find(v=>v.driver.id===sourceDriverId);if(!x)throw new Error('Driver account not found.');signed=int(x.exact_balance_cents);}const rounded=roundTowardZero5(signed),discarded=signed-rounded;if(!signed)return{ok:true,cleared_cents:0,discarded_rounding_cents:0,report:r};run('INSERT INTO supervisor_account_clears(id,territory_id,supervisor_driver_id,account_type,source_driver_id,signed_amount_cents,payable_amount_cents,discarded_rounding_cents,note,created_by_role,created_by_driver_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id(),r.territory.id,r.supervisor.id,accountType,sourceDriverId,signed,rounded,discarded,text(note)||'Account settled',createdByRole,createdByDriverId,now());return{ok:true,cleared_cents:rounded,discarded_rounding_cents:discarded,report:report()};}
  function mayDriverView(driver){const sup=supervisor();return !!sup&&driver?.id===sup.id;}
  return{snapshotOrder,report,clearAccount,mayDriverView,subordinateRate,roundTowardZero5};
};
