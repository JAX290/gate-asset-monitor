'use strict';

/**
 * Deterministic SIMULATED portfolio data — v3 (market-factor consistent).
 *
 * v3 change: prices are NO LONGER independent random walks. A single common
 * market factor F(ts) drives every risky currency through its own beta, plus a
 * small idiosyncratic component. Macro-event pulses are permanent smooth steps
 * in F(ts), so the benchmark curve, the portfolio NAV, the 3-way attribution
 * and the event windows all tell the SAME story. This is what makes "why did I
 * underperform BTC" answerable from data instead of being a random number.
 *
 *   price(c, ts) = basePx(c) * (1 + vol(c) * (beta(c)*F(ts) + idio(c)*W_c(ts)))
 *   F(ts)        = W_0(ts) + SUM( shock_amp * sigmoid((ts - shock_ts)/width) )
 *
 * Every holding still satisfies valueUsd = qty * priceUsd exactly (implied
 * price is derived from the rounded qty/value). BTC has beta=1, idio=0, so the
 * market benchmark's close IS the portfolio's BTC mark — no contradiction.
 *
 * NO real market prices, NO real account data. Everything is flagged DEMO.
 * Backwards compatible exports: buildSnapshot(ts[, events]) / generateHistory().
 */
const UNIVERSE = [
  { currency: 'USDT', baseQty: 18240.55, basePx: 1,     vol: 0.0004, beta: 0,    idio: 1,    seed: 1, decimals: 2 },
  { currency: 'BTC',  baseQty: 0.4821,   basePx: 64000, vol: 0.020,  beta: 1.00, idio: 0,    seed: 2, decimals: 6 },
  { currency: 'ETH',  baseQty: 6.314,    basePx: 3200,  vol: 0.028,  beta: 0.92, idio: 0.22, seed: 3, decimals: 4 },
  { currency: 'GT',   baseQty: 820.0,    basePx: 10.5,  vol: 0.030,  beta: 1.15, idio: 0.50, seed: 4, decimals: 2 },
  { currency: 'SOL',  baseQty: 42.7,     basePx: 145,   vol: 0.040,  beta: 1.35, idio: 0.45, seed: 5, decimals: 3 },
  { currency: 'DOGE', baseQty: 9800,     basePx: 0.14,  vol: 0.050,  beta: 1.60, idio: 0.60, seed: 6, decimals: 1 },
];
const META = Object.fromEntries(UNIVERSE.map(u => [u.currency, u]));
const QUOTE = 'USD';
const OTHER_ACCOUNTS = [
  { id: 'futures', label: '合约账户 (USDT)', base: 24000, borrowed: 0, unrealisedPnl: 0 },
  { id: 'earn',    label: '理财/赚币',       base: 12000, borrowed: 0, unrealisedPnl: 0 },
  { id: 'margin',  label: '杠杆账户',        base: 5500,  borrowed: 900, unrealisedPnl: 0 },
];

/**
 * Macro-event shocks on the DEMO timeline. These are SIMULATED events, clearly
 * labelled source='mock' in the ledger — never presented as real news.
 * `i` is the snapshot index inside the generated window (0 = oldest).
 */
const DEMO_SHOCKS = [
  { i: 22, amp:  2.2,  category: 'macro',      title: '宏观数据超预期，风险资产集体走强', impact: 'bullish',  symbols: ['BTC', 'ETH'] },
  { i: 43, amp: -2.8,  category: 'policy',     title: '监管表态偏鹰，主流币快速回撤',     impact: 'bearish',  symbols: ['BTC', 'ETH'] },
  { i: 63, amp:  1.9,  category: 'onchain',    title: '大额 ETF 净流入，BTC 领涨',        impact: 'bullish',  symbols: ['BTC'] },
  { i: 79, amp: -1.6,  category: 'volatility', title: '杠杆集中平仓，短时插针后修复',     impact: 'bearish',  symbols: ['BTC', 'ETH', 'SOL'] },
];
const DEFAULT_MARKET_SYMBOLS = ['BTC', 'ETH'];

/** Module-level DEMO context, set once by generateFullDemo(). Purely in-memory:
 *  it never touches disk, live mode, or exported account data. */
let DEMO_CTX = { shocks: [], symbols: DEFAULT_MARKET_SYMBOLS.slice() };

