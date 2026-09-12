import { corsHeaders, json, methodNotAllowed, rejectOversizedBody } from '../http.js';
import { VERSION_FORMAT_PATTERN } from '../constants.js';
import {
  normalizeTrackBody,
  validateTrackEvent,
  writeAnalyticsDataPoint,
} from '../services/analyticsTrack.js';
import { recordTrackClient } from '../services/analyticsStatsStore.js';
import { isTrackVersionBlocked } from '../services/versionBlockStore.js';
import { isValidProjectName } from '../utils.js';

export async function handleTrack(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  // 埋点事件体积很小；超大 body 的全量缓冲 + JSON.parse 是 10ms CPU 预算下的无鉴权打点。
  // 与其他公开 POST 端点同口径用 rejectOversizedBody：声明长度缺失（chunked 传输）也拒绝，
  // 原"头缺失时放行"正是可携带数 MB 合法 JSON 的 CPU 打点绕过口。
  const oversized = rejectOversizedBody(request, 4096);
  if (oversized) return oversized;

  let body;
  try {
    // 垃圾/截断 body 的解析失败属客户端错误：与其他 POST 端点同口径返回 400，
    // 不落入 500 污染错误率监控。
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid json body' }, { status: 400 });
  }
  // JSON null/裸值同属客户端错误：null 进入 normalizeTrackBody 会解引用抛错落入 500 兜底。
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json({ code: 400, message: 'invalid json body' }, { status: 400 });
  }

  try {
    const event = normalizeTrackBody(body, request);
    if (!VERSION_FORMAT_PATTERN.test(event.version)) {
      // 版本号格式不合法（含空版本号）：静默丢弃，不触发当天客户端数据清理。
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (isValidProjectName(event.projectName) && await isTrackVersionBlocked(env, event.projectName, event.version)) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const validationError = validateTrackEvent(event);
    if (validationError) {
      return json({ code: 400, message: validationError }, { status: 400 });
    }

    writeAnalyticsDataPoint(env, event);
    try {
      await recordTrackClient(env, event);
    } catch (error) {
      console.warn('[analytics] realtime client record failed', error?.message || String(error));
    }

    return json({ code: 0 });
  } catch (error) {
    console.error('[analytics] track failed', error?.message || String(error));
    return json({ code: 500, message: 'internal error' }, { status: 500 });
  }
}
