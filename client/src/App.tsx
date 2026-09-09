import { useCallback, useEffect, useRef, useState } from 'react';
import AppRouter from './app/AppRouter';
import GpuHardwareAccelerationPrompt from './app/GpuHardwareAccelerationPrompt';
import LicenseStatusPrompt from './app/LicenseStatusPrompt';
import RequiredOnlineServicesPrompt from './app/RequiredOnlineServicesPrompt';
import UpdateNotifier from './app/UpdateNotifier';
import AppShell from './components/AppShell';
import { trackAppOpen, trackConfigUsage, trackPageView } from './shared/analytics/analytics';
import { getSectionOrder } from './app/menuConfig';
import type { SectionId } from './shared/types/navigation';

function isDeveloperSection(section: SectionId) {
  return section.startsWith('developer-');
}

function isManagedWorkbenchSection(section: SectionId) {
  return section === 'technical-plan' || section === 'existing-plan-expansion' || section === 'feasibility-report';
}

const LAST_SECTION_STORAGE_KEY = 'yibiao:last-section';

// 启动时恢复上次工作板块：重开应用直接回到现场，省去"子菜单 → 工作流"的
// 重复导航；存储值不在当前菜单清单内（版本变化）时回退默认入口。
function readLastSection(developerMode: boolean): SectionId | null {
  try {
    const saved = localStorage.getItem(LAST_SECTION_STORAGE_KEY) as SectionId | null;
    if (!saved) return null;
    return getSectionOrder(developerMode).includes(saved) ? saved : null;
  } catch {
    return null;
  }
}

function App() {
  const [developerMode, setDeveloperMode] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>(() => 'bid-generation');
  const leaveGuardRef = useRef<((nextSection?: string) => Promise<boolean>) | null>(null);
  const restoreDoneRef = useRef(false);

  useEffect(() => {
    trackAppOpen();

    void window.yibiao?.config.load()
      .then((config) => {
        setDeveloperMode(Boolean(config?.developer_mode));
        trackConfigUsage({}, config);
        // 恢复上次工作板块（在 developerMode 已知后做清单校验，仅执行一次）
        if (restoreDoneRef.current) return;
        restoreDoneRef.current = true;
        const saved = readLastSection(Boolean(config?.developer_mode));
        if (saved && saved !== 'bid-generation') {
          setActiveSection(saved);
          activeSectionRef.current = saved;
        }
      })
      .catch((error) => console.warn('读取开发者模式失败', error));
  }, []);

  // 板块变化写入本地，供下次启动恢复
  useEffect(() => {
    try {
      localStorage.setItem(LAST_SECTION_STORAGE_KEY, activeSection);
    } catch {
      // 存储不可用时仅失去恢复能力
    }
  }, [activeSection]);

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
