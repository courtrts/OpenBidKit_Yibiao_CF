import { useEffect, type ReactNode } from 'react';
import { AgentQuestionDialogProvider, AiHttpErrorDialogProvider, DocumentParseNoticeProvider, DonationPromptProvider, ToastProvider } from '../../shared/ui';
import { applyThemeMode, isThemeMode } from '../theme';

interface AppProvidersProps {
  children: ReactNode;
}

function AppProviders({ children }: AppProvidersProps) {
  useEffect(() => {
    let cancelled = false;
    window.yibiao.config
      .load()
      .then((config) => {
        if (!cancelled) {
          applyThemeMode(isThemeMode(config.theme_mode) ? config.theme_mode : 'light');
        }
      })
      .catch(() => {
        if (!cancelled) {
          applyThemeMode('light');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ToastProvider>
      <DonationPromptProvider>
        <AgentQuestionDialogProvider>
          <AiHttpErrorDialogProvider>
            <DocumentParseNoticeProvider>{children}</DocumentParseNoticeProvider>
          </AiHttpErrorDialogProvider>
        </AgentQuestionDialogProvider>
      </DonationPromptProvider>
    </ToastProvider>
  );
}

export default AppProviders;
