const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// duplicateCheckService 在模块顶层解构 parseDocumentWithConfig，
// 必须在 require 被测模块前把假实现注入 require.cache
const fileServicePath = require.resolve('./fileService.cjs');
const parseImpl = { current: null };
require.cache[fileServicePath] = {
  id: fileServicePath,
  filename: fileServicePath,
  loaded: true,
  exports: {
    parseDocumentWithConfig: (...args) => parseImpl.current(...args),
  },
};

const { createDuplicateCheckService } = require('./duplicateCheckService.cjs');

async function createFixture(t) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duplicate-check-test-'));
  t.after(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    delete require.cache[fileServicePath];
  });
  const bid1 = {
    id: 'bid-1',
    file_name: 'bid1.txt',
    extension: '.txt',
    size: 12,
    modified_at: '2026-09-12T00:00:00.000Z',
    file_path: path.join(tmpRoot, 'bid1.txt'),
  };
  const bid2 = {
    id: 'bid-2',
    file_name: 'bid2.txt',
    extension: '.txt',
    size: 12,
    modified_at: '2026-09-12T00:00:00.000Z',
    file_path: path.join(tmpRoot, 'bid2.txt'),
  };
  await fs.writeFile(bid1.file_path, '投标内容一', 'utf-8');
  await fs.writeFile(bid2.file_path, '投标内容二', 'utf-8');
  const app = { getPath: () => tmpRoot };
  const configStore = { load: () => ({ components: { file_parser: { provider: 'local' } } }) };
  let state = {};
  const analysisFields = ['metadataAnalysis', 'outlineAnalysis', 'contentAnalysis', 'imageAnalysis'];
  const workspaceStore = {
    loadDuplicateCheck: () => state,
    // 模拟真实 store saveSection 的逐键合并语义：partial 缺省的键保留已持久化旧值，
    // 直接整体替换字段会让终态 partial（仅 status/progress/message）抹掉 contentExtraction 等明细键
    updateDuplicateCheckWithoutReload: (partial) => {
      const next = { ...state };
      for (const [key, value] of Object.entries(partial || {})) {
        next[key] = analysisFields.includes(key) ? { ...(state[key] || {}), ...value } : value;
      }
      state = next;
    },
  };
  const service = createDuplicateCheckService({ app, configStore, workspaceStore });
  return { tmpRoot, app, bid1, bid2, state: () => state, workspaceStore, service };
}

function createRecorder(signal, applyState) {
  const calls = [];
  const updateTask = (partial, workspacePartial) => {
    calls.push({ kind: 'update', partial, workspacePartial });
  };
  // 模拟框架 commitTaskCheckpoint：取消后拒绝中间与常规 checkpoint；
  // 成功提交时把业务状态落回 workspace（框架 updateWorkspaceStateWithoutReload 语义）
  const checkpointTask = (taskPartial, workspacePartial) => {
    if (signal?.aborted) throw signal.reason;
    calls.push({ kind: 'checkpoint', partial: taskPartial, workspacePartial });
    if (typeof applyState === 'function' && workspacePartial) applyState(workspacePartial);
    return { task: taskPartial };
  };
  return { calls, updateTask, checkpointTask };
}

function terminalCheckpoints(calls) {
  return calls.filter((call) => call.kind === 'checkpoint' && (call.partial.status === 'success' || call.partial.status === 'error'));
}

test('取消信号中断查重流水线：以 TASK_CANCELLED 拒绝且不落常规终态', async (t) => {
  const fixture = await createFixture(t);
  const { bid1, bid2, service, workspaceStore } = fixture;
  const ac = new AbortController();
  const cancelError = new Error('已取消该任务');
  cancelError.code = 'TASK_CANCELLED';
  parseImpl.current = async (_app, filePath) => {
    if (filePath === bid1.file_path) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      // 首份文件解析返回前触发取消：第二份文件的循环检查点必然命中
      ac.abort(cancelError);
      return 'markdown one';
    }
    return new Promise(() => {});
  };
  const recorder = createRecorder(ac.signal);
  const taskControl = { signal: ac.signal };
  const payload = { tenderFile: null, tenderFiles: [], bidFiles: [bid1, bid2] };
  const rejected = service.runAnalysisTask({
    workspaceStore,
    updateTask: recorder.updateTask,
    checkpointTask: recorder.checkpointTask,
    payload,
    taskControl,
  }).then(() => null, (error) => error);
  const error = await rejected;
  assert.equal(error?.code, 'TASK_CANCELLED');
  // 取消不是分析失败：常规 checkpoint 不得写入 success/error 终态（终态由框架 settleCancelledTask 写入）
  assert.deepEqual(terminalCheckpoints(recorder.calls), []);
});

