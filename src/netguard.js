'use strict';

/**
 * Source-IP allowlist for Tailscale-only deployments.
 *
 * Ranges verified on the target host with `tailscale ip -4` / `tailscale ip -6`:
 *   IPv4: 100.64.0.0/10        (CGNAT space Tailscale assigns node IPs from)
 *   IPv6: fd7a:115c:a1e0::/48  (Tailscale ULA prefix)
 * Loopback is always permitted so local health checks keep working.
 *
 * SECURITY: only the real socket peer is trusted by default. X-Forwarded-For
 * is ignored unless TRUST_PROXY is explicitly enabled, because any client can
 * forge that header and walk straight through an IP allowlist.
 */
const net = require('net');

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function ipv6ToBigInt(ip) {
  let s = String(ip).toLowerCase();
  if (s.startsWith('::ffff:')) return null; // handled as IPv4 by normalizePeer
  if (s.includes('::')) {
    if (s.indexOf('::') !== s.lastIndexOf('::')) return null;
    const [left, right] = s.split('::');
    const l = left ? left.split(':') : [];
    const r = right ? right.split(':') : [];
    const missing = 8 - l.length - r.length;
    if (missing < 0) return null;
    s = [...l, ...Array(missing).fill('0'), ...r].join(':');
  }
  const groups = s.split(':');
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return v;
}

function parseRule(raw) {
  const rule = String(raw).trim();
  if (!rule) return null;
  const [addr, bitsStr] = rule.split('/');
  if (net.isIP(addr) === 6) {
    const bits = bitsStr === undefined ? 128 : parseInt(bitsStr, 10);
    if (Number.isNaN(bits) || bits < 0 || bits > 128) return null;
    const base = ipv6ToBigInt(addr);
    return base === null ? null : { v: 6, base, bits };
  }
  const bits = bitsStr === undefined ? 32 : parseInt(bitsStr, 10);
  if (Number.isNaN(bits) || bits < 0 || bits > 32) return null;
  const base = ipv4ToInt(addr);
  if (base === null) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { v: 4, base: (base & mask) >>> 0, mask };
}

function normalizePeer(addr) {
  if (!addr) return null;
  let s = String(addr).trim().toLowerCase().replace(/%.*$/, '');
  if (s.startsWith('::ffff:')) {
    const n = ipv4ToInt(s.slice(7));
    if (n !== null) return { v: 4, int: n };
  }
  if (net.isIP(s) === 4) return { v: 4, int: ipv4ToInt(s) };
  if (net.isIP(s) === 6) {
    const big = ipv6ToBigInt(s);
    return big === null ? null : { v: 6, big };
  }
  return null;
}

function isAllowed(addr, rules) {
  const p = normalizePeer(addr);
  if (!p) return false;
  for (const r of rules) {
    if (r.v === 4 && p.v === 4) {
      if (((p.int & r.mask) >>> 0) === r.base) return true;
    } else if (r.v === 6 && p.v === 6) {
      const shift = 128n - BigInt(r.bits);
      if ((p.big >> shift) === (r.base >> shift)) return true;
    }
  }
  return false;
}

function peerFromReq(req, cfg) {
  let addr = req.socket && req.socket.remoteAddress;
  if (cfg.trustProxy) {
    const h = req.headers[cfg.proxyHeader];
    if (h) {
      const first = String(Array.isArray(h) ? h[0] : h).split(',')[0].trim();
      if (first) addr = first;
    }
  }
  return addr;
}

function buildGuard(cfg) {
  const rules = (cfg.allowCidrs || []).map(parseRule).filter(Boolean);
  return {
    rules,
    peer: (req) => peerFromReq(req, cfg),
    check: (req) => isAllowed(peerFromReq(req, cfg), rules),
    describe: () => rules.map(r => r.v === 4
      ? `IPv4/${r.mask.toString(16)}`
      : `IPv6/${r.bits}`).join(', '),
  };
}

module.exports = { buildGuard, isAllowed, parseRule, normalizePeer };