function wobble(seed, t) {
  return (
    Math.sin(t * 0.0007 + seed * 1.7) * 0.6 +
    Math.sin(t * 0.00013 + seed * 3.1) * 0.3 +
    Math.cos(t * 0.000021 + seed * 0.9) * 0.1
  );
}
function round(v, d = 2) { const p = Math.pow(10, d); return Math.round(v * p) / p; }

/** Common market factor at time t (SECONDS). Smooth permanent event steps. */
function marketFactor(tSec) {
  let f = wobble(0, tSec);
  for (const s of DEMO_CTX.shocks) {
    f += s.amp * (0.5 + 0.5 * Math.tanh((tSec - s.atSec) / s.widthSec));
  }
  return f;
}

/** Deterministic USD price for a currency at time ts (ms). */
function priceUsd(currency, ts) {
  const m = META[currency];
  if (!m) return 0;
  const tSec = ts / 1000;
  const rel = m.vol * (m.beta * marketFactor(tSec) + m.idio * wobble(m.seed, tSec));
  return round(m.basePx * (1 + rel), m.basePx >= 1000 ? 2 : 8);
}

/** Cumulative signed quantity delta from non-cashflow events up to ts. */
function eventQty(currency, ts, events) {
  let d = 0;
  for (const e of events) {
    if (e.ts > ts) continue;
    if (e.isCashflow) continue;          // handled separately (USD -> USDT qty)
    if (String(e.currency).toUpperCase() === currency) d += Number(e.amount) || 0;
  }
  return d;
}
/** External cashflow (USD) accumulated into the USDT balance up to ts. */
function cashflowQty(ts, events) {
  let q = 0;
  for (const e of events) {
    if (e.ts > ts || !e.isCashflow) continue;
    q += (Number(e.cashflowUsd) || 0) / (priceUsd('USDT', e.ts) || 1);
  }
  return q;
}
function qtyAt(currency, ts, events) {
  const base = META[currency] ? META[currency].baseQty : 0;
  let q = base + eventQty(currency, ts, events);
  if (currency === 'USDT') q += cashflowQty(ts, events);
  return q;
}

/**
 * Build one self-consistent snapshot at `ts`.
 * @param {number} ts  Unix ms
 * @param {Array}  events  optional event list (defaults to none, fully backwards compatible)
 */
function buildSnapshot(ts, events = []) {
  const holdings = UNIVERSE.map(u => {
    const q = qtyAt(u.currency, ts, events);
    const p = priceUsd(u.currency, ts);
    const amount = round(q, u.decimals);
    const valueUsd = round(q * p, 2);
    // Implied price from the rounded quantity/value keeps valueUsd = qty*priceUsd
    // exact (the independent market series still lives in prices/market .jsonl).
    const implied = amount > 0 ? round(valueUsd / amount, 8) : p;
    return {
      currency: u.currency,
      amount,
      available: round(amount * 0.82, u.decimals),
      locked: round(amount * 0.18, u.decimals),
      venue: 'spot',
      priceUsd: implied,
      valueUsd,
    };
  });
  const spotTotal = round(holdings.reduce((s, h) => s + h.valueUsd, 0), 2);
  const accounts = [
    { id: 'spot', label: '现货账户', amount: spotTotal, currency: QUOTE, borrowed: 0, unrealisedPnl: 0 },
    ...OTHER_ACCOUNTS.map(a => ({
      id: a.id, label: a.label, amount: a.base, currency: QUOTE,
      borrowed: a.borrowed, unrealisedPnl: a.unrealisedPnl,
    })),
  ];
  const totalUsd = round(accounts.reduce((s, a) => s + a.amount, 0), 2);
  return {
    ts,
    totalUsd,
    totalCurrency: QUOTE,
    accounts: accounts.sort((a, b) => b.amount - a.amount),
    holdings: holdings.sort((a, b) => b.valueUsd - a.valueUsd),
    notes: [],
  };
}

/** Legacy helper kept for compatibility (no events => flat quantities). */
function generateHistory(now, count, stepSec) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push(buildSnapshot(now - i * stepSec * 1000));
  return out;
}

/* ------------------------------- DEMO events ------------------------------ */

