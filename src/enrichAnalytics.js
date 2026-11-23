'use strict';

/**
 * Enrichment analytics — PURE FUNCTIONS, zero dependencies, no I/O.
 *
 * Turns the low-frequency `enrichment.jsonl` snapshots (extended Gate read-only
 * endpoints) + the existing events/snapshots into:
 *
 *   summary   a handful of headline numbers for the DASHBOARD's prominent spot
 *   detail    tidy long tables for the "更多数据" fold-out + CSV/JSONL export
 *
 * Design intent (user requirement): "use as much of the API data as possible,
 * but don't let rarely-used numbers occupy prominent positions — show me the
 * key info at a glance, keep everything else in an inconspicuous place."
 * So `summary` is deliberately tiny (4-6 numbers); everything else lives in
 * `detail.*` which the UI renders inside a collapsed panel.
 *
 * All functions tolerate missing/partial data (mock mode, brand-new install,
 * an endpoint that the API key cannot access) and degrade to nulls/empty
 * arrays instead of throwing.
 */
const STABLES = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD', 'USD', 'USDP', 'USD']);

// NOTE: null/undefined/'' must stay null — Number(null) is 0, which would make
// a "no data" comparison look like a real +0% or a "+null%" headline.
function num(v) { if (v === null || v === undefined || v === '') return null; const x = Number(v); return Number.isFinite(x) ? x : null; }
function r(v, d = 4) { const x = num(v); return x === null ? null : Math.round(x * 10 ** d) / 10 ** d; }
function sum(a) { return a.reduce((s, x) => s + (num(x) || 0), 0); }
function mean(a) { const v = a.map(num).filter(x => x !== null); return v.length ? sum(v) / v.length : null; }
function iso(ts) { const x = num(ts); return x ? new Date(x).toISOString() : ''; }
function s(v) { return v === undefined || v === null ? '' : String(v); }

