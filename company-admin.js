(() => {
  'use strict';

  const E = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
  const strength = value => {
    const clean = String(value ?? '').trim().replace(/\s*mg\s*$/i, '');
    return clean ? `${clean} mg` : '';
  };
  const q = id => document.getElementById(id);
  const state = { data:null, search:'', filter:'all', page:1, pageSize:24, inventoryView:'company', busy:false };
  const request = (url, options = {}) => window.api(url, options);
  const activeTerritory = () => {
    try { return typeof T !== 'undefined' ? T?.territory : null; } catch { return null; }
  };
  const modal = html => {
    q('modalContent').innerHTML = html;
    q('modal').classList.add('open');
  };
  const productName = product => `${product.brand} ${product.flavor}${product.series ? ` (${product.series})` : ''}`;
  const image = product => E(product.image || product.catalog_image || '/product-images/catalog-placeholder.webp');
  const territoryFor = (product, territoryId) => product.territories.find(row => row.id === territoryId);
  const totalPhysical = territory => territory ? territory.linked.physical + territory.independent.physical : 0;

  function installStyles() {
    if (q('companyStockStyles')) return;
    const style = document.createElement('style');
    style.id = 'companyStockStyles';
    style.textContent = `
      .cs-toolbar{position:sticky;top:0;z-index:8;background:#efefec;padding:6px 0 10px}
      .cs-title{font-size:25px;font-weight:1000;margin:4px 0}.cs-search{width:100%;border:1px solid #bbb;border-radius:12px;padding:12px;font-size:16px;background:#fff}
      .cs-filters,.cs-subnav{display:flex;gap:7px;overflow:auto;padding:8px 0 2px}.cs-filter{border:0;border-radius:999px;background:#ddd;padding:9px 12px;font-weight:900;white-space:nowrap}.cs-filter.active{background:#111;color:#fff}
      .cs-product{display:grid;grid-template-columns:92px minmax(0,1fr);gap:12px}.cs-image{width:92px;height:92px;border-radius:13px;background:#f4f4f1;display:grid;place-items:center;overflow:hidden}.cs-image img{width:100%;height:100%;object-fit:contain;padding:5px}
      .cs-name{font-size:17px;font-weight:1000;line-height:1.2}.cs-edition{font-size:12px;color:#555;margin-top:3px}.cs-stockgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:10px}.cs-stat{background:#f5f5f2;border-radius:10px;padding:8px}.cs-stat span{display:block;font-size:9px;font-weight:900;color:#555;letter-spacing:.03em}.cs-stat b{font-size:17px}
      .cs-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:10px}.cs-actions .btn{font-size:10px;padding:9px 5px;min-width:0}.cs-pager{display:flex;gap:8px;align-items:center;justify-content:center;margin:14px 0}.cs-pager .btn{min-width:90px}
      .cs-note{font-size:12px;line-height:1.4;color:#444}.cs-history{border-left:4px solid #111;padding:9px 10px;margin:8px 0;background:#f6f6f4;border-radius:0 10px 10px 0}.cs-history b{font-size:13px}.cs-history .muted{font-size:11px}
      .cs-invariant{background:#111;color:#fff;border-radius:14px;padding:13px;margin-bottom:10px}.cs-invariant b{font-size:20px}.cs-empty{background:#fff;border-radius:15px;padding:22px;text-align:center;color:#555}
      @media(max-width:460px){.cs-product{grid-template-columns:78px minmax(0,1fr)}.cs-image{width:78px;height:78px}.cs-actions{grid-template-columns:repeat(2,minmax(0,1fr))}.cs-stockgrid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);
  }

  async function load(force = false) {
    if (state.data && !force) return state.data;
    const territory = activeTerritory();
    state.data = await request(`/api/admin/company-stock/catalog${territory ? `?territory_id=${encodeURIComponent(territory.id)}` : ''}`);
    return state.data;
  }

  function matchProducts(products, territoryId = '') {
    const needle = state.search.trim().toLowerCase();
    return products.filter(product => {
      const territory = territoryFor(product, territoryId);
      const text = [product.brand, product.flavor, product.strength, product.series, product.notes].join(' ').toLowerCase();
      if (needle && !text.includes(needle)) return false;
      if (state.filter === 'live' && !territory?.listed) return false;
      if (state.filter === 'hidden' && territory?.listed) return false;
      if (state.filter === 'stock' && !totalPhysical(territory) && !product.company.reserve) return false;
      if (state.filter === 'zero' && (totalPhysical(territory) || product.company.reserve)) return false;
      if (state.filter === 'low' && !(territory?.customer_sellable > 0 && territory.customer_sellable <= 19)) return false;
      if (state.filter.startsWith('brand:') && product.brand.toLowerCase() !== state.filter.slice(6)) return false;
      if (state.filter === 'archived') return !!product.archived;
      return !product.archived;
    });
  }

  function filterToolbar(products, territoryId) {
    const brands = [...new Set(products.map(product => product.brand).filter(Boolean))].sort();
    const options = [
      ['all','All'], ['live','Live'], ['hidden','Hidden'], ['stock','In stock'], ['zero','Zero stock'], ['low','Low stock'], ['archived','Archived'],
      ...brands.map(brand => [`brand:${brand.toLowerCase()}`, brand])
    ];
    return `<div class="cs-toolbar"><input id="csSearch" class="cs-search" value="${E(state.search)}" placeholder="Search brand, flavour, strength or series"><div class="cs-filters">${options.map(([value,label]) => `<button class="cs-filter ${state.filter === value ? 'active' : ''}" data-cs-filter="${E(value)}">${E(label)}</button>`).join('')}</div></div>`;
  }

  function stockStats(product, territory) {
    return `<div class="cs-stockgrid">
      <div class="cs-stat"><span>COMPANY RESERVE</span><b>${product.company.reserve}</b></div>
      <div class="cs-stat"><span>LINKED SELLABLE</span><b>${territory?.linked.sellable ?? 0}</b></div>
      <div class="cs-stat"><span>LINKED RESERVED</span><b>${territory?.linked.reserved ?? 0}</b></div>
      <div class="cs-stat"><span>LINKED HELD</span><b>${territory?.linked.held ?? 0}</b></div>
      <div class="cs-stat"><span>INDEPENDENT</span><b>${territory?.independent.physical ?? 0}</b></div>
      <div class="cs-stat"><span>CUSTOMER AVAILABLE</span><b>${territory?.customer_sellable ?? 0}</b></div>
    </div>`;
  }

  function productCard(product, territoryId) {
    const territory = territoryFor(product, territoryId);
    return `<div class="card" data-product-id="${E(product.id)}">
      <div class="cs-product"><div class="cs-image"><img src="${image(product)}" alt="${E(productName(product))}" onerror="this.onerror=null;this.src='/product-images/catalog-placeholder.webp'"></div><div>
        <div class="cs-name">${E(product.brand)} • ${E(product.flavor)}</div>
        <div class="cs-edition">${E(strength(product.strength))}${product.series ? ` • ${E(product.series)}` : ''}</div>
        <div class="statusline"><span class="chip ${territory?.listed ? 'on' : 'off'}">${territory?.listed ? 'LIVE' : 'HIDDEN'}</span><span class="chip">${product.policy.mode === 'linked' ? 'LINKED TO COMPANY' : 'INDEPENDENT DEFAULT'}</span>${product.catalog_key ? '<span class="chip on">PRELOADED</span>' : '<span class="chip">CUSTOM</span>'}</div>
      </div></div>${stockStats(product, territory)}
      <div class="cs-actions actions">
        <button class="btn" data-cs-action="receive">RECEIVE STOCK</button><button class="btn ghost" data-cs-action="allocate">ALLOCATE</button><button class="btn ghost" data-cs-action="hold">HOLD / RELEASE</button>
        <button class="btn ${territory?.listed ? 'ghost' : ''}" data-cs-action="listing">${territory?.listed ? 'HIDE' : 'LIST LIVE'}</button><button class="btn ghost" data-cs-action="edit">EDIT</button><button class="btn ghost" data-cs-action="history">HISTORY</button><button class="btn ${product.archived?'':'danger'}" data-cs-action="archive">${product.archived?'RESTORE':'ARCHIVE'}</button>
      </div>
    </div>`;
  }

  function bindLibrary(host, territoryId) {
    const search = q('csSearch');
    if (search) search.oninput = () => { state.search = search.value; state.page = 1; renderProductLibrary(); };
    host.querySelectorAll('[data-cs-filter]').forEach(button => button.onclick = () => { state.filter = button.dataset.csFilter; state.page = 1; renderProductLibrary(); });
    host.querySelectorAll('[data-product-id]').forEach(card => card.onclick = event => {
      const button = event.target.closest('[data-cs-action]');
      if (!button) return;
      const product = state.data.catalog.find(row => row.id === card.dataset.productId);
      openAction(button.dataset.csAction, product, territoryId);
    });
    q('csPrev')?.addEventListener('click', () => { state.page--; renderProductLibrary(); });
    q('csNext')?.addEventListener('click', () => { state.page++; renderProductLibrary(); });
    q('csAddProduct')?.addEventListener('click', openAddProduct);
  }

  async function renderProductLibrary() {
    installStyles();
    const host = q('view');
    host.innerHTML = '<div class="card">Loading Product Library…</div>';
    try {
      const data = await load();
      const territory = activeTerritory();
      if (!territory) throw new Error('Choose a territory first');
      const list = matchProducts(data.catalog, territory.id);
      const pages = Math.max(1, Math.ceil(list.length / state.pageSize));
      state.page = Math.min(Math.max(1, state.page), pages);
      const shown = list.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
      host.innerHTML = `<div class="row"><div><div class="cs-title">Product Library</div><div class="muted">${data.catalog.length} reusable products • ${E(territory.name)} listing and availability</div></div><button id="csAddProduct" class="btn">ADD</button></div>
        <div class="good"><b>Library is separate from storefront listing.</b><br>Every newly preloaded product starts at stock 0, hidden, and not featured. Receive and release stock before listing it live.</div>
        ${filterToolbar(data.catalog, territory.id)}
        ${shown.length ? shown.map(product => productCard(product, territory.id)).join('') : '<div class="cs-empty">No products match these filters.</div>'}
        <div class="cs-pager"><button id="csPrev" class="btn ghost" ${state.page <= 1 ? 'disabled' : ''}>PREVIOUS</button><b>${state.page} / ${pages}</b><button id="csNext" class="btn ghost" ${state.page >= pages ? 'disabled' : ''}>NEXT</button></div>`;
      bindLibrary(host, territory.id);
    } catch (error) { host.innerHTML = `<div class="warn"><b>Product Library could not load.</b><br>${E(error.message)}</div>`; }
  }

  function openAddProduct() {
    modal(`<h2>Add Product</h2><div class="good">This creates a reusable product with zero stock and hidden storefront listings in every territory.</div>
      <div class="two"><div class="field"><label>BRAND</label><input id="csBrand"></div><div class="field"><label>FLAVOUR / PRODUCT</label><input id="csFlavor"></div></div>
      <div class="two"><div class="field"><label>STRENGTH (MG)</label><input id="csStrength"></div><div class="field"><label>SERIES / EDITION</label><input id="csSeries"></div></div>
      <div class="field"><label>LOCAL IMAGE PATH OR HTTPS URL</label><input id="csImage" placeholder="/product-images/..."></div><div class="field"><label>NOTES</label><textarea id="csNotes"></textarea></div>
      <button id="csSaveNew" class="btn" style="width:100%">ADD HIDDEN PRODUCT</button>`);
    q('csSaveNew').onclick = async () => {
      const brand=q('csBrand').value.trim(), flavor=q('csFlavor').value.trim();
      if (!brand || !flavor) return alert('Brand and flavour are required.');
      await request('/api/admin/products',{method:'POST',body:JSON.stringify({brand,flavor,strength:q('csStrength').value,series:q('csSeries').value,image:q('csImage').value,notes:q('csNotes').value})});
      closeModal(); state.data=null; await renderProductLibrary();
    };
  }

  function openAction(action, product, territoryId) {
    if (!product) return;
    if (action === 'receive') return openReceive(product, territoryId);
    if (action === 'allocate') return openAllocate(product, territoryId);
    if (action === 'hold') return openHold(product, territoryId);
    if (action === 'listing') return toggleListing(product, territoryId);
    if (action === 'edit') return openEdit(product, territoryId);
    if (action === 'history') return openHistory(product);
    if (action === 'archive') return toggleArchive(product);
  }

  function actionTitle(product) { return `<h2>${E(product.brand)} ${E(product.flavor)}</h2><div class="muted">${E(strength(product.strength))}${product.series ? ` • ${E(product.series)}` : ''}</div>`; }
  function territoryOptions(selected = '') { return state.data.territories.map(row => `<option value="${E(row.id)}" ${row.id === selected ? 'selected' : ''}>${E(row.name)}</option>`).join(''); }

  function openReceive(product, territoryId) {
    modal(`${actionTitle(product)}<h3>Receive Stock</h3><div class="good">Normal linked shipments go to Company Reserve first. Independent shipments can be received directly into one territory.</div>
      <div class="field"><label>DESTINATION</label><select id="csReceiveTarget"><option value="company_reserve">Company Reserve</option><option value="independent_territory">Independent territory stock</option><option value="linked_territory">Linked territory stock (direct)</option></select></div>
      <div id="csReceiveTerritoryWrap" class="field hidden"><label>TERRITORY</label><select id="csReceiveTerritory">${territoryOptions(territoryId)}</select></div>
      <div class="two"><div class="field"><label>QUANTITY RECEIVED</label><input id="csReceiveQty" type="number" min="1" inputmode="numeric"></div><div id="csReceiveSellableWrap" class="field hidden"><label>SELLABLE NOW</label><input id="csReceiveSellable" type="number" min="0" value="0"><div class="muted">Remainder is held back.</div></div></div>
      <div class="field"><label>SHIPMENT NOTE</label><input id="csReceiveNote" placeholder="Supplier / shipment reference"></div><button id="csReceiveSave" class="btn" style="width:100%">RECEIVE STOCK</button>`);
    const sync = () => { const direct=q('csReceiveTarget').value !== 'company_reserve'; q('csReceiveTerritoryWrap').classList.toggle('hidden',!direct); q('csReceiveSellableWrap').classList.toggle('hidden',!direct); };
    q('csReceiveTarget').onchange=sync; sync();
    q('csReceiveSave').onclick=()=>mutate('/api/admin/company-stock/receive',{product_id:product.id,target:q('csReceiveTarget').value,territory_id:q('csReceiveTerritory')?.value,qty:q('csReceiveQty').value,sellable_qty:q('csReceiveSellable')?.value,note:q('csReceiveNote').value});
  }

  function openAllocate(product, territoryId) {
    modal(`${actionTitle(product)}<h3>Allocate Company Reserve</h3><div class="cs-invariant"><span>AVAILABLE IN COMPANY RESERVE</span><br><b>${product.company.reserve} cans</b></div><div class="field"><label>DESTINATION TERRITORY</label><select id="csAllocateTerritory">${territoryOptions(territoryId)}</select></div><div class="field"><label>QUANTITY</label><input id="csAllocateQty" type="number" min="1" max="${product.company.reserve}"></div><div class="field"><label>NOTE</label><input id="csAllocateNote"></div><div class="good">Allocated cans arrive held back. Use HOLD / RELEASE to expose the chosen quantity to customers.</div><button id="csAllocateSave" class="btn" style="width:100%">ALLOCATE HELD STOCK</button>`);
    q('csAllocateSave').onclick=()=>mutate('/api/admin/company-stock/allocate',{product_id:product.id,territory_id:q('csAllocateTerritory').value,qty:q('csAllocateQty').value,note:q('csAllocateNote').value});
  }

  function openHold(product, territoryId) {
    const territory=territoryFor(product,territoryId);
    modal(`${actionTitle(product)}<h3>Hold Back / Release</h3>${stockStats(product,territory)}
      <div class="two"><div class="field"><label>POOL</label><select id="csHoldPool"><option value="linked">Linked to Company</option><option value="independent">Independent</option></select></div><div class="field"><label>ACTION</label><select id="csHoldAction"><option value="release">Release held stock for sale</option><option value="hold">Hold sellable stock back</option></select></div></div>
      <div class="field"><label>QUANTITY</label><input id="csHoldQty" type="number" min="1"></div><div class="field"><label>NOTE</label><input id="csHoldNote"></div><button id="csHoldSave" class="btn" style="width:100%">APPLY QUANTITY MOVE</button>`);
    q('csHoldSave').onclick=()=>mutate('/api/admin/company-stock/hold',{product_id:product.id,territory_id:territoryId,pool:q('csHoldPool').value,action:q('csHoldAction').value,qty:q('csHoldQty').value,note:q('csHoldNote').value});
  }

  async function toggleListing(product, territoryId) {
    const territory=territoryFor(product,territoryId);
    if (!territory) return;
    if (!territory.listed && territory.customer_sellable <= 0 && !confirm('This product has no customer-sellable stock. List it live anyway? It will remain absent from the storefront until stock is released.')) return;
    await request(`/api/admin/territories/${encodeURIComponent(territoryId)}/product/${encodeURIComponent(product.id)}`,{method:'PUT',body:JSON.stringify({listed:!territory.listed,featured:territory.featured,local_price_override_cents:territory.local_price_override_cents,sort_order:0})});
    await refreshCurrent();
  }

  async function toggleArchive(product) {
    if (product.archived) await request(`/api/admin/products/${encodeURIComponent(product.id)}/restore`,{method:'POST',body:'{}'});
    else {
      if (!confirm(`Archive ${productName(product)}? It will be hidden from every storefront but its stock and history remain.`)) return;
      const territory=activeTerritory();
      await request(`/api/admin/territories/${encodeURIComponent(territory.id)}/product/${encodeURIComponent(product.id)}`,{method:'DELETE'});
    }
    await refreshCurrent();
  }

  function openEdit(product, territoryId) {
    const territory=territoryFor(product,territoryId);
    modal(`${actionTitle(product)}<div class="cs-image" style="width:140px;height:140px;margin:12px auto"><img src="${image(product)}" style="width:100%;height:100%;object-fit:contain" onerror="this.onerror=null;this.src='/product-images/catalog-placeholder.webp'"></div>
      <div class="two"><div class="field"><label>BRAND</label><input id="csEditBrand" value="${E(product.brand)}"></div><div class="field"><label>FLAVOUR / PRODUCT</label><input id="csEditFlavor" value="${E(product.flavor)}"></div></div>
      <div class="two"><div class="field"><label>STRENGTH (MG)</label><input id="csEditStrength" value="${E(String(product.strength||'').replace(/\s*mg\s*$/i,''))}"></div><div class="field"><label>SERIES / EDITION</label><input id="csEditSeries" value="${E(product.series||'')}"></div></div>
      <div class="field"><label>IMAGE PATH / URL</label><input id="csEditImage" value="${image(product)}"><div class="muted">Preloaded catalog images are local. A custom replacement is preserved on restart.</div></div><div class="field"><label>NOTES</label><textarea id="csEditNotes">${E(product.notes||'')}</textarea></div>
      <div class="field"><label>DEFAULT STOCK MODE</label><select id="csEditPolicy"><option value="inherit" ${product.policy.source!=='product'?'selected':''}>Inherit system / brand default</option><option value="linked" ${product.policy.source==='product'&&product.policy.mode==='linked'?'selected':''}>Linked to Company</option><option value="independent" ${product.policy.source==='product'&&product.policy.mode==='independent'?'selected':''}>Independent</option></select><div class="muted">Changing this default does not move existing cans.</div></div>
      <div class="two"><div class="field"><label>LOCAL PRICE OVERRIDE</label><input id="csEditPrice" type="number" step=".01" value="${territory?.local_price_override_cents == null ? '' : (territory.local_price_override_cents/100).toFixed(2)}"></div><label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input id="csEditFeatured" type="checkbox" style="width:20px;height:20px" ${territory?.featured?'checked':''}> Featured in ${E(territory?.name||'territory')}</label></div>
      <button id="csEditSave" class="btn" style="width:100%">SAVE PRODUCT</button>`);
    q('csEditSave').onclick=async()=>{
      await request(`/api/admin/company-stock/products/${encodeURIComponent(product.id)}`,{method:'PUT',body:JSON.stringify({brand:q('csEditBrand').value,flavor:q('csEditFlavor').value,strength:q('csEditStrength').value,series:q('csEditSeries').value,image:q('csEditImage').value,notes:q('csEditNotes').value,active:true,archived:false,territory_id:territoryId})});
      await request('/api/admin/company-stock/product-policy',{method:'PUT',body:JSON.stringify({product_id:product.id,mode:q('csEditPolicy').value,territory_id:territoryId})});
      await request(`/api/admin/territories/${encodeURIComponent(territoryId)}/product/${encodeURIComponent(product.id)}`,{method:'PUT',body:JSON.stringify({listed:territory?.listed,featured:q('csEditFeatured').checked,local_price_override:q('csEditPrice').value,sort_order:0})});
      closeModal(); await refreshCurrent();
    };
  }

  async function openHistory(product) {
    modal(`${actionTitle(product)}<div id="csHistory"><div class="card">Loading stock history…</div></div>`);
    try { const rows=await request(`/api/admin/company-stock/history?product_id=${encodeURIComponent(product.id)}&limit=300`); q('csHistory').innerHTML=historyRows(rows); }
    catch(error){q('csHistory').innerHTML=`<div class="warn">${E(error.message)}</div>`;}
  }

  function historyRows(rows) {
    return rows.length ? rows.map(row=>`<div class="cs-history"><b>${E(String(row.movement_type).replaceAll('_',' ').toUpperCase())} • ${row.qty_delta > 0 ? '+' : ''}${row.qty_delta}</b><div>${E(row.brand)} ${E(row.flavor)} • ${E(row.pool||'legacy')}${row.territory_name ? ` • ${E(row.territory_name)}` : ''}</div><div class="muted">${E(row.note||'No note')} • ${new Date(row.created_at).toLocaleString()}${row.previous_qty != null ? ` • ${row.previous_qty} → ${row.resulting_qty}` : ''}${row.order_no ? ` • Order #${row.order_no}` : ''}</div></div>`).join('') : '<div class="cs-empty">No inventory history yet.</div>';
  }

  async function mutate(url, body) {
    if (state.busy) return;
    state.busy=true;
    try { await request(url,{method:'POST',body:JSON.stringify(body)}); closeModal(); await refreshCurrent(); }
    catch(error){alert(error.message);}
    finally{state.busy=false;}
  }

  async function refreshCurrent() {
    state.data=null;
    if (typeof currentTab !== 'undefined' && currentTab === 'inventory') await renderCompanyInventory(); else await renderProductLibrary();
  }

  function inventorySubnav() {
    const views=[['company','Company Stock'],...state.data.territories.map(row=>[`territory:${row.id}`,row.name]),['history','Transfers / History']];
    return `<div class="cs-subnav">${views.map(([value,label])=>`<button class="cs-filter ${state.inventoryView===value?'active':''}" data-cs-view="${E(value)}">${E(label)}</button>`).join('')}</div>`;
  }

  async function renderCompanyInventory() {
    installStyles(); const host=q('view'); host.innerHTML='<div class="card">Loading Company Stock…</div>';
    try {
      await load();
      host.innerHTML=`<div class="cs-title">Inventory</div><div class="muted">Global Company Stock and territory pools</div>${inventorySubnav()}<div id="csInventoryBody"></div>`;
      host.querySelectorAll('[data-cs-view]').forEach(button=>button.onclick=()=>{state.inventoryView=button.dataset.csView;renderCompanyInventory();});
      if(state.inventoryView==='company')renderCompanyView();
      else if(state.inventoryView==='history')await renderHistoryView();
      else renderTerritoryView(state.inventoryView.slice(10));
    } catch(error){host.innerHTML=`<div class="warn"><b>Inventory could not load.</b><br>${E(error.message)}</div>`;}
  }

  function renderCompanyView() {
    const body=q('csInventoryBody'), products=state.data.catalog.filter(product=>!product.archived);
    const brands=[...new Set(products.map(product=>product.brand))].sort();
    const linkedTotal=products.reduce((sum,product)=>sum+product.company.linked_physical,0), reserveTotal=products.reduce((sum,product)=>sum+product.company.reserve,0), allocations=linkedTotal-reserveTotal;
    body.innerHTML=`<div class="cs-invariant"><span>COMPANY-LINKED PHYSICAL STOCK</span><br><b>${linkedTotal} cans</b><div class="cs-note" style="color:#ddd">Company Reserve ${reserveTotal} + linked territory allocations ${allocations}</div></div>
      <div class="card"><h3>Stock Linkage Defaults</h3><label style="display:flex;gap:9px;align-items:center"><input id="csSystemLinked" type="checkbox" style="width:22px;height:22px" ${state.data.config.system_default_linked?'checked':''}><span><b>SYSTEM DEFAULT — LINK NEW STOCK TO COMPANY</b><div class="muted">Changing a default never moves existing cans.</div></span></label><button id="csSaveSystem" class="btn" style="width:100%;margin-top:10px">SAVE SYSTEM DEFAULT</button><div class="hr"></div><b>BRAND DEFAULTS</b>${brands.map(brand=>{const saved=state.data.config.brand_defaults.find(row=>row.brand_key===brand.toLowerCase()),linked=saved?saved.linked_default:state.data.config.system_default_linked;return `<label style="display:flex;justify-content:space-between;gap:9px;align-items:center;padding:9px 0;border-bottom:1px solid #ddd"><span>${E(brand)}</span><select data-cs-brand="${E(brand)}"><option value="linked" ${linked?'selected':''}>Linked</option><option value="independent" ${!linked?'selected':''}>Independent</option></select></label>`;}).join('')}<button id="csSaveBrands" class="btn ghost" style="width:100%;margin-top:10px">SAVE BRAND DEFAULTS</button></div>
      <div class="card"><h3>Linked Stock Transfer</h3><div class="muted">Move linked cans between Company Reserve and territories without changing Company’s physical total.</div><button id="csOpenTransfer" class="btn" style="width:100%;margin-top:10px">TRANSFER LINKED STOCK</button></div>
      <div class="card"><h3>Quantity-Level Opt Out</h3><div class="muted">Move a deliberate quantity between linked and independent stock. Reserved cans cannot be converted.</div><button id="csOpenConvert" class="btn ghost" style="width:100%;margin-top:10px">CONVERT A QUANTITY</button></div>`;
    q('csSaveSystem').onclick=async()=>{await request('/api/admin/company-stock/config',{method:'PUT',body:JSON.stringify({system_default_linked:q('csSystemLinked').checked})});await refreshCurrent();};
    q('csSaveBrands').onclick=async()=>{for(const el of body.querySelectorAll('[data-cs-brand]'))await request('/api/admin/company-stock/brand-policy',{method:'PUT',body:JSON.stringify({brand:el.dataset.csBrand,linked_default:el.value==='linked'})});await refreshCurrent();};
    q('csOpenTransfer').onclick=openTransfer;
    q('csOpenConvert').onclick=openConvert;
  }

  function renderTerritoryView(territoryId) {
    const body=q('csInventoryBody'), territory=state.data.territories.find(row=>row.id===territoryId);
    const products=state.data.catalog.filter(product=>{const row=territoryFor(product,territoryId);return !product.archived&&(row.listed||totalPhysical(row)>0);});
    body.innerHTML=`<div class="good"><b>${E(territory?.name||'Territory')} inventory</b><br>Customer availability is linked sellable + independent sellable only. Company Reserve and held stock never appear in the store.</div>${products.length?products.map(product=>productCard(product,territoryId)).join(''):'<div class="cs-empty">No stock or live listings in this territory.</div>'}`;
    body.querySelectorAll('[data-product-id]').forEach(card=>card.onclick=event=>{const button=event.target.closest('[data-cs-action]');if(button)openAction(button.dataset.csAction,state.data.catalog.find(row=>row.id===card.dataset.productId),territoryId);});
  }

  async function renderHistoryView() {
    const body=q('csInventoryBody'); body.innerHTML='<div class="card">Loading inventory history…</div>';
    const rows=await request('/api/admin/company-stock/history?limit=500'); body.innerHTML=`<div class="good"><b>Inventory audit trail</b><br>Receipts, allocations, transfers, reservations, cancellations, sales, holds, conversions, and corrections remain visible here.</div>${historyRows(rows)}`;
  }

  function productOptions() { return state.data.catalog.filter(product=>!product.archived).map(product=>`<option value="${E(product.id)}">${E(product.brand)} — ${E(product.flavor)} — ${E(strength(product.strength))}</option>`).join(''); }
  function endpointOptions() { return `<option value="reserve">Company Reserve</option>${state.data.territories.map(row=>`<option value="territory:${E(row.id)}">${E(row.name)} linked stock</option>`).join('')}`; }

  function openTransfer() {
    modal(`<h2>Transfer Linked Stock</h2><div class="good">Company-linked physical totals remain unchanged. Territory transfers use unreserved held stock first, then sellable stock, and arrive held back.</div><div class="field"><label>PRODUCT</label><select id="csTransferProduct">${productOptions()}</select></div><div class="two"><div class="field"><label>FROM</label><select id="csTransferFrom">${endpointOptions()}</select></div><div class="field"><label>TO</label><select id="csTransferTo">${endpointOptions()}</select></div></div><div class="field"><label>QUANTITY</label><input id="csTransferQty" type="number" min="1"></div><div class="field"><label>NOTE</label><input id="csTransferNote"></div><button id="csTransferSave" class="btn" style="width:100%">TRANSFER STOCK</button>`);
    q('csTransferSave').onclick=()=>{const parse=value=>value==='reserve'?{type:'reserve',territory:''}:{type:'territory',territory:value.slice(10)},from=parse(q('csTransferFrom').value),to=parse(q('csTransferTo').value);mutate('/api/admin/company-stock/transfer',{product_id:q('csTransferProduct').value,qty:q('csTransferQty').value,from_type:from.type,from_territory_id:from.territory,to_type:to.type,to_territory_id:to.territory,note:q('csTransferNote').value});};
  }

  function openConvert() {
    modal(`<h2>Convert Existing Quantity</h2><div class="warn"><b>This moves real cans between accounting pools.</b><br>Total territory physical stock is preserved. Reserved order stock cannot move.</div><div class="field"><label>PRODUCT</label><select id="csConvertProduct">${productOptions()}</select></div><div class="field"><label>TERRITORY</label><select id="csConvertTerritory">${territoryOptions(activeTerritory()?.id)}</select></div><div class="field"><label>DIRECTION</label><select id="csConvertDirection"><option value="linked_to_independent">Linked → Independent</option><option value="independent_to_linked">Independent → Linked</option></select></div><div class="field"><label>QUANTITY</label><input id="csConvertQty" type="number" min="1"></div><div class="field"><label>AUDIT NOTE</label><input id="csConvertNote"></div><label style="display:flex;gap:9px;align-items:flex-start;margin:12px 0"><input id="csConvertConfirm" type="checkbox" style="width:22px;height:22px"><span>I confirm this exact quantity should move pools.</span></label><button id="csConvertSave" class="btn" style="width:100%">CONVERT QUANTITY</button>`);
    q('csConvertSave').onclick=()=>{if(!q('csConvertConfirm').checked)return alert('Confirm the exact quantity move first.');mutate('/api/admin/company-stock/convert',{product_id:q('csConvertProduct').value,territory_id:q('csConvertTerritory').value,direction:q('csConvertDirection').value,qty:q('csConvertQty').value,note:q('csConvertNote').value,confirmed:true});};
  }

  window.renderProductLibrary = renderProductLibrary;
  window.renderCompanyInventory = renderCompanyInventory;
  installStyles();
})();
