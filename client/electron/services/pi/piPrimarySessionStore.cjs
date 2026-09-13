const fs = require('node:fs');
const path = require('node:path');
const { createPiEnvironmentLayout } = require('./piEnvironment.cjs');

const PRIMARY_SESSION_FILE = 'primary-session.json';
// 瞬态文件锁/句柄耗尽（Windows 杀毒实时防护、句柄刚释放的竞态）：
// 与 piPersistentTaskStore（R119）/licenseService（R118）同口径。
const TRANSIENT_WRITE_CODES = new Set(['EBUSY', 'EPERM', 'EAGAIN', 'ENFILE', 'EMFILE']);
const TRANSIENT_WRITE_ATTEMPTS = 3;

function getPrimarySessionFile(app) {
  return path.join(createPiEnvironmentLayout(app).runtimeRoot, PRIMARY_SESSION_FILE);
}

function normalizePrimarySession(value = {}) {
  const taskId = String(value.task_id || '').trim();
  const taskKey = String(value.task_key || '').trim();
  const sessionId = String(value.session_id || '').trim();
  if (!taskId && !taskKey) return null;
  return {
    task_id: taskId,
    task_key: taskKey,
    session_id: sessionId,
    updated_at: String(value.updated_at || new Date().toISOString()),
  };
}

// 原子写：先写同目录临时文件再 rename，避免写一半崩溃留下截断的指针文件
// （损坏/丢失的指针会让持久任务恢复链路静默回退新建 Session，丢失会话连续性）。
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

// 同步原子写 + 瞬态码即时重试；原子写已保证失败不会损坏既有指针文件。
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

function loadPrimaryAgentSession(app) {
  const filePath = getPrimarySessionFile(app);
  if (!fs.existsSync(filePath)) return null;
  try {
    return normalizePrimarySession(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch (error) {
    console.error('[pi-primary-session] 主会话指针读取失败，本次启动回退新建 Session', error?.message || String(error));
    return null;
  }
}

function savePrimaryAgentSession(app, value) {
  const normalized = normalizePrimarySession({
    ...value,
    updated_at: new Date().toISOString(),
  });
  if (!normalized) {
    clearPrimaryAgentSession(app);
    return null;
  }
  writeJsonAtomicWithRetry(getPrimarySessionFile(app), normalized);
  return normalized;
}

function clearPrimaryAgentSession(app) {
  fs.rmSync(getPrimarySessionFile(app), { force: true });
}

module.exports = {
  clearPrimaryAgentSession,
  loadPrimaryAgentSession,
  savePrimaryAgentSession,
};
