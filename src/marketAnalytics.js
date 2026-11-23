'use strict';

/**
 * Market-context analytics — PURE FUNCTIONS, zero dependencies.
 *
 * Answers: "over a chosen window, how did MY portfolio move vs BTC / ETH /
 * a weighted market index, which macro events happened, and WHY did I
 * outperform or underperform?"
 *
 * Rigour notes (see docs/METRICS.md):
 *  - AS-OF JOIN, never look-ahead: at snapshot time t a benchmark can only
 *    use its most recent CLOSED bar with ts <= t.
 *  - The comparison axis is the portfolio's own snapshot timestamps. When
 *    benchmark bars are coarser than snapshots (e.g. 1h candles vs 5min
 *    snapshots), the benchmark is a step function. Relative metrics are
 *    therefore computed on "benchmark-change intervals" only (from one new
 *    bar to the next), so flat plateaus never dilute beta/correlation.
 *  - Portfolio return is TWR (unit NAV), i.e. external cashflows are stripped.
 *  - Excess is a simple arithmetic difference in percentage points, NOT a
 *    geometric/linked excess return. This is stated explicitly in the output.
 *  - All timestamps are UTC. Ratios are fractions; *_pct are 0-100.
 */
const STABLES = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD', 'USD', 'USDP']);

function r(v, d = 4) {
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(x * Math.pow(10, d)) / Math.pow(10, d) : null;
}
function iso(ts) { return Number.isFinite(Number(ts)) ? new Date(Number(ts)).toISOString() : ''; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function variance(a) { if (a.length < 2) return 0; const m = mean(a); return a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1); }
function stdev(a) { return Math.sqrt(variance(a)); }
function covariance(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (n - 1);
}
function pct(first, last) { return (first > 0 && last > 0) ? (last / first - 1) * 100 : null; }

/**
 * AS-OF align one symbol's price series to the axis.
 * Returns { values:number[], firstTs, source } or null when no data exists.
 */
function asOf(symbol, axis, marketPts, pricePts) {
  const pts = (marketPts || []).filter(p => p.symbol === symbol && p.close > 0)
    .map(p => ({ ts: p.ts, v: p.close })).sort((a, b) => a.ts - b.ts);
  let source = 'market';
  if (!pts.length) {
    source = 'prices';
    for (const p of (pricePts || [])) {
      if (String(p.currency).toUpperCase() === symbol && Number(p.priceUsd) > 0) {
        pts.push({ ts: Number(p.ts), v: Number(p.priceUsd) });
      }
    }
    pts.sort((a, b) => a.ts - b.ts);
  }
  if (!pts.length) return null;

  // De-duplicate identical timestamps (keep the last value).
  const clean = [];
  for (const p of pts) {
    if (clean.length && clean[clean.length - 1].ts === p.ts) clean[clean.length - 1].v = p.v;
    else clean.push({ ts: p.ts, v: p.v });
  }

  const values = [];
  let j = -1;
  for (const a of axis) {
    while (j + 1 < clean.length && clean[j + 1].ts <= a.ts) j++;
    // j === -1 means the first bar is still in the future for this point:
    // use the earliest available price (documented as an aligned start), but
    // callers trim the axis to commonStart so this rarely happens.
    values.push(j >= 0 ? clean[j].v : clean[0].v);
  }
  return { values, firstTs: clean[0].ts, lastTs: clean[clean.length - 1].ts, source, points: clean.length };
}

/** Paired returns on benchmark-change intervals (skips flat plateaus). */
function pairedReturns(nav, bench) {
  const rn = [], rb = [];
  let last = 0;
  for (let i = 1; i < nav.length; i++) {
    if (!(bench[last] > 0) || !(bench[i] > 0)) continue;
    if (Math.abs(bench[i] - bench[last]) < 1e-12) continue;
    const pB = bench[i] / bench[last] - 1;
    const pN = (nav[last] > 0 && nav[i] > 0) ? nav[i] / nav[last] - 1 : null;
    if (pN === null || !Number.isFinite(pB)) continue;
    rb.push(pB); rn.push(pN);
    last = i;
  }
  return { rn, rb };
}

