'use strict';

/**
 * Daily report — PURE FUNCTION, zero dependencies, no I/O.
 *
 * Builds TWO independently sendable Chinese reports from already-collected data:
 *   1) assetReport — "我的资产": explicit 1h / 8h / 24h / 7d / 30d change points
 *      with both timestamps shown. No vague "上一轮快照" wording.
 *   2) marketReport — "大行情": BTC/ETH/LTC/DOGE/PEARL/FIL (configurable),
 *      24h high/low, 7d change, and a RULED-BASED 24h technical bias + range.
 *
 * The combined rep is kept for preview/history/export compatibility, but the
 * server sends assetReport and marketReport as SEPARATE WeCom messages.
 *
 * HONESTY CONTRACT (important):
 *   - The "处置观察" section is a set of DATA-DRIVEN OBSERVATIONS / review
 *     prompts derived from real numeric thresholds. It never fabricates a
 *     buy/sell instruction, never invents news, never claims prediction.
 *   - The 24h market outlook is explicitly TECHNICAL (SMA/RSI/vol/volume),
 *     labelled as a scenario range rather than a forecast, and carries a
 *     not-investment-advice disclaimer.
 *   - Every observation carries its `basis` (the actual number behind it).
 *   - When data is missing / the window is too short, the report says so
 *     instead of producing confident-looking but meaningless numbers.
 *
 * Output is fully serialisable and also rendered to WeCom-flavoured markdown
 * (<=4096 bytes per message, split into chunks) plus a plain-text form.
 */

const WECOM_MAX_BYTES = 4096;
const CHUNK_TARGET = 3600;              // leave headroom for the (i/n) header

const STABLE = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD', 'USD', 'USDP']);

