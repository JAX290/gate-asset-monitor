'use strict';

/**
 * Analytics engine — pure functions, no I/O, no side effects.
 *
 * Input  : snapshots[] (from store), events[]/prices[]/decisions[] (from facts)
 * Output : a fully serialisable object; every numeric result is a plain number
 *          (never NaN/Infinity — those become null), ready for CSV/JSON export.
 *
 * Metric definitions (also documented in docs/METRICS.md):
 *  - NAV / TWR  : unit-NAV method, END-OF-PERIOD cashflow convention.
 *                 r_i = (V_i - CF_i) / V_{i-1} - 1 ;  TWR = Π(1+r_i) - 1
 *  - MWR / XIRR : IRR of investor cashflows (-V0, -CF, +Vn), bisection solved.
 *  - Attribution: for currency c over one interval, with p = valueUsd / qty:
 *                 priceEffect = (p1-p0)*q0 ; qtyEffect = (q1-q0)*p0 ;
 *                 crossEffect = (p1-p0)*(q1-q0) ; Σ = Δvalue exactly.
 *                 Any part of Δtotal not covered by holdings is a __RESIDUAL__ row.
 *  - Risk       : computed on cashflow-adjusted period returns r_i.
 */

const DAY = 86400 * 1000;
const YEAR = 365 * DAY;

function r(v, d = 6) {
  const x = Number(v);
  if (!Number.isFinite(x)) return null;
  const p = Math.pow(10, d);
  return Math.round(x * p) / p;
}
function sum(a) { return a.reduce((s, x) => s + (Number(x) || 0), 0); }
function mean(a) { return a.length ? sum(a) / a.length : 0; }
function safeDiv(a, b, d = 6) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return r(a / b, d);
}
function sampleStd(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1));
}

/**
 * Solve IRR (MWR) by bisection.
 * @param {Array<{t:number, cf:number}>} cfs  investor cashflows (negative = money in)
 * @param {number} periodMs  the time unit `rate` is expressed over.
 *                           YEAR => annualised XIRR; window span => period IRR.
 * @returns {number|null} rate over `periodMs`, or null if no sign change / degenerate
 */
