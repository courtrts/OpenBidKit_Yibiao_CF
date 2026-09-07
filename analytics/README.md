# 埋点统计部署手册

本目录维护 `Cloudflare Workers + Analytics Engine + D1 + KV + R2 + Cron Triggers + Workers Static Assets` 埋点统计、Agent 异常日志、模型信息缓存和管理服务。公开仓库不保存 `ACCOUNT_ID`、`ADMIN_TOKEN`、`ANALYTICS_API_TOKEN` 等密钥。

## 地址

| 项目 | 地址 |
| --- | --- |
| API | `https://toubiao.ztok.dpdns.org` |
| Dashboard | `https://admin.toubiao.ztok.dpdns.org` |
| 插件包公网下载（R2 Public Development URL） | `https://pub-e7a765184e924c72a1dbe429d9bf181c.r2.dev` |

当前部署所在 Cloudflare 账户为 **Workers Free 免费套餐**（2026-09-07 实测：自定义域名路由、单 Cron Trigger、Analytics Engine 查询/写入均在免费额度内正常运行）。套餐在 Cloudflare 账户侧生效，`wrangler.jsonc` 不存在需要声明的套餐字段。

## 免费套餐（Workers Free）部署说明

`wrangler.jsonc` 当前为**免费套餐形态**：Cron Trigger 由原来的 6 个（5 个埋点统计 + 1 个模型信息同步）合并为 **1 个**（`0 17 * * *` UTC = 北京时间 01:00）。两个 Worker 保留自定义域名路由（API → `toubiao.ztok.dpdns.org`，Dashboard → `admin.toubiao.ztok.dpdns.org`）；免费套餐下 Workers 自定义域名已实测可用（Cloudflare 自动创建代理 DNS 记录，橙色云，无额外费用）。适用条件与限制：

### 免费套餐限额对照（官方文档，2026-09-07 抓取核对）

| 资源 | 免费套餐限额 | 本项目消耗路径 |
| --- | --- | --- |
| Workers 请求 | 100,000 次/天（UTC 0 点重置，超限返回 Error 1027） | 全部 HTTP 接口（每日仅 1 次 cron，其是否计入该额度官方 limits 页未明确说明；即使计入也可忽略不计） |
| Workers CPU | **10ms/次调用**（HTTP 与 cron 相同） | 见下方逐路径审计 |
| Cron Trigger | 5 个/账号 | 当前 1 个 |
| Analytics Engine 写入 | 100,000 数据点/天（当前不计费） | 每次 `POST /track` 写 1 个数据点 |
| Analytics Engine 查询 | 10,000 次/天（当前不计费） | cron 汇总约 10~11 次/天/项目；dashboard 每次打开数据页 1~3 次 |
| KV 读 / 写 / 删 / list | 100,000 / 1,000 / 1,000 / 1,000 次/天；存储 1GB | 公告、模型信息缓存、GitHub stats 缓存、模型目录源配置 |
| D1 行读 / 行写 | 5,000,000 / 100,000 次/天；存储 5GB | `stats_*` 实时入库 + cron 汇总写入 + 管理端查询 |
| R2 | 存储 10GB；Class A 100 万次/月；Class B 1000 万次/月 | 插件安装包、资源图片、Agent 异常包（7 天生命周期） |
| Queues | 10,000 次操作/天 | 本项目**未使用** Queues，不涉及 |

（来源：developers.cloudflare.com/workers/platform/pricing/、/workers/platform/limits/、/workers/analytics-engine/pricing/）

### 逐路径 CPU 审计（10ms/次调用预算）

CPU 时间只计 Worker 实际执行 JS 的时长，**等待 D1/AE/KV/R2 I/O 的挂起时间不计入**（官方文档："CPU time" 定义）。据此逐路径核对：

| 路径 | 主要 CPU 消耗 | 评估 |
| --- | --- | --- |
| `POST /track` | 小 JSON parse、内存去重（60 秒窗口）、条件性 D1 写入（见下方规模上限推导）；AE 写入为 fire-and-forget 不等响应 | 单次远小于 1ms，安全 |
| `POST /license/activate`、`/offline-license` | ECDSA P-256 `importKey` + `verify`（WebCrypto） | 亚毫秒级，安全 |
| 公开 GET（`/model-info`、`/notice`、`/ip-blocks`、`/github-repo-stats`、`/plugins` 等） | KV/D1 读 + 小 JSON 序列化 | 单次远小于 1ms，安全 |
| 管理端数据页（`/api/overview`、`/api/traffic`、`/api/model-usage` 等） | AE REST 查询的响应 JSON.parse + 行映射（结果集有 `LIMIT`，上限 100,000 行） | 正常查询结果行数小，安全；异常大结果集时才可能逼近预算 |
| **cron 每日汇总（唯一风险点）** | 10 个阶段串行：每阶段 1~2 次 AE REST 查询（JSON.parse 响应）+ 行映射 + D1 分块写入（`JSON.stringify` 分块）。**I/O 等待不计 CPU**，CPU 取决于各阶段当日结果行数 | 小规模部署（每阶段当日去重结果数百行以内）预计数毫秒内完成；若单项目当日数据量很大（某一阶段 GROUP BY 结果接近万行级），单次 cron 可能超过 10ms |

