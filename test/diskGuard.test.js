'use strict';
/** Disk watermark policy: never truncate the hash chain, only write less. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const disk = require('../src/diskGuard');

const MB = 1024 * 1024;
const cfg = { enabled: true, minFreeMb: 512, hardFreeMb: 128, maxSampleEvery: 100 };

test('healthy：空间充足时完全不改变采样频率', () => {
  const d = disk.decide(20 * 1024 * MB, cfg, 12);
  assert.equal(d.level, 'ok');
  assert.equal(d.sampleEvery, 12);
  assert.equal(d.skipHeavy, false);
});

test('low：低于软水位时采样间隔加倍，不删除任何事实', () => {
  const d = disk.decide(400 * MB, cfg, 12);
  assert.equal(d.level, 'low');
  assert.equal(d.multiplier, 2);
  assert.equal(d.sampleEvery, 24);
  assert.equal(d.skipHeavy, false);
  const d2 = disk.decide(200 * MB, cfg, 12);
  assert.equal(d2.sampleEvery, 48);
});

test('critical：低于硬水位时跳过重数据，采样上限不越界', () => {
  const d = disk.decide(64 * MB, cfg, 12);
  assert.equal(d.level, 'critical');
  assert.equal(d.skipHeavy, true);
  assert.equal(d.sampleEvery, 100, '不得超过 maxSampleEvery');
});

test('disabled / 未知空间：fail open，保持原采样频率', () => {
  assert.equal(disk.decide(null, cfg, 12).level, 'ok');
  assert.equal(disk.decide(NaN, cfg, 12).sampleEvery, 12);
  assert.equal(disk.decide(1 * MB, { enabled: false }, 12).sampleEvery, 12);
});

test('采样倍数与基数始终被夹在 [1, maxSampleEvery]', () => {
  for (const free of [0, 1 * MB, 127 * MB, 128 * MB, 511 * MB, 512 * MB, 1e12]) {
    for (const base of [1, 12, 1000]) {
      const d = disk.decide(free, cfg, base);
      assert.ok(d.sampleEvery >= 1 && d.sampleEvery <= 100);
      assert.ok(Number.isInteger(d.sampleEvery));
    }
  }
});

test('inspect：读取真实文件系统水位（临时目录必为 healthy）', () => {
  const d = disk.inspect(os.tmpdir(), cfg, 12);
  assert.equal(d.level, 'ok');
  assert.ok(d.freeMb > 512);
});
