import * as Tooltip from '@radix-ui/react-tooltip';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import AgentRuntimeStatusBar from '../app/AgentRuntimeStatusBar';
import BackgroundTaskTray from '../app/BackgroundTaskTray';
import AppDialog from '../shared/ui/AppDialog';
import { SHORTCUT_HINTS, useGlobalShortcuts } from '../shared/shortcuts/appShortcuts';
import type { SectionId } from '../shared/types/navigation';
import Sidebar from './Sidebar';

interface AppShellProps {
  activeSection: SectionId;
  children: ReactNode;
  developerMode: boolean;
  onSectionChange: (section: SectionId) => void;
}

function AppShell({ activeSection, children, developerMode, onSectionChange }: AppShellProps) {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [modelBannerDismissed, setModelBannerDismissed] = useState(false);
  const openShortcutHelp = useCallback((open: boolean) => setShortcutHelpOpen(open), []);
  useGlobalShortcuts(openShortcutHelp);

  // 首用引导：文本模型未配置时在内容区顶部给出常驻提示条（可关闭，
  // 关闭状态记忆在本标签页会话内）。配置完成后自动消失。
  useEffect(() => {
    let cancelled = false;
    try {
      if (sessionStorage.getItem('yibiao-model-banner-dismissed') === '1') {
        setModelBannerDismissed(true);
      }
    } catch {
      // sessionStorage 不可用时仅失去记忆能力，不影响展示
    }
    window.yibiao?.config.load()
      .then((config) => {
        if (cancelled) return;
        // 文本模型字段平铺在 ClientConfig 上（extends TextModelConfig）；
        // 直接 api_key 或任一 profile 已配置即视为就绪
        const profileReady = Object.values(config?.text_model_profiles || {})
          .some((profile) => Boolean(profile?.api_key));
        setModelReady(Boolean(config?.api_key) || profileReady);
      })
      .catch(() => setModelReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissModelBanner = useCallback(() => {
    setModelBannerDismissed(true);
    try {
      sessionStorage.setItem('yibiao-model-banner-dismissed', '1');
    } catch {
      // 忽略存储失败
    }
  }, []);

  // 侧边栏"快捷键"按钮经事件唤醒同一面板（让速记能力对不知道 ? 键的用户可见）
  useEffect(() => {
    const open = () => setShortcutHelpOpen(true);
    window.addEventListener('yibiao:open-shortcuts', open);
    return () => window.removeEventListener('yibiao:open-shortcuts', open);
  }, []);

  return (
    <Tooltip.Provider delayDuration={120} skipDelayDuration={80}>
      <div className={`app-shell${isMac ? ' is-mac' : ''}`}>
        <Sidebar activeSection={activeSection} developerMode={developerMode} onSectionChange={onSectionChange} />

        <main className="main-area">
          <AgentRuntimeStatusBar />
          <section className="content-shell" aria-label="主内容">
            {modelReady === false && !modelBannerDismissed && (
              <div className="model-ready-banner" role="status">
                <span>
                  <strong>尚未配置文本模型</strong>
                  解析与生成功能需要先在设置中填写模型服务地址与 API Key。
                </span>
                <span className="model-ready-banner-actions">
                  <button
                  type="button"
                  className="primary-action"
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('yibiao:open-settings-tab', { detail: { tab: 'text-model' } }));
                    onSectionChange('settings');
                  }}
                >
                  前往设置
                </button>
                  <button type="button" className="secondary-action" onClick={dismissModelBanner}>先随便看看</button>
                </span>
              </div>
            )}
            {children}
          </section>
          <BackgroundTaskTray onSectionChange={onSectionChange} />
        </main>
      </div>

      <AppDialog
        open={shortcutHelpOpen}
        onOpenChange={setShortcutHelpOpen}
        kicker="键盘快捷键"
        title="快捷键速记"
        description="在任意页面都可使用，减少来回切换鼠标的次数。"
        actions={(
          <button type="button" className="primary-action" onClick={() => setShortcutHelpOpen(false)}>知道了</button>
        )}
      >
        <ul className="shortcut-help-list">
          {SHORTCUT_HINTS.map((hint) => (
            <li key={hint.keys}>
              <kbd>{hint.keys}</kbd>
              <span>{hint.description}</span>
            </li>
          ))}
        </ul>
      </AppDialog>
    </Tooltip.Provider>
  );
}

export default AppShell;
