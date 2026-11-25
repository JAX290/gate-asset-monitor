'use strict';

/**
 * Gate Asset Monitor - main server.
 * Zero external dependencies (Node >= 18). Provides:
 *   - background collector (live Gate API or deterministic DEMO data)
 *   - append-only FACT datasets (events / prices / decisions / annotations /
 *     reports) with a tamper-evident hash chain
 *   - analytics engine (NAV / TWR / MWR / attribution / risk / cost / behaviour)
 *   - unified export: 34 tidy tables, CSV / JSON / JSONL, data dictionary, ZIP bundle + 9 raw JSONL
 *   - extended enrichment: market breadth / liquidity / fee schedule / futures risk /
 *     capital usage / deposit chains (low-frequency, isolated, never pollutes lastError)
 *   - market context: public Gate candles (no key) + append-only macro-event ledger
 *   - interval comparison vs BTC/ETH/index, beta / capture, event windows, causal reasons
 *   - operation records (read-only mirror of Gate activity) + user annotations
 *   - daily report generator + WeCom (企业微信) robot push with built-in scheduler
 *   - read-only JSON API + optional token login + Tailscale-only source filter
 *
 * SECURITY: the Gate API secret AND the WeCom webhook live only in
 * process.env. No route ever returns them; only a masked webhook is exposed.
 * All data APIs require auth when enabled.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const config = require('./config');
const gate = require('./gateClient');
const mock = require('./mockData');
const store = require('./store');
const auth = require('./auth');
const netguard = require('./netguard');
const facts = require('./facts');
const analytics = require('./analytics');
const marketAnalytics = require('./marketAnalytics');
const exporter = require('./exporter');
const operations = require('./operations');
const metricGlossary = require('./metricGlossary');
const dailyReport = require('./dailyReport');
const wecom = require('./wecom');
const enrichAnalytics = require('./enrichAnalytics');
const diskGuard = require('./diskGuard');
const marketCadence = require('./marketCadence');
const zip = require('./zip');
const { writeStream } = require('./httpStream');
const loginGuard = require('./loginGuard');

const guard = netguard.buildGuard(config.security);

const PUBLIC_DIR = path.join(config.root, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
};

let collectorTimer = null;
let pruneTimer = null;
let reportTimer = null;
let lastReportLocalDate = null;      // de-dup guard for the daily scheduler
let priceTick = 0;
const state = {
  lastRunAt: null,
  lastError: null,
  lastFactsAt: null,
  lastFactsNotes: [],
  lastMarketAt: null, lastMarketNotes: [],
  lastReportAt: null, lastReportOk: null, lastReportMessage: null,
  lastEnrichAt: null, lastEnrichNotes: [],
  disk: null, diskLevelLogged: null,
  running: false,
  startedAt: Date.now(),
};
// Per-socket-peer login failures. Never keyed by X-Forwarded-For.
const loginAttempts = new Map();

/* ------------------------------- collector ------------------------------- */

async function collectLiveFacts() {
  const last = facts.events.last();
  const since = last
    ? Math.max(0, last.ts - 3600 * 1000)                       // 1h overlap, dedup by id
    : Date.now() - config.analytics.eventLookbackDays * 86400 * 1000;
  const out = await gate.fetchLiveFacts(since);
  const ne = facts.addEvents(out.events, 'live');
  const every = (state.disk && state.disk.sampleEvery) || config.collector.priceSampleEvery;
  const np = (priceTick % every === 0) ? facts.addPrices(out.prices, 'live') : 0;
  state.lastFactsAt = Date.now();
  state.lastFactsNotes = out.notes.slice(0, 8);
  if (ne || np || out.notes.length) {
    console.log(`[facts] +${ne} events +${np} prices${out.notes.length ? ' notes=' + out.notes.join(' | ') : ''}`);
  }
}

/** Use only the active candle cadence; keep legacy 1h rows in the raw export. */
function marketPointsForAnalytics() {
  return marketCadence.activeMarketPoints(facts.listMarketPoints(), config.market.candleIntervalSec);
}

/** Last ACTIVE benchmark timestamp, used for an incremental candle refresh. */
function lastMarketTs() {
  // Do NOT fall back to legacy 1h rows here: after a cadence change that
  // would backfill only the last hour of 5m data instead of the full window.
  return marketCadence.lastActiveMarketTs(facts.listMarketPoints(), config.market.candleIntervalSec);
}

/** Incremental since the last closed bar (one bar of overlap for late closes). */
function marketRefreshOpts(forceFull) {
  if (forceFull) return {};
  const last = lastMarketTs();
  return last ? { sinceMs: last - config.market.candleIntervalSec * 1000 } : {};
}

async function collectLiveMarket() {
  const out = await gate.fetchMarketCandles(marketRefreshOpts());
  const nc = facts.addMarketPoints(out.points, 'live');
  let ne = 0;
  if (config.market.autoEvents) {
    ne = facts.addMacroEvents(facts.detectAutoMarketEvents(out.points, config.market.eventThresholdPct, out.intervalSec));
  }
  state.lastMarketAt = Date.now();
  state.lastMarketNotes = out.notes.slice(0, 8);
  if (nc || ne || out.notes.length) console.log(`[market] +${nc} ${config.market.candleInterval} candles +${ne} events${out.notes.length ? ' notes=' + out.notes.join(' | ') : ''}`);
  return { candles: nc, events: ne, notes: out.notes };
}

/** Cadence of the low-frequency extended-enrichment snapshot. */
function enrichEvery() {
  const n = Number(config.enrich.sampleEvery || config.collector.priceSampleEvery);
  return Math.max(1, Number.isFinite(n) ? n : 1);
}

/**
 * ONE extended read-only snapshot (tickers / fee / futures tickers / order
 * books / open orders / positions / margin). Every sub-request is isolated
 * inside gateClient; a failure only becomes a note in `enrichNotes`, NEVER
 * state.lastError (the dashboard's top red bar) and never aborts a snapshot.
 */
async function collectLiveEnrichment(snapshot) {
  const out = await gate.fetchEnrichment({
    snapshot,
    cfg: {
      settle: config.gate.settles[0] || 'usdt',
      contracts: config.enrich.futuresContracts,
      maxDetail: config.enrich.maxDetail,
      maxBookPairs: config.enrich.maxBookPairs,
      symbols: config.market.symbols,
      probeAccounts: config.enrich.probeAccounts,
    },
  });
  const rec = facts.addEnrichment(out, 'live');
  state.lastEnrichNotes = (out.notes || []).slice(0, 8);
  invalidateCache();
  console.log(`[enrich] +1 snapshot pairs=${out.pairs} detail=${(out.holdingsDetail || []).length} books=${(out.books || []).length} contracts=${(out.futures || []).length}${out.notes && out.notes.length ? ' notes=' + out.notes.join(' | ') : ''}`);
  return rec;
}

