'use strict';
/**
 * exporter: 35 tidy tables + dictionary + manifest + ZIP bundle.
 *
 * The export is the contract with third-party tools (Excel / pandas / Power BI).
 * A silently dropped table, a schema drift, or a bad CSV quote breaks analysis
 * downstream without any visible error in the dashboard, so pin it here.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config is loaded at require time; keep it away from real data.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gam-exporter-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ACCESS_TOKEN = 'test-token';
process.env.TAILSCALE_ONLY = 'false';

const exporter = require('../src/exporter');
const zip = require('../src/zip');
const { SCHEMA, DATASET_ORDER } = exporter;

const V5_TABLES = ['enrichment', 'ticker_detail', 'market_breadth', 'fee_schedule',
  'order_book_depth', 'futures_market', 'account_state', 'capital_usage', 'deposit_chains'];

// The 9 append-only source files are NOT the same set as the 9 new analytics
// tables: only `enrichment` is a new raw file in v5.
const RAW_FILES = ['snapshots', 'events', 'prices', 'decisions', 'market',
  'macro_events', 'annotations', 'reports', 'enrichment'];

test('SCHEMA 与 DATASET_ORDER 完全一致，共 35 张表', () => {
  assert.equal(DATASET_ORDER.length, 35);
  const keys = Object.keys(SCHEMA).sort();
  assert.deepEqual([...DATASET_ORDER].sort(), keys, '清单与 schema 不得漂移');
  assert.equal(new Set(DATASET_ORDER).size, DATASET_ORDER.length, '不得有重复表名');
});

test('每张表都有标题、粒度和唯一列名', () => {
  for (const name of DATASET_ORDER) {
    const s = SCHEMA[name];
    assert.ok(s.title && s.grain, `${name} 缺标题或粒度`);
    assert.ok(s.columns.length > 0, `${name} 没有列定义`);
    const cols = s.columns.map(c => c.name);
    assert.equal(new Set(cols).size, cols.length, `${name} 存在重复列名`);
    for (const c of s.columns) {
      assert.ok(c.name && c.type && c.desc, `${name}.${c.name} 定义不完整`);
    }
  }
});

test('v5 的 9 张扩展表全部在导出清单中', () => {
  for (const name of V5_TABLES) {
    assert.ok(DATASET_ORDER.includes(name), `${name} 未进入导出`);
  }
});

test('buildTables：空输入也产出全部 35 张表，列与 schema 对齐', () => {
  const T = exporter.buildTables({});
  assert.equal(Object.keys(T).length, 35);
  for (const name of DATASET_ORDER) {
    const t = T[name];
    assert.ok(t, `${name} 缺失`);
    assert.deepEqual(t.columns, SCHEMA[name].columns.map(c => c.name));
    assert.ok(Array.isArray(t.rows), `${name}.rows 必须是数组`);
    for (const row of t.rows) assert.ok(row && typeof row === 'object');
  }
});

test('dictionary 是唯一真相源：行数 = 所有表的列数之和', () => {
  const T = exporter.buildTables({});
  const expected = DATASET_ORDER.reduce((n, name) => n + SCHEMA[name].columns.length, 0);
  assert.equal(T.dictionary.rows.length, expected);
  const pairs = new Set(T.dictionary.rows.map(r => `${r.dataset}.${r.column}`));
  assert.equal(pairs.size, expected, '字典中不得有重复的 dataset.column');
});

test('datasetCatalog 报告的行列数与表内容一致', () => {
  const T = exporter.buildTables({ enrichment: [{ ts: 1, source: 'live' }] });
  const cat = exporter.datasetCatalog(T);
  assert.equal(cat.length, 35);
  for (const c of cat) {
    assert.equal(c.rows, T[c.name].rows.length);
    assert.equal(c.columns, T[c.name].columns.length);
  }
});

test('toCsv：UTF-8 BOM + CRLF，含逗号/引号/换行的字段正确转义', () => {
  const csv = exporter.toCsv(['a', 'b', 'c'], [
    { a: 1, b: 'hello, world', c: 'say "hi"\nnext' },
  ]);
  assert.ok(csv.startsWith('\uFEFF'), 'Excel 需要 BOM 才能正确识别 UTF-8');
  assert.ok(csv.includes('\r\n'), 'CSV 必须使用 CRLF');
  assert.ok(csv.includes('"hello, world"'));
  assert.ok(csv.includes('"say ""hi""\nnext"'), '双引号必须翻倍转义');
});

test('serialise：jsonl 每行可解析，json 带元信息，csv 有 BOM', () => {
  const T = exporter.buildTables({ snapshots: [{ ts: 1700000000000, totalUsd: 100, holdings: [] }] });
  const jl = exporter.serialise('snapshots', T, 'jsonl');
  assert.equal(jl.ext, 'jsonl');
  for (const line of jl.body.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  const js = exporter.serialise('snapshots', T, 'json');
  const parsed = JSON.parse(js.body);
  assert.equal(parsed.row_count, 1);
  assert.equal(parsed.dataset, 'snapshots');
  assert.ok(parsed.columns.length > 0);
  const csv = exporter.serialise('snapshots', T, 'csv');
  assert.ok(csv.body.startsWith('\uFEFF'));
  assert.equal(exporter.serialise('not_a_table', T, 'csv'), null);
});

test('时间戳统一：ts_ms 为 Unix 毫秒、ts_iso_utc 为 UTC ISO 8601', () => {
  const ts = 1700000000000;
  const T = exporter.buildTables({ snapshots: [{ ts, totalUsd: 1, holdings: [] }] });
  const row = T.snapshots.rows[0];
  assert.equal(row.ts_ms, ts);
  assert.equal(row.ts_iso_utc, new Date(ts).toISOString());
});

test('zip.crc32：标准测试向量 123456789 → 0xCBF43926', () => {
  assert.equal(zip.crc32(Buffer.from('123456789')), 0xCBF43926);
});

test('zip.stream：逐块产出与 build() 字节完全一致（流式下载不改包内容）', () => {
  const now = new Date('2026-01-02T03:04:05Z');
  const entries = [
    { name: 'a.csv', data: '\uFEFFx,y\n1,2\r\n' },
    { name: 'dir/b.json', data: Buffer.from('{"n":1}') },
    { name: '空.csv', data: '' },
  ];
  const expected = zip.build(entries, now);
  const streamed = Buffer.concat([...zip.stream(entries, now)]);
  assert.equal(streamed.length, expected.length);
  assert.ok(streamed.equals(expected), '流式输出必须与一次性构建逐字节相同');
});

test('buildBundle：82 条目、35 CSV + 35 JSONL + 9 raw + 3 辅助文件', () => {
  const rawFiles = RAW_FILES.map(name => ({
    name: `${name}.jsonl`, data: Buffer.from(`[${name}]\n`),
  }));
  assert.equal(rawFiles.length, 9);
  const b = exporter.buildBundle({
    snapshots: [{ ts: 1, totalUsd: 10, holdings: [] }],
    rawFiles,
    analysis: { meta: { from: 1, to: 2 } },
    integrity: { ok: true },
  });
  const raw = b.buffer;
  assert.ok(raw.length > 100);
  assert.equal(raw.subarray(0, 2).toString(), 'PK', '必须是合法 ZIP 头');

  // Parse the central directory without any third-party library.
  let n = 0;
  for (let i = 0; i < raw.length - 4; i++) {
    if (raw.readUInt32LE(i) === 0x02014b50) n++;
  }
  const expected = DATASET_ORDER.length * 2 + rawFiles.length + 3;
  assert.equal(expected, 82);
  assert.equal(n, expected, `ZIP 应有 ${expected} 个条目，实际 ${n}`);

  assert.equal(b.manifest.datasets.length, 35);
  assert.deepEqual(b.manifest.raw_files, rawFiles.map(r => r.name));
  assert.equal(b.manifest.integrity.ok, true);
  assert.match(b.filename, /^gate-assets-.*\.zip$/);
});
