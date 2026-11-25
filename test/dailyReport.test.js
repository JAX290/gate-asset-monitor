'use strict';

/**
 * v5.3 daily report: explicit asset time points, split pushes, multi-coin
 * market brief and the rule-based 24h technical bias.
 */
const test = require('node:test');
const assert = require('node:assert');

const daily = require('../src/dailyReport');

const HOUR = 3600e3;
const NOW = Date.UTC(2026, 10, 25, 1, 0, 0);   // 09:00 UTC+8

function candles(symbol, count, stepSec, opts = {}) {
  const base = opts.base === undefined ? 100 : opts.base;
  const slope = opts.slope || 0;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const close = base * (1 + slope * i);   // i=0 is the oldest bar
    rows.push({
      ts: NOW - (count - 1 - i) * stepSec * 1000,
      symbol,
      close,
      high: close * 1.01,
      low: close * 0.99,
      quoteVolume: opts.volume || 1000,
      intervalSec: stepSec,
    });
  }
  return rows;
}

test('资产时间窗取「窗口前最后一个快照」，并打印两端真实时间', () => {
  const snaps = [48, 9, 8, 2, 1, 0].map(h => ({
    ts: NOW - h * HOUR, totalUsd: 100000 - h * 100, mode: 'live',
  }));
  const ws = daily.assetWindows({ snapshots: snaps }, NOW, 8);
  assert.equal(ws.length, 5);
  const w8 = ws.find(w => w.key === '8h');
  assert.equal(w8.ok, true);
  // now-8h 恰好有一个点，必须命中它；不能拿 2h 前那个更新的点冒充。
  assert.equal(w8.fromTs, NOW - 8 * HOUR);
  assert.equal(w8.toTs, NOW);
  assert.match(w8.fromLabel, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.ok(w8.changeUsd > 0, '更早快照更低，当前应显示上涨');
});

test('窗口前没有快照时如实降级，不编造变化值', () => {
  const snaps = [{ ts: NOW - HOUR, totalUsd: 100, mode: 'live' }];
  const ws = daily.assetWindows({ snapshots: snaps }, NOW, 8);
  const w30 = ws.find(w => w.key === '30d');
  assert.equal(w30.ok, false);
  assert.equal(w30.changePct, undefined);
  assert.match(w30.reason, /窗口前无快照/);
});

test('marketBrief 覆盖六个币种且只消费当前 K 线周期', () => {
  const syms = ['BTC', 'ETH', 'LTC', 'DOGE', 'PEARL', 'FIL'];
  const pts = syms.flatMap((s, i) => candles(s, 300, 300, { base: 100 + i, slope: 0.001 })
    .concat([{ ts: NOW, symbol: s, close: 99999, high: 99999, low: 99999, intervalSec: 3600 }]));
  const brief = daily.marketBrief(pts, NOW, syms, 300);
  assert.equal(brief.length, 6);
  assert.deepEqual(brief.map(b => b.symbol), syms);
  assert.notEqual(brief[0].lastPrice, 99999, '旧 1h 点不能污染 5m 简报');
  assert.equal(brief[0].bars, 300);
});

test('24h 高低取真实 24 小时窗口，而不是最近 24 根 K 线', () => {
  const rows = candles('BTC', 300, 300, { base: 100, slope: 0 });
  rows[20].high = 999;     // 约 23.3 小时前，属于 24h 窗口
  rows[295].high = 101;    // 最近 24 根里的最高价
  const b = daily.marketBrief(rows, NOW, ['BTC'], 300)[0];
  assert.equal(b.high24, 999, '必须扫全 288 根，不是最近 24 根');
  assert.ok(b.high7 >= 999);
});

test('build 生成资产/行情两份独立报告，去掉模糊的「上一轮快照」', () => {
  const snaps = [0, 2, 26, 50, 200].map(h => ({ ts: NOW - h * HOUR, totalUsd: 100000 - h, mode: 'live' }));
  const rep = daily.build({
    analysis: { summary: {}, risk: {}, quality: {} },
    market: {}, snapshots: snaps,
    marketPts: candles('BTC', 300, 300, { base: 60000, slope: 0.0001 }),
    summary: { latest: snaps[0] },
    config: {
      market: { symbols: ['BTC'], candleIntervalSec: 300, candleInterval: '5m' },
      report: { tzOffsetHours: 8 },
    },
    now: NOW,
  });
  assert.ok(rep.assetReport && rep.marketReport);
  assert.ok(rep.assetReport.markdownChunks.length >= 1);
  assert.ok(rep.marketReport.markdownChunks.length >= 1);
  assert.doesNotMatch(rep.assetReport.markdown, /较上一次快照|上一轮快照/);
  assert.doesNotMatch(rep.assetReport.markdown, /^\s*>\s*>/m, 'buildMarkdown 已加引用符，bullets 不能再自带 >');
  assert.match(rep.assetReport.markdown, /1 小时/);
  assert.match(rep.marketReport.markdown, /未来 24 小时技术面研判/);
});

test('24h 研判由规则打分得出：单边上行 + 放量 → 偏强', () => {
  const rows = candles('BTC', 300, 300, { base: 60000, slope: 0.002, volume: 1000 });
  for (let i = 150; i < rows.length; i++) rows[i].quoteVolume = 3000; // 近 24h 量比 3x
  const b = daily.marketBrief(rows, NOW, ['BTC'], 300)[0];
  assert.ok(b.outlook, '样本充足时应给出研判');
  assert.ok(b.outlook.score >= 3);
  assert.equal(b.outlook.bias, '偏强');
  assert.ok(b.outlook.projectedHigh > b.lastPrice && b.outlook.projectedLow < b.lastPrice);
});