function num(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function fMoney(v, d = 2) { const x = num(v); return x === null ? '—' : x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fPct(v, d = 2) { const x = num(v); return x === null ? '—' : (x > 0 ? '+' : '') + x.toFixed(d) + '%'; }
function fPp(v, d = 2) { const x = num(v); return x === null ? '—' : (x > 0 ? '+' : '') + x.toFixed(d) + 'pp'; }
function fSigned(v, d = 2) { const x = num(v); return x === null ? '—' : (x > 0 ? '+' : '') + fMoney(v, d); }
function iso(ts) { const x = num(ts); return x ? new Date(x).toISOString() : ''; }
function dateLabel(ts, tzOffsetHours) {
  const shift = (Number(tzOffsetHours) || 0) * 3600 * 1000;
  const d = new Date(Number(ts) + shift);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
function timeLabel(ts, tzOffsetHours) {
  const shift = (Number(tzOffsetHours) || 0) * 3600 * 1000;
  const d = new Date(Number(ts) + shift);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function stampLabel(ts, tz) { return Number.isFinite(Number(ts)) ? `${dateLabel(ts, tz)} ${timeLabel(ts, tz)}` : '—'; }
function round(v, d = 2) { const x = num(v); if (x === null) return null; const p = 10 ** d; return Math.round(x * p) / p; }
function priceDecimals(v) { const x = Math.abs(num(v) || 0); return x >= 100 ? 2 : x >= 10 ? 3 : x >= 1 ? 4 : 5; }
function fPrice(v) { const x = num(v); return x === null ? '—' : fMoney(x, priceDecimals(x)); }

/* ---------------------------- asset time windows --------------------------- */

const ASSET_WINDOWS = [
  { key: '1h', ms: 3600e3, label: '1 小时' },
  { key: '8h', ms: 8 * 3600e3, label: '8 小时' },
  { key: '24h', ms: 24 * 3600e3, label: '24 小时' },
  { key: '7d', ms: 7 * 86400e3, label: '1 周' },
  { key: '30d', ms: 30 * 86400e3, label: '1 个月' },
];

/**
 * Explicit-point asset changes. We walk BACKWARDS from `now` and take the last
 * snapshot AT OR BEFORE each cutoff, so the report can print the real start
 * timestamp instead of the ambiguous "上一轮快照".
 */
function assetWindows(input, now, tz) {
  const rows = (input && input.snapshots ? input.snapshots : [])
    .filter(r => r && Number.isFinite(Number(r.ts)) && num(r.totalUsd) !== null && Number(r.ts) <= now)
    .slice()
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  if (!rows.length) return [];
  const last = rows[rows.length - 1];
  return ASSET_WINDOWS.map(w => {
    const target = Number(now) - w.ms;
    let base = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (Number(rows[i].ts) <= target) { base = rows[i]; break; }
    }
    if (!base) {
      return Object.assign({}, w, {
        ok: false, toTs: Number(last.ts), toLabel: stampLabel(last.ts, tz),
        reason: `窗口前无快照（最早 ${stampLabel(rows[0].ts, tz)}）`,
      });
    }
    const dUsd = Number(last.totalUsd) - Number(base.totalUsd);
    const dPct = Number(base.totalUsd) ? dUsd / Number(base.totalUsd) * 100 : null;
    return Object.assign({}, w, {
      ok: true, fromTs: Number(base.ts), toTs: Number(last.ts),
      fromLabel: stampLabel(base.ts, tz), toLabel: stampLabel(last.ts, tz),
      changeUsd: round(dUsd, 2), changePct: round(dPct, 2), tone: toneOf(dUsd),
    });
  });
}

/* ------------------------------- technical -------------------------------- */

function sma(vals, n) {
  const a = vals.slice(-Math.max(1, Math.floor(n)));
  if (!a.length) return null;
  return a.reduce((s, x) => s + x, 0) / a.length;
}
function rsi(vals, period = 14) {
  if (!vals.length || vals.length <= period) return null;
  let up = 0, down = 0;
  for (let i = vals.length - period; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    if (d > 0) up += d; else down -= d;
  }
  if (down === 0) return 100;
  const rs = up / down;
  return 100 - 100 / (1 + rs);
}
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
}

/**
 * Per-symbol brief + a RULED-BASED 24h technical bias. No news, no prediction:
 * the "range" is one realised-volatility standard-deviation band, clearly
 * labelled as a scenario, not a price target.
 */
function marketBrief(marketPts, nowMs, symbols, intervalSec) {
  const out = [];
  const by = new Map();
  const iv = num(intervalSec) || 0;
  for (const p of (marketPts || [])) {
    const sym = String(p.symbol || '').toUpperCase();
    const pIv = num(p.intervalSec);
    if (iv && pIv && pIv !== iv) continue;   // never mix legacy 1h with 5m bars
    if (!by.has(sym)) by.set(sym, []);
    by.get(sym).push(p);
  }
  const syms = symbols && symbols.length ? symbols.map(s => String(s).toUpperCase()) : Array.from(by.keys());
  const now = Number(nowMs) || Date.now();
  const barsPerDay = iv > 0 ? Math.max(4, Math.round(86400 / iv)) : 288;
  for (const sym of syms) {
    const rows = (by.get(sym) || []).slice().filter(r => Number(r.ts) <= now)
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    if (!rows.length) continue;
    const last = rows[rows.length - 1];
    const lastClose = num(last.close);
    const cutoff24 = now - 24 * 3600e3;
    const rows24 = rows.filter(r => Number(r.ts) > cutoff24);
    const past = rows.filter(r => Number(r.ts) <= cutoff24).pop() || rows24[0] || rows[0];
    const cutoff7 = now - 7 * 86400e3;
    const rows7 = rows.filter(r => Number(r.ts) > cutoff7);
    const past7 = rows.filter(r => Number(r.ts) <= cutoff7).pop() || rows7[0] || rows[0];
    const chg24 = lastClose !== null && num(past.close) ? (lastClose / num(past.close) - 1) * 100 : null;
    const chg7 = lastClose !== null && num(past7.close) ? (lastClose / num(past7.close) - 1) * 100 : null;

    const hiOf = rs => {
      let h = -Infinity, l = Infinity;
      for (const r of rs) {
        const hi = num(r.high) !== null ? num(r.high) : num(r.close);
        const lo = num(r.low) !== null ? num(r.low) : num(r.close);
        if (hi !== null && hi > h) h = hi;
        if (lo !== null && lo < l) l = lo;
      }
      return { high: Number.isFinite(h) ? h : null, low: Number.isFinite(l) ? l : null };
    };
    const h24 = hiOf(rows24), h7 = hiOf(rows7);

    const closes = rows.map(r => num(r.close)).filter(x => x !== null);
    const fastN = Math.max(3, Math.min(closes.length, Math.round(barsPerDay / 4)));
    const slowN = Math.max(6, Math.min(closes.length, barsPerDay));
    const smaFast = sma(closes, fastN);
    const smaSlow = sma(closes, slowN);
    const rsi14 = closes.length > 14 ? rsi(closes, 14) : null;
    const retN = Math.min(closes.length - 1, barsPerDay);
    const rets = [];
    for (let i = closes.length - retN; i < closes.length && i > 0; i++) {
      if (closes[i - 1] > 0) rets.push(closes[i] / closes[i - 1] - 1);
    }
    const vol24Pct = rets.length >= 3 ? round(stdev(rets) * Math.sqrt(rets.length) * 100, 2) : null;

    const sumQv = rs => rs.reduce((s, r) => s + (num(r.quoteVolume) || 0), 0);
    const qv24 = sumQv(rows24);
    const qvPrev = sumQv(rows.filter(r => Number(r.ts) > cutoff24 - 24 * 3600e3 && Number(r.ts) <= cutoff24));
    const volumeRatio = qvPrev > 0 ? round(qv24 / qvPrev, 2) : null;

    let outlook = null;
    if (closes.length >= Math.max(6, fastN) && lastClose !== null) {
      let score = 0;
      const drivers = [];
      if (smaFast !== null) {
        if (lastClose > smaFast) { score++; drivers.push(`价格高于 ${Math.round(fastN * iv / 3600)}h 均线`); }
        else { score--; drivers.push(`价格低于 ${Math.round(fastN * iv / 3600)}h 均线`); }
      }
      if (smaFast !== null && smaSlow !== null) {
        if (smaFast > smaSlow) { score++; drivers.push('快线在慢线上方'); }
        else { score--; drivers.push('快线在慢线下方'); }
      }
      if (rsi14 !== null) {
        if (rsi14 < 30) { score++; drivers.push(`RSI ${rsi14.toFixed(0)} 超卖`); }
        else if (rsi14 > 70) { score--; drivers.push(`RSI ${rsi14.toFixed(0)} 超买`); }
        else if (rsi14 >= 50) { score++; drivers.push(`RSI ${rsi14.toFixed(0)} 偏强`); }
        else { score--; drivers.push(`RSI ${rsi14.toFixed(0)} 偏弱`); }
      }
      if (chg24 !== null) {
        if (chg24 > 0) { score++; drivers.push('24h 收涨'); }
        else { score--; drivers.push('24h 收跌'); }
      }
      if (volumeRatio !== null && volumeRatio >= 1.2) {
        drivers.push(`量比 ${volumeRatio.toFixed(2)} 放大`);
        score += (chg24 !== null && chg24 > 0) ? 1 : -1;
      }
      const bias = score >= 3 ? '偏强' : score >= 1 ? '中性偏强' : score <= -3 ? '偏弱' : score <= -1 ? '中性偏弱' : '震荡';
      const bandPct = vol24Pct !== null ? Math.min(25, Math.max(0.5, vol24Pct)) : null;
      const projectedLow = bandPct !== null ? round(lastClose * (1 - bandPct / 100), priceDecimals(lastClose)) : null;
      const projectedHigh = bandPct !== null ? round(lastClose * (1 + bandPct / 100), priceDecimals(lastClose)) : null;
      outlook = {
        bias, score, drivers: drivers.slice(0, 4), bandPct,
        projectedLow, projectedHigh,
        support: bandPct !== null ? Math.min(h24.low === null ? projectedLow : h24.low, projectedLow) : h24.low,
        resistance: bandPct !== null ? Math.max(h24.high === null ? projectedHigh : h24.high, projectedHigh) : h24.high,
      };
    }

    out.push({
      symbol: sym, lastPrice: lastClose, lastTs: Number(last.ts),
      chg24Pct: round(chg24, 2), chg7Pct: round(chg7, 2),
      high24: h24.high, low24: h24.low, high7: h7.high, low7: h7.low,
      volumeRatio, vol24Pct, rsi14: rsi14 === null ? null : round(rsi14, 1),
      bars: rows.length, outlook,
    });
  }
  return out;
}

/**
 * Build the data-driven observation list. Each entry:
 *   { level: 'good'|'info'|'warn', title, detail, basis }
 * level is ONLY a visual emphasis, never a trading signal.
 */
function observations(a, mk, brief, summary, windowReliable) {
  const out = [];
  const s = a.summary || {}, risk = a.risk || {}, cost = a.costs || {},
    conc = a.concentration || {}, q = a.quality || {}, beh = a.behavior || {};
  const cm = (mk && mk.metrics && mk.metrics.summary) || {};
  const concl = (mk && mk.conclusion) || {};

  // 1) Data sufficiency — always first, so nothing downstream is over-trusted.
  if (!windowReliable) {
    out.push({
      level: 'warn', title: '统计样本不足，勿引用年化指标',
      detail: '当前统计窗口不足 7 天，年化波动率 / 夏普 / 索提诺 / 年化 MWR 会被极度放大，仅作算法演示。随时间累积会自动可靠。',
      basis: `统计窗口 ${fMoney(risk.windowDays, 2)} 天 · 快照 ${q.snapshotCount || 0} 个`,
    });
  }

  // 2) Concentration / single-name exposure.
  if (conc && num(conc.top1Pct) !== null && conc.top1Pct >= 50) {
    out.push({
      level: 'warn', title: '仓位较集中，留意单一标的暴露',
      detail: '最大单一持仓占比过半，账户涨跌会高度受该标的主导。可复核它是否仍在你可承受的敞口内——这是风险提示，不是买卖建议。',
      basis: `Top1 ${fMoney(conc.top1Pct, 1)}% · HHI ${fMoney(conc.hhi, 4)} · 有效币种数 ${fMoney(conc.effectiveN, 2)}`,
    });
  }

  // 3) Stablecoin buffer.
  if (conc && num(conc.stablecoinPct) !== null) {
    if (conc.stablecoinPct >= 60) {
      out.push({
        level: 'info', title: '现金类仓位偏高，上涨行情易跑输',
        detail: '稳定币占比较高意味着防守姿态，抗跌但普涨时弹性有限。可结合市场对比页确认「跑输」是否由此解释。',
        basis: `稳定币占比 ${fMoney(conc.stablecoinPct, 1)}%`,
      });
    } else if (conc.stablecoinPct <= 8) {
      out.push({
        level: 'info', title: '现金类仓位很低，回撤缓冲有限',
        detail: '几乎满仓风险资产，波动与回撤的缓冲较薄。留意最大回撤与下行捕获是否同步偏高。',
        basis: `稳定币占比 ${fMoney(conc.stablecoinPct, 1)}%`,
      });
    }
  }

  // 4) Drawdown.
  if (num(s.maxDrawdownPct) !== null && s.maxDrawdownPct <= -8) {
    out.push({
      level: 'warn', title: '本窗口出现较深回撤',
      detail: '单位净值相对峰值一度明显回落。可回看「资产分析」的净值曲线与归因，确认是价格效应（市场）还是数量效应（调仓）主导。',
      basis: `最大回撤 ${fPct(s.maxDrawdownPct)} · 卡玛 ${fMoney(s.calmar, 2)}`,
    });
  }

  // 5) Relative performance vs main benchmark.
  if (num(concl.excessVsMainPct) !== null) {
    const main = concl.mainSeries || 'BTC';
    if (concl.excessVsMainPct < 0) {
      out.push({
        level: 'info', title: `区间跑输 ${main}，可复核结构`,
        detail: '相对主流币落后。原因可能是稳定币占比、风险币拖累、成本或事件窗口反应，市场对比页已给出逐条归因，可据此复盘选币/择时/仓位结构。',
        basis: `超额 ${fPp(concl.excessVsMainPct)} · 资产 TWR ${fPct(concl.navPct)} · ${main} ${fPct(concl.mainPct)} · β ${fMoney(cm.betaVsMain, 3)}`,
      });
    } else {
      out.push({
        level: 'good', title: `区间跑赢 ${main}，注意区分来源`,
        detail: '相对主流币领先。建议核对「β 调整后超额」：若领先主要由更高市场敞口带来，则属放大 beta 而非主动 alpha。',
        basis: `超额 ${fPp(concl.excessVsMainPct)} · β ${fMoney(cm.betaVsMain, 3)} · 上行捕获 ${cm.upCaptureVsMain === null ? '—' : fMoney(cm.upCaptureVsMain * 100, 0) + '%'}`,
      });
    }
  }

  // 6) Down-capture > up-capture ("跟跌不跟涨").
  const rel = (mk && mk.relativeRows) || [];
  const mainRel = rel.find(x => x.series_kind === 'benchmark') || rel[0];
  if (mainRel && num(mainRel.up_capture) !== null && num(mainRel.down_capture) !== null &&
    mainRel.down_capture > mainRel.up_capture + 0.05) {
    out.push({
      level: 'info', title: '下行捕获高于上行捕获',
      detail: '基准下跌时组合跟跌幅度大于上涨时的跟涨幅度，属「弹性偏弱」结构。可与稳定币占比、风险币拖累一起看。',
      basis: `上行 ${fMoney(mainRel.up_capture * 100, 0)}% / 下行 ${fMoney(mainRel.down_capture * 100, 0)}%`,
    });
  }

  // 7) Cost drag. When the window is too short, annualised cost is meaningless
  //    (a 2-hour window can annualise to 95%), so use cost/avg-assets instead
  //    and never quote the annualised figure until it is reliable.
  const costToAssets = num(cost.costToAvgAssetsPct);
  const annualCost = windowReliable ? num(cost.annualisedCostPct) : null;
  if ((costToAssets !== null && costToAssets > 0.5) || (annualCost !== null && annualCost > 1)) {
    const basis = windowReliable && annualCost !== null
      ? `年化成本率 ${fMoney(annualCost, 3)}% · 成本/均资产 ${fMoney(costToAssets, 3)}%`
      : `成本/均资产 ${fMoney(costToAssets, 3)}%（窗口 <7 天，不引用年化成本率）`;
    out.push({
      level: 'info', title: '摩擦成本占比偏高',
      detail: '显式成本相对资产不低。若长期高于策略收益，调仓频率与 maker/taker 结构值得复核。',
      basis: `${basis} · 手续费 ${fMoney(cost.totalFeeUsd)} USD · maker ${cost.makerRatioPct === null ? '—' : fMoney(cost.makerRatioPct, 1) + '%'}`,
    });
  }

  // 8) Cashflow vs performance.
  if (num(s.netCashflowUsd) !== null && Math.abs(s.netCashflowUsd) > 0) {
    out.push({
      level: 'info', title: '窗口内有外部资金进出',
      detail: '总资产变化里有一部分是充值/提现，不是收益。看真实表现请用 TWR（已剥离），不要看总资产涨幅。',
      basis: `净外部现金流 ${fSigned(s.netCashflowUsd)} USD · 总资产涨幅 ${fPct(s.rawChangePct)} vs TWR ${fPct(s.twrPct)}`,
    });
  }

  // 9) Recent market events.
  const evCount = num(cm.eventCount) || 0;
  if (evCount > 0 && mk && mk.events && mk.events.length) {
    const recent = mk.events.slice(0, 3).map(e => e.title).filter(Boolean);
    out.push({
      level: 'info', title: '近期有市场异动/标注事件',
      detail: '这些是行情异动自动检测或人工标注（非实时新闻）。可在「市场对比」页查看事件前后资产与主流币的反应与原因。',
      basis: `${evCount} 个事件${recent.length ? ' · 例如：' + recent.join('；') : ''}`,
    });
  }

  // 10) Data trust.
  if (q.hashChainOk === false || (num(q.longGaps) || 0) > 0 || (num(q.duplicateEventIds) || 0) > 0) {
    out.push({
      level: 'warn', title: '数据质量有可复核项',
      detail: '哈希链或采集连续性有异常，派生指标的可信度会受影响。建议在「导出中心」查看完整性校验。',
      basis: `哈希链 ${q.hashChainOk === false ? '异常' : '正常'} · 断点 ${q.longGaps || 0} · 重复事件 ${q.duplicateEventIds || 0}`,
    });
  }

  // 11) Review coverage — the "compounding experience" layer.
  if (num(beh.reviewCoveragePct) !== null && beh.reviewCoveragePct < 40) {
    out.push({
      level: 'info', title: '操作复盘覆盖率偏低',
      detail: '不少 Gate 操作还没补写动机/止盈止损/复盘。补齐后胜率、盈亏比与经验沉淀才更有意义。',
      basis: `复盘覆盖 ${fMoney(beh.reviewCoveragePct, 0)}% · 操作数 ${beh.decisionsTotal || 0}`,
    });
  }

  if (!out.length) {
    out.push({ level: 'good', title: '暂无需要特别关注的信号', detail: '各项指标处于常规区间，未触发集中/回撤/成本/数据质量等提示阈值。', basis: '基于当前窗口真实数据' });
  }
  return out;
}

/** tone -> WeCom font color. Chinese convention: up=红(warning), down=绿(info). */
function fontColor(tone) { return tone === 'up' ? 'warning' : tone === 'down' ? 'info' : 'comment'; }
function toneOf(v) { const x = num(v); return x === null ? '' : x > 0 ? 'up' : x < 0 ? 'down' : ''; }
function cw(text, tone) { return `<font color="${fontColor(tone)}">${text}</font>`; }

function buildMarkdown(rep) {
  const L = [];
  const title = rep.title || '每日资产日报';
  L.push(`# ${title} · ${rep.meta.date}`);
  L.push(`> 生成 ${rep.meta.generatedAtLocal} (${rep.meta.tzLabel}) · 模式 <font color="comment">${rep.meta.mode === 'live' ? '真实 Gate.io' : 'DEMO 模拟'}</font>`);
  L.push(`**${rep.headline}**`);
  L.push('');

  for (const sec of rep.sections) {
    L.push(`## ${sec.title}`);
    for (const line of sec.lines) {
      L.push(`> ${line.label}：${cw(line.value, line.tone || '')}`);
    }
    if (sec.bullets && sec.bullets.length) for (const b of sec.bullets) L.push(`> ${b}`);
    L.push('');
  }

  if (rep.observations && rep.observations.length) {
    L.push('## 资产处置观察（数据驱动，非投资建议）');
    const icon = { good: '🟢', info: '🔵', warn: '🟠' };
    rep.observations.forEach((o, i) => {
      L.push(`**${icon[o.level] || '🔵'} ${i + 1}. ${o.title}**`);
      L.push(`> ${o.detail}`);
      L.push(`> <font color="comment">依据：${o.basis}</font>`);
    });
    L.push('');
  }
  L.push(`> <font color="comment">${rep.disclaimer}</font>`);
  return L.join('\n');
}

/** Split a long markdown into <= CHUNK_TARGET-byte pieces on line boundaries. */
function splitMarkdown(md) {
  const lines = md.split('\n');
  const chunks = [];
  let cur = '';
  const blen = s => Buffer.byteLength(s, 'utf8');
  for (const line of lines) {
    const candidate = cur ? cur + '\n' + line : line;
    if (blen(candidate) > CHUNK_TARGET && cur) { chunks.push(cur); cur = line; }
    else cur = candidate;
  }
  if (cur) chunks.push(cur);
  const total = chunks.length;
  return chunks.map((c, i) => total > 1 ? `**（${i + 1}/${total}）**\n` + c : c)
    .map(c => blen(c) > WECOM_MAX_BYTES ? c.slice(0, 1200) : c);   // hard safety net
}

/**
 * @returns combined report plus two independently sendable sub-reports:
 *          { ..., assetReport, marketReport, assetWindows }
 */
function build(input) {
  const a = input.analysis || {}, mk = input.market || {}, summary = input.summary || {};
  const config = input.config || {};
  const mkCfg = config.market || {};
  const now = Number(input.now) || Date.now();
  const tz = Number(config.report && config.report.tzOffsetHours) || 8;
  const windowReliable = !!(a.risk && a.risk.annualizationReliable) &&
    (Number(a.risk.windowDays) || 0) >= 7;
  const s = a.summary || {}, risk = a.risk || {}, cost = a.costs || {},
    conc = a.concentration || {}, q = a.quality || {};
  const latest = summary.latest || {};
  const brief = marketBrief(input.marketPts, now, mkCfg.symbols, mkCfg.candleIntervalSec);
  const windows = assetWindows(input, now, tz);
  const concl = mk.conclusion || {};

  const headlineParts = [];
  if (num(latest.totalUsd) !== null) headlineParts.push(`总资产 ${fMoney(latest.totalUsd)} USD`);
  const w24 = windows.find(x => x.key === '24h' && x.ok);
  if (w24) headlineParts.push(`24h ${fSigned(w24.changeUsd)} USD (${fPct(w24.changePct)})`);
  if (num(s.twrPct) !== null) headlineParts.push(`区间 TWR ${fPct(s.twrPct)}`);
  if (num(concl.excessVsMainPct) !== null) {
    headlineParts.push(`较 ${concl.mainSeries || 'BTC'} ${concl.excessVsMainPct >= 0 ? '跑赢' : '跑输'} ${Math.abs(concl.excessVsMainPct).toFixed(2)}pp`);
  }
  const headline = headlineParts.length ? headlineParts.join(' · ') : '数据累积中，暂无足够快照生成摘要';

  const secAsset = {
    key: 'asset', title: '一、我的资产',
    lines: [
      { label: '总资产估值', value: `${fMoney(latest.totalUsd)} USD`, tone: '' },
      { label: '最新快照时间', value: latest.ts ? stampLabel(latest.ts, tz) : '—', tone: '' },
      { label: '区间 TWR（真实表现）', value: fPct(s.twrPct), tone: toneOf(s.twrPct) },
      { label: '总资产涨幅（含出入金）', value: fPct(s.rawChangePct), tone: toneOf(s.rawChangePct) },
      { label: '净外部现金流', value: `${fSigned(s.netCashflowUsd)} USD`, tone: toneOf(s.netCashflowUsd) },
      { label: '最大回撤', value: fPct(s.maxDrawdownPct), tone: toneOf(s.maxDrawdownPct) },
      { label: '显式成本合计', value: `${fMoney(s.totalExplicitCostUsd)} USD`, tone: '' },
    ],
    bullets: ['按明确时间点对比（总资产口径，含出入金）：'],
  };
  for (const w of windows) {
    if (!w.ok) {
      secAsset.bullets.push(`${w.label} · 截止 ${w.toLabel}：—（${w.reason}）`);
      continue;
    }
    const arrow = w.changeUsd > 0 ? '↗' : w.changeUsd < 0 ? '↘' : '→';
    secAsset.bullets.push(
      `${w.label} · ${w.fromLabel} → ${w.toLabel}：${fSigned(w.changeUsd)} USD (${fPct(w.changePct)}) ${arrow}`);
  }

  const secMarket = {
    key: 'market', title: '一、主流币行情快照',
    lines: [], bullets: [],
  };
  if (brief.length) {
    for (const b of brief) {
      secMarket.lines.push({
        label: b.symbol,
        value: `${fPrice(b.lastPrice)} USD · 24h ${fPct(b.chg24Pct)} · 7d ${fPct(b.chg7Pct)} · 24h ${fPrice(b.low24)}~${fPrice(b.high24)}`,
        tone: toneOf(b.chg24Pct),
      });
    }
  } else {
    secMarket.bullets.push('暂无基准 K 线数据（live 模式会在采集时自动抓取公开行情）');
  }

  const secOutlook = {
    key: 'outlook', title: '二、未来 24 小时技术面研判（非预测）',
    lines: [], bullets: [],
  };
  for (const b of brief) {
    if (!b.outlook) {
      secOutlook.lines.push({ label: b.symbol, value: 'K 线样本不足，暂不研判', tone: '' });
      continue;
    }
    const o = b.outlook;
    secOutlook.lines.push({
      label: b.symbol,
      value: `${o.bias} · 技术区间 ${fPrice(o.projectedLow)}~${fPrice(o.projectedHigh)} (±${fMoney(o.bandPct, 2)}%)`,
      tone: o.score >= 1 ? 'up' : o.score <= -1 ? 'down' : '',
    });
    secOutlook.bullets.push(`${b.symbol} 依据：${o.drivers.join('、') || '样本不足'}；参考支撑 ${fPrice(o.support)} / 阻力 ${fPrice(o.resistance)}`);
  }

  const evc = num((mk.metrics && mk.metrics.summary || {}).eventCount) || 0;
  const secMarketEvents = {
    key: 'marketEvents', title: '三、行情数据与事件口径',
    lines: [
      { label: '基准币种', value: brief.map(b => b.symbol).join(' / ') || '—', tone: '' },
      { label: 'K 线周期 / 样本', value: `${mkCfg.candleInterval || '5m'} · ${brief.length ? brief[0].bars : 0} 根/币种`, tone: '' },
      { label: '区间内事件', value: `${evc} 个（自动异动 + 人工标注，非实时新闻）`, tone: '' },
    ],
    bullets: ['研判为规则化技术面观察：均线位置、RSI、24h 已实现波动率、量比；不含新闻或链上资金流，突发消息可使区间失效。'],
  };

  const secCompare = {
    key: 'compare', title: '二、资产 vs 主流币',
    lines: [
      { label: '结论', value: concl.headline || '数据不足', tone: concl.excessVsMainPct === null || concl.excessVsMainPct === undefined ? '' : toneOf(concl.excessVsMainPct) },
      { label: '资产 TWR', value: fPct(concl.navPct), tone: toneOf(concl.navPct) },
      { label: `${concl.mainSeries || 'BTC'} 同期`, value: fPct(concl.mainPct), tone: toneOf(concl.mainPct) },
      { label: 'β（市场敏感度）', value: fMoney((mk.metrics && mk.metrics.summary || {}).betaVsMain, 3), tone: '' },
      { label: '稳定币占比', value: conc.stablecoinPct === undefined ? '—' : `${fMoney(conc.stablecoinPct, 1)}%`, tone: '' },
      { label: '最大单一持仓', value: conc.top1Pct === undefined ? '—' : `${fMoney(conc.top1Pct, 1)}%`, tone: '' },
    ],
    bullets: [],
  };
  const topReasons = (mk.reasons || []).slice(0, 3).map(x => `${x.label}：${x.text}`);
  if (topReasons.length) secCompare.bullets.push('主因：' + topReasons.join(' ｜ ').slice(0, 220));

  const secQuality = {
    key: 'quality', title: '三、数据说明',
    lines: [
      { label: '统计窗口', value: `${fMoney(risk.windowDays, 2)} 天 · ${q.snapshotCount || 0} 个快照`, tone: '' },
      { label: '年化指标', value: windowReliable ? '窗口充足，可用' : '窗口不足 7 天，仅供演示', tone: windowReliable ? '' : 'up' },
      { label: '哈希链完整性', value: q.hashChainOk === null ? '—' : (q.hashChainOk ? '✓ 通过' : '⚠ 异常'), tone: q.hashChainOk === false ? 'up' : '' },
      { label: '采集断点 / 重复事件', value: `${q.longGaps || 0} / ${q.duplicateEventIds || 0}`, tone: '' },
    ],
    bullets: [],
  };

  // v5: one SHORT section for the extended API data. The long tail (9 tidy
  // tables) stays in the export centre; the report only carries 3 key lines.
  const enr = (a.enrichment && a.enrichment.available && a.enrichment.summary) || null;
  const secEnrich = enr ? {
    key: 'enrich', title: '四、扩展数据速览（更多数据）',
    lines: [
      { label: '全市场宽度', value: `${enr.advancers === null ? '—' : enr.advancers} 涨 / ${enr.decliners === null ? '—' : enr.decliners} 跌 · 上涨占比 ${fPct(enr.upRatioPct)}`, tone: toneOf(enr.medianChangePct) },
      { label: '我的持仓 24h vs 大盘', value: `${fPct(enr.portfolio24hPct)} vs 中位 ${fPct(enr.medianChangePct)} · ${enr.relativeVerdict || '—'}`, tone: toneOf(enr.excessVsMarketPct) },
      { label: '资金占用', value: `冻结 ${fPct(enr.lockedSharePct)} · 借款/总资产 ${fPct(enr.borrowedToTotalPct)} · 平均价差 ${enr.avgSpreadPct === null || enr.avgSpreadPct === undefined ? '—' : fMoney(enr.avgSpreadPct, 4) + '%'}`, tone: '' },
    ],
    bullets: ['以上为低频扩展采集的关键摘要；费率表、盘口深度、合约资金费/基差、账户状态、充提链等完整明细见导出中心（9 张表）。'],
  } : null;

  const obs = observations(a, mk, brief, summary, windowReliable);
  // One extra data-driven observation from market breadth (never a trade call).
  if (enr && num(enr.upRatioPct) !== null && (enr.upRatioPct < 25 || enr.upRatioPct > 75)) {
    const weak = enr.upRatioPct < 25;
    obs.push({
      level: weak ? 'warn' : 'info',
      title: weak ? '全市场普跌，注意组合防守' : '全市场普涨，留意追高风险',
      detail: `USDT 交易对上涨占比 ${fMoney(enr.upRatioPct, 1)}%，中位涨跌 ${fPct(enr.medianChangePct)}；我的持仓 24h ${fPct(enr.portfolio24hPct)}，${enr.relativeVerdict}。极端宽度下分散化通常失效，建议复核集中度与稳定币缓冲。`,
      basis: 'enrichment.jsonl 全市场宽度 + 持仓 24h 加权涨跌',
    });
  }

  const meta = {
    generatedAt: iso(now), generatedAtLocal: `${dateLabel(now, tz)} ${timeLabel(now, tz)}`,
    date: dateLabel(now, tz), tzLabel: `UTC${tz >= 0 ? '+' : ''}${tz}`,
    tzOffsetHours: tz, mode: a.meta ? a.meta.mode : (summary.mode || 'mock'),
    windowFrom: a.meta ? a.meta.from : null, windowTo: a.meta ? a.meta.to : null,
    snapshotCount: q.snapshotCount || 0, windowReliable,
    benchmarkMain: concl.mainSeries || (mkCfg.symbols && mkCfg.symbols[0]) || 'BTC',
  };

  const disclaimer = '以上为基于真实数据的观察与复核提示，不构成投资建议、不含任何买卖指令；事件为行情异动自动检测或人工标注，非实时新闻。加密资产波动大，决策请自行判断。';
  const marketDisclaimer = '未来 24h 研判为基于已收盘 K 线的规则化技术面观察（均线 / RSI / 已实现波动率 / 量比），不是价格预测或投资建议；突发消息、流动性变化可使区间失效。';

  const keyMetrics = {
    totalUsd: num(latest.totalUsd), deltaUsd: num(summary.deltaUsd),
    twrPct: num(s.twrPct), maxDrawdownPct: num(s.maxDrawdownPct),
    netCashflowUsd: num(s.netCashflowUsd), totalExplicitCostUsd: num(s.totalExplicitCostUsd),
    excessVsMainPct: num(concl.excessVsMainPct), betaVsMain: num((mk.metrics && mk.metrics.summary || {}).betaVsMain),
    stablecoinPct: num(conc.stablecoinPct), top1Pct: num(conc.top1Pct),
    windowDays: num(risk.windowDays), hashChainOk: q.hashChainOk === undefined ? null : q.hashChainOk,
    eventCount: evc,
    enrichAvailable: !!(a.enrichment && a.enrichment.available),
    upRatioPct: enr ? num(enr.upRatioPct) : null,
    portfolio24hPct: enr ? num(enr.portfolio24hPct) : null,
    excessVsMarketPct: enr ? num(enr.excessVsMarketPct) : null,
    lockedSharePct: enr ? num(enr.lockedSharePct) : null,
  };

  function makeSub(title, headlineText, sections, observations, note) {
    const r = {
      title, meta: Object.assign({ kind: title }, meta), headline: headlineText,
      sections, observations, marketBrief: brief, assetWindows: windows,
      keyMetrics, disclaimer: note || disclaimer,
    };
    r.markdown = buildMarkdown(r);
    r.markdownChunks = splitMarkdown(r.markdown);
    r.plain = buildPlain(r);
    return r;
  }

  const assetHeadline = headlineParts.slice(0, 2).join(' · ') || headline;
  const marketChg = brief.map(b => b.chg24Pct).filter(x => x !== null);
  const marketHeadline = brief.length
    ? `${brief.length} 个基准币种 · 24h 均值 ${marketChg.length ? fPct(marketChg.reduce((x, y) => x + y, 0) / marketChg.length) : '—'} · ${brief.filter(b => b.outlook && b.outlook.score >= 1).length} 偏强 / ${brief.filter(b => b.outlook && b.outlook.score <= -1).length} 偏弱`
    : '暂无基准 K 线，行情研判未生成';

  const assetReport = makeSub(
    '每日资产日报 · 我的资产', assetHeadline,
    [secAsset, secCompare, secQuality].concat(secEnrich ? [secEnrich] : []),
    obs, disclaimer);
  const marketReport = makeSub(
    '每日资产日报 · 大行情', marketHeadline,
    [secMarket, secOutlook, secMarketEvents], [], marketDisclaimer);

  const rep = {
    meta, headline,
    sections: [secAsset, secMarket, secOutlook, secCompare, secQuality, secMarketEvents].concat(secEnrich ? [secEnrich] : []),
    observations: obs, marketBrief: brief, assetWindows: windows,
    keyMetrics, disclaimer,
    assetReport, marketReport,
  };
  rep.markdown = buildMarkdown(rep);
  rep.markdownChunks = splitMarkdown(rep.markdown);
  rep.plain = buildPlain(rep);
  return rep;
}

function buildPlain(rep) {
  const L = [];
  L.push(`${rep.title || '每日资产日报'} · ${rep.meta.date}`);
  L.push(rep.headline);
  L.push('');
  for (const sec of rep.sections) {
    L.push(sec.title);
    for (const line of sec.lines) L.push(`  ${line.label}: ${line.value}`);
    for (const b of (sec.bullets || [])) L.push(`  ${b}`);
    L.push('');
  }
  if (rep.observations && rep.observations.length) {
    L.push('资产处置观察（数据驱动，非投资建议）');
    rep.observations.forEach((o, i) => { L.push(`  ${i + 1}. [${o.level}] ${o.title}`); L.push(`     ${o.detail}`); L.push(`     依据: ${o.basis}`); });
    L.push('');
  }
  L.push(rep.disclaimer);
  return L.join('\n');
}

module.exports = { build, marketBrief, assetWindows, observations, splitMarkdown, WECOM_MAX_BYTES, CHUNK_TARGET };
