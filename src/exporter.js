'use strict';

/**
 * Unified export layer — "everything exportable, third-party analysable".
 *
 * Produces 20 TIDY long tables (one row = one observation), each with a fixed
 * column order and a machine-readable data dictionary describing every
 * column's type / unit / definition. Serialisers: CSV (UTF-8 BOM), JSON, JSONL.
 * A single ZIP bundles all tables + manifest + dictionary + README + the full
 * analytics result.
 *
 * Design rules for third-party friendliness:
 *  - timestamps: always ts_ms (Unix ms, UTC) AND ts_iso_utc (ISO 8601)
 *  - ratios are fractions; percentages are explicit *_pct columns (0-100)
 *  - money columns are raw numbers in *_usd; no thousand separators, no symbols
 *  - missing values -> empty cell in CSV, null in JSON
 *  - nested objects are flattened or JSON-stringified, never silently dropped
 */
const zip = require('./zip');
const config = require('./config');
const metricGlossary = require('./metricGlossary');
const operations = require('./operations');
const enrichAnalytics = require('./enrichAnalytics');

const C = (name, type, unit, desc) => ({ name, type, unit, desc });

const SCHEMA = {
  snapshots: {
    title: '资产快照主表', grain: '一行 = 一个采集时点',
    columns: [
      C('ts_ms', 'integer', 'ms', '采集时间戳（Unix 毫秒, UTC）'),
      C('ts_iso_utc', 'iso8601', 'UTC', '采集时间（ISO 8601, UTC）'),
      C('mode', 'string', '', '数据源模式：mock=模拟 / live=真实 API'),
      C('quote_currency', 'string', '', '计价货币标签'),
      C('total_usd', 'number', 'USD', '总资产估值（各账户合计）'),
      C('spot_usd', 'number', 'USD', '现货持仓估值合计'),
      C('other_accounts_usd', 'number', 'USD', '非现货账户估值合计'),
      C('accounts_count', 'integer', 'count', '该快照的账户分类数'),
      C('holdings_count', 'integer', 'count', '该快照的币种明细数'),
      C('has_notes', 'boolean', '', '该次采集是否有数据源告警'),
      C('notes', 'string', '', '采集告警/备注（| 分隔）'),
    ],
  },
  holdings: {
    title: '逐币种持仓长表', grain: '一行 = 一个时点 × 一个币种',
    columns: [
      C('ts_ms', 'integer', 'ms', '采集时间戳（Unix 毫秒）'),
      C('ts_iso_utc', 'iso8601', 'UTC', '采集时间（ISO 8601）'),
      C('currency', 'string', '', '币种代码（大写）'),
      C('venue', 'string', '', '持仓场所：spot/futures/earn/margin'),
      C('qty', 'number', 'token', '持有数量'),
      C('available', 'number', 'token', '可用数量'),
      C('locked', 'number', 'token', '冻结数量'),
      C('price_usd_implied', 'number', 'USD/token', '隐含单价 = value_usd / qty（无独立行情时的口径）'),
      C('value_usd', 'number', 'USD', '该币种估值（= qty × 隐含单价）'),
      C('weight_pct', 'number', 'percent', '占该时点持仓合计的百分比 0-100'),
    ],
  },
  accounts: {
    title: '账户分类长表', grain: '一行 = 一个时点 × 一个账户',
    columns: [
      C('ts_ms', 'integer', 'ms', '采集时间戳'),
      C('ts_iso_utc', 'iso8601', 'UTC', '采集时间'),
      C('account_id', 'string', '', '账户标识：spot/futures/earn/margin/...'),
      C('account_label', 'string', '', '账户显示名'),
      C('amount_usd', 'number', 'USD', '该账户估值'),
      C('currency', 'string', '', '账户计价货币'),
      C('borrowed_usd', 'number', 'USD', '借款金额'),
      C('unrealised_pnl_usd', 'number', 'USD', '未实现盈亏'),
      C('weight_pct', 'number', 'percent', '占该时点账户合计的百分比 0-100'),
    ],
  },
  events: {
    title: '事件流水（操作历史）', grain: '一行 = 一个事件（成交按双腿+手续费拆分，ref_id 关联）',
    columns: [
      C('event_id', 'string', '', '事件唯一 ID（幂等去重键）'),
      C('seq', 'integer', 'count', '追加序号（哈希链顺序）'),
      C('ts_ms', 'integer', 'ms', '事件发生时间戳'),
      C('ts_iso_utc', 'iso8601', 'UTC', '事件发生时间'),
      C('type', 'string', '', 'deposit/withdraw/trade/fee/funding/interest/realized_pnl/transfer/liquidation/rebate/other'),
      C('currency', 'string', '', '涉及币种'),
      C('amount', 'number', 'token', '该币种数量变化（带符号）'),
      C('amount_usd', 'number', 'USD', '按当时价折算的 USD 金额（带符号）'),
      C('price_usd', 'number', 'USD/token', '成交/折算单价'),
      C('fee_amount', 'number', 'token', '手续费数量'),
      C('fee_currency', 'string', '', '手续费币种'),
      C('fee_usd', 'number', 'USD', '手续费 USD 金额'),
      C('side', 'string', '', 'buy/sell/long/short'),
      C('role', 'string', '', 'maker/taker（Gate 成交角色）'),
      C('venue', 'string', '', 'spot/futures/earn/margin/wallet'),
      C('account', 'string', '', '账户标识'),
      C('pair', 'string', '', '交易对'),
      C('ref_id', 'string', '', '同一笔成交的关联 ID（双腿+手续费共用）'),
      C('is_cashflow', 'boolean', '', '是否外部现金流（影响净值/TWR 剥离）'),
      C('cashflow_usd', 'number', 'USD', '净外部现金流：+充值 / -提现（仅 is_cashflow=true）'),
      C('is_realized', 'boolean', '', '是否已实现盈亏/成本（非市值重估）'),
      C('source', 'string', '', 'live/mock/manual'),
      C('note', 'string', '', '备注'),
      C('prev_hash', 'string', '', '前一条记录 hash（SHA-256 链）'),
      C('hash', 'string', '', '本条记录 hash（防篡改校验）'),
    ],
  },
  prices: {
    title: '独立行情价格序列', grain: '一行 = 一个时点 × 一个币种',
    columns: [
      C('price_id', 'string', '', '价格记录 ID'),
      C('seq', 'integer', 'count', '追加序号'),
      C('ts_ms', 'integer', 'ms', '时间戳'),
      C('ts_iso_utc', 'iso8601', 'UTC', '时间'),
      C('currency', 'string', '', '币种'),
      C('price_usd', 'number', 'USD/token', 'USD 单价'),
      C('quote', 'string', '', '计价货币'),
      C('source', 'string', '', 'live/mock'),
      C('prev_hash', 'string', '', '哈希链前驱'),
      C('hash', 'string', '', '本条 hash'),
    ],
  },
  decisions: {
    title: '人工决策日志（当前状态）', grain: '一行 = 一条决策（事件溯源折叠后的最新状态）',
    columns: [
      C('decision_id', 'string', '', '决策 ID'),
      C('decided_at_ms', 'integer', 'ms', '决策发生时间'),
      C('decided_at_iso_utc', 'iso8601', 'UTC', '决策发生时间'),
      C('action', 'string', '', 'buy/sell/deposit/withdraw/rebalance/hold/other'),
      C('symbol', 'string', '', '标的币种'),
      C('amount', 'number', 'token', '数量'),
      C('price_usd', 'number', 'USD/token', '决策时价格'),
      C('value_usd', 'number', 'USD', '决策时金额'),
      C('reason', 'string', '', '决策理由（为什么这么做）'),
      C('expectation', 'string', '', '预期（当时认为会怎样）'),
      C('tags', 'string', '', '标签（| 分隔）'),
      C('review_note', 'string', '', '复盘结论'),
      C('outcome', 'string', '', '复盘结果：better/as_expected/worse/abandoned'),
      C('reviewed_at_ms', 'integer', 'ms', '复盘时间'),
      C('source', 'string', '', 'manual'),
      C('note', 'string', '', '备注'),
    ],
  },
  decision_events: {
    title: '决策原始审计链（未折叠）', grain: '一行 = 一条 create/edit/review/delete 原始记录（append-only 哈希链）',
    columns: [
      C('seq', 'integer', 'count', '哈希链追加序号'),
      C('op_ts_ms', 'integer', 'ms', '该操作写入时间戳（Unix 毫秒, UTC）'),
      C('op_ts_iso_utc', 'iso8601', 'UTC', '该操作写入时间（ISO 8601）'),
      C('op', 'string', '', '溯源操作：create/edit/review/delete'),
      C('record_id', 'string', '', '该条链上记录 ID'),
      C('decision_id', 'string', '', '关联决策 ID'),
      C('decided_at_ms', 'integer', 'ms', '业务决策时间（create 记录携带）'),
      C('action', 'string', '', '决策操作（如该记录携带）'),
      C('symbol', 'string', '', '标的币种（如该记录携带）'),
      C('amount', 'number', 'token', '数量（如该记录携带）'),
      C('price_usd', 'number', 'USD/token', '价格（如该记录携带）'),
      C('value_usd', 'number', 'USD', '金额（如该记录携带）'),
      C('reason', 'string', '', '理由（如该记录携带）'),
      C('expectation', 'string', '', '预期（如该记录携带）'),
      C('tags', 'string', '', '标签（| 分隔）'),
      C('review_note', 'string', '', '复盘结论（review 记录）'),
      C('outcome', 'string', '', '复盘结果（review 记录）'),
      C('reviewed_at_ms', 'integer', 'ms', '复盘时间（review 记录）'),
      C('payload_json', 'string', 'json', '该条原始记录完整字段（JSON，保底不丢任何自定义字段）'),
      C('source', 'string', '', '来源：manual'),
      C('prev_hash', 'string', '', '前一条记录 hash'),
      C('hash', 'string', '', '本条记录 hash（SHA-256 链）'),
    ],
  },
  cashflows: {
    title: '外部现金流（净值剥离用）', grain: '一行 = 一笔充值/提现',
    columns: [
      C('ts_ms', 'integer', 'ms', '时间戳'),
      C('ts_iso_utc', 'iso8601', 'UTC', '时间'),
      C('type', 'string', '', 'deposit/withdraw'),
      C('currency', 'string', '', '币种'),
      C('amount', 'number', 'token', '数量'),
      C('cashflow_usd', 'number', 'USD', '净外部现金流（+入 / -出）'),
      C('note', 'string', '', '备注'),
      C('source', 'string', '', 'live/mock/manual'),
    ],
  },
  nav: {
    title: '单位净值 / TWR 曲线', grain: '一行 = 一个快照时点',
    columns: [
      C('ts_ms', 'integer', 'ms', '时间戳'),
      C('ts_iso_utc', 'iso8601', 'UTC', '时间'),
      C('total_usd', 'number', 'USD', '总资产（含现金流影响）'),
      C('cashflow_usd', 'number', 'USD', '该区间净外部现金流（期末约定）'),
      C('net_asset_usd', 'number', 'USD', '剔除现金流后的期末市值 = total - cashflow'),
      C('units', 'number', 'share', '基金份额（现金流按当期净值折算）'),
      C('nav_per_unit', 'number', 'index', '单位净值，起点 = 1'),
      C('period_return', 'number', 'ratio', '本区间收益率 r=(V-CF)/V_prev-1'),
      C('twr', 'number', 'ratio', '累计时间加权收益率 = nav_per_unit - 1'),
      C('drawdown', 'number', 'ratio', '相对历史峰值的回撤（<=0）'),
      C('benchmark_price', 'number', 'USD/token', '基准币种（默认 BTC）价格'),
      C('mode', 'string', '', '数据源模式'),
    ],
  },
  attribution: {
    title: '逐币种归因分解（逐区间）', grain: '一行 = 一个区间 × 一个币种（含 __RESIDUAL__）',
    columns: [
      C('from_ts_ms', 'integer', 'ms', '区间起点'),
      C('to_ts_ms', 'integer', 'ms', '区间终点'),
      C('from_iso_utc', 'iso8601', 'UTC', '区间起点'),
      C('to_iso_utc', 'iso8601', 'UTC', '区间终点'),
      C('currency', 'string', '', '币种；__RESIDUAL__ = 未被持仓覆盖的残差'),
      C('qty0', 'number', 'token', '期初数量'),
      C('qty1', 'number', 'token', '期末数量'),
      C('price0', 'number', 'USD/token', '期初隐含单价'),
      C('price1', 'number', 'USD/token', '期末隐含单价'),
      C('value0_usd', 'number', 'USD', '期初市值'),
      C('value1_usd', 'number', 'USD', '期末市值'),
      C('price_effect_usd', 'number', 'USD', '价格效应 =(p1-p0)*q0'),
      C('qty_effect_usd', 'number', 'USD', '数量效应 =(q1-q0)*p0（加仓/减仓，非投资收益）'),
      C('cross_effect_usd', 'number', 'USD', '交叉效应 =(p1-p0)*(q1-q0)'),
      C('delta_value_usd', 'number', 'USD', '市值变动 = 三段效应之和'),
      C('contribution_pct', 'number', 'percent', '对期初总资产的贡献 %'),
      C('price_change_pct', 'number', 'percent', '该币种单价涨跌 %'),
      C('qty_change_pct', 'number', 'percent', '持仓数量变动 %'),
      C('trade_driven_qty', 'number', 'token', '区间内该币种的成交量绝对值'),
      C('flow_driven_qty', 'number', 'token', '区间内该币种的充提量绝对值'),
      C('is_residual', 'boolean', '', '是否残差行'),
    ],
  },
  attribution_agg: {
    title: '逐币种归因汇总', grain: '一行 = 一个币种（全窗口累计）',
    columns: [
      C('currency', 'string', '', '币种 / __RESIDUAL__'),
      C('intervals', 'integer', 'count', '参与区间数'),
      C('price_effect_usd', 'number', 'USD', '累计价格效应'),
      C('qty_effect_usd', 'number', 'USD', '累计数量效应'),
      C('cross_effect_usd', 'number', 'USD', '累计交叉效应'),
      C('delta_value_usd', 'number', 'USD', '累计市值变动'),
      C('contribution_pct', 'number', 'percent', '占总变动的贡献 %'),
    ],
  },
  distribution: {
    title: '账户分布迁移', grain: '一行 = 一个账户（首末对比）',
    columns: [
      C('account_id', 'string', '', '账户标识'),
      C('label', 'string', '', '账户显示名'),
      C('first_amount_usd', 'number', 'USD', '窗口起点金额'),
      C('last_amount_usd', 'number', 'USD', '窗口终点金额'),
      C('change_usd', 'number', 'USD', '金额变化'),
      C('change_pct', 'number', 'percent', '变化 %'),
      C('last_weight_pct', 'number', 'percent', '终点占比 %'),
    ],
  },
  metrics: {
    title: '指标汇总（键值长表）', grain: '一行 = 一个指标',
    columns: [
      C('category', 'string', '', '指标分类：summary/risk/benchmark/cost/behavior/concentration/quality'),
      C('metric', 'string', '', '指标名'),
      C('value', 'string', '', '指标值（统一转字符串，null 表示不可计算）'),
      C('unit', 'string', '', '单位：USD/percent/pp/ratio/count/...'),
      C('window_from', 'iso8601', 'UTC', '统计窗口起点'),
      C('window_to', 'iso8601', 'UTC', '统计窗口终点'),
      C('note', 'string', '', '口径备注'),
    ],
  },
  market: {
    title: '主流币基准行情（Gate 公开 K 线）', grain: '一行 = 一个币种 × 一根已收盘 K 线',
    columns: [
      C('ts_ms', 'integer', 'ms', 'K 线开盘时间戳（Unix 毫秒, UTC）'),
      C('ts_iso_utc', 'iso8601', 'UTC', 'K 线开盘时间'),
      C('symbol', 'string', '', '基准币种：BTC/ETH/...'),
      C('quote', 'string', '', '计价货币（USDT）'),
      C('open', 'number', 'USD/token', '开盘价'),
      C('high', 'number', 'USD/token', '最高价'),
      C('low', 'number', 'USD/token', '最低价'),
      C('close', 'number', 'USD/token', '收盘价（对比计算使用的价格）'),
      C('base_volume', 'number', 'token', '基础币成交量'),
      C('quote_volume', 'number', 'USD', '计价币成交额'),
      C('interval_sec', 'integer', 's', 'K 线周期（秒）'),
      C('window_closed', 'boolean', '', '是否已收盘（未收盘的末根不入库）'),
      C('source', 'string', '', 'live=Gate 公开端点 / mock=DEMO 市场因子'),
      C('seq', 'integer', 'count', '哈希链追加序号'),
      C('prev_hash', 'string', '', '前一条记录 hash'),
      C('hash', 'string', '', '本条记录 hash（SHA-256 链）'),
    ],
  },
  macro_events: {
    title: '宏观 / 市场事件台账（当前有效）', grain: '一行 = 一个事件（事件溯源折叠后的当前状态）',
    columns: [
      C('event_id', 'string', '', '事件 ID'),
      C('event_ts_ms', 'integer', 'ms', '事件发生时间（业务时间，Unix 毫秒 UTC）'),
      C('event_iso_utc', 'iso8601', 'UTC', '事件发生时间'),
      C('category', 'string', '', 'macro/policy/onchain/listing/security/volatility/custom'),
      C('title', 'string', '', '事件标题'),
      C('summary', 'string', '', '事件摘要'),
      C('impact', 'string', '', 'bullish/bearish/neutral/unknown（人工或自动判定）'),
      C('symbols', 'string', '', '相关币种（| 分隔）'),
      C('source', 'string', '', 'manual=人工标注 / auto=行情异动自动检测 / mock=DEMO'),
      C('url', 'string', '', '来源链接（如人工填写）'),
      C('note', 'string', '', '备注'),
    ],
  },
  macro_event_log: {
    title: '事件台账原始审计链（未折叠）', grain: '一行 = 一条 create/edit/delete 原始记录',
    columns: [
      C('seq', 'integer', 'count', '哈希链追加序号'),
      C('op_ts_ms', 'integer', 'ms', '该操作写入时间（链时间，非业务事件时间）'),
      C('op_ts_iso_utc', 'iso8601', 'UTC', '该操作写入时间'),
      C('op', 'string', '', 'create/edit/delete'),
      C('record_id', 'string', '', '链上记录 ID'),
      C('event_id', 'string', '', '关联事件 ID'),
      C('event_ts_ms', 'integer', 'ms', '业务事件时间（create/edit 记录携带）'),
      C('category', 'string', '', '事件分类'),
      C('title', 'string', '', '事件标题'),
      C('summary', 'string', '', '事件摘要'),
      C('impact', 'string', '', '影响方向'),
      C('symbols', 'string', '', '相关币种（| 分隔）'),
      C('source', 'string', '', '来源'),
      C('payload_json', 'string', 'json', '该条原始记录完整字段（保底不丢自定义字段）'),
      C('prev_hash', 'string', '', '前一条记录 hash'),
      C('hash', 'string', '', '本条记录 hash'),
    ],
  },
  benchmark_comparison: {
    title: '资产 vs 主流币归一化对比时序', grain: '一行 = 一个时点 × 一个序列（长表）',
    columns: [
      C('ts_ms', 'integer', 'ms', '快照时间戳'),
      C('ts_iso_utc', 'iso8601', 'UTC', '快照时间'),
      C('series', 'string', '', 'NAV=我的单位净值 / BTC / ETH / INDEX=加权指数'),
      C('series_kind', 'string', '', 'portfolio/benchmark/index'),
      C('value', 'number', 'mixed', '原始值：组合为单位净值、基准为 USD 单价、INDEX 为指数点位'),
      C('normalized_value', 'number', 'index', '区间起点归一化到 100 的点位（跨序列可比）'),
      C('unit', 'string', '', 'value 的单位'),
    ],
  },
  relative_metrics: {
    title: '相对表现指标（区间对比）', grain: '一行 = 一个对比基准',
    columns: [
      C('series', 'string', '', '基准序列'),
      C('series_kind', 'string', '', 'benchmark/index'),
      C('from_ts_ms', 'integer', 'ms', '统计区间起点'),
      C('to_ts_ms', 'integer', 'ms', '统计区间终点'),
      C('nav_pct', 'number', 'percent', '资产 TWR 区间收益 %'),
      C('series_pct', 'number', 'percent', '基准区间涨跌 %'),
      C('excess_pct', 'number', 'pp', '超额 = nav_pct - series_pct（百分点算术差）'),
      C('beta_adjusted_excess_pct', 'number', 'pp', 'β 调整后主动超额 = 超额 - (β-1)×基准涨幅'),
      C('beta', 'number', 'ratio', 'OLS 斜率 cov(r_nav,r_bench)/var(r_bench)'),
      C('correlation', 'number', 'ratio', 'Pearson 相关系数'),
      C('r_squared', 'number', 'ratio', '相关系数平方'),
      C('tracking_error_pct', 'number', 'percent', 'stdev(r_nav-r_bench) 每期百分点，未年化'),
      C('up_capture', 'number', 'ratio', '上行捕获率'),
      C('down_capture', 'number', 'ratio', '下行捕获率'),
      C('sample_periods', 'integer', 'count', '有效配对区间数（基准发生变化的周期）'),
      C('outperformed', 'boolean', '', '是否跑赢该基准'),
    ],
  },
  event_windows: {
    title: '事件窗口复盘（事件 × 序列）', grain: '一行 = 一个事件 × 一个序列在事件窗口内的表现',
    columns: [
      C('event_id', 'string', '', '事件 ID'),
      C('event_ts_ms', 'integer', 'ms', '事件时间'),
      C('event_iso_utc', 'iso8601', 'UTC', '事件时间'),
      C('category', 'string', '', '事件分类'),
      C('title', 'string', '', '事件标题'),
      C('impact', 'string', '', '影响方向'),
      C('source', 'string', '', '事件来源'),
      C('symbols', 'string', '', '相关币种（| 分隔）'),
      C('window_from_ms', 'integer', 'ms', '事件窗口起点（事件前 N 个快照）'),
      C('window_to_ms', 'integer', 'ms', '事件窗口终点（事件后 N 个快照）'),
      C('series', 'string', '', '序列：NAV/BTC/ETH/INDEX'),
      C('series_kind', 'string', '', 'portfolio/benchmark/index'),
      C('window_pct', 'number', 'percent', '该序列在窗口内的涨跌 %'),
      C('excess_vs_nav_pct', 'number', 'pp', '资产相对该序列的超额（百分点）'),
      C('cashflow_usd', 'number', 'USD', '窗口内净外部现金流（不改变 TWR）'),
      C('trade_legs', 'integer', 'count', '窗口内成交腿数'),
      C('fee_usd', 'number', 'USD', '窗口内手续费合计'),
      C('decisions', 'integer', 'count', '窗口内决策条数'),
      C('dominant_holding', 'string', '', '事件时点最大非稳定币持仓'),
      C('dominant_weight_pct', 'number', 'percent', '该持仓占比 %'),
      C('top_drag_currency', 'string', '', '窗口内市值缩水最多的币种'),
      C('top_drag_usd', 'number', 'USD', '其市值变动'),
      C('top_lift_currency', 'string', '', '窗口内市值增长最多的币种'),
      C('top_lift_usd', 'number', 'USD', '其市值变动'),
      C('reason', 'string', '', '基于窗口数据的结构化原因说明'),
    ],
  },
  operations: {
    title: 'Gate 真实操作记录（只读同步）', grain: '一行 = 一笔操作（成交按 ref_id 聚合成一条买/卖，充提/划转/费用各一条）',
    columns: [
      C('operation_id', 'string', '', '操作稳定 ID（= 成交组的 ref_id 或单个事件 id；注释以此为外键）'),
      C('ts_ms', 'integer', 'ms', '操作时间（Unix 毫秒, UTC）'),
      C('ts_iso_utc', 'iso8601', 'UTC', '操作时间（ISO 8601）'),
      C('kind', 'string', '', 'buy/sell/deposit/withdraw/transfer/fee/funding/interest/realized_pnl/rebate/liquidation/trade_fill/order/lend/redeem/award/other'),
      C('kind_label', 'string', '', '操作类型中文名（trade_fill 会标注成交入账/出账）'),
      C('raw_type', 'string', '', 'Gate account_book 原始子类型（order_fill/new_order/order_fee/lend/redeem/award/cv_buy/cv_sell）'),
      C('side', 'string', '', 'buy/sell（成交方向，非成交为空）'),
      C('symbol', 'string', '', '主币种（成交为基础币，充提为该币）'),
      C('pair', 'string', '', '交易对（如 BTC_USDT，若可得）'),
      C('amount', 'number', 'token', '主数量（绝对值）'),
      C('price_usd', 'number', 'USD/token', '成交/折算单价'),
      C('value_usd', 'number', 'USD', '该操作 USD 金额（绝对值）'),
      C('fee_usd', 'number', 'USD', '该操作手续费合计'),
      C('fee_currency', 'string', '', '手续费币种'),
      C('venue', 'string', '', 'spot/futures/wallet'),
      C('is_cashflow', 'boolean', '', '是否外部现金流'),
      C('cashflow_usd', 'number', 'USD', '净外部现金流（+入/-出）'),
      C('source', 'string', '', 'live/mock/manual'),
      C('leg_count', 'integer', 'count', '聚合的事件腿数'),
      C('event_ids', 'string', '', '关联原始事件 id（| 分隔，可回连 events 表）'),
      C('note', 'string', '', 'Gate 原始备注'),
      C('annotated', 'boolean', '', '是否已填写注释'),
      C('motive', 'string', '', '动机（用户注释）'),
      C('take_profit', 'string', '', '止盈（用户注释，价格或百分比文本）'),
      C('stop_loss', 'string', '', '止损（用户注释）'),
      C('expectation', 'string', '', '预期（用户注释）'),
      C('tags', 'string', '', '标签（| 分隔）'),
      C('review_note', 'string', '', '复盘结论'),
      C('outcome', 'string', '', '结果：better/as_expected/worse/abandoned'),
    ],
  },
  operation_annotations: {
    title: '操作注释（当前状态）', grain: '一行 = 一条对 Gate 操作的注释（事件溯源折叠后）',
    columns: [
      C('operation_id', 'string', '', '关联操作 ID'),
      C('annotated_at_ms', 'integer', 'ms', '最近一次注释写入时间'),
      C('annotated_at_iso_utc', 'iso8601', 'UTC', '最近一次注释写入时间'),
      C('motive', 'string', '', '为什么做这笔操作'),
      C('take_profit', 'string', '', '止盈设置'),
      C('stop_loss', 'string', '', '止损设置'),
      C('expectation', 'string', '', '当时的预期'),
      C('tags', 'string', '', '标签（| 分隔）'),
      C('review_note', 'string', '', '事后复盘'),
      C('outcome', 'string', '', '结果'),
      C('reviewed_at_ms', 'integer', 'ms', '复盘时间'),
      C('source', 'string', '', 'manual'),
    ],
  },
  annotation_events: {
    title: '操作注释原始审计链（未折叠）', grain: '一行 = 一条 create/edit/review/delete 原始记录',
    columns: [
      C('seq', 'integer', 'count', '哈希链追加序号'),
      C('op_ts_ms', 'integer', 'ms', '写入时间'),
      C('op_ts_iso_utc', 'iso8601', 'UTC', '写入时间'),
      C('op', 'string', '', 'create/edit/review/delete'),
      C('record_id', 'string', '', '链上记录 ID'),
      C('operation_id', 'string', '', '关联操作 ID'),
      C('motive', 'string', '', '动机（如该记录携带）'),
      C('take_profit', 'string', '', '止盈'),
      C('stop_loss', 'string', '', '止损'),
      C('expectation', 'string', '', '预期'),
      C('tags', 'string', '', '标签（| 分隔）'),
      C('review_note', 'string', '', '复盘结论'),
      C('outcome', 'string', '', '结果'),
      C('reviewed_at_ms', 'integer', 'ms', '复盘时间'),
      C('note', 'string', '', '备注'),
      C('payload_json', 'string', 'json', '该条原始记录完整字段（保底不丢自定义字段）'),
      C('prev_hash', 'string', '', '前一条记录 hash'),
      C('hash', 'string', '', '本条记录 hash'),
    ],
  },
  metric_glossary: {
    title: '指标详解（来源 / 口径 / 走势含义）', grain: '一行 = 一个指标的定义',
    columns: [
      C('seq', 'integer', 'count', '序号'),
      C('group', 'string', '', '分组：asset/risk/attribution/cost/structure/quality/market'),
      C('group_name', 'string', '', '分组中文名'),
      C('name', 'string', '', '指标名'),
      C('field', 'string', '', '对应字段 / 表.列'),
      C('source', 'string', '', '数据来源（Gate 端点 / 事实表 / 计算来源）'),
      C('formula', 'string', '', '计算口径 / 公式'),
      C('meaning', 'string', '', '走势 / 数值意味着什么（如何解读）'),
      C('caveat', 'string', '', '注意事项 / 常见误读 / 适用边界'),
    ],
  },
  daily_reports: {
    title: '每日日报历史', grain: '一行 = 一份生成的日报（append-only 哈希链）',
    columns: [
      C('report_id', 'string', '', '日报 ID'),
      C('ts_ms', 'integer', 'ms', '生成时间'),
      C('ts_iso_utc', 'iso8601', 'UTC', '生成时间'),
      C('date', 'string', '', '日报日期（本地，YYYY-MM-DD）'),
      C('tz_label', 'string', '', '时区标签'),
      C('mode', 'string', '', 'mock/live'),
      C('trigger', 'string', '', '触发方式：scheduled/manual/cli/test'),
      C('headline', 'string', '', '一句话摘要'),
      C('window_reliable', 'boolean', '', '年化指标是否可靠（窗口≥7天）'),
      C('snapshot_count', 'integer', 'count', '统计快照数'),
      C('chunks', 'integer', 'count', '企业微信 markdown 分段数'),
      C('pushed', 'boolean', '', '是否尝试推送企业微信'),
      C('push_ok', 'boolean', '', '推送是否成功'),
      C('pushed_to', 'string', '', '推送目标（脱敏后的 webhook，绝不含密钥）'),
      C('push_message', 'string', '', '推送结果说明'),
      C('sent', 'integer', 'count', '成功发送条数'),
      C('failed', 'integer', 'count', '失败条数'),
      C('key_metrics_json', 'string', 'json', '关键指标快照（JSON）'),
      C('observations_json', 'string', 'json', '处置观察项（JSON）'),
      C('disclaimer', 'string', '', '免责声明'),
      C('markdown', 'string', '', '日报 markdown 全文'),
      C('seq', 'integer', 'count', '哈希链累加序号'),
      C('prev_hash', 'string', '', '前一条记录 hash'),
      C('hash', 'string', '', '本条记录 hash'),
    ],
  },
  // ---- v5: extended Gate read-only endpoints (low-frequency) ----
  enrichment: {
    title: '扩展行情聚合快照', grain: '一行 = 一次扩展采集周期',
    columns: [
      C('snapshot_id', 'string', '', '扩展快照 ID'),
      C('ts_ms', 'integer', 'ms', '采集时间戳（Unix 毫秒, UTC）'),
      C('ts_iso_utc', 'iso8601', 'UTC', '采集时间（ISO 8601, UTC）'),
      C('source', 'string', '', 'live / mock'),
      C('pairs', 'integer', 'count', '/spot/tickers 返回的有效交易对总数'),
      C('usdt_pairs', 'integer', 'count', '参与宽度统计的 USDT 计价交易对数'),
      C('advancers', 'integer', 'count', '24h 上涨家数'),
      C('decliners', 'integer', 'count', '24h 下跌家数'),
      C('unchanged', 'integer', 'count', '24h 平盘家数'),
      C('up_ratio_pct', 'number', 'percent', '上涨占比 0-100'),
      C('median_change_pct', 'number', 'percent', '全市场 24h 涨跌幅中位数'),
      C('mean_change_pct', 'number', 'percent', '全市场 24h 涨跌幅算术均值'),
      C('total_quote_volume_usd', 'number', 'USD', 'USDT 交易对 24h 成交额合计'),
      C('holdings_detail_count', 'integer', 'count', '本周期保留完整 ticker 明细的持仓币种数'),
      C('futures_count', 'integer', 'count', '采集的合约 ticker 数'),
      C('book_pairs', 'integer', 'count', '采集的盘口币对数'),
      C('open_orders', 'integer', 'count', '当前挂单数'),
      C('positions', 'integer', 'count', '当前合约持仓数'),
      C('margin_accounts', 'integer', 'count', '杠杆账户数'),
      C('notes', 'string', '', '可选端点失败备注（| 分隔，不影响顶部告警）'),
      C('payload_json', 'string', 'json', '子端点原始响应的有界副本（第三方可重放）'),
    ],
  },
  ticker_detail: {
    title: '持仓币种 Ticker 全字段明细', grain: '一行 = 一个周期 × 一个持仓交易对',
    columns: [
      C('snapshot_id', 'string', '', '扩展快照 ID'), C('ts_ms', 'integer', 'ms', '时间戳'),
      C('ts_iso_utc', 'iso8601', 'UTC', 'ISO 时间'), C('currency', 'string', '', '币种'),
      C('pair', 'string', '', '交易对'), C('last', 'number', 'USD', '最新成交价'),
      C('change_24h_pct', 'number', 'percent', '24h 涨跌幅'),
      C('high_24h', 'number', 'USD', '24h 最高'), C('low_24h', 'number', 'USD', '24h 最低'),
      C('amplitude_24h_pct', 'number', 'percent', '24h 振幅 = (高/低−1)×100'),
      C('base_volume', 'number', 'token', '24h 基础币成交量'),
      C('quote_volume_usd', 'number', 'USD', '24h 计价币成交额'),
      C('highest_bid', 'number', 'USD', '买一价'), C('lowest_ask', 'number', 'USD', '卖一价'),
      C('highest_size', 'number', 'token', '买一量'), C('lowest_size', 'number', 'token', '卖一量'),
      C('spread_pct', 'number', 'percent', '买卖价差 = (卖一/买一−1)×100'),
      C('etf', 'boolean', '', '该交易对是否含 ETF 字段'),
    ],
  },
  market_breadth: {
    title: '全市场宽度时间序列', grain: '一行 = 一次扩展采集周期',
    columns: [
      C('snapshot_id', 'string', '', '扩展快照 ID'), C('ts_ms', 'integer', 'ms', '时间戳'),
      C('ts_iso_utc', 'iso8601', 'UTC', 'ISO 时间'),
      C('usdt_pairs', 'integer', 'count', 'USDT 交易对数'),
      C('advancers', 'integer', 'count', '上涨家数'), C('decliners', 'integer', 'count', '下跌家数'),
      C('unchanged', 'integer', 'count', '平盘家数'),
      C('up_ratio_pct', 'number', 'percent', '上涨占比'), C('median_change_pct', 'number', 'percent', '中位涨跌'),
      C('mean_change_pct', 'number', 'percent', '平均涨跌'),
      C('total_quote_volume_usd', 'number', 'USD', '成交额合计'),
      C('top_gainers_json', 'string', 'json', '涨幅前 5'), C('top_losers_json', 'string', 'json', '跌幅前 5'),
      C('top_by_volume_json', 'string', 'json', '成交额前 5'),
    ],
  },
  fee_schedule: {
    title: '名义费率表', grain: '一行 = 一次扩展采集周期',
    columns: [
      C('snapshot_id', 'string', '', '扩展快照 ID'), C('ts_ms', 'integer', 'ms', '时间戳'),
      C('ts_iso_utc', 'iso8601', 'UTC', 'ISO 时间'), C('user_id', 'string', '', 'Gate 用户 ID'),
      C('taker_fee_pct', 'number', 'percent', '现货 taker 费率'), C('maker_fee_pct', 'number', 'percent', '现货 maker 费率'),
      C('futures_taker_fee_pct', 'number', 'percent', '合约 taker'), C('futures_maker_fee_pct', 'number', 'percent', '合约 maker'),
      C('delivery_taker_fee_pct', 'number', 'percent', '交割 taker'), C('delivery_maker_fee_pct', 'number', 'percent', '交割 maker'),
      C('gt_discount', 'boolean', '', '是否启用 GT 抵扣'), C('gt_taker_fee_pct', 'number', 'percent', 'GT 抵扣后 taker'),
      C('gt_maker_fee_pct', 'number', 'percent', 'GT 抵扣后 maker'),
      C('loan_fee_pct', 'number', 'percent', '借贷费率'), C('point_type', 'string', '', '点卡类型'),
      C('debit_fee', 'string', '', '借记费率'),
    ],
  },
  order_book_depth: {
    title: '盘口深度', grain: '一行 = 一个周期 × 一个交易对',
    columns: [
      C('snapshot_id', 'string', '', '扩展快照 ID'), C('ts_ms', 'integer', 'ms', '时间戳'),
      C('ts_iso_utc', 'iso8601', 'UTC', 'ISO 时间'), C('pair', 'string', '', '交易对'),
      C('best_bid', 'number', 'USD', '买一价'), C('best_ask', 'number', 'USD', '卖一价'),
      C('spread_pct', 'number', 'percent', '价差百分比'),
      C('bid_depth_usd', 'number', 'USD', '前 5 档买单金额'), C('ask_depth_usd', 'number', 'USD', '前 5 档卖单金额'),
      C('levels', 'integer', 'count', '有效档位数'),
    ],
  },
  futures_market: {
    title: '合约市场（资金费 / 基差 / 持仓量）', grain: '一行 = 一个周期 × 一个合约',
    columns: [
      C('snapshot_id', 'string', '', '扩展快照 ID'), C('ts_ms', 'integer', 'ms', '时间戳'),
      C('ts_iso_utc', 'iso8601', 'UTC', 'ISO 时间'), C('contract', 'string', '', '合约'),
      C('last', 'number', 'USD', '最新价'), C('mark_price', 'number', 'USD', '标记价'),
      C('index_price', 'number', 'USD', '指数价'),
      C('funding_rate_pct', 'number', 'percent', '当期资金费率'),
      C('funding_rate_indicative_pct', 'number', 'percent', '预测资金费率'),
      C('funding_annualised_pct', 'number', 'percent', '资金费率×3×365 粗略年化'),
      C('open_interest', 'number', 'contract', '未平仓合约张数'),
      C('volume_24h_quote', 'number', 'USD', '24h 成交额'),
      C('high_24h', 'number', 'USD', '24h 高'), C('low_24h', 'number', 'USD', '24h 低'),
      C('change_24h_pct', 'number', 'percent', '24h 涨跌'), C('basis_pct', 'number', 'percent', '标记/指数基差'),
    ],
  },
  account_state: {
    title: '账户状态（挂单 / 持仓 / 杠杆）', grain: '一行 = 一个周期 × 一条账户记录',
    columns: [
      C('snapshot_id', 'string', '', '扩展快照 ID'), C('ts_ms', 'integer', 'ms', '时间戳'),
      C('ts_iso_utc', 'iso8601', 'UTC', 'ISO 时间'),
      C('kind', 'string', '', 'open_order / position / margin'), C('key', 'string', '', '交易对或合约'),
      C('count', 'number', 'count', '数量（挂单数 / 持仓张数）'), C('risk', 'string', '', '杠杆账户风险率'),
      C('leverage', 'string', '', '杠杆倍数'), C('liq_price', 'number', 'USD', '强平价'),
      C('mark_price', 'number', 'USD', '标记价'), C('unrealised_pnl', 'number', 'USD', '未实现盈亏'),
      C('borrowed', 'number', 'token', '已借数量/金额'), C('sides', 'string', '', '方向 / 模式'),
    ],
  },
  capital_usage: {
    title: '资金利用率', grain: '一行 = 一次扩展采集周期',
    columns: [
      C('snapshot_id', 'string', '', '扩展快照 ID'), C('ts_ms', 'integer', 'ms', '时间戳'),
      C('ts_iso_utc', 'iso8601', 'UTC', 'ISO 时间'),
      C('total_usd', 'number', 'USD', '总资产'), C('borrowed_usd', 'number', 'USD', '借款合计'),
      C('unrealised_pnl_usd', 'number', 'USD', '未实现盈亏合计'),
      C('borrowed_to_total_pct', 'number', 'percent', '借款/总资产'),
      C('unrealised_to_total_pct', 'number', 'percent', '未实现盈亏/总资产'),
      C('available_qty', 'number', 'token', '可用数量合计（跨币种仅作参考）'),
      C('locked_qty', 'number', 'token', '冻结数量合计（跨币种仅作参考）'),
      C('locked_share_pct', 'number', 'percent', '冻结占比（按估值加权）'),
    ],
  },
  deposit_chains: {
    title: '充提链分布', grain: '一行 = 一条链',
    columns: [
      C('chain', 'string', '', '链名（从事件备注解析，UNKNOWN=未标注）'),
      C('deposits', 'integer', 'count', '充值笔数'), C('withdraws', 'integer', 'count', '提现笔数'),
      C('count', 'integer', 'count', '总笔数'), C('volume_usd', 'number', 'USD', '现金流绝对额合计'),
      C('avg_usd', 'number', 'USD', '单笔均值'), C('last_ts_ms', 'integer', 'ms', '最近一笔时间戳'),
      C('last_iso_utc', 'iso8601', 'UTC', '最近一笔 ISO 时间'),
    ],
  },
  fx_rates: {
    title: 'USD/CNY 参考汇率', grain: '一行 = 一次汇率采样（当前值，展示换算用）',
    columns: [
      C('ts_ms', 'integer', 'ms', '本次汇率抓取时间'),
      C('ts_iso_utc', 'iso8601', 'UTC', '本次汇率抓取时间'),
      C('base_currency', 'string', '', '基准币种：USD'),
      C('quote_currency', 'string', '', '目标币种：CNY'),
      C('usd_to_cny', 'number', 'CNY/USD', '1 USD 可兑换的 CNY 数量'),
      C('provider', 'string', '', '公开汇率来源'),
      C('source_time_ms', 'integer', 'ms', '数据源公布的报价时间'),
      C('source_time_iso_utc', 'iso8601', 'UTC', '数据源公布的报价时间'),
      C('stale', 'boolean', '', 'true=来自缓存且未能刷新'),
      C('note', 'string', '', '口径说明：仅展示换算，事实层与分析指标仍为 USD'),
    ],
  },
  dictionary: {
    title: '数据字典', grain: '一行 = 一个数据集的一个字段',
    columns: [
      C('dataset', 'string', '', '数据集名'),
      C('column', 'string', '', '字段名'),
      C('type', 'string', '', '类型：string/integer/number/boolean/iso8601'),
      C('unit', 'string', '', '单位'),
      C('description', 'string', '', '字段定义与口径'),
    ],
  },
};

