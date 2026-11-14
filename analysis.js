/* analysis.js — CTB pure analytics (no DOM, no fetch)
   main thread + web worker both use this file.
   Fixes: fund=null neutral (0 pts, not 1), structural:false hard penalty (-15),
   gate.checks includes structural check.
   Trader-process review (round 2): zone-reaction confirmation + range filter. Round 1: HTF-weighted bias + 1h/4h gate, premium/discount gate, ATR stop floor, market-price R:R, stale-break decay (flags in SIG).
   Audit fixes: Node export (require), kzNow(at) for backtests, inp.minReady override,
   partial MTF no longer counts as 'complete data'. */
(function (root) {
'use strict';

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return NaN;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce(function(a, b){ return a + b; }, 0) / period;
  for (let i = period; i < values.length; i++) e = (values[i] - e) * k + e;
  return e;
}

function rsi(closes, p) {
  p = p || 14;
  if (!Array.isArray(closes) || closes.length < p + 1) return 50;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function liqVol(c) {
  const n = c.length - 1; if (n < 30) return { liq: null, vol: null };
  const T = c.map(function(x){ return +x[0]; });
  const O = c.map(function(x){ return +x[1]; });
  const H = c.map(function(x){ return +x[2]; });
  const L = c.map(function(x){ return +x[3]; });
  const C = c.map(function(x){ return +x[4]; });
  const V = c.map(function(x){ return +x[5]; });
  const k = 3, ph = [], pl = [];
  for (let i = k; i < n - k; i++) {
    let a = true, b = true;
    for (let j = 1; j <= k; j++) {
      if (H[i] < H[i - j] || H[i] <= H[i + j]) a = false;
      if (L[i] > L[i - j] || L[i] >= L[i + j]) b = false;
    }
    if (a) ph.push({ i: i, p: H[i] });
    if (b) pl.push({ i: i, p: L[i] });
  }
  const price = C[n - 1];
  const top = function(a){ return Math.max.apply(null, a); };
  const low = function(a){ return Math.min.apply(null, a); };
  const bslC = ph.filter(function(x){ return x.p > price && !H.slice(x.i + 1).some(function(h){ return h > x.p; }); }).sort(function(a, b){ return a.p - b.p; })[0];
  const sslC = pl.filter(function(x){ return x.p < price && !L.slice(x.i + 1).some(function(l){ return l < x.p; }); }).sort(function(a, b){ return b.p - a.p; })[0];
  const sweeps = [];
  for (let j = Math.max(1, n - 3); j <= n - 1; j++) {
    ph.slice(-8).forEach(function(x){
      if (x.i < j && H[j] > x.p && C[j] < x.p && !H.slice(x.i + 1, j).some(function(h){ return h > x.p; }))
        sweeps.push({ type: 'BSL', level: x.p, ago: n - 1 - j, wick: (H[j] - x.p) / x.p * 100, bias: 'bear' });
    });
    pl.slice(-8).forEach(function(x){
      if (x.i < j && L[j] < x.p && C[j] > x.p && !L.slice(x.i + 1, j).some(function(l){ return l < x.p; }))
        sweeps.push({ type: 'SSL', level: x.p, ago: n - 1 - j, wick: (x.p - L[j]) / x.p * 100, bias: 'bull' });
    });
  }
  sweeps.sort(function(a, b){ return a.ago - b.ago || b.wick - a.wick; });
  let turtle = null;
  for (let j = n - 1; j >= Math.max(20, n - 3) && !turtle; j--) {
    const hs = H.slice(j - 20, j), ls = L.slice(j - 20, j);
    const ph0 = top(hs), pl0 = low(ls);
    const hi = j - 20 + hs.indexOf(ph0), li = j - 20 + ls.indexOf(pl0);
    if (H[j] > ph0 && C[j] < ph0 && j - hi >= 4) turtle = { dir: 'bear', level: ph0, ago: n - 1 - j };
    else if (L[j] < pl0 && C[j] > pl0 && j - li >= 4) turtle = { dir: 'bull', level: pl0, ago: n - 1 - j };
  }
  let asia = null;
  if (T[1] - T[0] <= 3600000) {
    const gm = function(t){ const d = new Date(t); return ((d.getUTCHours() + 4) % 24) * 60 + d.getUTCMinutes(); };
    const inA = function(i){ const m = gm(T[i]); return m >= 180 && m < 720; };
    const day = function(i){ return Math.floor((T[i] + 4 * 3600000) / 86400000); };
    const groups = [];
    for (let i = 0; i <= n - 1; i++) if (inA(i)) {
      const g = groups[groups.length - 1];
      if (g && g.day === day(i) && g.end === i - 1) { g.hi = Math.max(g.hi, H[i]); g.lo = Math.min(g.lo, L[i]); g.end = i; }
      else groups.push({ day: day(i), hi: H[i], lo: L[i], start: i, end: i });
    }
    const g = groups.filter(function(x){ return x.end < n - 1 && (!inA(n - 1) || x.day !== day(n - 1)); }).pop();
    if (g) {
      asia = { hi: g.hi, lo: g.lo, sweep: null, ago: null };
      for (let j = g.end + 1; j <= n - 1 && T[j] - T[g.end] <= 16 * 3600000; j++) {
        if (H[j] > g.hi && C[j] < g.hi) { asia.sweep = 'high'; asia.ago = n - 1 - j; break; }
        if (L[j] < g.lo && C[j] > g.lo) { asia.sweep = 'low'; asia.ago = n - 1 - j; break; }
      }
    }
  }
  const avgAt = function(j){ const s = V.slice(Math.max(0, j - 20), j); return s.length ? s.reduce(function(a, b){ return a + b; }, 0) / s.length : 0; };
  const ratioAt = function(j){ const a = avgAt(j); return a > 0 ? V[j] / a : null; };
  const r = ratioAt(n - 1), recent = [];
  for (let j = n - 1; j >= n - 3; j--) { const q = ratioAt(j); if (q !== null && q >= 2) recent.push({ ago: n - 1 - j, ratio: q, dir: C[j] >= O[j] ? 'bull' : 'bear' }); }
  return {
    liq: { bsl: bslC ? bslC.p : null, ssl: sslC ? sslC.p : null, sweeps: sweeps.slice(0, 2), turtle: turtle, asia: asia },
    vol: { ratio: r, avg: avgAt(n - 1), spike: r !== null && r >= 2, dir: C[n - 1] >= O[n - 1] ? 'bull' : 'bear', recent: recent }
  };
}

function smcAnalyze(c) {
  const O = c.map(function(x){ return +x[1]; });
  const H = c.map(function(x){ return +x[2]; });
  const L = c.map(function(x){ return +x[3]; });
  const C = c.map(function(x){ return +x[4]; });
  const n = c.length - 1, k = 3, piv = [];
  for (let i = k; i < n - k; i++) {
    let ph = true, pl = true;
    for (let j = 1; j <= k; j++) {
      if (H[i] < H[i - j] || H[i] <= H[i + j]) ph = false;
      if (L[i] > L[i - j] || L[i] >= L[i + j]) pl = false;
    }
    if (ph) piv.push({ i: i, t: 'H', p: H[i] });
    if (pl) piv.push({ i: i, t: 'L', p: L[i] });
  }
  const hs = piv.filter(function(x){ return x.t === 'H'; });
  const ls = piv.filter(function(x){ return x.t === 'L'; });
  const lh = hs[hs.length - 1], ph = hs[hs.length - 2], ll = ls[ls.length - 1], pl = ls[ls.length - 2];
  let trend = 0;
  if (lh && ph && ll && pl) {
    if (lh.p > ph.p && ll.p > pl.p) trend = 1;
    else if (lh.p < ph.p && ll.p < pl.p) trend = -1;
  }
  const last = C[n - 1]; let event = 'No Break', ob = null, eventAgo = null;
  if (lh && last > lh.p) {
    event = trend === -1 ? 'Bullish CHoCH' : 'Bullish BOS';
    let m = lh.i + 1; while (m < n && C[m] <= lh.p) m++;
    eventAgo = (n - 1) - m;
    for (let i = m - 1; i >= Math.max(0, lh.i - 10); i--) if (C[i] < O[i]) { ob = { dir: 'bull', lo: L[i], hi: H[i] }; break; }
  } else if (ll && last < ll.p) {
    event = trend === 1 ? 'Bearish CHoCH' : 'Bearish BOS';
    let m = ll.i + 1; while (m < n && C[m] >= ll.p) m++;
    eventAgo = (n - 1) - m;
    for (let i = m - 1; i >= Math.max(0, ll.i - 10); i--) if (C[i] > O[i]) { ob = { dir: 'bear', lo: L[i], hi: H[i] }; break; }
  }
  const fvgs = [];
  for (let i = n - 1; i >= Math.max(2, n - 60) && fvgs.length < 3; i--) {
    if (L[i] > H[i - 2]) { if (Math.min.apply(null, L.slice(i + 1, n)) > H[i - 2]) fvgs.push({ dir: 'bull', lo: H[i - 2], hi: L[i] }); }
    else if (H[i] < L[i - 2]) { if (Math.max.apply(null, H.slice(i + 1, n)) < L[i - 2]) fvgs.push({ dir: 'bear', lo: H[i], hi: L[i - 2] }); }
  }
  let fib = null;
  const W = Math.min(50, n);
  const ar = H.slice(-W).reduce(function(t, h, i){ return t + h - L[L.length - W + i]; }, 0) / W;
  for (let i = piv.length - 1; i >= 1 && !fib; i--) {
    const p1 = piv[i];
    for (let j = i - 1; j >= 0; j--) {
      const q = piv[j];
      if (q.t !== p1.t && (p1.t === 'H' ? q.p < p1.p : q.p > p1.p)) {
        const hi = Math.max(p1.p, q.p), lo = Math.min(p1.p, q.p);
        if (hi - lo < ar * 4) continue;
        fib = { bull: p1.t === 'H', hi: hi, lo: lo, d: hi - lo };
        break;
      }
    }
  }
  let atr = null;   // ATR(14) over closed candles (the still-forming last candle is excluded, like the rest of the engine)
  if (n >= 15) { let t = 0; for (let i = n - 14; i <= n - 1; i++) t += Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])); atr = t / 14; }
  // dealing range = last swing low..high (ignored when it is smaller than 1.5 ATR: no meaningful premium/discount)
  const range = (lh && ll && lh.p > ll.p && (atr === null || lh.p - ll.p >= 1.5 * atr)) ? { hi: lh.p, lo: ll.p } : null;
  let er = null;    // Kaufman efficiency ratio over the last 29 closed steps: ~1 = clean trend, ~0 = chop/range
  if (n >= 31) { let path = 0; for (let i = n - 29; i <= n - 1; i++) path += Math.abs(C[i] - C[i - 1]); er = path > 0 ? Math.abs(C[n - 1] - C[n - 30]) / path : 0; }
  const recent = [n - 3, n - 2, n - 1].filter(function(i){ return i >= 0; }).map(function(i){ return { o: O[i], h: H[i], l: L[i], c: C[i] }; });
  const lv = liqVol(c);
  return { trend: trend, event: event, eventAgo: eventAgo, atr: atr, er: er, recent: recent, range: range, ob: ob, fvgs: fvgs, sh: lh && lh.p, sl: ll && ll.p, fib: fib, last: last, liq: lv.liq, vol: lv.vol };
}