async function collectOnce() {
  if (state.running) return;
  state.running = true;
  priceTick++;
  // Refresh before any fact write. A level change is logged once, not every
  // cycle, so a full disk does not flood the journal.
  state.disk = diskGuard.inspect(config.storage.dir, config.disk, config.collector.priceSampleEvery);
  if (state.disk.level !== state.diskLevelLogged) {
    state.diskLevelLogged = state.disk.level;
    if (state.disk.level === 'ok') console.log(`[disk] watermark back to healthy (${state.disk.freeMb}MB free)`);
    else console.warn(`[disk] ${state.disk.level.toUpperCase()}: ${state.disk.reason} · price/enrich every ${state.disk.sampleEvery} cycles${state.disk.skipHeavy ? ' · heavy writes SUSPENDED (snapshots continue)' : ''}`);
  }
  try {
    let data;
    if (config.mode === 'live') {
      data = await gate.fetchLiveSnapshot();
      if (data.totalUsd === 0 && data.accounts.length === 0) {
        throw new Error('All Gate endpoints returned no data (check key permissions / IP allowlist)');
      }
    } else {
      // DEMO snapshots are derived from the same event ledger => fully consistent
      data = mock.buildSnapshot(Date.now(), facts.listEvents());
    }
    const rec = store.append(data, config.mode);
    state.lastRunAt = rec.ts;
    state.lastError = data.notes && data.notes.length ? data.notes.join(' | ') : null;
    console.log(`[collector] ${new Date(rec.ts).toISOString()} mode=${config.mode} total=${rec.totalUsd} ${rec.totalCurrency}${state.lastError ? ' notes=' + state.lastError : ''}`);

    // Facts collection is isolated: failure must never break the snapshot.
    try {
      if (config.mode === 'live') {
        if (config.analytics.collectEvents) await collectLiveFacts();
        // Candles are coarse (default 1h); no need to re-pull every 5 min.
        const minGap = Math.max(60, Math.floor(config.market.candleIntervalSec / 2)) * 1000;
        if (config.market.collect && Date.now() - (state.lastMarketAt || 0) >= minGap) await collectLiveMarket();
      } else if (config.mode === 'mock' && !state.disk.skipHeavy && priceTick % state.disk.sampleEvery === 0) {
        facts.addPrices(mock.buildDemoPrices([Date.now()]), 'mock');
      }
    } catch (err) {
      state.lastFactsNotes = [err.message];
      console.error('[facts] ERROR:', err.message);
    }

    // Extended read-only enrichment: low-frequency, and FULLY isolated. A
    // failing optional endpoint must never reach state.lastError (the top red
    // bar) nor abort the snapshot. Follows PRICE_SAMPLE_EVERY to bound disk.
    const enrichEveryEffective = Math.max(enrichEvery(), state.disk.sampleEvery);
    if (config.enrich.collect && !state.disk.skipHeavy && priceTick % enrichEveryEffective === 0) {
      try {
        if (config.mode === 'live') await collectLiveEnrichment(data);
        else if (config.mode === 'mock') {
          // buildDemoEnrichment expects ARRAYS (tss / snapshots). A single
          // record keeps the per-cycle mock path consistent with the seed.
          const demoEnr = mock.buildDemoEnrichment([Date.now()], [data], config.market.symbols)[0];
          if (demoEnr) facts.addEnrichment(demoEnr, 'mock');
        }
        state.lastEnrichAt = Date.now();
      } catch (err) {
        state.lastEnrichNotes = [err.message];
        console.error('[enrich] isolated ERROR:', err.message);
      }
    }
    return rec;
  } catch (err) {
    state.lastError = err.message;
    console.error('[collector] ERROR:', err.message);
    throw err;
  } finally {
    state.running = false;
  }
}

/**
 * Seed a complete, internally-consistent DEMO dataset on first boot (mock only).
 * If an older snapshot file exists (pre-v2 DEMO), back it up once, then rebuild.
 * Live data is NEVER touched by this function.
 */
function ensureDemoData() {
  if (config.mode !== 'mock') return;
  const hasCore = facts.events.count() > 0;
  // v3 migration: older DEMO datasets have no market.jsonl / macro_events.jsonl.
  // Rebuild them into one self-consistent dataset (DEMO only, so nothing of
  // value is lost); user-entered decisions are preserved across the rebuild.
  const hasMarket = facts.market.count() > 0 && facts.macroEvents.count() > 0;
  // v5 migration: older DEMO datasets have no enrichment.jsonl either.
  const hasEnrich = facts.enrichment.count() > 0;
  if (hasCore && hasMarket && hasEnrich) return;          // already up to date
  const userDecisions = hasCore
    ? facts.listDecisions().filter(d => !String(d.note || '').includes('演示决策'))
    : [];
  if (hasCore) console.log('[demo] v3 migration: old DEMO without market context -> rebuilding (backup kept)');
  ensureBackup();                                // backs up all six .jsonl files
  store.reset();
  facts.resetAll();
  const ds = mock.generateFullDemo(Date.now(), 96, config.collector.intervalSec, config.market.symbols);
  store.appendRaw(ds.snapshots.map(s => ({
    ts: s.ts, mode: 'mock', quote: config.quote,
    totalUsd: s.totalUsd, totalCurrency: s.totalCurrency,
    accounts: s.accounts, holdings: s.holdings, notes: [],
  })));
  facts.addEvents(ds.events, 'mock');
  facts.addPrices(ds.prices, 'mock');
  for (const d of ds.decisions) facts.addDecision(d);
  facts.addMarketPoints(ds.market, 'mock');
  facts.addMacroEvents(ds.macroEvents);
  for (const e of (ds.enrichment || [])) facts.addEnrichment(e, 'mock');
  for (const d of userDecisions) facts.addDecision(d);   // preserve manual entries
  console.log(`[demo] seeded self-consistent dataset: ${ds.snapshots.length} snapshots / ${ds.events.length} events / ${ds.prices.length} prices / ${ds.decisions.length} decisions / ${ds.market.length} candles / ${ds.macroEvents.length} macro events / ${(ds.enrichment || []).length} enrichment${userDecisions.length ? ` / +${userDecisions.length} preserved user decisions` : ''}`);
}

