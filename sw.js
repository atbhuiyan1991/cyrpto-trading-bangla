// Service Worker — অ্যাপ শেল ক্যাশ করে, API ডেটা কখনো ক্যাশ করে না
// Audit fixes:
//  - addAll() is all-or-nothing: one missing file (e.g. wrong worker name) meant NOTHING was cached
//    and the .catch hid it. Now every file is cached individually.
//  - Worker file name: app.js tries analysis.worker.js then analysis_worker.js — both handled.
//  - Version skew: only analysis.js/worker were network-first while app.js/backtest.js/index.html were
//    stale-while-revalidate, so a new analysis.js could run with an old app.js. All code is network-first now.
//  - Background cache writes are wrapped in waitUntil so the browser cannot kill them half-way.
const CACHE = 'ctb-v7';
const SHELL = [
  './',
  './index.html',
  './analysis.js',
  './analysis.worker.js',
  './analysis_worker.js',
  './backtest.js',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './maskable-512.png',
  './apple-touch-icon.png',
  './favicon-64.png',
  './my-logo2.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))   // a missing file no longer blocks the rest
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith('ctb-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const isCode = (req, url) => req.mode === 'navigate' || /\.(?:js|html)$/.test(url.pathname) || url.pathname.endsWith('/');

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Binance, Bybit, Supabase, CoinGecko, TradingView, CDN → সরাসরি নেটওয়ার্ক, কখনো ক্যাশ নয়
  if (url.origin !== location.origin) return;

  // কোড (পেজ, JS, worker): network-first — সব ফাইল একই সংস্করণের থাকে; অফলাইনে ক্যাশ
  if (isCode(req, url)) {
    const key = req.mode === 'navigate' ? './index.html' : req;
    e.respondWith(
      fetch(req).then(r => {
        if (r.ok && r.type === 'basic') {
          const clone = r.clone();
          e.waitUntil(caches.open(CACHE).then(c => c.put(key, clone)));
        }
        return r;
      }).catch(() => caches.match(key).then(c => c || Response.error()))
    );
    return;
  }

  // আইকন, manifest, ছবি: ক্যাশ থেকে সাথে সাথে, পেছনে নতুন সংস্করণ নামে
  e.respondWith(
    caches.open(CACHE).then(async c => {
      const cached = await c.match(req);
      const fresh = fetch(req)
        .then(r => { if (r.ok && r.type === 'basic') { const clone = r.clone(); e.waitUntil(c.put(req, clone)); } return r; })
        .catch(() => null);
      return cached || (await fresh) || Response.error();
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => {
      for (const c of l) if ('focus' in c) return c.focus();
      return clients.openWindow('./');
    })
  );
});