**cron CPU 超限时的兜底**（按优先级）：

1. **拆回 5 个 rollup cron**（仍满足免费套餐 5 个上限）：把 `wrangler.jsonc` 的 crons 恢复为 `0 17 / 30 17 / 0 18 / 30 18 / 0 19 * * *`，并把 `src/index.js` 的 `scheduled()` 恢复为按 cron 字符串分发（`ROLLUP_CRON_STAGES` 与 `rollupYesterdayCronStage` 代码仍保留，每段 cron 各自拥有独立的 10ms 预算，阶段间有时序依赖保护）。模型同步 cron 保持移除（见下）。
2. 若仍超限：升级付费套餐（$5/月，cron CPU 上限 30 秒（间隔 <1h）/ 15 分钟（间隔 ≥1h））。
3. 监控依据：Cloudflare dashboard 的 Workers CPU 用量指标；cron 超限被终止时，未完成的阶段因无成功标记会在下次 cron 由 `catchUpIncompleteRollups` 补跑（不会重复累计）。

### 免费额度规模上限推导（代码 + 上方官方限额计算，非估算）

- **AE 写入上限（逐事件硬上限）**：每次 `POST /track` 无条件写 1 个 AE 数据点（`writeAnalyticsDataPoint`，fire-and-forget、无去重）。免费额度 100,000 数据点/天 → **日事件量必须低于约 10 万条**，这是免费部署最可能先触顶的配额。
- **D1 写入上限（随并发活跃客户端数线性增长）**：客户端所有 track 事件都附带授权字段（客户端 `analytics.ts` 的 `sendAnalytics` 固定写入 `license_status` 等 5 个字段，已核对）；服务端 `recordTrackClient` 对带授权快照的事件按 `(项目, 客户端, 授权字段值)` 键做 60 秒内存去重（`RECENT_CLIENT_WRITE_ATTEMPT_TTL_MS = 60000`）后执行 1 条 D1 `UPDATE`。因此 D1 写入速率 ≈ 并发活跃客户端数 × 每分钟 1 次。免费额度 100,000 行写/天 ÷ 1440 分/天 ≈ **约 69 个并发活跃客户端（按每客户端每分钟 ≥1 事件的最高频假设）**；事件间隔越大（如每 10 分钟 1 次），上限相应放大约 10 倍。新客户端（创建 ≤1 天）首次入库另有 ≤3 条 D1 语句（一次性）。
- **注意**：上述 60 秒去重窗口是 isolate（区域）级内存，同一客户端若同时命中多个区域会按区域数放大写入；`recentClientWriteAttempts` 上限 10,000 键，超出时清空重计。
- 结论：免费套餐适合日事件量 <10 万、并发活跃客户端数十到数百量级的部署；超过后升级付费（D1 5,000 万行写/月、AE 1,000 万数据点/月）。