function fibPx(f, r) { return f.bull ? f.hi - f.d * r : f.lo + f.d * r; }
function fibExt(f, r) { return f.bull ? f.lo + f.d * r : f.hi - f.d * r; }

function fibState(f, price) {
  const r = f.bull ? (f.hi - price) / f.d : (price - f.lo) / f.d;
  const ote = r >= 0.618 && r <= 0.786;
  const zone = r < 0 ? 'Breakout' : r > 1 ? 'Leg Expired' : ote ? 'OTE Zone' : r > 0.786 ? 'Deep' : r >= 0.5 ? (f.bull ? 'Discount' : 'Premium') : 'Shallow';
  return { r: r, ote: ote, zone: zone, fav: r >= 0.5 && r <= 0.786 };
}

const SIG = { minReady: 70, minWatch: 50, minRR: 1.5, minSlPct: 0.3, maxSlPct: 8, nearPct: 0.4, conflict: 8,
  // trader-process rules (set false/0 to switch one off)
  htfGate: true,          // 1h AND 4h both against the trade -> never READY
  pdGate: true,           // long only in the discount half of the swing range, short only in premium
  pdTol: 0.05,            // tolerance around the 50% equilibrium (fraction of range)
  atrSlMult: 0.8,         // stop is never tighter than 0.8 x ATR(14) of the signal timeframe (0 = off)
  marketRR: true,         // R:R must also hold at the CURRENT price (one-click orders are market orders)
  eventFresh: 20, eventStale: 50,  // BOS/CHoCH older than this many bars loses half / all of its points
  confirmGate: true,      // READY needs a rejection candle that tapped the entry zone and held (reaction, not just proximity)
  rangeGate: true,        // READY needs a trending market: Kaufman efficiency ratio (30 bars) >= minER
  minER: 0.2              // calibrated on synthetic data only: random walk median 0.15, trending median 0.34
};
const SIG_MAX = { mtf: 20, ema: 15, smc: 20, liq: 15, vol: 10, entry: 10, rr: 10 };

