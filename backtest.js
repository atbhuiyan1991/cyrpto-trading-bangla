/* backtest.js — walk-forward backtest using analysis.js Signal Engine.
   Input: klines (raw Binance array OR objects {t,o,h,l,c,v}). Drop the still-forming last candle before calling.
   Earlier fixes kept:
   - Market entry uses next bar OPEN + slippage; same bar SL wins over TP (conservative)
   - Partial TP1 fee accounted separately; Max DD peak starts at startBalance
   Audit fixes (this version):
   - smcAnalyze() was fed {t,o,h,l,c,v} objects -> every value NaN -> 0 trades ever. Now fed [t,o,h,l,c,v] rows.
   - Entry bar is now simulated (market: from the open; limit: stop-loss check only). Skipping it hid
     stop-outs that happen inside the entry bar (optimistic bias).
   - Gap guards: skip if entry already beyond SL or TP1 (R used to be abs() of a wrong-side distance).
   - buildMtf: step sizes were mixed units (5m/15m in 5m-units, 1h/4h in 15m-units), sampled from the
     oldest bar (stale), and 4h was always Neutral on a 300-bar window. Now minute-based, sampled from
     the newest bar, with a longer close history.
   - TP3 branch was unreachable (TP3 hit implies TP2 hit). Plan is explicit now: 50% @TP1 -> SL to BE -> rest @TP2.
   - Limit ('zone') orders expire after entryExpiryBars (default 30) instead of waiting forever.
   - Kill-zone points now computed from the bar time (live engine gets them, backtest used to get 0).
   - minScore really is the READY threshold (was stuck at >=70 because status had to be READY first).
   - Max DD % is relative to the equity peak (was relative to start balance). */