/** One enrichment chain record -> a set of tidy table rows (long format). */
function buildTables(enrichRows) {
  const enrichment = [], tickerDetail = [], marketBreadth = [], feeSchedule = [],
    orderBookDepth = [], futuresMarket = [], accountState = [], capitalUsage = [];

  for (const e of (enrichRows || [])) {
    const ts = num(e.ts), T = iso(ts), id = s(e.id);
    const b = e.breadth || {}, cap = e.capital || {}, fee = e.fee || null;

    // 1) main snapshot (one row per cycle) — payload_json keeps EVERY raw field
    enrichment.push({
      snapshot_id: id, ts_ms: ts, ts_iso_utc: T, source: s(e.source),
      pairs: num(e.pairs), usdt_pairs: num(b.usdtPairs),
      advancers: num(b.advancers), decliners: num(b.decliners), unchanged: num(b.unchanged),
      up_ratio_pct: num(b.upRatioPct), median_change_pct: num(b.medianChangePct),
      mean_change_pct: num(b.meanChangePct), total_quote_volume_usd: num(b.totalQuoteVolumeUsd),
      holdings_detail_count: (e.holdingsDetail || []).length,
      futures_count: (e.futures || []).length, book_pairs: (e.books || []).length,
      open_orders: num(e.account && e.account.openOrderCount),
      positions: num(e.account && e.account.positionCount),
      margin_accounts: num(e.account && e.account.marginCount),
      notes: (e.notes || []).join(' | '),
      payload_json: e.payload ? JSON.stringify(e.payload) : '',
    });

    // 2) full 11-field ticker detail for MY holdings
    for (const d of (e.holdingsDetail || [])) {
      tickerDetail.push({
        snapshot_id: id, ts_ms: ts, ts_iso_utc: T,
        currency: s(d.currency), pair: s(d.pair), last: num(d.last),
        change_24h_pct: num(d.change24Pct), high_24h: num(d.high24h), low_24h: num(d.low24h),
        amplitude_24h_pct: num(d.amplitude24Pct),
        base_volume: num(d.baseVolume), quote_volume_usd: num(d.quoteVolumeUsd),
        highest_bid: num(d.highestBid), lowest_ask: num(d.lowestAsk),
        highest_size: num(d.highestSize), lowest_size: num(d.lowestSize),
        spread_pct: num(d.spreadPct), etf: !!d.etf,
      });
    }

    // 3) market breadth time series
    if (e.breadth) marketBreadth.push({
      snapshot_id: id, ts_ms: ts, ts_iso_utc: T,
      usdt_pairs: num(b.usdtPairs), advancers: num(b.advancers), decliners: num(b.decliners),
      unchanged: num(b.unchanged), up_ratio_pct: num(b.upRatioPct),
      median_change_pct: num(b.medianChangePct), mean_change_pct: num(b.meanChangePct),
      total_quote_volume_usd: num(b.totalQuoteVolumeUsd),
      top_gainers_json: JSON.stringify(b.topGainers || []),
      top_losers_json: JSON.stringify(b.topLosers || []),
      top_by_volume_json: JSON.stringify(b.topByVolume || []),
    });

    // 4) nominal fee schedule
    if (fee) feeSchedule.push({
      snapshot_id: id, ts_ms: ts, ts_iso_utc: T, user_id: s(fee.userId),
      taker_fee_pct: num(fee.takerFeePct), maker_fee_pct: num(fee.makerFeePct),
      futures_taker_fee_pct: num(fee.futuresTakerFeePct), futures_maker_fee_pct: num(fee.futuresMakerFeePct),
      delivery_taker_fee_pct: num(fee.deliveryTakerFeePct), delivery_maker_fee_pct: num(fee.deliveryMakerFeePct),
      gt_discount: !!fee.gtDiscount, gt_taker_fee_pct: num(fee.gtTakerFeePct),
      gt_maker_fee_pct: num(fee.gtMakerFeePct), loan_fee_pct: num(fee.loanFeePct),
      point_type: s(fee.pointType), debit_fee: s(fee.debitFee),
    });

    // 5) order-book depth
    for (const d of (e.books || [])) orderBookDepth.push({
      snapshot_id: id, ts_ms: ts, ts_iso_utc: T, pair: s(d.pair),
      best_bid: num(d.bestBid), best_ask: num(d.bestAsk), spread_pct: num(d.spreadPct),
      bid_depth_usd: num(d.bidDepthUsd), ask_depth_usd: num(d.askDepthUsd), levels: num(d.levels),
    });

    // 6) futures market (funding / mark / index / open interest)
    for (const f of (e.futures || [])) futuresMarket.push({
      snapshot_id: id, ts_ms: ts, ts_iso_utc: T, contract: s(f.contract),
      last: num(f.last), mark_price: num(f.markPrice), index_price: num(f.indexPrice),
      funding_rate_pct: num(f.fundingRatePct), funding_rate_indicative_pct: num(f.fundingRateIndicativePct),
      funding_annualised_pct: num(f.fundingRatePct) !== null ? r(num(f.fundingRatePct) * 3 * 365, 4) : null,
      open_interest: num(f.openInterest), volume_24h_quote: num(f.volume24hQuote),
      high_24h: num(f.high24h), low_24h: num(f.low24h), change_24h_pct: num(f.change24Pct),
      basis_pct: num(f.basisPct),
    });

    // 7) account state: open orders / positions / margin as one long table
    const ac = e.account || {};
    for (const o of (ac.openOrders || [])) accountState.push({
      snapshot_id: id, ts_ms: ts, ts_iso_utc: T, kind: 'open_order',
      key: s(o.pair), count: num(o.total), risk: '', leverage: '',
      liq_price: null, mark_price: null, unrealised_pnl: null, borrowed: null,
      sides: (o.sides || []).join('|'),
    });
    for (const p of (ac.positions || [])) accountState.push({
      snapshot_id: id, ts_ms: ts, ts_iso_utc: T, kind: 'position',
      key: s(p.contract), count: num(p.size), risk: '', leverage: s(p.leverage),
      liq_price: num(p.liqPrice), mark_price: num(p.markPrice),
      unrealised_pnl: num(p.unrealisedPnl), borrowed: num(p.margin), sides: s(p.mode),
    });
    for (const m of (ac.margin || [])) accountState.push({
      snapshot_id: id, ts_ms: ts, ts_iso_utc: T, kind: 'margin',
      key: s(m.pair), count: null, risk: s(m.risk), leverage: '',
      liq_price: null, mark_price: null, unrealised_pnl: null,
      borrowed: r((num(m.baseBorrowed) || 0) + (num(m.quoteBorrowed) || 0), 8),
      sides: m.locked ? 'locked' : '',
    });

    // 8) capital usage
    if (e.capital) capitalUsage.push({
      snapshot_id: id, ts_ms: ts, ts_iso_utc: T,
      total_usd: num(cap.totalUsd), borrowed_usd: num(cap.borrowedUsd),
      unrealised_pnl_usd: num(cap.unrealisedPnlUsd),
      borrowed_to_total_pct: num(cap.borrowedToTotalPct),
      unrealised_to_total_pct: num(cap.unrealisedToTotalPct),
      available_qty: num(cap.availableQty), locked_qty: num(cap.lockedQty),
      locked_share_pct: num(cap.lockedSharePct),
    });
  }

  return { enrichment, ticker_detail: tickerDetail, market_breadth: marketBreadth,
    fee_schedule: feeSchedule, order_book_depth: orderBookDepth,
    futures_market: futuresMarket, account_state: accountState, capital_usage: capitalUsage };
}

