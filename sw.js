// Service Worker — অ্যাপ শেল ক্যাশ করে (দ্রুত খোলে), API ডেটা কখনো ক্যাশ করে না
const CACHE = 'ctb-v5';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './maskable-512.png', './apple-touch-icon.png', './my-logo2.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('ctb-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Binance, Supabase, CoinGecko, TradingView, CDN: সরাসরি নেটওয়ার্ক, কখনো ক্যাশ নয়
  if (url.origin !== location.origin) return;
  // নিজের ফাইল (পেজ, app.js, আইকন): ক্যাশ থেকে সাথে সাথে, পেছনে নতুন সংস্করণ নামে (পরের বার থেকে নতুন)
  const key = req.mode === 'navigate' ? './index.html' : req;
  e.respondWith(caches.open(CACHE).then(async c => {
    const cached = await c.match(key);
    const fresh = fetch(req).then(r => { if (r.ok && r.type === 'basic') c.put(key, r.clone()); return r; }).catch(() => null);
    return cached || (await fresh) || Response.error();
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => { for (const c of l) if ('focus' in c) return c.focus(); return clients.openWindow('./'); }));
});
