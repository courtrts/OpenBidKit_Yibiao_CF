'use strict';

// configStore 损坏文件自愈 + 导入校验永久回归测试。
// configStore 无原生依赖（better-sqlite3 无关）：直接从磁盘加载源文件在真实模块环境执行，
// paths/machineIdentity 均为纯 JS，测试文件与源文件同目录，require 相对解析与生产一致。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SOURCE_PATH = path.join(__dirname, 'configStore.cjs');

function loadConfigStoreModule() {
  const source = fs.readFileSync(SOURCE_PATH, 'utf-8');
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', source)(require, mod, mod.exports);
  return mod.exports;
}

const { createConfigStore, parseImportedConfig } = loadConfigStoreModule();

function makeTempApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-configtest-'));
  return { getPath: () => dir, __dir: dir };
}

function listCorruptedBackups(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith('user_config.json.corrupt-'));
}

test('全新安装：load 生成默认配置并生成确定性分析身份', () => {
  const app = makeTempApp();
  const store = createConfigStore(app);
  const config = store.load();

  assert.ok(fs.existsSync(path.join(app.__dir, 'user_config.json')), '配置文件应已落盘');
  assert.ok(/^machine-v1-[0-9a-f]{64}$/.test(config.analytics_client_id), 'client_id 应为机器摘要格式');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(config.analytics_created_at), 'created_at 应为 Asia/Shanghai 日期');
  assert.strictEqual(config.text_model_provider, 'jinlong', '默认文本 provider 应为 jinlong');
});

test('save 后重新 load 保持值，且返回副本不污染缓存', () => {
  const app = makeTempApp();
  const store = createConfigStore(app);
  store.load();
  store.save({ developer_mode: true });

  const reloaded = store.load();
  assert.strictEqual(reloaded.developer_mode, true);
  reloaded.developer_mode = false;
  assert.strictEqual(store.load().developer_mode, true, '修改返回值不应污染进程内缓存');
});

test('损坏文件自愈：备份原文件 + 默认配置继续 + 抢救分析身份', () => {
  const app = makeTempApp();
  const store = createConfigStore(app);
  store.load();
  const configFile = path.join(app.__dir, 'user_config.json');

  // 模拟用户手改引入的语法错误（截断 JSON），并保留分析身份字段
  const corrupted = '{"developer_mode": true, "analytics_client_id": "machine-v1-abc", "analytics_created_at": "2020-05-05",';
  fs.writeFileSync(configFile, corrupted, 'utf-8');

  // 新实例（模拟应用重启，进程内缓存为空）
  const freshStore = createConfigStore(app);
  const config = freshStore.load();

  // 自愈后配置合法且为完整默认口径
  assert.strictEqual(config.text_model_provider, 'jinlong', '自愈后应与全新安装同口径（jinlong）');
  assert.ok(fs.existsSync(configFile), '自愈后配置文件应重新存在');
  assert.ok(JSON.parse(fs.readFileSync(configFile, 'utf-8')).analytics_client_id === 'machine-v1-abc');

  // 分析身份从损坏文本抢救（created_at 无法重建，必须保留原值）
  assert.strictEqual(config.analytics_client_id, 'machine-v1-abc');
  assert.strictEqual(config.analytics_created_at, '2020-05-05');

  // 损坏文件已备份，且 getStatus 可查询自愈记录
  const backups = listCorruptedBackups(app.__dir);
  assert.strictEqual(backups.length, 1, '应生成 1 个损坏备份');
  const status = freshStore.getStatus();
  assert.strictEqual(status.recovery.recovered, true);
  assert.match(status.recovery.backup_file, /^user_config\.json\.corrupt-\d+$/);
  assert.ok(status.path.endsWith('user_config.json'));
  assert.ok(status.updated_at > 0);

  // 缓存生效后二次 load 不再重复备份
  freshStore.load();
  assert.strictEqual(listCorruptedBackups(app.__dir).length, 1, '缓存命中不应重复自愈');
});

