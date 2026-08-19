(() => {
  'use strict';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const E = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  let config = null;

  async function preq(url, opt={}) {
    const r = await fetch(url, { ...opt, headers:{'Content-Type':'application/json',...(opt.headers||{})}, cache:'no-store' });
    let j={}; try{j=await r.json()}catch{}
    if(!r.ok) throw Error(j.error||'Request failed');
    return j;
  }
  async function loadConfig(){
    try{ config=await preq('/api/platform/public/config'); return config; }catch{return null;}
  }
  function photoEnabled(){ return config?.modules?.order_photos?.enabled !== false; }

  async function compressPhoto(file) {
    if (!file || !String(file.type||'').startsWith('image/')) throw Error('Choose a photo.');
    let bitmap = null, objectUrl = '';
    try {
      if ('createImageBitmap' in window) bitmap = await createImageBitmap(file);
      let width, height, draw;
      if (bitmap) { width=bitmap.width; height=bitmap.height; draw=(ctx,w,h)=>ctx.drawImage(bitmap,0,0,w,h); }
      else {
        objectUrl=URL.createObjectURL(file); const img=new Image();
        await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('Could not read photo'));img.src=objectUrl;});
        width=img.naturalWidth; height=img.naturalHeight; draw=(ctx,w,h)=>ctx.drawImage(img,0,0,w,h);
      }
      const max=1600, scale=Math.min(1,max/Math.max(width,height));
      const w=Math.max(1,Math.round(width*scale)),h=Math.max(1,Math.round(height*scale));
      const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');draw(ctx,w,h);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.82));
      if(!blob) throw Error('Could not prepare photo');
      return await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=()=>reject(Error('Could not read photo'));fr.readAsDataURL(blob);});
    } finally { try{bitmap?.close?.()}catch{} if(objectUrl)URL.revokeObjectURL(objectUrl); }
  }

  async function uploadFiles(orderId, files) {
    const status=document.getElementById('pvPhotoStatus'); if(status)status.textContent='Preparing photo…';
    const stage=document.getElementById('pvPhotoStage')?.value||'general';
    try {
      for (const file of Array.from(files||[])) {
        if(status)status.textContent='Uploading photo…';
        const image_data_url=await compressPhoto(file);
        await preq(`/api/driver/platform/orders/${encodeURIComponent(orderId)}/photos`,{method:'POST',body:JSON.stringify({stage,image_data_url})});
      }
      if(status)status.textContent='Photo saved to this order.';
      await renderPhotos(orderId);
    } catch(e) { if(status)status.textContent=''; alert(e.message); }
  }

  async function renderPhotos(orderId) {
    const host=document.getElementById('pvDriverPhotos'); if(!host)return;
    try {
      const x=await preq(`/api/driver/platform/orders/${encodeURIComponent(orderId)}/photos`), photos=x.photos||[], p=x.policy||{};
      const required=p.require_pickup_before_on_the_way||p.require_delivery_before_completed;
      host.innerHTML=`<div class="hr"></div><h3>ORDER PHOTOS ${required?'':'(OPTIONAL)'}</h3>
        <div class="muted">${required?'This business has one or more photo rules switched on.':'Take photos only if useful. Photos are NOT required for this business.'} You can add more than one before the order is complete.</div>
        <div style="margin:9px 0"><span class="chip">${photos.length} PHOTO${photos.length===1?'':'S'}</span>${p.require_pickup_before_on_the_way?'<span class="chip new">PICKUP PHOTO REQUIRED</span>':''}${p.require_delivery_before_completed?'<span class="chip new">DELIVERY PHOTO REQUIRED</span>':''}</div>
        <div class="field"><label>PHOTO TYPE</label><select id="pvPhotoStage"><option value="general">General / note</option><option value="pickup">Pickup</option><option value="delivery">Delivery</option></select></div>
        <input id="pvTakePhoto" type="file" accept="image/*" capture="environment" hidden>
        <input id="pvAddPhotos" type="file" accept="image/*" multiple hidden>
        <div class="two"><button class="btn ghost" id="pvTakePhotoBtn">TAKE PHOTO</button><button class="btn ghost" id="pvAddPhotosBtn">ADD FROM PHONE</button></div>
        <div id="pvPhotoStatus" class="muted" style="margin-top:7px"></div>
        ${photos.length?`<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px">${photos.map(ph=>`<div style="background:#f6f6f4;border-radius:12px;padding:8px"><img src="${E(ph.content_url)}" alt="Order photo" style="width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:9px;background:#ddd"><div class="muted" style="margin:5px 0"><b>${E(String(ph.stage||'general').toUpperCase())}</b><br>${new Date(ph.created_at).toLocaleString()}</div>${p.driver_can_delete!==false?`<button class="btn ghost" style="padding:8px" onclick="window.pvDeleteOrderPhoto('${ph.id}','${orderId}')">DELETE / RETAKE</button>`:''}</div>`).join('')}</div>`:''}`;
      document.getElementById('pvTakePhotoBtn').onclick=()=>document.getElementById('pvTakePhoto').click();
      document.getElementById('pvAddPhotosBtn').onclick=()=>document.getElementById('pvAddPhotos').click();
      document.getElementById('pvTakePhoto').onchange=e=>uploadFiles(orderId,e.target.files);
      document.getElementById('pvAddPhotos').onchange=e=>uploadFiles(orderId,e.target.files);
    } catch(e) { host.innerHTML=`<div class="muted">Could not load order photos: ${E(e.message)}</div>`; }
  }
  window.pvDeleteOrderPhoto=async(photoId,orderId)=>{
    if(!confirm('Delete this photo? You can take another one.'))return;
    try{await preq(`/api/driver/platform/photos/${encodeURIComponent(photoId)}`,{method:'DELETE'});await renderPhotos(orderId);}catch(e){alert(e.message);}
  };

  function patchStatus() {
    if (!window.setStatus || window.setStatus.__pvPhotoPatched) return;
    const original=window.setStatus;
    const patched=async function(orderId,status){
      try{
        if(photoEnabled() && ['on_the_way','completed'].includes(status)){
          const x=await preq(`/api/driver/platform/orders/${encodeURIComponent(orderId)}/photos`),p=x.policy||{};
          if((status==='on_the_way'||status==='completed')&&p.require_pickup_before_on_the_way&&Number(x.pickup_count||0)<1)return alert('A PICKUP photo is required before continuing. Add a Pickup photo to this order first.');
          if(status==='completed'&&p.require_delivery_before_completed&&Number(x.delivery_count||0)<1)return alert('A DELIVERY photo is required before completing this order. Add a Delivery photo first.');
        }
      }catch(e){return alert(e.message);}
      return original(orderId,status);
    };
    patched.__pvPhotoPatched=true;window.setStatus=patched;
  }

  async function install() {
    for (let i=0;i<80;i++) { if (window.openOrder && window.req) break; await sleep(100); }
    await loadConfig();
    patchStatus();
    if (!window.openOrder || window.openOrder.__pvSupportPatched) return;
    const original = window.openOrder;
    const patched = async function(orderId) {
      await original(orderId);
      try {
        const o = await window.req('/api/driver/orders/'+encodeURIComponent(orderId));
        if (o.support_updated_at) {
          const banner = document.createElement('div');
          banner.className = 'good';
          banner.style.background = '#fff1a8';
          banner.innerHTML = `<b>⚠ ORDER UPDATED</b><div style="margin-top:5px">Customer support changed this order at ${E(new Date(o.support_updated_at).toLocaleString())}. The address and delivery notes shown below are the current version.</div>`;
          const h = document.querySelector('#detail h2'); if (h) h.insertAdjacentElement('afterend', banner);
        }
        const buttons = document.getElementById('driverStatusActions');
        if (buttons && !document.getElementById('pvOptionalStatus')) {
          const note = document.createElement('div'); note.id='pvOptionalStatus'; note.className='muted'; note.style.marginTop='8px';
          note.textContent='“ON THE WAY” is optional. You can mark the order completed without using it.';
          buttons.insertAdjacentElement('afterend', note);
        }
        if(photoEnabled()){
          const host=document.createElement('div');host.id='pvDriverPhotos';document.getElementById('detail').appendChild(host);await renderPhotos(orderId);
        }
      } catch {}
    };
    patched.__pvSupportPatched = true;
    window.openOrder = patched;
    patchStatus();
  }
  install();
})();

