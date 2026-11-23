'use strict';

/**
 * Append-only FACT datasets with a tamper-evident SHA-256 hash chain.
 *
 * Datasets (all under config.storage.dir):
 *   events.jsonl    外部现金流 / 成交 / 手续费 / 资金费 / 划转 / 强平 ...
 *   prices.jsonl    每时点每币种的 USD 单价（独立的行情留存）
 *   decisions.jsonl 人工决策日志（事件溯源：create/edit/review/delete 折叠成当前状态）
 *   market.jsonl     主流币基准 K 线（Gate 公开端点，无需密钥；或 DEMO 市场因子）
 *   macro_events.jsonl 宏观/市场事件台账（事件溯源：manual/auto/mock）
 *   annotations.jsonl 针对真实 Gate「操作记录」的注释（动机/止盈/止损/复盘，事件溯源）
 *   reports.jsonl    每日日报历史（append-only，可导出复盘）
 *   enrichment.jsonl 扩展只读端点低频聚合快照（全市场宽度/费率/合约资金费/盘口/账户状态，v5）
 *
 * Each record carries  seq / ts / prevHash / hash :
 *   hash = sha256(prevHash + "\n" + stableJSON(record without hash & prevHash))
 *   prevHash of the first record = 64 zeros (GENESIS)
 *
 * This makes silent edits / deletions detectable via integrity(). Chain state
 * is rebuilt in memory on boot. Zero external dependencies.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const GENESIS = '0'.repeat(64);

function stable(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function s(v) { return v === undefined || v === null ? '' : String(v); }

/** Strip caller-supplied chain metadata so it cannot be forged. */
function stripMeta(o) {
  const out = {};
  for (const k of Object.keys(o)) {
    if (k === 'seq' || k === 'hash' || k === 'prevHash') continue;
    out[k] = o[k];
  }
  return out;
}
/** Canonical signed body: everything except the two hash fields. Must be
 *  IDENTICAL in append() and verify(), otherwise integrity always fails. */
function bodyOf(o) {
  const out = {};
  for (const k of Object.keys(o)) {
    if (k === 'hash' || k === 'prevHash') continue;
    out[k] = o[k];
  }
  return out;
}

class Chain {
  constructor(name) {
    this.name = name;
    this.file = path.join(config.storage.dir, name + '.jsonl');
    this._rows = null;
  }
  _ensure() {
    fs.mkdirSync(config.storage.dir, { recursive: true });
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, '', 'utf8');
  }
  load() {
    if (this._rows) return this._rows;
    this._ensure();
    const rows = [];
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o && typeof o === 'object') rows.push(o); } catch (_) { /* skip corrupt line */ }
    }
    this._rows = rows;
    return rows;
  }
  append(payload) {
    const rows = this.load();
    const prev = rows.length ? rows[rows.length - 1].hash : GENESIS;
    const rec = Object.assign({ seq: rows.length + 1, ts: Date.now() }, stripMeta(payload), { prevHash: prev });
    rec.hash = sha(prev + '\n' + stable(bodyOf(rec)));
    fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', 'utf8');
    rows.push(rec);
    return rec;
  }
  /** Append many, skipping records whose `dedupKey` already exists. Returns #added. */
  appendMany(payloads, dedupKey) {
    const rows = this.load();
    const seen = dedupKey ? new Set(rows.map(r => r[dedupKey]).filter(Boolean)) : null;
    let added = 0;
    for (const p of payloads) {
      if (seen && p[dedupKey]) {
        if (seen.has(p[dedupKey])) continue;
        seen.add(p[dedupKey]);
      }
      this.append(p);
      added++;
    }
    return added;
  }
  range(from, to) {
    const rows = this.load();
    return rows.filter(r => (from === undefined || r.ts >= from) && (to === undefined || r.ts <= to));
  }
  count() { return this.load().length; }
  last() { const r = this.load(); return r.length ? r[r.length - 1] : null; }
  /** Verify the whole chain by RE-READING THE FILE (never the in-memory
   *  cache), so on-disk tampering is actually detectable. */
  verify() {
    this._ensure();
    const rows = [];
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o && typeof o === 'object') rows.push(o); }
      catch (_) { return { ok: false, checked: rows.length, reason: '文件含无法解析的行' }; }
    }
    let prev = GENESIS;
    for (const r of rows) {
      const { hash, prevHash } = r;
      if (prevHash !== prev) return { ok: false, checked: r.seq, brokenAt: r.seq, reason: 'prevHash 不连续（记录被删除或重排）' };
      if (sha(prev + '\n' + stable(bodyOf(r))) !== hash) return { ok: false, checked: r.seq, brokenAt: r.seq, reason: '记录 hash 不匹配（内容被改动）' };
      prev = hash;
    }
    return { ok: true, checked: rows.length };
  }
  reset() { this._ensure(); fs.writeFileSync(this.file, '', 'utf8'); this._rows = []; }
  fileSize() { this._ensure(); return fs.statSync(this.file).size; }
}

