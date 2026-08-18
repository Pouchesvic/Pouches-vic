(() => {
  'use strict';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const E = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const money = c => new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD'}).format((Number(c)||0)/100);
  let config = null, territoryUi = null, watchedSlug = '', lastOrderMeta = null;
  let deliveryState = { slug:'', address:'', lat:null, lng:null, quote:null, method:'delivery' };
  let suggestTimer = null, checkoutEnhancedFor = null;

  const css = document.createElement('style');
  css.textContent = `
    .pv-gate{position:fixed;inset:0;background:#171717;color:#fff;z-index:9999;display:flex;align-items:center;justify-content:center;padding:22px}
    .pv-gate-card{width:min(540px,100%);text-align:center}.pv-gate-card h1{font-size:34px;margin:8px 0 14px}.pv-gate-card p{font-size:17px;line-height:1.5;color:#ddd}
    .pv-gate-btn{width:100%;border:0;border-radius:13px;padding:16px;margin:7px 0;font-size:17px;font-weight:900}.pv-gate-btn.primary{background:#fff;color:#111}.pv-gate-btn.secondary{background:#444;color:#fff}
    .pv-address-card{background:#fff;color:#111;border-radius:22px;padding:22px;text-align:left;box-shadow:0 18px 55px #0006}.pv-address-card h2{text-align:center;margin:0 0 8px}.pv-address-card p{text-align:center;color:#666;line-height:1.4}
    .pv-address-wrap{position:relative}.pv-address-input{width:100%;border:2px solid #111;border-radius:12px;padding:14px 44px 14px 14px;font-size:17px}.pv-address-pin{position:absolute;right:14px;top:13px;font-size:20px}
    .pv-suggestions{position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid #ddd;border-radius:0 0 12px 12px;box-shadow:0 10px 25px #0002;z-index:10002;max-height:250px;overflow:auto}.pv-suggestion{display:block;width:100%;border:0;border-bottom:1px solid #eee;background:#fff;text-align:left;padding:12px;font-size:14px}.pv-suggestion:last-child{border-bottom:0}
    .pv-address-status{font-size:13px;line-height:1.4;margin:10px 0;min-height:18px}.pv-good{color:#146b2f;font-weight:800}.pv-warn{color:#8a5b00;font-weight:800}.pv-bad{color:#9b2020;font-weight:800}
    .pv-announcement{max-width:680px;margin:12px auto 0;background:#111;color:#fff;border-radius:14px;padding:12px 16px;text-align:center;font-size:13px;font-weight:800}
    .pv-help{background:#fff;border-radius:18px;padding:16px;text-align:center;margin:14px 0}.pv-help b{display:block;font-size:17px;margin-bottom:5px}.pv-help a{display:inline-block;margin-top:8px;background:#111;color:#fff;border-radius:10px;padding:10px 14px;text-decoration:none;font-weight:900}
    .pv-rating{font-size:12px;margin-top:5px;white-space:nowrap}.pv-rating .stars{letter-spacing:1px;color:#8b671e}.pv-rating .count{color:#777;margin-left:4px}
    .pv-zone-confirmed{background:#eef7ee;border-radius:12px;padding:11px 12px;margin:8px 0 12px;font-size:13px}.pv-zone-confirmed b{display:block;margin-bottom:3px}
    .pv-loyal-badge{display:inline-block;background:#111;color:#fff;border-radius:999px;padding:8px 12px;margin:12px auto;font-size:12px;font-weight:900;letter-spacing:.03em}
    .pv-method-option{display:flex;align-items:center;gap:12px;width:100%;background:#fff;border:2px solid #ddd;border-radius:16px;padding:15px;margin:9px 0;text-align:left;font-size:16px}.pv-method-option b{flex:1}.pv-method-option.selected{border-color:#111}
    .pv-mini-note{font-size:11px;color:#777;margin-top:8px;text-align:center}
    .pv-social-links{display:flex;justify-content:center;align-items:center;gap:8px;margin:0 0 12px}.pv-social-link{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid #ccc;border-radius:50%;color:#333;text-decoration:none;font-size:14px;font-weight:900;background:#fff}.pv-social-link:hover{border-color:#111;color:#111}
  `;
  document.head.appendChild(css);

  async function jfetch(url, opt={}) {
    const r = await fetch(url,{...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})},cache:'no-store'});
    let j={}; try{j=await r.json();}catch{}
    if(!r.ok) throw Error(j.error||'Request failed'); return j;
  }

  // Route checkout orders through the platform layer so address/zone exceptions are server-validated.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function(input, opt={}) {
    const rawUrl = typeof input === 'string' ? input : (input?.url || '');
    const method = String(opt?.method || (typeof input !== 'string' ? input?.method : '') || 'GET').toUpperCase();
    if (/\/api\/public\/orders(?:\?.*)?$/.test(rawUrl) && method === 'POST' && !/\/api\/platform\/public\/orders/.test(rawUrl)) {
      let body={}; try{body=JSON.parse(opt.body||'{}');}catch{}
      const addressNow = document.getElementById('customerAddress')?.value?.trim() || body.address || '';
      if (deliveryState.address && addressNow && normalizeLoose(addressNow) === normalizeLoose(deliveryState.address)) {
        if (deliveryState.lat != null && deliveryState.lng != null) { body.lat=deliveryState.lat; body.lng=deliveryState.lng; }
      }
      body.fulfillment_type = deliveryState.method || 'delivery';
      const r = await nativeFetch('/api/platform/public/orders',{...opt,body:JSON.stringify(body)});
      try { lastOrderMeta = (await r.clone().json())?.customer_status || null; } catch { lastOrderMeta=null; }
      setTimeout(insertConfirmationBadge, 40);
      return r;
    }
    return nativeFetch(input,opt);
  };
  function normalizeLoose(v){return String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}

  async function loadConfig(){
    try{config=await jfetch('/api/platform/public/config');return config;}catch{return null;}
  }
  async function loadTerritoryUi(slug){
    try{territoryUi=await jfetch('/api/platform/public/territory/'+encodeURIComponent(slug));return territoryUi;}catch{territoryUi=null;return null;}
  }
  function token(){ return config?.integrations?.mapbox_public_token || window.data?.settings?.mapbox_public_token || ''; }

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
    if(config?.profile?.entry_age_gate_enabled===false || ageAccepted()) return showAddressGateIfNeeded();
    const p=config.profile||{}; const g=document.createElement('div');g.id='pvAgeGate';g.className='pv-gate';
    g.innerHTML=`<div class="pv-gate-card"><div style="font-size:13px;font-weight:900;letter-spacing:.12em">${E(p.business_name||'POUCHES VIC')}</div><h1>${E(p.entry_age_gate_title||'19+ ONLY')}</h1><p>${E(p.entry_age_gate_text||'You must be 19 or older to enter this site.')}</p><button class="pv-gate-btn primary" id="pvAgeYes">YES, I’M 19+</button><button class="pv-gate-btn secondary" id="pvAgeNo">NO, I’M NOT</button></div>`;
    document.body.appendChild(g);
    document.getElementById('pvAgeYes').onclick=()=>{sessionStorage.setItem('pv_entry_age_ok','1');g.remove();setTimeout(showAddressGateIfNeeded,0);};
    document.getElementById('pvAgeNo').onclick=()=>{g.querySelector('.pv-gate-card').innerHTML='<h1>Sorry</h1><p>You must meet the age requirement to enter this site.</p>';};
  }

  function storedAddress(slug){try{return JSON.parse(sessionStorage.getItem('pv_delivery_address_'+slug)||'null');}catch{return null;}}
  function saveAddressState(){ if(deliveryState.slug) sessionStorage.setItem('pv_delivery_address_'+deliveryState.slug,JSON.stringify(deliveryState)); }
  function showAddressGateIfNeeded(force=false){
    if(location.pathname.startsWith('/order/') || config?.profile?.address_first_enabled===false || !ageAccepted() && config?.profile?.entry_age_gate_enabled!==false) return;
    const slug=window.currentSlug||'victoria';
    if(!force){const saved=storedAddress(slug);if(saved?.address){deliveryState={...deliveryState,...saved,slug};return;}}
    if(document.getElementById('pvAddressGate'))return;
    const g=document.createElement('div');g.id='pvAddressGate';g.className='pv-gate';g.style.background='#000b';
    g.innerHTML=`<div class="pv-gate-card"><div class="pv-address-card"><h2>Where are we delivering?</h2><p>Enter your address first so we can check your delivery area.</p><div class="pv-address-wrap"><input id="pvAddressInput" class="pv-address-input" autocomplete="street-address" placeholder="Start typing your address"><span class="pv-address-pin">⌖</span><div id="pvAddressSuggestions" class="pv-suggestions" hidden></div></div><div id="pvAddressStatus" class="pv-address-status"></div><button id="pvAddressContinue" class="pv-gate-btn primary" style="background:#111;color:#fff" disabled>CONTINUE TO STORE</button><div class="pv-mini-note">No account or registration required.</div></div></div>`;
    document.body.appendChild(g);
    const input=document.getElementById('pvAddressInput'), cont=document.getElementById('pvAddressContinue');
    input.oninput=()=>{deliveryState={slug,address:'',lat:null,lng:null,quote:null,method:'delivery'};cont.disabled=!!token() || input.value.trim().length<5;addressSuggest(input,'pvAddressSuggestions','pvAddressStatus',async f=>{await selectAddressFeature(f,input,'pvAddressStatus');cont.disabled=false;});};
    cont.onclick=async()=>{
      const raw=input.value.trim(); if(!raw)return;
      if(!deliveryState.address){deliveryState={slug,address:raw,lat:null,lng:null,quote:null,method:'delivery'};saveAddressState();}
      if(config?.modules?.delivery_method_step?.enabled) return showMethodGate(g);
      g.remove();
    };
  }

  async function mapboxSuggestions(q){
    const t=token(); if(!t || q.trim().length<3) return [];
    const city=territoryUi?.territory?.name||window.data?.territory?.name||'';
    const query = /,/.test(q) ? q : `${q}, ${city}, BC`;
    const url=`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${encodeURIComponent(t)}&autocomplete=true&country=ca&types=address,poi&limit=6`;
    const r=await nativeFetch(url); if(!r.ok)return[]; const j=await r.json(); return j.features||[];
  }
  function addressSuggest(input, listId, statusId, onPick){
    clearTimeout(suggestTimer);const box=document.getElementById(listId),status=document.getElementById(statusId);if(box)box.hidden=true;
    const q=input.value.trim(); if(q.length<3)return;
    if(!token()){if(status)status.innerHTML='<span class="pv-warn">Live address suggestions are ready once the Mapbox token is added in Control Room.</span>';return;}
    suggestTimer=setTimeout(async()=>{try{const features=await mapboxSuggestions(q);if(!box)return;box.innerHTML=features.map((f,i)=>`<button type="button" class="pv-suggestion" data-i="${i}">${E(f.place_name||f.text||'')}</button>`).join('');box.hidden=!features.length;box.onclick=e=>{const b=e.target.closest('[data-i]');if(!b)return;box.hidden=true;onPick(features[Number(b.dataset.i)]);};}catch{}},220);
  }
  async function selectAddressFeature(feature,input,statusId){
    const center=feature?.center||[],address=feature?.place_name||input.value.trim();input.value=address;
    deliveryState={slug:window.currentSlug||'victoria',address,lat:Number(center[1]),lng:Number(center[0]),quote:null,method:deliveryState.method||'delivery'};
    const quote=await getQuote({address,lat:deliveryState.lat,lng:deliveryState.lng}); deliveryState.quote=quote;saveAddressState();renderAddressStatus(statusId,quote);
  }
  async function getQuote(extra={}){
    const phone=document.getElementById('customerPhone')?.value||'',email=document.getElementById('customerEmail')?.value||'',name=document.getElementById('customerName')?.value||'';
    return jfetch('/api/platform/public/delivery-quote',{method:'POST',body:JSON.stringify({territory_slug:window.currentSlug||'victoria',address:extra.address??deliveryState.address,lat:extra.lat??deliveryState.lat,lng:extra.lng??deliveryState.lng,zone_id:document.getElementById('zone')?.value||'',customer_phone:phone,customer_email:email,customer_name:name})});
  }
  function renderAddressStatus(id,q){
    const el=document.getElementById(id);if(!el)return;
    if(q?.serviceable)el.innerHTML=`<span class="pv-good">✓ ${E(q.zone.name)} delivery area • ${money(q.zone.fee_cents)}${q.override?.applied?' • saved exception applied':''}</span>`;
    else el.innerHTML='<span class="pv-warn">We could not confirm a normal zone for this address. You can still continue; any saved customer/address exception will be checked again at checkout.</span>';
  }
  function showMethodGate(existingGate){
    const m=config?.modules||{}, options=[];
    if(m.local_delivery?.enabled!==false)options.push(['delivery','Local Delivery','Same-day local delivery']);
    if(m.pickup?.enabled)options.push(['pickup','In-Store Pickup','Pick up from the business']);
    if(m.shipping?.enabled)options.push(['shipping','Postal Delivery','Ship to the address']);
    existingGate.querySelector('.pv-address-card').innerHTML=`<h2>How do you want to get it?</h2><p>Select a delivery method to continue.</p>${options.map((x,i)=>`<button class="pv-method-option ${i===0?'selected':''}" data-method="${x[0]}"><span>${x[0]==='delivery'?'🚚':x[0]==='pickup'?'🛍️':'📦'}</span><b>${E(x[1])}</b><span style="font-size:12px;color:#666">${E(x[2])}</span></button>`).join('')}<button id="pvMethodContinue" class="pv-gate-btn primary" style="background:#111;color:#fff">CONTINUE TO STORE</button>`;
    deliveryState.method=options[0]?.[0]||'delivery';saveAddressState();
    existingGate.querySelectorAll('[data-method]').forEach(b=>b.onclick=()=>{existingGate.querySelectorAll('[data-method]').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');deliveryState.method=b.dataset.method;saveAddressState();});
    document.getElementById('pvMethodContinue').onclick=()=>existingGate.remove();
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

  function enhanceCheckout(){
    const address=document.getElementById('customerAddress'),zone=document.getElementById('zone'),age=document.getElementById('ageAck'); if(!address||!zone||!age)return;
    const key=`${window.currentSlug||''}:${Date.now()>>10}`; if(checkoutEnhancedFor===address)return; checkoutEnhancedFor=address;
    // Mandatory every order. Entry gate never auto-checks or hides this box.
    age.checked=false; const span=age.parentElement?.querySelector('span');if(span&&config?.profile?.age_acknowledgement_text)span.textContent=config.profile.age_acknowledgement_text;
    if(deliveryState.slug===(window.currentSlug||'victoria')&&deliveryState.address){address.value=deliveryState.address;if(deliveryState.quote?.serviceable){zone.value=deliveryState.quote.zone.id;zone.dispatchEvent(new Event('change'));showConfirmedZone(zone,deliveryState.quote);}}
    let sug=document.createElement('div');sug.id='pvCheckoutSuggestions';sug.className='pv-suggestions';sug.hidden=true;address.parentElement.style.position='relative';address.insertAdjacentElement('afterend',sug);
    const st=document.createElement('div');st.id='pvCheckoutAddressStatus';st.className='pv-address-status';sug.insertAdjacentElement('afterend',st);if(deliveryState.quote)renderAddressStatus('pvCheckoutAddressStatus',deliveryState.quote);
    address.addEventListener('input',()=>{if(normalizeLoose(address.value)!==normalizeLoose(deliveryState.address)){deliveryState={slug:window.currentSlug||'victoria',address:address.value.trim(),lat:null,lng:null,quote:null,method:deliveryState.method||'delivery'};document.getElementById('pvZoneConfirmed')?.remove();zone.closest('.field').style.display='';}addressSuggest(address,'pvCheckoutSuggestions','pvCheckoutAddressStatus',async f=>{await selectAddressFeature(f,address,'pvCheckoutAddressStatus');if(deliveryState.quote?.serviceable){zone.value=deliveryState.quote.zone.id;zone.dispatchEvent(new Event('change'));showConfirmedZone(zone,deliveryState.quote);}});});
    const recheck=async()=>{if(!deliveryState.address)return;try{const q=await getQuote();deliveryState.quote=q;saveAddressState();if(q.serviceable){zone.value=q.zone.id;zone.dispatchEvent(new Event('change'));showConfirmedZone(zone,q);renderAddressStatus('pvCheckoutAddressStatus',q);}}catch{}};
    document.getElementById('customerPhone')?.addEventListener('blur',recheck);document.getElementById('customerEmail')?.addEventListener('blur',recheck);
  }
  function showConfirmedZone(zone,q){
    let card=document.getElementById('pvZoneConfirmed');if(!card){card=document.createElement('div');card.id='pvZoneConfirmed';card.className='pv-zone-confirmed';zone.closest('.field')?.insertAdjacentElement('afterend',card);}card.innerHTML=`<b>DELIVERY AREA CONFIRMED</b>${E(q.zone.name)} • ${money(q.zone.fee_cents)}${q.override?.applied?' • your saved delivery exception is applied':''}`;
    if(deliveryState.lat!=null&&deliveryState.lng!=null)zone.closest('.field').style.display='none';
  }

  function patchQuote(){
    if(!window.currentQuote||window.currentQuote.__pvDeliveryPatched)return;const original=window.currentQuote;
    const patched=function(){const x=original();const q=deliveryState.quote;if(q?.serviceable&&q.override?.applied&&q.override.fee_cents!=null&&x?.z?.id===q.zone.id){x.delivery=Number(q.override.fee_cents)||0;x.pre=x.subtotal+x.delivery;const step=Math.max(1,Number(window.data?.settings?.round_down_to_cents)||500);x.total=Math.floor(x.pre/step)*step;x.discount=Math.max(0,x.pre-x.total);}return x;};patched.__pvDeliveryPatched=true;window.currentQuote=patched;
  }
  function patchProductRender(){
    if(window.renderProducts&&!window.renderProducts.__pvStorePatched){const original=window.renderProducts;const patched=function(){const r=original();setTimeout(()=>{applyGenericLabels();renderRatings();},0);return r;};patched.__pvStorePatched=true;window.renderProducts=patched;}
    if(window.updateCart&&!window.updateCart.__pvStorePatched){const original=window.updateCart;const patched=function(){const r=original();setTimeout(applyGenericLabels,0);return r;};patched.__pvStorePatched=true;window.updateCart=patched;}
  }
  function insertConfirmationBadge(){
    if(!lastOrderMeta?.returning_customer || config?.profile?.loyalty_badges_enabled===false)return;const success=document.querySelector('#checkout .success');if(!success||success.querySelector('.pv-loyal-badge'))return;const stars=Math.max(0,Math.min(5,Number(lastOrderMeta.loyalty_stars)||0));const label=lastOrderMeta.loyalty_label||(stars?'Loyal Customer':'Returning Customer');const badge=document.createElement('div');badge.className='pv-loyal-badge';badge.textContent=`${stars?'★'.repeat(stars)+' ': '★ '}${label}${lastOrderMeta.previous_order_count?` • ${lastOrderMeta.previous_order_count} previous order${lastOrderMeta.previous_order_count===1?'':'s'}`:''}`;success.querySelector('.confirm-title')?.insertAdjacentElement('afterend',badge);
  }

  async function onTerritoryReady(slug){
    await loadTerritoryUi(slug);renderTerritoryExtras();renderRatings();applyGenericLabels();
    const saved=storedAddress(slug);if(saved?.address)deliveryState={...deliveryState,...saved,slug};else deliveryState={slug,address:'',lat:null,lng:null,quote:null,method:'delivery'};
  }
  async function boot(){
    await loadConfig(); if(!config)return;
    for(let i=0;i<100;i++){if(window.data&&window.currentSlug)break;await sleep(80);}
    if(location.pathname.startsWith('/order/')){applyGenericLabels();renderSocialLinks();return;}
    watchedSlug=window.currentSlug||'victoria';await onTerritoryReady(watchedSlug);patchQuote();patchProductRender();showAgeGate();
    const timer=setInterval(async()=>{
      patchQuote();patchProductRender();enhanceCheckout();applyGenericLabels();renderRatings();renderSocialLinks();insertConfirmationBadge();
      const slug=window.currentSlug||'victoria';if(slug!==watchedSlug){watchedSlug=slug;sessionStorage.removeItem('pv_delivery_address_'+slug);await onTerritoryReady(slug);showAddressGateIfNeeded(true);}
    },650);
    window.addEventListener('beforeunload',()=>clearInterval(timer),{once:true});
  }
  boot();
})();