/** Explicit reseed (mock only). Backs up, then rebuilds the DEMO dataset. */
function reseedDemo() {
  if (config.mode !== 'mock') throw Object.assign(new Error('仅 mock 模式可重置 DEMO'), { status: 403 });
  ensureBackup();
  store.reset();
  facts.resetAll();
  const ds = mock.generateFullDemo(Date.now(), 96, config.collector.intervalSec, config.market.symbols);
  store.appendRaw(ds.snapshots.map(s => ({
    ts: s.ts, mode: 'mock', quote: config.quote,
    totalUsd: s.totalUsd, totalCurrency: s.totalCurrency,
    accounts: s.accounts, holdings: s.holdings, notes: [],
  })));
  facts.addEvents(ds.events, 'mock');
  facts.addPrices(ds.prices, 'mock');
  for (const d of ds.decisions) facts.addDecision(d);
  facts.addMarketPoints(ds.market, 'mock');
  facts.addMacroEvents(ds.macroEvents);
  for (const e of (ds.enrichment || [])) facts.addEnrichment(e, 'mock');
  invalidateCache();
  return { snapshots: ds.snapshots.length, events: ds.events.length, prices: ds.prices.length, decisions: ds.decisions.length, candles: ds.market.length, macroEvents: ds.macroEvents.length, enrichment: (ds.enrichment || []).length };
}
function ensureBackup() {
  try {
    const dir = config.storage.dir;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const f of ['snapshots.jsonl', 'events.jsonl', 'prices.jsonl', 'decisions.jsonl', 'market.jsonl', 'macro_events.jsonl', 'annotations.jsonl', 'reports.jsonl', 'enrichment.jsonl']) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(dir, `${f}.${stamp}.bak`));
    }
  } catch (e) { console.error('[demo] backup failed:', e.message); }
}

function startCollector() {
  ensureDemoData();                       // must run BEFORE the first append
  collectOnce().catch(() => {});
  collectorTimer = setInterval(() => collectOnce().catch(() => {}), config.collector.intervalSec * 1000);
  collectorTimer.unref?.();
  pruneTimer = setInterval(() => {
    try { const n = store.prune(); if (n) console.log(`[store] pruned ${n} old snapshots`); } catch (e) { console.error('[store] prune error', e.message); }
  }, 6 * 3600 * 1000);
  pruneTimer.unref?.();
}

/* ------------------------------- analysis -------------------------------- */

let _cache = { key: '', ts: 0, input: null, analysis: null };
function invalidateCache() { _cache.ts = 0; }