test('损坏文件无身份字段：身份重新生成为机器摘要（同机同值，不产生新统计身份）', () => {
  const app = makeTempApp();
  const store = createConfigStore(app);
  const first = store.load();
  const configFile = path.join(app.__dir, 'user_config.json');
  fs.writeFileSync(configFile, '{broken json!!', 'utf-8');

  const freshStore = createConfigStore(app);
  const config = freshStore.load();

  assert.strictEqual(config.analytics_client_id, first.analytics_client_id, '确定性机器摘要：重建后 client_id 不变');
  assert.notStrictEqual(config.analytics_created_at, '', 'created_at 应重新生成');
});

test('损坏备份清理：超过 3 份时只保留最新 3 份', () => {
  const app = makeTempApp();
  const configFile = path.join(app.__dir, 'user_config.json');
  // 预置 4 个不同时间戳的旧备份
  for (const stamp of [1000, 2000, 3000, 4000]) {
    fs.writeFileSync(`${configFile}.corrupt-${stamp}`, '{}', 'utf-8');
  }
  const store = createConfigStore(app);
  fs.writeFileSync(configFile, 'not json', 'utf-8');
  store.load();

  const backups = listCorruptedBackups(app.__dir).map((name) => Number(name.slice('user_config.json.corrupt-'.length)));
  const sorted = backups.sort((a, b) => b - a);
  assert.strictEqual(sorted.length, 3, '应只保留最新 3 份');
  assert.ok(sorted[0] > 4000, '最新一份应是本次自愈生成的备份');
  assert.strictEqual(sorted[1], 4000, '次新预置备份应保留');
  assert.strictEqual(sorted[2], 3000, '第三新预置备份应保留');
  assert.ok(!backups.includes(2000) && !backups.includes(1000), '最旧两份预置备份应被清理');
});

test('load 状态：recovery 未发生时返回 recovered=false', () => {
  const app = makeTempApp();
  const store = createConfigStore(app);
  store.load();
  assert.deepStrictEqual(store.getStatus().recovery, { recovered: false });
});

test('parseImportedConfig：有效对象通过并剥离分析身份字段', () => {
  const parsed = parseImportedConfig(JSON.stringify({
    developer_mode: true,
    text_model_provider: 'deepseek',
    analytics_client_id: 'machine-v1-other',
    analytics_created_at: '2020-01-01',
  }));
  assert.strictEqual(parsed.developer_mode, true);
  assert.strictEqual(parsed.text_model_provider, 'deepseek');
  assert.strictEqual('analytics_client_id' in parsed, false, '必须剥离导入方的 client_id');
  assert.strictEqual('analytics_created_at' in parsed, false, '必须剥离导入方的 created_at');
});

test('parseImportedConfig：非法输入全部拒绝且文案无内部细节', () => {
  assert.throws(() => parseImportedConfig('not json'), /不是有效的 JSON/);
  assert.throws(() => parseImportedConfig('["array"]'), /格式不正确/);
  assert.throws(() => parseImportedConfig('"just a string"'), /格式不正确/);
  assert.throws(() => parseImportedConfig('null'), /格式不正确/);
  const big = JSON.stringify({ a: 'x'.repeat(1024 * 1024 + 10) });
  assert.throws(() => parseImportedConfig(big), /过大/);
  // 文案不得出现本地路径/堆栈等内部细节
  try {
    parseImportedConfig('bad');
    assert.fail('应抛错');
  } catch (error) {
    assert.ok(!/[A-Za-z]:\\/.test(error.message), '错误文案不应含 Windows 本地路径');
    assert.ok(!/at .+\(.+:\d+:\d+\)/.test(error.message), '错误文案不应含堆栈');
  }
});

test('save 后配置归一化：非法字段回退默认，不写坏现有配置', () => {
  const app = makeTempApp();
  const store = createConfigStore(app);
  store.load();
  const result = store.save({
    update_channel: 'not-a-channel',
    text_model_provider: 'deepseek',
    context_length_limit: -5,
  });
  assert.strictEqual(result.success, true);
  const reloaded = store.load();
  assert.strictEqual(reloaded.update_channel, 'atomgit', '非法渠道应回退默认');
  assert.strictEqual(reloaded.text_model_provider, 'deepseek');
  assert.strictEqual(reloaded.context_length_limit, 400000, '非法长度应回退默认');
});