// Did price TAP the entry zone and get REJECTED within the last 3 closed candles? (what a trader waits for before entering)
function zoneReaction(side, zone, recent) {
  if (!zone || !recent || !recent.length) return null;           // unknown: caller skips the gate
  const long = side === 'LONG', n = recent.length, last = recent[n - 1];
  if (long ? !(last.c > zone.lo) : !(last.c < zone.hi)) return { ok: false, why: 'last close through the zone' };
  for (let i = n - 1; i >= 0; i--) {
    const k = recent[i], rg = k.h - k.l; if (!(rg > 0)) continue;
    const tapped = long ? k.l <= zone.hi : k.h >= zone.lo;
    const held = long ? k.c > zone.lo : k.c < zone.hi;
    const wick = long ? (Math.min(k.o, k.c) - k.l) / rg : (k.h - Math.max(k.o, k.c)) / rg;                 // rejection wick share
    const body = long ? (k.c > k.o && (k.c - k.l) / rg >= 0.6) : (k.c < k.o && (k.h - k.c) / rg >= 0.6);  // strong close away from the zone
    if (tapped && held && (wick >= 0.5 || body)) return { ok: true, why: (n - 1 - i === 0 ? 'last' : (n - 1 - i) + ' bars ago') + (wick >= 0.5 ? ' wick rejection' : ' strong close') };
  }
  return { ok: false, why: 'no tap + rejection in last 3 bars' };
}

