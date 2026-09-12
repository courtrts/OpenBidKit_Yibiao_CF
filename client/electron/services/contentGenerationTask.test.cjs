const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createInitialSections,
  buildContentOverallProgress,
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
