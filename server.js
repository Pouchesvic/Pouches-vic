const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "pouchesvic.db");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-now";

fs.mkdirSync(DATA_DIR, {recursive:true});
const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function now(){ return new Date().toISOString(); }
function id(){ return crypto.randomUUID(); }
function bool(v){ return v ? 1 : 0; }
function num(v,d=0){ const n=Number(v); return Number.isFinite(n)?n:d; }
function text(v){ return v == null ? "" : String(v).trim(); }
function jparse(v,d={}){ try{return JSON.parse(v)}catch{return d} }

db.exec(`
CREATE TABLE IF NOT EXISTS territories(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
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
  free_at_qty INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT DEFAULT '',
  rule_notes TEXT DEFAULT '',
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
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(territory_id, product_id),
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS drivers(
  id TEXT PRIMARY KEY,
  territory_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT 'driver',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS settlement_rules(
  id TEXT PRIMARY KEY,
  territory_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  rule_type TEXT NOT NULL,
  from_driver_id TEXT,
  to_driver_id TEXT,
  zone_id TEXT,
  amount REAL NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(territory_id) REFERENCES territories(id) ON DELETE CASCADE,
  FOREIGN KEY(from_driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
  FOREIGN KEY(to_driver_id) REFERENCES drivers(id) ON DELETE SET NULL,
  FOREIGN KEY(zone_id) REFERENCES delivery_zones(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY,
  order_no INTEGER,
  territory_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  customer_name TEXT DEFAULT '',
  customer_phone TEXT DEFAULT '',
  customer_email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  delivery_notes TEXT DEFAULT '',
  zone_id TEXT,
  zone_name_snapshot TEXT DEFAULT '',
  zone_fee_snapshot REAL NOT NULL DEFAULT 0,
  zone_fee_override REAL,
  zone_override_note TEXT DEFAULT '',
  assigned_driver_id TEXT,
  payment_method TEXT DEFAULT '',
  payment_note TEXT DEFAULT '',
  subtotal REAL NOT NULL DEFAULT 0,
  delivery_fee REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  rounding_adjustment REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY(territory_id) REFERENCES territories(id),
  FOREIGN KEY(zone_id) REFERENCES delivery_zones(id) ON DELETE SET NULL,
  FOREIGN KEY(assigned_driver_id) REFERENCES drivers(id) ON DELETE SET NULL
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
  line_total REAL NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS order_adjustments(
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  affects_inventory INTEGER NOT NULL DEFAULT 0,
  product_id TEXT,
  qty_delta INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
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

function one(sql, ...args){ return db.prepare(sql).get(...args); }
function all(sql, ...args){ return db.prepare(sql).all(...args); }
function run(sql, ...args){ return db.prepare(sql).run(...args); }

function seed(){
  if (one("SELECT COUNT(*) c FROM territories").c > 0) return;
  const t=now();
  const vic=id(), kel=id(), pg=id();

  const insT=db.prepare(`INSERT INTO territories(id,name,slug,active,domain,currency,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`);
  insT.run(vic,"Victoria","victoria",1,"pouchesvic.com","CAD",t,t);
  insT.run(kel,"Kelowna","kelowna",1,"","CAD",t,t);
  insT.run(pg,"Prince George","prince-george",1,"","CAD",t,t);

  const insTier=db.prepare(`INSERT INTO pricing_tiers(id,territory_id,min_qty,max_qty,unit_price,active,sort_order) VALUES(?,?,?,?,?,?,?)`);
  [[1,9,15],[10,19,13.5],[20,null,12.5]].forEach((x,i)=>insTier.run(id(),vic,x[0],x[1],x[2],1,i));
  [[1,9,15],[10,19,13.5],[20,null,12.5]].forEach((x,i)=>insTier.run(id(),kel,x[0],x[1],x[2],1,i));
  [[1,9,15],[10,19,13.5],[20,null,12.5]].forEach((x,i)=>insTier.run(id(),pg,x[0],x[1],x[2],1,i));

  const green=id(), orange=id(), pink=id();
  const insZ=db.prepare(`INSERT INTO delivery_zones(id,territory_id,name,color_label,fee,free_at_qty,active,description,rule_notes,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  insZ.run(green,vic,"Green","Green",10,10,1,
    "Core Victoria / closest delivery area",
    "South of Ash/Arbutus/Royal Oak; south of Wilkinson; south of Helmcken; includes Downtown, Gordon Head, Oak Bay and Fairfield. Pipeline Rd address near View Royal included. Near Victoria General, the area just south of the north-running boundary street is Green.",0);
  insZ.run(orange,vic,"Orange","Orange",15,null,1,
    "Outer Victoria / Westshore and mid-north area",
    "North of Royal Oak; Pipeline to south of Keating; north of Victoria General including Bear Mountain, Colwood and Royal Bay; south of Sooke Rd; general Langford.",1);
  insZ.run(pink,vic,"Pink","Pink",20,null,1,
    "Farthest regular Victoria delivery area",
    "North of Keating; also north of Sooke Rd beyond Royal Bay toward Happy Valley or Sooke; north of where 4 lanes start. Regular max distance to Gillespie Rd or about 5 km up Happy Valley.",2);

  // Non-Victoria territories start editable and simple.
  insZ.run(id(),kel,"Local","Local",0,null,1,"Default editable zone","Set Kelowna zone boundaries/fees in Admin.",0);
  insZ.run(id(),pg,"Local","Local",0,null,1,"Default editable zone","Set Prince George zone boundaries/fees in Admin.",0);

  const d1=id(), d2=id();
  const insD=db.prepare(`INSERT INTO drivers(id,territory_id,name,active,role,email,phone,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  insD.run(d1,vic,"Victoria Driver 1",1,"operations_admin","","","Victoria supervisor/settlement driver",t,t);
  insD.run(d2,vic,"Victoria Driver 2",1,"driver","","","Victoria subordinate driver",t,t);
  insD.run(id(),kel,"Kelowna Driver",1,"driver","","","",t,t);
  insD.run(id(),pg,"Prince George Driver",1,"driver","","","",t,t);

  const insR=db.prepare(`INSERT INTO settlement_rules(id,territory_id,name,active,rule_type,from_driver_id,to_driver_id,zone_id,amount,notes,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  insR.run(id(),vic,"Driver 2 pays Driver 1 per can",1,"per_can_driver_to_driver",d2,d1,null,10,"Driver 2 pays Driver 1 $10 for every can sold.",0);
  insR.run(id(),vic,"Driver 1 pays Boss per can",1,"per_can_driver_to_boss",d1,null,null,9,"Boss settles weekly only with Driver 1. Driver 1 owes Boss $9 per can.",1);
  insR.run(id(),vic,"Driver 2 Orange fee share to Driver 1",1,"zone_fee_driver_to_driver",d2,d1,orange,5,"On Driver 2 Orange deliveries, Driver 2 keeps fee minus $5 to Driver 1.",2);
  insR.run(id(),vic,"Driver 2 Pink fee share to Driver 1",1,"zone_fee_driver_to_driver",d2,d1,pink,5,"On Driver 2 Pink deliveries, Driver 2 keeps fee minus $5 to Driver 1.",3);
  insR.run(id(),vic,"Green fee goes to Driver 1",1,"zone_fee_to_driver",null,d1,green,0,"If Green delivery fee is charged, the Green delivery fee belongs to Driver 1. Amount 0 means use actual charged fee.",4);

  run("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)","round_down_to","5",t);
  run("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)","shipping_enabled","false",t);
  run("INSERT OR REPLACE INTO counters(key,value) VALUES('order_no',1000)");
}
seed();

const sessions = new Map();
function parseCookies(req){
  const out={};
  (req.headers.cookie||"").split(";").forEach(p=>{
    const i=p.indexOf("="); if(i>-1) out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim());
  });
  return out;
}
function session(req){
  const tok=parseCookies(req).pv_session;
  return tok && sessions.get(tok);
}
function requireAdmin(req,res){
  if(!session(req)){ send(res,401,{error:"Unauthorized"}); return false; }
  return true;
}
function send(res,status,body,type="application/json; charset=utf-8",headers={}){
  res.writeHead(status,{"Content-Type":type,...headers});
  if(Buffer.isBuffer(body)) return res.end(body);
  res.end(typeof body==="string"?body:JSON.stringify(body));
}
function bodyJson(req){
  return new Promise((resolve,reject)=>{
    let d="";
    req.on("data",c=>{d+=c;if(d.length>2_000_000)req.destroy()});
    req.on("end",()=>{try{resolve(d?JSON.parse(d):{})}catch(e){reject(e)}});
    req.on("error",reject);
  });
}
function serve(res,file){
  const p=path.join(__dirname,file);
  if(!fs.existsSync(p)) return send(res,404,"Not found","text/plain");
  send(res,200,fs.readFileSync(p),"text/html; charset=utf-8",{"Cache-Control":"no-store"});
}
function publicTerritory(slug){
  return one("SELECT * FROM territories WHERE slug=? AND active=1",slug);
}
function territorySnapshot(tid){
  const territory=one("SELECT * FROM territories WHERE id=?",tid);
  if(!territory) return null;
  const tiers=all("SELECT * FROM pricing_tiers WHERE territory_id=? AND active=1 ORDER BY sort_order,min_qty",tid);
  const zones=all("SELECT * FROM delivery_zones WHERE territory_id=? AND active=1 ORDER BY sort_order,name",tid);
  const products=all(`
    SELECT p.id,p.brand,p.flavor,p.strength,p.image,tp.inventory,tp.listed,tp.featured,tp.local_price_override,tp.sort_order
    FROM territory_products tp JOIN products p ON p.id=tp.product_id
    WHERE tp.territory_id=? AND tp.listed=1 AND p.active=1
    ORDER BY tp.featured DESC,tp.sort_order,p.brand,p.flavor`,tid);
  return {territory,tiers,zones,products};
}
function priceFor(tiers,qty){
  const tier=tiers.find(x=>qty>=x.min_qty && (x.max_qty==null || qty<=x.max_qty)) || tiers[tiers.length-1];
  return tier ? Number(tier.unit_price) : 0;
}
function roundDown(value,step){
  step=Number(step)||0;
  return step>0 ? Math.floor((value+1e-9)/step)*step : value;
}
function nextOrderNo(){
  const tx=db.transaction(()=>{
    const r=one("SELECT value FROM counters WHERE key='order_no'");
    const n=(r?.value||1000)+1;
    run("INSERT OR REPLACE INTO counters(key,value) VALUES('order_no',?)",n);
    return n;
  });
  return tx();
}

function createOrder(b){
  const territory=publicTerritory(text(b.territory_slug)||"victoria");
  if(!territory) throw new Error("Territory unavailable");
  const cart=Array.isArray(b.items)?b.items:[];
  if(!cart.length) throw new Error("Order is empty");

  const tiers=all("SELECT * FROM pricing_tiers WHERE territory_id=? AND active=1 ORDER BY sort_order,min_qty",territory.id);
  let qty=0;
  const itemRows=[];
  for(const x of cart){
    const q=Math.max(0,Math.floor(num(x.qty)));
    if(!q) continue;
    const p=one(`
      SELECT p.id,p.brand,p.flavor,p.strength,tp.inventory,tp.listed,tp.local_price_override
      FROM territory_products tp JOIN products p ON p.id=tp.product_id
      WHERE tp.territory_id=? AND p.id=? AND p.active=1`,territory.id,text(x.product_id));
    if(!p || !p.listed) throw new Error("A product is no longer available");
    if(p.inventory < q) throw new Error(`${p.flavor} does not have enough stock`);
    qty += q; itemRows.push({p,q});
  }
  if(!qty) throw new Error("Order is empty");

  const defaultUnit=priceFor(tiers,qty);
  let subtotal=0;
  itemRows.forEach(x=>{
    x.unit= x.p.local_price_override!=null ? Number(x.p.local_price_override) : defaultUnit;
    x.total=x.unit*x.q; subtotal+=x.total;
  });

  const zone=b.zone_id?one("SELECT * FROM delivery_zones WHERE id=? AND territory_id=? AND active=1",text(b.zone_id),territory.id):null;
  let delivery=zone?Number(zone.fee):0;
  if(zone && zone.free_at_qty!=null && qty>=zone.free_at_qty) delivery=0;

  const step=num(one("SELECT value FROM settings WHERE key='round_down_to'")?.value,5);
  const raw=subtotal+delivery;
  const total=roundDown(raw,step);
  const rounding=total-raw;
  const oid=id(), ono=nextOrderNo(), created=now();

  const tx=db.transaction(()=>{
    run(`INSERT INTO orders(id,order_no,territory_id,status,customer_name,customer_phone,customer_email,address,delivery_notes,zone_id,zone_name_snapshot,zone_fee_snapshot,assigned_driver_id,payment_method,payment_note,subtotal,delivery_fee,total,rounding_adjustment,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      oid,ono,territory.id,"new",text(b.customer_name),text(b.customer_phone),text(b.customer_email),text(b.address),text(b.delivery_notes),
      zone?.id||null,zone?.name||"",zone?Number(zone.fee):0,null,text(b.payment_method),text(b.payment_note),subtotal,delivery,total,rounding,created);
    for(const x of itemRows){
      run(`INSERT INTO order_items(id,order_id,product_id,product_name_snapshot,brand_snapshot,strength_snapshot,qty,unit_price,line_total) VALUES(?,?,?,?,?,?,?,?,?)`,
        id(),oid,x.p.id,x.p.flavor,x.p.brand,x.p.strength,x.q,x.unit,x.total);
      run(`UPDATE territory_products SET inventory=inventory-?,updated_at=? WHERE territory_id=? AND product_id=?`,x.q,created,territory.id,x.p.id);
    }
  });
  tx();
  return {id:oid,order_no:ono,total,qty,territory:territory.name};
}

function adminBootstrap(){
  const territories=all("SELECT * FROM territories ORDER BY name");
  return {territories};
}

function territoryAdmin(tid){
  const territory=one("SELECT * FROM territories WHERE id=?",tid);
  if(!territory) return null;
  return {
    territory,
    tiers:all("SELECT * FROM pricing_tiers WHERE territory_id=? ORDER BY sort_order,min_qty",tid),
    zones:all("SELECT * FROM delivery_zones WHERE territory_id=? ORDER BY sort_order,name",tid),
    drivers:all("SELECT * FROM drivers WHERE territory_id=? ORDER BY active DESC,name",tid),
    rules:all(`SELECT r.*,fd.name from_driver_name,td.name to_driver_name,z.name zone_name
      FROM settlement_rules r
      LEFT JOIN drivers fd ON fd.id=r.from_driver_id
      LEFT JOIN drivers td ON td.id=r.to_driver_id
      LEFT JOIN delivery_zones z ON z.id=r.zone_id
      WHERE r.territory_id=? ORDER BY r.sort_order,r.name`,tid),
    products:all(`
      SELECT p.*,tp.id territory_product_id,tp.inventory,tp.listed,tp.featured,tp.local_price_override,tp.sort_order
      FROM products p LEFT JOIN territory_products tp ON tp.product_id=p.id AND tp.territory_id=?
      WHERE p.active=1 ORDER BY p.brand,p.flavor`,tid),
    orders:all(`SELECT o.*,d.name driver_name FROM orders o LEFT JOIN drivers d ON d.id=o.assigned_driver_id
      WHERE o.territory_id=? ORDER BY o.created_at DESC LIMIT 200`,tid)
  };
}
function orderFull(oid){
  const order=one(`SELECT o.*,t.name territory_name,d.name driver_name FROM orders o
    JOIN territories t ON t.id=o.territory_id LEFT JOIN drivers d ON d.id=o.assigned_driver_id WHERE o.id=?`,oid);
  if(!order)return null;
  return {...order,items:all("SELECT * FROM order_items WHERE order_id=?",oid),adjustments:all("SELECT * FROM order_adjustments WHERE order_id=? ORDER BY created_at",oid)};
}
function settlementReport(tid){
  const territory=one("SELECT * FROM territories WHERE id=?",tid);
  const orders=all(`SELECT o.*,d.name driver_name FROM orders o LEFT JOIN drivers d ON d.id=o.assigned_driver_id
    WHERE o.territory_id=? AND o.status='completed' ORDER BY o.completed_at DESC`,tid);
  const rules=all("SELECT * FROM settlement_rules WHERE territory_id=? AND active=1 ORDER BY sort_order",tid);
  const drivers=all("SELECT * FROM drivers WHERE territory_id=?",tid);
  const byDriver={};
  for(const d of drivers) byDriver[d.id]={driver:d.name,cans:0,sales:0,delivery_fees:0,owes:{},receives:{},boss_owed:0};
  for(const o of orders){
    if(!o.assigned_driver_id || !byDriver[o.assigned_driver_id]) continue;
    const cans=one("SELECT COALESCE(SUM(qty),0) q FROM order_items WHERE order_id=?",o.id).q;
    const row=byDriver[o.assigned_driver_id];
    row.cans+=cans; row.sales+=Number(o.subtotal); row.delivery_fees+=Number(o.delivery_fee);
    for(const r of rules){
      if(r.rule_type==="per_can_driver_to_driver" && r.from_driver_id===o.assigned_driver_id){
        const amt=cans*Number(r.amount);
        row.owes[r.to_driver_id]=(row.owes[r.to_driver_id]||0)+amt;
        if(byDriver[r.to_driver_id])byDriver[r.to_driver_id].receives[o.assigned_driver_id]=(byDriver[r.to_driver_id].receives[o.assigned_driver_id]||0)+amt;
      }
      if(r.rule_type==="per_can_driver_to_boss" && r.from_driver_id===o.assigned_driver_id){
        row.boss_owed+=cans*Number(r.amount);
      }
      if(r.rule_type==="zone_fee_driver_to_driver" && r.from_driver_id===o.assigned_driver_id && r.zone_id===o.zone_id){
        const amt=Math.min(Number(r.amount),Number(o.delivery_fee));
        row.owes[r.to_driver_id]=(row.owes[r.to_driver_id]||0)+amt;
        if(byDriver[r.to_driver_id])byDriver[r.to_driver_id].receives[o.assigned_driver_id]=(byDriver[r.to_driver_id].receives[o.assigned_driver_id]||0)+amt;
      }
      if(r.rule_type==="zone_fee_to_driver" && r.zone_id===o.zone_id && r.to_driver_id){
        const amt=Number(r.amount)===0?Number(o.delivery_fee):Math.min(Number(r.amount),Number(o.delivery_fee));
        if(byDriver[r.to_driver_id])byDriver[r.to_driver_id].receives["delivery_fee"]=(byDriver[r.to_driver_id].receives["delivery_fee"]||0)+amt;
      }
    }
  }
  return {territory,rows:Object.entries(byDriver).map(([id,x])=>({id,...x}))};
}

function saveTerritoryEntity(kind,tid,b){
  const t=now();
  if(kind==="tier"){
    if(b.id) run(`UPDATE pricing_tiers SET min_qty=?,max_qty=?,unit_price=?,active=?,sort_order=? WHERE id=? AND territory_id=?`,
      num(b.min_qty), b.max_qty===""||b.max_qty==null?null:num(b.max_qty), num(b.unit_price), bool(b.active), num(b.sort_order), b.id,tid);
    else run(`INSERT INTO pricing_tiers(id,territory_id,min_qty,max_qty,unit_price,active,sort_order) VALUES(?,?,?,?,?,?,?)`,
      id(),tid,num(b.min_qty),b.max_qty===""||b.max_qty==null?null:num(b.max_qty),num(b.unit_price),bool(b.active),num(b.sort_order));
  }
  if(kind==="zone"){
    if(b.id) run(`UPDATE delivery_zones SET name=?,color_label=?,fee=?,free_at_qty=?,active=?,description=?,rule_notes=?,sort_order=? WHERE id=? AND territory_id=?`,
      text(b.name),text(b.color_label),num(b.fee),b.free_at_qty===""||b.free_at_qty==null?null:num(b.free_at_qty),bool(b.active),text(b.description),text(b.rule_notes),num(b.sort_order),b.id,tid);
    else run(`INSERT INTO delivery_zones(id,territory_id,name,color_label,fee,free_at_qty,active,description,rule_notes,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      id(),tid,text(b.name),text(b.color_label),num(b.fee),b.free_at_qty===""||b.free_at_qty==null?null:num(b.free_at_qty),bool(b.active),text(b.description),text(b.rule_notes),num(b.sort_order));
  }
  if(kind==="driver"){
    if(b.id) run(`UPDATE drivers SET name=?,active=?,role=?,email=?,phone=?,notes=?,updated_at=? WHERE id=? AND territory_id=?`,
      text(b.name),bool(b.active),text(b.role)||"driver",text(b.email),text(b.phone),text(b.notes),t,b.id,tid);
    else run(`INSERT INTO drivers(id,territory_id,name,active,role,email,phone,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      id(),tid,text(b.name),bool(b.active),text(b.role)||"driver",text(b.email),text(b.phone),text(b.notes),t,t);
  }
  if(kind==="rule"){
    if(b.id) run(`UPDATE settlement_rules SET name=?,active=?,rule_type=?,from_driver_id=?,to_driver_id=?,zone_id=?,amount=?,notes=?,sort_order=? WHERE id=? AND territory_id=?`,
      text(b.name),bool(b.active),text(b.rule_type),b.from_driver_id||null,b.to_driver_id||null,b.zone_id||null,num(b.amount),text(b.notes),num(b.sort_order),b.id,tid);
    else run(`INSERT INTO settlement_rules(id,territory_id,name,active,rule_type,from_driver_id,to_driver_id,zone_id,amount,notes,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      id(),tid,text(b.name),bool(b.active),text(b.rule_type),b.from_driver_id||null,b.to_driver_id||null,b.zone_id||null,num(b.amount),text(b.notes),num(b.sort_order));
  }
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host}`);
  try{
    if(url.pathname==="/"||url.pathname==="/index.html") return serve(res,"index.html");
    if(url.pathname==="/admin"||url.pathname==="/admin.html") return serve(res,"admin.html");
    if(url.pathname==="/health") return send(res,200,{ok:true,time:now()});

    if(url.pathname==="/api/public/territories" && req.method==="GET")
      return send(res,200,all("SELECT id,name,slug,domain FROM territories WHERE active=1 ORDER BY name"));
    const pub=url.pathname.match(/^\/api\/public\/territory\/([^/]+)$/);
    if(pub && req.method==="GET"){
      const terr=publicTerritory(decodeURIComponent(pub[1]));
      if(!terr)return send(res,404,{error:"Territory not found"});
      return send(res,200,territorySnapshot(terr.id));
    }
    if(url.pathname==="/api/public/orders" && req.method==="POST"){
      const b=await bodyJson(req);
      return send(res,201,createOrder(b));
    }

    if(url.pathname==="/api/admin/login"&&req.method==="POST"){
      const b=await bodyJson(req);
      if(text(b.password)!==ADMIN_PASSWORD)return send(res,401,{error:"Wrong password"});
      const tok=crypto.randomBytes(24).toString("hex");sessions.set(tok,{role:"super_admin",created:Date.now()});
      return send(res,200,{ok:true},"application/json; charset=utf-8",{"Set-Cookie":`pv_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`});
    }
    if(url.pathname==="/api/admin/logout"&&req.method==="POST"){
      const tok=parseCookies(req).pv_session;if(tok)sessions.delete(tok);
      return send(res,200,{ok:true},"application/json; charset=utf-8",{"Set-Cookie":"pv_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"});
    }
    if(url.pathname.startsWith("/api/admin/") && !requireAdmin(req,res)) return;

    if(url.pathname==="/api/admin/bootstrap"&&req.method==="GET")return send(res,200,adminBootstrap());
    const ta=url.pathname.match(/^\/api\/admin\/territories\/([^/]+)$/);
    if(ta&&req.method==="GET"){
      const data=territoryAdmin(decodeURIComponent(ta[1]));if(!data)return send(res,404,{error:"Not found"});return send(res,200,data);
    }
    if(url.pathname==="/api/admin/territories"&&req.method==="POST"){
      const b=await bodyJson(req),tid=id(),t=now();
      run("INSERT INTO territories(id,name,slug,active,domain,currency,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        tid,text(b.name),text(b.slug),bool(b.active??true),text(b.domain),"CAD",t,t);
      [[1,9,15],[10,19,13.5],[20,null,12.5]].forEach((x,i)=>run("INSERT INTO pricing_tiers(id,territory_id,min_qty,max_qty,unit_price,active,sort_order) VALUES(?,?,?,?,?,?,?)",id(),tid,x[0],x[1],x[2],1,i));
      return send(res,201,{id:tid});
    }
    const saveMatch=url.pathname.match(/^\/api\/admin\/territories\/([^/]+)\/(tier|zone|driver|rule)$/);
    if(saveMatch&&req.method==="POST"){
      const b=await bodyJson(req);saveTerritoryEntity(saveMatch[2],decodeURIComponent(saveMatch[1]),b);return send(res,200,{ok:true});
    }

    if(url.pathname==="/api/admin/products"&&req.method==="POST"){
      const b=await bodyJson(req),pid=id(),t=now();
      run("INSERT INTO products(id,brand,flavor,strength,image,notes,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        pid,text(b.brand),text(b.flavor),text(b.strength),text(b.image),text(b.notes),1,t,t);
      return send(res,201,{id:pid});
    }
    const tp=url.pathname.match(/^\/api\/admin\/territories\/([^/]+)\/product\/([^/]+)$/);
    if(tp&&req.method==="PUT"){
      const b=await bodyJson(req),tid=decodeURIComponent(tp[1]),pid=decodeURIComponent(tp[2]),t=now();
      const exists=one("SELECT id FROM territory_products WHERE territory_id=? AND product_id=?",tid,pid);
      if(exists)run(`UPDATE territory_products SET inventory=?,listed=?,featured=?,local_price_override=?,sort_order=?,updated_at=? WHERE territory_id=? AND product_id=?`,
        Math.max(0,Math.floor(num(b.inventory))),bool(b.listed),bool(b.featured),b.local_price_override===""||b.local_price_override==null?null:num(b.local_price_override),num(b.sort_order),t,tid,pid);
      else run(`INSERT INTO territory_products(id,territory_id,product_id,inventory,listed,featured,local_price_override,sort_order,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        id(),tid,pid,Math.max(0,Math.floor(num(b.inventory))),bool(b.listed),bool(b.featured),b.local_price_override===""||b.local_price_override==null?null:num(b.local_price_override),num(b.sort_order),t);
      return send(res,200,{ok:true});
    }

    const ord=url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if(ord&&req.method==="GET"){
      const o=orderFull(decodeURIComponent(ord[1]));if(!o)return send(res,404,{error:"Not found"});return send(res,200,o);
    }
    if(ord&&req.method==="PUT"){
      const oid=decodeURIComponent(ord[1]),b=await bodyJson(req),o=one("SELECT * FROM orders WHERE id=?",oid);if(!o)return send(res,404,{error:"Not found"});
      let delivery=b.delivery_fee==null?Number(o.delivery_fee):Math.max(0,num(b.delivery_fee));
      let subtotal=Number(o.subtotal);
      const step=num(one("SELECT value FROM settings WHERE key='round_down_to'")?.value,5);
      let raw=subtotal+delivery;
      let total=roundDown(raw,step), rounding=total-raw;
      let status=text(b.status)||o.status;
      let completed=o.completed_at;
      if(status==="completed"&&!completed)completed=now();
      if(status!=="completed")completed=null;
      run(`UPDATE orders SET status=?,assigned_driver_id=?,delivery_fee=?,zone_fee_override=?,zone_override_note=?,payment_method=?,payment_note=?,total=?,rounding_adjustment=?,completed_at=? WHERE id=?`,
        status,b.assigned_driver_id||null,delivery,b.delivery_fee==null?o.zone_fee_override:delivery,text(b.zone_override_note)||o.zone_override_note,text(b.payment_method)||o.payment_method,text(b.payment_note)||o.payment_note,total,rounding,completed,oid);
      return send(res,200,orderFull(oid));
    }
    const adj=url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/adjustment$/);
    if(adj&&req.method==="POST"){
      const oid=decodeURIComponent(adj[1]),b=await bodyJson(req),o=one("SELECT * FROM orders WHERE id=?",oid);if(!o)return send(res,404,{error:"Not found"});
      const t=now();
      const tx=db.transaction(()=>{
        run("INSERT INTO order_adjustments(id,order_id,kind,amount,note,affects_inventory,product_id,qty_delta,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          id(),oid,text(b.kind)||"manual",num(b.amount),text(b.note),bool(b.affects_inventory),b.product_id||null,Math.floor(num(b.qty_delta)),t);
        if(b.affects_inventory&&b.product_id&&num(b.qty_delta)!==0){
          run("UPDATE territory_products SET inventory=MAX(0,inventory+?),updated_at=? WHERE territory_id=? AND product_id=?",
            Math.floor(num(b.qty_delta)),t,o.territory_id,b.product_id);
        }
      });tx();return send(res,201,{ok:true});
    }
    const rep=url.pathname.match(/^\/api\/admin\/territories\/([^/]+)\/settlements$/);
    if(rep&&req.method==="GET")return send(res,200,settlementReport(decodeURIComponent(rep[1])));

    return send(res,404,{error:"Not found"});
  }catch(e){
    console.error(e);
    return send(res,400,{error:e.message||"Request failed"});
  }
});
server.listen(PORT,"0.0.0.0",()=>console.log(`Pouches Vic running on ${PORT}`));