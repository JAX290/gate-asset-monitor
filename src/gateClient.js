'use strict';

/**
 * Gate.io API v4 signed client.
 *
 * Signing algorithm verified against the official SDK source
 * (gate/gateapi-nodejs -> model/models.ts -> GateApiV4Auth.applyToRequest):
 *
 *   timestamp      = seconds since epoch (string)
 *   resourcePath   = new URL(fullUrl).pathname        // includes /api/v4 prefix
 *   queryString    = decodeURIComponent(urlencoded params with + -> space)
 *   hashedPayload  = sha512(body).digest('hex')       // body is '' for GET
 *   signatureString= [METHOD, resourcePath, queryString, hashedPayload, timestamp].join('\n')
 *   SIGN           = HMAC_SHA512(secret, signatureString).digest('hex')
 *   headers        = { KEY, Timestamp, SIGN, Accept, Content-Type }
 *
 * The API secret is used only here, in memory, on the server. It is never
 * serialized into responses, snapshots, exports or logs.
 */
const crypto = require('crypto');
const config = require('./config');

function sha512Hex(buf) {
  return crypto.createHash('sha512').update(buf || '').digest('hex');
}

function hmacSha512Hex(secret, str) {
  return crypto.createHmac('sha512', secret).update(str).digest('hex');
}

/** Build the exact query string Gate expects (percent-decoded, + means space). */
function encodeQuery(params) {
  if (!params || Object.keys(params).length === 0) return '';
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  const encoded = parts.join('&');
  // Gate SDK: querystring.stringify(...).replace(/\+/g,' ') then decodeURIComponent once
  try {
    return decodeURIComponent(encoded.replace(/\+/g, ' '));
  } catch (_) {
    return encoded;
  }
}

/**
 * Perform a signed request.
 * @param {object} opts
 * @param {string} opts.method  HTTP method (uppercase)
 * @param {string} opts.path    path relative to base, e.g. '/spot/accounts'
 * @param {object} [opts.query] query params
 * @param {string} [opts.body]  raw body string (empty for GET)
 */