1. **合并为什么是安全的**：每日汇总的 10 个阶段（discover/daily/clients/pages/versions/configs/models/agents/retention/resources）在项目级、阶段级、分块级都有 `stats_rollup_runs` / `stats_rollup_stages` 成功标记，单 cron 中途被中断不会重复累计；`catchUpIncompleteRollups`（保留 3 个业务日窗口）在次日 cron 中自动补跑不完整的数据日。`scheduled()` 内 4 个步骤独立 try/catch，单步失败不阻塞后续。
2. **模型目录同步不在 cron 内**：`models.dev/api.json` 约 4.3MB（2026-09-07 实测 4,495,456 字节、213 供应商、7560 模型），单次 `JSON.parse` 本地实测 5 次平均约 23ms CPU（随机器性能在 20~40ms 区间变化，此前一轮实测 36ms），必然超出免费 10ms 预算，因此从 cron 移除。免费部署下 `/model-info` 返回 503、客户端回退手动录入模型参数（功能降级但不阻断）；管理员可随时通过 dashboard"立即同步"按钮（`POST /api/model-info-cache`）手动同步，`syncModelInfoCache` 等函数仍保留在服务代码中。
3. **模型目录源可配置**：同步源地址优先级为 管理端 KV 设置（dashboard"模型目录源"）> 环境变量 `MODEL_INFO_SOURCE_URL` > 内置默认 `https://models.dev/api.json`；配置界面保存时做 SSRF 校验（仅 http/https、拒绝回环/内网/元数据地址）。
4. **域名**：当前免费部署已启用 Workers 自定义域名（2026-09-07 实测：免费套餐下 `custom_domain` 路由可用，Cloudflare 自动创建代理 DNS 记录，无额外费用）：API → `toubiao.ztok.dpdns.org`，Dashboard → `admin.toubiao.ztok.dpdns.org`，插件包公网下载 → `https://pub-e7a765184e924c72a1dbe429d9bf181c.r2.dev`（R2 Public Development URL，代码默认值，可用环境变量 `PLUGIN_PACKAGE_PUBLIC_BASE_URL` 覆盖）。客户端各接口（track / notice / license / plugins / resources / ip-blocks / model-info / agent-errors）与 dashboard 的 `public/src/api.js` `productionApiBase`、`public/index.html` 默认值均指向 `toubiao.ztok.dpdns.org`；其中 `licenseService.cjs` / `agentErrorReporter.cjs` 另支持环境变量覆盖（`YIBIAO_LICENSE_ENDPOINT` / `YIBIAO_AGENT_ERROR_ENDPOINT`）。仍引用遗留域名、本次未迁移的是 `wiki.agnet.top`（用户指南、问题检索 API）与 `oss.agnet.top`（图片），自部署时需替换为自己的域名。
5. **需实测项**（无法仅凭源码/文档确认）：① cron 汇总在实际数据量下的真实 CPU 耗时（需部署后看 Cloudflare 监控）。~~② 免费账号能否绑定 Workers 自定义域名~~——已实测可以（见第 4 条）。
6. **恢复付费/生产配置**：crons 恢复为 `0 17 / 30 17 / 0 18 / 30 18 / 0 19 / 0 20 * * *`（UTC，含模型同步），恢复自定义域名路由，并把 `src/index.js` 的 `scheduled()` 恢复为按 cron 字符串分发（`rollupYesterdayCronStage` / `OVERVIEW_AI_TOTALS_CRON` / `MODEL_INFO_SYNC_CRON` 相关代码仍保留）。

## 数据源

| 数据源 | Binding | 用途 |
| --- | --- | --- |
| Analytics Engine `agnet_analytics` | `ANALYTICS` | 详细事件、今天/7天/30天查询、最近事件、Cron 汇总来源 |
| D1 `openbidkit-analytics` | `ANALYTICS_DB` | 新版 `stats_*` 长期统计表和全局 IP 封禁状态 |
| D1 `openbidkit-resources` | `RESOURCE_DB` | 资源管理元数据 |
| R2 `openbidkit` | `RESOURCE_BUCKET` | 资源图片、插件当前版与上一版安装包 |
| R2 `openbidkit-agent-errors` | `AGENT_ERROR_BUCKET` | gzip Agent 完整失败诊断包，保留 7 天 |
| KV | `NOTICE_STORE` | 公告、授权配置、GitHub stats 缓存和模型信息精简索引；旧 IP 封禁列表仅用于一次性迁移 |

`openbidkit-analytics` 可以在改版时直接删除并由 `setup:analytics-storage` 重建；删除后异常日志元数据会丢失，R2 孤立对象仍由 7 天生命周期自动清理。不要删除 `openbidkit-resources`。

## 接口

