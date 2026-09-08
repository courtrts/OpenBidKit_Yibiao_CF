const { BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const configWindows = new Map();

// 插件配置窗加载的是第三方插件 HTML：只允许在本插件目录内导航，
// 其余一律拦截并转系统浏览器，防止插件页面借 window.open / location 跳转外部地址。
function openPluginExternalUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return;
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;
  try {
    const url = new URL(candidate);
    if (['http:', 'https:'].includes(url.protocol)) {
      void shell.openExternal(url.toString());
    }
  } catch {
    // 非法 URL 直接忽略
  }
}

function isNavigationWithinPluginDir(url, pluginDir) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    const filePath = path.resolve(decodeURIComponent(parsed.pathname));
    const rootDir = path.resolve(pluginDir);
    return filePath !== rootDir && filePath.startsWith(`${rootDir}${path.sep}`);
  } catch {
    return false;
  }
}

/**
 * 打开插件配置窗口
 */
function openPluginConfigWindow(app, pluginId, pluginService) {
  // 如果窗口已存在，激活它
  if (configWindows.has(pluginId)) {
    const existingWindow = configWindows.get(pluginId);
    if (!existingWindow.isDestroyed()) {
      existingWindow.focus();
      return;
    }
  }

  try {
    const pluginDir = path.join(app.getPath('userData'), 'plugins', pluginId);
    const manifest = pluginService.readManifest(pluginDir);

    if (!manifest || !manifest.hasConfig) {
      throw new Error('插件没有配置界面');
    }

    const configUI = manifest.configUI || './config-ui/index.html';
    const configPath = path.join(pluginDir, configUI);

    if (!fs.existsSync(configPath)) {
      throw new Error('配置界面文件不存在');
    }

    // 创建配置窗口
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      title: `${manifest.name} - 配置`,
      webPreferences: {
        preload: path.join(__dirname, '../preload-plugin-config.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        additionalArguments: [`--plugin-id=${pluginId}`],
      },
    });

    win.loadFile(configPath);

    win.webContents.setWindowOpenHandler(({ url }) => {
      void openPluginExternalUrl(url);
      return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, url) => {
      if (isNavigationWithinPluginDir(url, pluginDir)) {
        return;
      }
      event.preventDefault();
      void openPluginExternalUrl(url);
    });

    // 窗口关闭时清理
    win.on('closed', () => {
      configWindows.delete(pluginId);
    });

    configWindows.set(pluginId, win);
  } catch (error) {
    console.error('[plugin-config-window] 打开配置窗口失败:', error);
    throw error;
  }
}

module.exports = {
  openPluginConfigWindow,
};
