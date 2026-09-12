const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readJson,
  finalizeOutline,
  validateOutlineOutput,
} = require('./feasibilityOutlineTask.cjs');

test('validateOutlineOutput 对合法纯 JSON 目录通过并返回一级计数', () => {
  const content = JSON.stringify({
    outline: [
      {
        title: '概述',
        description: '本章说明',
        children: [
          { title: '项目概况', description: '本节写作重点' },
          { title: '建设必要性', description: '必要性论证' },
        ],
      },
      { title: '结论', description: '结论与建议' },
    ],
  });

  const result = validateOutlineOutput({ output_content: content });
  assert.deepEqual(result, { outlineCount: 2 });
});

test('validateOutlineOutput 对非法 JSON 抛出不含解析细节的简短文案', () => {
  assert.throws(
    () => validateOutlineOutput({ output_content: '{ "outline": [oops' }),
    (error) => error.message === 'outline.json不是合法 JSON，请修正为纯 JSON 后重写该文件',
  );
});

test('validateOutlineOutput 对空目录抛出可自修的失败文案', () => {
  assert.throws(
    () => validateOutlineOutput({ output_content: JSON.stringify({ outline: [] }) }),
    /模型未返回可用目录/,
  );
});

test('validateOutlineOutput 对全空壳节点视为无可用目录', () => {
  const content = JSON.stringify({
    outline: [
      { title: '', description: '' },
      { title: '   ', description: '  ' },
    ],
  });
  assert.throws(() => validateOutlineOutput({ output_content: content }), /模型未返回可用目录/);
});

test('validateOutlineOutput 对缺失内容抛错', () => {
  assert.throws(() => validateOutlineOutput({}), /outline.json不是合法 JSON/);
});

test('readJson 错误文案剥离解析器细节，避免内部信息透传', () => {
  assert.throws(
    () => readJson('not-json', 'outline.json'),
    (error) => error.message === 'outline.json不是合法 JSON，请修正为纯 JSON 后重写该文件',
  );
  assert.equal(readJson('{"a":1}', 'x').a, 1);
});

test('finalizeOutline 过滤非允许的知识库 id 并把三级以下子节点裁剪', () => {
  const raw = {
    outline: [
      {
        title: '第一章 概述',
        description: '说明',
        children: [
          {
            title: '1.1 概况',
            description: '重点',
            knowledge_item_ids: ['doc1::item1', 'doc9::itemX'],
          },
          {
            title: '1.2 子节',
            description: '另一节',
            children: [
              {
                // 三级节点：自身保留为叶子，其下第四级子节点应被裁剪
                title: '1.2.1 孙节',
                description: '孙节重点',
                knowledge_item_ids: ['doc1::item1'],
                children: [{ title: '1.2.1.1 第四级', description: '应被裁剪' }],
              },
            ],
          },
        ],
      },
    ],
  };
  const outline = finalizeOutline(raw, new Set(['doc1::item1']));
  assert.equal(outline.length, 1);
  assert.equal(outline[0].title, '概述');
  const leaf = outline[0].children[0];
  assert.deepEqual(leaf.knowledge_item_ids, ['doc1::item1']);
  const grandchild = outline[0].children[1].children[0];
  assert.deepEqual(grandchild.knowledge_item_ids, ['doc1::item1']);
  assert.equal(grandchild.children, undefined, '三级节点下的第四级子节点应被裁剪');
});
