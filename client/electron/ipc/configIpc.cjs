const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, shell, dialog } = require('electron');
const { parseImportedConfig } = require('../services/configStore.cjs');

function registerConfigIpc({ configStore, aiService, onDeveloperModeChange, onConfigChanged }) {
  ipcMain.handle('config:load', () => configStore.load());
  ipcMain.handle('config:save', (_event, config) => {
    const previousConfig = configStore.load();
    const result = configStore.save(config);
    const nextConfig = configStore.load();
    onDeveloperModeChange?.(Boolean(nextConfig?.developer_mode));
    onConfigChanged?.(nextConfig, previousConfig);
    return result;
  });
  // 配置文件状态（路径/最后修改时间/自愈记录），供设置页"配置文件"卡片展示
  ipcMain.handle('config:status', () => configStore.getStatus());
  // 一键导出配置：把当前归一化配置写到用户选择的 JSON 文件（换机迁移/备份）
  ipcMain.handle('config:export', async () => {
    const config = configStore.load();
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出配置',
      defaultPath: 'yibiao-config.json',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    });
    if (canceled || !filePath) {
      return { success: false, canceled: true, message: '已取消导出' };
    }
    try {
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
      return { success: true, path: filePath, message: '配置已导出' };
    } catch (error) {
      console.error('[config] 导出配置失败', error);
      return { success: false, message: '配置导出失败：请检查目标位置是否可写。' };
    }
  });
  // 一键导入配置：选择之前导出的 JSON 覆盖当前设置。
  // parseImportedConfig 负责体积/JSON/结构校验并剥离分析身份字段（保留本机统计身份）；
  // 落盘走 configStore.save 的归一化合并，非法字段回退默认值，不会写坏现有配置。
  ipcMain.handle('config:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '导入配置',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths || filePaths.length === 0) {
      return { success: false, canceled: true, message: '已取消导入' };
    }

    let raw;
    try {
      raw = fs.readFileSync(filePaths[0], 'utf-8');
    } catch (error) {
      console.error('[config] 导入配置文件读取失败', error);
      return { success: false, message: '导入的配置文件读取失败：请检查文件是否可访问。' };
    }

    let imported;
    try {
      imported = parseImportedConfig(raw);
    } catch (error) {
      // 校验失败文案由 parseImportedConfig 给出（中文、无内部细节），直接透传
      return { success: false, message: error?.message || '导入的配置无效，已拒绝导入。' };
    }

    const previousConfig = configStore.load();
    const result = configStore.save(imported);
    const nextConfig = configStore.load();
    onDeveloperModeChange?.(Boolean(nextConfig?.developer_mode));
    onConfigChanged?.(nextConfig, previousConfig);
    return { ...result, message: result?.success ? '配置已导入' : result?.message };
  });
  ipcMain.handle('config:list-models', (_event, config) => aiService.listModels(config));
  ipcMain.handle('config:get-model-info', (_event, modelName) => aiService.getModelInfo(modelName));
  ipcMain.handle('config:open-config-folder', async () => {
    const configFolder = path.dirname(configStore.getConfigFilePath());
    fs.mkdirSync(configFolder, { recursive: true });
    const errorMessage = await shell.openPath(configFolder);

    if (errorMessage) {
      throw new Error(`打开配置文件夹失败：${errorMessage}`);
    }

    return { success: true, path: configFolder };
  });
}

module.exports = {
  registerConfigIpc,
};
