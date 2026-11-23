'use strict';

/**
 * Minimal, dependency-free auth for a single-owner dashboard.
 * - ACCESS_TOKEN is the password (server-side env only).
 * - On login we set an HttpOnly, SameSite=Strict cookie containing an
 *   HMAC-signed session payload (exp timestamp). No plain token in the cookie.
 * - Signing key is derived from the access token + a per-boot random salt, so
 *   cookies are invalidated on restart and cannot be forged without the token.
 */
const crypto = require('crypto');
const config = require('./config');

const COOKIE = 'gam_session';
const bootSalt = crypto.randomBytes(32).toString('hex');
// Revoked session ids (sid -> exp). Logout invalidates exactly one device,
// leaving other terminals' sessions intact. Bounded by TTL cleanup.
const revoked = new Map();

function signingKey() {
  return crypto.createHash('sha256').update(`${bootSalt}:${config.auth.token}`).digest();
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', signingKey()).update(payloadB64).digest('hex');
}

function createSession() {
  const exp = Date.now() + config.auth.sessionTtlSec * 1000;
  const sid = crypto.randomBytes(16).toString('hex');
  const payload = Buffer.from(JSON.stringify({ exp, sid, v: 1 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function decode(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (_) { return null; }
}

function verify(token) {
  if (!config.auth.enabled) return true;
  const obj = decode(token);
  if (!obj) return false;
  if (typeof obj.exp !== 'number' || obj.exp <= Date.now()) return false;
  if (obj.sid && revoked.has(obj.sid)) return false;
  return true;
}

/** Revoke one session (used on logout). Returns nothing. */
function revoke(token) {
  const obj = decode(token);
  if (obj && obj.sid && typeof obj.exp === 'number') {
    revoked.set(obj.sid, obj.exp);
  }
  // opportunistic cleanup
  const now = Date.now();
  for (const [k, e] of revoked) if (e <= now) revoked.delete(k);
}

function tokenFromReq(req) {
  return parseCookies(req.headers.cookie)[COOKIE];
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function checkLogin(token) {
  if (!config.auth.enabled) return true; // auth disabled
  if (!token) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(config.auth.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieFlags() {
  return `HttpOnly; SameSite=Strict${config.auth.secureCookie ? '; Secure' : ''}; Path=/`;
}

function sessionCookie() {
  const maxAge = config.auth.sessionTtlSec;
  return `${COOKIE}=${createSession()}; ${cookieFlags()}; Max-Age=${maxAge}`;
}

function clearCookie() {
  return `${COOKIE}=; ${cookieFlags()}; Max-Age=0`;
}

function isAuthed(req) {
  if (!config.auth.enabled) return true;
  const cookies = parseCookies(req.headers.cookie);
  return verify(cookies[COOKIE]);
}

module.exports = { COOKIE, checkLogin, verify, revoke, tokenFromReq, sessionCookie, clearCookie, isAuthed, parseCookies };