'use strict';
(function (root) {
const C = root.CTB || (typeof require === 'function' ? require('./analysis.js') : null);
const TF_MIN = { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };

function klinesToCandles(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const first = raw[0];
  if (Array.isArray(first)) {
    return raw.map(function(k){ return { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }; });
  }
  return raw.map(function(k){ return { t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }; });
}

// Approximate 4-TF MTF snapshot by down-sampling closes (newest bar first, so the "current" higher-TF
// candle closes at the current price — same as the live view). TFs lower than the base TF fall back to base.
function buildMtf(closes, tf) {
  const per = {};
  const base = TF_MIN[tf] || 15;
  ['5m', '15m', '1h', '4h'].forEach(function(key) {
    const step = Math.max(1, Math.round(TF_MIN[key] / base));
    const sampled = [];
    for (let i = closes.length - 1; i >= 0; i -= step) sampled.push(closes[i]);
    sampled.reverse();
    if (sampled.length < 22) { per[key] = 'Neutral'; return; }
    const e9 = C.ema(sampled, 9), e21 = C.ema(sampled, 21);
    const p = sampled[sampled.length - 1];
    per[key] = (p > e9 && e9 > e21) ? 'Bullish' : (p < e9 && e9 < e21) ? 'Bearish' : 'Neutral';
  });
  return { per: per };
}

function runBacktest(candles, cfg) {
  cfg = cfg || {};
  const num = function(v, d){ return (v !== undefined && v !== null && v !== '' && Number.isFinite(+v)) ? +v : d; };
  const config = {
    tf: cfg.tf || '15m',
    symbol: cfg.symbol || 'BACKTEST',
    feePct: num(cfg.feePct, 0.05),
    riskPct: num(cfg.riskPct, 1),
    minScore: num(cfg.minScore, 55),
    maxBarsInTrade: num(cfg.maxBarsInTrade, 100),
    entryExpiryBars: num(cfg.entryExpiryBars, 30),
    entryMode: cfg.entryMode === 'zone' ? 'zone' : 'market',
    balance: num(cfg.balance, 1000),
    slippagePct: num(cfg.slippagePct, 0.02),
    conservative: cfg.conservative !== false
  };

  const raw = klinesToCandles(candles);
  if (raw.length < 250) return { error: 'Not enough candles (250+ required)' };
  if (!C || !C.smcAnalyze || !C.computeSignal) return { error: 'analysis.js not loaded' };
  if (!(config.balance > 0) || !(config.riskPct > 0) || config.feePct < 0) return { error: 'Invalid balance / risk / fee' };

  const rows = raw.map(function(k){ return [k.t, k.o, k.h, k.l, k.c, k.v]; });   // analysis.js expects arrays
  const allCloses = raw.map(function(k){ return k.c; });
  const tfMs = (TF_MIN[config.tf] || 15) * 60000;

  let balance = config.balance;
  const trades = [];
  const warmup = 200;
  const eqCurve = [{ i: 0, eq: balance }];
  const fee = config.feePct / 100;
  const slip = config.slippagePct / 100;

  for (let i = warmup; i < raw.length - 1; i++) {
    const from = Math.max(0, i - 299);
    const win = rows.slice(from, i + 1);
    if (win.length < 60) continue;

    const closes = allCloses.slice(from, i + 1);
    const smc = C.smcAnalyze(win);
    const price = closes[closes.length - 1];
    const mtf = buildMtf(allCloses.slice(Math.max(0, i - 1199), i + 1), config.tf);

    const inp = {
      symbol: config.symbol,
      tf: config.tf,
      price: price,
      ema: { e9: C.ema(closes, 9), e21: C.ema(closes, 21), e50: C.ema(closes, 50), e200: C.ema(closes, 200) },
      rsi: C.rsi(closes),
      smc: smc,
      mtf: mtf,
      fund: null,                                  // historical funding not reconstructable -> neutral
      kz: C.kzNow(raw[i].t + tfMs),                // time the signal bar closed
      fresh: { ok: true },
      locked: false,
      minReady: config.minScore
    };

    const sig = C.computeSignal(inp);
    if (sig.status !== 'READY' || !sig.plan) continue;

    const plan = sig.plan;
    const side = sig.dir;
    const dirSign = side === 'LONG' ? 1 : -1;
    const tp1 = plan.tps[0], tp2 = plan.tps[1];

    // ---- find entry bar (never the signal bar itself) ----
    let entryBar = -1, entryPrice = 0;
    const entryTarget = config.entryMode === 'zone' ? (plan.zone.lo + plan.zone.hi) / 2 : 0;
    for (let j = i + 1; j < raw.length; j++) {
      const bar = raw[j];
      if (config.entryMode === 'zone') {
        if (j - i > config.entryExpiryBars) break;
        if (bar.l <= entryTarget && bar.h >= entryTarget) { entryBar = j; entryPrice = entryTarget; break; }
        if (side === 'LONG' && bar.h >= tp1) break;       // target gone before fill
        if (side === 'SHORT' && bar.l <= tp1) break;
      } else {
        entryPrice = side === 'LONG' ? bar.o * (1 + slip) : bar.o * (1 - slip);
        entryBar = j;
        break;
      }
    }
    if (entryBar < 0) continue;

    let sl = plan.sl;
    // gapped through the stop / already past TP1 -> setup no longer valid
    if (side === 'LONG' ? (entryPrice <= sl || entryPrice >= tp1) : (entryPrice >= sl || entryPrice <= tp1)) continue;

    const R = Math.abs(entryPrice - sl);
    if (!(R > 0)) continue;
    const qty = (balance * (config.riskPct / 100)) / R;
    let qtyLeft = qty, realized = 0, feeAccum = entryPrice * qty * fee;
    let exitBar = -1, exitPrice = 0, reason = '', beMoved = false, tp1Hit = false;

    const closePart = function(px, q) {
      realized += dirSign * (px - entryPrice) * q;
      feeAccum += Math.abs(px * q) * fee;
    };

    // ---- simulate FROM the entry bar (market: from the open; limit: SL check only on that bar) ----
    const forceBar = Math.min(raw.length - 1, entryBar + config.maxBarsInTrade);
    for (let j = entryBar; j <= forceBar; j++) {
      const bar = raw[j];
      const hitSL = side === 'LONG' ? bar.l <= sl : bar.h >= sl;

      if (j === entryBar && config.entryMode === 'zone') {
        // intrabar order unknown: TPs on the fill bar are ignored, a stop-out is assumed
        if (hitSL) { closePart(sl, qtyLeft); qtyLeft = 0; exitBar = j; exitPrice = sl; reason = 'SL'; break; }
        continue;
      }

      const hitTP1 = !tp1Hit && (side === 'LONG' ? bar.h >= tp1 : bar.l <= tp1);
      const hitTP2 = side === 'LONG' ? bar.h >= tp2 : bar.l <= tp2;

      // Conservative: on the same bar, SL wins over TP
      if (config.conservative && hitSL) {
        closePart(sl, qtyLeft); qtyLeft = 0; exitBar = j; exitPrice = sl; reason = tp1Hit ? 'BE' : 'SL'; break;
      }
      // TP1 partial (50%) -> stop to break-even
      if (hitTP1) {
        const partQty = qty * 0.5;
        closePart(tp1, partQty);
        qtyLeft -= partQty;
        tp1Hit = true; beMoved = true; sl = entryPrice;
      }
      if (hitSL) {   // only reachable when conservative === false
        closePart(sl, qtyLeft); qtyLeft = 0; exitBar = j; exitPrice = sl; reason = tp1Hit ? 'BE' : 'SL'; break;
      }
      if (hitTP2) {  // remaining size exits at TP2 (TP3 can never be hit without TP2 first)
        closePart(tp2, qtyLeft); qtyLeft = 0; exitBar = j; exitPrice = tp2; reason = 'TP2'; break;
      }
    }

    if (exitBar < 0) {   // time stop / end of data
      const px = raw[forceBar].c;
      closePart(px, qtyLeft); qtyLeft = 0;
      exitBar = forceBar; exitPrice = px; reason = 'TIME';
    }

    const pnl = realized - feeAccum;
    balance += pnl;
    eqCurve.push({ i: exitBar, eq: balance });
    trades.push({
      entryTime: raw[entryBar].t,
      exitTime: raw[exitBar].t,
      side: side,
      entry: entryPrice,
      exit: exitPrice,
      reason: reason,
      sl: plan.sl,
      tp1: plan.tps[0],
      tp2: plan.tps[1],
      tp3: plan.tps[2],
      qty: qty,
      fees: feeAccum,
      pnl: pnl,
      score: sig.score,
      be: beMoved,
      tp1Hit: tp1Hit
    });

    i = exitBar;
  }

  // ---- stats ----
  const wins = trades.filter(function(t){ return t.pnl > 0; });
  const losses = trades.filter(function(t){ return t.pnl < 0; });
  const grossWin = wins.reduce(function(s, t){ return s + t.pnl; }, 0);
  const grossLoss = Math.abs(losses.reduce(function(s, t){ return s + t.pnl; }, 0));
  const n = trades.length;

  let peak = config.balance, maxDD = 0, maxDDpct = 0, running = config.balance;
  for (let k = 0; k < trades.length; k++) {
    running += trades[k].pnl;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
    const ddp = peak > 0 ? dd / peak * 100 : 0;
    if (ddp > maxDDpct) maxDDpct = ddp;
  }
  let streak = 0, maxStreak = 0;
  for (let k = 0; k < trades.length; k++) {
    if (trades[k].pnl < 0) { streak++; if (streak > maxStreak) maxStreak = streak; }
    else streak = 0;
  }

  return {
    trades: trades,
    equity: eqCurve,
    stats: {
      n: n,
      wins: wins.length,
      losses: losses.length,
      winRate: n ? wins.length / n * 100 : 0,
      totalPnl: balance - config.balance,
      finalBalance: balance,
      grossWin: grossWin,
      grossLoss: grossLoss,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      expectancy: n ? (balance - config.balance) / n : 0,
      maxDD: maxDD,
      maxDDpct: maxDDpct,
      maxLossStreak: maxStreak,
      mtfApprox: true,
      conservative: config.conservative,
      entryMode: config.entryMode,
      slippagePct: config.slippagePct
    }
  };
}

const api = { runBacktest: runBacktest, klinesToCandles: klinesToCandles, buildMtf: buildMtf };
root.Backtest = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
