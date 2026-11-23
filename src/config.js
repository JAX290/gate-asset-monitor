'use strict';

/**
 * Central configuration. Secrets are read ONLY from server-side environment
 * variables and are never exposed to the browser, logs, API responses or exports.
 */
const path = require('path');
const fs = require('fs');
const marketCadence = require('./marketCadence');

/**
 * Minimal .env loader (zero dependency). Real environment variables always win,
 * so Docker/K8s/CI overrides work without editing files. Lines are safe-parsed:
 * `KEY=value`, optional surrounding quotes, # comments, `export` prefix allowed.
 */
function loadDotEnv() {
  const ROOT0 = path.resolve(__dirname, '..');
  const file = process.env.ENV_FILE || path.join(ROOT0, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // real env wins
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '').trim(); // strip inline comment
    }
    process.env[key] = val;
  }
}
loadDotEnv();

function bool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function int(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}
/** Parse "BTC:0.6,ETH:0.4" into a weight map (unknown/malformed -> defaults). */
function parseWeights(spec) {
  const out = {};
  for (const part of String(spec || '').split(',')) {
    const m = /^\s*([A-Za-z0-9]+)\s*:\s*([0-9.]+)\s*$/.exec(part);
    if (!m) continue;
    const w = Number(m[2]);
    if (Number.isFinite(w) && w > 0) out[m[1].toUpperCase()] = w;
  }
  return Object.keys(out).length ? out : { BTC: 0.6, ETH: 0.4 };
}
/** "5m" / "1h" / "4h" / "1d" -> seconds. */
function intervalToSec(s) {
  const m = /^(\d+)(m|h|d)$/.exec(String(s || '1h').toLowerCase());
  if (!m) return 3600;
  return Number(m[1]) * (m[2] === 'm' ? 60 : m[2] === 'h' ? 3600 : 86400);
}

const ROOT = path.resolve(__dirname, '..');

// Benchmark candles must be at least as dense as asset snapshots, otherwise
// the BTC/ETH curve becomes a step function and the two charts drift apart.
const SNAPSHOT_SEC = int(process.env.SNAPSHOT_INTERVAL_SEC, 300, 30, 86400);
const CANDLE = marketCadence.resolveCandle({
  snapshotSec: SNAPSHOT_SEC,
  requested: process.env.MARKET_CANDLE_INTERVAL,
});