function kzNow(at) {
  const n = at ? new Date(at) : new Date(), m = ((n.getUTCHours() + 4) % 24) * 60 + n.getUTCMinutes();
  return { london: m >= 660 && m < 900, ny: m >= 960 && m < 1200 };
}

function sigPlan(side, inp) {
  const long = side === 'LONG', price = inp.price, smc = inp.smc;
  if (!smc || !(price > 0)) return null;
  const f = smc.fib, ob = smc.ob, liq = smc.liq || {}, zones = [];
  if (ob && ob.dir === (long ? 'bull' : 'bear')) zones.push({ lo: ob.lo, hi: ob.hi, src: 'Order Block' });
  if (f && f.bull === long) { const a = fibPx(f, 0.618), b = fibPx(f, 0.786); zones.push({ lo: Math.min(a, b), hi: Math.max(a, b), src: 'Fib OTE' }); }
  for (let i = 0; i < (smc.fvgs || []).length; i++) {
    const g = smc.fvgs[i];
    if (g.dir === (long ? 'bull' : 'bear')) { zones.push({ lo: g.lo, hi: g.hi, src: 'FVG' }); break; }
  }
  const valid = zones.filter(function(z){ return Number.isFinite(z.lo) && Number.isFinite(z.hi) && (long ? z.lo < price : z.hi > price); }).map(function(z){
    const lo = long ? z.lo : Math.max(z.lo, price), hi = long ? Math.min(z.hi, price) : z.hi;
    const dist = long ? (price - hi) / price * 100 : (lo - price) / price * 100;
    return { src: z.src, lo: Math.min(lo, hi), hi: Math.max(lo, hi), dist: dist };
  }).sort(function(a, b){ return a.dist - b.dist; });
  let zone = valid[0], structural = true;
  if (!zone) { structural = false; zone = { src: 'Current price', lo: long ? price * 0.998 : price, hi: long ? price : price * 1.002, dist: 0 }; }
  const entry = zone.dist === 0 ? price : (zone.lo + zone.hi) / 2;
  const c = [];
  if (long) {
    if (ob && ob.dir === 'bull') c.push(ob.lo);
    (liq.sweeps || []).forEach(function(s){ if (s.type === 'SSL') c.push(s.level); });
    if (smc.sl) c.push(smc.sl);
    if (f && f.bull) c.push(f.lo);
  } else {
    if (ob && ob.dir === 'bear') c.push(ob.hi);
    (liq.sweeps || []).forEach(function(s){ if (s.type === 'BSL') c.push(s.level); });
    if (smc.sh) c.push(smc.sh);
    if (f && !f.bull) c.push(f.hi);
  }
  const out = c.filter(function(x){ return Number.isFinite(x) && (long ? x <= zone.lo : x >= zone.hi); });
  const base = out.length ? (long ? Math.max.apply(null, out) : Math.min.apply(null, out)) : (long ? zone.lo * 0.99 : zone.hi * 1.01);
  let sl = long ? base * (1 - 0.0007) : base * (1 + 0.0007);
  if (Math.abs(entry - sl) / entry < 0.003) sl = long ? entry * (1 - 0.0035) : entry * (1 + 0.0035);
  let atrFloor = false;   // a stop inside normal candle noise gets hunted: never tighter than atrSlMult x ATR
  if (SIG.atrSlMult > 0 && Number.isFinite(smc.atr) && smc.atr > 0 && Math.abs(entry - sl) < SIG.atrSlMult * smc.atr) { sl = long ? entry - SIG.atrSlMult * smc.atr : entry + SIG.atrSlMult * smc.atr; atrFloor = true; }
  const R = Math.abs(entry - sl), slPct = R / entry * 100;
  const t = [];
  if (long) {
    if (liq.bsl) t.push(liq.bsl);
    if (smc.sh) t.push(smc.sh);
    if (f && f.bull) { t.push(fibExt(f, 1.272)); t.push(fibExt(f, 1.618)); }
  } else {
    if (liq.ssl) t.push(liq.ssl);
    if (smc.sl) t.push(smc.sl);
    if (f && !f.bull) { t.push(fibExt(f, 1.272)); t.push(fibExt(f, 1.618)); }
  }
  const lv = t.filter(function(x){ return Number.isFinite(x) && (long ? x > entry + 0.8 * R : x < entry - 0.8 * R); }).sort(function(a, b){ return long ? a - b : b - a; });
  const uq = [];
  for (let i = 0; i < lv.length; i++) if (!uq.length || Math.abs(lv[i] - uq[uq.length - 1]) > 0.3 * R) uq.push(lv[i]);
  const fb = [1.5, 2.5, 4].map(function(m){ return long ? entry + m * R : entry - m * R; });
  const tps = [];
  for (let i = 0; i < 3; i++) {
    let v = uq[i] !== undefined ? uq[i] : fb[i];
    const p = tps[i - 1];
    if (p !== undefined && (long ? v <= p + 0.4 * R : v >= p - 0.4 * R)) v = long ? p + 0.6 * R : p - 0.6 * R;
    tps.push(v);
  }
  const dMkt = Math.abs(price - sl);
  const rng = smc.range, pd = rng && rng.hi > rng.lo ? (entry - rng.lo) / (rng.hi - rng.lo) : null;   // 0 = swing low, 1 = swing high
  return { side: side, zone: zone, structural: structural, entry: entry, sl: sl, R: R, slPct: slPct, tps: tps, rr: tps.map(function(x){ return Math.abs(x - entry) / R; }),
    rrMkt: dMkt > 0 ? Math.abs(tps[1] - price) / dMkt : 0, pd: pd, atrFloor: atrFloor };
}

