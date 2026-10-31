// Service Worker — অ্যাপ শেল ক্যাশ করে (দ্রুত খোলে), API ডেটা কখনো ক্যাশ করে না
const CACHE = 'ctb-v4';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './maskable-512.png', './apple-touch-icon.png', './my-logo2.png'];

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
  // পেজ: ক্যাশ থেকে সাথে সাথে খোলে, পেছনে নতুন সংস্করণ নামিয়ে রাখে (পরের বার থেকে নতুন)
  if (req.mode === 'navigate') {
    e.respondWith(caches.open(CACHE).then(async c => {
      const cached = await c.match('./index.html');
      const fresh = fetch(req).then(r => { if (r.ok) c.put('./index.html', r.clone()); return r; }).catch(() => null);
      return cached || (await fresh) || Response.error();
    }));
    return;
  }
  e.respondWith(caches.match(req).then(h => h || fetch(req).then(r => { if (r.ok && r.type === 'basic') { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return r; })));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => { for (const c of l) if ('focus' in c) return c.focus(); return clients.openWindow('./'); }));
});
