'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDonationService } = require('./donationService.cjs');
const SERVICE_SOURCE = fs.readFileSync(path.join(__dirname, 'donationService.cjs'), 'utf-8');

// 假 app 只提供临时 userData 路径；fetch 一律 stub，不发真实网络请求。
function makeApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-donation-'));
  return { getPath: (key) => path.join(root, key) };
}

function makeService() {
  const prompts = [];
  const service = createDonationService({
    app: makeApp(),
    onPrompt: (prompt) => prompts.push(prompt),
    onPaid: () => {},
  });
  // 服务内含分钟级 setInterval：每个测试结束必须 close 清理计时器，否则进程不退出
  return { service, prompts, close: () => service.close() };
}

function regionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `未找到起始标记：${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notStrictEqual(end, -1, `未找到结束标记：${endMarker}`);
  return source.slice(start, end);
}

function withFetch(stub, fn) {
  const original = global.fetch;
  global.fetch = stub;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      global.fetch = original;
    });
}

test('C1 非 JSON 错误页响应体清洗截断（HTML 全文不直达打赏弹窗）', async () => {
  const { service, close } = makeService();
  const html = `<html>\n  <body>  ${'<p>Gateway Error</p>'.repeat(300)}  </body>\n</html>`;
  try {
    await withFetch(async () => ({
      ok: false,
      status: 502,
      text: async () => html,
    }), async () => {
      await assert.rejects(
        () => service.getConfig(),
        (error) => {
          assert.strictEqual(error.statusCode, 502);
          assert.ok(error.message.length <= 200, '摘要必须截断');
          assert.ok(!error.message.includes('<'), 'HTML 标签必须剥离');
          assert.ok(!error.message.includes('\n'), '换行必须剥离');
          assert.match(error.message, /Gateway Error/);
          return true;
        },
      );
    });
  } finally {
    close();
  }
});

test('C1 FastAPI 风格 detail 数组口径保持（清洗不破坏既有 detail 优先级）', async () => {
  const { service, close } = makeService();
  try {
    await withFetch(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ detail: [{ msg: '金额无效' }, { msg: '渠道不可用' }] }),
    }), async () => {
      await assert.rejects(
        () => service.getConfig(),
        (error) => {
          assert.strictEqual(error.message, '金额无效；渠道不可用');
          assert.strictEqual(error.statusCode, 400);
          return true;
        },
      );
    });
  } finally {
    close();
  }
});

test('C1 连接失败固定前缀与空响应体兜底口径保持', async () => {
  const { service, close } = makeService();
  try {
    await withFetch(async () => {
      throw new Error('fetch failed');
    }, async () => {
      await assert.rejects(() => service.getConfig(), /无法连接打赏服务：fetch failed/);
    });
    await withFetch(async () => ({
      ok: false,
      status: 500,
      text: async () => '',
    }), async () => {
      await assert.rejects(
        () => service.getConfig(),
        (error) => {
          assert.match(error.message, /打赏服务请求失败：HTTP 500/);
          return true;
        },
      );
    });
  } finally {
    close();
  }
});

test('C1 响应体清洗源断言（text fallback 必须剥标签、剥离换行并截断）', () => {
  const region = regionBetween(SERVICE_SOURCE, 'if (!response.ok) {', 'requestError.statusCode = response.status;');
  assert.match(region, /replace\(\/<\[\^>\]\*>\/g, ' '\)/);
  assert.match(region, /replace\(\/\\s\+\/g, ' '\)/);
  assert.match(region, /\.slice\(0, 200\)/);
  assert.match(region, /detail \|\| fallbackText \|\|/);
});