function xirr(cfs, periodMs = YEAR) {
  if (!cfs || cfs.length < 2 || !(periodMs > 0)) return null;
  const t0 = cfs[0].t;
  const npv = (rate) => {
    let v = 0;
    for (const c of cfs) {
      const periods = (c.t - t0) / periodMs;
      const denom = Math.pow(1 + rate, periods);
      if (!Number.isFinite(denom) || denom <= 0) return NaN;
      v += c.cf / denom;
    }
    return v;
  };
  let lo = -0.9999, hi = 10;
  let flo = npv(lo), fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (!Number.isFinite(fm)) return null;
    if (Math.abs(fm) < 1e-9 || (hi - lo) < 1e-10) return r(mid, 8);
    if (flo * fm <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return r((lo + hi) / 2, 8);
}

/** Clean + sort snapshots, collapse duplicate timestamps (keep last). */
function cleanSnapshots(snapshots) {
  const byTs = new Map();
  for (const s of (snapshots || [])) {
    if (!s || !Number.isFinite(Number(s.ts))) continue;
    byTs.set(Number(s.ts), s);
  }
  return Array.from(byTs.values()).sort((a, b) => Number(a.ts) - Number(b.ts));
}

/**
 * Keep only the newest run of rows that share the same data source.
 *
 * A mock -> live switch inside one append-only file would otherwise be read as a
 * real cliff: a DEMO account sits around ~148k USD while a real one may hold
 * ~78k, so mixing the two produces a fake -47% "crash" in NAV, drawdown, TWR and
 * every attribution row. We therefore analyse only the trailing run whose source
 * matches the newest row, so metrics always describe the CURRENT data source.
 *
 * @param {Array<object>} rows   append-only rows, chronological order
 * @param {string}        field  'mode' for snapshots, 'source' for events/prices
 * @returns {Array<object>}      trailing consistent run (input untouched if untagged)
 */
function consistentRun(rows, field = 'mode') {
  const arr = Array.isArray(rows) ? rows : [];
  if (arr.length < 2) return arr;
  const last = arr[arr.length - 1];
  const want = last && last[field];
  if (!want) return arr;                        // untagged data: keep as-is
  let i = arr.length - 1;
  while (i > 0 && arr[i - 1] && arr[i - 1][field] === want) i--;
  return arr.slice(i);
}

/** Build a fast lookup: ts -> { currency: {qty, value} }. */
function holdingsMap(s) {
  const m = new Map();
  for (const h of (s.holdings || [])) {
    const c = String(h.currency || '').toUpperCase();
    if (!c) continue;
    m.set(c, {
      qty: Number(h.amount) || 0,
      value: Number(h.valueUsd) || 0,
      available: Number(h.available) || 0,
      locked: Number(h.locked) || 0,
      venue: h.venue || '',
    });
  }
  return m;
}

/* ------------------------------ NAV / TWR -------------------------------- */

function buildNav(snaps, events, prices, opts) {
  const nav = [];
  if (!snaps.length) return nav;
  const priceByTs = new Map();
  for (const p of (prices || [])) {
    if (p.currency !== opts.benchmark) continue;
    const k = Number(p.ts);
    if (!priceByTs.has(k)) priceByTs.set(k, Number(p.priceUsd) || 0);
  }
  const sortedPrices = Array.from(priceByTs.entries()).sort((a, b) => a[0] - b[0]);
  const priceAt = (ts) => {
    if (!sortedPrices.length) return null;
    let best = sortedPrices[0][1], bestD = Infinity;
    for (const [t, v] of sortedPrices) { const d = Math.abs(t - ts); if (d < bestD) { bestD = d; best = v; } }
    return best;
  };

  // interval cashflows keyed by the END snapshot ts
  const cfByEnd = new Map();
  for (const e of (events || [])) {
    if (!e.isCashflow) continue;
    // find the first snapshot ts >= event ts (end-of-period convention)
    let end = null;
    for (const s of snaps) { if (Number(s.ts) >= e.ts) { end = Number(s.ts); break; } }
    if (end === null) end = Number(snaps[snaps.length - 1].ts);
    cfByEnd.set(end, (cfByEnd.get(end) || 0) + (Number(e.cashflowUsd) || 0));
  }

  let navPerUnit = 1;
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    const V = Number(s.totalUsd) || 0;
    const prevV = i > 0 ? (Number(snaps[i - 1].totalUsd) || 0) : null;
    const CF = i > 0 ? (cfByEnd.get(Number(s.ts)) || 0) : 0;
    let periodReturn = null;
    if (i > 0 && prevV > 0) {
      periodReturn = (V - CF) / prevV - 1;
      navPerUnit = navPerUnit * (1 + periodReturn);
    }
    const units = navPerUnit > 0 ? V / navPerUnit : null;
    nav.push({
      ts: Number(s.ts),
      timestamp_iso: new Date(Number(s.ts)).toISOString(),
      totalUsd: r(V, 2),
      cashflowUsd: r(CF, 2),
      netAssetUsd: r(V - CF, 2),
      units: r(units, 6),
      navPerUnit: r(navPerUnit, 8),
      periodReturn: r(periodReturn, 8),
      twr: r(navPerUnit - 1, 8),
      benchmarkPrice: priceAt(Number(s.ts)) !== null ? r(priceAt(Number(s.ts)), 8) : null,
      mode: s.mode || '',
    });
  }
  // drawdown on the NAV index
  let peak = -Infinity;
  for (const row of nav) {
    peak = Math.max(peak, row.navPerUnit);
    row.drawdown = r(row.navPerUnit / peak - 1, 8);
  }
  return nav;
}

/* ------------------------------- attribution ----------------------------- */