| 接口 | 数据源 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `GET /health` | Worker | 无 | 健康检查 |
| `POST /track` | AE + D1 | 无 | 写 AE；从 Cloudflare 真实客户端 IP 请求头记录客户端 IP；新客户端按 `client_created_at` 窗口实时入库，授权字段按快照覆盖既有 `stats_clients` |
| `GET /ip-blocks` | D1 + Worker | 无 | 返回全局封禁 IP 列表和 Cloudflare 观测到的请求公网出口 IP，供客户端启动后静默检查 |
| `GET/POST/DELETE /api/ip-blocks` | D1 + AE | `ADMIN_TOKEN` | 管理全局精确 IP 封禁；POST 原子写封禁、删除客户端明细并写防回填标记，DELETE 原子解除封禁并释放标记 |
| `GET/POST /agent-errors` | D1 + R2 | GET 无；POST 有效可信 license | GET 供客户端预检开关、版本和容量；POST 仅在预检条件仍满足时保存 gzip Agent 失败诊断包 |
| `GET /api/projects` | D1 优先，AE 兜底 | `ADMIN_TOKEN` | 项目列表 |
| `GET /api/overview` | D1 + AE + KV | `ADMIN_TOKEN` | 概览总数、文本 Token、生图次数、新增、今日活跃、每日统计 |
| `GET /api/clients` | D1 | `ADMIN_TOKEN` | 客户端统计列表 |
| `GET /api/client-detail` | AE | `ADMIN_TOKEN` | 单客户端 7天/30天/全部事件明细 |
| `GET /api/ip-stats` | D1 或 AE | `ADMIN_TOKEN` | `date` 可选；无日期按全部客户端当前最后访问 IP 汇总，指定日期时按当天最后访问 IP 汇总，并返回新客户端数、Total Tokens、AI 服务商和 endpoint host |
| `GET /api/traffic` | D1 或 AE | `ADMIN_TOKEN` | 访问分析，`range=history/today/7/30` |
| `GET /api/config-usage` | D1 或 AE | `ADMIN_TOKEN` | 配置使用，`range=history/today/7/30` |
| `GET /api/model-usage` | D1 或 AE | `ADMIN_TOKEN` | 模型使用，支持 `provider/endpointHost/model` 筛选 |
| `GET /api/agent-runtime` | D1 或 AE | `ADMIN_TOKEN` | Agent 总体、运行时、模型维度的成功率、失败率、重试率和重试后成功率，`range=history/today/7/30` |
| `GET/DELETE /api/agent-errors` | D1 + R2 | `ADMIN_TOKEN` | 分页读取异常元数据，或单条/批量删除日志 |
| `GET/POST /api/agent-errors/config` | D1 | `ADMIN_TOKEN` | 管理接收开关和精确版本号列表，查看 2 GiB 容量使用情况 |
| `GET /api/agent-errors/download` | D1 + R2 | `ADMIN_TOKEN` | 下载单份 `.json.gz` 完整诊断包 |
| `GET /api/latest` | AE | `ADMIN_TOKEN` | 最近事件，支持 `event` 筛选 |
| `GET /api/retention` | D1 | `ADMIN_TOKEN` | 留存概览，读取 Cron 生成的最新 30 天快照 |
| `GET /api/github-repo-stats` | GitHub + KV | `ADMIN_TOKEN` | GitHub stats |
| `GET /notice` | KV | 无 | 客户端公告 |
| `GET /model-info` | KV | 无 | 按 `modelName` 返回最终生效的思考强度、最大 context/output 和缓存时间，人工覆盖优先 |
| `GET/POST/DELETE /api/notice` | KV | `ADMIN_TOKEN` | 公告后台管理 |
| `GET/POST /api/model-info-cache` | KV + 可配置目录源 | `ADMIN_TOKEN` | 分页查看模型详细索引或手动同步，GET 支持 `q/scope/page/pageSize`；POST 从当前生效的目录源（默认 models.dev）同步 |
| `GET/POST /api/model-info-cache/source` | KV | `ADMIN_TOKEN` | 读取/保存模型目录源地址（支持任意第三方或自部署的 models.dev 兼容目录），POST 传空表示清除回退 |
| `POST/DELETE /api/model-info-cache/override` | KV | `ADMIN_TOKEN` | 保存单条模型人工覆盖，或按 `modelName` 恢复自动同步值 |
| `POST /license/activate` | KV + Worker Secret | 无 | 客户端免费授权签发，返回带签名 license |
| `GET/POST /api/license-config` | KV | `ADMIN_TOKEN` | 授权配置后台管理 |
| `GET /resources` | `RESOURCE_DB` + AE | 无 | 客户端资源列表，点击量为 D1 累计 + AE 今天 |
| `GET/POST/DELETE /api/resources` | `RESOURCE_DB` + R2 + AE | `ADMIN_TOKEN` | 资源管理 |
| `GET /plugins` | `RESOURCE_DB` + R2 | 无 | 插件市场列表，当前版作为升级目标，同时返回保留的上一版信息和地址 |
| `POST /plugins/download` | `RESOURCE_DB` | 无 | 累计插件成功下载次数 |
| `GET/POST/DELETE /api/plugins` | `RESOURCE_DB` + R2 | `ADMIN_TOKEN` | 插件管理；新增、更新和删除会同步维护 R2 安装包 |
| `POST /api/plugins/sync` | GitHub + `RESOURCE_DB` + R2 | `ADMIN_TOKEN` | 从 GitHub 正式 Release 同步全部插件，并清理 R2 历史版本和孤立对象 |

旧 `/api/summary` 已删除。