function relativeMetrics(nav, bench, navPct, benchPct) {
  const { rn, rb } = pairedReturns(nav, bench);
  const varB = variance(rb);
  const beta = varB > 0 ? covariance(rn, rb) / varB : null;
  const sdN = stdev(rn), sdB = stdev(rb);
  const corr = (sdN > 0 && sdB > 0) ? covariance(rn, rb) / (sdN * sdB) : null;
  const diff = rn.map((x, i) => x - rb[i]);
  const upIdx = rb.map((x, i) => x > 0 ? i : -1).filter(i => i >= 0);
  const dnIdx = rb.map((x, i) => x < 0 ? i : -1).filter(i => i >= 0);
  const upCapture = upIdx.length && mean(upIdx.map(i => rb[i])) !== 0
    ? mean(upIdx.map(i => rn[i])) / mean(upIdx.map(i => rb[i])) : null;
  const downCapture = dnIdx.length && mean(dnIdx.map(i => rb[i])) !== 0
    ? mean(dnIdx.map(i => rn[i])) / mean(dnIdx.map(i => rb[i])) : null;
  const excess = (navPct !== null && benchPct !== null) ? navPct - benchPct : null;
  return {
    excessPct: r(excess),
    betaAdjustedExcessPct: (excess !== null && beta !== null) ? r(excess - (beta - 1) * (benchPct || 0)) : null,
    beta: r(beta), correlation: r(corr), rSquared: corr !== null ? r(corr * corr) : null,
    trackingErrorPct: r(stdev(diff) * 100),
    upCapture: r(upCapture), downCapture: r(downCapture),
    samplePeriods: rb.length,
    outperformed: excess !== null ? excess > 0 : null,
  };
}

/** Weighted synthetic index over the normalised benchmark series. */
function buildIndex(normBySymbol, symbols, weights) {
  const usable = symbols.filter(s => normBySymbol[s]);
  if (usable.length < 2) return null;
  let wsum = 0;
  for (const s of usable) wsum += (Number(weights[s]) || 0);
  if (!(wsum > 0)) {
    wsum = usable.length;
    for (const s of usable) weights[s] = 1;
  }
  const len = normBySymbol[usable[0]].length;
  const out = new Array(len).fill(0);
  for (const s of usable) {
    const w = (Number(weights[s]) || 0) / wsum;
    for (let i = 0; i < len; i++) out[i] += w * normBySymbol[s][i];
  }
  return out;
}

/** Average stablecoin weight across the snapshots in the window. */
function stableWeight(snaps) {
  if (!snaps.length) return null;
  let sum = 0, n = 0;
  for (const s of snaps) {
    const hs = s.holdings || [];
    const tot = hs.reduce((a, h) => a + (Number(h.valueUsd) || 0), 0);
    if (!(tot > 0)) continue;
    const st = hs.reduce((a, h) => a + (STABLES.has(String(h.currency).toUpperCase()) ? (Number(h.valueUsd) || 0) : 0), 0);
    sum += st / tot * 100; n++;
  }
  return n ? r(sum / n, 2) : null;
}

/** Dominant non-stable holding at (or just before) eventTs. */
function dominantHolding(snaps, eventTs) {
  let best = null;
  for (const s of snaps) {
    if (Number(s.ts) > eventTs) break;
    best = s;
  }
  if (!best) best = snaps[0];
  const hs = (best && best.holdings || []).filter(h => !STABLES.has(String(h.currency).toUpperCase()));
  const tot = (best && best.holdings || []).reduce((a, h) => a + (Number(h.valueUsd) || 0), 0) || 1;
  let top = null;
  for (const h of hs) if (!top || Number(h.valueUsd) > Number(top.valueUsd)) top = h;
  return top ? { currency: top.currency, weightPct: r((Number(top.valueUsd) || 0) / tot * 100, 2), snapTs: best.ts } : null;
}

