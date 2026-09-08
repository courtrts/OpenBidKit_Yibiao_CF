import { getRequestClientIp } from '../utils.js';

function requireStatsDb(env) {
  if (!env.ANALYTICS_DB) throw new Error('ANALYTICS_DB is not configured');
  return env.ANALYTICS_DB;
}

// 读取 D1 中的全局封禁列表。
export async function listBlockedIps(env) {
  const result = await requireStatsDb(env).prepare(`
    SELECT ip, reason, created_at AS createdAt
    FROM ip_blocks
    ORDER BY created_at DESC, ip ASC
  `).all();
  return result.results || [];
}

// 封禁列表变更频率极低，但 isRequestIpBlocked 在每个非 /api 请求前都会执行；
// 进程内 60s 缓存把每请求一次的 D1 读收敛为每 isolate 每分钟一次（TTL 即生效延迟上限）。
const BLOCKED_IPS_CACHE_TTL_MS = 60000;
let blockedIpsCache = { at: 0, ips: [] };

async function loadBlockedIps(env) {
  const now = Date.now();
  if (now - blockedIpsCache.at < BLOCKED_IPS_CACHE_TTL_MS) {
    return blockedIpsCache.ips;
  }
  const result = await requireStatsDb(env).prepare('SELECT ip FROM ip_blocks').all();
  const ips = (result.results || []).map((row) => String(row.ip || '')).filter(Boolean);
  blockedIpsCache = { at: now, ips };
  return ips;
}

// 判断请求公网出口是否已被封禁；D1 异常时回退到上次缓存，仍不可用则保持公开服务可用。
export async function isRequestIpBlocked(env, request) {
  const clientIp = getRequestClientIp(request);
  if (!clientIp) return false;
  try {
    return (await loadBlockedIps(env)).includes(clientIp);
  } catch {
    return blockedIpsCache.ips.length > 0 && blockedIpsCache.ips.includes(clientIp);
  }
}
