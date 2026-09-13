// licenseService 回归测试：刷新超时/错误净化/失效写盘守卫/时钟水位/渲染层提醒链路。
// 网络全部走 require.cache 注入的假 undici fetch，不触真实网络；
// 不产生合法签名授权（无私钥），仅覆盖无需签名的状态路径。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let fakeFetchImpl = null;
let fetchCallCount = 0;
const undiciPath = require.resolve('undici');
require.cache[undiciPath] = {
  id: undiciPath,
  filename: undiciPath,
  loaded: true,
  exports: {
    fetch: (...args) => {
      fetchCallCount += 1;
      return fakeFetchImpl(...args);
    },
  },
};

const { createLicenseService } = require('./licenseService.cjs');

function makeService({ isPackaged = true, refreshTimeoutMs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-license-test-'));
  const app = {
    isPackaged,
    getPath: (kind) => path.join(root, kind),
    getVersion: () => '9.9.9-test',
  };
  const configStore = {
    load: () => ({
      analytics_client_id: 'test-client-id',
      analytics_created_at: '2026-01-01T00:00:00.000Z',
    }),
  };
  const service = createLicenseService({ app, configStore, ...(refreshTimeoutMs ? { refreshTimeoutMs } : {}) });
  return { service, root };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// 尊重 signal 的挂起 fetch：超时守卫触发 abort 时以 AbortError 拒绝；
// 若守卫未生效则 5s 后以测试失败收尾，避免测试挂死。
function abortingFetch() {
  return (_url, options = {}) => new Promise((_resolve, reject) => {
    const fallback = setTimeout(() => reject(new Error('test: fetch 未按时被 abort，超时守卫未生效')), 5000);
    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        clearTimeout(fallback);
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      });
    }
  });
}

const LICENSE_SOURCE = fs.readFileSync(path.join(__dirname, 'licenseService.cjs'), 'utf-8');
const PROMPT_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'app', 'LicenseStatusPrompt.tsx'), 'utf-8');

function regionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `未找到起始标记：${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notStrictEqual(end, -1, `未找到结束标记：${endMarker}`);
  return source.slice(start, end);
}

test('C2 授权刷新按注入超时中止并返回固定超时文案', async () => {
  fakeFetchImpl = abortingFetch();
  const { service, root } = makeService({ refreshTimeoutMs: 200 });
  const startedAt = Date.now();
  try {
    const status = await service.refresh();
    const elapsed = Date.now() - startedAt;
    assert.strictEqual(status.status, 'refresh_failed');
    assert.match(status.refreshError, /响应超时/);
    assert.ok(!status.refreshError.includes('toubiao.ztok.dpdns.org'), '不得泄露内部端点');
    assert.ok(elapsed < 2000, `应由超时守卫中止（实际 ${elapsed}ms）`);
    assert.strictEqual(fetchCallCount, 1);
  } finally {
    cleanup(root);
  }
});

test('C2 连接失败归一固定文案且不泄露端点与 OS 细节', async () => {
  fakeFetchImpl = async () => {
    throw new Error('fetch failed');
  };
  const { service, root } = makeService({ refreshTimeoutMs: 5000 });
  try {
    const status = await service.refresh();
    assert.strictEqual(status.status, 'refresh_failed');
    assert.match(status.refreshError, /连接失败/);
    assert.ok(!status.refreshError.includes('toubiao.ztok.dpdns.org'), '不得泄露内部端点');
    assert.ok(!status.refreshError.includes('fetch failed'), '不得透传 OS 层错误');
  } finally {
    cleanup(root);
  }
});

test('C2 HTTP 业务错误保留授权服务返回文案', async () => {
  fakeFetchImpl = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ code: 1, message: '授权次数不足，请稍后再试' }),
  });
  const { service, root } = makeService({ refreshTimeoutMs: 5000 });
  try {
    const status = await service.refresh();
    assert.strictEqual(status.status, 'refresh_failed');
    assert.strictEqual(status.refreshError, '授权次数不足，请稍后再试');
  } finally {
    cleanup(root);
  }
});

test('C2 授权服务返回格式不完整走固定文案', async () => {
  fakeFetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, license: { payload: {} } }),
  });
  const { service, root } = makeService({ refreshTimeoutMs: 5000 });
  try {
    const status = await service.refresh();
    assert.strictEqual(status.status, 'refresh_failed');
    assert.match(status.refreshError, /数据格式不完整/);
  } finally {
    cleanup(root);
  }
});

test('C2 开发调试模式不触发任何网络请求', async () => {
  fetchCallCount = 0;
  fakeFetchImpl = async () => {
    throw new Error('开发调试模式不应发起网络请求');
  };
  const { service, root } = makeService({ isPackaged: false });
  try {
    const status = await service.refresh();
    assert.strictEqual(status.status, 'debug_disabled');
    assert.strictEqual(fetchCallCount, 0);
  } finally {
    cleanup(root);
  }
});

test('C2 超时源断言：默认 30000+可注入参数+signal 接线+clearTimeout 清理', () => {
  assert.match(LICENSE_SOURCE, /const LICENSE_REFRESH_TIMEOUT_MS = 30000;/);
  assert.match(LICENSE_SOURCE, /function createLicenseService\(\{ app, configStore, refreshTimeoutMs = LICENSE_REFRESH_TIMEOUT_MS \}\)/);
  const region = regionBetween(LICENSE_SOURCE, 'const controller = new AbortController();', 'async function refreshOnStartup');
  assert.match(region, /setTimeout\(\(\) => controller\.abort\(\), refreshTimeoutMs\)/);
  assert.match(region, /signal: controller\.signal/);
  assert.match(region, /clearTimeout\(timer\)/);
});

test('C1 离线授权文件读取错误净化源断言：try/catch+固定文案+诊断日志', () => {
  const region = regionBetween(LICENSE_SOURCE, 'async function importOfflineLicenseFile(', '\n  return {');
  assert.match(region, /try \{\n\s+content = fs\.readFileSync\(result\.filePaths\[0\], 'utf-8'\);/);
  assert.match(region, /throw new Error\('无法读取所选授权文件，请确认文件未被占用且可正常访问'\)/);
  assert.match(region, /console\.error\('\[license\] 读取离线授权文件失败'/);
});

test('C4 已失效授权跳过重复写盘：失效标记守卫位于写盘调用之前', () => {
  const region = regionBetween(LICENSE_SOURCE, 'payload.clientId !== runtimeContext.clientId', "statusFromPayload(payload, 'machine_mismatch'");
  const guardIdx = region.indexOf('if (!envelope.local?.invalidated)');
  const callIdx = region.indexOf("invalidateLocalLicense(envelope, 'license_machine_mismatch')");
  assert.notStrictEqual(guardIdx, -1, '缺少失效标记守卫');
  assert.notStrictEqual(callIdx, -1, '缺少失效写盘调用');
  assert.ok(guardIdx < callIdx, '守卫必须先于失效写盘调用');
});

test('C3 周期性复核源断言：30 分钟间隔+清理+问题签名去重', () => {
  assert.match(PROMPT_SOURCE, /const RECHECK_INTERVAL_MS = 30 \* 60 \* 1000;/);
  assert.match(PROMPT_SOURCE, /window\.setInterval\(\(\) => \{\n\s+void checkLicense\(\);\n\s+\}, RECHECK_INTERVAL_MS\)/);
  assert.match(PROMPT_SOURCE, /window\.clearInterval\(timer\)/);
  assert.match(PROMPT_SOURCE, /dismissedSignatureRef\.current = problemSignature\(licenseStatus\)/);
  assert.match(PROMPT_SOURCE, /problemSignature\(finalStatus\) === dismissedSignatureRef\.current/);
});

test('C5 差异化提示文案源断言：四类问题+官方链接仅对来源不可信', () => {
  const region = regionBetween(PROMPT_SOURCE, 'function getLicenseHint(', 'function shouldShowPrompt(');
  assert.match(region, /请续期授权，或使用下方离线激活授权。/);
  assert.match(region, /请检查网络后重试，或使用下方离线激活授权。/);
  assert.match(region, /请重新获取授权，或使用下方离线激活授权。/);
  assert.match(region, /请从官方渠道下载可信客户端：/);
  assert.match(PROMPT_SOURCE, /const showOfficialLink = licenseStatus\?\.sourceTrusted === false;/);
  assert.match(PROMPT_SOURCE, /\{showOfficialLink && \(/);
});

test('时钟水位源断言：取最大值推进+10 分钟落盘间隔+isExpired 水位回退口径', () => {
  const advanceRegion = regionBetween(LICENSE_SOURCE, 'function advanceClockWatermark()', 'function getPublicJwk()');
  assert.match(advanceRegion, /if \(nowMs <= clockWatermarkMs\) return;/);
  assert.match(advanceRegion, /10 \* 60 \* 1000/);
  const isExpiredRegion = regionBetween(LICENSE_SOURCE, 'function isExpired(', 'let clockWatermarkMs = 0;');
  assert.match(isExpiredRegion, /clockWatermarkMs > 0 \? clockWatermarkMs : Date\.now\(\)/);
});

test('refreshOnStartup 离线授权短路保持（回归护栏）', () => {
  const region = regionBetween(LICENSE_SOURCE, 'async function refreshOnStartup()', 'async function activateOfflineLicenseEnvelope');
  assert.match(region, /if \(status\.activationMode === 'offline'\) \{\n\s+return status;/);
});
