const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 覆盖 R87 更新链路加固的纯函数与跨渠道完整性富化逻辑：
// 版本比较（含预发布门禁谓词）、sha256 digest 形态、临时文件识别、
// 文件名消毒、落盘就绪判定、attachGitHubIntegrityMetadata（校验源可注入，不触网）。
const {
  compareVersions,
  isValidSha256Digest,
  isUpdateTempFileName,
  sanitizeDownloadFileName,
  isDownloadedFileReady,
  attachGitHubIntegrityMetadata,
  setFetchGitHubReleaseForTest,
  MAX_UPDATE_INSTALLER_BYTES,
} = require('./updateService.cjs').__test;

const SHA_HEX = 'b'.repeat(64);

function makeAtomGitRelease(version) {
  return {
    channel: 'atomgit',
    version,
    files: [
      { name: `Yibiao-${version}-win-x64.exe`, url: 'https://api.atomgit.com/dl/exe', size: 0, digest: '' },
      { name: `Yibiao-${version}-source.zip`, url: 'https://api.atomgit.com/dl/zip', size: 0, digest: '' },
    ],
  };
}

test('compareVersions: 正式版高于同核心版本预发布（预发布门禁谓词依据）', () => {
  assert.equal(compareVersions('2.26.0-beta', '2.26.0'), -1);
  assert.equal(compareVersions('2.26.0', '2.26.0-beta'), 1);
});

test('compareVersions: 新核心版本的 beta 仍高于旧正式版', () => {
  assert.equal(compareVersions('2.26.0-beta', '2.25.27'), 1);
});

test('compareVersions: 预发布标识数值/字母规则与 build 元数据剔除', () => {
  assert.equal(compareVersions('2.26.0-alpha', '2.26.0-beta'), -1);
  assert.equal(compareVersions('2.26.0-1', '2.26.0-alpha'), -1);
  assert.equal(compareVersions('2.26.0+build.5', '2.26.0'), 0);
});

test('compareVersions: 核心段位数补齐', () => {
  assert.equal(compareVersions('2.26', '2.26.0'), 0);
  assert.equal(compareVersions('v2.26.1', '2.26.1'), 0);
});

test('isValidSha256Digest: 形态判定（前缀可有可无、大小写不限、长度/字符集严格）', () => {
  assert.equal(isValidSha256Digest(`sha256:${SHA_HEX}`), true);
  assert.equal(isValidSha256Digest(SHA_HEX), true);
  assert.equal(isValidSha256Digest(`SHA256:${SHA_HEX.toUpperCase()}`), true);
  assert.equal(isValidSha256Digest('a'.repeat(63)), false);
  assert.equal(isValidSha256Digest(`sha256:${'g'.repeat(64)}`), false);
  assert.equal(isValidSha256Digest(''), false);
  assert.equal(isValidSha256Digest(undefined), false);
  assert.equal(isValidSha256Digest('md5:0123456789abcdef0123456789abcdef'), false);
});

test('isUpdateTempFileName: 只识别下载残留的 .tmp 半成品', () => {
  assert.equal(isUpdateTempFileName('Yibiao-2.25.27-win-x64.exe.1234.1757641234567.tmp'), true);
  assert.equal(isUpdateTempFileName('Yibiao-2.25.27-win-x64.exe'), false);
  assert.equal(isUpdateTempFileName('notes.tmp.bak'), false);
  assert.equal(isUpdateTempFileName(''), false);
});

test('sanitizeDownloadFileName: 剥离路径分隔/危险字符与 ..', () => {
  // 替换先于 basename 发生：斜杠/反斜杠统一变下划线，结果必然是"扁平文件名"
  // （无路径分隔符、非 . / ..），跨平台行为一致——断言安全性质而非具体拼写。
  const traversal = sanitizeDownloadFileName('../../evil.exe', 'fallback.exe');
  assert.ok(!/[\\/]/.test(traversal), `结果不应含路径分隔符: ${traversal}`);
  assert.ok(traversal !== '.' && traversal !== '..');
  assert.equal(sanitizeDownloadFileName('a\\b:?.exe', 'fallback.exe'), 'a_b__.exe');
  assert.equal(sanitizeDownloadFileName('', 'fallback.exe'), 'fallback.exe');
  assert.equal(sanitizeDownloadFileName('..', 'fallback.exe'), 'fallback.exe');
});

