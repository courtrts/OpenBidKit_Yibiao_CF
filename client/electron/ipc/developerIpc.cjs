const { BrowserWindow, ipcMain, shell } = require('electron');

function requireDeveloperMode(configStore) {
  if (!configStore.load()?.developer_mode) {
    throw new Error('请先开启开发者模式');
  }
}

function broadcastTextTokenStats(stats) {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('developer-token-stats:changed', stats);
    }
  });
}

function registerDeveloperIpc({ configStore, aiService, agentService, openDeveloperTokenStatsWindow, openDeveloperAgentMonitorWindow, developerExpansionReplaceTestService }) {
  let monitorSenderId = null;
  let unsubscribeMonitor = null;
  let monitorDestroyedSenderId = null;

  function detachMonitor(senderId) {
    if (senderId !== undefined && senderId !== null && senderId !== monitorSenderId) return;
    try { unsubscribeMonitor?.(); } catch {}
    unsubscribeMonitor = null;
    monitorSenderId = null;
  }

  aiService.onTextTokenStatsChanged((stats) => {
    broadcastTextTokenStats(stats);
  });

  ipcMain.handle('developer-token-stats:open-window', () => {
    requireDeveloperMode(configStore);
    return openDeveloperTokenStatsWindow();
  });

  ipcMain.handle('developer-token-stats:get', () => {
    requireDeveloperMode(configStore);
    return aiService.getTextTokenStats();
  });

  ipcMain.handle('developer-token-stats:reset', () => {
    requireDeveloperMode(configStore);
    return aiService.resetTextTokenStats();
  });

  ipcMain.handle('developer-agent-monitor:open-window', () => {
    requireDeveloperMode(configStore);
    return openDeveloperAgentMonitorWindow();
  });

  ipcMain.handle('developer-agent-monitor:attach', (event) => {
    requireDeveloperMode(configStore);
    const sender = event.sender;
    detachMonitor();
    monitorSenderId = sender.id;
    unsubscribeMonitor = agentService.onMonitorEvent((monitorEvent) => {
      if (sender.isDestroyed?.()) {
        detachMonitor(sender.id);
        return;
      }
      sender.send('developer-agent-monitor:event', monitorEvent);
    });
    // 同一 webContents 反复 attach 时避免叠加多个 once('destroyed') 监听器
    if (monitorDestroyedSenderId !== sender.id) {
      monitorDestroyedSenderId = sender.id;
      sender.once('destroyed', () => {
        if (monitorDestroyedSenderId === sender.id) monitorDestroyedSenderId = null;
        detachMonitor(sender.id);
      });
    }
    return agentService.getMonitorSnapshot();
  });

  ipcMain.handle('developer-agent-monitor:detach', (event) => {
    detachMonitor(event.sender.id);
    return { success: true };
  });

  ipcMain.handle('developer-agent-monitor:open-workspace', async (_event, workspaceDir) => {
    requireDeveloperMode(configStore);
    // 非字符串入参会让 shell.openPath 抛 Electron 原生 TypeError 泄给渲染层，先归一
    const targetDir = String(workspaceDir || '').trim();
    if (!targetDir) {
      return { success: false, message: '工作空间路径为空' };
    }
    const errorMessage = await shell.openPath(targetDir);
    if (errorMessage) {
      throw new Error(`打开当前工作空间失败：${errorMessage}`);
    }
    return { success: true, path: targetDir };
  });

  ipcMain.handle('developer-expansion-replace-test:run', (_event, payload) => {
    requireDeveloperMode(configStore);
    return developerExpansionReplaceTestService.run(payload);
  });
}

module.exports = {
  registerDeveloperIpc,
};