除 `/ip-blocks` 和 `/api/*` 管理接口外，Worker 会在路由处理前检查请求的 `CF-Connecting-IP`。命中 D1 `ip_blocks` 的公开读取或上传请求直接返回空 `204`，不会读取请求正文，也不会写入 AE、D1 或 R2；D1 读取异常时保持公开服务可用。客户端在正常启动后异步调用 `/ip-blocks`，只有返回成功、出口 IP 明确且与列表精确匹配时才结束进程，网络或响应异常不影响正常启动，开发调试模式执行相同检查。

管理端封禁 IP 时，无日期按 `stats_clients.last_access_ip` 匹配当前项目客户端，指定日期先按 AE 中客户端当天最后访问 IP 匹配；AE 查询成功后，通过单个 D1 事务写 `ip_blocks`、删除 `stats_clients` 和 `stats_client_activity`、写 `stats_blocked_clients` 并重算 `stats_totals.total_clients`。版本、每日统计和留存等其他历史汇总不回算，Agent 异常元数据和 R2 诊断包不删除。AE 原始事件保留三个月，但 IP 统计会隐藏仍被封禁的地址；解除封禁通过单个 D1 事务删除封禁和客户端标记，后续埋点最迟在 60 秒实时去重缓存过期后重新采集。

## 统计口径

| 模块 | 口径 |
| --- | --- |
| 历史 | 读 D1，忽略 AE |
| 今天/7天/30天 | 读 AE，忽略 D1 |
| 活跃客户端 | 任意允许事件去重 `client_id` |
| 总客户端数 | D1 `stats_totals.total_clients` |
| 今日/7日新增 | D1 `stats_clients.first_seen_date` |
| 实时客户端入库 | `/track` 只对当前业务日期或前 1 天创建的客户端尝试实时插入并增加总客户端数；授权字段会按客户端授权快照覆盖既有 `stats_clients`；D1 写入失败不影响 `/track` 返回成功；老客户端活跃由 Cron 批量更新 |
| 最后访问 IP | Worker 优先记录 `CF-Connecting-IP`；如果它是 Pseudo IPv4 的 `240.0.0.0/4` 伪地址，则改用 `CF-Connecting-IPv6`；完全忽略 `CF-Pseudo-IPv4`。AE 写入 `blob13`，D1 `stats_clients.last_access_ip` 由新客户端实时入库和每日 Cron 更新 |
| 每日统计 | 今天读 AE，前 9 天读 D1 |
| 最近事件 | 只读 AE，不入 D1 |
| 留存 | Cron 写入 `stats_client_activity` 和固定 30 天 `stats_retention`，页面只读 D1 最新快照，忽略当天数据 |
| 资源点击量 | `RESOURCE_DB.resources.click_count` 保存历史累计，页面查询时加上 AE 今天点击量 |
| 版本客户端数 | D1 历史来自 `stats_clients.last_active_version` 当前分组重算；今天/7天/30天来自 AE 去重客户端数 |
| 模型 Total Tokens | `ai_request` 的 `double4` 按 `_sample_interval` 聚合，历史写入 `stats_models.total_tokens` |
| 概览 AI 指标 | 北京时间 02:30 模型汇总完成后，从 D1 `stats_models` 覆盖刷新 `stats_totals.total_text_tokens` 和 `stats_totals.total_generated_images`；生成图片数沿用生图模型请求次数口径 |
| Agent 执行统计 | 新版 `agent_runtime` 使用 `blob9` v4 复合值聚合运行时、最终状态、Pi 原生模型重试次数、文本模型服务商、endpoint host 和模型名；v3 历史结果修复次数保留在独立列，不与模型重试混算；历史读 D1，今天/7天/30天读 AE |
| 配置使用 | 新版 `config_usage` 使用 `config_key/config_value` 键值对上报；D1 历史保留，AE 旧格式不再兼容 |
| 授权状态 | 客户端上报 `license_status/license_plan/license_expires_at/source_trusted/untrusted_reason`；AE 写入 `blob14-blob18`，D1 `stats_clients` 保存最新状态 |

## 事件类型

| event | 用途 |
| --- | --- |
| `app_open` | 打开次数、留存 |
| `page_view` | 页面访问 |
| `config_usage` | 配置使用 |
| `ai_request` | 模型使用、AI 请求、Token |
| `resource_click` | 资源点击 |
| `agent_runtime` | Agent 执行成功率、失败率、重试率和重试后成功率 |

