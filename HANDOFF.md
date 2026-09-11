# OpenBidKit 项目交接文档

> 交接时间：2026-09-10 08:31（北京时间）| 交接人：ZCode Agent | 远端 main = `de43f0d`

---

## 一、项目概览

**OpenBidKit（易标投标工具箱）**：面向中国投标从业者的 AI 标书生成桌面应用。

- **桌面客户端**：Electron 41 + Vite 7 + React 19 + TypeScript + better-sqlite3
- **服务端**：Cloudflare Workers（免费套餐）+ D1 ×2 + KV + R2 ×2 + Analytics Engine
- **仓库**：`https://github.com/courtrts/OpenBidKit_Yibiao_CF.git`（远端名 `mine`，分支 `main`）
- **本地路径**：`D:/temp/temp/OpenBidKit`

### 核心业务流程
导入招标文件 → 条款解析/评分分析 → 生成大纲 → 全局事实设定 → 生成技术方案正文 → 废标检查/查重/可行性报告 → 导出 Word

### 目录结构
```
client/                    # Electron 桌面客户端
  electron/                # 主进程（main.cjs、services/、ipc/）
  src/                     # 渲染进程（React 19 + TS）
    app/                   # AppShell、AppRouter、providers
    components/            # 共享组件（Sidebar、AppShell）
    features/              # 功能模块（technical-plan、rejection-check、
                           #   duplicate-check、feasibility-report、
                           #   export-format、settings、knowledge-base）
    shared/                # 共享 UI、类型、工具
  styles/                  # CSS（tokens.css 设计令牌 + 功能样式）
analytics/                 # 服务端
  worker/src/              # CF Worker 源码（34 个 JS 文件）
    routes/                # 路由处理器
    services/              # 业务逻辑层
    utils.js http.js       # 工具与 HTTP 封装
  analytics-migrations/    # D1 迁移（0012/0013 为本轮新增）
  dashboard/public/        # 管理台静态站（vanilla JS）
.zcode-progress.md         # 迭代进度文件（每轮更新）
```

---

## 二、构建 / 测试 / 部署命令

```bash
# 客户端（在 client/ 目录下）
npm run build                    # tsc --noEmit + vite build
npm run dev                      # 并发启动 vite + electron（开发模式）
npm run smoke:electron-native    # electron 原生模块冒烟测试
node --test electron/ipc/*.test.cjs electron/services/*.test.cjs \
     src/features/*/exportState.test.cjs   # 23 个单元测试

# 服务端（在 analytics/worker/ 目录下）
for f in src/routes/*.js src/services/*.js src/utils.js src/http.js src/index.js; do
  node --check $f; done                          # 语法检查
npx wrangler deploy                              # 部署到 CF Workers

# 管理台（在 analytics/dashboard/ 目录下）
cd analytics/dashboard && node ../worker/node_modules/wrangler/bin/wrangler.js deploy
```

### 线上端点
- API：`https://toubiao.ztok.dpdns.org`（自定义域）
- 管理台：`https://admin.toubiao.ztok.dpdns.org`
- ADMIN_TOKEN：存在 worker Secret 中（不在代码里）

---

## 三、远端当前状态

| 项 | 值 |
|----|-----|
| 远端 main | `de43f0d` |
| worker 最新版本 | `0da3d6ba` |
| dashboard 最新版本 | `2ab2d4da` |
| 工作区 | 与远端零差异 |
| build / 23 tests / smoke / dev | 全绿 |
| 线上 health/overview/latest/plugins/resources/dashboard | 全 200 |
| 未授权访问 | 401 正确拒绝 |

---

## 四、已完成迭代摘要（R12–R35）

每轮均走完"三全新审计→方案+收益评估→复核→实施→统一测试→推送→远端验证"完整闭环。

### 安全加固
- 管理台 `_headers`（CSP/nosniff/DENY/Referrer-Policy）
- `requireAdmin` 常数时间比较
- `/license/activate` 付费计划需管理员令牌
- 诊断上传 Content-Length 预检（95MB→10MB）
- Markdown 链接协议白名单 + img src 约束 + 内联 style 黑名单
- HTML→DOCX 递归 50 层深度限制
- 离屏渲染 HTML 消毒（剥离 script/事件属性）
- 插件配置路径校验、JSON.parse 容错
- notice enabled 布尔归一、资源图片校验 400

