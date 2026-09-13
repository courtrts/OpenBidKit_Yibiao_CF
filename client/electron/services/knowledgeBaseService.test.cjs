'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createKnowledgeBaseService, _internals } = require('./knowledgeBaseService.cjs');
const SERVICE_SOURCE = fs.readFileSync(path.join(__dirname, 'knowledgeBaseService.cjs'), 'utf-8');

// 假 app 只提供临时 userData 路径；假 store 全内存，不触碰真实 Electron 与 SQLite。
function makeApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-kb-service-'));
  return { getPath: (key) => path.join(root, key) };
}

function makeFakeStore({ document } = {}) {
  const calls = { moveDocument: [], deleteDocument: [], deleteFolder: [] };
  const store = {
    recoverInterruptedDocuments: () => [],
    getDocument: (id) => (document && document.id === id ? document : null),
    list: () => ({
      folders: [{ id: 'f-A', name: '文件夹A' }, { id: 'f-B', name: '文件夹B' }],
      documents: document ? [document] : [],
    }),
    moveDocument: (id, folderId, options) => {
      calls.moveDocument.push({ id, folderId, options });
      return { ...document, folder_id: folderId };
    },
    deleteDocument: (id) => {
      calls.deleteDocument.push(id);
    },
    deleteFolder: (id) => {
      calls.deleteFolder.push(id);
    },
    readMarkdown: () => '# md',
    readItems: () => [],
    readAnalysis: () => ({ items: [] }),
  };
  return { store, calls };
}

function makeService(fakeStore, app) {
  return createKnowledgeBaseService({
    app,
    aiService: {},
    configStore: { load: () => ({}) },
    knowledgeBaseStore: fakeStore,
  });
}

function regionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `未找到起始标记：${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notStrictEqual(end, -1, `未找到结束标记：${endMarker}`);
  return source.slice(start, end);
}

test('C1 moveDocument 磁盘移动 E2E：目录 rename + store 收到重定基路径', () => {
  const app = makeApp();
  const document = {
    id: 'doc-1',
    folder_id: 'f-A',
    document_dir: 'folders/f-A/documents/doc-1',
    source_path: 'folders/f-A/documents/doc-1/source.docx',
    markdown_path: 'folders/f-A/documents/doc-1/content.md',
    status: 'success',
    file_name: '招标.docx',
  };
  const { store, calls } = makeFakeStore({ document });
  const service = makeService(store, app);
  const baseDir = require('../utils/paths.cjs').getKnowledgeBaseDir(app);
  const oldDir = path.join(baseDir, 'folders', 'f-A', 'documents', 'doc-1');
  const newDir = path.join(baseDir, 'folders', 'f-B', 'documents', 'doc-1');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'content.md'), '# t', 'utf-8');
  try {
    const result = service.moveDocument('doc-1', 'f-B', null, 'end');
    assert.strictEqual(result.success, true);
    assert.ok(fs.existsSync(path.join(newDir, 'content.md')), '目录应已移动');
    assert.ok(!fs.existsSync(oldDir), '旧目录应不存在');
    assert.strictEqual(calls.moveDocument.length, 1);
    assert.strictEqual(calls.moveDocument[0].options.documentDir, 'folders/f-B/documents/doc-1');
    assert.strictEqual(calls.moveDocument[0].options.markdownPath, 'folders/f-B/documents/doc-1/content.md');
  } finally {
    fs.rmSync(path.join(baseDir, 'folders'), { recursive: true, force: true });
  }
});

test('C1 moveDocument store 失败回滚：目录搬回原位并保留原始错误', () => {
  const app = makeApp();
  const document = {
    id: 'doc-1',
    folder_id: 'f-A',
    document_dir: 'folders/f-A/documents/doc-1',
    source_path: 'folders/f-A/documents/doc-1/source.docx',
    markdown_path: 'folders/f-A/documents/doc-1/content.md',
    status: 'success',
    file_name: '招标.docx',
  };
  const { store } = makeFakeStore({ document });
  store.moveDocument = () => {
    throw new Error('db boom');
  };
  const service = makeService(store, app);
  const baseDir = require('../utils/paths.cjs').getKnowledgeBaseDir(app);
  const oldDir = path.join(baseDir, 'folders', 'f-A', 'documents', 'doc-1');
  const newDir = path.join(baseDir, 'folders', 'f-B', 'documents', 'doc-1');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'content.md'), '# t', 'utf-8');
  try {
    assert.throws(() => service.moveDocument('doc-1', 'f-B', null, 'end'), /db boom/);
    assert.ok(fs.existsSync(path.join(oldDir, 'content.md')), '失败后目录应回滚到原位');
    assert.ok(!fs.existsSync(newDir), '新目录不应残留');
  } finally {
    fs.rmSync(path.join(baseDir, 'folders'), { recursive: true, force: true });
  }
});

test('C1 renameSync 错误净化源断言（EBUSY/EPERM/EACCES 固定文案+诊断通道+兜底净化）', () => {
  const region = regionBetween(SERVICE_SOURCE, 'ensureDir(path.dirname(newDir));', 'const movedDocument = knowledgeBaseStore.moveDocument');
  assert.match(region, /try \{\s*\n\s*fs\.renameSync\(oldDir, newDir\);/);
  assert.match(region, /\['EBUSY', 'EPERM', 'EACCES'\]\.includes\(error\?\.code\)/);
  assert.match(region, /文档文件可能正被 Office\/WPS 打开，请关闭相关文件后重试/);
  assert.match(region, /console\.error\('\[knowledge-base\] 文档目录移动失败:'/);
  assert.match(region, /userFacingTaskError\(error, '移动失败，请稍后重试'\)/);
});

test('C2 过期 id 守卫：retry/start/delete 返回固定文案，move/read 抛固定文案（不产生 TypeError）', () => {
  const app = makeApp();
  const { store } = makeFakeStore({ document: null });
  const service = makeService(store, app);
  const retry = service.retryDocument('gone', null);
  assert.strictEqual(retry.success, false);
  assert.match(retry.message, /知识库文档不存在或已删除，请刷新列表/);
  const start = service.startMatching('gone', null, null);
  assert.strictEqual(start.success, false);
  assert.match(start.message, /知识库文档不存在或已删除，请刷新列表/);
  const del = service.deleteDocument('gone');
  assert.strictEqual(del.success, false);
  assert.match(del.message, /知识库文档不存在或已删除，请刷新列表/);
  assert.throws(() => service.moveDocument('gone', 'f-B', null, 'end'), /知识库文档不存在或已删除/);
  assert.throws(() => service.readMarkdown('gone'), /知识库文档不存在或已删除/);
  assert.throws(() => service.readItems('gone'), /知识库文档不存在或已删除/);
  assert.throws(() => service.readAnalysis('gone'), /知识库文档不存在或已删除/);
});

test('C2 存在文档时读路径不受守卫影响（零回归）', () => {
  const app = makeApp();
  const document = { id: 'doc-1', folder_id: 'f-A', status: 'success', file_name: 'a.docx' };
  const { store } = makeFakeStore({ document });
  const service = makeService(store, app);
  assert.strictEqual(service.readMarkdown('doc-1'), '# md');
  assert.deepStrictEqual(service.readItems('doc-1'), []);
  assert.deepStrictEqual(service.readAnalysis('doc-1'), { items: [] });
});

test('C2 prepareDocument 排队删除竞态静默收口（源断言）', () => {
  const region = regionBetween(SERVICE_SOURCE, 'async function prepareDocument(documentId, sourceFilePath, webContents) {', 'const copyStep = getStep(');
  assert.match(region, /if \(!document\) \{/);
  assert.match(region, /prepare:skip-missing/);
  assert.match(region, /return;/);
  assert.match(region, /getDocument\(documentId\);/);
});

test('C3 supplement 条目子批兜底源断言（与 match/recovery 同构）', () => {
  const region = regionBetween(SERVICE_SOURCE, 'const requestSupplementItems = async', 'const mergeStep = getStep(');
  assert.match(region, /getMessagesContentLength\(fullItemMessages\) <= unifiedPack\.requestBudget/);
  assert.match(region, /ai:supplement-items:item-split/);
  assert.match(region, /getItemSplitBudget\(aiService, \[/);
  assert.match(region, /buildSupplementItemTaskMessage\(document\.file_name, \[\]\)/);
  assert.match(region, /packItemsIntoSegments\(firstItems, itemSegmentLimit\)/);
  assert.match(region, /mergeTitleSummaryItems\(subLists\)/);
  assert.match(region, /-条目\$\{itemSegment\.index\}/);
  assert.match(region, /'sub_batch'/);
  assert.match(region, /'full'/);
  assert.match(region, /item_mode: itemMode/);
});

test('C3 getItemSplitBudget 行为：requestBudget 减去前缀壳长度', () => {
  const aiService = { getConfig: () => ({ context_length_limit: 1000 }) };
  const prefixMessages = [{ role: 'user', content: 'x'.repeat(100) }];
  // 800 - (role 4 + content 100 + 开销 64) = 632
  assert.strictEqual(_internals.getItemSplitBudget(aiService, prefixMessages), 632);
});

test('C3 buildSupplementItemTaskMessage 空条目壳可渲染（子批预算壳依赖）', () => {
  const message = _internals.buildSupplementItemTaskMessage('招标.docx', []);
  assert.ok(message.role === 'user');
  assert.match(message.content, /<first_round_items>/);
  assert.match(message.content, /\[\]/);
});
