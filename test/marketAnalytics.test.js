'use strict';
/**
 * marketAnalytics: portfolio vs BTC/ETH comparison.
 *
 * The single most important property here is NO LOOK-AHEAD: at snapshot time t
 * the comparison may only use the last benchmark candle with ts <= t. If this
 * regresses, every "beat the market" number becomes a fantasy.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gam-mkt-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ACCESS_TOKEN = 'test-token';
process.env.TAILSCALE_ONLY = 'false';

const mk = require('../src/marketAnalytics');
const analytics = require('../src/analytics');

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60000;
test.after(() => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} });

function candle(symbol, ts, close) {
  return { symbol, ts, open: close, high: close, low: close, close, volume: 1, quoteVolume: 1000, interval: '5m' };
}
function navPoint(ts, navPerUnit) {
  return { ts, navPerUnit, totalUsd: 1000 * navPerUnit, twr: navPerUnit - 1 };
}

test('asOf：只使用 ts <= t 的最近一根 K 线，绝不前视', () => {
  const market = [candle('BTC', T0, 100), candle('BTC', T0 + MIN, 200), candle('BTC', T0 + 2 * MIN, 300)];
  const axis = [{ ts: T0 + 30 * 1000 }, { ts: T0 + MIN + 30 * 1000 }, { ts: T0 + 2 * MIN + 30 * 1000 }];
  const out = mk.asOf('BTC', axis, market, []);
  assert.ok(out);
  assert.equal(out.source, 'market');
  assert.deepEqual(out.values, [100, 200, 300], '必须取「当时的」价格，而不是下一根');
});

test('asOf：t 早于所有 K 线时返回 null 而不是硬塞未来价格', () => {
  const market = [candle('BTC', T0 + 10 * MIN, 500)];
  const out = mk.asOf('BTC', [{ ts: T0 }], market, []);
  assert.ok(out);
  assert.equal(out.values[0], null, '窗口前无行情应留空，交由上层裁剪');
});

test('asOf：market 缺失时回退到 prices 链', () => {
  const prices = [{ currency: 'BTC', ts: T0, priceUsd: 42 }, { currency: 'BTC', ts: T0 + MIN, priceUsd: 44 }];
  const out = mk.asOf('BTC', [{ ts: T0 + MIN }], [], prices);
  assert.equal(out.source, 'prices');
  assert.equal(out.values[0], 44);
});

test('asOf：完全没有该币行情时返回 null', () => {
  assert.equal(mk.asOf('DOGE', [{ ts: T0 }], [], []), null);
});

test('asOf：同一时间戳重复行情取最后一条（不产生抖动）', () => {
  const market = [candle('BTC', T0, 100), candle('BTC', T0, 111)];
  const out = mk.asOf('BTC', [{ ts: T0 }], market, []);
  assert.deepEqual(out.values, [111]);
});

test('relativeMetrics：资产完全复制基准 → beta≈1、超额≈0、跟踪误差≈0', () => {
  const bench = [100, 110, 99, 105];
  const m = mk.relativeMetrics(bench.slice(), bench.slice(), (105 / 100 - 1) * 100, (105 / 100 - 1) * 100);
  assert.ok(Math.abs(m.beta - 1) < 1e-6, `beta=${m.beta}`);
  assert.ok(Math.abs(m.correlation - 1) < 1e-6, `corr=${m.correlation}`);
  assert.ok(Math.abs(m.excessPct) < 1e-9, `excess=${m.excessPct}`);
  assert.ok(Math.abs(m.trackingErrorPct) < 1e-9, `te=${m.trackingErrorPct}`);
});

test('relativeMetrics：资产翻倍而基准不动 → 超额为正、beta≈0', () => {
  const bench = [100, 100, 100];
  const nav = [100, 200, 200];
  const m = mk.relativeMetrics(nav, bench, 100, 0);
  assert.ok(m.excessPct > 99, `excess=${m.excessPct}`);
  assert.ok(Math.abs(m.beta) < 1e-9, `beta=${m.beta}`);
});

test('compute：归一化起点为 100，且 points 与 axis 一一对应', () => {
  const axis = [0, 1, 2, 3].map(i => navPoint(T0 + i * MIN, [1, 1.1, 1.05, 1.2][i]));
  const analysis = { nav: axis };
  const market = [0, 1, 2, 3].map(i => candle('BTC', T0 + i * MIN, [100, 102, 101, 108][i]))
    .concat([0, 1, 2, 3].map(i => candle('ETH', T0 + i * MIN, [10, 10.1, 10.2, 10.3][i])));

  const out = mk.compute({ snapshots: [], events: [], prices: [], market, macroEvents: [], decisions: [] }, analysis, {
    symbols: ['BTC', 'ETH'], indexWeights: { BTC: 0.6, ETH: 0.4 }, mode: 'mock',
  });

  assert.equal(out.meta.points, 4);
  assert.ok(out.points.length >= 4);
  // normalized 是宽表：一行一个时间戳，各序列一个字段
  const n0 = out.normalized.find(x => x.ts === T0);
  assert.ok(n0 && Math.abs(n0.BTC - 100) < 1e-9, '归一化首点必须是 100');
  assert.ok(n0 && Math.abs(n0.NAV - 100) < 1e-9, 'NAV 归一化首点必须是 100');
  const nLast = out.normalized[out.normalized.length - 1];
  assert.ok(Math.abs(nLast.BTC - 108) < 1e-6, `BTC 末点应为 108，实际 ${nLast.BTC}`);
  assert.ok(out.conclusion && typeof out.conclusion.text === 'string' && out.conclusion.text.length > 0, '必须给出结论文字');
});

test('compute：快照不足 2 个时明确返回原因，而不是编造数字', () => {
  const out = mk.compute({ snapshots: [], events: [], prices: [], market: [], decisions: [] },
    { nav: [navPoint(T0, 1)] }, { symbols: ['BTC'] });
  assert.equal(out.meta.points, 0);
  assert.ok(out.meta.reason && out.meta.reason.includes('2 个快照'));
  assert.deepEqual(out.points, []);
});

test('compute：没有基准行情时返回原因，不伪造基准', () => {
  const analysis = { nav: [navPoint(T0, 1), navPoint(T0 + MIN, 1.05)] };
  const out = mk.compute({ snapshots: [], events: [], prices: [], market: [], decisions: [] }, analysis, { symbols: ['BTC'] });
  assert.equal(out.meta.points, 0);
  assert.match(out.meta.reason, /基准行情/);
});

test('与 analytics 串联：DEMO 数据跑通且相对指标有限', () => {
  const mock = require('../src/mockData');
  const ds = mock.generateFullDemo(Date.now(), 60, 300, ['BTC', 'ETH']);
  const a = analytics.compute({ snapshots: ds.snapshots, events: ds.events, prices: ds.prices, decisions: ds.decisions }, { mode: 'mock' });
  const out = mk.compute({ snapshots: ds.snapshots, events: ds.events, prices: ds.prices, market: ds.market, macroEvents: ds.macroEvents, decisions: ds.decisions }, a, { symbols: ['BTC', 'ETH'], mode: 'mock' });
  assert.ok(out.meta.points >= 2);
  assert.ok(out.relativeRows.length >= 1);
  for (const t of ['BTC', 'ETH']) {
    const row = out.relativeRows.find(r => r.symbol === t);
    if (!row) continue;
    for (const k of ['excessPct', 'beta', 'correlation']) {
      const v = row[k];
      assert.ok(v === null || Number.isFinite(v), `${t}.${k} 非有限值: ${v}`);
    }
  }
});
