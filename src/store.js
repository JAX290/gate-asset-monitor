'use strict';

/**
 * Append-only snapshot store (JSON Lines). Zero external dependencies.
 * - data/snapshots.jsonl : one snapshot per line, append-only (crash-safe)
 * - in-memory index for fast queries, rebuilt on boot
 * CSV / JSON export is generated from the stored snapshots.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');

const FILE = path.join(config.storage.dir, 'snapshots.jsonl');
let cache = [];          // [{ ts, mode, totalUsd, totalCurrency, accounts, holdings, notes }]
let loaded = false;

function ensure() {
  fs.mkdirSync(config.storage.dir, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, '', 'utf8');
}

function load() {
  if (loaded) return;
  ensure();
  const raw = fs.readFileSync(FILE, 'utf8');
  cache = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.ts === 'number') cache.push(obj);
    } catch (_) { /* skip corrupted line */ }
  }
  cache.sort((a, b) => a.ts - b.ts);
  loaded = true;
}

/**
 * Append a snapshot. Returns the stored record.
 * @param {object} data  normalised snapshot payload from gateClient/mockData
 * @param {string} mode  'mock' | 'live'
 */
function append(data, mode) {
  load();
  const rec = {
    ts: Date.now(),
    mode,
    quote: config.quote,
    totalUsd: data.totalUsd,
    totalCurrency: data.totalCurrency || 'USD',
    accounts: data.accounts || [],
    holdings: data.holdings || [],
    notes: data.notes || [],
  };
  fs.appendFileSync(FILE, JSON.stringify(rec) + '\n', 'utf8');
  cache.push(rec);
  return rec;
}

/**
 * Append fully-formed records (used for demo history backfill), writing to disk
 * AND updating the in-memory cache so the data is visible immediately.
 */
function appendRaw(recs) {
  load();
  if (!recs.length) return;
  fs.appendFileSync(FILE, recs.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  for (const r of recs) cache.push(r);
  cache.sort((a, b) => a.ts - b.ts);
}

function latest() {
  load();
  return cache.length ? cache[cache.length - 1] : null;
}

function previous() {
  load();
  return cache.length > 1 ? cache[cache.length - 2] : null;
}

/** Return up to `limit` most recent snapshots, optionally filtered by range. */
function history({ limit = 500, from, to, fields } = {}) {
  load();
  let rows = cache;
  if (from) rows = rows.filter(r => r.ts >= from);
  if (to) rows = rows.filter(r => r.ts <= to);
  rows = rows.slice(-limit);
  if (fields) {
    return rows.map(r => {
      const o = { ts: r.ts, mode: r.mode, totalUsd: r.totalUsd, totalCurrency: r.totalCurrency };
      return o;
    });
  }
  return rows;
}

function count() {
  load();
  return cache.length;
}

/** Retention cleanup: rewrite file dropping snapshots older than retentionDays. */
function prune() {
  load();
  const cutoff = Date.now() - config.collector.retentionDays * 86400 * 1000;
  const kept = cache.filter(r => r.ts >= cutoff);
  if (kept.length === cache.length) return 0;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, kept.map(r => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, FILE);
  const removed = cache.length - kept.length;
  cache = kept;
  return removed;
}

function esc(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Flat CSV of every snapshot (one row per account bucket). */
function toCsv(rows) {
  const header = ['timestamp_iso', 'timestamp_ms', 'mode', 'total_usd', 'total_currency',
    'account_id', 'account_label', 'account_amount', 'account_currency',
    'account_borrowed', 'account_unrealised_pnl'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const iso = new Date(r.ts).toISOString();
    const accs = r.accounts && r.accounts.length ? r.accounts : [{}];
    for (const a of accs) {
      lines.push([
        esc(iso), r.ts, esc(r.mode), esc(r.totalUsd), esc(r.totalCurrency),
        esc(a.id), esc(a.label), esc(a.amount), esc(a.currency),
        esc(a.borrowed), esc(a.unrealisedPnl),
      ].join(','));
    }
  }
  // UTF-8 BOM so Excel opens Chinese headers correctly
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** Flat CSV of holdings for the latest snapshot. */
function holdingsCsv(rec) {
  if (!rec) return '\uFEFFtimestamp_iso,mode\n';
  const header = ['timestamp_iso', 'mode', 'currency', 'amount', 'available', 'locked', 'venue', 'value_usd'];
  const lines = [header.join(',')];
  const iso = new Date(rec.ts).toISOString();
  for (const h of rec.holdings || []) {
    lines.push([esc(iso), esc(rec.mode), esc(h.currency), esc(h.amount),
      esc(h.available), esc(h.locked), esc(h.venue), esc(h.valueUsd)].join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** Clear snapshots and the in-memory cache (used only by DEMO reseed). */
function reset() {
  ensure();
  fs.writeFileSync(FILE, '', 'utf8');
  cache = [];
  loaded = true;
}

module.exports = { append, appendRaw, latest, previous, history, count, prune, toCsv, holdingsCsv, reset, FILE };
