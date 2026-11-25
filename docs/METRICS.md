# 指标口径与数据约定（Metrics & Conventions）

本文件是 Gate Asset Monitor「Analytics Edition」的**唯一口径真相源**。看板、导出表、ZIP 数据包里的每一个指标、字段、单位、时间基准都以此为准。写给两类读者：一是用它做决策的你，二是拿导出数据做二次分析的第三方工具（pandas / Excel / Power BI）。

> 对应代码：`src/analytics.js`（归因/风险/成本）、`src/marketAnalytics.js`（市场对比纯函数）、`src/facts.js`（append-only 事实层）、`src/exporter.js`（导出 SCHEMA / 数据字典）。数据字典（`dictionary.csv`）由 SCHEMA 自动生成，与本文互为印证。

---

## 0. 三条不能混淆的线

| 概念 | 回答的问题 | 用哪个量 |
|---|---|---|
| 总资产 | 我现在有多少钱 | `snapshots.total_usd`、`nav.total_usd` |
| 真实投资表现 | 我操作/选币赚了多少（剔除出入金） | `nav.twr`、`summary.twrPct` |
| 钱进钱出 | 有多少变化只是因为我充值/提现 | `cashflows`、`nav.cashflow_usd` |

**核心原则**：`总资产涨幅` ≠ `投资收益`。一次大额充值会把总资产曲线抬一个台阶，但这不是你赚的。所有收益口径都必须先做「现金流剥离」。

---

## 1. 时间基准与单位

| 项 | 约定 |
|---|---|
| 时间戳 | 全部 `ts_ms` = Unix 毫秒、**UTC**；导出另附 `ts_iso_utc` = ISO 8601 UTC |
| 统计窗口 | `meta.from` → `meta.to`（首末快照，UTC） |
| 金额 | 一律 **USD**；字段名以 `_usd` 结尾 |
| 数量 | 以 `token` 为单位；字段名 `qty` / `amount` |
| 比例 | `ratio` 类为小数（`0.12` = 12%）；`*_pct` 为 0–100 百分数 |
| 空值 | CSV 空单元格 / JSON `null` = 不可计算或缺失，**不代表 0** |
| 价格 | 隐含单价 `p = value_usd / qty`（由快照反推，见 §4）；有独立行情时另见 `prices` 表 |

---

## 2. 现金流剥离（Cashflow Stripping）

**只有外部现金流参与剥离**：`is_cashflow=true` 的事件，即 Gate `/wallet/deposits`（充值）与 `/wallet/withdrawals`（提现）。

- `cashflow_usd`：`+` 充值 / `-` 提现（USD）。
- **内部划转不算外部现金流**：`/spot/account_book` 里出现的 `deposit/withdraw`（现货↔合约↔理财）是账户间转移，若也剥离会造成 TWR 双重扣除。代码在 `gateClient.fetchLiveFacts()` 中明确区分。
- **期末现金流约定（end-of-period）**：一笔现金流被归入「事件发生之后第一个快照时点」所属区间（`buildNav` 中 `cfByEnd`）。DEMO 数据同样服从该约定。

---

## 3. 收益口径

### 3.1 单位净值 / TWR（时间加权收益率）—— 衡量策略表现，主口径

逐区间收益率（期末现金流约定）：

```
r_i = (V_i − CF_i) / V_{i−1} − 1
TWR = Π(1 + r_i) − 1 = nav_per_unit(末) − 1
```

- `V_i`：第 i 个快照的 `total_usd`。
- `CF_i`：归属该期末区间的净外部现金流（`+入 −出`）。
- `nav_per_unit` 起点 = 1；`units = V_i / nav_per_unit`（份额，现金流按当期净值折算）。
- `net_asset_usd = V_i − CF_i`（剔除现金流后的期末市值）。
- `drawdown = nav_per_unit / 历史峰值 − 1`（≤ 0）。

**为什么用 TWR**：它剔除了出入金时点与规模的影响，可跨期、可与基准公平比较。比较"我炒得好不好"永远看 `nav.twr`，不要看含现金流的总资产涨幅。

### 3.2 MWR / XIRR（资金加权收益率）—— 衡量投资者实际体验

投资者视角现金流：`−V0`（期初投入）、`−deposit`、`+withdraw`、`+Vn`（期末市值），二分法求 IRR：

```
Σ CF_j / (1 + IRR)^(t_j − t_0) = 0
```

