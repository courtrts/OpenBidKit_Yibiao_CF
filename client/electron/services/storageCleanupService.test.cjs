const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  runHistoricalStorageCleanup,
  sweepAgedStartupArtifacts,
  __test,
} = require('./storageCleanupService.cjs');

const { sweepAgedFiles, collectGeneratedImageReferences, HISTORICAL_CLEANUP_STEP_LABELS } = __test;
const DAY = 24 * 60 * 60 * 1000;

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'storage-cleanup-test-'));
}

function writeFileWithMtime(filePath, mtimeMs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'x');
  const date = new Date(mtimeMs);
  fs.utimesSync(filePath, date, date);
}

function makeFakeApp(userDataDir) {
  return { getPath: (key) => path.join(userDataDir, key) };
}

// ---- sweepAgedFiles：锚点相对年龄 ----

test('sweepAgedFiles 正常时钟下按 TTL 清扫旧文件并保留新文件', () => {
  const dir = makeTmpDir();
  const now = Date.now();
  writeFileWithMtime(path.join(dir, 'fresh.log'), now - 1 * 3600 * 1000);
  writeFileWithMtime(path.join(dir, 'old.log'), now - 20 * DAY);
  writeFileWithMtime(path.join(dir, 'mid.log'), now - 10 * DAY);
  writeFileWithMtime(path.join(path.join(dir, 'sub', 'old2.log')), now - 40 * DAY);
  writeFileWithMtime(path.join(path.join(dir, 'sub', 'fresh2.log')), now - 2 * DAY);

  sweepAgedFiles(dir, 14 * DAY);

  assert.ok(fs.existsSync(path.join(dir, 'fresh.log')));
  assert.ok(fs.existsSync(path.join(dir, 'mid.log')));
  assert.ok(!fs.existsSync(path.join(dir, 'old.log')));
  assert.ok(fs.existsSync(path.join(path.join(dir, 'sub', 'fresh2.log'))));
  assert.ok(!fs.existsSync(path.join(path.join(dir, 'sub', 'old2.log'))));
});

test('sweepAgedFiles 墙钟前跳时不误删：年龄以树内最新 mtime 为锚点', () => {
  const dir = makeTmpDir();
  const now = Date.now();
  // 模拟"NTP 校时前跳 10 天"：树内最新活动停留在 10 天前（锚点），
  // young.log 墙钟年龄 20 天（>14 天 TTL，墙钟实现会删它）但相对锚点只老 10 天。
  writeFileWithMtime(path.join(dir, 'anchor.log'), now - 10 * DAY);
  writeFileWithMtime(path.join(dir, 'young.log'), now - 20 * DAY);
  writeFileWithMtime(path.join(dir, 'truly-stale.log'), now - 30 * DAY);

  sweepAgedFiles(dir, 14 * DAY);

  assert.ok(fs.existsSync(path.join(dir, 'anchor.log')));
  // 相对锚点 10 天 < 14 天：保留（墙钟口径会误删，本断言即回归防护）
  assert.ok(fs.existsSync(path.join(dir, 'young.log')));
  // 相对锚点 20 天 > 14 天：真旧，仍删除
  assert.ok(!fs.existsSync(path.join(dir, 'truly-stale.log')));
});

test('sweepAgedFiles 清空的子目录连带删除，非空子目录保留', () => {
  const dir = makeTmpDir();
  const now = Date.now();
  writeFileWithMtime(path.join(dir, 'fresh.log'), now - 1 * 3600 * 1000);
  writeFileWithMtime(path.join(path.join(dir, 'prune', 'old.log')), now - 20 * DAY);

  sweepAgedFiles(dir, 14 * DAY);

  assert.ok(!fs.existsSync(path.join(dir, 'prune')));
  assert.ok(fs.existsSync(path.join(dir, 'fresh.log')));
});

