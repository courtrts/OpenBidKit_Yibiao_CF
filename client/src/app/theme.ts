export type ThemeMode = 'light' | 'dark' | 'system';

const SYSTEM_DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

let systemMediaListener: ((event: MediaQueryListEvent) => void) | null = null;

// matchMedia() 每次调用都返回新实例：用新建实例加的监听器无法通过另一个新实例移除。
// 模块级复用同一 MediaQueryList，否则每次切主题都会残留一个永不移除的监听器。
const systemDarkQuery = typeof window.matchMedia === 'function' ? window.matchMedia(SYSTEM_DARK_MEDIA_QUERY) : null;

function resolveEffectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') {
    return mode;
  }

  return systemDarkQuery?.matches ? 'dark' : 'light';
}

/**
 * 应用主题：更新 <html data-theme> 驱动 CSS 变量覆盖，并同步 Electron
 * 原生标题栏/系统控件配色。'system' 模式订阅系统配色变化实时跟随。
 */
export function applyThemeMode(mode: ThemeMode) {
  document.documentElement.dataset.theme = resolveEffectiveTheme(mode);

  if (systemMediaListener) {
    systemDarkQuery?.removeEventListener('change', systemMediaListener);
    systemMediaListener = null;
  }

  if (mode === 'system' && systemDarkQuery) {
    systemMediaListener = (event) => {
      document.documentElement.dataset.theme = event.matches ? 'dark' : 'light';
    };
    systemDarkQuery.addEventListener('change', systemMediaListener);
  }

  void window.yibiao.ui.setNativeTheme(mode).catch(() => {
    // 非 Electron 环境（如纯浏览器预览）下没有原生主题可同步，忽略即可
  });
}