- `mwrAnnualized`：以 `YEAR` 为单位时间的年化 XIRR。
- `mwrWindow` / `mwrWindowPct`：以实际窗口 `windowMs` 为单位时间的**整段区间收益率**（不年化，短窗口更稳健）。

### 3.3 年化可靠性（重要）

窗口极短时，年化 XIRR 会数值不稳定甚至无解。因此：

- `risk.annualizationReliable = windowDays >= 7`；
- `summary.annualizationReliable` 透传到看板；
- 短窗口时前端给出醒目提示，`mwrAnnualized` 可能为 `null`。
- **结论**：DEMO / 刚上线几天的数据，请用 `mwrWindow`（整段收益率）和 TWR，不要引用年化 MWR、Sharpe、Calmar。

---

## 4. 逐币种归因分解（Attribution）

隐含单价：`p = value_usd / qty`（`qty>0`；否则回退到行情/估算价）。对每个区间、每个币种做三段分解：

```
价格效应 price_effect = (p1 − p0) · q0        ← 币价涨跌贡献（真正的市场收益）
数量效应 qty_effect   = (q1 − q0) · p0        ← 加减仓贡献（不是投资收益）
交叉效应 cross_effect = (p1 − p0) · (q1 − q0)
市值变动 delta_value  = price + qty + cross = value1_usd − value0_usd
```

**恒等式（residual 保证）**：

```
Σ_逐币种 delta_value_usd + __RESIDUAL__ = 该区间 Δtotal_usd
```

- `__RESIDUAL__` 是总资产变动中未被逐币种持仓覆盖的部分（估值口径差异、账户级调整、未纳入持仓的项等）。
- `contribution_pct`：该行 `delta_value_usd / V0 × 100`（对期初总资产的贡献）。
- `price_change_pct` / `qty_change_pct`：单价 / 数量变动百分比。
- `trade_driven_qty` / `flow_driven_qty`：区间内该币种的成交量 / 充提量绝对值，用于区分"数量变化来自交易还是出入金"。
- `attribution_agg` = 全窗口按币种累计。

**解读要点**：价格上涨带来的 `price_effect` 才是市场给的收益；`qty_effect` 主要是你自己加仓/减仓搬进来的钱。不要把它算成"赚了"。

---

## 5. 风险指标（`risk`，均基于 TWR 净值序列）

| 指标 | 公式 / 定义 |
|---|---|
| `annualReturn` | `(1 + TWR)^(1/years) − 1`，几何年化 |
| `periodVolatility` | 逐区间 `r_i` 的样本标准差 |
| `annualVolatility` | `periodVolatility × √ppy`，`ppy = YEAR / 中位采样间隔` |
| `downsideVolatility` | `√(mean(min(r_i,0)²)) × √ppy`，只惩罚下行 |
| `sharpe` | `(annualReturn − rf) / annualVolatility`，`rf = RISK_FREE_RATE` |
| `sortino` | `(annualReturn − rf) / downsideVolatility` |
| `maxDrawdown` / `Pct` | 净值相对历史峰值的最大回撤（负值） |
| `calmar` | `annualReturn / |maxDrawdown|` |
| `betaVsBenchmark` | `cov(r_portfolio, r_bench) / var(r_bench)`，样本 ≥ 3 才计算 |
| `correlationVsBenchmark` | 组合与基准区间收益的皮尔逊相关 |
| `rawChangePct` | 含现金流的总资产涨幅（**仅作对照**，非收益） |

短窗口（`windowDays < 7`）年化类指标不可靠，见 §3.3。

---

## 6. 基准对比（`benchmarks`）

默认基准 `BTC`（`BENCHMARK_CURRENCY` 可改）。需要 `prices` 表中该币种 ≥ 2 个价格点。**注意**：这是简化的单币买入持有对照；完整的多主流币区间对比见 §10（`analysis.market`）。

- `buyAndHoldPct`：基准买入持有收益率 `p1/p0 − 1`。
- `fiftyFiftyPct`：基准收益的一半（半仓基准）。
- `allStablecoinPct`：稳定币基准，按 0 处理。
- `excessVsBuyAndHoldPct` = `TWR − 基准买入持有`（策略超额）。
- `excessVsFiftyFiftyPct` = `TWR − 基准/2`。

---

## 7. 成本与行为（`costs` / `behavior`）

**成本**（来自 `events`，按类型累加 `amountUsd`）：

