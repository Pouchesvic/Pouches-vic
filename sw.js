self.addEventListener('install',event=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));

self.addEventListener('push',event=>{
  let data={};
  try{data=event.data?event.data.json():{}}catch{data={body:event.data?event.data.text():'New order'}};
  if(data.type==='dismiss'){
    event.waitUntil(self.registration.getNotifications({tag:data.tag||`pouchesvic-order-${data.order_id||''}`}).then(list=>list.forEach(n=>n.close())));
    return;
  }
  const title=data.title||'New Pouches Vic Order';
  const options={
    body:data.body||'A new order was assigned to you.',
    tag:data.order_id?`pouchesvic-order-${data.order_id}`:'pouchesvic-order',
    renotify:true,
    requireInteraction:true,
    vibrate:[250,100,250,100,400],
    data:{url:data.url||'/driver',order_id:data.order_id||''}
  };
  event.waitUntil(self.registration.showNotification(title,options));
});

self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const url=new URL(event.notification.data?.url||'/driver',self.location.origin).href;
  event.waitUntil((async()=>{
    const list=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of list){
      if('focus'in client){
        await client.navigate(url);
        return client.focus();
      }
    }
    if(self.clients.openWindow)return self.clients.openWindow(url);
  })());
});
