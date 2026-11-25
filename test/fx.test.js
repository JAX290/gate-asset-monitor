'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fx = require('../src/fx');

const NOW = Date.parse('2026-11-25T01:00:00.000Z');

test('主/备两个公开源的解析器都得到同一个 USD→CNY 口径', () => {
  const a = fx.parsePrimary({
    result: 'success',
    rates: { CNY: 6.678179, EUR: 0.9 },
    time_last_update_unix: Math.floor(NOW / 1000) - 3600,
  }, NOW);
  const b = fx.parseFallback({ date: '2026-11-24', usd: { cny: 6.678179 } }, NOW);
  assert.equal(a.rate, 6.678179);
  assert.equal(b.rate, 6.678179);
  assert.equal(a.base, 'USD'); assert.equal(b.quote, 'CNY');
  assert.match(a.rateLabel, /1 USD = 6.6782 CNY/);
  assert.equal(a.stale, false);
});

test('异常/缺失载荷返回 null，绝不把 0 当汇率', () => {
  assert.equal(fx.parsePrimary({ result: 'error' }, NOW), null);
  assert.equal(fx.parsePrimary({ result: 'success', rates: { CNY: 0 } }, NOW), null);
  assert.equal(fx.parseFallback({ usd: {} }, NOW), null);
  assert.equal(fx.normaliseCached({ rate: -1 }), null);
});

test('主源失败时自动回退备用源并写入 .runtime 缓存', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gam-fx-'));
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url === fx.PRIMARY) return { ok: false, status: 502 };
    return { ok: true, json: async () => ({ date: '2026-11-24', usd: { cny: 6.7 } }) };
  };
  const client = fx.createFxClient({ root, ttlMs: 60000, fetchFn, nowFn: () => NOW });
  const rec = await client.refresh(true);
  assert.equal(rec.rate, 6.7);
  assert.equal(rec.provider, fx.parseFallback({ date: 'x', usd: { cny: 1 } }, 0).provider);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(client.cachePath, 'utf8')).rate, 6.7);
});

test('两个源都失败时返回上次缓存并如实标 stale；无缓存则 rate=null', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gam-fx-'));
  const bad = async () => ({ ok: false, status: 503 });
  const empty = fx.createFxClient({ root, ttlMs: 1000, fetchFn: bad, nowFn: () => NOW });
  assert.equal(empty.current().rate, null);
  assert.equal((await empty.refresh(true)).stale, true);

  const stored = fx.parsePrimary({ result: 'success', rates: { CNY: 6.6 }, time_last_update_unix: 1 }, NOW);
  fs.mkdirSync(path.join(root, '.runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, '.runtime', 'fx.json'), JSON.stringify(stored));
  const cached = fx.createFxClient({ root, ttlMs: 1000, fetchFn: bad, nowFn: () => NOW });
  const rec = await cached.refresh(true);
  assert.equal(rec.rate, 6.6);
  assert.equal(rec.stale, true);
  assert.ok(rec.error);
});