- `totalFeeUsd` 手续费、`fundingUsd` 资金费、`interestUsd` 利息、`rebateUsd` 返佣、`realisedPnlUsd` 已实现盈亏。
- `totalExplicitCostUsd = feeUsd + |fundingUsd|`（显式成本；资金费按绝对值计）。
- `costToAvgAssetsPct`、`annualisedCostPct`（成本 / 平均资产 × 年化）。
- `makerRatioPct`、`buyLegs/sellLegs`、`byVenue`、`byCurrency`：成交结构与场所分布。

**行为 / 复盘**（来自人工 `decisions` + 已实现盈亏事件）：

- `reviewCoveragePct`：填写复盘结论的决策占比 —— 衡量"经验有没有被沉淀"。
- `winRatePct`、`avgWinUsd`、`avgLossUsd`、`profitFactor`（`Σ盈利 / |Σ亏损|`）、`expectancyUsd`：基于 `isRealized` 事件的简化胜率与期望值。
- `byAction`、`byOutcome`、`tagCount`：操作与结果分布。

> 行为指标是**简化口径**：胜率基于已实现盈亏事件样本，不等于逐笔平仓配对；决策日志是人工输入，非自动从成交推断。

---

## 8. 集中度与数据质量（`concentration` / `quality` / integrity）

**集中度**（基于最新快照逐币种估值，权重 `w_i`）：

- `hhi = Σ w_i²`（0–1，越大越集中）；`effectiveN = 1/hhi`（有效币种数）。
- `top1Pct` / `top3Pct`、`stablecoinPct`（稳定币集合：USDT/USDC/DAI/BUSD/TUSD/FDUSD/USD）。

**数据质量 / 审计可信度**：

- 原始事实层 `events / prices / decisions / market / macro_events` 为 **append-only + SHA-256 哈希链**：`hash = sha256(prevHash + "\n" + canonicalBody)`，`prevHash` 首条为 64 个 0。
- `verify()` **重新读磁盘**校验，可检出任何改动/删除/重排（不依赖内存缓存）。
- `quality.longGaps`：超过中位间隔 2.5 倍的快照断点数；`duplicateEventIds`、`snapshotsWithNotes`、`maxResidualContributionPct`、`hashChainOk` 用于判断数据是否可信。
- `/api/integrity` 与导出 `manifest.integrity` 给出五条链的实时校验结果。

---

## 9. 导出与第三方分析

- **20 张整齐长表**（tidy long tables）：`snapshots / holdings / accounts / events / prices / decisions / decision_events / market / macro_events / macro_event_log / benchmark_comparison / relative_metrics / event_windows / cashflows / nav / attribution / attribution_agg / distribution / metrics / dictionary`。
- 市场相关 6 张：`market`（基准 K 线）、`macro_events`（事件当前态）、`macro_event_log`（事件原始审计链）、`benchmark_comparison`（归一化对比长表）、`relative_metrics`（相对指标）、`event_windows`（事件窗口复盘）。
- `decisions` = 折叠后的**当前状态**；`decision_events` = 未折叠的**原始审计链**（每条 create/edit/review/delete，含 `payload_json` 与哈希），二者互补，覆盖「所有决策数据」。
- ZIP 内 `raw/*.jsonl` 为 6 个 append-only 源文件（含 `market.jsonl` / `macro_events.jsonl`）的**字节级副本**，可独立重放哈希链、从零重建全部派生表。
- 格式：CSV（UTF-8 BOM + CRLF）、JSONL（每行一对象）、JSON；`dictionary` 写明每字段类型/单位/口径；`manifest.json` 给出清单、口径、完整性。
- 推荐主键：`snapshots(ts_ms)`、`holdings(ts_ms,currency)`、`events(event_id)`、`decision_events(seq)`、`attribution(from_ts_ms,to_ts_ms,currency)`、`market(ts_ms,symbol)`、`benchmark_comparison(ts_ms,series)`、`event_windows(event_id,series)`。
- 口径坑位再强调：
  - 比较策略表现用 `nav.twr`，不要用 `total_usd` 涨幅；
  - `qty_effect_usd` 不是收益；
  - 空值 ≠ 0；
  - 短窗口年化指标不可靠；
  - `mock` 模式为确定性模拟数据，导出显著标注 DEMO，不可当真实资产；
  - 事件来源为人工标注 / 行情异动自动检测 / DEMO，**不是新闻事实**，见 §10.1。

