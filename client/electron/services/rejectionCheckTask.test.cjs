const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runRejectionCheckTask, runRejectionItemsExtractionTask } = require('./rejectionCheckTask.cjs');

function createDeveloperLoggerRecorder() {
  const writes = [];
  const logger = { write: (name, data) => writes.push({ name, data }) };
  return { writes, logger };
}

function createWorkspaceStore() {
  return {
    readDocumentMarkdown: () => '',
    createDocumentSignature: () => 'sig-document-1',
    createRejectionCheckInputSignature: () => 'sig-input-1',
  };
}

function createCheckpointRecorder() {
  const calls = [];
  const record = (taskPartial, workspacePartial) => {
    calls.push({ taskPartial, workspacePartial });
    return { task: {} };
  };
  return { calls, updateTask: record, checkpointTask: record };
}

test('runRejectionItemsExtractionTask：AI 失败时用户可见错误被净化，error 终态进度封顶 99，原始细节保留在开发者日志', async () => {
  const rawMessage = 'Request failed at D:\\data\\secret\ntimeout /Users/x/y';
  const { writes, logger } = createDeveloperLoggerRecorder();
  const aiService = {
    chat: async () => {
      throw new Error(rawMessage);
    },
    createDeveloperLogger: () => logger,
  };
  const { calls, checkpointTask } = createCheckpointRecorder();

  await runRejectionItemsExtractionTask({
    aiService,
    workspaceStore: createWorkspaceStore(),
    checkpointTask,
    payload: { workspaceState: { tenderDocument: { content: '招标正文内容若干' } } },
    previousState: {},
  });

  const last = calls.at(-1);
  assert.equal(last.taskPartial.status, 'error');
  // 失败终态进度封顶 99，避免“失败”却显示 100%
  assert.equal(last.taskPartial.progress, 99);
  // 用户可见消息：绝对路径被替换、换行被剥离
  assert.equal(last.taskPartial.error, 'Request failed at [路径] timeout [路径]');
  assert.equal(last.workspacePartial.invalidBidAndRejectionItems.error, last.taskPartial.error);
  assert.equal(last.workspacePartial.invalidBidAndRejectionItems.status, 'error');
  // 开发者日志保留原始错误细节（诊断通道不削弱）
  const errorWrite = writes.find((item) => item.name === 'rejection.extraction.error');
  assert.ok(errorWrite, '应写入 rejection.extraction.error 开发者日志');
  assert.ok(String(errorWrite.data.error.message).includes('D:\\data\\secret'), '开发者日志应保留原始路径细节');
});

test('runRejectionItemsExtractionTask：成功路径进度仍为 100（99 封顶只作用于失败态）', async () => {
  const { logger } = createDeveloperLoggerRecorder();
  const aiService = {
    chat: async () => '提取到的无效与废标项内容',
    createDeveloperLogger: () => logger,
  };
  const { calls, checkpointTask } = createCheckpointRecorder();

  await runRejectionItemsExtractionTask({
    aiService,
    workspaceStore: createWorkspaceStore(),
    checkpointTask,
    payload: { workspaceState: { tenderDocument: { content: '招标正文内容若干' } } },
    previousState: {},
  });

  const last = calls.at(-1);
  assert.equal(last.taskPartial.status, 'success');
  assert.equal(last.taskPartial.progress, 100);
  assert.equal(last.workspacePartial.invalidBidAndRejectionItems.content, '提取到的无效与废标项内容');
});

test('runRejectionCheckTask：子检查失败时错误被净化，终态进度封顶 99，原始细节保留在开发者日志', async () => {
  const rawMessage = 'boom D:\\secret\nnewline detail';
  const { writes, logger } = createDeveloperLoggerRecorder();
  const aiService = {
    requestJson: async () => {
      throw new Error(rawMessage);
    },
    createDeveloperLogger: () => logger,
  };
  const { calls, updateTask, checkpointTask } = createCheckpointRecorder();

  await runRejectionCheckTask({
    aiService,
    workspaceStore: createWorkspaceStore(),
    updateTask,
    checkpointTask,
    payload: {
      runOptions: { rejectionCheck: false, typoCheck: true, logicCheck: false },
      workspaceState: {
        bidDocuments: [{ id: 'bid-1', fileName: 'bid.docx', content: '投标正文内容若干' }],
        invalidBidAndRejectionItems: { content: '' },
        customCheckItems: '',
      },
    },
    previousState: {},
  });

  const last = calls.at(-1);
  assert.equal(last.taskPartial.status, 'error');
  // 失败终态进度封顶 99，避免“失败”却显示 100%
  assert.equal(last.taskPartial.progress, 99);
  assert.equal(last.taskPartial.error, '1 个检查任务失败');
  // 子检查结果：错误消息净化后进入 error 与 progressMessage
  const typoCall = [...calls].reverse().find((item) => item.workspacePartial?.typoCheckResult?.status === 'error');
  assert.ok(typoCall, '应写入失败态的 typoCheckResult');
  assert.equal(typoCall.workspacePartial.typoCheckResult.error, 'boom [路径] newline detail');
  assert.equal(typoCall.workspacePartial.typoCheckResult.progressMessage, 'boom [路径] newline detail');
  assert.deepEqual(typoCall.workspacePartial.typoCheckResult.findings, []);
  // 开发者日志保留原始错误细节（诊断通道不削弱）
  const stageError = writes.find((item) => item.name === 'rejection.check.stage.error');
  assert.ok(stageError, '应写入 rejection.check.stage.error 开发者日志');
  assert.ok(String(stageError.data.error.message).includes('D:\\secret'), '开发者日志应保留原始路径细节');
});