/** Per-currency value change between two snapshots (window-local attribution). */
function holdingDeltas(snaps, fromTs, toTs) {
  const at = (ts) => {
    let best = null;
    for (const s of snaps) { if (Number(s.ts) > ts) break; best = s; }
    return best || snaps[0];
  };
  const a = at(fromTs), b = at(toTs);
  if (!a || !b) return { drag: null, lift: null };
  const map = new Map();
  for (const h of (a.holdings || [])) map.set(String(h.currency).toUpperCase(), { v0: Number(h.valueUsd) || 0, v1: 0 });
  for (const h of (b.holdings || [])) {
    const k = String(h.currency).toUpperCase();
    if (!map.has(k)) map.set(k, { v0: 0, v1: 0 });
    map.get(k).v1 = Number(h.valueUsd) || 0;
  }
  const rows = Array.from(map, ([currency, x]) => ({ currency, delta: r(x.v1 - x.v0, 2) }))
    .filter(x => x.delta !== null && x.delta !== 0);
  rows.sort((x, y) => x.delta - y.delta);
  return { drag: rows[0] || null, lift: rows.length ? rows[rows.length - 1] : null };
}

/* ------------------------------------------------------------------------ */

/**
 * @param {object} input    { snapshots, events, prices, decisions, market, macroEvents, ... }
 * @param {object} analysis result of analytics.compute()
 * @param {object} opts     { fromMs, toMs, symbols, mode, intervalSec,
 *                            eventWindowBars, indexWeights }
 */
