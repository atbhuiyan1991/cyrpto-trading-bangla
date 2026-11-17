/* backtest.js — bar-by-bar backtest using the analysis.js Signal Engine.
   Input: klines (raw Binance array OR objects {t,o,h,l,c,v}). Drop the still-forming last candle before calling.

   Changes in this version (signal-quality audit):
   1. STALE-BAR FIX: the engine (smcAnalyze) always treats the LAST row as the still-forming candle and ignores it.
      The old backtest passed rows up to the signal bar, so that closed bar was dropped -> in ~18% of bars the
      SMC event differed from what the live scanner sees right after that candle closes. We now append a
      flat placeholder "forming" candle (open=high=low=close=signal close). No future data is used.
   2. exitMode: 'single' (default) = 100% exit at TP2, SL stays  -> this is what the live Trade Panel really does.
                'partial'           = 50% at TP1, stop to break-even, rest at TP2 (old behaviour).
   3. leverage: a trade whose margin (notional / leverage) exceeds the balance is skipped (the server rejects it too).
   4. Stop / time exits get adverse slippage (stops are market orders). Take-profits fill at the limit price.
   5. Non-conservative mode: TP is checked before SL on the same bar (clear, documented ordering).
   6. diag: optional signal-quality diagnostics. Every bar with a direction (not only READY) is simulated and the
      result in R (after fees) is grouped by score bucket and by each risk-gate check, to show whether the
      score and each gate really separate good setups from bad ones.
   Kept: market entry = next bar OPEN + slippage; same-bar SL wins over TP (conservative); limit orders expire;
   Max DD relative to equity peak. */
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

// Approximate 4-TF MTF snapshot by down-sampling closes (newest bar first). TFs lower than the base TF fall back to base.
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

// Short stable key for a risk-gate check text (digits stripped) -> used by the diagnostics
function gateKey(t) {
  t = String(t);
  if (/^SL dist/.test(t)) return 'SL distance';
  if (/^R:R at market/.test(t)) return 'R:R at market price';
  if (/^R:R/.test(t)) return 'R:R (TP2)';
  if (/discount|premium/.test(t)) return 'Premium/Discount';
  if (/^HTF/.test(t)) return 'HTF bias (1h+4h)';
  if (/Trending|Choppy/.test(t)) return 'Trending market (ER)';
  if (/^Zone reaction/.test(t)) return 'Zone reaction candle';
  if (/^LTF/.test(t)) return 'LTF confirmation';
  if (/structural zone|Structural zone/i.test(t)) return 'Structural zone';
  if (/^Data/.test(t)) return 'Data fresh & complete';
  if (/lock/i.test(t)) return 'Loss lock';
  return t.slice(0, 24);
}

/* Simulate ONE trade from the signal on bar i. sizeFn(entryPrice, riskDistance) -> qty (or null = skip).
   Returns { skip } or a trade record. */
function simTrade(raw, i, sig, cfg, sizeFn, ref) {
  const plan = sig.plan, side = sig.dir, dirSign = side === 'LONG' ? 1 : -1;
  const fee = cfg.fee, slip = cfg.slip, partial = cfg.exitMode === 'partial';
  // ref = { entry } -> MIRROR trade (diagnostics control): every level is reflected around the signal trade's real entry price
  const L = function(x){ return ref ? 2 * ref.entry - x : x; };
  const tp1 = L(plan.tps[0]), tp2 = L(plan.tps[1]);

  // ---- entry bar (never the signal bar itself) ----
  let entryBar = -1, entryPrice = 0;
  const target = ref ? ref.entry : (plan.zone.lo + plan.zone.hi) / 2;
  for (let j = i + 1; j < raw.length; j++) {
    const bar = raw[j];
    if (cfg.entryMode === 'zone') {
      if (j - i > cfg.entryExpiryBars) break;
      if (bar.l <= target && bar.h >= target) { entryBar = j; entryPrice = target; break; }
      if (side === 'LONG' && bar.h >= tp1) break;       // target gone before fill
      if (side === 'SHORT' && bar.l <= tp1) break;
    } else {
      entryPrice = side === 'LONG' ? bar.o * (1 + slip) : bar.o * (1 - slip);
      entryBar = j;
      break;
    }
  }
  if (entryBar < 0) return { skip: 'noentry' };

  let sl = L(plan.sl);
  if (side === 'LONG' ? (entryPrice <= sl || entryPrice >= tp1) : (entryPrice >= sl || entryPrice <= tp1)) return { skip: 'gap' };
  const Rd = Math.abs(entryPrice - sl);
  if (!(Rd > 0)) return { skip: 'gap' };
  const qty = sizeFn(entryPrice, Rd);
  if (!(qty > 0)) return { skip: 'margin' };

  let qtyLeft = qty, realized = 0, feeAccum = entryPrice * qty * fee;
  let exitBar = -1, exitPrice = 0, reason = '', beMoved = false, tp1Hit = false;
  // limit/TP fills at the price; stop & time exits are market orders -> adverse slippage
  const closePart = function(px, q, market) {
    const fp = market ? px * (1 - dirSign * slip) : px;
    realized += dirSign * (fp - entryPrice) * q;
    feeAccum += Math.abs(fp * q) * fee;
    return fp;
  };
  const stopOut = function(j) {
    exitPrice = closePart(sl, qtyLeft, true); qtyLeft = 0; exitBar = j; reason = tp1Hit ? 'BE' : 'SL';
  };

  const forceBar = Math.min(raw.length - 1, entryBar + cfg.maxBarsInTrade);
  for (let j = entryBar; j <= forceBar; j++) {
    const bar = raw[j];
    const hitSL = side === 'LONG' ? bar.l <= sl : bar.h >= sl;

    if (j === entryBar && cfg.entryMode === 'zone') {
      // intrabar order unknown on the fill bar: TPs ignored, a stop-out is assumed
      if (hitSL) { stopOut(j); break; }
      continue;
    }
    const hitTP1 = partial && !tp1Hit && (side === 'LONG' ? bar.h >= tp1 : bar.l <= tp1);
    const hitTP2 = side === 'LONG' ? bar.h >= tp2 : bar.l <= tp2;

    if (cfg.conservative && hitSL) { stopOut(j); break; }          // same bar: SL wins
    if (hitTP1) {
      const part = qty * 0.5;
      closePart(tp1, part, false); qtyLeft -= part;
      tp1Hit = true; beMoved = true; sl = entryPrice;
    }
    if (hitTP2) { exitPrice = closePart(tp2, qtyLeft, false); qtyLeft = 0; exitBar = j; reason = 'TP2'; break; }
    if (hitSL) { stopOut(j); break; }                              // only reachable when conservative === false
  }
  if (exitBar < 0) {   // time stop / end of data
    exitPrice = closePart(raw[forceBar].c, qtyLeft, true); qtyLeft = 0; exitBar = forceBar; reason = 'TIME';
  }
  const pnl = realized - feeAccum;
  return { entryBar: entryBar, exitBar: exitBar, entry: entryPrice, exit: exitPrice, reason: reason, qty: qty, fees: feeAccum,
           pnl: pnl, R: pnl / (Rd * qty), feeR: feeAccum / (Rd * qty), be: beMoved, tp1Hit: tp1Hit, sl: sl };
}

