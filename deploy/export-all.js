#!/usr/bin/env node
'use strict';
/**
 * Offline full export — no HTTP, no token, no running server required.
 *
 * Reads the JSONL datasets directly and writes the same 34 tidy tables +
 * dictionary + manifest + README + ZIP that /api/export/all produces.
 * Useful for cron backups or handing data to a third-party analyst from the VPS.
 *
 * Usage (on the VPS, using the private runtime):
 *   /opt/gate-asset-monitor/.runtime/node/bin/node deploy/export-all.js
 *   DATA_DIR=/opt/gate-asset-monitor/data OUT_DIR=/backup node deploy/export-all.js
 *
 * Options (env): DATA_DIR, OUT_DIR (default ./data/exports), NO_ZIP=1
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const store = require('../src/store');
const facts = require('../src/facts');
const analytics = require('../src/analytics');
const marketAnalytics = require('../src/marketAnalytics');
const operations = require('../src/operations');
const enrichAnalytics = require('../src/enrichAnalytics');
const exporter = require('../src/exporter');

const OUT_DIR = process.env.OUT_DIR || path.join(config.storage.dir, 'exports');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join(OUT_DIR, `gate-assets-${stamp}`);
fs.mkdirSync(dir, { recursive: true });

const events = analytics.consistentRun(facts.listEvents(), 'source');
const annotations = facts.listAnnotations();
const ops = operations.attachAnnotations(
  operations.buildOperations(events, { limit: 200000 }), facts.annotationMap());
const input = {
  // Only the current data source (mock vs live) — see analytics.consistentRun.
  snapshots: analytics.consistentRun(store.history({ limit: config.analytics.analyticsLimit || 200000 }), 'mode'),
  events,
  prices: analytics.consistentRun(facts.listPrices(), 'source'),
  decisions: facts.listDecisions(),
  behaviorDecisions: facts.listDecisions().concat(annotations.map(a => ({
    decisionId: 'ann-' + a.operationId, action: 'other', symbol: '',
    decidedAt: a.annotatedAt, expectation: a.expectation,
    reviewNote: a.reviewNote, outcome: a.outcome, tags: a.tags, source: 'manual',
  }))),
  decisionEvents: facts.listDecisionEvents(),
  market: facts.listMarketPoints(),
  macroEvents: facts.listMacroEvents(),
  macroEventLog: facts.listMacroEventLog(),
  operations: ops,
  annotations,
  annotationEvents: facts.listAnnotationEvents(),
  reports: facts.listReports(),
  enrichment: facts.listEnrichment(),
  latestSnapshot: store.latest(),
  integrity: facts.integrity(),
};
const analysis = analytics.compute(input, {
  mode: config.mode, quote: config.quote,
  benchmark: config.analytics.benchmark, riskFreeRate: config.analytics.riskFreeRate,
});
analysis.market = marketAnalytics.compute(input, analysis, {
  symbols: config.market.symbols, mode: config.mode,
  intervalSec: config.collector.intervalSec,
  eventWindowBars: config.market.eventWindowBars,
  indexWeights: config.market.indexWeights,
});
analysis.enrichment = enrichAnalytics.compute({ ...input, analysis });
const T = exporter.buildTables({ ...input, analysis });

let files = 0;
for (const name of exporter.DATASET_ORDER) {
  const t = T[name];
  fs.writeFileSync(path.join(dir, `${name}.csv`), exporter.toCsv(t.columns, t.rows));
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), exporter.toJsonl(t.rows));
  files += 2;
  console.log(`  ${name.padEnd(18)} ${String(t.rows.length).padStart(6)} rows  ${t.columns.length} cols`);
}
fs.writeFileSync(path.join(dir, 'analytics.json'), JSON.stringify(analysis, null, 2));
const raws = facts.rawFiles();
if (raws.length) {
  const rawDir = path.join(dir, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  for (const rf of raws) { fs.writeFileSync(path.join(rawDir, rf.name), rf.data); files++; }
}
const manifest = {
  generated_at: new Date().toISOString(), mode: config.mode, demo: config.mode === 'mock',
  window: { from: analysis.meta.from, to: analysis.meta.to },
  conventions: analysis.meta.conventions, integrity: input.integrity,
  datasets: exporter.datasetCatalog(T),
  raw_files: raws.map(r => r.name),
};
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
files += 2;

if (process.env.NO_ZIP !== '1') {
  const bundle = exporter.buildBundle({ ...input, analysis, rawFiles: raws });
  fs.writeFileSync(path.join(OUT_DIR, bundle.filename), bundle.buffer);
  console.log(`  ZIP: ${path.join(OUT_DIR, bundle.filename)}  (${(bundle.buffer.length / 1024).toFixed(0)} KB)`);
}
console.log(`\nDone: ${files} files in ${dir}`);
console.log(`Mode: ${config.mode}${config.mode === 'mock' ? '  *** DEMO 模拟数据 ***' : ''}`);
console.log(`Integrity: ${JSON.stringify(input.integrity)}`);
