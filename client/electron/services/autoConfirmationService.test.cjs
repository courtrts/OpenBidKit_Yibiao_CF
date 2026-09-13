'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createAutoConfirmationService } = require('./autoConfirmationService.cjs');
const SERVICE_SOURCE = fs.readFileSync(path.join(__dirname, 'autoConfirmationService.cjs'), 'utf-8');
const AGENT_SOURCE = fs.readFileSync(path.join(__dirname, 'agentService.cjs'), 'utf-8');
const TASK_SOURCE = fs.readFileSync(path.join(__dirname, 'taskService.cjs'), 'utf-8');
const QUESTION_DIALOG_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared', 'ui', 'AgentQuestionDialogProvider.tsx'), 'utf-8');
const OUTLINE_DIALOG_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'features', 'technical-plan', 'components', 'OutlineSelectionDialog.tsx'), 'utf-8');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeService({ enabled = true, delayMs = 40 } = {}) {
  return createAutoConfirmationService({
    configStore: { load: () => ({ agent_auto_answer_enabled: enabled }) },
    delayMs,
  });
}

test('C3 自动提交成功：只触发一次且截止时间同步业务', async () => {
  const service = makeService();
  let submits = 0;
  const states = [];
  service.register({
    id: 'q-1',
    submit: async () => { submits += 1; },
    onStateChange: (state) => { states.push({ ...state }); },
  });
  await sleep(120);
  assert.strictEqual(submits, 1, '自动提交应只触发一次');
  assert.ok(states.some((state) => typeof state.auto_answer_at === 'string'), '触发前应同步截止时间');
  assert.ok(states.some((state) => state.auto_answer_at === undefined), '触发前应清空截止时间');
  service.close();
});

test('C3 自动提交失败：不静默（onSubmitError + 失败位 + 不重试）', async () => {
  const service = makeService();
  let submits = 0;
  let errorSeen = null;
  const states = [];
  service.register({
    id: 'q-2',
    submit: async () => {
      submits += 1;
      throw new Error('submit boom');
    },
    onStateChange: (state) => { states.push({ ...state }); },
    onSubmitError: (error) => { errorSeen = error; },
  });
  await sleep(120);
  assert.strictEqual(submits, 1, '失败后不应重试提交');
  assert.strictEqual(errorSeen?.message, 'submit boom');
  assert.ok(states.some((state) => state.auto_submit_failed === true), '应向业务同步失败位');
  service.close();
});

test('C3 全局开关关闭：不安装计时器', async () => {
  const service = makeService({ enabled: false });
  let submits = 0;
  service.register({ id: 'q-3', submit: async () => { submits += 1; } });
  await sleep(120);
  assert.strictEqual(submits, 0);
  service.close();
});

test('C3 suppress 停止本轮自动提交', async () => {
  const service = makeService();
  let submits = 0;
  const states = [];
  service.register({
    id: 'q-4',
    submit: async () => { submits += 1; },
    onStateChange: (state) => { states.push({ ...state }); },
  });
  service.suppress('q-4');
  await sleep(120);
  assert.strictEqual(submits, 0);
  assert.ok(states.some((state) => state.auto_answer_at === undefined), 'suppress 应清空截止时间');
  service.close();
});

test('C3 重复注册作废旧确认项（stale timer 守卫）', async () => {
  const service = makeService();
  let first = 0;
  let second = 0;
  service.register({ id: 'q-5', submit: async () => { first += 1; } });
  service.register({ id: 'q-5', submit: async () => { second += 1; } });
  await sleep(120);
  assert.strictEqual(first, 0, '旧确认项在重新注册后不得触发');
  assert.strictEqual(second, 1);
  // stale 守卫：计时回调触发前校验 entry 身份（注册与失败回调两处）
  assert.ok((SERVICE_SOURCE.match(/entries\.get\(entry\.id\) !== entry/g) || []).length >= 2);
  service.close();
});

test('C3 close 清理未完成计时', async () => {
  const service = makeService();
  let submits = 0;
  service.register({ id: 'q-6', submit: async () => { submits += 1; } });
  service.close();
  await sleep(120);
  assert.strictEqual(submits, 0);
});

test('C3 业务接线源断言（agent / task / 两对话框文案）', () => {
  const agentRegion = AGENT_SOURCE.slice(AGENT_SOURCE.indexOf('autoConfirmationService.register({'));
  assert.match(agentRegion, /onSubmitError/);
  assert.match(agentRegion, /auto_submit_failed/);
  assert.match(agentRegion, /自动回答提交失败/);
  const taskRegion = TASK_SOURCE.slice(TASK_SOURCE.indexOf('autoConfirmationService.register({'));
  assert.match(taskRegion, /onSubmitError/);
  assert.match(taskRegion, /auto_submit_failed/);
  assert.match(taskRegion, /一级目录自动确认提交失败/);
  assert.match(QUESTION_DIALOG_SOURCE, /auto_submit_failed/);
  assert.match(QUESTION_DIALOG_SOURCE, /自动回答未成功，请手动提交/);
  assert.match(OUTLINE_DIALOG_SOURCE, /auto_submit_failed/);
  assert.match(OUTLINE_DIALOG_SOURCE, /自动确认未成功，请手动提交/);
});