const events = new Chain('events');
const prices = new Chain('prices');
const decisions = new Chain('decisions');
const market = new Chain('market');
const macroEvents = new Chain('macro_events');
const annotations = new Chain('annotations');
const reports = new Chain('reports');
const enrichment = new Chain('enrichment');

/* ------------------------------ normalisers ------------------------------ */

/** Normalise an event into a fixed, export-friendly column set. */
function normalizeEvent(e) {
  return {
    id: s(e.id),
    ts: Number(e.ts) || Date.now(),
    type: s(e.type) || 'other',           // deposit|withdraw|trade|fee|funding|interest|transfer|liquidation|rebate|other
    currency: s(e.currency).toUpperCase(),
    amount: n(e.amount),                  // signed quantity change of `currency`
    amountUsd: n(e.amountUsd),            // signed USD value at execution
    priceUsd: n(e.priceUsd),
    feeAmount: n(e.feeAmount),
    feeCurrency: s(e.feeCurrency).toUpperCase(),
    feeUsd: n(e.feeUsd),
    side: s(e.side),                      // buy|sell|maker|taker|long|short|(empty)
    role: s(e.role),                      // maker|taker (from Gate trade)
    venue: s(e.venue),                    // spot|futures|earn|margin|wallet
    account: s(e.account),
    pair: s(e.pair),
    refId: s(e.refId),                    // groups the legs of one trade
    isCashflow: !!e.isCashflow,           // external money in/out of the whole portfolio
    cashflowUsd: n(e.cashflowUsd),        // +deposit / -withdraw (USD)
    isRealized: !!e.isRealized,          // realised pnl / cost, not market revaluation
    source: s(e.source) || 'live',        // live|mock|manual
    note: s(e.note),
  };
}

function normalizePrice(p) {
  return {
    id: s(p.id) || `${Number(p.ts)}-${s(p.currency).toUpperCase()}`,
    ts: Number(p.ts) || Date.now(),
    currency: s(p.currency).toUpperCase(),
    priceUsd: n(p.priceUsd),
    quote: s(p.quote) || 'USD',
    source: s(p.source) || 'live',
  };
}


/* ------------------------------- market ---------------------------------- */
/**
 * Benchmark OHLCV bars from Gate PUBLIC endpoints (no signature required), or
 * from the deterministic DEMO market factor. Stored INDEPENDENTLY of `prices`
 * (which are MY portfolio's valuation marks) so a third party can compare
 * against an authoritative market series even when I hold no BTC at all.
 */
function normalizeMarketPoint(p) {
  return {
    id: s(p.id) || `${Number(p.ts)}-${s(p.symbol).toUpperCase()}`,
    ts: Number(p.ts) || Date.now(),
    symbol: s(p.symbol).toUpperCase(),
    quote: s(p.quote) || 'USDT',
    open: n(p.open), high: n(p.high), low: n(p.low), close: n(p.close),
    baseVolume: n(p.baseVolume), quoteVolume: n(p.quoteVolume),
    intervalSec: n(p.intervalSec) || 3600,
    windowClosed: p.windowClosed !== false,
    source: s(p.source) || 'live',
  };
}
function addMarketPoints(list, source) {
  return market.appendMany(list.map(p => normalizeMarketPoint(Object.assign({}, p, { source: source || p.source }))), 'id');
}
function listMarketPoints(opts = {}) {
  let rows = market.range(opts.from, opts.to);
  const syms = opts.symbols && opts.symbols.length ? opts.symbols.map(x => s(x).toUpperCase()) : null;
  if (opts.symbol) rows = rows.filter(r => r.symbol === s(opts.symbol).toUpperCase());
  else if (syms) rows = rows.filter(r => syms.includes(r.symbol));
  return rows.sort((a, b) => a.ts - b.ts);
}