function buildAttribution(snaps, events) {
  const rows = [];
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1], b = snaps[i];
    const fromTs = Number(a.ts), toTs = Number(b.ts), V0 = Number(a.totalUsd) || 0;
    const m0 = holdingsMap(a), m1 = holdingsMap(b);
    const currencies = new Set([...m0.keys(), ...m1.keys()]);
    let covered = 0;

    // quantity flow / trade flags in this interval
    const flowQty = new Map(), tradeQty = new Map();
    for (const e of (events || [])) {
      if (e.ts <= fromTs || e.ts > toTs) continue;
      const c = String(e.currency || '').toUpperCase();
      if (!c) continue;
      if (e.type === 'trade') tradeQty.set(c, (tradeQty.get(c) || 0) + Math.abs(Number(e.amount) || 0));
      if (e.isCashflow) flowQty.set(c, (flowQty.get(c) || 0) + Math.abs(Number(e.amount) || 0));
    }

    for (const c of currencies) {
      const h0 = m0.get(c) || { qty: 0, value: 0 };
      const h1 = m1.get(c) || { qty: 0, value: 0 };
      const q0 = h0.qty, q1 = h1.qty, v0 = h0.value, v1 = h1.value;
      const p0 = q0 > 0 ? v0 / q0 : (q1 > 0 ? v1 / q1 : 0);
      const p1 = q1 > 0 ? v1 / q1 : (q0 > 0 ? v0 / q0 : 0);
      const priceEffect = (p1 - p0) * q0;
      const qtyEffect = (q1 - q0) * p0;
      const crossEffect = (p1 - p0) * (q1 - q0);
      const deltaV = v1 - v0;
      covered += deltaV;
      rows.push({
        fromTs, toTs, ts: toTs,
        fromIso: new Date(fromTs).toISOString(), toIso: new Date(toTs).toISOString(),
        currency: c,
        qty0: r(q0, 8), qty1: r(q1, 8),
        price0: r(p0, 8), price1: r(p1, 8),
        value0: r(v0, 2), value1: r(v1, 2),
        priceEffect: r(priceEffect, 2),
        qtyEffect: r(qtyEffect, 2),
        crossEffect: r(crossEffect, 2),
        deltaValueUsd: r(deltaV, 2),
        contributionPct: V0 > 0 ? r(deltaV / V0 * 100, 4) : null,
        priceChangePct: p0 > 0 ? r((p1 / p0 - 1) * 100, 4) : null,
        qtyChangePct: q0 > 0 ? r((q1 / q0 - 1) * 100, 4) : null,
        tradeDrivenQty: r(tradeQty.get(c) || 0, 8),
        flowDrivenQty: r(flowQty.get(c) || 0, 8),
        isResidual: false,
      });
    }
    // residual: total change not explained by holdings valuation
    const totalDelta = (Number(b.totalUsd) || 0) - V0;
    const residual = totalDelta - covered;
    rows.push({
      fromTs, toTs, ts: toTs,
      fromIso: new Date(fromTs).toISOString(), toIso: new Date(toTs).toISOString(),
      currency: '__RESIDUAL__',
      qty0: null, qty1: null, price0: null, price1: null,
      value0: null, value1: null,
      priceEffect: 0, qtyEffect: r(residual, 2), crossEffect: 0,
      deltaValueUsd: r(residual, 2),
      contributionPct: V0 > 0 ? r(residual / V0 * 100, 4) : null,
      priceChangePct: null, qtyChangePct: null,
      tradeDrivenQty: 0, flowDrivenQty: 0,
      isResidual: true,
      note: '总资产变动中未被逐币种持仓估值覆盖的部分（其它账户未实现盈亏/折算口径差异）',
    });
  }
  return rows;
}

