const fs = require('node:fs');
const path = require('node:path');
const {
  getAgentRuntimeDir,
  getGeneratedImagesDir,
  getWorkspaceDir,
} = require('../utils/paths.cjs');
const { getMermaidCacheDir } = require('../utils/mermaidCache.cjs');
const {
  OUTLINE_AGENT_TASK_KEY,
  TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
} = require('./outlineGenerationAgentV2Config.cjs');
const { GLOBAL_FACTS_AGENT_TASK_KEY } = require('./globalFactsAgentV2Config.cjs');
const { FEASIBILITY_OUTLINE_AGENT_TASK_KEY } = require('./feasibilityOutlineAgentConfig.cjs');

const STORAGE_CLEANUP_VERSION = 1;
const PERSISTENT_AGENT_TASK_KEYS = [
  OUTLINE_AGENT_TASK_KEY,
  TEMPLATE_EXTRACTION_AGENT_TASK_KEY,
  GLOBAL_FACTS_AGENT_TASK_KEY,
  FEASIBILITY_OUTLINE_AGENT_TASK_KEY,
];
const LEGACY_WORKSPACE_FILES = [
  'technical_plan.json',
  'duplicate_check.json',
  'rejection_check.json',
];
// 历史清理步骤清单：与 configStore 的 storage_cleanup_failed_steps 持久化列表配套，
// 失败步骤下次启动只重试自己（标签集合是两侧的共同契约）。
const HISTORICAL_CLEANUP_STEP_LABELS = [
  '清理旧 Agent 运行目录',
  '清理普通 Pi 任务归档',
  '清理旧 Agent 缓存',
  '清理废弃工作区状态',
  '清理未引用的旧生图',
];

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function clearDirectoryExcept(directory, retainedNames) {
  if (!fs.existsSync(directory)) return;
  const retained = new Set(retainedNames);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (retained.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    try {
      removePath(fullPath);
    } catch (error) {
      // 逐条目隔离：单文件被杀软/预览占用（EBUSY/EPERM）不应让同批剩余条目全部
      // 顺延到下次启动（此前循环内无 try/catch，一处失败整批中断）。
      console.warn('[storage-cleanup] 清理条目失败（已继续后续条目）:', fullPath, error?.message || String(error));
    }
  }
}

// 每次启动清理异常关闭遗留的普通 Pi 任务归档。
function clearStalePiTaskArchives(app) {
  try {
    clearDirectoryExcept(
      path.join(getAgentRuntimeDir(app), 'pi', 'tasks'),
      PERSISTENT_AGENT_TASK_KEYS,
    );
  } catch (error) {
    console.warn('[storage-cleanup] 清理普通 Pi 任务归档失败', error?.message || String(error));
  }
}

