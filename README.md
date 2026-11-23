# Gate 账户资产监测系统 · 资产分析 / 操作记录 / 日报 / 扩展行情版 (v5)

一个**只读**的 Gate.io 账户资产监测 + **资产分析** + **市场对比** + **操作记录注释** + **每日日报**服务:定时采集账户估值/持仓快照与 Gate 真实操作流水,存成 **append-only + SHA-256 哈希链**的事实数据层,在此之上计算单位净值/TWR、逐币种涨跌贡献、风险/成本/行为指标,并为每个指标给出**来源 / 计算口径 / 走势意味着什么 / 常见误读**;叠加**主流币基准行情与大环境事件**做区间对比和跑赢/跑输归因;每天自动生成**资产日报**(最近行情 + 资产总结 + 数据驱动的处置观察),通过**企业微信机器人**推送;**全部数据可导出供第三方分析**(34 张整齐长表 + 数据字典 + ZIP + 9 个原始文件字节副本)。部署在**你自己的 VPS**,**仅允许 Tailscale 组网内的设备访问**,公网完全不可达。

> 看板六个视图:**总览 / 资产分析 / 市场对比 / 操作记录 / 日报 / 导出中心**。口径真相源是 [`docs/METRICS.md`](docs/METRICS.md) 与 `src/metricGlossary.js`;看板「指标详解」面板、`metric_glossary` 导出表、ZIP 三处口径一致,不凭记忆改公式。
>
> **操作记录不再手工录入**:系统按只读接口从 Gate 同步真实成交/充提/划转/费用,一次成交的基础腿+计价腿+手续费合并为一条;你只在该记录**下面**补写动机、止盈、止损、预期与复盘,注释与 Gate 事实分开存储、append-only。旧「决策日志」的深链接 `?tab=decisions` 自动跳转到「操作记录」,旧数据仍保留在 `decisions` 表可导出。

> 克隆后默认运行在 `mock` 演示模式:所有数字都是确定性模拟数据,界面与导出都明确标注 `DEMO`,不含任何真实账户信息,方便先跑通再切换。切换到 `live` 后,数据全部来自你的 Gate.io API v4 真实返回(见 §6)。

> **典型生产部署**:VPS(`tailscale0`),独立 systemd 服务 `gate-asset-monitor`,端口 `8787`。可与同机 Caddy/nginx、业务容器并存,**不改动 Caddy 配置、Docker 容器或防火墙规则**。

---

## 1. 它做了什么 / 安全边界

```
[Gate.io API v4]  ←── 服务端用 Key+Secret 做 HMAC-SHA512 签名(只读)
        │
   ┌────▼───────────────────────────────────┐
   │  服务端 · 可信区(你的 VPS)             │
   │   定时采集脚本 → 资产快照数据库        │
   │   API Key / Secret 仅存环境变量        │
   └────┬───────────────────────────────────┘
   安全边界:密钥与签名永不下发到浏览器
   ┌────▼───────────────────────────────────┐
   │  Tailscale 私网 · 唯一访问入口           │
   │   http://100.x.y.z:8787                │
   │   资产看板 / 走势 / 分布 / 币种明细      │
   │   随时导出 · 手机/平板/电脑              │
   │   ACCESS_TOKEN 登录保护(HMAC 会话)       │
   └────────────────────────────────────────┘
   公网 IP / eth0 / docker 网桥:8787 无监听 → 连接直接被拒
```

**安全红线**
- `GATE_API_KEY` / `GATE_API_SECRET` **只**存在于服务端进程的环境变量,绝不写进前端代码、磁盘、日志、API 响应或导出文件(已验证)。
- 看板只拿到服务端算好的「已归一化」数据,浏览器拿不到密钥,也没有签名能力。
- 建议再叠加:只读权限的 API Key、Gate 侧 IP 白名单、`ACCESS_TOKEN`、Tailscale 来源网段限制。

---

## 2. 功能

| 能力 | 说明 |
|---|---|
| 全账户估值 | `GET /wallet/total_balance`,一次拿总资产 + 各账户分类明细 |
| 现货币种明细 | `GET /spot/accounts`(数量/可用/冻结) |
| 合约账户 | `GET /futures/{usdt,btc,...}/accounts`(可配置) |
| 定时快照 | 默认每 5 分钟一条,持久化到 `data/snapshots.jsonl`(追加式,崩溃安全) |
| 历史保留 | 默认 365 天,超期自动清理 |
| 资产走势 | 内联 SVG 折线图,可切最近/中段/全部,悬停看数值 |
| 涨跌标记 | 遵循中国习惯:**红涨绿跌** |
| 市场对比 | 选定区间内资产 TWR vs BTC/ETH/加权指数,附 β、捕获率、事件窗口与原因分析 |
| 账户分布 / 占比 | 横向条形 + 百分比 |
| 随时导出 | 历史快照 CSV、当前持仓 CSV、完整数据 JSON(带 `demo` 标记) |
| 手动刷新 | 立即触发一次采集 |
| 多终端 | 响应式,手机 / 平板 / 电脑自适应(导出中心在窄屏自动转卡片式布局) |
| 登录保护 | `ACCESS_TOKEN` + HttpOnly HMAC 签名会话,按设备精确登出 |
| 仅 Tailscale | 只绑定 `100.x` 地址 + 来源网段白名单,公网/私网来源一律 403 |
| 零依赖 | 只用 Node ≥18 内置模块,服务器上无需 `npm install` |

### 2.1 深化分析能力(Analytics Edition)

在「看板」之上把数据变成**可复利的决策系统**。核心是**归因**:先分离现金流与真实盈亏,否则一次充值就会把总资产曲线抬一个台阶、被误当成收益。

| 能力 | 说明 |
|---|---|
| append-only 事实层 | `events / prices / decisions / market / macro_events / snapshots` 六类原始事实,逐条 `seq + prevHash + hash`,SHA-256 哈希链防篡改 |
| 现金流剥离 | 只把 `/wallet/deposits`、`/wallet/withdrawals` 当外部现金流;现货流水里的充提是内部划转,不双重剥离 |
| 单位净值 / TWR | 期末现金流约定 `r_i=(V_i−CF_i)/V_{i−1}−1`,`TWR=Π(1+r_i)−1`;**比较策略表现用这个** |
| MWR / XIRR | 投资者视角资金加权收益,短窗口年化不可靠时给出醒目提示 |
| 逐币种归因 | 价格效应 / 数量效应 / 交叉效应三段分解,`__RESIDUAL__` 保证 `ΣΔ市值 = Δ总资产` |
| 风险指标 | 最大回撤、年化收益/波动、Sharpe、Sortino、Calmar、β、相关系数、基准超额 |
| 成本与行为 | 手续费/资金费/利息、maker/taker、胜率、盈亏比、期望值、复盘覆盖率 |
| 集中度/数据质量 | HHI、稳定币占比、有效币种数、快照断点、重复事件、哈希链校验 |
| 操作记录 / 注释 | Gate 真实操作只读派生;动机/止盈/止损/复盘另存 `annotations` 链,event-sourcing 不可改写(旧 `decisions` 表保留兼容) |
| 市场基准 K 线 | Gate 公开 `/spot/candlesticks`,无需密钥;丢弃未收盘末根 |

