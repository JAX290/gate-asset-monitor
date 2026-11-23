'use strict';

/**
 * Per-IP login failure limiter (v5.1).
 *
 * The token is 24 random bytes and compared in constant time, so brute force
 * is not realistic — but a lost/stolen device is still a real threat, and the
 * login endpoint is the only door. Sliding-window failures + a bounded lock
 * make online guessing and credential stuffing noisy instead of silent.
 *
 * Pure state machine: no timers, no I/O, fully unit-testable. Keys are real
 * socket peers chosen by the caller; X-Forwarded-For is never trusted.
 */

const DEFAULTS = Object.freeze({
  maxAttempts: 5,     // failures allowed inside the window
  windowSec: 300,     // sliding window length
  lockSec: 300,       // hard lock once the threshold is reached
});

function prune(state, ip, nowMs, cfg) {
  const cutoff = nowMs - cfg.windowSec * 1000;
  const hits = state.get(ip) || [];
  const fresh = hits.filter(t => t > cutoff);
  if (fresh.length) state.set(ip, fresh); else state.delete(ip);
  return fresh;
}

/** Check whether an attempt may proceed. Does not mutate state. */
function check(state, ip, nowMs, cfg = {}, defaults = DEFAULTS) {
  const c = Object.assign({}, defaults, cfg);
  const hits = (state.get(ip) || []).filter(t => t > nowMs - c.windowSec * 1000);
  if (hits.length < c.maxAttempts) return { allowed: true, retryAfterSec: 0, failures: hits.length };
  const oldest = Math.min(...hits);
  const remaining = Math.max(1, Math.ceil((oldest + c.lockSec * 1000 - nowMs) / 1000));
  return { allowed: false, retryAfterSec: Math.min(c.lockSec, remaining), failures: hits.length };
}

/** Record one outcome. Success clears the IP's failure history. */
function record(state, ip, ok, nowMs, cfg = {}, defaults = DEFAULTS) {
  const c = Object.assign({}, defaults, cfg);
  if (ok) { state.delete(ip); return 0; }
  const hits = prune(state, ip, nowMs, c);
  hits.push(nowMs);
  state.set(ip, hits);
  return hits.length;
}

module.exports = { DEFAULTS, check, record };
