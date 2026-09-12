const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createInitialPrompt,
  createScorePlanningPrompt,
  createChildrenPrompt,
  enforceMinimumLeafTarget,
  deriveTargetLeafCount,
  assertScoreDirectoryPlan,
  assertLeafAllocations,
} = require('./outlineGenerationTaskV2.cjs');

test('独立成册模式直接以技术评分大项作为一级目录', () => {
  const prompt = createInitialPrompt('按响应文件要求生成。', { standaloneTechnical: true });

  assert.match(prompt, /一级目录必须直接对应技术评分大项/);
  assert.match(prompt, /不得创建“技术方案”“项目管理方案”“监理大纲”“监理大纲（暗标）”“施工组织设计”“技术标”/);
  assert.match(prompt, /不得加入商务、资信、投标函、授权委托书/);
});

test('独立成册评分规划把根节点固定为评分项层级', () => {
  const prompt = createScorePlanningPrompt({ standaloneTechnical: true });

  assert.match(prompt, /score_item_level 固定为 1/);
  assert.match(prompt, /target_title 必须与 root_title 完全一致/);
  assert.match(prompt, /不得再创建“技术方案”“项目管理方案”“监理大纲”“监理大纲（暗标）”“施工组织设计”“技术标”/);
});

test('独立成册生成子目录时不重复评分项根标题', () => {
  const prompt = createChildrenPrompt({
    hasOriginalPlan: false,
    originalOnly: false,
    targetLeafCount: 10,
    allowRootChanges: false,
    standaloneTechnical: true,
  });

  assert.match(prompt, /现有一级根节点本身就是评分项映射节点/);
  assert.match(prompt, /不得在根节点下面再次生成同名评分项/);
  assert.doesNotMatch(prompt, /"title":"技术方案"/);
});

test('独立成册末级小节目标至少覆盖每个技术分支', () => {
  assert.equal(enforceMinimumLeafTarget(10, 0, 6), 10);
  assert.equal(enforceMinimumLeafTarget(14, 0, 6), 14);
  assert.equal(enforceMinimumLeafTarget(4, 0, 6), 6);
  assert.equal(enforceMinimumLeafTarget(10, 2, 5), 10);
  assert.equal(enforceMinimumLeafTarget(null, 0, 6), null);
  assert.equal(enforceMinimumLeafTarget(2, 0, 1, {
    maximumWords: 4000,
    sectionWords: 3000,
    strictSectionWords: true,
  }), 1);
  assert.throws(
    () => enforceMinimumLeafTarget(4, 0, 6, {
      maximumWords: 4000,
      sectionWords: 1000,
      strictSectionWords: true,
    }),
    /最多容纳 5 个 AI 生成小节，但独立成册目录至少需要 6 个/,
  );
});

test('目标叶子数下限钳制：小字数配置不得产出负/零目标', () => {
  // max/section < 2 时原式 floor(max/section)-2 会为负，负目标让分配 schema 无解
  assert.equal(deriveTargetLeafCount({ minimumWords: 0, maximumWords: 2000, sectionWords: 3000, strictSectionWords: false }), 1);
  assert.equal(deriveTargetLeafCount({ minimumWords: 0, maximumWords: 6000, sectionWords: 3000, strictSectionWords: false }), 1);
  // 正常配置保持原式
  assert.equal(deriveTargetLeafCount({ minimumWords: 0, maximumWords: 15000, sectionWords: 3000, strictSectionWords: false }), 3);
  assert.equal(deriveTargetLeafCount({ minimumWords: 3000, maximumWords: 9000, sectionWords: 3000, strictSectionWords: false }), 2);
  assert.equal(deriveTargetLeafCount({ minimumWords: 3000, maximumWords: 0, sectionWords: 3000, strictSectionWords: false }), 3);
  assert.equal(deriveTargetLeafCount({ minimumWords: 0, maximumWords: 0, sectionWords: 3000, strictSectionWords: false }), null);
});

test('评分目录规划宿主侧复验', () => {
  const validPlan = {
    branches: [
      { branch_id: 'b1', root_id: '1', root_title: '总体部署' },
      { branch_id: 'b2', root_id: '2', root_title: '关键技术' },
    ],
    allow_root_changes: false,
  };
  assert.doesNotThrow(() => assertScoreDirectoryPlan(validPlan));
  assert.doesNotThrow(() => assertScoreDirectoryPlan({ branches: [] }));
  assert.throws(() => assertScoreDirectoryPlan(null), /不是合法对象/);
  assert.throws(() => assertScoreDirectoryPlan({}), /缺少技术分支列表/);
  assert.throws(
    () => assertScoreDirectoryPlan({ branches: [{ branch_id: 'b1', root_id: '', root_title: 'x' }] }),
    /分支字段缺失/,
  );
  assert.throws(
    () => assertScoreDirectoryPlan({
      branches: [
        { branch_id: 'b1', root_id: '1', root_title: 'a' },
        { branch_id: 'b1', root_id: '2', root_title: 'b' },
      ],
    }),
    /重复分支标识/,
  );
});

test('AI 小节分配结果宿主侧复验', () => {
  const branches = [
    { branch_id: 'b1', root_id: '1', root_title: 'A' },
    { branch_id: 'b2', root_id: '2', root_title: 'B' },
  ];
  const ok = { allocations: [{ branch_id: 'b1', leaf_count: 2 }, { branch_id: 'b2', leaf_count: 3 }] };
  assert.doesNotThrow(() => assertLeafAllocations(ok, branches, 5));
  assert.throws(() => assertLeafAllocations({ allocations: [] }, branches, 5), /分配结果缺失/);
  assert.throws(() => assertLeafAllocations(ok, branches, 6), /总和为 5，与可分配数 6 不一致/);
  assert.throws(
    () => assertLeafAllocations({ allocations: [{ branch_id: 'b1', leaf_count: 5 }] }, branches, 5),
    /未覆盖全部技术分支/,
  );
  assert.throws(
    () => assertLeafAllocations({ allocations: [{ branch_id: 'x', leaf_count: 5 }] }, branches, 5),
    /技术分支之外的条目/,
  );
  assert.throws(
    () => assertLeafAllocations({ allocations: [{ branch_id: 'b1', leaf_count: 2 }, { branch_id: 'b1', leaf_count: 3 }] }, branches, 5),
    /重复分支条目/,
  );
  assert.throws(
    () => assertLeafAllocations({ allocations: [{ branch_id: 'b1', leaf_count: 0 }, { branch_id: 'b2', leaf_count: 5 }] }, branches, 5),
    /分配数量不合法/,
  );
  // target 为 null（agent-decides 模式）时只校验结构，不强求总和
  assert.doesNotThrow(() => assertLeafAllocations(ok, branches, null));
});
