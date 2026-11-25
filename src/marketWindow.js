'use strict';

/**
 * Market-comparison window resolution — PURE FUNCTION, zero I/O.
 *
 * Two ways to select a window:
 *   1. preset: 24H / 7D / 30D / 180D (8H and ALL kept for compatibility)
 *   2. explicit calendar dates `YYYY-MM-DD`, interpreted at UTC 00:00:
 *        fromDate = inclusive start (00:00:00.000Z)
 *        toDate   = inclusive end   (23:59:59.999Z, i.e. next midnight - 1ms)
 *      This is the only supported manual form: it is deterministic across
 *      browser timezones and can never accidentally pick a local-time offset.
 *
 * Raw epoch params (from/to) remain accepted for API clients. A future `to`
 * is clamped to `now` so a comparison can never include data that does not
 * exist yet; `from` must be strictly before the resolved `to`.
 */

const DAY = 86400 * 1000;
const PRESETS = Object.freeze({
  '8H': 8 * 3600 * 1000,
  '24H': 24 * 3600 * 1000,
  '7D': 7 * DAY,
  '30D': 30 * DAY,
  '180D': 180 * DAY,
});
const DEFAULT_PRESET = '24H';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a UTC calendar date. Returns null when the date is not real. */
function utcDayStart(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s.trim())) return null;
  const text = s.trim();
  const [y, m, d] = text.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(ms)) return null;
  const check = new Date(ms);
  // Date.UTC silently rolls 2026-02-31 into March — reject that.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return ms;
}

function epoch(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {object} o { preset, from, to, fromDate, toDate, now }
 * @returns {{ok:true, fromMs:number|null, toMs:number, source:string,
 *            preset:string|null, fromDate:string|null, toDate:string|null,
 *            fromLabel:string, toLabel:string, manual:boolean}
 *          |{ok:false, error:string, message:string}}
 */
function resolve(o = {}) {
  const now = epoch(o.now) || Date.now();
  const preset = typeof o.preset === 'string' ? o.preset.trim().toUpperCase() : '';
  const fromDate = typeof o.fromDate === 'string' && DATE_RE.test(o.fromDate.trim()) ? o.fromDate.trim() : null;
  const toDate = typeof o.toDate === 'string' && DATE_RE.test(o.toDate.trim()) ? o.toDate.trim() : null;
  const manual = !!(fromDate || toDate);

  let fromMs = null, toMs = now, source = 'preset', usedPreset = null;

  if (manual) {
    source = 'utc-dates';
    if (fromDate) {
      const start = utcDayStart(fromDate);
      if (start === null) return { ok: false, error: 'BAD_FROM_DATE', message: '起始日期无效' };
      fromMs = start;
    }
    if (toDate) {
      const start = utcDayStart(toDate);
      if (start === null) return { ok: false, error: 'BAD_TO_DATE', message: '结束日期无效' };
      toMs = start + DAY - 1;
    }
  } else {
    const rawFrom = epoch(o.from), rawTo = epoch(o.to);
    if (rawFrom !== null || rawTo !== null) {
      source = 'epoch';
      fromMs = rawFrom;
      toMs = rawTo === null ? now : rawTo;
    } else if (PRESETS[preset]) {
      usedPreset = preset;
      fromMs = now - PRESETS[preset];
    } else if (preset === 'ALL') {
      usedPreset = 'ALL';
      fromMs = null;                 // ALL: no lower bound
    } else {
      usedPreset = DEFAULT_PRESET;   // absent/unknown preset -> 24H, not "all history"
      fromMs = now - PRESETS[DEFAULT_PRESET];
    }
  }

  if (toMs > now) toMs = now;
  if (fromMs !== null && fromMs >= toMs) {
    return { ok: false, error: 'BAD_WINDOW', message: '起始时间必须早于结束时间' };
  }
  const iso = (ms) => ms === null ? '—' : new Date(ms).toISOString();
  return {
    ok: true, fromMs, toMs, source, preset: usedPreset,
    fromDate: fromDate || null, toDate: toDate || null, manual,
    fromLabel: iso(fromMs), toLabel: iso(toMs),
  };
}

/** Client-side default date inputs for a "custom" selection (UTC calendar). */
function utcDateInput(ms) {
  return new Date(epoch(ms) || Date.now()).toISOString().slice(0, 10);
}

module.exports = { PRESETS, DEFAULT_PRESET, DAY, utcDayStart, resolve, utcDateInput };