const CASHFLOWS = [
  { i: 18, type: 'deposit',  usd: 12000, note: '追加资金（演示外部现金流）' },
  { i: 45, type: 'withdraw', usd: -4000, note: '部分提现（演示外部现金流）' },
  { i: 60, type: 'deposit',  usd: 8000,  note: '追加资金（演示外部现金流）' },
  { i: 88, type: 'deposit',  usd: 5000,  note: '追加资金（演示外部现金流）' },
];
const TRADES = [
  { i: 25, side: 'buy',  c: 'BTC',  usd: 3000 },
  { i: 38, side: 'sell', c: 'ETH',  usd: 1500 },
  { i: 52, side: 'buy',  c: 'SOL',  usd: 1200 },
  { i: 70, side: 'sell', c: 'GT',   usd: 900 },
  { i: 82, side: 'buy',  c: 'DOGE', usd: 600 },
];
const FUNDING = [
  { i: 30, usd: -45, note: '永续合约资金费' },
  { i: 66, usd: 28,  note: '永续合约资金费收入' },
];
const INTEREST = [
  { i: 35, usd: 12, note: '理财计息' },
  { i: 75, usd: 15, note: '理财计息' },
];
const REALIZED = [
  { i: 52, usd: 220,  note: 'SOL 波段平仓盈利' },
  { i: 70, usd: -95,  note: 'GT 止损平仓亏损' },
];

function buildDemoEvents(tss) {
  const ev = [];
  const at = (i) => tss[Math.max(0, Math.min(tss.length - 1, i))];
  let seq = 0;
  const push = (o) => ev.push(Object.assign({ source: 'mock', isCashflow: false, isRealized: false }, o, { id: o.id || ('demo-' + (++seq)) }));

  for (const c of CASHFLOWS) {
    push({
      id: `demo-cf-${c.i}`, ts: at(c.i), type: c.type, currency: 'USDT',
      amount: c.usd / (priceUsd('USDT', at(c.i)) || 1), amountUsd: c.usd,
      priceUsd: priceUsd('USDT', at(c.i)),
      cashflowUsd: c.usd, isCashflow: true,
      venue: 'wallet', account: 'spot', note: c.note,
    });
  }

  for (const t of TRADES) {
    const ts = at(t.i), p = priceUsd(t.c, ts) || 1;
    const qty = t.usd / p;
    const fee = round(t.usd * 0.001, 2);
    const role = (t.i % 2 === 0) ? 'maker' : 'taker';
    const ref = `demo-trade-${t.i}`;
    push({
      id: `${ref}-base`, ts, type: 'trade', currency: t.c,
      amount: t.side === 'buy' ? qty : -qty, amountUsd: t.side === 'buy' ? t.usd : -t.usd,
      priceUsd: p, side: t.side, role, venue: 'spot', account: 'spot',
      pair: `${t.c}_USDT`, refId: ref, note: `${t.side === 'buy' ? '买入' : '卖出'} ${t.c}`,
    });
    push({
      id: `${ref}-quote`, ts, type: 'trade', currency: 'USDT',
      amount: t.side === 'buy' ? -t.usd : t.usd, amountUsd: t.side === 'buy' ? -t.usd : t.usd,
      priceUsd: priceUsd('USDT', ts), side: t.side, role, venue: 'spot', account: 'spot',
      pair: `${t.c}_USDT`, refId: ref, note: '计价腿',
    });
    push({
      id: `${ref}-fee`, ts, type: 'fee', currency: 'USDT',
      amount: -fee, amountUsd: -fee, priceUsd: priceUsd('USDT', ts),
      feeAmount: fee, feeCurrency: 'USDT', feeUsd: fee,
      venue: 'spot', account: 'spot', pair: `${t.c}_USDT`, refId: ref, note: '成交手续费 0.1%',
    });
  }

  for (const f of FUNDING) push({
    id: `demo-fund-${f.i}`, ts: at(f.i), type: 'funding', currency: 'USDT',
    amount: f.usd, amountUsd: f.usd, priceUsd: priceUsd('USDT', at(f.i)),
    venue: 'futures', account: 'futures', note: f.note,
  });
  for (const x of INTEREST) push({
    id: `demo-int-${x.i}`, ts: at(x.i), type: 'interest', currency: 'USDT',
    amount: x.usd, amountUsd: x.usd, priceUsd: priceUsd('USDT', at(x.i)),
    venue: 'earn', account: 'earn', note: x.note,
  });
  for (const x of REALIZED) push({
    id: `demo-pnl-${x.i}`, ts: at(x.i), type: 'realized_pnl', currency: 'USDT',
    amount: x.usd, amountUsd: x.usd, priceUsd: priceUsd('USDT', at(x.i)),
    venue: 'spot', account: 'spot', isRealized: true, note: x.note,
  });

  return ev.sort((a, b) => a.ts - b.ts);
}

