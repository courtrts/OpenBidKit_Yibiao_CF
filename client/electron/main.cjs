const { app, BrowserWindow, dialog, nativeTheme, shell, protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerIpcHandlers } = require('./ipc/index.cjs');
const { createConfigStore } = require('./services/configStore.cjs');
const { setupAutoUpdate, checkAndDownloadUpdate, triggerUpdateDownload, quitAndInstall, getLatestVersion, getUpdateDownloadUrl } = require('./services/updateService.cjs');
const { getConfigFilePath, getGeneratedImagesDir, getGpuStartupProbePath, getImportedImagesDir, getDeveloperLogsDir } = require('./utils/paths.cjs');

const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const iconPath = path.join(__dirname, '../assets/icon.ico');
const packagedIndexUrl = pathToFileURL(path.join(__dirname, '../dist/index.html')).toString();
const IP_BLOCK_LIST_ENDPOINT = 'https://toubiao.ztok.dpdns.org/ip-blocks';
const GPU_HARDWARE_ACCELERATION_TRIAL_ARG = '--yibiao-trial-hardware-acceleration';
const FORCE_DISABLE_GPU_ARGS = ['--disable-gpu', '--disable-hardware-acceleration'];
let appQuitting = false;
let gpuRecoveryRelaunchStarted = false;
let developerTokenStatsWindow = null;
let developerAgentMonitorWindow = null;
let services = null;
let closeBeforeQuitStarted = false;
let quitAfterClose = false;

// 单实例锁：userData（配置、SQLite、工作区）只允许一个进程访问，
// 重复启动时聚焦已有主窗口而不是再开一个实例并发写同一份数据。
// 拿不到锁的进程立即退出，避免后续顶层初始化（GPU 状态机写配置等）产生副作用。
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
} else {
  app.on('second-instance', () => {
    // 主窗口存活则聚焦；仅剩辅助窗口（macOS）时重建主窗口回到主界面
    const window = getMainWindow ? getMainWindow() : null;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
}

// 主进程崩溃兜底：未捕获的 rejection 不终止进程（后台任务/服务状态尽量保活），
// 两者都落盘到 userData/logs/crash/crash.log 便于排查；
// 未捕获异常额外弹窗提示用户保存进度（不强制退出，避免直接丢失内存中的工作）。
function appendCrashLog(kind, error) {
  try {
    const logDir = getDeveloperLogsDir(app, 'crash');
    fs.mkdirSync(logDir, { recursive: true });
    const detail = error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack || ''}`
      : String(error);
    fs.appendFileSync(
      path.join(logDir, 'crash.log'),
      `\n===== ${kind} @ ${new Date().toISOString()} =====\n${detail}\n`,
      'utf-8',
    );
  } catch (logError) {
    console.error('[electron] 写入崩溃日志失败', logError?.message || String(logError));
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[electron] 未处理的 Promise rejection', reason);
  appendCrashLog('unhandledRejection', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[electron] 未捕获的异常', error);
  appendCrashLog('uncaughtException', error);
  if (app.isReady()) {
    dialog.showErrorBox('易标投标工具箱遇到意外错误', '程序遇到了未捕获的异常，部分功能可能不可用。建议先保存工作，然后重启程序。详情已记录到崩溃日志。');
  }
});

// 应用正常启动后静默检查公网出口 IP，仅明确命中封禁列表时结束进程。
async function checkBlockedIpAfterStartup() {
  try {
    const response = await net.fetch(IP_BLOCK_LIST_ENDPOINT, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    const data = await response.json();
    const clientIp = typeof data?.clientIp === 'string' ? data.clientIp.trim().toLowerCase() : '';
    if (data?.code !== 0 || !clientIp || !Array.isArray(data.blockedIps)) return;
    const blocked = data.blockedIps.some((ip) => typeof ip === 'string' && ip.trim().toLowerCase() === clientIp);
    // 走 app.quit() 的 before-quit 清理流程：运行中任务的 checkpoint/SQLite 得以落盘，
    // GPU 探测定时器被清理，避免残留 pending 探测文件导致下次启动被误判为 GPU 异常。
    if (blocked) app.quit();
  } catch {}
}

function hasProcessArg(name) {
  return process.argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function readStartupConfigFile() {
  try {
    const configFile = getConfigFilePath(app);
    if (!fs.existsSync(configFile)) {
      return {};
    }

    const raw = fs.readFileSync(configFile, 'utf-8');
    const config = JSON.parse(raw);
    return config && typeof config === 'object' ? config : {};
  } catch (error) {
    console.warn('[gpu] 读取图形渲染配置失败，将使用默认 GPU 硬件加速策略', error?.message || String(error));
    return null;
  }
}

function writeStartupConfigFile(config) {
  let tempFile = '';
  try {
    const configFile = getConfigFilePath(app);
    tempFile = `${configFile}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tempFile, configFile);
    return true;
  } catch (error) {
    if (tempFile) {
      try { fs.rmSync(tempFile, { force: true }); } catch {}
    }
    console.warn('[gpu] 写入图形渲染配置失败', error?.message || String(error));
    return false;
  }
}