---

## 10. 市场对比与大环境事件（Market Context）

对应代码：`src/marketAnalytics.js`（纯函数）、`src/gateClient.js` 的 `fetchMarketCandles()`（Gate 公开端点）、`src/facts.js` 的 `market` / `macro_events` 两条哈希链。

### 10.1 数据来源与诚实边界

| 数据 | 来源 | 需要密钥 |
|---|---|---|
| 主流币 K 线 | `GET /api/v4/spot/candlesticks`（公开） | **不需要** |
| 基准价格（回退） | `prices` 表中同币种价格点 | 不需要 |
| 宏观事件 | `macro_events.jsonl` 台账 | — |
| DEMO 行情 / 事件 | `mockData.js` 市场因子 | — |

返回字段顺序：`[timestamp_sec, quote_volume, close, high, low, open, base_volume, window_closed]`（**已按官方返回实测**）。`window_closed` 是字符串 `"true"/"false"`：**未收盘的末根 K 线必须丢弃**，否则基准里混入未完成的盘中价。Gate 限制最多回溯 10000 根，故 `MARKET_LOOKBACK_DAYS` 默认 30 天。

**事件来源只有三种**：`manual`（人工标注）、`auto`（公开 K 线大幅波动自动检测）、`mock`（DEMO 模拟）。**系统不内置实时新闻源，也不臆造宏观事件**；`source=auto` 是预留的外部新闻适配器接点。DEMO 事件与市场因子中的价格脉冲一一对应，仅用于演示联动分析，明确标注非真实新闻。

### 10.2 对齐与归一化（防止前视偏差）

- 对比轴 = **我自己的快照时点**。
- **AS-OF JOIN**：t 时刻的基准只能取 `ts <= t` 的最近一根已收盘 K 线的 `close`，**绝不引入未来数据**。
- 所有序列（资产单位净值 `NAV` / `BTC` / `ETH` / 加权 `INDEX`）在**所选区间起点归一化为 100**，比较曲线形状与累计涨幅，不比较绝对高度。
- 资产侧用 **TWR 单位净值**（已剥离充提），不是 `total_usd` 涨幅。
- `INDEX` = 各基准归一化序列按 `MARKET_INDEX_WEIGHTS` 加权（默认 `BTC:0.6,ETH:0.4`；只对实际有数据的币种重新归一化权重）。

### 10.3 相对指标

| 指标 | 定义 |
|---|---|
| `excess_pct` | `nav_pct − series_pct`，**百分点算术差**，不是几何 / 链接超额 |
| `beta_adjusted_excess_pct` | `excess − (β−1) × benchPct`，近似剥离仓位结构后的主动收益 |
| `beta` | `cov(r_nav, r_bench) / var(r_bench)`，OLS 斜率 |
| `correlation` / `r_squared` | Pearson 相关系数 / 其平方 |
| `up_capture` | `mean(r_nav \| r_bench>0) / mean(r_bench \| r_bench>0)` |
| `down_capture` | 同上，条件为 `r_bench<0` |
| `tracking_error_pct` | `stdev(r_nav − r_bench) × 100`，每期百分点，**未年化** |
| `sample_periods` | 有效配对周期数 |

**平台段处理（关键口径）**：当前默认 K 线已与资产快照同频（5m@5m），基准不再是长阶梯。但当使用历史遗留的粗 K 线或人为设置更细的 K 线时，基准在相邻快照间仍可能是阶梯状常数。若逐点回归，大量零收益样本会稀释 β 与相关性。因此相对指标**只在「基准值发生变化」的区间上取样**：从上一次基准变化点 `last` 到当前 `i`，`r_bench = bench[i]/bench[last]−1`、`r_nav = nav[i]/nav[last]−1`。图表仍展示完整快照轴。

### 10.4 事件窗口与原因分析

- 窗口 = 事件时点**前后各 `MARKET_EVENT_WINDOW_BARS` 个快照**（默认 8），裁剪到所选区间边界。
- `event_windows` 一行 = 一个事件 × 一个序列：窗口涨跌、相对超额、窗口内净现金流、成交腿数、手续费、决策数、事件时点最大非稳定币持仓及占比、窗口内市值缩水 / 增长最多的币种。
- `reason` 由**窗口内真实数据**拼装，不是主观评论。全局 `reasons` 分类：相对表现、β、上/下行捕获、β 调整后主动超额、现金类占比、风险币拖累/贡献、外部现金流、显式成本、大环境事件。稳定币市值变动（主要来自充提）在「最大贡献/拖累」中被排除，避免把出入金误读成投资能力。
- `eventStudy` 按事件类别聚合平均反应；第三方可直接对 `event_windows.category` 做 group by。
- 事件为 append-only event-sourcing：`macro_events`（折叠当前态）+ `macro_event_log`（create/edit/delete 原始链，含 `payload_json` 与哈希）。