/* ---------------------------- macro events ------------------------------- */
/**
 * Macro / market event ledger. Event-sourced like decisions: create / edit /
 * delete are append-only records; listMacroEvents() folds to current state.
 * Business time lives in `eventTs` so it can never be confused with the
 * chain's own write timestamp `ts`.
 *
 * Sources are explicit and honest: manual (you annotate), auto (detected from
 * benchmark price jumps), mock (DEMO). No live news feed is faked here.
 */
const MACRO_CATEGORIES = ['macro', 'policy', 'onchain', 'listing', 'security', 'volatility', 'custom'];
function macroEventId() {
  return 'me-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}
function normalizeMacroRecord(e) {
  const rid = s(e.id) || macroEventId();
  const cat = s(e.category).toLowerCase(), imp = s(e.impact).toLowerCase();
  return {
    id: rid, op: s(e.op) || 'create', eventId: s(e.eventId) || rid,
    eventTs: Number(e.ts || e.eventTs) || Date.now(),
    category: MACRO_CATEGORIES.includes(cat) ? cat : 'custom',
    title: s(e.title), summary: s(e.summary || e.note),
    impact: ['bullish', 'bearish', 'neutral', 'unknown'].includes(imp) ? imp : 'unknown',
    symbols: Array.isArray(e.symbols)
      ? e.symbols.map(x => s(x).toUpperCase()).filter(Boolean)
      : s(e.symbols).split(',').map(x => x.trim().toUpperCase()).filter(Boolean),
    source: s(e.source) || 'manual', url: s(e.url), note: s(e.note),
  };
}
function addMacroEvent(e) { return macroEvents.append(normalizeMacroRecord(e)); }
function addMacroEvents(list) { return macroEvents.appendMany(list.map(normalizeMacroRecord), 'id'); }
function editMacroEvent(id, patch) {
  const cur = listMacroEvents().find(e => e.eventId === id);
  if (!cur) return null;
  return macroEvents.append(Object.assign({ id: 'mee-' + Date.now().toString(36), op: 'edit', eventId: id, source: 'manual' }, stripMeta(patch)));
}
function deleteMacroEvent(id) {
  return macroEvents.append({ id: 'med-' + Date.now().toString(36), op: 'delete', eventId: id, source: 'manual' });
}
function listMacroEvents() {
  const map = new Map();
  for (const r of macroEvents.load()) {
    if (r.op === 'delete') { map.delete(r.eventId); continue; }
    const { id, op, ts: chainTs, source, ...business } = stripMeta(r);
    const merged = Object.assign({}, map.get(r.eventId) || {}, business);
    map.set(r.eventId, Object.assign(merged, {
      eventId: r.eventId, ts: merged.eventTs || chainTs,
      source: merged.source || 'manual',
    }));
  }
  return Array.from(map.values()).sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
function listMacroEventLog() { return macroEvents.load(); }

/**
 * Detect "major move" events from benchmark bars. Objective & replayable:
 * identical bars always produce identical events, and stable IDs mean
 * re-collection never duplicates them.
 */
function detectAutoMarketEvents(points, thresholdPct, intervalSec) {
  const by = new Map();
  for (const p of points) {
    if (!p.symbol || !(p.close > 0)) continue;
    if (!by.has(p.symbol)) by.set(p.symbol, []);
    by.get(p.symbol).push(p);
  }
  const out = [];
  for (const [symbol, rows] of by) {
    rows.sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1].close, cur = rows[i].close;
      if (!(prev > 0) || !(cur > 0)) continue;
      const ret = (cur / prev - 1) * 100;
      if (Math.abs(ret) < thresholdPct) continue;
      const mins = Math.max(1, Math.round((intervalSec || 3600) / 60));
      out.push({
        id: `auto-${symbol}-${rows[i].ts}`, ts: rows[i].ts,
        category: 'volatility',
        title: `${symbol} ${mins}分钟内${ret > 0 ? '上涨' : '下跌'} ${Math.abs(ret).toFixed(2)}%`,
        summary: `由公开 K 线自动检测的价格异动（阈值 ${thresholdPct}%）：${symbol} ${prev} → ${cur}`,
        impact: ret > 0 ? 'bullish' : 'bearish', symbols: [symbol],
        source: 'auto', note: `auto-detected | bar return ${ret.toFixed(4)}%`,
      });
    }
  }
  return out;
}

