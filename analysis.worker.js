/* analysis.worker.js — runs Signal Engine on symbols.
   Supports Binance + Bybit. Fetches funding, verifies freshness, tags roundId.
   Uses analysis.js via importScripts. Sends results back to main thread. */
'use strict';
importScripts('./analysis.js');
const C = self.CTB;

const BYBIT_TF = { '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };

// TF interval in ms (for freshness check)
const TF_MS = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000
};

// ---------- Klines (Binance + Bybit) ----------
async function fetchKlines(symbol, tf, limit, ex) {
  ex = ex || 'binance';
  if (ex === 'bybit') {
    const iv = BYBIT_TF[tf];
    if (!iv) throw new Error('bybit interval: ' + tf);
    const url = 'https://api.bybit.com/v5/market/kline?category=linear&symbol=' + encodeURIComponent(symbol) + '&interval=' + iv + '&limit=' + (limit || 300);
    const r = await fetch(url);
    if (!r.ok) throw new Error('bybit klines HTTP ' + r.status);
    const j = await r.json();
    if (j.retCode !== 0 || !j.result || !Array.isArray(j.result.list) || !j.result.list.length) throw new Error('bybit klines empty');
    // Bybit returns newest-first; reverse to oldest-first + normalize to Binance-like [t,o,h,l,c,v]
    return j.result.list.slice().reverse().map(function(c){ return [+c[0], c[1], c[2], c[3], c[4], c[5]]; });
  }
  const url = 'https://fapi.binance.com/fapi/v1/klines?symbol=' + encodeURIComponent(symbol) + '&interval=' + tf + '&limit=' + (limit || 300);
  const r = await fetch(url);
  if (!r.ok) throw new Error('binance klines HTTP ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j) || j.length < 60) throw new Error('not enough candles');
  return j;
}

// ---------- Funding ----------
async function fetchFunding(symbol, ex) {
  ex = ex || 'binance';
  try {
    if (ex === 'bybit') {
      const url = 'https://api.bybit.com/v5/market/tickers?category=linear&symbol=' + encodeURIComponent(symbol);
      const r = await fetch(url);
      if (!r.ok) return null;
      const j = await r.json();
      if (j.retCode !== 0 || !j.result || !j.result.list || !j.result.list[0]) return null;
      const d = j.result.list[0];
      const rate = +d.fundingRate;
      if (!Number.isFinite(rate)) return null;
      const hours = +d.fundingIntervalHour || 8;
      // Normalize to 8h equivalent for consistent scoring
      return { rate: rate * (8 / hours) * 100, raw: rate * 100, hours: hours };
    }
    const url = 'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=' + encodeURIComponent(symbol);
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const rate = +j.lastFundingRate;
    if (!Number.isFinite(rate)) return null;
    return { rate: rate * 100, raw: rate * 100, hours: 8 };
  } catch (e) { return null; }
}

// ---------- MTF ----------
async function fetchMtf(symbol, ex) {
  const tfs = ['5m', '15m', '1h', '4h'];
  const results = await Promise.allSettled(tfs.map(function(tf){
    return fetchKlines(symbol, tf, 100, ex).then(function(c){ return { tf: tf, closes: c.map(function(x){ return +x[4]; }) }; });
  }));
  const per = {};
  let partial = false;
  for (let i = 0; i < tfs.length; i++) {
    const tf = tfs[i], r = results[i];
    if (r.status !== 'fulfilled') { per[tf] = 'Neutral'; partial = true; continue; }
    const closes = r.value.closes;
    if (!closes || closes.length < 22) { per[tf] = 'Neutral'; partial = true; continue; }
    const e9 = C.ema(closes, 9), e21 = C.ema(closes, 21), p = closes[closes.length - 1];
    per[tf] = (p > e9 && e9 > e21) ? 'Bullish' : (p < e9 && e9 < e21) ? 'Bearish' : 'Neutral';
  }
  return { per: per, sym: symbol, partial: partial };
}

// ---------- Freshness check ----------
function checkFreshness(candles, tf) {
  if (!Array.isArray(candles) || !candles.length) return { ok: false, msg: 'no candles' };
  const lastT = +candles[candles.length - 1][0];
  const tfMs = TF_MS[tf] || 15 * 60 * 1000;
  const age = Date.now() - lastT;
  const maxAge = 2.2 * tfMs;
  if (age > maxAge) {
    return { ok: false, msg: 'last candle ' + Math.round(age / 60000) + 'm old (max ' + Math.round(maxAge / 60000) + 'm)' };
  }
  return { ok: true };
}

// ---------- Process one symbol ----------
async function processOne(symbol, tf, ex, roundId, minScore) {
  ex = ex || 'binance';

  const candles = await fetchKlines(symbol, tf, 300, ex);
  if (!Array.isArray(candles) || candles.length < 60) throw new Error('not enough candles');

  const closes = candles.map(function(x){ return +x[4]; });
  const smc = C.smcAnalyze(candles);
  const price = closes[closes.length - 1];

  // MTF (best-effort)
  let mtf = null;
  try { mtf = await fetchMtf(symbol, ex); } catch (e) { mtf = null; }

  // Funding (best-effort)
  let fund = null;
  try { fund = await fetchFunding(symbol, ex); } catch (e) { fund = null; }

  // Freshness
  const fresh = checkFreshness(candles, tf);

  const inp = {
    symbol: symbol,
    tf: tf,
    price: price,
    ema: { e9: C.ema(closes, 9), e21: C.ema(closes, 21), e50: C.ema(closes, 50), e200: C.ema(closes, 200) },
    rsi: C.rsi(closes),
    smc: smc,
    mtf: mtf,
    fund: fund,
    kz: C.kzNow(),
    fresh: fresh,
    locked: false
  };

  const sig = C.computeSignal(inp);

  // Apply user min-score filter — even if signal scores >= minWatch, downgrade if below minScore
  let status = sig.status;
  if (minScore && sig.score < minScore) {
    if (status === 'READY') status = 'WATCH';
    if (status === 'WATCH' && sig.score < Math.max(40, minScore - 15)) status = 'WAIT';
  }

  return {
    ok: true,
    roundId: roundId,
    symbol: symbol,
    tf: tf,
    ex: ex,
    price: price,
    score: sig.score,
    dir: sig.dir,
    status: status,
    plan: sig.plan,
    notes: sig.notes,
    event: smc.event,
    mtf: mtf ? mtf.per : null,
    mtfPartial: mtf ? !!mtf.partial : true,
    fund: fund ? { rate: fund.rate } : null,
    fresh: fresh,
    gate: sig.gate
  };
}

self.onmessage = async function(e) {
  const data = e.data || {};
  const id = data.id;
  const symbol = data.symbol;
  const tf = data.tf;
  const ex = data.ex || 'binance';
  const roundId = data.roundId || '';
  const minScore = data.minScore || 0;
  try {
    const res = await processOne(symbol, tf, ex, roundId, minScore);
    res.id = id;
    self.postMessage(res);
  } catch (err) {
    self.postMessage({ id: id, roundId: roundId, symbol: symbol, tf: tf, ex: ex, ok: false, err: String((err && err.message) || err) });
  }
};
