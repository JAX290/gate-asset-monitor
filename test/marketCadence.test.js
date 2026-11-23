'use strict';

/**
 * Benchmark candles must never be sparser than asset snapshots, otherwise the
 * BTC/ETH comparison becomes a step function and the two charts drift apart.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mc = require('../src/marketCadence');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gam-cadence-'));
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

function loadConfig(env) {
  const emptyEnv = path.join(TMP, `.env-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(emptyEnv, '', 'utf8');
  process.env.ENV_FILE = emptyEnv;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = v;
  }
  delete require.cache[require.resolve('../src/config')];
  return require('../src/config');
}

test('5 分钟快照默认使用 5 分钟 K 线，而不是 1 小时', () => {
  const cfg = loadConfig({
    SNAPSHOT_INTERVAL_SEC: '300',
    MARKET_CANDLE_INTERVAL: undefined,
  });
  assert.equal(cfg.collector.intervalSec, 300);
  assert.equal(cfg.market.candleIntervalSec, 300);
  assert.equal(cfg.market.candleInterval, '5m');
  assert.equal(cfg.market.marketSync.aligned, true);
  assert.equal(cfg.market.marketSync.snapshotsPerCandle, 1);
  assert.equal(cfg.market.eventThresholdPct, 3, '默认阈值保持 3%，避免 5m K 线刷屏');
  assert.equal(cfg.market.eventWindowBars, 12);
  assert.equal(cfg.market.lookbackDays, 30, '30d @5m = 8640 bars, within the 10000-bar cap');
});

test('显式配置的 1h 被下调：基准不能比资产快照更稀疏', () => {
  const cfg = loadConfig({
    SNAPSHOT_INTERVAL_SEC: '300',
    MARKET_CANDLE_INTERVAL: '1h',
  });
  assert.equal(cfg.market.candleIntervalSec, 300);
  assert.equal(cfg.market.candleInterval, '5m');
  assert.equal(cfg.market.candleIntervalAdjusted, true);
});

test('更细的 K 线被保留（只提高密度，不降低）', () => {
  const cfg = loadConfig({
    SNAPSHOT_INTERVAL_SEC: '900',
    MARKET_CANDLE_INTERVAL: '1m',
  });
  assert.equal(cfg.market.candleIntervalSec, 60);
  assert.equal(cfg.market.candleInterval, '1m');
  assert.equal(cfg.market.candleIntervalAdjusted, false);
  assert.equal(cfg.market.marketSync.snapshotsPerCandle, 15);
});

test('1 分钟 K 线自动缩短回看窗口，避免超过 Gate 10000 根上限', () => {
  assert.equal(mc.capLookbackDays(30, 60), 6);
  assert.equal(mc.capLookbackDays(30, 300), 30);
  assert.ok(6 * 86400 / 60 <= 10000);
});

test('interval 切换后只把当前周期的行情喂给图表，旧 1h 留在原始导出里', () => {
  const old = { ts: 1000, symbol: 'BTC', close: 10, intervalSec: 3600 };
  const fresh = { ts: 1000, symbol: 'BTC', close: 11, intervalSec: 300 };
  const next = { ts: 1300, symbol: 'BTC', close: 12, intervalSec: 300 };
  assert.deepEqual(mc.activeMarketPoints([old, fresh, next], 300), [fresh, next]);
  // Fresh install / legacy chain: no exact match -> fail open with all rows.
  assert.deepEqual(mc.activeMarketPoints([old], 300), [old]);
});

test('Gate 分页窗口最多覆盖 limit 根 K 线，避免 INVALID_PARAM_VALUE', () => {
  const to = 1795424723;
  const from = to - 30 * 86400;
  const w = mc.candlePageWindow(from, to, 300, 1000);
  assert.ok((w.to - w.from) / 300 <= 990, 'Gate 两端都计数，1000 根也会被拒绝');
  assert.ok(w.from > from, '必须向后翻页，而不是固定 from 反复请求');
  const small = mc.candlePageWindow(to - 100, to, 300, 1000);
  assert.equal(small.from, to - 100, '短窗口不应被错误裁剪');
});

test('切换周期后不能用旧 K 线当增量游标，否则只补最后一点数据', () => {
  const legacy = [{ ts: 1000, intervalSec: 3600, close: 10 }];
  assert.equal(mc.lastActiveMarketTs(legacy, 300), null);
  const mixed = legacy.concat([
    { ts: 900, intervalSec: 300, close: 11 },
    { ts: 1200, intervalSec: 300, close: 12 },
  ]);
  assert.equal(mc.lastActiveMarketTs(mixed, 300), 1200);
});

test('syncMeta 在异常配置下如实标记 COARSER，而不是掩盖', () => {
  assert.equal(mc.syncMeta(300, 3600).aligned, false);
  assert.equal(mc.syncMeta(300, 300).aligned, true);
});
