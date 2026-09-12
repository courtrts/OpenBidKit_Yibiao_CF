const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readJson,
  formatProgressTitle,
  validateGlobalFactsOutput,
} = require('./globalFactsTaskV2.cjs');

test('validateGlobalFactsOutput 对合法 JSON 通过并返回大项计数', () => {
  const result = validateGlobalFactsOutput({
    output_content: JSON.stringify({
      groups: [
        { id: 'team', title: '项目角色', content: '- 项目经理：张伟。' },
        { id: 'duration', title: '工期口径', content: '- 总工期：120 日历天。' },
      ],
    }),
  });

  assert.deepEqual(result, { groupsCount: 2 });
});

test('validateGlobalFactsOutput 对非法 JSON 抛固定文案且不携带解析器细节', () => {
  assert.throws(
    () => validateGlobalFactsOutput({ output_content: '{ 不是 JSON' }),
    (error) => {
      assert.equal(error.message, 'global-facts.json不是合法 JSON，请修正为纯 JSON 后重写该文件');
      assert.doesNotMatch(error.message, /Unexpected token|JSON\.parse/);
      return true;
    },
  );
});

test('validateGlobalFactsOutput 对空 groups 抛错', () => {
  assert.throws(
    () => validateGlobalFactsOutput({ output_content: JSON.stringify({ groups: [] }) }),
    /缺少 groups/,
  );
});

test('validateGlobalFactsOutput 对空白 content 的大项在归一化时剔除后抛缺 groups 错', () => {
  // content 为纯空白的大项会被 normalizeGlobalFactsResponse 剔除，
  // 剔除后无可用大项即"缺少 groups"——这是该形态的真实报错路径。
  assert.throws(
    () => validateGlobalFactsOutput({
      output_content: JSON.stringify({ groups: [{ id: 'a', title: '标题', content: '   ' }] }),
    }),
    /缺少 groups/,
  );
});

test('readJson 正常解析并原样返回对象', () => {
  assert.equal(readJson('{"a":1}', 'x.json').a, 1);
  assert.deepEqual(readJson('  [1, 2]  ', 'x.json'), [1, 2]);
});

test('formatProgressTitle 连续空白折叠为单空格并截断到 20 字', () => {
  assert.equal(formatProgressTitle('  正在   读取\n招标文件  '), '正在 读取 招标文件');
  assert.equal(formatProgressTitle(Array.from({ length: 30 }, (_, i) => `字${i}`).join('')).length, 20);
  assert.equal(formatProgressTitle(''), '');
});