// Accountless returning-customer context. Informational only; it does not change ID/compliance rules.
(() => {
  'use strict';
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const E=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  async function preq(url,opt={}){const r=await fetch(url,{...opt,headers:{'Content-Type':'application/json',...(opt.headers||{})},cache:'no-store'});let j={};try{j=await r.json()}catch{}if(!r.ok)throw Error(j.error||'Request failed');return j;}
  async function renderCustomer(orderId){
    const detail=document.getElementById('detail');if(!detail)return;
    detail.querySelector('#pvCustomerContext')?.remove();
    try{
      const c=await preq(`/api/driver/platform/orders/${encodeURIComponent(orderId)}/customer`);if(!c?.recognized)return;
      const stars=Math.max(0,Math.min(5,Number(c.loyalty_stars)||0)),returning=!!c.returning_customer;
      const host=document.createElement('div');host.id='pvCustomerContext';
      host.innerHTML=`<div class="hr"></div><h3>CUSTOMER CONTEXT</h3>
        <div class="good" style="${returning||stars?'background:#e7f5e7':'background:#f6f6f4'}"><b>${stars?'★'.repeat(stars)+' '+E(c.loyalty_label||'LOYAL CUSTOMER'):returning?'★ RETURNING CUSTOMER':'FIRST RECORDED ORDER'}</b><div style="margin-top:5px">${Number(c.previous_order_count)||0} previous order${Number(c.previous_order_count)===1?'':'s'}. This is just a familiarity heads-up.</div></div>
        ${(c.notes||[]).length?`<div style="margin-top:9px"><b>PREVIOUS CUSTOMER NOTES</b>${(c.notes||[]).slice(0,6).map(n=>`<div class="warn" style="margin-top:7px"><div>${E(n.note)}</div><div class="muted" style="margin-top:4px">${E(n.driver_name||n.created_by_role)} • ${new Date(n.created_at).toLocaleString()}</div></div>`).join('')}</div>`:'<div class="muted" style="margin-top:8px">No previous customer notes.</div>'}
        <div class="field"><label>ADD NOTE FOR NEXT TIME</label><textarea id="pvCustomerNote" placeholder="Example: customer mentioned an issue with the last order"></textarea></div><button class="btn ghost" style="width:100%" id="pvSaveCustomerNote">SAVE CUSTOMER NOTE</button>`;
      detail.appendChild(host);
      document.getElementById('pvSaveCustomerNote').onclick=async()=>{try{const note=document.getElementById('pvCustomerNote').value.trim();if(!note)return alert('Write a short note first.');await preq(`/api/driver/platform/orders/${encodeURIComponent(orderId)}/customer-notes`,{method:'POST',body:JSON.stringify({note})});await renderCustomer(orderId);}catch(e){alert(e.message)}};
    }catch{}
  }
  function patch(){
    if(!window.openOrder||window.openOrder.__pvCustomerContextPatched)return;const original=window.openOrder;
    const wrapped=async function(orderId){const r=await original(orderId);await renderCustomer(orderId);return r;};wrapped.__pvCustomerContextPatched=true;window.openOrder=wrapped;
  }
  async function boot(){for(let i=0;i<100;i++){if(window.openOrder&&window.req)break;await wait(80);}const timer=setInterval(patch,450);patch();window.addEventListener('beforeunload',()=>clearInterval(timer),{once:true});}
  boot();
})();
