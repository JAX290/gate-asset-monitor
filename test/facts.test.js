'use strict';
/**
 * facts: append-only JSONL + SHA-256 hash chain.
 *
 * The chain is the audit backbone of the whole project ("data cannot be
 * silently rewritten"), so the negative cases matter more than the happy path:
 * editing a record, deleting a record and reordering must all be detected.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Must be set BEFORE requiring config/facts: config reads env at load time.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gam-facts-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ACCESS_TOKEN = 'test-token';
process.env.TAILSCALE_ONLY = 'false';

const facts = require('../src/facts');

test.after(() => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} });

function lines(file) {
  return fs.readFileSync(path.join(DATA_DIR, file), 'utf8').split('\n').filter(Boolean);
}
function rewrite(file, rows) {
  fs.writeFileSync(path.join(DATA_DIR, file), rows.join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

test('Chain.append：seq 递增、prevHash 串联、hash 可复算', () => {
  const c = new facts.Chain('unit');
  c.reset();
  const a = c.append({ v: 1 });
  const b = c.append({ v: 2 });
  const d = c.append({ v: 3 });
  assert.deepEqual([a.seq, b.seq, d.seq], [1, 2, 3]);
  assert.equal(b.prevHash, a.hash);
  assert.equal(d.prevHash, b.hash);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(c.verify().ok, true);
  assert.equal(c.count(), 3);
});

test('Chain.verify：改动某条记录的金额 → 必被发现', () => {
  const c = new facts.Chain('tamper');
  c.reset();
  c.append({ amount: 1 });
  c.append({ amount: 2 });
  c.append({ amount: 3 });

  const rows = lines('tamper.jsonl').map(JSON.parse);
  rows[1].amount = 999;                     // 篡改中间一条
  rewrite('tamper.jsonl', rows.map(r => JSON.stringify(r)));

  const v = c.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
  assert.match(v.reason, /hash 不匹配/);
});

test('Chain.verify：删掉中间一条 → prevHash 断裂被发现', () => {
  const c = new facts.Chain('drop');
  c.reset();
  for (const i of [1, 2, 3]) c.append({ amount: i });

  const rows = lines('drop.jsonl').filter((_, i) => i !== 1);  // 删除第 2 条
  rewrite('drop.jsonl', rows);

  const v = c.verify();
  assert.equal(v.ok, false);
  assert.match(v.reason, /prevHash 不连续/);
});

test('Chain.verify：重排两条记录 → 被发现', () => {
  const c = new facts.Chain('swap');
  c.reset();
  for (const i of [1, 2, 3]) c.append({ amount: i });

  const rows = lines('swap.jsonl');
  [rows[1], rows[2]] = [rows[2], rows[1]];
  rewrite('swap.jsonl', rows);

  assert.equal(c.verify().ok, false);
});

test('Chain.verify：文件出现坏行 → 直接判失败而不是静默跳过', () => {
  const c = new facts.Chain('corrupt');
  c.reset();
  c.append({ amount: 1 });
  fs.appendFileSync(path.join(DATA_DIR, 'corrupt.jsonl'), '{not json\n', 'utf8');
  const v = c.verify();
  assert.equal(v.ok, false);
  assert.match(v.reason, /无法解析/);
});

test('addEvents：按 id 去重，重复同步不会写出重复事实', () => {
  facts.events.reset();
  const evs = [
    { id: 'e1', ts: 1000, type: 'deposit', currency: 'USDT', amount: 100, isCashflow: true, cashflowUsd: 100 },
    { id: 'e2', ts: 2000, type: 'trade', currency: 'BTC', amount: 0.01, pair: 'BTC_USDT' },
  ];
  assert.equal(facts.addEvents(evs, 'live'), 2);
  assert.equal(facts.addEvents(evs, 'live'), 0, '同一批 id 再次写入应为 0 条');
  assert.equal(facts.events.count(), 2);
  assert.equal(facts.events.verify().ok, true);
});

test('cashflows()：只返回外部现金流，内部划转不算', () => {
  facts.events.reset();
  facts.addEvents([
    { id: 'c1', ts: 1000, type: 'deposit', currency: 'USDT', amount: 500, isCashflow: true, cashflowUsd: 500 },
    { id: 'c2', ts: 1100, type: 'transfer', currency: 'USDT', amount: 200, isCashflow: false, cashflowUsd: 0 },
    { id: 'c3', ts: 1200, type: 'withdraw', currency: 'USDT', amount: 100, isCashflow: true, cashflowUsd: -100 },
  ], 'live');
  const cfs = facts.cashflows();
  assert.equal(cfs.length, 2);
  assert.deepEqual(cfs.map(e => e.id).sort(), ['c1', 'c3']);
  assert.equal(cfs.reduce((a, e) => a + e.cashflowUsd, 0), 400);
});

test('annotations：event-sourcing 折叠，create→edit→delete 后当前态为空', () => {
  facts.annotations.reset();
  const opId = 'op-x';
  facts.addAnnotation({ operationId: opId, motive: '试探建仓', stopLoss: 100, takeProfit: 130 });
  let cur = facts.listAnnotations();
  assert.equal(cur.length, 1);
  assert.equal(cur[0].motive, '试探建仓');

  facts.addAnnotation({ operationId: opId, motive: '改主意：加仓', stopLoss: 95 });
  cur = facts.listAnnotations();
  assert.equal(cur.length, 1, '同一 operationId 应折叠为一条');
  assert.equal(cur[0].motive, '改主意：加仓');
  assert.equal(cur[0].stopLoss, 95);

  facts.deleteAnnotation(opId);
  assert.equal(facts.listAnnotations().length, 0);
  assert.ok(facts.listAnnotationEvents().length >= 3, '原始审计链保留全部 3 次变更');
  assert.equal(facts.annotations.verify().ok, true);
});

test('enrichment：写入后可取最新值，并计入 8 条链与 raw 副本', () => {
  facts.resetAll();
  // snapshots.jsonl 由 store 负责创建、不参与哈希链；这里手工建一个占位文件，
  // 因为 rawFiles() 只返回磁盘上真实存在的文件。
  fs.writeFileSync(path.join(DATA_DIR, 'snapshots.jsonl'), JSON.stringify({ ts: 1, totalUsd: 1 }) + '\n', 'utf8');
  facts.addEnrichment({ ts: 2000, source: 'live', pairs: 2160, breadth: { upRatioPct: 55.5 }, notes: [] }, 'live');
  facts.addEnrichment({ ts: 3000, source: 'live', pairs: 2161, breadth: { upRatioPct: 60.1 }, notes: [] }, 'live');

  const latest = facts.latestEnrichment();
  assert.equal(latest.ts, 3000);
  assert.equal(latest.pairs, 2161);

  const integ = facts.integrity();
  assert.equal(Object.keys(integ).length, 8);
  assert.ok(integ.enrichment, 'enrichment 必须参与哈希链');
  assert.equal(integ.enrichment.ok, true);

  const rawNames = facts.rawFiles().map(r => r.name);
  assert.equal(rawNames.length, 9);
  assert.ok(rawNames.includes('enrichment.jsonl'));
  assert.ok(rawNames.includes('snapshots.jsonl'), 'snapshots 仍作为原始字节副本导出');
});
