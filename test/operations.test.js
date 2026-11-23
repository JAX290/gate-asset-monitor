'use strict';
/**
 * operations: fold raw Gate ledger rows into human-readable operations.
 *
 * Gate's account_book records ONE leg per row, so a single trade arrives as
 * several rows sharing a refId (base leg + quote leg + fee). If this folding
 * regresses, the UI shows duplicate half-trades and fee totals go wrong.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gam-ops-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ACCESS_TOKEN = 'test-token';
process.env.TAILSCALE_ONLY = 'false';

const ops = require('../src/operations');
const T0 = Date.UTC(2026, 0, 1);
test.after(() => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} });

const buyLegs = [
  { id: 'a1', refId: 'r1', ts: T0, type: 'trade', currency: 'BTC', amount: 0.5, amountUsd: 20000, priceUsd: 40000, pair: 'BTC_USDT', side: 'buy', venue: 'spot', source: 'live' },
  { id: 'a2', refId: 'r1', ts: T0, type: 'trade', currency: 'USDT', amount: -20000, amountUsd: -20000, priceUsd: 1, pair: 'BTC_USDT', side: 'buy', venue: 'spot', source: 'live' },
  { id: 'a3', refId: 'r1', ts: T0, type: 'fee', currency: 'USDT', amount: -8, amountUsd: -8, feeUsd: 8, feeCurrency: 'USDT', venue: 'spot', source: 'live' },
];

test('成交折叠：基础腿 + 计价腿 + 手续费 → 一条买入记录', () => {
  const list = ops.buildOperations(buyLegs);
  assert.equal(list.length, 1, '三条腿必须折叠成一条');
  const o = list[0];
  assert.equal(o.kind, 'buy');
  assert.equal(o.symbol, 'BTC');
  assert.equal(o.pair, 'BTC_USDT');
  assert.equal(o.amount, 0.5);
  assert.equal(o.valueUsd, 20000);
  assert.equal(o.feeUsd, 8);
  assert.equal(o.feeCurrency, 'USDT');
  assert.equal(o.legCount, 3);
  assert.deepEqual(o.eventIds.sort(), ['a1', 'a2', 'a3'], '必须能回连原始流水');
});

test('卖出：side=sell 映射为 sell，并且取绝对值展示', () => {
  const legs = [
    { id: 'b1', refId: 'r2', ts: T0 + 1000, type: 'trade', currency: 'ETH', amount: -2, amountUsd: -6000, priceUsd: 3000, pair: 'ETH_USDT', side: 'sell', venue: 'spot', source: 'live' },
    { id: 'b2', refId: 'r2', ts: T0 + 1000, type: 'trade', currency: 'USDT', amount: 6000, amountUsd: 6000, priceUsd: 1, pair: 'ETH_USDT', side: 'sell', venue: 'spot', source: 'live' },
  ];
  const o = ops.buildOperations(legs)[0];
  assert.equal(o.kind, 'sell');
  assert.equal(o.symbol, 'ETH');
  assert.equal(o.amount, 2);
  assert.equal(o.valueUsd, 6000);
});

test('无 refId 的独立流水各自成条，不被错误合并', () => {
  const rows = [
    { id: 'c1', ts: T0, type: 'deposit', currency: 'USDT', amount: 500, amountUsd: 500, isCashflow: true, cashflowUsd: 500, venue: 'wallet', source: 'live' },
    { id: 'c2', ts: T0 + 5000, type: 'withdraw', currency: 'USDT', amount: -200, amountUsd: -200, isCashflow: true, cashflowUsd: -200, venue: 'wallet', source: 'live' },
  ];
  const list = ops.buildOperations(rows);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(o => o.kind).sort(), ['deposit', 'withdraw']);
  // 按 ts DESC 排序
  assert.ok(list[0].ts > list[1].ts);
});

test('注释挂载：按 operationId 关联，未知 id 不影响其它记录', () => {
  const list = ops.buildOperations(buyLegs);
  const annMap = new Map([['r1', { operationId: 'r1', motive: '突破回踩建仓', stopLoss: 36000, takeProfit: 46000 }]]);
  const withAnn = ops.attachAnnotations(list, annMap);
  assert.equal(withAnn[0].annotation.motive, '突破回踩建仓');
  assert.equal(withAnn[0].annotation.stopLoss, 36000);

  const none = ops.attachAnnotations(list, new Map());
  assert.equal(none[0].annotation, undefined);
});

test('summarize：统计条数、买卖笔数、手续费与注释覆盖率', () => {
  const list = ops.buildOperations(buyLegs);
  list[0].annotation = { motive: 'test' };
  const s = ops.summarize(list);
  assert.equal(s.total, 1);
  assert.equal(s.trades, 1);
  assert.equal(s.annotated, 1);
  assert.equal(s.annotationCoveragePct, 100);
  assert.equal(s.feesUsd, 8);
  assert.equal(s.byKind.buy, 1);
});

test('筛选：kinds / symbol / 时间范围 / limit+offset', () => {
  const rows = buyLegs.concat([
    { id: 'd1', refId: 'r3', ts: T0 + 86400000, type: 'trade', currency: 'SOL', amount: 10, amountUsd: 1000, priceUsd: 100, pair: 'SOL_USDT', side: 'buy', venue: 'spot', source: 'live' },
  ]);
  const all = ops.buildOperations(rows);
  assert.equal(all.length, 2);

  assert.equal(ops.buildOperations(rows, { kinds: ['buy'] }).length, 2);
  assert.equal(ops.buildOperations(rows, { symbol: 'SOL' }).length, 1);
  assert.equal(ops.buildOperations(rows, { from: T0 + 1000 }).length, 1);
  assert.equal(ops.buildOperations(rows, { to: T0 + 1000 }).length, 1);

  const page1 = ops.buildOperations(rows, { limit: 1, offset: 0 });
  const page2 = ops.buildOperations(rows, { limit: 1, offset: 1 });
  assert.equal(page1.length, 1);
  assert.equal(page2.length, 1);
  assert.notEqual(page1[0].id, page2[0].id, '分页不得重复同一条');
});

test('未知/空输入不抛异常', () => {
  assert.deepEqual(ops.buildOperations([]), []);
  assert.deepEqual(ops.buildOperations(null), []);
  assert.deepEqual(ops.buildOperations([{ id: 'x' }]).length, 1);
});
