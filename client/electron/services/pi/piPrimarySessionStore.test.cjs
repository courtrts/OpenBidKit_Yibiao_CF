'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  clearPrimaryAgentSession,
  loadPrimaryAgentSession,
  savePrimaryAgentSession,
} = require('./piPrimarySessionStore.cjs');
const STORE_SOURCE = fs.readFileSync(path.join(__dirname, 'piPrimarySessionStore.cjs'), 'utf-8');

// 假 app 只提供临时 userData 路径，不触碰真实 Electron。
function makeApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-pi-primary-'));
  return { getPath: (key) => path.join(root, key) };
}

function regionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `未找到起始标记：${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notStrictEqual(end, -1, `未找到结束标记：${endMarker}`);
  return source.slice(start, end);
}

test('C2 主会话指针 save/load 往返（原子写）', () => {
  const app = makeApp();
  try {
    const saved = savePrimaryAgentSession(app, {
      task_id: 'task-1',
      task_key: 'demo-task',
      session_id: 'session-abc',
    });
    assert.strictEqual(saved.task_id, 'task-1');
    assert.ok(saved.updated_at, '保存时应写入 updated_at');
    const loaded = loadPrimaryAgentSession(app);
    assert.strictEqual(loaded.task_key, 'demo-task');
    assert.strictEqual(loaded.session_id, 'session-abc');
    // 原子写不应遗留 .tmp 中间文件
    const runtimeRoot = path.dirname(loadPath(app));
    const leftovers = fs.readdirSync(runtimeRoot).filter((name) => name.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, [], '原子写不得遗留临时文件');
  } finally {
    clearPrimaryAgentSession(app);
  }
});

function loadPath(app) {
  const layout = require('./piEnvironment.cjs').createPiEnvironmentLayout(app);
  return path.join(layout.runtimeRoot, 'primary-session.json');
}

test('C2 无 task_id/task_key 的值清空既有指针', () => {
  const app = makeApp();
  try {
    savePrimaryAgentSession(app, { task_id: 'task-1', task_key: 'demo-task', session_id: 's-1' });
    const cleared = savePrimaryAgentSession(app, { session_id: 'orphan' });
    assert.strictEqual(cleared, null);
    assert.strictEqual(loadPrimaryAgentSession(app), null, '指针文件应已被删除');
  } finally {
    clearPrimaryAgentSession(app);
  }
});

test('C2 指针文件损坏 → 返回空值 + 诊断日志（回退新建 Session，不抛错）', () => {
  const app = makeApp();
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    fs.mkdirSync(path.dirname(loadPath(app)), { recursive: true });
    fs.writeFileSync(loadPath(app), '{"task_id": "task-1"', 'utf-8');
    assert.strictEqual(loadPrimaryAgentSession(app), null);
    const logged = errors.join('\n');
    assert.match(logged, /\[pi-primary-session\]/, '必须有固定标签的诊断日志');
    assert.match(logged, /主会话指针读取失败/);
    assert.ok(!logged.includes(app.getPath('userData')), '诊断日志不得泄露本机绝对路径');
  } finally {
    console.error = originalError;
    clearPrimaryAgentSession(app);
  }
});

test('C2 不存在指针文件返回空值（首次启动口径）', () => {
  const app = makeApp();
  assert.strictEqual(loadPrimaryAgentSession(app), null);
});

test('C2 clear 移除指针文件且幂等（force 删除）', () => {
  const app = makeApp();
  savePrimaryAgentSession(app, { task_id: 'task-1', task_key: 'demo-task', session_id: 's-1' });
  clearPrimaryAgentSession(app);
  assert.strictEqual(loadPrimaryAgentSession(app), null);
  clearPrimaryAgentSession(app);
  assert.strictEqual(loadPrimaryAgentSession(app), null);
});

test('C2 原子写与瞬态重试源断言（与 piPersistentTaskStore 同口径）', () => {
  const atomicRegion = regionBetween(STORE_SOURCE, 'function writeJsonAtomic(filePath, value)', '\n}');
  assert.match(atomicRegion, /\.tmp`/);
  assert.match(atomicRegion, /fs\.renameSync\(tempFile, filePath\)/);
  assert.match(atomicRegion, /fs\.rmSync\(tempFile, \{ force: true \}\)/);
  const retryRegion = regionBetween(STORE_SOURCE, 'function writeJsonAtomicWithRetry(filePath, value)', '\n}');
  assert.match(retryRegion, /TRANSIENT_WRITE_CODES\.has\(error\?\.code\)/);
  assert.match(retryRegion, /TRANSIENT_WRITE_ATTEMPTS/);
  assert.match(STORE_SOURCE, /EBUSY/);
  assert.match(STORE_SOURCE, /ENFILE/);
  const saveRegion = regionBetween(STORE_SOURCE, 'function savePrimaryAgentSession(', '\n}');
  assert.match(saveRegion, /writeJsonAtomicWithRetry\(getPrimarySessionFile\(app\)/);
  // 指针文件不应有任何非原子直写（writeFileSync 只允许出现在 tmp 文件写入）
  const loadRegion = regionBetween(STORE_SOURCE, 'function loadPrimaryAgentSession(', '\n}');
  assert.ok(!/writeFileSync\(/.test(loadRegion), 'load 路径不得写文件');
  assert.ok(!/writeFileSync\(getPrimarySessionFile/.test(STORE_SOURCE), '保存不得直写指针文件');
  const loadFailRegion = loadRegion;
  assert.match(loadFailRegion, /console\.error\('\[pi-primary-session\]/);
});
