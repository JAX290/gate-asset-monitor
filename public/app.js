'use strict';
/* Zero-dependency dashboard logic. Talks only to same-origin /api/* routes. */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  authed: false, authEnabled: false, mode: 'mock',
  range: 50, series: [], summary: null, timer: null,
  tab: 'overview',
  analytics: null, datasets: null, integrity: null,
  navChartPts: [],
  market: null, mkPreset: '24H', mkSymbols: null, mkAllSymbols: null,
  mkFromDate: '', mkToDate: '',
  // display unit (USD/CNY) + server-side reference rate; fact layer stays USD
  unit: (localStorage.getItem('gam.unit') === 'CNY' ? 'CNY' : 'USD'), fx: null,
  // metric glossary
  glossary: null, glGroup: 'all', glQuery: '',
  // operations
  operations: null, opStats: null, opKind: 'all', opOnlyAnn: false,
  // daily report
  report: null, reportStatus: null, reportHistory: null,
  // v5 extended enrichment (fold-out, loaded lazily)
  enrich: null, enrichHeadline: null, enrichLoaded: false, enrichLoading: false,
};

/* ------------------------------ helpers ------------------------------ */
function fmtMoney(v, d = 2) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtQty(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  const abs = Math.abs(n);
  const d = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return n.toLocaleString('en-US', { maximumFractionDigits: d });
}
function fmtPct(v, d = 2) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
  return (Number(v) > 0 ? '+' : '') + Number(v).toFixed(d) + '%';
}
function fmtSigned(v, d = 2) {
  if (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) return '—';
  return (Number(v) > 0 ? '+' : '') + fmtMoney(v, d);
}
function pctClass(v) { return v === null || v === undefined || Number.isNaN(Number(v)) ? '' : (Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : ''); }
function cls(v) { return pctClass(v); }

/* ---- display units: USD <-> CNY, server-side reference rate only ---- */
function fxRate() { return state.unit === 'CNY' && state.fx && Number(state.fx.rate) > 0 ? Number(state.fx.rate) : 1; }
function effectiveUnit() { return state.unit === 'CNY' && fxRate() !== 1 ? 'CNY' : 'USD'; }
function unitSymbol() { return effectiveUnit() === 'CNY' ? '¥' : '$'; }
function unitTag() { return effectiveUnit(); }
function toUnit(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n * fxRate() : null;
}
function fmtUsd(v, d = 2) { const n = toUnit(v); return n === null ? '—' : unitSymbol() + fmtMoney(n, d); }
function fmtSignedUsd(v, d = 2) {
  const n = toUnit(v);
  return n === null ? '—' : (n > 0 ? '+' : '') + unitSymbol() + fmtMoney(n, d);
}
function renderFxLabel() {
  const el = $('#fxLabel'); if (!el) return;
  const f = state.fx || {};
  const ok = Number(f.rate) > 0;
  el.textContent = ok ? `${f.rateLabel}${f.stale ? ' · 缓存' : ''}` : '汇率 —';
  el.title = ok
    ? `USD/CNY 参考汇率 · 来源 ${f.provider || '—'} · 报价时间 ${f.sourceTimeIso || '—'} · 抓取 ${f.fetchedIso || '—'}${f.stale ? '（缓存值）' : ''}。仅用于界面单位换算，事实层与分析指标始终为 USD。`
    : '参考汇率暂不可用，金额按 USD 显示；公开数据源恢复后自动更新。';
}
async function loadFx(force = false) {
  try {
    state.fx = await api('/api/fx' + (force ? '?refresh=1' : ''));
    renderFxLabel();
    if (state.tab === 'market' && state.market) renderMkPrices(state.market);
  } catch (_) { /* keep last known rate */ }
}
$('#unitSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-unit]');
  if (!b) return;
  const u = b.dataset.unit;
  if (state.unit === u) return;
  state.unit = u;
  try { localStorage.setItem('gam.unit', u); } catch (_) {}
  $$('#unitSwitch button').forEach(x => x.classList.toggle('on', x.dataset.unit === u));
  renderFxLabel();
  refreshCurrentTab();
});
$$('#unitSwitch button').forEach(x => x.classList.toggle('on', x.dataset.unit === state.unit));
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtShortDate(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 401) {
    const j = await res.json().catch(() => ({}));
    if (j.error === 'UNAUTHORIZED') { showLogin(); throw new Error('UNAUTHORIZED'); }
  }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || j.message || `HTTP ${res.status}`);
  }
  return res.json();
}
async function downloadFile(url, fallbackName) {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('下载失败 HTTP ' + res.status);
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = /filename="?([^"]+)"?/.exec(cd);
    const name = m ? m[1] : fallbackName;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('已开始下载 ' + name);
  } catch (e) { toast(e.message); }
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ------------------------------- auth -------------------------------- */
function showLogin() {
  state.authed = false;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  $('#app').hidden = true; $('#login').hidden = false;
}
function showApp() {
  state.authed = true;
  $('#login').hidden = true; $('#app').hidden = false;
  $('#logoutBtn').hidden = !state.authEnabled;
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').hidden = true;
  try {
    const r = await api('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: $('#tokenInput').value }),
    });
    if (r.ok) { $('#tokenInput').value = ''; showApp(); await loadFx(); await refreshCurrentTab(); startPolling(); }
  } catch (err) { if (err.message !== 'UNAUTHORIZED') $('#loginErr').hidden = false; }
});
$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

/* ------------------------------- tabs -------------------------------- */
const VIEWS = ['overview', 'analytics', 'market', 'operations', 'report', 'export'];
// Backward-compatible deep links: ?tab=decisions used to be the manual log.
const TAB_ALIAS = { decisions: 'operations' };
function switchTab(tab) {
  tab = TAB_ALIAS[tab] || tab;
  if (!VIEWS.includes(tab)) tab = 'overview';
  state.tab = tab;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  VIEWS.forEach(t => { const el = $('#view-' + t); if (el) el.hidden = (t !== tab); });
  refreshCurrentTab();
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) switchTab(b.dataset.tab);
});
async function refreshCurrentTab() {
  if (state.tab === 'overview') return loadAll();
  if (state.tab === 'analytics') return loadAnalytics();
  if (state.tab === 'market') return loadMarket();
  if (state.tab === 'operations') return loadOperations();
  if (state.tab === 'report') return loadReport();
  if (state.tab === 'export') return loadExport();
}

