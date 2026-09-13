'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createPersistentAgentTask,
  deletePersistentAgentTask,
  loadPersistentAgentTask,
  savePersistentAgentResult,
  updatePersistentAgentTask,
} = require('./piPersistentTaskStore.cjs');
const STORE_SOURCE = fs.readFileSync(path.join(__dirname, 'piPersistentTaskStore.cjs'), 'utf-8');
const RUNTIME_SOURCE = fs.readFileSync(path.join(__dirname, 'piRuntimeService.cjs'), 'utf-8');

// 假 app 只提供临时 userData 路径，不触碰真实 Electron。
function makeApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-pi-store-'));
  return { getPath: (key) => path.join(root, key) };
}

function regionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `未找到起始标记：${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notStrictEqual(end, -1, `未找到结束标记：${endMarker}`);
  return source.slice(start, end);
}

test('C1 持久任务 create/update/load 往返（原子写 + 保留创建时间）', () => {
  const app = makeApp();
  try {
    createPersistentAgentTask(app, 'demo-task', { run_id: 'run-1', status: 'running' });
    const loaded = loadPersistentAgentTask(app, 'demo-task');
    assert.strictEqual(loaded.state.run_id, 'run-1');
    const createdBefore = loaded.state.created_at;
    const updated = updatePersistentAgentTask(app, 'demo-task', { phase: 'stage-2' });
    assert.strictEqual(updated.state.phase, 'stage-2');
    assert.strictEqual(updated.state.run_id, 'run-1');
    assert.strictEqual(updated.state.created_at, createdBefore, '更新应保留任务创建时间');
    const reloaded = loadPersistentAgentTask(app, 'demo-task');
    assert.strictEqual(reloaded.state.phase, 'stage-2');
  } finally {
    deletePersistentAgentTask(app, 'demo-task');
  }
});

test('C1 savePersistentAgentResult 往返（异步原子写）', async () => {
  const app = makeApp();
  try {
    createPersistentAgentTask(app, 'demo-task', { status: 'running' });
    const result = { success: true, output_content: 'ok', session_id: 's-1' };
    await savePersistentAgentResult(app, 'demo-task', result);
    const taskRoot = loadPersistentAgentTask(app, 'demo-task').paths.taskRoot;
    const stored = JSON.parse(fs.readFileSync(path.join(taskRoot, 'result.json'), 'utf-8'));
    assert.deepStrictEqual(stored, result);
  } finally {
    deletePersistentAgentTask(app, 'demo-task');
  }
});

test('C1 状态文件损坏 → 固定可行动文案（不泄露本机路径）', () => {
  const app = makeApp();
  try {
    createPersistentAgentTask(app, 'demo-task', { status: 'running' });
    const stateFile = loadPersistentAgentTask(app, 'demo-task').paths.stateFile;
    fs.writeFileSync(stateFile, '{"status": "running"', 'utf-8');
    assert.throws(
      () => loadPersistentAgentTask(app, 'demo-task'),
      (error) => {
        const text = String(error?.message || '');
        assert.match(text, /持久 Agent 任务状态已损坏/);
        assert.match(text, /重新执行当前业务任务/);
        assert.ok(!text.includes(app.getPath('userData')), '不得泄露本机绝对路径');
        return true;
      },
    );
  } finally {
    deletePersistentAgentTask(app, 'demo-task');
  }
});

test('C1 不存在状态文件返回空值（resume 口径）', () => {
  const app = makeApp();
  assert.strictEqual(loadPersistentAgentTask(app, 'never-created'), null);
});

test('C1 原子写与瞬态重试源断言（与 licenseService 同口径）', () => {
  const atomicRegion = regionBetween(STORE_SOURCE, 'function writeJsonAtomic(filePath, value)', '\n}');
  assert.match(atomicRegion, /\.tmp`/);
  assert.match(atomicRegion, /fs\.renameSync\(tempFile, filePath\)/);
  assert.match(atomicRegion, /fs\.rmSync\(tempFile, \{ force: true \}\)/);
  const retryRegion = regionBetween(STORE_SOURCE, 'function writeJsonAtomicWithRetry(filePath, value)', '\n}');
  assert.match(retryRegion, /TRANSIENT_WRITE_CODES\.has\(error\?\.code\)/);
  assert.match(retryRegion, /TRANSIENT_WRITE_ATTEMPTS/);
  assert.match(STORE_SOURCE, /EBUSY/);
  assert.match(STORE_SOURCE, /ENFILE/);
  const createRegion = regionBetween(STORE_SOURCE, 'function createPersistentAgentTask(', '\n}');
  assert.match(createRegion, /writeJsonAtomicWithRetry\(paths\.stateFile/);
  const updateRegion = regionBetween(STORE_SOURCE, 'function updatePersistentAgentTask(', '\n}');
  assert.match(updateRegion, /writeJsonAtomicWithRetry\(current\.paths\.stateFile/);
  const resultRegion = regionBetween(STORE_SOURCE, 'async function savePersistentAgentResult(', '\n}');
  assert.match(resultRegion, /TRANSIENT_WRITE_DELAY_MS/);
  assert.match(resultRegion, /writeJsonAtomic\(paths\.resultFile, result\)/);
  // 状态文件不应再有任何非原子直写（writeFileSync 只允许出现在 tmp 文件与测试数据写入）
  assert.ok(!/writeFileSync\(paths?\.?stateFile/.test(STORE_SOURCE));
  assert.ok(!/writeFileSync\(current\.paths\.stateFile/.test(STORE_SOURCE));
});

test('C1 piRuntimeService 终结检查点隔离（源断言）', () => {
  // 成功路径：结果文件改走 savePersistentAgentResult + 故障隔离（写失败不把成功报成失败）
  assert.match(RUNTIME_SOURCE, /await savePersistentAgentResult\(app, persistentConfig\.task_key, result\)/);
  assert.match(RUNTIME_SOURCE, /持久任务结果文件写入失败/);
  // 终结检查点写失败隔离出现两处（成功路径 + 错误路径，错误路径保留原始错误）
  assert.strictEqual((RUNTIME_SOURCE.match(/持久任务终结检查点写入失败/g) || []).length, 2);
  // 错误路径隔离必须在 checkpoint 调用外层：load 与 checkpoint 均被 try 包裹
  const errorPath = regionBetween(RUNTIME_SOURCE, 'archivedWorkspace = workspaceDir;\n        try {', '\n      } else {');
  assert.match(errorPath, /loadPersistentAgentTask\(app, persistentConfig\.task_key\)/);
  assert.match(errorPath, /checkpointPersistentTask\(\{/);
  // 孤立的 writeJsonAsync 应已移除
  assert.ok(!RUNTIME_SOURCE.includes('writeJsonAsync'));
});

test('C2 waitForExternalUser 中止路径口径（源断言）', () => {
  const region = regionBetween(RUNTIME_SOURCE, 'async function waitForExternalUser(', 'async function runTask');
  assert.match(region, /let settled = false;/);
  assert.match(region, /settled = true;/);
  assert.match(region, /stage: settled \? 'running' : activeTask\.stage/);
  assert.match(region, /message: settled \? '已收到用户操作，Agent 正在继续执行' : ''/);
  assert.match(region, /visible: settled,/);
  assert.match(region, /'pi\.workflow\.resumed' : 'pi\.workflow\.waited\.settled'/);
});