function buildDemoPrices(tss) {
  const out = [];
  for (const ts of tss) {
    for (const u of UNIVERSE) {
      out.push({ id: `dp-${ts}-${u.currency}`, ts, currency: u.currency, priceUsd: priceUsd(u.currency, ts), quote: QUOTE, source: 'mock' });
    }
  }
  return out;
}

/**
 * Benchmark OHLCV bars on the SAME timeline as the snapshots. `close` is
 * exactly priceUsd(symbol, ts), so the market series and the portfolio marks
 * can never disagree. OHLC around it is a deterministic synthetic intrabar.
 */
function buildDemoMarket(tss, stepSec, symbols) {
  const syms = (symbols && symbols.length ? symbols : DEFAULT_MARKET_SYMBOLS).map(s => String(s).toUpperCase());
  const out = [];
  for (let i = 0; i < tss.length; i++) {
    const ts = tss[i];
    for (const sym of syms) {
      const close = priceUsd(sym, ts);
      if (!(close > 0)) continue;
      const open = i > 0 ? (priceUsd(sym, tss[i - 1]) || close) : close;
      const seed = syms.indexOf(sym) + 11;
      const w = wobble(seed, ts / 1000);
      out.push({
        id: `dm-${ts}-${sym}`, ts, symbol: sym, quote: 'USDT',
        open, high: round(Math.max(open, close) * (1 + 0.0012 + Math.abs(w) * 0.0006), 8),
        low: round(Math.min(open, close) * (1 - 0.0012 - Math.abs(w) * 0.0006), 8),
        close,
        baseVolume: round(120 + Math.abs(w) * 380, 4),
        quoteVolume: round(close * (120 + Math.abs(w) * 380), 2),
        intervalSec: stepSec, windowClosed: true, source: 'mock',
      });
    }
  }
  return out;
}

/** DEMO macro events, aligned to the very shocks that drive the price factor. */
function buildDemoMacroEvents() {
  return DEMO_CTX.shocks.map((s, idx) => ({
    id: `demo-event-${idx + 1}`,
    ts: Math.round(s.atSec * 1000),
    category: s.category,
    title: s.title,
    summary: `DEMO 模拟市场事件 #${idx + 1}：用于演示「事件 → 主流币走势 → 资产表现 → 原因归因」的联动分析，非真实新闻。`,
    impact: s.impact,
    symbols: s.symbols,
    source: 'mock',
    note: 'DEMO / 非真实事件；与市场价格因子中的脉冲一一对应',
  }));
}

function buildDemoDecisions(tss) {
  const at = (i) => tss[Math.max(0, Math.min(tss.length - 1, i))];
  return [
    { decidedAt: at(24), action: 'buy', symbol: 'BTC', amount: 0.046, priceUsd: priceUsd('BTC', at(24)), valueUsd: 3000,
      reason: '回踩不破前低，日线级别出现放量', expectation: '两周内看向 68k，跌破 61k 止损', tags: ['趋势', '突破'], note: '演示决策' },
    { decidedAt: at(37), action: 'sell', symbol: 'ETH', amount: 0.47, priceUsd: priceUsd('ETH', at(37)), valueUsd: 1500,
      reason: '降低 ETH 集中度，兑现部分利润', expectation: '回落至 3000 附近再接回', tags: ['再平衡'], note: '演示决策' },
    { decidedAt: at(51), action: 'buy', symbol: 'SOL', amount: 8.2, priceUsd: priceUsd('SOL', at(51)), valueUsd: 1200,
      reason: '生态数据转好，短线波段', expectation: '持有 3-5 天，目标 +8%', tags: ['波段', '山寨'], note: '演示决策' },
    { decidedAt: at(69), action: 'sell', symbol: 'GT', amount: 85, priceUsd: priceUsd('GT', at(69)), valueUsd: 900,
      reason: '跌破成本价，按纪律止损', expectation: '规避进一步回撤', tags: ['止损'], note: '演示决策' },
    { decidedAt: at(81), action: 'buy', symbol: 'DOGE', amount: 4200, priceUsd: priceUsd('DOGE', at(81)), valueUsd: 600,
      reason: '小仓位试探情绪面', expectation: '纯粹试仓，可接受归零', tags: ['试仓', '高波动'], note: '演示决策' },
  ];
}

/**
 * v5: self-consistent DEMO snapshots for the extended read-only endpoints.
 * One record every 4 asset snapshots (~20 min at the default 5 min interval)
 * so the breadth trend has enough points for the fold-out sparkline.
 * Every number is DERIVED from the same priceUsd()/marketFactor() process as
 * the asset curve — never an independent random number.
 */