function compute(input, analysis, opts = {}) {
  const o = Object.assign({
    fromMs: undefined, toMs: undefined, symbols: ['BTC', 'ETH'], mode: 'mock',
    intervalSec: 300, eventWindowBars: 8,
    indexWeights: { BTC: 0.6, ETH: 0.4 },
  }, opts);
  const mode = o.mode || 'mock';
  const navAll = (analysis && analysis.nav) || [];
  const snapsAll = input.snapshots || [];
  const events = input.events || [];
  const prices = input.prices || [];
  const marketPts = input.market || [];
  const decisions = input.decisions || [];
  const macroEvents = (input.macroEvents || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const empty = (reason) => ({
    meta: { mode, reason, from: null, to: null, points: 0, symbols: [], conventions: CONVENTIONS },
    points: [], normalized: [], comparisonRows: [], relativeRows: [],
    metrics: { summary: {} }, events: [], eventRows: [], eventStudy: [],
    reasons: [], conclusion: null,
  });
  if (navAll.length < 2) return empty('需要至少 2 个快照才能做走势对比');

  // ---- 1) window filter on the portfolio's own snapshot axis ----
  const fromMs = Number.isFinite(Number(o.fromMs)) && Number(o.fromMs) > 0 ? Number(o.fromMs) : -Infinity;
  const toMs = Number.isFinite(Number(o.toMs)) && Number(o.toMs) > 0 ? Number(o.toMs) : Infinity;
  let axis = navAll.filter(v => Number(v.ts) >= fromMs && Number(v.ts) <= toMs);
  if (axis.length < 2) return empty('所选区间内快照不足 2 个');

  // ---- 2) benchmark series, as-of aligned ----
  const reqSymbols = (o.symbols && o.symbols.length ? o.symbols : ['BTC', 'ETH']).map(s => String(s).toUpperCase());
  const raw = {}, sources = {};
  for (const sym of reqSymbols) {
    const a = asOf(sym, axis, marketPts, prices);
    if (a) { raw[sym] = a.values; sources[sym] = a.source + ':' + a.points; }
  }
  const symbols = Object.keys(raw);
  if (!symbols.length) return empty('没有可用的基准行情（market / prices 均为空）');

  // Trim the axis so every benchmark has a real (not forward-filled) start.
  const firstReal = Math.max(...symbols.map(s => {
    const p = (marketPts || []).filter(x => x.symbol === s && x.close > 0).map(x => Number(x.ts));
    if (p.length) return Math.min(...p);
    const q = (prices || []).filter(x => String(x.currency).toUpperCase() === s && Number(x.priceUsd) > 0).map(x => Number(x.ts));
    return q.length ? Math.min(...q) : -Infinity;
  }));
  if (Number.isFinite(firstReal) && firstReal > axis[0].ts) {
    const trimmed = axis.filter(v => Number(v.ts) >= firstReal);
    if (trimmed.length >= 2) {
      const cut = axis.length - trimmed.length;
      axis = trimmed;
      for (const s of symbols) raw[s] = raw[s].slice(cut);
    }
  }

  const nav = axis.map(v => Number(v.navPerUnit) || 0);
  const tsList = axis.map(v => Number(v.ts));
  const winFrom = tsList[0], winTo = tsList[tsList.length - 1];
  const navPct = r(pct(nav[0], nav[nav.length - 1]), 4);

  // ---- 3) normalise everything to 100 at the window start ----
  const norm = { NAV: nav.map(v => (nav[0] > 0 ? v / nav[0] * 100 : null)) };
  const values = { NAV: nav };
  const units = { NAV: 'index' };
  const kinds = { NAV: 'portfolio' };
  const seriesPct = {};
  for (const s of symbols) {
    const v = raw[s];
    norm[s] = v.map(x => (v[0] > 0 ? x / v[0] * 100 : null));
    values[s] = v; units[s] = 'USD/token'; kinds[s] = 'benchmark';
    seriesPct[s] = r(pct(v[0], v[v.length - 1]), 4);
  }
  const idx = buildIndex(norm, symbols, Object.assign({}, o.indexWeights));
  const allSeries = ['NAV', ...symbols];
  if (idx) {
    norm.INDEX = idx;
    values.INDEX = idx;                 // index has no raw price; value IS the point level
    units.INDEX = 'index'; kinds.INDEX = 'index';
    seriesPct.INDEX = r(pct(idx[0], idx[idx.length - 1]), 4);
    allSeries.push('INDEX');
  }

  // ---- 4) comparison long table + chart points ----
  const points = [], normalized = [], comparisonRows = [];
  for (let i = 0; i < axis.length; i++) {
    const p = { ts: tsList[i] }, nrow = { ts: tsList[i] };
    for (const s of allSeries) { p[s] = values[s][i]; nrow[s] = norm[s][i]; }
    points.push(p); normalized.push(nrow);
    for (const s of allSeries) {
      comparisonRows.push({
        ts_ms: tsList[i], ts_iso_utc: iso(tsList[i]), series: s,
        series_kind: kinds[s], value: r(values[s][i], 8),
        normalized_value: r(norm[s][i], 6), unit: units[s],
      });
    }
  }

  // ---- 5) relative metrics vs every benchmark ----
  const bySeries = {}, relativeRows = [];
  const main = symbols.includes('BTC') ? 'BTC' : symbols[0];
  for (const s of [...symbols, ...(idx ? ['INDEX'] : [])]) {
    const m = relativeMetrics(nav, values[s], navPct, seriesPct[s]);
    bySeries[s] = m;
    relativeRows.push({
      series: s, series_kind: kinds[s],
      from_ts_ms: winFrom, to_ts_ms: winTo,
      nav_pct: navPct, series_pct: seriesPct[s],
      excess_pct: m.excessPct, beta_adjusted_excess_pct: m.betaAdjustedExcessPct,
      beta: m.beta, correlation: m.correlation, r_squared: m.rSquared,
      tracking_error_pct: m.trackingErrorPct,
      up_capture: m.upCapture, down_capture: m.downCapture,
      sample_periods: m.samplePeriods, outperformed: m.outperformed,
    });
  }

  // ---- 6) event windows --------------------------------------------------
  const w = Math.max(2, Number(o.eventWindowBars) || 8);
  const snapsWin = snapsAll.filter(s => Number(s.ts) >= winFrom && Number(s.ts) <= winTo);
  const eventsWin = macroEvents.filter(e => Number(e.ts) >= winFrom && Number(e.ts) <= winTo);
  const eventOut = [], eventRows = [];
  for (const ev of eventsWin) {
    const eTs = Number(ev.ts);
    let idxAt = 0;
    for (let i = 0; i < tsList.length; i++) if (tsList[i] <= eTs) idxAt = i;
    const pre = Math.max(0, idxAt - w), post = Math.min(tsList.length - 1, idxAt + w);
    const preTs = tsList[pre], postTs = tsList[post];
    const navWinPct = r(pct(nav[pre], nav[post]), 4);
    const inWin = (arr) => arr.filter(x => Number(x.ts) >= preTs && Number(x.ts) <= postTs);
    const cf = inWin(events).filter(e => e.isCashflow).reduce((a, e) => a + (Number(e.cashflowUsd) || 0), 0);
    const trades = inWin(events).filter(e => e.type === 'trade').length;
    const fees = inWin(events).reduce((a, e) => a + (Number(e.feeUsd) || 0), 0);
    const decs = inWin(decisions.map(d => ({ ts: d.decidedAt || d.ts }))).length;
    const dom = dominantHolding(snapsWin.length ? snapsWin : snapsAll, eTs);
    const hd = holdingDeltas(snapsAll, preTs, postTs);

    const reactions = [];
    for (const s of allSeries) {
      const sp = r(pct(values[s][pre], values[s][post]), 4);
      const excess = (navWinPct !== null && sp !== null) ? r(navWinPct - sp, 4) : null;
      reactions.push({ series: s, windowPct: sp, excessVsNavPct: excess });
      eventRows.push({
        event_id: ev.eventId || ev.id || '', event_ts_ms: eTs, event_iso_utc: iso(eTs),
        category: ev.category || 'custom', title: ev.title || '',
        impact: ev.impact || 'unknown', source: ev.source || 'manual',
        symbols: Array.isArray(ev.symbols) ? ev.symbols.join('|') : (ev.symbols || ''),
        window_from_ms: preTs, window_to_ms: postTs,
        series: s, series_kind: kinds[s],
        window_pct: sp, excess_vs_nav_pct: excess,
        cashflow_usd: r(cf, 2), trade_legs: trades, fee_usd: r(fees, 2), decisions: decs,
        dominant_holding: dom ? dom.currency : '', dominant_weight_pct: dom ? dom.weightPct : null,
        top_drag_currency: hd.drag ? hd.drag.currency : '', top_drag_usd: hd.drag ? hd.drag.delta : null,
        top_lift_currency: hd.lift ? hd.lift.currency : '', top_lift_usd: hd.lift ? hd.lift.delta : null,
        reason: '',
      });
    }

    const btc = reactions.find(x => x.series === main);
    const evReasons = [];
    if (btc && btc.windowPct !== null && navWinPct !== null) {
      const gap = r(navWinPct - btc.windowPct, 2);
      evReasons.push(`${main} 在该事件窗口 ${btc.windowPct >= 0 ? '+' : ''}${btc.windowPct}%，我的资产 ${navWinPct >= 0 ? '+' : ''}${navWinPct}%，相对 ${gap >= 0 ? '+' : ''}${gap}pp。`);
    }
    if (cf) evReasons.push(`窗口内净外部现金流 ${cf > 0 ? '+' : ''}$${r(cf, 0)}（TWR 已剥离，不改变收益率，但改变绝对金额）。`);
    if (dom) evReasons.push(`事件时点最大非稳定币持仓为 ${dom.currency}（占 ${dom.weightPct}%），决定了组合对该轮行情的弹性。`);
    if (hd.drag && hd.drag.delta < 0) evReasons.push(`窗口内市值缩水最多的是 ${hd.drag.currency}（$${hd.drag.delta}）。`);
    if (hd.lift && hd.lift.delta > 0) evReasons.push(`窗口内市值增长最多的是 ${hd.lift.currency}（+$${hd.lift.delta}）。`);
    if (decs) evReasons.push(`该窗口内有 ${decs} 条决策记录，可结合决策日志复盘。`);
    // backfill reason onto this event's rows
    const joined = evReasons.join(' ');
    for (let k = eventRows.length - allSeries.length; k < eventRows.length; k++) eventRows[k].reason = joined;

    eventOut.push(Object.assign({}, ev, {
      window: { fromMs: preTs, toMs: postTs, fromIso: iso(preTs), toIso: iso(postTs), bars: post - pre + 1 },
      navWindowPct: navWinPct,
      btcWindowPct: btc ? btc.windowPct : null,
      excessPct: btc ? r(navWinPct - (btc.windowPct || 0), 4) : null,
      cashflowUsd: r(cf, 2), tradeLegs: trades, feeUsd: r(fees, 2), decisionCount: decs,
      dominant: dom, drag: hd.drag, lift: hd.lift,
      reactions, reasons: evReasons,
    }));
  }

  // ---- 7) event study by category ---------------------------------------
  const catMap = new Map();
  for (const e of eventOut) {
    const k = e.category || 'custom';
    if (!catMap.has(k)) catMap.set(k, []);
    catMap.get(k).push(e);
  }
  const eventStudy = Array.from(catMap, ([category, list]) => {
    const b = list.map(x => x.btcWindowPct).filter(x => x !== null);
    const n = list.map(x => x.navWindowPct).filter(x => x !== null);
    const ex = list.map(x => x.excessPct).filter(x => x !== null);
    return {
      category, events: list.length,
      avgBtcPct: r(mean(b), 3), avgNavPct: r(mean(n), 3), avgExcessPct: r(mean(ex), 3),
      avgAbsBtcPct: r(mean(b.map(Math.abs)), 3),
      maxAbsBtcPct: b.length ? r(Math.max(...b.map(Math.abs)), 3) : null,
    };
  }).sort((a, b) => b.events - a.events);

  // ---- 8) structured "WHY" reasons --------------------------------------
  const reasons = [];
  const pushReason = (type, label, text, valuePp = null) => reasons.push({ type, label, text, valuePp });
  const sw = stableWeight(snapsWin.length ? snapsWin : snapsAll);
  const mainPct = seriesPct[main];
  const mM = bySeries[main] || {};
  const excess = mM.excessPct;

  if (excess !== null && excess !== undefined) {
    pushReason('verdict', '相对表现',
      `区间内资产 TWR ${navPct >= 0 ? '+' : ''}${navPct}%，${main} ${mainPct >= 0 ? '+' : ''}${mainPct}%，` +
      `${excess >= 0 ? '跑赢' : '跑输'} ${Math.abs(excess).toFixed(2)} 个百分点（算术差，非几何超额）。`, r(excess));
  }
  if (mM.beta !== null && mM.beta !== undefined) {
    const b = mM.beta;
    pushReason('beta', '市场敏感度 β',
      `对 ${main} 的实测 β=${b}（${mM.correlation !== null ? `相关系数 ${mM.correlation}` : '样本不足'}，R²=${mM.rSquared ?? '—'}）：` +
      `${main} 每变动 1%，组合平均约变动 ${b}%。` +
      (b < 0.9 && mainPct > 0 ? '上涨行情中 β<1 会结构性跑输。' : b > 1.1 && mainPct < 0 ? '下跌行情中 β>1 会放大回撤。' : ''), r(b));
  }
  if (mM.upCapture !== null && mM.downCapture !== null) {
    const gap = mM.upCapture - mM.downCapture;
    pushReason('capture', '上/下行捕获',
      `上行捕获 ${(mM.upCapture * 100).toFixed(0)}%、下行捕获 ${(mM.downCapture * 100).toFixed(0)}%：` +
      (Math.abs(gap) < 0.05 ? '两者基本对称，组合对基准是近似等比例的跟随。'
        : gap < 0 ? '涨时跟不满、跌时跟得较满，偏防御结构。' : '涨时弹性足于跌时，偏进攻结构。'));
  }
  if (mM.betaAdjustedExcessPct !== null && mM.betaAdjustedExcessPct !== undefined && mM.beta !== null) {
    pushReason('alpha', 'β 调整后的主动超额',
      `把「市场敏感度」剥离后，主动超额约 ${mM.betaAdjustedExcessPct >= 0 ? '+' : ''}${mM.betaAdjustedExcessPct}pp：` +
      `即原始 ${excess >= 0 ? '+' : ''}${excess}pp 的相对表现中，绝大部分由 β=${mM.beta} 的仓位结构解释，` +
      (Math.abs(mM.betaAdjustedExcessPct) < 0.5 ? '真正的选币/择时贡献很小。' : '仍有较明显的选币或择时贡献。') +
      ` 计算：超额 − (β−1) × 基准涨幅。`, r(mM.betaAdjustedExcessPct));
  }
  if (sw !== null) {
    pushReason('exposure', '现金类资产占比',
      `区间内稳定币/现金类资产平均占比 ${sw}%。` +
      (sw > 20 && mainPct > 0 ? '上涨行情里这部分不产生弹性，是相对基准落后的主要结构性来源。'
        : sw > 20 && mainPct < 0 ? '下跌行情里这部分起到了缓冲作用。' : '对相对表现影响有限。'), sw);
  }
  const agg = (analysis && analysis.attributionAgg) || [];
  const risky = agg.filter(x => x.currency !== '__RESIDUAL__' && !STABLES.has(String(x.currency).toUpperCase())
    && Number.isFinite(Number(x.deltaValueUsd)));
  // Stablecoin value changes are mostly cashflows, not investment results —
  // exclude them from "best/west contributor" so the statement stays honest.
  const ranked = (risky.length ? risky : agg.filter(x => x.currency !== '__RESIDUAL__'))
    .sort((a, b) => Number(a.deltaValueUsd) - Number(b.deltaValueUsd));
  if (ranked.length) {
    const worst = ranked[0], best = ranked[ranked.length - 1];
    pushReason('attribution', '风险币拖累 / 贡献',
      `全窗口逐币种归因（已排除稳定币，其变动主要来自充提）：${worst.currency} 市值变动 $${r(worst.deltaValueUsd, 0)}（贡献 ${r(worst.contributionPct, 2)}pp）为最大拖累；` +
      `${best.currency} $${r(best.deltaValueUsd, 0)}（${r(best.contributionPct, 2)}pp）为最大贡献。` +
      `注意：数量效应来自加减仓，不是投资收益。`, r(worst.contributionPct));
  }
  const cfWin = events.filter(e => e.isCashflow && Number(e.ts) >= winFrom && Number(e.ts) <= winTo);
  const cfSum = cfWin.reduce((a, e) => a + (Number(e.cashflowUsd) || 0), 0);
  if (cfSum) {
    pushReason('cashflow', '外部现金流',
      `区间内 ${cfWin.length} 笔充提，净额 ${cfSum > 0 ? '+' : ''}$${r(cfSum, 0)}。TWR/单位净值已按「期末现金流约定」剥离，` +
      `因此不改变收益率，但会改变绝对收益金额；这部分不是投资能力。`);
  }
  const cost = (analysis && analysis.costs) || {};
  if (Number.isFinite(Number(cost.totalExplicitCostUsd)) && Number(cost.totalExplicitCostUsd) !== 0) {
    const base = snapsWin.length ? Number(snapsWin[0].totalUsd) : 0;
    const pctCost = base > 0 ? r(Number(cost.totalExplicitCostUsd) / base * 100, 3) : null;
    pushReason('cost', '显式成本',
      `全窗口手续费 + 资金费 + 利息等显式成本合计 $${r(cost.totalExplicitCostUsd, 2)}` +
      (pctCost !== null ? `，约占期初资产 ${pctCost}%` : '') + `，会直接从收益中扣除。`);
  }
  if (eventOut.length) {
    const biggest = eventOut.slice().sort((a, b) => Math.abs(b.btcWindowPct || 0) - Math.abs(a.btcWindowPct || 0))[0];
    pushReason('events', '大环境事件',
      `区间内标注 ${eventOut.length} 个市场事件（${[...new Set(eventOut.map(e => e.category))].join('/')}）。` +
      `其中「${biggest.title}」窗口内 ${main} ${biggest.btcWindowPct >= 0 ? '+' : ''}${biggest.btcWindowPct}%、` +
      `资产 ${biggest.navWindowPct >= 0 ? '+' : ''}${biggest.navWindowPct}%。` +
      `事件为人工标注 + 行情异动自动检测，非实时新闻源。`);
  }

  const conclusion = {
    headline: excess === null || excess === undefined ? '数据不足' :
      `${excess >= 0 ? '跑赢' : '跑输'} ${main} ${Math.abs(excess).toFixed(2)}pp`,
    text: `所选区间 ${iso(winFrom)} → ${iso(winTo)}，${axis.length} 个快照；资产 TWR ${navPct}%，${main} ${mainPct}%。`,
    excessVsMainPct: excess ?? null, mainSeries: main,
    navPct, mainPct, betaVsMain: mM.beta ?? null, corrVsMain: mM.correlation ?? null,
    stableWeightPct: sw, eventCount: eventOut.length,
  };

  const metrics = {
    from: iso(winFrom), to: iso(winTo), points: axis.length,
    navPct, bySeries,
    summary: {
      windowPoints: axis.length, navPct, mainSeries: main, mainPct,
      excessVsMainPct: excess ?? null, betaVsMain: mM.beta ?? null,
      corrVsMain: mM.correlation ?? null, rSquaredVsMain: mM.rSquared ?? null,
      upCaptureVsMain: mM.upCapture ?? null, downCaptureVsMain: mM.downCapture ?? null,
      stableWeightPct: sw, eventCount: eventOut.length,
      benchmarkSources: JSON.stringify(sources),
    },
  };

  return {
    meta: {
      mode,
      from: iso(winFrom), to: iso(winTo), fromMs: winFrom, toMs: winTo,
      points: axis.length, symbols: allSeries,
      intervalSec: o.intervalSec, eventWindowBars: w,
      indexWeights: o.indexWeights, benchmarkSources: sources,
      dataNote: mode === 'mock'
        ? 'DEMO 模拟数据：基准行情与事件均为确定性模拟，与资产价格共享同一市场因子，非真实行情/新闻。'
        : '基准 K 线来自 Gate 公开端点（无需密钥）；事件为人工标注 + 行情异动自动检测，非实时新闻源。',
      conventions: CONVENTIONS,
    },
    points, normalized, comparisonRows, relativeRows,
    metrics, events: eventOut, eventRows, eventStudy,
    reasons, conclusion,
  };
}

const CONVENTIONS = {
  alignment: 'AS-OF 对齐：t 时刻的基准只使用 ts<=t 的最近一根已收盘 K 线，不引入未来数据',
  plateau: '相对指标仅在「基准值发生变化」的区间上取样，避免粗粒度 K 线的平台段稀释 β/相关性',
  normalisation: '所有序列在所选区间起点归一化为 100，比较的是曲线形状与累计涨幅',
  portfolioReturn: '资产侧用单位净值 TWR（已剥离充提），不是含现金流的总资产涨幅',
  excess: '超额 = 资产区间收益% - 基准区间收益%（百分点算术差，非几何/链接超额）',
  beta: 'β = cov(r_nav, r_bench)/var(r_bench)，OLS 斜率；相关系数取 Pearson，R²=其平方',
  capture: '上行捕获 = mean(r_nav | r_bench>0)/mean(r_bench | r_bench>0)；下行捕获同理（r_bench<0）',
  trackingError: '跟踪误差 = stdev(r_nav - r_bench)，区间内每期百分点，未年化',
  eventWindow: '事件窗口 = 事件时点前后各 N 个快照间隔（可配），窗口内涨跌用首尾值计算',
  timezone: '所有 ts 为 Unix 毫秒 UTC；ISO 列均为 ISO 8601 UTC',
};

module.exports = { compute, asOf, pairedReturns, relativeMetrics, CONVENTIONS };
