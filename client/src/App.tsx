import { useCallback, useEffect, useRef, useState } from 'react';
import AppRouter from './app/AppRouter';
import GpuHardwareAccelerationPrompt from './app/GpuHardwareAccelerationPrompt';
import LicenseStatusPrompt from './app/LicenseStatusPrompt';
import RequiredOnlineServicesPrompt from './app/RequiredOnlineServicesPrompt';
import UpdateNotifier from './app/UpdateNotifier';
import AppShell from './components/AppShell';
import { trackAppOpen, trackConfigUsage, trackPageView } from './shared/analytics/analytics';
import type { SectionId } from './shared/types/navigation';

function isDeveloperSection(section: SectionId) {
  return section.startsWith('developer-');
}

function isManagedWorkbenchSection(section: SectionId) {
  return section === 'technical-plan' || section === 'existing-plan-expansion' || section === 'feasibility-report';
}

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('bid-generation');
  const [developerMode, setDeveloperMode] = useState(false);
  const leaveGuardRef = useRef<((nextSection?: string) => Promise<boolean>) | null>(null);

  useEffect(() => {
    trackAppOpen();

    void window.yibiao?.config.load()
      .then((config) => {
        setDeveloperMode(Boolean(config?.developer_mode));
        trackConfigUsage({}, config);
      })
      .catch((error) => console.warn('读取开发者模式失败', error));
  }, []);

  useEffect(() => {
    trackPageView(activeSection);
    if (isManagedWorkbenchSection(activeSection)) return;
    void window.yibiao?.ui?.setCurrentView({ section: activeSection });
  }, [activeSection]);

  useEffect(() => {
    if (!developerMode && isDeveloperSection(activeSection)) {
      setActiveSection('bid-generation');
    }
  }, [activeSection, developerMode]);

  // activeSectionRef 与 state 同步（developerMode 自动跳转直接 setState 的路径）
  useEffect(() => {
    activeSectionRef.current = activeSection;
  }, [activeSection]);

  // 引用终身稳定：内部经 ref 读取当前板块、经 leaveGuardRef 读取最新守卫，
  // 避免下游（BackgroundTaskTray 等）的订阅 effect 因 onSectionChange 引用
  // 变化而反复退订/重订。
  const activeSectionRef = useRef(activeSection);
  const requestSectionChange = useCallback(async (section: SectionId) => {
    if (section === activeSectionRef.current) {
      return;
    }
    const allowed = await (leaveGuardRef.current?.(section) ?? Promise.resolve(true));
    if (allowed) {
      activeSectionRef.current = section;
      setActiveSection(section);
    }
  }, []);
  const handleSectionChange = useCallback((section: SectionId) => {
    void requestSectionChange(section);
  }, [requestSectionChange]);

  return (
    <>
      <GpuHardwareAccelerationPrompt />
      <RequiredOnlineServicesPrompt />
      <UpdateNotifier noticeEnabled />
      <LicenseStatusPrompt />
      <AppShell
        activeSection={activeSection}
        developerMode={developerMode}
        onSectionChange={handleSectionChange}
      >
        <AppRouter
          activeSection={activeSection}
          developerMode={developerMode}
          onDeveloperModeChange={setDeveloperMode}
          onSectionChange={handleSectionChange}
          registerLeaveGuard={(guard) => {
            leaveGuardRef.current = guard;
          }}
        />
      </AppShell>
    </>
  );
}

export default App;
