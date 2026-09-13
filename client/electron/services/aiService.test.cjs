'use strict';

// aiService 统一文本/生图出口永久回归测试：
// - 流式（默认请求方式）finish_reason 捕获与截断检测（fail_on_truncation / JSON 截断快速失败）
// - 模型列表/模型信息元数据请求超时保护与固定文案
// - Agent 代理请求与常规 chat 的废弃模型映射同口径
// - 生图模型测试 mime 透传
// - ComfyUI 非幂等提交不包裹重试层（防双排）
// global fetch 全程由桩接管：/track 分析上报被桩吞掉并计入 calls，本测试不触达真实网络、
// 不向生产统计发送任何事件
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createAiService } = require('./aiService.cjs');

const CHAT_URL = 'http://ai.test/chat/completions';
const MODELS_URL = 'http://ai.test/models';
const MODEL_INFO_URL_PREFIX = 'https://toubiao.ztok.dpdns.org/model-info';
const TRACK_URL = 'https://toubiao.ztok.dpdns.org/track';

function makeBaseConfig(overrides = {}) {
  return {
    api_key: 'test-key',
    model_name: 'test-model',
    base_url: 'http://ai.test',
    request_mode: 'stream',
    developer_mode: false,
    analytics_client_id: 'machine-v1-test',
    analytics_created_at: '2026-01-01',
    ...overrides,
  };
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const sseChunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

async function withHarness(configOverrides, fetchImpl, fn) {
  const config = makeBaseConfig(configOverrides);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const key = String(url);
    calls.push({ url: key, init });
    if (key === TRACK_URL) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    return fetchImpl(key, init);
  };
  const service = createAiService({
    app: {},
    configStore: { load: () => structuredClone(config) },
    metadataTimeoutMs: 150,
  });
  try {
    return await fn({ service, calls, config });
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('流式模式（默认）finish_reason=length 时 fail_on_truncation 生效', async () => {
  await withHarness({}, () => sseResponse([
    sseChunk({ choices: [{ delta: { content: '半章内容' } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    'data: [DONE]\n\n',
  ]), async ({ service }) => {
    await assert.rejects(
      service.chat({ messages: [{ role: 'user', content: 'hi' }], fail_on_truncation: true }),
      /max_tokens 截断/,
    );
  });
});

test('流式模式 finish_reason=stop 正常返回完整内容', async () => {
  await withHarness({}, () => sseResponse([
    sseChunk({ choices: [{ delta: { content: '你好' } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ]), async ({ service }) => {
    const content = await service.chat({ messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(content, '你好');
  });
});

test('流式响应缺失 finish_reason 时不产生误判截断', async () => {
  await withHarness({}, () => sseResponse([
    sseChunk({ choices: [{ delta: { content: '完整内容' } }] }),
    'data: [DONE]\n\n',
  ]), async ({ service }) => {
    const content = await service.chat({
      messages: [{ role: 'user', content: 'hi' }],
      fail_on_truncation: true,
    });
    assert.strictEqual(content, '完整内容');
  });
});

test('普通模式（normal）finish_reason=length 行为保持不变', async () => {
  await withHarness({ request_mode: 'normal' }, () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: '半章' }, finish_reason: 'length' }],
      usage: {},
    }),
  }), async ({ service }) => {
    await assert.rejects(
      service.chat({ messages: [{ role: 'user', content: 'hi' }], fail_on_truncation: true }),
      /max_tokens 截断/,
    );
  });
});

test('JSON 收集链路流式截断直接终局报错（不空跑解析-修复循环）', async () => {
  await withHarness({}, () => sseResponse([
    sseChunk({ choices: [{ delta: { content: '{"a": 1' } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    'data: [DONE]\n\n',
  ]), async ({ service, calls }) => {
    await assert.rejects(
      service.collectJsonResponse({
        messages: [{ role: 'user', content: '返回 JSON' }],
        response_format: { type: 'json_object' },
      }),
      (error) => {
        assert.match(error.message, /max_tokens 截断/);
        const chatCalls = calls.filter((call) => call.url === CHAT_URL).length;
        // 截断输出救不回来：只允许 1 次模型请求，不允许解析-修复-重发循环
        assert.strictEqual(chatCalls, 1);
        return true;
      },
    );
  });
});

test('getModelInfo 挂起请求在超时窗口内以明确文案失败', async () => {
  await withHarness({}, () => new Promise(() => {}), async ({ service }) => {
    await assert.rejects(
      service.getModelInfo('gpt-test'),
      /获取模型信息失败：请求超时，请检查网络后重试/,
    );
  });
});

test('getModelInfo 正常返回模型信息（超时包裹无回归）', async () => {
  await withHarness({}, (url) => {
    if (url.startsWith(MODEL_INFO_URL_PREFIX)) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          syncedAt: '2026-01-01T00:00:00Z',
          model: {
            reasoningEfforts: ['high'],
            context: 128000,
            output: 8000,
            inputModalities: ['text'],
            outputModalities: ['text'],
            imageInputStatus: 'supported',
            temperatureStatus: 'supported',
            concurrencyLimit: 5,
            requestMode: 'stream',
            sourceCount: 3,
          },
        }),
      });
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  }, async ({ service }) => {
    const result = await service.getModelInfo('gpt-test');
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.model.context, 128000);
    assert.strictEqual(result.model.concurrencyLimit, 5);
    assert.strictEqual(result.model.imageInputStatus, 'supported');
  });
});

test('listModels 挂起请求在超时窗口内以明确文案失败', async () => {
  await withHarness({}, () => new Promise(() => {}), async ({ service }) => {
    await assert.rejects(
      service.listModels(),
      /获取模型列表失败：请求超时，请检查网络后重试/,
    );
  });
});

test('listModels 正常返回并过滤废弃模型（超时包裹无回归）', async () => {
  await withHarness({}, (url) => {
    if (url === MODELS_URL) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-5.6-luna' }, { id: 'gpt-test' }, { id: null }] }),
      });
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  }, async ({ service }) => {
    const result = await service.listModels();
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.models, ['gpt-test']);
  });
});

test('Agent 代理请求与常规 chat 同口径应用废弃模型映射', async () => {
  const seen = [];
  await withHarness({ model_name: 'gpt-5.6-luna' }, (url, init) => {
    if (url === CHAT_URL) {
      seen.push(JSON.parse(String(init?.body || '')));
      return sseResponse([
        sseChunk({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
        'data: [DONE]\n\n',
      ]);
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  }, async ({ service }) => {
    await service.runAgentChatCompletion({
      body: { messages: [{ role: 'user', content: 'hi' }] },
      consumeResponse: async () => ({
        content: 'ok',
        responseData: { choices: [{ message: { content: 'ok' } }] },
        usage: {},
      }),
    });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].model, 'gpt-5.6-terra');
  });
});

test('生图模型测试按响应字段返回真实 mime', async () => {
  const b64 = Buffer.from('fake-image-bytes').toString('base64');
  const imageConfig = {
    provider: 'custom',
    api_key: 'img-key',
    model_name: 'img-model',
    base_url: 'http://img.test',
    request_mode: 'normal',
  };
  await withHarness({}, (url) => {
    if (url === 'http://img.test/images/generations') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: b64, mime_type: 'image/jpeg' }] }),
      });
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  }, async ({ service }) => {
    const result = await service.testImageModel({ ...makeBaseConfig(), image_model: imageConfig });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.mime_type, 'image/jpeg');
    assert.strictEqual(result.image_data, b64);
  });
});