function collectInput() {
  const limit = config.analytics.analyticsLimit || 200000;
  // Analyse only the CURRENT data source. A mock<->live switch inside one
  // append-only file would otherwise be read as a real cliff (DEMO account
  // ~148k vs a live account ~78k = fake -47% crash in NAV/TWR/attribution).
  const events = analytics.consistentRun(facts.listEvents(), 'source');
  const annotations = facts.listAnnotations();
  const ops = operations.attachAnnotations(
    operations.buildOperations(events, { limit: 200000 }), facts.annotationMap());
  return {
    snapshots: analytics.consistentRun(store.history({ limit }), 'mode'),
    events,
    prices: analytics.consistentRun(facts.listPrices(), 'source'),
    decisions: facts.listDecisions(),
    // Behaviour metrics count BOTH legacy manual decisions AND operation
    // annotations, so "复盘覆盖率" reflects the new annotation workflow too.
    behaviorDecisions: facts.listDecisions().concat(annotations.map(a => ({
      decisionId: 'ann-' + a.operationId, action: 'other', symbol: '',
      decidedAt: a.annotatedAt, expectation: a.expectation,
      reviewNote: a.reviewNote, outcome: a.outcome, tags: a.tags,
      source: 'manual',
    }))),
    decisionEvents: facts.listDecisionEvents(),
    market: marketPointsForAnalytics(),
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
}
/** Cached by dataset sizes + latest ts, TTL 8s (frontend polls multiple tabs). */
function getAnalysis() {
  const key = [store.count(), facts.events.count(), facts.prices.count(), facts.decisions.count(),
    facts.market.count(), facts.macroEvents.count(), facts.enrichment.count(),
    store.latest()?.ts || 0, facts.events.last()?.ts || 0, facts.market.last()?.ts || 0,
    facts.enrichment.last()?.ts || 0].join(':');
  if (_cache.key === key && _cache.analysis && Date.now() - _cache.ts < 8000) return _cache;
  const input = collectInput();
  const analysis = analytics.compute(input, {
    mode: config.mode, quote: config.quote,
    benchmark: config.analytics.benchmark, riskFreeRate: config.analytics.riskFreeRate,
  });
  // Attach the full-window market comparison so it is included in
  // /api/analytics, analytics.json and every export table.
  analysis.market = marketAnalytics.compute(input, analysis, {
    symbols: config.market.symbols, mode: config.mode,
    intervalSec: config.collector.intervalSec,
    eventWindowBars: config.market.eventWindowBars,
    indexWeights: config.market.indexWeights,
  });
  // Extended API data: a tiny headline/summary for the prominent strip plus
  // tidy long tables for the fold-out + export. Pure functions, never throws
  // when an optional endpoint is missing (mock / fresh install / key scope).
  analysis.enrichment = enrichAnalytics.compute({ ...input, analysis });
  _cache = { key, ts: Date.now(), input, analysis };
  return _cache;
}

/* ------------------------------- daily report ---------------------------- */

/** A trimmed /api/summary payload, reused so the report never re-queries Gate. */
function summaryPayload() {
  const latest = store.latest(), prev = store.previous();
  return {
    mode: config.mode, latest: latest || {},
    deltaUsd: latest && prev ? Math.round((latest.totalUsd - prev.totalUsd) * 100) / 100 : null,
    deltaPct: latest && prev && prev.totalUsd ? Math.round((latest.totalUsd - prev.totalUsd) / prev.totalUsd * 10000) / 100 : null,
  };
}

/** Build (but do not send) a report from current data + configured window. */
function generateDailyReport(nowMs) {
  const { input, analysis } = getAnalysis();
  const now = Number(nowMs) || Date.now();
  const PRESETS = { '8H': 8 * 3600e3, '24H': 24 * 3600e3, '7D': 7 * 86400e3, '30D': 30 * 86400e3 };
  let fromMs, toMs;
  if (PRESETS[config.report.preset]) { fromMs = now - PRESETS[config.report.preset]; toMs = now; }
  const mk = marketAnalytics.compute(input, analysis, {
    fromMs, toMs, symbols: config.market.symbols, mode: config.mode,
    intervalSec: config.collector.intervalSec,
    eventWindowBars: config.market.eventWindowBars,
    indexWeights: config.market.indexWeights,
  });
  return dailyReport.build({
    analysis, market: mk, marketPts: input.market, snapshots: input.snapshots,
    summary: summaryPayload(), config, now,
  });
}

/**
 * Full "run": optionally refresh fresh market/facts first (live), build the
 * report, optionally push to WeCom, and append to the report history chain.
 * `send` and `keep` are explicit so preview endpoints don't create history.
 */
async function runDailyReport({ trigger = 'manual', send = false, keep = true, refresh = false } = {}) {
  if (refresh && config.mode === 'live') {
    try { await collectLiveFacts(); } catch (e) { /* non-fatal: use cached facts */ }
    try { await collectLiveMarket(); } catch (e) { /* non-fatal */ }
    invalidateCache();
  }
  const rep = generateDailyReport(Date.now());
  let push = null;
  if (send) {
    // v5.3: asset and market are two separate WeCom pushes; @all fires once.
    push = await wecom.sendSplit(config, rep);
    state.lastReportAt = Date.now();
    state.lastReportOk = !!push.ok;
    state.lastReportMessage = push.message;
  }
  if (keep && config.report.keepHistory) {
    facts.addReport(rep, {
      trigger, pushed: !!send, pushOk: push ? push.ok : null,
      pushedTo: push ? push.maskedWebhook : '', pushMessage: push ? push.message : '',
      sent: push ? push.sent : 0, failed: push ? push.failed : 0,
    });
    invalidateCache();
  }
  return { rep, push };
}

/** Fire the scheduled report once per local calendar day. */
function reportTick() {
  const tz = config.report.tzOffsetHours;
  const local = new Date(Date.now() + tz * 3600 * 1000);
  const hh = local.getUTCHours(), mm = local.getUTCMinutes();
  const p = n => String(n).padStart(2, '0');
  const localDate = `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}`;
  if (hh !== config.report.hour || mm !== config.report.minute) return;
  if (lastReportLocalDate === localDate) return;
  if (facts.reportByDate(localDate)) { lastReportLocalDate = localDate; return; }   // already sent today
  lastReportLocalDate = localDate;
  console.log(`[report] scheduled fire ${localDate} ${p(hh)}:${p(mm)} (tz ${tz})`);
  runDailyReport({ trigger: 'scheduled', send: true, keep: true, refresh: true })
    .then(({ push }) => console.log(`[report] scheduled done: ${push ? push.message : 'no push'}`))
    .catch(e => console.error('[report] scheduled ERROR:', e.message));
}

function startReportScheduler() {
  if (!config.report.enabled) { console.log('[report] scheduler DISABLED (REPORT_ENABLED=false)'); return; }
  if (!wecom.configured(config)) {
    console.log('[report] scheduler enabled but webhook NOT configured — reports will be generated (not pushed) until WECOM_WEBHOOK_* is set');
  }
  reportTimer = setInterval(() => { try { reportTick(); } catch (e) { console.error('[report] tick error', e.message); } }, 60 * 1000);
  reportTimer.unref?.();
  console.log(`[report] scheduler ON · daily ${String(config.report.hour).padStart(2, '0')}:${String(config.report.minute).padStart(2, '0')} UTC${config.report.tzOffsetHours >= 0 ? '+' : ''}${config.report.tzOffsetHours} · preset ${config.report.preset}`);
  if (config.report.sendOnStart) {
    setTimeout(() => runDailyReport({ trigger: 'start', send: true, keep: true })
      .then(({ push }) => console.log(`[report] start-up send: ${push ? push.message : 'n/a'}`))
      .catch(e => console.error('[report] start-up ERROR:', e.message)), 8000).unref?.();
  }
}

/* --------------------------------- utils --------------------------------- */

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // Scripts stay strict. `style-src` needs unsafe-inline because app.js
    // builds width/colour bars via innerHTML style attributes; no inline JS,
    // no external origins, no eval anywhere in the front-end.
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...headers,
  });
  res.end(body);
}
function json(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': MIME['.json'], ...headers });
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 128 * 1024) b = ''; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } });
  });
}
function safeJoin(base, target) {
  const p = path.normalize(path.join(base, target));
  if (!p.startsWith(base)) return null;
  return p;
}
function download(res, body, filename, contentType) {
  return send(res, 200, body, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/* ------------------------------- API routes ------------------------------ */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // --- auth endpoints (no session required) ---
  // Liveness probe for systemd / monitors. Deliberately BEFORE the auth gate,
  // but still behind the Tailscale source filter. Carries no account data.
  if (p === '/api/health' && method === 'GET') {
    return json(res, 200, { ok: true, uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000), ts: Date.now() });
  }

  if (p === '/api/auth/status' && method === 'GET') {
    return json(res, 200, { enabled: config.auth.enabled, authed: auth.isAuthed(req) });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const peer = req.socket.remoteAddress || 'unknown';   // never X-Forwarded-For
    const limiter = {
      maxAttempts: config.auth.maxLoginAttempts,
      windowSec: config.auth.loginWindowSec,
      lockSec: config.auth.loginLockSec,
    };
    const verdict = loginGuard.check(loginAttempts, peer, Date.now(), limiter);
    if (!verdict.allowed) {
      return json(res, 429, {
        ok: false, error: '尝试次数过多，请稍后再试', retryAfterSec: verdict.retryAfterSec,
      }, { 'Retry-After': String(verdict.retryAfterSec) });
    }
    const body = await readBody(req);
    if (!auth.checkLogin(body.token)) {
      loginGuard.record(loginAttempts, peer, false, Date.now(), limiter);
      return json(res, 401, { ok: false, error: '访问口令错误' });
    }
    loginGuard.record(loginAttempts, peer, true, Date.now(), limiter);
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie() });
  }
  if (p === '/api/auth/logout' && method === 'POST') {
    auth.revoke(auth.tokenFromReq(req));
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  }

  // --- everything below requires auth ---
  if (!auth.isAuthed(req)) return json(res, 401, { error: 'UNAUTHORIZED', message: '需要登录' });

  /* ---------- summary / history / refresh (original, extended) ---------- */
  if (p === '/api/summary' && method === 'GET') {
    const latest = store.latest(), prev = store.previous();
    const integ = facts.integrity();
    return json(res, 200, {
      mode: config.mode, quote: config.quote, latest,
      deltaUsd: latest && prev ? round(latest.totalUsd - prev.totalUsd, 2) : null,
      deltaPct: latest && prev && prev.totalUsd ? round((latest.totalUsd - prev.totalUsd) / prev.totalUsd * 100, 3) : null,
      status: {
        lastRunAt: state.lastRunAt, lastError: state.lastError, startedAt: state.startedAt,
        intervalSec: config.collector.intervalSec, snapshotCount: store.count(),
        eventCount: facts.events.count(), priceCount: facts.prices.count(),
        decisionCount: facts.listDecisions().length,
        keysConfigured: !!(config.gate.key && config.gate.secret),
        authEnabled: config.auth.enabled, tailscaleOnly: config.security.tailscaleOnly,
        lastFactsAt: state.lastFactsAt, lastFactsNotes: state.lastFactsNotes,
        integrityOk: Object.values(integ).every(v => v.ok !== false),
        benchmark: config.analytics.benchmark,
        marketCount: facts.market.count(), macroEventCount: facts.listMacroEvents().length,
        benchmarkSymbols: config.market.symbols, marketInterval: config.market.candleInterval,
        marketIntervalSec: config.market.candleIntervalSec,
        marketSync: config.market.marketSync,
        marketIntervalAdjusted: config.market.candleIntervalAdjusted,
        lastMarketAt: state.lastMarketAt, lastMarketNotes: state.lastMarketNotes,
        annotationCount: facts.listAnnotations().length,
        reportEnabled: config.report.enabled, reportConfigured: wecom.configured(config),
        reportSchedule: `${String(config.report.hour).padStart(2, '0')}:${String(config.report.minute).padStart(2, '0')}`,
        reportCount: facts.listReports().length,
        enrichEnabled: config.enrich.collect, enrichCount: facts.enrichment.count(),
        lastEnrichAt: state.lastEnrichAt, lastEnrichNotes: state.lastEnrichNotes,
        diskGuard: state.disk, diskGuardConfig: config.disk,
      },
    });
  }

  if (p === '/api/history' && method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 5000);
    const from = url.searchParams.get('from') ? Number(url.searchParams.get('from')) : undefined;
    const to = url.searchParams.get('to') ? Number(url.searchParams.get('to')) : undefined;
    const rows = analytics.consistentRun(store.history({ limit, from, to, fields: false }), 'mode');
    return json(res, 200, { series: rows.map(r => ({ ts: r.ts, totalUsd: r.totalUsd, mode: r.mode })), count: rows.length });
  }

  if (p === '/api/refresh' && method === 'POST') {
    if (state.running) return json(res, 409, { ok: false, error: '采集正在进行中' });
    try {
      const rec = await collectOnce();
      invalidateCache();
      return json(res, 200, { ok: true, ts: rec.ts, totalUsd: rec.totalUsd });
    } catch (err) { return json(res, 502, { ok: false, error: err.message }); }
  }

  if (p === '/api/status' && method === 'GET') {
    return json(res, 200, {
      mode: config.mode, intervalSec: config.collector.intervalSec,
      snapshots: store.count(), events: facts.events.count(),
      prices: facts.prices.count(), decisions: facts.decisions.count(),
      lastRunAt: state.lastRunAt, lastError: state.lastError,
      uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    });
  }

  /* ---------- analytics ---------- */
  if (p === '/api/analytics' && method === 'GET') {
    const { analysis } = getAnalysis();
    if (url.searchParams.get('view') === 'compact') {
      const { attribution, ...compact } = analysis;   // drop 665-row detail for polling
      // Enrichment detail (long tables + raw payloads) is large; 30s polling
      // only needs the one-line headline. Full data lives at /api/enrichment.
      if (compact.enrichment) {
        const { available, headline, summary } = compact.enrichment;
        compact.enrichment = { available, headline, summary };
      }
      return json(res, 200, compact);
    }
    return json(res, 200, analysis);
  }

  /* ---------- extended enrichment (v5): headline + fold-out detail ------- */
  if (p === '/api/enrichment' && method === 'GET') {
    const { analysis } = getAnalysis();
    const enr = analysis.enrichment || { available: false, headline: '', summary: {}, depth: {}, tables: {} };
    if (url.searchParams.get('view') === 'headline') {
      return json(res, 200, { available: enr.available, headline: enr.headline, summary: enr.summary });
    }
    return json(res, 200, enr);
  }
  if (p === '/api/enrichment/refresh' && method === 'POST') {
    if (config.mode !== 'live') return json(res, 400, { error: 'ONLY_LIVE', message: '仅 live 模式可拉取真实扩展行情' });
    try {
      const snap = store.latest();
      if (!snap) return json(res, 409, { error: 'NO_SNAPSHOT', message: '尚无资产快照' });
      const out = await gate.fetchEnrichment({ snapshot: snap, cfg: {
        settle: config.gate.settles[0] || 'usdt',
        contracts: config.enrich.futuresContracts, maxDetail: config.enrich.maxDetail,
        maxBookPairs: config.enrich.maxBookPairs, symbols: config.market.symbols,
        probeAccounts: config.enrich.probeAccounts,
      } });
      facts.addEnrichment(out, 'live');
      state.lastEnrichAt = Date.now();
      state.lastEnrichNotes = (out.notes || []).slice(0, 8);
      invalidateCache();
      return json(res, 200, { ok: true, pairs: out.pairs, detail: (out.holdingsDetail || []).length, notes: out.notes });
    } catch (err) { return json(res, 502, { ok: false, error: err.message }); }
  }

  /* ---------- market context: benchmark comparison + macro events -------- */
  if (p === '/api/market' && method === 'GET') {
    const { input, analysis } = getAnalysis();
    const preset = (url.searchParams.get('preset') || '').toUpperCase();
    let fromMs = url.searchParams.get('from') ? Number(url.searchParams.get('from')) : undefined;
    let toMs = url.searchParams.get('to') ? Number(url.searchParams.get('to')) : undefined;
    const PRESETS = { '8H': 8 * 3600e3, '24H': 24 * 3600e3, '7D': 7 * 86400e3, '30D': 30 * 86400e3 };
    if (!fromMs && PRESETS[preset]) {
      fromMs = Date.now() - PRESETS[preset]; toMs = Date.now();
    }
    const symbols = url.searchParams.get('symbols')
      ? url.searchParams.get('symbols').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      : config.market.symbols;
    const view = (url.searchParams.get('view') || 'full').toLowerCase();
    const mk = marketAnalytics.compute(input, analysis, {
      fromMs, toMs, symbols, mode: config.mode,
      intervalSec: config.collector.intervalSec,
      eventWindowBars: config.market.eventWindowBars,
      indexWeights: config.market.indexWeights,
    });
    if (view === 'compact') {
      const { comparisonRows, eventRows, points, normalized, ...rest } = mk;
      return json(res, 200, rest);
    }
    return json(res, 200, mk);
  }
  if (p === '/api/market/refresh' && method === 'POST') {
    if (config.mode !== 'live') return json(res, 400, { error: 'ONLY_LIVE', message: '仅 live 模式可拉取真实公开行情' });
    try {
      // ?full=1 forces a full lookback backfill (used once after a cadence change).
      const out = await gate.fetchMarketCandles(marketRefreshOpts(url.searchParams.get('full') === '1'));
      const n = facts.addMarketPoints(out.points, 'live');
      const ev = config.market.autoEvents
        ? facts.addMacroEvents(facts.detectAutoMarketEvents(out.points, config.market.eventThresholdPct, out.intervalSec)) : 0;
      invalidateCache();
      return json(res, 200, { ok: true, candles: n, events: ev, symbols: out.symbols, notes: out.notes });
    } catch (err) { return json(res, 502, { ok: false, error: err.message }); }
  }
  if (p === '/api/macro-events' && method === 'GET') {
    const list = facts.listMacroEvents();
    return json(res, 200, {
      count: list.length, events: list, logCount: facts.listMacroEventLog().length,
      sources: { manual: '人工标注', auto: '公开行情异动自动检测', mock: 'DEMO 模拟' },
      note: '事件为人工标注/自动检测/DEMO，非实时新闻源；可用 POST 追加或导入。',
    });
  }
  if (p === '/api/macro-events' && method === 'POST') {
    const body = await readBody(req);
    if (!body.title) return json(res, 400, { error: 'BAD_INPUT', message: '缺少事件标题' });
    const rec = facts.addMacroEvent(body);
    invalidateCache();
    return json(res, 201, { ok: true, eventId: rec.eventId, event: facts.listMacroEvents().find(e => e.eventId === rec.eventId) });
  }
  if (p === '/api/macro-events/import' && method === 'POST') {
    const body = await readBody(req);
    const list = Array.isArray(body) ? body : (Array.isArray(body.events) ? body.events : null);
    if (!list) return json(res, 400, { error: 'BAD_INPUT', message: '需要 events 数组' });
    const clean = list.filter(e => e && e.title).map(e => Object.assign({}, e, { source: e.source || 'manual' }));
    const n = facts.addMacroEvents(clean);
    invalidateCache();
    return json(res, 200, { ok: true, added: n, total: facts.listMacroEvents().length });
  }
  if (p === '/api/macro-events/delete' && method === 'POST') {
    const body = await readBody(req);
    if (!body.id) return json(res, 400, { error: 'BAD_INPUT', message: '缺少 id' });
    facts.deleteMacroEvent(body.id);
    invalidateCache();
    return json(res, 200, { ok: true });
  }

  /* ---------- datasets / schema / integrity ---------- */
  if (p === '/api/datasets' && method === 'GET') {
    const { input, analysis } = getAnalysis();
    const T = exporter.buildTables({ ...input, analysis });
    return json(res, 200, {
      mode: config.mode, generatedAt: new Date().toISOString(),
      datasets: exporter.datasetCatalog(T),
      formats: ['csv', 'json', 'jsonl'],
      bundle: '/api/export/all',
    });
  }
  if (p === '/api/schema' && method === 'GET') {
    const format = (url.searchParams.get('format') || 'json').toLowerCase();
    if (format === 'csv') {
      const rows = [];
      for (const [name, def] of Object.entries(exporter.SCHEMA)) for (const c of def.columns) {
        rows.push({ dataset: name, title: def.title, grain: def.grain, column: c.name, type: c.type, unit: c.unit, description: c.desc });
      }
      return download(res, exporter.toCsv(['dataset', 'title', 'grain', 'column', 'type', 'unit', 'description'], rows),
        `gate-dictionary-${stamp()}.csv`, 'text/csv; charset=utf-8');
    }
    return json(res, 200, exporter.SCHEMA);
  }
  if (p === '/api/integrity' && method === 'GET') {
    return json(res, 200, { generatedAt: new Date().toISOString(), chains: facts.integrity() });
  }

  /* ---------- unified export ---------- */
  if (p === '/api/export/dataset' && method === 'GET') {
    const name = (url.searchParams.get('name') || '').toLowerCase();
    const format = (url.searchParams.get('format') || 'csv').toLowerCase();
    if (!exporter.DATASET_ORDER.includes(name)) return json(res, 400, { error: 'UNKNOWN_DATASET', available: exporter.DATASET_ORDER });
    if (!['csv', 'json', 'jsonl'].includes(format)) return json(res, 400, { error: 'UNKNOWN_FORMAT' });
    const { input, analysis } = getAnalysis();
    const T = exporter.buildTables({ ...input, analysis });
    const out = exporter.serialise(name, T, format);
    return download(res, out.body, `gate-${name}-${stamp()}.${out.ext}`, out.contentType);
  }
  if (p === '/api/export/all' && method === 'GET') {
    const { input, analysis } = getAnalysis();
    const { entries, manifest, prefix } = exporter.buildBundleEntries({
      ...input, analysis, rawFiles: facts.rawFiles(),
    });
    // Streamed: peak memory is the largest single table, not 2x the ZIP.
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Type': MIME['.zip'],
      'Content-Disposition': `attachment; filename="${prefix}.zip"`,
      'X-Export-Tables': String(manifest.datasets.length),
    });
    return writeStream(res, zip.stream(entries));
  }

  // Legacy export endpoint — kept for compatibility with older dashboards.
  if (p === '/api/export' && method === 'GET') {
    const format = (url.searchParams.get('format') || 'csv').toLowerCase();
    const kind = (url.searchParams.get('kind') || 'snapshots').toLowerCase();
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100000', 10) || 100000, 200000);
    const rows = store.history({ limit });
    if (format === 'json') {
      const payload = {
        exportedAt: new Date().toISOString(), mode: config.mode, demo: config.mode === 'mock',
        note: config.mode === 'mock' ? 'DEMO / 模拟数据，非真实资产' : '来自 Gate.io API v4',
        count: rows.length, snapshots: rows,
      };
      return download(res, JSON.stringify(payload, null, 2), `gate-assets-${stamp()}.json`, MIME['.json']);
    }
    const csv = kind === 'holdings' ? store.holdingsCsv(store.latest()) : store.toCsv(rows);
    return download(res, csv, `gate-assets-${kind}-${stamp()}.csv`, 'text/csv; charset=utf-8');
  }

  /* ---------- raw fact queries ---------- */
  if (p === '/api/events' && method === 'GET') {
    const from = url.searchParams.get('from') ? Number(url.searchParams.get('from')) : undefined;
    const to = url.searchParams.get('to') ? Number(url.searchParams.get('to')) : undefined;
    const type = url.searchParams.get('type');
    const rows = facts.listEvents({ from, to, types: type ? type.split(',') : undefined });
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '5000', 10) || 5000, 50000);
    return json(res, 200, { count: rows.length, events: rows.slice(-limit) });
  }
  if (p === '/api/prices' && method === 'GET') {
    const currency = (url.searchParams.get('currency') || '').toUpperCase();
    let rows = facts.listPrices();
    if (currency) rows = rows.filter(x => x.currency === currency);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '5000', 10) || 5000, 50000);
    return json(res, 200, { count: rows.length, prices: rows.slice(-limit) });
  }

  /* ---------- decision log (manual input) ---------- */
  if (p === '/api/decisions' && method === 'GET') {
    return json(res, 200, { count: facts.listDecisions().length, decisions: facts.listDecisions() });
  }
  if (p === '/api/decisions' && method === 'POST') {
    const body = await readBody(req);
    if (!body.action && !body.reason) return json(res, 400, { error: 'BAD_INPUT', message: '至少填写操作或理由' });
    const rec = facts.addDecision(body);
    invalidateCache();
    return json(res, 201, { ok: true, decisionId: rec.decisionId, decision: facts.listDecisions().find(d => d.decisionId === rec.decisionId) });
  }
  if (p === '/api/decisions/review' && method === 'POST') {
    const body = await readBody(req);
    if (!body.id) return json(res, 400, { error: 'BAD_INPUT', message: '缺少 id' });
    const rec = facts.reviewDecision(body.id, body);
    if (!rec) return json(res, 404, { error: 'NOT_FOUND' });
    invalidateCache();
    return json(res, 200, { ok: true, decision: facts.listDecisions().find(d => d.decisionId === body.id) });
  }
  if (p === '/api/decisions/delete' && method === 'POST') {
    const body = await readBody(req);
    if (!body.id) return json(res, 400, { error: 'BAD_INPUT', message: '缺少 id' });
    facts.deleteDecision(body.id);
    invalidateCache();
    return json(res, 200, { ok: true });
  }

  /* ---------- operation records (read-only Gate mirror) + annotations ---- */
  if (p === '/api/operations' && method === 'GET') {
    const { input } = getAnalysis();
    const kinds = url.searchParams.get('kinds') ? url.searchParams.get('kinds').split(',') : undefined;
    const opts = {
      kinds, symbol: url.searchParams.get('symbol') || undefined,
      from: url.searchParams.get('from') ? Number(url.searchParams.get('from')) : undefined,
      to: url.searchParams.get('to') ? Number(url.searchParams.get('to')) : undefined,
      limit: Math.min(parseInt(url.searchParams.get('limit') || '500', 10) || 500, 20000),
      offset: parseInt(url.searchParams.get('offset') || '0', 10) || 0,
    };
    const annotatedOnly = url.searchParams.get('annotated') === '1';
    // Build from the same event set, then attach folded annotations.
    let list = operations.attachAnnotations(
      operations.buildOperations(input.events, opts), facts.annotationMap());
    if (annotatedOnly) list = list.filter(o => o.annotation);
    return json(res, 200, {
      mode: config.mode, count: list.length, operations: list,
      stats: operations.summarize(operations.attachAnnotations(
        operations.buildOperations(input.events, { limit: 200000 }), facts.annotationMap())),
      note: '操作记录来自 Gate 只读接口（成交/充提/划转/费用），非人工录入；注释以 operation.id 为外键单独存储。',
    });
  }
  if (p === '/api/operations/annotate' && method === 'POST') {
    const body = await readBody(req);
    const id = body.operationId || body.id;
    if (!id) return json(res, 400, { error: 'BAD_INPUT', message: '缺少 operationId' });
    // Never trust a client-supplied `op`; addAnnotation derives it.
    const rec = facts.addAnnotation({
      operationId: id, motive: body.motive, takeProfit: body.takeProfit,
      stopLoss: body.stopLoss, expectation: body.expectation, tags: body.tags,
      note: body.note,
    });
    invalidateCache();
    return json(res, 201, { ok: true, annotation: facts.listAnnotations().find(a => a.operationId === id) });
  }
  if (p === '/api/operations/review' && method === 'POST') {
    const body = await readBody(req);
    const id = body.operationId || body.id;
    if (!id) return json(res, 400, { error: 'BAD_INPUT', message: '缺少 operationId' });
    const rec = facts.reviewAnnotation(id, body);
    if (!rec) return json(res, 404, { error: 'NOT_FOUND', message: '该操作还没有注释，请先保存动机/止盈止损' });
    invalidateCache();
    return json(res, 200, { ok: true, annotation: facts.listAnnotations().find(a => a.operationId === id) });
  }
  if (p === '/api/operations/annotate/delete' && method === 'POST') {
    const body = await readBody(req);
    const id = body.operationId || body.id;
    if (!id) return json(res, 400, { error: 'BAD_INPUT', message: '缺少 operationId' });
    facts.deleteAnnotation(id);
    invalidateCache();
    return json(res, 200, { ok: true });
  }

  /* ---------- metric glossary (指标详解) ---------- */
  if (p === '/api/metric-glossary' && method === 'GET') {
    return json(res, 200, {
      groups: metricGlossary.GROUPS, count: metricGlossary.ITEMS.length,
      items: metricGlossary.ITEMS,
      note: '每个指标的数据来源、计算口径、走势含义与注意事项；也作为 metric_glossary 表导出。',
    });
  }

  /* ---------- daily report ---------- */
  if (p === '/api/report/status' && method === 'GET') {
    const ws = wecom.status(config);
    const lastR = facts.listReports(1)[0];
    let lastReport = null;
    if (lastR) { const { markdown, ...rest } = lastR; lastReport = rest; }
    return json(res, 200, {
      ...ws,
      preset: config.report.preset, keepHistory: config.report.keepHistory,
      lastReportAt: state.lastReportAt, lastReportOk: state.lastReportOk,
      lastReportMessage: state.lastReportMessage,
      reportCount: facts.listReports().length,
      lastReport,
      note: '企业微信 webhook 仅存于服务端环境变量；此处只返回脱敏信息。',
    });
  }
  if (p === '/api/report/preview' && method === 'GET') {
    // Preview is pure: no push, no history write. Optionally refresh live data.
    const refresh = url.searchParams.get('refresh') === '1' && config.mode === 'live';
    const { rep } = await runDailyReport({ trigger: 'preview', send: false, keep: false, refresh });
    return json(res, 200, rep);
  }
  if (p === '/api/report/send' && method === 'POST') {
    const body = await readBody(req);
    const { rep, push } = await runDailyReport({
      trigger: body.trigger || 'manual', send: true, keep: true,
      refresh: body.refresh !== false,
    });
    return json(res, 200, {
      ok: true, report: {
        meta: rep.meta, headline: rep.headline, chunks: rep.markdownChunks.length,
        assetChunks: rep.assetReport ? rep.assetReport.markdownChunks.length : 0,
        marketChunks: rep.marketReport ? rep.marketReport.markdownChunks.length : 0,
      },
      push: push ? { ok: push.ok, sent: push.sent, failed: push.failed, message: push.message, maskedWebhook: push.maskedWebhook, parts: push.parts } : null,
    });
  }
  if (p === '/api/report/test' && method === 'POST') {
    const out = await wecom.sendTest(config);
    return json(res, 200, out);
  }
  if (p === '/api/report/history' && method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '60', 10) || 60, 1000);
    const rows = facts.listReports(limit).map(r => {
      const { markdown, ...rest } = r;   // history list omits the full markdown
      return rest;
    });
    return json(res, 200, { count: rows.length, reports: rows });
  }
  if (p === '/api/report/markdown' && method === 'GET') {
    const id = url.searchParams.get('id');
    const r = id ? facts.listReports().find(x => x.id === id) : facts.listReports(1)[0];
    if (!r) return json(res, 404, { error: 'NOT_FOUND' });
    return json(res, 200, { id: r.id, date: r.date, markdown: r.markdown, chunks: r.chunks });
  }

  /* ---------- DEMO reseed (mock only) ---------- */
  if (p === '/api/reseed-demo' && method === 'POST') {
    try {
      const out = reseedDemo();
      return json(res, 200, { ok: true, ...out, note: 'DEMO 数据集已重建（旧数据已备份），仅影响模拟数据' });
    } catch (err) { return json(res, err.status || 500, { ok: false, error: err.message }); }
  }

  return json(res, 404, { error: 'NOT_FOUND' });
}