test('sweepAgedFiles 空目录树直接返回不抛错', () => {
  const dir = makeTmpDir();
  assert.doesNotThrow(() => sweepAgedFiles(dir, 14 * DAY));
  const missing = path.join(dir, 'no-such-dir');
  assert.doesNotThrow(() => sweepAgedFiles(missing, 14 * DAY));
});

// ---- sweepAgedStartupArtifacts：imported-images 不再被年龄清扫 ----

test('sweepAgedStartupArtifacts 不再清扫 imported-images（活跃图片批次受保护）', () => {
  const tmp = makeTmpDir();
  const app = makeFakeApp(path.join(tmp, 'userData'));
  const now = Date.now();
  // 30 天前的导入图片批次（若仍按旧 7 天裸 mtime 清扫会被删——红线回归点）
  writeFileWithMtime(
    path.join(app.getPath('userData'), 'workspace', 'imported-images', 'duplicate-check-content-123-abc12345', 'image-0001.png'),
    now - 30 * DAY,
  );
  // 同样 30 天前的日志文件应被 14 天清扫删掉（其余链路语义不变）
  writeFileWithMtime(path.join(app.getPath('userData'), 'logs', 'old-ai.log'), now - 30 * DAY);
  writeFileWithMtime(path.join(app.getPath('userData'), 'logs', 'fresh-ai.log'), now - 1 * 3600 * 1000);

  sweepAgedStartupArtifacts(app);

  assert.ok(fs.existsSync(
    path.join(app.getPath('userData'), 'workspace', 'imported-images', 'duplicate-check-content-123-abc12345', 'image-0001.png'),
  ), '导入图片批次必须保留（生命周期归业务显式删除）');
  assert.ok(!fs.existsSync(path.join(app.getPath('userData'), 'logs', 'old-ai.log')));
  assert.ok(fs.existsSync(path.join(app.getPath('userData'), 'logs', 'fresh-ai.log')));
});

// ---- collectGeneratedImageReferences：共享引用收集 ----

test('collectGeneratedImageReferences 收集根级与子目录相对路径并解码', () => {
  const rows = [
    { value: 'yibiao-asset://generated-images/2026-09-12T10-30-00-abc123.png' },
    { value: '正文 ![图](yibiao-asset://generated-images/technical-plan/illustrations/a%20b.png)' },
    { value: 'yibiao-asset://generated-images/2026-09-12T11-00-00-def456.png?v=2' },
    { value: '无关内容' },
  ];
  const db = { prepare: () => ({ all: () => rows }) };
  const references = collectGeneratedImageReferences(db);
  assert.ok(references.has('2026-09-12T10-30-00-abc123.png'));
  assert.ok(references.has('technical-plan/illustrations/a b.png'));
  assert.ok(references.has('2026-09-12T11-00-00-def456.png'));
  assert.equal(references.size, 3);
});

// ---- runHistoricalStorageCleanup：失败步定向重试 ----

function makeFakeConfigStore(initial) {
  const state = { ...initial };
  return {
    state,
    load: () => ({ ...state }),
    save: (patch) => {
      Object.assign(state, patch);
      return { success: true };
    },
  };
}

function makeFakeDb() {
  return { prepare: () => ({ all: () => [] }) };
}