function aggregateAttribution(rows) {
  const agg = new Map();
  for (const x of rows) {
    let a = agg.get(x.currency);
    if (!a) { a = { currency: x.currency, priceEffect: 0, qtyEffect: 0, crossEffect: 0, deltaValueUsd: 0, intervals: 0 }; agg.set(x.currency, a); }
    a.priceEffect += x.priceEffect || 0;
    a.qtyEffect += x.qtyEffect || 0;
    a.crossEffect += x.crossEffect || 0;
    a.deltaValueUsd += x.deltaValueUsd || 0;
    a.intervals++;
  }
  const total = sum(Array.from(agg.values()).map(a => a.deltaValueUsd));
  return Array.from(agg.values()).map(a => Object.assign(a, {
    priceEffect: r(a.priceEffect, 2), qtyEffect: r(a.qtyEffect, 2),
    crossEffect: r(a.crossEffect, 2), deltaValueUsd: r(a.deltaValueUsd, 2),
    contributionPct: total !== 0 ? r(a.deltaValueUsd / Math.abs(total) * 100, 4) : null,
  })).sort((x, y) => Math.abs(y.deltaValueUsd) - Math.abs(x.deltaValueUsd));
}

/* --------------------------------- risk ---------------------------------- */

function buildRisk(nav, opts) {
  if (nav.length < 2) return { sampleIntervals: nav.length - 1, annualizationReliable: false };
  const rets = nav.slice(1).map(x => x.periodReturn).filter(x => Number.isFinite(x));
  const ts = nav.map(x => x.ts);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const medianGap = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const ppy = medianGap > 0 ? YEAR / medianGap : 0;
  const windowDays = (ts[ts.length - 1] - ts[0]) / DAY;
  const years = (ts[ts.length - 1] - ts[0]) / YEAR;
  const twr = nav[nav.length - 1].twr;
  const annualReturn = years > 0 && (1 + twr) > 0 ? Math.pow(1 + twr, 1 / years) - 1 : null;
  const vol = sampleStd(rets);
  const annualVol = ppy > 0 ? vol * Math.sqrt(ppy) : null;
  const downside = Math.sqrt(mean(rets.map(x => Math.min(x, 0) ** 2)));
  const downsideVol = ppy > 0 ? downside * Math.sqrt(ppy) : null;
  const rf = Number(opts.riskFreeRate) || 0;
  const maxDrawdown = Math.min(...nav.map(x => x.drawdown));
  // beta / correlation vs benchmark price returns
  const benchRets = [];
  for (let i = 1; i < nav.length; i++) {
    const p0 = nav[i - 1].benchmarkPrice, p1 = nav[i].benchmarkPrice;
    const pr = nav[i].periodReturn;
    if (p0 > 0 && p1 > 0 && Number.isFinite(pr)) benchRets.push([pr, p1 / p0 - 1]);
  }
  let beta = null, correlation = null;
  if (benchRets.length >= 3) {
    const pr = benchRets.map(x => x[0]), br = benchRets.map(x => x[1]);
    const mp = mean(pr), mb = mean(br);
    let cov = 0, vb = 0, vp = 0;
    for (let i = 0; i < pr.length; i++) { cov += (pr[i] - mp) * (br[i] - mb); vb += (br[i] - mb) ** 2; vp += (pr[i] - mp) ** 2; }
    cov /= pr.length; vb /= pr.length; vp /= pr.length;
    beta = vb > 0 ? r(cov / vb, 6) : null;
    correlation = (vb > 0 && vp > 0) ? r(cov / Math.sqrt(vb * vp), 6) : null;
  }
  return {
    sampleIntervals: rets.length,
    windowDays: r(windowDays, 3),
    medianIntervalSec: r(medianGap / 1000, 1),
    periodsPerYear: r(ppy, 1),
    annualizationReliable: windowDays >= 7,
    twr: r(twr, 8),
    rawChangePct: r((nav[nav.length - 1].totalUsd / nav[0].totalUsd - 1) * 100, 4),
    annualReturn: r(annualReturn, 6),
    meanPeriodReturn: r(mean(rets), 8),
    periodVolatility: r(vol, 8),
    annualVolatility: r(annualVol, 6),
    downsideVolatility: r(downsideVol, 6),
    riskFreeRate: rf,
    sharpe: safeDiv((annualReturn ?? 0) - rf, annualVol),
    sortino: safeDiv((annualReturn ?? 0) - rf, downsideVol),
    maxDrawdown: r(maxDrawdown, 8),
    maxDrawdownPct: r(maxDrawdown * 100, 4),
    calmar: safeDiv(annualReturn, Math.abs(maxDrawdown)),
    betaVsBenchmark: beta,
    correlationVsBenchmark: correlation,
    benchmark: opts.benchmark,
    benchmarkSampleIntervals: benchRets.length,
  };
}