function round(v, d = 2) { const p = Math.pow(10, d); return Math.round(v * p) / p; }

/* ----------------------------- static server ----------------------------- */

function serveStatic(res, pathname, req) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch (_) { return send404(res); }
  const file = safeJoin(PUBLIC_DIR, decoded);
  const isFile = file && fs.existsSync(file) && fs.statSync(file).isFile();
  if (isFile) return serveFile(res, file, req);
  if (path.extname(decoded)) return send404(res);
  const idx = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(idx)) return serveFile(res, idx, req);
  return send404(res);
}
function send404(res) { return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' }); }

// Static assets are small but re-downloaded on every cold start. gzip + ETag
// cuts ~80% of the bytes and turns unchanged reloads into a 304. Filenames
// have no content hash, so use `no-cache` (revalidate), NOT immutable.
const GZIP_EXT = new Set(['.html', '.js', '.css', '.svg', '.ico', '.json', '.txt']);
const assetCache = new Map();
function cachedAsset(file) {
  const st = fs.statSync(file);
  const hit = assetCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const raw = fs.readFileSync(file);
  const asset = {
    mtimeMs: st.mtimeMs, size: st.size, raw,
    etag: '"' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24) + '"',
    gz: GZIP_EXT.has(path.extname(file).toLowerCase()) ? zlib.gzipSync(raw, { level: 6 }) : null,
  };
  assetCache.set(file, asset);
  return asset;
}
function serveFile(res, file, req) {
  const ext = path.extname(file).toLowerCase();
  let asset;
  try { asset = cachedAsset(file); } catch (_) { return send404(res); }
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'ETag': asset.etag,
    'Cache-Control': 'no-cache',             // override send()'s no-store
  };
  if (req && req.headers['if-none-match'] === asset.etag) return send(res, 304, '', headers);
  let body = asset.raw;
  if (asset.gz && req && /\bgzip\b/i.test(req.headers['accept-encoding'] || '')) {
    body = asset.gz;
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  return send(res, 200, req && req.method === 'HEAD' ? '' : body, headers);
}

