# 更新日志

本项目遵循语义化版本思想。当前版本 **v5.1**。

## v5.1 — 测试、CI、容量与安全加固

- 新增仓库内 `node:test` 测试套件（79 条断言）：netguard、facts 哈希链（含篡改/删除/重排检测）、analytics、marketAnalytics（含前视偏差）、operations、enrichAnalytics、exporter（34 表 / ZIP 结构）、diskGuard、httpStream（含空 ZIP 回归）。
- 新增 GitHub Actions CI：Node 18 / 20 / 22 矩阵，`node --check` + `npm test` + 离线导出冒烟测试。
- 修复 `marketAnalytics.asOf` 的潜在前视：t 早于所有 K 线时返回 `null`，不再回填未来价格。
- 静态资源 gzip + ETag（`304` 条件请求，安全头不变）：`app.js` 82KB → 26KB；`/api/export/all` 改流式 ZIP，内存峰值降为单条最大记录，字节内容与离线 CLI 一致。修复流式写入把 generator 当数组导致空 ZIP 的问题。
- 新增磁盘水位保护：软水位自动加倍采样、硬水位停写重数据但快照继续；**不截断哈希链**。状态在 `/api/summary.status.diskGuard`。
- 安全：严格 CSP（`script-src 'self'`；`style-src` 因看板 `innerHTML` 生成宽度/颜色条保留 `unsafe-inline`）、登录失败限流（5 次/5 分钟，`429` + `Retry-After`，按真实 socket 对端）、免鉴权 `/api/health` 探针、`COOKIE_SECURE` 可选项。
- 核查后**未实现「撤销表落盘」**：会话签名密钥含每次启动随机 salt，重启后所有会话本就失效，落盘没有收益；`README` 已写明该行为。
- 仓库规范：MIT LICENSE、`.nvmrc`、`.editorconfig`、`CHANGELOG.md`。

## v5.0 — 扩展 API 数据与日报机器人

- 接入 7 个新增只读端点与 `/spot/tickers` 全字段，新增第 9 个事实文件 `enrichment.jsonl`（第 8 条哈希链）。
- 全市场宽度、持仓 ticker 明细、费率、盘口、合约、资金利用率、充提链统计。
- 导出从 25 张表扩展到 34 张（ZIP 80 条目，9 个 raw 原始文件）。
- 前端不新增 tab：总览页一行关键摘要条 + 默认收起的「更多数据」。
- 每日日报 + 企业微信群机器人推送（markdown 分段、密钥脱敏、主机白名单）。
- 修复 live 快照持仓缺 `valueUsd` 的既有缺陷，无价格币种诚实标记为 `null`。

## v4.0 — 操作记录、资产分析与日报基础

- 决策日志重构为「Gate 真实流水 → 人类可读操作记录 + 主观注释层」（注释独立 append-only 链）。
- 归因分析改名资产分析，新增 41 项指标详解（来源 / 公式 / 走势含义 / 注意事项）。
- 日报生成器、企业微信客户端、8 个日报 API 接口。

## v3.0 — 市场对比（Market Context）

- 公开 Gate K 线（无需 API Key）+ 宏观事件台账。
- 资产 vs BTC / ETH / 加权指数，as-of 对齐杜绝前视偏差。
- β、相关系数、上下行捕获率、事件窗口复盘与中文原因分析。
- 导出从 14 张表扩展到 20 张（后 v4 到 25 张）。

## v2.0 — 分析与导出

- 现金流剥离 → 单位净值 / TWR / MWR。
- 逐币种三段归因（价格 / 数量 / 交叉效应 + 残差闭合）。
- 风险、成本、行为、集中度、数据质量指标。
- append-only 事实层与 SHA-256 哈希链；14 张 tidy 长表导出。

## v1.0 — 采集与看板

- Gate.io API v4 只读采集，定时快照，多终端响应式看板。
- 独立 systemd 部署，仅 Tailscale 可达（网络层绑定 + 来源网段白名单）。
- 零 npm 依赖，Node >= 18。