> 全部公式、单位、时间基准、空值语义见 [`docs/METRICS.md`](docs/METRICS.md)——这是口径真相源。

### 2.2 全量数据导出(供第三方分析)

用户硬要求「**所有数据都要可以导出可供第三方分析**」,因此导出分三层,无歧义覆盖:

1. **34 张整齐长表**(tidy long tables,一行一观测):`snapshots / holdings / accounts / events / prices / decisions / decision_events / market / macro_events / macro_event_log / benchmark_comparison / relative_metrics / event_windows / cashflows / nav / attribution / attribution_agg / distribution / metrics /` **`operations / operation_annotations / annotation_events / metric_glossary / daily_reports`** `/` **`enrichment / ticker_detail / market_breadth / fee_schedule / order_book_depth / futures_market / account_state / capital_usage / deposit_chains`** `/ dictionary`。
   - 市场相关 6 张覆盖基准行情、事件台账(当前态 + 原始审计链)、归一化对比、相对指标、事件窗口复盘。
   - `decisions` = 折叠后的**当前状态**;`decision_events` = 未折叠的**原始审计链**(每条 create/edit/review/delete,含 `payload_json` 与哈希),二者互补。
   - **v4 新增 5 张**:`operations`(Gate 真实操作按 `refId` 折叠,含 `event_ids` 可回连原始流水)/ `operation_annotations`(每笔操作的动机、止盈、止损、预期、复盘当前态)/ `annotation_events`(注释原始审计链)/ `metric_glossary`(指标的来源、公式、走势含义、误读)/ `daily_reports`(每篇日报的摘要、关键指标、观察项、推送结果)。
   - **v5 新增 9 张**:`enrichment`(扩展采集聚合快照,含 `payload_json` 原始子端点副本)/ `ticker_detail`(持仓币种 11 字段全量 ticker)/ `market_breadth`(全市场宽度时间序列)/ `fee_schedule`(名义费率)/ `order_book_depth`(盘口前 5 档)/ `futures_market`(资金费/基差/持仓量)/ `account_state`(挂单/持仓/杠杆)/ `capital_usage`(资金利用率)/ `deposit_chains`(充提链分布)。
2. **数据字典**:`dictionary.csv` 写明每个字段的类型、单位、口径;`/api/schema` 返回机器可读 SCHEMA。
3. **原始文件字节副本**:ZIP 内 `raw/*.jsonl` 是 9 个 append-only 源文件的逐字节拷贝,可独立重放哈希链、从零重建全部派生表。

| 形式 | 入口 |
|---|---|
| 看板「导出中心」 | 逐表 CSV / JSON / JSONL 下载,显示行列数与完整性校验 |
| 一键全量 ZIP | `GET /api/export/all` → 20 CSV + 20 JSONL + `analytics.json` + `manifest.json` + `README.txt` + `raw/*.jsonl` |
| 离线 CLI | `deploy/export-all.js`(不经过 HTTP、不需要口令,可放进 cron 备份) |
| 格式 | CSV = UTF-8 BOM + CRLF(Excel/pandas 直读);JSONL 每行一对象;JSON 带 meta |

时间统一 UTC(`ts_ms` + `ts_iso_utc`),金额统一 USD,`*_pct` 为 0–100 百分数,空值 ≠ 0。归因恒等式 `Σ delta_value_usd + __RESIDUAL__ = 总资产变动`。

### 2.3 市场对比与大环境事件（Market Context）

回答「**选定区间内，我的资产走势和 BTC/ETH 比怎么样，为什么跑赢或跑输**」。

| 能力 | 说明 |
|---|---|
| 主流币基准行情 | Gate **公开**端点 `/spot/candlesticks`，**不需要 API 密钥**；默认 BTC / ETH，可配 `MARKET_SYMBOLS` 扩展 |
| 区间选择 | 8 小时 / 24 小时 / 7 天 / 30 天 / 全部，所有对比、指标、事件都基于所选区间**重新计算** |
| 归一化对比图 | 资产单位净值 vs BTC/ETH/加权指数，起点统一 = 100；叠加市场事件竖线 |
| 相对指标 | 超额（百分点差）、β、相关系数、R²、上/下行捕获率、跟踪误差、**β 调整后主动超额** |
| 大环境事件台账 | append-only：`manual` 人工标注 / `auto` 行情异动自动检测 / `mock` DEMO；图上打点，可增删 |
| 事件窗口复盘 | 每个事件前后各 N 个快照：资产与主流币各自涨跌、超额、现金流、成交、决策、主导持仓、最大拖累/贡献币 |
| 原因分析 | 由真实数据拼装的结构化结论（β 结构、稳定币占比、逐币种拖累、成本、现金流、事件反应），不是主观评论 |
| 加权市场指数 | `MARKET_INDEX_WEIGHTS`（默认 `BTC:0.6,ETH:0.4`），对有数据的币种重归一化 |

> **诚实边界**：系统**不内置实时新闻源**，也不臆造宏观事件。事件只有三种来源（人工标注 / 公开 K 线异动自动检测 / DEMO 模拟），`source=auto` 是预留的外部新闻适配器接点。DEMO 行情与事件均为确定性模拟，与资产价格共享同一市场因子，用于演示联动分析。**公式、as-of 对齐、平台段处理、事件窗口口径全部写死在 [`docs/METRICS.md`](docs/METRICS.md) §10。**

---

## 3. 快速开始(本地 / 模拟模式)

```bash
cd gate-asset-monitor
cp .env.example .env
# 先设置 ACCESS_TOKEN(openssl rand -hex 24),其余保持默认 mock
npm start
```

浏览器打开 `http://localhost:8787`,输入 `ACCESS_TOKEN` 即可看到 DEMO 看板(已预填 96 条历史,便于验证图表/导出)。

### 3.1 日常使用指南(看板怎么用)

**登录与会话**:首次打开输入 `.env` 里的 `ACCESS_TOKEN` 即可;会话是 HttpOnly HMAC Cookie,按设备独立,右上角「登出」只撤销当前设备。同属一个 Tailnet 的手机/平板/电脑登录方式相同。

