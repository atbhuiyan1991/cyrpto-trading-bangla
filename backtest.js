/* backtest.js — walk-forward backtest using analysis.js Signal Engine.
   Input: klines (raw Binance array OR objects).
   Output: { trades, equity, stats } or { error } */
'use strict';
(function (root) {
const C = root.CTB || (typeof require === 'function' ? require('./analysis.js') : null);

function klinesToCandles(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const first = raw[0];
  if (Array.isArray(first)) {
    return raw.map(function(k){ return { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }; });
  }
  return raw;
}

function runBacktest(candles, cfg) {
  cfg = cfg || {};
  const config = {
    tf: cfg.tf || '15m',
    symbol: cfg.symbol || 'BACKTEST',
    feePct: Number.isFinite(+cfg.feePct) ? +cfg.feePct : 0.05,
    riskPct: Number.isFinite(+cfg.riskPct) ? +cfg.riskPct : 1,
    minScore: Number.isFinite(+cfg.minScore) ? +cfg.minScore : 70,
    maxBarsInTrade: Number.isFinite(+cfg.maxBarsInTrade) ? +cfg.maxBarsInTrade : 100,
    entryMode: cfg.entryMode === 'zone' ? 'zone' : 'market',
    balance: Number.isFinite(+cfg.balance) ? +cfg.balance : 1000
  };

  const raw = klinesToCandles(candles);
  if (raw.length < 250) return { error: 'Not enough candles (250+ required)' };
  if (!C || !C.smcAnalyze || !C.computeSignal) return { error: 'analysis.js not loaded' };

  let balance = config.balance;
  const trades = [];
  const warmup = 200;
  const eqCurve = [{ i: 0, eq: balance }];
  const fee = config.feePct / 100;

  for (let i = warmup; i < raw.length; i++) {
    const window = raw.slice(Math.max(0, i - 299), i + 1);
    if (window.length < 60) continue;

    const closes = window.map(function(k){ return k.c; });
    const smc = C.smcAnalyze(window);
    const price = closes[closes.length - 1];

    const per = {};
    per[config.tf] = (price > C.ema(closes, 9) && C.ema(closes, 9) > C.ema(closes, 21))
      ? 'Bullish'
      : (price < C.ema(closes, 9) && C.ema(closes, 9) < C.ema(closes, 21))
        ? 'Bearish' : 'Neutral';

    const inp = {
      symbol: config.symbol,
      tf: config.tf,
      price: price,
      ema: { e9: C.ema(closes, 9), e21: C.ema(closes, 21), e50: C.ema(closes, 50), e200: C.ema(closes, 200) },
      rsi: C.rsi(closes),
      smc: smc,
      mtf: { per: per },
      fund: null,
      kz: { london: false, ny: false },
      fresh: { ok: true },
      locked: false
    };

    const sig = C.computeSignal(inp);
    if (sig.status !== 'READY' || !sig.plan || sig.score < config.minScore) continue;

    const plan = sig.plan;
    const side = sig.dir;

    const entryTarget = config.entryMode === 'zone' ? (plan.zone.lo + plan.zone.hi) / 2 : price;
    let entryBar = -1, entryPrice = 0;

    for (let j = i + 1; j < raw.length; j++) {
      const bar = raw[j];
      if (config.entryMode === 'zone') {
        if (bar.l <= entryTarget && bar.h >= entryTarget) { entryBar = j; entryPrice = entryTarget; break; }
        if (side === 'LONG' && bar.h >= plan.tps[0]) break;
        if (side === 'SHORT' && bar.l <= plan.tps[0]) break;
      } else {
        entryBar = j; entryPrice = bar.c; break;
      }
    }
    if (entryBar < 0) continue;

    let exitBar = -1, exitPrice = 0, realized = 0, remaining = 1;
    let sl = plan.sl, beMoved = false, tp1Hit = false;

    const R = Math.abs(entryPrice - sl);
    const riskAmount = balance * (config.riskPct / 100);
    const qty = riskAmount / Math.max(1e-9, R);

    for (let j = entryBar; j < raw.length && j < entryBar + config.maxBarsInTrade; j++) {
      const bar = raw[j];
      const hitSL = side === 'LONG' ? bar.l <= sl : bar.h >= sl;
      const hitTP1 = side === 'LONG' ? bar.h >= plan.tps[0] : bar.l <= plan.tps[0];
      const hitTP2 = side === 'LONG' ? bar.h >= plan.tps[1] : bar.l <= plan.tps[1];
      const hitTP3 = side === 'LONG' ? bar.h >= plan.tps[2] : bar.l <= plan.tps[2];

      if (!tp1Hit && hitTP1) {
        const p1 = plan.tps[0];
        realized += (side === 'LONG' ? (p1 - entryPrice) : (entryPrice - p1)) * qty * 0.5;
        remaining = 0.5;
        tp1Hit = true;
        sl = entryPrice;
        beMoved = true;
      }
      if (hitSL) {
        realized += (side === 'LONG' ? (sl - entryPrice) : (entryPrice - sl)) * qty * remaining;
        exitBar = j; exitPrice = sl; break;
      }
      if (hitTP3) {
        realized += (side === 'LONG' ? (plan.tps[2] - entryPrice) : (entryPrice - plan.tps[2])) * qty * remaining;
        exitBar = j; exitPrice = plan.tps[2]; break;
      }
      if (hitTP2) {
        realized += (side === 'LONG' ? (plan.tps[1] - entryPrice) : (entryPrice - plan.tps[1])) * qty * remaining;
        exitBar = j; exitPrice = plan.tps[1]; break;
      }
    }
    if (exitBar < 0) {
      const lastBar = raw[Math.min(raw.length - 1, entryBar + config.maxBarsInTrade)];
      const px = lastBar.c;
      realized += (side === 'LONG' ? (px - entryPrice) : (entryPrice - px)) * qty * remaining;
      exitBar = raw.length - 1; exitPrice = px;
    }

    const notionalEntry = entryPrice * qty;
    const notionalExit = exitPrice * qty;
    const fees = (notionalEntry + notionalExit) * fee;
    const pnl = realized - fees;

    balance += pnl;
    eqCurve.push({ i: exitBar, eq: balance });
    trades.push({
      entryTime: raw[entryBar].t,
      exitTime: raw[exitBar].t,
      side: side,
      entry: entryPrice,
      exit: exitPrice,
      sl: plan.sl,
      tp1: plan.tps[0],
      tp2: plan.tps[1],
      tp3: plan.tps[2],
      qty: qty,
      fees: fees,
      pnl: pnl,
      score: sig.score,
      be: beMoved,
      tp1Hit: tp1Hit
    });

    i = exitBar;
  }

  const wins = trades.filter(function(t){ return t.pnl > 0; });
  const losses = trades.filter(function(t){ return t.pnl < 0; });
  const grossWin = wins.reduce(function(s, t){ return s + t.pnl; }, 0);
  const grossLoss = Math.abs(losses.reduce(function(s, t){ return s + t.pnl; }, 0));
  const n = trades.length;

  let peak = 0, maxDD = 0, running = config.balance;
  for (let i = 0; i < trades.length; i++) {
    running += trades[i].pnl;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  }
  let streak = 0, maxStreak = 0;
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].pnl < 0) { streak++; if (streak > maxStreak) maxStreak = streak; }
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
      maxDDpct: config.balance > 0 ? maxDD / config.balance * 100 : 0,
      maxLossStreak: maxStreak
    }
  };
}

const api = { runBacktest: runBacktest, klinesToCandles: klinesToCandles };
root.Backtest = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
