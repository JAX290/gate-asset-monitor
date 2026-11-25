#!/usr/bin/env node
'use strict';
/**
 * Offline daily report — no HTTP, no auth, cron-friendly.
 *
 * Generates the SAME report as /api/report/send from the on-disk JSONL facts,
 * optionally pushes it to the WeCom (企业微信) robot, and appends it to the
 * append-only report history chain.
 *
 * Usage (on the VPS, using the private runtime):
 *   # Preview only (print markdown, do not send, do not store)
 *   node deploy/daily-report.js --preview
 *
 *   # Generate + push to WeCom + store in history (recommended for cron)
 *   node deploy/daily-report.js --send
 *
 *   # Just test the webhook connectivity
 *   node deploy/daily-report.js --test
 *
 * Suggested crontab (09:00 Asia/Shanghai, if not using the built-in scheduler):
 *   CRON_TZ=Asia/Shanghai
 *   0 9 * * *  cd /opt/gate-asset-monitor && ./.runtime/node/bin/node deploy/daily-report.js --send >> /var/log/gate-report.log 2>&1
 *
 * SECURITY: the webhook URL/key is read from server-side env / .env only.
 * It is never printed; only a masked form appears in logs.
 */
const config = require('../src/config');
const store = require('../src/store');
const facts = require('../src/facts');
const analytics = require('../src/analytics');
const marketAnalytics = require('../src/marketAnalytics');
const dailyReport = require('../src/dailyReport');
const wecom = require('../src/wecom');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

async function main() {
  if (has('--test')) {
    const out = await wecom.sendTest(config);
    console.log('[test]', JSON.stringify(out));
    process.exitCode = out.ok ? 0 : 1;
    return;
  }

  // Build a consistent input (same rules as server.collectInput / export-all).
  const events = analytics.consistentRun(facts.listEvents(), 'source');
  const annotations = facts.listAnnotations();
  const input = {
    snapshots: analytics.consistentRun(store.history({ limit: config.analytics.analyticsLimit || 200000 }), 'mode'),
    events,
    prices: analytics.consistentRun(facts.listPrices(), 'source'),
    decisions: facts.listDecisions(),
    behaviorDecisions: facts.listDecisions().concat(annotations.map(a => ({
      decisionId: 'ann-' + a.operationId, action: 'other', symbol: '',
      decidedAt: a.annotatedAt, expectation: a.expectation,
      reviewNote: a.reviewNote, outcome: a.outcome, tags: a.tags, source: 'manual',
    }))),
    market: facts.listMarketPoints(),
    macroEvents: facts.listMacroEvents(),
    macroEventLog: facts.listMacroEventLog(),
    integrity: facts.integrity(),
  };
  const analysis = analytics.compute(input, {
    mode: config.mode, quote: config.quote,
    benchmark: config.analytics.benchmark, riskFreeRate: config.analytics.riskFreeRate,
  });
  const PRESETS = { '8H': 8 * 3600e3, '24H': 24 * 3600e3, '7D': 7 * 86400e3, '30D': 30 * 86400e3 };
  const now = Date.now();
  let fromMs, toMs;
  if (PRESETS[config.report.preset]) { fromMs = now - PRESETS[config.report.preset]; toMs = now; }
  analysis.market = marketAnalytics.compute(input, analysis, {
    fromMs, toMs, symbols: config.market.symbols, mode: config.mode,
    intervalSec: config.collector.intervalSec,
    eventWindowBars: config.market.eventWindowBars,
    indexWeights: config.market.indexWeights,
  });

  const latest = store.latest(), prev = store.previous();
  const summary = {
    mode: config.mode, latest: latest || {},
    deltaUsd: latest && prev ? Math.round((latest.totalUsd - prev.totalUsd) * 100) / 100 : null,
    deltaPct: latest && prev && prev.totalUsd ? Math.round((latest.totalUsd - prev.totalUsd) / prev.totalUsd * 10000) / 100 : null,
  };
  const rep = dailyReport.build({
    analysis, market: analysis.market, marketPts: input.market,
    snapshots: input.snapshots, summary, config, now,
  });

  if (has('--preview') || (!has('--send') && !has('--test'))) {
    console.log(rep.plain);
    console.log('\n---- markdown (' + Buffer.byteLength(rep.markdown, 'utf8') + ' bytes, ' + rep.markdownChunks.length + ' chunk(s)) ----');
    console.log(rep.markdown);
    console.log('\n(preview only — not sent, not stored. Use --send to push + store.)');
    return;
  }

  if (has('--send')) {
    const push = await wecom.sendSplit(config, rep);
    if (config.report.keepHistory) {
      facts.addReport(rep, {
        trigger: 'cli', pushed: true, pushOk: push.ok,
        pushedTo: push.maskedWebhook, pushMessage: push.message,
        sent: push.sent, failed: push.failed,
      });
    }
    console.log(`[send] ${rep.meta.date} · ${rep.headline}`);
    console.log(`[send] push: ${JSON.stringify({ ok: push.ok, sent: push.sent, failed: push.failed, message: push.message, to: push.maskedWebhook })}`);
    console.log(`[send] markdown ${Buffer.byteLength(rep.markdown, 'utf8')} bytes / ${rep.markdownChunks.length} chunk(s) · observations ${rep.observations.length}`);
    process.exitCode = push.ok ? 0 : 1;
  }
}

main().catch(e => { console.error('[daily-report] ERROR:', e.message); process.exit(1); });
