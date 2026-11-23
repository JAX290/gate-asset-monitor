'use strict';
/** Login limiter: sliding window, per IP, success resets, bounded lock. */
const test = require('node:test');
const assert = require('node:assert');
const guard = require('../src/loginGuard');

const T0 = 1_700_000_000_000;
const cfg = { maxAttempts: 3, windowSec: 60, lockSec: 60 };

test('前 N-1 次失败仍允许尝试', () => {
  const s = new Map();
  assert.equal(guard.check(s, 'ip1', T0, cfg).allowed, true);
  guard.record(s, 'ip1', false, T0, cfg);
  guard.record(s, 'ip1', false, T0 + 1000, cfg);
  assert.equal(guard.check(s, 'ip1', T0 + 2000, cfg).allowed, true);
});

test('达到阈值后 429，并返回正的 Retry-After', () => {
  const s = new Map();
  for (let i = 0; i < 3; i++) guard.record(s, 'ip1', false, T0 + i * 1000, cfg);
  const r = guard.check(s, 'ip1', T0 + 3000, cfg);
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterSec > 0 && r.retryAfterSec <= 60);
});

test('不同 IP 互不影响', () => {
  const s = new Map();
  for (let i = 0; i < 3; i++) guard.record(s, 'ip1', false, T0 + i * 1000, cfg);
  assert.equal(guard.check(s, 'ip1', T0 + 3000, cfg).allowed, false);
  assert.equal(guard.check(s, 'ip2', T0 + 3000, cfg).allowed, true);
});

test('成功登录清空该 IP 的历史', () => {
  const s = new Map();
  for (let i = 0; i < 3; i++) guard.record(s, 'ip1', false, T0 + i * 1000, cfg);
  guard.record(s, 'ip1', true, T0 + 4000, cfg);
  assert.equal(guard.check(s, 'ip1', T0 + 5000, cfg).failures, 0);
  assert.equal(guard.check(s, 'ip1', T0 + 5000, cfg).allowed, true);
});

test('滑出窗口的旧失败不再计数', () => {
  const s = new Map();
  for (let i = 0; i < 3; i++) guard.record(s, 'ip1', false, T0 + i * 1000, cfg);
  assert.equal(guard.check(s, 'ip1', T0 + 61_000, cfg).allowed, true);
});

test('默认配置是 5 次 / 5 分钟', () => {
  const s = new Map();
  for (let i = 0; i < 4; i++) guard.record(s, 'x', false, T0 + i * 1000);
  assert.equal(guard.check(s, 'x', T0 + 4000).allowed, true);
  guard.record(s, 'x', false, T0 + 4000);
  assert.equal(guard.check(s, 'x', T0 + 5000).allowed, false);
});
