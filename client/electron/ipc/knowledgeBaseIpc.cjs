const { ipcMain } = require('electron');

// 服务层业务错误一律是面向用户的中文固定文案（含 R121 的存在性守卫文案），
// 原样放行；sqlite/OS 的 raw 技术消息（UNIQUE constraint 表结构、EBUSY 本机路径）
// 为英文形态，统一替换为兜底文案，原始错误只进本地诊断日志。
function toUserFacingError(error, fallback) {
  const message = String(error?.message || error || '');
  if (/[\u4e00-\u9fff]/.test(message)) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(fallback);
}

// 本兜底拦截 store 层 raw 错误，不让它们经 ipcMain.handle 的默认序列化直达渲染层 toast。
function registerKnowledgeBaseIpc({ knowledgeBaseService }) {
  function handle(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await handler(event, ...args);
      } catch (error) {
        console.error(`[knowledge-base] ${channel} 处理失败`, error);
        throw toUserFacingError(error, '操作失败，请重试');
      }
    });
  }

  handle('knowledge-base:list', () => knowledgeBaseService.list());
  handle('knowledge-base:create-folder', (_event, name) => knowledgeBaseService.createFolder(name));
  handle('knowledge-base:rename-folder', (_event, folderId, name) => knowledgeBaseService.renameFolder(folderId, name));
  handle('knowledge-base:reorder-folder', (_event, draggedFolderId, targetFolderId, position) => knowledgeBaseService.reorderFolder(draggedFolderId, targetFolderId, position));
  handle('knowledge-base:delete-folder', (_event, folderId) => knowledgeBaseService.deleteFolder(folderId));
  handle('knowledge-base:delete-document', (_event, documentId) => knowledgeBaseService.deleteDocument(documentId));
  handle('knowledge-base:move-document', (_event, documentId, targetFolderId, targetDocumentId, position) => knowledgeBaseService.moveDocument(documentId, targetFolderId, targetDocumentId, position));
  handle('knowledge-base:upload-documents', (event, folderId) => knowledgeBaseService.uploadDocuments(folderId, event.sender));
  handle('knowledge-base:retry-document', (event, documentId) => knowledgeBaseService.retryDocument(documentId, event.sender));
  // batchSize 已忽略，服务端按模型上下文自动分段匹配
  handle('knowledge-base:start-matching', (event, documentId, batchSize) => knowledgeBaseService.startMatching(documentId, batchSize, event.sender));
  handle('knowledge-base:read-markdown', (_event, documentId) => knowledgeBaseService.readMarkdown(documentId));
  handle('knowledge-base:read-items', (_event, documentId) => knowledgeBaseService.readItems(documentId));
  handle('knowledge-base:read-analysis', (_event, documentId) => knowledgeBaseService.readAnalysis(documentId));
}

module.exports = { registerKnowledgeBaseIpc };
