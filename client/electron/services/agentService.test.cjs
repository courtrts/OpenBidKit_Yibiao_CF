const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// 在加载 agentService 前向模块缓存注入假 Pi 运行时：
// 行为测试只跑 agentService 协调层，不触碰真实运行时/网络/错误上报。
const piRuntimePath = require.resolve('./pi/piRuntimeService.cjs');
let fakeRunTask = () => new Promise(() => {});
let lastRuntimeOptions = null;
require.cache[piRuntimePath] = {
  id: piRuntimePath,
  filename: piRuntimePath,
  loaded: true,
  exports: {
    createPiRuntimeService: (options = {}) => {
      lastRuntimeOptions = options;
      return {
        runTask: (payload) => fakeRunTask(payload),
        close: async () => {},
        onStatus: () => () => {},
        getStatus: () => ({}),
      };
    },
  },
};

const { createAgentService } = require('./agentService.cjs');

const AGENT_SOURCE = fs.readFileSync(path.join(__dirname, 'agentService.cjs'), 'utf8');
const PI_SOURCE = fs.readFileSync(path.join(__dirname, 'pi', 'piRuntimeService.cjs'), 'utf8');
const IPC_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'ipc', 'agentIpc.cjs'), 'utf8');
const PRELOAD_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8');
const DIALOG_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared', 'ui', 'AgentQuestionDialogProvider.tsx'), 'utf8');
const IPC_TYPES_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared', 'types', 'ipc.ts'), 'utf8');

function makeService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-service-test-'));
  const autoConfirmationCalls = { registered: [], unregistered: [], suppressed: [] };
  const service = createAgentService({
    app: { getPath: (key) => path.join(root, key) },
    configStore: { load: () => ({}), save: () => {} },
    aiService: {},
    licenseService: { isLicensed: () => true },
    autoConfirmationService: {
      register: ({ id }) => {
        autoConfirmationCalls.registered.push(id);
        return () => autoConfirmationCalls.unregistered.push(id);
      },
      unregister: (id) => { autoConfirmationCalls.unregistered.push(id); },
      suppress: (id) => { autoConfirmationCalls.suppressed.push(id); },
    },
  });
  return { service, autoConfirmationCalls, root };
}

