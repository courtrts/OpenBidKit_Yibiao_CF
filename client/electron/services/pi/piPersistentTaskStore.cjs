const fs = require('node:fs');
const path = require('node:path');
const { createPiEnvironmentLayout } = require('./piEnvironment.cjs');

const TASK_STATE_FILE = 'task-state.json';
const DELETE_MAX_RETRIES = 5;
const DELETE_RETRY_DELAY_MS = 100;
// 瞬态文件锁/句柄耗尽（Windows 杀毒实时防护、句柄刚释放的竞态）：
// 重试可收窄瞬时失败窗口；失败时原子写保证状态文件不会被写坏。
const TRANSIENT_WRITE_CODES = new Set(['EBUSY', 'EPERM', 'EAGAIN', 'ENFILE', 'EMFILE']);
const TRANSIENT_WRITE_ATTEMPTS = 3;
const TRANSIENT_WRITE_DELAY_MS = 100;

function nowIso() {
  return new Date().toISOString();
}

function safeTaskKey(value) {
  const key = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  if (!key) throw new Error('持久 Agent 任务缺少有效任务标识');
  return key;
}

// 根据 Electron userData 动态计算业务任务专属目录布局。
function getPersistentAgentTaskPaths(app, taskKey) {
  const layout = createPiEnvironmentLayout(app);
  const taskRoot = path.join(layout.tasksRoot, safeTaskKey(taskKey));
  return {
    taskRoot,
    workspaceDir: path.join(taskRoot, 'workspace'),
    sessionsDir: path.join(taskRoot, 'sessions'),
    stateFile: path.join(taskRoot, TASK_STATE_FILE),
    resultFile: path.join(taskRoot, 'result.json'),
  };
}

// 将状态文件中的 Session 文件名解析到当前用户的动态任务目录。
function getPersistentAgentSessionPath(app, taskKey, sessionFile) {
  const fileName = String(sessionFile || '').trim();
  if (!fileName || path.basename(fileName) !== fileName || !fileName.endsWith('.jsonl')) {
    throw new Error('持久 Agent Session 文件名无效，请重新执行当前业务任务');
  }
  return path.join(getPersistentAgentTaskPaths(app, taskKey).sessionsDir, fileName);
}

// 删除持久任务目录；Windows 文件句柄释放存在短暂延迟，需要由 Node 原生重试处理。
function removePersistentAgentTaskRoot(taskRoot) {
  fs.rmSync(taskRoot, {
    recursive: true,
    force: true,
    maxRetries: DELETE_MAX_RETRIES,
    retryDelay: DELETE_RETRY_DELAY_MS,
  });
}

// 原子写：先写同目录临时文件再 rename，避免写一半崩溃留下截断的状态文件
// （损坏的检查点会让持久业务任务永远无法恢复）。与 licenseService（R118）同口径。
function writeJsonAtomic(filePath, value) {
  let tempFile = '';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(value, null, 2), 'utf-8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    if (tempFile) {
      try { fs.rmSync(tempFile, { force: true }); } catch {}
    }
    throw error;
  }
}

// 同步原子写 + 瞬态码即时重试。调用方均为同步语义（多个任务 runner 直接调用），
// 不引入延迟；原子写已保证失败不会损坏既有状态文件。
function writeJsonAtomicWithRetry(filePath, value) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      writeJsonAtomic(filePath, value);
      return;
    } catch (error) {
      if (attempt >= TRANSIENT_WRITE_ATTEMPTS || !TRANSIENT_WRITE_CODES.has(error?.code)) throw error;
    }
  }
}

// 创建全新的持久任务目录；同一业务任务重新生成时会清空旧现场。
function createPersistentAgentTask(app, taskKey, state = {}) {
  const paths = getPersistentAgentTaskPaths(app, taskKey);
  removePersistentAgentTaskRoot(paths.taskRoot);
  fs.mkdirSync(paths.workspaceDir, { recursive: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const nextState = {
    task_key: taskKey,
    status: 'created',
    created_at: nowIso(),
    updated_at: nowIso(),
    ...state,
  };
  writeJsonAtomicWithRetry(paths.stateFile, nextState);
  return { paths, state: nextState };
}

// 读取持久 Agent 任务检查点，不存在时返回空值。
// 读取失败/解析失败给固定可行动文案，原始错误只进开发者日志（不向用户泄露本机路径）。
function loadPersistentAgentTask(app, taskKey) {
  const paths = getPersistentAgentTaskPaths(app, taskKey);
  if (!fs.existsSync(paths.stateFile)) return null;
  let raw;
  try {
    raw = fs.readFileSync(paths.stateFile, 'utf-8');
  } catch (error) {
    console.error('[pi-persistent-task] 读取状态文件失败', error?.message || String(error));
    throw new Error('持久 Agent 任务状态暂时无法读取，请重新执行当前业务任务');
  }
  try {
    const state = JSON.parse(raw);
    return { paths, state };
  } catch (error) {
    console.error('[pi-persistent-task] 状态文件损坏', error?.message || String(error));
    throw new Error('持久 Agent 任务状态已损坏，请重新执行当前业务任务');
  }
}

// 更新持久任务检查点，并保留任务创建时间。
function updatePersistentAgentTask(app, taskKey, partial = {}) {
  const current = loadPersistentAgentTask(app, taskKey);
  if (!current) throw new Error('持久 Agent 任务不存在，请重新执行当前业务任务');
  const nextState = {
    ...current.state,
    ...partial,
    task_key: taskKey,
    updated_at: nowIso(),
  };
  writeJsonAtomicWithRetry(current.paths.stateFile, nextState);
  return { paths: current.paths, state: nextState };
}

// 保存持久任务的最终结果：异步原子写 + 瞬态码带延迟重试。
// 唯一异步调用点位于 runTask 成功路径（任务已完成，磁盘抖动不应把成功报成失败）。
async function savePersistentAgentResult(app, taskKey, result) {
  const paths = getPersistentAgentTaskPaths(app, taskKey);
  for (let attempt = 1; ; attempt += 1) {
    try {
      writeJsonAtomic(paths.resultFile, result);
      return paths;
    } catch (error) {
      if (attempt >= TRANSIENT_WRITE_ATTEMPTS || !TRANSIENT_WRITE_CODES.has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_WRITE_DELAY_MS));
    }
  }
}

// 删除业务内容对应的完整 Agent 工作区、Session 和检查点。
function deletePersistentAgentTask(app, taskKey) {
  const paths = getPersistentAgentTaskPaths(app, taskKey);
  removePersistentAgentTaskRoot(paths.taskRoot);
}

module.exports = {
  createPersistentAgentTask,
  deletePersistentAgentTask,
  getPersistentAgentSessionPath,
  getPersistentAgentTaskPaths,
  loadPersistentAgentTask,
  savePersistentAgentResult,
  updatePersistentAgentTask,
};