const DATASET_ORDER = ['snapshots', 'holdings', 'accounts', 'events', 'prices', 'decisions', 'decision_events',
  'market', 'macro_events', 'macro_event_log', 'benchmark_comparison', 'relative_metrics', 'event_windows',
  'cashflows', 'nav', 'attribution', 'attribution_agg', 'distribution', 'metrics',
  'operations', 'operation_annotations', 'annotation_events', 'metric_glossary', 'daily_reports',
  'enrichment', 'ticker_detail', 'market_breadth', 'fee_schedule', 'order_book_depth',
  'futures_market', 'account_state', 'capital_usage', 'deposit_chains',
  'fx_rates', 'dictionary'];

// v5 tables are rebuilt straight from the raw enrichment.jsonl chain, so the
// offline CLI and any third party can reproduce them without trusting our
// derived analysis object.
const ENRICH_TABLES = ['enrichment', 'ticker_detail', 'market_breadth', 'fee_schedule',
  'order_book_depth', 'futures_market', 'account_state', 'capital_usage', 'deposit_chains'];

/* ------------------------------ serialisers ------------------------------ */

function esc(v) {
  if (v === null || v === undefined) return '';
  let s;
  if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(columns, rows) {
  const head = columns.join(',');
  const lines = [head];
  for (const row of rows) lines.push(columns.map(c => esc(row[c])).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';   // BOM + CRLF for Excel
}
function toJsonl(rows) { return rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''); }
function toJson(rows, meta) {
  return JSON.stringify(meta ? Object.assign({}, meta, { row_count: rows.length, rows }) : rows, null, 2);
}
const iso = (ts) => Number.isFinite(Number(ts)) ? new Date(Number(ts)).toISOString() : '';

/* ------------------------------ table builders --------------------------- */

function buildTables(input) {
  const { snapshots = [], events = [], prices = [], decisions = [], decisionEvents = [],
    market = [], macroEvents = [], macroEventLog = [], analysis = {}, integrity = {},
    annotations = [], annotationEvents = [], reports = [], enrichment = [], latestSnapshot = null } = input;
  const T = {};
  const put = (name, rows) => { T[name] = { columns: SCHEMA[name].columns.map(c => c.name), rows }; };
  const joinTags = (t) => Array.isArray(t) ? t.join(' | ') : (t || '');
  // Build the operations view from the SAME event set feeding analytics, then
  // attach folded annotations so the exported table is self-contained.
  const opsRaw = input.operations && input.operations.length
    ? input.operations
    : operations.buildOperations(events, { limit: 200000 });
  const annMap = new Map((annotations || []).map(a => [a.operationId, a]));

  // snapshots
  put('snapshots', snapshots.map(s => {
    const spot = (s.holdings || []).reduce((a, h) => a + (Number(h.valueUsd) || 0), 0);
    return {
      ts_ms: s.ts, ts_iso_utc: iso(s.ts), mode: s.mode || '', quote_currency: s.totalCurrency || '',
      total_usd: s.totalUsd, spot_usd: Math.round(spot * 100) / 100,
      other_accounts_usd: Math.round(((Number(s.totalUsd) || 0) - spot) * 100) / 100,
      accounts_count: (s.accounts || []).length, holdings_count: (s.holdings || []).length,
      has_notes: (s.notes || []).length > 0, notes: (s.notes || []).join(' | '),
    };
  }));

  // holdings
  const holdRows = [];
  for (const s of snapshots) {
    const tot = (s.holdings || []).reduce((a, h) => a + (Number(h.valueUsd) || 0), 0) || 1;
    for (const h of (s.holdings || [])) {
      const v = Number(h.valueUsd) || 0, q = Number(h.amount) || 0;
      holdRows.push({
        ts_ms: s.ts, ts_iso_utc: iso(s.ts), currency: h.currency, venue: h.venue || 'spot',
        qty: q, available: h.available, locked: h.locked,
        price_usd_implied: q > 0 ? Math.round(v / q * 1e8) / 1e8 : (h.priceUsd || null),
        value_usd: v, weight_pct: Math.round(v / tot * 1e6) / 1e4,
      });
    }
  }
  put('holdings', holdRows);

  // accounts
  const accRows = [];
  for (const s of snapshots) {
    const tot = (s.accounts || []).reduce((a, x) => a + (Number(x.amount) || 0), 0) || 1;
    for (const a of (s.accounts || [])) accRows.push({
      ts_ms: s.ts, ts_iso_utc: iso(s.ts), account_id: a.id, account_label: a.label,
      amount_usd: a.amount, currency: a.currency || '', borrowed_usd: a.borrowed || 0,
      unrealised_pnl_usd: a.unrealisedPnl || 0,
      weight_pct: Math.round((Number(a.amount) || 0) / tot * 1e6) / 1e4,
    });
  }
  put('accounts', accRows);

  // events
  put('events', events.map(e => ({
    event_id: e.id, seq: e.seq, ts_ms: e.ts, ts_iso_utc: iso(e.ts), type: e.type,
    currency: e.currency, amount: e.amount, amount_usd: e.amountUsd, price_usd: e.priceUsd,
    fee_amount: e.feeAmount, fee_currency: e.feeCurrency, fee_usd: e.feeUsd,
    side: e.side, role: e.role, venue: e.venue, account: e.account, pair: e.pair,
    ref_id: e.refId, is_cashflow: e.isCashflow, cashflow_usd: e.cashflowUsd,
    is_realized: e.isRealized, source: e.source, note: e.note,
    prev_hash: e.prevHash, hash: e.hash,
  })));

  // prices
  put('prices', prices.map(p => ({
    price_id: p.id, seq: p.seq, ts_ms: p.ts, ts_iso_utc: iso(p.ts), currency: p.currency,
    price_usd: p.priceUsd, quote: p.quote, source: p.source, prev_hash: p.prevHash, hash: p.hash,
  })));

  // decisions
  put('decisions', decisions.map(d => ({
    decision_id: d.decisionId || d.id, decided_at_ms: d.decidedAt || d.ts,
    decided_at_iso_utc: iso(d.decidedAt || d.ts), action: d.action, symbol: d.symbol,
    amount: d.amount, price_usd: d.priceUsd, value_usd: d.valueUsd,
    reason: d.reason, expectation: d.expectation,
    tags: Array.isArray(d.tags) ? d.tags.join(' | ') : (d.tags || ''),
    review_note: d.reviewNote || '', outcome: d.outcome || '',
    reviewed_at_ms: d.reviewedAt || null, source: d.source || 'manual', note: d.note || '',
  })));

  // decision_events — RAW unfolded audit trail (create/edit/review/delete),
  // distinct from `decisions` which is the folded current state. This is what
  // makes "every piece of data" unambiguously exportable.
  put('decision_events', (decisionEvents || []).map(r => ({
    seq: r.seq, op_ts_ms: r.ts, op_ts_iso_utc: iso(r.ts),
    op: r.op || '', record_id: r.id || '', decision_id: r.decisionId || '',
    decided_at_ms: r.decidedAt || null,
    action: r.action || '', symbol: r.symbol || '',
    amount: r.amount, price_usd: r.priceUsd, value_usd: r.valueUsd,
    reason: r.reason || '', expectation: r.expectation || '',
    tags: Array.isArray(r.tags) ? r.tags.join(' | ') : (r.tags || ''),
    review_note: r.reviewNote || '', outcome: r.outcome || '', reviewed_at_ms: r.reviewedAt || null,
    payload_json: JSON.stringify(r), source: r.source || 'manual',
    prev_hash: r.prevHash || '', hash: r.hash || '',
  })));

  // ---- market context (6 new tables) ----
  put('market', market.map(p => ({
    ts_ms: p.ts, ts_iso_utc: iso(p.ts), symbol: p.symbol, quote: p.quote,
    open: p.open, high: p.high, low: p.low, close: p.close,
    base_volume: p.baseVolume, quote_volume: p.quoteVolume,
    interval_sec: p.intervalSec, window_closed: p.windowClosed, source: p.source,
    seq: p.seq, prev_hash: p.prevHash, hash: p.hash,
  })));
  put('macro_events', macroEvents.map(e => ({
    event_id: e.eventId || e.id, event_ts_ms: e.ts || e.eventTs,
    event_iso_utc: iso(e.ts || e.eventTs), category: e.category, title: e.title,
    summary: e.summary, impact: e.impact,
    symbols: Array.isArray(e.symbols) ? e.symbols.join('|') : (e.symbols || ''),
    source: e.source, url: e.url || '', note: e.note || '',
  })));
  put('macro_event_log', macroEventLog.map(x => ({
    seq: x.seq, op_ts_ms: x.ts, op_ts_iso_utc: iso(x.ts), op: x.op || 'create',
    record_id: x.id || '', event_id: x.eventId || '', event_ts_ms: x.eventTs || null,
    category: x.category || '', title: x.title || '', summary: x.summary || '',
    impact: x.impact || '', symbols: Array.isArray(x.symbols) ? x.symbols.join('|') : (x.symbols || ''),
    source: x.source || '', payload_json: JSON.stringify(x),
    prev_hash: x.prevHash || '', hash: x.hash || '',
  })));
  const mk = analysis.market || {};
  put('benchmark_comparison', (mk.comparisonRows || []).map(x => ({
    ts_ms: x.ts_ms, ts_iso_utc: x.ts_iso_utc, series: x.series,
    series_kind: x.series_kind, value: x.value, normalized_value: x.normalized_value, unit: x.unit,
  })));
  put('relative_metrics', (mk.relativeRows || []).map(x => ({
    series: x.series, series_kind: x.series_kind, from_ts_ms: x.from_ts_ms, to_ts_ms: x.to_ts_ms,
    nav_pct: x.nav_pct, series_pct: x.series_pct, excess_pct: x.excess_pct,
    beta_adjusted_excess_pct: x.beta_adjusted_excess_pct, beta: x.beta,
    correlation: x.correlation, r_squared: x.r_squared,
    tracking_error_pct: x.tracking_error_pct, up_capture: x.up_capture,
    down_capture: x.down_capture, sample_periods: x.sample_periods, outperformed: x.outperformed,
  })));
  put('event_windows', (mk.eventRows || []).map(x => ({
    event_id: x.event_id, event_ts_ms: x.event_ts_ms, event_iso_utc: x.event_iso_utc,
    category: x.category, title: x.title, impact: x.impact, source: x.source, symbols: x.symbols,
    window_from_ms: x.window_from_ms, window_to_ms: x.window_to_ms,
    series: x.series, series_kind: x.series_kind,
    window_pct: x.window_pct, excess_vs_nav_pct: x.excess_vs_nav_pct,
    cashflow_usd: x.cashflow_usd, trade_legs: x.trade_legs, fee_usd: x.fee_usd, decisions: x.decisions,
    dominant_holding: x.dominant_holding, dominant_weight_pct: x.dominant_weight_pct,
    top_drag_currency: x.top_drag_currency, top_drag_usd: x.top_drag_usd,
    top_lift_currency: x.top_lift_currency, top_lift_usd: x.top_lift_usd, reason: x.reason,
  })));

  // cashflows
  put('cashflows', (analysis.cashflows || []).map(c => ({
    ts_ms: c.ts, ts_iso_utc: c.iso || iso(c.ts), type: c.type, currency: c.currency,
    amount: c.amount, cashflow_usd: c.cashflowUsd, note: c.note, source: c.source,
  })));

  // nav
  put('nav', (analysis.nav || []).map(v => ({
    ts_ms: v.ts, ts_iso_utc: v.timestamp_iso, total_usd: v.totalUsd, cashflow_usd: v.cashflowUsd,
    net_asset_usd: v.netAssetUsd, units: v.units, nav_per_unit: v.navPerUnit,
    period_return: v.periodReturn, twr: v.twr, drawdown: v.drawdown,
    benchmark_price: v.benchmarkPrice, mode: v.mode,
  })));

  // attribution
  put('attribution', (analysis.attribution || []).map(x => ({
    from_ts_ms: x.fromTs, to_ts_ms: x.toTs, from_iso_utc: x.fromIso, to_iso_utc: x.toIso,
    currency: x.currency, qty0: x.qty0, qty1: x.qty1, price0: x.price0, price1: x.price1,
    value0_usd: x.value0, value1_usd: x.value1,
    price_effect_usd: x.priceEffect, qty_effect_usd: x.qtyEffect, cross_effect_usd: x.crossEffect,
    delta_value_usd: x.deltaValueUsd, contribution_pct: x.contributionPct,
    price_change_pct: x.priceChangePct, qty_change_pct: x.qtyChangePct,
    trade_driven_qty: x.tradeDrivenQty, flow_driven_qty: x.flowDrivenQty, is_residual: x.isResidual,
  })));

  // attribution_agg
  put('attribution_agg', (analysis.attributionAgg || []).map(x => ({
    currency: x.currency, intervals: x.intervals, price_effect_usd: x.priceEffect,
    qty_effect_usd: x.qtyEffect, cross_effect_usd: x.crossEffect,
    delta_value_usd: x.deltaValueUsd, contribution_pct: x.contributionPct,
  })));

  // distribution
  put('distribution', (analysis.distribution || []).map(x => ({
    account_id: x.accountId, label: x.label, first_amount_usd: x.firstAmountUsd,
    last_amount_usd: x.lastAmountUsd, change_usd: x.changeUsd,
    change_pct: x.changePct, last_weight_pct: x.lastWeightPct,
  })));

  // ---- operations + annotations (Gate 真实操作 + 用户注释) ----
  put('operations', opsRaw.map(o => {
    const an = annMap.get(o.id) || o.annotation || null;
    return {
      operation_id: o.id, ts_ms: o.ts, ts_iso_utc: iso(o.ts),
      kind: o.kind, kind_label: o.kindLabel, raw_type: o.rawType || '',
      side: o.side, symbol: o.symbol, pair: o.pair,
      amount: o.amount, price_usd: o.priceUsd, value_usd: o.valueUsd, fee_usd: o.feeUsd,
      fee_currency: o.feeCurrency, venue: o.venue, is_cashflow: o.isCashflow,
      cashflow_usd: o.cashflowUsd, source: o.source, leg_count: o.legCount,
      event_ids: (o.eventIds || []).join(' | '), note: o.note, annotated: !!an,
      motive: an ? an.motive : '', take_profit: an ? an.takeProfit : '',
      stop_loss: an ? an.stopLoss : '', expectation: an ? an.expectation : '',
      tags: an ? joinTags(an.tags) : '', review_note: an ? an.reviewNote : '',
      outcome: an ? an.outcome : '',
    };
  }));
  put('operation_annotations', (annotations || []).map(a => ({
    operation_id: a.operationId, annotated_at_ms: a.annotatedAt || null,
    annotated_at_iso_utc: iso(a.annotatedAt), motive: a.motive,
    take_profit: a.takeProfit, stop_loss: a.stopLoss, expectation: a.expectation,
    tags: joinTags(a.tags), review_note: a.reviewNote, outcome: a.outcome,
    reviewed_at_ms: a.reviewedAt || null, source: a.source || 'manual',
  })));
  put('annotation_events', (annotationEvents || []).map(r => ({
    seq: r.seq, op_ts_ms: r.ts, op_ts_iso_utc: iso(r.ts), op: r.op || '',
    record_id: r.id || '', operation_id: r.operationId || '',
    motive: r.motive || '', take_profit: r.takeProfit || '', stop_loss: r.stopLoss || '',
    expectation: r.expectation || '', tags: joinTags(r.tags),
    review_note: r.reviewNote || '', outcome: r.outcome || '',
    reviewed_at_ms: r.reviewedAt || null, note: r.note || '',
    payload_json: JSON.stringify(r), prev_hash: r.prevHash || '', hash: r.hash || '',
  })));

  // ---- metric glossary (static documentation, single source of truth) ----
  put('metric_glossary', metricGlossary.rows().map(x => ({
    seq: x.seq, group: x.group, group_name: x.group_name, name: x.name,
    field: x.field, source: x.source, formula: x.formula,
    meaning: x.meaning, caveat: x.caveat,
  })));

  // ---- daily report history ----
  put('daily_reports', (reports || []).map(x => ({
    report_id: x.id, ts_ms: x.ts, ts_iso_utc: iso(x.ts), date: x.date,
    tz_label: x.tzLabel, mode: x.mode, trigger: x.trigger, headline: x.headline,
    window_reliable: x.windowReliable, snapshot_count: x.snapshotCount, chunks: x.chunks,
    pushed: x.pushed, push_ok: x.pushOk, pushed_to: x.pushedTo || '',
    push_message: x.pushMessage || '', sent: x.sent, failed: x.failed,
    key_metrics_json: JSON.stringify(x.keyMetrics || {}),
    observations_json: JSON.stringify(x.observations || []),
    disclaimer: x.disclaimer || '', markdown: x.markdown || '',
    seq: x.seq, prev_hash: x.prevHash || '', hash: x.hash || '',
  })));

  // v5: extended read-only endpoints, rebuilt from the append-only chain.
  const enrT = enrichAnalytics.buildTables(enrichment);
  enrT.deposit_chains = enrichAnalytics.buildChains(events);
  for (const name of ENRICH_TABLES) put(name, enrT[name] || []);

  // ---- USD/CNY reference rate (current snapshot, display conversion only) ----
  const fxRec = input.fx || {};
  put('fx_rates', fxRec.rate ? [{
    ts_ms: fxRec.fetchedMs || null, ts_iso_utc: iso(fxRec.fetchedMs),
    base_currency: fxRec.base || 'USD', quote_currency: fxRec.quote || 'CNY',
    usd_to_cny: fxRec.rate, provider: fxRec.provider || '',
    source_time_ms: fxRec.sourceTimeMs || null, source_time_iso_utc: fxRec.sourceTimeIso || '',
    stale: !!fxRec.stale,
    note: '仅用于界面单位换算；事实层与所有分析指标仍以 USD 存储与计算',
  }] : []);

  // dictionary (generated from SCHEMA, single source of truth)
  const dictRows = [];
  for (const name of DATASET_ORDER) for (const c of SCHEMA[name].columns) {
    dictRows.push({ dataset: name, column: c.name, type: c.type, unit: c.unit, description: c.desc });
  }
  put('dictionary', dictRows);

  // metrics (kv long table)
  const from = analysis.meta?.from || '', to = analysis.meta?.to || '';
  const metricRows = [];
  const unitOf = (k) => /_pct$|Pct$/.test(k) ? 'percent' : /_usd$|Usd$/.test(k) ? 'USD' :
    /return|twr|ratio|beta|correlation|drawdown|volatility|sharpe|sortino|calmar|hhi|nav/i.test(k) ? 'ratio' :
      /count|total|legs|samples|intervals|days/i.test(k) ? 'count' : '';
  const flatten = (category, obj, note = '') => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) { metricRows.push({ category, metric: k, value: '', unit: unitOf(k), window_from: from, window_to: to, note }); continue; }
      if (typeof v === 'object') { metricRows.push({ category, metric: k, value: JSON.stringify(v), unit: 'json', window_from: from, window_to: to, note }); continue; }
      metricRows.push({ category, metric: k, value: String(v), unit: unitOf(k), window_from: from, window_to: to, note });
    }
  };
  flatten('summary', analysis.summary);
  flatten('risk', analysis.risk);
  flatten('benchmark', analysis.benchmarks);
  flatten('cost', analysis.costs);
  flatten('behavior', analysis.behavior);
  flatten('concentration', analysis.concentration);
  flatten('quality', analysis.quality);
  flatten('market', analysis.market && analysis.market.metrics && analysis.market.metrics.summary, '资产 vs 主流币相对表现');
  flatten('enrichment', analysis.enrichment && analysis.enrichment.summary, '扩展 API 数据关键摘要');
  flatten('integrity', integrity, 'append-only 哈希链校验');
  put('metrics', metricRows);

  return T;
}

