const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFileService, parseDocumentWithConfig } = require('./fileService.cjs');

// parseDocumentWithConfig / import* 全链路在纯 node 下可跑：
// - require('electron') 在 node 环境返回字符串，dialog 解构为 undefined，
//   测试一律显式传 filePaths 不触发系统选择弹窗
// - config 不带 developer_mode → createDeveloperLogger 返回 no-op，无日志落盘
const LOCAL_CONFIG = { components: { file_parser: { provider: 'local' } } };

function makeTmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'file-service-test-'));
}

function makeApp(userDataDir) {
  return { getPath: (key) => path.join(userDataDir, key) };
}

function parseCacheDir(app) {
  return path.join(app.getPath('userData'), 'cache', 'parse-cache');
}

async function listCacheFiles(app) {
  try {
    return (await fsp.readdir(parseCacheDir(app))).filter((name) => name.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

async function withService(fn) {
  const root = makeTmpRoot();
  const app = makeApp(path.join(root, 'userData'));
  const service = createFileService({
    app,
    configStore: { load: () => structuredClone(LOCAL_CONFIG) },
  });
  try {
    return await fn({ root, app, service });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('本地文本解析：.txt 内容往返且图片语法被剥离', async () => {
  await withService(async ({ root, app }) => {
    const filePath = path.join(root, 'sample.txt');
    await fsp.writeFile(filePath, '# 标题\n\n正文 ![示意](http://x.example/i.png)\n', 'utf-8');
    const markdown = await parseDocumentWithConfig(app, filePath, LOCAL_CONFIG, {});
    assert.match(markdown, /# 标题/);
    assert.ok(!markdown.includes('http://x.example/i.png'), '图片引用必须被剥离');
  });
});

test('本地解析缓存：首次解析写缓存、再次解析命中（不重复解析）', async () => {
  await withService(async ({ root, app }) => {
    const filePath = path.join(root, 'cached.txt');
    await fsp.writeFile(filePath, '原始内容', 'utf-8');
    const first = await parseDocumentWithConfig(app, filePath, LOCAL_CONFIG, {});
    assert.equal(first, '原始内容');
    const cacheFiles = await listCacheFiles(app);
    assert.equal(cacheFiles.length, 1, '首次解析必须写缓存文件');
    // 用哨兵替换缓存内容：命中路径直接返回缓存文本，可证明未重新解析源文件
    const sentinel = 'CACHE_SENTINEL_R114';
    await fsp.writeFile(path.join(parseCacheDir(app), cacheFiles[0]), sentinel, 'utf-8');
    const second = await parseDocumentWithConfig(app, filePath, LOCAL_CONFIG, {});
    assert.equal(second, sentinel, '第二次必须命中缓存而非重读源文件');
  });
});

test('本地解析缓存：源文件改动后指纹失效，不再命中旧缓存', async () => {
  await withService(async ({ root, app }) => {
    const filePath = path.join(root, 'changing.txt');
    await fsp.writeFile(filePath, '第一版内容', 'utf-8');
    await parseDocumentWithConfig(app, filePath, LOCAL_CONFIG, {});
    const sentinel = 'CACHE_SENTINEL_R114';
    const cacheFiles = await listCacheFiles(app);
    assert.equal(cacheFiles.length, 1);
    await fsp.writeFile(path.join(parseCacheDir(app), cacheFiles[0]), sentinel, 'utf-8');
    await fsp.appendFile(filePath, '+第二版追加');
    const third = await parseDocumentWithConfig(app, filePath, LOCAL_CONFIG, {});
    assert.equal(third, '第一版内容+第二版追加');
    assert.notEqual(third, sentinel, '源文件 size/mtime 变化后旧缓存必须失效');
  });
});

test('本地解析缓存：输出超过 5MB 不写缓存', async () => {
  await withService(async ({ root, app }) => {
    const filePath = path.join(root, 'big.txt');
    const big = 'x'.repeat(5 * 1024 * 1024 + 1);
    await fsp.writeFile(filePath, big, 'utf-8');
    const result = await parseDocumentWithConfig(app, filePath, LOCAL_CONFIG, {});
    assert.equal(result.length, big.length, '大文件解析结果本身不受影响');
    assert.equal((await listCacheFiles(app)).length, 0, '超过 5MB 不得写缓存');
  });
});

test('本地解析缓存：preserveImages 路径不写缓存（防资产批次引用过期）', async () => {
  await withService(async ({ root, app }) => {
    const filePath = path.join(root, 'with-image.txt');
    await fsp.writeFile(filePath, '图 ![i](data:image/png;base64,AAAA)\n', 'utf-8');
    const result = await parseDocumentWithConfig(app, filePath, LOCAL_CONFIG, { preserveImages: true });
    assert.match(result, /yibiao-asset:\/\//, '图片必须改写为资产 URL');
    assert.equal((await listCacheFiles(app)).length, 0, 'preserveImages 路径不得写缓存');
  });
});

test('导入全失败：message 拼接全部逐文件原因（不只第一条）', async () => {
  await withService(async ({ root, service }) => {
    const badA = path.join(root, 'a.exe');
    const badB = path.join(root, 'b.bmp');
    await fsp.writeFile(badA, 'x');
    await fsp.writeFile(badB, 'x');
    const result = await service.importTechnicalPlanDocument('招标文件', { multiple: true, filePaths: [badA, badB] });
    assert.equal(result.success, false);
    assert.match(result.message, /a\.exe/);
    assert.match(result.message, /b\.bmp/, '第二份文件的失败原因也必须出现在消息中');
    assert.match(result.message, /不支持该文件格式/);
  });
});

test('导入部分成功：errors 契约保留逐文件原因（调用方拼接口径）', async () => {
  await withService(async ({ root, service }) => {
    const good = path.join(root, 'good.txt');
    const bad = path.join(root, 'a.exe');
    await fsp.writeFile(good, '有效内容', 'utf-8');
    await fsp.writeFile(bad, 'x');
    const result = await service.importTechnicalPlanDocument('招标文件', { multiple: true, filePaths: [good, bad] });
    assert.equal(result.success, true);
    assert.equal(result.documents.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /a\.exe/);
    assert.match(result.message, /失败 1 份/);
  });
});

test('可研导入：部分成功消息拼接逐文件原因（与招标分析/查废同口径）', () => {
  const source = fs.readFileSync(path.join(__dirname, 'feasibilityReportStore.cjs'), 'utf-8');
  const fnStart = source.indexOf('async function importSourceDocuments');
  assert.notEqual(fnStart, -1, 'importSourceDocuments 必须存在');
  const body = source.slice(fnStart, source.indexOf('async function removeSourceDocument'));
  assert.match(body, /result\?\.errors/, '必须消费 result.errors');
  assert.match(body, /failedParts\.join\('；'\)/, '必须拼接逐文件原因');
});

test('MinerU 轮询：主进程 console 无裸日志', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fileService.cjs'), 'utf-8');
  assert.ok(!/console\.log\(/.test(source), '轮询状态细节不应打进主进程 console');
});

test('远程图片：50MB 上限（声明 content-length + 流式复核双层防御）', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fileService.cjs'), 'utf-8');
  assert.match(source, /const remoteImageMaxBytes = 50 \* 1024 \* 1024/);
  assert.match(source, /response\.headers\.get\('content-length'\)/);
  assert.match(source, /response\.body\.getReader\(\)/);
  assert.match(source, /totalBytes > remoteImageMaxBytes/);
});

test('解析缓存路径：fileService 与清扫服务共用同一 helper 定义', () => {
  const fileServiceSource = fs.readFileSync(path.join(__dirname, 'fileService.cjs'), 'utf-8');
  assert.match(fileServiceSource, /getLocalParseCacheDir\(app\)/);
  const pathsSource = fs.readFileSync(path.join(__dirname, '..', 'utils', 'paths.cjs'), 'utf-8');
  assert.match(pathsSource, /function getLocalParseCacheDir/);
  assert.match(pathsSource, /'parse-cache'/);
  const cleanupSource = fs.readFileSync(path.join(__dirname, 'storageCleanupService.cjs'), 'utf-8');
  assert.match(cleanupSource, /getLocalParseCacheDir\(app\)/, '清扫目标必须复用同一 helper 防路径漂移');
});
