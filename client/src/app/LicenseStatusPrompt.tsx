import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { OfflineLicenseActivationDialog } from '../shared/ui';
import type { LicenseRuntimeStatus } from '../shared/types';

const officialDownloadUrl = 'https://github.com/FB208/OpenBidKit_Yibiao';
// 周期性复核间隔：会话期间授权过期、时钟回拨（水位生效）后重新提醒
const RECHECK_INTERVAL_MS = 30 * 60 * 1000;

function getLicenseProblem(status: LicenseRuntimeStatus | null) {
  if (!status) return '';
  if (status.status === 'expired') return '授权已过期';
  if (status.status === 'missing' || status.status === 'refresh_failed') return '未检测到授权文件';
  if (status.status === 'invalid' || status.status === 'invalidated' || status.status === 'machine_mismatch') return '授权已失效';
  if (status.sourceTrusted === false) return '来源不可信';
  return '';
}

// 按问题类型给出可行动的提示；「下载可信客户端」仅对来源不可信成立
function getLicenseHint(status: LicenseRuntimeStatus | null) {
  if (!status) return '';
  if (status.status === 'expired') return '请续期授权，或使用下方离线激活授权。';
  if (status.status === 'missing' || status.status === 'refresh_failed') return '请检查网络后重试，或使用下方离线激活授权。';
  if (status.status === 'invalid' || status.status === 'invalidated' || status.status === 'machine_mismatch') return '请重新获取授权，或使用下方离线激活授权。';
  if (status.sourceTrusted === false) return '请从官方渠道下载可信客户端：';
  return '';
}

function shouldShowPrompt(status: LicenseRuntimeStatus | null) {
  if (!status || status.config?.expirePopupEnabled === false) {
    return false;
  }
  return Boolean(getLicenseProblem(status));
}

// 用户已确认过的问题签名：同一签名不重复弹窗；问题变化（过期/回拨等）才重新提醒
function problemSignature(status: LicenseRuntimeStatus | null) {
  if (!status) return '';
  return `${status.status}|${status.untrustedReason || ''}|${status.expiresAt || ''}`;
}

function LicenseStatusPrompt() {
  const [licenseStatus, setLicenseStatus] = useState<LicenseRuntimeStatus | null>(null);
  const [offlineLicenseDialogOpen, setOfflineLicenseDialogOpen] = useState(false);
  const dismissedSignatureRef = useRef('');

  useEffect(() => {
    let disposed = false;

    const checkLicense = async () => {
      try {
        const initialStatus = await window.yibiao?.license?.getStatus();
        if (disposed || !initialStatus) return;

        if (!shouldShowPrompt(initialStatus)) {
          setLicenseStatus((current) => (current && getLicenseProblem(current) ? null : current));
          return;
        }

        const refreshedStatus = await window.yibiao?.license?.refresh?.().catch(() => null);
        const finalStatus = refreshedStatus || initialStatus;
        if (disposed) return;
        if (shouldShowPrompt(finalStatus) && problemSignature(finalStatus) === dismissedSignatureRef.current) {
          return;
        }
        setLicenseStatus(shouldShowPrompt(finalStatus) ? finalStatus : null);
      } catch {
        // 授权提醒不能影响主流程。
      }
    };

    void checkLicense();
    const timer = window.setInterval(() => {
      void checkLicense();
    }, RECHECK_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const problem = getLicenseProblem(licenseStatus);
  const hint = getLicenseHint(licenseStatus);
  const showOfficialLink = licenseStatus?.sourceTrusted === false;
  const dismissible = licenseStatus?.config?.expirePopupDismissible !== false;
  const open = Boolean(problem);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && dismissible) {
          dismissedSignatureRef.current = problemSignature(licenseStatus);
          setLicenseStatus(null);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="content-regenerate-modal" />
        <Dialog.Content className="license-status-card" onEscapeKeyDown={(event) => !dismissible && event.preventDefault()} onPointerDownOutside={(event) => !dismissible && event.preventDefault()}>
          <Dialog.Title>客户端授权提醒</Dialog.Title>
          <Dialog.Description>
            当前客户端{problem}。{hint}
            {showOfficialLink && (
              <a href={officialDownloadUrl} target="_blank" rel="noreferrer">{officialDownloadUrl}</a>
            )}
          </Dialog.Description>
          <div className="license-status-actions">
            <button type="button" className="secondary-action" onClick={() => setOfflineLicenseDialogOpen(true)}>离线激活授权</button>
            {dismissible && (
              <button type="button" className="primary-action" onClick={() => {
                dismissedSignatureRef.current = problemSignature(licenseStatus);
                setLicenseStatus(null);
              }}>我知道了</button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
      <OfflineLicenseActivationDialog
        open={offlineLicenseDialogOpen}
        onOpenChange={setOfflineLicenseDialogOpen}
        onActivated={(status) => setLicenseStatus(shouldShowPrompt(status) ? status : null)}
      />
    </Dialog.Root>
  );
}

export default LicenseStatusPrompt;
