(() => {
'use strict';
const $ = id => document.getElementById(id);
const fmtPrice = n => Number.isFinite(n) ? n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:n>=1000?2:6}) : '—';
const fmtMoney = n => Number.isFinite(n) ? (n<0?'-':'')+'$'+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—';
const fmtPct = n => Number.isFinite(n) ? `${n>=0?'+':''}${n.toFixed(2)}%` : '—';
const safe = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const load = (k,d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch(e){ return d; } };
const defaultPairs = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT'];
const tickers = new Map();
let selectedSymbol='BTCUSDT', selectedInterval='15m', scannerMode='gainers', marketRows=[];
let alerts = load('ctb-alerts',[]), journal = load('ctb-journal',[]), alertLog = load('ctb-alertlog',[]);
let watchlist = load('ctb-watchlist',null); if(!Array.isArray(watchlist)||!watchlist.length) watchlist=[...defaultPairs];
let settings = {balance:0,symbol:'BTCUSDT',language:'bn',refresh:30000,theme:'dark',apAutoAlert:true,...load('ctb-settings',{})};
let mtfGen=0, smcGen=0, tvKey="", lastSMC=null, lastMTF=null, lastFund=null, wsSet=new Set(), aiTimer=null, ws=null, reconnectTimer=null, refreshTimer=null, renderQueued=false;

// ---- analytics from analysis.js ----
const CTB = window.CTB || {};
const emaF = CTB.ema || (function(v,p){ if(v.length<p) return NaN; const k=2/(p+1); let e=v.slice(0,p).reduce(function(a,b){return a+b;},0)/p; for(let i=p;i<v.length;i++) e=(v[i]-e)*k+e; return e; });
const rsiF = CTB.rsi || (function(c,p){ p=p||14; if(c.length<p+1) return 50; let g=0,l=0; for(let i=1;i<=p;i++){const d=c[i]-c[i-1]; if(d>=0) g+=d; else l-=d;} let ag=g/p,al=l/p; for(let i=p+1;i<c.length;i++){const d=c[i]-c[i-1]; ag=(ag*(p-1)+Math.max(d,0))/p; al=(al*(p-1)+Math.max(-d,0))/p;} return al===0?100:100-100/(1+ag/al); });
const smcF = CTB.smcAnalyze || null;
const fibPxF = CTB.fibPx || (function(f,r){ return f.bull?f.hi-f.d*r:f.lo+f.d*r; });
const fibExtF = CTB.fibExt || (function(f,r){ return f.bull?f.lo+f.d*r:f.hi-f.d*r; });
const fibStateF = CTB.fibState || null;
const kzNowF = CTB.kzNow || (function(){ const n=new Date(),m=((n.getUTCHours()+4)%24)*60+n.getUTCMinutes(); return {london:m>=660&&m<900, ny:m>=960&&m<1200}; });
const computeSignalF = CTB.computeSignal || null;
const journalStatsF = CTB.journalStats || null;

if (!CTB.computeSignal) console.error('❌ analysis.js লোড হয়নি — Autopilot / Signal Engine / Backtest disabled');

