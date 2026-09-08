import * as Tooltip from '@radix-ui/react-tooltip';
import { useCallback, useState } from 'react';
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
  const openShortcutHelp = useCallback((open: boolean) => setShortcutHelpOpen(open), []);
  useGlobalShortcuts(openShortcutHelp);

  return (
    <Tooltip.Provider delayDuration={120} skipDelayDuration={80}>
      <div className={`app-shell${isMac ? ' is-mac' : ''}`}>
        <Sidebar activeSection={activeSection} developerMode={developerMode} onSectionChange={onSectionChange} />

        <main className="main-area">
          <AgentRuntimeStatusBar />
          <section className="content-shell" aria-label="主内容">
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
