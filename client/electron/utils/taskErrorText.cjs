// 用户可见的任务错误文案：按错误码映射固定短句，其余消息剥离换行与绝对路径后截断，
// 避免把堆栈、供应商端点、内部文件细节直接展示到界面（原始细节仍走诊断上报通道）。
// 独立共享模块：任务框架（taskService）与非 agent 任务（如招标解析子项）复用同一归一化口径，
// 避免两侧循环引用。
const TASK_ERROR_TEXT_BY_CODE = new Map([
  ['AGENT_STALLED', '任务长时间无进展，已自动停止，请重新生成。'],
  ['AGENT_DISCONNECTED', '与 AI 服务的连接中断，请重新生成。'],
]);

function userFacingTaskError(error, fallback = '任务执行失败') {
  const code = String(error?.code || '');
  if (TASK_ERROR_TEXT_BY_CODE.has(code)) return TASK_ERROR_TEXT_BY_CODE.get(code);
  const message = String(error?.message || error || '').trim();
  if (!message) return fallback;
  const cleaned = message
    .replace(/[\r\n]+/g, ' ')
    .replace(/([A-Za-z]:[\\/]|\/(?:Users|home|tmp|var)\/)\S+/g, '[路径]')
    .trim();
  return (cleaned || fallback).slice(0, 200) || fallback;
}

module.exports = { userFacingTaskError };