function updateStartupConfigFile(mutator) {
  const config = readStartupConfigFile();
  if (!config) {
    return false;
  }
  return writeStartupConfigFile(mutator({ ...config }));
}

function isPendingGpuStartupProbe(value) {
  return Boolean(value && typeof value === 'object' && value.state === 'pending');
}

function readGpuStartupProbeFile() {
  try {
    const probeFile = getGpuStartupProbePath(app);
    if (!fs.existsSync(probeFile)) {
      return null;
    }

    const raw = fs.readFileSync(probeFile, 'utf-8');
    const probe = JSON.parse(raw);
    return probe && typeof probe === 'object' ? probe : null;
  } catch (error) {
    console.warn('[gpu] 读取 GPU 启动探测文件失败', error?.message || String(error));
    return null;
  }
}

function writeGpuStartupProbeFile(probe) {
  let tempFile = '';
  try {
    const probeFile = getGpuStartupProbePath(app);
    tempFile = `${probeFile}.${process.pid}.${Date.now()}.tmp`;
    fs.mkdirSync(path.dirname(probeFile), { recursive: true });
    fs.writeFileSync(tempFile, JSON.stringify(probe, null, 2), 'utf-8');
    fs.renameSync(tempFile, probeFile);
    return true;
  } catch (error) {
    if (tempFile) {
      try { fs.rmSync(tempFile, { force: true }); } catch {}
    }
    console.warn('[gpu] 写入 GPU 启动探测文件失败', error?.message || String(error));
    return false;
  }
}

function removeGpuStartupProbeFile() {
  try {
    fs.rmSync(getGpuStartupProbePath(app), { force: true });
    return true;
  } catch (error) {
    console.warn('[gpu] 删除 GPU 启动探测文件失败', error?.message || String(error));
    return false;
  }
}

function readStartupGpuPreference() {
  const previousProbePending = isPendingGpuStartupProbe(readGpuStartupProbeFile());
  const config = readStartupConfigFile();
  if (!config) {
    return { enabled: true, configured: true, previousProbePending };
  }

  const configured = typeof config.gpu_hardware_acceleration_configured === 'boolean'
    ? config.gpu_hardware_acceleration_configured
    : true;

  return {
    enabled: configured === false
      ? true
      : typeof config.gpu_hardware_acceleration_enabled === 'boolean'
      ? config.gpu_hardware_acceleration_enabled
      : true,
    configured: configured === false ? true : configured,
    previousProbePending,
  };
}

function markGpuStartupProbePending() {
  writeGpuStartupProbeFile({
    state: 'pending',
    started_at: new Date().toISOString(),
  });
}

function clearGpuStartupProbe() {
  removeGpuStartupProbeFile();
}

function disableGpuHardwareAccelerationForNextLaunch(reason) {
  const saved = updateStartupConfigFile((config) => ({
    ...config,
    gpu_hardware_acceleration_enabled: false,
    gpu_hardware_acceleration_configured: true,
    gpu_hardware_acceleration_disabled_reason: reason,
    gpu_hardware_acceleration_disabled_at: new Date().toISOString(),
  }));
  if (saved) {
    clearGpuStartupProbe();
  }
}