const server = http.createServer((req, res) => {
  if (config.security.tailscaleOnly && !guard.check(req)) {
    return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(err => {
      console.error('[api] unexpected', err);
      if (!res.headersSent) json(res, 500, { error: 'INTERNAL', message: err.message });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { 'Content-Type': 'text/plain' });
  }
  serveStatic(res, url.pathname, req);
});

/* --------------------------------- boot ---------------------------------- */

function banner() {
  const lines = [
    '', '  Gate Asset Monitor  ·  Analytics Edition',
    '  -------------------------------------------',
    `  mode        : ${config.mode}${config.mode === 'mock' ? '  (DEMO / 模拟数据)' : '  (真实 Gate.io API)'}`,
    `  listen      : http://${config.server.host}:${config.server.port}`,
    `  access      : ${config.security.tailscaleOnly ? 'TAILSCALE ONLY (' + guard.rules.length + ' allow rules)' : 'unrestricted (no source-IP filter)'}`,
    `  interval    : ${config.collector.intervalSec}s`,
    `  disk guard  : ${config.disk.enabled ? `${config.disk.minFreeMb}MB soft / ${config.disk.hardFreeMb}MB hard · never truncate` : 'OFF'}`,
    `  retention   : ${config.collector.retentionDays}d`,
    `  benchmark   : ${config.analytics.benchmark}   riskFree=${config.analytics.riskFreeRate}`,
    `  market      : ${config.market.symbols.join('/')} @${config.market.candleInterval} (public, no key) | sync ${config.market.marketSync.aligned ? 'OK' : 'COARSER'} (${config.market.marketSync.snapshotsPerCandle} snapshot(s)/bar) | auto-events ${config.market.autoEvents ? 'on' : 'off'}`,
    `  data files  : snapshots / events / prices / decisions / market / macro_events / annotations / reports / enrichment .jsonl (9 raw, 8 hash chains)`,
    `  export      : /api/export/all (ZIP, 34 tables + dictionary + 9 raw JSONL)`,
    `  enrichment  : ${config.enrich.collect ? 'ON' : 'OFF'} every ${enrichEvery()} collector cycles | detail<=${config.enrich.maxDetail} | books<=${config.enrich.maxBookPairs} | contracts ${config.enrich.futuresContracts.join('/')} | /api/enrichment`,
    `  market API  : /api/market | /api/macro-events`,
    `  operations  : /api/operations (Gate read-only mirror) | /api/operations/annotate | /api/metric-glossary`,
    `  daily report: ${config.report.enabled ? 'ON' : 'OFF'} @${String(config.report.hour).padStart(2, '0')}:${String(config.report.minute).padStart(2, '0')} UTC${config.report.tzOffsetHours >= 0 ? '+' : ''}${config.report.tzOffsetHours} | preset ${config.report.preset} | SPLIT asset+market | wecom ${wecom.configured(config) ? 'configured (' + wecom.status(config).maskedWebhook + ')' : 'NOT configured'}`,
    `  report API  : /api/report/preview | /send | /test | /history | /status`,
    `  auth        : ${config.auth.enabled ? 'ENABLED' : 'DISABLED'}`,
    `  gate keys   : ${config.gate.key && config.gate.secret ? 'configured' : 'NOT configured (required for live)'}`,
    '  -------------------------------------------',
  ];
  if (config.mode === 'live' && !(config.gate.key && config.gate.secret)) lines.push('  [WARN] live mode needs GATE_API_KEY / GATE_API_SECRET');
  if (config.market.candleIntervalAdjusted) {
    lines.push(`  [WARN] MARKET_CANDLE_INTERVAL 比资产快照更粗，已自动下调到 ${config.market.candleInterval} 以保持走势图同步。`);
    lines.push('         如需更长历史窗口，请调大 MARKET_LOOKBACK_DAYS 而不是放宽 K 线周期。');
  }
  if (config.report.enabled && !wecom.configured(config)) {
    lines.push('  [WARN] 日报调度已开但企业微信 webhook 未配置：日报会生成并入历史，但不会推送。');
    lines.push('         在 .env 设置 WECOM_WEBHOOK_URL 或 WECOM_WEBHOOK_KEY 后重启即可推送。');
  }
  if (!config.auth.enabled) {
    lines.push('  [WARN] 未设置 ACCESS_TOKEN，看板当前无需登录即可访问！');
    lines.push('          绑定公网域名前请务必设置 ACCESS_TOKEN。');
  }
  lines.push('');
  console.log(lines.join('\n'));
}

server.listen(config.server.port, config.server.host, () => {
  banner();
  startCollector();
  startReportScheduler();
});

function shutdown() {
  if (collectorTimer) clearInterval(collectorTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  if (reportTimer) clearInterval(reportTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server, collectOnce, getAnalysis, ensureDemoData, generateDailyReport, runDailyReport };