/* ------------------------------- serialise -------------------------------- */

/** Serialise one dataset. Returns { body, contentType, ext }. */
function serialise(name, T, format) {
  const t = T[name];
  if (!t) return null;
  const meta = { dataset: name, title: SCHEMA[name].title, grain: SCHEMA[name].grain,
    columns: t.columns, exported_at: new Date().toISOString(), mode: config.mode };
  if (format === 'jsonl') return { body: toJsonl(t.rows), contentType: 'application/x-ndjson; charset=utf-8', ext: 'jsonl' };
  if (format === 'json') return { body: toJson(t.rows, meta), contentType: 'application/json; charset=utf-8', ext: 'json' };
  return { body: toCsv(t.columns, t.rows), contentType: 'text/csv; charset=utf-8', ext: 'csv' };
}

function readmeText(T, analysis, integrity) {
  const L = [];
  L.push('Gate Asset Monitor — 全量数据导出包');
  L.push('========================================');
  L.push('');
  L.push(`生成时间 (UTC): ${new Date().toISOString()}`);
  L.push(`数据模式      : ${config.mode}${config.mode === 'mock' ? '  *** DEMO 模拟数据，非真实资产 ***' : '  (Gate.io API v4)'}`);
  L.push(`统计窗口      : ${analysis.meta?.from || '-'}  →  ${analysis.meta?.to || '-'}`);
  L.push(`快照 / 事件 / 价格 / 决策 : ${analysis.meta?.snapshotCount || 0} / ${analysis.meta?.eventCount || 0} / ${analysis.meta?.priceCount || 0} / ${analysis.meta?.decisionCount || 0}`);
  L.push('');
  L.push('【文件清单】');
  for (const name of DATASET_ORDER) {
    const t = T[name];
    L.push(`  ${name}.csv / .jsonl   ${SCHEMA[name].title}  (${t.rows.length} 行, ${t.columns.length} 列)`);
    L.push(`      粒度: ${SCHEMA[name].grain}`);
  }
  L.push('  dictionary.csv / .json   每个字段的类型、单位、口径定义');
  L.push('  analytics.json           完整分析结果（含所有中间量）');
  L.push('  manifest.json            数据集清单、口径约定、完整性校验');
  L.push('  raw/*.jsonl             九个 append-only 原始文件的字节级副本（可独立重放哈希链）');
  L.push('  enrichment / ticker_detail / market_breadth / fee_schedule / order_book_depth /');
  L.push('  futures_market / account_state / capital_usage / deposit_chains：');
  L.push('                          扩展只读端点（全市场宽度、持仓 ticker 全字段、名义费率、盘口深度、');
  L.push('                          合约资金费/基差、挂单持仓杠杆、资金利用率、充提链分布）。');
  L.push('                          低频采集，错误隔离；长尾数据不占看板醒目位置，完整数据都在这些表里。');
  L.push('  market / macro_events / benchmark_comparison / relative_metrics / event_windows：');
  L.push('                          主流币基准行情、大环境事件、资产与 BTC/ETH 对比及原因分析');
  L.push('  operations / operation_annotations / annotation_events：');
  L.push('                          Gate 真实操作记录（只读同步）+ 用户填写的动机/止盈止损/复盘 + 原始注释审计链');
  L.push('  metric_glossary         每个指标的数据来源、计算口径、走势含义、注意事项');
  L.push('  daily_reports           每日日报历史（含 markdown 全文与推送结果，webhook 已脱敏）');
  L.push('');
  L.push('【口径约定】');
  for (const [k, v] of Object.entries(analysis.meta?.conventions || {})) L.push(`  ${k}: ${v}`);
  L.push('');
  L.push('【给第三方分析工具】');
  L.push('  - CSV 为 UTF-8 with BOM、CRLF 换行，Excel / pandas / Power BI 可直接打开。');
  L.push('  - JSONL 每行一个 JSON 对象，适合流式读取（pandas: pd.read_json(path, lines=True)）。');
  L.push('  - 时间统一 UTC：ts_ms 为 Unix 毫秒，ts_iso_utc 为 ISO 8601。');
  L.push('  - 金额单位为 USD，*_pct 为 0-100 的百分数，ratio 类为小数。');
  L.push('  - 空单元格 / null 表示不可计算或缺失，不代表 0。');
  L.push('  - 主键建议：snapshots(ts_ms)、holdings(ts_ms,currency)、events(event_id)、attribution(from_ts_ms,to_ts_ms,currency)、');
  L.push('              benchmark_comparison(ts_ms,series)、event_windows(event_id,series)、market(ts_ms,symbol)。');
  L.push('  - 归因恒等式：Σ逐币种 delta_value_usd + __RESIDUAL__ = 该区间总资产变动。');
  L.push('  - 数量效应(qty_effect_usd)代表加减仓，不是投资收益；比较策略表现请用 nav.twr。');
  L.push('  - 对比图请用 benchmark_comparison.normalized_value（各序列起点=100）；relative_metrics 的');
  L.push('    excess_pct 为百分点算术差，非几何超额；beta 用基准发生变化的有效周期回归。');
  L.push('  - 事件来源为人工标注 / 行情异动自动检测 / DEMO 模拟，非实时新闻源，请勿当作新闻事实。');
  L.push('  - operations.operation_id 是注释外键：join operation_annotations 取动机/止盈止损/复盘；');
  L.push('    operations.event_ids 可回连 events 表核对 Gate 原始流水。');
  L.push('  - metric_glossary 是口径说明文档，不是数值数据；daily_reports.pushed_to 为脱敏 webhook。');
  L.push('');
  L.push('【完整性与免责】');
  L.push(`  append-only 哈希链: ${JSON.stringify(integrity || {})}`);
  L.push('  本导出仅用于个人资产记录与分析，不构成投资建议。mock 模式为确定性模拟数据。');
  L.push('  敏感财务数据，请仅在可信环境（Tailscale 私网）内保存与传输，勿上传第三方分析服务。');
  L.push('');
  return L.join('\r\n');
}

