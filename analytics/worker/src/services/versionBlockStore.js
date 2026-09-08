function requireStatsDb(env) {
  if (!env.ANALYTICS_DB) throw new Error('ANALYTICS_DB is not configured');
  return env.ANALYTICS_DB;
}

// 读取指定项目的版本号封禁列表。
export async function listVersionBlocks(env, projectName) {
  const result = await requireStatsDb(env).prepare(`
    SELECT version, reason, created_at AS createdAt
    FROM version_blocks
    WHERE project_name = ?
    ORDER BY created_at DESC, version ASC
  `).bind(projectName).all();
  return result.results || [];
}

// 版本封禁判断在 /track 热路径上逐事件执行；与 ipBlockStore 同款 60s
// 进程内缓存把每事件一次 D1 读收敛为每 isolate 每项目每分钟一次。
const VERSION_BLOCKS_CACHE_TTL_MS = 60000;
const versionBlocksCache = new Map();

// 判断某项目的某个版本号（含空字符串）是否已被封禁；D1 异常时保持上报可用。
export async function isTrackVersionBlocked(env, projectName, version) {
  try {
    const now = Date.now();
    let entry = versionBlocksCache.get(projectName);
    if (!entry || now - entry.at >= VERSION_BLOCKS_CACHE_TTL_MS) {
      const result = await requireStatsDb(env).prepare(`
        SELECT version FROM version_blocks WHERE project_name = ?
      `).bind(projectName).all();
      entry = { at: now, versions: new Set((result.results || []).map((row) => String(row.version || ''))) };
      // projectName 来自公开请求且仅受格式约束，随机伪造值会让缓存无限增长；
      // 超上限时直接清空重建（TTL 内的少量重复读可接受）。
      if (versionBlocksCache.size >= 512) versionBlocksCache.clear();
      versionBlocksCache.set(projectName, entry);
    }
    return entry.versions.has(String(version ?? ''));
  } catch {
    return false;
  }
}

