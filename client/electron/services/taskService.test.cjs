'use strict';

const test = require('node:test');
const assert = require('node:assert');

// 在加载 taskService 前用 require.cache 注入假 runner（与 agentService 测试同模式），
// 避免真实任务 runner 的 AI 依赖参与纯 node 测试。
const bidAnalysisKey = require.resolve('./bidAnalysisTask.cjs');
const contentGenerationKey = require.resolve('./contentGenerationTask.cjs');

const fakeRunners = { bidAnalysis: null, contentGeneration: null };
require.cache[bidAnalysisKey] = {
  id: bidAnalysisKey,
  filename: bidAnalysisKey,
  loaded: true,
  exports: { runBidAnalysisTask: async (ctx) => { fakeRunners.bidAnalysis = ctx; } },
};
require.cache[contentGenerationKey] = {
  id: contentGenerationKey,
  filename: contentGenerationKey,
  loaded: true,
  exports: {
    runContentGenerationTask: (ctx) => new Promise((resolve, reject) => {
      const onAbort = () => reject(ctx.taskControl.signal.reason || new Error('后台任务已取消'));
      if (ctx.taskControl.signal.aborted) onAbort();
      else ctx.taskControl.signal.addEventListener('abort', onAbort);
    }),
  },
};

const { createTaskService } = require('./taskService.cjs');

function makeDeps() {
  const state = {
    failPersistence: false,
    technicalPlan: { outlineWordControlSnapshot: { snapshot: true } },
  };
  const technicalPlanStore = {
    loadTechnicalPlan: () => state.technicalPlan,
    updateTechnicalPlanWithoutReload: (partial) => {
      if (state.failPersistence) throw new Error('disk boom');
      state.technicalPlan = { ...state.technicalPlan, ...partial };
    },
    clearBidTemplate: () => {},
  };
  const service = createTaskService({
    aiService: {
      withQueueScope: (scopeId) => ({ queueScopeId: scopeId }),
      pauseQueueScope: () => {},
      resumeQueueScope: () => {},
    },
    agentService: {
      loadPersistentTask: () => null,
      updatePersistentTask: () => {},
      deletePersistentTask: () => {},
      hasPersistentTaskSession: () => false,
      isPrimarySession: () => false,
      bindTaskContext: () => ({}),
    },
    autoConfirmationService: {
      register: () => 'auto-id',
      unregister: () => {},
      suppress: () => {},
    },
    technicalPlanStore,
    rejectionCheckStore: { loadRejectionCheck: () => ({}), updateRejectionCheckWithoutReload: () => {} },
    duplicateCheckStore: { loadDuplicateCheck: () => ({}), updateDuplicateCheckWithoutReload: () => {} },
    feasibilityReportStore: { loadFeasibilityReport: () => ({}) },
  });
  return { service, state };
}

async function until(condition, message, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('C2 任务事件回调异常隔离：单个订阅方抛错不中断后续订阅方、不把任务打失败', async () => {
  const { service } = makeDeps();
  const seen = [];
  const unsubscribeBad = service.subscribeCallback(() => {
    throw new Error('boom-subscriber');
  });
  const unsubscribeGood = service.subscribeCallback((event) => seen.push(event));
  try {
    const task = service.startBidAnalysis({});
    assert.strictEqual(task.status, 'running', '异常回调不得沿初始化段把任务置为 error');
    assert.ok(seen.length >= 1, '异常回调不得中断后续订阅方收到事件');
    await until(() => service.getActiveTasks().length === 0, '任务应正常结算');
  } finally {
    unsubscribeBad();
    unsubscribeGood();
  }
});

test('C1 pause 检查点落库失败隔离：IPC 不抛 raw 存储错误，暂停标志内存自愈', async () => {
  const { service, state } = makeDeps();
  const task = service.startContentGeneration({});
  assert.strictEqual(task.status, 'running');
  try {
    state.failPersistence = true;
    // 修复前：checkpointTask 抛 'disk boom' 经 IPC 直达渲染层 toast
    const paused = service.pauseContentGeneration();
    assert.ok(paused, '落库失败时应返回当前任务而非抛错');
    assert.strictEqual(paused.pause_requested, true, '内存暂停标志应保持置位等待运行侧兜底');
    assert.ok(paused.status === 'pausing' || paused.status === 'running');
    assert.match(state.technicalPlan.contentGenerationTask?.status || '', /running|pausing|paused/, '持久态不应被写坏');
  } finally {
    state.failPersistence = false;
    service.cancelTechnicalPlanTask({ type: 'content-generation' });
    await until(() => service.getActiveTasks().length === 0, '取消后任务应结算退出');
  }
});

test('C1 正常路径 pause 不受隔离影响：checkpoint 落库成功返回 pausing', async () => {
  const { service, state } = makeDeps();
  service.startContentGeneration({});
  try {
    const paused = service.pauseContentGeneration();
    assert.strictEqual(paused.status, 'pausing');
    assert.strictEqual(state.technicalPlan.contentGenerationTask.status, 'pausing', '持久态应同步暂停中');
  } finally {
    service.cancelTechnicalPlanTask({ type: 'content-generation' });
    await until(() => service.getActiveTasks().length === 0, '取消后任务应结算退出');
  }
});