/* ---------------------------- overview render --------------------------- */
function renderSummary(s) {
  state.summary = s; state.mode = s.mode;
  const isDemo = s.mode === 'mock';
  $('#demoBadge').hidden = !isDemo;
  $('#liveBadge').hidden = isDemo;
  $('#modeLabel').textContent = isDemo ? 'DEMO · 模拟数据' : 'Gate.io API v4 · 实时';
  $('#quoteTag').textContent = unitTag();
  $('#footSource').textContent = isDemo ? '模拟数据生成器 (DEMO)' : 'Gate.io API v4';
  $('#sourceLabel').textContent = isDemo ? '模拟 (DEMO)' : 'Gate.io 实时';
  if (s.latest) {
    $('#totalValue').textContent = fmtUsd(s.latest.totalUsd);
    $('#updateTime').textContent = fmtTime(s.latest.ts);
    renderHoldings(s.latest, isDemo);
    renderDistribution(s.latest.accounts || []);
  } else $('#totalValue').textContent = '—';

  const chip = $('#deltaChip');
  if (s.deltaUsd === null || s.deltaUsd === undefined) { chip.className = 'delta-chip neutral'; chip.textContent = '—'; }
  else {
    const up = s.deltaUsd >= 0;
    chip.className = 'delta-chip ' + (up ? 'up' : 'down');
    const sign = up ? '+' : '';
    chip.textContent = `${fmtSignedUsd(s.deltaUsd)} (${sign}${(s.deltaPct || 0).toFixed(2)}%)`;
  }
  const st = s.status || {};
  $('#intervalLabel').textContent = st.intervalSec ? `${st.intervalSec}s` : '—';
  $('#snapCount').textContent = st.snapshotCount !== undefined ? st.snapshotCount.toLocaleString() : '—';
  $('#footStatus').textContent = st.lastRunAt ? `上次采集 ${fmtTime(st.lastRunAt)}` : '';
  const bar = $('#errorBar');
  if (st.lastError) {
    bar.hidden = false;
    bar.textContent = '数据源提示:' + st.lastError + (isDemo ? '' : ' — 部分账户可能未返回,请检查只读权限 / IP 白名单');
  } else bar.hidden = true;
}
function renderDistribution(accounts) {
  const el = $('#distList');
  const items = accounts.filter(a => (a.amount || 0) > 0);
  if (!items.length) { el.innerHTML = '<div class="dist-empty">暂无账户数据</div>'; return; }
  const max = Math.max(...items.map(a => a.amount || 0), 1);
  const total = items.reduce((s, a) => s + (a.amount || 0), 0) || 1;
  const colors = ['#2f6df6', '#7b5cf0', '#12996b', '#e0952a', '#d9536f', '#3aa9c9', '#8a7bd8'];
  el.innerHTML = items.map((a, i) => {
    const pct = (a.amount / total * 100), w = (a.amount / max * 100);
    return `<div class="dist-item">
      <div class="di-top"><span class="di-name">${escapeHtml(a.label || a.id || '账户')}</span>
        <span class="di-val">${fmtUsd(a.amount)}<span class="di-pct">${pct.toFixed(1)}%</span></span></div>
      <div class="di-bar"><i style="width:${w.toFixed(1)}%;background:${colors[i % colors.length]}"></i></div>
    </div>`;
  }).join('');
}
function renderHoldings(latest, isDemo) {
  const body = $('#holdingsBody');
  const hs = (latest.holdings || []).filter(h => (h.amount || 0) > 0);
  $('#holdingsNote').textContent = isDemo ? '数量与估值均为演示值' : '数量来自现货账户;估值以官方折算为准';
  if (!hs.length) { body.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:26px">暂无持仓明细</td></tr>'; return; }
  const totalVal = hs.reduce((s, h) => s + (Number(h.valueUsd) || 0), 0);
  body.innerHTML = hs.map(h => {
    const val = h.valueUsd !== undefined && h.valueUsd !== null ? fmtUsd(h.valueUsd) : '—';
    const pct = totalVal ? (Number(h.valueUsd || 0) / totalVal * 100) : 0;
    const ini = (h.currency || '?').slice(0, 3);
    return `<tr>
      <td><span class="ccy"><span class="coin">${escapeHtml(ini)}</span>${escapeHtml(h.currency || '')}</span></td>
      <td class="num">${fmtQty(h.amount)}</td>
      <td class="num muted">${h.available !== undefined ? fmtQty(h.available) : '—'}</td>
      <td class="num muted">${h.locked !== undefined ? fmtQty(h.locked) : '—'}</td>
      <td class="num">${val}</td>
      <td class="num"><span class="pct-cell"><span class="pct-mini"><i style="width:${Math.min(100, pct).toFixed(1)}%"></i></span>${pct ? pct.toFixed(1) + '%' : '—'}</span></td>
    </tr>`;
  }).join('');
}
function renderChart() {
  const svg = $('#chart'), data = state.series;
  if (!data.length) { svg.innerHTML = ''; return; }
  const W = 640, H = 220, padL = 8, padR = 8, padT = 14, padB = 14;
  const vals = data.map(d => d.totalUsd);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = (max - min) || Math.max(max * 0.01, 1);
  const lo = min - span * 0.12, hi = max + span * 0.12;
  const x = (i) => padL + (i / Math.max(data.length - 1, 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const pts = data.map((d, i) => [x(i), y(d.totalUsd)]);
  let path = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) path += ` L ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`;
  const area = `${path} L ${pts[pts.length - 1][0].toFixed(1)} ${H - padB} L ${pts[0][0].toFixed(1)} ${H - padB} Z`;
  const rising = vals[vals.length - 1] >= vals[0];
  const line = rising ? '#d92b2b' : '#12996b';
  const fill = rising ? 'rgba(217,43,43,.10)' : 'rgba(18,153,107,.10)';
  const gridY = [0, .5, 1].map(f => {
    const gy = padT + f * (H - padT - padB);
    return `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#eef0f4" stroke-width="1"/>`;
  }).join('');
  const last = pts[pts.length - 1];
  svg.innerHTML = `${gridY}
    <path d="${area}" fill="${fill}" stroke="none"/>
    <path d="${path}" fill="none" stroke="${line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3.5" fill="${line}" stroke="#fff" stroke-width="2"/>`;
  $('#chartMin').textContent = fmtUsd(min);
  $('#chartMax').textContent = fmtUsd(max);
  $('#chartRange').textContent = data.length > 1
    ? `${fmtShortDate(data[0].ts)} → ${fmtShortDate(data[data.length - 1].ts)} · ${data.length} 点` : '';
  svg.onmousemove = (e) => {
    const rect = svg.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width * W;
    let idx = Math.round((relX - padL) / (W - padL - padR) * (data.length - 1));
    idx = Math.max(0, Math.min(data.length - 1, idx));
    const tip = $('#chartTip');
    tip.hidden = false;
    tip.style.left = `${(pts[idx][0] / W * 100).toFixed(2)}%`;
    tip.style.top = `${(pts[idx][1] / H * 100).toFixed(2)}%`;
    tip.textContent = `${fmtShortDate(data[idx].ts)}  ≈ ${fmtUsd(data[idx].totalUsd)}`;
  };
  svg.onmouseleave = () => { $('#chartTip').hidden = true; };
}

/* ---------------------------- analytics view ---------------------------- */
async function loadAnalytics() {
  try {
    const [a, gl] = await Promise.all([
      api('/api/analytics?view=compact'),
      state.glossary ? Promise.resolve(state.glossary) : api('/api/metric-glossary'),
    ]);
    state.analytics = a;
    state.glossary = gl;
    renderAnalytics(a);
    renderGlossary(gl);
  } catch (e) { if (e.message !== 'UNAUTHORIZED') toast('分析数据加载失败:' + e.message); }
}
function renderAnalytics(a) {
  const s = a.summary || {}, risk = a.risk || {}, bm = a.benchmarks || {}, cost = a.costs || {}, beh = a.behavior || {}, conc = a.concentration || {}, q = a.quality || {};

  // notice: annualisation reliability + cashflow
  const notice = $('#anNotice');
  if (!a.meta || !a.meta.snapshotCount || risk.windowDays < 7) {
    notice.hidden = false;
    notice.innerHTML = `⚠️ 当前统计窗口仅 <b>${fmtMoney(risk.windowDays || 0, 2)} 天</b>，年化指标（年化波动率 / 夏普 / 索提诺 / 年化 MWR）会被极度放大，<b>仅作算法演示，不具参考意义</b>。窗口满 7 天后自动可靠。历史数据会随时间累积。`;
  } else notice.hidden = true;

  // KPI cards
  const kpis = [
    { label: '时间加权收益 TWR', hint: '剔除了充值/提现的策略真实表现', val: fmtPct(s.twrPct), v: s.twrPct,
      sub: `总资产涨幅 ${fmtPct(s.rawChangePct)}（含现金流）` },
    { label: '资金加权收益 MWR', hint: '按现金流金额与时点加权的区间收益', val: fmtPct(s.mwrWindowPct), v: s.mwrWindowPct,
      sub: s.mwrAnnualizedPct !== null ? `年化 ${fmtPct(s.mwrAnnualizedPct, 1)}${!s.annualizationReliable ? ' (窗口过短)' : ''}` : '区间口径' },
    { label: '最大回撤', hint: '单位净值相对历史峰值的最大跌幅', val: fmtPct(s.maxDrawdownPct), v: s.maxDrawdownPct,
      sub: '基于剔除现金流后的净值曲线' },
    { label: '年化波动率', hint: '区间收益率标准差 × √年化期数', val: s.annualVolatility !== null ? fmtPct(s.annualVolatility * 100, 1) : '—', v: null,
      sub: `区间波动 ${fmtPct((risk.periodVolatility || 0) * 100, 3)}` },
    { label: '夏普比率', hint: '(年化收益 − 无风险利率) / 年化波动', val: s.sharpe !== null ? fmtMoney(s.sharpe, 2) : '—', v: null,
      sub: `索提诺 ${s.sortino !== null ? fmtMoney(s.sortino, 2) : '—'} · 卡玛 ${s.calmar !== null ? fmtMoney(s.calmar, 2) : '—'}` },
    { label: `β (对 ${a.meta?.benchmark || 'BTC'})`, hint: '组合收益对基准收益的回归斜率', val: s.betaVsBenchmark !== null ? fmtMoney(s.betaVsBenchmark, 3) : '—', v: null,
      sub: `相关系数 ${fmtMoney(risk.correlationVsBenchmark, 3)}` },
    { label: '显式成本合计', hint: '手续费 + 资金费绝对值', val: fmtUsd(s.totalExplicitCostUsd), v: null,
      sub: `占均资产 ${cost.costToAvgAssetsPct !== null ? fmtMoney(cost.costToAvgAssetsPct, 4) + '%' : '—'}` },
    { label: '净外部现金流', hint: '充值 − 提现；这部分不是收益', val: fmtSignedUsd(s.netCashflowUsd), v: null,
      sub: `${(a.cashflows || []).length} 笔现金流事件` },
  ];
  $('#kpiGrid').innerHTML = kpis.map(k => `<div class="kpi">
    <div class="kpi-label">${escapeHtml(k.label)} <span class="hint" title="${escapeHtml(k.hint)}">ⓘ</span></div>
    <div class="kpi-val ${cls(k.v)}">${k.val}</div>
    <div class="kpi-sub">${escapeHtml(k.sub)}</div>
  </div>`).join('');

  renderNavChart(a.nav || [], a.cashflows || []);
  renderCashflows(a.cashflows || []);
  renderAttribution(a.attributionAgg || []);
  renderBenchmarks(bm, s);
  renderRisk(risk, s);
  renderCosts(cost, beh);
  renderQuality(conc, q, a.distribution || []);
  renderConventions(a.meta?.conventions || {});
}

/**
 * Dual-axis line chart. Total assets and unit NAV have very different scales
 * (a deposit can move total assets by 16% while NAV barely moves), so a shared
 * axis would flatten the NAV line. Each series gets its own vertical scale;
 * compare SHAPE, not height. Cashflow events are marked as dashed verticals.
 */
function renderNavChart(nav, cfs) {
  const svg = $('#navChart');
  if (nav.length < 2) { svg.innerHTML = '<text x="320" y="120" text-anchor="middle" fill="#9aa2b1" font-size="13">数据点不足</text>'; return; }
  const W = 640, H = 240, padL = 10, padR = 10, padT = 16, padB = 16;
  const base = nav[0].totalUsd || 1;
  const total = nav.map(n => (n.totalUsd || 0) / base);
  const navv = nav.map(n => n.navPerUnit || 1);
  const span = (arr) => {
    let lo = Math.min(...arr), hi = Math.max(...arr);
    if (!(hi > lo)) { const c = hi || 1; lo = c - 0.001; hi = c + 0.001; }
    const pad = (hi - lo) * 0.12;
    return [lo - pad, hi + pad];
  };
  const [tLo, tHi] = span(total);
  const [nLo, nHi] = span(navv);
  const x = (i) => padL + (i / (nav.length - 1)) * (W - padL - padR);
  const yT = (v) => padT + (1 - (v - tLo) / (tHi - tLo)) * (H - padT - padB);
  const yN = (v) => padT + (1 - (v - nLo) / (nHi - nLo)) * (H - padT - padB);
  const pathOf = (arr, yf) => arr.map((v, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${yf(v).toFixed(1)}`).join(' ');
  const gridY = [0, .25, .5, .75, 1].map(f => {
    const gy = padT + f * (H - padT - padB);
    return `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="#eef0f4" stroke-width="1"/>`;
  }).join('');
  const cfLines = cfs.map(c => {
    let idx = 0, best = Infinity;
    nav.forEach((n, i) => { const d = Math.abs(n.ts - c.ts); if (d < best) { best = d; idx = i; } });
    return `<line x1="${x(idx).toFixed(1)}" y1="${padT}" x2="${x(idx).toFixed(1)}" y2="${H - padB}" stroke="#e0952a" stroke-width="1" stroke-dasharray="3 3" opacity=".6"/>`;
  }).join('');
  const iLast = nav.length - 1;
  svg.innerHTML = `${gridY}${cfLines}
    <path d="${pathOf(total, yT)}" fill="none" stroke="#9aa2b1" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>
    <path d="${pathOf(navv, yN)}" fill="none" stroke="#2f6df6" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(iLast).toFixed(1)}" cy="${yT(total[iLast]).toFixed(1)}" r="3" fill="#9aa2b1" stroke="#fff" stroke-width="1.5"/>
    <circle cx="${x(iLast).toFixed(1)}" cy="${yN(navv[iLast]).toFixed(1)}" r="3.5" fill="#2f6df6" stroke="#fff" stroke-width="1.5"/>`;
  state.navChartPts = { nav, total, navv, x, yT, yN, W, H, padL, padR, padT, padB };
  $('#navFootLeft').textContent = `总资产 ${total[0].toFixed(4)} → ${total[iLast].toFixed(4)}`;
  $('#navFootMid').textContent = `${nav.length} 点 · 橙线＝充提`;
  $('#navFootRight').textContent = `单位净值 ${navv[0].toFixed(4)} → ${navv[iLast].toFixed(4)}`;
  svg.onmousemove = (e) => {
    const rect = svg.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width * W;
    let idx = Math.round((relX - padL) / (W - padL - padR) * (nav.length - 1));
    idx = Math.max(0, Math.min(nav.length - 1, idx));
    const tip = $('#navTip');
    tip.hidden = false;
    tip.style.left = `${(x(idx) / W * 100).toFixed(2)}%`;
    tip.style.top = `${(yN(navv[idx]) / H * 100).toFixed(2)}%`;
    tip.innerHTML = `${fmtShortDate(nav[idx].ts)}<br>总资产 ${total[idx].toFixed(4)} · 净值 ${navv[idx].toFixed(4)}`;
  };
  svg.onmouseleave = () => { $('#navTip').hidden = true; };
}

function renderCashflows(cfs) {
  const el = $('#cfList');
  if (!cfs.length) { el.innerHTML = '<div class="cf-empty">窗口内没有外部现金流（充值/提现）</div>'; return; }
  el.innerHTML = cfs.slice().reverse().map(c => {
    const inFlow = (c.cashflowUsd || 0) >= 0;
    return `<div class="cf-row">
      <span class="cf-dot ${inFlow ? 'in' : 'out'}"></span>
      <span class="cf-time">${fmtTime(c.ts)}</span>
      <span class="cf-type">${inFlow ? '充值' : '提现'} · ${escapeHtml(c.currency || '')}</span>
      <span class="cf-note">${escapeHtml(c.note || '')}</span>
      <span class="cf-amt ${inFlow ? 'up' : 'down'}">${fmtSignedUsd(c.cashflowUsd)}</span>
    </div>`;
  }).join('');
}

function renderAttribution(agg) {
  const body = $('#attrBody');
  if (!agg.length) { body.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:26px">暂无归因数据</td></tr>'; return; }
  body.innerHTML = agg.map(a => {
    const isRes = a.currency === '__RESIDUAL__';
    return `<tr class="${isRes ? 'row-residual' : ''}">
      <td>${isRes ? '残差 / 未覆盖' : `<b>${escapeHtml(a.currency)}</b>`}</td>
      <td class="num ${cls(a.priceEffect)}">${fmtSignedUsd(a.priceEffect)}</td>
      <td class="num ${cls(a.qtyEffect)}">${fmtSignedUsd(a.qtyEffect)}</td>
      <td class="num ${cls(a.crossEffect)}">${fmtSignedUsd(a.crossEffect)}</td>
      <td class="num ${cls(a.deltaValueUsd)}"><b>${fmtSignedUsd(a.deltaValueUsd)}</b></td>
      <td class="num ${cls(a.contributionPct)}">${fmtPct(a.contributionPct)}</td>
    </tr>`;
  }).join('');
  // diverging bars (contribution %)
  const vals = agg.filter(a => a.contributionPct !== null).map(a => Number(a.contributionPct));
  const maxAbs = Math.max(...vals.map(Math.abs), 1);
  $('#attrBars').innerHTML = agg.filter(a => a.contributionPct !== null).slice(0, 10).map(a => {
    const w = Math.abs(a.contributionPct) / maxAbs * 50;
    const pos = a.contributionPct >= 0;
    const bar = pos
      ? `<i class="attr-bar-pos" style="left:50%;width:${w}%"></i>`
      : `<i class="attr-bar-neg" style="right:50%;width:${w}%"></i>`;
    return `<div class="attr-bar-row">
      <span class="attr-bar-name">${escapeHtml(a.currency)}</span>
      <span class="attr-bar-track"><i class="attr-bar-zero"></i>${bar}</span>
      <span class="attr-bar-val ${cls(a.contributionPct)}">${fmtPct(a.contributionPct)}</span>
    </div>`;
  }).join('');
}

function kv(label, val, klass = '') {
  return `<div class="kv"><span>${escapeHtml(label)}</span><b class="${klass}">${val}</b></div>`;
}
function renderBenchmarks(bm, s) {
  const rows = [
    kv('组合 TWR', fmtPct(s.twrPct), cls(s.twrPct)),
    kv(`${bm.benchmark || 'BTC'} 买入持有`, bm.available ? fmtPct(bm.buyAndHoldPct) : '无行情数据', cls(bm.buyAndHoldPct)),
    kv('全稳定币(USDT)', fmtPct(bm.allStablecoinPct || 0), ''),
    kv('50/50 再平衡(近似)', bm.available ? fmtPct(bm.fiftyFiftyPct) : '—', cls(bm.fiftyFiftyPct)),
    kv('超额 vs 买入持有', bm.available ? fmtPct(bm.excessVsBuyAndHoldPct) : '—', cls(bm.excessVsBuyAndHoldPct)),
    kv('超额 vs 50/50', bm.available ? fmtPct(bm.excessVsFiftyFiftyPct) : '—', cls(bm.excessVsFiftyFiftyPct)),
  ];
  $('#benchBox').innerHTML = rows.join('') + `<p class="muted small" style="margin:10px 0 4px;line-height:1.6">回答「忙活半天跑赢躺平了吗」。超额为正表示策略优于该基准。</p>`;
}
function renderRisk(risk, s) {
  const rows = [
    kv('统计窗口', fmtMoney(risk.windowDays, 2) + ' 天'),
    kv('区间数', fmtMoney(risk.sampleIntervals, 0)),
    kv('年化收益', fmtPct(s.annualReturn !== null ? s.annualReturn * 100 : null, 2), cls(s.annualReturn)),
    kv('年化波动率', fmtPct(s.annualVolatility !== null ? s.annualVolatility * 100 : null, 2)),
    kv('下行波动率', fmtPct(risk.downsideVolatility !== null ? risk.downsideVolatility * 100 : null, 2)),
    kv('夏普 / 索提诺', `${fmtMoney(s.sharpe, 2)} / ${fmtMoney(s.sortino, 2)}`),
    kv('卡玛比率', fmtMoney(s.calmar, 2)),
    kv('最大回撤', fmtPct(s.maxDrawdownPct), cls(s.maxDrawdownPct)),
    kv(`β / 相关(${risk.benchmark || 'BTC'})`, `${fmtMoney(risk.betaVsBenchmark, 3)} / ${fmtMoney(risk.correlationVsBenchmark, 3)}`),
    kv('无风险利率(年化)', fmtPct((risk.riskFreeRate || 0) * 100, 2)),
  ];
  $('#riskBox').innerHTML = rows.join('') + `<p class="muted small" style="margin:10px 0 4px;line-height:1.6">${risk.annualizationReliable ? '窗口 ≥ 7 天，年化指标可用。' : '⚠️ 窗口 < 7 天，年化指标仅供演示。'}</p>`;
}
function renderCosts(cost, beh) {
  const rows = [
    kv('手续费合计', fmtUsd(cost.totalFeeUsd)),
    kv('资金费净额', fmtSignedUsd(cost.fundingUsd), cls(cost.fundingUsd)),
    kv('理财利息', fmtSignedUsd(cost.interestUsd), cls(cost.interestUsd)),
    kv('返佣 / 返利', fmtSignedUsd(cost.rebateUsd), cls(cost.rebateUsd)),
    kv('已实现盈亏', fmtSignedUsd(cost.realisedPnlUsd), cls(cost.realisedPnlUsd)),
    kv('显式成本合计', fmtUsd(cost.totalExplicitCostUsd)),
    kv('年化成本率', cost.annualisedCostPct !== null ? fmtPct(cost.annualisedCostPct, 3) : '—'),
    kv('成交腿数 / maker 占比', `${fmtMoney(cost.tradeLegs, 0)} / ${cost.makerRatioPct !== null ? fmtMoney(cost.makerRatioPct, 1) + '%' : '—'}`),
    kv('胜率 / 盈亏比', `${beh.winRatePct !== null ? fmtMoney(beh.winRatePct, 1) + '%' : '—'} / ${fmtMoney(beh.profitFactor, 2)}`),
    kv(`单笔期望(${unitTag()})`, fmtSignedUsd(beh.expectancyUsd)),
    kv('决策数 / 复盘覆盖', `${fmtMoney(beh.decisionsTotal, 0)} / ${beh.reviewCoveragePct !== null ? fmtMoney(beh.reviewCoveragePct, 0) + '%' : '—'}`),
  ];
  $('#costBox').innerHTML = rows.join('') + `<p class="muted small" style="margin:10px 0 4px;line-height:1.6">很多「策略不赚钱」其实是成本吃掉的。行为指标依赖已实现盈亏与人工决策日志。</p>`;
}
function renderQuality(conc, q, dist) {
  const rows = [
    kv('持仓币种数', fmtMoney(conc?.currencies, 0)),
    kv('集中度 HHI', fmtMoney(conc?.hhi, 4)),
    kv('有效币种数', fmtMoney(conc?.effectiveN, 2)),
    kv('Top1 / Top3 占比', conc ? `${fmtMoney(conc.top1Pct, 1)}% / ${fmtMoney(conc.top3Pct, 1)}%` : '—'),
    kv('稳定币占比', conc ? fmtMoney(conc.stablecoinPct, 2) + '%' : '—'),
    kv('快照 / 事件数', `${fmtMoney(q.snapshotCount, 0)} / ${fmtMoney(q.eventCount, 0)}`),
    kv('采集断点(长间隔)', fmtMoney(q.longGaps, 0)),
    kv('重复事件 ID', fmtMoney(q.duplicateEventIds, 0)),
    kv('最大残差贡献', fmtPct(q.maxResidualContributionPct, 4)),
    kv('哈希链完整', q.hashChainOk === null ? '—' : (q.hashChainOk ? '✓ 校验通过' : '⚠ 检出异常')),
  ];
  const distRows = (dist || []).slice(0, 4).map(d =>
    kv(`${d.label || d.accountId} 迁移`, fmtPct(d.changePct, 1), cls(d.changePct))).join('');
  $('#qualityBox').innerHTML = rows.join('') + distRows +
    `<p class="muted small" style="margin:10px 0 4px;line-height:1.6">HHI 越高越集中；原始事实以 append-only + SHA-256 哈希链存储，改动可在导出中心校验。</p>`;
}
function renderConventions(conv) {
  const labels = {
    twr: 'TWR 口径', mwr: 'MWR / XIRR', attribution: '贡献分解', price: '单价口径',
    timezone: '时间口径', residual: '残差恒等式',
  };
  $('#convBox').innerHTML = Object.entries(conv).map(([k, v]) =>
    `<div class="conv-item"><b>${escapeHtml(labels[k] || k)}：</b><code>${escapeHtml(v)}</code></div>`).join('') ||
    '<div class="muted small">暂无口径信息</div>';
}

/* ---------------------- metric glossary (指标详解) ---------------------- */
/**
 * The glossary is PURE DOCUMENTATION served by /api/metric-glossary. It is
 * also exported as the `metric_glossary` table so a third party reading the
 * CSV knows exactly where each number came from and what its direction means.
 */
function renderGlossary(gl) {
  const groups = gl.groups || [], items = gl.items || [];
  $('#glGroupTabs').innerHTML =
    `<button class="gl-chip ${state.glGroup === 'all' ? 'on' : ''}" data-group="all">全部 ${items.length}</button>` +
    groups.map(g => `<button class="gl-chip ${state.glGroup === g.key ? 'on' : ''}" data-group="${escapeHtml(g.key)}" title="${escapeHtml(g.desc || '')}">${escapeHtml(g.name)}</button>`).join('');
  renderGlossaryList();
}
function renderGlossaryList() {
  const items = state.glossary?.items || [];
  const gname = Object.fromEntries((state.glossary?.groups || []).map(g => [g.key, g.name]));
  const q = (state.glQuery || '').trim().toLowerCase();
  const list = items.filter(x => {
    if (state.glGroup !== 'all' && x.group !== state.glGroup) return false;
    if (!q) return true;
    return [x.name, x.field, x.source, x.formula, x.meaning, x.caveat].join(' ').toLowerCase().includes(q);
  });
  $('#glStat').textContent = `${items.length} 个指标 · 显示 ${list.length} 个 · 来源/口径/走势含义/误读四项齐全`;
  $('#glList').innerHTML = list.length ? list.map((x, i) => `
    <details class="gl-item" ${i < 2 ? 'open' : ''}>
      <summary class="gl-summary">
        <span class="gl-seq">${String(i + 1).padStart(2, '0')}</span>
        <span class="gl-name">${escapeHtml(x.name)}</span>
        <span class="gl-group-tag">${escapeHtml(gname[x.group] || x.group)}</span>
        <code class="gl-field">${escapeHtml(x.field)}</code>
        <span class="gl-chev">⌄</span>
      </summary>
      <div class="gl-body">
        <div class="gl-line"><span class="gl-k">来源</span><p>${escapeHtml(x.source)}</p></div>
        <div class="gl-line"><span class="gl-k">计算口径</span><p>${escapeHtml(x.formula)}</p></div>
        <div class="gl-line"><span class="gl-k gl-k-mean">走势 / 数值意味着什么</span><p>${escapeHtml(x.meaning)}</p></div>
        <div class="gl-line"><span class="gl-k">注意 / 常见误读</span><p>${escapeHtml(x.caveat)}</p></div>
      </div>
    </details>`).join('') : '<div class="dec-empty">没有匹配的指标，换个关键词试试。</div>';
}
$('#glGroupTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-group]');
  if (!b) return;
  state.glGroup = b.dataset.group;
  $$('#glGroupTabs button').forEach(x => x.classList.toggle('on', x === b));
  renderGlossaryList();
});
$('#glSearch').addEventListener('input', (e) => { state.glQuery = e.target.value; renderGlossaryList(); });

/* ------------------- operations (read-only Gate mirror) ----------------- */
/**
 * Operations are DERIVED from Gate's real ledger (`events`), never typed in.
 * The user's subjective layer (motive / TP / SL / expectation / review) is a
 * separate append-only `annotations` chain keyed by operationId. The UI below
 * only ever writes annotations; the operation card itself is read-only.
 */
const OP_KIND_LABEL = { buy: '买入', sell: '卖出', deposit: '充值', withdraw: '提现',
  transfer: '划转', fee: '手续费', funding: '资金费', interest: '理财利息',
  realized_pnl: '已实现盈亏', rebate: '返佣返利', liquidation: '强平',
  trade_fill: '成交资金变动', order: '下单/撤单', lend: '理财借出',
  redeem: '理财赎回', award: '奖励发放', trade: '成交', other: '其它' };
const OP_OUTCOME_LABEL = { better: '好于预期', as_expected: '符合预期', worse: '差于预期', abandoned: '已放弃' };
const OP_KIND_ORDER = ['buy', 'sell', 'trade_fill', 'order', 'fee', 'transfer', 'deposit',
  'withdraw', 'lend', 'redeem', 'award', 'funding', 'interest', 'realized_pnl',
  'rebate', 'liquidation', 'trade', 'other'];

async function loadOperations() {
  try {
    const qs = new URLSearchParams({ limit: '500' });
    if (state.opKind !== 'all') qs.set('kinds', state.opKind);
    if (state.opOnlyAnn) qs.set('annotated', '1');
    const d = await api('/api/operations?' + qs.toString());
    state.operations = d.operations || [];
    state.opStats = d.stats || {};
    renderOpStats(d.stats || {}, d.mode);
    renderOpKindChips(d.stats || {});
    renderOperations(state.operations, d.mode);
  } catch (e) { if (e.message !== 'UNAUTHORIZED') toast('操作记录加载失败: ' + e.message); }
}
function renderOpStats(st, mode) {
  const cov = st.annotationCoveragePct;
  $('#opStat').innerHTML = `
    <div class="op-stat-item"><span>操作总数</span><b>${fmtMoney(st.total, 0)}</b></div>
    <div class="op-stat-item"><span>买卖成交</span><b>${fmtMoney(st.trades, 0)}</b></div>
    <div class="op-stat-item"><span>外部现金流</span><b>${fmtMoney(st.cashflow, 0)}</b></div>
    <div class="op-stat-item"><span>手续费合计</span><b>${fmtUsd(st.feesUsd)}</b></div>
    <div class="op-stat-item"><span>已注释 / 覆盖率</span><b>${fmtMoney(st.annotated, 0)} / ${cov !== undefined && cov !== null ? fmtMoney(cov, 1) + '%' : '—'}</b></div>
    <div class="op-stat-item"><span>数据来源</span><b>${mode === 'live' ? 'Gate.io API v4 · 只读' : 'DEMO 模拟流水'}</b></div>`;
}
function renderOpKindChips(st) {
  const by = st.byKind || {};
  const chips = [`<button class="op-chip ${state.opKind === 'all' ? 'on' : ''}" data-kind="all">全部 ${fmtMoney(st.total, 0)}</button>`];
  for (const k of OP_KIND_ORDER) {
    if (!by[k]) continue;
    chips.push(`<button class="op-chip ${state.opKind === k ? 'on' : ''}" data-kind="${escapeHtml(k)}">${escapeHtml(OP_KIND_LABEL[k] || k)} ${by[k]}</button>`);
  }
  for (const k of Object.keys(by)) {
    if (OP_KIND_ORDER.includes(k)) continue;
    chips.push(`<button class="op-chip ${state.opKind === k ? 'on' : ''}" data-kind="${escapeHtml(k)}">${escapeHtml(OP_KIND_LABEL[k] || k)} ${by[k]}</button>`);
  }
  $('#opKindChips').innerHTML = chips.join('');
}
function renderOperations(ops, mode) {
  const el = $('#opList');
  $('#opListStat').textContent = ops.length ? `${ops.length} 条 · 按时间倒序 · 最多显示 500 条` : '';
  if (!ops.length) {
    el.innerHTML = `<div class="dec-empty">${state.opOnlyAnn ? '还没有已注释的操作。' : '当前筛选下没有操作流水。'}${mode === 'mock' ? ' DEMO 模式下为模拟流水。' : ' 可点击「刷新」重新同步 Gate 只读接口。'}</div>`;
    return;
  }
  el.innerHTML = ops.map(o => {
    const a = o.annotation || null;
    const tags = [];
    if (o.isCashflow) tags.push('<span class="op-tag op-tag-cf">外部现金流</span>');
    if (o.legCount > 1) tags.push(`<span class="op-tag">${o.legCount} 条原始流水合并</span>`);
    if (o.source === 'mock') tags.push('<span class="op-tag">DEMO</span>');
    const annBlock = a ? `
      <div class="op-ann">
        <div class="op-ann-head"><span class="op-ann-badge">已注释</span>
          ${a.annotatedAt ? `<span class="muted small">更新于 ${fmtTime(a.annotatedAt)}</span>` : ''}
          ${(a.tags || []).length ? `<span class="op-tags">${(a.tags || []).map(t => `<span class="op-tag-sm">${escapeHtml(t)}</span>`).join('')}</span>` : ''}
        </div>
        <div class="op-ann-grid">
          ${a.motive ? `<div><span>动机</span><p>${escapeHtml(a.motive)}</p></div>` : ''}
          ${a.takeProfit ? `<div><span>止盈</span><p>${escapeHtml(a.takeProfit)}</p></div>` : ''}
          ${a.stopLoss ? `<div><span>止损</span><p>${escapeHtml(a.stopLoss)}</p></div>` : ''}
          ${a.expectation ? `<div><span>预期</span><p>${escapeHtml(a.expectation)}</p></div>` : ''}
        </div>
        ${(a.reviewNote || a.outcome) ? `<div class="op-review"><span class="op-outcome ${escapeHtml(a.outcome || '')}">${escapeHtml(OP_OUTCOME_LABEL[a.outcome] || '已复盘')}</span>${escapeHtml(a.reviewNote || '')}${a.reviewedAt ? `<span class="muted small"> · ${fmtTime(a.reviewedAt)}</span>` : ''}</div>` : ''}
      </div>` : '<div class="op-no-ann muted small">未填写动机 / 止盈止损 —— 在下面补充，与 Gate 原始数据分开保存</div>';
    return `<div class="op-card" data-op-id="${escapeHtml(o.id)}">
      <div class="op-head">
        <span class="op-kind op-kind-${escapeHtml(o.kind)}">${escapeHtml(o.kindLabel || OP_KIND_LABEL[o.kind] || o.kind)}</span>
        <span class="op-sym">${escapeHtml(o.symbol || o.pair || '—')}</span>
        ${o.pair ? `<span class="muted small">${escapeHtml(o.pair)}</span>` : ''}
        <span class="op-time">${fmtTime(o.ts)}</span>
        <span class="op-tags">${tags.join('')}</span>
      </div>
      <div class="op-nums">
        ${o.amount ? `<span>数量 <b>${fmtQty(o.amount)}</b></span>` : ''}
        ${o.priceUsd ? `<span>单价 <b>${fmtUsd(o.priceUsd, 6)}</b></span>` : ''}
        ${o.valueUsd ? `<span>估值 <b>${fmtUsd(o.valueUsd)}</b></span>` : ''}
        ${o.feeUsd ? `<span>手续费 <b>${fmtMoney(o.feeUsd, 4)}${o.feeCurrency ? ' ' + escapeHtml(o.feeCurrency) : ''}</b></span>` : ''}
        ${o.isCashflow ? `<span>现金流 <b class="${cls(o.cashflowUsd)}">${fmtSignedUsd(o.cashflowUsd)}</b></span>` : ''}
        <span class="muted small">${escapeHtml(o.venue || 'spot')} · ${(o.eventIds || []).length || 1} 条 Gate 原始事件</span>
      </div>
      ${o.note ? `<div class="op-note muted small">${escapeHtml(o.note)}</div>` : ''}
      ${annBlock}
      <div class="op-btns">
        <button class="btn ghost" data-op-edit>${a ? '编辑动机 / 止盈止损' : '填写动机 / 止盈止损'}</button>
        <button class="btn ghost" data-op-review>${a && (a.reviewNote || a.outcome) ? '追加复盘' : '写复盘'}</button>
        ${a ? '<button class="btn ghost op-del" data-op-del>删除注释</button>' : ''}
      </div>
      <form class="op-annotation-form" hidden>
        <div class="op-form-grid">
          <label>动机 / 为什么做这笔<textarea name="motive" rows="2" placeholder="如：突破前高，顺势跟进">${escapeHtml(a?.motive || '')}</textarea></label>
          <label>止盈<input name="takeProfit" placeholder="价格 / 百分比 / 条件" value="${escapeHtml(a?.takeProfit || '')}" /></label>
          <label>止损<input name="stopLoss" placeholder="价格 / 百分比 / 条件" value="${escapeHtml(a?.stopLoss || '')}" /></label>
          <label>预期<textarea name="expectation" rows="2" placeholder="预期走法、持有周期…">${escapeHtml(a?.expectation || '')}</textarea></label>
          <label>标签（逗号分隔）<input name="tags" placeholder="趋势,突破" value="${escapeHtml((a?.tags || []).join(','))}" /></label>
        </div>
        <div class="op-form-foot">
          <button type="submit" class="btn primary">保存注释（append-only）</button>
          <button type="button" class="btn ghost" data-cancel>取消</button>
          <span class="muted small">修改会追加一条审计记录，原记录保留；可随时在导出中心取回完整注释链</span>
        </div>
      </form>
      <form class="op-review-form" hidden>
        <textarea name="reviewNote" rows="2" placeholder="事后看，当时的判断对了还是错了？为什么？">${escapeHtml(a?.reviewNote || '')}</textarea>
        <div class="op-form-foot">
          <select name="outcome">
            <option value="as_expected" ${a?.outcome === 'as_expected' ? 'selected' : ''}>符合预期</option>
            <option value="better" ${a?.outcome === 'better' ? 'selected' : ''}>好于预期</option>
            <option value="worse" ${a?.outcome === 'worse' ? 'selected' : ''}>差于预期</option>
            <option value="abandoned" ${a?.outcome === 'abandoned' ? 'selected' : ''}>已放弃</option>
          </select>
          <button type="submit" class="btn primary">保存复盘</button>
          <button type="button" class="btn ghost" data-cancel>取消</button>
        </div>
      </form>
    </div>`;
  }).join('');
}
$('#opKindChips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-kind]');
  if (!b) return;
  state.opKind = b.dataset.kind;
  $$('#opKindChips button').forEach(x => x.classList.toggle('on', x === b));
  loadOperations();
});
$('#opOnlyAnn').addEventListener('change', (e) => { state.opOnlyAnn = e.target.checked; loadOperations(); });
$('#opRefreshBtn').addEventListener('click', async () => {
  const btn = $('#opRefreshBtn'); btn.disabled = true;
  try {
    await api('/api/refresh', { method: 'POST' });   // live: re-pulls Gate ledger facts
    toast('已重新同步 Gate 只读流水');
    await loadOperations();
  } catch (err) { toast('刷新失败: ' + err.message); }
  finally { btn.disabled = false; }
});
$('#opList').addEventListener('click', async (e) => {
  const card = e.target.closest('.op-card');
  if (!card) return;
  const id = card.dataset.opId;
  const annForm = card.querySelector('.op-annotation-form');
  const revForm = card.querySelector('.op-review-form');
  if (e.target.closest('[data-cancel]')) { annForm.hidden = true; revForm.hidden = true; return; }
  if (e.target.closest('[data-op-edit]')) { annForm.hidden = !annForm.hidden; revForm.hidden = true; return; }
  if (e.target.closest('[data-op-review]')) {
    if (!card.querySelector('.op-ann')) { toast('请先保存动机 / 止盈止损，再写复盘'); return; }
    revForm.hidden = !revForm.hidden; annForm.hidden = true; return;
  }
  const del = e.target.closest('[data-op-del]');
  if (del) {
    if (del.dataset.confirm !== '1') {   // two-step confirm, no blocking dialog()
      del.dataset.confirm = '1'; del.textContent = '确认删除？'; del.classList.add('danger');
      setTimeout(() => { if (del.isConnected) { del.dataset.confirm = ''; del.textContent = '删除注释'; del.classList.remove('danger'); } }, 4000);
      return;
    }
    del.disabled = true;
    try {
      await api('/api/operations/annotate/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: id }),
      });
      toast('注释已删除（审计链保留）');
      await loadOperations();
      await loadAnalytics().catch(() => {});
    } catch (err) { toast('删除失败: ' + err.message); }
  }
});
$('#opList').addEventListener('submit', async (e) => {
  const annForm = e.target.closest('.op-annotation-form');
  const revForm = e.target.closest('.op-review-form');
  if (!annForm && !revForm) return;
  e.preventDefault();
  const id = e.target.closest('.op-card').dataset.opId;
  const fd = new FormData(e.target);
  const btn = e.target.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (annForm) {
      await api('/api/operations/annotate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId: id, motive: fd.get('motive'), takeProfit: fd.get('takeProfit'),
          stopLoss: fd.get('stopLoss'), expectation: fd.get('expectation'), tags: fd.get('tags'),
        }),
      });
      toast('注释已保存（append-only）');
    } else {
      await api('/api/operations/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: id, reviewNote: fd.get('reviewNote'), outcome: fd.get('outcome') }),
      });
      toast('复盘已追加，动机与止盈止损保持不变');
    }
    await loadOperations();
    await loadAnalytics().catch(() => {});
  } catch (err) { toast('保存失败: ' + err.message); }
  finally { btn.disabled = false; }
});

/* ------------------------------ daily report ---------------------------- */
const RP_LEVEL = { warn: { label: '需复核', cls: 'warn' }, info: { label: '提示', cls: 'info' }, good: { label: '常规', cls: 'good' } };

async function loadReport() {
  try {
    const [st, hist] = await Promise.all([
      api('/api/report/status'), api('/api/report/history?limit=30'),
    ]);
    state.reportStatus = st;
    state.reportHistory = hist.reports || [];
    renderReportStatus(st);
    renderReportHistory(state.reportHistory);
    if (!state.report) await loadReportPreview();   // first visit auto-previews, no push / no history
  } catch (e) { if (e.message !== 'UNAUTHORIZED') toast('日报状态加载失败: ' + e.message); }
}
async function loadReportPreview() {
  const btn = $('#rpPreviewBtn'); btn.disabled = true;
  try {
    const rep = await api('/api/report/preview?refresh=1');
    state.report = rep;
    renderReportPreview(rep);
    toast('日报预览已生成（未推送、未写历史）');
  } catch (e) { toast('预览生成失败: ' + e.message); }
  finally { btn.disabled = false; }
}
function renderReportStatus(st) {
  const rows = [
    `<div class="rp-status-row"><span>机器人配置</span><b class="${st.configured ? 'ok' : 'no'}">${st.configured ? '已配置 · ' + escapeHtml(st.maskedWebhook) : '未配置（仍可预览 / 存档，不会推送）'}</b></div>`,
    `<div class="rp-status-row"><span>定时调度</span><b>${st.enabled ? `已开启 · 每天 ${escapeHtml(st.schedule)} ${escapeHtml(st.tzLabel)}` : '未开启（REPORT_ENABLED=false）'}</b></div>`,
    `<div class="rp-status-row"><span>@ 提醒</span><b>${st.mentionCount ? st.mentionCount + ' 个手机号 / @all' : '未设置'}</b></div>`,
    `<div class="rp-status-row"><span>日报区间 / 存档</span><b>${escapeHtml(st.preset || '24H')} · ${fmtMoney(st.reportCount, 0)} 篇${st.keepHistory ? '' : '（不保留历史）'}</b></div>`,
  ];
  if (st.lastReportAt) rows.push(`<div class="rp-status-row"><span>上次推送</span><b>${fmtTime(st.lastReportAt)} · ${st.lastReportOk ? '✓ 成功' : '⚠ ' + escapeHtml(st.lastReportMessage || '失败')}</b></div>`);
  $('#rpStatus').innerHTML = rows.join('');
}
function renderReportPreview(rep) {
  const m = rep.meta || {};
  $('#rpPreviewStat').textContent = `${m.generatedAtLocal || ''} · ${m.tzLabel || ''} · ${m.mode === 'live' ? 'Gate 实时' : 'DEMO'} · ${fmtMoney(m.snapshotCount, 0)} 快照`;
  const secHtml = (rep.sections || []).map(sec => `
    <div class="rp-sec">
      <h3>${escapeHtml(sec.title)}</h3>
      <div class="rp-lines">${(sec.lines || []).map(l =>
        `<div class="rp-line"><span>${escapeHtml(l.label)}</span><b class="${l.tone === 'up' ? 'up' : l.tone === 'down' ? 'down' : ''}">${escapeHtml(l.value)}</b></div>`).join('')}</div>
      ${(sec.bullets || []).map(b => `<p class="rp-bullet">${escapeHtml(b)}</p>`).join('')}
    </div>`).join('');
  const obsHtml = (rep.observations || []).map((o, i) => {
    const lv = RP_LEVEL[o.level] || RP_LEVEL.info;
    return `<div class="rp-obs rp-obs-${lv.cls}">
      <div class="rp-obs-head"><span class="rp-obs-lv">${lv.label}</span><b>${i + 1}. ${escapeHtml(o.title)}</b></div>
      <p>${escapeHtml(o.detail)}</p>
      <div class="rp-obs-basis">依据：${escapeHtml(o.basis)}</div>
    </div>`;
  }).join('');
  const brief = (rep.marketBrief || []).map(b =>
    `<div class="rp-line"><span>${escapeHtml(b.symbol)}</span><b>${b.lastPrice === null ? '—' : fmtUsd(b.lastPrice, 2)} · 24h <em class="${cls(b.chg24Pct)}">${fmtPct(b.chg24Pct)}</em> · 区间 ${fmtPct(b.chgWindowPct)}</b></div>`).join('');
  $('#rpPreview').innerHTML = `
    <div class="rp-headline">${escapeHtml(rep.headline || '')}</div>
    <div class="rp-meta">生成于 ${escapeHtml(m.generatedAtLocal || '')} (${escapeHtml(m.tzLabel || '')}) · 窗口 ${fmtTime(m.windowFrom)} → ${fmtTime(m.windowTo)} · 主基准 ${escapeHtml(m.benchmarkMain || 'BTC')} · ${m.windowReliable ? '年化指标可用' : '年化指标仅供参考'}</div>
    <div class="rp-sections">${secHtml}</div>
    ${brief ? `<div class="rp-sec"><h3>主流币最新价（已收盘 K 线）</h3><div class="rp-lines">${brief}</div></div>` : ''}
    <div class="rp-obs-title">资产处置观察 · 数据驱动复核提示（${(rep.observations || []).length} 项）</div>
    <div class="rp-obs-list">${obsHtml}</div>
    <div class="rp-disclaimer">${escapeHtml(rep.disclaimer || '')}</div>
    <details class="rp-md"><summary>查看将推送到企业微信的 Markdown 原文（${(rep.markdownChunks || []).length} 段 / ${(rep.markdown || '').length} 字符）</summary><pre>${escapeHtml(rep.markdown || '')}</pre></details>`;
}
function renderReportHistory(rows) {
  $('#rpHistoryStat').textContent = rows.length ? `${rows.length} 篇（最近 30 篇）` : '';
  $('#rpHistory').innerHTML = rows.length ? rows.map(r => `
    <div class="rp-hist-card">
      <div class="rp-hist-top">
        <b>${escapeHtml(r.date || '')}</b>
        <span class="rp-hist-badge ${r.pushed ? (r.pushOk ? 'ok' : 'no') : 'gray'}">${r.pushed ? (r.pushOk ? '已推送' : '推送失败') : '仅生成'}</span>
        <span class="muted small">${escapeHtml(r.tzLabel || '')} · ${escapeHtml(r.trigger || '')}</span>
      </div>
      <div class="rp-hist-head">${escapeHtml(r.headline || '')}</div>
      <div class="rp-hist-meta muted small">${fmtTime(r.ts)} · ${fmtMoney(r.chunks, 0)} 段 · ${fmtMoney(r.snapshotCount, 0)} 快照 · ${r.windowReliable ? '年化可用' : '短窗口'}${r.pushMessage ? ' · ' + escapeHtml(r.pushMessage) : ''}</div>
      <div class="rp-hist-actions"><button class="btn ghost" data-md="${escapeHtml(r.id)}">查看 Markdown 全文</button></div>
      <pre class="rp-hist-md" hidden></pre>
    </div>`).join('') : '<div class="muted small">还没有日报存档。生成预览不写历史；点击「立即推送到企业微信」后会写入 append-only 历史链。</div>';
}
$('#rpHistory').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-md]');
  if (!b) return;
  const card = b.closest('.rp-hist-card');
  const pre = card.querySelector('.rp-hist-md');
  if (!pre.hidden) { pre.hidden = true; b.textContent = '查看 Markdown 全文'; return; }
  b.disabled = true;
  try {
    const r = await api('/api/report/markdown?id=' + encodeURIComponent(b.dataset.md));
    pre.textContent = r.markdown || '';
    pre.hidden = false;
    b.textContent = '收起 Markdown';
  } catch (err) { toast('读取失败: ' + err.message); }
  finally { b.disabled = false; }
});
$('#rpPreviewBtn').addEventListener('click', loadReportPreview);
$('#rpSendBtn').addEventListener('click', async () => {
  const btn = $('#rpSendBtn'); btn.disabled = true;
  try {
    const r = await api('/api/report/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: 'manual' }),
    });
    const p = r.push || {};
    toast(p.ok ? `已推送 ${p.sent} 条消息到企业微信` : `日报已生成并存档，但推送失败：${p.message || '未配置 webhook'}`);
    const [st, hist] = await Promise.all([api('/api/report/status'), api('/api/report/history?limit=30')]);
    state.reportStatus = st; state.reportHistory = hist.reports || [];
    renderReportStatus(st); renderReportHistory(state.reportHistory);
  } catch (e) { toast('推送失败: ' + e.message); }
  finally { btn.disabled = false; }
});
$('#rpTestBtn').addEventListener('click', async () => {
  const btn = $('#rpTestBtn'); btn.disabled = true;
  try {
    const r = await api('/api/report/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    toast(r.ok ? '测试消息已发送，请查看企业微信群' : '测试未成功：' + (r.message || '未配置 webhook'));
  } catch (e) { toast('测试失败: ' + e.message); }
  finally { btn.disabled = false; }
});

/* ------------------------------ export view ----------------------------- */
async function loadExport() {
  try {
    const [ds, integ] = await Promise.all([api('/api/datasets'), api('/api/integrity')]);
    state.datasets = ds; state.integrity = integ.chains;
    renderDatasets(ds);
    renderIntegrity(integ.chains, ds.mode);
  } catch (e) { if (e.message !== 'UNAUTHORIZED') toast('导出清单加载失败:' + e.message); }
}
function renderDatasets(ds) {
  const totalRows = ds.datasets.reduce((s, d) => s + d.rows, 0);
  $('#dsStat').textContent = `${ds.datasets.length} 张表 · 共 ${totalRows.toLocaleString()} 行${ds.mode === 'mock' ? ' · DEMO' : ''}`;
  // data-label + cell classes let the 600px media query reflow this table
  // into stacked cards (buttons stay visible/tappable on phones).
  $('#dsBody').innerHTML = ds.datasets.map(d => `<tr>
    <td class="ds-name-cell"><span class="ds-name">${escapeHtml(d.name)}</span><span class="ds-title">${escapeHtml(d.title)}</span></td>
    <td data-label="粒度" class="muted small">${escapeHtml(d.grain)}</td>
    <td data-label="行数" class="num">${d.rows.toLocaleString()}</td>
    <td data-label="列数" class="num">${d.columns}</td>
    <td data-label="导出" class="ds-action-cell"><div class="dl-btns">
      ${['csv', 'json', 'jsonl'].map(f => `<button class="dl-btn" data-ds="${escapeHtml(d.name)}" data-fmt="${f}">${f.toUpperCase()}</button>`).join('')}
    </div></td>
  </tr>`).join('');
}
function renderIntegrity(chains, mode) {
  const allOk = Object.values(chains).every(v => v.ok !== false);
  const box = $('#integrityBox');
  box.className = 'integrity-box ' + (allOk ? 'ok' : 'bad');
  box.innerHTML = `<b>${allOk ? '✓ 数据完整性校验通过' : '⚠ 检出数据异常'}</b> · 模式 ${escapeHtml(mode || '')}${mode === 'mock' ? '（DEMO 模拟数据）' : ''}<br>` +
    Object.entries(chains).map(([k, v]) =>
      `${escapeHtml(k)}: ${v.count} 条 · ${v.ok ? '哈希链完整' : '⚠ ' + escapeHtml(v.reason || '异常')}`).join(' &nbsp;|&nbsp; ') +
    `<br><span class="muted">原始事实为 append-only + SHA-256 哈希链；任何改动或删除都会在校验中暴露。</span>`;
}
$('#dsBody').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ds]');
  if (!b) return;
  downloadFile(`/api/export/dataset?name=${encodeURIComponent(b.dataset.ds)}&format=${b.dataset.fmt}`,
    `${b.dataset.ds}.${b.dataset.fmt}`);
});
$('#bundleBtn').addEventListener('click', () => downloadFile('/api/export/all', 'gate-assets.zip'));
$('#dictBtn').addEventListener('click', () => downloadFile('/api/schema?format=csv', 'gate-dictionary.csv'));
$('#schemaBtn').addEventListener('click', () => window.open('/api/schema', '_blank', 'noopener'));

/* ------------------------------- loading ----------------------------- */
/* --------------------- v5 extended enrichment ------------------------ *
 * Layout rule from the user: key info at a glance, everything else tucked
 * away. So the overview gets ONE thin headline strip; all long-tail tables
 * live in a collapsed <details> and are only fetched when it is opened.
 * --------------------------------------------------------------------- */
function renderEnrichHeadline(x) {
  const el = $('#enrichStrip');
  if (!x || !x.available || !x.headline) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="enrich-tag">扩展数据</span>
    <span class="enrich-line">${escapeHtml(x.headline)}</span>
    <button type="button" class="enrich-jump" id="enrichJump">明细 ↓</button>`;
  const jump = $('#enrichJump');
  if (jump) jump.addEventListener('click', () => {
    const d = $('#moreData');
    if (d) { d.open = true; loadEnrichDetail(); d.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  });
}
async function loadEnrichHeadline() {
  try {
    const x = await api('/api/enrichment?view=headline');
    state.enrichHeadline = x;
    renderEnrichHeadline(x);
  } catch (e) { /* optional data must never break the overview */ }
}

function enrNum(v, d = 2) { return v === null || v === undefined ? '—' : escapeHtml(fmtUsd(v, d)); }
const enrPct = (v) => v === null || v === undefined ? '—' : `<span class="${cls(v)}">${fmtPct(v)}</span>`;

/** Generic small table card, used only inside the collapsed panel. */
function enrCard(title, cols, rows, note) {
  if (!rows || !rows.length) return '';
  const head = cols.map(c => `<th${c.num ? ' class="num"' : ''}>${escapeHtml(c.label)}</th>`).join('');
  const body = rows.slice(0, 12).map(r => '<tr>' + cols.map(c => {
    const raw = r[c.key];
    const v = c.fmt ? c.fmt(raw, r) : (raw === null || raw === undefined || raw === '' ? '—' : escapeHtml(String(raw)));
    return `<td${c.num ? ' class="num"' : ''}>${v}</td>`;
  }).join('') + '</tr>').join('');
  return `<div class="enr-card"><h3>${escapeHtml(title)}${note ? ` <span class="muted small">· ${escapeHtml(note)}</span>` : ''}</h3>
    <div class="table-wrap"><table class="tbl enr-tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
}

function enrSpark(points) {
  const vals = (points || []).map(p => Number(p.up_ratio_pct)).filter(Number.isFinite);
  if (vals.length < 2) return '<div class="muted small">宽度趋势数据累积中（需 2 个以上采集周期）</div>';
  const W = 300, H = 56, pad = 4;
  const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
  const xy = vals.map((v, i) => `${pad + i * (W - 2 * pad) / (vals.length - 1)},${H - pad - (v - min) / span * (H - 2 * pad)}`);
  const last = vals[vals.length - 1];
  return `<div class="enr-spark">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="全市场上涨占比趋势">
      <polyline points="${xy.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="enr-spark-foot"><span>最低 ${min.toFixed(1)}%</span><span>最新 <b>${last.toFixed(1)}%</b></span><span>最高 ${max.toFixed(1)}%</span></div>
  </div>`;
}

async function loadEnrichDetail(force) {
  const box = $('#enrContent');
  if (state.enrichLoading) return;
  if (!force && state.enrichLoaded) return;
  state.enrichLoading = true;
  try {
    const enr = await api('/api/enrichment');
    state.enrich = enr; state.enrichLoaded = true;
    renderEnrichDetail(enr);
  } catch (e) {
    box.innerHTML = `<div class="muted">扩展数据加载失败：${escapeHtml(e.message)}</div>`;
  } finally { state.enrichLoading = false; }
}

function renderEnrichDetail(enr) {
  const meta = $('#enrMeta'), kpis = $('#enrKpis'), box = $('#enrContent');
  const s = enr.summary || {}, d = enr.depth || {}, t = enr.tables || {};
  if (!enr.available) {
    meta.textContent = '扩展行情数据累积中（下一采集周期生成）';
    kpis.innerHTML = '';
    box.innerHTML = '<div class="muted">暂无数据。live 模式会在下一采集周期自动抓取；也可点「刷新扩展数据」立即拉取。</div>';
    return;
  }
  meta.textContent = `最近采集 ${fmtTime(s.lastTs)} · 已累计 ${s.snapshotCount} 个周期 · ${s.pairs || '—'} 个交易对 · ${(s.notes || []).length} 条可选端点提示`;
  const kp = [
    { l: '上涨占比', v: fmtPct(s.upRatioPct), c: cls(s.medianChangePct), sub: `${s.advancers === null || s.advancers === undefined ? '—' : s.advancers} 涨 / ${s.decliners === null || s.decliners === undefined ? '—' : s.decliners} 跌` },
    { l: '我的持仓 24h', v: fmtPct(s.portfolio24hPct), c: cls(s.portfolio24hPct), sub: `大盘中位 ${fmtPct(s.medianChangePct)}` },
    { l: '相对大盘', v: s.relativeVerdict || '—', c: cls(s.excessVsMarketPct), sub: `超额 ${fmtPct(s.excessVsMarketPct)}` },
    { l: '冻结占比', v: fmtPct(s.lockedSharePct, 2), c: '', sub: `借款/总资产 ${fmtPct(s.borrowedToTotalPct)}` },
    { l: '平均价差', v: s.avgSpreadPct === null || s.avgSpreadPct === undefined ? '—' : fmtMoney(s.avgSpreadPct, 4) + '%', c: '', sub: `平均振幅 ${fmtPct(s.avgAmplitudePct, 2)}` },
    { l: '挂单 / 持仓', v: `${s.openOrderCount === null || s.openOrderCount === undefined ? '—' : s.openOrderCount} / ${s.positionCount === null || s.positionCount === undefined ? '—' : s.positionCount}`, c: '', sub: '未成交挂单 / 合约持仓' },
  ];
  kpis.innerHTML = kp.map(k => `<div class="enr-kpi"><div class="enr-kpi-l">${escapeHtml(k.l)}</div>
    <div class="enr-kpi-v ${k.c}">${escapeHtml(k.v)}</div><div class="enr-kpi-s">${escapeHtml(k.sub)}</div></div>`).join('');

  const cards = [];
  cards.push(`<div class="enr-card"><h3>全市场宽度趋势 <span class="muted small">· 上涨占比</span></h3>${enrSpark(d.breadthTrend)}
    <div class="enr-note muted small">中位涨跌 ${fmtPct(s.medianChangePct)} · 24h 成交额 ${s.totalQuoteVolumeUsd === null || s.totalQuoteVolumeUsd === undefined ? '—' : fmtUsd(s.totalQuoteVolumeUsd, 0)}</div></div>`);

  cards.push(enrCard('持仓 Ticker 全字段（我实际持有的币）', [
    { label: '币种', key: 'currency' },
    { label: '最新价', key: 'last', num: true, fmt: v => enrNum(v, 6) },
    { label: '24h', key: 'change24Pct', num: true, fmt: enrPct },
    { label: '振幅', key: 'amplitude24Pct', num: true, fmt: enrPct },
    { label: `成交额(${unitTag()})`, key: 'quoteVolumeUsd', num: true, fmt: v => enrNum(v, 0) },
    { label: '价差', key: 'spreadPct', num: true, fmt: v => v === null || v === undefined ? '—' : fmtMoney(v, 4) + '%' },
  ], d.liquidity, '按成交额排序'));

  cards.push(enrCard('涨幅榜 / 跌幅榜', [
    { label: '榜', key: 'kind' }, { label: '交易对', key: 'pair' },
    { label: '最新价', key: 'last', num: true, fmt: v => enrNum(v, 6) },
    { label: '24h', key: 'changePct', num: true, fmt: enrPct },
  ], [
    ...(d.topGainers || []).map(x => ({ ...x, kind: '涨幅' })),
    ...(d.topLosers || []).map(x => ({ ...x, kind: '跌幅' })),
  ]));
  cards.push(enrCard('成交额榜', [
    { label: '交易对', key: 'pair' },
    { label: `24h 成交额(${unitTag()})`, key: 'quoteVolumeUsd', num: true, fmt: v => enrNum(v, 0) },
  ], d.topByVolume));

  cards.push(enrCard('盘口深度（前 5 档）', [
    { label: '交易对', key: 'pair' },
    { label: '买一', key: 'bestBid', num: true, fmt: v => enrNum(v, 6) },
    { label: '卖一', key: 'bestAsk', num: true, fmt: v => enrNum(v, 6) },
    { label: '价差', key: 'spreadPct', num: true, fmt: v => v === null || v === undefined ? '—' : fmtMoney(v, 4) + '%' },
    { label: `买盘(${unitTag()})`, key: 'bidDepthUsd', num: true, fmt: v => enrNum(v, 0) },
    { label: `卖盘(${unitTag()})`, key: 'askDepthUsd', num: true, fmt: v => enrNum(v, 0) },
  ], d.books));

  cards.push(enrCard('合约市场（资金费 / 基差 / 持仓量）', [
    { label: '合约', key: 'contract' },
    { label: '标记价', key: 'markPrice', num: true, fmt: v => enrNum(v, 2) },
    { label: '资金费', key: 'fundingRatePct', num: true, fmt: v => v === null || v === undefined ? '—' : fmtMoney(v, 4) + '%' },
    { label: '粗略年化', key: 'fundingAnnualisedPct', num: true, fmt: v => v === null || v === undefined ? '—' : fmtMoney(v, 2) + '%' },
    { label: '未平仓', key: 'openInterest', num: true, fmt: v => enrNum(v, 0) },
    { label: '基差', key: 'basisPct', num: true, fmt: v => v === null || v === undefined ? '—' : fmtMoney(v, 4) + '%' },
  ], d.futures, '年化 = 费率×3×365，仅量级参考'));

  const fee = (t.fee_schedule || []).slice(-1)[0];
  const fa = d.feeAudit || {};
  cards.push(enrCard('名义费率与实扣对账', [
    { label: '项目', key: 'k' }, { label: '数值', key: 'v' },
  ], [
    { k: '现货 taker / maker', v: `${fee ? fmtMoney(fee.taker_fee_pct, 3) : '—'}% / ${fee ? fmtMoney(fee.maker_fee_pct, 3) : '—'}%` },
    { k: '合约 taker / maker', v: `${fee ? fmtMoney(fee.futures_taker_fee_pct, 3) : '—'}% / ${fee ? fmtMoney(fee.futures_maker_fee_pct, 3) : '—'}%` },
    { k: 'GT 抵扣', v: fee ? (fee.gt_discount ? '已开启' : '未开启') : '—' },
    { k: '借贷费率', v: fee ? fmtMoney(fee.loan_fee_pct, 3) + '%' : '—' },
    { k: '账本实扣合计', v: fa.actualFeesUsd === undefined ? '—' : fmtUsd(fa.actualFeesUsd, 2) },
    { k: '显式成本合计', v: fa.explicitCostUsd === undefined || fa.explicitCostUsd === null ? '—' : fmtUsd(fa.explicitCostUsd, 2) },
    { k: 'maker 占比', v: fa.makerRatioPct === undefined || fa.makerRatioPct === null ? '—' : fmtMoney(fa.makerRatioPct, 1) + '%' },
  ], '口径不同，不做机械相减'));

  const acct = d.account || {};
  const acctRows = [
    ...(acct.openOrders || []).map(o => ({ kind: '挂单', key: o.pair, count: o.total, extra: (o.sides || []).join('/') })),
    ...(acct.positions || []).map(p => ({ kind: '持仓', key: p.contract, count: p.size, extra: `${p.leverage || '—'}x · 强平价 ${p.liqPrice === null || p.liqPrice === undefined ? '—' : p.liqPrice}` })),
    ...(acct.margin || []).map(m => ({ kind: '杠杆', key: m.pair, count: null, extra: `风险 ${m.risk || '—'} · 借入 ${m.baseBorrowed === undefined ? 0 : m.baseBorrowed}/${m.quoteBorrowed === undefined ? 0 : m.quoteBorrowed}` })),
  ];
  cards.push(enrCard('账户状态（挂单 / 持仓 / 杠杆）', [
    { label: '类型', key: 'kind' }, { label: '交易对/合约', key: 'key' },
    { label: '数量', key: 'count', num: true }, { label: '备注', key: 'extra' },
  ], acctRows));
  cards.push(enrCard('持仓强平距离', [
    { label: '合约', key: 'contract' }, { label: '杠杆', key: 'leverage' },
    { label: '距强平', key: 'liqDistancePct', num: true, fmt: v => v === null || v === undefined ? '—' : fmtMoney(v, 2) + '%' },
    { label: '未实现盈亏', key: 'unrealisedPnl', num: true, fmt: v => v === null || v === undefined ? '—' : `<span class="${cls(v)}">${fmtSignedUsd(v)}</span>` },
  ], d.positions));

  const cap = d.capital || {};
  cards.push(enrCard('资金利用率', [
    { label: '项目', key: 'k' }, { label: '数值', key: 'v' },
  ], [
    { k: '总资产', v: cap.totalUsd === undefined ? '—' : fmtUsd(cap.totalUsd, 2) },
    { k: '借款合计', v: cap.borrowedUsd === undefined ? '—' : fmtUsd(cap.borrowedUsd, 2) },
    { k: '借款 / 总资产', v: fmtPct(cap.borrowedToTotalPct) },
    { k: '未实现盈亏', v: cap.unrealisedPnlUsd === undefined ? '—' : fmtSignedUsd(cap.unrealisedPnlUsd) },
    { k: '冻结占比（估值加权）', v: fmtPct(cap.lockedSharePct) },
    { k: '可用 / 冻结数量', v: `${fmtQty(cap.availableQty)} / ${fmtQty(cap.lockedQty)}（跨币种仅供参考）` },
  ]));
  cards.push(enrCard('充提链分布', [
    { label: '链', key: 'chain' }, { label: '笔数', key: 'count', num: true },
    { label: '充值/提现', key: 'mix', num: true },
    { label: `金额(${unitTag()})`, key: 'volume_usd', num: true, fmt: v => enrNum(v, 2) },
    { label: '最近', key: 'last_iso_utc' },
  ], (d.chains || []).map(c => ({ ...c, mix: `${c.deposits}/${c.withdraws}` })), '链名来自 Gate 账本备注解析'));

  if (s.notes && s.notes.length) {
    cards.push(`<div class="enr-card"><h3>数据采集提示</h3>
      <div class="enr-note muted small">${s.notes.map(n => escapeHtml(n)).join('<br>')}</div>
      <div class="enr-note muted small">可选端点失败仅记录于此，不影响主快照，也不会触发顶部红色告警。</div></div>`);
  }
  box.innerHTML = cards.filter(Boolean).join('');
}

async function loadSummary() { renderSummary(await api('/api/summary')); }
async function loadHistory() {
  const r = await api('/api/history?limit=' + state.range);
  state.series = r.series || [];
  renderChart();
}
async function loadAll() {
  try { await Promise.all([loadSummary(), loadHistory(), loadEnrichHeadline()]); }
  catch (e) { if (e.message !== 'UNAUTHORIZED') toast('加载失败:' + e.message); }
  if ($('#moreData') && $('#moreData').open) loadEnrichDetail(true);
}
function startPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (!state.authed || document.hidden) return;
    refreshCurrentTab().catch(() => {});
  }, 30000);
}

/* ------------------------------- events ------------------------------ */
$('#moreData').addEventListener('toggle', () => {
  if ($('#moreData').open && !state.enrichLoaded) loadEnrichDetail();
});
$('#enrRefreshBtn').addEventListener('click', async () => {
  const btn = $('#enrRefreshBtn');
  btn.disabled = true;
  try {
    if (state.mode === 'live') {
      await api('/api/enrichment/refresh', { method: 'POST' });
      toast('已拉取最新扩展行情');
    }
    await loadEnrichHeadline();
    await loadEnrichDetail(true);
  } catch (e) { toast('刷新失败:' + e.message); }
  finally { btn.disabled = false; }
});
$('#rangeTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-range]');
  if (!b) return;
  $$('#rangeTabs button').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  state.range = parseInt(b.dataset.range, 10);
  loadHistory().catch(() => {});
});
$('#refreshBtn').addEventListener('click', async () => {
  const btn = $('#refreshBtn');
  btn.disabled = true; btn.classList.add('spin');
  try {
    if (state.tab === 'overview') {
      const r = await api('/api/refresh', { method: 'POST' });
      if (r.ok) toast('已采集最新快照');
    }
    await refreshCurrentTab();
  } catch (e) { toast('刷新失败:' + e.message); }
  finally { btn.disabled = false; btn.classList.remove('spin'); }
});
window.addEventListener('resize', () => {
  if (state.tab === 'overview' && state.series.length) renderChart();
  if (state.tab === 'analytics' && state.analytics) renderNavChart(state.analytics.nav || [], state.analytics.cashflows || []);
  if (state.tab === 'market' && state.market) renderMkChart(state.market);
});


/* ======================= MARKET / BENCHMARK VIEW ======================= */
const MK_COLORS = { NAV: '#2f6df6', BTC: '#e0952a', ETH: '#8b5cf6', SOL: '#0ea5a4',
  DOGE: '#c026d3', BNB: '#d9a406', INDEX: '#9aa2b1' };
const MK_IMPACT = { bullish: '利多', bearish: '利空', neutral: '中性', unknown: '未知' };
const MK_CAT = { macro: '宏观', policy: '政策监管', onchain: '链上资金',
  listing: '上线解锁', security: '安全', volatility: '行情异动', custom: '自定义' };

async function loadMarket() {
  try {
    const qs = new URLSearchParams();
    if (state.mkPreset === 'CUSTOM') {
      if (state.mkFromDate) qs.set('fromDate', state.mkFromDate);
      if (state.mkToDate) qs.set('toDate', state.mkToDate);
    } else if (state.mkPreset && state.mkPreset !== 'ALL') qs.set('preset', state.mkPreset);
    if (state.mkSymbols && state.mkSymbols.length) qs.set('symbols', state.mkSymbols.join(','));
    const m = await api('/api/market?' + qs.toString());
    state.market = m;
    renderMarket(m);
  } catch (e) { if (e.message !== 'UNAUTHORIZED') toast('市场对比加载失败: ' + e.message); }
}

function renderMarket(m) {
  const s = m.meta || {}, c = m.conclusion;
  const notice = $('#mkNotice');
  if (s.dataNote) { notice.textContent = s.dataNote; notice.hidden = false; }
  else notice.hidden = true;

  $('#mkConclusion').textContent = c ? c.text : (s.reason || '数据不足，无法生成对比结论。');
  const v = $('#mkVerdict');
  if (c) {
    v.textContent = c.headline;
    const ex = c.excessVsMainPct;
    v.className = 'mk-verdict ' + (ex === null || ex === undefined ? '' : ex >= 0 ? 'up' : 'down');
  } else { v.textContent = '—'; v.className = 'mk-verdict'; }

  $('#mkReasons').innerHTML = (m.reasons || []).map(x =>
    `<div class="mk-reason"><span class="mk-reason-label">${escapeHtml(x.label)}</span>` +
    `<span class="mk-reason-text">${escapeHtml(x.text)}</span></div>`).join('')
    || '<div class="mk-reason"><span class="mk-reason-text muted">区间内数据不足，无法生成原因分析。</span></div>';

  const modeTag = s.windowSource === 'utc-dates' ? '自定义 UTC 日期' :
    s.windowPreset ? `快捷区间 ${s.windowPreset}` : (s.windowSource === 'epoch' ? '指定时间戳' : '全部可用快照');
  $('#mkWindowLabel').textContent = s.from
    ? `${modeTag} · ${s.from} → ${s.to} (UTC) · ${s.points} 个快照 · 基准 ` +
      Object.entries(s.benchmarkSources || {}).map(([k, x]) => `${k}(${x})`).join(', ')
    : `${modeTag} · 请求 ${s.requestedFrom || '—'} → ${s.requestedTo || '—'} (UTC) · 所选区间内快照不足`;

  renderMkPrices(m);
  renderMkChips(m);
  renderMkLegend(m);
  renderMkChart(m);
  renderMkMetrics(m);
  renderMkEvents(m);
  renderMkEventStudy(m);
  $$('#mkRangeTabs button').forEach(b => b.classList.toggle('active', b.dataset.preset === state.mkPreset));
}

function renderMkPrices(m) {
  const el = $('#mkPrices'); if (!el) return;
  const prices = (m.meta && m.meta.lastPrices) || {};
  const rows = Object.entries(prices).filter(([, v]) => v && Number.isFinite(Number(v.priceUsd)));
  if (!rows.length) {
    el.innerHTML = '<div class="muted small">暂无已收盘 K 线价格。</div>';
    return;
  }
  el.innerHTML = rows.map(([sym, v]) => `
    <div class="mk-price">
      <div class="sym">${escapeHtml(sym)}/USDT</div>
      <div class="px">${fmtUsd(v.priceUsd, v.priceUsd >= 100 ? 2 : 4)}</div>
      <div class="ts">${fmtTime(v.ts)} · ${unitTag()}</div>
    </div>`).join('');
}

function renderMkChips(m) {
  const avail = (m.meta.symbols || []).filter(x => x !== 'NAV' && x !== 'INDEX');
  if (!state.mkAllSymbols || !state.mkAllSymbols.length) state.mkAllSymbols = avail.slice();
  const all = state.mkAllSymbols.length ? state.mkAllSymbols : avail;
  if (!state.mkSymbols || !state.mkSymbols.length) state.mkSymbols = all.slice();
  const active = state.mkSymbols.filter(x => all.includes(x));
  state.mkSymbols = active.length ? active : all.slice(0, 1);
  $('#mkSymbolChips').innerHTML = all.map(x =>
    `<button class="mk-chip ${state.mkSymbols.includes(x) ? 'on' : ''}" data-sym="${escapeHtml(x)}">${escapeHtml(x)}</button>`).join('');
}

function renderMkLegend(m) {
  const series = (m.meta.symbols || []);
  $('#mkLegend').innerHTML = series.map(s =>
    `<span class="lg"><i class="lg-sw" style="background:${MK_COLORS[s] || '#64748b'}"></i>${s === 'NAV' ? '我的资产' : s === 'INDEX' ? '加权指数' : s}</span>`).join('')
    + `<span class="lg"><i class="lg-sw lg-ev"></i>事件</span>`;
}

function renderMkChart(m) {
  const svg = $('#mkChart'), rows = m.normalized || [];
  if (rows.length < 2) {
    svg.innerHTML = '<text x="320" y="130" text-anchor="middle" fill="#9aa2b1" font-size="13">所选区间数据不足</text>';
    $('#mkFootLeft').textContent = ''; $('#mkFootMid').textContent = ''; $('#mkFootRight').textContent = '';
    return;
  }
  const series = (m.meta.symbols || []).filter(s => rows[0][s] !== undefined && rows[0][s] !== null);
  const W = 640, H = 260, padL = 46, padR = 14, padT = 16, padB = 26;
  let lo = Infinity, hi = -Infinity;
  for (const row of rows) for (const s of series) {
    const v = Number(row[s]);
    if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  if (!Number.isFinite(lo)) { svg.innerHTML = ''; return; }
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad; hi += pad;
  const t0 = rows[0].ts, t1 = rows[rows.length - 1].ts, span = (t1 - t0) || 1;
  const x = (t) => padL + (t - t0) / span * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const out = [];

  for (let i = 0; i <= 4; i++) {
    const val = lo + (hi - lo) * i / 4, yy = y(val);
    out.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="#eef0f4" stroke-width="1"/>`);
    out.push(`<text x="${padL - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#9aa2b1">${val.toFixed(1)}</text>`);
  }
  if (100 >= lo && 100 <= hi) {
    out.push(`<line x1="${padL}" y1="${y(100).toFixed(1)}" x2="${W - padR}" y2="${y(100).toFixed(1)}" stroke="#c9cfd9" stroke-width="1" stroke-dasharray="4 3"/>`);
  }
  (m.events || []).forEach((e, i) => {
    const xx = x(Number(e.ts));
    if (xx < padL || xx > W - padR) return;
    out.push(`<line x1="${xx.toFixed(1)}" y1="${padT}" x2="${xx.toFixed(1)}" y2="${H - padB}" stroke="#e0952a" stroke-width="1" stroke-dasharray="3 3" opacity=".65"/>`);
    out.push(`<circle cx="${xx.toFixed(1)}" cy="${padT + 3}" r="7" fill="#e0952a"/>`);
    out.push(`<text x="${xx.toFixed(1)}" y="${padT + 6}" text-anchor="middle" font-size="8" fill="#fff">${i + 1}</text>`);
  });
  for (const s of series) {
    const pts = rows.map(r => [x(r.ts), y(Number(r[s]))]).filter(p => Number.isFinite(p[1]));
    if (!pts.length) continue;
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const isNav = s === 'NAV', isIdx = s === 'INDEX';
    out.push(`<path d="${d}" fill="none" stroke="${MK_COLORS[s] || '#64748b'}" stroke-width="${isNav ? 2.6 : 1.7}" ` +
      `${isIdx ? 'stroke-dasharray="5 4" ' : ''}stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  svg.innerHTML = out.join('');

  svg.onmousemove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = (ev.clientX - rect.left) / rect.width * W;
    let bi = 0, bd = Infinity;
    rows.forEach((r, i) => { const d = Math.abs(x(r.ts) - px); if (d < bd) { bd = d; bi = i; } });
    const r = rows[bi], tip = $('#mkTip');
    tip.innerHTML = `<b>${fmtTime(r.ts)}</b><br>` + series.map(s =>
      `${s === 'NAV' ? '资产' : s} <b>${Number(r[s]).toFixed(2)}</b>`).join(' · ');
    tip.hidden = false;
    tip.style.left = Math.max(60, Math.min(rect.width - 60, x(r.ts) / W * rect.width)) + 'px';
    tip.style.top = '24px';
  };
  svg.onmouseleave = () => { $('#mkTip').hidden = true; };

  $('#mkFootLeft').textContent = `${series.length} 条序列 · ${rows.length} 个点`;
  $('#mkFootMid').textContent = `${(m.events || []).length} 个事件（橙色竖线）`;
  $('#mkFootRight').textContent = `${fmtShortDate(t0)} → ${fmtShortDate(t1)}`;
}

function mkKv(label, val, klass) {
  return `<div class="mk-kv"><span>${escapeHtml(label)}</span><b class="${klass || ''}">${escapeHtml(val)}</b></div>`;
}
function fmtPp(v, d = 2) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return (Number(v) > 0 ? '+' : '') + Number(v).toFixed(d) + 'pp';
}
function renderMkMetrics(m) {
  const rows = m.relativeRows || [];
  $('#mkMetrics').innerHTML = rows.length ? rows.map(x => `
    <div class="mk-metric-card">
      <div class="mk-metric-head"><b>${escapeHtml(x.series)}</b>
        <span class="muted small">${x.series_kind === 'index' ? '加权指数' : '基准'} · ${x.sample_periods} 个有效周期</span></div>
      <div class="mk-metric-grid">
        ${mkKv('基准涨跌', fmtPct(x.series_pct), pctClass(x.series_pct))}
        ${mkKv('资产 TWR', fmtPct(x.nav_pct), pctClass(x.nav_pct))}
        ${mkKv('超额', fmtPp(x.excess_pct), pctClass(x.excess_pct))}
        ${mkKv('β', x.beta === null ? '—' : Number(x.beta).toFixed(3), '')}
        ${mkKv('相关系数', x.correlation === null ? '—' : Number(x.correlation).toFixed(3), '')}
        ${mkKv('β 调整超额', fmtPp(x.beta_adjusted_excess_pct), pctClass(x.beta_adjusted_excess_pct))}
        ${mkKv('上行捕获', x.up_capture === null ? '—' : (x.up_capture * 100).toFixed(0) + '%', '')}
        ${mkKv('下行捕获', x.down_capture === null ? '—' : (x.down_capture * 100).toFixed(0) + '%', '')}
        ${mkKv('跟踪误差', x.tracking_error_pct === null ? '—' : Number(x.tracking_error_pct).toFixed(3) + '%', '')}
      </div>
    </div>`).join('') : '<div class="dec-empty">没有可用基准数据</div>';
}

function renderMkEvents(m) {
  const evs = m.events || [];
  $('#mkEventStat').textContent = evs.length
    ? `${evs.length} 个事件 · 窗口前后各 ${m.meta.eventWindowBars || '—'} 个快照` : '';
  $('#mkEventList').innerHTML = evs.length ? evs.map((e, i) => `
    <div class="mk-event-card">
      <div class="mk-event-top">
        <span class="mk-ev-num">${i + 1}</span>
        <span class="mk-ev-cat">${escapeHtml(MK_CAT[e.category] || e.category || '事件')}</span>
        <span class="mk-ev-impact ${e.impact === 'bullish' ? 'up' : e.impact === 'bearish' ? 'down' : ''}">${escapeHtml(MK_IMPACT[e.impact] || e.impact || '')}</span>
        <span class="mk-ev-time">${fmtTime(Number(e.ts))}</span>
        <span class="mk-ev-src">${escapeHtml(e.source || '')}</span>
      </div>
      <div class="mk-ev-title">${escapeHtml(e.title || '')}</div>
      <div class="mk-ev-summary muted small">${escapeHtml(e.summary || '')}</div>
      <div class="mk-ev-reactions">${(e.reactions || []).map(r =>
        `<span class="mk-ev-react"><i>${escapeHtml(r.series === 'NAV' ? '我的资产' : r.series)}</i>` +
        `<b class="${pctClass(r.windowPct)}">${fmtPct(r.windowPct)}</b></span>`).join('')}</div>
      <div class="mk-ev-reasons">${(e.reasons || []).map(t => `<div>· ${escapeHtml(t)}</div>`).join('')}</div>
    </div>`).join('')
    : '<div class="dec-empty">所选区间内没有事件。可在下方标注，或在 live 模式下由行情异动自动检测。</div>';
}

function renderMkEventStudy(m) {
  const st = m.eventStudy || [];
  $('#mkEventStudy').innerHTML = st.length ? st.map(x => `
    <div class="kv"><span>${escapeHtml(MK_CAT[x.category] || x.category)} · ${x.events} 次</span>
      <b>BTC ${fmtPct(x.avgBtcPct)} / 资产 ${fmtPct(x.avgNavPct)} / 超额 ${fmtPct(x.avgExcessPct)}</b></div>`).join('')
    : '<div class="muted small">暂无事件统计</div>';
}

$('#mkRangeTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-preset]');
  if (!b) return;
  state.mkPreset = b.dataset.preset;
  loadMarket();
});
$('#mkCustomForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const from = $('#mkFromDate').value, to = $('#mkToDate').value;
  if (!from && !to) { toast('请至少填写一个日期'); return; }
  if (from && to && from > to) { toast('起始日期不能晚于结束日期'); return; }
  state.mkPreset = 'CUSTOM';
  state.mkFromDate = from; state.mkToDate = to;
  loadMarket();
});
$('#mkCustomClear').addEventListener('click', () => {
  $('#mkFromDate').value = ''; $('#mkToDate').value = '';
  state.mkFromDate = ''; state.mkToDate = '';
  state.mkPreset = '24H';
  loadMarket();
});
$('#mkSymbolChips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-sym]');
  if (!b) return;
  const sym = b.dataset.sym;
  let sel = (state.mkSymbols || []).slice();
  if (sel.includes(sym)) {
    if (sel.length === 1) { toast('至少保留一个对比基准'); return; }
    sel = sel.filter(x => x !== sym);
  } else sel.push(sym);
  state.mkSymbols = sel;
  loadMarket();
});
$('#mkRefreshBtn').addEventListener('click', async () => {
  const btn = $('#mkRefreshBtn');
  btn.disabled = true;
  try {
    const r = await api('/api/market/refresh', { method: 'POST' });
    toast(`已拉取 ${r.candles} 根 K 线 / 新增 ${r.events} 个事件`);
    await loadMarket();
  } catch (e) {
    toast(e.message.includes('ONLY_LIVE')
      ? 'DEMO 模式使用模拟行情；切换到 live 后可拉取 Gate 真实公开 K 线'
      : '拉取失败: ' + e.message);
  } finally { btn.disabled = false; }
});
$('#mkEventForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    title: (fd.get('title') || '').trim(),
    category: fd.get('category'), impact: fd.get('impact'),
    symbols: fd.get('symbols'), summary: fd.get('summary'), url: fd.get('url'),
  };
  const tv = fd.get('ts');
  if (tv) body.ts = new Date(tv).getTime();
  if (!body.title) { toast('请填写事件标题'); return; }
  try {
    await api('/api/macro-events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    e.target.reset();
    toast('事件已记录，正在重算对比…');
    await loadMarket();
  } catch (err) { toast('保存失败: ' + err.message); }
});

/* -------------------------------- boot ------------------------------- */
(async function init() {
  try {
    const st = await fetch('/api/auth/status', { credentials: 'same-origin' }).then(r => r.json());
    state.authEnabled = st.enabled;
    if (!st.enabled || st.authed) {
      showApp();
      await loadFx();
      setInterval(() => { loadFx(); }, 6 * 3600 * 1000);
      // Deep link: ?tab=overview|analytics|market|operations|report|export
      // Old ?tab=decisions is aliased to operations inside switchTab().
      const qp = new URLSearchParams(location.search).get('tab');
      const valid = VIEWS.concat(Object.keys(TAB_ALIAS));
      if (qp && valid.includes(qp)) switchTab(qp);   // switchTab() loads that view
      else await refreshCurrentTab();
      startPolling();
    } else showLogin();
  } catch (_) { showLogin(); }
})();