// 收集技术方案两张引用表中出现的全部生成图相对路径（根级文件与子目录文件都收，
// 保留解码后的真实文件名）。启动清扫与运行时删除（technicalPlanStore 的
// deleteGeneratedIllustrationAssets）共用本实现，避免"引用白名单"双实现漂移
// 导致仍被引用的 AI 生图被静默误删（AI 产物重新生成结果不同，不可再生）。
function collectGeneratedImageReferences(db) {
  const references = new Set();
  const collect = (value) => {
    const source = String(value || '');
    const pattern = /yibiao-asset:\/\/generated-images\/([^?#\s"'<>\)]+)/g;
    for (const match of source.matchAll(pattern)) {
      try {
        references.add(decodeURIComponent(match[1]));
      } catch {
        references.add(match[1]);
      }
    }
  };

  db.prepare(`
    SELECT generation_asset_url AS value
    FROM technical_plan_illustration_items
    WHERE generation_asset_url IS NOT NULL AND generation_asset_url <> ''
    UNION ALL
    SELECT content AS value
    FROM technical_plan_outline_nodes
    WHERE content LIKE '%yibiao-asset://generated-images/%'
  `).all().forEach((row) => collect(row.value));
  return references;
}

// 只清理 generated-images 根目录中的旧生图，保留当前业务引用及新版子目录。
function clearUnreferencedRootGeneratedImages(app, db) {
  const imagesDir = getGeneratedImagesDir(app);
  if (!fs.existsSync(imagesDir)) return;
  const references = collectGeneratedImageReferences(db);
  for (const entry of fs.readdirSync(imagesDir, { withFileTypes: true })) {
    if (!entry.isFile() || references.has(entry.name)) continue;
    const fullPath = path.join(imagesDir, entry.name);
    try {
      // 删除留痕：根级生图一旦被误判为"未引用"即不可逆，留下文件名+大小便于追溯。
      console.log(`[storage-cleanup] 删除未引用生图 ${entry.name}（${fs.statSync(fullPath).size} bytes）`);
      removePath(fullPath);
    } catch (error) {
      console.warn('[storage-cleanup] 删除未引用生图失败（已继续后续条目）:', fullPath, error?.message || String(error));
    }
  }
}

// 每次启动清理上次异常中断留下的未引用根目录生图。
function clearOrphanedGeneratedImages(app, db) {
  try {
    clearUnreferencedRootGeneratedImages(app, db);
  } catch (error) {
    console.warn('[storage-cleanup] 清理未引用生图失败', error?.message || String(error));
  }
}

// 新清理版本首次启动时清除历史遗留；失败不阻止启动。
// 完成标记与失败步骤列表一起写：失败步骤下次启动只重试自己，
// 此前任一步失败就不写标记，长期被占用的目录会让每次启动全量重跑。
function runHistoricalStorageCleanup({ app, db, configStore, onStatus }) {
  const config = configStore.load();
  const completedVersion = Number(config.storage_cleanup_version || 0);
  const rawFailedSteps = Array.isArray(config.storage_cleanup_failed_steps)
    ? config.storage_cleanup_failed_steps
    : [];
  const pendingLabels = new Set(
    rawFailedSteps.filter((label) => HISTORICAL_CLEANUP_STEP_LABELS.includes(label)),
  );
  if (completedVersion >= STORAGE_CLEANUP_VERSION) {
    if (pendingLabels.size === 0) {
      // 无待重试步骤即跳过；顺带清掉清单外的过期标签，不让其常驻配置。
      if (rawFailedSteps.length > 0) {
        configStore.save({ storage_cleanup_failed_steps: [] });
      }
      return { completed: true, skipped: true };
    }
  }

  const userDataDir = app.getPath('userData');
  const workspaceDir = getWorkspaceDir(app);
  const agentRuntimeDir = getAgentRuntimeDir(app);
  const steps = [
    { label: '清理旧 Agent 运行目录', action: () => clearDirectoryExcept(agentRuntimeDir, ['pi']) },
    { label: '清理普通 Pi 任务归档', action: () => clearDirectoryExcept(
      path.join(agentRuntimeDir, 'pi', 'tasks'),
      PERSISTENT_AGENT_TASK_KEYS,
    ) },
    { label: '清理旧 Agent 缓存', action: () => removePath(path.join(userDataDir, 'agent-cache')) },
    { label: '清理废弃工作区状态', action: () => {
      LEGACY_WORKSPACE_FILES.forEach((fileName) => removePath(path.join(workspaceDir, fileName)));
    } },
    { label: '清理未引用的旧生图', action: () => clearUnreferencedRootGeneratedImages(app, db) },
  ];
  const due = completedVersion >= STORAGE_CLEANUP_VERSION
    ? steps.filter((step) => pendingLabels.has(step.label))
    : steps;

  onStatus?.({ phase: 'cleaning', message: '正在清理历史缓存文件' });
  const failures = [];
  for (const step of due) {
    try {
      step.action();
    } catch (error) {
      failures.push(step.label);
      console.warn(`[storage-cleanup] ${step.label}失败`, error?.message || String(error));
    }
  }
  try {
    configStore.save({
      storage_cleanup_version: STORAGE_CLEANUP_VERSION,
      storage_cleanup_failed_steps: failures,
    });
  } catch (error) {
    console.warn('[storage-cleanup] 记录历史清理状态失败', error?.message || String(error));
  }
  return { completed: failures.length === 0, skipped: false, failures };
}

// 启动时按 mtime 清扫会持续膨胀的可再生目录：日志 14 天、mermaid 缓存 30 天。
// 年龄以"目录树内最新 mtime"为锚点（相对年龄）而非墙钟：NTP/手动校时前跳不会
// 把几天前的文件误判为超龄；正常时钟下锚点≈当前时间，语义一致且更保守。
// 注意：imported-images 不在此列——批次生命周期归业务 scope 的显式删除
// （各 preserveImages 链路的 clear/delete 入口，如查重内容清空），其内容
// 无 TTL 永久留存，曾按 7 天裸 mtime 清扫会删掉仍被引用的活跃图片批次。
function sweepAgedFiles(dir, maxAgeMs) {
  if (!fs.existsSync(dir)) return;
  const files = [];
  let anchorMs = 0;
  const collect = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      try {
        if (entry.isDirectory()) {
          collect(fullPath);
        } else {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > anchorMs) anchorMs = stat.mtimeMs;
          files.push({ fullPath, mtimeMs: stat.mtimeMs });
        }
      } catch (error) {
        console.warn('[storage-cleanup] 读取过期文件信息失败（已忽略）:', fullPath, error?.message || String(error));
      }
    }
  };
  collect(dir);
  if (!anchorMs) return;
  for (const { fullPath, mtimeMs } of files) {
    try {
      if (anchorMs - mtimeMs > maxAgeMs) removePath(fullPath);
    } catch (error) {
      console.warn('[storage-cleanup] 清理过期文件失败（已忽略）:', fullPath, error?.message || String(error));
    }
  }
  // 清空的子目录连带删除（不删清扫根目录本身）。
  const prune = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(currentDir, entry.name);
      try {
        prune(fullPath);
        if (fs.readdirSync(fullPath).length === 0) removePath(fullPath);
      } catch (error) {
        console.warn('[storage-cleanup] 清理空目录失败（已忽略）:', fullPath, error?.message || String(error));
      }
    }
  };
  prune(dir);
}

function sweepAgedStartupArtifacts(app) {
  const day = 24 * 60 * 60 * 1000;
  const targets = [
    { label: 'AI/开发日志', dir: path.join(app.getPath('userData'), 'logs'), maxAge: 14 * day },
    { label: 'mermaid 渲染缓存', dir: getMermaidCacheDir(app), maxAge: 30 * day },
  ];
  for (const { label, dir, maxAge } of targets) {
    try {
      sweepAgedFiles(dir, maxAge);
    } catch (error) {
      console.warn(`[storage-cleanup] 清理${label}失败`, error?.message || String(error));
    }
  }
}

module.exports = {
  STORAGE_CLEANUP_VERSION,
  clearOrphanedGeneratedImages,
  clearStalePiTaskArchives,
  runHistoricalStorageCleanup,
  sweepAgedStartupArtifacts,
  __test: {
    sweepAgedFiles,
    collectGeneratedImageReferences,
    HISTORICAL_CLEANUP_STEP_LABELS,
  },
};
