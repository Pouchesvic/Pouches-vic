(() => {
  'use strict';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const E = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const money = c => new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD'}).format((Number(c)||0)/100);
  let config = null, territoryUi = null, watchedSlug = '', lastOrderMeta = null;

  const css = document.createElement('style');
  css.textContent = `
    .pv-gate{position:fixed;inset:0;background:#171717;color:#fff;z-index:9999;display:flex;align-items:center;justify-content:center;padding:22px}
    .pv-gate-card{width:min(540px,100%);text-align:center}.pv-gate-card h1{font-size:34px;margin:8px 0 14px}.pv-gate-card p{font-size:17px;line-height:1.5;color:#ddd}
    .pv-gate-btn{width:100%;border:0;border-radius:13px;padding:16px;margin:7px 0;font-size:17px;font-weight:900}.pv-gate-btn.primary{background:#fff;color:#111}.pv-gate-btn.secondary{background:#444;color:#fff}
    .pv-address-card{background:#fff;color:#111;border-radius:22px;padding:22px;text-align:left;box-shadow:0 18px 55px #0006}.pv-address-card h2{text-align:center;margin:0 0 8px}.pv-address-card p{text-align:center;color:#4f4f4f;line-height:1.45}
    .pv-address-wrap{position:relative}.pv-address-input{width:100%;border:2px solid #111;border-radius:12px;padding:14px 44px 14px 14px;font-size:17px}.pv-address-pin{position:absolute;right:14px;top:13px;font-size:20px}
    .pv-suggestions{position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid #bbb;border-radius:0 0 12px 12px;box-shadow:0 10px 25px #0002;z-index:10002;max-height:250px;overflow:auto}.pv-suggestion{display:block;width:100%;border:0;border-bottom:1px solid #ddd;background:#fff;text-align:left;padding:13px;font-size:15px;color:#222}.pv-suggestion:last-child{border-bottom:0}
    .pv-address-status{font-size:14px;line-height:1.45;margin:10px 0;min-height:20px}.pv-good{color:#146b2f;font-weight:800}.pv-warn{color:#795000;font-weight:800}.pv-bad{color:#9b2020;font-weight:800}
    .pv-announcement{max-width:680px;margin:12px auto 0;background:#111;color:#fff;border-radius:14px;padding:12px 16px;text-align:center;font-size:14px;font-weight:800}
    .pv-help{background:#fff;border-radius:18px;padding:16px;text-align:center;margin:14px 0}.pv-help b{display:block;font-size:17px;margin-bottom:5px}.pv-help a{display:inline-block;margin-top:8px;background:#111;color:#fff;border-radius:10px;padding:10px 14px;text-decoration:none;font-weight:900}
    .pv-rating{font-size:13px;margin-top:5px;white-space:nowrap}.pv-rating .stars{letter-spacing:1px;color:#795815}.pv-rating .count{color:#4f4f4f;margin-left:4px}
    .pv-zone-confirmed{background:#eef7ee;border-radius:12px;padding:12px;margin:8px 0 12px;font-size:14px;line-height:1.4}.pv-zone-confirmed b{display:block;margin-bottom:3px}
    .pv-method-option{display:flex;align-items:center;gap:12px;width:100%;background:#fff;border:2px solid #ddd;border-radius:16px;padding:15px;margin:9px 0;text-align:left;font-size:16px}.pv-method-option b{flex:1}.pv-method-option.selected{border-color:#111}
    .pv-mini-note{font-size:13px;color:#4f4f4f;margin-top:8px;text-align:center}
    .pv-social-links{display:flex;justify-content:center;align-items:center;gap:8px;margin:0 0 12px}.pv-social-link{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid #ccc;border-radius:50%;color:#333;text-decoration:none;font-size:14px;font-weight:900;background:#fff}.pv-social-link:hover{border-color:#111;color:#111}
  `;
  document.head.appendChild(css);

  async function jfetch(url, opt={}) {
    const r = await fetch(url,{...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})},cache:'no-store'});
    let j={}; try{j=await r.json();}catch{}
    if(!r.ok) throw Error(j.error||'Request failed'); return j;
  }

  // Keep customer records/loyalty linkage in the platform layer. Delivery area is selected by the customer.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function(input, opt={}) {
    const rawUrl=typeof input==='string'?input:(input?.url||'');
    const method=String(opt?.method||(typeof input!=='string'?input?.method:'')||'GET').toUpperCase();
    if(/\/api\/public\/orders(?:\?.*)?$/.test(rawUrl)&&method==='POST'&&!/\/api\/platform\/public\/orders/.test(rawUrl)){
      let body={};try{body=JSON.parse(opt.body||'{}');}catch{}
      body.fulfillment_type='delivery';
      const r=await nativeFetch('/api/platform/public/orders',{...opt,body:JSON.stringify(body)});
      try{lastOrderMeta=(await r.clone().json())?.customer_status||null;}catch{lastOrderMeta=null;}
      setTimeout(insertConfirmationBadge,40);
      return r;
    }
    return nativeFetch(input,opt);
  };

  async function loadConfig(){
    try{config=await jfetch('/api/platform/public/config');return config;}catch{return null;}
  }
  async function loadTerritoryUi(slug){
    try{territoryUi=await jfetch('/api/platform/public/territory/'+encodeURIComponent(slug));return territoryUi;}catch{territoryUi=null;return null;}
  }
  function applyGenericLabels(){
    if(!config?.profile?.generic_business_mode) return;
    const p=config.profile;
    const top=document.querySelector('.top'); if(top) top.textContent=p.service_label||top.textContent;
    const logo=document.querySelector('.logo'); if(logo) logo.textContent=p.business_name||logo.textContent;
    const hero=document.querySelector('.hero h1'); if(hero) hero.innerHTML=E(p.hero_title||'').replace(/\n/g,'<br>');
    const sb=document.getElementById('shopBtn'); if(sb) sb.textContent=p.shop_button||sb.textContent;
    const singular=p.item_singular||'item',plural=p.item_plural||'items';
    const cc=document.getElementById('cartcount'); if(cc){const n=Number((cc.textContent.match(/\d+/)||[0])[0]);cc.textContent=`${n} ${n===1?singular:plural}`;}
    document.querySelectorAll('.qty-label').forEach(x=>x.textContent='QUANTITY');
  }

  function ageAccepted(){return sessionStorage.getItem('pv_entry_age_ok')==='1';}
  function showAgeGate(){
    if(document.getElementById('pvAgeGate') || location.pathname.startsWith('/order/')) return;
    if(config?.profile?.entry_age_gate_enabled===false || ageAccepted()) return;
    const p=config.profile||{}; const g=document.createElement('div');g.id='pvAgeGate';g.className='pv-gate';
    g.innerHTML=`<div class="pv-gate-card"><div style="font-size:13px;font-weight:900;letter-spacing:.12em">${E(p.business_name||'POUCHES LOCAL')}</div><h1>${E(p.entry_age_gate_title||'19+ ONLY')}</h1><p>${E(p.entry_age_gate_text||'You must be 19 or older to enter this site.')}</p><button class="pv-gate-btn primary" id="pvAgeYes">YES, I’M 19+</button><button class="pv-gate-btn secondary" id="pvAgeNo">NO, I’M NOT</button></div>`;
    document.body.appendChild(g);
    document.getElementById('pvAgeYes').onclick=()=>{sessionStorage.setItem('pv_entry_age_ok','1');g.remove();};
    document.getElementById('pvAgeNo').onclick=()=>{g.querySelector('.pv-gate-card').innerHTML='<h1>Sorry</h1><p>You must meet the age requirement to enter this site.</p>';};
  }

  function renderTerritoryExtras(){
    document.getElementById('pvAnnouncement')?.remove();document.getElementById('pvHelp')?.remove();
    const sf=territoryUi?.storefront||{};
    if(sf.announcement_enabled&&sf.announcement_text){const n=document.createElement('div');n.id='pvAnnouncement';n.className='pv-announcement';n.textContent=sf.announcement_text;document.querySelector('.top')?.insertAdjacentElement('afterend',n);}
    if(sf.help_enabled&&(sf.help_heading||sf.help_text||sf.help_contact)){const h=document.createElement('div');h.id='pvHelp';h.className='pv-help';let href='';if(sf.help_contact_action==='sms')href='sms:'+String(sf.help_contact||'').replace(/[^+\d]/g,'');else if(sf.help_contact_action==='tel')href='tel:'+String(sf.help_contact||'').replace(/[^+\d]/g,'');h.innerHTML=`<b>${E(sf.help_heading||'Need help?')}</b>${sf.help_text?`<div>${E(sf.help_text)}</div>`:''}${sf.help_contact?(href?`<a href="${E(href)}">${sf.help_contact_action==='tel'?'CALL':'TEXT'} ${E(sf.help_contact)}</a>`:`<div style="margin-top:8px;font-weight:900">${E(sf.help_contact)}</div>`):''}`;document.querySelector('.footer')?.insertAdjacentElement('beforebegin',h);}
    renderSocialLinks();
  }

  function renderSocialLinks(){
    const links=config?.show_social_links ? (config.social_links||[]) : [],signature=JSON.stringify(links),existing=document.getElementById('pvSocialLinks');
    if(!links.length){existing?.remove();return;}if(existing?.dataset.signature===signature)return;existing?.remove();
    const icons={facebook:'f',instagram:'◎',tiktok:'♪',x:'𝕏',youtube:'▶',custom:'↗'},host=document.createElement('div');host.id='pvSocialLinks';host.className='pv-social-links';
    host.dataset.signature=signature;
    host.innerHTML=links.map(x=>`<a class="pv-social-link" href="${E(x.url)}" target="_blank" rel="noopener noreferrer" aria-label="${E(x.label||x.platform||'Social link')}" title="${E(x.label||x.platform||'Social link')}">${icons[x.platform]||icons.custom}</a>`).join('');
    const footer=document.querySelector('.footer');if(footer)footer.insertAdjacentElement('afterbegin',host);
  }

  function renderRatings(){
    if(!config?.modules?.product_ratings?.enabled || !territoryUi?.ratings?.length || !window.data)return;
    const ratings=new Map(territoryUi.ratings.map(r=>[r.product_id,r]));
    const list=(window.data.products||[]).filter(p=>!window.activeBrand||p.brand===window.activeBrand),rows=[...document.querySelectorAll('#products .product-row')];
    rows.forEach((row,i)=>{const p=list[i],r=p&&ratings.get(p.id),existing=row.querySelector('.pv-rating');if(!r){existing?.remove();return;}const signature=`${r.rating}:${r.review_count}`,rounded=Math.max(0,Math.min(5,Math.round(Number(r.rating)||0))),stars='★'.repeat(rounded)+'☆'.repeat(5-rounded);if(existing?.dataset.signature===signature)return;existing?.remove();const el=document.createElement('div');el.className='pv-rating';el.dataset.signature=signature;el.innerHTML=`<span class="stars">${stars}</span> <b>${Number(r.rating).toFixed(1)}</b>${Number(r.review_count)>0?`<span class="count">(${Number(r.review_count)})</span>`:''}`;(row.querySelector('.pmeta')||row.querySelector('.pname'))?.insertAdjacentElement('afterend',el);});
  }

  function ensureCheckoutAge(){
    const age=document.getElementById('ageAck');if(!age||age.dataset.pvReady)return;
    age.dataset.pvReady='1';age.checked=false;
    const span=age.parentElement?.querySelector('span');if(span&&config?.profile?.age_acknowledgement_text)span.textContent=config.profile.age_acknowledgement_text;
  }
  function patchProductRender(){
    if(window.renderProducts&&!window.renderProducts.__pvStorePatched){const original=window.renderProducts;const patched=function(){const r=original();setTimeout(()=>{applyGenericLabels();renderRatings();},0);return r;};patched.__pvStorePatched=true;window.renderProducts=patched;}
    if(window.updateCart&&!window.updateCart.__pvStorePatched){const original=window.updateCart;const patched=function(){const r=original();setTimeout(applyGenericLabels,0);return r;};patched.__pvStorePatched=true;window.updateCart=patched;}
  }
  function insertConfirmationBadge(){
    // Customer loyalty ratings and labels are internal-only.
  }

  async function onTerritoryReady(slug){await loadTerritoryUi(slug);renderTerritoryExtras();renderRatings();applyGenericLabels();}
  async function boot(){
    await loadConfig(); if(!config)return;
    for(let i=0;i<100;i++){if(window.data&&window.currentSlug)break;await sleep(80);}
    if(location.pathname.startsWith('/order/')){applyGenericLabels();renderSocialLinks();return;}
    watchedSlug=window.currentSlug||'victoria';await onTerritoryReady(watchedSlug);patchProductRender();showAgeGate();
    const timer=setInterval(async()=>{
      patchProductRender();ensureCheckoutAge();applyGenericLabels();renderRatings();renderSocialLinks();insertConfirmationBadge();
      const slug=window.currentSlug||'victoria';if(slug!==watchedSlug){watchedSlug=slug;await onTerritoryReady(slug);}
    },650);
    window.addEventListener('beforeunload',()=>clearInterval(timer),{once:true});
  }
  boot();
})();
