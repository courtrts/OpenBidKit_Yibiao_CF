const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');
const { createPluginContext } = require('./pluginContext.cjs');
const { assertAllowedUpdateUrl } = require('./updateService.cjs');

const PLUGIN_MARKET_URL = 'https://toubiao.ztok.dpdns.org/plugins';
const PLUGIN_DOWNLOAD_URL = `${PLUGIN_MARKET_URL}/download`;
const PLUGIN_STATE_FILE = 'plugin-states.json';

/** 比较正式版版本号，返回值大于 0 表示前者版本更高。 */
function comparePluginVersions(a, b) {
  const partsA = String(a || '').trim().replace(/^v/i, '').split('.').map((part) => Number(part) || 0);
  const partsB = String(b || '').trim().replace(/^v/i, '').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const difference = (partsA[index] || 0) - (partsB[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

class PluginService {
  constructor() {
    this.app = null;
    this.plugins = new Map();
    this.pluginStates = {};
    this.services = {};
    this.marketCache = [];
    this.marketCacheTime = 0;
    this.updatingPlugins = new Set();
    this.failedUpdates = new Map();
    this.pluginOperations = new Map();
    this.activeBulkUpdatePromise = null;
  }

  /** 获取单个插件的独占操作权，内部子步骤可复用所有者令牌。 */
  acquirePluginOperation(pluginId, operation, ownerToken) {
    const activeOperation = this.pluginOperations.get(pluginId);
    if (ownerToken) {
      if (!activeOperation || activeOperation.token !== ownerToken) {
        throw new Error('插件操作上下文已失效');
      }
      return { token: ownerToken, ownsLock: false };
    }

    if (activeOperation) {
      throw new Error(`插件正在${activeOperation.operation}，请稍后再试`);
    }

    const token = Symbol(pluginId);
    this.pluginOperations.set(pluginId, { token, operation });
    return { token, ownsLock: true };
  }

  /** 仅由锁的所有者释放插件操作权。 */
  releasePluginOperation(pluginId, lock) {
    if (!lock.ownsLock) return;
    if (this.pluginOperations.get(pluginId)?.token === lock.token) {
      this.pluginOperations.delete(pluginId);
    }
  }

  /**
   * 初始化插件服务
   */
  async initialize(app, services) {
    this.app = app;
    this.services = services;
    
    const pluginsDir = this.getPluginsDir();
    fs.mkdirSync(pluginsDir, { recursive: true });
    
    this.loadPluginStates();
    this.failedUpdates.clear();
    
    console.log('[plugin-service] 插件服务已初始化');
  }

  /**
   * 更新服务引用（在 workspace database 初始化后调用）
   */
  updateServices(services) {
    this.services = { ...this.services, ...services };
    console.log('[plugin-service] 服务已更新');
  }

  /**
   * 获取插件目录
   */
  getPluginsDir() {
    return path.join(this.app.getPath('userData'), 'plugins');
  }

  /**
   * 获取插件状态文件路径
   */
  getStateFilePath() {
    return path.join(this.app.getPath('userData'), PLUGIN_STATE_FILE);
  }

  /**
   * 加载插件状态
   */
  loadPluginStates() {
    try {
      const stateFile = this.getStateFilePath();
      if (fs.existsSync(stateFile)) {
        const data = fs.readFileSync(stateFile, 'utf-8');
        this.pluginStates = JSON.parse(data);
      }
    } catch (error) {
      console.error('[plugin-service] 加载插件状态失败:', error);
      this.pluginStates = {};
    }
  }

  /**
   * 保存插件状态
   */
  savePluginStates() {
    try {
      const stateFile = this.getStateFilePath();
      fs.writeFileSync(stateFile, JSON.stringify(this.pluginStates, null, 2), 'utf-8');
    } catch (error) {
      console.error('[plugin-service] 保存插件状态失败:', error);
    }
  }

  /**
   * 读取插件 manifest
   */
  readManifest(pluginDir) {
    try {
      const manifestPath = path.join(pluginDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        return null;
      }
      const data = fs.readFileSync(manifestPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      console.error('[plugin-service] 读取 manifest 失败:', error);
      return null;
    }
  }

  /**
   * 清理插件目录下已加载的 CommonJS 模块缓存
   */
  clearPluginModuleCache(pluginDir) {
    for (const modulePath of Object.keys(require.cache)) {
      const relativePath = path.relative(pluginDir, modulePath);
      const isPluginModule = relativePath !== '..'
        && !relativePath.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relativePath);

      if (isPluginModule) {
        delete require.cache[modulePath];
      }
    }
  }

  /**
   * 启用所有标记为 enabled 的插件
   * 在 workspace database 就绪后调用
   */
  async activateEnabledPlugins() {
    const pluginsDir = this.getPluginsDir();
    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      
      const pluginId = entry.name;
      
      // 如果插件状态为 enabled，自动启用
      if (this.pluginStates[pluginId]?.enabled) {
        console.log(`[plugin-service] 自动启用插件: ${pluginId}`);
        try {
          await this.enablePlugin(pluginId);
        } catch (error) {
          console.error(`[plugin-service] 自动启用插件失败: ${pluginId}`, error);
        }
      }
    }
  }

  /**
   * 从服务器获取可用插件列表
   */
  async fetchAvailablePlugins() {
    // 使用缓存，5分钟内不重复请求
    const now = Date.now();
    if (this.marketCache.length > 0 && now - this.marketCacheTime < 5 * 60 * 1000) {
      return this.marketCache;
    }

    return new Promise((resolve, reject) => {
      // 与 downloadPlugin 同款 60s 超时：市场服务器"已连接不响应"时若无限挂起，
      // 安装/更新/批量升级的操作锁会被永久占用，只能重启应用恢复。
      const request = https.get(PLUGIN_MARKET_URL, (res) => {
        let data = '';
        // chunked 流损坏等流级错误要有监听者，否则成为未捕获异常拖崩主进程
        res.on('error', reject);
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.code === 0 && json.plugins) {
              this.marketCache = json.plugins;
              this.marketCacheTime = now;
              resolve(json.plugins);
            } else {
              reject(new Error('插件市场响应格式错误'));
            }
          } catch (error) {
            reject(error);
          }
        });
      });
      request.setTimeout(60000, () => {
        request.destroy(new Error('插件市场请求超时（60 秒）'));
      });
      request.on('error', reject);
    });
  }

  /**
   * 获取已安装插件列表
   */
  getInstalledPlugins() {
    const pluginsDir = this.getPluginsDir();
    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    const installed = [];
    
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // 跳过升级备份与 staging 中转目录，避免半截目录被当成已安装插件
      if (entry.name.startsWith('.') || entry.name.includes('.update-backup-')) continue;

      const pluginId = entry.name;
      const pluginDir = path.join(pluginsDir, pluginId);
      const manifest = this.readManifest(pluginDir);

      if (!manifest) continue;

      const state = this.pluginStates[pluginId] || {};
      
      installed.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        enabled: state.enabled || false,
        installed: true,
        installPath: pluginDir,
        hasConfig: manifest.hasConfig || false,
        manifest,
        updating: this.updatingPlugins.has(pluginId),
      });
    }
    
    return installed;
  }

  /** 检查所有已安装插件是否存在更高的市场版本。 */
  async checkAvailableUpdates() {
    const marketPlugins = await this.fetchAvailablePlugins();
    const installedMap = new Map(this.getInstalledPlugins().map((plugin) => [plugin.id, plugin]));

    return marketPlugins.flatMap((plugin) => {
      const installed = installedMap.get(plugin.id);
      if (!installed || comparePluginVersions(plugin.version, installed.version) <= 0) {
        return [];
      }
      return [{
        id: plugin.id,
        name: plugin.name,
        installedVersion: installed.version,
        version: plugin.version,
      }];
    });
  }

  /** 依次升级当前所有可升级插件，并汇总每个插件的执行结果。 */
  async updateAllAvailablePlugins() {
    if (this.activeBulkUpdatePromise) {
      throw new Error('插件批量升级正在进行，请勿重复执行');
    }

    const bulkUpdatePromise = (async () => {
      const updates = await this.checkAvailableUpdates();
      const results = [];

      for (const plugin of updates) {
        try {
          await this.updatePlugin(plugin.id);
          results.push({ ...plugin, success: true });
        } catch (error) {
          results.push({
            ...plugin,
            success: false,
            message: error?.message || String(error),
          });
        }
      }

      return { updates, results };
    })();

    this.activeBulkUpdatePromise = bulkUpdatePromise;
    try {
      return await bulkUpdatePromise;
    } finally {
      if (this.activeBulkUpdatePromise === bulkUpdatePromise) {
        this.activeBulkUpdatePromise = null;
      }
    }
  }

  /**
   * 下载插件。
   * 包地址来自插件市场接口（外部输入）：仅允许 https + 白名单 host，重定向同样校验，
   * 60 秒空闲超时防止慢速/假死服务器挂死插件操作锁，并校验响应状态码（原实现会把 404 页面当 zip 落盘）。
   */
  async downloadPlugin(releaseUrl) {
    let initialUrl;
    try {
      initialUrl = assertAllowedUpdateUrl(releaseUrl, '插件包');
    } catch (error) {
      throw error;
    }

    const tempDir = path.join(this.app.getPath('temp'), 'yibiao-plugins');
    fs.mkdirSync(tempDir, { recursive: true });

    // 临时文件名加随机前缀，避免两个同名插件包互相覆盖
    const baseName = path.basename(initialUrl.pathname) || 'plugin.zip';
    const zipPath = path.join(tempDir, `${crypto.randomUUID()}-${baseName}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      let request = null;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        if (request) {
          try { request.destroy(); } catch {}
        }
        try { fs.rmSync(zipPath, { force: true }); } catch {}
        reject(error);
      };

      const follow = (rawUrl, redirectCount) => {
        let parsed;
        try {
          parsed = assertAllowedUpdateUrl(rawUrl, '插件包下载');
        } catch (error) {
          fail(error);
          return;
        }
        request = https.get(parsed, { headers: { 'User-Agent': 'yibiao-client' } }, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            response.resume();
            if (redirectCount >= 3) {
              fail(new Error('插件包下载重定向次数过多'));
              return;
            }
            follow(new URL(response.headers.location, parsed).toString(), redirectCount + 1);
            return;
          }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            response.resume();
            fail(new Error(`插件包下载失败：${response.statusCode}`));
            return;
          }
          const file = fs.createWriteStream(zipPath);
          // 慢速滴流可绕过空闲超时无限写盘：超过 200MB 视为异常流，中止并清理
          const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
          let receivedBytes = 0;
          response.on('data', (chunk) => {
            receivedBytes += chunk.length;
            if (receivedBytes > MAX_DOWNLOAD_BYTES) {
              response.destroy();
              file.destroy();
              fail(new Error('插件包超过 200MB 上限，已中止下载'));
            }
          });
          response.pipe(file);
          response.on('error', fail);
          file.on('error', fail);
          file.on('finish', () => {
            file.close();
            if (settled) return;
            settled = true;
            resolve(zipPath);
          });
        });
        request.on('error', fail);
        request.setTimeout(60000, () => {
          fail(new Error('插件包下载超时'));
        });
      };

      follow(initialUrl.toString(), 0);
    });
  }

  /**
   * 静默记录一次成功的插件下载
   */
  recordPluginDownload(pluginId) {
    const body = JSON.stringify({ id: pluginId });
    const request = https.request(PLUGIN_DOWNLOAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (response) => response.resume());
    // 市场服务器"已连接不响应"时 socket 永不结束，每次安装都新增一个挂起连接
    request.setTimeout(60000, () => request.destroy());
    request.on('error', () => {});
    request.end(body);
  }

  /**
   * 解压插件
   */
  async extractPlugin(zipPath, targetDir) {
    try {
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(targetDir, true);
    } catch (error) {
      throw new Error(`解压失败: ${error.message}`);
    }
  }

  /**
   * 安装插件
   */
  async installPlugin(pluginId, ownerToken) {
    const lock = this.acquirePluginOperation(pluginId, '安装', ownerToken);
    try {
      // 从服务器获取插件信息
      const plugins = await this.fetchAvailablePlugins();
      const pluginInfo = plugins.find(p => p.id === pluginId);
      
      if (!pluginInfo) {
        throw new Error('插件不存在');
      }
      
      // 下载插件
      console.log('[plugin-service] 下载插件:', pluginInfo.releaseUrl);
      const zipPath = await this.downloadPlugin(pluginInfo.releaseUrl);

      // 解压到 plugins 目录内的 staging 中转目录（同卷 rename 原子生效），
      // manifest 校验通过后再替换旧目录——损坏包不再造成旧版已删、新目录半截
      const pluginsDir = this.getPluginsDir();
      const stagingDir = fs.mkdtempSync(path.join(pluginsDir, '.staging-market-'));
      try {
        await this.extractPlugin(zipPath, stagingDir);

        // 读取 manifest
        const stagedManifest = this.readManifest(stagingDir);
        if (!stagedManifest) {
          throw new Error('插件 manifest.json 不存在或格式错误');
        }
        if (stagedManifest.id !== pluginId) {
          throw new Error(`插件 manifest.id 与市场 ID 不一致：应为 ${pluginId}`);
        }

        // 校验通过才替换旧目录
        const pluginDir = path.join(pluginsDir, pluginId);
        if (this.plugins.has(pluginId)) {
          await this.disablePlugin(pluginId);
        }
        this.clearPluginModuleCache(pluginDir);
        if (fs.existsSync(pluginDir)) {
          fs.rmSync(pluginDir, { recursive: true, force: true });
        }
        fs.renameSync(stagingDir, pluginDir);
      } finally {
        // 失败路径清理半截 staging，成功路径 staging 已被 rename 走（不存在则忽略）
        fs.rmSync(stagingDir, { recursive: true, force: true });
        // 清理临时文件
        fs.unlinkSync(zipPath);
      }

      // 读取 manifest
      const manifest = this.readManifest(path.join(pluginsDir, pluginId));
      if (!manifest) {
        throw new Error('插件 manifest.json 不存在或格式错误');
      }
      
      // 保存状态
      this.pluginStates[pluginId] = {
        installed: true,
        enabled: false,
        version: manifest.version,
        installedAt: new Date().toISOString(),
      };
      this.savePluginStates();

      this.recordPluginDownload(pluginId);
      
      // 清除更新失败标记
      this.failedUpdates.delete(pluginId);
      
      console.log('[plugin-service] 插件安装成功:', pluginId);
    } catch (error) {
      console.error('[plugin-service] 安装插件失败:', error);
      throw error;
    } finally {
      this.releasePluginOperation(pluginId, lock);
    }
  }

  /**
   * 从本地 ZIP 安装插件，同 ID 插件直接覆盖升级
   */
  async installOfflinePlugin(zipPath) {
    if (path.extname(zipPath).toLowerCase() !== '.zip') {
      throw new Error('请选择 ZIP 格式的插件安装包');
    }

    // staging 建在 plugins 目录内（同卷）：os.temp 与 userData 跨盘时 renameSync 会 EXDEV 失败
    const tempRoot = path.join(this.getPluginsDir(), '.staging-offline');
    fs.mkdirSync(tempRoot, { recursive: true });
    let stagingDir = fs.mkdtempSync(path.join(tempRoot, 'offline-'));

    try {
      await this.extractPlugin(zipPath, stagingDir);

      const manifest = this.readManifest(stagingDir);
      if (!manifest) {
        throw new Error('ZIP 根目录缺少有效的 manifest.json');
      }

      const pluginId = String(manifest.id || '');
      const pluginName = String(manifest.name || '').trim();
      const pluginVersion = String(manifest.version || '').trim();
      const hasMain = fs.existsSync(path.join(stagingDir, 'main.cjs'));
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(pluginId)) {
        throw new Error('manifest.json 中的插件 ID 缺失或格式不正确');
      }
      if (!pluginName) {
        throw new Error('manifest.json 中缺少插件名称');
      }
      if (!pluginVersion) {
        throw new Error('manifest.json 中缺少插件版本');
      }

      const lock = this.acquirePluginOperation(pluginId, '离线安装');
      try {
        const pluginDir = path.join(this.getPluginsDir(), pluginId);
        const previousManifest = this.readManifest(pluginDir);
        const previousState = { ...(this.pluginStates[pluginId] || {}) };
        const wasEnabled = Boolean(previousManifest) && previousState.enabled === true;
        const shouldRestoreEnabledState = wasEnabled && hasMain;
        if (this.plugins.has(pluginId)) {
          await this.disablePlugin(pluginId);
        }
        this.clearPluginModuleCache(pluginDir);
        if (fs.existsSync(pluginDir)) {
          fs.rmSync(pluginDir, { recursive: true, force: true });
        }

        fs.renameSync(stagingDir, pluginDir);
        stagingDir = null;

        this.pluginStates[pluginId] = {
          ...previousState,
          installed: true,
          enabled: false,
          version: pluginVersion,
          installedAt: previousState.installedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        this.savePluginStates();

        if (shouldRestoreEnabledState) {
          await this.enablePlugin(pluginId);
        }

        // 清除更新失败标记
        this.failedUpdates.delete(pluginId);

        console.log('[plugin-service] 离线插件安装成功:', pluginId, pluginVersion);
        return {
          id: pluginId,
          name: pluginName,
          version: pluginVersion,
          previousVersion: previousManifest?.version || null,
          updated: Boolean(previousManifest),
          enabled: shouldRestoreEnabledState,
        };
      } finally {
        this.releasePluginOperation(pluginId, lock);
      }
    } catch (error) {
      console.error('[plugin-service] 离线安装插件失败:', error);
      throw error;
    } finally {
      if (stagingDir && fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * 卸载插件
   */
  async uninstallPlugin(pluginId, ownerToken) {
    const lock = this.acquirePluginOperation(pluginId, '卸载', ownerToken);
    try {
      // 先禁用
      if (this.plugins.has(pluginId)) {
        await this.disablePlugin(pluginId);
      }

      const pluginDir = path.join(this.getPluginsDir(), pluginId);
      this.clearPluginModuleCache(pluginDir);
      
      // 删除目录
      if (fs.existsSync(pluginDir)) {
        fs.rmSync(pluginDir, { recursive: true, force: true });
      }
      
      // 删除状态
      delete this.pluginStates[pluginId];
      this.savePluginStates();
      
      console.log('[plugin-service] 插件已卸载:', pluginId);
    } catch (error) {
      console.error('[plugin-service] 卸载插件失败:', error);
      throw error;
    } finally {
      this.releasePluginOperation(pluginId, lock);
    }
  }

  /**
   * 将配置变化通知给当前运行中的对应插件。
   */
  async notifyPluginConfigChange(pluginId, change) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin || typeof plugin.module.onConfigChange !== 'function') return;
    await plugin.module.onConfigChange(change);
  }

  /**
   * 向当前运行中的插件发送宿主事件（插件可选导出 onHostEvent 接收）。
   */
  async notifyPluginEvent(pluginId, event, payload) {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) {
      throw new Error('插件未启用');
    }
    if (typeof plugin.module.onHostEvent !== 'function') {
      throw new Error('插件不支持宿主事件');
    }
    await plugin.module.onHostEvent(event, payload);
  }

  /**
   * 启用插件
   */
  async enablePlugin(pluginId) {
    try {
      if (this.plugins.has(pluginId)) {
        return;
      }
      
      const pluginDir = path.join(this.getPluginsDir(), pluginId);
      const manifest = this.readManifest(pluginDir);
      
      if (!manifest) {
        throw new Error('插件 manifest 不存在');
      }
      
      // 检查是否有 main.cjs
      const mainPath = path.join(pluginDir, 'main.cjs');
      if (!fs.existsSync(mainPath)) {
        throw new Error('插件 main.cjs 不存在');
      }
      
      // 每次启用都从磁盘重新加载，避免停用后仍复用旧版 CommonJS 模块。
      this.clearPluginModuleCache(pluginDir);
      const pluginModule = require(mainPath);
      
      if (typeof pluginModule.activate !== 'function') {
        throw new Error('插件缺少 activate 方法');
      }
      
      // 创建上下文
      const context = createPluginContext(this.app, pluginId, this.services);
      
      // 激活插件
      await pluginModule.activate(context);
      
      // 保存插件实例
      this.plugins.set(pluginId, { module: pluginModule, context });
      
      // 更新状态
      this.pluginStates[pluginId] = {
        ...(this.pluginStates[pluginId] || {}),
        enabled: true,
      };
      this.savePluginStates();
      
      console.log('[plugin-service] 插件已启用:', pluginId);
    } catch (error) {
      console.error('[plugin-service] 启用插件失败:', error);
      throw error;
    }
  }

  /**
   * 禁用插件
   */
  async disablePlugin(pluginId) {
    try {
      const plugin = this.plugins.get(pluginId);
      if (plugin && typeof plugin.module.deactivate === 'function') {
        await plugin.module.deactivate();
      }
      
      this.plugins.delete(pluginId);
      
      // 更新状态
      if (this.pluginStates[pluginId]) {
        this.pluginStates[pluginId].enabled = false;
        this.savePluginStates();
      }
      
      console.log('[plugin-service] 插件已禁用:', pluginId);
    } catch (error) {
      console.error('[plugin-service] 禁用插件失败:', error);
      throw error;
    }
  }

  /**
   * 更新插件（删除重装）
   */
  async updatePlugin(pluginId) {
    const lock = this.acquirePluginOperation(pluginId, '更新');
    let stage = '读取插件状态';
    this.updatingPlugins.add(pluginId);
    this.failedUpdates.delete(pluginId);

    try {
      const wasEnabled = this.pluginStates[pluginId]?.enabled === true;

      // 升级前备份旧目录：卸载→安装非原子，安装失败时把旧版 rename 回来，
      // 避免"新版没装上、旧版也没了"两头空
      const pluginsDir = this.getPluginsDir();
      const pluginDir = path.join(pluginsDir, pluginId);
      const backupDir = `${pluginDir}.update-backup-${Date.now()}`;
      let backupCreated = false;
      if (fs.existsSync(pluginDir)) {
        fs.renameSync(pluginDir, backupDir);
        backupCreated = true;
      }

      stage = '卸载旧版本';
      await this.uninstallPlugin(pluginId, lock.token);

      try {
        stage = '下载并安装新版本';
        await this.installPlugin(pluginId, lock.token);
      } catch (installError) {
        // 安装失败：还原备份的旧版本目录，状态随 uninstall 清掉后按原启用态恢复
        if (backupCreated) {
          try {
            if (!fs.existsSync(pluginDir)) {
              fs.renameSync(backupDir, pluginDir);
              console.log('[plugin-service] 更新失败，已还原旧版本目录:', pluginId);
            }
          } catch (restoreError) {
            console.error('[plugin-service] 还原旧版本目录失败:', pluginId, restoreError);
          }
        }
        throw installError;
      }
      if (backupCreated && fs.existsSync(backupDir)) {
        try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch { /* 清理失败不影响升级成功 */ }
      }

      if (wasEnabled) {
        stage = '恢复插件启用状态';
        await this.enablePlugin(pluginId);
      }

      console.log('[plugin-service] 插件更新成功:', pluginId);
    } catch (error) {
      const message = error?.message || String(error);
      console.error(`[plugin-service] 更新插件失败，阶段：${stage}`, error);
      
      this.failedUpdates.set(pluginId, {
        stage,
        message,
        timestamp: Date.now(),
      });
      
      throw new Error(`更新阶段"${stage}"失败：${message}`);
    } finally {
      this.updatingPlugins.delete(pluginId);
      this.releasePluginOperation(pluginId, lock);
    }
  }

  /**
   * 刷新插件市场
   */
  async refreshMarket() {
    try {
      this.marketCache = [];
      this.marketCacheTime = 0;
      await this.fetchAvailablePlugins();
    } catch (error) {
      console.error('[plugin-service] 刷新市场失败:', error);
      throw error;
    }
  }
}

module.exports = new PluginService();
module.exports.comparePluginVersions = comparePluginVersions;