function sigScore(side, inp, plan) {
  const long = side === 'LONG', s = long ? 1 : -1;
  const smc = inp.smc || {}, liq = smc.liq || {}, vol = smc.vol || {}, e = inp.ema || {}, p = inp.price;
  const P = { mtf: 0, ema: 0, smc: 0, liq: 0, vol: 0, entry: 0, rr: 0 };
  const per = (inp.mtf && inp.mtf.per) || null;
  if (per) {
    const W = { '5m': 2, '15m': 4, '1h': 6, '4h': 8 };   // higher timeframe = bias, so it counts more (sum 20)
    ['5m', '15m', '1h', '4h'].forEach(function(tf){
      const v = per[tf];
      P.mtf += v === (long ? 'Bullish' : 'Bearish') ? W[tf] : v === 'Neutral' ? W[tf] * 0.4 : 0;
    });
    P.mtf = Math.round(P.mtf);
  }
  const chk = function(a, b){ return Number.isFinite(a) && Number.isFinite(b) && (long ? a > b : a < b); };
  P.ema = 3 * [chk(p, e.e9), chk(e.e9, e.e21), chk(e.e21, e.e50), chk(e.e50, e.e200), chk(p, e.e200)].filter(Boolean).length;
  if (smc.trend === s) P.smc += 6;
  const evMul = (smc.eventAgo === null || smc.eventAgo === undefined || smc.eventAgo <= SIG.eventFresh) ? 1 : smc.eventAgo <= SIG.eventStale ? 0.5 : 0;   // an old break is no longer a reason to enter
  if (smc.event === (long ? 'Bullish BOS' : 'Bearish BOS')) P.smc += Math.round(5 * evMul);
  else if (smc.event === (long ? 'Bullish CHoCH' : 'Bearish CHoCH')) P.smc += Math.round(7 * evMul);
  if (smc.ob && smc.ob.dir === (long ? 'bull' : 'bear') && plan && plan.zone.src === 'Order Block') P.smc += 4;
  if ((smc.fvgs || []).some(function(g){ return g.dir === (long ? 'bull' : 'bear') && Math.abs((g.lo + g.hi) / 2 - p) / p < 0.02; })) P.smc += 3;
  const sw = (liq.sweeps || []).find(function(x){ return x.type === (long ? 'SSL' : 'BSL'); });
  if (sw) P.liq += sw.ago <= 1 ? 7 : 5;
  if (liq.turtle && liq.turtle.dir === (long ? 'bull' : 'bear')) P.liq += 4;
  if (liq.asia && liq.asia.sweep === (long ? 'low' : 'high')) P.liq += 4;
  const dirV = long ? 'bull' : 'bear';
  if (vol.spike && vol.dir === dirV) P.vol += 5;
  else if ((vol.recent || []).some(function(x){ return x.dir === dirV; })) P.vol += 3;
  const r = inp.rsi;
  if (Number.isFinite(r)) P.vol += long ? (r >= 45 && r <= 70 ? 3 : r < 30 ? 1 : r > 75 ? 0 : 1) : (r >= 30 && r <= 55 ? 3 : r > 70 ? 1 : r < 25 ? 0 : 1);
  
  const fr = inp.fund && Number.isFinite(inp.fund.rate) ? inp.fund.rate : null;
  if (fr !== null) {
    P.vol += long ? (fr < 0.05 ? 2 : fr < 0.1 ? 1 : 0) : (fr > -0.05 ? 2 : fr > -0.1 ? 1 : 0);
  }
  
  if (smc.fib && smc.fib.bull === long) { const st = fibState(smc.fib, p); P.entry += st.ote ? 5 : st.fav ? 3 : 0; }
  if (plan && plan.structural) P.entry += plan.zone.dist <= 0.4 ? 3 : plan.zone.dist <= 1 ? 1 : 0;
  if (inp.kz && (inp.kz.london || inp.kz.ny)) P.entry += 2;
  if (plan) { const x = plan.rr[1]; P.rr = x >= 3 ? 10 : x >= 2 ? 7 : x >= SIG.minRR ? 4 : 0; }
  for (const k in P) P[k] = Math.min(SIG_MAX[k], P[k]);
  
  let total = Object.keys(P).reduce(function(a, k){ return a + P[k]; }, 0);
  if (plan && !plan.structural) total = Math.max(0, total - 15);
  return { side: side, parts: P, score: total, plan: plan };
}