function summarizeDiag(samples) {
  const avg = function(a){ return a.length ? a.reduce(function(s, x){ return s + x; }, 0) / a.length : 0; };
  const ed = function(arr) {   // edge vs the mirrored opposite trade (only samples where the mirror trade exists)
    const v = arr.filter(function(x){ return x.Rm !== null && x.Rm !== undefined; }).map(function(x){ return x.R - x.Rm; });
    return { n: v.length, e: avg(v) };
  };
  const buckets = [[50, 55], [55, 60], [60, 65], [65, 70], [70, 80], [80, 101]];
  const byScore = buckets.map(function(b) {
    const arr = samples.filter(function(x){ return x.score >= b[0] && x.score < b[1]; }), s = arr.map(function(x){ return x.R; }), e = ed(arr);
    return { label: b[0] + (b[1] > 100 ? '+' : '–' + (b[1] - 1)), n: s.length, winRate: s.length ? s.filter(function(r){ return r > 0; }).length / s.length * 100 : 0, avgR: avg(s), edge: e.e, edgeN: e.n };
  });
  const keys = {};
  samples.forEach(function(x){ Object.keys(x.gates).forEach(function(k){ keys[k] = true; }); });
  const byGate = Object.keys(keys).map(function(k) {
    const P = samples.filter(function(x){ return x.gates[k] === true; }), F = samples.filter(function(x){ return x.gates[k] === false; });
    const pe = ed(P), fe = ed(F);
    return { gate: k, passN: P.length, passAvgR: avg(P.map(function(x){ return x.R; })), passEdge: pe.e, passEdgeN: pe.n,
             failN: F.length, failAvgR: avg(F.map(function(x){ return x.R; })), failEdge: fe.e, failEdgeN: fe.n };
  });
  const byDir = ['LONG', 'SHORT'].map(function(d) {
    const arr = samples.filter(function(x){ return x.dir === d; }), e = ed(arr);
    return { dir: d, n: arr.length, avgR: avg(arr.map(function(x){ return x.R; })), edge: e.e, edgeN: e.n };
  });
  const half = function(lo, hi) {   // time stability: the first vs the second half of each coin's history
    const a = samples.filter(function(x){ return x.pos >= lo && x.pos < hi; }), e = ed(a);
    return { n: a.length, edge: e.e, edgeN: e.n, avgR: avg(a.map(function(x){ return x.R; })) };
  };
  const all = samples.map(function(x){ return x.R; }), eAll = ed(samples);
  return { n: samples.length, avgR: avg(all), winRate: all.length ? all.filter(function(r){ return r > 0; }).length / all.length * 100 : 0,
           edge: eAll.e, edgeN: eAll.n, avgFeeR: avg(samples.map(function(x){ return x.feeR || 0; })), byHalf: [half(0, 0.5), half(0.5, 1.01)],
           byScore: byScore, byGate: byGate, byDir: byDir };
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
    exitMode: cfg.exitMode === 'partial' ? 'partial' : 'single',
    leverage: Math.max(1, num(cfg.leverage, 10)),
    balance: num(cfg.balance, 1000),
    slippagePct: num(cfg.slippagePct, 0.02),
    conservative: cfg.conservative !== false,
    diag: cfg.diag === true,
    diagCooldown: Math.max(1, Math.floor(num(cfg.diagCooldown, 4)))
  };

  const raw = klinesToCandles(candles);
  if (raw.length < 250) return { error: 'Not enough candles (250+ required)' };
  if (!C || !C.smcAnalyze || !C.computeSignal) return { error: 'analysis.js not loaded' };
  if (!(config.balance > 0) || !(config.riskPct > 0) || config.feePct < 0) return { error: 'Invalid balance / risk / fee' };

  const rows = raw.map(function(k){ return [k.t, k.o, k.h, k.l, k.c, k.v]; });   // analysis.js expects arrays
  const allCloses = raw.map(function(k){ return k.c; });
  const tfMs = (TF_MIN[config.tf] || 15) * 60000;
  const sim = { fee: config.feePct / 100, slip: config.slippagePct / 100, exitMode: config.exitMode, entryMode: config.entryMode,
                entryExpiryBars: config.entryExpiryBars, maxBarsInTrade: config.maxBarsInTrade, conservative: config.conservative };

  let balance = config.balance;
  const trades = [], samples = [];
  const skipped = { margin: 0, gap: 0, noentry: 0 };
  const warmup = 200;
  const eqCurve = [{ i: 0, eq: balance }];
  let nextDiag = warmup;

  for (let i = warmup; i < raw.length - 1; i++) {
    const from = Math.max(0, i - 299);
    const closes = allCloses.slice(from, i + 1);
    const price = closes[closes.length - 1];
    // rows up to the closed signal bar + flat placeholder "forming" candle (the engine drops the last row)
    const win = rows.slice(from, i + 1);
    win.push([raw[i].t + tfMs, price, price, price, price, 0]);
    if (win.length < 60) continue;

    const smc = C.smcAnalyze(win);
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

    // ---- diagnostics: every bar with a direction, not only READY (does not affect the trades below) ----
    if (config.diag && sig.dir && sig.plan && i >= nextDiag) {
      const r = simTrade(raw, i, sig, sim, function(){ return 1; });
      if (!r.skip && Number.isFinite(r.R)) {
        const gates = {};
        sig.gate.checks.forEach(function(c){ const k = gateKey(c.t); gates[k] = (gates[k] === undefined ? c.ok : (gates[k] && c.ok)); });
        // control: the mirrored opposite trade (same entry, SL/TP reflected). Removes the market-drift effect:
        // edge = R(signal direction) - R(opposite direction)
        const rm = simTrade(raw, i, { dir: sig.dir === 'LONG' ? 'SHORT' : 'LONG', plan: sig.plan }, sim, function(){ return 1; }, { entry: r.entry });
        samples.push({ score: sig.score, dir: sig.dir, status: sig.status, R: r.R, Rm: (!rm.skip && Number.isFinite(rm.R)) ? rm.R : null, feeR: r.feeR, pos: i / raw.length, gates: gates });
        nextDiag = i + config.diagCooldown;
      }
    }

    if (sig.status !== 'READY' || !sig.plan) continue;

    const r = simTrade(raw, i, sig, sim, function(entry, Rd) {
      const q = (balance * (config.riskPct / 100)) / Rd;
      return (q * entry / config.leverage > balance) ? null : q;     // server rejects when margin > available
    });
    if (r.skip) { skipped[r.skip] = (skipped[r.skip] || 0) + 1; continue; }

    balance += r.pnl;
    eqCurve.push({ i: r.exitBar, eq: balance });
    trades.push({
      entryTime: raw[r.entryBar].t,
      exitTime: raw[r.exitBar].t,
      side: sig.dir,
      entry: r.entry,
      exit: r.exit,
      reason: r.reason,
      sl: sig.plan.sl,
      tp1: sig.plan.tps[0],
      tp2: sig.plan.tps[1],
      tp3: sig.plan.tps[2],
      qty: r.qty,
      fees: r.fees,
      pnl: r.pnl,
      R: r.R,
      score: sig.score,
      be: r.be,
      tp1Hit: r.tp1Hit
    });
    i = r.exitBar;
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
    diag: config.diag ? summarizeDiag(samples) : null,
    diagSamples: config.diag ? samples : null,
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
      avgR: n ? trades.reduce(function(s, t){ return s + t.R; }, 0) / n : 0,
      maxDD: maxDD,
      maxDDpct: maxDDpct,
      maxLossStreak: maxStreak,
      skipped: skipped,
      mtfApprox: true,
      conservative: config.conservative,
      entryMode: config.entryMode,
      exitMode: config.exitMode,
      leverage: config.leverage,
      slippagePct: config.slippagePct
    }
  };
}

const api = { runBacktest: runBacktest, klinesToCandles: klinesToCandles, buildMtf: buildMtf, summarizeDiag: summarizeDiag };
root.Backtest = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
