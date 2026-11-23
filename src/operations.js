'use strict';

/**
 * Operations view — PURE FUNCTION, zero dependencies.
 *
 * The `events` fact layer is ALREADY the read-only mirror of the user's real
 * Gate activity (trades / deposits / withdrawals / fees / funding / transfers),
 * each with a stable `id` and, for a trade, a shared `refId` that groups its
 * base leg + quote leg + fee leg into ONE economic operation.
 *
 * This module folds those low-level ledger rows into human-readable
 * "operation records". It is deliberately READ-ONLY: operations come from Gate,
 * never from manual entry. The user's subjective layer (motive / take-profit /
 * stop-loss / review) lives in the separate `annotations` chain and is attached
 * to an operation by its stable `id`.
 *
 * Design notes:
 *  - groupKey = refId when present, else the event's own id. In Gate's
 *    /spot/account_book each row's refId equals its own id, so single ledger
 *    rows are NOT accidentally merged; /spot/my_trades legs DO share a refId.
 *  - kind is normalised to buy|sell|deposit|withdraw|transfer|fee|funding|
 *    interest|realized_pnl|rebate|liquidation|other.
 *  - Every operation keeps its source event ids so a third party can always
 *    join back to the raw `events` table / hash chain.
 */

const KIND_LABEL = {
  buy: '买入', sell: '卖出', deposit: '充值', withdraw: '提现',
  transfer: '划转', fee: '手续费', funding: '资金费', interest: '理财利息',
  realized_pnl: '已实现盈亏', rebate: '返佣返利', liquidation: '强平',
  // Gate /spot/account_book puts most spot activity into a generic `other`
  // bucket and keeps the REAL subtype only inside the `note` text
  // ("原始类型:order_fill 1168..."). Without splitting it, a real account
  // renders as a wall of "其它" — unreadable. These kinds are still
  // CASH-MOVEMENT rows, not full trades: account_book records one leg only,
  // with no pair/side, so a true buy/sell direction is NOT derivable here.
  // Configure GATE_TRADE_PAIRS to additionally pull /spot/my_trades, which
  // DOES carry pair + side and produces real buy/sell operations.
  trade_fill: '成交资金变动', order: '下单/撤单', lend: '理财借出',
  redeem: '理财赎回', award: '奖励发放',
  other: '其它', trade: '成交',
};

/** Gate account_book raw subtype -> our readable kind. */
const RAW_KIND = {
  order_fill: 'trade_fill', new_order: 'order', order_fee: 'fee',
  lend: 'lend', redeem: 'redeem', award: 'award',
  cv_buy: 'buy', cv_sell: 'sell',
  deposit: 'deposit', withdraw: 'withdraw',
};

/** Extract `原始类型:xxx` from the note GateClient writes. */
function rawTypeOf(note) {
  const m = /原始类型:([A-Za-z0-9_]+)/.exec(String(note || ''));
  return m ? m[1] : '';
}

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function s(v) { return v === undefined || v === null ? '' : String(v); }
function r(v, d = 8) { const x = Number(v); return Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : 0; }

/** One event -> a single operation (used when the group has no trade legs). */
function simpleOperation(e) {
  const rawType = rawTypeOf(e.note);
  let kind = s(e.type) || 'other';
  // Split Gate's generic "other" bucket by its real subtype (see RAW_KIND).
  if ((kind === 'other' || kind === '') && RAW_KIND[rawType]) kind = RAW_KIND[rawType];
  const amount = n(e.amount);
  // A trade row from /spot/account_book has no side but a signed change.
  if (kind === 'trade') kind = amount >= 0 ? 'buy' : 'sell';
  let kindLabel = KIND_LABEL[kind] || kind;
  // Direction is visible in the sign for cash-movement rows; say it plainly.
  if (kind === 'trade_fill') kindLabel = amount >= 0 ? '成交入账' : '成交出账';
  const symbol = s(e.currency).toUpperCase();
  return {
    id: s(e.refId) || s(e.id),
    ts: Number(e.ts) || 0,
    kind, kindLabel, rawType,
    side: s(e.side) || (kind === 'buy' ? 'buy' : kind === 'sell' ? 'sell' : ''),
    symbol, pair: s(e.pair),
    amount: r(Math.abs(amount)),
    priceUsd: r(n(e.priceUsd)),
    valueUsd: r(Math.abs(n(e.amountUsd))),
    feeUsd: r(Math.abs(n(e.feeUsd))),
    feeCurrency: s(e.feeCurrency).toUpperCase(),
    venue: s(e.venue) || 'spot',
    isCashflow: !!e.isCashflow,
    cashflowUsd: r(n(e.cashflowUsd)),
    source: s(e.source) || 'live',
    note: s(e.note),
    eventIds: [s(e.id)],
    legCount: 1,
  };
}