**六个视图**(顶部 tab,支持深链接直达,如 `?tab=operations`):

| 视图 | 深链接 | 什么时候看 / 怎么用 |
|---|---|---|
| 总览 | `?tab=overview` | 日常就看这页:KPI 卡(总资产、区间涨跌、TWR 收益、现金流)、资产走势图(切「最近/中段/全部」)、账户分布、币种明细(估值/占比/24h)。页面周期自动刷新,右上角「刷新」可立即强制采集一次。 |
| 资产分析 | `?tab=analytics` | 回答「涨/跌是怎么来的」:现金流剥离后的净值曲线、逐币种价格/数量/交叉归因、回撤/波动/Sharpe 等风险指标、成本与行为统计。每个指标旁有「详解」面板:来源、公式、走势意味着什么、常见误读。区间用 8 小时 / 24 小时 / 7 天 / 30 天 / 全部 按钮切换。 |
| 市场对比 | `?tab=market` | 选定区间,资产净值与 BTC/ETH/加权指数归一化到同一起点对比;β、上行/下行捕获率、超额收益、事件窗口复盘与中文原因分析(不臆造新闻,只做数据归因)。 |
| 操作记录 | `?tab=operations` | Gate 真实流水自动折叠成人类可读的「买/卖/充值/提现/费用/利息」记录(**只读,不手写**,避免时间差);在任意一条下面点「注释」补写动机、止盈、止损、预期与复盘。注释独立存储、append-only,可改可删,原始审计链保留。 |
| 日报 | `?tab=report` | 「生成 / 刷新预览」看今日日报(资产 / 最近行情 / 资产 vs 主流币 / 数据驱动的处置观察);「立即推送」手动发到企业微信;下方是历史日报。定时任务每天自动生成并推送(配置见 §11.3)。 |
| 导出中心 | `?tab=export` | 全量 ZIP(34 张表 + 数据字典 + 9 个原始文件字节副本)、按表单下 CSV/JSON/JSONL、复制 CLI 命令离线导出;附哈希链完整性状态(8 条链逐条重算校验)。 |

**总览页的扩展行情**:资产卡下方有一条**摘要条**,一句话讲完最重要的事(全市场涨跌家数、我的持仓 24h、相对大盘强弱);长尾数据全部收纳在默认**收起**的「更多数据 · 扩展行情明细」中——市场宽度趋势、涨跌榜、盘口价差、合约资金费率、费率表、账户状态、资金利用率、充提链。点开才加载,右上角「刷新扩展数据」可立即拉取最新一次。完整的 34 张表(含全部历史周期)去「导出中心」下载。

**常见任务速查**:

| 你想做什么 | 操作 |
|---|---|
| 看最新资产 | 打开总览,等自动刷新;急看最新点右上角「刷新」 |
| 追问涨跌原因 | 资产分析 → 归因分解;和大盘比 → 市场对比 |
| 给某笔操作补记录 | 操作记录 → 找到那条 → 「注释」写动机/止盈/止损 |
| 备份 / 交给第三方分析 | 导出中心下载 ZIP(Excel/pandas/Power BI 可直接吃 CSV) |
| 让机器人每天发日报 | `.env` 配 `WECOM_WEBHOOK_KEY` + `REPORT_ENABLED=true` 后重启服务(§11.3) |
| 改日报推送时间 | `.env` 改 `REPORT_HOUR` / `REPORT_TZ_OFFSET_HOURS`,`systemctl restart gate-asset-monitor` |
| 确认数据没被改动 | 导出中心顶部完整性状态,或 `GET /api/integrity` |
| 减少磁盘占用 | `.env` 调大 `PRICE_SAMPLE_EVERY`(价格采样间隔,§9.1)后重启服务 |

---

## 4. 仅 Tailscale 私有部署(当前生产环境采用)

### 4.1 安全模型:两层独立拒绝

| 层 | 机制 | 效果 |
|---|---|---|
| 网络层 | `HOST` 在启动时被设为 `tailscale ip -4`(形如 `100.x.y.z`),服务只监听该地址 | 公网 IP、eth0、docker 网桥上 **8787 端口根本不存在**,连接直接 `refused` |
| 应用层 | `TAILSCALE_ONLY=true`,任何来源 IP 不在 `100.64.0.0/10` / `fd7a:115c:a1e0::/48` / 回环内的请求,**路由之前**返回 403 | 即使将来误把服务绑到 `0.0.0.0`,非组网设备依然进不来 |

两层之外还有第三道锁:`ACCESS_TOKEN` 登录 + per-IP 失败限流(5 次 / 5 分钟,超出返回 `429` + `Retry-After`),两者都只认真实 socket 对端,**不信任** `X-Forwarded-For`(可伪造)。所有响应带严格 CSP:`script-src 'self'`,无内联 JS、无外部源、无 `eval`;`style-src` 保留 `unsafe-inline`,因为看板用 `innerHTML` 生成宽度/颜色条(仅样式,不执行脚本)。`COOKIE_SECURE` 仅在 HTTPS 反代下开启。`/api/health` 是**唯一免登录**的路由,只返回 `ok`/`uptimeSec`/`ts`,不含任何账户数据,且仍在 Tailscale 来源过滤之后,可供 systemd/监控做存活检查。

> 会话签名密钥由 `ACCESS_TOKEN` + 每次启动随机 salt 派生,所以**服务重启后所有设备都需要重新登录**;这是有意的,单实例部署不需要额外的撤销落盘。登出只撤销当前 `sid`,不影响其它终端。

> 与同机现有 Caddy 配置里 `@notTailscale not remote_ip 100.64.0.0/10` 用的是同一个网段,口径一致。

### 4.2 一键部署(在 VPS 上,幂等)

```bash
# ① 本机打包上传(排除运行时数据与本地密钥)
#    把 <user>@<vps-ip> 换成你的 VPS 登录方式(SSH 端口非 22 时加 -p <port>)
cd gate-asset-monitor
tar czf - --exclude='./data' --exclude='./.env' --exclude='./.git' \
  --exclude='./node_modules' --exclude='./.runtime' . \
| ssh <user>@<vps-ip> \
  "mkdir -p /opt/gate-asset-monitor && tar xzf - -C /opt/gate-asset-monitor"

# ② 在 VPS 上安装并启动
ssh <user>@<vps-ip> \
  "cd /opt/gate-asset-monitor && sed -i 's/\r$//' deploy/*.sh && bash deploy/install-vps.sh"
```

`install-vps.sh` **只做**三件事:

