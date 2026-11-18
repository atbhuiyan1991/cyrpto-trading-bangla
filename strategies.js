/* strategies.js — simple, cost-aware intraday rule families for the Strategy Lab.
   Each rule only looks at CLOSED bars up to bar i and returns 'LONG' | 'SHORT' | null.
   Stops/targets are ATR multiples (so 1R is always comparable across coins and timeframes). */
'use strict';
(function (root) {
function features(raw) {
  const n = raw.length, F = { atr: [], e20: [], e50: [], e200: [], rsi: [], bbm: [], bbs: [], bbp: [], dh20: [], dl20: [], dh10: [], dl10: [], vr: [], ret24: [] };
  const NaNs = function(a){ for (let i = 0; i < n; i++) a.push(NaN); };
  Object.keys(F).forEach(function(k){ NaNs(F[k]); });
  const c = raw.map(function(x){ return x.c; }), h = raw.map(function(x){ return x.h; }), l = raw.map(function(x){ return x.l; }), v = raw.map(function(x){ return x.v; });
  // ATR(14) Wilder
  const tr = [0]; for (let i = 1; i < n; i++) tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  if (n > 14) { let a = 0; for (let i = 1; i <= 14; i++) a += tr[i]; a /= 14; F.atr[14] = a; for (let i = 15; i < n; i++) { a = (a * 13 + tr[i]) / 14; F.atr[i] = a; } }
  const ema = function(p, out) { if (n < p) return; let e = 0; for (let i = 0; i < p; i++) e += c[i]; e /= p; out[p - 1] = e; const k = 2 / (p + 1); for (let i = p; i < n; i++) { e = (c[i] - e) * k + e; out[i] = e; } };
  ema(20, F.e20); ema(50, F.e50); ema(200, F.e200);
  // RSI(14) Wilder
  if (n > 14) { let g = 0, ls = 0; for (let i = 1; i <= 14; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else ls -= d; } g /= 14; ls /= 14; F.rsi[14] = ls === 0 ? 100 : 100 - 100 / (1 + g / ls);
    for (let i = 15; i < n; i++) { const d = c[i] - c[i - 1]; g = (g * 13 + Math.max(d, 0)) / 14; ls = (ls * 13 + Math.max(-d, 0)) / 14; F.rsi[i] = ls === 0 ? 100 : 100 - 100 / (1 + g / ls); } }
  // Bollinger(20,2) mid/std, width percentile over the previous 100 bars, Donchian (previous N bars, excluding the current one), volume ratio, 24-bar move
  const bbw = [];
  for (let i = 0; i < n; i++) bbw.push(NaN);
  for (let i = 19; i < n; i++) { let s = 0; for (let j = i - 19; j <= i; j++) s += c[j]; const m = s / 20; let q = 0; for (let j = i - 19; j <= i; j++) q += (c[j] - m) * (c[j] - m); const sd = Math.sqrt(q / 20); F.bbm[i] = m; F.bbs[i] = sd; bbw[i] = m > 0 ? 4 * sd / m : NaN; }
  for (let i = 119; i < n; i++) { let cnt = 0, tot = 0; for (let j = i - 100; j < i; j++) if (Number.isFinite(bbw[j])) { tot++; if (bbw[j] < bbw[i]) cnt++; } F.bbp[i] = tot ? cnt / tot : NaN; }
  for (let i = 20; i < n; i++) { let hi = -Infinity, lo = Infinity; for (let j = i - 20; j < i; j++) { if (h[j] > hi) hi = h[j]; if (l[j] < lo) lo = l[j]; } F.dh20[i] = hi; F.dl20[i] = lo; let s = 0; for (let j = i - 20; j < i; j++) s += v[j]; F.vr[i] = s > 0 ? v[i] / (s / 20) : NaN; }
  for (let i = 10; i < n; i++) { let hi = -Infinity, lo = Infinity; for (let j = i - 10; j < i; j++) { if (h[j] > hi) hi = h[j]; if (l[j] < lo) lo = l[j]; } F.dh10[i] = hi; F.dl10[i] = lo; }
  for (let i = 24; i < n; i++) F.ret24[i] = c[i] - c[i - 24];
  return F;
}
const LIST = [
  { id: 'mom_don20', name: 'Donchian-20 ব্রেকআউট (ট্রেন্ড-অনুসরণ)', sl: 1.5, tp: 3,
    fn: function(i, F, c){ return c[i].c > F.dh20[i] ? 'LONG' : c[i].c < F.dl20[i] ? 'SHORT' : null; } },
  { id: 'bb_rev', name: 'Bollinger ±২σ রিভার্সন', sl: 1.5, tp: 1.5,
    fn: function(i, F, c){ const z = (c[i].c - F.bbm[i]) / F.bbs[i]; return (z <= -2 && F.rsi[i] < 30) ? 'LONG' : (z >= 2 && F.rsi[i] > 70) ? 'SHORT' : null; } },
  { id: 'ema_pull', name: 'EMA-পুলব্যাক (ট্রেন্ডে ফেরা)', sl: 1.5, tp: 3,
    fn: function(i, F, c){
      if (F.e20[i] > F.e50[i] && F.e50[i] > F.e200[i] && c[i].l <= F.e20[i] && c[i].c > F.e20[i] && c[i].c > c[i].o) return 'LONG';
      if (F.e20[i] < F.e50[i] && F.e50[i] < F.e200[i] && c[i].h >= F.e20[i] && c[i].c < F.e20[i] && c[i].c < c[i].o) return 'SHORT';
      return null; } },
  { id: 'squeeze', name: 'স্কুইজ ব্রেকআউট', sl: 1.5, tp: 3,
    fn: function(i, F, c){ if (!(F.bbp[i] <= 0.15)) return null; return c[i].c > F.dh10[i] ? 'LONG' : c[i].c < F.dl10[i] ? 'SHORT' : null; } },
  { id: 'sweep_rev', name: 'লিকুইডিটি সুইপ রিভার্সাল', sl: 1.2, tp: 2.4,
    fn: function(i, F, c){ return (c[i].l < F.dl20[i] && c[i].c > F.dl20[i]) ? 'LONG' : (c[i].h > F.dh20[i] && c[i].c < F.dh20[i]) ? 'SHORT' : null; } },
  { id: 'vol_climax', name: 'ভলিউম-ক্লাইম্যাক্স রিভার্সাল', sl: 1.5, tp: 1.5,
    fn: function(i, F, c){ const mv = (c[i].c - c[i].o) / F.atr[i]; return (F.vr[i] >= 3 && mv <= -1.5) ? 'LONG' : (F.vr[i] >= 3 && mv >= 1.5) ? 'SHORT' : null; } },
  { id: 'tsmom', name: 'মোমেন্টাম + EMA200 ফিল্টার', sl: 2, tp: 4,
    fn: function(i, F, c){ const m = F.ret24[i] / F.atr[i]; return (c[i].c > F.e200[i] && m >= 4) ? 'LONG' : (c[i].c < F.e200[i] && m <= -4) ? 'SHORT' : null; } }
];
root.CTBStrat = { features: features, LIST: LIST, WARMUP: 220 };
if (typeof module !== 'undefined' && module.exports) module.exports = root.CTBStrat;
})(typeof self !== 'undefined' ? self : this);
