'use strict';

/**
 * USD/CNY reference FX — server-side only, zero npm dependencies.
 *
 * Gate.io has no CNY spot pair (INVALID_CURRENCY), so the rate comes from a
 * public FX provider. It is a DISPLAY CONVERSION FACTOR, never part of the
 * asset fact chain: the stored ledger stays USD, and a constant multiplier
 * cannot change TWR / beta / excess-return calculations.
 *
 * Design:
 *  - primary  : exchangerate-api open endpoint (open.er-api.com)
 *  - fallback : @fawazahmed0/currency-api via jsDelivr
 *  - cached in .runtime/fx.json (NOT in data/, NOT overwritten by deploy)
 *  - if both providers fail, the last good rate is returned with stale=true;
 *    if there is no cached rate, rate=null and the UI shows "—" (never 0)
 */

const fs = require('fs');
const path = require('path');

const PRIMARY = 'https://open.er-api.com/v6/latest/USD';
const FALLBACK = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';
const PROVIDER_PRIMARY = 'exchangerate-api.com (open)';
const PROVIDER_FALLBACK = 'currency-api via jsDelivr';

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Pure parser: primary provider payload -> normalized rate record. */
function parsePrimary(json, fetchedAt) {
  if (!json || json.result && json.result !== 'success') return null;
  const rate = num(json.rates && json.rates.CNY);
  if (rate === null) return null;
  const sourceTime = num(json.time_last_update_unix)
    ? num(json.time_last_update_unix) * 1000 : null;
  return {
    base: 'USD', quote: 'CNY', rate,
    rateLabel: `1 USD = ${rate.toFixed(4)} CNY`,
    provider: PROVIDER_PRIMARY,
    sourceTimeMs: sourceTime,
    sourceTimeIso: sourceTime ? new Date(sourceTime).toISOString() : null,
    fetchedMs: fetchedAt,
    fetchedIso: new Date(fetchedAt).toISOString(),
    stale: false,
    error: null,
  };
}

/** Pure parser: fallback provider payload -> normalized rate record. */
function parseFallback(json, fetchedAt) {
  const rate = num(json && json.usd && json.usd.cny);
  if (rate === null) return null;
  const day = typeof json.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(json.date)
    ? Date.parse(`${json.date}T00:00:00.000Z`) : null;
  const sourceTime = Number.isFinite(day) ? day : null;
  return {
    base: 'USD', quote: 'CNY', rate,
    rateLabel: `1 USD = ${rate.toFixed(4)} CNY`,
    provider: PROVIDER_FALLBACK,
    sourceTimeMs: sourceTime,
    sourceTimeIso: sourceTime ? new Date(sourceTime).toISOString() : null,
    fetchedMs: fetchedAt,
    fetchedIso: new Date(fetchedAt).toISOString(),
    stale: false,
    error: null,
  };
}

function normaliseCached(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rate = num(raw.rate);
  if (rate === null) return null;
  return Object.assign({}, raw, {
    rate,
    rateLabel: `1 USD = ${rate.toFixed(4)} CNY`,
    stale: true,                     // a disk-loaded value is always older than live
    error: null,
  });
}

/**
 * @param {object} o { root, ttlMs, fetchFn, nowFn }
 *   fetchFn(url, opts) must return { ok, json() } like global fetch.
 */
function createFxClient(o = {}) {
  const root = o.root || process.cwd();
  const ttlMs = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : 6 * 3600 * 1000;
  const fetchFn = o.fetchFn || ((...a) => fetch(...a));
  const nowFn = typeof o.nowFn === 'function' ? o.nowFn : () => Date.now();
  const cachePath = path.join(root, '.runtime', 'fx.json');
  let mem = null;
  let inflight = null;

  function loadCache() {
    if (mem) return mem;
    try {
      mem = normaliseCached(JSON.parse(fs.readFileSync(cachePath, 'utf8')));
    } catch (_) { mem = null; }
    return mem;
  }
  function saveCache(rec) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(rec, null, 2), 'utf8');
    } catch (e) { /* read-only filesystem: keep the in-memory value */ }
  }
  function current() {
    const rec = loadCache();
    if (rec) return rec;
    return { base: 'USD', quote: 'CNY', rate: null, rateLabel: '汇率不可用',
      provider: null, sourceTimeMs: null, sourceTimeIso: null,
      fetchedMs: null, fetchedIso: null, stale: true, error: 'NO_FX_DATA' };
  }
  function fresh(rec) {
    return !!(rec && rec.rate !== null && !rec.stale &&
      Number(rec.fetchedMs) > 0 && nowFn() - Number(rec.fetchedMs) < ttlMs);
  }

  async function trySource(url, parser) {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rec = parser(await res.json(), nowFn());
    if (!rec) throw new Error('BAD_PAYLOAD');
    return rec;
  }

  async function doRefresh() {
    const cached = loadCache();
    const errors = [];
    for (const [url, parser] of [[PRIMARY, parsePrimary], [FALLBACK, parseFallback]]) {
      try {
        const rec = await trySource(url, parser);
        mem = rec; saveCache(rec);
        return rec;
      } catch (e) { errors.push(`${url.split('/')[2]}: ${e.message}`); }
    }
    const stale = cached || current();
    return Object.assign({}, stale, { stale: true, error: errors.join(' | ') });
  }

  return {
    current,
    refresh(force = false) {
      if (!force && fresh(loadCache())) return Promise.resolve(loadCache());
      if (inflight) return inflight;
      inflight = doRefresh().finally(() => { inflight = null; });
      return inflight;
    },
    cachePath,
    providers: [PROVIDER_PRIMARY, PROVIDER_FALLBACK],
  };
}

module.exports = {
  PRIMARY, FALLBACK, parsePrimary, parseFallback, normaliseCached, createFxClient,
};
