import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AiHttpErrorPayload } from '../types';
import { useToast } from './ToastProvider';

function isHtmlPayload(error: AiHttpErrorPayload | null) {
  if (!error?.body) return false;
  const contentType = String(error.contentType || '').toLowerCase();
  if (contentType.includes('html')) return true;
  return /<!doctype\s+html|<html[\s>]/i.test(error.body);
}

function formatTitle(error: AiHttpErrorPayload | null) {
  if (!error?.status) return 'AI 服务商返回错误';
  return `AI 服务商返回 HTTP ${error.status}${error.statusText ? ` ${error.statusText}` : ''} 错误`;
}

// 按状态码给出"下一步怎么办"的人话建议：401/429/5xx 的处理方式完全不同，
// 只展示原始报错会让用户无从下手。
function getRecoveryAdvice(error: AiHttpErrorPayload | null): string {
  const status = Number(error?.status) || 0;
  if (status === 401 || status === 403) {
    return 'API Key 无效或无权限：请到"设置 → 文本模型"检查 API Key 是否正确、是否已过期。';
  }
  if (status === 402) {
    return '账户余额不足：请到服务商控制台充值或更换可用的模型服务。';
  }
  if (status === 404) {
    return '接口或模型不存在：请到"设置 → 文本模型"核对服务地址与模型名称。';
  }
  if (status === 429) {
    return '请求过于频繁或额度已用尽：请稍等几分钟重试，或到服务商控制台确认额度。';
  }
  if (status >= 500) {
    return '服务商暂时不可用：稍等片刻重试即可；若持续失败，可切换到其他模型服务。';
  }
  if (status >= 400) {
    return '请求被服务商拒绝：请核对模型配置是否正确，或稍后重试。';
  }
  return '网络请求未成功：请检查网络连接后重试。';
}

function formatSource(source?: string) {
  if (!source) return 'AI 服务';
  if (source === 'text-model') return '文本模型';
  if (source === 'google-image-model') return 'Google 生图模型';
  if (source === 'openai-compatible-image-model') return '生图模型';
  return source;
}

export function AiHttpErrorDialogProvider({ children }: { children: ReactNode }) {
  const [errors, setErrors] = useState<AiHttpErrorPayload[]>([]);
  const currentError = errors[0] || null;
  const { showToast } = useToast();
  const htmlPayload = useMemo(() => isHtmlPayload(currentError), [currentError]);

  useEffect(() => {
    const unsubscribe = window.yibiao?.ai?.onHttpError?.((event) => {
      setErrors((prev) => [...prev, { ...event, body: String(event.body || '') }]);
    });

    return () => unsubscribe?.();
  }, []);

  const closeCurrent = useCallback(() => {
    setErrors((prev) => prev.slice(1));
  }, []);

  const copyRawBody = useCallback(() => {
    const body = currentError?.body || '';
    if (!body) {
      showToast('当前错误没有原始返回内容', 'info');
      return;
    }

    void navigator.clipboard.writeText(body)
      .then(() => showToast('原始返回内容已复制', 'success'))
      .catch(() => showToast('复制失败，请手动选择内容复制', 'error'));
  }, [currentError?.body, showToast]);

  return (
    <>
      {children}
      <Dialog.Root open={Boolean(currentError)} onOpenChange={(open) => { if (!open) closeCurrent(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="ai-http-error-modal" />
          <Dialog.Content className="ai-http-error-card">
            <div className="ai-http-error-head">
              <div>
                <span>{formatSource(currentError?.source)}</span>
                <Dialog.Title>{formatTitle(currentError)}</Dialog.Title>
              </div>
              <Dialog.Close className="ai-http-error-close" type="button" aria-label="关闭错误详情">×</Dialog.Close>
            </div>
            <Dialog.Description className="ai-http-error-description">
              {getRecoveryAdvice(currentError)}
            </Dialog.Description>
            <div className="ai-http-error-meta">
              {currentError?.contentType && <span>原始返回：{currentError.contentType}</span>}
              {currentError?.createdAt && <span>{new Date(currentError.createdAt).toLocaleString('zh-CN')}</span>}
              {errors.length > 1 && <span>还有 {errors.length - 1} 个错误待查看</span>}
            </div>
            <div className="ai-http-error-preview">
              {htmlPayload ? (
                <iframe
                  title="AI 服务商原始错误页"
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={currentError?.body || ''}
                />
              ) : (
                <pre>{currentError?.body || '服务商未返回响应正文。'}</pre>
              )}
            </div>
            <div className="ai-http-error-actions">
              <button type="button" className="secondary-action" onClick={copyRawBody}>复制原始返回</button>
              <Dialog.Close type="button" className="primary-action">关闭</Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

export default AiHttpErrorDialogProvider;