test('生图模型测试响应无 mime 字段时保持 png 默认', async () => {
  const b64 = Buffer.from('fake-image-bytes').toString('base64');
  const imageConfig = {
    provider: 'custom',
    api_key: 'img-key',
    model_name: 'img-model',
    base_url: 'http://img.test',
    request_mode: 'normal',
  };
  await withHarness({}, (url) => {
    if (url === 'http://img.test/images/generations') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: b64 }] }),
      });
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  }, async ({ service }) => {
    const result = await service.testImageModel({ ...makeBaseConfig(), image_model: imageConfig });
    assert.strictEqual(result.mime_type, 'image/png');
  });
});

test('文本请求成功路径产生一次分析上报且被测试桩吞掉（不污染生产统计）', async () => {
  await withHarness({}, () => sseResponse([
    sseChunk({ choices: [{ delta: { content: 'x' } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    'data: [DONE]\n\n',
  ]), async ({ service, calls }) => {
    await service.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const tracked = calls.filter((call) => call.url === TRACK_URL);
    assert.strictEqual(tracked.length, 1);
    const body = JSON.parse(tracked[0].init.body);
    assert.strictEqual(body.event, 'ai_request');
    assert.strictEqual(body.client_id, 'machine-v1-test');
    // 流式 usage 透传口径不回退
    assert.strictEqual(body.prompt_tokens, 10);
    assert.strictEqual(body.completion_tokens, 5);
  });
});

test('ComfyUI 提交段不包裹重试层（非幂等提交防双排）', () => {
  const source = fs.readFileSync(path.join(__dirname, 'aiService.cjs'), 'utf8');
  const start = source.indexOf('const submitted = await');
  const end = source.indexOf('const promptId =');
  assert.ok(start > -1 && end > start, '未找到 ComfyUI 提交代码段');
  const region = source.slice(start, end);
  assert.ok(region.includes('submitComfyUIPrompt'), '提交段应调用 submitComfyUIPrompt');
  assert.ok(
    !region.includes('runWithAiRetry'),
    '非幂等提交不应包裹 runWithAiRetry：超时 AbortError 可重试会导致同一提示词重复排队',
  );
});