function computeSignal(inp) {
  const pl = { LONG: sigPlan('LONG', inp), SHORT: sigPlan('SHORT', inp) };
  const L = sigScore('LONG', inp, pl.LONG), S = sigScore('SHORT', inp, pl.SHORT);
  const best = L.score >= S.score ? L : S;
  const conflict = Math.abs(L.score - S.score) < SIG.conflict, notes = [];
  const dir = (best.score >= SIG.minWatch && !conflict && best.plan) ? best.side : null;
  if (conflict && Math.max(L.score, S.score) >= SIG.minWatch) notes.push('LONG/SHORT conflict');
  const out = { symbol: inp.symbol, tf: inp.tf, price: inp.price, dir: dir, score: best.score, long: L, short: S, plan: dir ? best.plan : null, gate: { ok: false, checks: [] }, status: 'WAIT', notes: notes, invalidation: '' };
  const g = out.gate.checks, pn = out.plan, smc = inp.smc;
  if (dir) {
    g.push({ ok: pn.slPct >= SIG.minSlPct && pn.slPct <= SIG.maxSlPct, t: 'SL dist ' + pn.slPct.toFixed(2) + '%' });
    g.push({ ok: pn.rr[1] >= SIG.minRR, t: 'R:R (TP2) 1:' + pn.rr[1].toFixed(2) });
    if (SIG.marketRR) g.push({ ok: pn.rrMkt >= SIG.minRR, t: 'R:R at market price 1:' + pn.rrMkt.toFixed(2) });
    if (SIG.pdGate && pn.pd !== null) {
      const okpd = dir === 'LONG' ? pn.pd <= 0.5 + SIG.pdTol : pn.pd >= 0.5 - SIG.pdTol;
      g.push({ ok: okpd, t: (dir === 'LONG' ? 'Long in discount' : 'Short in premium') + ' (' + Math.round(pn.pd * 100) + '% of swing range)' });
    }
    if (SIG.htfGate && inp.mtf && inp.mtf.per) {
      const opp = dir === 'LONG' ? 'Bearish' : 'Bullish', h1 = inp.mtf.per['1h'], h4 = inp.mtf.per['4h'];
      g.push({ ok: !(h1 === opp && h4 === opp), t: 'HTF bias: 1h+4h not both against' });
    }
    if (SIG.rangeGate && smc && Number.isFinite(smc.er)) g.push({ ok: smc.er >= SIG.minER, t: (smc.er >= SIG.minER ? 'Trending market' : 'Choppy/ranging market') + ' (efficiency ' + smc.er.toFixed(2) + ')' });
    if (SIG.confirmGate && pn.structural) {
      const rx = zoneReaction(dir, pn.zone, smc && smc.recent);
      if (rx) g.push({ ok: rx.ok, t: 'Zone reaction: ' + rx.why });
    }
    if (pn.structural) g.push({ ok: true, t: 'Structural zone (OB/OTE/FVG)' });
    else g.push({ ok: false, t: 'No structural zone — fallback only' });
  } else g.push({ ok: false, t: 'No direction' });
  const fr = inp.fresh || { ok: false, msg: 'no data' };
  g.push({ ok: !!(fr.ok && smc && inp.mtf && inp.mtf.per && !inp.mtf.partial && Number.isFinite(inp.rsi)), t: 'Data fresh & complete' });
  g.push({ ok: !inp.locked, t: inp.locked ? 'Loss Lock active' : 'No lock' });
  out.gate.ok = dir !== null && g.every(function(x){ return x.ok; });
  if (dir) {
    const fr2 = inp.fund && Number.isFinite(inp.fund.rate) ? inp.fund.rate : null;
    if (fr2 !== null && ((dir === 'LONG' && fr2 >= 0.1) || (dir === 'SHORT' && fr2 <= -0.1))) notes.push('Extreme funding');
    const h = inp.mtf && inp.mtf.per && inp.mtf.per['4h'];
    if ((dir === 'LONG' && h === 'Bearish') || (dir === 'SHORT' && h === 'Bullish')) notes.push('4h trend against');
    if (pn.atrFloor) notes.push('SL widened to ATR floor');
    if (pn.zone.dist > 0 && pn.rrMkt < pn.rr[1]) notes.push('Market entry is worse than zone entry (R:R ' + pn.rrMkt.toFixed(2) + ' vs ' + pn.rr[1].toFixed(2) + ')');
    out.invalidation = inp.tf + ' close beyond $' + pn.sl.toFixed(4) + ' invalidates.';
    const minReady = Number.isFinite(+inp.minReady) && +inp.minReady > 0 ? +inp.minReady : SIG.minReady;
    if (best.score >= minReady && out.gate.ok) {
      if (pn.zone.dist <= SIG.nearPct) out.status = 'READY';
      else { out.status = 'WAIT'; notes.push('Entry zone ' + pn.zone.dist.toFixed(2) + '% away'); }
    } else out.status = best.score >= SIG.minWatch ? 'WATCH' : 'WAIT';
  } else out.status = 'WAIT';
  return out;
}