/** Deposit/withdraw chains parsed from the event notes (`链上充值 · ETH`). */
function buildChains(events) {
  const map = new Map();
  const re = /链上(充值|提现)\s*[·•]\s*([A-Za-z0-9_\-]+)/;
  for (const e of (events || [])) {
    if (!e.isCashflow) continue;
    const m = re.exec(s(e.note));
    const chain = m ? m[2].toUpperCase() : 'UNKNOWN';
    let x = map.get(chain);
    if (!x) { x = { chain, deposits: 0, withdraws: 0, count: 0, volumeUsd: 0, lastTs: 0 }; map.set(chain, x); }
    if (e.type === 'withdraw') x.withdraws++; else x.deposits++;
    x.count++;
    x.volumeUsd += Math.abs(num(e.cashflowUsd) || 0);
    x.lastTs = Math.max(x.lastTs, num(e.ts) || 0);
  }
  return Array.from(map.values()).map(x => ({
    chain: x.chain, deposits: x.deposits, withdraws: x.withdraws, count: x.count,
    volume_usd: r(x.volumeUsd, 2), avg_usd: x.count ? r(x.volumeUsd / x.count, 2) : null,
    last_ts_ms: x.lastTs || null, last_iso_utc: iso(x.lastTs),
  })).sort((a, b) => b.count - a.count);
}

/**
 * Portfolio 24h weighted change vs the whole-market median.
 * Answers: "is my move just the market, or did my coin selection add value?"
 */
function relativeStrength(detail, breadth, holdings) {
  const chg = new Map();
  for (const d of (detail || [])) if (d.currency && num(d.change24Pct) !== null) chg.set(s(d.currency).toUpperCase(), num(d.change24Pct));
  let wsum = 0, covered = 0, total = 0;
  for (const h of (holdings || [])) {
    const v = num(h.valueUsd) || 0;
    total += v;
    const c = s(h.currency).toUpperCase();
    const ch = STABLES.has(c) ? 0 : chg.get(c);
    if (ch !== undefined && ch !== null) { wsum += v * ch; covered += v; }
  }
  const portPct = covered > 0 ? r(wsum / covered, 4) : null;   // weighted over covered risky holdings
  const median = num(breadth && breadth.medianChangePct);
  return {
    portfolio24hPct: portPct,
    marketMedian24hPct: median,
    excessVsMarketPct: (portPct !== null && median !== null) ? r(portPct - median, 4) : null,
    coveragePct: total > 0 ? r(covered / total * 100, 2) : null,
    coveredCurrencies: chg.size,
    verdict: portPct === null || median === null ? '数据不足'
      : portPct > median + 0.5 ? '强于大盘' : portPct < median - 0.5 ? '弱于大盘' : '与大盘同步',
  };
}

/** Fee audit: nominal schedule vs actually charged fees (from ledger events). */
function feeAudit(fee, costs, events) {
  const nominalTaker = num(fee && fee.takerFeePct);
  const nominalMaker = num(fee && fee.makerFeePct);
  let charged = 0, feeEvents = 0;
  for (const e of (events || [])) if (e.type === 'fee' || num(e.feeUsd)) { charged += Math.abs(num(e.feeUsd) || 0); feeEvents++; }
  return {
    nominalTakerFeePct: nominalTaker, nominalMakerFeePct: nominalMaker,
    gtDiscount: fee ? !!fee.gtDiscount : null,
    actualFeesUsd: r(charged, 2), feeEventCount: feeEvents,
    explicitCostUsd: num(costs && costs.totalExplicitCostUsd),
    makerRatioPct: num(costs && costs.makerRatioPct),
    note: '名义费率来自 /wallet/fee；实扣来自账本 fee 事件。二者口径不同（含 GT 抵扣/返佣/不同币对），不做机械相减。',
  };
}

