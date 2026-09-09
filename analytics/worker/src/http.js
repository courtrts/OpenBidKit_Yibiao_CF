export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export function json(data, init = {}) {
  return Response.json(data, {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init.headers || {}),
    },
  });
}

export function methodNotAllowed() {
  return json({ code: 405, message: 'method not allowed' }, { status: 405 });
}

export function unauthorized() {
  return json({ code: 401, message: 'unauthorized' }, { status: 401 });
}

// 双侧 SHA-256 后常数时间比较：管理端唯一鉴权门，避免逐字节短路比较的
// 计时侧信道；长度不同直接判否（不泄露长度信息，因哈希后长度恒定，此处
// 仅作快速失败优化，不影响安全性）。
function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

export function requireAdmin(request, env) {
  const token = String(env.ADMIN_TOKEN || '');
  const authorization = String(request.headers.get('Authorization') || '');
  if (!token) return false;
  return safeEqual(authorization, `Bearer ${token}`);
}

// handler 内部 catch 的对外 message 文案：仅显式带 statusCode 的业务错误
// （createPluginError 一类"有意可读"的校验/配置提示）放行其 message；
// D1/KV/AE 等内部异常（可能含 SQL 片段、表名、绑定名）一律回退固定文案，
// 完整错误只写 Worker 日志。safe() 统一返回 'internal error'，此函数供
// 自带 try/catch 的 handler 复用同一标准。
export function internalErrorMessage(error, fallback) {
  return Number(error?.statusCode) ? (error?.message || fallback) : fallback;
}

// 公开 POST 端点的请求体大小预检：大 body 的全量缓冲与 JSON.parse 是免费套餐
// 10ms CPU 预算下的无鉴权打点。声明长度缺失（chunked 传输无法廉价预检）时也拒绝，
// 由调用方对确有必要的端点自行放宽。
export function rejectOversizedBody(request, maxBytes) {
  const declaredLength = Number(request.headers.get('Content-Length') || '');
  if (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > maxBytes) {
    return json({ code: 413, message: 'payload too large' }, { status: 413 });
  }
  return null;
}

// 管理路由统一错误兜底：D1/KV/AE 异常时返回带 CORS 头的 JSON 500 并记录日志，
// 而不是不透明裸 500（dashboard 无法读取错误内容，排障也没有线索）。
// 鉴权（401）与参数校验（400）在 handler 内部先行处理，不受影响。
export function safe(handler) {
  return async (request, env, url) => {
    try {
      return await handler(request, env, url);
    } catch (error) {
      console.error('[analytics] admin handler error', error?.message || String(error));
      return json({ code: 500, message: 'internal error' }, { status: 500 });
    }
  };
}
