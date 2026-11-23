'use strict';
/**
 * netguard: source-IP allowlist used by the Tailscale-only deployment.
 * These are the cases that decide whether the service is reachable at all,
 * so they are pinned exactly (including /10 boundary values).
 */
const test = require('node:test');
const assert = require('node:assert');
const { buildGuard, isAllowed, parseRule, normalizePeer } = require('../src/netguard');

const RULES = ['100.64.0.0/10', '127.0.0.0/8', '::1', 'fd7a:115c:a1e0::/48'].map(parseRule);

test('parseRule: 合法 CIDR / 单 IP / 非法输入', () => {
  assert.ok(parseRule('100.64.0.0/10'));
  assert.ok(parseRule('100.64.0.0'));            // bare IP = /32
  assert.ok(parseRule('fd7a:115c:a1e0::/48'));
  assert.equal(parseRule(''), null);
  assert.equal(parseRule('not-an-ip'), null);
  assert.equal(parseRule('100.64.0.0/33'), null);
  assert.equal(parseRule('fd7a::/129'), null);
});

test('isAllowed: 100.64.0.0/10 的四个边界', () => {
  assert.equal(isAllowed('100.64.0.0', RULES), true);       // 下边界
  assert.equal(isAllowed('100.127.255.255', RULES), true);  // 上边界
  assert.equal(isAllowed('100.63.255.255', RULES), false);  // 下边界外一格
  assert.equal(isAllowed('100.128.0.0', RULES), false);     // 上边界外一格
});

test('isAllowed: 回环放行、公网/私网拒绝', () => {
  for (const ip of ['127.0.0.1', '127.1.2.3']) assert.equal(isAllowed(ip, RULES), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '192.168.1.10', '10.0.0.5', '172.16.0.1']) {
    assert.equal(isAllowed(ip, RULES), false, ip);
  }
});

test('isAllowed: IPv6 ULA 与 ::1、IPv4-mapped 地址', () => {
  assert.equal(isAllowed('::1', RULES), true);
  assert.equal(isAllowed('fd7a:115c:a1e0::1', RULES), true);
  assert.equal(isAllowed('fd7a:115c:a1e1::1', RULES), false);
  assert.equal(isAllowed('2001:4860:4860::8888', RULES), false);
  // ::ffff:100.64.0.1 是 Tailscale 地址的 IPv4-mapped 形式，必须按 IPv4 判定
  assert.equal(isAllowed('::ffff:100.64.0.1', RULES), true);
  assert.equal(isAllowed('::ffff:8.8.8.8', RULES), false);
});

test('isAllowed: 畸形输入不抛异常且默认拒绝', () => {
  for (const bad of ['', null, undefined, 'garbage', '1.2.3', '1.2.3.4.5', ':::']) {
    assert.doesNotThrow(() => isAllowed(bad, RULES));
    assert.equal(isAllowed(bad, RULES), false, String(bad));
  }
});

test('normalizePeer: 去掉 zone id 并归一化大小写', () => {
  assert.deepEqual(normalizePeer('FD7A:115C:A1E0::1'), normalizePeer('fd7a:115c:a1e0::1'));
  assert.ok(normalizePeer('fe80::1%eth0'));
  assert.equal(normalizePeer('nope'), null);
});

test('buildGuard: 默认只信 socket 对端，忽略可伪造的 X-Forwarded-For', () => {
  const g = buildGuard({ allowCidrs: ['100.64.0.0/10'], trustProxy: false, proxyHeader: 'x-forwarded-for' });
  const req = { socket: { remoteAddress: '8.8.8.8' }, headers: { 'x-forwarded-for': '100.64.0.9' } };
  assert.equal(g.peer(req), '8.8.8.8');
  assert.equal(g.check(req), false, '伪造 XFF 不得绕过白名单');

  const ok = { socket: { remoteAddress: '100.64.0.9' }, headers: {} };
  assert.equal(g.check(ok), true);
});

test('buildGuard: 显式开启 trustProxy 时才读代理头', () => {
  const g = buildGuard({ allowCidrs: ['100.64.0.0/10'], trustProxy: true, proxyHeader: 'x-forwarded-for' });
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '100.64.0.9, 10.0.0.1' } };
  assert.equal(g.peer(req), '100.64.0.9');
  assert.equal(g.check(req), true);
});

test('buildGuard: 空规则集 = 全部拒绝（fail closed）', () => {
  const g = buildGuard({ allowCidrs: [] });
  assert.equal(g.check({ socket: { remoteAddress: '100.64.0.1' }, headers: {} }), false);
});