`config_usage` 使用 `config_key/config_value` 键值对上报，每个配置项一条事件。Worker 从 Cloudflare 真实客户端 IP 请求头读取公网 IP 并写入 `blob13`，客户端不自报 IP；`CF-Pseudo-IPv4` 不参与统计。授权状态写入 `blob14-blob18`，只包含状态、授权类型、有效期日期和可信来源标记，不上传设备原始指纹。`ai_request` 只采集请求类型、服务商、endpoint host、模型名和 token 用量，不采集 API Key、Prompt、响应内容或错误详情。`agent_runtime` 额外接收运行时注册表 ID 和 `agent_runtime_model_retry_count`，新版统计编码到 `blob9=v4|<runtime>|<success|failed>|m<model-retry-count>|<provider>|<host>|<model>`；旧版 v3 的 `r<0-3>` 继续表示结果修复次数并独立汇总，不采集 API Key、任务内容、错误详情、Prompt、输出或本地路径。

`GET /api/agent-runtime` 的 `agentRuntime` 保留总体计数，`retryRate/retrySuccessRate` 按 v4 模型口径任务计算；`runtimes[]` 和 `models[]` 同时返回 `modelRunCount`、模型重试统计及独立的历史结果修复统计。

插件仍以 GitHub 最新正式 Release 为发布上游。Worker 同步时先在 D1 登记发布对象，再把 ZIP 写入 `plugins/.staging/` 临时对象并校验，然后发布到 `openbidkit` R2 的 `plugins/<插件ID>/<插件ID>-v<版本>.zip`；正式对象确认完整后才更新市场下载地址。同版本重复同步会直接复用完整的已发布对象，不覆盖线上包。新版本切换成功后，数据库记录当前版和上一版，R2 每个插件只保留这两个正式版本；全量同步结束会再次清理更早版本、已删除插件和遗留临时对象。插件发布、删除和全局清理通过 D1 租约锁跨 Worker 串行执行，清理前还会逐个检查 30 分钟有效的发布标记，避免删除并发发布中的临时键或正式键。客户端只接收 `https://pub-e7a765184e924c72a1dbe429d9bf181c.r2.dev` 下载地址，市场升级目标始终是最新版，上一版仅用于保障在途下载。

首次部署该分发逻辑后，需要在 Dashboard 的“插件管理”中执行一次“同步全部插件”，把现有 GitHub 下载地址迁移为 R2 地址；迁移完成前，公共插件接口不会向客户端下发尚未镜像的插件。

Agent 异常日志与 `agent_runtime` 埋点完全分离。接收默认关闭；开启后仍必须配置至少一个精确版本号，空列表表示不接收。Worker 在读取正文前检查开关、版本和剩余容量；日志压缩后总占用上限为 2 GiB，达到上限直接丢弃。正文只保存到 `AGENT_ERROR_BUCKET`，D1 只保存元数据和容量计数；日志到期、单条删除或批量删除都会释放容量。上传必须携带 Worker 已签发、来源可信且未过期的 license。

## 首次部署

### 1. Cloudflare 凭据

自动创建 KV/D1/R2 需要在 Cloudflare Workers Build 的构建环境变量中配置：

| 变量 | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 具备 Workers KV、D1、R2 和 Worker 部署权限 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID |

这两个变量不是 GitHub Secrets，也不是 Worker 运行时 Secret；本地手动执行 setup 时，才需要在本机终端临时设置它们。

Worker 运行时还需要在 Cloudflare 后台配置 Secret：

| Secret | 说明 |
| --- | --- |
| `ACCOUNT_ID` | Cloudflare Account ID |
| `ADMIN_TOKEN` | Dashboard 管理 Token |
| `ANALYTICS_API_TOKEN` | Analytics Engine SQL Read Token |
| `OPENBIDKIT_PET_READ_TOKEN` | 插件同步专用 GitHub Fine-grained Token，仅授予 `openbidkit-pet` 仓库 `Contents: Read-only` 权限 |
| `OPENBIDKIT_YIBIAO_METADATA_READ_TOKEN` | 可选，仓库统计专用 GitHub Fine-grained Token，仅选择 `OpenBidKit_Yibiao` 仓库并保留自动授予的 `Metadata: Read-only` 权限 |
| `LICENSE_PRIVATE_KEY_JWK` | ECDSA P-256 私钥 JWK，用于签发客户端 license |
| `LICENSE_KEY_ID` | 可选，授权签名 key id，默认 `official-build-key-2026-01` |

自部署时可通过以下**可选非密钥变量**（`wrangler secret` 之外的普通 env/vars）覆盖内置默认值：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MODEL_INFO_SOURCE_URL` | `https://models.dev/api.json` | 模型目录同步源（models.dev 兼容格式），支持任意第三方或自部署目录；运行时可在 dashboard"模型目录源"直接覆盖（优先级更高） |
| `GITHUB_REPO_FULL_NAME` | `FB208/OpenBidKit_Yibiao` | dashboard 仓库统计指向的 `owner/repo`（自部署 fork 时改为自己的仓库） |
| `PLUGIN_PACKAGE_PUBLIC_BASE_URL` | `https://pub-e7a765184e924c72a1dbe429d9bf181c.r2.dev` | 插件包公网下载基地址（自部署时指向自己的 R2/CDN 公网地址） |