test('isDownloadedFileReady: 不存在/空文件/清单 size 不符均判未就绪', () => {
  assert.equal(isDownloadedFileReady(path.join(os.tmpdir(), 'obk-no-such-update-file.exe')), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obk-update-test-'));
  try {
    const empty = path.join(dir, 'empty.exe');
    fs.writeFileSync(empty, '');
    assert.equal(isDownloadedFileReady(empty), false);

    const file = path.join(dir, 'file.exe');
    fs.writeFileSync(file, '12345');
    assert.equal(isDownloadedFileReady(file), true);
    assert.equal(isDownloadedFileReady(file, 5), true);
    assert.equal(isDownloadedFileReady(file, 6), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('attachGitHubIntegrityMetadata: github 渠道直接放行且不调用校验源', async () => {
  let called = 0;
  setFetchGitHubReleaseForTest(async () => {
    called += 1;
    return null;
  });
  const release = {
    channel: 'github',
    version: '2.26.0',
    files: [{ name: 'a.exe', url: 'https://github.com/x', digest: `sha256:${SHA_HEX}` }],
  };
  const result = await attachGitHubIntegrityMetadata(release);
  assert.equal(result, release);
  assert.equal(called, 0);
  setFetchGitHubReleaseForTest(null);
});

test('attachGitHubIntegrityMetadata: 缺 digest 时按同名资产从校验源补齐 digest 与 size', async () => {
  setFetchGitHubReleaseForTest(async (version) => {
    assert.equal(version, '2.26.0');
    return {
      channel: 'github',
      version: '2.26.0',
      files: [
        { name: 'Yibiao-2.26.0-win-x64.exe', url: 'https://github.com/x', size: 123456, digest: `sha256:${SHA_HEX}` },
      ],
    };
  });
  const result = await attachGitHubIntegrityMetadata(makeAtomGitRelease('2.26.0'));
  assert.notEqual(result, undefined);
  const exe = result.files.find((file) => file.name.endsWith('.exe'));
  assert.equal(exe.digest, `sha256:${SHA_HEX}`);
  assert.equal(exe.size, 123456);
  // 校验源没有的资产保持原样：是否放行由安装器 fail-closed 门禁裁决
  const zip = result.files.find((file) => file.name.endsWith('.zip'));
  assert.equal(isValidSha256Digest(zip.digest), false);
  setFetchGitHubReleaseForTest(null);
});

test('attachGitHubIntegrityMetadata: 校验源请求失败时原样返回不抛错（由门禁 fail-closed）', async () => {
  setFetchGitHubReleaseForTest(async () => {
    throw new Error('network down');
  });
  const release = makeAtomGitRelease('2.26.0');
  const result = await attachGitHubIntegrityMetadata(release);
  assert.equal(result, release);
  setFetchGitHubReleaseForTest(null);
});

test('attachGitHubIntegrityMetadata: 全部资产已有合法 digest 时不调用校验源', async () => {
  let called = 0;
  setFetchGitHubReleaseForTest(async () => {
    called += 1;
    return null;
  });
  const release = {
    channel: 'atomgit',
    version: '2.26.0',
    files: [{ name: 'a.exe', url: 'https://atomgit.com/x', size: 1, digest: `sha256:${SHA_HEX}` }],
  };
  const result = await attachGitHubIntegrityMetadata(release);
  assert.equal(result, release);
  assert.equal(called, 0);
  setFetchGitHubReleaseForTest(null);
});

test('MAX_UPDATE_INSTALLER_BYTES: 上限常量远大于合法安装包（1.5GB）', () => {
  assert.equal(MAX_UPDATE_INSTALLER_BYTES, 1536 * 1024 * 1024);
});