function journalStats(journal, balance) {
  const rows = Array.isArray(journal) ? journal.filter(function(t){ return t && !t.open && Number.isFinite(+t.pnl); }) : [];
  const n = rows.length;
  const wins = rows.filter(function(t){ return +t.pnl > 0; });
  const losses = rows.filter(function(t){ return +t.pnl < 0; });
  const totalPnl = rows.reduce(function(s, t){ return s + (+t.pnl); }, 0);
  const grossWin = wins.reduce(function(s, t){ return s + (+t.pnl); }, 0);
  const grossLoss = Math.abs(losses.reduce(function(s, t){ return s + (+t.pnl); }, 0));
  const winRate = n ? wins.length / n * 100 : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const expectancy = (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss;
  const withR = rows.filter(function(t){ return Number.isFinite(+t.rMultiple) && +t.rMultiple !== 0; });
  const avgR = withR.length ? withR.reduce(function(s, t){ return s + (+t.rMultiple); }, 0) / withR.length : null;
  let peak = 0, maxDD = 0, ddPct = 0;
  const curve = [];
  const sorted = rows.slice().sort(function(a, b){ return String(a.date || '').localeCompare(String(b.date || '')); });
  let eq = 0;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    eq += (+t.pnl);
    curve.push({ date: t.date, eq: eq });
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
    if (balance > 0 && (dd / balance) * 100 > ddPct) ddPct = (dd / balance) * 100;
  }
  let streak = 0, maxStreak = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (+sorted[i].pnl < 0) { streak++; if (streak > maxStreak) maxStreak = streak; }
    else streak = 0;
  }
  const bySetup = {}, bySession = {}, bySymbol = {};
  rows.forEach(function(t){
    const k1 = String(t.setup || 'untagged'), k2 = String(t.session || 'unspecified'), k3 = String(t.symbol || '?');
    if (!bySetup[k1]) bySetup[k1] = { n: 0, wins: 0, pnl: 0 }; bySetup[k1].n++; bySetup[k1].pnl += +t.pnl; if (+t.pnl > 0) bySetup[k1].wins++;
    if (!bySession[k2]) bySession[k2] = { n: 0, wins: 0, pnl: 0 }; bySession[k2].n++; bySession[k2].pnl += +t.pnl; if (+t.pnl > 0) bySession[k2].wins++;
    if (!bySymbol[k3]) bySymbol[k3] = { n: 0, wins: 0, pnl: 0 }; bySymbol[k3].n++; bySymbol[k3].pnl += +t.pnl; if (+t.pnl > 0) bySymbol[k3].wins++;
  });
  return { n: n, wins: wins.length, losses: losses.length, winRate: winRate, totalPnl: totalPnl, avgWin: avgWin, avgLoss: avgLoss, profitFactor: profitFactor, expectancy: expectancy, avgR: avgR, maxDD: maxDD, maxDDpct: ddPct, maxLossStreak: maxStreak, equityCurve: curve, bySetup: bySetup, bySession: bySession, bySymbol: bySymbol };
}

