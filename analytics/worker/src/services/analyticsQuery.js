import { fetchWithTimeout } from '../utils.js';

const retryableStatuses = new Set([429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export async function queryAnalytics(env, sql) {
  if (!env.ACCOUNT_ID || !env.ANALYTICS_API_TOKEN) {
    throw new Error('missing analytics api config');
  }

  const api = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/analytics_engine/sql`;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetchWithTimeout(api, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ANALYTICS_API_TOKEN}`,
      },
      body: sql,
    }, 8000);
    const text = await response.text();

    if (response.ok) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`Analytics Engine query returned invalid JSON: ${error?.message || String(error)}; sql=${compactSql(sql)}`);
      }
      // AE 存在"HTTP 200 但 success:false / errors 非空"的失败形态（配额、内部部分失败）。
      // 不在此拦截，下游一律 `data || []` 会把查询失败静默退化成"暂无数据 / 0"，
      // 运营会把失败误读为当天无流量。失败摘要只进 worker 日志，对外仍由各路由固定文案兜底。
      if (parsed && typeof parsed === 'object' && (parsed.success === false || (Array.isArray(parsed.errors) && parsed.errors.length > 0))) {
        const detail = JSON.stringify(parsed.errors || parsed).slice(0, 300);
        throw new Error(`Analytics Engine query reported failure: ${detail}; sql=${compactSql(sql)}`);
      }
      return parsed;
    }

    const retryable = retryableStatuses.has(response.status) && attempt < 4;
    const message = `Analytics Engine query failed: status=${response.status}; attempt=${attempt}; body=${text.slice(0, 1000)}; sql=${compactSql(sql)}`;
    if (!retryable) {
      throw new Error(message);
    }

    console.warn(`[analytics] ${message}; retrying`);
    // 固定间隔会让同批并发查询在同一时刻同步重试（惊群），在 AE 限流时自我恶化，
    // 乘以 0.5–1.5 随机系数打散重试时刻。
    await sleep(500 * attempt * (0.5 + Math.random()));
  }

  throw new Error(`Analytics Engine query failed after retries; sql=${compactSql(sql)}`);
}
