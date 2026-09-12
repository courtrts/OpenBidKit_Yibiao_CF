const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const GITHUB_RELEASE_API = 'https://api.github.com/repos/FB208/OpenBidKit_Yibiao/releases/latest';
const GITHUB_RELEASE_DOWNLOAD_URL = 'https://github.com/FB208/OpenBidKit_Yibiao/releases/latest';
const GITHUB_PROVIDER_OPTIONS = {
  provider: 'github',
  owner: 'FB208',
  repo: 'OpenBidKit_Yibiao',
  releaseType: 'release',
};
const CLOUDFLARE_RELEASE_BASE_URL = 'https://pub-e7a765184e924c72a1dbe429d9bf181c.r2.dev/release';
const CLOUDFLARE_LATEST_JSON_URL = `${CLOUDFLARE_RELEASE_BASE_URL}/latest.json`;
const ATOMGIT_REPOSITORY_URL = 'https://atomgit.com/FB208/OpenBidKit_Yibiao';
const ATOMGIT_RELEASE_API_BASE_URL = 'https://api.atomgit.com/api/v5/repos/FB208/OpenBidKit_Yibiao/releases';
const ATOMGIT_LATEST_RELEASE_API = `${ATOMGIT_RELEASE_API_BASE_URL}/latest`;
// GitHub 校验源：按 tag 查询 Release 资产（API 对每个资产返回 sha256 digest）。
// AtomGit 附件 API 不返回 digest/size，默认渠道的安装包靠它做跨渠道交叉校验。
const GITHUB_TAG_RELEASE_API = 'https://api.github.com/repos/FB208/OpenBidKit_Yibiao/releases/tags/';

// 更新包允许出现的 host（含重定向目标）。按各渠道真实重定向链实测固定：
// GitHub 资产 github.com → release-assets.githubusercontent.com；
// AtomGit 附件 api.atomgit.com → file-cdn.gitcode.com（签名 CDN）；
// Cloudflare 渠道为 R2 公共桶域名。禁止 http: 与白名单外的重定向，防止劫持/篡改投递安装包。
const ALLOWED_UPDATE_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'atomgit.com',
  'api.atomgit.com',
  'file-cdn.gitcode.com',
  'pub-e7a765184e924c72a1dbe429d9bf181c.r2.dev',
]);

