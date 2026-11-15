/* autotest.js — ১-ক্লিক OOS backtest for 10 coins
   Uses your existing analysis.js + backtest.js. No extra libraries. */
'use strict';

const COINS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
               'ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','DOTUSDT'];

// 15m ক্যান্ডেল সংখ্যা হিসাব: 6 মাস in-sample + 2 মাস OOS
const TF = '15m';
const OOS_BARS = 2 * 30 * 24 * 4;   // 2 মাস = ~5760 বার (15m)
const IS_BARS  = 6 * 30 * 24 * 4;   // 6 মাস = ~17280 বার
const NEED_BARS = OOS_BARS + IS_BARS; // ~23040

const STATUS = document.getElementById('status');
const TABLE  = document.getElementById('results');
const CSV_BTN = document.getElementById('csvBtn');

let lastResults = [];

function log(msg){
  STATUS.textContent = msg;
  console.log('[autotest]', msg);
}

async function fetchKlines(symbol, limit){
  // Binance futures klines, paginated (max 1500 per call)
  const out = [];
  let endTime = Date.now();
  while(out.length < limit){
    const need = Math.min(1500, limit - out.length);
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${TF}&limit=${need}&endTime=${endTime}`;
    const r = await fetch(url);
    if(!r.ok) throw new Error(symbol+' HTTP '+r.status);
    const batch = await r.json();
    if(!Array.isArray(batch) || !batch.length) break;
    out.unshift(...batch);              // পুরোনো আগে
    endTime = batch[0][0] - 1;          // এর আগের ব্যাচ
    if(batch.length < need) break;
    await new Promise(r=>setTimeout(r, 250)); // rate limit respect
  }
  return out;
}

function runOne(symbol, raw){
  // in-sample: প্রথম IS_BARS; OOS: শেষ OOS_BARS
  const isRaw = raw.slice(0, IS_BARS);
  const oosRaw = raw.slice(IS_BARS);
  const cfg = { tf: TF, symbol, entryMode:'market', riskPct:1, feePct:0.05, balance:1000, minScore:70 };
  const isRes  = window.Backtest.runBacktest(isRaw, cfg);
  const oosRes = window.Backtest.runBacktest(oosRaw, cfg);
  return { symbol, isRes, oosRes };
}

function fmt(n, d=2){
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

function render(rows){
  TABLE.innerHTML = rows.map(r=>{
    const is = r.isRes.stats || {}, oos = r.oosRes.stats || {};
    const isErr = r.isRes.error || '—';
    const oosErr = r.oosRes.error || '—';
    const oosWR = oos.winRate || 0;
    const oosExp = oos.expectancy || 0;
    const oosDD = oos.maxDDpct || 0;
    const oosN = oos.n || 0;
    const cls = (oosN < 10) ? 'muted'
      : (oosWR>=50 && oosExp>0 && oosDD<15) ? 'good'
      : (oosWR>=45 && oosExp>0) ? 'warn' : 'bad';
    return `<tr class="${cls}">
      <td>${r.symbol}</td>
      <td>${fmt(is.winRate)}%</td>
      <td>${fmt(is.expectancy,4)}</td>
      <td>${is.n||0}</td>
      <td>${fmt(oosWR)}%</td>
      <td>${fmt(oosExp,4)}</td>
      <td>${fmt(oosDD,1)}%</td>
      <td>${oosN}</td>
      <td>${isErr!=='—'?isErr:''}${oosErr!=='—'?oosErr:''}</td>
    </tr>`;
  }).join('');
}

function summarize(rows){
  const valid = rows.filter(r=>r.oosRes.stats && r.oosRes.stats.n>=10);
  if(!valid.length){ document.getElementById('summary').textContent = '⚠️ কোনো কয়েনে পর্যাপ্ত OOS ট্রেড নেই (কমপক্ষে ১০ লাগবে)।'; return; }
  const avg = k => valid.reduce((s,r)=>s+(r.oosRes.stats[k]||0),0)/valid.length;
  const good = valid.filter(r=>r.oosRes.stats.winRate>=50 && r.oosRes.stats.expectancy>0 && r.oosRes.stats.maxDDpct<15);
  document.getElementById('summary').innerHTML =
    `<b>সারসংক্ষেপ (${valid.length} কয়েনে ≥১০ OOS ট্রেড):</b><br>`+
    `গড় OOS Win-rate: <b>${fmt(avg('winRate'))}%</b> · `+
    `গড় Expectancy: <b>${fmt(avg('expectancy'),4)}</b> · `+
    `গড় Max DD: <b>${fmt(avg('maxDDpct'),1)}%</b><br>`+
    `✅ ভালো (WR≥50%, Exp>0, DD<15%): <b>${good.length}/${valid.length}</b> কয়েন`;
}

async function runAll(){
  if(!window.Backtest || !window.CTB || !window.CTB.computeSignal){
    log('❌ analysis.js / backtest.js লোড হয়নি');
    return;
  }
  lastResults = [];
  CSV_BTN.disabled = true;
  TABLE.innerHTML = '<tr><td colspan="9" class="muted">শুরু হচ্ছে…</td></tr>';
  document.getElementById('summary').textContent = '';

  for(let i=0;i<COINS.length;i++){
    const sym = COINS[i];
    log(`(${i+1}/${COINS.length}) ${sym} — ডেটা আনছে…`);
    try{
      const raw = await fetchKlines(sym, NEED_BARS);
      if(raw.length < NEED_BARS - 100){ log(`${sym}: ডেটা কম (${raw.length}/${NEED_BARS}) — skip`); continue; }
      log(`(${i+1}/${COINS.length}) ${sym} — backtest চলছে…`);
      const r = runOne(sym, raw);
      lastResults.push(r);
      render(lastResults);
    }catch(e){
      console.error(sym, e);
      log(`${sym}: ব্যর্থ — ${e.message}`);
    }
    await new Promise(r=>setTimeout(r, 400));
  }
  render(lastResults);
  summarize(lastResults);
  CSV_BTN.disabled = lastResults.length===0;
  log('✅ শেষ হয়েছে।');
}

function downloadCSV(){
  if(!lastResults.length) return;
  const header = ['Symbol','IS_WinRate','IS_Exp','IS_N','OOS_WinRate','OOS_Exp','OOS_MaxDD%','OOS_N'];
  const rows = lastResults.map(r=>{
    const is = r.isRes.stats||{}, oos = r.oosRes.stats||{};
    return [r.symbol, is.winRate||0, is.expectancy||0, is.n||0,
            oos.winRate||0, oos.expectancy||0, oos.maxDDpct||0, oos.n||0];
  });
  const csv = '\ufeff'+[header, ...rows].map(r=>r.map(c=>
    typeof c==='string' && /[",\n]/.test(c) ? '"'+c.replace(/"/g,'""')+'"' : c
  ).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8'}));
  a.download = 'oos-backtest-'+Date.now()+'.csv';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
}

window.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('runBtn').addEventListener('click', runAll);
  CSV_BTN.addEventListener('click', downloadCSV);
});
