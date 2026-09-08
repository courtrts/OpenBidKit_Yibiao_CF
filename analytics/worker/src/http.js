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

export function requireAdmin(request, env) {
  const token = String(env.ADMIN_TOKEN || '');
  const authorization = request.headers.get('Authorization') || '';
  return Boolean(token) && authorization === `Bearer ${token}`;
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
