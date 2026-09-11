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

    // configUI 来自第三方 manifest（外部输入）：用 path.resolve 归一化后校验必须落在本插件目录内。
    // path.join 无法阻止绝对路径或 '..' 跳出 pluginDir，越界的初始 loadFile 会加载本机任意 HTML。
    const rawConfigUI = String(manifest.configUI || './config-ui/index.html');
    if (rawConfigUI.includes('\0')) {
      throw new Error('插件配置界面路径非法');
    }
    const resolvedPluginDir = path.resolve(pluginDir);
    const configPath = path.resolve(resolvedPluginDir, rawConfigUI);
    if (configPath === resolvedPluginDir || !configPath.startsWith(`${resolvedPluginDir}${path.sep}`)) {
      throw new Error('插件配置界面路径超出插件目录');
    }

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

    // existsSync 通过后文件仍可能在加载前被删除/损坏；load 失败若不捕获会成为
    // unhandledRejection 且用户只看到白屏，这里记录并给出可见的错误页后关窗。
    win.loadFile(configPath).catch((error) => {
      console.error('[plugin-config] load failed', error?.message || String(error));
      win.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<body style="font-family:sans-serif"><h3>插件配置界面加载失败</h3><p>配置文件可能已损坏或被移动，请重新安装该插件。</p></body>')}`).catch(() => undefined);
      setTimeout(() => {
        if (!win.isDestroyed()) win.close();
      }, 3000);
    });

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