### 可靠性
- taskService 订阅去重 + get-active 回显自激循环切断
- 退出链路 8 秒超时兜底
- 暂停/取消竞态修复（abort 后静默返回）
- 插件市场请求 60s 超时、更新源重定向 5 跳上限
- 远程图片 fetch 15s 超时 + 20MB 体积上限
- HTML→DOCX 递归 50 层深度限制 + 单小节降级
- 导出写盘 temp+rename 原子化
- GPU 探测文件清理时机修复
- theme.ts matchMedia 单例修复
- 可研审校失败改增量续跑（不清空全部正文）
- AI 队列暂停拒绝统一落 paused 终态
- ErrorBoundary 根级边界
- /track 原子写 + JSON 解析 400

### 统计一致性
- AE 查询原生 timestamp 裁剪（分区裁剪）
- /api/clients 复合索引（迁移 0013）
- /api/latest 采样加权（SUM vs COUNT）
- /track JSON 解析 400 与原子写
- model-usage 排序 tie-break
- 资源点击项目过滤修复（365d 边界）
- 资源点击重算分页全量键列表（修复 LIMIT 500 截断）
- 禁用公告 enabled=1 条件
- agent_error 配额对账（catch-up 末尾）
- 模型索引负缓存修复

### 用户体验
- 后台任务托盘 + 系统通知 + 内联暂停 + 已运行时长
- 快捷键 Ctrl+S / Alt+←→ / ? 速记面板（侧边栏入口）
- 目录相似度卡片前置（查重）
- 废标风险项/逻辑谬误一键复制
- 废标结果完整性提示（丢弃条目计数）
- 导入/移除招标文件级联确认
- 全局事实删除/切组确认
- 正文"永不丢稿"（切节点自动保存+失败暂存恢复）
- 模型未配置引导条（直落 text-model tab）
- 可研阶段文案精确化（审校≠生成）
- SourcesPage 读取三态
- 深色模式全面修复（壳层/弹窗/共享组件/上传板/toast/工具条）
- 进度条 progressbar aria 语义
- ErrorBoundary 根级边界
- 重开应用恢复上次工作板块

---

## 五、关键文件索引

### 客户端核心
| 文件 | 说明 |
|------|------|
| `client/electron/main.cjs` | 主进程入口（窗口/GPU/退出链路/单实例锁） |
| `client/electron/services/taskService.cjs` | 任务状态机（订阅/暂停/恢复/checkpoint） |
| `client/electron/services/aiService.cjs` | AI 供应商调用（重试/队列/流式） |
| `client/electron/services/exportService.cjs` | Word 导出（cheerio+docx） |
| `client/electron/services/technicalPlanStore.cjs` | 技术方案 SQLite 持久化 |
| `client/electron/services/feasibilityReportTasks.cjs` | 可研报告任务（生成/审校/暂停） |
| `client/electron/services/configStore.cjs` | 配置读写（原子写/normalize） |
| `client/src/app/AppShell.tsx` | 应用外壳（快捷键/引导条/托盘挂载点） |
| `client/src/features/technical-plan/pages/TechnicalPlanHome.tsx` | 五步流程主页 |
| `client/src/features/technical-plan/pages/ContentEditPage.tsx` | 正文编辑（永不丢稿/快捷保存） |
| `client/src/shared/ui/MarkdownRenderer.tsx` | Markdown 渲染（安全白名单） |
| `client/src/shared/shortcuts/appShortcuts.ts` | 全局快捷键分发 |
| `client/src/app/BackgroundTaskTray.tsx` | 后台任务托盘（通知/暂停/计时） |
| `client/src/app/ErrorBoundary.tsx` | 根级错误边界 |

### 服务端核心
| 文件 | 说明 |
|------|------|
| `analytics/worker/src/index.js` | 路由表（safe() 兜底） |
| `analytics/worker/src/http.js` | json()/safe()/rejectOversizedBody()/requireAdmin |
| `analytics/worker/src/utils.js` | sqlString/businessDate*/shouldSkipDuplicateWrite |
| `analytics/worker/src/routes/latest.js` | AE 采样加权 + eventTime 别名 |
| `analytics/worker/src/services/analyticsStatsStore.js` | 汇总/rollup/统计查询 |
| `analytics/worker/src/services/licenseStore.js` | license 配置（布尔归一） |
| `analytics/worker/src/routes/track.js` | 埋点接收（413/原子/JSON 400） |
| `analytics/worker/analytics-migrations/` | D1 迁移（0012/0013 为本轮新增） |

---

## 六、剩余待办（按优先级）

