const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const {
  assertValidPluginId,
  PluginService,
} = require('./pluginService.cjs');
const { getPluginDownloadTempDir } = require('../utils/paths.cjs');

const SERVICE_SOURCE = fs.readFileSync(path.join(__dirname, 'pluginService.cjs'), 'utf-8');
const IPC_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'ipc', 'pluginIpc.cjs'), 'utf-8');

function makeFakeApp(root) {
  return {
    getPath: (key) => (key === 'userData' ? path.join(root, 'userData') : path.join(root, key)),
  };
}

async function makeService(root) {
  const svc = new PluginService();
  await svc.initialize(makeFakeApp(root), {});
  return svc;
}

function makeInstalledPlugin(root, pluginId, version) {
  const pluginDir = path.join(root, 'userData', 'plugins', pluginId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'manifest.json'),
    JSON.stringify({ id: pluginId, name: `Plugin ${pluginId}`, version }),
  );
  fs.writeFileSync(path.join(pluginDir, 'main.cjs'), 'module.exports = { activate: async () => {} };');
  return pluginDir;
}

// ---- C1：pluginId 格式校验（路径穿越防线）----

test('assertValidPluginId 接受合法插件 ID（与离线安装同一口径）', () => {
  for (const id of ['a', 'MyPlugin', 'plugin_1.2-x', 'P9', 'a'.repeat(80)]) {
    assert.doesNotThrow(() => assertValidPluginId(id), `应接受：${id}`);
  }
});

test('assertValidPluginId 拒绝路径穿越、分隔符与超长 ID', () => {
  for (const id of ['', 'a b', 'a/b', 'a\\b', '..', '../x', '../../etc', '.hidden', '-x', '_x', '插件', 'a'.repeat(81)]) {
    assert.throws(() => assertValidPluginId(id), /插件 ID 格式不正确/, `应拒绝：${JSON.stringify(id)}`);
  }
  // 非字符串入参按非法处理，不抛类型错误
  assert.throws(() => assertValidPluginId(undefined), /插件 ID 格式不正确/);
  assert.throws(() => assertValidPluginId({ id: 'x' }), /插件 ID 格式不正确/);
});

test('市场路径四入口拒绝穿越 ID（不触碰文件系统、不发网络请求）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-svc-test-'));
  try {
    const svc = await makeService(root);
    await assert.rejects(() => svc.installPlugin('../evil'), /插件 ID 格式不正确/);
    await assert.rejects(() => svc.uninstallPlugin('../../x'), /插件 ID 格式不正确/);
    await assert.rejects(() => svc.enablePlugin('../../userData'), /插件 ID 格式不正确/);
    await assert.rejects(() => svc.updatePlugin('a/b'), /插件 ID 格式不正确/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plugins:openConfig 处理层先过插件 ID 格式检查（防越界目录探读）', () => {
  const start = IPC_SOURCE.indexOf("plugins:openConfig");
  assert.ok(start >= 0, '缺少 plugins:openConfig 处理');
  const block = IPC_SOURCE.slice(start, start + 400);
  assert.ok(block.includes('PLUGIN_CONFIG_ID_PATTERN.test(String(pluginId'));
  assert.ok(block.includes("throw new Error('插件 ID 格式不正确')"));
});

// ---- C2：启用/禁用接入插件操作锁 ----

