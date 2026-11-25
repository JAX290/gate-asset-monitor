'use strict';

/**
 * Metric glossary — PURE DATA, zero dependencies.
 *
 * Human-facing explanation of every metric shown on the "资产分析" page and
 * exported. Each entry states:
 *   name      显示名
 *   field     对应字段 / 表.列（第三方分析时的定位）
 *   source    数据来源（哪个 Gate 只读端点 / 哪张事实表 / 怎么算出来）
 *   formula   计算口径
 *   meaning   走势 / 数值「意味着什么」—— 该怎么读、方向代表什么
 *   caveat    注意事项 / 常见误读 / 适用边界
 *
 * This is the single source of truth for:
 *   - /api/metric-glossary (front-end "指标详解" panel)
 *   - the `metric_glossary` export table
 *   - docs/METRICS.md (mirrored in prose)
 * It deliberately contains NO live values — it is documentation, not data.
 */

const GROUPS = [
  { key: 'asset', name: '资产与收益', desc: '我到底有多少钱、真实赚了多少' },
  { key: 'risk', name: '风险指标', desc: '为了这些收益承担了多大波动与回撤' },
  { key: 'attribution', name: '归因分解', desc: '资产变动是市场给的，还是自己搬进来的' },
  { key: 'cost', name: '成本与行为', desc: '摩擦成本与操作习惯有没有吃掉收益' },
  { key: 'structure', name: '持仓结构', desc: '仓位是否集中、现金类占比、账户迁移' },
  { key: 'quality', name: '数据质量', desc: '这份分析本身可不可信' },
  { key: 'market', name: '市场对比', desc: '相对 BTC/ETH 等主流币跑赢还是跑输、为什么' },
  { key: 'enrich', name: '扩展行情数据', desc: '全市场宽度、流动性、费率、资金利用率等长尾数据（折叠展示）' },
];