test('runHistoricalStorageCleanup 首启全量执行并把失败步骤持久化，下次只重试失败步', () => {
  const tmp = makeTmpDir();
  const userDataDir = path.join(tmp, 'userData');
  // getPath('userData') = tmp/userData，与下方手工构造的目录结构对齐
  const app = makeFakeApp(tmp);
  const agentRuntimeDir = path.join(userDataDir, 'agent-runtime');
  const tasksDir = path.join(agentRuntimeDir, 'pi', 'tasks');
  const generatedImagesDir = path.join(userDataDir, 'workspace', 'generated-images');

  // 制造第 2 步失败：tasks 是文件而非目录 → readdirSync 抛错
  fs.mkdirSync(path.dirname(tasksDir), { recursive: true });
  fs.writeFileSync(tasksDir, 'blocker');
  // 第 5 步目标：未引用根级生图
  fs.mkdirSync(generatedImagesDir, { recursive: true });
  fs.writeFileSync(path.join(generatedImagesDir, 'orphan-1.png'), 'x');

  const statuses = [];
  const configStore = makeFakeConfigStore({});
  const firstRun = runHistoricalStorageCleanup({
    app,
    db: makeFakeDb(),
    configStore,
    onStatus: (s) => statuses.push(s),
  });

  assert.equal(firstRun.completed, false);
  assert.deepEqual(firstRun.failures, ['清理普通 Pi 任务归档']);
  assert.deepEqual(configStore.state.storage_cleanup_failed_steps, ['清理普通 Pi 任务归档']);
  assert.ok(statuses.length >= 1, '应推送清理状态');
  // 成功步骤已执行：未引用生图已删
  assert.ok(!fs.existsSync(path.join(generatedImagesDir, 'orphan-1.png')));

  // 修复失败点：删掉挡路的 tasks 文件、建目录并放入一个普通任务归档
  fs.rmSync(tasksDir);
  fs.mkdirSync(path.join(tasksDir, 'task-x'), { recursive: true });
  // 再造一个未引用生图：若第 5 步被重复执行它会消失
  fs.writeFileSync(path.join(generatedImagesDir, 'orphan-2.png'), 'x');

  const secondRun = runHistoricalStorageCleanup({ app, db: makeFakeDb(), configStore });

  assert.equal(secondRun.completed, true);
  assert.deepEqual(secondRun.failures, []);
  assert.deepEqual(configStore.state.storage_cleanup_failed_steps, []);
  // 只重试了失败步：task-x 被清
  assert.ok(!fs.existsSync(path.join(tasksDir, 'task-x')));
  // 成功步未重跑：orphan-2.png 仍在（首启时它还不存在，第二启才创建）
  assert.ok(fs.existsSync(path.join(generatedImagesDir, 'orphan-2.png')));
});

test('runHistoricalStorageCleanup 版本已完成且无失败步骤时整体跳过', () => {
  const tmp = makeTmpDir();
  const userDataDir = path.join(tmp, 'userData');
  const app = makeFakeApp(userDataDir);
  const agentRuntimeDir = path.join(userDataDir, 'agent-runtime');
  fs.mkdirSync(path.join(agentRuntimeDir, 'should-remain'), { recursive: true });

  const configStore = makeFakeConfigStore({
    storage_cleanup_version: 1,
    storage_cleanup_failed_steps: [],
  });
  const result = runHistoricalStorageCleanup({ app, db: makeFakeDb(), configStore });

  assert.deepEqual(result, { completed: true, skipped: true });
  assert.ok(fs.existsSync(path.join(agentRuntimeDir, 'should-remain')), '跳过时不得触碰任何目录');
});

test('runHistoricalStorageCleanup 忽略清单外的过期失败标签并清空', () => {
  const tmp = makeTmpDir();
  const app = makeFakeApp(tmp);
  const configStore = makeFakeConfigStore({
    storage_cleanup_version: 1,
    storage_cleanup_failed_steps: ['已下线的旧步骤'],
  });
  const result = runHistoricalStorageCleanup({ app, db: makeFakeDb(), configStore });
  assert.deepEqual(result, { completed: true, skipped: true });
  assert.deepEqual(configStore.state.storage_cleanup_failed_steps, []);
});

test('HISTORICAL_CLEANUP_STEP_LABELS 与已知 5 步一致', () => {
  assert.equal(HISTORICAL_CLEANUP_STEP_LABELS.length, 5);
  assert.ok(HISTORICAL_CLEANUP_STEP_LABELS.includes('清理旧 Agent 缓存'));
  assert.ok(HISTORICAL_CLEANUP_STEP_LABELS.includes('清理未引用的旧生图'));
});