test('enablePlugin 与他操作共享插件锁：持锁时拒绝，失败后释放', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-svc-test-'));
  try {
    const svc = await makeService(root);
    const lock = svc.acquirePluginOperation('p1', '更新');
    await assert.rejects(() => svc.enablePlugin('p1'), /插件正在更新，请稍后再试/);
    svc.releasePluginOperation('p1', lock);
    // 锁释放后走 manifest 缺失分支（证明不再报持锁错误，且失败路径已释放锁）
    await assert.rejects(() => svc.enablePlugin('p1'), /插件 manifest 不存在/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disablePlugin 与他操作共享插件锁：持锁时拒绝', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-svc-test-'));
  try {
    const svc = await makeService(root);
    const lock = svc.acquirePluginOperation('p1', '安装');
    await assert.rejects(() => svc.disablePlugin('p1'), /插件正在安装，请稍后再试/);
    svc.releasePluginOperation('p1', lock);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- C3：更新失败恢复状态（含启用标志）----

test('updatePlugin 安装失败时还原旧版本目录并恢复升级前状态（含启用标志）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-svc-test-'));
  try {
    const pluginDir = makeInstalledPlugin(root, 'p1', '1.0.0');
    const svc = await makeService(root);
    svc.pluginStates['p1'] = {
      installed: true,
      enabled: true,
      version: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
    };
    svc.fetchAvailablePlugins = async () => [
      { id: 'p1', name: 'Plugin p1', version: '2.0.0', releaseUrl: 'https://github.com/x/y/releases/download/v2/p.zip' },
    ];
    svc.downloadPlugin = async () => {
      throw new Error('插件包下载失败：503');
    };

    await assert.rejects(
      () => svc.updatePlugin('p1'),
      /更新阶段"下载并安装新版本"失败：插件包下载失败：503/,
    );

    // 旧版本目录已还原
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf-8'));
    assert.equal(manifest.version, '1.0.0');
    // 升级前状态恢复（含启用标志与安装时间，重启后仍自动启用）
    assert.equal(svc.pluginStates['p1'].enabled, true);
    assert.equal(svc.pluginStates['p1'].version, '1.0.0');
    assert.equal(svc.pluginStates['p1'].installedAt, '2026-01-01T00:00:00.000Z');
    // 失败记录进 failedUpdates（供「查看错误」展示）
    assert.equal(svc.failedUpdates.get('p1').stage, '下载并安装新版本');
    // 无残留备份目录
    const entries = fs.readdirSync(path.join(root, 'userData', 'plugins'));
    assert.ok(!entries.some((name) => name.includes('.update-backup-')), '备份目录应已还原');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('updatePlugin 成功后按原启用态恢复（内部 enable 复用 ownerToken 不自锁）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-svc-test-'));
  const zipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-zip-'));
  try {
    makeInstalledPlugin(root, 'p1', '1.0.0');
    const zipPath = path.join(zipDir, 'p1-v2.zip');
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify({ id: 'p1', name: 'Plugin p1', version: '2.0.0' })));
    zip.addFile('main.cjs', Buffer.from('module.exports = { activate: async () => {}, deactivate: async () => {} };'));
    zip.writeZip(zipPath);

    const svc = await makeService(root);
    svc.pluginStates['p1'] = { installed: true, enabled: true, version: '1.0.0' };
    svc.fetchAvailablePlugins = async () => [
      { id: 'p1', name: 'Plugin p1', version: '2.0.0', releaseUrl: 'https://github.com/x/y/releases/download/v2/p.zip' },
    ];
    svc.downloadPlugin = async () => zipPath;
    // 测试不向生产市场发下载计数（统计红线）
    svc.recordPluginDownload = () => {};

    await svc.updatePlugin('p1');

    assert.equal(svc.pluginStates['p1'].version, '2.0.0');
    assert.equal(svc.pluginStates['p1'].enabled, true);
    assert.ok(svc.plugins.has('p1'), '原启用态插件升级后应重新启用');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'userData', 'plugins', 'p1', 'manifest.json'), 'utf-8'),
    );
    assert.equal(manifest.version, '2.0.0');
    await svc.disablePlugin('p1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(zipDir, { recursive: true, force: true });
  }
});

// ---- C4：用户可见错误净化 ----

test('用户可见错误边界统一走 userFacingTaskError 净化（本地路径/内部细节不外显）', () => {
  for (const snippet of [
    "throw new Error(userFacingTaskError(error, '插件安装失败'));",
    "throw new Error(userFacingTaskError(error, '插件卸载失败'));",
    "throw new Error(userFacingTaskError(error, '插件启用失败'));",
    "throw new Error(userFacingTaskError(error, '插件禁用失败'));",
    "throw new Error(userFacingTaskError(error, '离线插件安装失败'));",
  ]) {
    assert.ok(SERVICE_SOURCE.includes(snippet), `缺少净化边界：${snippet}`);
  }
  assert.ok(/const message = userFacingTaskError\(error, '插件更新失败'\);/.test(SERVICE_SOURCE));
  assert.ok(SERVICE_SOURCE.includes("require('../utils/taskErrorText.cjs')"));
});

test('市场请求底层网络错误不透传：固定文案 + 原始错误进开发者日志', () => {
  assert.ok(SERVICE_SOURCE.includes("fail(new Error('插件市场连接失败，请检查网络后重试'))"));
  assert.ok(SERVICE_SOURCE.includes("console.error('[plugin-service] 插件市场请求失败:'"));
  assert.ok(!SERVICE_SOURCE.includes("res.on('error', reject)"), '流错误仍在透传 raw error');
  assert.ok(!SERVICE_SOURCE.includes("request.on('error', reject)"), '请求错误仍在透传 raw error');
  assert.ok(
    !SERVICE_SOURCE.includes("request.destroy(new Error('插件市场请求超时"),
    '超时应显式 fail 固定文案，而非依赖 destroy 的错误事件透传',
  );
});

// ---- C5：下载临时目录生命周期 ----

test('downloadPlugin 失败先销毁写入流，临时目录走共享 helper（Windows 句柄泄漏兜底）', () => {
  assert.ok(
    /if \(fileStream\) \{\s*try \{ fileStream\.destroy\(\); \} catch \{\}/.test(SERVICE_SOURCE),
    'fail 应先销毁写入流再删文件',
  );
  assert.ok(SERVICE_SOURCE.includes('fileStream = file;'));
  assert.ok(SERVICE_SOURCE.includes('const tempDir = getPluginDownloadTempDir();'));
  assert.ok(!SERVICE_SOURCE.includes("getPath('temp')"), '仍用 app.getPath temp 拼目录（漂移风险）');
  assert.ok(SERVICE_SOURCE.includes("require('../utils/paths.cjs')"));
});

test('getPluginDownloadTempDir 指向系统临时区固定目录名（与写入路径同源）', () => {
  assert.equal(getPluginDownloadTempDir(), path.join(os.tmpdir(), 'yibiao-plugins'));
});
