'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mw = require('../src/marketWindow');

const NOW = Date.parse('2026-11-25T09:00:00.000Z');
const DAY = 86400 * 1000;

test('四个默认快捷区间都可用，24H 是缺省', () => {
  for (const p of ['24H', '7D', '30D', '180D']) {
    const r = mw.resolve({ preset: p, now: NOW });
    assert.equal(r.ok, true, p);
    assert.equal(r.toMs, NOW);
    assert.equal(r.fromMs, NOW - mw.PRESETS[p]);
  }
  const def = mw.resolve({ now: NOW });
  assert.equal(def.preset, '24H');
  assert.equal(def.fromMs, NOW - DAY);
});

test('自定义日期按 UTC 0 点起、次日 0 点前一毫秒止', () => {
  const r = mw.resolve({ fromDate: '2026-11-20', toDate: '2026-11-22', now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.fromMs, Date.parse('2026-11-20T00:00:00.000Z'));
  assert.equal(r.toMs, Date.parse('2026-11-22T23:59:59.999Z'));
  assert.equal(r.manual, true);
  assert.equal(r.source, 'utc-dates');
  assert.equal(r.fromLabel, '2026-11-20T00:00:00.000Z');
  assert.equal(r.toLabel, '2026-11-22T23:59:59.999Z');
});

test('自定义日期优先于 preset，且不会与浏览器时区互相污染', () => {
  const r = mw.resolve({ preset: '7D', fromDate: '2026-11-24', now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.preset, null);
  assert.equal(r.fromMs, Date.parse('2026-11-24T00:00:00.000Z'));
  assert.equal(r.toMs, NOW);
});

test('未到结束日的未来日期被夹到当前时刻，避免前视', () => {
  const r = mw.resolve({ fromDate: '2026-11-24', toDate: '2026-12-01', now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.toMs, NOW);
});

test('无效日期、倒序日期与非法参数都被拒绝', () => {
  assert.equal(mw.resolve({ fromDate: '2026-02-31', now: NOW }).error, 'BAD_FROM_DATE');
  assert.equal(mw.resolve({ toDate: '2026-11-', now: NOW }).error, null); // not a date input -> ignored
  assert.equal(mw.resolve({ fromDate: '2026-11-24', toDate: '2026-11-20', now: NOW }).error, 'BAD_WINDOW');
  assert.equal(mw.resolve({ from: NOW + 1000, now: NOW }).error, 'BAD_WINDOW');
});

test('utcDateInput 输出 UTC 日历日', () => {
  assert.equal(mw.utcDateInput(Date.parse('2026-11-24T23:30:00.000Z')), '2026-11-24');
});