test('部分文件失败：终态 error/进度 99、正文阶段按文件失败记 error、逐文件错误经净化', async (t) => {
  const fixture = await createFixture(t);
  const { bid1, bid2, service, workspaceStore } = fixture;
  const state = () => fixture.state();
  parseImpl.current = async (_app, filePath) => {
    if (filePath === bid1.file_path) return '第一条投标句子。第二条投标句子。';
    const error = new Error('解析失败 at D:\\data\\secret\\bid2.txt\n第二行细节');
    return Promise.reject(error);
  };
  const recorder = createRecorder(new AbortController().signal, workspaceStore.updateDuplicateCheckWithoutReload);
  const payload = { tenderFile: null, tenderFiles: [], bidFiles: [bid1, bid2] };
  await service.runAnalysisTask({
    workspaceStore,
    updateTask: recorder.updateTask,
    checkpointTask: recorder.checkpointTask,
    payload,
    taskControl: { signal: new AbortController().signal },
  });
  const terminals = terminalCheckpoints(recorder.calls);
  assert.ok(terminals.length);
  const last = terminals[terminals.length - 1].partial;
  assert.equal(last.status, 'error');
  // 失败进度封顶 99：error 终态不显示 100%
  assert.equal(last.progress, 99);
  assert.equal(last.error, '标书查重分析完成，部分结果失败');
  // 元数据分析阶段：正文提取有失败文件 → error/99
  assert.equal(state().metadataAnalysis.status, 'error');
  assert.equal(state().metadataAnalysis.progress, 99);
  assert.equal(state().metadataAnalysis.contentExtraction.status, 'error');
  // 用户可见错误净化：剥离绝对路径与换行，原始细节不出现在用户可见字段
  const failedFile = state().metadataAnalysis.contentFiles.find((item) => item.file_id === 'bid-2');
  assert.ok(failedFile, '应有失败文件记录');
  assert.ok(failedFile.error.includes('[路径]'), `错误应净化为 [路径]，实际：${failedFile.error}`);
  assert.ok(!failedFile.error.includes('D:\\data'), '不得残留本机绝对路径');
  assert.ok(!failedFile.error.includes('\n'), '不得残留换行');
  // 正文比对阶段口径修正：文件比对失败 → 阶段 error（原恒记 success），进度封顶 99
  assert.equal(state().contentAnalysis.status, 'error');
  assert.equal(state().contentAnalysis.progress, 99);
  // 目录/图片阶段同口径
  assert.equal(state().outlineAnalysis.status, 'error');
  assert.equal(state().outlineAnalysis.progress, 99);
  assert.equal(state().imageAnalysis.status, 'error');
  assert.equal(state().imageAnalysis.progress, 99);
});

test('全部成功：终态 success/进度 100（99 封顶只作用于失败态的回归守卫）', async (t) => {
  const fixture = await createFixture(t);
  const { bid1, service, workspaceStore } = fixture;
  const state = () => fixture.state();
  parseImpl.current = async () => '唯一的内容句子。';
  const recorder = createRecorder(new AbortController().signal, workspaceStore.updateDuplicateCheckWithoutReload);
  const payload = { tenderFile: null, tenderFiles: [], bidFiles: [bid1] };
  await service.runAnalysisTask({
    workspaceStore,
    updateTask: recorder.updateTask,
    checkpointTask: recorder.checkpointTask,
    payload,
    taskControl: { signal: new AbortController().signal },
  });
  const terminals = terminalCheckpoints(recorder.calls);
  assert.ok(terminals.length);
  const last = terminals[terminals.length - 1].partial;
  assert.equal(last.status, 'success');
  assert.equal(last.progress, 100);
  assert.equal(state().metadataAnalysis.status, 'success');
  assert.equal(state().metadataAnalysis.progress, 100);
  assert.equal(state().outlineAnalysis.status, 'success');
  assert.equal(state().outlineAnalysis.progress, 100);
  assert.equal(state().contentAnalysis.status, 'success');
  assert.equal(state().contentAnalysis.progress, 100);
  assert.equal(state().imageAnalysis.status, 'success');
  assert.equal(state().imageAnalysis.progress, 100);
});