function configureGpuHardwareAcceleration() {
  const preference = readStartupGpuPreference();
  const trial = hasProcessArg(GPU_HARDWARE_ACCELERATION_TRIAL_ARG);
  const forcedDisabled = FORCE_DISABLE_GPU_ARGS.some((arg) => hasProcessArg(arg));
  const autoDisabledByPreviousFailure = !forcedDisabled && !trial && preference.enabled && preference.previousProbePending;

  if (autoDisabledByPreviousFailure) {
    disableGpuHardwareAccelerationForNextLaunch('previous-startup-probe');
  }

  const hardwareAccelerationEnabled = !forcedDisabled && !autoDisabledByPreviousFailure && (trial || preference.enabled);

  if (!hardwareAccelerationEnabled) {
    app.disableHardwareAcceleration();
  } else {
    markGpuStartupProbePending();
  }

  return {
    autoDisabledByPreviousFailure,
    configured: preference.configured,
    forcedDisabled,
    hardwareAccelerationEnabled,
    probeStarted: hardwareAccelerationEnabled,
    trial,
  };
}

function scheduleGpuStartupProbeClear(mainWindow) {
  if (!gpuStartupState.probeStarted) {
    return;
  }

  const clearWhenStable = () => {
    setTimeout(() => {
      if (!appQuitting && !gpuRecoveryRelaunchStarted) {
        clearGpuStartupProbe();
      }
    }, 3000);
  };

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', clearWhenStable);
  } else {
    clearWhenStable();
  }
}

function withoutGpuControlArgs(args) {
  const excludedArgs = new Set([GPU_HARDWARE_ACCELERATION_TRIAL_ARG, ...FORCE_DISABLE_GPU_ARGS]);
  return args.filter((arg) => !excludedArgs.has(String(arg).split('=')[0]));
}

async function closeServicesBeforeExit() {
  try {
    await services?.closeServices?.();
  } catch (error) {
    console.warn('[electron] 关闭后台服务失败', error?.message || String(error));
  }
}

async function relaunchWithGpuDisabled() {
  if (gpuRecoveryRelaunchStarted) {
    return;
  }

  gpuRecoveryRelaunchStarted = true;
  appQuitting = true;
  await closeServicesBeforeExit();
  app.relaunch({ args: withoutGpuControlArgs(process.argv.slice(1)).concat('--disable-gpu') });
  app.exit(0);
}

const gpuStartupState = configureGpuHardwareAcceleration();