/* ------------------------------- benchmarks ------------------------------ */

function buildBenchmarks(nav, prices, opts) {
  const bm = String(opts.benchmark || 'BTC').toUpperCase();
  const series = (prices || []).filter(p => p.currency === bm).map(p => ({ ts: Number(p.ts), price: Number(p.priceUsd) || 0 }))
    .sort((a, b) => a.ts - b.ts);
  const out = { benchmark: bm, available: series.length >= 2, from: null, to: null };
  if (!out.available) return out;
  const p0 = series[0].price, p1 = series[series.length - 1].price;
  const holdRet = p0 > 0 ? p1 / p0 - 1 : null;
  out.from = new Date(series[0].ts).toISOString();
  out.to = new Date(series[series.length - 1].ts).toISOString();
  out.price0 = r(p0, 8); out.price1 = r(p1, 8);
  out.buyAndHoldReturn = r(holdRet, 8);
  out.buyAndHoldPct = r(holdRet * 100, 4);
  out.allStablecoinPct = 0;                    // USDT-like: 0 by construction
  out.fiftyFiftyPct = r((holdRet || 0) * 100 / 2, 4);
  const twr = nav.length ? nav[nav.length - 1].twr : null;
  out.portfolioTwrPct = r(twr * 100, 4);
  out.excessVsBuyAndHoldPct = (twr !== null && holdRet !== null) ? r((twr - holdRet) * 100, 4) : null;
  out.excessVsFiftyFiftyPct = (twr !== null && holdRet !== null) ? r((twr - holdRet / 2) * 100, 4) : null;
  return out;
}

/* ---------------------------------- costs -------------------------------- */

function buildCosts(events, snaps) {
  let feeUsd = 0, fundingUsd = 0, interestUsd = 0, rebateUsd = 0, realisedPnlUsd = 0;
  let maker = 0, taker = 0, buy = 0, sell = 0, tradeLegs = 0;
  const byVenue = new Map(), byCurrency = new Map();
  for (const e of (events || [])) {
    const fee = Number(e.feeUsd) || 0;
    feeUsd += fee;
    if (e.type === 'funding') fundingUsd += Number(e.amountUsd) || 0;
    if (e.type === 'interest') interestUsd += Number(e.amountUsd) || 0;
    if (e.type === 'rebate') rebateUsd += Number(e.amountUsd) || 0;
    if (e.isRealized) realisedPnlUsd += Number(e.amountUsd) || 0;
    if (e.type === 'trade') {
      tradeLegs++;
      if (e.role === 'maker') maker++; else if (e.role === 'taker') taker++;
      if (e.side === 'buy') buy++; else if (e.side === 'sell') sell++;
      byVenue.set(e.venue || 'unknown', (byVenue.get(e.venue || 'unknown') || 0) + Math.abs(Number(e.amountUsd) || 0));
      byCurrency.set(e.currency, (byCurrency.get(e.currency) || 0) + Math.abs(Number(e.amountUsd) || 0));
    }
  }
  const avgAssets = snaps.length ? mean(snaps.map(s => Number(s.totalUsd) || 0)) : 0;
  const windowDays = snaps.length >= 2 ? (Number(snaps[snaps.length - 1].ts) - Number(snaps[0].ts)) / DAY : 0;
  const totalCost = feeUsd + Math.abs(fundingUsd);
  return {
    totalFeeUsd: r(feeUsd, 2),
    fundingUsd: r(fundingUsd, 2),
    interestUsd: r(interestUsd, 2),
    rebateUsd: r(rebateUsd, 2),
    realisedPnlUsd: r(realisedPnlUsd, 2),
    totalExplicitCostUsd: r(totalCost, 2),
    costToAvgAssetsPct: avgAssets > 0 ? r(totalCost / avgAssets * 100, 4) : null,
    annualisedCostPct: (avgAssets > 0 && windowDays > 0) ? r(totalCost / avgAssets * 365 / windowDays * 100, 4) : null,
    tradeLegs, makerCount: maker, takerCount: taker,
    makerRatioPct: (maker + taker) > 0 ? r(maker / (maker + taker) * 100, 2) : null,
    buyLegs: buy, sellLegs: sell,
    byVenue: Object.fromEntries(byVenue),
    byCurrency: Object.fromEntries(byCurrency),
  };
}