不要在 `wrangler.jsonc` 增加 `secrets.required`。

授权密钥使用 ECDSA P-256 JWK。可在本地用 Node 生成一次密钥对，把私钥 JSON 配置到 GitHub Actions Secret `YIBIAO_LICENSE_PRIVATE_KEY_JWK` 和 Worker Secret `LICENSE_PRIVATE_KEY_JWK`：

```powershell
node -e "const { webcrypto } = require('node:crypto'); (async () => { const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify']); console.log(JSON.stringify(await webcrypto.subtle.exportKey('jwk', key.privateKey))); })();"
```

公钥由客户端发布脚本从私钥 JWK 自动导出并打入安装包，不需要作为 Secret 保存。

### 2. 创建或复用存储

正常部署不需要本地手动执行 setup。Cloudflare Workers Build 执行 `npm run deploy` 时，会由 `deploy-if-changed.mjs` 自动运行：

```powershell
npm run setup:notice-kv
npm run setup:resources
npm run setup:agent-errors
npm run setup:analytics-storage
```

本地手动执行仅用于调试，必须先在本机设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。

`setup:analytics-storage` 会：

| 动作 | 说明 |
| --- | --- |
| D1 | 创建或复用 `openbidkit-analytics`，binding 为 `ANALYTICS_DB` |
| R2 | 复用 `openbidkit` 的 `RESOURCE_BUCKET` 保存资源图片、插件当前版与上一版安装包；创建或复用 `openbidkit-agent-errors`，binding 为 `AGENT_ERROR_BUCKET`，配置 7 天删除生命周期 |
| Cron | 生产账户使用 Workers Paid Plan；确认北京时间 01:00 到 03:00 的 5 个统计 Cron，以及北京时间 04:00 的独立模型信息同步 Cron |
| Migration | 通过 Wrangler D1 migrations 执行 `analytics-migrations/*.sql` 并记录已应用版本；自动补齐统计字段；首次创建 `ip_blocks` 后把旧 KV 封禁记录一次性导入 D1，并用 `ip_block_storage_meta` 防止重复迁移 |

如果刚删除过 `openbidkit-analytics`，脚本会重新创建并更新 `wrangler.jsonc` 的 `database_id`。

模型信息同步从当前生效的目录源（默认 `models.dev/api.json`，可配置为任意第三方或自部署的 models.dev 兼容目录，见“免费套餐部署说明”）提取按模型 ID 聚合的精简索引。思考强度取同名模型明确档位的交集，`context` 和 `output` 分别取同名记录最大值；同步失败不会覆盖最后一次成功索引。**免费套餐下模型同步不挂 cron**（目录体积超出 10ms CPU 预算），由管理员在 Dashboard 手动触发；付费/生产部署可恢复独立 Cron `0 20 * * *`（北京时间每天 04:00）。Dashboard 的“模型信息缓存”页面支持查看详细索引、手动同步和人工修改。人工修改按完整模型记录独立保存在 KV 中，公共查询优先使用人工值，定时或手动同步不会覆盖；点击“恢复默认”后立即删除人工覆盖并重新使用最近一次自动同步值。

### 3. 部署 Worker

API Worker 配置：

| 项目 | 值 |
| --- | --- |
| Worker 名称 | `agnet-analytics-api` |
| Root directory | `analytics/worker` |
| Build command | `npm install` |
| Deploy command | `npm run deploy` |

Dashboard Worker 配置：

| 项目 | 值 |
| --- | --- |
| Worker 名称 | `agnet-analytics-dashboard` |
| Root directory | `analytics/dashboard` |
| Build command | `npm install` |
| Deploy command | `npm run deploy` |

## 验证

健康检查：

```powershell
Invoke-RestMethod -Uri "https://toubiao.ztok.dpdns.org/health"
```

上报测试：

```powershell
Invoke-RestMethod `
  -Uri "https://toubiao.ztok.dpdns.org/track" `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"projectName":"yibiao-client","event":"app_open","version":"0.1.0","platform":"win32","arch":"x64","client_id":"test-client","client_created_at":"2026-06-13"}'
```

如果要验证 `/track` 实时写入 D1 客户端表，`client_created_at` 需要使用当前业务日期或前 1 天日期；否则只写 AE，客户端会由后续 Cron 汇总补入 D1。

查询概览：