const setStatus=(id,t,ok=true)=>{const e=$(id); if(e){e.textContent=t; e.className=ok?'good-status':'bad-status';}};
const persist=()=>{ try{ localStorage.setItem('ctb-journal',JSON.stringify(journal)); localStorage.setItem('ctb-watchlist',JSON.stringify(watchlist)); localStorage.setItem('ctb-alerts',JSON.stringify(alerts)); localStorage.setItem('ctb-settings',JSON.stringify(settings)); }catch(e){} scheduleCloudSave(); };
const tvInterval = i => ({'5m':'5','15m':'15','1h':'60','4h':'240','1d':'D'}[i]||'15');
const normSymbol = s => { s=String(s).toUpperCase().replace(/[^A-Z0-9]/g,''); return s.endsWith('USDT')?s:s+'USDT'; };
const download = (name,text,type) => { const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); };
const csvCell=v=>{ let s=String(v==null?'':v); if(/^[=+\-@\t\r]/.test(s)&&Number.isNaN(Number(s))) s="'"+s; return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
const EXCH={binance:{name:'Binance',tv:'BINANCE'},bybit:{name:'Bybit',tv:'BYBIT'}};
let EX='binance';
const BYBIT_TF={'5m':'5','15m':'15','1h':'60','4h':'240','1d':'D'};
const klines = async (sym,tf,limit,ex=EX) => {
  if(ex==='bybit'){
    const iv=BYBIT_TF[tf]; if(!iv) throw new Error('interval');
    const r=await fetch(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(sym)}&interval=${iv}&limit=${limit}`); if(!r.ok) throw new Error('klines');
    const j=await r.json(); if(j.retCode!==0||!j.result||!Array.isArray(j.result.list)||!j.result.list.length) throw new Error('klines');
    return j.result.list.slice().reverse().map(c=>[+c[0],c[1],c[2],c[3],c[4],c[5]]);
  }
  const r=await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${tf}&limit=${limit}`); if(!r.ok) throw new Error('klines'); return r.json();
};

/* ---------- Global data ---------- */
async function fetchGlobal(){
  try{
    const r=await fetch('https://api.coingecko.com/api/v3/global'); if(!r.ok) throw 0;
    const d=(await r.json()).data;
    $('global-mcap').textContent='$'+(d.total_market_cap.usd/1e12).toFixed(2)+' T';
    const c=d.market_cap_change_percentage_24h_usd, el=$('global-mcap-change'); el.textContent=fmtPct(c); el.className='small '+(c>=0?'green':'red');
    $('global-volume').textContent='$'+(d.total_volume.usd/1e9).toFixed(1)+' B';
    $('global-btc-dom').textContent=d.market_cap_percentage.btc.toFixed(1)+'%';
    $('global-coins').textContent=d.active_cryptocurrencies.toLocaleString();
  }catch(e){ ['global-mcap','global-volume','global-btc-dom','global-coins'].forEach(i=>{const el=$(i); if(el) el.textContent='—';}); }
}

/* ---------- Indicators ---------- */
function calcEMA(values,period){ return emaF(values,period); }
function calcRSI(c,p){ return rsiF(c,p||14); }
async function updateEMA(){
  const periods=[9,21,50,200], sym=selectedSymbol, tf=selectedInterval;
  $('ema-symbol').textContent=sym.replace('USDT','/USDT'); $('ema-timeframe').textContent=' · '+tf;
  try{
    const candles=await klines(sym,tf,300);
    if(sym!==selectedSymbol||tf!==selectedInterval) return;
    const closes=candles.map(c=>+c[4]), v={};
    periods.forEach(p=>{v[p]=calcEMA(closes,p); $('ema-'+p).textContent=fmtPrice(v[p]);});
    const price=closes[closes.length-1];
    const bull=price>v[9]&&v[9]>v[21]&&v[21]>v[50], bear=price<v[9]&&v[9]<v[21]&&v[21]<v[50];
    const t=$('ema-trend'); t.textContent=bull?'Bullish Alignment':bear?'Bearish Alignment':'Mixed / Range'; t.className=bull?'green':bear?'red':'muted';
  }catch(e){ periods.forEach(p=>$('ema-'+p).textContent='ডেটা নেই'); $('ema-trend').textContent='লোড করা যায়নি'; }
}

/* ---------- Chart ---------- */
let tvLoading=false, tvMode='iframe';
try{ const m=localStorage.getItem('ctb-tvmode'); if(m==='script'||m==='iframe') tvMode=m; }catch(e){}
function tvIframeUrl(){
  const light=settings.theme==='light';
  const q=new URLSearchParams({frameElementId:'tradingview_chart',symbol:EXCH[EX].tv+':'+selectedSymbol+'.P',interval:tvInterval(selectedInterval),hidesidetoolbar:'0',symboledit:'0',saveimage:'1',toolbarbg:light?'f1f3f6':'161a1e',studies:'[]',theme:light?'light':'dark',style:'1',timezone:'Asia/Muscat',withdateranges:'1',locale:'en'});
  return 'https://s.tradingview.com/widgetembed/?'+q.toString();
}
function ensureTV(){
  if(tvLoading) return; tvLoading=true;
  const sc=document.createElement('script'); sc.src='https://s3.tradingview.com/tv.js'; sc.async=true;
  sc.onload=()=>{ tvLoading=false; if(typeof TradingView!=='undefined') loadTradingView(); };
  sc.onerror=()=>{ tvLoading=false; $('tradingview_chart').innerHTML='<div class="empty">TradingView লোড হয়নি <button id="tv-retry">আবার চেষ্টা</button></div>'; const b=$('tv-retry'); if(b) b.onclick=()=>loadTradingView(); };
  document.head.appendChild(sc);
}
function loadTradingView(){
  const box=$('tradingview_chart');
  $('chart-symbol-label').textContent=selectedSymbol.replace('USDT','')+'/USDT · '+selectedInterval;
  const key=selectedSymbol+'|'+selectedInterval+'|'+settings.theme+'|'+tvMode+'|'+EX;
  if(key!==tvKey||!box.firstChild){
    if(tvMode==='iframe'){
      tvKey=key; box.innerHTML='';
      const f=document.createElement('iframe'); f.src=tvIframeUrl(); f.title='TradingView chart'; f.referrerPolicy='strict-origin-when-cross-origin'; f.setAttribute('allowfullscreen','');
      f.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms'); box.appendChild(f);
    } else if(typeof TradingView==='undefined'){ box.innerHTML='<div class="empty">চার্ট লোড হচ্ছে…</div>'; ensureTV(); }
    else { tvKey=key; box.innerHTML=''; try{ new TradingView.widget({autosize:true,symbol:EXCH[EX].tv+':'+selectedSymbol+'.P',interval:tvInterval(selectedInterval),timezone:'Asia/Muscat',theme:settings.theme==='light'?'light':'dark',style:'1',locale:'en',container_id:'tradingview_chart'}); }catch(e){ box.innerHTML='<div class="empty">চার্ট লোড ব্যর্থ</div>'; } }
  }
  updateEMA();
}
function syncFollowers(){
  if($('tr-sym')) $('tr-sym').textContent=selectedSymbol.replace('USDT','/USDT');
  ['mtf-symbol','smc-auto-symbol','ai-symbol','alert-symbol','j-symbol','setting-symbol','chart-symbol-input','bt-symbol'].forEach(i=>{const e=$(i); if(e) e.value=selectedSymbol;});
  if($('alert-tf')) $('alert-tf').value=selectedInterval;
  if($('smc-auto-tf')) $('smc-auto-tf').value=selectedInterval;
  if($('ai-timeframe')) $('ai-timeframe').value=selectedInterval;
  const t=tickers.get(selectedSymbol); if($('ai-price')) $('ai-price').value=t?t.lastPrice:'';
  if($('ai-support')) $('ai-support').value='';
  if($('ai-resistance')) $('ai-resistance').value='';
}
let firstRun=true;
function runAll(){ clearTimeout(aiTimer); const d=firstRun?1500:300; firstRun=false; aiTimer=setTimeout(async()=>{ await Promise.all([runMTF(),runSMC(),runFunding()]); buildAI(); },d); }
function selectSymbol(symbol){
  if(!symbol) return;
  selectedSymbol=normSymbol(symbol); settings.symbol=selectedSymbol; persist();
  syncFollowers();
  if(!wsSet.has(selectedSymbol.toLowerCase()+'@ticker')) connectSocket();
  loadTradingView(); runAll();
}
function changeInterval(tf){
  selectedInterval=tf; settings.interval=tf; persist();
  document.querySelectorAll('#timeframes button').forEach(b=>b.classList.toggle('active',b.dataset.interval===tf));
  syncFollowers(); loadTradingView(); runAll();
}
function goChart(){ const v=$('chart-symbol-input').value.trim(); if(v) selectSymbol(v); }

/* ---------- Live data ---------- */
let lastRender=0;
function scheduleRender(){
  if(renderQueued) return; renderQueued=true;
  setTimeout(()=>requestAnimationFrame(()=>{renderQueued=false; lastRender=Date.now(); renderWatchlist(); renderMiniCards(); renderScanner(); updateTopCards(); renderFib();}),Math.max(0,800-(Date.now()-lastRender)));
}
function updateTopCards(){
  const b=tickers.get('BTCUSDT'), e=tickers.get('ETHUSDT');
  if(b){ $('top-btc-price').textContent='$'+fmtPrice(b.lastPrice); $('top-btc-change').textContent=fmtPct(b.change); $('top-btc-change').className='small '+(b.change>=0?'green':'red'); $('ticker-change').textContent=fmtPct(b.change); $('ticker-change').className='stat-value '+(b.change>=0?'green':'red'); }
  if(e){ $('top-eth-price').textContent='$'+fmtPrice(e.lastPrice); $('top-eth-change').textContent=fmtPct(e.change); $('top-eth-change').className='small '+(e.change>=0?'green':'red'); }
}
/* ---------- Alerts ---------- */
function toast(msg){
  let box=$('toasts'); if(!box){ box=document.createElement('div'); box.id='toasts'; box.style.cssText='position:fixed;right:12px;bottom:12px;z-index:60;display:flex;flex-direction:column;gap:8px;max-width:min(360px,90vw)'; document.body.appendChild(box); }
  const d=document.createElement('div'); d.textContent=msg; d.style.cssText='background:var(--panel);color:var(--text);border:1px solid var(--yellow);border-radius:10px;padding:10px 12px;box-shadow:0 4px 18px rgba(0,0,0,.4);font-size:13px';
  box.appendChild(d); setTimeout(()=>d.remove(),9000);
}
function beep(){ try{ const c=new (window.AudioContext||window.webkitAudioContext)(), o=c.createOscillator(), g=c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value=880; g.gain.value=0.15; o.start(); setTimeout(()=>{o.stop(); c.close();},350); }catch(e){} }
function notify(msg){
  toast(msg); if(settings.sound!==false) beep();
  try{ if(navigator.vibrate) navigator.vibrate(200); }catch(e){}
  try{
    if('Notification' in window&&Notification.permission==='granted'){
      const o={body:msg,icon:'icon-192.png',badge:'icon-192.png',tag:'ctb-alert'};
      if('serviceWorker' in navigator&&navigator.serviceWorker.controller) navigator.serviceWorker.ready.then(r=>r.showNotification('Smart Alert',o)).catch(()=>{});
      else new Notification('Smart Alert',o);
    }
  }catch(e){}
}
function normAlert(a){ if(!a.ex) a.ex='binance'; if(!a.type) a.type='price'; if(a.value===undefined) a.value=a.price; if(a.enabled===undefined) a.enabled=true; return a; }
function alertText(a){
  const tf=a.tf||'15m', sy=a.symbol+(a.ex==='bybit'?' [Bybit]':'');
  if(a.type==='ema') return `${sy} · EMA 9/21 (${tf}) ${a.condition==='bull'?'Bullish':'Bearish'} cross`;
  if(a.type==='smc') return `${sy} · SMC (${tf}) ${a.condition==='bull'?'Bullish':a.condition==='bear'?'Bearish':'যেকোনো'} BOS/CHoCH`;
  if(a.type==='fib') return `${sy} · Fib OTE (${tf}) ${a.condition==='bull'?'Long জোন':a.condition==='bear'?'Short জোন':'যেকোনো দিক'}`;
  if(a.type==='signal') return `${sy} · Autopilot ${a.condition==='long'?'LONG':a.condition==='short'?'SHORT':'READY'}`;
  const t={price:'Price',change:'24h %',rsi:`RSI(${tf})`}[a.type]||'Price';
  return `${sy} · ${t} ${a.condition==='above'?'≥ ':'≤ '}${a.type==='price'?fmtPrice(a.value):a.value}`;
}
function fireAlert(a,detail){
  const now=Date.now();
  if(a.repeat){ if(now-(a.lastFired||0)<900000) return; a.lastFired=now; } else a.triggered=true;
  const msg=`${alertText(a)} → ${detail}`; notify(msg);
  alertLog.unshift({t:now,m:msg}); alertLog=alertLog.slice(0,20);
  try{ localStorage.setItem('ctb-alertlog',JSON.stringify(alertLog)); }catch(e){}
  persist(); renderAlerts();
}
function checkAlerts(t){
  if(!alerts.length) return; alerts.forEach(normAlert);
  alerts.forEach(a=>{
    if(!a.enabled||a.triggered||a.symbol!==t.symbol||(a.ex||'binance')!==EX) return;
    if(a.type==='price'&&((a.condition==='above'&&t.lastPrice>=a.value)||(a.condition==='below'&&t.lastPrice<=a.value))) fireAlert(a,'$'+fmtPrice(t.lastPrice));
    else if(a.type==='change'&&Number.isFinite(t.change)&&((a.condition==='above'&&t.change>=a.value)||(a.condition==='below'&&t.change<=a.value))) fireAlert(a,fmtPct(t.change));
  });
}
async function checkIndicatorAlerts(){
  alerts.forEach(normAlert);
  const T=['rsi','ema','smc','fib'], act=alerts.filter(a=>a.enabled&&!a.triggered&&T.includes(a.type)); if(!act.length) return;
  const groups=new Map(); act.forEach(a=>{ const k=(a.ex||'binance')+'|'+a.symbol+'|'+(a.tf||'15m'); if(!groups.has(k)) groups.set(k,[]); groups.get(k).push(a); });
  for(const [k,list] of groups){
    const [ex,sym,tf]=k.split('|');
    try{
      const raw=await klines(sym,tf,200,ex), closed=raw.slice(0,-1), bar=closed[closed.length-1][0], closes=closed.map(c=>+c[4]);
      const rr=calcRSI(closes), e9=calcEMA(closes,9), e21=calcEMA(closes,21), p9=calcEMA(closes.slice(0,-1),9), p21=calcEMA(closes.slice(0,-1),21);
      const sm=(list.some(a=>a.type==='smc'||a.type==='fib')&&smcF)?smcF(raw):null;
      list.forEach(a=>{
        if(a.lastBar===bar) return;
        if(a.type==='smc'&&sm){ a.lastBar=bar; const ev=sm.event, first=a.lastEvent===undefined; const hit=!first&&ev!==a.lastEvent&&((a.condition==='bull'&&ev.startsWith('Bullish'))||(a.condition==='bear'&&ev.startsWith('Bearish'))||(a.condition==='any'&&ev!=='No Break')); a.lastEvent=ev; if(hit) fireAlert(a,ev); }
        else if(a.type==='fib'&&sm){ a.lastBar=bar; const st=sm.fib?fibStateF(sm.fib,sm.last):null, inz=!!(st&&st.ote)&&(a.condition==='any'||(a.condition==='bull')===sm.fib.bull), first=a.lastIn===undefined; const hit=!first&&inz&&!a.lastIn; a.lastIn=inz; if(hit) fireAlert(a,`OTE জোনে প্রবেশ ${(st.r*100).toFixed(0)}%`); }
        else if(a.type==='rsi'&&((a.condition==='above'&&rr>=a.value)||(a.condition==='below'&&rr<=a.value))){ a.lastBar=bar; fireAlert(a,'RSI '+rr.toFixed(1)); }
        else if(a.type==='ema'&&((a.condition==='bull'&&p9<=p21&&e9>e21)||(a.condition==='bear'&&p9>=p21&&e9<e21))){ a.lastBar=bar; fireAlert(a,a.condition==='bull'?'EMA 9 উপরে ক্রস':'EMA 9 নিচে ক্রস'); }
      });
    }catch(e){}
  }
}
/* ---------- Sockets ---------- */
let byTimer=null, byState=new Map();
function connectSocket(){ return EX==='bybit'?connectBybitSocket():connectBinanceSocket(); }
function connectBybitSocket(){
  clearTimeout(reconnectTimer); clearInterval(byTimer);
  try{ if(ws){ ws.onclose=null; ws.onmessage=null; ws.close(); } }catch(_){}
  const syms=[...new Set([...defaultPairs,...watchlist,selectedSymbol])]; wsSet=new Set(syms.map(s=>s.toLowerCase()+'@ticker')); byState=new Map();
  try{
    ws=new WebSocket('wss://stream.bybit.com/v5/public/linear');
    ws.onopen=()=>{
      for(let i=0;i<syms.length;i+=10) ws.send(JSON.stringify({op:'subscribe',args:syms.slice(i,i+10).map(s=>'tickers.'+s)}));
      byTimer=setInterval(()=>{ try{ ws.send('{"op":"ping"}'); }catch(e){} },20000);
      setStatus('binance-status','Connected (Bybit)'); setStatus('market-status','Live');
    };
    ws.onmessage=ev=>{
      if(EX!=='bybit') return;
      let m; try{m=JSON.parse(ev.data);}catch(_){return;}
      if(!m.topic||m.topic.indexOf('tickers.')!==0||!m.data) return;
      const s=m.data.symbol||m.topic.slice(8), st=byState.get(s)||{}; Object.assign(st,m.data); byState.set(s,st);
      if(st.lastPrice===undefined) return;
      const row={symbol:s,lastPrice:+st.lastPrice,change:+st.price24hPcnt*100,quoteVolume:+st.turnover24h};
      tickers.set(s,row); checkAlerts(row); scheduleRender();
    };
    ws.onerror=()=>setStatus('binance-status','Polling Active');
    ws.onclose=()=>{ clearInterval(byTimer); reconnectTimer=setTimeout(connectSocket,10000); };
  }catch(e){ setStatus('binance-status','Polling Active'); }
}
function connectBinanceSocket(){
  clearTimeout(reconnectTimer); clearInterval(byTimer);
  try{ if(ws){ws.onclose=null; ws.onmessage=null; ws.close();} }catch(_){}
  const streams=[...new Set([...defaultPairs,...watchlist,selectedSymbol].map(s=>s.toLowerCase()+'@ticker'))]; wsSet=new Set(streams);
  try{
    ws=new WebSocket('wss://fstream.binance.com/stream?streams='+streams.join('/'));
    ws.onopen=()=>{setStatus('binance-status','Connected (Futures)'); setStatus('market-status','Live');};
    ws.onmessage=ev=>{
      if(EX!=='binance') return;
      let m; try{m=JSON.parse(ev.data);}catch(_){return;}
      const d=m.data||m; if(!d||!d.s||!d.c) return;
      const row={symbol:d.s,lastPrice:+d.c,change:+d.P,quoteVolume:+d.q};
      tickers.set(row.symbol,row); checkAlerts(row); scheduleRender();
    };
    ws.onerror=()=>setStatus('binance-status','Polling Active');
    ws.onclose=()=>{reconnectTimer=setTimeout(connectSocket,10000);};
  }catch(e){ setStatus('binance-status','Polling Active'); }
}
async function fetchTickerRows(ex){
  if(ex==='bybit'){
    const r=await fetch('https://api.bybit.com/v5/market/tickers?category=linear',{cache:'no-store'}); if(!r.ok) throw 0;
    const j=await r.json(); if(j.retCode!==0||!j.result||!Array.isArray(j.result.list)) throw 0;
    return j.result.list.filter(t=>/USDT$/.test(t.symbol)&&!t.symbol.includes('-')).map(t=>({symbol:t.symbol,lastPrice:+t.lastPrice,change:+t.price24hPcnt*100,quoteVolume:+t.turnover24h}));
  }
  const r=await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr',{cache:'no-store'}); if(!r.ok) throw 0;
  return (await r.json()).filter(t=>t.symbol.endsWith('USDT')&&!t.symbol.includes('_')).map(t=>({symbol:t.symbol,lastPrice:+t.lastPrice,change:+t.priceChangePercent,quoteVolume:+t.quoteVolume}));
}
async function fetchMarket(){
  const ex=EX;
  try{
    const rows=await fetchTickerRows(ex); if(ex!==EX) return;
    marketRows=rows; marketRows.forEach(x=>{ tickers.set(x.symbol,x); checkAlerts(x); });
    $('sym-list').innerHTML=marketRows.map(t=>`<option value="${safe(t.symbol)}">`).join(''); if(!$('ai-price').value&&tickers.has(selectedSymbol)) $('ai-price').value=tickers.get(selectedSymbol).lastPrice;
    setStatus('binance-status',ex==='bybit'?'Live (Bybit)':'Live Futures Data'); setStatus('market-status','Active');
    renderMarketTable(); scheduleRender();
  }catch(e){ if(ex!==EX) return; setStatus('binance-status','ডেটা নেই',false); $('market-table').innerHTML='<tr><td colspan="5" class="empty">'+EXCH[ex].name+'-এর ডেটা পাওয়া যায়নি।</td></tr>'; }
}

/* ---------- Renderers ---------- */
function renderMiniCards(){
  $('mini-tickers').innerHTML=defaultPairs.map(s=>{const t=tickers.get(s); return `<button class="mini" data-symbol="${safe(s)}"><strong>${safe(s.replace('USDT','/USDT'))}</strong><div class="price">${t?'$'+fmtPrice(t.lastPrice):'—'}</div><div class="${t&&t.change>=0?'green':'red'} small">${t?fmtPct(t.change):'…'}</div></button>`;}).join('');
}
function renderWatchlist(){
  $('watchlist-cards').innerHTML=watchlist.map(s=>{const t=tickers.get(s); return `<div class="mini"><div style="display:flex;justify-content:space-between;gap:6px"><button data-symbol="${safe(s)}" style="padding:0;background:none;border:0;font-weight:700">${safe(s.replace('USDT','/USDT'))}</button><button data-remove-watch="${safe(s)}" style="padding:2px 7px">×</button></div><div class="price">${t?'$'+fmtPrice(t.lastPrice):'—'}</div><div class="${t&&t.change>=0?'green':'red'} small">${t?fmtPct(t.change):'…'}</div></div>`;}).join('')||'<div class="empty">Watchlist খালি।</div>';
}
function renderScanner(){
  const rows=[...tickers.values()].filter(t=>Number.isFinite(t.change));
  rows.sort((a,b)=>scannerMode==='gainers'?b.change-a.change:scannerMode==='losers'?a.change-b.change:b.quoteVolume-a.quoteVolume);
  $('scanner-results').innerHTML=rows.slice(0,10).map(t=>`<button class="mini" data-symbol="${safe(t.symbol)}"><strong>${safe(t.symbol.replace('USDT','/USDT'))}</strong><div class="price">$${fmtPrice(t.lastPrice)}</div><div class="${t.change>=0?'green':'red'} small">${fmtPct(t.change)}</div><div class="small muted">Vol $${(t.quoteVolume/1e6).toFixed(1)}M</div></button>`).join('')||'<div class="empty">অপেক্ষমাণ…</div>';
}
function renderMarketTable(){
  const q=$('market-search').value.trim().toUpperCase().replace('/','');
  let rows=marketRows.filter(t=>t.symbol.includes(q)); const s=$('market-sort').value;
  rows.sort((a,b)=>s==='change-desc'?b.change-a.change:s==='change-asc'?a.change-b.change:b.quoteVolume-a.quoteVolume);
  rows=rows.slice(0,Number($('market-limit').value)||50); $('market-count').textContent=rows.length+' symbols';
  $('market-table').innerHTML=rows.map(t=>`<tr><td><button data-symbol="${safe(t.symbol)}" style="padding:0;border:0;background:none;font-weight:700">${safe(t.symbol.replace('USDT','/USDT'))}</button></td><td>$${fmtPrice(t.lastPrice)}</td><td class="${t.change>=0?'green':'red'}">${fmtPct(t.change)}</td><td>$${(t.quoteVolume/1e6).toFixed(1)}M</td><td><button data-symbol="${safe(t.symbol)}">Chart</button> <button data-add-watch="${safe(t.symbol)}">+ Watch</button></td></tr>`).join('')||'<tr><td colspan="5" class="empty">নেই।</td></tr>';
}
function renderJournal(){
  const bal=effectiveBalance();
  const st=journalStatsF&&bal>0?journalStatsF(journal,bal):null;
  const kpi=(label,v,cls)=>{cls=cls||'';return `<div class="result"><span>${label}</span><b class="${cls}">${v}</b></div>`;};
  if(st){
    $('journal-kpi').innerHTML=
      kpi('Trades',st.n)+
      kpi('Win Rate',st.winRate.toFixed(1)+'%',st.winRate>=50?'green':'red')+
      kpi('Total P&L',fmtMoney(st.totalPnl),st.totalPnl>=0?'green':'red')+
      kpi('Profit Factor',Number.isFinite(st.profitFactor)?st.profitFactor.toFixed(2):'∞',st.profitFactor>=1.5?'green':st.profitFactor>=1?'yellow':'red')+
      kpi('Expectancy',fmtMoney(st.expectancy),st.expectancy>=0?'green':'red')+
      kpi('Max DD',fmtMoney(st.maxDD)+' ('+st.maxDDpct.toFixed(1)+'%)','red')+
      kpi('Loss Streak',st.maxLossStreak)+
      kpi('Avg R',st.avgR!==null?st.avgR.toFixed(2):'—');
    const tagRow=(obj,label)=>{ const ks=Object.keys(obj); if(!ks.length) return '';
      return `<div class="result" style="grid-column:1/-1;text-align:left"><span>${label}</span><div class="small">`+
        ks.map(k=>`${safe(k)}: ${obj[k].n} trades · WR ${(obj[k].wins/obj[k].n*100).toFixed(0)}% · PnL ${fmtMoney(obj[k].pnl)}`).join('<br>')+'</div></div>'; };
    $('journal-breakdown-setup').innerHTML=tagRow(st.bySetup,'Setup-wise')+tagRow(st.bySession,'Session-wise')+tagRow(st.bySymbol,'Symbol-wise');
  } else {
    const pnl=journal.reduce((s,t)=>s+Number(t.pnl||0),0), wins=journal.filter(t=>t.pnl>0).length, losses=journal.filter(t=>t.pnl<0).length;
    $('journal-kpi').innerHTML=kpi('Trades',journal.length)+kpi('Win Rate',(journal.length?wins/journal.length*100:0).toFixed(1)+'%')+kpi('Total P&L',fmtMoney(pnl))+kpi('Wins/Losses',wins+'/'+losses);
    $('journal-breakdown-setup').innerHTML='';
  }
  $('journal-table').innerHTML=journal.slice().reverse().map(t=>`<tr><td>${safe(t.date)}</td><td>${safe(t.symbol)}${t.ex==='bybit'?' (Bybit)':''}</td><td>${safe(t.side)}</td><td>${safe(t.setup||'—')}</td><td class="${t.open?'muted':t.pnl>=0?'green':'red'}">${t.open?'open':fmtMoney(t.pnl)}</td><td><button data-delete-trade="${safe(t.id)}">×</button></td></tr>`).join('')||'<tr><td colspan="6" class="empty">কোনো ট্রেড নেই।</td></tr>';
}
function renderAlerts(){
  alerts.forEach(normAlert);
  $('alerts-list').innerHTML=alerts.map(a=>`<div class="mini" style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px"><div><strong>${safe(alertText(a))}</strong><div class="small ${a.triggered?'yellow':a.enabled?'muted':'red'}">${a.triggered?'Triggered ✓':!a.enabled?'Paused':a.repeat?'Repeat (১৫ মিনিট)':'Waiting'}</div></div><div class="button-row"><button data-toggle-alert="${safe(a.id)}">${a.triggered?'Re-arm':a.enabled?'Pause':'Resume'}</button><button data-delete-alert="${safe(a.id)}">Delete</button></div></div>`).join('')||'<div class="empty">কোনো alert নেই।</div>';
  $('alert-log').innerHTML=alertLog.slice(0,10).map(x=>`<div class="small muted">${new Date(x.t).toLocaleString()} · ${safe(x.m)}</div>`).join('')||'<div class="small muted">এখনও কিছু ট্রিগার হয়নি।</div>';
}
function updateAlertForm(){
  const t=$('alert-type').value, c=$('alert-condition');
  c.innerHTML=t==='ema'?'<option value="bull">Bullish cross (EMA 9 উপরে)</option><option value="bear">Bearish cross (EMA 9 নিচে)</option>':t==='smc'?'<option value="bull">Bullish BOS/CHoCH</option><option value="bear">Bearish BOS/CHoCH</option><option value="any">যেকোনো</option>':t==='fib'?'<option value="bull">Long জোন (Bullish leg)</option><option value="bear">Short জোন (Bearish leg)</option><option value="any">যেকোনো দিক</option>':t==='signal'?'<option value="ready">READY (any)</option><option value="long">LONG only</option><option value="short">SHORT only</option>':'<option value="above">Above or Equal</option><option value="below">Below or Equal</option>';
  $('alert-val-wrap').style.display=['ema','smc','fib','signal'].includes(t)?'none':''; $('alert-tf-wrap').style.display=(t==='price'||t==='change'||t==='signal')?'none':'';
  $('alert-val-label').textContent=t==='price'?'Target Price':t==='change'?'24h Change (%)':'RSI মান (০–১০০)';
}
let deferredInstall=null;
function setupPWA(){
  const btn=$('install-btn'), standalone=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone;
  const ios=/iphone|ipad|ipod/i.test(navigator.userAgent)&&!window.MSStream;
  window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); deferredInstall=e; if(!standalone) btn.style.display=''; });
  window.addEventListener('appinstalled',()=>{ deferredInstall=null; btn.style.display='none'; toast('অ্যাপ ইনস্টল হয়েছে।'); });
  if(ios&&!standalone) btn.style.display='';
  btn.addEventListener('click',async()=>{
    if(deferredInstall){ deferredInstall.prompt(); try{ await deferredInstall.userChoice; }catch(e){} deferredInstall=null; btn.style.display='none'; }
    else toast('iPhone/iPad: Safari-র Share বাটন চেপে "Add to Home Screen" বেছে নিন।');
  });
  if('serviceWorker' in navigator&&location.protocol!=='file:'){
    navigator.serviceWorker.register('sw.js').then(reg=>{
      reg.addEventListener('updatefound',()=>{ const nw=reg.installing; if(nw) nw.addEventListener('statechange',()=>{ if(nw.state==='installed'&&navigator.serviceWorker.controller) toast('নতুন সংস্করণ এসেছে, পেজ রিলোড করুন।'); }); });
    }).catch(()=>{});
  }
}
function applyExchangeLabels(){
  document.querySelectorAll('.ex-name').forEach(e=>{ e.textContent=EXCH[EX].name; });
  const n=$('tr-exnote');
  if(n){ if(EX==='bybit'){ n.style.display=''; n.textContent='Bybit: আগে Demo বা Testnet-এ যাচাই করুন। LIVE-এর জন্য লাগবে: Isolated Margin Mode, One-way পজিশন মোড, আর API Key-তে শুধু Contract Trade অনুমতি (Withdraw বন্ধ)। IP না বাঁধা Key-র মেয়াদ প্রায় ৩ মাস।'; } else n.style.display='none'; }
  const s=$('ex-select'); if(s) s.value=EX;
  fillTrEnv(); lastRisk=null; lastLiveEnabled=null; trStatus(); syncBalanceUI(); renderRiskWarnings(); renderCalcWarnings();
}
function switchExchange(v){
  if(!EXCH[v]||v===EX) return;
  EX=v; settings.exchange=v; persist();
  tickers.clear(); marketRows=[]; lastSMC=null; lastMTF=null; lastFund=null; tvKey='';
  applyExchangeLabels(); ['tr-bal','tr-avail','tr-count'].forEach(i=>{ const e=$(i); if(e) e.textContent='—'; }); $('tr-table').innerHTML='<tr><td colspan="6" class="empty">Refresh চাপুন।</td></tr>'; if(user&&$('trade-panel').style.display!=='none') refreshTrade(); setStatus('binance-status','সংযোগ হচ্ছে…'); setStatus('market-status','সংযোগ হচ্ছে…');
  $('market-table').innerHTML='<tr><td colspan="5" class="empty">ডেটা আসছে…</td></tr>';
  wsSet=new Set(); connectSocket(); fetchMarket(); selectSymbol(selectedSymbol);
  toast('Exchange: '+EXCH[EX].name);
}
function setupExchange(){ $('ex-select').addEventListener('change',e=>switchExchange(e.target.value)); applyExchangeLabels(); }
/* ---------- Workspaces: show one group of panels at a time ---------- */
const WS=[{id:'market',ic:'📊',bn:'মার্কেট'},{id:'analysis',ic:'🔬',bn:'বিশ্লেষণ'},{id:'trade',ic:'⚡',bn:'ট্রেড'},{id:'review',ic:'📒',bn:'রিভিউ'},{id:'settings',ic:'⚙️',bn:'সেটিংস'}];
let curWs='market';
function renderWsChips(){
  const box=$('ws-chips'); if(!box) return;
  const items=[]; document.querySelectorAll('.nav').forEach(b=>{ if(b.dataset&&b.dataset.ws===curWs&&b.style.display!=='none') items.push([b.dataset.target,(b.title||b.textContent||'').trim()]); });
  box.innerHTML=items.length>1?items.map(x=>`<button type="button" data-goto="${safe(x[0])}">${safe(x[1])}</button>`).join(''):'';
}
function applyWorkspace(ws,toTop){
  if(!WS.some(w=>w.id===ws)) ws='market';
  curWs=ws; try{ localStorage.setItem('ctb-ws',ws); }catch(e){}
  document.querySelectorAll('[data-ws]').forEach(el=>el.classList.toggle('ws-off',el.dataset.ws!==ws));
  document.querySelectorAll('[data-wsbtn]').forEach(b=>b.classList.toggle('active',b.dataset.wsbtn===ws));
  let first=true; document.querySelectorAll('.nav').forEach(b=>{ const vis=b.dataset&&b.dataset.ws===ws&&b.style.display!=='none'; b.classList.toggle('active',vis&&first); if(vis) first=false; });
  renderWsChips();
  if(toTop&&window.scrollTo) window.scrollTo({top:0,behavior:'smooth'});
}
function goPanel(id){   // jump to a panel, switching workspace (and opening a folded card) when needed
  const el=$(id); if(!el) return;
  const w=el.dataset&&el.dataset.ws; if(w&&w!==curWs) applyWorkspace(w,false);
  if(el.classList&&el.classList.contains('collapsed')&&el.firstElementChild) el.firstElementChild.click();
  el.scrollIntoView({behavior:'smooth'});
}
function setupCollapsible(){
  let st={}; try{ st=JSON.parse(localStorage.getItem('ctb-collapsed')||'{}')||{}; }catch(e){}
  const DEF={'fib-tools':true,'funding-oi':true,'backtest':true};   // advanced cards start folded
  document.querySelectorAll('section.panel[data-ws]').forEach(sec=>{
    const head=sec.firstElementChild; if(!head) return;
    const folded=(sec.id in st)?!!st[sec.id]:!!DEF[sec.id];
    sec.classList.toggle('collapsed',folded); head.classList.add('collapsible-head');
    const h=head.querySelector('h2'); if(h){ const c=document.createElement('span'); c.className='chev'; c.textContent=folded?'▸ ':'▾ '; h.prepend(c); }
    head.addEventListener('click',e=>{
      if(e.target&&e.target.closest&&e.target.closest('button,select,input,a,label')) return;
      const now=!sec.classList.contains('collapsed'); sec.classList.toggle('collapsed',now);
      const ch=head.querySelector('.chev'); if(ch) ch.textContent=now?'▸ ':'▾ ';
      st[sec.id]=now; try{ localStorage.setItem('ctb-collapsed',JSON.stringify(st)); }catch(err){}
    });
  });
}
function setupWorkspaces(){
  const mk=cls=>WS.map(w=>`<button type="button" class="${cls}" data-wsbtn="${w.id}" title="${safe(w.bn)}"><span class="ni">${w.ic}</span><span class="nt">${safe(w.bn)}</span></button>`).join('');
  $('ws-nav').innerHTML=mk('wsb'); $('ws-bar').innerHTML=mk('wsbb');
  [$('ws-nav'),$('ws-bar')].forEach(box=>box.addEventListener('click',e=>{
    const b=e.target.closest&&e.target.closest('[data-wsbtn]'); if(!b) return;
    applyWorkspace(b.dataset.wsbtn,true); const sb=document.querySelector('.sidebar'); if(sb) sb.classList.remove('open');
  }));
  $('ws-chips').addEventListener('click',e=>{ const b=e.target.closest&&e.target.closest('[data-goto]'); if(b) goPanel(b.dataset.goto); });
  setupCollapsible();
  let saved='market'; try{ saved=localStorage.getItem('ctb-ws')||'market'; }catch(e){}
  applyWorkspace(saved,false);
}