const SECTORS = {
  BTCUSDT: 'btc', ETHUSDT: 'eth',
  SOLUSDT: 'l1', AVAXUSDT: 'l1', NEARUSDT: 'l1', ADAUSDT: 'l1', DOTUSDT: 'l1', ATOMUSDT: 'l1', APTUSDT: 'l1', SUIUSDT: 'l1', SEIUSDT: 'l1', TIAUSDT: 'l1',
  DOGEUSDT: 'meme', SHIBUSDT: 'meme', PEPEUSDT: 'meme', WIFUSDT: 'meme', BONKUSDT: 'meme',
  UNIUSDT: 'defi', AAVEUSDT: 'defi', LINKUSDT: 'defi', MKRUSDT: 'defi', CRVUSDT: 'defi',
  BNBUSDT: 'bnb', XRPUSDT: 'xrp'
};
function sectorOf(sym) { return SECTORS[String(sym).toUpperCase()] || 'other'; }
function correlationBlock(symbol, openSymbols) {
  const sec = sectorOf(symbol);
  if (sec === 'other' || sec === 'btc' || sec === 'eth') return { ok: true };
  const clash = (openSymbols || []).find(function(s){ return s !== symbol && sectorOf(s) === sec; });
  if (clash) return { ok: false, msg: symbol + ' & ' + clash + ' same sector (' + sec + ')' };
  return { ok: true };
}

const api = {
  ema: ema, rsi: rsi, liqVol: liqVol, smcAnalyze: smcAnalyze,
  fibPx: fibPx, fibExt: fibExt, fibState: fibState,
  SIG: SIG, SIG_MAX: SIG_MAX, kzNow: kzNow,
  sigPlan: sigPlan, sigScore: sigScore, computeSignal: computeSignal,
  journalStats: journalStats, sectorOf: sectorOf, correlationBlock: correlationBlock
};
root.CTB = api;
if (typeof self !== 'undefined') self.CTB = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