### 10.5 DEMO 自洽性

DEMO 不再是各币种独立随机游走，而是**共同市场因子**：

```
price(c, ts) = basePx(c) × (1 + vol(c) × (beta(c)·F(ts) + idio(c)·W_c(ts)))
F(ts)        = W_0(ts) + Σ shock_amp × sigmoid((ts − shock_ts)/width)
```

BTC 的 `beta=1, idio=0`，因此 `market.jsonl` 的 BTC `close` 与持仓估值中的 BTC 单价**完全一致**，不会出现「基准涨、持仓不涨」的矛盾。4 个 DEMO 事件对应 `F(ts)` 中的 4 个阶跃脉冲，事件窗口分析因此有真实可解释的因果，而不是两条无关随机曲线的巧合。

### 10.6 与旧 `benchmarks` 的区别

`analytics.benchmarks`（§6）是基于 `prices` 的**单币种买入持有对照**（buy&hold / 半仓 / 稳定币），是简化口径；`analysis.market` 是基于**公开 K 线 + 多个主流币 + 事件台账**的完整区间对比。两者口径独立，不要混用数值。

---

## 11. v4 新增口径：操作记录 / 指标详解 / 日报

### 11.1 操作记录与注释层（`operations` / `annotations`）

- `events` 是 Gate 只读流水的事实层；`operations` 是**纯派生视图**，不落盘、不可手工新增。分组键为 `refId`（缺失时用 `id`）；组内出现 `type=trade` 时用 `tradeOperation()` 合成一条买/卖，否则用 `simpleOperation()` 单腿一条。Gate `/spot/account_book` 每行的 `refId` 等于自身 `id`，因此单腿账本行不会被误合并；`/spot/my_trades` 的成交腿才共享 `refId`。
- 成交估值优先取基础腿 `amountUsd`，退回计价腿，再退回 `|amount| × priceUsd`；手续费取组内 `feeUsd / amountUsd` 绝对值之和；`side` 取 `main.side`，否则 `amount >= 0 → buy`。每条操作保留 `event_ids` 与 `leg_count`，可回连 `events` 表与哈希链。
- `isCashflow` 仅继承原始事件口径（外部充提），成交 / 划转 / 费用一律不算现金流，与 §2「现金流剥离」口径一致，不重复剥离。
- `annotations` 以 `operationId` 为外键，event-sourcing：`create/edit` 只更新主观字段（motive / takeProfit / stopLoss / expectation / tags），`review` 只更新复盘字段（reviewNote / outcome / reviewedAt），`delete` 从当前态移除。`listAnnotations()` 折叠成当前态；`annotation_events` 保留完整审计链（含哈希）。
- `analytics.behavior` 的输入为 `behaviorDecisions = legacy decisions + annotations`，因此**复盘覆盖率反映新工作流**；旧 `decisions` 表与 API 保留兼容，不参与操作记录页。
- 导出：`operations`（一操作一行，含 `event_ids` / `leg_count`）、`operation_annotations`（折叠当前态）、`annotation_events`（未折叠原始链）。

### 11.2 指标详解（`metric_glossary`）

- 纯数据文档，**不含任何实时数值**。8 个分组 / 41 个指标，导出字段：`seq / group / group_name / name / field / source / formula / meaning / caveat`。
- `source` = 数据来源（Gate 端点 / 事实表 / 派生方式）；`formula` = 计算口径与单位；`meaning` = 走势或数值的方向含义与读法；`caveat` = 常见误读与适用边界（短窗口年化、现金流台阶、数量效应不是收益、as-of 防前视等）。
- `/api/metric-glossary`、前端「指标详解」面板、`metric_glossary` 导出表**同源**；三处口径不一致视为 bug。`meaning` 只解释「怎么读」，不做预测、不含买卖判断。

### 11.3 日报口径（`daily_reports` / `reports.jsonl`）