1. 往 `/opt/gate-asset-monitor/` 放项目文件 + 私有 Node 运行时(`.runtime/`,解压即用,**不 apt 装任何系统包**);
2. 生成 `.env`(`DATA_MODE=mock`、`TAILSCALE_ONLY=true`、随机 `ACCESS_TOKEN`,权限 `600`);
3. 写 `/etc/systemd/system/gate-asset-monitor.service` 并 `enable --now`。

**明确不碰**:Caddy / nginx 配置、任何现有 Docker 容器、ufw / iptables 规则、SSH 配置、任何其它 systemd 单元。已部署服务不会重启、不会重载、不会改配置。

> 为什么不改防火墙?「只绑定 Tailscale IP」已经让公网无监听,无需动防火墙;对已开 ufw 的机器,启用/修改规则会牵动 SSH 等现有端口,风险远大于收益,应保持原样。

### 4.3 访问

在**已加入同一 Tailnet 的设备**上打开:

```
http://<vps-tailscale-ip>:8787
```

MagicDNS 已启用时也可用主机名:`http://<hostname>.<tailnet>.ts.net:8787`。

首次输入 `.env` 里的 `ACCESS_TOKEN`(安装日志会打印一次,或 `grep ACCESS_TOKEN /opt/gate-asset-monitor/.env`)。手机 / 平板 / 电脑只要装了 Tailscale 并登录同一账号即可访问。

### 4.4 验证

```bash
ssh <user>@<vps-ip> "bash /opt/gate-asset-monitor/deploy/verify-tailscale.sh"
```

脚本会检查:服务状态、`8787` 只监听 `100.x`、Tailscale 地址可访问、其它网卡地址被拒、来源白名单已生效、原有 Docker 服务仍在运行。

### 4.5 常用运维

```bash
journalctl -u gate-asset-monitor -f        # 日志
systemctl restart gate-asset-monitor       # 重启
systemctl status gate-asset-monitor        # 状态
cat /opt/gate-asset-monitor/.env           # 查看口令(勿外泄)
cp /opt/gate-asset-monitor/data/snapshots.jsonl ~/backup/   # 备份
```

卸载(不影响其它服务):

```bash
systemctl disable --now gate-asset-monitor
rm -f /etc/systemd/system/gate-asset-monitor.service && systemctl daemon-reload
rm -rf /opt/gate-asset-monitor
```

---

## 5. 其它部署方式(通用场景)

### 5.1 Docker

```bash
cd /opt/gate-asset-monitor
cp .env.example .env
vim .env     # 设置 ACCESS_TOKEN;live 模式再填密钥
docker compose up -d
```

compose 只把端口绑定到 `127.0.0.1:8787`,由同机反代转发,不直接暴露到公网。

### 5.2 通用 systemd(不绑定 Tailscale)

```bash
sudo cp deploy/gate-monitor.service.example /etc/systemd/system/gate-monitor.service
# 编辑 User / WorkingDirectory / EnvironmentFile
sudo systemctl daemon-reload && sudo systemctl enable --now gate-monitor
```

### 5.3 绑定公网域名(不推荐)

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/conf.d/gate-monitor.conf
# 把 server_name 改成你的域名
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d assets.yourdomain.com
```

> 公网暴露前**必须**设置 `ACCESS_TOKEN`,并强烈建议在反代层叠加 `allow 100.64.0.0/10; deny all;` 之类限制。本项目默认部署方式(第 4 章)不走这条路。

---

## 6. 从演示模式切到真实数据

### 第一步:申请只读 API Key

1. Gate.io → 账户 → API 管理 → **APIv4 Keys** → 创建
2. 权限:**只勾选「读取 / Read」**,**不要**勾选交易、提现、划转
3. **IP 白名单**:填你服务器的公网出口 IP(可从服务器 `curl ifconfig.me` 查看)
4. 保存 `Key` 和 `Secret`(Secret 只显示一次)

> Gate 官方明确警告:不要把 API key 提交给客服或任何人;一旦泄露立即删除重建。本项目密钥只放在服务器 `.env`,不经过聊天/代码库。

### 第二步:先验证密钥可用

```bash
bash deploy/verify-live.sh
```

脚本会用你的真实密钥做一次签名请求,只打印总额与账户分类(不打印密钥)。常见失败原因:密钥/权限错误、IP 不在白名单、服务器时钟偏差(Timestamp 用「秒」)。

### 第三步:切换并重启

```bash
# 编辑 /opt/gate-asset-monitor/.env
DATA_MODE=live
GATE_API_KEY=xxxx
GATE_API_SECRET=yyyy

