const { ipcMain, shell } = require('electron');
const { userFacingTaskError } = require('../utils/taskErrorText.cjs');

// 主进程级单飞保护：渲染层的防连点只存在于单个页面组件内，切页重进即失效；
// 导出（含 Mermaid 转图）可长达分钟级，并发导出会叠加保存对话框并重复计数。
let exportInFlight = false;

function registerExportIpc({ exportService, donationService }) {
  ipcMain.handle('export:word', async (event, rawPayload) => {
    // 渲染层误传 null 时 payload.requestId 会抛原始 TypeError 泄进 UI，先归一为对象
    const payload = (rawPayload && typeof rawPayload === 'object') ? rawPayload : {};
    if (exportInFlight) {
      return { success: false, message: '已有导出任务正在进行，请稍候再试' };
    }
    exportInFlight = true;
    const requestId = payload.requestId || payload.request_id;
    const donationPrompt = donationService.recordWordExport({ deferPrompt: true });
    const sendProgress = (progress) => {
      event.sender.send('export:word-progress', { requestId, ...progress });
    };

    try {
      return await exportService.exportWord(payload, sendProgress);
    } catch (error) {
      // 用户可见错误统一净化：原始异常可能携带图片 URL/文件路径/底层 SDK 细节，
      // raw slice(0,500) 截断无法剥离路径 token；净化后 re-throw（cause 保留原始供诊断），
      // 各渲染层 catch 直接上屏净化文案，无需跨进程引入净化器。
      // 失败进度封顶 99：error 态显示 100% 会被误读为"导出已完成"。
      const message = userFacingTaskError(error, '导出 Word 失败');
      sendProgress({
        phase: 'error',
        progress: 99,
        message,
      });
      const cleanError = new Error(message);
      cleanError.cause = error;
      throw cleanError;
    } finally {
      exportInFlight = false;
      donationService.showPrompt(donationPrompt);
    }
  });

  ipcMain.handle('export:open-file', async (_event, filePath) => {
    const targetPath = String(filePath || '').trim();
    if (!targetPath) {
      throw new Error('缺少要打开的文件路径');
    }

    const errorMessage = await shell.openPath(targetPath);
    if (errorMessage) {
      throw new Error(`打开文件失败：${errorMessage}`);
    }

    return { success: true };
  });
}

module.exports = {
  registerExportIpc,
};