- 窗口：`REPORT_PRESET` = `8H / 24H / 7D / 30D / ALL`；资产侧用 **TWR**（§3），市场侧用 **as-of 对齐**（§10.2），年化可靠性沿用 `risk.annualizationReliable`（统计窗口 ≥ 7 天）。
- **v5.3 分推**：一次生成 `assetReport` + `marketReport` 两个独立对象，企业微信分两条发送；合并对象仅用于预览 / `reports.jsonl` / 导出。@ 人只在第二条（`marketReport`）出现一次。
- **资产时间点对比**：窗口固定为 `1h / 8h / 24h / 7d / 30d`。从 `now` 向前找**最后一个 `ts ≤ now − 窗口`** 的快照作起点，终点是最新快照；两点时间都按 `REPORT_TZ_OFFSET_HOURS` 打印。`changePct = (V_end − V_start) / V_start × 100`，**总资产口径含出入金**；没有起点快照时输出「窗口前无快照」而不是估算。不再出现「较上一轮快照」。
- `marketBrief`：按 symbol 取最近一根**已收盘** K 线；`chg24Pct = close / 24h 前最近一根 close − 1`；`chg7Pct` 同理用 7d；`high24 / low24 / high7 / low7` 取对应时间窗内 K 线的 `high / low`（**不再用「最近 24 根」冒充 24h**，5m 周期下 24h = 288 根）。只消费与 `MARKET_CANDLE_INTERVAL` 同 `intervalSec` 的点，绝不混用旧 1h K 线。
- **24h 技术面研判（非预测）**：`barsPerDay = 86400 / intervalSec`；快线 `SMA(barsPerDay/4)`、慢线 `SMA(barsPerDay)`、`RSI(14)`、24h 已实现波动率 `stdev(bar returns) × √barsPerDay`、量比 `ΣquoteVolume(近24h) / ΣquoteVolume(前24h)`。逐项打分（价格在快线上/下、快慢线关系、RSI 区间、24h 涨跌、量比≥1.2 放大且顺势），映射为 `偏强 / 中性偏强 / 震荡 / 中性偏弱 / 偏弱`。技术区间 = `last × (1 ± 波动率)`，并取 24h 高低作参考支撑/阻力。**不含新闻、链上资金或预测模型，突发消息可使区间失效**。
- `observations`：仅在真实数值触发阈值时生成，每项带 `basis`（依据数值）与 `level`（`warn / info / good` **仅视觉强调，不是交易信号**）。**短窗口不引用年化成本率**（2 小时窗口年化可虚高到 95%），改用 `costToAvgAssetsPct`，避免误导。
- 推送：企业微信 `markdown` 单条 ≤ **4096 字节 UTF-8**，按行切分至 `CHUNK_TARGET=3600` 并加 `(i/n)` 前缀；条间 350ms，远低于 20 条/分钟；@ 人用独立短 `text` 消息（`mentioned_mobile_list`），分推时只在行情条出现；只允许主机 `qyapi.weixin.qq.com`。
- `reports.jsonl`：一报一行，存 `meta / headline / keyMetrics / observations 摘要 / sections 目录 / 完整 markdown / chunks / 推送结果（含分推 parts）`；**`pushedTo` 只存脱敏 webhook**（`?key=***abcd`），密钥绝不落盘。
- 日报里的「资产处置建议」与「24h 研判」= **数据驱动的观察与规则化技术面提示**，不构成投资建议、不含买卖指令、不臆造新闻、不是价格预测；事件来源为行情异动自动检测 / 人工标注 / DEMO，不是实时新闻源。

### 11.4 事实层与导出清单（v5 汇总）

- **9 个原始文件**：`snapshots / events / prices / decisions / market / macro_events / annotations / reports / enrichment`（均为 `.jsonl`，append-only）。
- **8 条哈希链**：`events / prices / decisions / market / macro_events / annotations / reports / enrichment`；`snapshots.jsonl` 仍作为原始字节副本随 ZIP 导出，但不参与 facts 哈希链。
- **34 张 tidy 长表**；全量 ZIP = 34 CSV + 34 JSONL + 9 个 `raw/*.jsonl` + `analytics.json` + `manifest.json` + `README.txt` = **80 条目**。CSV 为 UTF-8 BOM + CRLF，时间戳统一 `ts_ms`(Unix 毫秒 UTC) + `ts_iso_utc`。

