/* Chatgram service worker: push notifications + PWA install */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // network-only (install-able PWA er jonno)

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Chatgram', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    if (d.t === 'callend') {
      const l = await self.registration.getNotifications({ tag: 'call' }); l.forEach(n => n.close());
      return self.registration.showNotification('Missed call', { body: 'Apni ekta call miss korechen', tag: 'missed', icon: '/icon-192.png', badge: '/icon-192.png' });
    }
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (d.t === 'msg' && clients.some(c => c.visibilityState === 'visible')) return;
    const isCall = d.t === 'call';
    await self.registration.showNotification(d.title || 'Chatgram', {
      body: d.body || '', tag: d.tag || 'chatgram', icon: '/icon-192.png', badge: '/icon-192.png', renotify: true,
      requireInteraction: isCall, vibrate: isCall ? [300, 150, 300, 150, 300, 150, 300] : [120],
      data: { t: d.t, room: d.room, from: d.from, callId: d.callId }
    });
  })());
});

self.addEventListener('notificationclick', e => {
  const data = e.notification.data || {}; e.notification.close();
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    let c = list.find(x => 'focus' in x);
    if (c) { await c.focus(); } else c = await self.clients.openWindow('/');
    if (c && c.postMessage) c.postMessage(data.t === 'call' ? { type: 'call' } : { type: 'open', room: data.room });
  })());
});
