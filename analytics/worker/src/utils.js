import { PROJECT_NAME_PATTERN } from './constants.js';

const BUSINESS_TIME_ZONE = 'Asia/Shanghai';

export function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

export function normalizeMetricValue(value, maxLength) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return normalizeText(value, maxLength);
}

// 规范化单个 IPv4 或 IPv6 地址，拒绝网段和地址列表。
export function normalizeIpAddress(value) {
  const text = normalizeText(value, 80).replace(/^\[|\]$/g, '').toLowerCase();
  if (!text || /[\s,/]/.test(text)) return '';

  const ipv4Parts = text.split('.');
  if (ipv4Parts.length === 4 && ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return ipv4Parts.map((part) => String(Number(part))).join('.');
  }

  if (!text.includes(':')) return '';
  try {
    const hostname = new URL(`http://[${text}]/`).hostname;
    return hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

// 读取 Cloudflare 观测到的真实公网出口 IP。
export function getRequestClientIp(request) {
  const connectingIp = normalizeIpAddress(request?.headers?.get('CF-Connecting-IP'));
  const connectingIpv6 = normalizeIpAddress(request?.headers?.get('CF-Connecting-IPv6'));
  const firstOctet = Number(connectingIp.split('.')[0]);
  return connectingIp.includes('.') && firstOctet >= 240 && firstOctet <= 255
    ? connectingIpv6
    : connectingIp;
}

export function isValidProjectName(projectName) {
  return PROJECT_NAME_PATTERN.test(projectName);
}

export function safeDays(value) {
  const days = Number(value || 30);
  if (!Number.isFinite(days)) return 30;
  return Math.max(1, Math.min(Math.floor(days), 90));
}

export function safeStatsRange(value, defaultRange = 'history') {
  const range = normalizeText(value, 20);
  if (['history', 'today', '7', '30'].includes(range)) {
    return range;
  }
  return defaultRange;
}

export function safePage(value) {
  const page = Number(value || 1);
  if (!Number.isFinite(page)) return 1;
  // 上限 clamp：深分页的 OFFSET 会线性放大 AE 扫描量，正常使用远达不到
  return Math.min(1000, Math.max(1, Math.floor(page)));
}

export function addIsoDays(value, days) {
  const date = new Date(`${String(value || '').slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';

  date.setUTCDate(date.getUTCDate() + days);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addBusinessDateDays(value, days) {
  return addIsoDays(value, days);
}

export function datePart(value) {
  return String(value || '').slice(0, 10);
}

export function getBusinessDateDaysAgo(days = 0, baseDate = new Date()) {
  const date = new Date(baseDate.getTime() - Math.max(0, Number(days || 0)) * 86400000);
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getBusinessToday(baseDate = new Date()) {
  return getBusinessDateDaysAgo(0, baseDate);
}

export function formatBusinessDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

export function businessDateSqlExpression(value = 'timestamp') {
  return `formatDateTime(${value}, '%Y-%m-%d', '${BUSINESS_TIME_ZONE}')`;
}

export function businessDateTimeSqlExpression(value = 'timestamp') {
  return `formatDateTime(${value}, '%Y-%m-%d %H:%i:%S', '${BUSINESS_TIME_ZONE}')`;
}

// 北京时间（UTC+8，无夏令时）业务日 → 原生 timestamp 边界（UTC 墙钟串交给
// toDateTime(..., 'UTC') 解析）。业务日 D 的范围是 [D-1 16:00, D+1 16:00) UTC。
// 对 formatDateTime 计算列的比较无法触发 AE 分区裁剪，原生边界让扫描真正收敛；
// 语义与计算列条件完全等价（叠加使用是收紧不是改变）。
export function businessDateUtcBoundsCondition(startDate, endDate) {
  const startMs = Date.parse(`${datePart(startDate)}T00:00:00Z`);
  const endMs = Date.parse(`${datePart(endDate)}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return '';
  const lower = new Date(startMs - 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const upper = new Date(endMs + 16 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  return `timestamp >= toDateTime(${sqlString(lower)}, 'UTC') AND timestamp < toDateTime(${sqlString(upper)}, 'UTC')`;
}

export function businessDateRangeCondition(startDate, endDate = getBusinessToday()) {
  const dateExpr = businessDateSqlExpression();
  const nativeBounds = businessDateUtcBoundsCondition(startDate, endDate);
  const nativeCondition = nativeBounds ? ` AND ${nativeBounds}` : '';
  return `${dateExpr} >= ${sqlString(startDate)} AND ${dateExpr} <= ${sqlString(endDate)}${nativeCondition}`;
}

export function logQueryError(scope, error) {
  console.error(`[analytics] ${scope} query failed`, error?.message || String(error));
}

// 公开计数端点的进程内去重：同键 60s 内重复提交只写一次 D1。
// 免费档 D1 写配额有限，无鉴权写端点被脚本刷计数会拖累 /track 与汇总链路；
// isolate 级去重不跨实例，但已把单实例内的重复写压掉绝大部分。
const RECENT_WRITE_TTL_MS = 60000;
const RECENT_WRITE_MAX_KEYS = 512;
const recentWriteKeys = new Map();

export function shouldSkipDuplicateWrite(key) {
  const now = Date.now();
  const last = recentWriteKeys.get(key);
  if (last !== undefined && now - last < RECENT_WRITE_TTL_MS) return true;
  recentWriteKeys.set(key, now);
  if (recentWriteKeys.size > RECENT_WRITE_MAX_KEYS) {
    for (const [mapKey, at] of recentWriteKeys) {
      if (now - at >= RECENT_WRITE_TTL_MS) recentWriteKeys.delete(mapKey);
    }
  }
  return false;
}

export function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// 统一 fetch 超时：Analytics Engine / models.dev / GitHub 等外部请求没有超时时
// 可能无限挂起，占满调用墙钟预算且无日志。超时经 AbortController 中断后按普通
// 错误抛出（fetch 抛 AbortError），由调用方既有的重试/错误处理链路接管。
export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 与 formatBusinessDateTime 完全同语义，保留导出名以兼容既有调用方。
export const formatNoticeTime = formatBusinessDateTime;
