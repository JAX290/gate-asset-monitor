'use strict';

/**
 * Disk watermark guard (v5.1).
 *
 * append-only fact files are never truncated — a hash chain that loses its
 * tail is no longer verifiable. So when disk runs low we do NOT delete: we
 * write heavy datasets less often, then stop writing them entirely at the
 * hard watermark. Snapshots (the small primary record) always continue.
 *
 * This module is deliberately pure except for `freeBytes`, so the policy can
 * be unit-tested with arbitrary numbers.
 */

const DEFAULTS = Object.freeze({
  enabled: true,
  minFreeMb: 512,       // below this: increase sampling interval
  hardFreeMb: 128,      // below this: skip prices + enrichment completely
  maxSampleEvery: 100,  // matches config.collector.priceSampleEvery upper bound
});

/** Free bytes available to the current user on the filesystem holding `dir`. */
function freeBytes(dir) {
  try {
    const s = require('node:fs').statfsSync(dir);
    // bavail = blocks available to unprivileged users (more honest than bfree).
    return s.bavail * s.bsize;
  } catch (_) {
    return null;
  }
}

/**
 * Decide the effective sampling policy.
 * @param {number|null} free free bytes (null = unknown → fail open, no change)
 * @param {object} cfg guard config
 * @param {number} baseEvery configured PRICE_SAMPLE_EVERY
 */
function decide(free, cfg = {}, baseEvery = 1) {
  const c = Object.assign({}, DEFAULTS, cfg);
  const base = Math.max(1, Number.isFinite(baseEvery) ? Math.floor(baseEvery) : 1);
  if (!c.enabled || free === null || !Number.isFinite(free)) {
    return { level: 'ok', freeMb: null, multiplier: 1, sampleEvery: base, skipHeavy: false, reason: 'disabled-or-unknown' };
  }

  const minMb = Math.max(1, c.minFreeMb);
  const hardMb = Math.max(1, Math.min(c.hardFreeMb, minMb / 2));
  const mb = Math.max(0, free / 1048576);
  let level = 'ok', multiplier = 1, reason = 'healthy';
  if (mb < hardMb) {
    level = 'critical';
    multiplier = Math.max(1, c.maxSampleEvery);
    reason = `free ${mb.toFixed(0)}MB < hard ${hardMb}MB`;
  } else if (mb < minMb) {
    level = 'low';
    const ratio = minMb / Math.max(mb, 1);
    multiplier = Math.max(2, Math.min(c.maxSampleEvery, Math.pow(2, Math.ceil(Math.log(ratio) / Math.LN2))));
    reason = `free ${mb.toFixed(0)}MB < soft ${minMb}MB`;
  }
  return {
    level,
    freeMb: Math.round(mb),
    multiplier,
    sampleEvery: Math.max(1, Math.min(c.maxSampleEvery, base * multiplier)),
    skipHeavy: level === 'critical',
    reason,
  };
}

function inspect(dir, cfg, baseEvery) {
  return decide(freeBytes(dir), cfg, baseEvery);
}

module.exports = { DEFAULTS, freeBytes, decide, inspect };