### P2（建议下轮优先）
1. **可研 ContentPage 暂停/失败文案统一**——ContentPage.tsx 暂停 toast 和章节失败标题在审校阶段仍写"正文生成"（已部分修复，确认全部覆盖）
2. **ExportFormatPage 本地 withExportFormatDefaults 收敛**——仍有本地重复定义，应完全使用共享 exportFormatNormalize 模块
3. **pluginStore sync 快照竞态**——sync 循环期间删除插件会被复活（需 skipIfMissing 选项）
4. **agent error 删除路径配额回滚与实际删除行数脱钩**——需 DELETE...RETURNING 按实际行扣减

### P3（可延后）
5. 时间颗粒度统一（三处各自复制 formatDuration，应抽共享 formatter）
6. 可研 ContentPage 暂停/失败文案的 tray 托盘入口矛盾（PAUSABLE_TASK_TYPES 需核实主进程真实能力）
7. SettingsPage 保存按钮 Tab 名说明（保存范围跨 Tab 但文案未提及）
8. SettingsPage 危险开关视觉区隔（GPU/开发者模式无 warning 变体）
9. SettingsPage 占位死控件清理（显示语言/侧边栏布局为 disabled 假控件）
10. notice.js offline license 签发过期日期双源（已部分修复，需回归验证）
11. 可研章节状态按标题匹配同名章节（activeNodeId 已实现待回归验证）
12. StartupAdvertisementDialog 死代码删除
13. ExportFormatPage 本地重复的 withExportFormatDefaults 彻底删除

### 架构级（天级改造，需排期）
- 文档转换/Word 导出迁出主线程（utilityProcess）
- cron AE 查询按键集分页拉取
- 插件 ed25519 签名体系
- kill-switch 独立域名 + 降级提示
- 模板 config 归一化推广至 ContentPage config.load

---

## 七、关键约束（必须遵守）

1. **严禁把真实凭据提交进仓库**（ADMIN_TOKEN、ACCOUNT_ID、ANALYTICS_API_TOKEN 均为 Secret）
2. **严禁削弱埋点/统计/聚合语义**（/track、rollup、overview 等）
3. **AE SQL 是 ClickHouse 系受限子集**：聚合内无 CASE WHEN/nullIf、if() 分支同型、无 uniqExactIf、裸 timestamp 不能 ORDER BY、原生比较用 toDateTime(x,'UTC')
4. **免费套餐限制**：10ms CPU、单 cron、约 10 万 D1 写/天、D1 读 5M/天
5. **Electron 信任边界**：Renderer/preload/Main/内部 IPC 属本机可信边界，不要层级间重复校验
6. **Worker 免费版 wrangler 4.129.0**；`wrangler tail` 不支持
7. **部署顺序**：worker `npx wrangler deploy` → dashboard `node ../worker/node_modules/wrangler/bin/wrangler.js deploy`（dashboard 单独 Workers 项目）
8. **AE 数据保留 90 天**——时间窗口计算需考虑此约束

---

## 八、Git 工作流

```bash
# 推送流程（每轮迭代结束后）
git read-tree cf-remote          # 同步 index 到远端状态
git add <修改的文件>              # 逐个添加
T=$(git write-tree)              # 写树
C=$(git commit-tree $T -p cf-remote -m "提交消息")
git update-ref refs/heads/cf-remote $C
git push mine cf-remote:main
git ls-remote mine main          # 验证远端

# 注意：
# - cf-remote 是本地跟踪分支，mine 是远端名
# - git read-tree 只同步 index，不影响工作区
# - git status --porcelain 对比的是 HEAD(996eb3f)，不是 cf-remote
# - 真正的未提交检查用: git diff cf-remote --stat
```

---

## 九、注意事项

1. **机器时钟不稳定**（VM 时间同步问题），`date` 输出可能跳变，以线上巡检为准
2. **wrangler deploy 偶发网络失败**——重试即可；`npx wrangler` 可能遇到 EBUSY 缓存锁，用 `node ../worker/node_modules/wrangler/bin/wrangler.js deploy` 绕过
3. **AE SQL API 直连测试**可用 OAuth token 从 `C:/Users/Administrator/AppData/Roaming/xdg.config/.wrangler/config/default.toml` 获取后 POST 到 `https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql`
4. **`git status --porcelain` 对比的是 HEAD(996eb3f) 而非 cf-remote**——检查未提交改动要用 `git diff cf-remote --stat`
5. **`git add` 多文件时若有一个路径不存在会静默跳过整组**——务必在 `git add` 后用 `git diff --cached --stat` 验证