function buildDemoEnrichment(tss, snapshots, symbols) {
  const rows = [];
  const syms = (symbols && symbols.length ? symbols : DEFAULT_MARKET_SYMBOLS).map(s => String(s).toUpperCase());
  const chg24 = (c, ts) => {
    const p1 = priceUsd(c, ts), p0 = priceUsd(c, ts - 86400 * 1000);
    return p0 > 0 ? round((p1 / p0 - 1) * 100, 4) : 0;
  };
  for (let i = 0; i < snapshots.length; i += 4) {
    const ts = tss[i], snap = snapshots[i];
    const holdings = (snap.holdings || []).filter(h => (Number(h.valueUsd) || 0) > 0);
    const risky = holdings.filter(h => h.currency !== 'USDT' && h.currency !== 'USD');
    const f = marketFactor(ts / 1000);
    const drift = round(f * 0.55, 4);                   // whole-market median move
    const usdtPairs = 1180;
    const advancers = Math.round(usdtPairs * (0.5 + Math.max(-0.35, Math.min(0.35, drift / 12))));
    const decliners = usdtPairs - advancers - 17;

    const detail = risky.slice(0, 12).map(h => {
      const c = h.currency, last = priceUsd(c, ts), ch = chg24(c, ts);
      const high = round(last * (1 + Math.abs(ch) / 200 + 0.012), 8);
      const low = round(last * (1 - Math.abs(ch) / 200 - 0.010), 8);
      const qv = round((Number(h.valueUsd) || 0) * (38 + (META[c] ? META[c].seed * 7 : 5)), 2);
      const bid = round(last * 0.9997, 8), ask = round(last * 1.0003, 8);
      return {
        currency: c, pair: `${c}_USDT`, last, change24Pct: ch,
        high24h: high, low24h: low,
        amplitude24Pct: low > 0 ? round((high / low - 1) * 100, 4) : null,
        baseVolume: round(qv / (last || 1), 4), quoteVolumeUsd: qv,
        highestBid: bid, lowestAsk: ask,
        highestSize: round(qv / (last || 1) * 0.004, 6), lowestSize: round(qv / (last || 1) * 0.003, 6),
        spreadPct: round((ask / bid - 1) * 100, 6), etf: false,
      };
    });
    const movers = detail.slice().sort((a, b) => b.change24Pct - a.change24Pct);
    const breadth = {
      usdtPairs, advancers, decliners, unchanged: 17,
      upRatioPct: round(advancers / usdtPairs * 100, 2),
      medianChangePct: drift, meanChangePct: round(drift * 1.12, 4),
      totalQuoteVolumeUsd: round(2.86e9 + f * 1.4e8, 2),
      topGainers: movers.slice(0, 5).map(d => ({ pair: d.pair, last: d.last, changePct: d.change24Pct, quoteVolumeUsd: d.quoteVolumeUsd })),
      topLosers: movers.slice(-5).reverse().map(d => ({ pair: d.pair, last: d.last, changePct: d.change24Pct, quoteVolumeUsd: d.quoteVolumeUsd })),
      topByVolume: detail.slice().sort((a, b) => b.quoteVolumeUsd - a.quoteVolumeUsd).slice(0, 5)
        .map(d => ({ pair: d.pair, quoteVolumeUsd: d.quoteVolumeUsd })),
    };
    const futures = syms.slice(0, 4).map(c => {
      const last = priceUsd(c, ts) || (c === 'BTC' ? 64000 : 3200);
      const funding = round(0.01 + Math.sin(ts / 3600000) * 0.008, 6);
      return {
        contract: `${c}_USDT`, last, markPrice: round(last * 1.0004, 8), indexPrice: last,
        fundingRatePct: funding, fundingRateIndicativePct: round(funding * 1.05, 6),
        openInterest: Math.round(420000 + f * 12000), volume24hQuote: round(1.2e9 + f * 8e7, 2),
        high24h: round(last * 1.03, 8), low24h: round(last * 0.97, 8),
        change24Pct: chg24(c, ts), basisPct: 0.04,
      };
    });
    const books = detail.slice(0, 4).map(d => ({
      pair: d.pair, bestBid: d.highestBid, bestAsk: d.lowestAsk, spreadPct: d.spreadPct,
      bidDepthUsd: round(d.quoteVolumeUsd * 0.0021, 2), askDepthUsd: round(d.quoteVolumeUsd * 0.0019, 2), levels: 5,
    }));
    const accounts = snap.accounts || [];
    const borrowedUsd = accounts.reduce((s, a) => s + (Number(a.borrowed) || 0), 0);
    const lockedUsd = holdings.reduce((s, h) => {
      const l = Number(h.locked) || 0, av = Number(h.available) || 0;
      return s + (l + av > 0 ? (Number(h.valueUsd) || 0) * l / (l + av) : 0);
    }, 0);
    const totalUsd = Number(snap.totalUsd) || 0;
    rows.push({
      ts, source: 'mock', pairs: 2160, breadth, holdingsDetail: detail,
      fee: {
        userId: 'demo', takerFeePct: 0.1, makerFeePct: 0.1,
        futuresTakerFeePct: 0.05, futuresMakerFeePct: 0.02,
        deliveryTakerFeePct: 0.06, deliveryMakerFeePct: 0.02,
        gtDiscount: true, gtTakerFeePct: 0.075, gtMakerFeePct: 0.075,
        loanFeePct: 0.005, pointType: '0', debitFee: '',
      },
      futures, books,
      account: {
        openOrders: detail.slice(0, 2).map((d, k) => ({ pair: d.pair, total: k + 1, sides: ['buy'] })),
        positions: [{ contract: 'BTC_USDT', size: 0.05, leverage: '3',
          liqPrice: round(priceUsd('BTC', ts) * 0.72, 2), markPrice: priceUsd('BTC', ts),
          unrealisedPnl: round(f * 42, 2), margin: 1080, mode: 'single' }],
        margin: [{ pair: 'ETH_USDT', risk: '0.62', locked: false, baseBorrowed: 0, quoteBorrowed: 900 }],
        openOrderCount: 3, positionCount: 1, marginCount: 1,
      },
      capital: {
        totalUsd: round(totalUsd, 2), borrowedUsd: round(borrowedUsd, 2),
        unrealisedPnlUsd: round(f * 42, 2),
        borrowedToTotalPct: totalUsd > 0 ? round(borrowedUsd / totalUsd * 100, 4) : null,
        unrealisedToTotalPct: totalUsd > 0 ? round(f * 42 / totalUsd * 100, 4) : null,
        lockedQty: round(holdings.reduce((s, h) => s + (Number(h.locked) || 0), 0), 8),
        availableQty: round(holdings.reduce((s, h) => s + (Number(h.available) || 0), 0), 8),
        lockedSharePct: totalUsd > 0 ? round(lockedUsd / totalUsd * 100, 4) : null,
      },
      notes: [],
      payload: { feeRaw: null, futuresRaw: [], openOrders: null, positions: null, margin: null },
    });
  }
  return rows;
}

