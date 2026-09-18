(() => {
  'use strict';
  let config = null;
  let editingRecipients = [], editingSocials = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const E = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  window.pvHumanStamp = value => value ? new Intl.DateTimeFormat('en-CA',{weekday:'long',month:'long',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value)) : '';

  async function pfetch(url, opt = {}) {
    const r = await fetch(url, { ...opt, headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) }, cache: 'no-store' });
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error(j.error || 'Request failed');
    return j;
  }
  async function loadConfig() {
    try { config = await pfetch('/api/admin/platform/config'); return config; }
    catch { return null; }
  }
  function itemWords() {
    return { singular: config?.profile?.item_singular || 'can', plural: config?.profile?.item_plural || 'cans' };
  }
  function applyProductLabels() {
    if (!config || !window.view) return;
    const p = config.profile || {};
    const replacements = new Map([
      ['BRAND', p.product_group_label || 'BRAND'],
      ['FLAVOUR', p.product_name_label || 'FLAVOUR'],
      ['STRENGTH (MG)', p.variant_label || 'STRENGTH (MG)'],
      ['STARTING STOCK (CANS)', `STARTING STOCK (${(p.item_plural || 'cans').toUpperCase()})`],
      ['RECEIVE STOCK — HOW MANY CANS ARRIVED?', `RECEIVE STOCK — HOW MANY ${(p.item_plural || 'items').toUpperCase()} ARRIVED?`],
      ['STOCK CORRECTION (+ OR − CANS)', `STOCK CORRECTION (+ OR − ${(p.item_plural || 'items').toUpperCase()})`]
    ]);
    document.querySelectorAll('#view label').forEach(el => {
      const key = el.textContent.trim(); if (replacements.has(key)) el.textContent = replacements.get(key);
    });
    const { plural } = itemWords();
    document.querySelectorAll('#view .muted').forEach(el => {
      if (/^cans$/i.test(el.textContent.trim())) el.textContent = plural;
      else if (/\bcans\b/i.test(el.textContent)) el.textContent = el.textContent.replace(/\bcans\b/gi, plural);
    });
  }
  function installButtons() {
    // Everyday entry points live in the explicit four-tab Control Room.
  }
  function collectRecipients(){const territoryId=(typeof T!=='undefined'?T?.territory?.id:'')||'';editingRecipients=[...document.querySelectorAll('[data-pv-recipient]')].map((row,i)=>({id:row.dataset.id||'',email:row.querySelector('[data-email]').value.trim(),enabled:row.querySelector('[data-enabled]').checked,territory_id:row.dataset.territoryId||territoryId,sort_order:i}));return editingRecipients;}
  function renderRecipients(){const host=document.getElementById('pvRecipientRows');if(!host)return;host.innerHTML=editingRecipients.length?editingRecipients.map((x,i)=>`<div class="card" data-pv-recipient data-id="${E(x.id||'')}" data-territory-id="${E(x.territory_id||'')}" style="padding:10px;margin:8px 0"><div style="display:flex;gap:8px;align-items:center"><input data-email type="email" value="${E(x.email||'')}" placeholder="orders@example.com" style="flex:1"><label style="display:flex;gap:5px;align-items:center;white-space:nowrap"><input data-enabled type="checkbox" ${x.enabled!==false?'checked':''}> ENABLED</label><button type="button" class="btn danger" data-remove-recipient="${i}" style="padding:8px">REMOVE</button></div></div>`).join(''):'<div class="muted">No business notification recipients configured.</div>';host.querySelectorAll('[data-remove-recipient]').forEach(b=>b.onclick=()=>{collectRecipients();editingRecipients.splice(Number(b.dataset.removeRecipient),1);renderRecipients();});}
  function collectSocials(){editingSocials=[...document.querySelectorAll('[data-pv-social]')].map((row,i)=>({id:row.dataset.id||'',platform:row.querySelector('[data-platform]').value,label:row.querySelector('[data-label]').value.trim(),url:row.querySelector('[data-url]').value.trim(),enabled:row.querySelector('[data-enabled]').checked,sort_order:i}));return editingSocials;}
  function renderSocials(){const host=document.getElementById('pvSocialRows');if(!host)return;host.innerHTML=editingSocials.length?editingSocials.map((x,i)=>`<div class="card" data-pv-social data-id="${E(x.id||'')}" style="padding:10px;margin:8px 0"><div class="three"><div class="field"><label>NETWORK</label><select data-platform>${['facebook','instagram','tiktok','x','youtube','custom'].map(p=>`<option value="${p}" ${x.platform===p?'selected':''}>${p==='x'?'X':p[0].toUpperCase()+p.slice(1)}</option>`).join('')}</select></div><div class="field"><label>LABEL</label><input data-label value="${E(x.label||'')}"></div><div class="field"><label>URL</label><input data-url type="url" value="${E(x.url||'')}" placeholder="https://..."></div></div><div style="display:flex;gap:7px;align-items:center"><label style="display:flex;gap:5px;align-items:center;margin-right:auto"><input data-enabled type="checkbox" ${x.enabled!==false?'checked':''}> SHOW THIS LINK</label><button type="button" class="btn ghost" data-social-up="${i}" style="padding:8px" ${i===0?'disabled':''}>↑</button><button type="button" class="btn ghost" data-social-down="${i}" style="padding:8px" ${i===editingSocials.length-1?'disabled':''}>↓</button><button type="button" class="btn danger" data-social-remove="${i}" style="padding:8px">REMOVE</button></div></div>`).join(''):'<div class="muted">No social links configured. Nothing will appear in the storefront.</div>';host.querySelectorAll('[data-social-remove]').forEach(b=>b.onclick=()=>{collectSocials();editingSocials.splice(Number(b.dataset.socialRemove),1);renderSocials();});host.querySelectorAll('[data-social-up]').forEach(b=>b.onclick=()=>moveSocial(Number(b.dataset.socialUp),-1));host.querySelectorAll('[data-social-down]').forEach(b=>b.onclick=()=>moveSocial(Number(b.dataset.socialDown),1));}
  function moveSocial(index,delta){collectSocials();const next=index+delta;if(next<0||next>=editingSocials.length)return;[editingSocials[index],editingSocials[next]]=[editingSocials[next],editingSocials[index]];renderSocials();}
  async function openPlatformSetup() {
    await loadConfig();
    const p = config.profile, m = config.modules;
    editingRecipients=(config.notification_recipients||[]).map(x=>({...x}));editingSocials=(config.social_links||[]).map(x=>({...x}));
    const moduleRow = (key, label, note='') => `<label style="display:flex;gap:9px;align-items:flex-start;margin:11px 0"><input id="pm_${key}" type="checkbox" style="width:20px;height:20px" ${m[key]?.enabled?'checked':''} ${m[key]?.readiness==='socket_ready'?'disabled':''}><span><b>${E(label)}</b><div class="muted">${E(note || m[key]?.readiness || '')}</div></span></label>`;
    window.modalContent.innerHTML = `<h2>Store, Checkout & Communications</h2>
      <div class="good">Customer-facing wording, order emails, social links, address setup, and age/ID settings.</div>
      <label style="display:flex;gap:9px;align-items:center;margin:12px 0"><input id="ppGeneric" type="checkbox" style="width:22px;height:22px" ${p.generic_business_mode?'checked':''}><b>GENERIC BUSINESS MODE</b></label>
      <div class="field"><label>BUSINESS NAME</label><input id="ppName" value="${E(p.business_name)}"></div>
      <div class="field"><label>HERO TITLE</label><input id="ppHero" value="${E(p.hero_title)}"></div>
      <div class="field"><label>SHOP BUTTON</label><input id="ppShop" value="${E(p.shop_button)}"></div>
      <div class="three"><div class="field"><label>GROUP FIELD</label><input id="ppGroup" value="${E(p.product_group_label)}" placeholder="Brand / Category"></div><div class="field"><label>PRODUCT FIELD</label><input id="ppProduct" value="${E(p.product_name_label)}" placeholder="Flavour / Item"></div><div class="field"><label>VARIANT FIELD</label><input id="ppVariant" value="${E(p.variant_label)}" placeholder="Size / Strength"></div></div>
      <div class="two"><div class="field"><label>ONE ITEM IS CALLED</label><input id="ppSingular" value="${E(p.item_singular)}"></div><div class="field"><label>MULTIPLE ITEMS ARE CALLED</label><input id="ppPlural" value="${E(p.item_plural)}"></div></div>
      <label style="display:flex;gap:9px;align-items:center;margin:12px 0"><input id="ppAge" type="checkbox" style="width:20px;height:20px" ${p.entry_age_gate_enabled!==false?'checked':''}><span><b>19+ ENTRY SCREEN</b><div class="muted">Customer must click 19+ before entering. This can be turned off. The checkout ID box remains mandatory either way.</div></span></label>
      <div class="good"><b>ADDRESS & DELIVERY AREA AT CHECKOUT</b><br>Customers type their address, check the Local delivery-area map, and select their own delivery area. No live customer map or automatic GPS zoning is used.</div>
      <div class="field"><label>MANDATORY CHECKOUT ID / AGE BOX WORDING</label><input id="ppAgeText" value="${E(p.age_acknowledgement_text||'')}"></div>
      <div class="hr"></div><h3>Order Notification Emails</h3><div class="muted">Each enabled address receives the full business notification once when a new order is placed. Customer confirmation email is separate. Later status and payment changes do not send these notifications.</div><div id="pvRecipientRows"></div><button type="button" class="btn ghost" id="pvAddRecipient" style="width:100%">ADD RECIPIENT EMAIL</button>
      <div class="hr"></div><h3>Social Media Links</h3><label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input id="ppShowSocial" type="checkbox" style="width:20px;height:20px" ${config.show_social_links?'checked':''}><b>SHOW SOCIAL LINKS</b></label><div class="muted">A footer icon appears only when the master switch and that link are enabled and its URL is valid.</div><div id="pvSocialRows"></div><button type="button" class="btn ghost" id="pvAddSocial" style="width:100%">ADD SOCIAL LINK</button>
      <div class="hr"></div><h3>Modules</h3>
      ${moduleRow('local_delivery','Local delivery','Installed and available.')}
      ${moduleRow('driver_dispatch','Driver dispatch','Installed; can be switched off for courier/shipping businesses.')}
      ${moduleRow('barcode_inventory','Barcode inventory','Installed; phone camera, paired scanner, or integration API.')}
      ${moduleRow('customer_support_updates','Live support → driver updates','Installed; Control Room can update delivery instructions and notify the assigned driver.')}
      ${moduleRow('customer_history','Returning customer history','Accountless recognition and persistent driver/admin customer notes.')}
      ${moduleRow('product_ratings','Product star ratings','Optional 1–5 star display. Off until Admin turns it on.')}
      ${moduleRow('delivery_method_step','Delivery method page','Optional Pickup / Local Delivery / Postal-style choice page. Off for PouchesVic now.')}
      ${moduleRow('order_photos','Driver order photos','Installed and OPTIONAL by default. Drivers can attach multiple photos to an order.')}
      <div class="card" style="background:#f6f6f4;padding:11px"><b>PHOTO RULES</b><div class="muted">Both requirement switches are OFF now. Turn them on later only for a business that needs proof-of-pickup/delivery.</div>
        <div class="field"><label>MAX PHOTOS PER ORDER</label><input id="ppPhotoMax" type="number" min="1" max="20" value="${E(m.order_photos?.config?.max_photos_per_order ?? 8)}"></div>
        <label style="display:flex;gap:8px;align-items:center;margin:9px 0"><input id="ppDriverDelete" type="checkbox" style="width:20px;height:20px" ${m.order_photos?.config?.driver_can_delete!==false?'checked':''}> Driver can delete/retake their own photos</label>
        <label style="display:flex;gap:8px;align-items:center;margin:9px 0"><input id="ppRequirePickup" type="checkbox" style="width:20px;height:20px" ${m.order_photos?.config?.require_pickup_before_on_the_way?'checked':''}> Require a PICKUP photo before ON THE WAY</label>
        <label style="display:flex;gap:8px;align-items:center;margin:9px 0"><input id="ppRequireDelivery" type="checkbox" style="width:20px;height:20px" ${m.order_photos?.config?.require_delivery_before_completed?'checked':''}> Require a DELIVERY photo before COMPLETED</label>
      </div>
      ${moduleRow('pickup','Pickup','Installed/off framework; fulfillment UI can use this later.')}
      ${moduleRow('shipping','Shipping','Installed/off framework for future ecommerce fulfillment.')}
      ${moduleRow('external_courier','External courier','Installed/off framework so the driver module can be retired later.')}
      ${moduleRow('external_scanner_api','External scanner API','Turn on only after creating a scanner token below.')}
      ${moduleRow('marketplace','Marketplace / Craigslist-style sellers','Socket prepared. Full multi-seller layer intentionally not installed yet.')}
      ${moduleRow('multi_seller','Multi-seller accounts','Socket prepared. Seller/location/ownership tables are ready.')}
      <button class="btn" style="width:100%;margin-top:10px" id="ppSave">SAVE PLATFORM SETUP</button>
      <div class="hr"></div><h3>External Scanner Connection</h3><div class="muted">For scanner apps/hardware that can send an HTTP request. The token is shown only once.</div>
      <div class="two"><div class="field"><label>SCANNER NAME</label><input id="scannerName" placeholder="Warehouse phone"></div><button class="btn ghost" style="align-self:end;margin-bottom:9px" id="createScannerToken">CREATE CONNECTION TOKEN</button></div>
      <div id="scannerTokenResult"></div><div id="scannerList" class="muted"></div>`;
    window.modal.classList.add('open');
    document.getElementById('ppSave').onclick = savePlatformSetup;
    document.getElementById('createScannerToken').onclick = createScannerToken;
    document.getElementById('pvAddRecipient').onclick=()=>{collectRecipients();editingRecipients.push({id:'',email:'',enabled:true});renderRecipients();};
    document.getElementById('pvAddSocial').onclick=()=>{collectSocials();editingSocials.push({id:'',platform:'custom',label:'',url:'',enabled:true});renderSocials();};
    renderRecipients();renderSocials();
    renderScannerList();
  }
  window.pvOpenStoreCheckoutSettings=openPlatformSetup;
  async function savePlatformSetup() {
    const p = config.profile, modules = {};
    for (const [key, value] of Object.entries(config.modules)) {
      const el = document.getElementById('pm_'+key);
      modules[key] = { enabled: el ? el.checked : value.enabled, config: value.config || {} };
    }
    if (modules.order_photos) modules.order_photos.config = {
      ...(modules.order_photos.config || {}),
      max_photos_per_order: Math.max(1, Math.min(20, Number(document.getElementById('ppPhotoMax')?.value || 8))),
      driver_can_delete: document.getElementById('ppDriverDelete')?.checked !== false,
      require_pickup_before_on_the_way: !!document.getElementById('ppRequirePickup')?.checked,
      require_delivery_before_completed: !!document.getElementById('ppRequireDelivery')?.checked,
      storage_provider: 'local'
    };
    config = await pfetch('/api/admin/platform/config', { method:'PUT', body: JSON.stringify({
      profile: {
        ...p,
        generic_business_mode: document.getElementById('ppGeneric').checked,
        business_name: document.getElementById('ppName').value,
        hero_title: document.getElementById('ppHero').value,
        shop_button: document.getElementById('ppShop').value,
        product_group_label: document.getElementById('ppGroup').value,
        product_name_label: document.getElementById('ppProduct').value,
        variant_label: document.getElementById('ppVariant').value,
        item_singular: document.getElementById('ppSingular').value,
        item_plural: document.getElementById('ppPlural').value,
        entry_age_gate_enabled: document.getElementById('ppAge').checked,
        address_first_enabled: false,
        address_autocomplete_enabled: false,
        age_acknowledgement_text: document.getElementById('ppAgeText').value
      },
      modules,
      notification_recipients: collectRecipients(),
      show_social_links: document.getElementById('ppShowSocial').checked,
      social_links: collectSocials()
    }) });
    alert('Platform setup saved.');
    window.closeModal();
    if (window.render) window.render();
  }
  async function createScannerToken() {
    try {
      const result = await pfetch('/api/admin/platform/scanner-integrations', { method:'POST', body: JSON.stringify({ name: document.getElementById('scannerName').value }) });
      document.getElementById('scannerTokenResult').innerHTML = `<div class="warn"><b>SAVE THIS TOKEN NOW — IT IS SHOWN ONCE</b><div style="word-break:break-all;margin-top:7px">${E(result.token)}</div></div>`;
      renderScannerList();
    } catch(e) { alert(e.message); }
  }
  async function renderScannerList() {
    try {
      const list = await pfetch('/api/admin/platform/scanner-integrations');
      document.getElementById('scannerList').innerHTML = list.length ? list.map(x => `<div style="margin-top:7px">${E(x.name)} • ${x.active?'active':'off'}${x.last_used_at?' • last used '+E(window.pvHumanStamp(x.last_used_at)):''}</div>`).join('') : '<div style="margin-top:7px">No external scanner connections yet.</div>';
    } catch {}
  }

  async function renderAdminPhotos(orderId) {
    const host = document.getElementById('pvOrderPhotos');
    if (!host) return;
    try {
      const x = await pfetch(`/api/admin/platform/orders/${encodeURIComponent(orderId)}/photos`);
      const photos = x.photos || [];
      const policy = x.policy || {};
      host.innerHTML = `<div class="hr"></div><h3>ORDER PHOTOS</h3>
        <div class="muted">Driver photos are optional unless a Photo Rule is switched on in Business Setup. Archive keeps the image; Delete removes the stored image to free space.</div>
        <div class="statusline"><span class="chip">${photos.filter(p=>p.status==='active').length} ACTIVE</span><span class="chip">${photos.filter(p=>p.status==='archived').length} ARCHIVED</span>${policy.require_pickup_before_on_the_way?'<span class="chip on">PICKUP REQUIRED</span>':''}${policy.require_delivery_before_completed?'<span class="chip on">DELIVERY REQUIRED</span>':''}</div>
        ${photos.length ? `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px">${photos.map(p=>`<div class="card" style="padding:9px;margin:0;${p.status==='archived'?'opacity:.65':''}"><img src="${E(p.content_url)}" alt="Order photo" style="width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:10px;background:#eee"><div class="muted" style="margin:6px 0"><b>${E(String(p.stage||'general').toUpperCase())}</b> • ${E(window.pvHumanStamp(p.created_at))}${p.caption?'<br>'+E(p.caption):''}</div><div class="actions">${p.status==='active'?`<button class="btn ghost" onclick="window.pvAdminPhotoAction('${p.id}','archive','${orderId}')">ARCHIVE</button>`:`<button class="btn ghost" onclick="window.pvAdminPhotoAction('${p.id}','restore','${orderId}')">RESTORE</button>`}<button class="btn danger" onclick="window.pvAdminPhotoAction('${p.id}','delete','${orderId}')">DELETE</button></div></div>`).join('')}</div>` : '<div class="good" style="margin-top:9px">No photos attached to this order.</div>'}`;
    } catch(e) { host.innerHTML = `<div class="muted">Could not load order photos: ${E(e.message)}</div>`; }
  }
  window.pvAdminPhotoAction = async (photoId, action, orderId) => {
    if (action === 'delete' && !confirm('Delete this photo and free its stored image space?')) return;
    await pfetch(`/api/admin/platform/photos/${encodeURIComponent(photoId)}`, { method:'PUT', body: JSON.stringify({ action }) });
    await renderAdminPhotos(orderId);
  };

  function installOrderSupportPatch() {
    if (!window.openOrder || window.openOrder.__pvPatched) return;
    const original = window.openOrder;
    const patched = async function(orderId) {
      await original(orderId);
      try {
        const o = await pfetch(`/api/admin/platform/orders/${encodeURIComponent(orderId)}/support`);
        const driverPhone = o.driver_phone || o.driver_customer_contact_number || '';
        const holder = document.createElement('div');
        holder.id = 'pvSupportPanel';
        holder.innerHTML = `<div class="hr"></div><h3>CUSTOMER SUPPORT / LIVE DRIVER UPDATE</h3>
          <div class="warn">Edit live delivery information here. Saving a real change updates the order immediately and alerts the assigned driver.</div>
          <div class="field"><label>DELIVERY ADDRESS / ACCESS DETAILS</label><input id="pvSupportAddress" value="${E(o.address||'')}"></div>
          <div class="field"><label>DELIVERY INSTRUCTIONS</label><textarea id="pvSupportNotes">${E(o.delivery_notes||'')}</textarea></div>
          <div class="field"><label>SUPPORT NOTE / WHY IT CHANGED</label><input id="pvSupportReason" placeholder="Customer called — use side entrance"></div>
          <label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input id="pvNotifyDriver" type="checkbox" style="width:20px;height:20px" ${o.assigned_driver_id?'checked':''} ${o.assigned_driver_id?'':'disabled'}> Notify assigned driver</label>
          ${o.assigned_driver_id ? `<div class="two">${driverPhone?`<a class="btn ghost" style="text-decoration:none;text-align:center" href="tel:${E(driverPhone)}">CALL DRIVER</a>`:'<button class="btn ghost" disabled>NO DRIVER PHONE SAVED</button>'}<button class="btn" id="pvSaveSupport">SAVE UPDATE</button></div>` : '<div class="muted">No driver is currently assigned. The update will still be saved to the live order.</div><button class="btn" style="width:100%;margin-top:8px" id="pvSaveSupport">SAVE UPDATE</button>'}
          ${o.support_updated_at?`<div class="muted" style="margin-top:9px">Last support update: ${E(window.pvHumanStamp(o.support_updated_at))}</div>`:''}`;
        window.modalContent.appendChild(holder);
        const photosHolder = document.createElement('div'); photosHolder.id = 'pvOrderPhotos'; window.modalContent.appendChild(photosHolder);
        renderAdminPhotos(orderId);
        document.getElementById('pvSaveSupport').onclick = async () => {
          try {
            const result = await pfetch(`/api/admin/platform/orders/${encodeURIComponent(orderId)}/support`, { method:'PUT', body: JSON.stringify({
              address: document.getElementById('pvSupportAddress').value,
              delivery_notes: document.getElementById('pvSupportNotes').value,
              support_note: document.getElementById('pvSupportReason').value,
              notify_driver: document.getElementById('pvNotifyDriver')?.checked !== false
            }) });
            if (!result.changed) return alert('Nothing changed.');
            alert(result.push?.sent ? 'Order updated and driver notified.' : 'Order updated. No driver push was sent.');
            window.closeModal();
            const activeT = (typeof T !== 'undefined' ? T : null);
            if (window.selectTerritory && activeT?.territory?.id) await window.selectTerritory(activeT.territory.id);
            await patched(orderId);
          } catch(e) { alert(e.message); }
        };
      } catch {}
    };
    patched.__pvPatched = true;
    patched.__pvCustomerHistoryPatched = !!original.__pvCustomerHistoryPatched;
    window.openOrder = patched;
  }

  function patchRenderProducts() {
    if (!window.renderProducts || window.renderProducts.__pvPatched) return;
    const original = window.renderProducts;
    const patched = function() { const r = original(); setTimeout(applyProductLabels, 0); return r; };
    patched.__pvPatched = true;
    window.renderProducts = patched;
  }

  async function boot() {
    for (let i=0;i<80;i++) {
      if (document.getElementById('app') && typeof api==='function') break;
      await sleep(100);
    }
    const timer = setInterval(async () => {
      if (document.getElementById('app')?.classList.contains('hidden')) return;
      if (!config) await loadConfig();
      if (!config) return;
      installButtons();
      installOrderSupportPatch();
      patchRenderProducts();
      applyProductLabels();
    }, 500);
    window.addEventListener('beforeunload', () => clearInterval(timer), { once:true });
  }
  boot();
})();