const ITEMS = [
  // ---------------- 资产与收益 ----------------
  {
    group: 'asset', name: '总资产估值', field: 'snapshots.total_usd / summary.totalUsd',
    source: 'Gate 只读端点 GET /wallet/total_balance 的 total（USD 口径），辅以 /spot/accounts、/futures/{settle}/accounts 汇总校验；每个采集时点写入 snapshots.jsonl',
    formula: '各账户估值合计，折算为 USD；每 SNAPSHOT_INTERVAL_SEC（默认 300s）采一次快照',
    meaning: '曲线整体向上=账户在增值，向下=缩水。但注意：一次大额充值/提现会让曲线瞬间跳一个台阶，这不是涨跌。所以要配合下面的 TWR 与净现金流一起看，不要把台阶当行情。',
    caveat: '这是「含出入金」的名义金额，不等于投资收益。比较策略好坏请用 TWR，不要用总资产涨幅。合约未开通时该账户取不到，会少一块。',
  },
  {
    group: 'asset', name: '总资产涨幅', field: 'summary.rawChangePct / risk.rawChangePct',
    source: '由首末两个快照的 total_usd 直接相除得到',
    formula: '末快照 total_usd / 首快照 total_usd − 1',
    meaning: '反映账户名义规模变化。若明显高于 TWR，多半是期间有净充值把规模抬大了；若低于 TWR，可能是净提现。二者背离本身就是「有资金进出」的信号。',
    caveat: '仅作对照，不是收益口径，任何情况下都不要拿它评价操作水平。',
  },
  {
    group: 'asset', name: '时间加权收益 TWR', field: 'nav.twr / summary.twrPct',
    source: '由 snapshots（市值）+ events 中 is_cashflow=true 的充提事件共同计算，逐快照构造单位净值序列',
    formula: 'r_i=(V_i−CF_i)/V_{i−1}−1；TWR=Π(1+r_i)−1=单位净值末值−1。期末现金流约定',
    meaning: '这是「剔除出入金后、纯粹由选币与择时带来的真实表现」，也是评价策略的主口径。持续上行=稳定赚钱；走平=不赚不亏；与总资产涨幅背离=出入金在干扰。可与 BTC 买入持有、市场指数公平对比。',
    caveat: '依赖现金流被正确识别为「外部」（仅 /wallet/deposits|withdrawals 计入）；内部划转不算。快照太密或断点会轻微影响逐区间复利。',
  },
  {
    group: 'asset', name: '资金加权收益 MWR / XIRR', field: 'summary.mwrWindowPct / mwrAnnualizedPct',
    source: '由投资者视角现金流（期初市值、各笔充提、期末市值）求内部收益率',
    formula: '对 −V0 / −充值 / +提现 / +Vn 用二分法求 IRR；mwrWindow=整段窗口收益率，mwrAnnualized=年化 XIRR',
    meaning: '衡量「我作为出资人实际体验到的收益」，会把大资金进出的时点和规模计入。MWR 高于 TWR=我在高收益期投入了更多钱（择时加分）；低于 TWR=钱多在低迷期进场。',
    caveat: '窗口 < 7 天时年化 XIRR 数值极不稳定甚至无解，此时只看 mwrWindow。短窗口年化值不可用于决策。',
  },
  {
    group: 'asset', name: '净外部现金流', field: 'cashflows / summary.netCashflowUsd',
    source: 'Gate GET /wallet/deposits 与 /wallet/withdrawals（外部链上充提），按当时价折算 USD',
    formula: 'Σ 充值(+) − Σ 提现(−)',
    meaning: '这部分钱进出不是收益。正值=净入金，会把总资产抬高；负值=净出金。看净值曲线时它会先被剥离。',
    caveat: '现货账本里的 deposit/withdraw 是账户间内部划转，不计入，否则会双重扣除。',
  },

  // ---------------- 风险 ----------------
  {
    group: 'risk', name: '最大回撤', field: 'risk.maxDrawdownPct / nav.drawdown',
    source: '基于 TWR 单位净值序列（已剥离现金流）计算',
    formula: '净值相对其历史峰值的最小比值 − 1（≤0）',
    meaning: '从最高点跌下来最深的一次。数值越接近 0 越平稳；−20% 意味着曾从峰值缩水两成。它刻画的是「中途最难熬的时刻」，比波动率更贴近真实体验。回撤扩大往往意味着风险敞口变大或行情转弱。',
    caveat: '只反映已观测到的最深一次，不代表未来下限；样本短时容易低估。',
  },
  {
    group: 'risk', name: '年化波动率', field: 'risk.annualVolatility / summary.annualVolatility',
    source: '逐区间收益率 r_i（来自净值序列）的样本标准差 × √年化期数',
    formula: 'stdev(r_i) × √ppy，ppy = YEAR / 中位采样间隔',
    meaning: '收益的「颠簸程度」。越高=上上下下越剧烈，同样收益要承受更大的心理与强平压力。用来横向比较不同策略/币种的稳定性。',
    caveat: '窗口 < 7 天会被极度放大，仅供演示。看板按绿涨红跌显示，但波动率无方向。',
  },
  {
    group: 'risk', name: '夏普比率 Sharpe', field: 'risk.sharpe / summary.sharpe',
    source: '由年化收益、年化波动率、无风险利率 RISK_FREE_RATE 计算',
    formula: '(年化收益 − rf) / 年化波动率',
    meaning: '每承担一单位总波动换到多少超额收益。>1 通常算不错，越高越好，<0 表示连无风险利率都没跑赢。它把「赚多少」和「颠不颠」合成一个数。',
    caveat: '对上行波动也一并惩罚；短窗口不可靠。若更在意「只惩罚下跌」，看索提诺。',
  },
  {
    group: 'risk', name: '索提诺比率 Sortino', field: 'risk.sortino / summary.sortino',
    source: '同 Sharpe，但分母换成下行波动率',
    formula: '(年化收益 − rf) / 下行波动率（只统计 r_i<0 的部分）',
    meaning: '只把「往下的颠簸」当风险。上涨再猛不算坏事。对趋势型/低回撤策略，Sortino 往往比 Sharpe 更好看，也更贴近「怕亏不怕涨」的直觉。',
    caveat: '同样受短窗口年化失真影响。',
  },
  {
    group: 'risk', name: '卡玛比率 Calmar', field: 'risk.calmar / summary.calmar',
    source: '年化收益与最大回撤之比',
    formula: '年化收益 / |最大回撤|',
    meaning: '每承受一单位最大回撤换到的年化收益。越高说明「回撤换收益」的效率越好。适合最在意深跌的人。',
    caveat: '回撤接近 0 时会异常放大；样本内没出现过大跌时偏乐观。',
  },
  {
    group: 'risk', name: 'β（对基准）', field: 'risk.betaVsBenchmark / summary.betaVsBenchmark',
    source: '组合逐区间收益 r_i 与基准（默认 BTC）逐区间收益的回归，基准价来自 prices 表 / 公开 K 线',
    formula: 'cov(r_port, r_bench) / var(r_bench)，OLS 斜率',
    meaning: '组合对市场波动的敏感度。β≈1=与大盘同涨同跌；β>1=放大市场波动（涨更猛、跌更狠）；β<1=更抗跌；β<0=与市场反向。判断「我的涨跌到底是不是被大盘带的」。',
    caveat: '市场对比页的 β 只在「基准值发生变化」的有效周期上回归（避免 K 线平台段稀释）；这里的 β 基于净值序列，二者口径不同不要混用。样本需足够。',
  },
  {
    group: 'risk', name: '相关系数', field: 'risk.correlationVsBenchmark',
    source: '组合与基准逐区间收益的 Pearson 相关',
    formula: 'cov / (σ_port·σ_bench)，取值 −1~1',
    meaning: '越接近 1=几乎跟大盘同步（分散化不足）；接近 0=基本独立；为负=对冲。配合 β 看：高相关+高 β=纯粹在放大市场。',
    caveat: '线性相关，不刻画尾部极端行情。',
  },
  {
    group: 'risk', name: '基准买入持有 / 超额', field: 'benchmarks.buyAndHoldPct / excessVsBuyAndHoldPct',
    source: 'prices 表中基准币种（默认 BTC）首末价；简化单币对照',
    formula: '买入持有 = p1/p0−1；超额 = TWR − 买入持有',
    meaning: '回答「忙活半天跑赢躺平买 BTC 了吗」。超额为正=主动操作赢了基准，为负=不如不动。',
    caveat: '这是简化单币口径；完整多主流币对比请用「市场对比」页（analysis.market）。两者数值不要直接比。',
  },

  // ---------------- 归因 ----------------
  {
    group: 'attribution', name: '价格效应', field: 'attribution.price_effect_usd / attribution_agg',
    source: '逐快照逐币种的隐含单价 p=value_usd/qty（由 holdings 反推）',
    formula: '(p1 − p0) × q0',
    meaning: '币价涨跌带来的市值变化，是「市场给你的钱」，真正的投资收益来源。为正=持仓涨价，为负=跌价拖累。',
    caveat: '隐含单价可能混入估值口径变化；无独立行情时由快照反推。',
  },
  {
    group: 'attribution', name: '数量效应', field: 'attribution.qty_effect_usd',
    source: '逐快照逐币种持有数量 qty 的变化',
    formula: '(q1 − q0) × p0',
    meaning: '加仓/减仓搬进来的钱。为正=净买入，为负=净卖出。**这不是投资收益**，而是你自己调仓造成的规模变化。最容易被人误当成「赚了」。',
    caveat: '务必与价格效应分开看；比较策略表现请用 TWR，不要用含数量效应的市值变动。',
  },
  {
    group: 'attribution', name: '交叉效应', field: 'attribution.cross_effect_usd',
    source: '价格与数量同时变化的交互项',
    formula: '(p1 − p0) × (q1 − q0)',
    meaning: '「涨价时又加仓」或「跌价时又减仓」的叠加部分。为正通常意味着顺势加仓放大了收益，为负可能是追跌减仓。',
    caveat: '是数学恒等分解的产物，不代表独立因果。',
  },
  {
    group: 'attribution', name: '贡献占比 / 残差', field: 'attribution.contribution_pct / __RESIDUAL__',
    source: '逐币种 delta_value_usd 相对期初总资产；总资产变动未被持仓覆盖的部分归为残差',
    formula: '贡献% = delta_value_usd / V0 × 100；Σ逐币种Δ市值 + __RESIDUAL__ = 区间Δ总资产',
    meaning: '谁的涨跌在驱动总资产。残差大=有较大一块变化没被逐币种持仓解释（估值口径、账户级调整、未纳入持仓项），提示数据口径需检查。',
    caveat: '残差是恒等式保证项，不是错误；但残差占比长期过大要排查数据源。',
  },

  // ---------------- 成本与行为 ----------------
  {
    group: 'cost', name: '手续费 / 资金费 / 显式成本', field: 'costs.totalFeeUsd / fundingUsd / totalExplicitCostUsd',
    source: 'events 中 type=fee 的行、futures 账本 funding 行、/spot/my_trades 的 fee 字段，按当时价折 USD',
    formula: '显式成本 = Σ手续费 + |Σ资金费|（资金费取绝对值）',
    meaning: '交易摩擦的真金白银。很多「策略不赚钱」其实是成本吃掉的。资金费为正=收到，为负=付出（合约）。',
    caveat: '已实现盈亏、理财利息、返佣单列，不计入「显式成本」这一口径。',
  },
  {
    group: 'cost', name: '年化成本率', field: 'costs.annualisedCostPct',
    source: '显式成本 / 平均资产 / 窗口天数 年化',
    formula: '显式成本 / avgAssets × 365 / windowDays × 100',
    meaning: '把成本换算成「占资产每年百分之几」。若年化收益还跑不赢成本率，等于白干甚至倒贴。高频调仓者尤其要盯。',
    caveat: '短窗口会被放大，需结合窗口可靠性判断。',
  },
  {
    group: 'cost', name: '胜率 / 盈亏比 / 期望值', field: 'behavior.winRatePct / profitFactor / expectancyUsd',
    source: 'events 中 is_realized=true 的已实现盈亏事件（简化口径），非逐笔平仓配对',
    formula: '胜率=盈利样本/总样本；盈亏比=Σ盈利/|Σ亏损|；期望=平均单笔盈亏',
    meaning: '刻画操作质量：高胜率低盈亏比=靠频繁小赚；低胜率高盈亏比=靠少数大赚。期望值为正才长期可复利。',
    caveat: '基于已实现盈亏事件样本，不等于严格逐笔配对；无合约/无已实现字段时样本可能为 0。',
  },
  {
    group: 'cost', name: '复盘覆盖率', field: 'behavior.reviewCoveragePct',
    source: 'annotations 注释链中填写了复盘/结果的操作占比（原为人工 decisions）',
    formula: '已复盘操作数 / 总操作数 × 100',
    meaning: '衡量「经验有没有被沉淀」。覆盖率低=很多操作没留下动机与事后结论，同样的错容易再犯。这是把数据变成可复利经验的关键一层。',
    caveat: '依赖你主动在操作记录下补填复盘；不填则偏低，不代表操作本身差。',
  },

  // ---------------- 持仓结构 ----------------
  {
    group: 'structure', name: '集中度 HHI / 有效币种数', field: 'concentration.hhi / effectiveN',
    source: '最新快照逐币种估值权重 w_i',
    formula: 'HHI=Σw_i²（0~1）；有效币种数=1/HHI',
    meaning: 'HHI 越高越集中：接近 1=几乎全仓一个币，风险高度绑定单一标的；有效币种数低=看似持了很多币，实际风险只集中在少数几个。上涨时集中度高弹性大，下跌时也更惨。',
    caveat: '只看估值权重，不含杠杆/合约敞口。',
  },
  {
    group: 'structure', name: 'Top1 / Top3 占比', field: 'concentration.top1Pct / top3Pct',
    source: '最新快照逐币种估值权重排序',
    formula: '最大 / 前三大持仓权重 × 100',
    meaning: '最直观的集中程度。Top1 过高=「一个币定生死」。若该币恰是高波动山寨，整体回撤会被它主导。',
    caveat: '与稳定币占比一起看：稳定币占比高会天然压低风险敞口。',
  },
  {
    group: 'structure', name: '稳定币占比', field: 'concentration.stablecoinPct',
    source: '最新快照中 USDT/USDC/DAI/BUSD/TUSD/FDUSD/USD 的估值合计占比',
    formula: '稳定币市值 / 持仓总市值 × 100',
    meaning: '现金类「弹药」比例。高=防守姿态、抗跌但行情来了容易跑输（β 偏低）；低=满仓风险资产、上涨弹性大但回撤也大。市场对比页用其解释「为什么跑赢/跑输」。',
    caveat: '理财/合约账户里的保证金可能未完全体现在现货持仓估值里。',
  },
  {
    group: 'structure', name: '账户分布迁移', field: 'distribution / distribution.change_pct',
    source: '首末快照各账户（现货/合约/理财…）估值对比',
    formula: '各账户 last − first 及其变化率、终点占比',
    meaning: '钱在账户之间怎么搬家。资金从现货转向合约=加杠杆倾向；转向理财=降风险。迁移往往对应一次主动的仓位调整。',
    caveat: '账户口径以 Gate 返回的 label 为准；合约未开通则不出现。',
  },

  // ---------------- 数据质量 ----------------
  {
    group: 'quality', name: '采集断点', field: 'quality.longGaps',
    source: '相邻快照时间间隔，与中位间隔比较',
    formula: '间隔 > 中位间隔 × 2.5 视为断点',
    meaning: '断点多=中途有段时间没采到（服务重启、API 失败、网络抖动）。断点会让净值/波动/β 的采样不准，看到指标异常先查这里。',
    caveat: '计划内停服维护也会计入。',
  },
  {
    group: 'quality', name: '重复事件 ID / 残差', field: 'quality.duplicateEventIds / maxResidualContributionPct',
    source: 'events 的幂等去重键、归因残差行',
    formula: '重复 id 计数、最大残差贡献%',
    meaning: '重复 id=采集去重是否干净；残差占比大=归因覆盖不全。两者异常都说明数据口径需要检查，不宜直接用于决策。',
    caveat: '0 是理想值；轻微残差属正常估值口径差异。',
  },
  {
    group: 'quality', name: '哈希链完整性', field: 'integrity / quality.hashChainOk',
    source: 'events/prices/decisions/market/macro_events(+annotations/reports) 各 append-only 文件的 SHA-256 链，verify() 重新读磁盘校验',
    formula: 'hash = sha256(prevHash + canonicalBody)；任一改动/删除/重排都会断开',
    meaning: '✓ 通过=原始事实未被篡改、可放心交给第三方重放；⚠ 异常=有文件被改动/删除/重排，导出的派生表可信度存疑。这是整套分析「可被信任」的地基。',
    caveat: '校验的是磁盘文件，不校验内存缓存；手工编辑过 .jsonl 会立即暴露。',
  },

  // ---------------- 市场对比 ----------------
  {
    group: 'market', name: '归一化走势（起点=100）', field: 'benchmark_comparison.normalized_value',
    source: '我的单位净值 TWR（snapshots+events）与 BTC/ETH 等公开 K 线（GET /spot/candlesticks，无需密钥）',
    formula: '所选区间起点全部归一化为 100，AS-OF 对齐（t 时刻基准只取 ts≤t 最近一根已收盘 K 线）',
    meaning: '把量纲不同的资产与币价放到同一把尺子上比形状。曲线在谁上方=区间内累计表现更好；分叉扩大=相对强弱在拉开。只比形状与涨幅，不比绝对高度。',
    caveat: '绝不使用未来 K 线（防前视偏差）；未收盘末根会被丢弃。',
  },
  {
    group: 'market', name: '超额 / β 调整后超额', field: 'relative_metrics.excess_pct / beta_adjusted_excess_pct',
    source: '资产 TWR 与基准区间涨跌',
    formula: '超额 = 资产收益% − 基准收益%（百分点算术差）；β 调整超额 ≈ 超额 − (β−1)×基准涨幅',
    meaning: '超额>0=跑赢。β 调整后超额把「只是因为仓位更激进/更保守」的部分剥掉，近似看主动选币/择时的贡献。两者都为正=真的有 alpha；超额靠 β 撑起来=只是加了杠杆式敞口。',
    caveat: '超额是百分点算术差，不是几何/链接超额；基准下跌时算术差会误导，需结合涨跌方向。',
  },
  {
    group: 'market', name: '上行 / 下行捕获', field: 'relative_metrics.up_capture / down_capture',
    source: '基准上涨 / 下跌区间内，资产收益与基准收益之比',
    formula: 'up=mean(r_nav|r_bench>0)/mean(r_bench|r_bench>0)；down 同理（r_bench<0）',
    meaning: '上行捕获>100%=大盘涨时涨得更多；下行捕获<100%=大盘跌时跌得更少。理想是「上行高、下行低」。下行捕获>上行捕获=典型的「跟跌不跟涨」，要警惕。',
    caveat: '依赖足够的有效配对周期；样本太少不稳定。',
  },
  {
    group: 'market', name: '跟踪误差', field: 'relative_metrics.tracking_error_pct',
    source: '资产与基准逐期收益差',
    formula: 'stdev(r_nav − r_bench) × 100，每期百分点，未年化',
    meaning: '组合偏离基准的波动。越大=走势越「不走基准那套」，主动程度高（可能更好也可能更差）。',
    caveat: '未年化；与 β 一起判断「偏离来自放大还是来自不同步」。',
  },
  {
    group: 'market', name: '事件窗口复盘', field: 'event_windows / event_windows.reason',
    source: 'macro_events 事件台账（人工标注 + 行情异动自动检测 + DEMO）与事件前后各 N 个快照内的真实数据',
    formula: '窗口内各序列涨跌、超额、现金流、成交腿、手续费、最大拖累/贡献币种，拼装结构化原因',
    meaning: '回答「某个大环境事件发生时，我的资产和 BTC 各自怎么反应、为什么」。用于复盘「利空时我的仓位是不是太重」「事件里是哪些币拖了后腿」。',
    caveat: '事件来源不是实时新闻源；自动事件只是价格异动检测，不解释宏观成因。原因分析基于窗口内数据，不是主观评论。',
  },

  // ---------------- 扩展行情数据（v5，折叠展示 / 仅供导出深挖） ----------------
  {
    group: 'enrich', name: '全市场宽度 · 上涨占比', field: 'market_breadth.up_ratio_pct / advancers / decliners',
    source: '公开端点 GET /spot/tickers 全量交易对（实测约 2160 个），仅统计 *_USDT 计价对，落盘 enrichment.jsonl → market_breadth 表',
    formula: '上涨占比 = 24h change_percentage>0 的 USDT 交易对数 ÷ 参与统计的 USDT 交易对总数 × 100；另算中位/平均涨跌、成交额合计、涨跌前 5',
    meaning: '「大盘是普涨还是普跌」的温度计。>60% 偏普涨、<40% 偏普跌；上涨占比抬升而中位涨跌仍为负=少数币拉抬、多数币在跌（分化）。配合成交额看：放量普涨比缩量普涨更可信。',
    caveat: '只统计 USDT 计价对以避免重复计数；不含合约与币币对。ticker 的 change_percentage 是 Gate 的 24h 口径，与本地快照区间涨跌不可直接相减。',
  },
  {
    group: 'enrich', name: '组合相对强弱', field: 'enrichment.summary.portfolio24hPct / excessVsMarketPct / relativeVerdict',
    source: 'ticker_detail 中我实际持仓币种的 24h 涨跌 + 最新快照逐币种估值 + 全市场中位涨跌',
    formula: '组合 24h = Σ(持仓估值 × 该币 24h 涨跌) ÷ Σ(已覆盖持仓估值)，稳定币按 0；超额 = 组合 24h − 全市场中位涨跌；覆盖率 = 已覆盖估值 ÷ 全部持仓估值',
    meaning: '回答「我今天的涨跌是大盘给的，还是我选的币带来的」。超额>0=选币/择时加分，<0=拖后腿；覆盖率低说明有不少持仓没有对应 ticker（如理财、合约），此时结论参考性下降。',
    caveat: '这是 24h 横截面强弱，不是区间收益归因；不含手续费、资金费与现金流。与「市场对比」页的 TWR 超额是不同口径，不要混用。',
  },
  {
    group: 'enrich', name: '24h 振幅 / 买卖价差', field: 'ticker_detail.amplitude_24h_pct / spread_pct / order_book_depth.bid_depth_usd',
    source: '/spot/tickers 的 high_24h、low_24h、highest_bid、lowest_ask，以及 /spot/order_book 前 5 档盘口',
    formula: '振幅 = (24h 高 / 24h 低 − 1)×100；价差 = (卖一 / 买一 − 1)×100；盘口深度 = 前 5 档价格×数量之和',
    meaning: '振幅大=波动剧烈，止损容易被扫；价差大、深度浅=冲击成本高，大额进出会明显吃价。持仓中若高振幅+浅盘口占比高，说明组合的隐性交易成本偏高。',
    caveat: '价差是瞬时快照，不是成交滑点；不同价格量纲的币不能直接比绝对深度，宜比 spread_pct。盘口只取前 5 档，不代表全深度。',
  },
  {
    group: 'enrich', name: '名义费率 vs 实扣费用', field: 'fee_schedule.taker_fee_pct / metrics.cost.actualFeesUsd',
    source: '签名端点 GET /wallet/fee（taker/maker/合约/交割/GT 抵扣/借贷费率）+ 账本 fee 事件实扣金额',
    formula: '名义费率直接取 /wallet/fee；实扣 = Σ|events.feeUsd|；maker 比例来自成交腿的 taker/maker 标记',
    meaning: '名义费率是「定价表」，实扣是「账单」。GT 抵扣开启后实扣通常低于名义；实扣持续偏高要检查是否频繁 taker 吃单、是否走了高费率币对或借贷。',
    caveat: '两者口径不同（含 GT 抵扣、返佣、不同币对、点卡），不做机械相减求「误差」。费率表是低频快照，历史费率变化需看时间序列。',
  },
  {
    group: 'enrich', name: '资金费率 / 基差 / 未平仓量', field: 'futures_market.funding_rate_pct / basis_pct / open_interest',
    source: '公开端点 GET /futures/{settle}/tickers（funding_rate、mark_price、index_price、total_size、volume_24h_quote）',
    formula: '粗略年化资金费 ≈ 当期费率 × 3 × 365；基差 = (标记价 / 指数价 − 1)×100',
    meaning: '资金费持续为正且走高=多头拥挤、持多仓成本上升；基差扩大=合约相对现货偏离加大；未平仓量配合价格上行=新资金进场，价格跌而持仓量增=可能在加空。',
    caveat: '×3×365 假设每 8 小时结算且费率不变，只是粗略量级，不是真实年化收益。不同交易所结算周期不同，不做跨所比较。',
  },
  {
    group: 'enrich', name: '资金利用率 · 冻结占比', field: 'capital_usage.borrowed_to_total_pct / locked_share_pct / unrealised_to_total_pct',
    source: '最新快照的 accounts.borrowed / unrealisedPnl + holdings 的 available / locked / valueUsd（不额外请求 API）',
    formula: '借款占比 = 借款合计 ÷ 总资产；冻结占比 = Σ(该币估值 × 冻结数量/(冻结+可用)) ÷ 总资产（按估值加权）',
    meaning: '借款占比上升=杠杆在加，回撤时的强平风险随之上升；冻结占比高=资金被挂单/理财/合约占用，可动用弹药少；未实现盈亏占比大=账面浮动对总资产影响显著。',
    caveat: '冻结占比按 USD 估值加权，避免把 BTC 与 DOGE 的原始数量直接相加。数量合计字段（locked_qty / available_qty）跨币种量纲不同，仅作参考。',
  },
  {
    group: 'enrich', name: '挂单 / 持仓 / 强平距离', field: 'account_state.* / liqDistancePct',
    source: '签名端点 GET /spot/open_orders、/futures/{settle}/positions、/margin/accounts',
    formula: '强平距离 = |标记价 − 强平价| ÷ 标记价 × 100；挂单数按交易对聚合，持仓按非零 size 过滤',
    meaning: '强平距离小=价格稍不利就可能触发强平，需要降杠杆或补保证金；大量未成交挂单=资金被占且可能成交在不利价位；杠杆账户 risk 升高=接近追保线。',
    caveat: '部分账户未开通时这些端点返回 USER_NOT_FOUND，系统将其静默记入 notes，不影响主快照也不触发顶部红条。空数组可能表示「没有持仓」或「无权限」，需结合 notes 判断。',
  },
  {
    group: 'enrich', name: '充提链分布', field: 'deposit_chains.chain / volume_usd / count',
    source: 'events.jsonl 中 isCashflow=true 的充提事件，从备注解析「链上充值 · ETH」「链上提现 · TRON」等链名',
    formula: '按链聚合笔数、现金流绝对额、均值与最近时间；解析不到链名归入 UNKNOWN',
    meaning: '看资金主要走哪条链、笔均规模、哪条链最近活跃。链集中度过高时，该链拥堵或维护会直接影响出入金效率；也可用于核对跨链手续费成本。',
    caveat: '链名来自 Gate 账本备注文本解析，不是链上原始数据；UNKNOWN 表示备注未标注链，不代表没有链。金额取现金流绝对额，不区分方向。',
  },
];

/** Flat, export-friendly rows (one row = one metric). */
function rows() {
  const gname = Object.fromEntries(GROUPS.map(g => [g.key, g.name]));
  return ITEMS.map((x, i) => ({
    seq: i + 1,
    group: x.group, group_name: gname[x.group] || x.group,
    name: x.name, field: x.field, source: x.source,
    formula: x.formula, meaning: x.meaning, caveat: x.caveat,
  }));
}

module.exports = { GROUPS, ITEMS, rows };