const config = {
  root: ROOT,
  // 'mock' = deterministic simulated data (clearly labelled DEMO)
  // 'live' = real Gate.io API v4 calls using GATE_API_KEY / GATE_API_SECRET
  mode: (process.env.DATA_MODE || 'mock').toLowerCase() === 'live' ? 'live' : 'mock',

  gate: {
    key: process.env.GATE_API_KEY || '',
    secret: process.env.GATE_API_SECRET || '',
    baseUrl: (process.env.GATE_BASE_URL || 'https://api.gateio.ws/api/v4').replace(/\/$/, ''),
    // settle currencies queried for futures accounts
    settles: (process.env.GATE_SETTLES || 'usdt,btc').split(',').map(s => s.trim()).filter(Boolean),
    timeoutMs: int(process.env.GATE_TIMEOUT_MS, 12000, 2000, 60000),
  },

  server: {
    port: int(process.env.PORT, 8787, 1, 65535),
    // Bind address. For Tailscale-only deployments the start script sets HOST
    // to this node's 100.x address at boot, so the public interface never
    // listens at all. Keep 0.0.0.0 as default for local dev / containers.
    host: process.env.HOST || '0.0.0.0',
    // Same-origin only. Behind a reverse proxy, keep the proxy on the same host.
  },

  security: {
    // When true, every request from outside the Tailscale ranges is rejected
    // with 403. This is defence-in-depth on top of HOST binding: even if the
    // service is accidentally exposed on 0.0.0.0, non-tailnet peers are refused.
    tailscaleOnly: bool(process.env.TAILSCALE_ONLY, false),
    // Comma-separated IPv4 CIDRs / IPv6 prefixes. Defaults were verified on the
    // target host via `tailscale ip`; loopback keeps local health checks working.
    allowCidrs: (process.env.ALLOW_CIDRS ||
      '100.64.0.0/10,127.0.0.0/8,::1,fd7a:115c:a1e0::/48')
      .split(',').map(s => s.trim()).filter(Boolean),
    // Do NOT trust X-Forwarded-For unless you control the proxy that sets it.
    trustProxy: bool(process.env.TRUST_PROXY, false),
    proxyHeader: (process.env.PROXY_IP_HEADER || 'x-forwarded-for').toLowerCase(),
  },

  collector: {
    intervalSec: SNAPSHOT_SEC, // default 5 min
    retentionDays: int(process.env.RETENTION_DAYS, 365, 1, 3650),
    // Store a price point only every N collector cycles (1 = every cycle).
    // Raise this on long-running hosts to keep prices.jsonl lean.
    priceSampleEvery: int(process.env.PRICE_SAMPLE_EVERY, 1, 1, 100),
  },

  // ---------------------------------------------------------------------
  // Extended data enrichment (v5).
  //
  // Goal: "use as much of the API data as possible" WITHOUT bloating the
  // dashboard or the disk. Gate returns ~2160 tickers with 11 extra fields
  // (change_percentage / high_24h / low_24h / volumes / bid / ask / etf_*),
  // plus /wallet/fee, /futures/*/tickers (funding rate, mark/index price,
  // open interest), /spot/order_book, /spot/open_orders, /futures positions,
  // /margin/accounts. Previously only `last` was kept.
  //
  // Design:
  //   - ONE aggregated, structured snapshot is appended to its OWN hash chain
  //     `enrichment.jsonl` (the 8th chain), only once every `priceSampleEvery`
  //     cycles (default hourly). ~3-8 KB/record => well under 200 KB/day.
  //   - The 2160 raw rows are NEVER written verbatim: they are reduced to
  //     market-breadth aggregates + full detail ONLY for MY holdings. The
  //     complete raw payload of each sub-endpoint is kept in `payload_json`
  //     inside the one record, so third parties lose nothing.
  //   - Every sub-request is isolated. A failure is captured in `enrichNotes`
  //     and NEVER reaches state.lastError (the top red "数据源提示" bar).
  // ---------------------------------------------------------------------
  enrich: {
    collect: bool(process.env.ENRICH_COLLECT, true),
    // 0 = follow collector.priceSampleEvery. Otherwise a separate cadence.
    sampleEvery: int(process.env.ENRICH_SAMPLE_EVERY, 0, 0, 100),
    // Futures contracts to snapshot (public tickers: funding/mark/index/OI).
    futuresContracts: (process.env.ENRICH_FUTURES_CONTRACTS || 'BTC_USDT,ETH_USDT')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    // Max holdings to keep full ticker detail for (disk guard).
    maxDetail: int(process.env.ENRICH_MAX_DETAIL, 40, 1, 200),
    // Max order-book pairs (holdings + configured benchmarks).
    maxBookPairs: int(process.env.ENRICH_MAX_BOOK_PAIRS, 6, 1, 20),
    // Probe signed account endpoints (open orders / positions / margin).
    // Some accounts return USER_NOT_FOUND; those are isolated and silent.
    probeAccounts: bool(process.env.ENRICH_PROBE_ACCOUNTS, true),
  },

  analytics: {
    // Annual risk-free rate for Sharpe / Sortino (0.02 = 2% p.a.).
    riskFreeRate: (() => { const x = Number(process.env.RISK_FREE_RATE); return Number.isFinite(x) ? x : 0; })(),
    // Benchmark currency for beta / excess return (needs a price series).
    benchmark: (process.env.BENCHMARK_CURRENCY || 'BTC').toUpperCase(),
    // First live backfill window for events/prices (days).
    eventLookbackDays: int(process.env.EVENT_LOOKBACK_DAYS, 90, 1, 730),
    // In live mode, pull the event ledger + ticker prices on each cycle.
    collectEvents: bool(process.env.COLLECT_EVENTS, true),
    // Number of snapshots to feed the analytics window (0 = all).
    analyticsLimit: int(process.env.ANALYTICS_LIMIT, 0, 0, 200000),
  },

  // ---------------------------------------------------------------------
  // Market context: PUBLIC Gate endpoints (no API key needed) + an
  // append-only, human-maintainable macro-event ledger.
  //
  // Event sources are explicit and honest:
  //   manual  - you annotate an event in the dashboard / via API
  //   auto    - detected from benchmark price jumps (objective, replayable)
  //   mock    - DEMO events aligned to the simulated timeline
  // There is deliberately NO "live news feed" baked in: a reliable one needs
  // an external API key. `source=auto` is the adapter point for adding one.
  // ---------------------------------------------------------------------
  market: {
    symbols: (process.env.MARKET_SYMBOLS || 'BTC,ETH').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    quote: (process.env.MARKET_QUOTE || 'USDT').toUpperCase(),
    // Default = same cadence as asset snapshots (5m @ 5m snapshots). A
    // manually requested coarser interval is clamped down by marketCadence.
    candleInterval: CANDLE.label,
    candleIntervalSec: CANDLE.sec,
    candleIntervalAdjusted: CANDLE.adjusted,
    marketSync: marketCadence.syncMeta(SNAPSHOT_SEC, CANDLE.sec),
    // Gate caps candlestick history at 10000 bars back. 30d @5m = 8640 bars;
    // at 1m the lookback is automatically shortened to ~6d.
    lookbackDays: marketCadence.capLookbackDays(
      int(process.env.MARKET_LOOKBACK_DAYS, 30, 1, 330), CANDLE.sec),
    // Pull candles on each collector cycle in live mode.
    collect: bool(process.env.MARKET_COLLECT, true),
    // Auto-detect a "major move" event when |bar return| >= this percent.
    // Default stays at 3% even on 5m bars, so fine candles don't flood events.
    autoEvents: bool(process.env.MARKET_AUTO_EVENTS, true),
    eventThresholdPct: marketCadence.eventThresholdPct(CANDLE.sec, process.env.MARKET_EVENT_THRESHOLD_PCT),
    // Half-width of an event study window, in bars (~1h by default).
    eventWindowBars: marketCadence.eventWindowBars(CANDLE.sec, process.env.MARKET_EVENT_WINDOW_BARS),
    // Weights for the synthetic "market index" series (renormalised over
    // whichever symbols actually have data).
    indexWeights: parseWeights(process.env.MARKET_INDEX_WEIGHTS || 'BTC:0.6,ETH:0.4'),
  },

  // ---------------------------------------------------------------------
  // Daily report + WeCom (企业微信) group-robot push.
  //
  // SECRET HANDLING: WECOM_WEBHOOK_URL / WECOM_WEBHOOK_KEY contain the robot
  // `key`. They are read ONLY here (server-side env), never exposed to the
  // browser / API responses / exports / logs (see src/wecom.js maskUrl()).
  // The dashboard only ever sees a masked "key=***abcd" string.
  // ---------------------------------------------------------------------
  report: {
    // Master switch for the built-in daily scheduler. Off by default so a
    // deployment never starts messaging before the webhook is configured.
    enabled: bool(process.env.REPORT_ENABLED, false),
    // Local time-of-day (in tzOffsetHours) to fire the daily report.
    hour: int(process.env.REPORT_HOUR, 9, 0, 23),
    minute: int(process.env.REPORT_MINUTE, 0, 0, 59),
    // Timezone offset from UTC for the schedule + displayed timestamps.
    // Beijing = +8. Fractional offsets (e.g. 5.5) are supported.
    tzOffsetHours: (() => { const x = Number(process.env.REPORT_TZ_OFFSET_HOURS); return Number.isFinite(x) ? Math.min(14, Math.max(-12, x)) : 8; })(),
    // Market-comparison window used in the daily report (24H/7D/30D/ALL).
    preset: (process.env.REPORT_PRESET || '24H').toUpperCase(),
    // One-shot send on process start (handy to verify the webhook once).
    sendOnStart: bool(process.env.REPORT_SEND_ON_START, false),
    // Keep every generated report in an append-only, hash-chained history.
    keepHistory: bool(process.env.REPORT_KEEP_HISTORY, true),
  },

  wecom: {
    // Either a full webhook URL or just the key (prefer the KEY form in .env).
    webhookUrl: process.env.WECOM_WEBHOOK_URL || '',
    key: process.env.WECOM_WEBHOOK_KEY || '',
    // Optional @mentions. Comma-separated mobile numbers, or '@all'.
    mentionMobiles: (process.env.WECOM_MENTION_MOBILES || '').split(',').map(s => s.trim()).filter(Boolean),
    mentionAll: /^(@all|1|true|yes)$/i.test(process.env.WECOM_MENTION_ALL || ''),
    timeoutMs: int(process.env.WECOM_TIMEOUT_MS, 10000, 2000, 60000),
  },

  storage: {
    dir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  },

  // Disk watermark guard (v5.1): fact files are append-only, so we never
  // truncate them. Instead we raise the heavy-data sampling interval below
  // the soft watermark and stop writing prices/enrichment below the hard one.
  // Snapshots always continue. Unknown free space fails open.
  disk: {
    enabled: bool(process.env.DISK_GUARD_ENABLED, true),
    minFreeMb: int(process.env.DISK_GUARD_MIN_FREE_MB, 512, 32, 100000),
    hardFreeMb: int(process.env.DISK_GUARD_HARD_FREE_MB, 128, 16, 100000),
    maxSampleEvery: int(process.env.DISK_GUARD_MAX_SAMPLE_EVERY, 100, 1, 1000),
  },

  auth: {
    // Access token protecting the dashboard. If unset, auth is DISABLED and a
    // loud warning is printed at boot. Strongly recommended to set behind a domain.
    token: process.env.ACCESS_TOKEN || '',
    enabled: bool(process.env.AUTH_ENABLED, undefined) && !!process.env.ACCESS_TOKEN,
    sessionTtlSec: int(process.env.SESSION_TTL_SEC, 86400 * 7, 3600, 86400 * 30),
    // Set true only when the dashboard is served over HTTPS (e.g. behind a
    // Tailscale HTTPS proxy). The default HTTP-only deployment must stay false.
    secureCookie: bool(process.env.COOKIE_SECURE, false),
    // Per-socket-peer login limiter. X-Forwarded-For is never consulted.
    maxLoginAttempts: int(process.env.LOGIN_MAX_ATTEMPTS, 5, 1, 100),
    loginWindowSec: int(process.env.LOGIN_WINDOW_SEC, 300, 10, 86400),
    loginLockSec: int(process.env.LOGIN_LOCK_SEC, 300, 10, 86400),
  },

  // Optional display currency label for the dashboard (purely cosmetic).
  quote: process.env.QUOTE_LABEL || 'USD',
};

// If AUTH_ENABLED was not explicitly provided, enable automatically whenever a
// token is configured.
if (process.env.AUTH_ENABLED === undefined) {
  config.auth.enabled = !!config.auth.token;
}

module.exports = config;
