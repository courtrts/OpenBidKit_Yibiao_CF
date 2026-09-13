'use strict';

const test = require('node:test');
const assert = require('node:assert');

// 纯 node 环境注入假 electron.ipcMain（require.cache 覆盖），捕获注册的 handler 做行为测试。
const electronKey = require.resolve('electron');
const registered = new Map();
require.cache[electronKey] = {
  id: electronKey,
  filename: electronKey,
  loaded: true,
  exports: {
    ipcMain: {
      handle: (channel, handler) => registered.set(channel, handler),
    },
  },
};

const { registerKnowledgeBaseIpc } = require('./knowledgeBaseIpc.cjs');

const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args.map((item) => String(item?.message || item)).join(' '));

test('C1 handler 兜底净化：store 层 raw sqlite 错误转固定文案（内部表结构不外泄）', async () => {
  const service = {
    list: () => [],
    createFolder: () => {
      throw new Error('UNIQUE constraint failed: knowledge_folders.name');
    },
  };
  registerKnowledgeBaseIpc({ knowledgeBaseService: service });
  const handler = registered.get('knowledge-base:create-folder');
  assert.ok(typeof handler === 'function');
  try {
    await assert.rejects(
      () => handler({}, '测试文件夹'),
      (error) => {
        const message = String(error?.message || '');
        assert.ok(!message.includes('knowledge_folders'), '内部表名不得外泄');
        assert.ok(!message.includes('UNIQUE constraint'), 'raw sqlite 消息不得外泄');
        assert.ok(message.length > 0 && message.length <= 200);
        return true;
      },
    );
    const logged = errors.join('\n');
    assert.match(logged, /knowledge-base:create-folder 处理失败/);
    assert.match(logged, /UNIQUE constraint failed: knowledge_folders\.name/);
  } finally {
    console.error = originalError;
  }
});

test('C1 成功路径透传与 event.sender 传递不受兜底影响', async () => {
  registered.clear();
  const sender = { id: 42 };
  let receivedSender = null;
  const service = {
    list: () => [{ id: 'doc-1' }],
    uploadDocuments: (folderId, webContents) => {
      receivedSender = webContents;
      return { success: true, added: folderId === 'f-1' };
    },
  };
  registerKnowledgeBaseIpc({ knowledgeBaseService: service });
  const listResult = await registered.get('knowledge-base:list')({});
  assert.deepStrictEqual(listResult, [{ id: 'doc-1' }]);
  const uploadResult = await registered.get('knowledge-base:upload-documents')({ sender }, 'f-1');
  assert.deepStrictEqual(uploadResult, { success: true, added: true });
  assert.strictEqual(receivedSender, sender);
});

test('C1 中文业务文案原样放行（服务层固定文案不被兜底吞掉）', async () => {
  registered.clear();
  const service = {
    renameFolder: () => {
      throw new Error('该文档正在处理中，请完成后再删除');
    },
  };
  registerKnowledgeBaseIpc({ knowledgeBaseService: service });
  await assert.rejects(
    () => registered.get('knowledge-base:rename-folder')({}, 'folder-1', '新名称'),
    (error) => {
      assert.strictEqual(String(error?.message), '该文档正在处理中，请完成后再删除');
      return true;
    },
  );
});

test('C1 全部 13 个通道均经兜底包装注册', () => {
  registered.clear();
  registerKnowledgeBaseIpc({ knowledgeBaseService: {} });
  const channels = [...registered.keys()].filter((channel) => channel.startsWith('knowledge-base:'));
  assert.strictEqual(channels.length, 13, `应有 13 个通道，实际 ${channels.length}`);
});