// Lightweight storefront/customer controls. Kept separate from the core Control Room tabs
// so PouchesVic stays simple while these tools remain one tap away.
(() => {
  'use strict';
  let everydayConfig=null;
  const wait = ms => new Promise(r=>setTimeout(r,ms));
  const E = s => String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const moneyCents = c => new Intl.NumberFormat('en-CA',{style:'currency',currency:'CAD'}).format((Number(c)||0)/100);
  const strengthLabel = value => { const s=String(value??'').trim(); if(!s)return ''; if(/mg\s*$/i.test(s))return s.replace(/\s*mg\s*$/i,' mg'); return /^\d+(?:\.\d+)?$/.test(s)?s+' mg':s; };
  async function req(url,opt={}){const r=await fetch(url,{...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})},cache:'no-store'});let j={};try{j=await r.json()}catch{}if(!r.ok)throw Error(j.error||'Request failed');return j;}
  function activeT(){try{return typeof T!=='undefined'?T:null}catch{return null}}
  function openModal(html){const c=document.getElementById('modalContent'),m=document.getElementById('modal');if(!c||!m)return;c.innerHTML=html;m.classList.add('open');}

  function installExtraButtons(){
    // Everyday buttons are installed in the prominent Store / Customer Settings card.
  }

  async function openStorefrontTools(){
    const t=activeT();if(!t?.territory?.id)return alert('Choose a city first.');
    try{
      const tid=t.territory.id,[sf,overrides,customers]=await Promise.all([
        req(`/api/admin/platform/territories/${encodeURIComponent(tid)}/storefront`),
        req(`/api/admin/platform/territories/${encodeURIComponent(tid)}/zone-overrides`),
        req(`/api/admin/platform/customers?territory_id=${encodeURIComponent(tid)}`)
      ]),s=sf.storefront||{},zones=t.zones||[];
      openModal(`<h2>${E(t.territory.name)} Storefront Tools</h2>
        <div class="good">These settings affect only this city / area.</div>
        <h3>Top Store Notice</h3>
        <label style="display:flex;gap:9px;align-items:center;margin:10px 0"><input id="pvAnnOn" type="checkbox" style="width:21px;height:21px" ${s.announcement_enabled?'checked':''}><b>SHOW NOTICE</b></label>
        <div class="field"><label>NOTICE TEXT</label><textarea id="pvAnnText" placeholder="Special delivery note, holiday hours, etc.">${E(s.announcement_text||'')}</textarea></div>
        <div class="hr"></div><h3>Help / Customer Service</h3>
        <label style="display:flex;gap:9px;align-items:center;margin:10px 0"><input id="pvHelpOn" type="checkbox" style="width:21px;height:21px" ${s.help_enabled?'checked':''}><b>SHOW HELP BOX</b></label>
        <div class="field"><label>HEADING</label><input id="pvHelpHeading" value="${E(s.help_heading||'Need help?')}"></div>
        <div class="field"><label>HELP TEXT</label><input id="pvHelpText" value="${E(s.help_text||'')}" placeholder="For help, please text"></div>
        <div class="two"><div class="field"><label>PHONE / CONTACT</label><input id="pvHelpContact" value="${E(s.help_contact||'')}" inputmode="tel"></div><div class="field"><label>WHEN TAPPED</label><select id="pvHelpAction"><option value="sms" ${s.help_contact_action==='sms'?'selected':''}>Text</option><option value="tel" ${s.help_contact_action==='tel'?'selected':''}>Call</option><option value="none" ${s.help_contact_action==='none'?'selected':''}>Display only</option></select></div></div>
        <button class="btn" style="width:100%" id="pvSaveStorefront">SAVE STOREFRONT TOOLS</button>
        <div class="hr"></div><h3>Delivery Exceptions</h3>
        <div class="muted">Use this only for special customers/addresses. Exact customer/address exceptions beat normal map zones.</div>
        <div id="pvOverrideList">${renderOverrides(overrides)}</div>
        <div class="card" style="background:#f6f6f4;padding:11px;margin-top:10px"><b>ADD EXCEPTION</b>
          <div class="field"><label>APPLIES TO</label><select id="pvOvType"><option value="address">Exact address</option><option value="street">Entire street</option><option value="customer">Specific returning customer</option></select></div>
          <div class="field" id="pvOvValueWrap"><label id="pvOvValueLabel">EXACT ADDRESS</label><input id="pvOvValue" placeholder="815 Rupert Terrace, Victoria"></div>
          <div class="field hidden" id="pvOvCustomerWrap"><label>CUSTOMER</label><select id="pvOvCustomer"><option value="">Choose customer</option>${customers.map(c=>`<option value="${c.id}">${E(c.display_name||'Customer')} • ${E(c.phone||c.email||c.address||'')}</option>`).join('')}</select></div>
          <div class="two"><div class="field"><label>USE ZONE</label><select id="pvOvZone">${zones.map(z=>`<option value="${z.id}">${E(z.name)}</option>`).join('')}</select></div><div class="field"><label>SPECIAL FEE (OPTIONAL)</label><input id="pvOvFee" type="number" min="0" step=".01" placeholder="blank = zone fee"></div></div>
          <div class="field"><label>NOTE</label><input id="pvOvNote" placeholder="Good customer — no delivery fee"></div><button class="btn ghost" style="width:100%" id="pvAddOverride">ADD DELIVERY EXCEPTION</button>
        </div>`);
      document.getElementById('pvSaveStorefront').onclick=async()=>{try{await req(`/api/admin/platform/territories/${encodeURIComponent(tid)}/storefront`,{method:'PUT',body:JSON.stringify({announcement_enabled:document.getElementById('pvAnnOn').checked,announcement_text:document.getElementById('pvAnnText').value,help_enabled:document.getElementById('pvHelpOn').checked,help_heading:document.getElementById('pvHelpHeading').value,help_text:document.getElementById('pvHelpText').value,help_contact:document.getElementById('pvHelpContact').value,help_contact_action:document.getElementById('pvHelpAction').value})});alert('Storefront tools saved.');}catch(e){alert(e.message)}};
      document.getElementById('pvOvType').onchange=e=>{const customer=e.target.value==='customer',street=e.target.value==='street';document.getElementById('pvOvCustomerWrap').classList.toggle('hidden',!customer);document.getElementById('pvOvValueWrap').classList.toggle('hidden',customer);document.getElementById('pvOvValueLabel').textContent=street?'STREET NAME':'EXACT ADDRESS';document.getElementById('pvOvValue').placeholder=street?'Rupert Terrace':'815 Rupert Terrace, Victoria';};
      document.getElementById('pvAddOverride').onclick=async()=>{try{const fee=document.getElementById('pvOvFee').value;await req(`/api/admin/platform/territories/${encodeURIComponent(tid)}/zone-overrides`,{method:'POST',body:JSON.stringify({match_type:document.getElementById('pvOvType').value,match_value:document.getElementById('pvOvValue').value,customer_id:document.getElementById('pvOvCustomer').value,zone_id:document.getElementById('pvOvZone').value,fee_cents:fee===''?null:Math.round(Number(fee)*100),note:document.getElementById('pvOvNote').value,active:true})});await openStorefrontTools();}catch(e){alert(e.message)}};
    }catch(e){alert(e.message)}
  }
  function renderOverrides(rows){return rows.length?rows.map(o=>`<div class="archiveItem"><div class="row"><div><b>${o.match_type==='customer'?E(o.customer_name||'Customer'):o.match_type==='street'?'STREET: '+E(o.match_value):'ADDRESS: '+E(o.match_value)}</b><div class="muted">→ ${E(o.zone_name)}${o.fee_cents!=null?' • special fee '+moneyCents(o.fee_cents):' • normal zone fee'}${o.note?' • '+E(o.note):''}</div></div><button class="btn danger" onclick="window.pvDeleteZoneOverride('${o.id}')">DELETE</button></div></div>`).join(''):'<div class="good" style="margin-top:8px">No special delivery exceptions yet.</div>';}
  window.pvDeleteZoneOverride=async id=>{if(!confirm('Delete this delivery exception?'))return;try{await req('/api/admin/platform/zone-overrides/'+encodeURIComponent(id),{method:'DELETE'});await openStorefrontTools();}catch(e){alert(e.message)}};

  async function openRatings(){
    const t=activeT();if(!t?.territory?.id)return alert('Choose a city first.');
    try{const rows=await req('/api/admin/platform/product-ratings'),allowed=new Set((t.products||[]).map(p=>p.id)),list=rows.filter(r=>allowed.has(r.product_id));
      openModal(`<h2>Product Ratings</h2><div class="good">Optional display only. No rating is shown until Product Ratings is switched ON in Business Setup and a rating is saved here.</div>
        <div class="field"><label>PRODUCT</label><select id="pvRateProduct">${list.map(r=>`<option value="${r.product_id}" data-rating="${r.rating??''}" data-count="${r.review_count??0}">${E(r.brand)} ${E(r.flavor)}${r.strength?' • '+E(strengthLabel(r.strength)):''}</option>`).join('')}</select></div>
        <div class="two"><div class="field"><label>RATING (1–5)</label><input id="pvRateValue" type="number" min="1" max="5" step=".1" value="5"></div><div class="field"><label>REVIEW COUNT</label><input id="pvRateCount" type="number" min="0" value="0"></div></div>
        <div class="two"><button class="btn" id="pvRateSave">SAVE RATING</button><button class="btn danger" id="pvRateRemove">REMOVE RATING</button></div><div class="hr"></div><div id="pvRatingsList">${list.map(r=>`<div class="archiveItem"><b>${E(r.brand)} ${E(r.flavor)}</b><div class="muted">${r.rating!=null?`${Number(r.rating).toFixed(1)} ★ • ${Number(r.review_count)||0} reviews`:'No rating saved'}</div></div>`).join('')}</div>`);
      const sel=document.getElementById('pvRateProduct'),sync=()=>{const o=sel.selectedOptions[0];document.getElementById('pvRateValue').value=o?.dataset.rating||'5';document.getElementById('pvRateCount').value=o?.dataset.count||'0';};sel.onchange=sync;sync();
      document.getElementById('pvRateSave').onclick=async()=>{try{await req(`/api/admin/platform/products/${encodeURIComponent(sel.value)}/rating`,{method:'PUT',body:JSON.stringify({rating:document.getElementById('pvRateValue').value,review_count:document.getElementById('pvRateCount').value})});await openRatings();}catch(e){alert(e.message)}};
      document.getElementById('pvRateRemove').onclick=async()=>{if(!confirm('Remove this product rating?'))return;try{await req(`/api/admin/platform/products/${encodeURIComponent(sel.value)}/rating`,{method:'DELETE'});await openRatings();}catch(e){alert(e.message)}};
    }catch(e){alert(e.message)}
  }

  let customerCache=[];
  async function openCustomers(){
    const t=activeT();if(!t?.territory?.id)return alert('Choose a city first.');
    try{customerCache=await req(`/api/admin/platform/customers?territory_id=${encodeURIComponent(t.territory.id)}`);openModal(`<h2>Customers</h2><div class="good">No customer accounts. This list is built quietly from completed/placed guest orders so you can recognize repeat customers.</div><div class="field"><label>SEARCH</label><input id="pvCustomerSearch" placeholder="Name, phone, email or address"></div><div id="pvCustomerList">${customerListHtml(customerCache)}</div>`);document.getElementById('pvCustomerSearch').oninput=e=>{const q=e.target.value.toLowerCase();document.getElementById('pvCustomerList').innerHTML=customerListHtml(customerCache.filter(c=>`${c.display_name} ${c.phone} ${c.email} ${c.address}`.toLowerCase().includes(q)));};}catch(e){alert(e.message)}
  }
  function customerListHtml(rows){return rows.length?rows.map(c=>`<button class="archiveItem" style="display:block;width:100%;border:0;text-align:left" onclick="window.pvOpenCustomer('${c.id}')"><div class="row"><div><b>${E(c.display_name||'Customer')}</b><div class="muted">${E(c.phone||c.email||c.address||'No contact')} • ${Number(c.order_count)||0} order${Number(c.order_count)===1?'':'s'}</div></div>${Number(c.loyalty_stars)>0?`<span class="chip on">${'★'.repeat(Number(c.loyalty_stars))}</span>`:Number(c.order_count)>1?'<span class="chip">RETURNING</span>':''}</div></button>`).join(''):'<div class="card">No returning customer records yet.</div>';}
  window.pvOpenCustomer=async cid=>{try{const c=await req('/api/admin/platform/customers/'+encodeURIComponent(cid));const others=customerCache.filter(x=>x.id!==cid);openModal(`<h2>${E(c.display_name||'Customer')}</h2><div class="statusline"><span class="chip">${Number(c.order_count)||0} ORDERS</span>${c.admin_confirmed?'<span class="chip on">ADMIN CONFIRMED</span>':''}</div>
      <div class="two"><div class="field"><label>NAME</label><input id="pvCName" value="${E(c.display_name||'')}"></div><div class="field"><label>PHONE</label><input id="pvCPhone" value="${E(c.phone||'')}"></div></div><div class="field"><label>EMAIL</label><input id="pvCEmail" value="${E(c.email||'')}"></div><div class="field"><label>ADDRESS</label><input id="pvCAddress" value="${E(c.address||'')}"></div>
      <div class="two"><div class="field"><label>LOYAL CUSTOMER STARS (0–5)</label><input id="pvCStars" type="number" min="0" max="5" value="${Number(c.loyalty_stars)||0}"></div><div class="field"><label>BADGE LABEL</label><input id="pvCLabel" value="${E(c.loyalty_label||'')}" placeholder="Loyal Customer"></div></div><label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input id="pvCConfirmed" type="checkbox" style="width:20px;height:20px" ${c.admin_confirmed?'checked':''}> Admin confirmed this customer match</label><button class="btn" style="width:100%" id="pvCSave">SAVE CUSTOMER</button>
      <div class="hr"></div><h3>Driver / Admin Notes</h3>${(c.notes||[]).length?(c.notes||[]).map(n=>`<div class="archiveItem"><div>${E(n.note)}</div><div class="muted">${E(n.driver_name||n.created_by_role)} • ${E(window.pvHumanStamp(n.created_at))}</div></div>`).join(''):'<div class="muted">No customer notes yet.</div>'}<div class="field"><label>ADD NOTE FOR FUTURE ORDERS</label><textarea id="pvCNote" placeholder="Useful delivery/customer context only"></textarea></div><button class="btn ghost" style="width:100%" id="pvCAddNote">ADD CUSTOMER NOTE</button>
      <button class="btn danger" style="width:100%;margin-top:14px" id="pvCDelete">DELETE CUSTOMER</button><div class="muted" style="margin-top:6px">Archives this customer profile only. Historical orders, payments, settlements, and audit records are retained.</div>
      <details class="advanced" style="margin-top:14px"><summary>Fix a duplicate customer match</summary><div class="warn">Only use this if the same person accidentally has two customer records.</div><div class="field"><label>MERGE THIS OTHER RECORD INTO ${E(c.display_name||'THIS CUSTOMER')}</label><select id="pvCMerge"><option value="">Choose duplicate</option>${others.map(x=>`<option value="${x.id}">${E(x.display_name||'Customer')} • ${E(x.phone||x.email||x.address||'')}</option>`).join('')}</select></div><button class="btn danger" style="width:100%" id="pvCMergeBtn">MERGE DUPLICATE</button></details>`);
      document.getElementById('pvCSave').onclick=async()=>{try{await req('/api/admin/platform/customers/'+encodeURIComponent(cid),{method:'PUT',body:JSON.stringify({display_name:document.getElementById('pvCName').value,phone:document.getElementById('pvCPhone').value,email:document.getElementById('pvCEmail').value,address:document.getElementById('pvCAddress').value,loyalty_stars:document.getElementById('pvCStars').value,loyalty_label:document.getElementById('pvCLabel').value,admin_confirmed:document.getElementById('pvCConfirmed').checked})});alert('Customer saved.');await window.pvOpenCustomer(cid);}catch(e){alert(e.message)}};
      document.getElementById('pvCAddNote').onclick=async()=>{try{await req(`/api/admin/platform/customers/${encodeURIComponent(cid)}/notes`,{method:'POST',body:JSON.stringify({note:document.getElementById('pvCNote').value})});await window.pvOpenCustomer(cid);}catch(e){alert(e.message)}};
      document.getElementById('pvCDelete').onclick=async()=>{if(!confirm('Delete this customer from the Customers list? Their historical orders, payments, settlements, notes, and audit records will be kept.'))return;try{await req('/api/admin/platform/customers/'+encodeURIComponent(cid),{method:'DELETE'});customerCache=customerCache.filter(x=>x.id!==cid);await openCustomers();alert('Customer profile archived. Historical records were retained.');}catch(e){alert(e.message)}};
      document.getElementById('pvCMergeBtn').onclick=async()=>{const source=document.getElementById('pvCMerge').value;if(!source)return alert('Choose the duplicate record.');if(!confirm('Merge the duplicate into this customer? Orders and notes will be combined.'))return;try{await req(`/api/admin/platform/customers/${encodeURIComponent(cid)}/merge`,{method:'POST',body:JSON.stringify({source_customer_id:source})});customerCache=customerCache.filter(x=>x.id!==source);await window.pvOpenCustomer(cid);}catch(e){alert(e.message)}};
    }catch(e){alert(e.message)}};

  function patchOrderCustomer(){
    if(!window.openOrder||window.openOrder.__pvCustomerHistoryPatched)return;const original=window.openOrder;
    const patched=async function(orderId){await original(orderId);try{const c=await req(`/api/admin/platform/orders/${encodeURIComponent(orderId)}/customer`);if(!c?.recognized)return;const holder=document.createElement('div');holder.id='pvCustomerHistoryPanel';const stars=Number(c.loyalty_stars)||0;holder.innerHTML=`<div class="hr"></div><h3>CUSTOMER HISTORY</h3><div class="good"><b>${stars?'★'.repeat(stars)+' '+E(c.loyalty_label||'Loyal Customer'):c.returning_customer?'★ RETURNING CUSTOMER':'FIRST RECORDED ORDER'}</b><div style="margin-top:4px">${Number(c.previous_order_count)||0} previous order${Number(c.previous_order_count)===1?'':'s'}</div></div>${(c.notes||[]).slice(0,5).map(n=>`<div class="archiveItem"><b>NOTE</b><br>${E(n.note)}<div class="muted">${E(window.pvHumanStamp(n.created_at))}</div></div>`).join('')}<button class="btn ghost" style="width:100%;margin-top:8px" onclick="window.pvOpenCustomer('${c.customer_id}')">OPEN CUSTOMER RECORD</button>`;document.getElementById('modalContent')?.appendChild(holder);}catch{}};patched.__pvCustomerHistoryPatched=true;patched.__pvPatched=!!original.__pvPatched;window.openOrder=patched;
  }

  function installSettlementView(){if(!window.renderSettlements||window.renderSettlements.__companySimple||window.renderSettlements.__finalSupervisor)return;const render=async function(){const t=activeT();if(!t)return;const data=await req(`/api/admin/platform/territories/${encodeURIComponent(t.territory.id)}/settlements`);view.innerHTML=data.drivers.map(settlementCard).join('')+`<details class="card"><summary><b>Previous Settlements (${data.history.length})</b></summary>${data.history.map(h=>{const s=h.snapshot||{},amount=s.final_amount_cents??s.send_to_boss_cents??0;return `<div class="archiveItem"><b>${E(h.driver_name)}</b><div class="muted">${humanWhen(h.started_at)} – ${humanWhen(h.closed_at)} · Settled</div><b>${moneyCents(amount)}</b><button class="btn ghost" onclick="window.pvCorrectSettlement('${h.id}')">CORRECT SETTLEMENT</button></div>`}).join('')||'<div class="muted">No previous settlements.</div>'}</details>`;};render.__companySimple=true;window.renderSettlements=render;}
  function humanWhen(value){return new Intl.DateTimeFormat('en-CA',{month:'long',day:'numeric'}).format(new Date(value));}
  function settlementCard(s){const p=s.period,companyOwes=s.final_direction==='company_owes_driver';return `<div class="card"><div style="font-size:20px;font-weight:1000">${E(s.driver.name)}</div><div class="muted">Open Since ${humanWhen(s.started_at)}</div><div class="two" style="margin-top:10px"><div class="receiveBox"><span class="muted">Cans Accounted For</span><div class="stockNow">${s.accountable_items}</div></div><div class="receiveBox"><span class="muted">Company Received</span><div class="money">${moneyCents(s.boss_credit_cents)}</div></div></div><div style="background:${companyOwes?'#28623d':'#111'};color:#fff;border-radius:16px;padding:17px;margin:10px 0;text-align:center"><div style="font-size:12px;font-weight:900">${companyOwes?'COMPANY OWES DRIVER':'SEND TO COMPANY'}</div><div style="font-size:38px;font-weight:1000">${moneyCents(s.final_amount_cents)}</div></div>${s.adjustment_cents?`<div class="warn">Calculated: ${moneyCents(Math.abs(s.calculated_net_cents))}<br>Company Adjustment: ${s.adjustment_cents<0?'−':'+'}${moneyCents(Math.abs(s.adjustment_cents))}<br>${E(s.adjustment_reason)}</div>`:''}<details class="advanced"><summary>View Breakdown</summary><div class="receipt"><div class="line"><span>Website Sales</span><b>${s.sold_website}</b></div><div class="line"><span>Off-Site Sales</span><b>${s.sold_off_website}</b></div><div class="line"><span>Company Share</span><b>${moneyCents(s.boss_share_before_credits_cents)}</b></div><div class="line"><span>Company Received</span><b>−${moneyCents(s.boss_credit_cents)}</b></div><div class="line"><span>Delivery Fees</span><b>${moneyCents(s.delivery_fees_cents)}</b></div><div class="line"><span>Tips</span><b>${moneyCents(s.tips_cents)}</b></div></div><details><summary>Check Stock</summary><div class="muted">Starting ${s.starting_inventory??'—'} • Expected ${s.expected_ending_inventory??'—'} • Actual ${s.actual_ending_inventory??'—'} • Variance ${s.variance??'—'}</div></details></details><div class="three"><button class="btn ghost" onclick="window.pvAdjustSettlement('${p.id}','${s.final_direction}',${s.final_amount_cents})">ADJUST FINAL</button><button class="btn ghost" onclick="window.pvShareSettlement('${p.id}')">COPY / SHARE</button><button class="btn" onclick="window.pvCloseSettlement('${p.id}')">MARK AS SETTLED</button></div></div>`;}
  window.pvSaveCounts=async pid=>{await req('/api/admin/platform/settlement-periods/'+pid,{method:'PUT',body:JSON.stringify({starting_inventory:document.getElementById('pvStart_'+pid).value,actual_ending_inventory:document.getElementById('pvActual_'+pid).value})});await window.renderSettlements();};
  window.pvAddSettlementEntry=async pid=>{const kind=document.getElementById('pvKind_'+pid).value,note=document.getElementById('pvNote_'+pid).value;if(!note)return alert('Add a note / audit reason.');await req(`/api/admin/platform/settlement-periods/${pid}/transactions`,{method:'POST',body:JSON.stringify({kind,qty:document.getElementById('pvQty_'+pid).value,amount_cents:Math.round(Number(document.getElementById('pvAmount_'+pid).value||0)*100),note})});await window.renderSettlements();};
  window.pvAdjustSettlement=async(pid,currentDirection,currentAmount)=>{const direction=confirm('Should the final settlement be SEND TO COMPANY?\n\nOK — Send to Company\nCancel — Company Owes Driver')?'send_to_company':'company_owes_driver',amount=prompt('Final settlement amount:',(Number(currentAmount)/100).toFixed(2));if(amount==null)return;const reason=prompt('Why are you changing it?');if(!reason)return alert('A reason is required.');await req(`/api/admin/platform/settlement-periods/${pid}/adjustment`,{method:'POST',body:JSON.stringify({final_direction:direction,final_amount_cents:Math.round(Number(amount)*100),reason})});await window.renderSettlements();};
  window.pvCloseSettlement=async pid=>{if(!confirm('Mark this settlement as settled? The current calculation and adjustment will be frozen.'))return;await req(`/api/admin/platform/settlement-periods/${pid}/close`,{method:'POST',body:'{}'});await window.renderSettlements();};
  window.pvCorrectSettlement=async pid=>{const direction=confirm('Should the corrected record say SEND TO COMPANY?\n\nOK — Send to Company\nCancel — Company Owes Driver')?'send_to_company':'company_owes_driver',amount=prompt('Corrected amount:');if(amount==null)return;const reason=prompt('Reason for correcting this settled record:');if(!reason)return alert('A reason is required.');await req(`/api/admin/platform/settlement-periods/${pid}/correction`,{method:'POST',body:JSON.stringify({final_direction:direction,final_amount_cents:Math.round(Number(amount)*100),reason})});await window.renderSettlements();};
  window.pvShareSettlement=pid=>{const button=[...document.querySelectorAll('button')].find(x=>x.getAttribute('onclick')?.includes(`pvShareSettlement('${pid}')`)),card=button?.closest('.card');openModal(`<h2>Share Settlement</h2><div class="good">Screenshot or copy this summary.</div><div style="white-space:pre-wrap;font-size:16px">${E(card?.innerText||'')}</div>`);};
  async function renderInlineRatings(){if(![...document.querySelectorAll('.tab.active')].some(x=>['Stock','Products'].includes(x.textContent.trim())))return;try{const rows=await req('/api/admin/platform/product-ratings'),map=new Map(rows.map(x=>[x.product_id,x]));document.querySelectorAll('[data-product-id]').forEach(card=>{if(card.querySelector('.pv-inline-rating'))return;const pid=card.dataset.productId,r=map.get(pid)||{},box=document.createElement('details');box.className='advanced pv-inline-rating';box.innerHTML=`<summary>Rating</summary><div class="two"><div class="field"><label>STARS (1–5)</label><input data-rate type="number" min="1" max="5" step=".1" value="${r.rating??5}"></div><div class="field"><label>REVIEWS</label><input data-count type="number" min="0" value="${r.review_count??0}"></div></div><div class="two"><button class="btn ghost" data-save>SAVE RATING</button><button class="btn danger" data-reset>REMOVE / RESET</button></div>`;card.appendChild(box);box.querySelector('[data-save]').onclick=async()=>{try{await req(`/api/admin/platform/products/${encodeURIComponent(pid)}/rating`,{method:'PUT',body:JSON.stringify({rating:box.querySelector('[data-rate]').value,review_count:box.querySelector('[data-count]').value,enabled:true})});alert('Rating saved and shown.');}catch(e){alert(e.message)}};box.querySelector('[data-reset]').onclick=async()=>{if(!confirm('Remove this rating display? Stock, product details, and order history will stay unchanged.'))return;try{await req(`/api/admin/platform/products/${encodeURIComponent(pid)}/rating`,{method:'DELETE'});box.querySelector('[data-rate]').value=5;box.querySelector('[data-count]').value=0;alert('Rating reset.');}catch(e){alert(e.message)}};});}catch(e){console.error('Rating controls:',e.message)}}

  async function openEverydayStorefront(){const t=activeT();if(!t?.territory?.id)return alert('Choose an area first.');try{everydayConfig=await req('/api/admin/platform/config');const tid=t.territory.id,[store,schedule,email]=await Promise.all([req(`/api/admin/platform/territories/${encodeURIComponent(tid)}/storefront`),window.api(`/api/admin/territories/${encodeURIComponent(tid)}/schedule`),req(`/api/admin/platform/territories/${encodeURIComponent(tid)}/email-status`)]),days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],byDay=new Map((schedule.hours||[]).map(x=>[Number(x.weekday),x])),time=n=>`${String(Math.floor(Number(n)/60)).padStart(2,'0')}:${String(Number(n)%60).padStart(2,'0')}`,recipient=(email.recipients||[])[0];openModal(`<h2>Edit Storefront • ${E(t.territory.name)}</h2><div class="field"><label>STORE HOURS</label>${days.map((day,i)=>{const h=byDay.get(i);return `<div class="three" data-hours-day="${i}"><label style="display:flex;gap:6px;align-items:center"><input data-open type="checkbox" ${h?'checked':''}> ${day}</label><input data-start type="time" value="${h?time(h.open_minute):'10:00'}"><input data-end type="time" value="${h?time(h.close_minute):'22:00'}"></div>`}).join('')}</div><div class="field"><label>TOP MESSAGE</label><input id="pvEveryTop" value="${E(store.storefront?.announcement_text||'')}"></div><div class="field"><label>DELIVERY MESSAGE</label><input id="pvEveryDelivery" value="${E(t.territory.same_day_text||'SAME-DAY DELIVERY')}"></div><div class="field"><label>PAYMENT MESSAGE</label><input id="pvEveryPayment" value="${E(t.territory.payment_note_text||'No upfront payment — pay when your order arrives.')}"></div><div class="field"><label>DELIVERY AREA MAP IMAGE</label><input id="pvEveryMap" value="${E(t.territory.delivery_map_image||'')}" placeholder="/delivery-maps/victoria.webp or https://..."><div class="muted">Still image shown to customers before they choose their delivery area. Leave blank only if this Local has no map yet.</div></div><div class="field"><label>SEND NEW ORDER EMAILS TO</label><input id="pvEveryEmail" type="email" value="${E(t.territory.slug==='victoria'?'vicpouches@protonmail.com':recipient?.email||'')}" ${t.territory.slug==='victoria'?'readonly':''}></div><div class="${email.configured?'good':'warn'}"><b>EMAIL DELIVERY: ${email.configured?'CONFIGURED':'NOT CONFIGURED'}</b><br>${email.recent_orders?.[0]?`Last order: ${E(email.recent_orders[0].status)}${email.recent_orders[0].error?' — '+E(email.recent_orders[0].error):''}`:'No delivery attempt recorded yet.'}</div>${t.territory.slug==='victoria'?'<button id="pvEmailTest" class="btn ghost" style="width:100%;margin-top:8px">SEND TEST EMAIL</button>':''}<div class="field"><label>CUSTOMER HELP</label><textarea id="pvEveryHelp">${E(store.storefront?.help_text||'')}</textarea></div><div class="card"><b>Payments</b><div class="row"><span>Cash</span><span class="chip on">ON</span></div><div class="row"><span>e-Transfer</span><span class="chip on">ON</span></div><div class="row"><span>Credit / Debit</span><span class="chip">NOT CONNECTED</span></div><div class="row"><span>PayPal</span><span class="chip">NOT CONNECTED</span></div><div class="row"><span>Crypto</span><span class="chip">NOT CONNECTED</span></div></div><button id="pvEverySave" class="btn" style="width:100%">SAVE STOREFRONT</button><details class="advanced"><summary>More Options / Owner Setup</summary><button id="pvOpenAdvanced" class="btn ghost" style="width:100%">OPEN ADVANCED SETUP</button></details>`);document.getElementById('pvOpenAdvanced').onclick=()=>window.pvOpenStoreCheckoutSettings?.();document.getElementById('pvEmailTest')?.addEventListener('click',async()=>{try{const result=await req(`/api/admin/platform/territories/${encodeURIComponent(tid)}/email-test`,{method:'POST',body:'{}'});alert(result.ok?'Test email sent.':result.error||'Test email failed.');}catch(e){alert(e.message)}});document.getElementById('pvEverySave').onclick=async()=>{try{const minutes=v=>{const [h,m]=v.split(':').map(Number);return h*60+m},hours=[...document.querySelectorAll('[data-hours-day]')].filter(row=>row.querySelector('[data-open]').checked).map(row=>({weekday:Number(row.dataset.hoursDay),open_minute:minutes(row.querySelector('[data-start]').value),close_minute:minutes(row.querySelector('[data-end]').value)}));await window.api(`/api/admin/territories/${encodeURIComponent(tid)}/schedule`,{method:'PUT',body:JSON.stringify({timezone:t.territory.timezone||'America/Vancouver',hours})});await window.api(`/api/admin/territories/${encodeURIComponent(tid)}/storefront-info`,{method:'PUT',body:JSON.stringify({operating_hours:hours.length?'Structured hours configured':'Hours need setup',same_day_text:document.getElementById('pvEveryDelivery').value,payment_note_text:document.getElementById('pvEveryPayment').value,delivery_map_image:document.getElementById('pvEveryMap').value.trim()})});await req(`/api/admin/platform/territories/${encodeURIComponent(tid)}/storefront`,{method:'PUT',body:JSON.stringify({announcement_enabled:!!document.getElementById('pvEveryTop').value.trim(),announcement_text:document.getElementById('pvEveryTop').value,help_enabled:!!document.getElementById('pvEveryHelp').value.trim(),help_heading:'Need help?',help_text:document.getElementById('pvEveryHelp').value,help_contact:'',help_contact_action:'none'})});const other=(everydayConfig.notification_recipients||[]).filter(x=>x.territory_id!==tid),mail=document.getElementById('pvEveryEmail').value.trim();if(mail)other.push({id:recipient?.id||'',email:mail,enabled:true,territory_id:tid});await req('/api/admin/platform/config',{method:'PUT',body:JSON.stringify({notification_recipients:other})});alert('Storefront saved.');window.closeModal();await window.selectTerritory(tid);}catch(e){alert(e.message)}};}catch(e){alert(e.message)}}

  window.openStorefrontInfo=openEverydayStorefront;window.pvOpenStorefrontTools=openEverydayStorefront;window.pvOpenCustomers=openCustomers;window.pvOpenRatings=openRatings;

  // Keep stable settlement/database identifiers such as boss_credit unchanged, while
  // translating every rendered Control Room label (including legacy saved rule names).
  function applyCompanyTerminology(root=document.body){
    if(!root)return;const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
    while((node=walker.nextNode()))if(/\bboss\b/i.test(node.nodeValue||''))node.nodeValue=node.nodeValue.replace(/\bboss\b/gi,'Company');
  }
  const companyTerminologyObserver=new MutationObserver(rows=>rows.forEach(row=>row.addedNodes.forEach(node=>applyCompanyTerminology(node.nodeType===Node.TEXT_NODE?node.parentNode:node))));
  companyTerminologyObserver.observe(document.body,{childList:true,subtree:true});applyCompanyTerminology();

  async function boot(){for(let i=0;i<100;i++){if(document.getElementById('app')&&typeof api==='function')break;await wait(80);}const timer=setInterval(()=>{if(document.getElementById('app')?.classList.contains('hidden'))return;installExtraButtons();patchOrderCustomer();installSettlementView();renderInlineRatings();},500);window.addEventListener('beforeunload',()=>clearInterval(timer),{once:true});}
  boot();
})();
