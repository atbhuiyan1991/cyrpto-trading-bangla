// Service Worker — অ্যাপ শেল ক্যাশ করে, API ডেটা কখনো ক্যাশ করে না
const CACHE = 'ctb-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './my-logo2.png'];

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
  // Supabase লাইব্রেরি (নির্দিষ্ট সংস্করণ, বদলায় না): অফলাইনেও লগইন UI চালু রাখতে ক্যাশ
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.match(req).then(h => h || fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return r; })));
    return;
  }
  // Binance, Supabase, CoinGecko, TradingView ইত্যাদি: সরাসরি নেটওয়ার্ক, কখনো ক্যাশ নয়
  if (url.origin !== location.origin) return;
  // পেজ: আগে নেটওয়ার্ক (সর্বশেষ সংস্করণ), না পেলে ক্যাশ
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', cp)); return r; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then(h => h || fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); } return r; })));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => { for (const c of l) if ('focus' in c) return c.focus(); return clients.openWindow('./'); }));
});