/** Generate a complete, internally consistent DEMO dataset. */
function generateFullDemo(now, count, stepSec, symbols) {
  const tss = [];
  for (let i = count - 1; i >= 0; i--) tss.push(now - i * stepSec * 1000);
  const at = (i) => tss[Math.max(0, Math.min(tss.length - 1, i))];
  // Set the market context BEFORE any priceUsd() call below.
  DEMO_CTX = {
    symbols: (symbols && symbols.length ? symbols : DEFAULT_MARKET_SYMBOLS).map(s => String(s).toUpperCase()),
    shocks: DEMO_SHOCKS.map(s => ({
      atSec: at(s.i) / 1000,
      widthSec: Math.max(60, stepSec * 1.2),
      amp: s.amp, category: s.category, title: s.title, impact: s.impact, symbols: s.symbols,
    })),
  };
  const events = buildDemoEvents(tss);
  const prices = buildDemoPrices(tss);
  const snapshots = tss.map(ts => buildSnapshot(ts, events));
  const decisions = buildDemoDecisions(tss);
  const market = buildDemoMarket(tss, stepSec, DEMO_CTX.symbols);
  const macroEvents = buildDemoMacroEvents();
  const enrichment = buildDemoEnrichment(tss, snapshots, DEMO_CTX.symbols);
  return { tss, snapshots, events, prices, decisions, market, macroEvents, enrichment };
}

module.exports = {
  buildSnapshot, generateHistory, generateFullDemo,
  priceUsd, marketFactor, qtyAt,
  buildDemoEvents, buildDemoPrices, buildDemoMarket, buildDemoMacroEvents, buildDemoDecisions,
  buildDemoEnrichment,
  UNIVERSE, QUOTE, DEMO_SHOCKS, round,
};
