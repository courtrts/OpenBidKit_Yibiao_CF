import { useEffect } from 'react';

// 应用级键盘快捷键：全局 keydown 统一转换成 AppShortcutAction 事件，
// 页面自行订阅自己关心的动作。通过事件解耦，避免 AppShell 直接依赖各页面实现。

export type AppShortcutAction = 'save' | 'step-prev' | 'step-next';

const APP_SHORTCUT_EVENT = 'yibiao:app-shortcut';

export function dispatchAppShortcut(action: AppShortcutAction): void {
  window.dispatchEvent(new CustomEvent(APP_SHORTCUT_EVENT, { detail: { action } }));
}

export function onAppShortcut(listener: (action: AppShortcutAction) => void): () => void {
  const handler = (event: Event) => {
    const action = (event as CustomEvent<{ action?: AppShortcutAction }>).detail?.action;
    if (action) listener(action);
  };
  window.addEventListener(APP_SHORTCUT_EVENT, handler);
  return () => window.removeEventListener(APP_SHORTCUT_EVENT, handler);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export interface ShortcutHint {
  keys: string;
  description: string;
}

// 速记面板展示的快捷键清单；新增快捷键时同步维护这里。
export const SHORTCUT_HINTS: ShortcutHint[] = [
  { keys: 'Ctrl+S', description: '保存当前编辑中的内容' },
  { keys: 'Alt+←', description: '上一步' },
  { keys: 'Alt+→', description: '下一步' },
  { keys: '?', description: '打开快捷键速记面板' },
];

// 全局键盘分发：Ctrl/Cmd+S 保存、Alt+←/→ 切步、? 打开速记面板（非输入态）。
export function useGlobalShortcuts(onOpenCheatSheet: (open: boolean) => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && !event.shiftKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        dispatchAppShortcut('save');
        return;
      }
      if (event.altKey && !mod && !event.shiftKey && event.key === 'ArrowLeft') {
        event.preventDefault();
        dispatchAppShortcut('step-prev');
        return;
      }
      if (event.altKey && !mod && !event.shiftKey && event.key === 'ArrowRight') {
        event.preventDefault();
        dispatchAppShortcut('step-next');
        return;
      }
      if (event.key === '?' && !mod && !event.altKey && !isTypingTarget(event.target)) {
        event.preventDefault();
        onOpenCheatSheet(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onOpenCheatSheet]);
}