### 11.5 v5 扩展只读端点口径（`enrichment` 及 8 张派生表）

- **采集频率**：低频，跟随 `PRICE_SAMPLE_EVERY`（或 `ENRICH_SAMPLE_EVERY`），约每小时一条，3–8KB/条。**不把 2160 行原始 tickers 落盘**：只保留全市场聚合 + 我实际持仓的 11 字段明细。
- **来源端点**（均为只读）：`/spot/tickers`、`/wallet/fee`、`/futures/{settle}/tickers`、`/spot/order_book`、`/spot/open_orders`、`/futures/{settle}/positions`、`/margin/accounts`。
- **错误隔离**：每个可选子请求独立 try/catch，失败只写记录内 `notes` 与 `status.lastEnrichNotes`，**绝不进入 `status.lastError`**，不触发顶部红条，不中断快照。
- **全市场宽度**：仅统计 `*_USDT` 计价对（避免重复计数）。`up_ratio_pct = 上涨家数 / USDT 交易对总数 × 100`；另给中位/平均涨跌、24h 成交额合计、涨/跌/量前 5。**ticker 的 `change_percentage` 是 Gate 的 24h 口径，与本地快照区间涨跌不可直接相减**。
- **组合相对强弱**：`portfolio24hPct = Σ(持仓估值 × 该币 24h 涨跌) / Σ(已覆盖估值)`，稳定币按 0；`excessVsMarketPct = portfolio24hPct − marketMedian24hPct`；附 `coveragePct`。这是**24h 横截面强弱，不是区间收益归因**，与 §10 的 TWR 超额口径不同，不可混用。
- **振幅 / 价差 / 深度**：`amplitude_24h_pct = (24h高/24h低−1)×100`；`spread_pct = (卖一/买一−1)×100`；`bid_depth_usd / ask_depth_usd` 为前 5 档价格×数量之和。价差是瞬时快照，不等于成交滑点。
- **名义费率 vs 实扣**：`fee_schedule` 来自 `/wallet/fee`（定价表）；`actualFeesUsd` 为账本 `fee` 事件实扣。两者口径不同（GT 抵扣、返佣、不同币对、点卡），**不做机械相减求误差**。
- **资金费 / 基差**：`funding_annualised_pct = 当期费率 × 3 × 365`（假设每 8h 结算且费率不变，**仅量级参考**）；`basis_pct = (标记价/指数价−1)×100`；`open_interest` 为未平仓张数。
- **资金利用率**：`borrowed_to_total_pct = 借款 / 总资产`；`locked_share_pct` 按 **USD 估值加权**（`Σ 估值×冻结/(冻结+可用) ÷ 总资产`），避免把 BTC 与 DOGE 的原始数量相加；`locked_qty / available_qty` 跨币种量纲不同，仅参考。
- **强平距离**：`=|标记价 − 强平价| ÷ 标记价 × 100`；空持仓被 `size≠0` 过滤。
- **充提链**：从 `events.note` 解析「链上充值 · ETH」等链名，解析不到归 `UNKNOWN`（表示未标注，不等于没有链）；金额取现金流绝对额。
- **DEMO 自洽性**：`buildDemoEnrichment` 的宽度、ticker 明细、合约资金费、盘口、资金占用都由同一 `priceUsd()/marketFactor()` 过程派生，与资产曲线、市场对比、事件窗口讲同一个故事。

### 11.6 v5.1 传输与容量口径