```powershell
Invoke-RestMethod `
  -Uri "https://toubiao.ztok.dpdns.org/api/overview?projectName=yibiao-client" `
  -Method Get `
  -Headers @{ Authorization = "Bearer <ADMIN_TOKEN>" }
```

## 历史回填

新版历史回填脚本会按 Cron 同一套逻辑，把 Analytics Engine 中 `yibiao-client` 在脚本执行当天北京时间之前的所有历史日期汇总到 D1 `stats_*` 表；回填会补齐留存所需的 30 天 `app_open` 活动窗口并生成 `stats_retention` 快照；资源点击量会按历史总量写入 `openbidkit-resources.resources.click_count`，不会按天重复累加。

本地执行前，在 `analytics/scripts/.env` 中配置：

| 变量 | 说明 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` 或 `ACCOUNT_ID` | Cloudflare Account ID |
| `CLOUDFLARE_API_TOKEN` | 具备 D1 Query 权限的 Cloudflare API Token |
| `ANALYTICS_API_TOKEN` | Analytics Engine SQL Read Token |
| `ANALYTICS_DB_ID` | 可选；不填则按 D1 名称 `openbidkit-analytics` 自动查找 |
| `RESOURCE_DB_ID` | 可选；不填则按 D1 名称 `openbidkit-resources` 自动查找，用于回填资源累计点击量 |

执行回填：

```powershell
cd analytics\worker
npm run backfill:analytics-stats
```

只补指定日期时使用 `BACKFILL_DATE` 环境变量：

```powershell
cd analytics\worker
$env:BACKFILL_DATE="2026-06-17"
npm run backfill:analytics-stats
Remove-Item Env:\BACKFILL_DATE
```

如果只需要补齐新增的 `stats_versions.client_count` 和 `stats_models.total_tokens` 两个字段，执行：

```powershell
cd analytics\worker
npm run backfill:analytics-stat-fields
```

只根据 D1 已有模型历史统计回填概览 Token 消耗量和生成图片数时，执行独立脚本：

```powershell
cd analytics\worker
npm run backfill:overview-ai-totals
```

注意事项：

| 项 | 说明 |
| --- | --- |
| 项目 | 固定回填 `yibiao-client` |
| 日期 | 默认自动发现 AE 中北京时间今天之前的所有有数据日期；设置 `BACKFILL_DATE=YYYY-MM-DD` 时只处理指定日期 |
| 今天 | 脚本不回填今天，今天/7天/30天仍直接读 AE |
| 留存 | 回填会先补齐回填窗口前 30 天到最后回填日的 `stats_client_activity`，再生成对应 `stats_retention` 快照 |
| 重复保护 | `stats_rollup_runs.status = success` 的日期会跳过 |
| 异常状态 | 已存在 `running/failed` 且没有 `stats_daily` 时会清理状态并重试；如果已有 `stats_daily` 会停止，避免重复累加污染 D1 |
| 临时错误 | AE/D1 对 `429/500/502/503/504` 会自动重试，并打印 HTTP 状态、返回内容和 SQL 片段 |
| 参数 | 脚本不接受命令行参数；指定单日使用环境变量 `BACKFILL_DATE` |
| 补字段脚本 | 只补 `stats_versions.client_count` 和 `stats_models.total_tokens`，不回填资源点击量，不重跑每日统计 |

## 排查

| 问题 | 处理 |
| --- | --- |
| `unauthorized` | 检查 Dashboard 输入的 `ADMIN_TOKEN` |
| `ANALYTICS_DB is not configured` | 确认 Cloudflare Workers Build 已配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，重新触发 API Worker 部署；本地调试时才手动运行 setup |
| 查询为空 | 先确认 `/track` 成功，再等待 AE 写入或第二天 Cron 汇总 |
| 历史总数为空 | 新版 D1 刚重建时没有历史数据，需等待 Cron 或后续回填 |
| 今日/7天/30天为空 | 检查 `ACCOUNT_ID` 和 `ANALYTICS_API_TOKEN` |
| 资源数据异常 | 不要删除 `openbidkit-resources`、`RESOURCE_DB`、`RESOURCE_BUCKET` |

查看 Worker 日志：

```powershell
cd analytics\worker
npx wrangler tail agnet-analytics-api --format pretty
```

## 自动部署触发规则

Cloudflare Workers Builds 会在生产分支推送时触发构建。部署脚本按目录判断是否需要部署：

| Worker | 监听目录 |
| --- | --- |
| `agnet-analytics-api` | `analytics/worker` |
| `agnet-analytics-dashboard` | `analytics/dashboard` |

强制部署可临时设置：

```text
FORCE_DEPLOY=1 npm run deploy
```
