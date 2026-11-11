/* analysis.worker.js — runs Signal Engine on symbols
   Uses analysis.js via importScripts. Sends results back to main thread. */
'use strict';
importScripts('./analysis.js');
const C = self.CTB;

async function fetchKlines(symbol, tf, limit) {
  const r = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=' + encodeURIComponent(symbol) + '&interval=' + tf + '&limit=' + (limit || 300));
  if (!r.ok) throw new Error('klines HTTP ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j) || j.length < 60) throw new Error('not enough candles');
  return j;
}

async function fetchMtf(symbol) {
  const tfs = ['5m', '15m', '1h', '4h'];
  const results = await Promise.allSettled(tfs.map(function(tf){
    return fetchKlines(symbol, tf, 100).then(function(c){ return { tf: tf, closes: c.map(function(x){ return +x[4]; }) }; });
  }));
  const per = {};
  for (let i = 0; i < tfs.length; i++) {
    const tf = tfs[i], r = results[i];
    if (r.status !== 'fulfilled') { per[tf] = 'Neutral'; continue; }
    const closes = r.value.closes;
    const e9 = C.ema(closes, 9), e21 = C.ema(closes, 21), p = closes[closes.length - 1];
    per[tf] = (p > e9 && e9 > e21) ? 'Bullish' : (p < e9 && e9 < e21) ? 'Bearish' : 'Neutral';
  }
  return { per: per, sym: symbol };
}

async function processOne(symbol, tf) {
  const candles = await fetchKlines(symbol, tf, 300);
  const closes = candles.map(function(x){ return +x[4]; });
  const smc = C.smcAnalyze(candles);
  const price = closes[closes.length - 1];
  let mtf = null;
  try { mtf = await fetchMtf(symbol); } catch (e) { mtf = null; }
  const fresh = { ok: true };
  const inp = {
    symbol: symbol,
    tf: tf,
    price: price,
    ema: { e9: C.ema(closes, 9), e21: C.ema(closes, 21), e50: C.ema(closes, 50), e200: C.ema(closes, 200) },
    rsi: C.rsi(closes),
    smc: smc,
    mtf: mtf,
    fund: null,
    kz: C.kzNow(),
    fresh: fresh,
    locked: false
  };
  const sig = C.computeSignal(inp);
  return {
    ok: true,
    symbol: symbol,
    tf: tf,
    price: price,
    score: sig.score,
    dir: sig.dir,
    status: sig.status,
    plan: sig.plan,
    notes: sig.notes,
    event: smc.event,
    mtf: mtf ? mtf.per : null
  };
}

self.onmessage = async function(e) {
  const data = e.data || {};
  const id = data.id, symbol = data.symbol, tf = data.tf;
  try {
    const res = await processOne(symbol, tf);
    res.id = id;
    self.postMessage(res);
  } catch (err) {
    self.postMessage({ id: id, symbol: symbol, tf: tf, ok: false, err: String((err && err.message) || err) });
  }
};