function setupNav(){
  document.querySelectorAll('.nav').forEach(b=>{
    const sp=b.querySelector('span'), t=sp.textContent.trim(), i=t.indexOf(' '), ic=i>0?t.slice(0,i):t.slice(0,1), rest=i>0?t.slice(i+1):'';
    b.title=rest||t; sp.innerHTML='<span class="ni"></span> <span class="nt"></span>'; sp.querySelector('.ni').textContent=ic; sp.querySelector('.nt').textContent=rest;
  });
  const lay=document.querySelector('.layout'), sb=document.querySelector('.sidebar'), mob=()=>window.matchMedia('(max-width:1100px)').matches;
  try{ if(localStorage.getItem('ctb-rail')==='1') lay.classList.add('rail'); }catch(e){}
  $('nav-toggle').addEventListener('click',()=>{ if(mob()) sb.classList.toggle('open'); else { lay.classList.toggle('rail'); try{ localStorage.setItem('ctb-rail',lay.classList.contains('rail')?'1':'0'); }catch(e){} } });
  sb.addEventListener('click',e=>{ if(mob()&&e.target.closest('.nav')) sb.classList.remove('open'); });
}
function setupAlerts(){
  updateAlertForm(); $('alert-type').addEventListener('change',updateAlertForm);
  $('alert-sound').checked=settings.sound!==false; $('alert-sound').addEventListener('change',e=>{ settings.sound=e.target.checked; persist(); });
  $('alert-test').addEventListener('click',()=>notify('🔔 টেস্ট অ্যালার্ট: সব ঠিক আছে'));
  $('alert-notif').addEventListener('click',async()=>{
    if(!('Notification' in window)) return toast('এই ব্রাউজারে নোটিফিকেশন সাপোর্ট নেই।');
    const p=await Notification.requestPermission(); toast(p==='granted'?'নোটিফিকেশন চালু হয়েছে।':'নোটিফিকেশন অনুমতি দেওয়া হয়নি।');
  });
  $('alert-add').addEventListener('click',()=>{
    const type=$('alert-type').value, cond=$('alert-condition').value, raw=$('alert-price').value, v=+raw;
    if(!['ema','smc','fib','signal'].includes(type)){ if(raw===''||!Number.isFinite(v)) return toast('সঠিক মান দিন।'); if(type==='price'&&!(v>0)) return toast('সঠিক প্রাইস দিন।'); if(type==='rsi'&&(v<=0||v>=100)) return toast('RSI মান ০–১০০ এর মধ্যে দিন।'); }
    alerts.push({id:Date.now(),symbol:selectedSymbol,ex:EX,type,condition:cond,value:['ema','smc','fib','signal'].includes(type)?0:v,tf:$('alert-tf').value,repeat:$('alert-repeat').checked,enabled:true,triggered:false});
    persist(); renderAlerts(); $('alert-price').value=''; toast('অ্যালার্ট তৈরি হয়েছে: '+alertText(alerts[alerts.length-1]));
  });
}