function extractRegion(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `源断言未找到起始标记: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `源断言未找到结束标记: ${endMarker}`);
  return source.slice(start, end);
}

// 经注入给假运行时的 requestUserQuestion 建立一次真实登记的待答提问。
async function createPendingQuestion(service, taskId) {
  const ask = lastRuntimeOptions?.requestUserQuestion;
  assert.ok(typeof ask === 'function', '未取到注入运行时的提问函数');
  const questionPromise = ask({
    question: '测试问题',
    options: [{ label: '选项 A' }, { label: '选项 B' }],
    task_id: taskId,
  }, new AbortController().signal);
  const settle = { done: false };
  questionPromise.then(
    (value) => { settle.done = true; settle.value = value; },
    (error) => { settle.done = true; settle.error = error; },
  );
  await Promise.resolve();
  return { question: service.getPendingQuestion(), settle };
}

test('R117-C1 同一 task_id 并发启动被拒绝（防 activeEntries 覆盖与跨任务归档误删）', async () => {
  const { service } = makeService();
  fakeRunTask = () => new Promise(() => {});
  const first = service.runTask({ task_id: 'dup-1', title: '任务 A' });
  first.catch(() => {});
  await assert.rejects(service.runTask({ task_id: 'dup-1' }), /已有运行中的任务/);
  const second = service.runTask({ task_id: 'dup-2' });
  second.catch(() => {});
  assert.equal(service.getStatus().active_tasks.length, 2);
});

test('R117-C1 重复 taskId 守卫位于 taskId 解析之后、entry 创建之前（源断言）', () => {
  const region = extractRegion(AGENT_SOURCE, 'function startTask(', 'function runTask(');
  const idIndex = region.indexOf('payload.task_id ||');
  const guardIndex = region.indexOf('activeEntries.has(taskId)');
  const setIndex = region.indexOf('activeEntries.set(taskId, entry)');
  assert.ok(idIndex > -1 && guardIndex > idIndex && setIndex > -1 && guardIndex < setIndex,
    '重复 taskId 守卫必须在 taskId 解析之后、activeEntries.set 之前');
});

test('R117-C2 cancelQuestion 按任务取消口径了结提问并停止自动回答计时（E2E）', async () => {
  const { service, autoConfirmationCalls } = makeService();
  fakeRunTask = () => new Promise(() => {});
  const task = service.runTask({ task_id: 'q-task-1' });
  task.catch(() => {});
  const { question, settle } = await createPendingQuestion(service, 'q-task-1');
  assert.ok(question, '待答提问应可见');
  assert.ok(autoConfirmationCalls.registered.includes(`agent-question:${question.question_id}`),
    '推荐选项应已登记自动回答');
  assert.deepEqual(service.cancelQuestion({ question_id: question.question_id }), { success: true });
  assert.equal(service.getPendingQuestion(), null);
  await Promise.resolve();
  assert.equal(settle.done, true);
  assert.equal(settle.error.code, 'TASK_CANCELLED');
  assert.match(settle.error.message, /任务已取消/);
  assert.ok(autoConfirmationCalls.unregistered.includes(`agent-question:${question.question_id}`),
    '取消后应反注册自动回答计时');
});

test('R117-C2 cancelQuestion 对不存在的问题抛固定文案（不泄露内部细节）', () => {
  const { service } = makeService();
  assert.throws(() => service.cancelQuestion({ question_id: 'no-such-question' }), /该问题不存在或已处理/);
  assert.throws(() => service.cancelQuestion({}), /该问题不存在或已处理/);
});

test('R117-C2 取消后 answerQuestion 报问题已失效（E2E）', async () => {
  const { service } = makeService();
  fakeRunTask = () => new Promise(() => {});
  const task = service.runTask({ task_id: 'q-task-2' });
  task.catch(() => {});
  const { question } = await createPendingQuestion(service, 'q-task-2');
  service.cancelQuestion({ question_id: question.question_id });
  assert.throws(() => service.answerQuestion({ question_id: question.question_id, option_id: 'option-1' }), /已失效/);
});

test('R117-C3 任务终结时清理同任务残留未决提问（防对话框停在死任务上）', async () => {
  const { service } = makeService();
  const cancelError = new Error('任务已取消');
  cancelError.code = 'TASK_CANCELLED';
  fakeRunTask = () => Promise.reject(cancelError);
  const task = service.runTask({ task_id: 't3' });
  const { question, settle } = await createPendingQuestion(service, 't3');
  assert.ok(question, '任务运行中应存在待答提问');
  await assert.rejects(task, /任务已取消/);
  assert.equal(service.getPendingQuestion(), null);
  assert.equal(settle.done, true);
  assert.equal(settle.error.code, 'TASK_CANCELLED');
});

test('R117-C3 提问 promise 带未处理拒绝安全网（源断言）', () => {
  const region = extractRegion(AGENT_SOURCE, 'function requestUserQuestion(', 'function suppressQuestionAutoAnswer(');
  assert.match(region, /const promise = new Promise/);
  assert.match(region, /promise\.catch\(\(\) => undefined\)/);
  assert.match(region, /return promise/);
});

test('R117-C3 任务终结清理位于 startTask finally（源断言）', () => {
  const region = extractRegion(AGENT_SOURCE, 'function startTask(', 'function runTask(');
  assert.match(region, /item\.question\.task_id === taskId/);
  const finallyIndex = region.indexOf('.finally(async () => {');
  const sweepIndex = region.indexOf('item.question.task_id === taskId');
  assert.ok(finallyIndex > -1 && sweepIndex > finallyIndex, '残留提问清理必须在 finally 内');
});

test('R117-C4 close 后 warmup/selfCheck/restart 统一拒绝（不复活运行时）', async () => {
  const { service } = makeService();
  await service.close();
  await assert.rejects(service.warmup(), /Agent 服务正在关闭/);
  await assert.rejects(service.selfCheck(), /Agent 服务正在关闭/);
  await assert.rejects(service.restart('test'), /Agent 服务正在关闭/);
  assert.equal(service.getStatus().active_tasks.length, 0);
});

test('R117-C4 ensureServiceRuntime 带 closing 守卫（源断言）', () => {
  const region = extractRegion(AGENT_SOURCE, 'function ensureServiceRuntime()', 'function createTaskRuntime(');
  assert.match(region, /if \(closing\) throw new Error\('Agent 服务正在关闭'\)/);
});

test('R117-C2 pi 运行时将提问的预期中断错误升级为任务中止（源断言）', () => {
  const region = extractRegion(PI_SOURCE, 'async function waitForUserQuestion(', 'async function waitForExternalUser(');
  assert.match(region, /code === 'TASK_CANCELLED' \|\| code === 'AGENT_DISCONNECTED'/);
  assert.match(region, /activeController\.abort\(error\)/);
  assert.match(region, /throw error/);
});

test('R117-C2 IPC/preload/对话框完整暴露取消链路（源断言）', () => {
  assert.match(IPC_SOURCE, /ipcMain\.handle\('agent:cancel-question', async \(_event, payload\) => agentService\.cancelQuestion\(payload\)\)/);
  assert.match(PRELOAD_SOURCE, /cancelQuestion: \(payload\) => invoke\('agent:cancel-question', payload\)/);
  assert.match(IPC_TYPES_SOURCE, /cancelQuestion: \(payload: \{ question_id: string \}\) => Promise<\{ success: boolean \}>/);
  const footer = extractRegion(DIALOG_SOURCE, 'agent-question-actions', '</footer>');
  assert.match(footer, /className="secondary-action"/);
  assert.match(footer, /取消任务/);
  assert.match(footer, /cancelling \? '正在取消\.\.\.' : '取消任务'/);
  assert.match(DIALOG_SOURCE, /window\.yibiao\.agent\.cancelQuestion\(\{ question_id: questionId \}\)/);
});