/** A group WITH trade legs -> one buy/sell operation (base + quote + fee). */
function tradeOperation(group) {
  const legs = group.slice();
  const withPair = legs.find(x => s(x.pair));
  const pair = s(withPair && withPair.pair);
  const base = pair ? pair.split('_')[0].toUpperCase() : '';
  const quote = pair ? pair.split('_')[1].toUpperCase() : '';

  const tradeLegs = legs.filter(x => s(x.type) === 'trade');
  const feeLegs = legs.filter(x => s(x.type) === 'fee' || n(x.feeUsd) !== 0);
  const main = tradeLegs.find(x => (base && s(x.currency).toUpperCase() === base)) || tradeLegs[0] || legs[0];
  const side = s(main.side) || (n(main.amount) >= 0 ? 'buy' : 'sell');
  const kind = side === 'sell' ? 'sell' : 'buy';

  // Prefer the base leg's absolute USD value; fall back to quote leg or qty*px.
  let valueUsd = Math.abs(n(main.amountUsd));
  if (!valueUsd && quote) {
    const qLeg = tradeLegs.find(x => s(x.currency).toUpperCase() === quote);
    if (qLeg) valueUsd = Math.abs(n(qLeg.amountUsd));
  }
  if (!valueUsd) valueUsd = Math.abs(n(main.amount)) * n(main.priceUsd);

  const feeUsd = feeLegs.reduce((a, x) => a + Math.abs(n(x.feeUsd || x.amountUsd)), 0);
  const feeCurrency = s((feeLegs.find(x => s(x.feeCurrency)) || {}).feeCurrency).toUpperCase() ||
    s((feeLegs[0] || {}).currency).toUpperCase();

  return {
    id: s(main.refId) || s(main.id),
    ts: Number(main.ts) || 0,
    kind, kindLabel: KIND_LABEL[kind], rawType: rawTypeOf(main.note),
    side,
    symbol: base || s(main.currency).toUpperCase(),
    pair,
    amount: r(Math.abs(n(main.amount))),
    priceUsd: r(n(main.priceUsd)),
    valueUsd: r(valueUsd),
    feeUsd: r(feeUsd),
    feeCurrency,
    venue: s(main.venue) || 'spot',
    isCashflow: false,
    cashflowUsd: 0,
    source: s(main.source) || 'live',
    note: legs.map(x => s(x.note)).filter(Boolean).join(' · ').slice(0, 240),
    eventIds: legs.map(x => s(x.id)).filter(Boolean),
    legCount: legs.length,
  };
}

/**
 * Fold raw events into operation records.
 * @param {Array} events  raw event rows from facts.listEvents()
 * @param {object} opts   { limit, offset, kinds[], from, to, symbol }
 * @returns {Array} operations sorted by ts DESC
 */
function buildOperations(events, opts = {}) {
  const groups = new Map();
  for (const e of (events || [])) {
    if (!e) continue;
    const key = s(e.refId) || s(e.id) || `idx-${groups.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  let ops = [];
  for (const [, group] of groups) {
    const hasTrade = group.some(x => s(x.type) === 'trade');
    ops.push(hasTrade ? tradeOperation(group) : simpleOperation(group[0]));
  }
  if (opts.kinds && opts.kinds.length) ops = ops.filter(o => opts.kinds.includes(o.kind));
  if (opts.symbol) ops = ops.filter(o => o.symbol === String(opts.symbol).toUpperCase());
  if (opts.from) ops = ops.filter(o => o.ts >= Number(opts.from));
  if (opts.to) ops = ops.filter(o => o.ts <= Number(opts.to));
  ops.sort((a, b) => b.ts - a.ts || String(a.id).localeCompare(String(b.id)));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 500, 20000));
  return ops.slice(offset, offset + limit);
}

/** Attach folded annotations (keyed by operationId) onto operations. */
function attachAnnotations(ops, annMap) {
  const m = annMap instanceof Map ? annMap : new Map(Object.entries(annMap || {}));
  return ops.map(o => Object.assign({}, o, { annotation: m.get(o.id) || null, annotated: m.has(o.id) }));
}

/** Coverage stats for the operations view header. */
function summarize(ops) {
  const byKind = {};
  let annotated = 0, trades = 0, fees = 0, cashflow = 0;
  for (const o of ops) {
    byKind[o.kind] = (byKind[o.kind] || 0) + 1;
    if (o.annotation || o.annotated) annotated++;
    if (o.kind === 'buy' || o.kind === 'sell') trades++;
    fees += n(o.feeUsd);
    if (o.isCashflow) cashflow++;
  }
  return {
    total: ops.length, byKind, annotated,
    annotationCoveragePct: ops.length ? r(annotated / ops.length * 100, 2) : 0,
    trades, feesUsd: r(fees, 2), cashflow,
  };
}

module.exports = { buildOperations, attachAnnotations, summarize, KIND_LABEL, tradeOperation, simpleOperation };