sudo systemctl restart gate-asset-monitor    # Tailscale 部署
# docker compose restart                    # Docker 部署
```

看板右上角徽章变为「● 实时」,数据即来自你的真实账户。若部分端点返回失败,页面顶部会给出提示(其余账户仍正常显示)。

---

## 7. 配置参考

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATA_MODE` | `mock` | `mock`=演示数据 / `live`=真实 API |
| `GATE_API_KEY` / `GATE_API_SECRET` | 空 | 只读密钥,仅 live 需要 |
| `GATE_BASE_URL` | `https://api.gateio.ws/api/v4` | 可换 testnet |
| `GATE_SETTLES` | `usdt,btc` | 查询的合约结算币种 |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址;VPS 启动脚本自动改写为 Tailscale `100.x` |
| `TAILSCALE_ONLY` | `false` | 仅允许 Tailscale 网段来源,其余 403(**VPS 部署强制为 true**) |
| `ALLOW_CIDRS` | `100.64.0.0/10,127.0.0.0/8,::1,fd7a:115c:a1e0::/48` | 允许的来源网段 |
| `TRUST_PROXY` | `false` | 是否信任 `X-Forwarded-For`(默认否,防伪造) |
| `PROXY_IP_HEADER` | `x-forwarded-for` | 仅 `TRUST_PROXY=true` 时生效 |
| `SNAPSHOT_INTERVAL_SEC` | `300` | 采集间隔(秒) |
| `RETENTION_DAYS` | `365` | 历史保留天数 |
| `PRICE_SAMPLE_EVERY` | `1` | 每 N 个采集周期存一次价格点(1–100) |
| `DISK_GUARD_ENABLED` | `true` | 低磁盘时自动降采样/停写重数据（不删哈希链） |
| `DISK_GUARD_MIN_FREE_MB` | `512` | 软水位：低于此值采样间隔加倍 |
| `DISK_GUARD_HARD_FREE_MB` | `128` | 硬水位：低于此值停写 prices / enrichment |
| `DISK_GUARD_MAX_SAMPLE_EVERY` | `100` | 自动降采样的倍数上限 |
| `EVENT_LOOKBACK_DAYS` | `90` | live 首次回溯流水窗口(1–730 天) |
| `COLLECT_EVENTS` | `true` | live 模式每轮拉取流水与行情 |
| `GATE_TRADE_PAIRS` | 空 | live 模式额外抓 `/spot/my_trades` 的交易对(逗号分隔,如 `BTC_USDT,ETH_USDT`) |
| `BENCHMARK_CURRENCY` | `BTC` | β / 超额收益的基准币种(需 `prices` 有该币行情) |
| `RISK_FREE_RATE` | `0` | Sharpe/Sortino 年化无风险利率(如 `0.02`) |
| `ANALYTICS_LIMIT` | `0` | 送入分析窗口的快照数(0=全部,上限 200000) |
| `MARKET_SYMBOLS` | `BTC,ETH` | 对比的主流币（Gate 公开 K 线，无需密钥） |
| `MARKET_QUOTE` | `USDT` | 组成 `{SYMBOL}_{QUOTE}` 交易对 |
| `MARKET_CANDLE_INTERVAL` | `1h` | K 线周期 |
| `MARKET_LOOKBACK_DAYS` | `30` | 回溯天数（Gate 上限 10000 根） |
| `MARKET_COLLECT` | `true` | live 模式拉取公开 K 线 |
| `MARKET_AUTO_EVENTS` | `true` | 从行情大幅波动自动生成异动事件 |
| `MARKET_EVENT_THRESHOLD_PCT` | `3` | 单根 K 线涨跌幅超该值(%)记为事件 |
| `MARKET_EVENT_WINDOW_BARS` | `8` | 事件窗口前后各 N 个快照 |
| `MARKET_INDEX_WEIGHTS` | `BTC:0.6,ETH:0.4` | 合成市场指数权重 |
| `ACCESS_TOKEN` | 空 | 看板访问口令(**必填**) |
| `SESSION_TTL_SEC` | `604800` | 登录会话有效期 |
| `COOKIE_SECURE` | `false` | 仅 HTTPS 反代下设为 `true`（纯 HTTP 下会导致无法登录） |
| `LOGIN_MAX_ATTEMPTS` | `5` | 同一来源 IP 的登录失败上限，超出 429 |
| `LOGIN_WINDOW_SEC` | `300` | 失败计数的滑动窗口（秒） |
| `LOGIN_LOCK_SEC` | `300` | 触发上限后的锁定时长（秒） |
| `QUOTE_LABEL` | `USD` | 界面计价标签(仅显示用) |
| `DATA_DIR` | `./data` | 9 个 append-only `.jsonl` 文件目录 |
| `ENV_FILE` | 自动 | 指定要加载的 `.env` 路径 |

环境变量优先级高于 `.env` 文件,便于 Docker/CI 覆盖。完整说明见 [`.env.example`](.env.example),公式口径见 [`docs/METRICS.md`](docs/METRICS.md)。

---