/* -------------------------------- behaviour ------------------------------ */

function buildBehavior(decisions, events) {
  const ds = decisions || [];
  const byAction = {}, byOutcome = {}, tagCount = {};
  let reviewed = 0, withExpectation = 0;
  for (const d of ds) {
    byAction[d.action || 'other'] = (byAction[d.action || 'other'] || 0) + 1;
    if (d.reviewNote || d.outcome) { reviewed++; byOutcome[d.outcome || 'unspecified'] = (byOutcome[d.outcome || 'unspecified'] || 0) + 1; }
    if (d.expectation) withExpectation++;
    for (const t of (d.tags || [])) tagCount[t] = (tagCount[t] || 0) + 1;
  }
  // simple realised win/loss from closed pnl events
  const pnls = (events || []).filter(e => e.isRealized && Number.isFinite(Number(e.amountUsd))).map(e => Number(e.amountUsd));
  const wins = pnls.filter(x => x > 0), losses = pnls.filter(x => x < 0);
  return {
    decisionsTotal: ds.length,
    decisionsReviewed: reviewed,
    decisionsWithExpectation: withExpectation,
    reviewCoveragePct: ds.length ? r(reviewed / ds.length * 100, 2) : null,
    byAction, byOutcome, tagCount,
    realisedSamples: pnls.length,
    winRatePct: pnls.length ? r(wins.length / pnls.length * 100, 2) : null,
    avgWinUsd: wins.length ? r(mean(wins), 2) : null,
    avgLossUsd: losses.length ? r(mean(losses), 2) : null,
    profitFactor: (losses.length && sum(losses) !== 0) ? r(sum(wins) / Math.abs(sum(losses)), 4) : null,
    expectancyUsd: pnls.length ? r(mean(pnls), 2) : null,
  };
}

/* ------------------------------- distribution ---------------------------- */

function buildDistribution(snaps) {
  if (!snaps.length) return [];
  const first = snaps[0], last = snaps[snaps.length - 1];
  const acc = (s) => {
    const m = new Map();
    for (const a of (s.accounts || [])) m.set(a.id || a.label || '?', { label: a.label || a.id, amount: Number(a.amount) || 0 });
    return m;
  };
  const f = acc(first), l = acc(last);
  const total = sum(Array.from(l.values()).map(x => x.amount)) || 1;
  const ids = new Set([...f.keys(), ...l.keys()]);
  return Array.from(ids).map(id => {
    const a0 = f.get(id)?.amount || 0, a1 = l.get(id)?.amount || 0;
    return {
      accountId: id,
      label: (l.get(id) || f.get(id)).label,
      firstAmountUsd: r(a0, 2), lastAmountUsd: r(a1, 2),
      changeUsd: r(a1 - a0, 2),
      changePct: a0 > 0 ? r((a1 / a0 - 1) * 100, 4) : null,
      lastWeightPct: r(a1 / total * 100, 4),
    };
  }).sort((x, y) => y.lastAmountUsd - x.lastAmountUsd);
}