function addEvents(list, source) {
  return events.appendMany(list.map(e => normalizeEvent(Object.assign({}, e, { source: source || e.source }))), 'id');
}
function addPrices(list, source) {
  return prices.appendMany(list.map(p => normalizePrice(Object.assign({}, p, { source: source || p.source }))), 'id');
}
function listEvents(opts = {}) {
  let rows = events.range(opts.from, opts.to);
  if (opts.types && opts.types.length) rows = rows.filter(r => opts.types.includes(r.type));
  if (opts.cashflowOnly) rows = rows.filter(r => r.isCashflow);
  return rows;
}
function listPrices(opts = {}) { return prices.range(opts.from, opts.to); }
function cashflows(opts = {}) { return listEvents(Object.assign({}, opts, { cashflowOnly: true })); }

/* -------------------------------- decisions ------------------------------ */
/**
 * Decision log is event-sourced: every create / edit / review / delete is a new
 * append-only record keyed by decisionId. listDecisions() folds them into the
 * current state, so the audit trail is never rewritten.
 */
function decisionId() {
  return 'dec-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}
function addDecision(d) {
  const id = d.id || decisionId();
  return decisions.append({
    id, op: 'create', decisionId: id,
    decidedAt: Number(d.decidedAt) || Date.now(),
    action: s(d.action) || 'other',        // buy|sell|deposit|withdraw|rebalance|hold|other
    symbol: s(d.symbol).toUpperCase(),
    amount: n(d.amount), priceUsd: n(d.priceUsd), valueUsd: n(d.valueUsd),
    reason: s(d.reason), expectation: s(d.expectation),
    tags: Array.isArray(d.tags) ? d.tags.map(s) : s(d.tags).split(',').map(x => x.trim()).filter(Boolean),
    reviewNote: '', outcome: '', reviewedAt: null,
    source: 'manual', note: s(d.note),
  });
}
function reviewDecision(id, review) {
  const cur = listDecisions().find(d => d.decisionId === id);
  if (!cur) return null;
  return decisions.append({
    id: 'rev-' + Date.now().toString(36), op: 'review', decisionId: id,
    reviewNote: s(review.reviewNote || review.note),
    outcome: s(review.outcome),            // better|as_expected|worse|abandoned
    reviewedAt: Number(review.reviewedAt) || Date.now(),
    source: 'manual',
  });
}
function editDecision(id, patch) {
  const cur = listDecisions().find(d => d.decisionId === id);
  if (!cur) return null;
  return decisions.append(Object.assign({ id: 'edt-' + Date.now().toString(36), op: 'edit', decisionId: id, source: 'manual' }, stripMeta(patch)));
}
function deleteDecision(id) {
  return decisions.append({ id: 'del-' + Date.now().toString(36), op: 'delete', decisionId: id, source: 'manual' });
}
function listDecisions() {
  const map = new Map();
  for (const r of decisions.load()) {
    if (r.op === 'delete') { map.delete(r.decisionId); continue; }
    // Only merge business fields; operation metadata (id/op/ts of the edit)
    // must not overwrite the original decision's identity/timestamp.
    const { id, op, ts, source, ...business } = stripMeta(r);
    map.set(r.decisionId, Object.assign({}, map.get(r.decisionId) || {}, business, { decisionId: r.decisionId, source: 'manual' }));
  }
  return Array.from(map.values()).sort((a, b) => (b.decidedAt || b.ts || 0) - (a.decidedAt || a.ts || 0));
}

/* --------------------------- operation annotations ----------------------- */
/**
 * ANNOTATIONS — the user's subjective layer on top of READ-ONLY Gate
 * "operation records" (see src/operations.js). Operations themselves come
 * from Gate and are never written here; only the user's notes about a given
 * operation are stored, keyed by its stable `operationId`.
 *
 * Event-sourced like decisions/macros: create/edit/delete/review are all
 * append-only; listAnnotations() folds them into the current state. A user can
 * record: 动机 motive / 止盈 takeProfit / 止损 stopLoss / 预期 expectation /
 * 标签 tags / 复盘 reviewNote / 结果 outcome.
 */
function annotationRecId() {
  return 'an-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}
function normalizeAnnotationRecord(a) {
  const op = ['create', 'edit', 'delete', 'review'].includes(s(a.op)) ? a.op : 'create';
  return {
    id: s(a.id) || annotationRecId(), op,
    operationId: s(a.operationId || a.targetId),
    motive: s(a.motive), takeProfit: s(a.takeProfit), stopLoss: s(a.stopLoss),
    expectation: s(a.expectation),
    tags: Array.isArray(a.tags) ? a.tags.map(s).filter(Boolean)
      : s(a.tags).split(',').map(x => x.trim()).filter(Boolean),
    reviewNote: s(a.reviewNote),
    outcome: ['better', 'as_expected', 'worse', 'abandoned', ''].includes(s(a.outcome)) ? s(a.outcome) : '',
    reviewedAt: a.reviewedAt ? Number(a.reviewedAt) : null,
    source: 'manual', note: s(a.note),
  };
}
/**
 * Upsert an annotation for one operation. `op` is derived automatically:
 * no existing annotation -> create, otherwise edit. A `review` op only
 * touches review fields. All writes are appended (audit trail preserved).
 */
function addAnnotation(a) {
  const target = s(a && (a.operationId || a.targetId));
  if (!target) return null;
  const cur = listAnnotations().find(x => x.operationId === target);
  const op = s(a.op) === 'review' ? 'review' : (cur ? 'edit' : 'create');
  return annotations.append(normalizeAnnotationRecord(Object.assign({}, a, { op })));
}
function reviewAnnotation(operationId, review) {
  if (!listAnnotations().find(x => x.operationId === s(operationId))) return null;
  return annotations.append(normalizeAnnotationRecord({
    op: 'review', operationId, reviewNote: s(review && (review.reviewNote || review.note)),
    outcome: s(review && review.outcome), reviewedAt: Number(review && review.reviewedAt) || Date.now(),
  }));
}
function deleteAnnotation(operationId) {
  if (!operationId) return null;
  return annotations.append(normalizeAnnotationRecord({ op: 'delete', operationId }));
}
/** Fold the annotation chain into current state, keyed by operationId. */
function listAnnotations() {
  const map = new Map();
  for (const r of annotations.load()) {
    const key = r.operationId;
    if (!key) continue;
    if (r.op === 'delete') { map.delete(key); continue; }
    const prev = map.get(key) || { reviewNote: '', outcome: '', reviewedAt: null, motive: '', takeProfit: '', stopLoss: '', expectation: '', tags: [] };
    // A `review` record only updates review fields (keeps motive/TP/SL intact);
    // create/edit only touch the subjective fields (keeps any prior review).
    const business = r.op === 'review'
      ? { reviewNote: s(r.reviewNote), outcome: s(r.outcome), reviewedAt: r.reviewedAt || null }
      : {
        motive: s(r.motive), takeProfit: s(r.takeProfit), stopLoss: s(r.stopLoss),
        expectation: s(r.expectation), tags: Array.isArray(r.tags) ? r.tags : [],
      };
    map.set(key, Object.assign({}, prev, business, {
      operationId: key, annotatedAt: r.ts || Date.now(), source: 'manual',
    }));
  }
  return Array.from(map.values());
}
function annotationMap() { return new Map(listAnnotations().map(a => [a.operationId, a])); }
function listAnnotationEvents() { return annotations.load(); }

/* ------------------------------ report history --------------------------- */
/**
 * Every generated daily report is appended here (append-only, hash-chained),
 * so reports are themselves exportable / replayable like all other data.
 * The full markdown is kept (one report/day is tiny); the webhook URL never is.
 */
function addReport(rep, extra = {}) {
  return reports.append({
    id: 'rp-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    ts: Number(rep.meta && rep.meta.generatedAt ? Date.parse(rep.meta.generatedAt) : Date.now()) || Date.now(),
    date: s(rep.meta && rep.meta.date),
    tzLabel: s(rep.meta && rep.meta.tzLabel),
    mode: s(rep.meta && rep.meta.mode),
    trigger: s(extra.trigger) || 'manual',
    headline: s(rep.headline),
    windowReliable: !!(rep.meta && rep.meta.windowReliable),
    snapshotCount: Number(rep.meta && rep.meta.snapshotCount) || 0,
    keyMetrics: rep.keyMetrics || {},
    observations: (rep.observations || []).map(o => ({ level: o.level, title: o.title, basis: o.basis })),
    sections: (rep.sections || []).map(sec => ({ key: sec.key, title: sec.title })),
    markdown: s(rep.markdown),
    chunks: (rep.markdownChunks || []).length,
    pushed: !!extra.pushed,
    pushOk: extra.pushOk === undefined ? null : !!extra.pushOk,
    pushedTo: s(extra.pushedTo),      // masked webhook only, never the secret
    pushMessage: s(extra.pushMessage),
    sent: Number(extra.sent) || 0,
    failed: Number(extra.failed) || 0,
    disclaimer: s(rep.disclaimer),
  });
}
function listReports(limit) {
  const rows = reports.load().slice();
  rows.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  return limit ? rows.slice(0, limit) : rows;
}
function reportByDate(date) { return listReports().find(r => r.date === s(date)) || null; }

/* --------------------------- enrichment (v5) ---------------------------- */
/**
 * Low-frequency snapshots of the extended read-only Gate endpoints. Written
 * at most once per `priceSampleEvery` collector cycles, so the file stays
 * tiny even though the underlying /spot/tickers response is ~2160 rows.
 * `payload` keeps the bounded raw sub-endpoint replies for third-party replay.
 * The webhook / API secret are NEVER part of this record.
 */
function normalizeEnrichment(e) {
  return {
    id: s(e.id) || `enr-${Number(e.ts) || Date.now()}`,
    ts: Number(e.ts) || Date.now(),
    source: s(e.source) || 'live',
    pairs: e.pairs === null || e.pairs === undefined ? null : n(e.pairs),
    breadth: e.breadth && typeof e.breadth === 'object' ? e.breadth : null,
    holdingsDetail: Array.isArray(e.holdingsDetail) ? e.holdingsDetail : [],
    fee: e.fee && typeof e.fee === 'object' ? e.fee : null,
    futures: Array.isArray(e.futures) ? e.futures : [],
    books: Array.isArray(e.books) ? e.books : [],
    account: e.account && typeof e.account === 'object' ? e.account : null,
    capital: e.capital && typeof e.capital === 'object' ? e.capital : null,
    notes: Array.isArray(e.notes) ? e.notes.map(s) : [],
    payload: e.payload && typeof e.payload === 'object' ? e.payload : null,
    mode: s(e.mode) || '',
  };
}
function addEnrichment(e, mode) {
  return enrichment.append(normalizeEnrichment(Object.assign({}, e, { mode: mode || e.mode })));
}
function listEnrichment(opts = {}) {
  let rows = enrichment.range(opts.from, opts.to);
  const mode = opts.mode;
  if (mode) rows = rows.filter(r => s(r.mode) === mode);
  rows.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  return opts.limit ? rows.slice(-Number(opts.limit)) : rows;
}
function latestEnrichment() {
  const r = enrichment.load();
  return r.length ? r[r.length - 1] : null;
}

/* -------------------------------- integrity ------------------------------ */
function integrity() {
  const out = {};
  for (const c of [events, prices, decisions, market, macroEvents, annotations, reports, enrichment]) {
    out[c.name] = Object.assign({ count: c.count(), bytes: c.fileSize() }, c.verify());
  }
  return out;
}
function resetAll() { for (const c of [events, prices, decisions, market, macroEvents, annotations, reports, enrichment]) c.reset(); }

/**
 * The RAW, UNFOLDED decision audit trail. listDecisions() folds
 * create/edit/review/delete into current state; this returns every original
 * chain record (incl. seq / op / prevHash / hash) so the full history is
 * exportable — "all data" without ambiguity.
 */
function listDecisionEvents() { return decisions.load(); }

/**
 * Byte-exact copies of all nine append-only source files. Attached to the
 * export bundle under raw/ so a third party can independently replay the
 * SHA-256 hash chain and rebuild everything from scratch, without trusting
 * our derived tidy tables.
 */
function rawFiles() {
  const out = [];
  for (const name of ['snapshots', 'events', 'prices', 'decisions', 'market', 'macro_events', 'annotations', 'reports', 'enrichment']) {
    const file = path.join(config.storage.dir, name + '.jsonl');
    if (fs.existsSync(file)) out.push({ name: name + '.jsonl', data: fs.readFileSync(file) });
  }
  return out;
}

module.exports = {
  Chain, events, prices, decisions, market, macroEvents, annotations, reports, enrichment,
  normalizeEvent, normalizePrice,
  addEvents, addPrices, listEvents, listPrices, cashflows,
  addDecision, reviewDecision, editDecision, deleteDecision, listDecisions,
  listDecisionEvents, rawFiles,
  normalizeMarketPoint, addMarketPoints, listMarketPoints,
  addMacroEvent, addMacroEvents, editMacroEvent, deleteMacroEvent,
  listMacroEvents, listMacroEventLog, detectAutoMarketEvents, normalizeMacroRecord,
  addAnnotation, reviewAnnotation, deleteAnnotation, listAnnotations,
  annotationMap, listAnnotationEvents, normalizeAnnotationRecord,
  addReport, listReports, reportByDate,
  addEnrichment, listEnrichment, latestEnrichment, normalizeEnrichment,
  integrity, resetAll, stable, sha,
};