async function signedRequest({ method = 'GET', path, query = {}, body = '' }) {
  const { key, secret, baseUrl, timeoutMs } = config.gate;
  if (!key || !secret) {
    throw Object.assign(new Error('GATE_API_KEY / GATE_API_SECRET not configured'), { code: 'NO_KEYS' });
  }

  const upper = method.toUpperCase();
  const qs = encodeQuery(query);
  const fullUrl = new URL(baseUrl + path + (qs ? `?${qs}` : ''));
  const resourcePath = fullUrl.pathname;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const hashedPayload = sha512Hex(body);
  const signatureString = [upper, resourcePath, qs, hashedPayload, timestamp].join('\n');
  const sign = hmacSha512Hex(secret, signatureString);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(fullUrl.toString(), {
      method: upper,
      headers: {
        KEY: key,
        Timestamp: timestamp,
        SIGN: sign,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: upper === 'GET' || upper === 'HEAD' ? undefined : (body || '{}'),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!res.ok) {
      const label = (data && (data.label || data.message)) || res.statusText;
      throw Object.assign(new Error(`Gate API ${res.status}: ${label}`), {
        code: 'GATE_HTTP', status: res.status, detail: data,
      });
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error('Gate API request timed out'), { code: 'TIMEOUT' });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Number-safe addition using strings to avoid float precision issues. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch a normalised asset snapshot from the real Gate API.
 * Shape is identical to the mock snapshot so the frontend/DB never care about mode.
 */
async function fetchLiveSnapshot() {
  const accounts = [];
  const holdings = [];
  const notes = [];

  // 1) Total balance across ALL account types, with per-account breakdown.
  //    GET /wallet/total_balance -> { total: AccountBalance, details: {key: AccountBalance} }
  let totalUsd = 0;
  let totalCurrency = 'USD';
  try {
    const tb = await signedRequest({ path: '/wallet/total_balance' });
    if (tb && tb.total) {
      totalUsd = num(tb.total.amount);
      totalCurrency = tb.total.currency || 'USD';
    }
    if (tb && tb.details && typeof tb.details === 'object') {
      for (const [bucket, bal] of Object.entries(tb.details)) {
        if (!bal) continue;
        accounts.push({
          id: bucket,
          label: bucketLabel(bucket),
          amount: num(bal.amount),
          currency: bal.currency || totalCurrency,
          borrowed: num(bal.borrowed),
          unrealisedPnl: num(bal.unrealised_pnl ?? bal.unrealisedPnl),
        });
      }
    }
  } catch (err) {
    notes.push(`wallet/total_balance: ${err.message}`);
    // Fall back to summing spot accounts so the dashboard still shows data.
  }

  // 2) Spot holdings detail + USD valuation. `valueUsd` is what drives the
  //    dashboard weight%, the enrichment "portfolio 24h vs market" comparison
  //    and capital usage — without it every holding looked like 0 USD.
  const priceMap = await fetchPriceMap(notes);
  try {
    const spot = await signedRequest({ path: '/spot/accounts' });
    if (Array.isArray(spot)) {
      for (const a of spot) {
        const available = num(a.available);
        const locked = num(a.locked);
        const amount = available + locked;
        if (amount <= 0) continue;
        const px = num(priceMap[up(a.currency)]);
        const hasPx = px !== null && px > 0;
        holdings.push({
          currency: a.currency, available, locked, amount, venue: 'spot',
          // null (not 0) when there is no usable price: "unknown", not "worthless".
          priceUsd: hasPx ? round(px, 8) : null,
          valueUsd: hasPx ? round(amount * px, 2) : null,
        });
      }
    }
  } catch (err) {
    notes.push(`spot/accounts: ${err.message}`);
  }

  // 3) Futures accounts per settle currency: GET /futures/{settle}/accounts
  for (const settle of config.gate.settles) {
    try {
      const fa = await signedRequest({ path: `/futures/${encodeURIComponent(settle)}/accounts` });
      if (fa && typeof fa === 'object') {
        accounts.push({
          id: `futures_${settle}`,
          label: `合约账户 (${settle.toUpperCase()})`,
          amount: num(fa.total),
          currency: fa.currency || settle.toUpperCase(),
          borrowed: 0,
          unrealisedPnl: num(fa.unrealised_pnl ?? fa.unrealisedPnl),
        });
      }
    } catch (err) {
      notes.push(`futures/${settle}/accounts: ${err.message}`);
    }
  }

  // If total_balance failed, derive a total from whatever we have.
  if (totalUsd === 0 && accounts.length) {
    totalUsd = accounts.reduce((s, a) => s + (a.amount || 0), 0);
  }

  return {
    totalUsd,
    totalCurrency,
    accounts: accounts.sort((a, b) => (b.amount || 0) - (a.amount || 0)),
    holdings: holdings.sort((a, b) => b.amount - a.amount),
    notes,
  };
}

function bucketLabel(bucket) {
  const map = {
    spot: '现货账户', margin: '杠杆账户', futures: '合约账户',
    earn: '理财/赚币', option: '期权账户', unified: '统一账户',
    cross_ex: '跨账户', alpha: 'Alpha 账户', stock: '股票账户',
    total: '总计',
  };
  return map[bucket] || bucket;
}

/* ==========================================================================
 * LIVE FACTS: external cashflows, account ledger, trades, ticker prices.
 *
 * Endpoint paths & fields verified against the official Node SDK:
 *   /wallet/deposits | /wallet/withdrawals      (from/to in SECONDS, offset)
 *   /spot/account_book                          (from/to in SECONDS, page)
 *   /futures/{settle}/account_book              (from/to in SECONDS, offset)
 *   /spot/my_trades                            (currency_pair required)
 *   /spot/tickers                              (public; last price)
 *
 * IMPORTANT accounting rule: ONLY /wallet/deposits|withdrawals are treated as
 * EXTERNAL cashflows (isCashflow=true). Ledger rows of type deposit/withdraw
 * are internal transfers — counting them too would strip the same money twice
 * from the NAV/TWR calculation.
 * ========================================================================== */

function toSec(ms) { return Math.floor(Number(ms) / 1000); }
/** Gate mixes seconds and ms across endpoints; accept both. */
function normTime(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n > 1e12 ? n : n * 1000;
}
function up(v) { return String(v === undefined || v === null ? '' : v).toUpperCase(); }

/** Fetch a USD price map from /spot/tickers (stablecoin-quoted pairs only). */
async function fetchPriceMap(notes) {
  const map = { USDT: 1, USDC: 1, DAI: 1, BUSD: 1, TUSD: 1, FDUSD: 1, USD: 1 };
  try {
    const tickers = await signedRequest({ path: '/spot/tickers' });
    if (Array.isArray(tickers)) {
      for (const t of tickers) {
        const pair = String(t.currency_pair || '');
        const last = num(t.last);
        if (!last || !pair.includes('_')) continue;
        const [base, quote] = pair.split('_');
        if (!base) continue;
        const q = up(quote);
        if (q === 'USDT' || q === 'USD') map[up(base)] = last;
        else if (!map[up(base)] && (q === 'USDC' || q === 'DAI' || q === 'FDUSD')) map[up(base)] = last;
      }
    }
  } catch (err) { notes.push(`spot/tickers: ${err.message}`); }
  return map;
}

/**
 * Split [fromSec, toSecEnd] into consecutive chunks of at most `step` seconds.
 * Gate's ledger endpoints reject a single query whose span exceeds 30 days, so a
 * long backfill has to be walked window by window instead of 400ing out.
 */
const LEDGER_WINDOW_SEC = 30 * 86400;
function timeWindows(fromSec, toSecEnd, step = LEDGER_WINDOW_SEC) {
  const s0 = Number(fromSec);
  const end = Number(toSecEnd);
  if (!Number.isFinite(s0) || !Number.isFinite(end)) return [];
  if (end <= s0) return [[s0, end]];
  const out = [];
  let s = s0;
  while (s < end) {
    const e = Math.min(s + step, end);
    out.push([s, e]);
    s = e;
  }
  return out;
}

/** Single-window paged GET. `pageKey` is 'page' or 'offset' depending on endpoint. */
async function fetchPagedOne(path, query, pageKey, maxPages, notes, label) {
  const out = [];
  for (let i = 0; i < maxPages; i++) {
    try {
      const q = Object.assign({}, query, { limit: 100, [pageKey]: pageKey === 'offset' ? i * 100 : i + 1 });
      const d = await signedRequest({ path, query: q });
      if (!Array.isArray(d) || !d.length) break;
      out.push(...d);
      if (d.length < 100) break;
    } catch (err) { notes.push(`${label}: ${err.message}`); break; }
  }
  return out;
}

/**
 * Paged GET that transparently splits long windows into <=30-day chunks.
 * Gate returns INVALID_PARAM_VALUE when `to` lies in the future OR when the
 * from..to span exceeds 30 days (verified against the live API), so a 90-day
 * backfill is queried as 3 windows instead of failing outright. Queries that
 * carry no from/to pair pass straight through unchanged.
 */
async function fetchPaged(path, query, pageKey, maxPages, notes, label) {
  const from = Number(query && query.from);
  const to = Number(query && query.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    return fetchPagedOne(path, query, pageKey, maxPages, notes, label);
  }
  const out = [];
  for (const [f, t] of timeWindows(from, to)) {
    const part = await fetchPagedOne(
      path, Object.assign({}, query, { from: f, to: t }), pageKey, maxPages, notes, label,
    );
    out.push(...part);
  }
  return out;
}

/**
 * Pull all facts since `sinceMs`. Returns { events, prices, notes, priceMap }.
 * Event IDs are stable so facts.addEvents() deduplicates on every cycle.
 * @param {number} sinceMs  Unix ms
 */
async function fetchLiveFacts(sinceMs) {
  const notes = [];
  const events = [];
  const nowMs = Date.now();
  const from = toSec(sinceMs), to = Math.max(toSec(sinceMs), toSec(nowMs) - 5);
  const priceMap = await fetchPriceMap(notes);
  const usd = (c, amt) => Math.abs(num(amt)) * (priceMap[up(c)] || 0);

  // 1) EXTERNAL cashflows (the only ones that adjust NAV units)
  const deps = await fetchPaged('/wallet/deposits', { from, to }, 'offset', 5, notes, 'wallet/deposits');
  for (const d of deps) {
    const c = up(d.currency), amt = num(d.amount);
    if (!c || !amt) continue;
    const id = 'dep-' + (d.txid || d.id || d.order_id || `${d.timestamp}-${c}-${amt}`);
    events.push({
      id, ts: normTime(d.timestamp || d.time), type: 'deposit', currency: c,
      amount: amt, amountUsd: usd(c, amt), priceUsd: priceMap[c] || 0,
      isCashflow: true, cashflowUsd: usd(c, amt),
      venue: 'wallet', account: 'spot', note: `链上充值${d.chain ? ' · ' + d.chain : ''}`, source: 'live',
    });
  }
  const wds = await fetchPaged('/wallet/withdrawals', { from, to }, 'offset', 5, notes, 'wallet/withdrawals');
  for (const d of wds) {
    const c = up(d.currency), amt = num(d.amount);
    if (!c || !amt) continue;
    const id = 'wd-' + (d.txid || d.id || d.order_id || `${d.timestamp}-${c}-${amt}`);
    events.push({
      id, ts: normTime(d.timestamp || d.time), type: 'withdraw', currency: c,
      amount: -amt, amountUsd: -usd(c, amt), priceUsd: priceMap[c] || 0,
      isCashflow: true, cashflowUsd: -usd(c, amt),
      venue: 'wallet', account: 'spot', note: `链上提现${d.chain ? ' · ' + d.chain : ''}`, source: 'live',
    });
  }

  // 2) Spot ledger — internal movements / fees / costs, NOT external cashflow
  const sb = await fetchPaged('/spot/account_book', { from, to }, 'page', 5, notes, 'spot/account_book');
  for (const b of sb) {
    const c = up(b.currency), ch = num(b.change), t = String(b.type || '').toLowerCase();
    if (!c) continue;
    let type = 'other';
    if (/fee/.test(t)) type = 'fee';
    else if (/trade|deal/.test(t)) type = 'trade';
    else if (/rebate|point|reward/.test(t)) type = 'rebate';
    else if (/interest|earn/.test(t)) type = 'interest';
    else if (/deposit|withdraw|transfer/.test(t)) type = 'transfer';
    const id = 'sb-' + (b.id || `${b.time}-${c}-${ch}`);
    const feeUsd = type === 'fee' ? Math.abs(ch * (priceMap[c] || 0)) : 0;
    events.push({
      id, ts: normTime(b.time), type, currency: c, amount: ch,
      amountUsd: ch * (priceMap[c] || 0), priceUsd: priceMap[c] || 0,
      feeAmount: type === 'fee' ? Math.abs(ch) : 0, feeCurrency: type === 'fee' ? c : '', feeUsd,
      venue: 'spot', account: 'spot', refId: id,
      isRealized: /realis|pnl/.test(t), isCashflow: false,
      note: `原始类型:${b.type || ''} ${b.text || ''}`.trim(), source: 'live',
    });
  }

  // 3) Futures ledger per settle currency (funding / realised pnl / fee)
  for (const settle of config.gate.settles) {
    const path = `/futures/${encodeURIComponent(settle)}/account_book`;
    const fb = await fetchPaged(path, { from, to }, 'offset', 5, notes, `futures/${settle}/account_book`);
    const c = up(settle);
    for (const b of fb) {
      const ch = num(b.change), t = String(b.type || '').toLowerCase();
      let type = 'other';
      if (/fund|dnw/.test(t)) type = 'funding';
      else if (/fee/.test(t)) type = 'fee';
      else if (/pnl|realis/.test(t)) type = 'realized_pnl';
      else if (/refr|bonus|dividend|point/.test(t)) type = 'rebate';
      const id = `fb-${settle}-` + (b.id || b.trade_id || `${b.time}-${ch}`);
      events.push({
        id, ts: normTime(b.time), type, currency: c, amount: ch,
        amountUsd: ch * (priceMap[c] || 0), priceUsd: priceMap[c] || 0,
        feeAmount: num(b.fee), feeCurrency: c, feeUsd: num(b.fee) * (priceMap[c] || 0),
        venue: 'futures', account: `futures_${settle}`,
        pair: b.contract || '', refId: b.trade_id ? 'ftr-' + b.trade_id : id,
        isRealized: /pnl|realis/.test(t), isCashflow: false,
        note: `原始类型:${b.type || ''} ${b.text || ''}`.trim(), source: 'live',
      });
    }
  }

  // 4) Optional fine-grained trade history (requires explicit pairs to bound requests)
  const pairs = (process.env.GATE_TRADE_PAIRS || '').split(',').map(x => x.trim()).filter(Boolean);
  for (const pair of pairs) {
    const mt = await fetchPaged('/spot/my_trades', { currency_pair: pair, from, to }, 'page', 3, notes, `spot/my_trades ${pair}`);
    const [base, quote] = pair.split('_');
    if (!base || !quote) continue;
    for (const t of mt) {
      const id = 'mt-' + t.id, ref = 'trade-' + t.id;
      const price = num(t.price), amount = num(t.amount);
      const side = String(t.side || ''), role = String(t.role || '');
      const fee = num(t.fee), feeC = up(t.fee_currency);
      const ts = normTime(t.create_time_ms || t.create_time);
      events.push({
        id: id + '-b', ts, type: 'trade', currency: up(base),
        amount: side === 'buy' ? amount : -amount,
        amountUsd: (side === 'buy' ? 1 : -1) * price * amount * (priceMap[up(quote)] || 0),
        priceUsd: price * (priceMap[up(quote)] || 0), side, role,
        venue: 'spot', account: 'spot', pair, refId: ref, note: '成交明细·基础腿', source: 'live',
      });
      events.push({
        id: id + '-q', ts, type: 'trade', currency: up(quote),
        amount: side === 'buy' ? -price * amount : price * amount,
        amountUsd: (side === 'buy' ? -1 : 1) * price * amount * (priceMap[up(quote)] || 0),
        priceUsd: priceMap[up(quote)] || 0, side, role,
        venue: 'spot', account: 'spot', pair, refId: ref, note: '成交明细·计价腿', source: 'live',
      });
      if (fee) events.push({
        id: id + '-f', ts, type: 'fee', currency: feeC, amount: -fee,
        amountUsd: -fee * (priceMap[feeC] || 0), priceUsd: priceMap[feeC] || 0,
        feeAmount: fee, feeCurrency: feeC, feeUsd: fee * (priceMap[feeC] || 0),
        venue: 'spot', account: 'spot', pair, refId: ref, note: '成交手续费', source: 'live',
      });
    }
  }

  // 5) Price snapshot (one row per currency, independent series)
  const prices = Object.entries(priceMap).filter(([, p]) => p > 0).map(([c, p]) => ({
    id: `px-${nowMs}-${c}`, ts: nowMs, currency: c, priceUsd: p, quote: 'USD', source: 'live',
  }));

  events.sort((a, b) => a.ts - b.ts);
  return { events, prices, notes, priceMap, from: sinceMs, to: nowMs };
}

/* ==========================================================================
 * PUBLIC MARKET DATA — no API key, no signature.
 *
 * Verified live against GET /api/v4/spot/candlesticks:
 *   [["1795345200","28667985.30","61072.6","61138.4","60828.6","60876.5",
 *     "470.12816000","true"], ...]
 *   fields = [timestamp_sec, quote_volume, close, high, low, open,
 *             base_volume, window_closed]
 * `window_closed` is the STRING "true"/"false". The final, still-open bar MUST
 * be dropped or the benchmark silently contains an incomplete price.
 *
 * Gate caps candlestick history at 10000 bars back from the latest bar, hence
 * a bounded lookback and backwards paging via `to`.
 * ========================================================================== */
async function publicGet(path, query = {}) {
  const { baseUrl, timeoutMs } = config.gate;
  const qs = encodeQuery(query);
  const fullUrl = baseUrl + path + (qs ? `?${qs}` : '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(fullUrl, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!res.ok) {
      const label = (data && (data.label || data.message)) || res.statusText;
      throw Object.assign(new Error(`Gate public API ${res.status}: ${label}`), { code: 'GATE_HTTP', status: res.status, detail: data });
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw Object.assign(new Error('Gate public API timed out'), { code: 'TIMEOUT' });
    throw err;
  } finally { clearTimeout(timer); }
}

function parseCandle(arr, symbol, quote, intervalSec) {
  if (!Array.isArray(arr) || arr.length < 8) return null;
  const tsSec = Number(arr[0]), close = num(arr[2]);
  if (!Number.isFinite(tsSec) || tsSec <= 0 || !(close > 0)) return null;
  return {
    id: `candle-${symbol}-${tsSec}`,
    ts: tsSec * 1000, symbol, quote,
    open: num(arr[5]), high: num(arr[3]), low: num(arr[4]), close,
    baseVolume: num(arr[6]), quoteVolume: num(arr[1]),
    intervalSec,
    windowClosed: String(arr[7]).toLowerCase() === 'true',
    source: 'live',
  };
}

/**
 * Fetch recent CLOSED candles for each configured benchmark symbol.
 * Returns { points, notes, from, to, interval, intervalSec, symbols }.
 * Failures are captured per-symbol in `notes` and NEVER abort collection.
 */
async function fetchMarketCandles(opts = {}) {
  const cfg = config.market;
  const symbols = (opts.symbols && opts.symbols.length ? opts.symbols : cfg.symbols).map(x => String(x).toUpperCase());
  const interval = opts.interval || cfg.candleInterval;
  const intervalSec = opts.intervalSec || cfg.candleIntervalSec;
  const lookbackDays = opts.lookbackDays || cfg.lookbackDays;
  const quote = cfg.quote;
  const notes = [], points = [];
  const toSec = Math.floor(Date.now() / 1000);
  const fromSec = toSec - lookbackDays * 86400;
  const maxBars = Math.min(10000, Math.ceil(lookbackDays * 86400 / intervalSec) + 5);

  for (const symbol of symbols) {
    let collected = 0, cursorTo = toSec, pages = 0;
    while (collected < maxBars && pages < 12) {
      const limit = Math.min(1000, maxBars - collected);
      let rows;
      try {
        rows = await publicGet('/spot/candlesticks', {
          currency_pair: `${symbol}_${quote}`, interval, from: fromSec, to: cursorTo, limit,
        });
      } catch (err) { notes.push(`${symbol}/${interval}: ${err.message}`); break; }
      if (!Array.isArray(rows) || !rows.length) break;
      let oldest = Infinity;
      for (const arr of rows) {
        const p = parseCandle(arr, symbol, quote, intervalSec);
        if (!p || !p.windowClosed) continue;      // skip unfinished bar
        points.push(p);
        if (p.ts < oldest) oldest = p.ts;
      }
      collected += rows.length;
      pages++;
      if (rows.length < limit) break;
      const nextTo = Math.floor(oldest / 1000) - 1;
      if (!Number.isFinite(nextTo) || nextTo <= fromSec || nextTo >= cursorTo) break;
      cursorTo = nextTo;
    }
  }
  const seen = new Set();
  const dedup = points.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
    .sort((a, b) => a.ts - b.ts || a.symbol.localeCompare(b.symbol));
  return { points: dedup, notes, from: fromSec * 1000, to: toSec * 1000, interval, intervalSec, symbols };
}

/* ==========================================================================
 * EXTENDED ENRICHMENT — use the API fields that used to be discarded.
 *
 * Verified live 2026-11-23 against Gate API v4:
 *   GET /spot/tickers            (public) 2160 pairs, 10-13 fields each:
 *       currency_pair, last, lowest_ask, lowest_size, highest_bid,
 *       highest_size, change_percentage, base_volume, quote_volume,
 *       high_24h, low_24h [, etf_*]
 *   GET /wallet/fee              (signed) taker_fee/maker_fee/gt_discount/
 *       futures_*_fee/delivery_*_fee/loan_fee/point_type/...
 *   GET /futures/{settle}/tickers(public) funding_rate, mark_price,
 *       index_price, total_size(open interest), volume_24h_*, ...
 *   GET /spot/order_book         (public) asks/bids depth
 *   GET /spot/open_orders        (signed) working orders by pair
 *   GET /futures/{settle}/positions (signed) leverage, liq_price, ...
 *   GET /margin/accounts         (signed) risk, base/quote borrowed
 *   GET /wallet/total_balance    (signed) details{bucket} borrowed/unrealised_pnl
 *
 * Every request is OPTIONAL and isolated: a failure only adds a note, never
 * aborts the snapshot, and NEVER reaches the dashboard's top error bar.
 * ========================================================================== */

function str(v) { return v === undefined || v === null ? '' : String(v); }
function round(v, d = 6) { const x = Number(v); return Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null; }

/** Full /spot/tickers, reduced to breadth aggregates + full detail for holdings. */
async function fetchTickerEnrichment(holdings, maxDetail, notes) {
  let rows;
  try {
    rows = await publicGet('/spot/tickers');
  } catch (err) {
    notes.push(`spot/tickers: ${err.message}`);
    return null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;

  const held = new Set((holdings || [])
    .map(h => str(h.currency).toUpperCase()).filter(Boolean));
  const changes = [], volumes = [], gainers = [], losers = [];
  const detailMap = new Map();
  let pairs = 0, advancers = 0, decliners = 0, unchanged = 0, totalQuoteVol = 0;

  for (const t of rows) {
    const pair = str(t.currency_pair);
    const last = num(t.last);
    if (!pair || !(last > 0)) continue;
    pairs++;
    const chg = num(t.change_percentage);
    const qv = num(t.quote_volume);
    // Breadth is computed on USDT-quoted pairs only (comparable, no double count).
    if (/_USDT$/i.test(pair)) {
      changes.push(chg); totalQuoteVol += qv;
      if (chg > 0) advancers++; else if (chg < 0) decliners++; else unchanged++;
      volumes.push({ pair, qv });
      const item = { pair, last, changePct: round(chg, 4), quoteVolumeUsd: round(qv, 2),
        high24h: num(t.high_24h), low24h: num(t.low_24h) };
      gainers.push(item); losers.push(item);
    }
    // Full 11-field detail ONLY for currencies I actually hold. Keyed by
    // CURRENCY (not pair) and USDT pairs win, so BTC doesn't appear 4× via
    // BTC_USDT/BTC_USDC/BTC_ETH and the 24h change is always the USDT one.
    const base = pair.split('_')[0].toUpperCase();
    if (held.has(base) && detailMap.size < maxDetail) {
      const quote = (pair.split('_')[1] || '').toUpperCase();
      const cur = detailMap.get(base);
      if (cur && !(quote === 'USDT' && !/_USDT$/.test(cur.pair))) continue;
      const bid = num(t.highest_bid), ask = num(t.lowest_ask);
      const low = num(t.low_24h);
      detailMap.set(base, {
        currency: base, pair, last,
        change24Pct: round(chg, 4),
        high24h: num(t.high_24h), low24h: low,
        amplitude24Pct: low > 0 ? round((num(t.high_24h) / low - 1) * 100, 4) : null,
        baseVolume: num(t.base_volume), quoteVolumeUsd: round(qv, 2),
        highestBid: bid, lowestAsk: ask,
        highestSize: num(t.highest_size), lowestSize: num(t.lowest_size),
        spreadPct: bid > 0 && ask > 0 ? round((ask / bid - 1) * 100, 6) : null,
        etf: Object.keys(t).filter(k => /^etf_/.test(k)).length > 0,
      });
    }
  }
  changes.sort((a, b) => a - b);
  const median = changes.length ? changes[Math.floor(changes.length / 2)] : null;
  const mean = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : null;
  gainers.sort((a, b) => b.changePct - a.changePct);
  losers.sort((a, b) => a.changePct - b.changePct);
  const byVol = volumes.slice().sort((a, b) => b.qv - a.qv).slice(0, 5)
    .map(x => ({ pair: x.pair, quoteVolumeUsd: round(x.qv, 2) }));

  return {
    pairs, usdtPairs: changes.length,
    advancers, decliners, unchanged,
    upRatioPct: changes.length ? round(advancers / changes.length * 100, 2) : null,
    medianChangePct: round(median, 4), meanChangePct: round(mean, 4),
    totalQuoteVolumeUsd: round(totalQuoteVol, 2),
    topGainers: gainers.slice(0, 5), topLosers: losers.slice(0, 5),
    topByVolume: byVol,
    holdingsDetail: Array.from(detailMap.values()),
  };
}

/** Nominal fee schedule from /wallet/fee. */
async function fetchFeeSchedule(notes) {
  try {
    const d = await signedRequest({ path: '/wallet/fee' });
    const x = Array.isArray(d) ? d[0] : d;
    if (!x || typeof x !== 'object') return null;
    return {
      userId: str(x.user_id),
      takerFeePct: round(num(x.taker_fee) * 100, 5),
      makerFeePct: round(num(x.maker_fee) * 100, 5),
      futuresTakerFeePct: round(num(x.futures_taker_fee) * 100, 5),
      futuresMakerFeePct: round(num(x.futures_maker_fee) * 100, 5),
      deliveryTakerFeePct: round(num(x.delivery_taker_fee) * 100, 5),
      deliveryMakerFeePct: round(num(x.delivery_maker_fee) * 100, 5),
      gtDiscount: /^(true|1)$/i.test(str(x.gt_discount)),
      gtTakerFeePct: round(num(x.gt_taker_fee) * 100, 5),
      gtMakerFeePct: round(num(x.gt_maker_fee) * 100, 5),
      loanFeePct: round(num(x.loan_fee) * 100, 5),
      pointType: str(x.point_type), debitFee: str(x.debit_fee),
      raw: x,
    };
  } catch (err) { notes.push(`wallet/fee: ${err.message}`); return null; }
}

/** Public futures tickers: funding rate / mark / index / open interest. */
async function fetchFuturesMarket(contracts, settle, notes) {
  const out = [];
  for (const c of (contracts || [])) {
    try {
      const d = await publicGet(`/futures/${encodeURIComponent(settle)}/tickers`, { contract: c });
      const x = Array.isArray(d) ? d[0] : d;
      if (!x || typeof x !== 'object') continue;
      out.push({
        contract: str(x.contract) || c,
        last: num(x.last), markPrice: num(x.mark_price), indexPrice: num(x.index_price),
        fundingRatePct: round(num(x.funding_rate) * 100, 6),
        fundingRateIndicativePct: round(num(x.funding_rate_indicative) * 100, 6),
        openInterest: num(x.total_size),            // 未平仓合约张数
        volume24hQuote: num(x.volume_24h_quote),
        high24h: num(x.high_24h), low24h: num(x.low_24h),
        change24Pct: round(num(x.change_percentage), 4),
        basisPct: num(x.index_price) > 0 ? round((num(x.mark_price) / num(x.index_price) - 1) * 100, 6) : null,
        raw: x,
      });
    } catch (err) { notes.push(`futures/tickers ${c}: ${err.message}`); }
  }
  return out;
}

/** Top-of-book depth for the pairs I care about. */
async function fetchOrderBooks(pairs, notes) {
  const out = [];
  for (const pair of (pairs || [])) {
    try {
      const d = await publicGet('/spot/order_book', { currency_pair: pair, limit: '5' });
      const x = Array.isArray(d) ? d[0] : d;
      if (!x || typeof x !== 'object') continue;
      const asks = Array.isArray(x.asks) ? x.asks : [];
      const bids = Array.isArray(x.bids) ? x.bids : [];
      const ask = num(asks[0] && asks[0][0]), bid = num(bids[0] && bids[0][0]);
      const depth = (arr) => arr.slice(0, 5).reduce((s, r) => s + num(r[0]) * num(r[1]), 0);
      out.push({ pair, bestAsk: ask, bestBid: bid,
        spreadPct: bid > 0 && ask > 0 ? round((ask / bid - 1) * 100, 6) : null,
        askDepthUsd: round(depth(asks), 2), bidDepthUsd: round(depth(bids), 2),
        levels: Math.min(asks.length, bids.length),
      });
    } catch (err) { notes.push(`order_book ${pair}: ${err.message}`); }
  }
  return out;
}

/** Signed account state: open orders / positions / margin, each isolated. */
async function fetchAccountState(settle, notes) {
  const out = { openOrders: [], positions: [], margin: [], openOrderCount: 0, positionCount: 0, marginCount: 0 };
  try {
    const d = await signedRequest({ path: '/spot/open_orders' });
    if (Array.isArray(d)) {
      for (const g of d) {
        const orders = Array.isArray(g.orders) ? g.orders : [];
        out.openOrders.push({ pair: str(g.currency_pair), total: num(g.total),
          sides: Array.from(new Set(orders.map(o => str(o.side)).filter(Boolean))) });
      }
      out.openOrderCount = out.openOrders.reduce((s, g) => s + g.total, 0);
    }
  } catch (err) { notes.push(`spot/open_orders: ${err.message}`); }
  try {
    const d = await signedRequest({ path: `/futures/${encodeURIComponent(settle)}/positions` });
    if (Array.isArray(d)) {
      for (const p of d) {
        if (!(num(p.size) !== 0)) continue;
        out.positions.push({ contract: str(p.contract), size: num(p.size),
          leverage: str(p.leverage), liqPrice: num(p.liq_price), markPrice: num(p.mark_price),
          unrealisedPnl: num(p.unrealised_pnl), margin: num(p.margin), mode: str(p.mode) });
      }
      out.positionCount = out.positions.length;
    }
  } catch (err) { notes.push(`futures/${settle}/positions: ${err.message}`); }
  try {
    const d = await signedRequest({ path: '/margin/accounts' });
    if (Array.isArray(d)) {
      for (const m of d) {
        const base = typeof m.base === 'string' ? (() => { try { return JSON.parse(m.base); } catch (_) { return {}; } })() : (m.base || {});
        out.margin.push({ pair: str(m.currency_pair), risk: str(m.risk), locked: /^(true|1)$/i.test(str(m.locked)),
          baseBorrowed: num(base.borrowed), quoteBorrowed: num((m.quote && m.quote.borrowed) || 0) });
      }
      out.marginCount = out.margin.length;
    }
  } catch (err) { notes.push(`margin/accounts: ${err.message}`); }
  return out;
}

/**
 * Orchestrate ONE enriched snapshot. Returns a compact, fully serialisable
 * record. `snapshot` supplies accounts/holdings so no duplicate balance call.
 * The raw payloads are trimmed to a bounded size and kept for export.
 */
async function fetchEnrichment({ snapshot, cfg }) {
  const notes = [];
  const nowMs = Date.now();
  // Rank by USD value so the detail/book budget goes to what actually matters,
  // not to dust or delisted tickers (e.g. KISHU_USDT rejects with 400).
  const holdings = ((snapshot && snapshot.holdings) || []).slice()
    .sort((a, b) => (num(b.valueUsd) || 0) - (num(a.valueUsd) || 0));
  const settle = (cfg && cfg.settle) || 'usdt';
  const maxDetail = (cfg && cfg.maxDetail) || 40;

  const tickers = await fetchTickerEnrichment(holdings, maxDetail, notes);
  const fee = await fetchFeeSchedule(notes);
  const futures = await fetchFuturesMarket((cfg && cfg.contracts) || [], settle, notes);

  // Book pairs: held USDT pairs first (by value, dust skipped), then benchmarks.
  const wanted = [];
  for (const h of holdings) {
    const c = str(h.currency).toUpperCase();
    if (c && c !== 'USDT' && c !== 'USD' && (num(h.valueUsd) || 0) >= 10) wanted.push(`${c}_USDT`);
  }
  for (const s of ((cfg && cfg.symbols) || [])) {
    const c = str(s).toUpperCase();
    if (c && c !== 'USDT') wanted.push(`${c}_USDT`);
  }
  const bookPairs = Array.from(new Set(wanted)).slice(0, (cfg && cfg.maxBookPairs) || 6);
  const books = await fetchOrderBooks(bookPairs, notes);
  const account = (cfg && cfg.probeAccounts !== false)
    ? await fetchAccountState(settle, notes) : null;

  // Capital usage from the ALREADY-FETCHED snapshot (no extra request).
  const accounts = (snapshot && snapshot.accounts) || [];
  let borrowedUsd = 0, unrealisedPnlUsd = 0, lockedQty = 0, availableQty = 0, lockedValueUsd = 0;
  for (const a of accounts) { borrowedUsd += num(a.borrowed) || 0; unrealisedPnlUsd += num(a.unrealisedPnl) || 0; }
  for (const h of holdings) {
    const l = num(h.locked) || 0, av = num(h.available) || 0, v = num(h.valueUsd) || 0;
    lockedQty += l; availableQty += av;
    // Value-weighted frozen share: summing raw token quantities across BTC and
    // DOGE is meaningless, so express the locked portion in USD instead.
    if (l + av > 0) lockedValueUsd += v * l / (l + av);
  }
  const totalUsd = num(snapshot && snapshot.totalUsd);

  return {
    ts: nowMs, source: 'live',
    pairs: tickers ? tickers.pairs : null,
    breadth: tickers ? {
      usdtPairs: tickers.usdtPairs, advancers: tickers.advancers, decliners: tickers.decliners,
      unchanged: tickers.unchanged, upRatioPct: tickers.upRatioPct,
      medianChangePct: tickers.medianChangePct, meanChangePct: tickers.meanChangePct,
      totalQuoteVolumeUsd: tickers.totalQuoteVolumeUsd,
      topGainers: tickers.topGainers, topLosers: tickers.topLosers, topByVolume: tickers.topByVolume,
    } : null,
    holdingsDetail: tickers ? tickers.holdingsDetail : [],
    fee: fee ? Object.fromEntries(Object.entries(fee).filter(([k]) => k !== 'raw')) : null,
    futures: futures.map(f => Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'raw'))),
    books, account,
    capital: {
      totalUsd: round(totalUsd, 2), borrowedUsd: round(borrowedUsd, 2),
      unrealisedPnlUsd: round(unrealisedPnlUsd, 2),
      borrowedToTotalPct: totalUsd > 0 ? round(borrowedUsd / totalUsd * 100, 4) : null,
      unrealisedToTotalPct: totalUsd > 0 ? round(unrealisedPnlUsd / totalUsd * 100, 4) : null,
      lockedQty: round(lockedQty, 8), availableQty: round(availableQty, 8),
      lockedSharePct: totalUsd > 0 ? round(lockedValueUsd / totalUsd * 100, 4) : null,
    },
    notes,
    // Bounded raw payload for third-party replay (never the 2160-row array).
    payload: {
      feeRaw: fee ? fee.raw : null,
      futuresRaw: futures.map(f => f.raw),
      openOrders: account ? account.openOrders : null,
      positions: account ? account.positions : null,
      margin: account ? account.margin : null,
    },
  };
}

module.exports = {
  signedRequest, fetchLiveSnapshot, fetchLiveFacts, fetchPriceMap,
  publicGet, fetchMarketCandles, parseCandle, timeWindows,
  sha512Hex, hmacSha512Hex, encodeQuery,
  fetchTickerEnrichment, fetchFeeSchedule, fetchFuturesMarket,
  fetchOrderBooks, fetchAccountState, fetchEnrichment,
};
