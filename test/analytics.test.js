'use strict';
/**
 * analytics: NAV / TWR / XIRR / three-factor attribution / risk.
 *
 * These numbers drive real decisions, so the tests pin down the invariants
 * that are easy to break silently:
 *   - a pure deposit must NOT show up as return (cashflow stripping)
 *   - per-interval attribution must close exactly (Σ per-coin + residual = Δtotal)
 *   - max drawdown must be measured on cashflow-adjusted NAV
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gam-ana-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ACCESS_TOKEN = 'test-token';
process.env.TAILSCALE_ONLY = 'false';

const analytics = require('../src/analytics');
const mock = require('../src/mockData');

const DAY = 86400000;
test.after(() => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} });

function snap(ts, totalUsd, holdings = []) {
  return { ts, totalUsd, totalCurrency: 'USD', holdings, accounts: [], notes: [], mode: 'live' };
}
function hold(currency, amount, valueUsd) {
  return { currency, amount, available: amount, locked: 0, priceUsd: amount ? valueUsd / amount : 0, valueUsd };
}

test('xirr：单期 +10% 精确解、零收益、无符号变化返回 null', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const one = analytics.xirr([{ t: t0, cf: -100 }, { t: t0 + 365 * DAY, cf: 110 }], 365 * DAY);
  assert.ok(Math.abs(one - 0.1) < 1e-6, `期望 0.1，实际 ${one}`);

  const flat = analytics.xirr([{ t: t0, cf: -100 }, { t: t0 + 365 * DAY, cf: 100 }], 365 * DAY);
  assert.ok(Math.abs(flat) < 1e-6, `期望 0，实际 ${flat}`);

  assert.equal(analytics.xirr([{ t: t0, cf: -100 }], 365 * DAY), null);
});

test('现金流剥离：纯充值 100 不计入收益（TWR 必须为 0）', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const out = analytics.compute({
    snapshots: [snap(t0, 100), snap(t0 + DAY, 200)],
    events: [{ id: 'd1', ts: t0 + DAY / 2, type: 'deposit', isCashflow: true, cashflowUsd: 100, currency: 'USDT', amount: 100, source: 'live' }],
    prices: [], decisions: [],
  }, { mode: 'live' });
  assert.ok(Math.abs(out.summary.twr) < 1e-9, `TWR 应为 0，实际 ${out.summary.twr}`);
  assert.equal(out.summary.netCashflowUsd, 100);
  assert.equal(out.summary.rawChangeUsd, 100, '原始变动仍是 +100（现金流与收益分开呈现）');
});

test('最大回撤：100→120→90 应为 -25%', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const out = analytics.compute({
    snapshots: [snap(t0, 100), snap(t0 + DAY, 120), snap(t0 + 2 * DAY, 90)],
    events: [], prices: [], decisions: [],
  }, { mode: 'live' });
  assert.ok(Math.abs(out.risk.maxDrawdownPct - (-25)) < 1e-6, `期望 -25，实际 ${out.risk.maxDrawdownPct}`);
});

test('三段归因：每个区间的 Σ逐币种Δ + 残差 必须等于 Δ总资产', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const s0 = snap(t0, 1000, [hold('BTC', 0.01, 600), hold('ETH', 0.1, 400)]);
  const s1 = snap(t0 + DAY, 1200, [hold('BTC', 0.01, 800), hold('ETH', 0.1, 400)]);
  const out = analytics.compute({ snapshots: [s0, s1], events: [], prices: [], decisions: [] }, { mode: 'live' });

  const byInterval = new Map();
  for (const row of out.attribution) {
    const k = row.toTs;
    byInterval.set(k, (byInterval.get(k) || 0) + row.deltaValueUsd);
  }
  assert.equal(byInterval.size, 1);
  const totalDelta = 1200 - 1000;
  for (const [k, sum] of byInterval) {
    assert.ok(Math.abs(sum - totalDelta) < 0.02, `区间 ${k}: Σ=${sum} vs Δ=${totalDelta}`);
  }
  // BTC 涨 200、ETH 不动 → BTC 的价格效应应为 +200，数量/交叉为 0
  const btc = out.attribution.find(x => x.currency === 'BTC');
  assert.ok(Math.abs(btc.priceEffect - 200) < 0.01, `priceEffect=${btc.priceEffect}`);
  assert.equal(btc.qtyEffect, 0);
  assert.equal(btc.crossEffect, 0);
});

test('consistentRun：mock/live 混写时只保留占多数的那一段，避免假暴跌', () => {
  const rows = [
    { ts: 1, mode: 'mock' }, { ts: 2, mode: 'mock' },
    { ts: 3, mode: 'live' }, { ts: 4, mode: 'live' }, { ts: 5, mode: 'live' },
  ];
  const kept = analytics.consistentRun(rows, 'mode');
  assert.equal(kept.length, 3);
  assert.ok(kept.every(x => x.mode === 'live'));
});

test('compute：DEMO 全量数据下结构完整、无 NaN 泄漏', () => {
  const ds = mock.generateFullDemo(Date.now(), 48, 3600, ['BTC', 'ETH']);
  const out = analytics.compute({
    snapshots: ds.snapshots, events: ds.events, prices: ds.prices,
    decisions: ds.decisions, market: ds.market, macroEvents: ds.macroEvents,
  }, { mode: 'mock' });

  for (const key of ['meta', 'summary', 'nav', 'attribution', 'attributionAgg', 'risk', 'costs', 'behavior', 'distribution', 'concentration', 'quality']) {
    assert.ok(out[key] !== undefined, `缺少字段 ${key}`);
  }
  assert.equal(out.meta.snapshotCount, ds.snapshots.length);
  assert.ok(out.nav.length >= 2);
  for (const p of out.nav) {
    assert.ok(Number.isFinite(p.navPerUnit), 'navPerUnit 必须是有限数');
    assert.ok(Number.isFinite(p.twr), 'twr 必须是有限数');
    assert.ok(p.periodReturn === 0 || Number.isFinite(p.periodReturn), 'periodReturn 不得为 NaN');
    assert.ok(p.drawdown <= 0, '回撤必须 <= 0');
  }
  const bad = out.attributionAgg.filter(a => !Number.isFinite(a.deltaValueUsd));
  assert.equal(bad.length, 0, '归因聚合出现非数值');
  assert.ok(out.quality.hashChainOk !== undefined);
});

test('compute：空输入不抛异常（首次启动 / 数据被清空）', () => {
  const out = analytics.compute({ snapshots: [], events: [], prices: [], decisions: [] }, { mode: 'mock' });
  assert.equal(out.summary.totalUsd, null);
  assert.equal(out.summary.twrPct, 0);
  assert.deepEqual(out.nav, []);
});
