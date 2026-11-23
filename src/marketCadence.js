'use strict';

/**
 * Market-cadence policy (zero dependencies, pure functions).
 *
 * The dashboard compares MY NAV (one point per collector snapshot) against
 * BTC/ETH benchmarks. A 1h candle against a 5min snapshot makes the benchmark
 * a 12-point step function, so the two curves visually drift apart. This
 * module chooses a Gate-supported candle interval that is at least as dense
 * as the snapshot interval, and keeps legacy coarser rows out of the chart
 * without rewriting the append-only market chain.
 */

// Gate /spot/candlesticks supported intervals used by this project.
const SUPPORTED_SEC = [60, 180, 300, 900, 1800, 3600, 14400, 28800, 86400];
const MAX_BARS_PER_REQUEST_WINDOW = 10000;

function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Largest supported interval that is still <= the snapshot interval. */
function pickCandleIntervalSec(snapshotSec) {
  const s = positive(snapshotSec) || 300;
  let best = SUPPORTED_SEC[0];
  for (const sec of SUPPORTED_SEC) if (sec <= s) best = sec;
  return best;
}

/** "300" -> "5m", "3600" -> "1h", "86400" -> "1d". */
function labelForSec(sec) {
  const s = Math.round(positive(sec) || 300);
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/** "5m"/"1h"/"1d" -> seconds; null for malformed input. */
function secForLabel(label) {
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(String(label || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  const mul = m[2].toLowerCase() === 'd' ? 86400 : m[2].toLowerCase() === 'h' ? 3600 : m[2].toLowerCase() === 'm' ? 60 : 1;
  return n * mul;
}

/**
 * Resolve the candle cadence actually used.
 * - If no explicit interval is set: align to the snapshot cadence.
 * - If the requested interval is COARSER than the snapshot: clamp it down so
 *   the benchmark can never be sparser than the portfolio curve.
 * - If the requested interval is FINER: keep it (more data, still in sync).
 */
function resolveCandle({ snapshotSec, requested } = {}) {
  const snapshot = positive(snapshotSec) || 300;
  const alignedSec = pickCandleIntervalSec(snapshot);
  const requestedSec = secForLabel(requested);
  if (requestedSec === null) {
    return { sec: alignedSec, label: labelForSec(alignedSec), alignedSec, adjusted: false, requestedSec: null };
  }
  // Snap a non-supported but finer request (e.g. 7m) down to a supported bar.
  const normalisedSec = pickCandleIntervalSec(requestedSec) === requestedSec
    ? requestedSec
    : Math.max(60, pickCandleIntervalSec(requestedSec));
  const sec = Math.min(normalisedSec, alignedSec);
  return {
    sec, label: labelForSec(sec), alignedSec,
    adjusted: requestedSec > alignedSec,
    requestedSec,
  };
}

/**
 * Keep the existing 3% "major move" default when the bar interval changes.
 * A 3% move inside 5 minutes is already exceptional, so fine candles do not
 * flood the event ledger. Explicit user configuration always wins.
 */
function eventThresholdPct(sec, requested) {
  const x = positive(requested);
  return x !== null ? x : 3;
}

/** Default event window = ~1h around the event, expressed in bars. */
function eventWindowBars(sec, requested) {
  const x = Number(requested);
  if (Number.isFinite(x) && x >= 2) return Math.min(48, Math.max(2, Math.round(x)));
  const s = positive(sec) || 300;
  return Math.min(48, Math.max(2, Math.round(3600 / s)));
}

/** Gate caps candle history at 10000 bars; shrink lookback for fine intervals. */
function capLookbackDays(days, sec) {
  const d = positive(days) || 30;
  const s = positive(sec) || 300;
  const max = Math.max(1, Math.floor(MAX_BARS_PER_REQUEST_WINDOW * s / 86400));
  return Math.max(1, Math.min(Math.round(d), max));
}

/**
 * After an interval change the append-only chain contains both old 1h and new
 * 5m rows (they are distinguished by id/intervalSec). Use only the active
 * cadence for analytics; fall back to all rows on a fresh/legacy install.
 */
function activeMarketPoints(points, intervalSec) {
  const rows = Array.isArray(points) ? points : [];
  const want = positive(intervalSec);
  if (want === null) return rows;
  const exact = rows.filter(p => Number(p.intervalSec) === want);
  return exact.length ? exact : rows;
}

/**
 * Gate counts BOTH endpoints: a range spanning exactly 1000 bars is rejected
 * ("maximum 1000 data points"). 990 leaves headroom for unaligned timestamps.
 * Paginate backwards in <=990-bar windows instead of one fixed 30d `from`.
 */
const CANDLE_PAGE_BARS = 990;

function candlePageWindow(fromSec, toSec, intervalSec, limit) {
  const bars = Math.min(CANDLE_PAGE_BARS, Math.max(1, Math.floor(Number(limit) || CANDLE_PAGE_BARS)));
  const span = bars * (positive(intervalSec) || 300);
  return {
    from: Math.max(Number(fromSec), Number(toSec) - span + 1),
    to: Number(toSec),
  };
}

/**
 * Last timestamp of the ACTIVE cadence only. Legacy coarser bars must NOT be
 * used as the incremental cursor after a cadence change: that would backfill
 * only the last hour of 5m data instead of the full configured lookback.
 */
function lastActiveMarketTs(points, intervalSec) {
  const want = positive(intervalSec);
  if (want === null) return null;
  let last = null;
  for (const p of (Array.isArray(points) ? points : [])) {
    if (Number(p.intervalSec) !== want) continue;
    const ts = Number(p.ts);
    if (Number.isFinite(ts) && (last === null || ts > last)) last = ts;
  }
  return last;
}

/** Status payload: make the cadence visible in the UI / health checks. */
function syncMeta(snapshotSec, candleSec) {
  const snap = positive(snapshotSec) || 300;
  const candle = positive(candleSec) || 300;
  return {
    snapshotSec: snap,
    candleSec: candle,
    aligned: candle <= snap,
    snapshotsPerCandle: Math.max(1, Math.round(snap / candle)),
  };
}

module.exports = {
  SUPPORTED_SEC,
  CANDLE_PAGE_BARS,
  pickCandleIntervalSec,
  labelForSec,
  secForLabel,
  resolveCandle,
  eventThresholdPct,
  eventWindowBars,
  capLookbackDays,
  activeMarketPoints,
  candlePageWindow,
  lastActiveMarketTs,
  syncMeta,
};