function buildConcentration(snaps) {
  if (!snaps.length) return null;
  const last = snaps[snaps.length - 1];
  const hs = (last.holdings || []).map(h => ({ c: String(h.currency || '').toUpperCase(), v: Number(h.valueUsd) || 0 })).filter(x => x.v > 0);
  const total = sum(hs.map(x => x.v));
  if (!total) return null;
  const weights = hs.map(x => x.v / total);
  const hhi = sum(weights.map(w => w * w));
  const stable = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD', 'USD']);
  return {
    totalHoldingValueUsd: r(total, 2),
    currencies: hs.length,
    hhi: r(hhi, 6),                       // 0..1, higher = more concentrated
    effectiveN: r(1 / hhi, 3),
    top1Pct: r(Math.max(...weights) * 100, 4),
    top3Pct: r(weights.slice().sort((a, b) => b - a).slice(0, 3).reduce((s, x) => s + x, 0) * 100, 4),
    stablecoinPct: r(sum(hs.filter(x => stable.has(x.c)).map(x => x.v)) / total * 100, 4),
  };
}

/* --------------------------------- quality -------------------------------- */

function buildQuality(snaps, events, attribution, integrity) {
  const gaps = [];
  for (let i = 1; i < snaps.length; i++) {
    const d = Number(snaps[i].ts) - Number(snaps[i - 1].ts);
    if (d > 0) gaps.push(d);
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const longGaps = gaps.filter(g => median > 0 && g > median * 2.5).length;
  const notesCount = snaps.filter(s => (s.notes || []).length).length;
  const intervalRows = attribution.filter(x => x.isResidual);
  let maxResidualPct = 0;
  for (const x of intervalRows) if (x.contributionPct !== null) maxResidualPct = Math.max(maxResidualPct, Math.abs(x.contributionPct));
  const ids = (events || []).map(e => e.id).filter(Boolean);
  const dupIds = ids.length - new Set(ids).size;
  const chainOk = integrity ? Object.values(integrity).every(v => v.ok !== false) : null;
  return {
    snapshotCount: snaps.length,
    eventCount: (events || []).length,
    medianIntervalSec: r(median / 1000, 1),
    longGaps,
    snapshotsWithNotes: notesCount,
    duplicateEventIds: dupIds,
    maxResidualContributionPct: r(maxResidualPct, 4),
    hashChainOk: chainOk,
    coverageNote: '贡献分解基于快照内逐币种持仓估值；未覆盖部分见 __RESIDUAL__ 行',
  };
}

/* ---------------------------------- main --------------------------------- */

/**
 * @param {object} input
 * @param {Array} input.snapshots
 * @param {Array} input.events
 * @param {Array} input.prices
 * @param {Array} input.decisions
 * @param {object} input.integrity   optional facts.integrity() result
 * @param {object} opts  { mode, quote, benchmark, riskFreeRate }
 */
function compute(input, opts = {}) {
  const o = Object.assign({ mode: 'mock', quote: 'USD', benchmark: 'BTC', riskFreeRate: 0 }, opts);
  const snaps = cleanSnapshots(consistentRun(input.snapshots, 'mode'));
  const events = input.events || [];
  const prices = input.prices || [];
  const decisions = input.decisions || [];
  // Behaviour metrics may also fold in operation annotations (see server
  // collectInput). Keep decisionCount on the real decisions only.
  const behaviorDecisions = input.behaviorDecisions || decisions;

  const nav = buildNav(snaps, events, prices, o);
  const attribution = buildAttribution(snaps, events);
  const risk = buildRisk(nav, o);

  // MWR cashflows (investor view): -V0, -CF(deposit), +Vn
  const cfs = [];
  if (snaps.length) {
    cfs.push({ t: Number(snaps[0].ts), cf: -(Number(snaps[0].totalUsd) || 0) });
    for (const e of events) if (e.isCashflow) cfs.push({ t: Number(e.ts), cf: -(Number(e.cashflowUsd) || 0) });
    cfs.push({ t: Number(snaps[snaps.length - 1].ts), cf: Number(snaps[snaps.length - 1].totalUsd) || 0 });
    cfs.sort((a, b) => a.t - b.t);
  }
  const windowMs = snaps.length >= 2 ? (Number(snaps[snaps.length - 1].ts) - Number(snaps[0].ts)) : 0;
  const mwr = xirr(cfs, YEAR);                       // annualised XIRR (may be null on tiny windows)
  const mwrWindow = windowMs > 0 ? xirr(cfs, windowMs) : null; // robust period return

  const cashflowList = events.filter(e => e.isCashflow).map(e => ({
    ts: e.ts, iso: new Date(e.ts).toISOString(), type: e.type, currency: e.currency,
    amount: r(e.amount, 8), cashflowUsd: r(e.cashflowUsd, 2), note: e.note, source: e.source,
  })).sort((a, b) => a.ts - b.ts);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      mode: o.mode, quote: o.quote, benchmark: o.benchmark, riskFreeRate: o.riskFreeRate,
      from: snaps.length ? new Date(Number(snaps[0].ts)).toISOString() : null,
      to: snaps.length ? new Date(Number(snaps[snaps.length - 1].ts)).toISOString() : null,
      snapshotCount: snaps.length, eventCount: events.length,
      priceCount: prices.length, decisionCount: decisions.length,
      conventions: {
        twr: '单位净值法 / 期末现金流约定： r_i=(V_i-CF_i)/V_{i-1}-1, TWR=Π(1+r_i)-1',
        mwr: 'XIRR：投资者现金流 -V0 / -deposit / +withdraw / +Vn，二分法求年化 IRR',
        attribution: '价格效应=(p1-p0)q0, 数量效应=(q1-q0)p0, 交叉效应=(p1-p0)(q1-q0)',
        price: '隐含单价 p=valueUsd/qty；无独立行情时由快照反推',
        timezone: '所有 ts 为 Unix 毫秒；ISO 列均为 UTC',
        residual: 'Σ逐币种Δ市值 + __RESIDUAL__ = 总资产变动（恒等式）',
      },
    },
    summary: {
      totalUsd: snaps.length ? r(Number(snaps[snaps.length - 1].totalUsd), 2) : null,
      firstTotalUsd: snaps.length ? r(Number(snaps[0].totalUsd), 2) : null,
      rawChangeUsd: snaps.length ? r(Number(snaps[snaps.length - 1].totalUsd) - Number(snaps[0].totalUsd), 2) : null,
      rawChangePct: risk.rawChangePct ?? null,
      netCashflowUsd: r(sum(cashflowList.map(c => c.cashflowUsd)), 2),
      twr: risk.twr ?? null,
      twrPct: r((risk.twr ?? 0) * 100, 4),
      mwrWindow: mwrWindow,
      mwrWindowPct: mwrWindow !== null ? r(mwrWindow * 100, 4) : null,
      mwrAnnualized: mwr,
      mwrAnnualizedPct: mwr !== null ? r(mwr * 100, 4) : null,
      annualizationReliable: risk.annualizationReliable ?? false,
      annualReturn: risk.annualReturn ?? null,
      annualVolatility: risk.annualVolatility ?? null,
      sharpe: risk.sharpe ?? null,
      sortino: risk.sortino ?? null,
      maxDrawdownPct: risk.maxDrawdownPct ?? null,
      calmar: risk.calmar ?? null,
      betaVsBenchmark: risk.betaVsBenchmark ?? null,
      totalExplicitCostUsd: null, // filled below
    },
    nav,
    attribution,
    attributionAgg: aggregateAttribution(attribution),
    risk,
    benchmarks: buildBenchmarks(nav, prices, o),
    costs: buildCosts(events, snaps),
    behavior: buildBehavior(behaviorDecisions, events),
    distribution: buildDistribution(snaps),
    concentration: buildConcentration(snaps),
    quality: buildQuality(snaps, events, attribution, input.integrity),
    cashflows: cashflowList,
  };
}

// attach cost headline to summary
const _compute = compute;
module.exports = {
  compute: (input, opts) => {
    const out = _compute(input, opts);
    out.summary.totalExplicitCostUsd = out.costs.totalExplicitCostUsd;
    return out;
  },
  xirr, cleanSnapshots, consistentRun, buildNav, buildAttribution, aggregateAttribution, buildRisk,
};
