const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getBidAnalysisTaskById,
  isUnusableBidAnalysisResult,
  runBidAnalysisPromptTask,
} = require('./bidAnalysisTask.cjs');

const jsonTask = getBidAnalysisTaskById('projectInfo');
const mdTask = getBidAnalysisTaskById('projectOverview');

test('isUnusableBidAnalysisResult：json 项空串/非法/空对象/数组判不可用，合法对象通过', () => {
  assert.equal(isUnusableBidAnalysisResult(jsonTask, ''), true);
  assert.equal(isUnusableBidAnalysisResult(jsonTask, '   '), true);
  assert.equal(isUnusableBidAnalysisResult(jsonTask, '模型返回了散文而不是 JSON'), true);
  assert.equal(isUnusableBidAnalysisResult(jsonTask, '{"project_name"'), true);
  assert.equal(isUnusableBidAnalysisResult(jsonTask, '{}'), true);
  assert.equal(isUnusableBidAnalysisResult(jsonTask, '[]'), true);
  assert.equal(isUnusableBidAnalysisResult(jsonTask, '{"project_name":"测试项目"}'), false);
});

test('isUnusableBidAnalysisResult：markdown 项空串与整项无结果标记判不可用，正常内容与局部缺失通过', () => {
  assert.equal(isUnusableBidAnalysisResult(mdTask, ''), true);
  assert.equal(isUnusableBidAnalysisResult(mdTask, '未提取到'), true);
  assert.equal(isUnusableBidAnalysisResult(mdTask, '## 项目概述\n测试内容'), false);
  // 局部字段缺失写"没有提及"是合法部分结果，不得误判为整项无结果
  assert.equal(isUnusableBidAnalysisResult(mdTask, '项目名称：没有提及'), false);
});

test('json 项首次返回非法 JSON：自动重跑一次并采用第二次合法结果', async () => {
  let calls = 0;
  const aiService = {
    getConfig: () => ({}),
    chat: async () => {
      calls += 1;
      return calls === 1 ? '不是 JSON 的散文' : '{"project_name":"测试项目"}';
    },
  };
  const content = await runBidAnalysisPromptTask({
    aiService,
    fileContent: '招标文件正文',
    fileSegments: ['招标文件正文'],
    task: jsonTask,
    sectionHint: '',
  });
  assert.equal(calls, 2);
  assert.equal(JSON.parse(content).project_name, '测试项目');
});

test('json 项两次均非法：只重跑一次，第二次结果原样交上层按项失败', async () => {
  let calls = 0;
  const aiService = {
    getConfig: () => ({}),
    chat: async () => {
      calls += 1;
      return '仍然不是 JSON';
    },
  };
  const content = await runBidAnalysisPromptTask({
    aiService,
    fileContent: '招标文件正文',
    fileSegments: ['招标文件正文'],
    task: jsonTask,
    sectionHint: '',
  });
  assert.equal(calls, 2);
  assert.equal(content, '仍然不是 JSON');
  assert.equal(isUnusableBidAnalysisResult(jsonTask, content), true);
});
