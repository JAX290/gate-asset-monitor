'use strict';

/**
 * WeCom (企业微信) group-robot webhook client — zero external dependencies.
 *
 * Uses only Node's built-in https/http. Verified against the official doc
 * (developer.work.weixin.qq.com/document/path/91770):
 *   POST <webhook>  Content-Type: application/json
 *   { "msgtype":"markdown", "markdown": { "content": "<=4096 bytes UTF-8" } }
 *   { "msgtype":"text", "text": { "content":"<=2048 bytes",
 *          "mentioned_mobile_list":["138...","@all"] } }
 *   markdown supports: # headings, **bold**, [link](url), `code`, > quote,
 *   <font color="info|comment|warning"> (3 colours only).
 *   Rate limit: 20 messages / minute per robot.
 *
 * SECURITY:
 *   - The full webhook URL (contains the secret `key`) is NEVER logged, never
 *     included in thrown errors, never returned to callers in a raw form, and
 *     never written to any fact/export file. Only a masked form is exposed.
 *   - Only `qyapi.weixin.qq.com` (or an explicitly configured host) is allowed
 *     to avoid the URL being repurposed as an SSRF target.
 */

const https = require('https');
const http = require('http');

const ALLOWED_HOSTS = new Set(['qyapi.weixin.qq.com']);

function maskUrl(url) {
  try {
    const u = new URL(url);
    const key = u.searchParams.get('key') || '';
    const tail = key ? key.slice(-4) : '';
    return `${u.protocol}//${u.host}${u.pathname}?key=***${tail}`;
  } catch (_) { return '(invalid webhook)'; }
}

function buildWebhook(config) {
  const w = config.wecom || {};
  if (w.webhookUrl) return w.webhookUrl;
  if (w.key) return `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(w.key)}`;
  return '';
}

function configured(config) {
  return !!buildWebhook(config);
}

/** Minimal status for the dashboard — never reveals the secret. */
function status(config) {
  const url = buildWebhook(config);
  return {
    configured: !!url,
    maskedWebhook: url ? maskUrl(url) : '',
    enabled: !!(config.report && config.report.enabled),
    schedule: config.report ? `${String(config.report.hour).padStart(2, '0')}:${String(config.report.minute).padStart(2, '0')}` : '',
    tzLabel: config.report ? `UTC${config.report.tzOffsetHours >= 0 ? '+' : ''}${config.report.tzOffsetHours}` : '',
    mentionCount: (config.wecom && config.wecom.mentionMobiles || []).length,
  };
}

/** POST one JSON body to the webhook. Resolves { ok, errcode, errmsg, httpStatus }. */
function postOnce(webhook, payload, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(webhook); } catch (_) { return resolve({ ok: false, errcode: -1, errmsg: 'invalid webhook url (masked)' }); }
    if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
      return resolve({ ok: false, errcode: -1, errmsg: 'webhook host not allowed' });
    }
    const mod = u.protocol === 'http:' ? http : https;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: timeoutMs || 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* non-json reply */ }
        resolve({
          ok: res.statusCode === 200 && (j.errcode === 0 || j.errcode === undefined),
          errcode: j.errcode === undefined ? null : j.errcode,
          errmsg: j.errmsg || '',
          httpStatus: res.statusCode,
        });
      });
    });
    req.on('error', () => resolve({ ok: false, errcode: -2, errmsg: 'network error (details withheld)' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, errcode: -3, errmsg: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Send a report's markdown chunks (or an arbitrary markdown string) to WeCom.
 * @param {object} config  full config
 * @param {object} opts    { markdown, chunks, mentionMobiles, mentionAll, dryRun }
 * @returns { ok, sent, failed, results:[{ok,errcode,errmsg}], maskedWebhook }
 */
async function sendMarkdown(config, opts = {}) {
  const webhook = buildWebhook(config);
  const masked = webhook ? maskUrl(webhook) : '';
  const empty = (msg) => ({ ok: false, sent: 0, failed: 0, results: [], maskedWebhook: masked, message: msg });
  if (!webhook) return empty('未配置企业微信机器人 webhook');
  if (opts.dryRun) return Object.assign(empty('dry-run: 未实际发送'), { ok: true, dryRun: true });

  let chunks = Array.isArray(opts.chunks) && opts.chunks.length ? opts.chunks : [opts.markdown || ''];
  chunks = chunks.filter(c => String(c).trim());
  if (!chunks.length) return empty('日报内容为空');

  const mobiles = (opts.mentionMobiles && opts.mentionMobiles.length)
    ? opts.mentionMobiles
    : (config.wecom && config.wecom.mentionMobiles || []);
  const mentionAll = !!(opts.mentionAll || (config.wecom && config.wecom.mentionAll));

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    // Put the @ mention on the LAST chunk as a short text message so it works
    // with markdown too (markdown content itself cannot reliably @ by mobile).
    const payload = { msgtype: 'markdown', markdown: { content: chunks[i] } };
    const res = await postOnce(webhook, payload, config.wecom && config.wecom.timeoutMs);
    results.push(res);
    if (i < chunks.length - 1) await sleep(350);       // stay well under 20 msg/min
  }
  if (mobiles.length || mentionAll) {
    const at = {
      msgtype: 'text',
      text: {
        content: '每日资产日报已送达，以上观察为数据驱动提示，非投资建议。',
        mentioned_mobile_list: mentionAll ? ['@all'] : mobiles,
      },
    };
    results.push(await postOnce(webhook, at, config.wecom && config.wecom.timeoutMs));
  }
  const sent = results.filter(r => r.ok).length;
  return {
    ok: results.length > 0 && results.every(r => r.ok),
    sent, failed: results.length - sent, results, maskedWebhook: masked,
    message: results.every(r => r.ok) ? 'ok' : '部分消息发送失败',
  };
}

/** Lightweight connectivity test — one short markdown message. */
async function sendTest(config) {
  if (!configured(config)) return { ok: false, sent: 0, failed: 0, results: [], maskedWebhook: '', message: '未配置企业微信机器人 webhook' };
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const md = `# ✅ 资产监测连通性测试\n> ${ts}\n> 企业微信机器人已接通，每日资产日报将按时段推送。`;
  return sendMarkdown(config, { chunks: [md] });
}

module.exports = { configured, status, maskUrl, buildWebhook, sendMarkdown, sendTest, ALLOWED_HOSTS };
