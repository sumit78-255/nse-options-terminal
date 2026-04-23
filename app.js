// ============ NSE Options Terminal â core logic ============
const PROXIES = [
  u => 'https://corsproxy.io/?' + encodeURIComponent(u),
  u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  u => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
];
const IDX_CONF = {
  NIFTY:     { name:'Nifty 50',    yahoo:'%5ENSEI',    nseSym:'NIFTY',     lot:75,  step:50 },
  BANKNIFTY: { name:'Bank Nifty',  yahoo:'%5ENSEBANK', nseSym:'BANKNIFTY', lot:15,  step:100 },
  SENSEX:    { name:'BSE Sensex',  yahoo:'%5EBSESN',   nseSym:'SENSEX',    lot:10,  step:100 },
};
const REFRESH_MS = 5 * 60 * 1000;
const STALE_MS = 10 * 60 * 1000;
const state = {
  currentIdx: 'NIFTY',
  oi: { NIFTY:null, BANKNIFTY:null, SENSEX:null },
  spots: { NIFTY:null, BANKNIFTY:null, SENSEX:null },
  candles: {},
  vix: null,
  pcr: { NIFTY:null, BANKNIFTY:null, SENSEX:null },
  lastFetchOK: null,
  alerts: [],
  lastAlertKeys: {},
  news: [],
  newsKeywordSeen: new Set(),
  rsiPrev: {},
  emaPrev: {},
  breakoutPrev: {},
  popups: [],
  spotPrev5m: {},
  mismatchActive: false,
};
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e) { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) {} },
};
state.alerts = LS.get('alerts_v1', []);
state.trades = LS.get('trades_v1', []);
state.lastAlertKeys = LS.get('alertkeys_v1', {});
function fmt(n, d = 2) { if (n == null || isNaN(n)) return '--'; return Number(n).toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fmtInt(n) { if (n == null || isNaN(n)) return '--'; return Math.round(n).toLocaleString('en-IN'); }
function istNow() { const d = new Date(); const utc = d.getTime() + d.getTimezoneOffset() * 60000; return new Date(utc + 5.5 * 3600000); }
function istHMS() { const d = istNow(); const p = n => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} IST`; }
function istHM() { const d = istNow(); const p = n => String(n).padStart(2, '0'); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
async function fetchProxied(url, asJson = true) {
  for (let i = 0; i < PROXIES.length; i++) {
    try {
      const r = await fetch(PROXIES[i](url), { headers: { 'Accept': 'application/json,text/html,*/*' } });
      if (!r.ok) continue;
      if (asJson) return await r.json();
      return await r.text();
    } catch (e) { /* try next */ }
  }
  throw new Error('All proxies failed for ' + url);
}
async function fetchDirect(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  return r.json();
}
function tickClock() {
  document.getElementById('ist-clock').textContent = istHMS();
}
setInterval(tickClock, 1000); tickClock();
function setStatus(ok, msg) {
  const b = document.getElementById('status-badge');
  const warn = document.getElementById('stale-warn');
  if (ok) {
    b.className = 'badge ok'; b.textContent = 'LIVE';
    warn.classList.remove('show'); warn.textContent = '';
  } else {
    b.className = 'badge stale'; b.textContent = 'STALE';
    warn.textContent = msg || ('STALE DATA â last successful fetch ' + (state.lastFetchOK ? istHM.call(null) : 'never'));
    warn.classList.add('show');
  }
}
function updateLastUpdate() {
  const el = document.getElementById('last-update');
  if (state.lastFetchOK) {
    const age = (Date.now() - state.lastFetchOK) / 1000;
    const ts = new Date(state.lastFetchOK);
    const ist = new Date(ts.getTime() + ts.getTimezoneOffset() * 60000 + 5.5 * 3600000);
    const p = n => String(n).padStart(2, '0');
    el.textContent = `Last: ${p(ist.getHours())}:${p(ist.getMinutes())}:${p(ist.getSeconds())}`;
    if (age * 1000 > STALE_MS) setStatus(false);
  } else {
    el.textContent = 'Last: never';
  }
}
setInterval(updateLastUpdate, 5000);
// ============ Yahoo Finance spot & candles ============
async function fetchYahooCandles(yahooSym, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=${interval}&range=${range}`;
  try {
    return await fetchDirect(url);
  } catch(e) {
    return await fetchProxied(url, true);
  }
}
function parseYahooCandles(j) {
  if (!j || !j.chart || !j.chart.result || !j.chart.result[0]) return null;
  const r = j.chart.result[0];
  const ts = r.timestamp || [];
  const q = r.indicators.quote[0] || {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    out.push({
      t: ts[i] * 1000,
      o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i],
      v: q.volume ? q.volume[i] : 0,
    });
  }
  const meta = r.meta || {};
  return { candles: out, meta };
}
async function fetchSpot(idx) {
  const conf = IDX_CONF[idx];
  const j = await fetchYahooCandles(conf.yahoo, '5m', '1d');
  const p = parseYahooCandles(j);
  if (!p) throw new Error('spot parse fail');
  const meta = p.meta;
  const price = meta.regularMarketPrice ?? (p.candles.length ? p.candles[p.candles.length-1].c : null);
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  const chg = price - prev;
  const chgp = prev ? (chg / prev) * 100 : 0;
  state.spots[idx] = { price, prev, chg, chgp, ts: Date.now() };
  return state.spots[idx];
}
async function fetchAllCandles() {
  for (const idx of Object.keys(IDX_CONF)) {
    const conf = IDX_CONF[idx];
    state.candles[idx] = {};
    const tfs = [['5m','5d'], ['15m','1mo'], ['1h','3mo'], ['1d','2y'], ['1wk','5y']];
    for (const [int, range] of tfs) {
      try {
        const j = await fetchYahooCandles(conf.yahoo, int, range);
        const p = parseYahooCandles(j);
        if (p) state.candles[idx][int] = p.candles;
      } catch(e) { console.warn('candle fail', idx, int, e.message); }
    }
  }
}
async function fetchVIX() {
  try {
    const j = await fetchYahooCandles('%5EINDIAVIX', '5m', '1d');
    const p = parseYahooCandles(j);
    if (!p) return;
    const price = p.meta.regularMarketPrice ?? (p.candles.length ? p.candles[p.candles.length-1].c : null);
    const prev = p.meta.chartPreviousClose ?? p.meta.previousClose;
    state.vix = { price, prev, chg: price - prev, chgp: prev ? ((price - prev) / prev * 100) : 0 };
  } catch(e) { console.warn('vix fail', e.message); }
}
// ============ NSE Options Chain ============
async function fetchOptionChain(sym) {
  const isBSE = sym === 'SENSEX';
  const url = isBSE
    ? 'https://api.bseindia.com/BseIndiaAPI/api/ddlExpiry_IV/w?scrip_cd=SENSEX&ProductType=IO'
    : `https://www.nseindia.com/api/option-chain-indices?symbol=${sym}`;
  // For SENSEX on BSE, chain API differs; fall back gracefully
  if (isBSE) {
    // Try NSE sensex proxy alt â BSE doesn't expose same chain freely. Return null.
    try { return await fetchProxied(`https://www.nseindia.com/api/option-chain-indices?symbol=${sym}`, true); }
    catch(e) { return null; }
  }
  try { return await fetchProxied(url, true); } catch(e) { return null; }
}
function processChain(raw, sym) {
  if (!raw || !raw.records || !raw.records.data) return null;
  const rec = raw.records;
  const data = rec.data;
  const expiries = rec.expiryDates || [];
  const underlying = rec.underlyingValue || 0;
  // group by expiry
  const byExp = {};
  for (const row of data) {
    const e = row.expiryDate;
    if (!byExp[e]) byExp[e] = [];
    byExp[e].push(row);
  }
  return { expiries, underlying, byExp, ts: Date.now() };
}
async function fetchAllChains() {
  for (const idx of Object.keys(IDX_CONF)) {
    try {
      const raw = await fetchOptionChain(IDX_CONF[idx].nseSym);
      const p = processChain(raw, idx);
      if (p) state.oi[idx] = p;
    } catch(e) { console.warn('chain fail', idx, e.message); }
  }
  // compute PCR per index
  for (const idx of Object.keys(IDX_CONF)) {
    const oi = state.oi[idx];
    if (!oi) { state.pcr[idx] = null; continue; }
    const allRows = Object.values(oi.byExp).flat();
    let ceOI = 0, peOI = 0;
    for (const r of allRows) {
      if (r.CE) ceOI += (r.CE.openInterest || 0);
      if (r.PE) peOI += (r.PE.openInterest || 0);
    }
    state.pcr[idx] = ceOI ? (peOI / ceOI) : null;
  }
}
// ============ Indicators ============
function calcRSI(closes, period) {
  if (closes.length < period + 1) return [];
  const out = new Array(closes.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  out[period] = avgL === 0 ? 100 : 100 - (100 / (1 + avgG/avgL));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - (100 / (1 + avgG/avgL));
  }
  return out;
}
function calcEMA(values, period) {
  if (values.length < period) return [];
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let sma = 0;
  for (let i = 0; i < period; i++) sma += values[i];
  sma /= period;
  out[period - 1] = sma;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i-1] * (1 - k);
  }
  return out;
}
// Resample 15m candles to 45m or 75m
function resample(candles, groupSize) {
  if (!candles || !candles.length) return [];
  const out = [];
  for (let i = 0; i + groupSize <= candles.length; i += groupSize) {
    const grp = candles.slice(i, i + groupSize);
    out.push({
      t: grp[0].t, o: grp[0].o,
      h: Math.max(...grp.map(c => c.h)),
      l: Math.min(...grp.map(c => c.l)),
      c: grp[grp.length-1].c,
      v: grp.reduce((s, c) => s + (c.v || 0), 0),
    });
  }
  return out;
}
// ============ Candlestick patterns ============
function isHammer(c) {
  const body = Math.abs(c.c - c.o);
  const upper = c.h - Math.max(c.o, c.c);
  const lower = Math.min(c.o, c.c) - c.l;
  return lower > body * 2 && upper < body * 0.3 && body > 0;
}
function isBullishEngulf(p, c) {
  return p.c < p.o && c.c > c.o && c.o < p.c && c.c > p.o;
}
function isBearishEngulf(p, c) {
  return p.c > p.o && c.c < c.o && c.o > p.c && c.c < p.o;
}
function isMorningStar(a, b, c) {
  return a.c < a.o && Math.abs(b.c - b.o) < Math.abs(a.c - a.o) * 0.5 && c.c > c.o && c.c > (a.o + a.c) / 2;
}
function isEveningStar(a, b, c) {
  return a.c > a.o && Math.abs(b.c - b.o) < Math.abs(a.c - a.o) * 0.5 && c.c < c.o && c.c < (a.o + a.c) / 2;
}
function isShootingStar(c) {
  const body = Math.abs(c.c - c.o);
  const upper = c.h - Math.max(c.o, c.c);
  const lower = Math.min(c.o, c.c) - c.l;
  return upper > body * 2 && lower < body * 0.3 && body > 0;
}
function detectPatterns(cs) {
  if (!cs || cs.length < 3) return [];
  const out = [];
  const last = cs[cs.length-1], prev = cs[cs.length-2], prev2 = cs[cs.length-3];
  if (isHammer(last)) out.push({ name:'Hammer', bull:true });
  if (isShootingStar(last)) out.push({ name:'Shooting Star', bull:false });
  if (isBullishEngulf(prev, last)) out.push({ name:'Bullish Engulfing', bull:true });
  if (isBearishEngulf(prev, last)) out.push({ name:'Bearish Engulfing', bull:false });
  if (isMorningStar(prev2, prev, last)) out.push({ name:'Morning Star', bull:true });
  if (isEveningStar(prev2, prev, last)) out.push({ name:'Evening Star', bull:false });
  return out;
}
// ============ Max pain ============
function maxPain(rows) {
  if (!rows || !rows.length) return null;
  const strikes = [...new Set(rows.map(r => r.strikePrice))].sort((a,b)=>a-b);
  let minPain = Infinity, mpStrike = null;
  for (const s of strikes) {
    let pain = 0;
    for (const r of rows) {
      const ceOI = r.CE && r.CE.openInterest || 0;
      const peOI = r.PE && r.PE.openInterest || 0;
      const k = r.strikePrice;
      if (k < s) pain += (s - k) * ceOI;
      if (k > s) pain += (k - s) * peOI;
    }
    if (pain < minPain) { minPain = pain; mpStrike = s; }
  }
  return mpStrike;
}
// ============ UI renderers ============
function renderTopBar() {
  const cards = [['NIFTY','card-nifty'],['BANKNIFTY','card-banknifty'],['SENSEX','card-sensex']];
  for (const [idx, id] of cards) {
    const s = state.spots[idx];
    const el = document.getElementById(id);
    if (!s) continue;
    const chgCls = s.chg >= 0 ? 'g' : 'r';
    const sign = s.chg >= 0 ? '+' : '';
    el.querySelector('.price').textContent = fmt(s.price);
    el.querySelector('.price').className = 'price mono ' + chgCls;
    el.querySelector('.chg').innerHTML = `<span class="${chgCls}">${sign}${fmt(s.chg)} (${sign}${fmt(s.chgp)}%)</span> <span class="m">prev ${fmt(s.prev)}</span>`;
  }
  // VIX
  const vixEl = document.getElementById('card-vix');
  if (state.vix) {
    const v = state.vix.price;
    let cls = 'g';
    if (v > 18) cls = 'r'; else if (v >= 15) cls = 'a';
    const sign = state.vix.chg >= 0 ? '+' : '';
    vixEl.querySelector('.price').textContent = fmt(v);
    vixEl.querySelector('.price').className = 'price mono ' + cls;
  }
  // PCR line
  const pcrLine = document.getElementById('pcr-line');
  const p = state.pcr;
  pcrLine.textContent = `PCR N:${p.NIFTY?fmt(p.NIFTY):'--'} BN:${p.BANKNIFTY?fmt(p.BANKNIFTY):'--'} SX:${p.SENSEX?fmt(p.SENSEX):'--'}`;
}
let oiSortCol = 'strikePrice', oiSortDir = 1;
function switchIdx(idx) {
  state.currentIdx = idx;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.idx === idx));
  renderOI();
  renderSR();
}
function populateExpiries() {
  const oi = state.oi[state.currentIdx];
  const sel = document.getElementById('expiry-select');
  sel.innerHTML = '';
  if (!oi || !oi.expiries.length) { sel.innerHTML = '<option>--</option>'; return; }
  // detect if current expiry within 2 trading days â we approximate by date diff <=3 calendar days
  const now = new Date();
  let activeExp = oi.expiries[0];
  const first = parseExpiry(oi.expiries[0]);
  if (first) {
    const diff = (first - now) / 86400000;
    if (diff <= 2 && oi.expiries[1]) activeExp = oi.expiries[1];
  }
  for (const e of oi.expiries) {
    const opt = document.createElement('option');
    opt.value = e; opt.textContent = e;
    if (e === activeExp) opt.selected = true;
    sel.appendChild(opt);
  }
}
function parseExpiry(s) {
  // "29-May-2026"
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(s);
  if (!m) return null;
  const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  return new Date(Date.UTC(+m[3], months[m[2]], +m[1]));
}
function renderOI() {
  const idx = state.currentIdx;
  const oi = state.oi[idx];
  const body = document.getElementById('oi-body');
  const mpEl = document.getElementById('maxpain-val');
  populateExpiries();
  if (!oi) {
    body.innerHTML = `<div class="m" style="text-align:center;padding:20px;">NSE options chain temporarily unavailable for ${idx} (CORS proxy blocked). Yahoo-powered modules still work.</div>`;
    mpEl.textContent = '--';
    return;
  }
  const exp = document.getElementById('expiry-select').value;
  const rows = oi.byExp[exp] || [];
  const mp = maxPain(rows);
  mpEl.textContent = mp ? fmtInt(mp) : '--';
  const spot = oi.underlying;
  const step = IDX_CONF[idx].step;
  const atmStrike = Math.round(spot / step) * step;
  // Sort rows
  const sorted = [...rows].sort((a,b) => (a.strikePrice - b.strikePrice));
  // build rows
  const html = [];
  html.push('<table><thead><tr>');
  const cols = [
    ['Strike','strikePrice'],['CE OI','ceOI'],['CE ÎOI','ceChg'],['CE Vol','ceVol'],
    ['PE OI','peOI'],['PE ÎOI','peChg'],['PE Vol','peVol'],['IV','iv'],['Signal','sig'],
  ];
  for (const [t,k] of cols) html.push(`<th onclick="sortOI('${k}')">${t}</th>`);
  html.push('</tr></thead><tbody>');
  // Detect top signals in window Â±8 strikes around ATM
  const window = sorted.filter(r => Math.abs(r.strikePrice - atmStrike) <= step * 8);
  const maxCEChg = Math.max(0, ...window.map(r => r.CE ? r.CE.changeinOpenInterest || 0 : 0));
  const maxPEChg = Math.max(0, ...window.map(r => r.PE ? r.PE.changeinOpenInterest || 0 : 0));
  let callWritingStrike = null, putWritingStrike = null;
  for (const r of window) {
    if (r.CE && r.CE.changeinOpenInterest > 0 && r.CE.changeinOpenInterest === maxCEChg) callWritingStrike = r.strikePrice;
    if (r.PE && r.PE.changeinOpenInterest > 0 && r.PE.changeinOpenInterest === maxPEChg) putWritingStrike = r.strikePrice;
  }
  for (const r of window) {
    const atm = r.strikePrice === atmStrike;
    const ce = r.CE || {}; const pe = r.PE || {};
    const ceChg = ce.changeinOpenInterest || 0, peChg = pe.changeinOpenInterest || 0;
    let sig = '';
    const ceUnwind = ceChg < 0 && ce.openInterest && (ceChg / (ce.openInterest - ceChg)) < -0.2;
    const peUnwind = peChg < 0 && pe.openInterest && (peChg / (pe.openInterest - peChg)) < -0.2;
    if (r.strikePrice === callWritingStrike) sig = '<span class="sigbadge sig-cw">CALL WR</span>';
    else if (r.strikePrice === putWritingStrike) sig = '<span class="sigbadge sig-pw">PUT WR</span>';
    else if (ceUnwind || peUnwind) sig = '<span class="sigbadge sig-un">UNWIND</span>';
    const iv = ce.impliedVolatility || pe.impliedVolatility || 0;
    html.push(`<tr class="${atm?'atm':''}">
      <td>${fmtInt(r.strikePrice)}</td>
      <td>${fmtInt(ce.openInterest)}</td>
      <td class="${ceChg>=0?'g':'r'}">${ceChg>=0?'+':''}${fmtInt(ceChg)}</td>
      <td>${fmtInt(ce.totalTradedVolume)}</td>
      <td>${fmtInt(pe.openInterest)}</td>
      <td class="${peChg>=0?'g':'r'}">${peChg>=0?'+':''}${fmtInt(peChg)}</td>
      <td>${fmtInt(pe.totalTradedVolume)}</td>
      <td>${iv ? fmt(iv) : '--'}</td>
      <td>${sig}</td>
    </tr>`);
  }
  html.push('</tbody></table>');
  // trade suggestion
  html.push(renderSuggestion(idx, spot, callWritingStrike, putWritingStrike, window, mp));
  body.innerHTML = html.join('');
}
function sortOI(k) { oiSortCol = k; oiSortDir = -oiSortDir; renderOI(); }
function renderSuggestion(idx, spot, cw, pw, rows, mp) {
  if (state.mismatchActive) {
    return `<div class="suggestion neutral"><div class="tag">NEUTRAL</div><div>Auto-suggestion suppressed â spot/premium mismatch active.</div><div class="reason">Watch for IV drop or illiquidity before entering.</div></div>`;
  }
  const step = IDX_CONF[idx].step;
  if (cw && cw > spot) {
    // bearish wall
    const support = rows.filter(r => r.strikePrice < spot).sort((a,b) => (b.PE && b.PE.openInterest || 0) - (a.PE && a.PE.openInterest || 0))[0];
    const target = support ? support.strikePrice : (spot - step * 3);
    return `<div class="suggestion bearish"><div class="tag">BEARISH BIAS</div><div>Bearish wall at <b>${fmtInt(cw)}</b> â consider ATM/OTM PE, target next support at <b>${fmtInt(target)}</b>.</div><div class="reason">Highest CE OI buildup above spot (${fmtInt(spot)}) suggests sellers defending ${fmtInt(cw)}.</div></div>`;
  }
  if (pw && pw < spot) {
    const res = rows.filter(r => r.strikePrice > spot).sort((a,b) => (b.CE && b.CE.openInterest || 0) - (a.CE && a.CE.openInterest || 0))[0];
    const target = res ? res.strikePrice : (spot + step * 3);
    return `<div class="suggestion"><div class="tag">BULLISH BIAS</div><div>Bullish floor at <b>${fmtInt(pw)}</b> â consider ATM/OTM CE, target next resistance at <b>${fmtInt(target)}</b>.</div><div class="reason">Highest PE OI buildup below spot (${fmtInt(spot)}) suggests sellers defending ${fmtInt(pw)}.</div></div>`;
  }
  return `<div class="suggestion neutral"><div class="tag">NEUTRAL</div><div>No dominant writing cluster near ATM. Max Pain ${fmtInt(mp)}.</div><div class="reason">Wait for clearer OI directional bias before committing to directional options.</div></div>`;
}
// ============ RSI Engine render ============
function renderRSI() {
  const body = document.getElementById('rsi-body');
  const idxs = ['NIFTY','BANKNIFTY','SENSEX'];
  const tfMap = [
    ['5m','5m',false,null],
    ['15m','15m',false,null],
    ['45m','15m',true,3],
    ['75m','15m',true,5],
    ['1D','1d',false,null],
    ['1W','1wk',false,null],
  ];
  const html = [];
  for (const idx of idxs) {
    html.push(`<div style="margin-bottom:8px;"><div class="head" style="font-size:12px;margin-bottom:4px;">${IDX_CONF[idx].name}</div><div class="gauge-grid">`);
    for (const [label, src, resample_f, group] of tfMap) {
      let cs = state.candles[idx] && state.candles[idx][src];
      if (!cs) { html.push(`<div class="gauge"><div class="tf">${label}</div><div class="vals m">--</div></div>`); continue; }
      if (resample_f) cs = resample(cs, group);
      const closes = cs.map(c => c.c);
      const r5 = calcRSI(closes, 5), r14 = calcRSI(closes, 14);
      const v5 = r5[r5.length-1], v14 = r14[r14.length-1];
      if (v5 == null || v14 == null) { html.push(`<div class="gauge"><div class="tf">${label}</div><div class="vals m">--</div></div>`); continue; }
      let chipCls = '';
      if (Math.abs(v5 - v14) < 2) chipCls = 'a';
      else if (v5 > v14) chipCls = 'g'; else chipCls = 'r';
      const chipColor = chipCls === 'g' ? 'var(--green)' : chipCls === 'r' ? 'var(--red)' : 'var(--amber)';
      html.push(`<div class="gauge"><div class="tf">${label}</div><div class="vals"><span class="rsi mono ${chipCls}">${fmt(v5,1)}/${fmt(v14,1)}</span><span class="chip" style="background:${chipColor};"></span></div></div>`);
      // Crossover detection
      const prev5 = r5[r5.length-2], prev14 = r14[r14.length-2];
      if (prev5 != null && prev14 != null) {
        const crossUp = prev5 <= prev14 && v5 > v14;
        const crossDn = prev5 >= prev14 && v5 < v14;
        const key = `${idx}-${label}-xo`;
        const prevKey = state.lastAlertKeys[key];
        if (crossUp || crossDn) {
          const sig = crossUp ? 'CONFIRMED BUY' : 'CONFIRMED SELL';
          const t1 = ['45m','75m','1D','1W'].includes(label);
          const curStamp = `${cs[cs.length-1].t}`;
          if (prevKey !== curStamp) {
            if (t1) {
              pushAlert('crit', `${sig} â ${idx} ${label} RSI5/14 crossover`);
              showPopup(`${sig}`, `${idx} ${label} RSI crossover fresh on latest candle`);
            } else {
              // Tier 2: require sustain 2+ candles: only alert if previous candle's crossover same direction
              const c5 = r5[r5.length-3], c14 = r14[r14.length-3];
              if (c5 != null && c14 != null) {
                const sustain = crossUp ? (prev5 > prev14 || c5 > c14) : (prev5 < prev14 || c5 < c14);
                if (sustain) pushAlert('imp', `${sig} sustained â ${idx} ${label} RSI5/14`);
              }
            }
            state.lastAlertKeys[key] = curStamp;
          }
        }
      }
    }
    html.push('</div></div>');
  }
  body.innerHTML = html.join('');
}
// ============ EMA render ============
function renderEMA() {
  const body = document.getElementById('ema-body');
  const idxs = ['NIFTY','BANKNIFTY','SENSEX'];
  const tfs = [['5m','5m'],['15m','15m'],['1h','1h'],['1d','1d']];
  const html = [];
  for (const idx of idxs) {
    html.push(`<div style="margin-bottom:8px;"><div class="head" style="font-size:12px;margin-bottom:4px;">${IDX_CONF[idx].name}</div>`);
    // banner for fresh cross on this idx, first tf with fresh cross
    let banner = '';
    html.push('<table><thead><tr><th>TF</th><th>EMA13</th><th>EMA50</th><th>EMA200</th><th>Trend</th></tr></thead><tbody>');
    for (const [lbl, src] of tfs) {
      const cs = state.candles[idx] && state.candles[idx][src];
      if (!cs || cs.length < 200) { html.push(`<tr><td>${lbl}</td><td colspan="4" class="m">insufficient data</td></tr>`); continue; }
      const closes = cs.map(c => c.c);
      const e13 = calcEMA(closes, 13), e50 = calcEMA(closes, 50), e200 = calcEMA(closes, 200);
      const L = closes.length - 1;
      const v13 = e13[L], v50 = e50[L], v200 = e200[L];
      // fresh cross if e13 crossed e50 in last 3 candles
      let fresh = false, crossDir = 0;
      for (let i = Math.max(1, L - 2); i <= L; i++) {
        if (e13[i-1] == null || e50[i-1] == null) continue;
        if (e13[i-1] <= e50[i-1] && e13[i] > e50[i]) { fresh = true; crossDir = 1; }
        if (e13[i-1] >= e50[i-1] && e13[i] < e50[i]) { fresh = true; crossDir = -1; }
      }
      let trend = 'NEUTRAL', tcls = 'm';
      if (v13 > v50 && v50 > v200) { trend = 'STRONG UP'; tcls = 'g'; }
      else if (v13 < v50 && v50 < v200) { trend = 'STRONG DN'; tcls = 'r'; }
      else if (v13 > v50) { trend = 'UP'; tcls = 'g'; }
      else if (v13 < v50) { trend = 'DN'; tcls = 'r'; }
      html.push(`<tr class="${fresh?'ema-row fresh':''}"><td>${lbl}</td><td class="mono">${fmt(v13)}</td><td class="mono">${fmt(v50)}</td><td class="mono">${fmt(v200)}</td><td class="${tcls}">${trend}${fresh?' *':''}</td></tr>`);
      if (fresh && !banner) {
        banner = crossDir > 0
          ? `<div class="ema-banner">CLEAR BUY â EMA13 &gt; EMA50 on ${idx} ${lbl}</div>`
          : `<div class="ema-banner sell">CLEAR SELL â EMA50 &gt; EMA13 on ${idx} ${lbl}</div>`;
        const key = `${idx}-${lbl}-emaxo`;
        const stamp = `${cs[cs.length-1].t}-${crossDir}`;
        if (state.lastAlertKeys[key] !== stamp) {
          pushAlert('crit', `${crossDir>0?'GOLDEN':'DEATH'} CROSS â EMA13/50 on ${idx} ${lbl}`);
          showPopup(`${crossDir>0?'GOLDEN':'DEATH'} CROSS`, `${idx} ${lbl} EMA13/50 fresh crossover`);
          state.lastAlertKeys[key] = stamp;
        }
      }
    }
    html.push('</tbody></table>');
    if (banner) html[html.length-1] = banner + html[html.length-1];
    html.push('</div>');
  }
  body.innerHTML = html.join('');
}
// ============ Confluence (patterns) ============
function renderConfluence() {
  const body = document.getElementById('conf-body');
  const idxs = ['NIFTY','BANKNIFTY','SENSEX'];
  const tfs = [['15m','15m',null],['45m','15m',3],['1D','1d',null]];
  const html = [];
  let any = false;
  for (const idx of idxs) {
    for (const [lbl, src, group] of tfs) {
      let cs = state.candles[idx] && state.candles[idx][src];
      if (!cs) continue;
      if (group) cs = resample(cs, group);
      if (cs.length < 25) continue;
      const patterns = detectPatterns(cs);
      if (!patterns.length) continue;
      for (const p of patterns) {
        // confluence
        let score = 0;
        // a) RSI direction
        const closes = cs.map(c => c.c);
        const r5 = calcRSI(closes, 5), r14 = calcRSI(closes, 14);
        const lastR5 = r5[r5.length-1], lastR14 = r14[r14.length-1];
        if (lastR5 && lastR14) {
          if (p.bull && lastR5 > lastR14) score++;
          if (!p.bull && lastR5 < lastR14) score++;
        }
        // b) EMA alignment
        if (closes.length >= 50) {
          const e13 = calcEMA(closes, 13), e50 = calcEMA(closes, 50);
          const L = closes.length - 1;
          if (e13[L] && e50[L]) {
            if (p.bull && e13[L] > e50[L]) score++;
            if (!p.bull && e13[L] < e50[L]) score++;
          }
        }
        // c) OI agrees â writing on opposite side
        const oi = state.oi[idx];
        if (oi) {
          const firstExp = oi.expiries[0];
          const rows = oi.byExp[firstExp] || [];
          const spot = oi.underlying;
          const step = IDX_CONF[idx].step;
          const window = rows.filter(r => Math.abs(r.strikePrice - spot) <= step * 6);
          const ceSum = window.reduce((s,r)=>s + (r.CE&&r.CE.changeinOpenInterest||0), 0);
          const peSum = window.reduce((s,r)=>s + (r.PE&&r.PE.changeinOpenInterest||0), 0);
          if (p.bull && peSum > ceSum) score++;
          if (!p.bull && ceSum > peSum) score++;
        }
        // d) volume > 20-period avg
        if (cs.length >= 20) {
          const vols = cs.slice(-21,-1).map(c => c.v || 0);
          const avg = vols.reduce((a,b)=>a+b,0) / vols.length;
          if (cs[cs.length-1].v && cs[cs.length-1].v > avg) score++;
        }
        if (score < 2) continue;
        any = true;
        const cls = score === 4 ? 'vhigh' : score === 3 ? 'high' : '';
        const lbl2 = score === 4 ? 'VERY HIGH' : score === 3 ? 'HIGH CONFIDENCE' : 'MODERATE';
        const dir = p.bull ? 'BULL' : 'BEAR';
        const dirCls = p.bull ? 'g' : 'r';
        html.push(`<div class="conf-card ${cls}"><span class="score ${dirCls}">${score}/4</span><b>${p.name}</b> <span class="${dirCls}">${dir}</span> â ${idx} ${lbl} <div class="m" style="font-size:10px;margin-top:2px;">${lbl2}</div></div>`);
        // fire alert if â¥3
        if (score >= 3) {
          const key = `conf-${idx}-${lbl}-${p.name}`;
          const stamp = `${cs[cs.length-1].t}`;
          if (state.lastAlertKeys[key] !== stamp) {
            state.lastAlertKeys[key] = stamp;
            pushAlert('imp', `${p.name} ${dir} ${idx} ${lbl} â confluence ${score}/4`);
          }
        }
      }
    }
  }
  body.innerHTML = any ? html.join('') : '<div class="m">No qualifying patterns (score â¥ 2) detected.</div>';
}
// ============ Breakout ============
function renderBreakout() {
  const body = document.getElementById('breakout-body');
  const idxs = ['NIFTY','BANKNIFTY','SENSEX'];
  const tfs = [['15m','15m',null],['45m','15m',3],['1D','1d',null]];
  const html = [];
  for (const idx of idxs) {
    for (const [lbl, src, group] of tfs) {
      let cs = state.candles[idx] && state.candles[idx][src];
      if (!cs || cs.length < 11) continue;
      if (group) cs = resample(cs, group);
      if (cs.length < 11) continue;
      const last = cs[cs.length-1];
      const prior = cs.slice(-11, -1);
      const maxH = Math.max(...prior.map(c => c.h));
      const minL = Math.min(...prior.map(c => c.l));
      let type = null;
      if (last.c > maxH) type = 'BREAKOUT';
      else if (last.c < minL) type = 'BREAKDOWN';
      if (type) {
        const key = `bk-${idx}-${lbl}`;
        const stamp = `${last.t}-${type}`;
        const fresh = state.lastAlertKeys[key] !== stamp;
        if (fresh) {
          state.lastAlertKeys[key] = stamp;
          // Check confluence for critical alert
          const closes = cs.map(c => c.c);
          const r5 = calcRSI(closes, 5), r14 = calcRSI(closes, 14);
          const e13 = calcEMA(closes, 13), e50 = calcEMA(closes, 50);
          let conf = 0;
          if (type === 'BREAKOUT' && r5[r5.length-1] > r14[r14.length-1]) conf++;
          if (type === 'BREAKDOWN' && r5[r5.length-1] < r14[r14.length-1]) conf++;
          if (type === 'BREAKOUT' && e13[closes.length-1] > e50[closes.length-1]) conf++;
          if (type === 'BREAKDOWN' && e13[closes.length-1] < e50[closes.length-1]) conf++;
          const vols = cs.slice(-21,-1).map(c => c.v || 0);
          const avg = vols.reduce((a,b)=>a+b,0) / Math.max(1,vols.length);
          if (last.v > avg) conf++;
          if (conf >= 3) {
            pushAlert('crit', `${type} ${idx} ${lbl} â confluence ${conf}/3+`);
            showPopup(`${type}`, `${idx} ${lbl} with confluence ${conf}`);
          } else {
            pushAlert('imp', `${type} ${idx} ${lbl}`);
          }
        }
        const cls = type === 'BREAKOUT' ? 'g' : 'r';
        html.push(`<div class="conf-card ${type==='BREAKOUT'?'vhigh':''}"><b class="${cls}">${type}</b> ${idx} ${lbl} close <span class="mono">${fmt(last.c)}</span> vs ${type==='BREAKOUT'?'10-high':'10-low'} <span class="mono">${fmt(type==='BREAKOUT'?maxH:minL)}</span></div>`);
      }
    }
  }
  body.innerHTML = html.length ? html.join('') : '<div class="m">No breakouts/breakdowns detected on 15m/45m/1D.</div>';
}
// ============ S/R + Sparkline ============
function renderSR() {
  const idx = state.currentIdx;
  const cs = state.candles[idx] && state.candles[idx]['15m'];
  const canvas = document.getElementById('spark-canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.offsetWidth;
  const H = canvas.height;
  ctx.fillStyle = '#0A0C0F'; ctx.fillRect(0, 0, W, H);
  if (!cs || !cs.length) { document.getElementById('sr-levels').innerHTML = '<span class="m">No data</span>'; return; }
  const recent = cs.slice(-60);
  const closes = recent.map(c => c.c);
  const mn = Math.min(...closes), mx = Math.max(...closes);
  // Prev day high/low
  const daily = state.candles[idx] && state.candles[idx]['1d'];
  let pdh = null, pdl = null;
  if (daily && daily.length >= 2) { pdh = daily[daily.length-2].h; pdl = daily[daily.length-2].l; }
  const oi = state.oi[idx];
  const mp = oi ? maxPain(oi.byExp[oi.expiries[0]] || []) : null;
  const lo = Math.min(mn, pdl || mn, mp || mn);
  const hi = Math.max(mx, pdh || mx, mp || mx);
  const pad = 10;
  function y(v) { return pad + (hi - v) / (hi - lo) * (H - 2 * pad); }
  // sparkline
  ctx.strokeStyle = '#00FF88'; ctx.lineWidth = 1.5; ctx.beginPath();
  for (let i = 0; i < closes.length; i++) {
    const x = (i / (closes.length - 1)) * W;
    if (i === 0) ctx.moveTo(x, y(closes[i])); else ctx.lineTo(x, y(closes[i]));
  }
  ctx.stroke();
  // S/R dotted lines
  function dottedLine(v, color, label) {
    if (v == null) return;
    ctx.strokeStyle = color; ctx.setLineDash([4, 4]); ctx.beginPath();
    ctx.moveTo(0, y(v)); ctx.lineTo(W, y(v)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.font = '10px monospace';
    ctx.fillText(label + ' ' + fmt(v), 4, y(v) - 3);
  }
  dottedLine(pdh, '#FF3B5C', 'PDH');
  dottedLine(pdl, '#00FF88', 'PDL');
  dottedLine(mp, '#FFB800', 'MP');
  document.getElementById('sr-levels').innerHTML = `<span class="r">PDH ${pdh?fmt(pdh):'--'}</span> Â· <span class="g">PDL ${pdl?fmt(pdl):'--'}</span> Â· <span class="a">Max Pain ${mp?fmt(mp):'--'}</span>`;
}
// ============ Confluence / patterns ============
function renderConfluence() {
  const body = document.getElementById('conf-body');
  const idxs = ['NIFTY','BANKNIFTY','SENSEX'];
  const tfs = [['15m','15m',false,null], ['45m','15m',true,3], ['1D','1d',false,null]];
  const html = [];
  for (const idx of idxs) {
    for (const [lbl, src, rs, grp] of tfs) {
      let cs = state.candles[idx] && state.candles[idx][src];
      if (!cs || cs.length < 25) continue;
      if (rs) cs = resample(cs, grp);
      const patterns = detectPatterns(cs);
      if (!patterns.length) continue;
      for (const p of patterns) {
        // compute confluence
        let score = 0;
        const reasons = [];
        // (a) RSI direction
        const closes = cs.map(c => c.c);
        const r5 = calcRSI(closes, 5), r14 = calcRSI(closes, 14);
        const rsiUp = r5[r5.length-1] > r14[r14.length-1];
        if ((p.bull && rsiUp) || (!p.bull && !rsiUp)) { score++; reasons.push('RSI agrees'); }
        // (b) EMA alignment â use 1h closes for this tf bias
        const srcCs = state.candles[idx] && state.candles[idx][src];
        if (srcCs && srcCs.length >= 50) {
          const sc = srcCs.map(c => c.c);
          const e13 = calcEMA(sc, 13), e50 = calcEMA(sc, 50);
          const emaUp = e13[e13.length-1] > e50[e50.length-1];
          if ((p.bull && emaUp) || (!p.bull && !emaUp)) { score++; reasons.push('EMA agrees'); }
        }
        // (c) OI agreement â writing on opposite side
        const oi = state.oi[idx];
        if (oi) {
          const spot = oi.underlying;
          const allRows = Object.values(oi.byExp).flat();
          const window = allRows.filter(r => Math.abs(r.strikePrice - spot) <= IDX_CONF[idx].step * 8);
          const maxCEChg = Math.max(0, ...window.map(r => r.CE ? r.CE.changeinOpenInterest || 0 : 0));
          const maxPEChg = Math.max(0, ...window.map(r => r.PE ? r.PE.changeinOpenInterest || 0 : 0));
          if (p.bull && maxPEChg > maxCEChg) { score++; reasons.push('OI put-writing agrees'); }
          else if (!p.bull && maxCEChg > maxPEChg) { score++; reasons.push('OI call-writing agrees'); }
        }
        // (d) volume > 20-period avg
        const vols = cs.slice(-21, -1).map(c => c.v || 0);
        const avgV = vols.reduce((a,b) => a+b, 0) / (vols.length || 1);
        const curV = cs[cs.length-1].v || 0;
        if (curV > avgV && avgV > 0) { score++; reasons.push('volume surge'); }
        if (score < 2) continue;
        const cls = score >= 4 ? 'vhigh' : score === 3 ? 'high' : '';
        const label = score >= 4 ? 'VERY HIGH' : score === 3 ? 'HIGH CONFIDENCE' : '';
        html.push(`<div class="conf-card ${cls}"><span class="score ${p.bull?'g':'r'}">${score}/4</span><b>${idx} ${lbl}</b> â ${p.name} ${p.bull?'(bullish)':'(bearish)'} ${label?`<span class="${cls==='vhigh'?'g':'a'}">[${label}]</span>`:''}<div class="m" style="font-size:10px;margin-top:2px;">${reasons.join(' Â· ')||'pattern only'}</div></div>`);
        // push alerts
        if (score >= 3) {
          const key = `${idx}-${lbl}-${p.name}`;
          const stamp = `${cs[cs.length-1].t}`;
          if (state.lastAlertKeys[key] !== stamp) {
            pushAlert('crit', `CONFLUENCE ${score}/4 â ${idx} ${lbl} ${p.name}`);
            showPopup('HIGH CONFLUENCE', `${idx} ${lbl} ${p.name} â score ${score}/4`);
            state.lastAlertKeys[key] = stamp;
          }
        } else {
          const key = `${idx}-${lbl}-${p.name}`;
          const stamp = `${cs[cs.length-1].t}`;
          if (state.lastAlertKeys[key] !== stamp) {
            pushAlert('imp', `Pattern â ${idx} ${lbl} ${p.name} (${score}/4)`);
            state.lastAlertKeys[key] = stamp;
          }
        }
      }
    }
  }
  body.innerHTML = html.length ? html.join('') : '<div class="m">No high-confluence patterns detected.</div>';
}
// ============ Breakouts ============
function renderBreakouts() {
  const body = document.getElementById('breakout-body');
  const idxs = ['NIFTY','BANKNIFTY','SENSEX'];
  const tfs = [['15m','15m',false,null], ['45m','15m',true,3], ['1D','1d',false,null]];
  const html = [];
  for (const idx of idxs) {
    for (const [lbl, src, rs, grp] of tfs) {
      let cs = state.candles[idx] && state.candles[idx][src];
      if (!cs || cs.length < 12) continue;
      if (rs) cs = resample(cs, grp);
      const last = cs[cs.length-1];
      const prev10 = cs.slice(-11, -1);
      const hi = Math.max(...prev10.map(c => c.h));
      const lo = Math.min(...prev10.map(c => c.l));
      let ev = null;
      if (last.c > hi) ev = 'BREAKOUT';
      else if (last.c < lo) ev = 'BREAKDOWN';
      if (!ev) continue;
      const key = `${idx}-${lbl}-bk`;
      const stamp = `${last.t}-${ev}`;
      const cls = ev === 'BREAKOUT' ? 'g' : 'r';
      html.push(`<div style="margin-bottom:4px;"><b>${idx} ${lbl}</b> <span class="${cls}">${ev}</span> close ${fmt(last.c)} ${ev==='BREAKOUT'?'>':'<'} ${fmt(ev==='BREAKOUT'?hi:lo)}</div>`);
      if (state.lastAlertKeys[key] !== stamp) {
        // confluence >= 3 flag: check if RSI + EMA agree
        const closes = cs.map(c => c.c);
        const r5 = calcRSI(closes, 5), r14 = calcRSI(closes, 14);
        const e13 = calcEMA(closes, 13), e50 = calcEMA(closes, 50);
        let conf = 1;
        const rsiAgree = (ev==='BREAKOUT' && r5[r5.length-1] > r14[r14.length-1]) || (ev==='BREAKDOWN' && r5[r5.length-1] < r14[r14.length-1]);
        const emaAgree = (ev==='BREAKOUT' && e13[e13.length-1] > e50[e50.length-1]) || (ev==='BREAKDOWN' && e13[e13.length-1] < e50[e50.length-1]);
        if (rsiAgree) conf++;
        if (emaAgree) conf++;
        if (conf >= 3) {
          pushAlert('crit', `${ev} w/ confluence ${conf}/3 â ${idx} ${lbl}`);
          showPopup(ev, `${idx} ${lbl} confluence ${conf}/3`);
        } else {
          pushAlert('imp', `${ev} â ${idx} ${lbl}`);
        }
        state.lastAlertKeys[key] = stamp;
      }
    }
  }
  body.innerHTML = html.length ? html.join('') : '<div class="m">No breakouts detected.</div>';
}
// ============ Alerts / Popups / Toasts ============
function pushAlert(tier, msg) {
  const a = { tier, msg, t: Date.now() };
  state.alerts.unshift(a);
  if (state.alerts.length > 50) state.alerts.length = 50;
  LS.set('alerts_v1', state.alerts);
  LS.set('alertkeys_v1', state.lastAlertKeys);
  renderFeed();
  if (tier === 'info') showToast(msg);
}
function renderFeed() {
  const el = document.getElementById('feed');
  if (!state.alerts.length) { el.innerHTML = '<div class="m">No signals yet. Fetching data...</div>'; return; }
  const html = [];
  for (let i = 0; i < state.alerts.length; i++) {
    const a = state.alerts[i];
    const d = new Date(a.t);
    const ist = new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 5.5 * 3600000);
    const p = n => String(n).padStart(2, '0');
    const ts = `${p(ist.getHours())}:${p(ist.getMinutes())}:${p(ist.getSeconds())}`;
    html.push(`<div class="alert ${a.tier}${a.tier==='crit'?' pulse':''}"><span class="x" onclick="dismissAlert(${i})">x</span><div class="t">${ts} IST</div><div class="msg">${a.msg}</div></div>`);
  }
  el.innerHTML = html.join('');
}
function dismissAlert(i) { state.alerts.splice(i, 1); LS.set('alerts_v1', state.alerts); renderFeed(); }
function clearFeed() { state.alerts = []; LS.set('alerts_v1', []); renderFeed(); }
function showPopup(title, msg) {
  if (state.popups.length >= 2) {
    // remove oldest
    const first = state.popups.shift();
    first.el.remove();
    clearTimeout(first.timer);
  }
  const el = document.createElement('div');
  el.className = 'popup';
  el.innerHTML = `<button class="close">x</button><div class="title">${title}</div><div class="msg">${msg}</div>`;
  document.getElementById('popups').appendChild(el);
  const entry = { el, timer: null };
  entry.timer = setTimeout(() => { el.remove(); state.popups = state.popups.filter(p => p !== entry); }, 10000);
  el.querySelector('.close').onclick = () => { el.remove(); clearTimeout(entry.timer); state.popups = state.popups.filter(p => p !== entry); };
  state.popups.push(entry);
}
function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}
// ============ Spot-vs-premium mismatch ============
function checkMismatch() {
  for (const idx of Object.keys(IDX_CONF)) {
    const spot = state.spots[idx];
    const oi = state.oi[idx];
    if (!spot || !oi) continue;
    const cs = state.candles[idx] && state.candles[idx]['5m'];
    if (!cs || cs.length < 2) continue;
    const now5 = cs[cs.length-1].c, prev5 = cs[cs.length-2].c;
    const spotPct = ((now5 - prev5) / prev5) * 100;
    if (Math.abs(spotPct) < 0.3) { state.mismatchActive = false; continue; }
    // ATM premium change
    const exp = oi.expiries[0];
    const rows = oi.byExp[exp] || [];
    const atm = Math.round(oi.underlying / IDX_CONF[idx].step) * IDX_CONF[idx].step;
    const row = rows.find(r => r.strikePrice === atm);
    if (!row) continue;
    const side = spotPct > 0 ? row.CE : row.PE;
    if (!side || !side.lastPrice || !side.pchange) continue;
    const premPct = Math.abs(side.pchange);
    if (premPct < 0.5) {
      state.mismatchActive = true;
      const key = `mm-${idx}`;
      const stamp = Math.floor(Date.now() / 300000);
      if (state.lastAlertKeys[key] !== stamp) {
        state.lastAlertKeys[key] = stamp;
        pushAlert('imp', `MISMATCH ${idx} â spot ${spotPct>0?'+':''}${fmt(spotPct)}% but ATM premium only ${fmt(premPct)}% â possible IV drop or illiquidity`);
      }
    }
  }
}
// ============ News RSS ============
async function fetchNews() {
  const feeds = [
    'https://www.moneycontrol.com/rss/marketsnews.xml',
    'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
  ];
  const all = [];
  for (const f of feeds) {
    try {
      const j = await fetchDirect(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(f)}`);
      if (j && j.items) for (const it of j.items) all.push({ title: it.title, link: it.link, src: j.feed.title });
    } catch(e) { /* skip */ }
  }
  state.news = all.slice(0, 20);
  renderTicker();
}
function renderTicker() {
  const kws = ['RBI','FED','FOMC','SEBI','CIRCUIT','RESULT','GDP','BAN','INFLATION','RATE'];
  const inner = document.getElementById('ticker-inner');
  if (!state.news.length) { inner.innerHTML = '<span class="prefix">NEWS</span><span class="m">No feeds loaded</span>'; return; }
  const parts = ['<span class="prefix">NEWS</span>'];
  let flashTriggered = false;
  for (const n of state.news) {
    const up = n.title.toUpperCase();
    const isKw = kws.some(k => up.includes(k));
    if (isKw && !state.newsKeywordSeen.has(n.link)) {
      state.newsKeywordSeen.add(n.link);
      flashTriggered = true;
    }
    parts.push(`<a href="${n.link}" target="_blank" class="${isKw?'kw':''}">${n.title}</a>`);
  }
  inner.innerHTML = parts.join(' ');
  if (flashTriggered) {
    document.body.classList.add('border-flash');
    setTimeout(() => document.body.classList.remove('border-flash'), 4000);
  }
}
// ============ S/R sparkline ============
function renderSR() {
  const idx = state.currentIdx;
  const cs = state.candles[idx] && state.candles[idx]['15m'];
  const c = document.getElementById('spark-canvas');
  const ctx = c.getContext('2d');
  const W = c.width = c.clientWidth; const H = c.height;
  ctx.fillStyle = '#0A0C0F'; ctx.fillRect(0,0,W,H);
  if (!cs || cs.length < 10) {
    ctx.fillStyle = '#7A8390'; ctx.font = '11px JetBrains Mono'; ctx.fillText('insufficient data', 10, H/2); return;
  }
  const slice = cs.slice(-60);
  const ys = slice.map(k => k.c);
  let min = Math.min(...ys), max = Math.max(...ys);
  // previous day hi/lo from 1d candles
  const d1 = state.candles[idx] && state.candles[idx]['1d'];
  let pdh = null, pdl = null;
  if (d1 && d1.length >= 2) { pdh = d1[d1.length-2].h; pdl = d1[d1.length-2].l; }
  const oi = state.oi[idx];
  const mp = oi ? maxPain(Object.values(oi.byExp).flat()) : null;
  const levels = [];
  if (pdh) levels.push({v: pdh, c: '#FF3B5C', label: 'PDH'});
  if (pdl) levels.push({v: pdl, c: '#00FF88', label: 'PDL'});
  if (mp) levels.push({v: mp, c: '#FFB800', label: 'MP'});
  for (const lv of levels) { min = Math.min(min, lv.v); max = Math.max(max, lv.v); }
  const pad = (max - min) * 0.1 || 1;
  min -= pad; max += pad;
  const xScale = i => (i / (slice.length - 1)) * (W - 40) + 30;
  const yScale = v => H - 10 - ((v - min) / (max - min)) * (H - 20);
  // dotted lines
  ctx.setLineDash([3,3]);
  ctx.lineWidth = 1;
  for (const lv of levels) {
    ctx.strokeStyle = lv.c;
    const y = yScale(lv.v);
    ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(W-5, y); ctx.stroke();
    ctx.fillStyle = lv.c; ctx.font = '10px JetBrains Mono';
    ctx.fillText(lv.label, 2, y+3);
  }
  // sparkline
  ctx.setLineDash([]);
  ctx.strokeStyle = '#00FF88'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < slice.length; i++) {
    const x = xScale(i), y = yScale(slice[i].c);
    if (i === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();
  // last price dot
  const lastX = xScale(slice.length-1), lastY = yScale(slice[slice.length-1].c);
  ctx.fillStyle = '#00FF88'; ctx.beginPath(); ctx.arc(lastX, lastY, 3, 0, Math.PI*2); ctx.fill();
  // Levels summary text
  const srEl = document.getElementById('sr-levels');
  srEl.innerHTML = `${IDX_CONF[idx].name} Â· <span class="r">PDH ${pdh?fmt(pdh):'--'}</span> Â· <span class="g">PDL ${pdl?fmt(pdl):'--'}</span> Â· <span class="a">MaxPain ${mp?fmtInt(mp):'--'}</span>`;
}
// ============ Alerts & popups ============
function pushAlert(level, msg) {
  state.alerts.unshift({ level, msg, t: Date.now() });
  state.alerts = state.alerts.slice(0, 50);
  LS.set('alerts_v1', state.alerts);
  LS.set('alertkeys_v1', state.lastAlertKeys);
  renderFeed();
}
function renderFeed() {
  const feed = document.getElementById('feed');
  if (!state.alerts.length) { feed.innerHTML = '<div class="m">No alerts yet.</div>'; return; }
  feed.innerHTML = state.alerts.map((a, i) => {
    const d = new Date(a.t);
    const ist = new Date(d.getTime() + d.getTimezoneOffset() * 60000 + 5.5 * 3600000);
    const p = n => String(n).padStart(2, '0');
    const hms = `${p(ist.getHours())}:${p(ist.getMinutes())}:${p(ist.getSeconds())}`;
    return `<div class="alert ${a.level}"><span class="x" onclick="dismissAlert(${i})">x</span><div class="t">${hms} IST</div><div class="msg">${a.msg}</div></div>`;
  }).join('');
}
function dismissAlert(i) {
  state.alerts.splice(i, 1);
  LS.set('alerts_v1', state.alerts);
  renderFeed();
}
function clearFeed() {
  state.alerts = [];
  LS.set('alerts_v1', state.alerts);
  renderFeed();
}
function showPopup(title, msg) {
  const el = document.createElement('div');
  el.className = 'popup';
  el.innerHTML = `<button class="close" onclick="this.parentNode.remove()">x</button><div class="title">${title}</div><div class="msg">${msg}</div>`;
  document.getElementById('popups').appendChild(el);
  // prune: max 2
  const all = document.getElementById('popups').children;
  while (all.length > 2) all[0].remove();
  setTimeout(() => { try { el.remove(); } catch(e) {} }, 10000);
}
function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { try { el.remove(); } catch(e) {} }, 5000);
}
// ============ Mismatch detector ============
function checkMismatch() {
  for (const idx of Object.keys(IDX_CONF)) {
    const cs = state.candles[idx] && state.candles[idx]['5m'];
    if (!cs || cs.length < 2) continue;
    const last = cs[cs.length-1].c;
    const prev = cs[cs.length-2].c;
    const spotChgP = ((last - prev) / prev) * 100;
    // ATM option premium change
    const oi = state.oi[idx];
    if (!oi) continue;
    const spot = oi.underlying;
    const step = IDX_CONF[idx].step;
    const atm = Math.round(spot / step) * step;
    const allRows = Object.values(oi.byExp).flat();
    const atmRow = allRows.find(r => r.strikePrice === atm);
    if (!atmRow) continue;
    const ceLtp = atmRow.CE ? atmRow.CE.lastPrice : 0;
    const peLtp = atmRow.PE ? atmRow.PE.lastPrice : 0;
    const ceChg = atmRow.CE ? atmRow.CE.change : 0;
    const peChg = atmRow.PE ? atmRow.PE.change : 0;
    const ceChgP = ceLtp ? (ceChg / (ceLtp - ceChg)) * 100 : 0;
    const peChgP = peLtp ? (peChg / (peLtp - peChg)) * 100 : 0;
    const maxPremChg = Math.max(Math.abs(ceChgP), Math.abs(peChgP));
    if (Math.abs(spotChgP) > 0.3 && maxPremChg < 0.5) {
      const key = `${idx}-mismatch`;
      const stamp = `${cs[cs.length-1].t}`;
      if (state.lastAlertKeys[key] !== stamp) {
        pushAlert('imp', `MISMATCH ALERT â ${idx} options lagging (spot ${fmt(spotChgP)}%, ATM prem ${fmt(maxPremChg)}%)`);
        state.lastAlertKeys[key] = stamp;
      }
      state.mismatchActive = true;
    }
  }
}
// ============ Trade Log ============
function openTradeForm() {
  document.getElementById('tradeform').classList.add('open');
  const d = istNow();
  document.getElementById('tf-idx').value = state.currentIdx;
  if (state.oi[state.currentIdx]) {
    const step = IDX_CONF[state.currentIdx].step;
    const atm = Math.round(state.oi[state.currentIdx].underlying / step) * step;
    document.getElementById('tf-strike').value = atm;
  }
}
function closeTradeForm() { document.getElementById('tradeform').classList.remove('open'); }
function saveTrade() {
  const tr = {
    id: Date.now(),
    time: istHMS(),
    idx: document.getElementById('tf-idx').value,
    strike: +document.getElementById('tf-strike').value,
    type: document.getElementById('tf-type').value,
    qty: +document.getElementById('tf-qty').value,
    entry: +document.getElementById('tf-entry').value,
    exit: null,
  };
  state.trades.unshift(tr);
  LS.set('trades_v1', state.trades);
  closeTradeForm();
  renderTrades();
}
function updateExit(id, val) {
  const tr = state.trades.find(t => t.id === id);
  if (!tr) return;
  tr.exit = val === '' ? null : +val;
  LS.set('trades_v1', state.trades);
  renderTrades();
}
function deleteTrade(id) {
  state.trades = state.trades.filter(t => t.id !== id);
  LS.set('trades_v1', state.trades);
  renderTrades();
}
function renderTrades() {
  const tb = document.getElementById('trades-body');
  if (!state.trades.length) { tb.innerHTML = '<tr><td colspan="9" class="m" style="text-align:center;padding:10px;">No trades logged yet.</td></tr>'; return; }
  const html = state.trades.map(t => {
    const lot = IDX_CONF[t.idx].lot;
    let pnl = '', pnlCls = '';
    if (t.exit != null) {
      const p = t.qty * lot * (t.exit - t.entry);
      pnl = (p >= 0 ? '+' : '') + fmt(p, 0);
      pnlCls = 'pnl ' + (p >= 0 ? 'pos' : 'neg');
    }
    return `<tr>
      <td class="mono">${t.time}</td>
      <td>${t.idx}</td>
      <td class="mono">${t.strike}</td>
      <td class="${t.type==='CE'?'g':'r'}">${t.type}</td>
      <td class="mono">${t.qty}</td>
      <td class="mono">${fmt(t.entry)}</td>
      <td><input type="number" step="0.05" value="${t.exit??''}" onchange="updateExit(${t.id},this.value)" style="width:80px;" /></td>
      <td class="${pnlCls}">${pnl}</td>
      <td><button onclick="deleteTrade(${t.id})" style="font-size:10px;">x</button></td>
    </tr>`;
  });
  tb.innerHTML = html.join('');
}
function exportCSV() {
  const rows = [['Time','Index','Strike','Type','Qty','Entry','Exit','Lot','P&L']];
  for (const t of state.trades) {
    const lot = IDX_CONF[t.idx].lot;
    const pnl = t.exit != null ? t.qty * lot * (t.exit - t.entry) : '';
    rows.push([t.time, t.idx, t.strike, t.type, t.qty, t.entry, t.exit ?? '', lot, pnl]);
  }
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'trades_' + Date.now() + '.csv'; a.click();
  URL.revokeObjectURL(url);
}
// ============ Kite stub ============
async function generateSession() {
  const key = localStorage.getItem('kite_key');
  const secret = localStorage.getItem('kite_secret');
  const tok = localStorage.getItem('kite_token');
  if (!key || !secret || !tok) return { error: 'Missing creds' };
  // browser will CORS-fail; kept as stub
  try {
    const r = await fetch('https://api.kite.trade/session/token', {
      method: 'POST',
      headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `api_key=${key}&request_token=${tok}&checksum=BROWSER_BLOCKED`,
    });
    return await r.json();
  } catch(e) { return { error: 'CORS blocked â browser cannot call Kite directly. Run a tiny backend.' }; }
}
async function getLTP(sym) {
  const key = localStorage.getItem('kite_key');
  const access = localStorage.getItem('kite_access_token');
  if (!key || !access) return { error: 'Missing session' };
  try {
    const r = await fetch(`https://api.kite.trade/quote/ltp?i=${encodeURIComponent(sym)}`, {
      headers: { 'X-Kite-Version': '3', 'Authorization': `token ${key}:${access}` },
    });
    return await r.json();
  } catch(e) { return { error: 'CORS blocked' }; }
}
async function getPositions() {
  const key = localStorage.getItem('kite_key');
  const access = localStorage.getItem('kite_access_token');
  if (!key || !access) return { error: 'Missing session' };
  try {
    const r = await fetch('https://api.kite.trade/portfolio/positions', {
      headers: { 'X-Kite-Version': '3', 'Authorization': `token ${key}:${access}` },
    });
    return await r.json();
  } catch(e) { return { error: 'CORS blocked' }; }
}
function openSettings() {
  document.getElementById('settings').classList.add('open');
  document.getElementById('kite-key').value = localStorage.getItem('kite_key') || '';
  document.getElementById('kite-secret').value = localStorage.getItem('kite_secret') || '';
  document.getElementById('kite-token').value = localStorage.getItem('kite_token') || '';
}
function closeSettings() { document.getElementById('settings').classList.remove('open'); }
function saveKite() {
  localStorage.setItem('kite_key', document.getElementById('kite-key').value);
  localStorage.setItem('kite_secret', document.getElementById('kite-secret').value);
  localStorage.setItem('kite_token', document.getElementById('kite-token').value);
  document.getElementById('kite-result').textContent = 'Saved locally.';
}
function clearKite() {
  ['kite_key','kite_secret','kite_token','kite_access_token'].forEach(k => localStorage.removeItem(k));
  document.getElementById('kite-key').value = '';
  document.getElementById('kite-secret').value = '';
  document.getElementById('kite-token').value = '';
  document.getElementById('kite-result').textContent = 'Cleared.';
}
async function testKite() {
  const r = await getLTP('NSE:NIFTY 50');
  document.getElementById('kite-result').textContent = JSON.stringify(r).slice(0, 200);
}
// ============ News RSS ============
async function fetchNews() {
  const feeds = [
    'https://www.moneycontrol.com/rss/marketreports.xml',
    'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
  ];
  const keywords = /\b(RBI|Fed|FED|SEBI|circuit|results?|GDP|ban|banned)\b/i;
  const all = [];
  for (const f of feeds) {
    try {
      const j = await fetchDirect('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(f));
      if (j && j.items) {
        for (const it of j.items.slice(0, 10)) {
          const isKw = keywords.test(it.title);
          all.push({ title: it.title, link: it.link, kw: isKw });
        }
      }
    } catch(e) { console.warn('rss fail', f); }
  }
  state.news = all.slice(0, 20);
  renderNews();
  // border flash if a new keyword headline
  for (const n of state.news) {
    if (n.kw && !state.newsKeywordSeen.has(n.link)) {
      state.newsKeywordSeen.add(n.link);
      document.body.classList.add('border-flash');
      setTimeout(() => document.body.classList.remove('border-flash'), 4000);
      pushAlert('imp', `NEWS: ${n.title}`);
    }
  }
}
function renderNews() {
  const inner = document.getElementById('ticker-inner');
  if (!state.news.length) { inner.innerHTML = '<span class="prefix">NEWS</span><span class="m">No headlines available.</span>'; return; }
  const items = state.news.map(n => `<a href="${n.link}" target="_blank" rel="noopener" class="${n.kw?'kw':''}">${n.title}</a>`).join(' | ');
  inner.innerHTML = `<span class="prefix">NEWS</span>${items}`;
}
// ============ Trades ============
function openTradeForm() {
  document.getElementById('tradeform').classList.add('open');
  document.getElementById('tf-idx').value = state.currentIdx;
  const oi = state.oi[state.currentIdx];
  if (oi) {
    const step = IDX_CONF[state.currentIdx].step;
    document.getElementById('tf-strike').value = Math.round(oi.underlying / step) * step;
  }
}
function closeTradeForm() { document.getElementById('tradeform').classList.remove('open'); }
function saveTrade() {
  const t = {
    id: Date.now(),
    time: istHMS(),
    idx: document.getElementById('tf-idx').value,
    strike: +document.getElementById('tf-strike').value,
    type: document.getElementById('tf-type').value,
    qty: +document.getElementById('tf-qty').value,
    entry: +document.getElementById('tf-entry').value,
    exit: null,
  };
  if (!t.strike || !t.entry) { alert('Fill strike and entry'); return; }
  state.trades.unshift(t);
  LS.set('trades_v1', state.trades);
  closeTradeForm();
  renderTrades();
}
function updateExit(id, val) {
  const t = state.trades.find(x => x.id === id);
  if (!t) return;
  t.exit = +val || null;
  LS.set('trades_v1', state.trades);
  renderTrades();
}
function deleteTrade(id) {
  state.trades = state.trades.filter(t => t.id !== id);
  LS.set('trades_v1', state.trades);
  renderTrades();
}
function renderTrades() {
  const tbody = document.getElementById('trades-body');
  if (!state.trades.length) { tbody.innerHTML = '<tr><td colspan="9" class="m" style="text-align:center;padding:10px;">No trades logged yet.</td></tr>'; return; }
  tbody.innerHTML = state.trades.map(t => {
    const lot = IDX_CONF[t.idx].lot;
    let pnl = '';
    if (t.exit != null) {
      const v = t.qty * lot * (t.exit - t.entry);
      pnl = `<span class="pnl ${v>=0?'pos':'neg'}">${v>=0?'+':''}${fmt(v)}</span>`;
    }
    return `<tr>
      <td>${t.time}</td><td>${t.idx}</td><td>${t.strike}</td><td>${t.type}</td>
      <td>${t.qty}</td><td>${fmt(t.entry)}</td>
      <td><input type="number" step="0.05" value="${t.exit||''}" style="width:60px;" onchange="updateExit(${t.id}, this.value)"/></td>
      <td>${pnl}</td>
      <td><button onclick="deleteTrade(${t.id})" style="font-size:10px;">x</button></td>
    </tr>`;
  }).join('');
}
function exportCSV() {
  if (!state.trades.length) { alert('No trades to export'); return; }
  const h = 'Time,Index,Strike,Type,Qty,Entry,Exit,P&L\n';
  const rows = state.trades.map(t => {
    const lot = IDX_CONF[t.idx].lot;
    const pnl = t.exit != null ? (t.qty * lot * (t.exit - t.entry)).toFixed(2) : '';
    return `${t.time},${t.idx},${t.strike},${t.type},${t.qty},${t.entry},${t.exit||''},${pnl}`;
  }).join('\n');
  const blob = new Blob([h + rows], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `trades_${Date.now()}.csv`; a.click();
  URL.revokeObjectURL(url);
}
// ============ Kite stub ============
function openSettings() {
  document.getElementById('settings').classList.add('open');
  document.getElementById('kite-key').value = LS.get('kite_key', '');
  document.getElementById('kite-secret').value = LS.get('kite_secret', '');
  document.getElementById('kite-token').value = LS.get('kite_token', '');
}
function closeSettings() { document.getElementById('settings').classList.remove('open'); }
function saveKite() {
  LS.set('kite_key', document.getElementById('kite-key').value);
  LS.set('kite_secret', document.getElementById('kite-secret').value);
  LS.set('kite_token', document.getElementById('kite-token').value);
  document.getElementById('kite-result').textContent = 'Saved to localStorage only.';
}
function clearKite() {
  localStorage.removeItem('kite_key'); localStorage.removeItem('kite_secret');
  localStorage.removeItem('kite_token'); localStorage.removeItem('kite_access');
  document.getElementById('kite-key').value = '';
  document.getElementById('kite-secret').value = '';
  document.getElementById('kite-token').value = '';
  document.getElementById('kite-result').textContent = 'Cleared.';
}
async function generateSession() {
  const key = LS.get('kite_key',''), secret = LS.get('kite_secret',''), tok = LS.get('kite_token','');
  if (!key || !secret || !tok) throw new Error('missing credentials');
  // Kite requires SHA256(api_key + request_token + api_secret) signed request to /session/token
  const enc = new TextEncoder();
  const data = enc.encode(key + tok + secret);
  const hashBuf = await crypto.subtle.digest('SHA-256', data);
  const hashHex = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2,'0')).join('');
  const body = new URLSearchParams({ api_key: key, request_token: tok, checksum: hashHex });
  const r = await fetch('https://api.kite.trade/session/token', {
    method: 'POST', headers: { 'X-Kite-Version': '3', 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const j = await r.json();
  if (j.status === 'success') LS.set('kite_access', j.data.access_token);
  return j;
}
async function getLTP(symbol) {
  const key = LS.get('kite_key',''), access = LS.get('kite_access','');
  if (!key || !access) throw new Error('need session');
  const r = await fetch('https://api.kite.trade/quote/ltp?i=' + encodeURIComponent(symbol), {
    headers: { 'X-Kite-Version': '3', 'Authorization': `token ${key}:${access}` },
  });
  return r.json();
}
async function getPositions() {
  const key = LS.get('kite_key',''), access = LS.get('kite_access','');
  if (!key || !access) throw new Error('need session');
  const r = await fetch('https://api.kite.trade/portfolio/positions', {
    headers: { 'X-Kite-Version': '3', 'Authorization': `token ${key}:${access}` },
  });
  return r.json();
}
async function testKite() {
  const el = document.getElementById('kite-result');
  el.textContent = 'Testing (browser will likely CORS-block)...';
  try {
    const r = await getLTP('NSE:NIFTY 50');
    el.textContent = JSON.stringify(r).slice(0, 200);
  } catch(e) {
    el.textContent = 'Error: ' + e.message + ' â browsers block api.kite.trade directly. Use a backend.';
  }
}
// ============ Orchestrator ============
async function refreshAll(manual) {
  const btn = document.getElementById('refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing...'; }
  let anyOK = false;
  try {
    await Promise.all([
      fetchSpot('NIFTY').catch(()=>null),
      fetchSpot('BANKNIFTY').catch(()=>null),
      fetchSpot('SENSEX').catch(()=>null),
      fetchVIX().catch(()=>null),
    ]);
    if (state.spots.NIFTY || state.spots.BANKNIFTY || state.spots.SENSEX) anyOK = true;
    await fetchAllCandles().catch(()=>null);
    await fetchAllChains().catch(()=>null);
    await fetchNews().catch(()=>null);
    if (anyOK) { state.lastFetchOK = Date.now(); setStatus(true); }
    else setStatus(false, 'All data sources unreachable. Check network or proxy status.');
    renderAll();
    checkMismatch();
    updateLastUpdate();
  } catch(e) {
    setStatus(false, 'Fetch error: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
  }
}
function renderAll() {
  renderTopBar();
  renderOI();
  renderRSI();
  renderEMA();
  renderConfluence();
  renderBreakout();
  renderSR();
  renderTrades();
  renderFeed();
}
renderTrades();
renderFeed();
refreshAll(true);
setInterval(refreshAll, REFRESH_MS);
// Redraw sparkline on resize
window.addEventListener('resize', () => renderSR());
// ============ Master refresh ============
async function refreshAll(manual) {
  const btn = document.getElementById('refresh-btn');
  if (manual) btn.textContent = '...';
  let anySuccess = false;
  try {
    await Promise.allSettled([
      (async () => { for (const i of Object.keys(IDX_CONF)) { try { await fetchSpot(i); anySuccess = true; } catch(e){} } })(),
      fetchAllCandles().then(() => anySuccess = true).catch(()=>{}),
      fetchVIX().then(() => anySuccess = true).catch(()=>{}),
      fetchAllChains().then(() => { if (Object.values(state.oi).some(v=>v)) anySuccess = true; }).catch(()=>{}),
      fetchNews().catch(()=>{}),
    ]);
  } catch(e) { console.warn('refresh err', e); }
  if (anySuccess) { state.lastFetchOK = Date.now(); setStatus(true); }
  else setStatus(false, 'STALE DATA - all fetch attempts failed');
  updateLastUpdate();
  state.mismatchActive = false;
  checkMismatch();
  renderTopBar(); renderOI(); renderRSI(); renderEMA(); renderConfluence(); renderBreakouts(); renderSR();
  renderTrades(); renderFeed();
  if (manual) btn.textContent = 'Refresh';
}
// ============ Init ============
function init() {
  renderTrades();
  renderFeed();
  refreshAll(false);
  setInterval(() => refreshAll(false), REFRESH_MS);
  // re-render SR on resize
  window.addEventListener('resize', () => renderSR());
  // close modals on ESC
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeTradeForm(); closeSettings(); }
  });
}
window.addEventListener('DOMContentLoaded', init);