/* ---------- MTF / SMC / Funding ---------- */
async function runMTF(){
  const sym=normSymbol($('mtf-symbol').value), tfs=['5m','15m','1h','4h'], g=++mtfGen;
  tfs.forEach(tf=>{$('mtf-'+tf).textContent='যাচাই…'; $('mtf-'+tf).className='';});
  const res=await Promise.all(tfs.map(async tf=>{
    try{
      const closes=(await klines(sym,tf,100)).map(c=>+c[4]), e9=calcEMA(closes,9), e21=calcEMA(closes,21), p=closes[closes.length-1];
      const s=p>e9&&e9>e21?'Bullish':p<e9&&e9<e21?'Bearish':'Neutral';
      if(g!==mtfGen) return 'Stale';
      const el=$('mtf-'+tf); el.textContent=s; el.className=s==='Bullish'?'green':s==='Bearish'?'red':'muted'; return s;
    }catch(e){ $('mtf-'+tf).textContent='Error'; return 'Error'; }
  }));
  if(g!==mtfGen) return lastMTF;
  const bu=res.filter(x=>x==='Bullish').length, be=res.filter(x=>x==='Bearish').length, el=$('mtf-summary');
  if(bu===4){el.textContent='শক্তিশালী কনফ্লুয়েন্স: সব টাইমফ্রেম বুলিশ!'; el.className='notice green';}
  else if(be===4){el.textContent='শক্তিশালী কনফ্লুয়েন্স: সব টাইমফ্রেম বেয়ারিশ!'; el.className='notice red';}
  else {el.textContent=`মিশ্র ট্রেন্ড (${bu} Bullish, ${be} Bearish)। সাবধানে ট্রেড করুন।`; el.className='notice';}
  const badTf=x=>x==='Error'||x==='Stale';
  lastMTF={sym,bu,be,partial:res.some(badTf),per:Object.fromEntries(tfs.map((t,i)=>[t,badTf(res[i])?'Neutral':res[i]]))}; return lastMTF;
}
function liqVolHtml(a){
  if(!a.liq||!a.vol) return '<br><span class="muted">Liquidity/Volume: ডেটা কম</span>'; const f=fmtPrice, l=a.liq, v=a.vol;
  const sw=l.sweeps.length?l.sweeps.map(s=>`${s.bias==='bear'?'🔴':'🟢'} ${s.type} sweep $${f(s.level)} (${s.ago===0?'শেষ ক্যান্ডেলে':s.ago+' ক্যান্ডেল আগে'}, উইক ${s.wick.toFixed(2)}%)`).join('<br>'):'নেই';
  const tt=l.turtle?`${l.turtle.dir==='bear'?'🔴 Short':'🟢 Long'} জোন · ব্যর্থ ব্রেক $${f(l.turtle.level)}`:'নেই';
  const as=l.asia?`$${f(l.asia.lo)} – $${f(l.asia.hi)} · স্যুইপ: ${l.asia.sweep==='high'?'🔴 উপরে':l.asia.sweep==='low'?'🟢 নিচে':'এখনও নেই'}`:'প্রযোজ্য নয়';
  const vt=v.ratio===null?'ডেটা নেই':`×${v.ratio.toFixed(1)} গড়ের ${v.spike?'🔥 Spike':'(সাধারণ)'}`;
  return `<br><b>Liquidity:</b> BSL $${f(l.bsl)} | SSL $${f(l.ssl)}<br><b>Sweep:</b> ${sw}<br><b>Turtle Soup:</b> ${tt}<br><b>Asia রেঞ্জ:</b> ${as}<br><b>Volume:</b> ${vt}`;
}
function renderFib(){
  const o=$('fib-output'); if(!o) return; const a=lastSMC;
  if(!a||a.sym!==selectedSymbol){ o.textContent='অপেক্ষমাণ…'; return; }
  if(!a.fib){ o.textContent='পর্যাপ্ত swing ডেটা নেই।'; return; }
  const f=a.fib, t=tickers.get(selectedSymbol), price=t?t.lastPrice:a.last, st=fibStateF?fibStateF(f,price):null;
  const rows=[0.382,0.5,0.618,0.786].map(r=>`<tr><td>${r}</td><td>$${fmtPrice(fibPxF(f,r))}</td></tr>`).join('')+[1.272,1.618].map(r=>`<tr><td>Extension ${r}</td><td>$${fmtPrice(fibExtF(f,r))}</td></tr>`).join('');
  o.innerHTML=`<b>${safe(a.sym)} (${safe(a.tf)})</b> · Leg: <b class="${f.bull?'green':'red'}">${f.bull?'Bullish':'Bearish'}</b><br>Swing High $${fmtPrice(f.hi)} · Low $${fmtPrice(f.lo)}<br>এখন $${fmtPrice(price)}${st?` · রিট্রেসমেন্ট ${(st.r*100).toFixed(1)}% · <b class="${st.fav?'green':'yellow'}">${st.zone}</b>`:''}<div class="table-wrap"><table><thead><tr><th>Level</th><th>Price</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
async function runFibScan(){
  const out=$('fib-scan-out'), tf=selectedInterval, syms=[...new Set([...watchlist,...defaultPairs])].slice(0,15), rows=[];
  out.innerHTML='<div class="empty">স্ক্যান চলছে…</div>';
  if(!smcF){ out.innerHTML='<div class="empty">analysis.js লোড হয়নি।</div>'; return; }
  for(let i=0;i<syms.length;i+=5){
    await Promise.all(syms.slice(i,i+5).map(async s=>{ try{ const a=smcF(await klines(s,tf,200)); if(!a.fib) return; const t=tickers.get(s), st=fibStateF(a.fib,t?t.lastPrice:a.last); if(st.fav) rows.push({s,bull:a.fib.bull,st}); }catch(e){} }));
  }
  out.innerHTML=rows.map(x=>`<button class="mini" data-symbol="${safe(x.s)}"><strong>${safe(x.s.replace('USDT','/USDT'))}</strong><div class="${x.bull?'green':'red'} small">${x.bull?'Long':'Short'} জোন</div><div class="small muted">${x.st.zone}</div></button>`).join('')||`<div class="empty">${safe(tf)}-এ কোনো OTE জোনে নেই।</div>`;
}
async function runSMC(){
  const sym=normSymbol($('smc-auto-symbol').value), tf=$('smc-auto-tf').value, out=$('smc-auto-output'), g=++smcGen;
  out.textContent='বিশ্লেষণ চলছে…'; out.className='notice';
  if(!smcF){ out.textContent='analysis.js লোড হয়নি।'; return; }
  try{
    const a=smcF(await klines(sym,tf,200)); if(g!==smcGen) return; lastSMC={sym,tf,...a}; renderFib(); const f=fmtPrice;
    out.innerHTML=`<b>${safe(sym)} (${safe(tf)})</b><br><b>Structure:</b> ${a.trend>0?'Bullish':a.trend<0?'Bearish':'Range'}<br><b>Event:</b> ${a.event}<br><b>Swing High:</b> $${f(a.sh)} | <b>Low:</b> $${f(a.sl)}<br><b>Order Block:</b> ${a.ob?`${a.ob.dir==='bull'?'Bullish':'Bearish'} $${f(a.ob.lo)} – $${f(a.ob.hi)}`:'নেই'}<br><b>FVG:</b> ${a.fvgs.length?a.fvgs.map(g=>`${g.dir==='bull'?'🟢':'🔴'} $${f(g.lo)}–$${f(g.hi)}`).join(' | '):'নেই'}`;
    out.innerHTML+=liqVolHtml(a);
    out.className='notice '+(a.event.startsWith('Bullish')?'green':a.event.startsWith('Bearish')?'red':'');
  }catch(e){ out.textContent='ডেটা ফেচ ব্যর্থ।'; lastSMC=null; }
}
async function fundingData(sym,ex){
  const o={rate:NaN,hours:8,next:NaN,mark:NaN,oiCoin:NaN,oiUsd:NaN,oi1h:NaN,oi24h:NaN,ratio:NaN,longPct:NaN,shortPct:NaN}, s=encodeURIComponent(sym);
  const j=async u=>{const r=await fetch(u); if(!r.ok) throw 0; return r.json();};
  if(ex==='bybit'){
    const B='https://api.bybit.com/v5/market/';
    const [tk,hi,ls]=await Promise.allSettled([j(B+'tickers?category=linear&symbol='+s),j(B+'open-interest?category=linear&symbol='+s+'&intervalTime=1h&limit=25'),j(B+'account-ratio?category=linear&symbol='+s+'&period=1h&limit=1')]);
    if(tk.status==='fulfilled'&&tk.value.retCode===0&&tk.value.result.list[0]){ const d=tk.value.result.list[0]; o.rate=+d.fundingRate*100; o.hours=+d.fundingIntervalHour||8; o.next=+d.nextFundingTime; o.mark=+d.markPrice; o.oiCoin=+d.openInterest; o.oiUsd=+d.openInterestValue; }
    if(hi.status==='fulfilled'&&hi.value.retCode===0){ const L=hi.value.result.list, v=x=>+x.openInterest; if(L.length>2){ o.oi1h=(v(L[0])/v(L[1])-1)*100; o.oi24h=(v(L[0])/v(L[L.length-1])-1)*100; } }
    if(ls.status==='fulfilled'&&ls.value.retCode===0&&ls.value.result.list[0]){ const d=ls.value.result.list[0]; o.longPct=+d.buyRatio*100; o.shortPct=+d.sellRatio*100; o.ratio=+d.buyRatio/+d.sellRatio; }
    return o;
  }
  const B='https://fapi.binance.com';
  const [pi,oi,hi,ls]=await Promise.allSettled([j(B+'/fapi/v1/premiumIndex?symbol='+s),j(B+'/fapi/v1/openInterest?symbol='+s),j(B+'/futures/data/openInterestHist?symbol='+s+'&period=1h&limit=25'),j(B+'/futures/data/globalLongShortAccountRatio?symbol='+s+'&period=1h&limit=1')]);
  if(pi.status==='fulfilled'){ const d=pi.value; o.rate=+d.lastFundingRate*100; o.next=+d.nextFundingTime; o.mark=+d.markPrice; }
  if(oi.status==='fulfilled'&&Number.isFinite(o.mark)){ o.oiCoin=+oi.value.openInterest; o.oiUsd=o.oiCoin*o.mark; }
  if(hi.status==='fulfilled'&&hi.value.length>2){ const h=hi.value, v=x=>+x.sumOpenInterestValue, l=v(h[h.length-1]); o.oi1h=(l/v(h[h.length-2])-1)*100; o.oi24h=(l/v(h[0])-1)*100; }
  if(ls.status==='fulfilled'&&ls.value[0]){ const d=ls.value[0]; o.ratio=+d.longShortRatio; o.longPct=+d.longAccount*100; o.shortPct=+d.shortAccount*100; }
  return o;
}
async function runFunding(){
  const sym=selectedSymbol, ex=EX, o={sym,ex,rate:NaN,oi1h:NaN,oi24h:NaN};
  let d=null; try{ d=await fundingData(sym,ex); }catch(e){}
  if(sym!==selectedSymbol||ex!==EX) return;
  d=d||{}; const set=(id,t,c='')=>{const e=$(id); if(e){e.textContent=t; e.className=c;}}, hrs=d.hours||8;
  if(Number.isFinite(d.rate)){
    o.rate=d.rate*(8/hrs);
    set('fund-rate',d.rate.toFixed(4)+'%',Math.abs(o.rate)>0.05?'yellow':'');
    set('fund-note',(d.rate>0?'লং → শর্টকে ফি':d.rate<0?'শর্ট → লংকে ফি':'')+(hrs!==8?' · প্রতি '+hrs+' ঘণ্টা':''),'small muted');
    const ms=d.next-Date.now(); set('fund-next',Number.isFinite(ms)?`${Math.max(0,Math.floor(ms/3.6e6))}h ${Math.max(0,Math.floor(ms%3.6e6/6e4))}m`:'—');
    set('fund-mark',Number.isFinite(d.mark)?'$'+fmtPrice(d.mark):'—');
  } else ['fund-rate','fund-next','fund-mark'].forEach(i=>set(i,'—'));
  if(Number.isFinite(d.oiUsd)){ set('oi-usd','$'+(d.oiUsd/1e6).toFixed(1)+'M'); set('oi-coin',d.oiCoin.toLocaleString()+' coin','small muted'); } else set('oi-usd','—');
  const cl=v=>Number.isFinite(v)?(v>=0?'green':'red'):''; o.oi1h=d.oi1h; o.oi24h=d.oi24h;
  set('oi-1h',Number.isFinite(o.oi1h)?fmtPct(o.oi1h):'—',cl(o.oi1h)); set('oi-24h',Number.isFinite(o.oi24h)?fmtPct(o.oi24h):'—',cl(o.oi24h));
  if(Number.isFinite(d.ratio)){ set('ls-ratio',d.ratio.toFixed(2)); set('ls-note',`Long ${d.longPct.toFixed(1)}% / Short ${d.shortPct.toFixed(1)}%`,'small muted'); } else set('ls-ratio','—');
  lastFund=o; return o;
}

/* ---------- Signal HTML ---------- */
const SIG = CTB.SIG || {minReady:70,minWatch:50,minRR:1.5,minSlPct:0.3,maxSlPct:8,nearPct:0.4,conflict:8};
const SIG_MAX = CTB.SIG_MAX || {mtf:20,ema:15,smc:20,liq:15,vol:10,entry:10,rr:10};
function signalHtml(s){
  const f=fmtPrice, col=s.status==='READY'?'green':s.status==='WATCH'?'yellow':'muted', dcol=s.dir==='LONG'?'green':s.dir==='SHORT'?'red':'muted';
  const lbl={mtf:'Multi-TF Trend',ema:'EMA Confluence',smc:'SMC Structure',liq:'Liquidity',vol:'Volume/Momentum',entry:'Entry Quality',rr:'Risk/Reward'};
  const best=s.dir==='SHORT'?s.short:s.long;
  let h=`<div class="scenario" style="margin-top:12px;border-top:3px solid var(--yellow)"><h3 style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><span>🎯 Signal Engine v1</span><span class="${col}">${safe(s.status)}${s.dir?' · <b class="'+dcol+'">'+safe(s.dir)+'</b>':''}</span></h3>`;
  h+=`<div class="small muted">LONG ${s.long.score}/100 · SHORT ${s.short.score}/100</div><div style="height:8px;border-radius:5px;background:var(--line);margin:6px 0 10px;overflow:hidden"><div style="height:100%;width:${Math.max(0,Math.min(100,s.score))}%;background:var(--${s.status==='READY'?'green':'yellow'})"></div></div>`;
  h+=`<b>স্কোর ${s.score}/100</b> (${safe(s.dir||'কোনো দিক নেই')}): `+Object.keys(lbl).map(k=>`${lbl[k]} ${best.parts[k]}/${SIG_MAX[k]}`).join(' · ');
  if(s.plan){ const p=s.plan;
    h+=`<p style="margin:10px 0 4px"><b>Entry Zone:</b> $${f(p.zone.lo)} – $${f(p.zone.hi)} <span class="muted">(${safe(p.zone.src)})</span><br><b>Entry:</b> $${f(p.entry)} · <b>SL:</b> $${f(p.sl)} <span class="muted">(${p.slPct.toFixed(2)}%)</span><br><b>TP1:</b> $${f(p.tps[0])} (${p.rr[0].toFixed(1)}R) · <b>TP2:</b> $${f(p.tps[1])} (${p.rr[1].toFixed(1)}R) · <b>TP3:</b> $${f(p.tps[2])} (${p.rr[2].toFixed(1)}R)</p>`;
  } else h+='<p class="muted" style="margin:10px 0 4px">কোনো স্পষ্ট সেটআপ বা দিক নেই।</p>';
  h+='<div class="small" style="margin:6px 0"><b>Risk Gate:</b><br>'+s.gate.checks.map(c=>`${c.ok?'✅':'❌'} ${safe(c.t)}`).join('<br>')+'</div>';
  if(s.notes.length) h+='<div class="small yellow" style="margin:6px 0">'+s.notes.map(safe).join('<br>')+'</div>';
  if(s.invalidation) h+=`<div class="small muted" style="margin:6px 0"><b>বাতিলের শর্ত:</b> ${safe(s.invalidation)}</div>`;
  if(s.plan) h+=`<button class="${s.dir==='LONG'?'button-primary':'button-danger'}" data-send="${s.dir==='LONG'?'long':'short'}" data-sl="${s.plan.sl}" data-entry="${s.plan.entry}" data-tp="${s.plan.tps[1]}" style="font-size:11px;padding:4px 8px;margin-top:4px">Send to Calculator ↗ (TP2)</button>`;
  h+='<div class="notice">স্কোর নিয়মভিত্তিক, জয়ের সম্ভাবনা নয়।</div></div>';
  return h;
}
async function buildAI(){
  const symbol=normSymbol($('ai-symbol').value||selectedSymbol), tf=$('ai-timeframe').value, notes=$('ai-notes').value.trim();
  $('ai-output').innerHTML='<div class="warning">স্ক্যান চলছে…</div>';
  if(!lastSMC||lastSMC.sym!==symbol||lastSMC.tf!==tf) await runSMC();
  if(!lastMTF||lastMTF.sym!==symbol) await runMTF();
  if(!lastFund||lastFund.sym!==symbol) await runFunding();
  let price=tickers.has(symbol)?tickers.get(symbol).lastPrice:0, sup=+$('ai-support').value, res=+$('ai-resistance').value;
  let rr=50,e9=NaN,e21=NaN,e50=NaN,e200=NaN,fresh={ok:false,msg:'ক্যান্ডেল ডেটা নেই'};
  try{
    const c=await klines(symbol,tf,300), hi=c.map(x=>+x[2]), lo=c.map(x=>+x[3]), cl=c.map(x=>+x[4]);
    if(!(price>0)){price=cl[cl.length-1]; $('ai-price').value=price;}
    if(!(sup>0)){sup=Math.min(...lo.slice(-50)); $('ai-support').value=sup;}
    if(!(res>0)){res=Math.max(...hi.slice(-50)); $('ai-resistance').value=res;}
    rr=calcRSI(cl); e9=calcEMA(cl,9); e21=calcEMA(cl,21); e50=calcEMA(cl,50); e200=calcEMA(cl,200);
    const iv=(+c[1][0])-(+c[0][0]), age=Date.now()-(+c[c.length-1][0]); fresh=age<2.2*iv?{ok:true}:{ok:false,msg:`শেষ ক্যান্ডেল ${Math.round(age/60000)} মিনিট পুরোনো`};
  }catch(e){}
  if(!(price>0)){ $('ai-output').innerHTML='<div class="warning">প্রাইস পাওয়া যায়নি।</div>'; return; }
  if(symbol!==selectedSymbol||tf!==selectedInterval) return;
  const sm=lastSMC&&lastSMC.sym===symbol&&lastSMC.tf===tf?lastSMC:null, mt=lastMTF&&lastMTF.sym===symbol?lastMTF:null, fu=lastFund&&lastFund.sym===symbol?lastFund:null;
  const trend=price>e9&&e9>e21?'Bullish':price<e9&&e9<e21?'Bearish':'Mixed';
  const rsiTxt=rr>70?'Overbought ⚠️':rr<30?'Oversold 🟢':'Neutral';
  let score=0; const why=[]; const add=(v,t)=>{score+=v; why.push(`${v>0?'+':''}${v} · ${t}`);};
  if(trend==='Bullish') add(1,'EMA বুলিশ'); else if(trend==='Bearish') add(-1,'EMA বেয়ারিশ');
  if(rr>70) add(-0.5,'RSI OB'); else if(rr<30) add(0.5,'RSI OS');
  if(mt&&mt.bu!==mt.be) add((mt.bu-mt.be)/2,`MTF: ${mt.bu} Bullish / ${mt.be} Bearish`);
  if(sm){ if(sm.event.startsWith('Bullish')) add(1.5,'SMC '+sm.event); else if(sm.event.startsWith('Bearish')) add(-1.5,'SMC '+sm.event); if(sm.trend) add(sm.trend*0.5,'Structure'); }
  if(sm&&sm.fib&&fibStateF){ const st=fibStateF(sm.fib,price); if(st.fav) add(sm.fib.bull?1:-1,`Fib ${st.zone}`); }
  if(fu&&Number.isFinite(fu.rate)){ if(fu.rate>0.05) add(-0.5,'Funding উচ্চ'); else if(fu.rate<-0.05) add(0.5,'Funding নেগেটিভ'); }
  const bias=score>=2?'Bullish':score<=-2?'Bearish':'Neutral';
  const hasS=sup>0&&sup<price, hasR=res>price, ob=sm&&sm.ob;
  const bSL=ob&&ob.dir==='bull'&&ob.lo<price?ob.lo*0.998:hasS?sup*0.99:price*0.985, bTP=hasR?res:price*1.02;
  const sSL=ob&&ob.dir==='bear'&&ob.hi>price?ob.hi*1.002:hasR?res*1.01:price*1.015, sTP=hasS?sup:price*0.98;
  $('ai-output').innerHTML=`
<p><strong>${safe(symbol)} (${safe(tf)}) Master Scan</strong> · Price: $${fmtPrice(price)}</p>
<div class="cards" style="margin-bottom:12px">
<div class="result"><span>Overall Bias (${score>0?'+':''}${score})</span><b class="${bias==='Bullish'?'green':bias==='Bearish'?'red':''}">${bias}</b></div>
<div class="result"><span>RSI (14)</span><b>${rr.toFixed(1)} (${rsiTxt})</b></div>
<div class="result"><span>Support / Resistance</span><b>${fmtPrice(sup)} / ${fmtPrice(res)}</b></div>
<div class="result"><span>SMC</span><b>${sm?safe(sm.event):'—'}</b></div>
</div>
<div class="notice" style="margin:0 0 10px">${why.join('<br>')||'কোনো স্পষ্ট সংকেত নেই'}</div>
<div class="scenario-grid">
<div class="scenario bull"><h3 class="green">Bullish Setup</h3><p><b>SL:</b> $${fmtPrice(bSL)} | <b>TP:</b> $${fmtPrice(bTP)}</p><button class="button-primary" data-send="long" data-sl="${bSL}" data-entry="${price}" data-tp="${bTP}" style="font-size:11px;padding:4px 8px">Send to Calculator ↗</button></div>
<div class="scenario bear"><h3 class="red">Bearish Setup</h3><p><b>SL:</b> $${fmtPrice(sSL)} | <b>TP:</b> $${fmtPrice(sTP)}</p><button class="button-danger" data-send="short" data-sl="${sSL}" data-entry="${price}" data-tp="${sTP}" style="font-size:11px;padding:4px 8px">Send to Calculator ↗</button></div>
</div>
<div class="notice"><b>EMA 9:</b> $${fmtPrice(e9)} | <b>EMA 21:</b> $${fmtPrice(e21)} | <b>EMA 50:</b> $${fmtPrice(e50)}${notes?'<br>Notes: '+safe(notes):''}${sm&&sm.fib?`<br><b>OTE:</b> $${fmtPrice(fibPxF(sm.fib,0.618))} – $${fmtPrice(fibPxF(sm.fib,0.786))}`:''}</div>`;
  if(computeSignalF){
    const ltfTf=(CTB.LTF_MAP||{})[tf]||'', ltfOn=!!settings.ltfConfirm; let ltf=null;
    if(ltfOn&&ltfTf){ try{ ltf=await klines(symbol,ltfTf,200); }catch(e){ ltf=null; } if(symbol!==selectedSymbol||tf!==selectedInterval) return; }
    try{ $('ai-output').innerHTML+=signalHtml(computeSignalF({symbol,tf,price,ema:{e9,e21,e50,e200},rsi:rr,smc:sm,mtf:mt,fund:fu,kz:kzNowF(),fresh,locked:false,ltfConfirm:ltfOn,ltfTf,ltf})); }
    catch(e){ $('ai-output').innerHTML+='<div class="warning">Signal Engine: '+safe(e.message)+'</div>'; }
  }
}

/* ---------- Calculator ---------- */
let lastCalc=null;
const rawNum=n=>String(+Number(n).toFixed(8));
function copyText(t){
  const ok=()=>toast('কপি হয়েছে: '+(t.length>60?t.slice(0,57)+'…':t.replace(/\n/g,' | ')));
  const legacy=()=>{ try{ const ta=document.createElement('textarea'); ta.value=t; ta.setAttribute('readonly',''); ta.style.cssText='position:fixed;top:0;left:0;opacity:0'; document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0,t.length); const r=document.execCommand('copy'); ta.remove(); r?ok():toast('কপি হয়নি'); }catch(e){ toast('কপি হয়নি'); } };
  if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok,legacy); else legacy();
}
function calcValue(k){ const c=lastCalc; if(!c) return null; return {entry:rawNum(c.entry),sl:rawNum(c.sl),tp:c.tp?rawNum(c.tp):'',size:c.size.toFixed(4),risk:c.risk.toFixed(2),value:c.value.toFixed(2),margin:c.margin.toFixed(2)}[k]; }
function calcSummary(){ const c=lastCalc; if(!c) return ''; return `${c.symbol} · ${c.side==='long'?'Long':'Short'}\nEntry: ${rawNum(c.entry)}\nSL: ${rawNum(c.sl)}\nTP: ${c.tp?rawNum(c.tp):'—'}\nSize: ${c.size.toFixed(4)}\nValue: $${c.value.toFixed(2)} | Margin: $${c.margin.toFixed(2)} (${c.lev}x)\nRisk: $${c.risk.toFixed(2)} | R:R ${c.rr===null?'—':'1:'+c.rr.toFixed(2)} | Fees ≈ $${c.fees.toFixed(2)}`; }
function updateCalcChips(){ const box=$('calc-chips'); if(!box) return; if(!lastCalc){ box.innerHTML=''; return; } const items=[['size','Size'],['entry','Entry'],['sl','SL'],['tp','TP']].filter(([k])=>calcValue(k)); box.innerHTML=items.map(([k,l])=>`<button data-copy="${k}">📋 ${l} ${safe(calcValue(k))}</button>`).join(''); }
function setupCalcCopy(){
  document.addEventListener('click',e=>{ const el=e.target.closest('[data-copy]'); if(!el) return; if(!lastCalc) return toast('আগে Calculate চাপুন।'); const v=calcValue(el.dataset.copy); if(v) copyText(v); });
  $('calc-copy').addEventListener('click',()=>{ if(!lastCalc) return toast('আগে Calculate চাপুন।'); copyText(calcSummary()); });
}
function calcRisk(){
  renderCalcWarnings();
  const bal=+$('calc-balance').value, rp=+$('calc-risk').value, entry=+$('calc-entry').value, sl=+$('calc-sl').value, tp=+$('calc-tp').value, lev=+$('calc-leverage').value||1, fee=+$('calc-fee').value||0, side=$('calc-side').value, msg=$('calc-message');
  const err=t=>{msg.textContent=t; msg.className='notice red';};
  if(!(bal>0&&rp>0&&entry>0&&sl>0&&entry!==sl)) return err('সঠিক তথ্য দিন।');
  if((side==='long'&&sl>=entry)||(side==='short'&&sl<=entry)) return err('SL এর দিক ভুল (Long এ নিচে, Short এ উপরে)।');
  const risk=bal*rp/100, dist=Math.abs(entry-sl), size=risk/dist, value=size*entry, fees=value*fee/100*2, margin=value/Math.max(1,lev);
  const rr=tp>0?Math.abs(tp-entry)/dist:null;
  $('res-risk').textContent=fmtMoney(risk); $('res-size').textContent=size.toFixed(4); $('res-val').textContent=fmtMoney(value);
  $('res-margin').textContent=fmtMoney(margin); $('res-fees').textContent=fmtMoney(fees); $('res-rr').textContent=rr===null?'TP দিন':'1 : '+rr.toFixed(2);
  lastCalc={symbol:selectedSymbol,side,entry,sl,tp:tp>0?tp:0,lev,risk,size,value,margin,fees,rr}; updateCalcChips();
  msg.textContent=margin>bal?'⚠️ মার্জিন > ব্যালেন্স!':'হিসাব সফল।'; msg.className='notice'+(margin>bal?' red':'');
  if(typeof showTradePreview==='function') showTradePreview();
}
function updateKillZones(){
  const n=new Date(), g=(n.getUTCHours()+4)%24, m=g*60+n.getUTCMinutes(), hm=x=>`${Math.floor(x/60)}h ${x%60}m`;
  const S=[['sess-asia',180,720,'Active','Closed'],['sess-london',660,900,'Kill Zone 🔥','Inactive'],['sess-ny',960,1200,'Kill Zone 🔥','Inactive']];
  const active=[];
  S.forEach(([id,a,b,on,off])=>{ const act=m>=a&&m<b, el=$(id); if(!el) return; el.textContent=act?`${on} · শেষ ${hm(b-m)}`:`${off} · শুরু ${hm((a-m+1440)%1440)}`; el.className=act?'green':'muted'; if(act) active.push(id.replace('sess-','')); });
  const now=$('sess-now'); if(now) now.textContent=`ওমান (GST): ${String(g).padStart(2,'0')}:${String(n.getUTCMinutes()).padStart(2,'0')} · সক্রিয়: ${active.length?active.join(' + ').toUpperCase():'কোনো সেশন নয়'}`;
}
function applyTheme(){ document.documentElement.dataset.theme=settings.theme; const m=document.querySelector('meta[name=theme-color]'); if(m) m.content=settings.theme==='light'?'#f4f5f7':'#0b0e11'; }

/* ---------- AUTOPILOT ---------- */
let apWorker=null, apTimer=null, apRunning=false, apRoundActive=false;
let apResults=new Map(), apPending=new Set(), apStats={scanned:0,ready:0,errors:0};
let apInFlight=0, apQueue=[], apRoundStarted=0, apRoundId='';
const apNotified = new Set();

function apSymbolPool(){
  const mode=$('ap-pool').value;
  if(mode==='watchlist') return [...new Set([...watchlist])];
  if(mode==='default') return [...defaultPairs];
  const topN=mode==='top20'?20:50;
  const rows=[...tickers.values()].filter(t=>t.symbol.endsWith('USDT')&&Number.isFinite(t.quoteVolume)).sort((a,b)=>b.quoteVolume-a.quoteVolume).slice(0,topN).map(t=>t.symbol);
  return rows.length?rows:[...defaultPairs];
}
const AP_WORKER_URLS=['./analysis.worker.js','./analysis_worker.js'];   // tries both spellings of the file name
let apWorkerIdx=0;
function ensureApWorker(){
  if(apWorker) return apWorker;
  while(apWorkerIdx<AP_WORKER_URLS.length){
    try{
      const w=new Worker(AP_WORKER_URLS[apWorkerIdx]);
      w.onmessage=onApResult; w.onerror=ev=>onApWorkerError(w,ev);
      apWorker=w; return w;
    }catch(e){ console.error('worker init',AP_WORKER_URLS[apWorkerIdx],e); apWorkerIdx++; }
  }
  return null;
}
// A missing/blocked worker file does NOT throw in the constructor — it only fires 'error' later.
// Without this handler the round just hung until the 5-minute guard.
function onApWorkerError(w,ev){
  if(w!==apWorker) return;
  console.error('Autopilot worker failed:',AP_WORKER_URLS[apWorkerIdx],ev&&ev.message);
  try{ w.terminate(); }catch(e){}
  apWorker=null; apWorkerIdx++;
  if(apRoundActive){ apRoundActive=false; apQueue=[]; apPending.clear(); apInFlight=0; apRunOnce(); }  // retry: next file name, else main thread
}
function onApResult(ev){
  const r=ev.data||{};
  // ignore results from previous rounds (timeout / restart / stop) BEFORE touching any counter
  if(apRoundId && r.roundId && r.roundId !== apRoundId) return;
  if(!apRoundActive) return; // round cancelled/stopped — discard
  apPending.delete(r.id); apInFlight=Math.max(0,apInFlight-1);
  apStats.scanned++;
  if(!r.ok){ apStats.errors++; }
  else if(r.dir&&(r.status==='READY'||r.status==='WATCH')){
    apResults.set(r.symbol,r);
    if(r.status==='READY'){ apStats.ready++; pushSignalAlert(r); }
  }
  else apResults.delete(r.symbol);
  renderApResults(); updateApProgress();
  dispatchAp();
  if(apRoundActive && apInFlight===0 && apQueue.length===0 && apPending.size===0){
    apRoundActive=false; apRoundDone();
  }
}
function dispatchAp(){
  const CONC=4;
  while(apInFlight<CONC&&apQueue.length){
    const job=apQueue.shift(); apInFlight++; apPending.add(job.id);
    apWorker.postMessage(job);
  }
}
function updateApProgress(){
  const el=$('ap-progress'); if(el) el.textContent=`Scanned ${apStats.scanned} · READY ${apStats.ready} · Errors ${apStats.errors} · In-flight ${apInFlight} · Queued ${apQueue.length}`;
}
async function apRunOnce(){
  if(!window.CTB||!window.CTB.computeSignal){ toast('analysis.js লোড হয়নি'); return; }
  if(apRoundActive){ toast('আগের round এখনো চলছে'); return; }
  const w=ensureApWorker();
  if(!w){ toast('Worker নেই, মেইন থ্রেডে চলবে'); return apRunOnceMain(); }
  const tf=$('ap-tf').value, pool=apSymbolPool(), minScore=+$('ap-minscore').value||70;
  apRoundId = 'r'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
  apStats={scanned:0,ready:0,errors:0}; apResults.clear(); apPending.clear(); apInFlight=0; apRoundStarted=Date.now(); apRoundActive=true;
  $('ap-table').innerHTML='<tr><td colspan="9" class="empty">স্ক্যান চলছে…</td></tr>';
  apQueue=pool.map((s,i)=>({id:s+'|'+tf+'|'+apRoundId+'-'+i,symbol:s,tf,ex:EX,roundId:apRoundId,minScore:minScore,ltfConfirm:!!settings.ltfConfirm}));
  $('ap-status').textContent='Running…';
  dispatchAp(); updateApProgress();
  const guard=setInterval(()=>{
    if(!apRoundActive){ clearInterval(guard); return; }
    if(Date.now()-apRoundStarted>300000){ clearInterval(guard); apQueue=[]; apInFlight=0; apPending.clear(); apRoundActive=false; apRoundDone(); }
  }, 5000);
}
async function apMtfMain(sym){
  const tfs=['5m','15m','1h','4h'], res=await Promise.allSettled(tfs.map(tf=>klines(sym,tf,100))), per={}; let partial=false;
  tfs.forEach((tf,i)=>{
    const r=res[i]; if(r.status!=='fulfilled'){ per[tf]='Neutral'; partial=true; return; }
    const cl=r.value.map(c=>+c[4]); if(cl.length<22){ per[tf]='Neutral'; partial=true; return; }
    const e9=emaF(cl,9), e21=emaF(cl,21), p=cl[cl.length-1];
    per[tf]=p>e9&&e9>e21?'Bullish':p<e9&&e9<e21?'Bearish':'Neutral';
  });
  return {per,sym,partial};
}
async function apRunOnceMain(){
  if(apRoundActive) return;
  apRoundActive=true;
  const tf=$('ap-tf').value, pool=apSymbolPool(), minScore=+$('ap-minscore').value||70;
  apRoundId = 'r'+Date.now()+'-m';
  apStats={scanned:0,ready:0,errors:0}; apResults.clear();
  for(const s of pool){
    try{
      const raw=await klines(s,tf,300), closes=raw.map(c=>+c[4]);
      const smc=smcF(raw), price=closes[closes.length-1], mtf=await apMtfMain(s), ltfTf=(CTB.LTF_MAP||{})[tf]||'', ltfOn=!!settings.ltfConfirm;
      let ltf=null; if(ltfOn&&ltfTf){ try{ ltf=await klines(s,ltfTf,200); }catch(e){ ltf=null; } }
      const sig=computeSignalF({symbol:s,tf,price,ema:{e9:emaF(closes,9),e21:emaF(closes,21),e50:emaF(closes,50),e200:emaF(closes,200)},rsi:rsiF(closes),smc,mtf,fund:null,kz:kzNowF(),fresh:{ok:true},locked:false,minReady:minScore,ltfConfirm:ltfOn,ltfTf,ltf});
      let status = sig.status;
      if(sig.score < minScore){ if(status==='READY') status='WATCH'; if(status==='WATCH'&&sig.score<Math.max(40,minScore-15)) status='WAIT'; }
      apStats.scanned++; if(status==='READY'){ apStats.ready++; pushSignalAlert({symbol:s,tf,price,score:sig.score,dir:sig.dir,plan:sig.plan}); }
      if(sig.dir&&(status==='READY'||status==='WATCH')){ apResults.set(s,{symbol:s,tf,price,score:sig.score,dir:sig.dir,status,plan:sig.plan,event:smc.event}); }
    }catch(e){ apStats.errors++; }
    renderApResults(); updateApProgress();
    await new Promise(r=>setTimeout(r,300));
  }
  apRoundActive=false; apRoundDone();
}
function apRoundDone(){
  renderApResults();
  $('ap-status').textContent='Round done · '+new Date().toLocaleTimeString();
  const ready=[...apResults.values()].filter(r=>r.status==='READY');
  if(ready.length) notify('🎯 READY: '+ready.slice(0,3).map(r=>`${r.symbol} ${r.dir} ${r.score}`).join(' · '));
  if(apRunning) scheduleNextAp();
}
function scheduleNextAp(){
  clearTimeout(apTimer);
  if(!apRunning) return;
  const min=+$('ap-interval').value;
  apTimer=setTimeout(()=>{ if(document.hidden){ scheduleNextAp(); } else apRunOnce(); }, min*60000);
}
// FIX: Autopilot READY → Smart Alerts auto-push (30min dedupe)
function pushSignalAlert(r){
  const key = r.symbol+'|'+r.tf+'|'+r.dir+'|READY';
  if(apNotified.has(key)) return;
  alerts.forEach(normAlert);
  const dir=(r.dir||'').toLowerCase(), detail=`${r.dir} score ${r.score} @ $${fmtPrice(r.price||0)}`;
  // 1) alerts the user created with type "Autopilot" (these were never evaluated anywhere before)
  const mine=alerts.filter(a=>a.type==='signal'&&a.enabled&&!a.triggered&&a.symbol===r.symbol&&(a.ex||'binance')===EX&&(a.condition==='ready'||a.condition===dir));
  // 2) otherwise the optional auto-notify. Not stored in `alerts` any more: every READY hit used to add a
  //    permanent 'repeat' alert (unbounded growth in localStorage + cloud sync + the alerts list).
  if(!mine.length && settings.apAutoAlert === false) return;
  apNotified.add(key);
  setTimeout(()=>apNotified.delete(key), 30*60000);
  if(mine.length) mine.forEach(a=>fireAlert(a,detail));
  else fireAlert({symbol:r.symbol,ex:EX,type:'signal',condition:dir,tf:r.tf,repeat:true}, detail);
}
function renderApResults(){
  const rows=[...apResults.values()].sort((a,b)=>b.score-a.score);
  if(!rows.length){ $('ap-table').innerHTML='<tr><td colspan="9" class="empty">কোনো সিগন্যাল নেই।</td></tr>'; $('ap-ready').innerHTML=''; return; }
  $('ap-table').innerHTML=rows.map(r=>{
    const plan=r.plan||{}, f=fmtPrice, dcol=r.dir==='LONG'?'green':r.dir==='SHORT'?'red':'muted', scol=r.status==='READY'?'green':'yellow';
    const zone=plan.zone?`$${f(plan.zone.lo)} – $${f(plan.zone.hi)}`:'—';
    return `<tr><td><button data-symbol="${safe(r.symbol)}" style="padding:0;border:0;background:none;font-weight:700">${safe(r.symbol.replace('USDT','/USDT'))}</button></td><td class="${dcol}">${safe(r.dir||'—')}</td><td>${r.score}</td><td class="${scol}">${safe(r.status)}</td><td>${zone}</td><td>$${f(plan.sl)}</td><td>$${f(plan.tps&&plan.tps[1])}</td><td>1:${plan.rr?plan.rr[1].toFixed(2):'—'}</td><td><button data-send="${r.dir==='LONG'?'long':'short'}" data-sl="${plan.sl}" data-entry="${plan.entry}" data-tp="${plan.tps&&plan.tps[1]}" style="font-size:11px;padding:3px 7px">Calc ↗</button> <button data-ap-trade="${safe(r.symbol)}" style="font-size:11px;padding:3px 7px">⚡</button></td></tr>`;
  }).join('');
  $('ap-ready').innerHTML=rows.filter(r=>r.status==='READY').slice(0,8).map(r=>`<button class="mini" data-symbol="${safe(r.symbol)}"><strong>${safe(r.symbol.replace('USDT','/USDT'))}</strong><div class="${r.dir==='LONG'?'green':'red'} small">${safe(r.dir)} · ${r.score}</div><div class="small muted">${safe(r.event||'')}</div></button>`).join('');
}
function setupAutopilot(){
  if(!$('ap-start')) return;
  $('ap-start').addEventListener('click',()=>{ apRunning=true; $('ap-start').disabled=true; $('ap-stop').disabled=false; apRunOnce(); });
  $('ap-stop').addEventListener('click',()=>{ apRunning=false; apRoundActive=false; clearTimeout(apTimer); $('ap-start').disabled=false; $('ap-stop').disabled=true; $('ap-status').textContent='Stopped'; });
  $('ap-once').addEventListener('click',()=>{ apRunning=false; apRunOnce(); });
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden&&apRunning){ clearTimeout(apTimer); apRunOnce(); } });
  const tg = $('ap-auto-alert');
  if(tg){ tg.checked = settings.apAutoAlert !== false; tg.addEventListener('change', e => { settings.apAutoAlert = e.target.checked; persist(); }); }
}

/* ---------- BACKTEST ---------- */
let btLast=null;
function setupBacktest(){
  if(!$('bt-run')) return;
  $('bt-run').addEventListener('click',async()=>{
    const sym=normSymbol($('bt-symbol').value), tf=$('bt-tf').value, mode=$('bt-entry').value;
    const num=(id,d)=>{ const v=parseFloat($(id).value); return Number.isFinite(v)?v:d; };
    const lim=Math.min(EX==='bybit'?1000:1500,Math.max(250,num('bt-limit',1000)));   // Bybit max 1000, Binance max 1500
    const risk=num('bt-risk',1), fee=num('bt-fee',0.05), bal=num('bt-balance',1000), minscore=num('bt-minscore',70);
    if(!(risk>0)||!(bal>0)||fee<0){ $('bt-status').textContent='ইনপুট ঠিক করুন (ঝুঁকি ও ব্যালেন্স ০-র বেশি হতে হবে)'; return; }
    $('bt-status').textContent='ডেটা লোড হচ্ছে…'; $('bt-kpi').innerHTML=''; $('bt-trades').innerHTML='<tr><td colspan="9" class="empty">চলছে…</td></tr>';
    try{
      const raw=(await klines(sym,tf,lim)).slice(0,-1);   // drop the still-forming candle
      if(!window.Backtest||!window.Backtest.runBacktest){ $('bt-status').textContent='backtest.js লোড হয়নি'; return; }
      $('bt-status').textContent='হিসাব চলছে…';
      const res=window.Backtest.runBacktest(raw,{tf,symbol:sym,entryMode:mode,riskPct:risk,feePct:fee,balance:bal,minScore:minscore});
      if(res.error){ $('bt-status').textContent=res.error; return; }
      btLast=res;
      $('bt-status').textContent=`${res.trades.length} trade · শেষ ব্যালেন্স ${fmtMoney(res.stats.finalBalance)}`;
      const kpi=(l,v,c)=>{c=c||'';return `<div class="result"><span>${l}</span><b class="${c}">${v}</b></div>`;};
      $('bt-kpi').innerHTML=
        kpi('Trades',res.stats.n)+
        kpi('Win Rate',res.stats.winRate.toFixed(1)+'%',res.stats.winRate>=50?'green':'red')+
        kpi('Total P&L',fmtMoney(res.stats.totalPnl),res.stats.totalPnl>=0?'green':'red')+
        kpi('Profit Factor',Number.isFinite(res.stats.profitFactor)?res.stats.profitFactor.toFixed(2):'∞',res.stats.profitFactor>=1.5?'green':res.stats.profitFactor>=1?'yellow':'red')+
        kpi('Expectancy',fmtMoney(res.stats.expectancy),res.stats.expectancy>=0?'green':'red')+
        kpi('Max DD',fmtMoney(res.stats.maxDD)+' ('+res.stats.maxDDpct.toFixed(1)+'%)','red')+
        kpi('Loss Streak',res.stats.maxLossStreak)+
        kpi('Mode',res.stats.mtfApprox?'MTF approx':'single-TF');
      drawEquity(res.equity, bal);
      $('bt-trades').innerHTML=res.trades.slice(-100).map((t,i)=>`<tr><td>${i+1}</td><td class="${t.side==='LONG'?'green':'red'}">${t.side}</td><td>$${fmtPrice(t.entry)}</td><td>$${fmtPrice(t.exit)}</td><td>$${fmtPrice(t.sl)}</td><td>$${fmtPrice(t.tp1)}</td><td>$${fmtPrice(t.tp2)}</td><td>${fmtMoney(t.fees)}</td><td class="${t.pnl>=0?'green':'red'}">${fmtMoney(t.pnl)}</td></tr>`).join('')||'<tr><td colspan="9" class="empty">কোনো trade নেই</td></tr>';
    }catch(e){ $('bt-status').textContent='ব্যর্থ: '+e.message; }
  });
  $('bt-export').addEventListener('click',()=>{
    if(!btLast||!btLast.trades.length) return toast('আগে backtest চালান।');
    const rows=[['EntryTime','ExitTime','Side','Entry','Exit','SL','TP1','TP2','TP3','Qty','Fees','PnL','Score']].concat(btLast.trades.map(t=>[new Date(t.entryTime).toISOString(),new Date(t.exitTime).toISOString(),t.side,t.entry,t.exit,t.sl,t.tp1,t.tp2,t.tp3,t.qty.toFixed(6),t.fees.toFixed(4),t.pnl.toFixed(4),t.score]));
    download('backtest-'+Date.now()+'.csv','\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\n'),'text/csv;charset=utf-8');
  });
}
function drawEquity(curve, startBal){
  const cvs=$('bt-equity-canvas'); if(!cvs) return;
  const dpr=window.devicePixelRatio||1;
  const w=cvs.clientWidth||800, h=cvs.clientHeight||180;
  cvs.width=w*dpr; cvs.height=h*dpr;
  const ctx=cvs.getContext('2d'); ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,w,h);
  if(!curve||curve.length<2){ ctx.fillStyle='#848e9c'; ctx.font='12px sans-serif'; ctx.fillText('ডেটা কম',10,20); return; }
  const ys=curve.map(p=>p.eq), yMin=Math.min(...ys,startBal), yMax=Math.max(...ys,startBal);
  const pad=20, x0=pad, x1=w-pad, y0=pad, y1=h-pad;
  const sx=i=>x0+(x1-x0)*i/(curve.length-1), sy=v=>y1-(y1-y0)*(v-yMin)/Math.max(1e-9,yMax-yMin);
  ctx.strokeStyle='#2b3139'; ctx.lineWidth=1;
  for(let i=0;i<=4;i++){ const y=y0+(y1-y0)*i/4; ctx.beginPath(); ctx.moveTo(x0,y); ctx.lineTo(x1,y); ctx.stroke(); }
  ctx.strokeStyle=curve[curve.length-1].eq>=startBal?'#0ecb81':'#f6465d'; ctx.lineWidth=2; ctx.beginPath();
  curve.forEach((p,i)=>{ const x=sx(i),y=sy(p.eq); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }); ctx.stroke();
  ctx.fillStyle='#848e9c'; ctx.font='11px sans-serif';
  ctx.fillText('$'+yMax.toFixed(0),4,y0-4); ctx.fillText('$'+yMin.toFixed(0),4,y1+12);
}

/* ---------- Events ---------- */
function setupEvents(){
  document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('.nav').forEach(x=>x.classList.remove('active')); b.classList.add('active');
    goPanel(b.dataset.target);
  }));
  document.addEventListener('click',e=>{
    const t=e.target, g=s=>t.closest(s);
    let el;
    if(el=g('[data-ap-trade]')){ const r=apResults.get(el.dataset.apTrade); if(!r||!r.plan) return; selectSymbol(r.symbol); $('calc-entry').value=r.plan.entry; $('calc-sl').value=r.plan.sl; $('calc-tp').value=r.plan.tps[1]; $('calc-side').value=r.dir==='LONG'?'long':'short'; calcRisk(); if(typeof showTradePreview==='function') showTradePreview(); goPanel('trade-panel'); return; }
    if(el=g('[data-send]')){ $('calc-entry').value=el.dataset.entry; $('calc-sl').value=el.dataset.sl; $('calc-tp').value=el.dataset.tp; $('calc-side').value=el.dataset.send; goPanel('calculator'); calcRisk(); return; }
    if(el=g('[data-add-watch]')){ const s=el.dataset.addWatch; if(!watchlist.includes(s)){watchlist.push(s); persist(); renderWatchlist(); connectSocket();} return; }
    if(el=g('[data-remove-watch]')){ watchlist=watchlist.filter(s=>s!==el.dataset.removeWatch); persist(); renderWatchlist(); connectSocket(); return; }
    if(el=g('[data-delete-trade]')){ journal=journal.filter(x=>String(x.id)!==el.dataset.deleteTrade); persist(); renderJournal(); return; }
    if(el=g('[data-rearm]')){ const a=alerts.find(x=>String(x.id)===el.dataset.rearm); if(a){a.triggered=false;a.lastFired=0;persist();renderAlerts();} return; }
    if(el=g('[data-toggle-alert]')){ const x=alerts.find(q=>String(q.id)===el.dataset.toggleAlert); if(x){ if(x.triggered){x.triggered=false;x.enabled=true;x.lastFired=0;x.lastBar=0;x.lastEvent=undefined;x.lastIn=undefined;} else x.enabled=!x.enabled; persist(); renderAlerts(); } return; }
    if(el=g('[data-delete-alert]')){ alerts=alerts.filter(x=>String(x.id)!==el.dataset.deleteAlert); persist(); renderAlerts(); return; }
    if(el=g('[data-interval]')){ changeInterval(el.dataset.interval); return; }
    if(el=g('[data-scanner-tab]')){ scannerMode=el.dataset.scannerTab; document.querySelectorAll('[data-scanner-tab]').forEach(b=>b.classList.toggle('active',b===el)); renderScanner(); return; }
    if(el=g('[data-symbol]')){ selectSymbol(el.dataset.symbol); goPanel('chart-section'); }
  });
  $('global-search').addEventListener('keydown',e=>{ if(e.key==='Enter'&&e.target.value.trim()){ selectSymbol(e.target.value); goPanel('chart-section'); e.target.value=''; } });
  $('chart-go').addEventListener('click',goChart); $('chart-symbol-input').addEventListener('keydown',e=>{if(e.key==='Enter')goChart();}); $('mtf-run').addEventListener('click',runMTF); $('smc-auto-run').addEventListener('click',runSMC);
  $('calc-button').addEventListener('click',calcRisk); $('ai-generate').addEventListener('click',buildAI);
  $('calc-reset').addEventListener('click',()=>{ lastCalc=null; updateCalcChips();['calc-entry','calc-sl','calc-tp'].forEach(i=>$(i).value=''); ['res-risk','res-size','res-val','res-margin','res-fees','res-rr'].forEach(i=>$(i).textContent='—');});
  $('tv-mode').addEventListener('click',()=>{ tvMode=tvMode==='iframe'?'script':'iframe'; try{ localStorage.setItem('ctb-tvmode',tvMode); }catch(e){} tvKey=''; toast('চার্ট মোড: '+(tvMode==='iframe'?'সুরক্ষিত':'স্ক্রিপ্ট')); loadTradingView(); });
  $('open-full-tv').addEventListener('click',()=>window.open('https://www.tradingview.com/chart/?symbol='+EXCH[EX].tv+':'+selectedSymbol+'.P&interval='+tvInterval(selectedInterval),'_blank','noopener'));
  $('ai-copy').addEventListener('click',()=>{ navigator.clipboard?.writeText($('ai-output').innerText).then(()=>alert('কপি হয়েছে।')).catch(()=>{}); });
  ['market-search','market-sort','market-limit'].forEach(i=>$(i).addEventListener(i==='market-search'?'input':'change',renderMarketTable));
  $('refresh-market').addEventListener('click',fetchMarket);
  $('market-search-clear').addEventListener('click',()=>{$('market-search').value=''; renderMarketTable();});
  $('journal-add').addEventListener('click',()=>{
    const symbol=normSymbol($('j-symbol').value||''), pnl=parseFloat($('j-pnl').value), date=$('j-date').value||new Date().toISOString().slice(0,10), setup=$('j-setup').value.trim();
    if(!$('j-symbol').value.trim()||isNaN(pnl)){alert('সঠিক তথ্য দিন।'); return;}
    journal.push({id:Date.now(),date,symbol,side:$('j-side').value,pnl,setup,ex:EX}); persist(); renderJournal(); $('j-pnl').value=''; $('j-setup').value='';
  });
  $('journal-clear').addEventListener('click',()=>{ if(confirm('সব ট্রেড মুছবেন?')){journal=[]; persist(); renderJournal();} });
  $('journal-export').addEventListener('click',()=>{
    const rows=[['Date','Symbol','Side','Setup','PnL'],...journal.map(t=>[t.date,t.symbol,t.side,t.setup||'',t.pnl])];
    download('journal.csv','\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\n'),'text/csv;charset=utf-8');
  });
  $('export-data').addEventListener('click',()=>download('terminal-data.json',JSON.stringify({settings,watchlist,alerts,journal},null,2),'application/json'));
  $('watch-add').addEventListener('click',()=>{ const v=$('watch-add-symbol').value.trim(); if(v){const s=normSymbol(v); if(!watchlist.includes(s)){watchlist.push(s); persist(); renderWatchlist(); connectSocket();}} $('watch-add-symbol').value=''; });
  $('settings-save').addEventListener('click',()=>{
    if(!user||!access||!access.canTrade) settings.balance=+$('setting-balance').value||0; else settings.balance=effectiveBalance();
    settings.ltfConfirm=!!$('setting-ltf').checked;
    settings.symbol=$('setting-symbol').value; settings.refresh=+$('setting-refresh').value||30000; settings.language=$('setting-language').value; persist();
    syncBalanceUI();
    document.documentElement.lang=settings.language; selectSymbol(settings.symbol);
    clearInterval(refreshTimer); refreshTimer=setInterval(fetchMarket,settings.refresh); alert('সেভ হয়েছে।');
  });
  $('settings-reset').addEventListener('click',()=>{
    if(!confirm('সব সেটিংস রিসেট করবেন?')) return;
    settings={balance:0,symbol:'BTCUSDT',language:'bn',refresh:30000,theme:'dark',apAutoAlert:true}; persist(); applyTheme();
    $('setting-balance').value=0; selectSymbol('BTCUSDT'); $('setting-language').value='bn'; $('setting-refresh').value='30000'; alert('রিসেট সম্পন্ন।');
  });
  $('theme-toggle').addEventListener('click',()=>{ settings.theme=settings.theme==='light'?'dark':'light'; persist(); applyTheme(); loadTradingView(); });
  $('lang-toggle').addEventListener('click',()=>{ settings.language=settings.language==='bn'?'en':'bn'; $('setting-language').value=settings.language; document.documentElement.lang=settings.language; persist(); });
}

/* ---------- Supabase Auth + Cloud Sync ---------- */
const SB_URL='https://yswbiogwhklhfrkeatpp.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlzd2Jpb2d3aGtsaGZya2VhdHBwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzMjAyNTQsImV4cCI6MjEwODg5NjI1NH0.ZH3zfylWWLAIcwPOciIbObbchf38bD-cTmc3v2Dv8Go';
let sb=null, user=null, saveTimer=null, pulling=false, lastPull=0;
try{ if(window.supabase) sb=window.supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}); }catch(e){}
const byId=(a,b)=>{const m=new Map(); [...a,...b].forEach(x=>m.set(String(x.id),x)); return [...m.values()];};
const setSync=(t,c='muted')=>{const e=$('sync-status'); if(e){e.textContent=t; e.className=c;}};
const authMsg=(t,bad)=>{const e=$('auth-msg'); e.textContent=t; e.className='notice '+(bad?'red':'green');};
const openAuth=o=>{$('auth-modal').style.display=o?'flex':'none'; if(o) $('auth-msg').textContent='';};
async function cloudPush(){
  if(!sb||!user) return;
  try{ setSync('সেভ হচ্ছে…'); const {error}=await sb.from('user_data').upsert({user_id:user.id,journal,watchlist,alerts,settings,updated_at:new Date().toISOString()}); if(error) throw error; setSync('Synced ✓','good-status'); }
  catch(e){ setSync('Sync ব্যর্থ','bad-status'); }
}
function scheduleCloudSave(){ if(!sb||!user) return; clearTimeout(saveTimer); saveTimer=setTimeout(()=>{saveTimer=null; cloudPush();},1500); }
function applyState(){
  applyTheme(); renderJournal(); renderWatchlist(); renderAlerts();
  $('setting-balance').value=settings.balance; $('setting-ltf').checked=!!settings.ltfConfirm; syncBalanceUI();
  $('setting-refresh').value=String(settings.refresh); $('setting-language').value=settings.language; connectSocket();
}
async function cloudPull(){
  if(!sb||!user||pulling||saveTimer) return; pulling=true; lastPull=Date.now();
  try{
    setSync('লোড হচ্ছে…');
    const {data,error}=await sb.from('user_data').select('*').eq('user_id',user.id).maybeSingle(); if(error) throw error;
    const flag='ctb-synced-'+user.id; let first=true; try{ first=!localStorage.getItem(flag); }catch(e){}
    if(data){
      const keep={symbol:settings.symbol,interval:settings.interval,exchange:settings.exchange};
      if(first){ journal=byId(data.journal||[],journal); alerts=byId(data.alerts||[],alerts); watchlist=[...new Set([...(data.watchlist||[]),...watchlist])]; }
      else { journal=data.journal||[]; alerts=data.alerts||[]; if(data.watchlist&&data.watchlist.length) watchlist=data.watchlist; }
      settings={...settings,...(data.settings||{}),...keep}; sanitizeState(); applyState();
    }
    try{ localStorage.setItem(flag,'1'); }catch(e){}
    if(first||!data) persist(); else setSync('Synced ✓','good-status');
  }catch(e){ setSync('Sync ব্যর্থ','bad-status'); }
  pulling=false;
}
async function onUser(u){
  if((user&&u&&user.id===u.id)||(!user&&!u)) return;
  const was=user;
  // সরাসরি A -> B: user=null থাকা অবস্থায় মুছি, নইলে খালি ডেটা B-র ক্লাউডে ঢুকে যেত এবং A-র ডেটা B-র অ্যাকাউন্টে মিশত
  if(was&&u){ user=null; wipeLocal(); }
  user=u||null;
  $('auth-btn').textContent=user?('👤 '+(user.email||'').split('@')[0]+' · Logout'):'লগইন';
  if(user){ openAuth(false); checkAccess(); await cloudPull(); }
  else { access=null; renderAccess(); resetBalanceState(); setSync('Guest (লোকাল)'); if(was) wipeLocal(); }
}
function showTrade(on){ if(on) setTimeout(trAutoTick,200); $('nav-trade').style.display=on?'flex':'none'; $('trade-panel').style.display=on?'':'none'; }
let access=null; // সার্ভারের whoami: {role,status,confirmed,admin,canTrade}
let balancesByEnv={binance:{testnet:null,demo:null,live:null},bybit:{testnet:null,demo:null,live:null}};
let balanceSyncReady=false;
let lastLimits=null;      // status action থেকে (limits)
let lastRisk=null;        // status action থেকে (dailyPnl/weeklyPnl/tradesToday/balance)
let lastLiveEnabled=null, lastLiveCfgErr='', lastSyncedBalance=null;
function effectiveBalance(){
  if(!user) return 0;
  if(!access||!access.canTrade) return 0;
  const ex=EX, env=trEnv();
  const c=balancesByEnv[ex]&&balancesByEnv[ex][env];
  return (Number.isFinite(c)&&c>=0)?c:0;
}
function syncBalanceUI(){
  const bal=effectiveBalance(), live=!!(user&&access&&access.canTrade), env=trEnv();
  $('balance-card').textContent=fmtMoney(bal);
  $('balance-mode-label').textContent=live?`(${EXCH[EX].name} ${ENV_LBL[env]||env} · লাইভ)`:(user?'(অনুমোদনের অপেক্ষায়)':'(Guest)');
  const cb=$('calc-balance'), edited=!!(cb.dataset&&cb.dataset.userEdited);
  if(!edited) cb.value=bal;
  $('calc-balance-hint').textContent=edited?'(ম্যানুয়াল: শুধু প্রিভিউ, আসল সাইজ সার্ভার হিসাব করে)':live?'(লাইভ, অটো)':'(লগইন + অনুমোদনের পরে অটো)';
  const sb=$('setting-balance'); sb.readOnly=live; if(live) sb.value=bal;
  $('setting-balance-env').textContent=live?`(${EXCH[EX].name} ${ENV_LBL[env]||env} লাইভ, শুধু পড়ার জন্য)`:'';
  if(lastSyncedBalance!==bal){ lastSyncedBalance=bal; renderJournal(); }
}
// ---- সতর্ক সংকেত: সার্ভারের পাঠানো সীমা/PnL থেকে আগাম তথ্য। চূড়ান্ত সিদ্ধান্ত সবসময় সার্ভারের ----
function riskWarnList(){
  const L=lastLimits, R=lastRisk, live=trEnv()==='live';
  if(!user||!access||!access.canTrade||!L) return null;
  const w=[];
  if(live&&lastLiveCfgErr) w.push(['bad','🔴 LIVE সার্ভার কনফিগারেশন অসম্পূর্ণ: '+safe(lastLiveCfgErr)]);
  if(live&&lastLiveEnabled===false) w.push(['bad','🔴 LIVE বন্ধ আছে — অর্ডার পাঠাতে "LIVE চালু করুন" চাপুন']);
  const bal=(R&&Number.isFinite(R.balance))?R.balance:effectiveBalance();
  const lossChk=(name,pnl,pct)=>{
    if(!(pct>0)||!Number.isFinite(pnl)||!(bal>0)) return;
    const lim=bal*pct/100, loss=-pnl; if(!(loss>0)) return; const r=loss/lim, pc=Math.round(r*100);
    if(r>=1) w.push(['bad',`🔴 ${name} লস লক: লস ${fmtMoney(loss)} / সীমা ${fmtMoney(lim)} (${pc}%) — সার্ভার নতুন অর্ডার নেবে না`]);
    else if(r>=0.8) w.push(['warn',`⚠️ ${name} লস ${fmtMoney(loss)} / সীমা ${fmtMoney(lim)} (${pc}%) — সীমার কাছাকাছি`]);
  };
  if(R){
    lossChk('আজকের',R.dailyPnl,L.dailyLossPct);
    if(live) lossChk('এই সপ্তাহের',R.weeklyPnl,L.weeklyLossPct);
    if(live&&L.maxTradesPerDay>0&&Number.isFinite(R.tradesToday)){
      if(R.tradesToday>=L.maxTradesPerDay) w.push(['bad',`🔴 আজকের LIVE ট্রেড ${R.tradesToday} / সীমা ${L.maxTradesPerDay} — সার্ভার নতুন অর্ডার নেবে না`]);
      else if(R.tradesToday>=L.maxTradesPerDay*0.8) w.push(['warn',`⚠️ আজকের LIVE ট্রেড ${R.tradesToday} / সীমা ${L.maxTradesPerDay} — সীমার কাছাকাছি`]);
    }
  }
  return w;
}
function renderRiskWarnings(){
  const el=$('tr-warnings'); if(!el) return;
  const w=riskWarnList();
  if(w===null){ el.style.display='none'; el.innerHTML=''; return; }
  el.style.display='';
  if(!w.length){ el.className='notice green'; el.innerHTML='✅ সব সীমার মধ্যে — অর্ডার পাঠানো যাবে <span class="small muted">(সার্ভার চূড়ান্ত যাচাই করবে)</span>'; return; }
  el.className='warning'; el.innerHTML=w.map(x=>`<div>${x[1]}</div>`).join('');
}
function calcWarnItems(){
  const L=lastLimits; if(!L) return [];
  const rp=+$('calc-risk').value, lev=+$('calc-leverage').value, entry=+$('calc-entry').value, sl=+$('calc-sl').value, bal=effectiveBalance(), w=[];
  if(lev>0&&lev>L.maxLeverage) w.push(['warn',`⚠️ Calculator-এ লিভারেজ ${lev}x, আপনার সীমা ${L.maxLeverage}x — সার্ভার ${L.maxLeverage}x-এ নামিয়ে দেবে`]);
  if(rp>L.maxRiskPct) w.push(['warn',`⚠️ Risk ${rp}%, আপনার সীমা ${L.maxRiskPct}% — সার্ভার অর্ডার রিজেক্ট করবে`]);
  if(entry>0&&sl>0&&entry!==sl){
    const slp=Math.abs(entry-sl)/entry*100;
    if(slp<L.minSlPct) w.push(['warn',`⚠️ SL দূরত্ব ${slp.toFixed(2)}%, ন্যূনতম ${L.minSlPct}% — সার্ভার রিজেক্ট করবে`]);
    if(L.maxNotional>0&&bal>0&&rp>0){ const nv=bal*rp/100/(slp/100); if(nv>L.maxNotional) w.push(['warn',`⚠️ পজিশন মূল্য প্রায় ${fmtMoney(nv)}, আপনার সীমা ${fmtMoney(L.maxNotional)} — সার্ভার রিজেক্ট করবে`]); }
  }
  return w;
}
function renderCalcWarnings(){
  const el=$('calc-warnings'); if(!el) return;
  const L=lastLimits;
  if(!user||!access||!access.canTrade||!L){ el.className='notice'; el.textContent='লগইন + অনুমোদনের পরে আপনার সীমা অনুযায়ী প্রি-চেক এখানে দেখা যাবে।'; return; }
  const items=calcWarnItems().concat((riskWarnList()||[]).filter(x=>x[0]==='bad'));
  const ready=+$('calc-entry').value>0&&+$('calc-sl').value>0&&+$('calc-risk').value>0;
  if(items.length){ el.className='warning'; el.innerHTML=items.map(x=>`<div>${x[1]}</div>`).join(''); }
  else if(ready){ el.className='notice green'; el.innerHTML='✅ সব সীমার মধ্যে — অর্ডার পাঠানো যাবে <span class="small muted">(সার্ভার চূড়ান্ত যাচাই করবে)</span>'; }
  else { el.className='notice'; el.textContent='Entry, SL ও Risk দিলে আপনার সীমার সাথে প্রি-চেক দেখা যাবে।'; }
}
function confirmLimitsText(p){
  const L=lastLimits, R=lastRisk; if(!L) return '';
  let t=`\n\nআপনার সীমা: Risk ≤ ${L.maxRiskPct}% · লিভ ≤ ${L.maxLeverage}x · মূল্য ${L.maxNotional>0?'≤ '+fmtMoney(L.maxNotional):'সীমাহীন'} · SL ≥ ${L.minSlPct}%`;
  if(R&&Number.isFinite(R.dailyPnl)&&L.dailyLossPct>0) t+=`\nআজকের PnL ${fmtMoney(R.dailyPnl)} (দৈনিক লস সীমা ${L.dailyLossPct}%)`;
  if(R&&Number.isFinite(R.tradesToday)&&L.maxTradesPerDay>0) t+=`\nআজকের LIVE ট্রেড ${R.tradesToday}/${L.maxTradesPerDay}`;
  const w=calcWarnItems().concat(riskWarnList()||[]);
  if(w.length) t+='\n'+w.map(x=>x[1].replace(/<[^>]*>/g,'')).join('\n');
  return t+'\n(সার্ভার চূড়ান্ত যাচাই করবে)';
}
function resetBalanceState(){
  balancesByEnv={binance:{testnet:null,demo:null,live:null},bybit:{testnet:null,demo:null,live:null}};
  balanceSyncReady=false; lastLimits=null; lastRisk=null; lastLiveEnabled=null; lastLiveCfgErr='';
  const cb=$('calc-balance'); if(cb&&cb.dataset) delete cb.dataset.userEdited;
  syncBalanceUI(); renderRiskWarnings(); renderCalcWarnings();
}
function setupBalanceWarn(){
  $('calc-balance').addEventListener('input',()=>{ $('calc-balance').dataset.userEdited='1'; syncBalanceUI(); renderCalcWarnings(); });
  $('calc-bal-refresh').addEventListener('click',()=>{ delete $('calc-balance').dataset.userEdited; syncBalanceUI(); renderCalcWarnings(); });
  ['calc-risk','calc-leverage','calc-entry','calc-sl','calc-tp'].forEach(i=>$(i).addEventListener('input',renderCalcWarnings));
  $('calc-side').addEventListener('change',renderCalcWarnings);
}
const ACCESS_TXT={none:'ট্রেডিং ব্যবহার করতে অ্যাডমিনের অনুমোদন লাগবে। নিচের বাটনে অনুরোধ পাঠান।',pending:'আপনার অনুরোধ অ্যাডমিনের কাছে আছে। অনুমোদনের অপেক্ষা করুন (পেজ নিজে থেকে আপডেট হবে)।',rejected:'আপনার অনুরোধ বাতিল হয়েছে। অ্যাডমিনের সাথে যোগাযোগ করুন।'};
function renderAccess(){
  const a=access, p=$('access-panel');
  if(!user||!a){ p.style.display='none'; $('nav-admin').style.display='none'; $('admin-panel').style.display='none'; showTrade(false); renderWsChips(); return; }
  showTrade(!!a.canTrade);
  $('nav-admin').style.display=a.admin?'flex':'none'; $('admin-panel').style.display=a.admin?'':'none';
  p.style.display=a.canTrade?'none':''; renderWsChips();
  if(a.canTrade) return;
  const st=a.status||'none';
  $('access-badge').textContent=!a.confirmed?'ইমেইল কনফার্ম বাকি':st==='pending'?'⏳ অপেক্ষায়':st==='rejected'?'⛔ বাতিল':'অ্যাক্সেস নেই';
  $('access-msg').textContent=!a.confirmed?'আগে ইমেইল কনফার্ম করুন (ইনবক্সের লিংকে ক্লিক করুন), তারপর অনুরোধ পাঠাতে পারবেন।':(ACCESS_TXT[st]||ACCESS_TXT.none);
  $('access-request').style.display=(a.confirmed&&st==='none')?'':'none';
}
async function checkAccess(){
  if(!user){ access=null; renderAccess(); syncBalanceUI(); renderRiskWarnings(); return; }
  try{ access=await tradeCall({action:'whoami'}); }catch(e){ access=null; }
  renderAccess(); syncBalanceUI(); renderRiskWarnings();
  if(access&&access.canTrade) trStatus();
  if(access&&access.admin) loadAdmin();
}
async function loadAdmin(){
  if(!access||!access.admin) return;
  try{
    const r=await tradeCall({action:'admin_list'}), ST={pending:'⏳ অপেক্ষায়',approved:'✅ অনুমোদিত',rejected:'⛔ বাতিল',none:'—'}, ord={pending:0,none:1,rejected:2,approved:3};
    const rows=(r.users||[]).filter(u=>u.role!=='admin').sort((a,b)=>(ord[a.status]??9)-(ord[b.status]??9));
    $('admin-table').innerHTML=rows.map(u=>`<tr><td>${safe(u.email)}</td><td>${ST[u.status]||safe(u.status)}</td><td>${u.requestedAt?safe(new Date(u.requestedAt).toLocaleString()):'—'}</td><td>${u.status!=='approved'?`<button class="button-primary" data-admin-set="approve" data-uid="${safe(u.id)}">Approve</button>`:''} ${u.status!=='rejected'?`<button class="button-danger" data-admin-set="reject" data-uid="${safe(u.id)}">${u.status==='approved'?'Revoke':'Reject'}</button>`:''}</td></tr>`).join('')||'<tr><td colspan="4" class="empty">কোনো ইউজার নেই।</td></tr>';
    $('admin-msg').textContent='';
  }catch(e){ $('admin-msg').textContent=e.message; }
}
const LIM_IDS={maxRisk:['tr-lim-risk','maxRiskPct'],maxLev:['tr-lim-lev','maxLeverage'],maxNotional:['tr-lim-notional','maxNotional'],maxPos:['tr-lim-pos','maxPositions'],dayLoss:['tr-lim-day','dailyLossPct'],weekLoss:['tr-lim-week','weeklyLossPct'],maxTrades:['tr-lim-trades','maxTradesPerDay']};
function fillLimits(l){ if(!l) return; const ae=document.activeElement; if(ae&&ae.id&&ae.id.startsWith('tr-lim-')) return; for(const k in LIM_IDS) $(LIM_IDS[k][0]).value=l[LIM_IDS[k][1]]; }
function setupAccess(){
  $('tr-lim-save').addEventListener('click',async()=>{
    const lim={}; for(const k in LIM_IDS) lim[k]=parseFloat($(LIM_IDS[k][0]).value);
    if(Object.values(lim).some(v=>!Number.isFinite(v))) return trMsg('সবগুলো ঘরে সংখ্যা দিন (সীমা না চাইলে 0)।',true);
    if((lim.maxRisk>5||lim.maxLev>25)&&!confirm(`⚠️ Risk ${lim.maxRisk}% / লিভারেজ ${lim.maxLev}x অনেক উঁচু: কয়েকটা ক্ষতিতেই পুরো ব্যালেন্স শেষ হতে পারে। তবু সংরক্ষণ করবেন?`)) return;
    try{ await tradeCall({action:'limits_save',env:trEnv(),limits:lim}); trMsg('সীমা সংরক্ষিত ✓'); trStatus(); }catch(e){ trMsg(e.message,true); }
  });
  $('access-request').addEventListener('click',async()=>{ try{ await tradeCall({action:'request_access'}); toast('অনুরোধ পাঠানো হয়েছে'); }catch(e){ $('access-msg').textContent=e.message; } checkAccess(); });
  $('access-refresh').addEventListener('click',checkAccess);
  $('admin-refresh').addEventListener('click',loadAdmin);
  $('admin-table').addEventListener('click',async e=>{
    const b=e.target.closest&&e.target.closest('[data-admin-set]'); if(!b) return;
    const dec=b.dataset.adminSet, em=b.closest('tr')&&b.closest('tr').firstChild?b.closest('tr').firstChild.textContent:'';
    if(!confirm(`${dec==='approve'?'অনুমোদন দেবেন':'বাতিল করবেন'}: ${em}?`)) return;
    try{ await tradeCall({action:'admin_set',userId:b.dataset.uid,decision:dec}); }catch(err){ $('admin-msg').textContent=err.message; }
    loadAdmin();
  });
  $('tr-key-save').addEventListener('click',async()=>{
    const env=trEnv(), k=$('tr-key-api').value.trim(), sec=$('tr-key-secret').value.trim();
    if(!k||!sec) return trMsg('API Key ও Secret দুটোই দিন।',true);
    if(env==='live'&&!confirm('🔴 LIVE Key সংরক্ষণ হবে। Key-তে Withdraw/Transfer বন্ধ আছে তো? সংরক্ষণের পর LIVE বন্ধ হয়ে যাবে; আবার Key যাচাই করে চালু করতে হবে।')) return;
    const btn=$('tr-key-save'); btn.disabled=true; trMsg('Key যাচাই ও সংরক্ষণ হচ্ছে…');
    try{ await tradeCall({action:'keys_save',env,apiKey:k,apiSecret:sec}); $('tr-key-api').value=''; $('tr-key-secret').value=''; trMsg('Key সংরক্ষিত ✓'); trStatus(); refreshTrade(); }
    catch(e){ trMsg(e.message,true); }
    finally{ btn.disabled=false; }
  });
  $('tr-key-del').addEventListener('click',async()=>{
    const env=trEnv(); if(!confirm(`${EXCH[EX].name} ${env.toUpperCase()} Key মুছবেন?`)) return;
    try{ await tradeCall({action:'keys_delete',env}); trMsg('Key মোছা হয়েছে।'); }catch(e){ trMsg(e.message,true); }
    trStatus();
  });
  setInterval(()=>{ if(user&&!document.hidden) checkAccess(); },60000);   // অ্যাডমিন অনুমোদন/বাতিল করলে নিজে থেকে বদলায়
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden&&user) checkAccess(); });
}
function wipeLocal(){   // লগআউট বা অন্য ইউজারে বদলের সময়: আগের ইউজারের লোকাল ডেটা মুছে ফেলা
  clearTimeout(saveTimer); saveTimer=null; journal=[]; alerts=[]; alertLog=[]; watchlist=[...defaultPairs]; settings={...settings,balance:0}; persist(); applyState(); resetBalanceState();
}
function setupAuth(){
  const hookAuth=()=>{
  sb.auth.onAuthStateChange((ev,session)=>{
    if(ev==='TOKEN_REFRESHED') return;
    if(ev==='PASSWORD_RECOVERY') setTimeout(async()=>{ const p=prompt('নতুন পাসওয়ার্ড (৬+):'); if(p&&p.length>=6){ const {error}=await sb.auth.updateUser({password:p}); alert(error?'ব্যর্থ: '+error.message:'পাসওয়ার্ড বদলানো হয়েছে।'); } },100);
    setTimeout(()=>onUser(session&&session.user),0);
  });
  };
  const loadScript=src=>new Promise((res,rej)=>{ const t=document.createElement('script'); t.src=src; t.onload=res; t.onerror=()=>rej(new Error(src)); document.head.appendChild(t); });
  async function ensureSb(){
    if(sb) return sb;
    const srcs=['supabase.js','https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.0/dist/umd/supabase.js','https://unpkg.com/@supabase/supabase-js@2.45.0/dist/umd/supabase.js','https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'];
    for(const src of srcs){ if(window.supabase) break; try{ await loadScript(src); }catch(e){} }
    if(window.supabase&&!sb){ try{ sb=window.supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}); hookAuth(); }catch(e){ sb=null; } }
    return sb;
  }
  if(sb) hookAuth(); else ensureSb();
  const cred=()=>({email:$('auth-email').value.trim(),password:$('auth-pass').value});
  const redirect=location.origin+location.pathname;
  $('auth-btn').addEventListener('click',async()=>{
    if(!sb){ toast('লোড হচ্ছে…'); await ensureSb(); }
    if(!sb){ alert('Supabase লোড হয়নি। ইন্টারনেট/VPN/Adblock চেক করুন।'); return; }
    if(user){ if(confirm('লগআউট করবেন?')){ clearTimeout(saveTimer); await cloudPush(); await sb.auth.signOut(); } }
    else openAuth(true);
  });
  $('auth-close').addEventListener('click',()=>openAuth(false));
  $('auth-modal').addEventListener('click',e=>{ if(e.target.id==='auth-modal') openAuth(false); });
  $('auth-pass').addEventListener('keydown',e=>{ if(e.key==='Enter') $('auth-login').click(); });
  $('auth-login').addEventListener('click',async()=>{
    const c=cred(); if(!c.email||!c.password) return authMsg('ইমেইল ও পাসওয়ার্ড দিন।',true);
    authMsg('অপেক্ষা করুন…'); const {error}=await sb.auth.signInWithPassword(c); if(error) authMsg(error.message,true);
  });
  $('auth-signup').addEventListener('click',async()=>{
    const c=cred(); if(!c.email||c.password.length<6) return authMsg('সঠিক ইমেইল ও পাসওয়ার্ড (৬+) দিন।',true);
    authMsg('অপেক্ষা করুন…'); const {data,error}=await sb.auth.signUp({...c,options:{emailRedirectTo:redirect}});
    if(error) authMsg(error.message,true); else if(!data.session) authMsg('ইমেইলে কনফার্মেশন লিংক পাঠানো হয়েছে।');
  });
  $('auth-reset').addEventListener('click',async()=>{
    const email=$('auth-email').value.trim(); if(!email) return authMsg('ইমেইল লিখুন।',true);
    const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:redirect}); authMsg(error?error.message:'রিসেট লিংক পাঠানো হয়েছে।',!!error);
  });
  window.addEventListener('focus',()=>{ if(user&&Date.now()-lastPull>30000) cloudPull(); });
}

/* ---------- Trade Panel ---------- */
async function tradeCall(body){
  if(!sb||!user) throw new Error('আগে লগইন করুন');
  const payload=body.action==='whoami'?body:{...body,ex:EX};
  const {data,error}=await sb.functions.invoke('trade',{body:payload});
  if(error){ let m=error.message; try{ const j=await error.context.json(); if(j&&j.error) m=j.error; }catch(e){} throw new Error(m); }
  if(data&&data.error) throw new Error(data.error);
  // FIX: auto-journal on successful order
  if(body.action==='order' && data && data.ok && data.symbol){
    try{
      journal.push({id:Date.now(),date:new Date().toISOString().slice(0,10),symbol:data.symbol,side:(data.side==='SELL'?'Short':'Long'),setup:'Auto (Trade Panel)',pnl:0,open:true,ex:EX});
      persist(); renderJournal();
    }catch(e){}
  }
  return data;
}
const trMsg=(t,bad)=>{const e=$('tr-msg'); e.textContent=t; e.className='notice '+(bad?'red':'green');};
const trEnv=()=>{ const v=$('tr-env').value; return v==='live'?'live':(v==='demo'?'demo':'testnet'); };
function tradeParams(){
  const side=$('calc-side').value==='short'?'SELL':'BUY';
  return {env:trEnv(),symbol:selectedSymbol,side,sl:+$('calc-sl').value,tp:+$('calc-tp').value||0,leverage:+$('calc-leverage').value||1,riskPct:+$('calc-risk').value};
}
const TR_ENVS={binance:[['testnet','Testnet (নকল টাকা)'],['live','🔴 LIVE (আসল টাকা)']],bybit:[['demo','Demo (ভার্চুয়াল)'],['testnet','Testnet'],['live','🔴 LIVE (আসল টাকা)']]};
const ENV_LBL={testnet:'TESTNET',demo:'DEMO',live:'LIVE'};
let trEnvFor='';
function fillTrEnv(){
  const sel=$('tr-env'); if(!sel) return;
  const cur=sel.value, list=TR_ENVS[EX]||TR_ENVS.binance, keep=trEnvFor===EX&&list.some(x=>x[0]===cur);
  sel.innerHTML=''; list.forEach(([v,t])=>{ const o=document.createElement('option'); o.value=v; o.textContent=t; sel.appendChild(o); });
  sel.value=keep?cur:list[0][0]; trEnvFor=EX;
}
function showTradePreview(){
  const p=tradeParams(); if($('tr-sym')) $('tr-sym').textContent=p.symbol.replace('USDT','/USDT');
  if($('tr-preview')) $('tr-preview').textContent=`${EXCH[EX].name} · ${p.env==='live'?'🔴 ':''}${ENV_LBL[p.env]} · ${p.side==='BUY'?'Long':'Short'} ${p.symbol} · SL ${p.sl||'—'} · TP ${p.tp||'—'} · ${p.leverage}x · Risk ${p.riskPct}%`;
}
async function trStatus(){
  const env=trEnv(), live=env==='live', nm=EXCH[EX].name;
  $('tr-banner').style.display=live?'':'none'; $('tr-live-ctl').style.display=live?'':'none';
  $('tr-banner').textContent=`🔴 ${nm} LIVE মোড: এখানকার অর্ডার আসল টাকায় যাবে।`;
  $('tr-badge').textContent=live?`🔴 ${nm} LIVE`:env==='demo'?`${nm} DEMO`:`${nm} TESTNET`; $('tr-badge').className=live?'badge live':'badge';
  $('tr-place').textContent=live?`🔴 Place LIVE Order`:env==='demo'?'Place Order (Demo)':'Place Order (Testnet)';
  if(!user||!access||!access.canTrade) return;
  try{
    const s=await tradeCall({action:'status',env}), l=s.limits, h=(s.keys||{})[env];
    $('tr-key-state').innerHTML=`<b>${safe(nm)} ${safe(ENV_LBL[env]||env)} API Key:</b> ${h?`<span class="green">সংরক্ষিত ✓ (••••${safe(h)})</span>`:'<span class="red">সংরক্ষিত নেই, নিচে আপনার নিজের Key দিন</span>'}`;
    fillLimits(l);
    lastLimits=l; lastRisk=s.risk||null; lastLiveEnabled=(typeof s.liveEnabled==='boolean')?s.liveEnabled:null; lastLiveCfgErr=s.liveConfigError||'';
    renderRiskWarnings(); renderCalcWarnings();
    if(!live) return;
    $('tr-live-state').innerHTML=`<b class="${s.liveEnabled?'green':'red'}">${safe(nm)} LIVE: ${s.liveEnabled?'চালু':'বন্ধ'}</b>${s.liveConfigured?'':' · <b class="red">LIVE Key নেই</b>'}<br>আপনার সীমা: ঝুঁকি ≤ ${safe(l.maxRiskPct)}% · লিভ ≤ ${safe(l.maxLeverage)}x · মূল্য ${l.maxNotional>0?'≤ $'+safe(l.maxNotional):'সীমাহীন'} · পজিশন ${l.maxPositions>0?'≤ '+safe(l.maxPositions):'সীমাহীন'} · দিনে ${l.maxTradesPerDay>0?'≤ '+safe(l.maxTradesPerDay):'সীমাহীন'} · দৈনিক লস ${l.dailyLossPct>0?safe(l.dailyLossPct)+'%':'বন্ধ'} · SL ≥ ${safe(l.minSlPct)}%`;
  }catch(e){ if(live) $('tr-live-state').textContent=e.message; else $('tr-key-state').textContent=e.message; }
}
let trBusy=false, trAgain=false, trFails=0, trPauseUntil=0;
const TR_AUTO_MS=5000;
const trAutoOn=()=>{ try{ return localStorage.getItem('ctb-trauto')!=='0'; }catch(e){ return true; } };
async function refreshTrade(silent){
  if(trBusy){ trAgain=true; return; } trBusy=true;
  if(!silent) showTradePreview();
  const envNow=trEnv(), exNow=EX;
  try{
    const a=await tradeCall({action:'account',env:envNow});
    if(envNow!==trEnv()||exNow!==EX) return;
    balancesByEnv[exNow][envNow]=a.balance; balanceSyncReady=true; syncBalanceUI(); renderRiskWarnings();
    $('tr-bal').textContent=fmtMoney(a.balance); $('tr-avail').textContent=fmtMoney(a.available); $('tr-count').textContent=a.positions.length;
    $('tr-table').innerHTML=a.positions.map(p=>`<tr><td>${safe(p.symbol)}</td><td class="${p.amt>0?'green':'red'}">${p.amt>0?'Long':'Short'} ${Math.abs(p.amt)}</td><td>$${fmtPrice(p.entry)}</td><td>$${fmtPrice(p.mark)}</td><td class="${p.pnl>=0?'green':'red'}">${fmtMoney(p.pnl)}</td><td><button data-close-pos="${safe(p.symbol)}">Close</button></td></tr>`).join('')||'<tr><td colspan="6" class="empty">কোনো খোলা পজিশন নেই।</td></tr>';
    const hadErr=trFails>0; trFails=0; $('tr-updated').textContent='শেষ আপডেট: '+new Date().toLocaleTimeString();
    if(!silent||hadErr) trMsg(hadErr?'আবার সংযুক্ত।':'আপডেট হয়েছে।');
  }catch(e){
    trFails++;
    if(!silent||trFails===1) trMsg(e.message,true);
    if(silent&&(trFails>=3||/অনেক বেশি/.test(e.message))){ trPauseUntil=Date.now()+60000; trMsg('অটো-রিফ্রেশ ১ মিনিট থেমেছে: '+e.message,true); }
  }finally{ trBusy=false; if(trAgain){ trAgain=false; setTimeout(()=>refreshTrade(true),50); } }
}
function trAutoTick(){
  if(!trAutoOn()||document.hidden||!user) return;
  if(trPauseUntil){ if(Date.now()<trPauseUntil) return; trPauseUntil=0; trFails=0; }
  const tp=$('trade-panel'); if(!tp||tp.style.display==='none') return;
  refreshTrade(true);
}
function setupTrade(){
  $('tr-auto').checked=trAutoOn();
  $('tr-auto').addEventListener('change',e=>{ try{ localStorage.setItem('ctb-trauto',e.target.checked?'1':'0'); }catch(x){} if(e.target.checked){ trPauseUntil=0; trFails=0; trAutoTick(); } });
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden) trAutoTick(); });
  setInterval(trAutoTick,TR_AUTO_MS);
  $('tr-refresh').addEventListener('click',refreshTrade);
  ['calc-side','calc-sl','calc-tp','calc-leverage','calc-risk'].forEach(i=>$(i).addEventListener('input',showTradePreview));
  $('tr-env').addEventListener('change',()=>{ lastRisk=null; lastLiveEnabled=null; trStatus(); syncBalanceUI(); renderRiskWarnings(); refreshTrade(); });
  $('tr-place').addEventListener('click',async()=>{
    const p=tradeParams(), live=p.env==='live'; showTradePreview();
    if(!(p.sl>0)) return trMsg('Calculator-এ Stop Loss দিন।',true);
    if(!confirm(`${live?'🔴 LIVE — আসল টাকা!':p.env==='demo'?'DEMO':'TESTNET'}\n${EXCH[EX].name} · ${p.side==='BUY'?'Long':'Short'} ${p.symbol}\nSL ${p.sl} | TP ${p.tp||'নেই'}\nLev ${p.leverage}x | Risk ${p.riskPct}%${confirmLimitsText(p)}\n\nঅর্ডার দেবেন?`)) return;
    let typed=''; if(live) typed=p.symbol;
    trMsg('অর্ডার পাঠানো হচ্ছে…'); const btn=$('tr-place'); btn.disabled=true;
    try{ const r=await tradeCall({action:'order',...p,confirm:typed,clientId:(window.crypto&&crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random().toString(36).slice(2))}); trMsg(`সফল${live?' (LIVE)':''}: ${r.side} ${r.qty} ${r.symbol} @~${fmtPrice(r.fill||r.mark)}${r.warning?' ⚠️ '+r.warning:''}`,!!r.warning); refreshTrade(); }
    catch(e){ trMsg(e.message,true); }
    finally{ setTimeout(()=>{ btn.disabled=false; },2500); }
  });
  $('tr-keycheck').addEventListener('click',async()=>{
    try{ const k=await tradeCall({action:'keycheck',env:'live'}); trMsg((k.ok?'✅ Key ঠিক ':'❌ '+k.problems.join(' | ')+' ')+(k.warnings&&k.warnings.length?'⚠️ '+k.warnings.join(' | '):''),!k.ok); }catch(e){ trMsg(e.message,true); }
  });
  $('tr-live-on').addEventListener('click',async()=>{
    const t=prompt('LIVE চালু করতে লিখুন: ENABLE LIVE'); if(t!=='ENABLE LIVE') return trMsg('মেলেনি।',true);
    try{ await tradeCall({action:'live_on',env:'live',confirm:t}); trMsg('LIVE চালু।'); }catch(e){ trMsg(e.message,true); } trStatus();
  });
  $('tr-live-off').addEventListener('click',async()=>{ try{ await tradeCall({action:'live_off',env:'live'}); trMsg('LIVE বন্ধ।'); }catch(e){ trMsg(e.message,true); } trStatus(); });
  $('tr-panic').addEventListener('click',async()=>{
    if(!confirm('🛑 সব LIVE পজিশন বন্ধ?')) return;
    try{ const r=await tradeCall({action:'panic',env:'live'}); trMsg(r.ok?`জরুরি বন্ধ সম্পন্ন (${r.closed.length})।`:'⚠️ কিছু বন্ধ হয়নি: '+r.failed.join(' ; '),!r.ok); }catch(e){ trMsg('🚨 '+e.message,true); }
    refreshTrade(); trStatus();
  });
  $('tr-table').addEventListener('click',async e=>{
    const b=e.target.closest('[data-close-pos]'); if(!b||!confirm(b.dataset.closePos+' বন্ধ করবেন?')) return;
    try{ await tradeCall({action:'close',env:trEnv(),symbol:b.dataset.closePos}); trMsg('বন্ধ হয়েছে।'); refreshTrade(); }catch(err){ trMsg(err.message,true); }
  });
  trStatus();
}

/* ---------- Sanitize + Init ---------- */
const TFS=['5m','15m','1h','4h','1d'];
function sanitizeState(){
  watchlist=[...new Set((Array.isArray(watchlist)?watchlist:[]).map(x=>normSymbol(x)).filter(x=>/^[A-Z0-9]{2,20}USDT$/.test(x)))].slice(0,50); if(!watchlist.length) watchlist=[...defaultPairs];
  journal=(Array.isArray(journal)?journal:[]).filter(t=>t&&typeof t==='object').slice(0,5000).map(t=>({id:Number(t.id)||Date.now(),date:String(t.date||'').slice(0,10),symbol:String(t.symbol||'').slice(0,30),side:t.side==='Short'?'Short':'Long',setup:String(t.setup||'').slice(0,60),pnl:Number(t.pnl)||0,open:t.open===true,ex:t.ex==='bybit'?'bybit':'binance'}));
  alerts=(Array.isArray(alerts)?alerts:[]).filter(a=>a&&typeof a==='object').slice(0,200).map(a=>{ a.id=Number(a.id)||Date.now(); a.symbol=normSymbol(a.symbol||''); if(!EXCH[a.ex]) a.ex='binance'; if(a.tf&&!TFS.includes(a.tf)) a.tf='15m'; return a; });
  settings.refresh=Math.min(300000,Math.max(5000,Number(settings.refresh)||30000)); settings.balance=Math.max(0,Number(settings.balance)||0);
  settings.ltfConfirm=settings.ltfConfirm===true;
  if(!TFS.includes(settings.interval)) settings.interval='15m'; settings.symbol=normSymbol(settings.symbol||'BTCUSDT'); if(!['dark','light'].includes(settings.theme)) settings.theme='dark'; if(!EXCH[settings.exchange]) settings.exchange='binance'; EX=settings.exchange;
}
function init(){
  sanitizeState(); EX=EXCH[settings.exchange]?settings.exchange:'binance';
  const lg=document.querySelector('.brand-logo'); if(lg){ const hide=()=>{ lg.style.display='none'; }; lg.addEventListener('error',hide); if(lg.complete&&lg.naturalWidth===0) hide(); }
  applyTheme();
  $('j-date').value=new Date().toISOString().slice(0,10);
  $('setting-balance').value=settings.balance;
  $('setting-refresh').value=String(settings.refresh); $('setting-language').value=settings.language;
  setupEvents(); setupAuth(); setupTrade(); setupAccess(); setupBalanceWarn(); setupAlerts(); setupNav(); setupWorkspaces(); setupExchange(); setupCalcCopy(); setupPWA(); setupAutopilot(); setupBacktest();
  if($('fib-scan')) $('fib-scan').addEventListener('click',runFibScan);
  renderWatchlist(); renderMiniCards(); renderJournal(); renderAlerts(); updateKillZones();
  selectedSymbol=normSymbol(settings.symbol||'BTCUSDT'); selectedInterval=settings.interval||'15m';
  document.querySelectorAll('#timeframes button').forEach(b=>b.classList.toggle('active',b.dataset.interval===selectedInterval));
  fetchGlobal(); fetchMarket(); connectSocket();
  selectSymbol(selectedSymbol);
  refreshTimer=setInterval(fetchMarket,settings.refresh);
  setInterval(updateKillZones,10000);
  setInterval(()=>{ if(!document.hidden) runFunding(); },60000);
  setInterval(checkIndicatorAlerts,60000);
  setInterval(fetchGlobal,300000);
  syncBalanceUI(); renderRiskWarnings(); renderCalcWarnings();
}
init();
})();