## 8. API(同源,仅供看板使用)

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/auth/status` | GET | 登录状态 |
| `/api/auth/login` | POST | `{token}` → 设置会话 Cookie |
| `/api/auth/logout` | POST | 撤销当前设备会话 |
| `/api/health` | GET | **免登录**存活探针（仅 `ok` / `uptimeSec` / `ts`，无账户数据） |
| `/api/summary` | GET | 最新快照 + 涨跌 + 系统状态(含 `tailscaleOnly`) |
| `/api/history?limit=` | GET | 历史序列 |
| `/api/refresh` | POST | 立即采集一次 |
| `/api/status` | GET | 运行状态 |
| `/api/analytics?view=compact` | GET | 完整分析结果:净值/TWR/归因/风险/基准/成本/行为/集中度/质量 |
| `/api/events` · `/api/prices` | GET | 原始事件流水 / 行情序列(可带 `from`/`to`/`type`) |
| `/api/decisions` | GET/POST | (旧版兼容)决策日志:读取 / 新增;新工作流请用 `/api/operations` |
| `/api/decisions/review` · `/api/decisions/delete` | POST | 追加复盘 / 删除(event-sourcing,不可改写) |
| `/api/datasets` | GET | 34 张导出表的清单(行数/列数/粒度) |
| `/api/schema?format=json\|csv` | GET | 数据字典(机器可读 / CSV) |
| `/api/integrity` | GET | 八条 append-only 哈希链实时校验 |
| `/api/export/dataset?name=&format=` | GET | 单表导出(`csv`/`json`/`jsonl`) |
| `/api/export/all` | GET | **全量 ZIP**(34 表 + 字典 + manifest + README + 9 个 `raw/*.jsonl`) |
| `/api/operations?kinds=&annotated=1&limit=` | GET | **Gate 真实操作记录**(只读派生视图)+ 注释挂载 + 覆盖率统计 |
| `/api/operations/annotate` | POST | 按 `operationId` upsert 动机 / 止盈 / 止损 / 预期 / 标签(append-only) |
| `/api/operations/review` | POST | 追加复盘(保留动机与止盈止损);`/api/operations/annotate/delete` 删除注释 |
| `/api/metric-glossary` | GET | 41 个指标的来源 / 口径 / 走势含义 / 误读(同时是导出表) |
| `/api/enrichment?view=headline\|full` | GET | **扩展行情数据**:`headline` 只返回一行摘要(轮询用);`full` 返回摘要 + depth + 9 张长表 |
| `/api/enrichment/refresh` | POST | 仅 live:立即拉取一次扩展只读端点(tickers/费率/盘口/合约/账户) |
| `/api/report/status` | GET | 日报调度、机器人**脱敏**状态、上次推送结果、存档数 |
| `/api/report/preview` | GET | 生成日报(不推送、不写历史);`/api/report/markdown?id=` 取全文 |
| `/api/report/send` | POST | 生成 + 推送企业微信 + 写入 `reports.jsonl` |
| `/api/report/test` · `/api/report/history` | POST/GET | 机器人连通性测试 / 推送历史 |
| `/api/market?preset=&symbols=&from=&to=&view=` | GET | 区间市场对比：归一化序列 / 相对指标 / 事件窗口 / 原因结论 |
| `/api/market/refresh` | POST | 仅 live：重新拉取公开 K 线 + 自动检测事件 |
| `/api/macro-events` | GET/POST | 事件台账读取 / 新增人工标注 |
| `/api/macro-events/import` · `/api/macro-events/delete` | POST | 批量导入 / 删除事件（event-sourcing） |
| `/api/export?format=csv\|json&kind=` | GET | 旧版导出端点(兼容保留) |
| `/api/reseed-demo` | POST | 仅 mock:重建自洽 DEMO 数据(旧数据自动备份) |

所有 `/api/*`(除登录相关)在开启鉴权后都需要有效会话;`TAILSCALE_ONLY=true` 时非组网来源**在路由之前**即被 403 拦截。看板支持深链接 `?tab=overview|analytics|market|operations|report|export`;旧 `?tab=decisions` 自动映射到「操作记录」。

---

## 9. 数据备份与维护

- 数据都在 `data/` 下 9 个 **append-only 纯文本** `.jsonl`:`snapshots.jsonl` / `events.jsonl` / `prices.jsonl` / `decisions.jsonl` / `market.jsonl` / `macro_events.jsonl` / `annotations.jsonl` / `reports.jsonl` / **`enrichment.jsonl`**,直接复制即备份,其中 8 条链(`events/prices/decisions/market/macro_events/annotations/reports/enrichment`)带 SHA-256 哈希链可校验完整性;`snapshots.jsonl` 仍作为原始文件随 ZIP 导出。
- Tailscale 部署的数据在 `/opt/gate-asset-monitor/data/`,服务重启、重装代码都不会丢(增量部署刻意不覆盖 `.env` / `data/` / `.runtime/`)。
- 看板「导出中心」一键下载全量 ZIP;或用离线 CLI 定时备份(不经过 HTTP、不需要口令):

```bash
/opt/gate-asset-monitor/.runtime/node/bin/node \
  /opt/gate-asset-monitor/deploy/export-all.js

# 自定义目录 / 跳过 ZIP
DATA_DIR=/opt/gate-asset-monitor/data OUT_DIR=/backup/gate NO_ZIP=1 \
  /opt/gate-asset-monitor/.runtime/node/bin/node deploy/export-all.js
```

CLI 产出:34 张表的 `.csv` + `.jsonl`、`analytics.json`、`manifest.json`、`raw/*.jsonl`(9 个原始文件字节副本),以及(默认)一个全量 ZIP。可放进 cron 做每日留档。

### 9.1 磁盘占用与顶部「数据源提示」

- **`prices.jsonl` 是主要增长源**:`/spot/tickers` 每次返回约 **2160 个交易对**,5 分钟采集周期下 `PRICE_SAMPLE_EVERY=1` 约 **162MB/天**。生产环境设 `PRICE_SAMPLE_EVERY=12`(每小时一次)后约 **13.5MB/天**;快照、净值、三段归因、市场对比都不依赖 `prices` 链密度,不受影响。
- **`prices.jsonl` 属于哈希链事实层,历史不能截断或删除**(否则 `/api/integrity` 报错、ZIP 的 `raw/` 字节副本缺失);该配置只控制**未来**写入频率。`RETENTION_DAYS` 只清理 `snapshots.jsonl`,对其余链无效。
- **顶部红色「数据源提示」横幅**来自 `/api/summary.status.lastError`,即本轮采集的 `notes`。最常见的一条是
  `futures/btc/accounts: Gate API 400: USER_NOT_FOUND` —— 含义是 **Gate Key 未开通 BTC 本位合约账户**(或该 Key 无合约读取权限),**不是网页故障**,也不影响现货、USDT 合约、理财、充提、成交与总资产(总额来自 `/wallet/total_balance`)。把 `GATE_SETTLES` 设为**实际已开通**的结算币(如 `usdt`)即可让该提示消失;以后开通 BTC 合约再加回来。
- **`enrichment.jsonl`（v5）**：低频，跟随 `PRICE_SAMPLE_EVERY`（默认每小时一条），约 3–8KB/条 ≈ **0.1–0.2MB/天**，可忽略。只存**聚合结果 + 我实际持仓的 ticker 明细**，不存 2160 行原始 tickers（子端点原始响应截断后放 `payload_json` 供第三方重放）。想更省可调 `ENRICH_SAMPLE_EVERY` 或 `ENRICH_COLLECT=false`。
- **磁盘水位保护（v5.1）**：剩余空间低于 `DISK_GUARD_MIN_FREE_MB`（默认 512MB）时自动把价格/扩展数据的采样间隔翻倍（最低 512→×2、256→×4、128→×8，上限 `DISK_GUARD_MAX_SAMPLE_EVERY`）；低于 `DISK_GUARD_HARD_FREE_MB`（默认 128MB）时**完全停止写 prices / enrichment，但快照继续**。宁可少采，也**不截断或删除哈希链**。状态见 `/api/summary` 的 `status.diskGuard`（`level` / `freeMb` / `sampleEvery` / `skipHeavy`），日志只在级别变化时打一次。`DISK_GUARD_ENABLED=false` 可关闭。
- **传输优化（v5.1）**：前端 `index.html` / `app.js` / `style.css` 走 gzip（实测 82KB → 26KB）+ ETag 条件请求（未变更返回 `304`），安全头保持不变；文件名没有内容哈希，所以用 `no-cache` 重新校验而不是 `immutable`，避免改版后拿旧页面。`/api/export/all` 改为**流式 ZIP**（逐块写入并处理背压），内存峰值从「整包 ×2」降为「单张最大表」，ZIP 内容与离线 CLI 逐字节一致（80 条目 / 34 表 / 9 raw）。
- 任何 `.env` 改动后必须 `systemctl restart gate-asset-monitor` 才生效(配置只在进程启动时读取)。

---

## 10. 项目结构

```
gate-asset-monitor/
├── src/
│   ├── config.js        # 配置 + .env 加载(环境变量优先) + 安全/分析策略
│   ├── gateClient.js    # API v4 签名 + 快照/流水/行情/成交抓取(对齐官方 SDK 源码)
│   ├── mockData.js      # 自洽确定性 DEMO(共同市场因子 + 币种 β + 事件脉冲)
│   ├── netguard.js      # Tailscale 来源网段白名单(IPv4 CIDR / IPv6 ULA)
│   ├── store.js         # snapshots.jsonl 存储 / 查询 / reset
│   ├── facts.js         # append-only 事实层(9 文件 / 8 条哈希链)+ 决策/注释 event-sourcing
│   ├── analytics.js     # 纯函数分析引擎(净值/TWR/归因/风险/成本/行为/质量)
│   ├── marketAnalytics.js # 市场对比纯函数(as-of 对齐/β/捕获率/事件窗口/原因)
│   ├── enrichAnalytics.js # 扩展数据纯函数(市场宽度/相对强弱/费率对账/资金利用率/充提链)
│   ├── operations.js    # Gate 真实 events → 人类可读操作记录(按 refId 合并成交腿)
│   ├── metricGlossary.js # 41 个指标的来源/公式/走势含义/误读(纯数据,唯一真相源)
│   ├── dailyReport.js   # 日报生成器(行情/资产/对比/观察项 + markdown 分段)
│   ├── wecom.js         # 企业微信机器人(零依赖 HTTPS + webhook 脱敏 + 主机白名单)
│   ├── exporter.js      # 34 张整齐长表 + 数据字典 + manifest + ZIP bundle
│   ├── zip.js           # 零依赖 ZIP writer(STORE / CRC32 / UTF-8 文件名)
│   ├── auth.js          # Token 登录 + HMAC 会话 + 按设备撤销
│   ├── diskGuard.js     # 磁盘水位策略(软/硬水位 → 降采样/停写重数据,不删链)
│   ├── httpStream.js    # 流式 ZIP 写入(背压 + 断连保护)
│   ├── loginGuard.js    # 登录失败限流(per-IP 滑动窗口,不信任代理头)
│   └── server.js        # HTTP 服务 / 定时采集 / 全部 API / 分析缓存 / 日报调度 / 安全 gate
├── public/              # 看板六视图(零 CDN 依赖:index.html / style.css / app.js)
├── deploy/
│   ├── start-tailscale.sh        # 动态解析 100.x 并只绑该地址
│   ├── install-vps.sh            # 幂等安装(私有 Node 运行时 + systemd)
│   ├── verify-tailscale.sh       # 部署后自检 + 现有服务无损确认
│   ├── export-all.js             # 离线全量导出 CLI(可进 cron)
│   ├── daily-report.js           # 离线日报 CLI:--preview / --send / --test
│   ├── gate-monitor.service.example
│   ├── verify-live.sh            # 真实密钥预检
│   └── nginx.conf.example
├── test/                # node:test 单测套件(79 条断言,零依赖)
│   ├── netguard.test.js         # 网段白名单边界 / 代理头信任 / fail-closed
│   ├── facts.test.js            # 哈希链串联 + 篡改/删除/重排检测
│   ├── diskGuard.test.js        # 水位策略 / 采样夹逼 / fail-open
│   ├── httpStream.test.js       # 流式写入 / 背压 / 断连（空 ZIP 回归）
│   ├── loginGuard.test.js       # 滑动窗口 / 按 IP 隔离 / 成功后清零
│   ├── analytics.test.js        # 现金流剥离 / NAV / 归因残差闭合 / 回撤
│   ├── marketAnalytics.test.js  # as-of 对齐无前视 / 归一化 / 相对指标
│   ├── operations.test.js       # refId 折叠 / 注释挂载 / 筛选
│   ├── enrichAnalytics.test.js  # 扩展表 / 相对强弱 / 费率对账 / 充提链
│   └── exporter.test.js         # 34 表 schema / CSV 转义 / ZIP 80 条目
├── docs/
│   └── METRICS.md       # 指标口径真相源(公式/单位/时间基准/空值语义)
├── .github/workflows/ci.yml # Node 18/20/22 矩阵:语法 + 单测 + 导出冒烟
├── data/                # 9 个 append-only .jsonl(git 忽略)
├── .runtime/            # VPS 私有 Node 运行时(git 忽略,安装时生成)
├── .env.example / .nvmrc / .editorconfig
├── LICENSE / CHANGELOG.md
├── package.json
├── Dockerfile / docker-compose.yml
└── README.md
```

---

## 11. v4 新增：操作记录 / 资产分析指标详解 / 日报

### 11.1 操作记录：从「先手工记一笔」改为「读 Gate 真实记录」

旧「决策日志」的毛病是**时间差**：在看板里写完动机，还得再去 Gate 操作，两条记录对不上。v4 把方向反过来：

- `events.jsonl` 本来就是 Gate 只读接口同步回来的真实流水(成交 / 充值 / 提现 / 划转 / 手续费 / 资金费 / 已实现盈亏)。`src/operations.js` 把它折叠成**人类可读操作记录**，按 `refId` 把一次成交的**基础腿 + 计价腿 + 手续费**合成一条买/卖；没有 `refId` 的账本行各自独立，不误合并。
- 操作记录是**只读派生视图**，不可手工新增、不覆盖 Gate 事实；每条带 `event_ids` 可回连 `events` 表与哈希链。
- 你的主观信息放独立 `annotations.jsonl`：动机 / 止盈 / 止损 / 预期 / 标签 / 复盘 / 结果，以 `operationId` 为外键。`create / edit / review / delete` 全部 append-only，`review` 只更新复盘字段、保留动机与止盈止损，`delete` 后当前态消失但审计链永久保留。
- 前端「操作记录」页按类型筛选、只看已注释、刷新重新同步 Gate(`/api/refresh`),在每条卡片下方就地填写与复盘;`analytics.behavior` 会把注释一起折进复盘覆盖率。

### 11.2 资产分析：每个指标都写清来源与走势含义

「归因分析」更名为**资产分析**。新增「指标详解」卡片，由 `src/metricGlossary.js` 提供 **8 个分组 / 41 个指标**，每项固定四段：

| 字段 | 回答什么 |
|---|---|
| `source` | 数据**从哪来**(哪个 Gate 只读端点 / 哪张事实表 / 怎么算出来) |
| `formula` | **计算口径**、单位、时间基准 |
| `meaning` | **走势或数值意味着什么**、方向代表什么、该怎么读 |
| `caveat` | **常见误读与适用边界**(如短窗口年化不可靠、数量效应不是收益) |

同一个数据源同时驱动 `/api/metric-glossary`、前端「指标详解」面板和导出表 `metric_glossary`,第三方拿到 CSV 也能自查每个字段的含义。

### 11.3 每日日报：行情 + 资产 + 对比 + 数据驱动的处置观察

`src/dailyReport.js` 生成四段结构化内容：**① 我的资产**(总资产 / 较上次快照 / TWR / 净现金流 / 回撤 / 成本)、**② 最近行情**(BTC/ETH 等主流币最新价、24h 与区间涨跌、行情异动事件数)、**③ 资产 vs 主流币**(结论、超额、β、稳定币与集中度)、**④ 数据说明**(窗口天数、年化是否可靠、哈希链、采集断点)。

「**资产处置建议**」被实现为**数据驱动的观察 / 复核提示**：只在真实数值触发阈值时生成(样本不足、Top1 集中、稳定币过高/过低、较深回撤、跑赢/跑输、下行捕获 > 上行捕获、摩擦成本、外部现金流、近期事件、数据质量、复盘覆盖不足),每条都附 `basis` 写明依据数值。**不含买卖指令、不臆造新闻、不构成投资建议**。

推送走 `src/wecom.js`：官方 `markdown`(`<=4096` 字节/段)自动按行切分并标注 `(i/n)`,间隔 350ms 远低于 20 条/分钟限制;@ 人用最后一条短 `text` 消息;只允许 `qyapi.weixin.qq.com`,错误信息不携带 webhook 原文,前端与导出只见 `?key=***abcd` 脱敏形式。每篇日报写入 `reports.jsonl`(append-only + 哈希链),可预览、可取全文、可导出。

**启用方式**(webhook 只写服务端 `.env`,不要发到对话里):

```bash
WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx
REPORT_ENABLED=true
REPORT_HOUR=9
REPORT_TZ_OFFSET_HOURS=8
REPORT_PRESET=24H
# WECOM_MENTION_MOBILES=13800000000
sudo systemctl restart gate-asset-monitor   # 改 .env 必须重启才生效
```

或完全绕开内置调度,用 cron + 离线 CLI:`node deploy/daily-report.js --send`(`--preview` 只打印不发送不写历史,`--test` 测连通性)。**未配置 webhook 时日报仍可预览 / 生成 / 存档,只是不推送**(优雅失败)。

### 11.4 v5：把 API 用尽,但只把关键信息放在显眼处

v4 之前只用了 `GET /spot/tickers` 返回的 `last` 和 `currency_pair`,另外 11 个字段(24h 涨跌、高低、买卖一、量、价差…)全部被丢弃;另有 8 个实测可用的只读端点没有接入。v5 把它们全部接上,但**不堆在首页**。

**接了什么**:`/spot/tickers` 全量(约 2160 个交易对)、`/wallet/fee`、`/futures/{settle}/tickers`、`/spot/order_book`、`/spot/open_orders`、`/futures/{settle}/positions`、`/margin/accounts`,聚合写入**低频** `enrichment.jsonl`(跟随 `PRICE_SAMPLE_EVERY`,约每小时一条,3–8KB/条),导出成 9 张表(见 §2.2)。

**排版原则**(直接对应「不常用数据别占醒目位置」):
- **不新增 tab**。总览页 hero 下方只有一条**细的摘要条**——「全市场 570 涨 / 593 跌(上涨占比 48%) · 我的持仓 24h −1.2% · 大盘中位 −0.3% · 弱于大盘」。
- 其余全部塞进**默认收起**的「更多数据 · 扩展行情明细」折叠面板;展开才拉取(懒加载),内含 6 个指标小卡 + 宽度趋势 sparkline + 10 张表格。
- 30 秒轮询只拉 `/api/enrichment?view=headline`(小对象);完整 `depth/tables` 在 `/api/analytics?view=compact` 里被主动剥离,避免轮询拖慢页面。

**错误隔离**(不再制造顶部红条):每个可选子请求单独 try/catch,失败只写 `lastEnrichNotes` 和记录内的 `notes`;**绝不进入 `state.lastError`**,也绝不中断快照。未开通 BTC 本位合约导致的 `USER_NOT_FOUND` 因此静默降级。

**关键口径与读法**(完整 8 条见 `/api/metric-glossary` 的「扩展行情数据」分组):
- **上涨占比**:仅统计 `*_USDT` 计价对,避免重复计数。>60% 偏普涨、<40% 偏普跌;上涨占比升而中位涨跌仍为负 = 少数币拉抬。
- **组合相对强弱**:组合 24h(按估值加权,稳定币记 0) − 全市场中位;附覆盖率,覆盖率低说明有持仓无对应 ticker(理财/合约)。
- **名义费率 vs 实扣**:`/wallet/fee` 是定价表,账本 `fee` 事件是账单;含 GT 抵扣/返佣/币对差异,**不做机械相减**。
- **资金费/基差/持仓量**:年化 = 当期费率×3×365,只是量级参考。
- **资金利用率**:冻结占比按**估值加权**(不把 BTC 与 DOGE 的原始数量相加);借款/总资产升 = 杠杆在加。
- **强平距离** = |标记价−强平价| ÷ 标记价。
- **充提链**:从账本备注解析链名,`UNKNOWN` 表示未标注(不等于没有链)。

**日报**只增加一小段「五、扩展数据速览」共 3 行(市场宽度 / 持仓 24h vs 大盘 / 资金占用),长尾明细仍留在导出中心。

---

## 12. 开发与测试

```bash
npm test          # node:test,79 条断言,无需 npm install
npm run check     # 关键模块加载冒烟测试
node --check src/server.js   # 单文件语法检查
```

- **测试全部用临时 `DATA_DIR` 隔离**,不会碰 `.env`、`data/` 或生产数据;测试身份也由环境变量注入。
- CI 在 push / PR 到 `main` 时跑 Node 18 / 20 / 22 三个版本:全量语法检查 → 79 条单测 → 离线导出 CLI 冒烟(校验 ZIP 可解压、34 张表、manifest 一致)。
- 关键不变量被测试钉死:**现金流不能算成收益**、**归因残差必须闭合**、**as-of 不能用未来数据**、**哈希链篡改必被发现**、**导出 34 表且字典与 schema 一致**。改公式前先跑测试。
- 本地开发建议 `mock` 模式 + 独立 `DATA_DIR`;没有 Gate 密钥也能跑通全部视图、日报预览和导出。
- 版本演进见 [`CHANGELOG.md`](CHANGELOG.md);指标口径以 [`docs/METRICS.md`](docs/METRICS.md) 为准。

---

## 13. 免责与口径说明

- 本工具**只做资产查看、分析与导出,不提供任何投资建议、买卖判断或仓位建议**;日报中的「资产处置观察」是基于真实数值阈值的复核提示,不是交易信号。企业微信机器人 webhook 与 Gate 密钥同属服务端机密,不下发前端、不进日志与导出。
- `mock` 模式全部为确定性模拟数据并显著标注 `DEMO`,不代表真实资产或真实行情。
- `live` 模式的数值来自 Gate.io API v4 你的账户真实返回;估值口径以 Gate 官方 `total_balance` 折算为准;隐含单价由 `valueUsd/qty` 反推,不是独立行情价(独立行情见 `prices` 表)。
- **口径要点**:总资产涨幅 ≠ 投资收益(需现金流剥离);比较策略表现用 `nav.twr`;归因里的数量效应是加减仓、不是收益;短窗口年化指标不可靠;空值代表不可计算、不代表 0。市场对比用 as-of 对齐防止前视偏差,超额为百分点算术差;事件为人工标注/自动检测/DEMO,**不是新闻事实**。完整定义见 [`docs/METRICS.md`](docs/METRICS.md)。
- 加密资产波动大,数据仅作记录与参考,决策请自行判断并注意风险。导出为敏感财务数据,请仅在可信环境(Tailscale 私网)内保存与传输。
