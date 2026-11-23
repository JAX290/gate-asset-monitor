'use strict';

/**
 * Daily report — PURE FUNCTION, zero dependencies, no I/O.
 *
 * Builds a structured Chinese daily report from already-collected data:
 *   analysis   analytics.compute() result (assets / NAV / risk / cost / quality)
 *   market     marketAnalytics.compute() result (portfolio vs BTC/ETH + reasons)
 *   marketPts  raw benchmark K-lines (for latest price / 24h change / event count)
 *   summary    /api/summary payload (mode, latest, delta, status)
 *   macroEvents, config, now
 *
 * HONESTY CONTRACT (important):
 *   - The "处置建议" section is a set of DATA-DRIVEN OBSERVATIONS / review
 *     prompts derived from real numeric thresholds. It never fabricates a
 *     buy/sell instruction, never invents news, never claims prediction.
 *   - Every observation carries its `basis` (the actual number behind it) and
 *     the report ends with an explicit not-investment-advice disclaimer.
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

/** Latest price + 24h / window change per benchmark symbol from raw K-lines. */
function marketBrief(marketPts, nowMs, symbols) {
  const out = [];
  const by = new Map();
  for (const p of (marketPts || [])) {
    const sym = String(p.symbol || '').toUpperCase();
    if (!by.has(sym)) by.set(sym, []);
    by.get(sym).push(p);
  }
  const syms = symbols && symbols.length ? symbols.map(s => String(s).toUpperCase()) : Array.from(by.keys());
  for (const sym of syms) {
    const rows = (by.get(sym) || []).slice().sort((a, b) => Number(a.ts) - Number(b.ts));
    if (!rows.length) continue;
    const last = rows[rows.length - 1];
    const lastClose = num(last.close);
    const cutoff24 = Number(nowMs) - 24 * 3600 * 1000;
    const past = rows.filter(r => Number(r.ts) <= cutoff24).pop() || rows[0];
    const first = rows[0];
    const chg24 = lastClose !== null && num(past.close) ? (lastClose / num(past.close) - 1) * 100 : null;
    const chgWin = lastClose !== null && num(first.close) ? (lastClose / num(first.close) - 1) * 100 : null;
    let hi = -Infinity, lo = Infinity;
    for (const r of rows.slice(-24)) { const c = num(r.close); if (c === null) continue; if (c > hi) hi = c; if (c < lo) lo = c; }
    out.push({
      symbol: sym, lastPrice: lastClose, lastTs: Number(last.ts),
      chg24Pct: chg24 === null ? null : Math.round(chg24 * 100) / 100,
      chgWindowPct: chgWin === null ? null : Math.round(chgWin * 100) / 100,
      high24: Number.isFinite(hi) ? hi : null, low24: Number.isFinite(lo) ? lo : null,
      bars: rows.length,
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
  L.push(`# 每日资产日报 · ${rep.meta.date}`);
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

  L.push('## 资产处置观察（数据驱动，非投资建议）');
  const icon = { good: '🟢', info: '🔵', warn: '🟠' };
  rep.observations.forEach((o, i) => {
    L.push(`**${icon[o.level] || '🔵'} ${i + 1}. ${o.title}**`);
    L.push(`> ${o.detail}`);
    L.push(`> <font color="comment">依据：${o.basis}</font>`);
  });
  L.push('');
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
 * @returns full report object { meta, headline, sections, observations,
 *          marketBrief, markdown, markdownChunks, plain, disclaimer }
 */
function build(input) {
  const a = input.analysis || {}, mk = input.market || {}, summary = input.summary || {};
  const config = input.config || {};
  const now = Number(input.now) || Date.now();
  const tz = Number(config.report && config.report.tzOffsetHours) || 8;
  const windowReliable = !!(a.risk && a.risk.annualizationReliable) &&
    (Number(a.risk.windowDays) || 0) >= 7;
  const s = a.summary || {}, risk = a.risk || {}, cost = a.costs || {},
    conc = a.concentration || {}, q = a.quality || {};
  const latest = summary.latest || {};
  const brief = marketBrief(input.marketPts, now, config.market && config.market.symbols);
  const concl = mk.conclusion || {};

  const headlineParts = [];
  if (num(latest.totalUsd) !== null) headlineParts.push(`总资产 ${fMoney(latest.totalUsd)} USD`);
  if (num(s.twrPct) !== null) headlineParts.push(`区间 TWR ${fPct(s.twrPct)}`);
  if (num(concl.excessVsMainPct) !== null) {
    headlineParts.push(`较 ${concl.mainSeries || 'BTC'} ${concl.excessVsMainPct >= 0 ? '跑赢' : '跑输'} ${Math.abs(concl.excessVsMainPct).toFixed(2)}pp`);
  }
  const headline = headlineParts.length ? headlineParts.join(' · ') : '数据累积中，暂无足够快照生成摘要';

  const secAsset = {
    key: 'asset', title: '一、我的资产',
    lines: [
      { label: '总资产估值', value: `${fMoney(latest.totalUsd)} USD`, tone: '' },
      { label: '较上一次快照', value: `${fSigned(summary.deltaUsd)} USD (${fPct(summary.deltaPct)})`, tone: toneOf(summary.deltaUsd) },
      { label: '区间 TWR（真实表现）', value: fPct(s.twrPct), tone: toneOf(s.twrPct) },
      { label: '总资产涨幅（含出入金）', value: fPct(s.rawChangePct), tone: toneOf(s.rawChangePct) },
      { label: '净外部现金流', value: `${fSigned(s.netCashflowUsd)} USD`, tone: toneOf(s.netCashflowUsd) },
      { label: '最大回撤', value: fPct(s.maxDrawdownPct), tone: toneOf(s.maxDrawdownPct) },
      { label: '显式成本合计', value: `${fMoney(s.totalExplicitCostUsd)} USD`, tone: '' },
    ],
    bullets: [],
  };

  const secMarket = {
    key: 'market', title: '二、最近行情（主流币）',
    lines: [], bullets: [],
  };
  if (brief.length) {
    for (const b of brief) {
      secMarket.lines.push({
        label: b.symbol,
        value: `${b.lastPrice === null ? '—' : fMoney(b.lastPrice, 2)} USD · 24h ${fPct(b.chg24Pct)} · 区间 ${fPct(b.chgWindowPct)}`,
        tone: toneOf(b.chg24Pct),
      });
    }
    const evc = num((mk.metrics && mk.metrics.summary || {}).eventCount) || 0;
    secMarket.bullets.push(`覆盖 ${brief[0].bars} 根已收盘 K 线 · 区间内 ${evc} 个行情异动/人工标注事件`);
  } else {
    secMarket.bullets.push('暂无基准 K 线数据（live 模式会在采集时自动抓取公开行情）');
  }

  const secCompare = {
    key: 'compare', title: '三、资产 vs 主流币',
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
    key: 'quality', title: '四、数据说明',
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
    key: 'enrich', title: '五、扩展数据速览（更多数据）',
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
    benchmarkMain: concl.mainSeries || (config.market && config.market.symbols && config.market.symbols[0]) || 'BTC',
  };

  const disclaimer = '以上为基于真实数据的观察与复核提示，不构成投资建议、不含任何买卖指令；事件为行情异动自动检测或人工标注，非实时新闻。加密资产波动大，决策请自行判断。';

  const rep = {
    meta, headline,
    sections: [secAsset, secMarket, secCompare, secQuality].concat(secEnrich ? [secEnrich] : []),
    observations: obs, marketBrief: brief,
    keyMetrics: {
      totalUsd: num(latest.totalUsd), deltaUsd: num(summary.deltaUsd),
      twrPct: num(s.twrPct), maxDrawdownPct: num(s.maxDrawdownPct),
      netCashflowUsd: num(s.netCashflowUsd), totalExplicitCostUsd: num(s.totalExplicitCostUsd),
      excessVsMainPct: num(concl.excessVsMainPct), betaVsMain: num((mk.metrics && mk.metrics.summary || {}).betaVsMain),
      stablecoinPct: num(conc.stablecoinPct), top1Pct: num(conc.top1Pct),
      windowDays: num(risk.windowDays), hashChainOk: q.hashChainOk === undefined ? null : q.hashChainOk,
      eventCount: num((mk.metrics && mk.metrics.summary || {}).eventCount) || 0,
      enrichAvailable: !!(a.enrichment && a.enrichment.available),
      upRatioPct: enr ? num(enr.upRatioPct) : null,
      portfolio24hPct: enr ? num(enr.portfolio24hPct) : null,
      excessVsMarketPct: enr ? num(enr.excessVsMarketPct) : null,
      lockedSharePct: enr ? num(enr.lockedSharePct) : null,
    },
    disclaimer,
  };
  rep.markdown = buildMarkdown(rep);
  rep.markdownChunks = splitMarkdown(rep.markdown);
  rep.plain = buildPlain(rep);
  return rep;
}

function buildPlain(rep) {
  const L = [];
  L.push(`每日资产日报 · ${rep.meta.date}`);
  L.push(rep.headline);
  L.push('');
  for (const sec of rep.sections) {
    L.push(sec.title);
    for (const line of sec.lines) L.push(`  ${line.label}: ${line.value}`);
    for (const b of (sec.bullets || [])) L.push(`  ${b}`);
    L.push('');
  }
  L.push('资产处置观察（数据驱动，非投资建议）');
  rep.observations.forEach((o, i) => { L.push(`  ${i + 1}. [${o.level}] ${o.title}`); L.push(`     ${o.detail}`); L.push(`     依据: ${o.basis}`); });
  L.push('');
  L.push(rep.disclaimer);
  return L.join('\n');
}

module.exports = { build, marketBrief, observations, splitMarkdown, WECOM_MAX_BYTES, CHUNK_TARGET };
