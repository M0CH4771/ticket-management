/* Notification-only worker: never caches pages or spreadsheet data. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{
  let payload={};try{payload=event.data?.json()||{}}catch(e){}
  const data=payload.data||payload.notification||{};
  event.waitUntil(self.registration.showNotification(data.title||'Ticket Management',{
    body:data.body||'イベントのお知らせがあります。',
    icon:new URL('icons/icon-192.png',self.registration.scope).href,
    tag:data.tag||'ticket-management',renotify:false,
    data:{url:self.registration.scope}
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const url=self.registration.scope;
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(client=>client.url.startsWith(url));
    if(existing)return existing.focus();
    return self.clients.openWindow(url);
  })());
});