protocol.registerSchemesAsPrivileged([{
  scheme: 'yibiao-asset',
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

function registerAssetProtocol() {
  protocol.handle('yibiao-asset', (request) => {
    try {
      const url = new URL(request.url);
      const assetRoots = {
        'generated-images': getGeneratedImagesDir(app),
        'imported-images': getImportedImagesDir(app),
      };
      const rootDir = assetRoots[url.hostname];
      if (!rootDir) {
        return new Response('Not found', { status: 404 });
      }

      const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if (!relativePath) {
        return new Response('Not found', { status: 404 });
      }

      const baseDir = path.resolve(rootDir);
      const filePath = path.resolve(baseDir, relativePath);
      if (filePath !== baseDir && !filePath.startsWith(`${baseDir}${path.sep}`)) {
        return new Response('Forbidden', { status: 403 });
      }

      if (!fs.existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }

      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Invalid asset url', { status: 400 });
    }
  });
}

function normalizeExternalUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const candidate = /^www\./i.test(raw) ? `https://${raw}` : raw;

  try {
    const url = new URL(candidate);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function isAllowedAppNavigation(value) {
  try {
    const url = new URL(value);
    if (rendererUrl) {
      return url.origin === new URL(rendererUrl).origin;
    }

    const indexUrl = new URL(packagedIndexUrl);
    return url.protocol === 'file:' && url.pathname === indexUrl.pathname;
  } catch {
    return false;
  }
}

async function openExternalUrl(value) {
  const externalUrl = normalizeExternalUrl(value);
  if (!externalUrl) return;
  try {
    await shell.openExternal(externalUrl);
  } catch (error) {
    const preview = externalUrl.length > 300 ? `${externalUrl.slice(0, 300)}...` : externalUrl;
    console.warn('[electron] 打开外部链接失败', { url: preview, message: error.message || String(error) });
  }
}

// 当前存活的 主窗口 引用：macOS 关窗后 activate 会重建窗口，
// 所有 main→renderer 推送必须经 getMainWindow() 现取现判，
// 不能长期持有旧窗口引用（悬空引用会让推送静默丢失甚至抛错）。
let activeMainWindow = null;

function getMainWindow() {
  return activeMainWindow && !activeMainWindow.isDestroyed() ? activeMainWindow : null;
}

function attachMainWindowClosedHandlers(win) {
  win.on('closed', () => {
    closeDeveloperTokenStatsWindow();
    closeDeveloperAgentMonitorWindow();
  });
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 720,
    backgroundColor: '#f8fafd',
    title: '易标投标工具箱',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  if (rendererUrl) {
    mainWindow.loadURL(rendererUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppNavigation(url)) {
      return;
    }

    event.preventDefault();
    void openExternalUrl(url);
  });

  attachMainWindowClosedHandlers(mainWindow);
  activeMainWindow = mainWindow;
  return mainWindow;
}

function appendWindowQuery(url, windowName) {
  return `${url}${url.includes('?') ? '&' : '?'}window=${encodeURIComponent(windowName)}`;
}

function closeDeveloperTokenStatsWindow() {
  const window = developerTokenStatsWindow;
  developerTokenStatsWindow = null;
  if (window && !window.isDestroyed()) {
    window.close();
  }
}

function openDeveloperTokenStatsWindow() {
  if (developerTokenStatsWindow && !developerTokenStatsWindow.isDestroyed()) {
    if (developerTokenStatsWindow.isMinimized()) {
      developerTokenStatsWindow.restore();
    }
    developerTokenStatsWindow.show();
    developerTokenStatsWindow.focus();
    return { success: true };
  }

  const tokenStatsWindow = new BrowserWindow({
    width: 360,
    height: 330,
    minWidth: 320,
    minHeight: 300,
    maxWidth: 420,
    maxHeight: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Token 统计',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  developerTokenStatsWindow = tokenStatsWindow;
  tokenStatsWindow.setMenuBarVisibility(false);
  tokenStatsWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: 'deny' };
  });
  tokenStatsWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppNavigation(url)) {
      return;
    }
    event.preventDefault();
    void openExternalUrl(url);
  });
  tokenStatsWindow.on('closed', () => {
    if (developerTokenStatsWindow === tokenStatsWindow) {
      developerTokenStatsWindow = null;
    }
  });

  const baseUrl = rendererUrl || packagedIndexUrl;
  tokenStatsWindow.loadURL(appendWindowQuery(baseUrl, 'token-stats'));
  return { success: true };
}

function closeDeveloperAgentMonitorWindow() {
  const window = developerAgentMonitorWindow;
  developerAgentMonitorWindow = null;
  if (window && !window.isDestroyed()) {
    window.close();
  }
}

function openDeveloperAgentMonitorWindow() {
  if (developerAgentMonitorWindow && !developerAgentMonitorWindow.isDestroyed()) {
    if (developerAgentMonitorWindow.isMinimized()) {
      developerAgentMonitorWindow.restore();
    }
    developerAgentMonitorWindow.show();
    developerAgentMonitorWindow.focus();
    return { success: true };
  }

  const monitorWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#fafcff',
    title: 'Pi Agent 执行监视器',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  developerAgentMonitorWindow = monitorWindow;
  monitorWindow.setMenuBarVisibility(false);
  monitorWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: 'deny' };
  });
  monitorWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedAppNavigation(url)) {
      return;
    }
    event.preventDefault();
    void openExternalUrl(url);
  });
  monitorWindow.on('closed', () => {
    if (developerAgentMonitorWindow === monitorWindow) {
      developerAgentMonitorWindow = null;
    }
  });

  const baseUrl = rendererUrl || packagedIndexUrl;
  monitorWindow.loadURL(appendWindowQuery(baseUrl, 'agent-monitor'));
  return { success: true };
}

// Windows 通知需要固定的 AppUserModelID，否则渲染进程的系统通知可能不展示。
app.setAppUserModelId('com.yibiao.openbidkit');