- **磁盘水位策略**（`src/diskGuard.js`）：`freeMb = statfs.bavail × bsize ÷ 1048576`，用 `bavail`（普通用户可用块）而非 `bfree`。软水位 `minFreeMb=512` 以下按 `2^ceil(log2(minFree/free))` 加倍采样间隔，硬水位 `hardFreeMb=128` 以下 `skipHeavy=true`（停写 `prices` 与 `enrichment`，快照与哈希链其它事件继续）。采样倍数夹在 `[1, maxSampleEvery=100]`，与基础 `PRICE_SAMPLE_EVERY` 相乘后再夹一次。文件系统不可查时 **fail open**（保持原设置），绝不误停采集。
- **事实层不可截断**：水位保护只改变**未来写入频率**，不删除、不重写、不压缩历史 `.jsonl`；截断会破坏 `prevHash` 链，使 `/api/integrity` 失败。要长期留存应做**分段归档 + 尾哈希锚点**，而不是删除。
- **静态资源**：`ETag = sha256(文件内容).hex 前 24 位`，内容变则 ETag 变；`If-None-Match` 命中返回 `304`，无 body。`Accept-Encoding: gzip` 时预压缩并缓存（`mtime + size` 作为失效键），返回 `Content-Encoding: gzip` + `Vary: Accept-Encoding`。因文件名不含内容哈希，缓存策略为 `no-cache`（每次重新校验），**不是 `immutable`**；`nosniff` / `X-Frame-Options` / `Referrer-Policy` 安全头在所有响应上保留。
- **流式 ZIP**：`/api/export/all` 用 `zip.stream()` generator 逐块 `res.write()`，`drain` 事件处理背压，`close` 事件处理客户端断开。字节内容与离线 CLI 的 `zip.build()` **逐字节相同**（同一套 header 构造函数，固定时间戳可复现）；响应带 `X-Export-Tables: 34` 便于脚本核对。内存峰值由「整包 + 拷贝」降为「单条最大记录」。
- **CSP 口径**：`script-src 'self'`（无 `unsafe-inline` / `unsafe-eval` / 外部源），`style-src 'self' 'unsafe-inline'` 仅因 `app.js` 用 `innerHTML` 写宽度/颜色条——样式属性不执行脚本。`connect-src 'self'` 保证 API 同源；`base-uri 'none'` / `frame-ancestors 'none'` / `object-src 'none'` 收紧注入面。登录限流按 `req.socket.remoteAddress` 计数，完全不读 `X-Forwarded-For`。

### 11.7 基准行情采样同步（v5.2）

- **问题**：资产快照每 `SNAPSHOT_INTERVAL_SEC`（默认 300s）一条，而 BTC/ETH 基准 K 线原为 1h。走势对比时基准是 12 点阶梯，两条曲线在时间轴上"看着不同步"，β/相关性也只在基准换棒时才有样本。
- **策略**（`src/marketCadence.js`）：默认选择与快照同频的 Gate 支持周期（5m@5m）。若显式配置比快照更粗（如 `MARKET_CANDLE_INTERVAL=1h` + 300s 快照），自动下调到 5m；若配置更细则保留。异常配置在启动 banner 与 `/api/summary.status.marketSync` 中如实显示 `aligned=false`。
- **增量采集 + 翻页**：首次按 `MARKET_LOOKBACK_DAYS` 全量回填；此后只从上一条**同周期**已落盘 K 线往前重叠 1 根拉取，修正迟到收盘价，避免每 5 分钟重拉 30 天数据。Gate 规定**单次请求范围最多 1000 根且两端都计数**（恰好 1000 根会报 `INVALID_PARAM_VALUE`），因此回填按 **990 根**窗口向前翻页（30 天 5m ≈ 9 页）。切换周期时不会拿旧 1h 当游标（那只会补最后一小时）；如需手动重跑全窗口，调用 `POST /api/market/refresh?full=1`。Gate 总历史上限 10000 根，1m 周期时回看窗口自动缩到 6 天。
- **哈希链兼容**：K 线 id 从 `candle-{SYMBOL}-{ts}` 改为 `candle-{SYMBOL}-{intervalSec}-{ts}`。切换周期后，同一时间戳的旧 1h 与新 5m 可共存于 append-only 的 `market.jsonl`；分析入口按当前 `intervalSec` 过滤，**只把同频数据喂给图表**，旧数据仍随 ZIP 的 `raw/market.jsonl` 原样导出供第三方复核。
- **事件阈值保持不变**：5m K 线仍使用 3% 阈值（5 分钟内 3% 已是显著波动，不会刷屏），事件窗口默认约 1 小时（5m=12 根）。显式配置始终优先。
- **磁盘口径**：`market.jsonl` 只存 `MARKET_SYMBOLS` 指定的主流币，30 天 5m×2 币约 0.1–0.2MB/天；全市场 2160 对 tickers 仍走低频 `prices.jsonl` + `PRICE_SAMPLE_EVERY`，不受本次改动影响。

---

## 12. 免责

本工具只做资产记录、归因与导出，**不提供任何投资建议、买卖判断或仓位建议**。`live` 模式数值来自 Gate.io API v4 你的账户真实返回，估值口径以官方 `total_balance` 折算为准；加密资产波动大，决策请自行判断并注意风险。导出为敏感财务数据，请仅在可信环境（Tailscale 私网）内保存与传输。