/**
 * Build the full ZIP. Returns { buffer, filename, manifest }.
 */
/**
 * Assemble the ZIP entries without materialising the archive. The HTTP route
 * streams these into the response; the offline CLI uses buildBundle() below.
 */
function buildBundleEntries(input) {
  const T = buildTables(input);
  const analysis = input.analysis || {};
  const integrity = input.integrity || {};
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = `gate-assets-${stamp}`;
  const entries = [];
  const manifest = {
    generated_at: new Date().toISOString(),
    mode: config.mode, demo: config.mode === 'mock',
    disclaimer: config.mode === 'mock' ? 'DEMO / 模拟数据，非真实资产' : '来自 Gate.io API v4',
    window: { from: analysis.meta?.from || null, to: analysis.meta?.to || null },
    conventions: analysis.meta?.conventions || {},
    integrity,
    datasets: [],
    raw_files: (input.rawFiles || []).map(r => r.name),
  };
  for (const name of DATASET_ORDER) {
    const t = T[name];
    entries.push({ name: `${prefix}/${name}.csv`, data: toCsv(t.columns, t.rows) });
    entries.push({ name: `${prefix}/${name}.jsonl`, data: toJsonl(t.rows) });
    manifest.datasets.push({ name, title: SCHEMA[name].title, grain: SCHEMA[name].grain,
      rows: t.rows.length, columns: t.columns.length, column_list: t.columns });
  }
  for (const rf of (input.rawFiles || [])) entries.push({ name: `${prefix}/raw/${rf.name}`, data: rf.data });
  entries.push({ name: `${prefix}/analytics.json`, data: JSON.stringify(analysis, null, 2) });
  entries.push({ name: `${prefix}/manifest.json`, data: JSON.stringify(manifest, null, 2) });
  entries.push({ name: `${prefix}/README.txt`, data: readmeText(T, analysis, integrity) });
  return { entries, manifest, tables: T, prefix };
}

function buildBundle(input) {
  const { entries, manifest, tables, prefix } = buildBundleEntries(input);
  return { buffer: zip.build(entries), filename: `${prefix}.zip`, manifest, tables };
}

function datasetCatalog(T) {
  return DATASET_ORDER.map(name => ({
    name, title: SCHEMA[name].title, grain: SCHEMA[name].grain,
    rows: T[name].rows.length, columns: T[name].columns.length,
    column_list: T[name].columns,
  }));
}

module.exports = {
  SCHEMA, DATASET_ORDER, buildTables, serialise, buildBundleEntries, buildBundle, datasetCatalog,
  toCsv, toJsonl, toJson, iso,
};
