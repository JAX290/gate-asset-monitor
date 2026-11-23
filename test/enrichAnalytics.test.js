'use strict';
/**
 * enrichAnalytics: turn raw extended-API snapshots into a SMALL headline plus
 * exportable long tables. The headline is what the dashboard shows, so the
 * "no data" cases must stay honest instead of rendering +0% or +null%.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gam-enr-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ACCESS_TOKEN = 'test-token';
process.env.TAILSCALE_ONLY = 'false';

const enr = require('../src/enrichAnalytics');

const T0 = Date.UTC(2026, 0, 1);
test.after(() => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} });

function sample(ts = T0, over = {}) {
  return Object.assign({
    id: 'en-' + ts, ts, source: 'live', pairs: 2160, notes: [], payload: {},
    breadth: {
      usdtPairs: 2010, advancers: 1000, decliners: 900, unchanged: 110,
      upRatioPct: 49.7, medianChangePct: 1.0, meanChangePct: 1.2, totalQuoteVolumeUsd: 1.8e9,
    },
    holdingsDetail: [
      { currency: 'BTC', pair: 'BTC_USDT', last: 40000, change24Pct: 5, high24h: 41000, low24h: 39000, amplitude24Pct: 5.1, quoteVolumeUsd: 1e6, spreadPct: 0.005 },
      { currency: 'ETH', pair: 'ETH_USDT', last: 3000, change24Pct: 2, high24h: 3050, low24h: 2950, amplitude24Pct: 3.4, quoteVolumeUsd: 8e5, spreadPct: 0.008 },
    ],
    fee: { takerFeePct: 0.2, makerFeePct: 0.15, gtDiscountPct: 0 },
    futures: [{ contract: 'BTC_USDT', fundingRatePct: 0.01, openInterest: 1000, markPrice: 40010, indexPrice: 40000, liqPrice: 0 }],
    books: [{ pair: 'BTC_USDT', bids: [[39999, 1]], asks: [[40001, 1]], spreadPct: 0.005 }],
    account: {
      openOrderCount: 3, positionCount: 1, marginCount: 1,
      openOrders: [{ pair: 'BTC_USDT', total: 2, sides: ['buy', 'sell'] }],
      positions: [{ contract: 'BTC_USDT', size: 0.01, leverage: '5', liqPrice: 30000, markPrice: 40000, unrealisedPnl: 12 }],
      margin: [{ pair: 'BTC_USDT', risk: 'low', baseBorrowed: 0, quoteBorrowed: 100, locked: false }],
    },
    capital: { totalUsd: 10000, borrowedUsd: 0, unrealisedPnlUsd: 0, borrowedToTotalPct: 0, unrealisedToTotalPct: 0, lockedQty: 1, availableQty: 9, lockedSharePct: 10 },
  }, over);
}

test('buildTables：空输入返回 8 张空表，不抛异常', () => {
  const t = enr.buildTables([]);
  for (const k of ['enrichment', 'ticker_detail', 'market_breadth', 'fee_schedule', 'order_book_depth', 'futures_market', 'account_state', 'capital_usage']) {
    assert.ok(Array.isArray(t[k]), `缺少表 ${k}`);
    assert.equal(t[k].length, 0, `${k} 应为空`);
  }
});

test('buildTables：一条快照展开为多张长表，行数与明细数量一致', () => {
  const t = enr.buildTables([sample(T0), sample(T0 + 3600000)]);
  assert.equal(t.enrichment.length, 2);
  assert.equal(t.market_breadth.length, 2);
  assert.equal(t.ticker_detail.length, 4, '2 个周期 × 2 个持仓币');
  assert.ok(t.fee_schedule.length >= 1);
  assert.ok(t.futures_market.length >= 1);
  assert.ok(t.order_book_depth.length >= 1);
  // 开仓 + 持仓 + 杠杆各一条 → 每周期 3 行，两个周期 6 行
  assert.equal(t.account_state.length, 6);
  assert.equal(t.capital_usage.length, 2);
  assert.deepEqual(t.account_state.map(x => x.kind).sort(), ['margin', 'margin', 'open_order', 'open_order', 'position', 'position']);
  // 关键：全市场 2160 对不能整表落盘，只保留聚合与持仓明细
  assert.ok(t.ticker_detail.length < 10);
});

test('relativeStrength：按市值加权、稳定币按 0 参与总组合收益', () => {
  const detail = [
    { currency: 'BTC', change24Pct: 5 },
    { currency: 'ETH', change24Pct: 2 },
  ];
  const holdings = [
    { currency: 'BTC', valueUsd: 500 },
    { currency: 'USDT', valueUsd: 500 },
  ];
  const rs = enr.relativeStrength(detail, { medianChangePct: 1 }, holdings);
  // 组合口径 = 全部持仓的市值加权，稳定币不动 → (500*5 + 500*0)/1000 = 2.5
  assert.equal(rs.portfolio24hPct, 2.5);
  assert.equal(rs.coveragePct, 100);
  assert.equal(rs.excessVsMarketPct, 1.5);
  assert.equal(rs.verdict, '强于大盘');
});

test('relativeStrength：缺数据时返回「数据不足」而不是 0%', () => {
  const rs = enr.relativeStrength([], { medianChangePct: 1 }, [{ currency: 'XYZ', valueUsd: 100 }]);
  assert.equal(rs.portfolio24hPct, null);
  assert.equal(rs.excessVsMarketPct, null);
  assert.equal(rs.verdict, '数据不足');
});

test('feeAudit：名义费率与账本实扣分开统计，可对齐 maker 比例', () => {
  const events = [
    { type: 'fee', feeUsd: 3 },
    { type: 'trade', feeUsd: 1.5, role: 'maker' },
    { type: 'trade', feeUsd: 2.5, role: 'taker' },
  ];
  const fa = enr.feeAudit({ takerFeePct: 0.2, makerFeePct: 0.15 }, { totalExplicitCostUsd: 7, makerRatioPct: 40 }, events);
  assert.equal(fa.nominalTakerFeePct, 0.2);
  assert.equal(fa.nominalMakerFeePct, 0.15);
  assert.equal(fa.actualFeesUsd, 7, '账本实扣 = 所有 fee 事件绝对值之和');
  assert.equal(fa.explicitCostUsd, 7);
  assert.equal(fa.makerRatioPct, 40);
  assert.equal(fa.feeEventCount, 3);
  assert.ok(fa.note.includes('口径不同'));
});

test('buildChains：按 note 解析链上充提，未知链归为 UNKNOWN', () => {
  const rows = enr.buildChains([
    { isCashflow: true, type: 'deposit', cashflowUsd: 100, ts: T0, note: '链上充值 · TRC20' },
    { isCashflow: true, type: 'withdraw', cashflowUsd: -40, ts: T0 + 1000, note: '链上提现 · ERC20' },
    { isCashflow: true, type: 'deposit', cashflowUsd: 10, ts: T0 + 2000, note: '无链信息' },
    { isCashflow: false, type: 'trade', cashflowUsd: 0, ts: T0, note: '链上充值 · 不应统计' },
  ]);
  const trc = rows.find(r => r.chain === 'TRC20');
  assert.ok(trc);
  assert.equal(trc.deposits, 1);
  assert.equal(trc.volume_usd, 100);
  const erc = rows.find(r => r.chain === 'ERC20');
  assert.equal(erc.withdraws, 1);
  assert.ok(rows.find(r => r.chain === 'UNKNOWN'));
  assert.equal(rows.length, 3, '非现金流事件必须被忽略');
});

test('compute：无数据时 headline 诚实提示累积中，summary.available=false', () => {
  const out = enr.compute({ enrichment: [], events: [] });
  assert.equal(out.available, false);
  assert.match(out.headline, /累积/);
  assert.equal(out.summary.relativeVerdict, '数据不足');
  assert.ok(out.tables && out.tables.deposit_chains);
});

test('compute：有数据时 headline 含涨跌家数，summary 数值有限', () => {
  const out = enr.compute({
    enrichment: [sample(T0)],
    events: [],
    analysis: { costs: { totalExplicitCostUsd: 0 } },
    latestSnapshot: { holdings: [{ currency: 'BTC', valueUsd: 500 }, { currency: 'USDT', valueUsd: 500 }] },
  });
  assert.equal(out.available, true);
  assert.match(out.headline, /涨/);
  assert.match(out.headline, /跌/);
  assert.equal(out.summary.portfolio24hPct, 2.5);
  assert.equal(out.summary.relativeVerdict, '强于大盘');
  for (const k of ['upRatioPct', 'medianChangePct', 'totalQuoteVolumeUsd', 'lockedSharePct']) {
    assert.ok(Number.isFinite(out.summary[k]), `${k} 应为有限数，实际 ${out.summary[k]}`);
  }
  assert.ok(!/null/.test(out.headline), `headline 不应出现 null: ${out.headline}`);
});
