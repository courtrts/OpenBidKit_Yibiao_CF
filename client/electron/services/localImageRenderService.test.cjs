const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { __test__ } = require('./localImageRenderService.cjs');
const { getLocalRenderTempDir } = require('../utils/paths.cjs');

const SERVICE_SOURCE = fs.readFileSync(path.join(__dirname, 'localImageRenderService.cjs'), 'utf-8');
const PATHS_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'utils', 'paths.cjs'), 'utf-8');

test('HTML 布局探针覆盖文字变形、裁切、遮挡和重叠，不把竖排文字列为问题', () => {
  const probe = __test__.buildHtmlLayoutProbeScript();
  assert.match(probe, /文字存在旋转、倒置、镜像或缩放变形/);
  assert.match(probe, /文字被容器裁切/);
  assert.match(probe, /文字被前景元素遮挡/);
  assert.match(probe, /文字内容发生重叠/);
  assert.doesNotMatch(probe, /writing-mode/);
});

test('Mermaid 与 HTML 截图共用高度硬上限（失控 AI 产出防拼接 Buffer OOM）', () => {
  // 顶层共享常量，HTML 侧内联常量必须消除（防两处口径漂移）
  assert.match(SERVICE_SOURCE, /const MAX_CONTENT_CAPTURE_HEIGHT = 20000/);
  assert.doesNotMatch(SERVICE_SOURCE, /MAX_HTML_CAPTURE_HEIGHT/);
  // Mermaid 路径超限抛错（由 Mermaid 修复回路把错误喂模型简化图、导出侧走 loadRetry 通道）
  assert.match(SERVICE_SOURCE, /Mermaid 图面高度 \$\{height\}px 超过 \$\{MAX_CONTENT_CAPTURE_HEIGHT\}px 上限/);
  // HTML 路径同口径
  assert.match(SERVICE_SOURCE, /HTML 页面高度 \$\{height\}px 超过 \$\{MAX_CONTENT_CAPTURE_HEIGHT\}px 上限/);
});

test('布局质检探针有总超时守卫（页面内 O(n²) 重叠检测不挂死主进程）', () => {
  const wraps = SERVICE_SOURCE.match(/withTimeout\(\s*probeHtmlLayoutIssues\(win\.webContents\)/g) || [];
  assert.equal(wraps.length, 2, 'renderHtmlToPng 与 probeHtmlLayoutOnly 两处探针都必须包总超时');
  assert.match(SERVICE_SOURCE, /HTML 布局质检超时/);
});

test('渲染页加载失败用固定文案，诊断细节进 console.error（Chromium 错误码不暴露给用户）', () => {
  const userFacing = SERVICE_SOURCE.match(/finish\(new Error\('本地渲染页面加载失败'\)\)/g) || [];
  assert.equal(userFacing.length, 2, 'onFail 与 loadURL catch 两处都必须是固定文案');
  // 不得把 description/code 拼进用户可见错误
  assert.doesNotMatch(SERVICE_SOURCE, /加载渲染页面失败：\$\{/);
  assert.match(SERVICE_SOURCE, /console\.error\('\[local-image-render\]/);
});

test('HTML 质检探针检测坏图（complete 恒真但 naturalWidth=0 的 img 静默留白）', () => {
  const probe = __test__.buildHtmlLayoutProbeScript();
  assert.match(probe, /img\.complete&&!\(img\.naturalWidth>0\)/);
  assert.match(probe, /图片加载失败/);
});

test('转图临时目录走 paths.cjs 共享 helper（防路径漂移，清扫目标同源）', () => {
  assert.match(SERVICE_SOURCE, /getLocalRenderTempDir/);
  assert.doesNotMatch(SERVICE_SOURCE, /os\.tmpdir/);
  assert.match(PATHS_SOURCE, /function getLocalRenderTempDir\(\)/);
  assert.match(PATHS_SOURCE, /yibiao-local-image-render/);
});

test('getLocalRenderTempDir 返回系统临时区下的固定子目录', () => {
  assert.equal(getLocalRenderTempDir(), path.join(os.tmpdir(), 'yibiao-local-image-render'));
});