function assertAllowedUpdateUrl(rawUrl, label) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label}仅支持 https 地址`);
  }
  if (!ALLOWED_UPDATE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`${label}地址不在允许的更新源范围内`);
  }
  return parsed;
}

// 更新包字节上限：正常安装包约 100–280MB，1.5GB 远超任何合法版本。超限即中止，
// 防止被攻破/故障的源用无限流（含慢速滴流绕过空闲超时）写满用户磁盘——
// 与 pluginService 插件下载的 200MB 上限同款防御。
const MAX_UPDATE_INSTALLER_BYTES = 1536 * 1024 * 1024;
// 已知清单 size 时，实际字节数超出 size+64KB 即判定源数据异常，提前中止而不必写完全程
// 再靠事后 size 比对（原实现是"先写满再验"，写满前无法截停）。
const EXPECTED_SIZE_TOLERANCE_BYTES = 64 * 1024;

let autoUpdaterInstance = null;
let downloadedUpdateVersion = '';
let downloadedUpdateChannel = '';
let downloadedUpdateFilePath = '';
let activeUpdateCheckPromise = null;

// 下载临时文件命名固定以 ".tmp" 结尾（见 downloadFile 的 tempPath 构造）；
// updates 目录只由本服务写入，.tmp 文件不可能是合法成品。
function isUpdateTempFileName(name) {
  return /\.tmp$/i.test(String(name || ''));
}

// 新版本启动后删除已经安装或更旧的手动安装包，保留尚未安装的更新包。
function clearManualUpdateDownloads(app) {
  const updatesDir = path.join(app.getPath('userData'), 'updates');
  try {
    if (!fs.existsSync(updatesDir)) return;
    for (const entry of fs.readdirSync(updatesDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      // 下载被强杀/中断时残留的临时文件（<成品名>.<pid>.<ts>.tmp）永远是半成品，
      // 启动即清理，否则每次强杀都会泄漏上百 MB 磁盘空间。
      if (isUpdateTempFileName(entry.name)) {
        fs.rmSync(path.join(updatesDir, entry.name), { force: true });
        continue;
      }
      const match = /^Yibiao-(.+?)-(?:win-x64\.exe|mac-(?:x64|arm64)\.dmg)$/i.exec(entry.name);
      if (!match || compareVersions(match[1], app.getVersion()) > 0) continue;
      fs.rmSync(path.join(updatesDir, entry.name), { force: true });
    }
  } catch (error) {
    console.warn('[update] 清理旧更新安装包失败', error?.message || String(error));
  }
}

// 将版本号拆分为核心版本和 SemVer 预发布标识。
function parseVersion(value) {
  const normalized = String(value || '').trim().replace(/^v/i, '').split('+')[0];
  const separatorIndex = normalized.indexOf('-');
  const core = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
  const prerelease = separatorIndex === -1 ? [] : normalized.slice(separatorIndex + 1).split('.');
  return {
    core: core.split('.').map((part) => Number(part) || 0),
    prerelease,
  };
}

// 按 SemVer 规则比较单个预发布标识。
function comparePrereleaseIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a.localeCompare(b);
}

// 比较两个版本号，正式版高于相同核心版本的测试版。
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i += 1) {
    const na = pa.core[i] || 0;
    const nb = pb.core[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }

  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  for (let i = 0; i < Math.max(pa.prerelease.length, pb.prerelease.length); i += 1) {
    const partA = pa.prerelease[i];
    const partB = pb.prerelease[i];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    const result = comparePrereleaseIdentifier(partA, partB);
    if (result !== 0) return result;
  }
  return 0;
}

function normalizeUpdateChannel(value) {
  if (value === 'cloudflare' || value === 'atomgit') {
    return value;
  }
  return 'atomgit';
}

function getUpdateChannel(configStore) {
  if (!configStore) {
    return 'atomgit';
  }
  const config = configStore.load();
  return normalizeUpdateChannel(config.update_channel);
}

function requestJson(url, label, headers = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = assertAllowedUpdateUrl(url, `${label}请求`);
    } catch (error) {
      reject(error);
      return;
    }

    const request = https.get(parsed, { headers: { 'User-Agent': 'yibiao-client', ...headers } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        // 与 downloadFile 的 5 跳上限对齐：重定向环不再无限请求
        if (redirectCount >= 5) {
          reject(new Error(`${label}重定向次数过多`));
          return;
        }
        let nextParsed;
        try {
          nextParsed = assertAllowedUpdateUrl(new URL(response.headers.location, parsed).toString(), `${label}请求`);
        } catch (error) {
          reject(error);
          return;
        }
        requestJson(nextParsed.toString(), label, headers, redirectCount + 1).then(resolve, reject);
        return;
      }

      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`${label}请求失败：${response.statusCode}`));
          return;
        }

        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`解析${label}响应失败`));
        }
      });
    });
    request.on('error', (error) => reject(error));
    request.setTimeout(10000, () => {
      request.destroy();
      reject(new Error('请求超时'));
    });
  });
}

// 把 GitHub Release API 的原始响应规整为统一的 release 结构（含资产 sha256 digest）。
function createGithubReleaseInfo(release) {
  const files = Array.isArray(release.assets)
    ? release.assets.map((asset) => ({
      name: asset.name || '',
      url: asset.browser_download_url || '',
      size: Number(asset.size || 0),
      digest: asset.digest || '',
    }))
    : [];
  const downloadFile = pickPlatformDownloadFile(files);
  return {
    channel: 'github',
    version: release.tag_name?.replace(/^v/, '') || '',
    name: release.name || '',
    body: release.body || '',
    published_at: release.published_at || '',
    html_url: release.html_url || GITHUB_RELEASE_DOWNLOAD_URL,
    download_url: downloadFile?.url || GITHUB_RELEASE_DOWNLOAD_URL,
    files,
  };
}

async function fetchGithubLatestRelease() {
  const release = await requestJson(GITHUB_RELEASE_API, 'GitHub API ');
  return createGithubReleaseInfo(release);
}

// 按目标版本（已去除 v 前缀）取 GitHub 上对应 Release 的完整性元数据。
// 发布 tag 可能带 v 前缀也可能不带，两种形态各试一次；都取不到视为该版本不在校验源。
async function fetchGitHubReleaseByVersion(version) {
  const tag = String(version || '').trim();
  if (!tag) return null;
  let lastError = null;
  for (const candidate of [`v${tag}`, tag]) {
    try {
      const release = await requestJson(`${GITHUB_TAG_RELEASE_API}${encodeURIComponent(candidate)}`, 'GitHub 校验源 ');
      const info = createGithubReleaseInfo(release);
      if (info.version === tag) return info;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('GitHub 校验源未找到该版本');
}

// 测试注入口：替换 GitHub 校验源请求实现，避免单测触网；传 null 恢复真实实现。
let fetchGitHubReleaseByVersionImpl = fetchGitHubReleaseByVersion;
function setFetchGitHubReleaseForTest(impl) {
  fetchGitHubReleaseByVersionImpl = impl || fetchGitHubReleaseByVersion;
}

// 跨渠道完整性富化（best-effort）：目标渠道未提供 sha256 digest 时（AtomGit 附件 API
// 不返回 digest/size），到 GitHub 校验源按同名资产交叉取证，补齐 digest 与 size。
// 本函数永远返回可用的 release 对象（校验源不可达时原样返回、不抛错）；
// "缺 digest 是否允许下载"由 runManualInstallerUpdateCheck 的 fail-closed 门禁裁决。
async function attachGitHubIntegrityMetadata(release) {
  if (!release || release.channel === 'github') return release;
  const files = Array.isArray(release.files) ? release.files : [];
  const needsVerification = files.some((file) => file && !isValidSha256Digest(file.digest));
  if (!needsVerification) return release;
  let githubRelease;
  try {
    githubRelease = await fetchGitHubReleaseByVersionImpl(release.version);
  } catch (error) {
    console.warn('[update] 完整性校验源（GitHub）请求失败', error?.message || String(error));
    return release;
  }
  if (!githubRelease) return release;
  const githubFiles = Array.isArray(githubRelease.files) ? githubRelease.files : [];
  const enriched = files.map((file) => {
    if (!file || isValidSha256Digest(file.digest)) return file;
    const reference = githubFiles.find((candidate) => candidate && candidate.name === file.name);
    if (!reference || !isValidSha256Digest(reference.digest)) return file;
    return {
      ...file,
      digest: reference.digest,
      size: file.size > 0 ? file.size : Number(reference.size || 0),
    };
  });
  return { ...release, files: enriched };
}

function getMacUpdateArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

function pickMacDmgFile(files = []) {
  const validFiles = Array.isArray(files) ? files.filter((file) => file?.url && file?.name) : [];
  const arch = getMacUpdateArch();
  return validFiles.find((file) => new RegExp(`-mac-${arch}\\.dmg$`, 'i').test(file.name))
    || validFiles.find((file) => /-mac-(?:x64|arm64)\.dmg$/i.test(file.name))
    || validFiles.find((file) => /\.dmg$/i.test(file.name));
}

function pickPlatformDownloadFile(files = []) {
  const validFiles = Array.isArray(files) ? files.filter((file) => file?.url && file?.name) : [];
  if (process.platform === 'win32') {
    return validFiles.find((file) => /-win-x64\.exe$/i.test(file.name))
      || validFiles.find((file) => /-win-x64\.msi$/i.test(file.name))
      || validFiles.find((file) => /-win-x64\.zip$/i.test(file.name));
  }
  if (process.platform === 'darwin') {
    const arch = getMacUpdateArch();
    return pickMacDmgFile(validFiles)
      || validFiles.find((file) => new RegExp(`-mac-${arch}\\.zip$`, 'i').test(file.name))
      || validFiles.find((file) => /-mac-(?:x64|arm64)\.zip$/i.test(file.name));
  }
  return null;
}

// 选择下载后可直接启动的系统安装程序。
function pickPlatformInstallerFile(files = []) {
  const validFiles = Array.isArray(files) ? files.filter((file) => file?.url && file?.name) : [];
  if (process.platform === 'win32') {
    return validFiles.find((file) => /-win-x64\.exe$/i.test(file.name))
      || validFiles.find((file) => /-win-x64\.msi$/i.test(file.name));
  }
  if (process.platform === 'darwin') {
    return pickMacDmgFile(validFiles);
  }
  return null;
}

async function fetchCloudflareLatestRelease() {
  const release = await requestJson(CLOUDFLARE_LATEST_JSON_URL, 'Cloudflare 更新源 ');
  const files = Array.isArray(release.files)
    ? release.files.map((file) => ({
      name: file.name || '',
      url: file.url || '',
      size: Number(file.size || 0),
      contentType: file.contentType || '',
    }))
    : [];
  const downloadFile = pickPlatformDownloadFile(files);
  return {
    channel: 'cloudflare',
    version: String(release.version || release.tagName || '').replace(/^v/i, ''),
    name: release.name || release.tagName || '',
    body: release.body || '',
    published_at: release.generatedAt || '',
    html_url: CLOUDFLARE_RELEASE_BASE_URL,
    download_url: downloadFile?.url || CLOUDFLARE_RELEASE_BASE_URL,
    files,
  };
}

// 创建无需客户端令牌的 AtomGit Release 附件下载地址。
function createAtomGitAssetDownloadUrl(tagName, fileName) {
  return `${ATOMGIT_RELEASE_API_BASE_URL}/${encodeURIComponent(tagName)}/attach_files/${encodeURIComponent(fileName)}/download`;
}

// 获取 AtomGit 最新 Release 及可下载附件。
async function fetchAtomGitLatestRelease() {
  const release = await requestJson(ATOMGIT_LATEST_RELEASE_API, 'AtomGit API ');
  const tagName = String(release.tag_name || '');
  const files = Array.isArray(release.assets)
    ? release.assets.map((asset) => {
      const name = String(asset.name || '');
      return {
        name,
        url: tagName && name
          ? createAtomGitAssetDownloadUrl(tagName, name)
          : String(asset.browser_download_url || ''),
        size: Number(asset.size || 0),
      };
    })
    : [];
  const downloadFile = pickPlatformDownloadFile(files);
  return {
    channel: 'atomgit',
    version: tagName.replace(/^v/i, ''),
    name: release.name || tagName,
    body: release.body || '',
    published_at: release.created_at || '',
    html_url: ATOMGIT_REPOSITORY_URL,
    download_url: downloadFile?.url || ATOMGIT_REPOSITORY_URL,
    files,
  };
}

function fetchLatestRelease(channel) {
  if (channel === 'cloudflare') return fetchCloudflareLatestRelease();
  if (channel === 'atomgit') return fetchAtomGitLatestRelease();
  return fetchGithubLatestRelease();
}

async function getLatestVersion(options = {}) {
  const channel = getUpdateChannel(options.configStore);
  return fetchLatestRelease(channel);
}

async function getUpdateDownloadUrl(options = {}) {
  const channel = getUpdateChannel(options.configStore);
  if (channel === 'cloudflare') {
    try {
      const release = await fetchCloudflareLatestRelease();
      return release.download_url || CLOUDFLARE_RELEASE_BASE_URL;
    } catch (error) {
      console.warn('[update] Cloudflare 下载地址获取失败，回退到 GitHub Release', error);
      return GITHUB_RELEASE_DOWNLOAD_URL;
    }
  }
  if (channel === 'atomgit') {
    try {
      const release = await fetchAtomGitLatestRelease();
      return release.download_url || ATOMGIT_REPOSITORY_URL;
    } catch (error) {
      console.warn('[update] AtomGit 下载地址获取失败', error);
      return ATOMGIT_REPOSITORY_URL;
    }
  }
  return GITHUB_RELEASE_DOWNLOAD_URL;
}

function configureAutoUpdater(channel) {
  if (!autoUpdaterInstance) {
    return;
  }
  if (channel === 'cloudflare') {
    autoUpdaterInstance.setFeedURL({ provider: 'generic', url: CLOUDFLARE_RELEASE_BASE_URL });
    return;
  }
  autoUpdaterInstance.setFeedURL(GITHUB_PROVIDER_OPTIONS);
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

function setProgressBar(mainWindow, progress) {
  const target = typeof getMainWindow === 'function' ? (getMainWindow() || mainWindow) : mainWindow;
  mainWindow = target;
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.setProgressBar(progress);
}

function getDisabledResult() {
  return { enabled: false, updateAvailable: false };
}

function sanitizeDownloadFileName(fileName, fallback) {
  const normalized = String(fileName || '').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').trim();
  const baseName = path.basename(normalized);
  return baseName && baseName !== '.' && baseName !== '..' ? baseName : fallback;
}

function getManualUpdateDownloadPath(app, release, file) {
  const platformSuffix = process.platform === 'win32' ? 'win-x64.exe' : `mac-${getMacUpdateArch()}.dmg`;
  const fallbackName = `Yibiao-${release.version || 'update'}-${platformSuffix}`;
  const fileName = sanitizeDownloadFileName(file?.name, fallbackName);
  return path.join(app.getPath('userData'), 'updates', fileName);
}

function isDownloadedFileReady(filePath, expectedSize = 0) {
  if (!filePath) {
    return false;
  }
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0 && (!expectedSize || stat.size === expectedSize);
  } catch {
    return false;
  }
}

function requestModuleForUrl(url) {
  if (url.protocol === 'https:') return https;
  throw new Error(`不支持的下载地址协议：${url.protocol}`);
}

function downloadFile(url, destinationPath, options = {}, redirectCount = 0) {
  const { expectedSize = 0, onProgress } = options;
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = assertAllowedUpdateUrl(url, '更新包下载');
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let tempPath = '';
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (tempPath) {
        try { fs.rmSync(tempPath, { force: true }); } catch {}
      }
      reject(error);
    };

    let request;
    try {
      request = requestModuleForUrl(parsedUrl).get(parsedUrl, { headers: { 'User-Agent': 'yibiao-client' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirectCount >= 5) {
            fail(new Error('更新包下载重定向次数过多'));
            return;
          }
          let nextUrl;
          try {
            nextUrl = assertAllowedUpdateUrl(new URL(response.headers.location, parsedUrl).toString(), '更新包下载重定向');
          } catch (error) {
            fail(error);
            return;
          }
          downloadFile(nextUrl.toString(), destinationPath, options, redirectCount + 1)
            .then(resolve, reject);
          return;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          fail(new Error(`更新包下载失败：${response.statusCode}`));
          return;
        }

        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        tempPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
        const output = fs.createWriteStream(tempPath);
        const total = Number(response.headers['content-length'] || expectedSize || 0);
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          // 写入阶段截停：超安全上限或超清单 size 容差即中止，
          // 而不是等流写完再靠事后 size 比对（那时磁盘可能已被写满）。
          if (downloaded > MAX_UPDATE_INSTALLER_BYTES) {
            response.destroy(new Error('更新包大小超过安全上限，已中止下载'));
            return;
          }
          if (expectedSize > 0 && downloaded > expectedSize + EXPECTED_SIZE_TOLERANCE_BYTES) {
            response.destroy(new Error('更新包大小与清单不符，已中止下载'));
            return;
          }
          if (total > 0) {
            onProgress?.(Math.max(0, Math.min(100, (downloaded / total) * 100)));
          }
        });
        response.on('error', fail);
        output.on('error', fail);
        output.on('finish', () => {
          output.close(() => {
            try {
              fs.rmSync(destinationPath, { force: true });
              fs.renameSync(tempPath, destinationPath);
              tempPath = '';
              if (expectedSize && fs.statSync(destinationPath).size !== expectedSize) {
                throw new Error('更新包下载不完整，请重新检查更新');
              }
              onProgress?.(100);
              settled = true;
              resolve(destinationPath);
            } catch (error) {
              if (!tempPath) {
                try { fs.rmSync(destinationPath, { force: true }); } catch {}
              }
              fail(error);
            }
          });
        });

        response.pipe(output);
      });
    } catch (error) {
      fail(error);
      return;
    }

    request.on('error', fail);
    request.setTimeout(60000, () => {
      request.destroy(new Error('下载更新包超时'));
    });
  });
}

// 形如 "sha256:<64位hex>"（GitHub Release API 的 digest 字段形态，前缀可有可无、大小写不限）。
// 渠道自报或交叉校验取得的 digest 必须先过此校验，不合法即视为"无完整性信息"。
function isValidSha256Digest(value) {
  const hex = String(value || '').trim().replace(/^sha256:/i, '');
  return /^[a-f0-9]{64}$/i.test(hex);
}

// 用发布接口返回的 digest（形如 "sha256:xxx"）流式校验安装包完整性；无合法 digest 时不阻断
//（是否允许下载由 runManualInstallerUpdateCheck 的 fail-closed 门禁统一裁决）。
function verifyDownloadedDigest(filePath, expectedDigest) {
  return new Promise((resolve) => {
    if (!isValidSha256Digest(expectedDigest)) {
      resolve(true);
      return;
    }
    const hex = String(expectedDigest).trim().replace(/^sha256:/i, '').toLowerCase();
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(false));
    stream.on('end', () => {
      hash.end();
      resolve(hash.digest('hex') === hex);
    });
  });
}

// 下载可由系统直接启动的 Windows 或 macOS 更新安装包。
async function runManualInstallerUpdateCheck(options, release, channel) {
  const { app, mainWindow, onProgress, onDownloaded, onError } = options;
  const installerFile = pickPlatformInstallerFile(release.files);
  if (!installerFile) {
    const platformLabel = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : '当前系统';
    const message = `未找到适用于 ${platformLabel} 的更新安装包`;
    onError?.(message);
    return { enabled: true, updateAvailable: true, version: release.version, failed: true, message, channel };
  }

  // fail-closed 门禁：将要落盘的安装包必须携带合法 sha256（渠道自报或
  // attachGitHubIntegrityMetadata 从 GitHub 校验源交叉取证）。无校验的安装包
  // 是更新链路最直接的恶意投递通道，拒绝下载而不是"先下后验"。
  if (!isValidSha256Digest(installerFile.digest)) {
    const message = '更新包缺少完整性校验信息，已暂停本次更新，请稍后重试';
    onError?.(message);
    return { enabled: true, updateAvailable: true, version: release.version, failed: true, message, channel };
  }

  // fail-closed 门禁：将要落盘的安装包必须携带合法 sha256（渠道自报，或
  // attachGitHubIntegrityMetadata 从 GitHub 校验源按同名资产交叉取证而来）。
  // 无校验的安装包是更新链路最直接的恶意投递通道——拒绝下载而不是"先下后验"。
  if (!isValidSha256Digest(installerFile.digest)) {
    const message = '更新包缺少完整性校验信息，已暂停本次更新，请稍后重试';
    onError?.(message);
    return { enabled: true, updateAvailable: true, version: release.version, failed: true, message, channel };
  }

  const destinationPath = getManualUpdateDownloadPath(app, release, installerFile);
  const expectedSize = Number(installerFile.size || 0);

  try {
    // 已存在同版本安装包时先用 digest 复核，防篡改/防损坏残留（失败则删除重下）。
    let ready = isDownloadedFileReady(destinationPath, expectedSize);
    if (ready && installerFile.digest) {
      ready = await verifyDownloadedDigest(destinationPath, installerFile.digest);
      if (!ready) {
        try { fs.rmSync(destinationPath, { force: true }); } catch {}
      }
    }
    if (ready) {
      downloadedUpdateVersion = release.version;
      downloadedUpdateChannel = channel;
      downloadedUpdateFilePath = destinationPath;
      onDownloaded?.(release.version);
      return { enabled: true, updateAvailable: true, version: release.version, downloaded: true, channel };
    }

    setProgressBar(mainWindow, 0);
    await downloadFile(installerFile.url, destinationPath, {
      expectedSize,
      onProgress: (percent) => {
        setProgressBar(mainWindow, Math.max(0, Math.min(1, percent / 100)));
        onProgress?.(percent);
      },
    });
    // GitHub 渠道提供 sha256 digest：下载完成后比对，不符即删除并报完整性失败。
    if (installerFile.digest && !(await verifyDownloadedDigest(destinationPath, installerFile.digest))) {
      try { fs.rmSync(destinationPath, { force: true }); } catch {}
      throw new Error('更新包完整性校验失败，请重新检查更新');
    }

    downloadedUpdateVersion = release.version;
    downloadedUpdateChannel = channel;
    downloadedUpdateFilePath = destinationPath;
    setProgressBar(mainWindow, -1);
    onDownloaded?.(release.version);
    return { enabled: true, updateAvailable: true, version: release.version, downloaded: true, channel };
  } catch (error) {
    const message = formatErrorMessage(error);
    setProgressBar(mainWindow, -1);
    onError?.(message);
    return { enabled: true, updateAvailable: true, version: release.version, failed: true, message, channel };
  }
}

async function runUpdateCheck(options = {}) {
  const { app, mainWindow, onProgress, onDownloaded, onError } = options;
  const configuredChannel = getUpdateChannel(options.configStore);
  let channel = configuredChannel;
  let release;
  try {
    release = await fetchLatestRelease(channel);
  } catch (error) {
    // 非默认渠道源故障（如 Cloudflare R2 404）时回退默认渠道：
    // 否则选中该渠道的用户会永久收不到更新。默认渠道自身失败直接上抛原样报错。
    if (configuredChannel === 'atomgit') throw error;
    console.warn('[update] %s 渠道检查失败，回退到 atomgit', configuredChannel, error?.message || String(error));
    channel = 'atomgit';
    release = await fetchLatestRelease(channel);
  }
  if (!release.version || compareVersions(release.version, app.getVersion()) <= 0) {
    return { enabled: true, updateAvailable: false, channel };
  }
  // 与 electron-updater 渠道的 allowPrerelease=false 对齐：手动下载路径同样不推预发布版本。
  if (parseVersion(release.version).prerelease.length > 0) {
    return { enabled: true, updateAvailable: false, channel };
  }
  if (process.platform === 'darwin' || channel === 'atomgit') {
    const verifiedRelease = await attachGitHubIntegrityMetadata(release);
    return runManualInstallerUpdateCheck(options, verifiedRelease, channel);
  }
  configureAutoUpdater(channel);
  downloadedUpdateFilePath = '';
  if (!autoUpdaterInstance) {
    return { enabled: true, updateAvailable: false, failed: true, message: '自动更新未初始化', channel };
  }

  let downloadedVersion = release.version;
  let downloadedNotified = false;
  let errorNotified = false;
  const notifyError = (message) => {
    if (errorNotified) {
      return;
    }
    errorNotified = true;
    onError?.(message);
  };

  const handleProgress = (progress) => {
    const percent = Number(progress?.percent || 0);
    setProgressBar(mainWindow, Math.max(0, Math.min(1, percent / 100)));
    onProgress?.(percent);
  };

  const handleDownloaded = (info) => {
    downloadedVersion = info?.version || release.version;
    downloadedUpdateVersion = downloadedVersion;
    downloadedUpdateChannel = channel;
    downloadedUpdateFilePath = '';
    downloadedNotified = true;
    setProgressBar(mainWindow, -1);
    onDownloaded?.(downloadedVersion);
  };

  const handleError = (error) => {
    setProgressBar(mainWindow, -1);
    notifyError(formatErrorMessage(error));
  };

  autoUpdaterInstance.on('download-progress', handleProgress);
  autoUpdaterInstance.on('update-downloaded', handleDownloaded);
  autoUpdaterInstance.on('error', handleError);

  try {
    const result = await autoUpdaterInstance.checkForUpdates();
    if (!result) {
      throw new Error('未找到可下载的更新包');
    }

    await autoUpdaterInstance.downloadUpdate();
    downloadedUpdateVersion = downloadedVersion;
    downloadedUpdateChannel = channel;
    downloadedUpdateFilePath = '';
    setProgressBar(mainWindow, -1);
    if (!downloadedNotified) {
      onDownloaded?.(downloadedVersion);
    }
    return { enabled: true, updateAvailable: true, version: downloadedVersion, downloaded: true, channel };
  } catch (error) {
    const message = formatErrorMessage(error);
    notifyError(message);
    return { enabled: true, updateAvailable: true, version: release.version, failed: true, message, channel };
  } finally {
    autoUpdaterInstance.removeListener('download-progress', handleProgress);
    autoUpdaterInstance.removeListener('update-downloaded', handleDownloaded);
    autoUpdaterInstance.removeListener('error', handleError);
    setProgressBar(mainWindow, -1);
  }
}

async function checkAndDownloadUpdate(options = {}) {
  const { app } = options;
  const channel = getUpdateChannel(options.configStore);
  if (!app?.isPackaged) {
    return getDisabledResult();
  }
  if (process.platform !== 'darwin' && !autoUpdaterInstance) {
    return { enabled: true, updateAvailable: false, failed: true, message: '自动更新未初始化', channel };
  }
  if (downloadedUpdateVersion && downloadedUpdateChannel === channel) {
    const cachedFileReady = !downloadedUpdateFilePath || isDownloadedFileReady(downloadedUpdateFilePath);
    let hasNewerVersion = false;
    if (cachedFileReady) {
      // 缓存命中后仍做一次轻量版本探测：同一运行期间发布的新版本
      // （如紧急安全修复）不应被"已下载旧版"缓存遮蔽。
      // 探测失败（离线/渠道故障）时保留缓存结果，不阻断"已下载"状态。
      try {
        const latest = await fetchLatestRelease(channel);
        hasNewerVersion = Boolean(latest.version) && compareVersions(latest.version, downloadedUpdateVersion) > 0;
      } catch (error) {
        hasNewerVersion = false;
      }
    }
    if (cachedFileReady && !hasNewerVersion) {
      return { enabled: true, updateAvailable: true, version: downloadedUpdateVersion, downloaded: true, channel };
    }
    downloadedUpdateVersion = '';
    downloadedUpdateChannel = '';
    downloadedUpdateFilePath = '';
  }
  if (activeUpdateCheckPromise) {
    return activeUpdateCheckPromise;
  }

  activeUpdateCheckPromise = runUpdateCheck(options)
    .catch((error) => {
      const message = formatErrorMessage(error);
      options.onError?.(message);
      return { enabled: true, updateAvailable: false, failed: true, message, channel };
    })
    .finally(() => {
      activeUpdateCheckPromise = null;
    });
  return activeUpdateCheckPromise;
}

function triggerUpdateDownload(options) {
  return checkAndDownloadUpdate(options);
}

async function quitAndInstall(options = {}) {
  if (downloadedUpdateFilePath) {
    if (!isDownloadedFileReady(downloadedUpdateFilePath)) {
      return { success: false, message: '更新安装包尚未下载完成，请先检查更新' };
    }

    const { shell } = require('electron');
    const openError = await shell.openPath(downloadedUpdateFilePath);
    if (openError) {
      return { success: false, message: `打开更新安装包失败：${openError}` };
    }

    const { app } = options;
    setTimeout(() => {
      if (app?.quit) {
        app.quit();
      }
    }, 500);
    return { success: true };
  }

  if (autoUpdaterInstance && downloadedUpdateVersion) {
    autoUpdaterInstance.quitAndInstall(false, true);
    return { success: true };
  }

  return { success: false, message: '更新包尚未下载完成，请先检查更新' };
}

function setupAutoUpdate({ app, mainWindow, getMainWindow }) {
  if (!app.isPackaged) {
    return;
  }
  clearManualUpdateDownloads(app);
  if (process.platform === 'darwin') {
    return;
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdaterInstance = autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  configureAutoUpdater('github');

  autoUpdater.on('download-progress', (progress) => {
    const percent = Number(progress?.percent || 0);
    setProgressBar(mainWindow, Math.max(0, Math.min(1, percent / 100)));
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateVersion = info?.version || downloadedUpdateVersion;
    downloadedUpdateFilePath = '';
    setProgressBar(mainWindow, -1);
  });

  autoUpdater.on('error', (error) => {
    setProgressBar(mainWindow, -1);
    console.warn('自动更新检查失败', error);
  });
}

module.exports = {
  setupAutoUpdate,
  checkAndDownloadUpdate,
  triggerUpdateDownload,
  quitAndInstall,
  getLatestVersion,
  getUpdateDownloadUrl,
  // 供插件下载等其它下载链路复用：https + host 白名单校验
  assertAllowedUpdateUrl,
  __test: {
    compareVersions,
    parseVersion,
    sanitizeDownloadFileName,
    isDownloadedFileReady,
    isValidSha256Digest,
    isUpdateTempFileName,
    pickPlatformInstallerFile,
    attachGitHubIntegrityMetadata,
    setFetchGitHubReleaseForTest,
    MAX_UPDATE_INSTALLER_BYTES,
  },
};