/** Aggregate the newest snapshot into the small headline + detail sections. */
function compute(input) {
  const rows = input.enrichment || [];
  const events = input.events || [];
  const costs = (input.analysis && input.analysis.costs) || {};
  const latestSnap = input.latestSnapshot || null;
  const tables = buildTables(rows);
  tables.deposit_chains = buildChains(events);

  const last = rows.length ? rows[rows.length - 1] : null;
  const b = (last && last.breadth) || null;
  const cap = (last && last.capital) || null;
  const rs = relativeStrength(last && last.holdingsDetail, b, latestSnap && latestSnap.holdings);
  const fa = feeAudit(last && last.fee, costs, events);

  // trend of breadth across snapshots (for a tiny sparkline / direction text)
  const breadthTrend = tables.market_breadth.slice(-24).map(x => ({
    ts_ms: x.ts_ms, up_ratio_pct: x.up_ratio_pct, median_change_pct: x.median_change_pct,
  }));

  // liquidity / impact view: held coins sorted by amplitude & spread
  const liquidity = (last && last.holdingsDetail || []).slice().map(d => ({
    currency: d.currency, pair: d.pair, change24Pct: num(d.change24Pct),
    amplitude24Pct: num(d.amplitude24Pct), quoteVolumeUsd: num(d.quoteVolumeUsd),
    spreadPct: num(d.spreadPct), last: num(d.last),
  })).sort((x, y) => (y.quoteVolumeUsd || 0) - (x.quoteVolumeUsd || 0));
  // Volume-weighted: a near-zero-liquidity listing must not skew the average
  // spread/amplitude of an otherwise healthy portfolio (dust coins often show
  // 50%+ spreads and 200% amplitudes).
  const wmean = (arr, key) => {
    let sw = 0, sv = 0;
    for (const x of arr) {
      const w = num(x.quoteVolumeUsd) || 0, v = num(x[key]);
      if (v !== null && w > 0) { sw += w; sv += v * w; }
    }
    return sw > 0 ? r(sv / sw, 4) : null;
  };
  const avgSpread = wmean(liquidity, 'spreadPct');
  const avgAmplitude = wmean(liquidity, 'amplitude24Pct');

  // futures risk summary
  const fut = (last && last.futures || []).map(f => {
    const mark = num(f.markPrice), liq = num(f.liqPrice);
    return {
      contract: f.contract, fundingRatePct: num(f.fundingRatePct),
      fundingAnnualisedPct: num(f.fundingRatePct) !== null ? r(num(f.fundingRatePct) * 3 * 365, 4) : null,
      openInterest: num(f.openInterest), basisPct: num(f.basisPct), markPrice: mark, indexPrice: num(f.indexPrice),
    };
  });
  const pos = (last && last.account && last.account.positions) || [];
  const posRisk = pos.map(p => {
    const mark = num(p.markPrice), liq = num(p.liqPrice);
    return { contract: p.contract, size: num(p.size), leverage: s(p.leverage),
      liqDistancePct: (mark > 0 && liq > 0) ? r(Math.abs(mark - liq) / mark * 100, 4) : null,
      unrealisedPnl: num(p.unrealisedPnl) };
  });

  const summary = {
    available: !!last,
    lastTs: last ? num(last.ts) : null,
    lastIso: last ? iso(last.ts) : null,
    snapshotCount: rows.length,
    pairs: last ? num(last.pairs) : null,
    usdtPairs: b ? num(b.usdtPairs) : null,
    advancers: b ? num(b.advancers) : null,
    decliners: b ? num(b.decliners) : null,
    upRatioPct: b ? num(b.upRatioPct) : null,
    medianChangePct: b ? num(b.medianChangePct) : null,
    totalQuoteVolumeUsd: b ? num(b.totalQuoteVolumeUsd) : null,
    portfolio24hPct: rs.portfolio24hPct,
    excessVsMarketPct: rs.excessVsMarketPct,
    relativeVerdict: rs.verdict,
    lockedSharePct: cap ? num(cap.lockedSharePct) : null,
    borrowedToTotalPct: cap ? num(cap.borrowedToTotalPct) : null,
    avgSpreadPct: avgSpread,
    avgAmplitudePct: avgAmplitude,
    openOrderCount: last && last.account ? num(last.account.openOrderCount) : null,
    positionCount: last && last.account ? num(last.account.positionCount) : null,
    notes: (last && last.notes) || [],
  };

  // One-line "key info" for the prominent strip. Honest when data is missing.
  let headline;
  if (!last) headline = '扩展行情数据累积中（下一采集周期生成）';
  else {
    const parts = [];
    if (b && num(b.upRatioPct) !== null) parts.push(`全市场 ${b.advancers} 涨 / ${b.decliners} 跌（上涨占比 ${b.upRatioPct}%）`);
    if (num(rs.portfolio24hPct) !== null) parts.push(`我的持仓 24h ${rs.portfolio24hPct >= 0 ? '+' : ''}${rs.portfolio24hPct}%`);
    if (num(rs.marketMedian24hPct) !== null) parts.push(`大盘中位 ${rs.marketMedian24hPct >= 0 ? '+' : ''}${rs.marketMedian24hPct}% · ${rs.verdict}`);
    headline = parts.join(' · ');
  }

  return {
    available: !!last,
    headline,
    summary,
    depth: {
      relativeStrength: rs, liquidity, avgSpreadPct: avgSpread, avgAmplitudePct: avgAmplitude,
      feeAudit: fa, capital: cap, futures: fut, positions: posRisk,
      breadthTrend, chains: tables.deposit_chains,
      topGainers: (b && b.topGainers) || [], topLosers: (b && b.topLosers) || [],
      topByVolume: (b && b.topByVolume) || [],
      books: (last && last.books) || [],
      account: (last && last.account) || null,
    },
    tables,
  };
}

module.exports = { compute, buildTables, buildChains, relativeStrength, feeAudit };
