const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createInitialSections,
  buildContentOverallProgress,
  stripRepeatedChapterTitle,
  __developerContentExpansionPatchRuntime: patchRuntime,
} = require('./contentGenerationTask.cjs');

function leaf(id, content = '') {
  return { item: { id, title: `小节${id}`, content, content_mode: 'ai-generate' } };
}

test('createInitialSections：默认路径保留既有状态并标记中断小节', () => {
  const leaves = [leaf('1.1'), leaf('1.2'), leaf('2.1', '目录里带的旧文')];
  const existing = {
    '1.1': { id: '1.1', status: 'running', content: '上次写到一半', updated_at: 't0' },
    '1.2': { id: '1.2', status: 'error', content: '', error: '上次失败原因' },
    '9.9': { id: '9.9', status: 'success', content: '已不在目录里' },
  };

  const sections = createInitialSections(leaves, existing);

  // 被中断的 running 小节：状态置 error 并给出固定提示，但旧正文保留
  assert.equal(sections['1.1'].status, 'error');
  assert.ok(sections['1.1'].error);
  assert.equal(sections['1.1'].content, '上次写到一半');
  // error 小节原样保留错误信息
  assert.equal(sections['1.2'].status, 'error');
  assert.equal(sections['1.2'].error, '上次失败原因');
  // 无小节记录的叶子：目录自带内容按 success 对待
  assert.equal(sections['2.1'].status, 'success');
  assert.equal(sections['2.1'].content, '目录里带的旧文');
  // 已不在目录里的旧小节被清理
  assert.equal(sections['9.9'], undefined);
});

test('createInitialSections：freshStatus（全量重生成）状态清零但保留旧正文作回退底本', () => {
  const leaves = [leaf('1.1'), leaf('1.2'), leaf('2.1')];
  const existing = {
    '1.1': { id: '1.1', status: 'error', content: '旧的好版本', error: '上次失败原因' },
    '1.2': { id: '1.2', status: 'running', content: '写到一半', updated_at: 't0' },
    '2.1': { id: '2.1', status: 'success', content: '已完成的旧文' },
  };

  const sections = createInitialSections(leaves, existing, { freshStatus: true });

  for (const id of ['1.1', '1.2', '2.1']) {
    assert.equal(sections[id].status, 'idle', `${id} 状态应从头起算`);
    assert.equal(sections[id].error, undefined, `${id} 旧错误应被清掉`);
  }
  // 关键：旧正文保留，重生成失败时可回退
  assert.equal(sections['1.1'].content, '旧的好版本');
  assert.equal(sections['1.2'].content, '写到一半');
  assert.equal(sections['2.1'].content, '已完成的旧文');
  // freshStatus 时 running 不再被判定为中断
  assert.notEqual(sections['1.2'].status, 'error');
});

test('createInitialSections：无小节记录且目录无内容时为 idle 空正文', () => {
  const sections = createInitialSections([leaf('1.1')], {});
  assert.equal(sections['1.1'].status, 'idle');
  assert.equal(sections['1.1'].content, '');
  assert.equal(sections['1.1'].error, undefined);
});

test('buildContentOverallProgress：done 阶段带错误收尾封顶 99', () => {
  const detail = { phase: 'done', phase_progress: 100 };
  assert.equal(buildContentOverallProgress('full', detail, 'error'), 99);
  assert.equal(buildContentOverallProgress('full', detail, 'running'), 100);
  assert.equal(buildContentOverallProgress('full', detail, 'success'), 100);
});

test('buildContentOverallProgress：阶段内按区间线性映射且不超 99', () => {
  // full 模式 planning 区间 [0,12]：50% → 6
  assert.equal(buildContentOverallProgress('full', { phase: 'planning', phase_progress: 50 }, 'running'), 6);
  // illustration-generating 区间 [98,99]：即使阶段内 100% 也只到 99
  assert.equal(buildContentOverallProgress('full', { phase: 'illustration-generating', phase_progress: 100 }, 'running'), 99);
  // 未知阶段回退 0
  assert.equal(buildContentOverallProgress('full', { phase: 'not-a-phase', phase_progress: 0 }, 'running'), 0);
});

test('applyContentExpansionPatch：锚点不再反向包含命中短段，未命中落入末尾追加', () => {
  const content = '第一段正文有一些实际的内容。\n\n是。\n\n第三段正文还有别的内容。';
  const patch = {
    operation: 'insert',
    // 长锚点里包含短段“是。”：旧逻辑会反向包含命中短段，把补写插到“是。”之后
    anchor: '这个锚点句子很长，中间还包含 是。 这样的短段落，不可能被任何单一段落包含',
    content: '新增的补写内容',
  };
  const result = patchRuntime.applyContentExpansionPatch(content, patch);
  assert.equal(result, `${content}\n\n新增的补写内容`);
});

test('applyContentExpansionPatch：过短锚点（<6 字符）不参与匹配，避免撞词误命中', () => {
  const content = '第一段正文有一些实际的内容。\n\n第二段正文还有别的内容。';
  const patch = { operation: 'insert', anchor: '内容', content: '新增的补写内容' };
  const result = patchRuntime.applyContentExpansionPatch(content, patch);
  assert.equal(result, `${content}\n\n新增的补写内容`);
});

test('applyContentExpansionPatch：正常锚点（段落包含锚点）仍在对应段落后插入', () => {
  const content = '第一段正文有一些实际的内容。\n\n第二段正文还有别的内容。';
  const patch = { operation: 'insert', anchor: '第二段正文还有别的内容', content: '新增的补写内容' };
  const result = patchRuntime.applyContentExpansionPatch(content, patch);
  assert.equal(result, '第一段正文有一些实际的内容。\n\n第二段正文还有别的内容。\n\n新增的补写内容');
});

test('normalizeContentExpansionPatch：target 不再进锚点链，replace_target 降级进 target_text 链', () => {
  // insert 携带 target：不得被误当锚点
  const inserted = patchRuntime.normalizeContentExpansionPatch({ operation: 'insert', target: '某段现有文字', content: '新增内容' });
  assert.equal(inserted.anchor, 'end');
  assert.equal(inserted.target_text, '');
  // replace 只给 replace_target：兜底进 target_text，避免整轮校验失败
  const replaced = patchRuntime.normalizeContentExpansionPatch({ operation: 'replace', replace_target: '某段现有文字', content: '替换后内容' });
  assert.equal(replaced.target_text, '某段现有文字');
});

test('stripRepeatedChapterTitle：剥离 “id、标题” 顿号格式，且 id 前缀数字不误剥', () => {
  // “2.1、标题”（id+中文顿号）
  assert.equal(
    stripRepeatedChapterTitle('2.1、系统架构\n\n正文内容在这里。', { id: '2.1', title: '系统架构' }),
    '正文内容在这里。',
  );
  // 常规 “id 标题”（id+空白）保持原有行为
  assert.equal(
    stripRepeatedChapterTitle('2.1 系统架构\n\n正文内容在这里。', { id: '2.1', title: '系统架构' }),
    '正文内容在这里。',
  );
  // id 是更长编号的前缀时不得误剥（2.12 ≠ 2.1）
  assert.equal(
    stripRepeatedChapterTitle('2.12 系统架构\n\n正文内容在这里。', { id: '2.1', title: '系统架构' }),
    '2.12 系统架构\n\n正文内容在这里。',
  );
});