app.whenReady().then(() => {
  // 深色模式：启动时按用户配置同步原生标题栏/系统控件配色。
  // 这里独立创建一个只读用途的 configStore 实例（ipc 层另有单实例负责读写）：
  // 本实例只读不写，不参与配置文件的合并保存，无缓存一致性问题。
  try {
    const startupConfigStore = createConfigStore(app);
    const themeMode = startupConfigStore.load().theme_mode;
    nativeTheme.themeSource = themeMode === 'dark' || themeMode === 'system' ? themeMode : 'light';
  } catch (error) {
    console.warn('[theme] 读取主题配置失败，回退浅色模式', error?.message || String(error));
    nativeTheme.themeSource = 'light';
  }
  registerAssetProtocol();
  const mainWindow = createMainWindow();
  scheduleGpuStartupProbeClear(mainWindow);
  services = registerIpcHandlers({
    app,
    mainWindow,
    // 动态访问器：donation/数据库状态等推送按需解析当前存活主窗口，
    // macOS 关窗重开后不再指向已销毁的旧窗口。
    getMainWindow,
    checkAndDownloadUpdate,
    triggerUpdateDownload,
    quitAndInstall,
    getLatestVersion,
    getUpdateDownloadUrl,
    gpuStartupState,
    gpuTrialArg: GPU_HARDWARE_ACCELERATION_TRIAL_ARG,
    forceDisableGpuArgs: FORCE_DISABLE_GPU_ARGS,
    openDeveloperTokenStatsWindow,
    closeDeveloperTokenStatsWindow,
    openDeveloperAgentMonitorWindow,
    closeDeveloperAgentMonitorWindow,
  });
  setupAutoUpdate({ app, mainWindow, getMainWindow });
  void checkBlockedIpAfterStartup();

  app.on('activate', () => {
    // 仅剩辅助窗口（开发者工具等）时也要重建主窗口，不能只看 getAllWindows().length
    if (!getMainWindow()) {
      createMainWindow();
    }
  });
});

app.on('child-process-gone', (_event, details) => {
  if (details?.type !== 'GPU') return;
  if (appQuitting) return;
  console.warn('[gpu] GPU 子进程异常退出', {
    reason: details.reason,
    exitCode: details.exitCode,
    hardwareAccelerationEnabled: gpuStartupState.hardwareAccelerationEnabled,
    trial: gpuStartupState.trial,
    forcedDisabled: gpuStartupState.forcedDisabled,
  });
  if (gpuStartupState.hardwareAccelerationEnabled && !gpuStartupState.forcedDisabled && details.reason !== 'clean-exit') {
    disableGpuHardwareAccelerationForNextLaunch('gpu-process-gone');
    void relaunchWithGpuDisabled();
  }
});

app.on('before-quit', (event) => {
  if (quitAfterClose) {
    return;
  }
  event.preventDefault();
  if (closeBeforeQuitStarted) {
    return;
  }
  closeBeforeQuitStarted = true;
  appQuitting = true;
  // 清理必须让位于退出：closeServicesBeforeExit 里会等待所有运行中任务与
  // 子进程结束，任一环节挂起（如子进程被安全软件阻断）会导致进程永不退出，
  // 叠加单实例锁后用户连重启都做不到。这里 8 秒兜底强制退出。
  const forceQuitTimer = setTimeout(() => {
    console.warn('[electron] before-quit 清理超时，强制退出');
    app.exit(0);
  }, 8000);
  void Promise.resolve()
    .then(async () => {
      // 探测 pending 文件必须在可能挂起的服务清理之前清理：
      // 若清理卡住触发 8 秒强退，残留的 pending 文件会让下次启动误判
      // “上次 GPU 探测未完成”而永久静默禁用硬件加速。
      if (gpuStartupState.probeStarted && !gpuRecoveryRelaunchStarted) {
        clearGpuStartupProbe();
      }
      await closeServicesBeforeExit();
    })
    .catch((error) => {
      console.warn('[electron] before-quit 清理失败', error?.message || String(error));
    })
    .finally(() => {
      clearTimeout(forceQuitTimer);
      quitAfterClose = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
