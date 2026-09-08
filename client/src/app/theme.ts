export type ThemeMode = 'light' | 'dark' | 'system';

const SYSTEM_DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

let systemMediaListener: ((event: MediaQueryListEvent) => void) | null = null;

function resolveEffectiveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') {
    return mode;
  }

  return typeof window.matchMedia === 'function' && window.matchMedia(SYSTEM_DARK_MEDIA_QUERY).matches
    ? 'dark'
    : 'light';
}

/**
 * 应用主题：更新 <html data-theme> 驱动 CSS 变量覆盖，并同步 Electron
 * 原生标题栏/系统控件配色。'system' 模式订阅系统配色变化实时跟随。
 */
export function applyThemeMode(mode: ThemeMode) {
  document.documentElement.dataset.theme = resolveEffectiveTheme(mode);

  if (systemMediaListener) {
    window.matchMedia(SYSTEM_DARK_MEDIA_QUERY).removeEventListener('change', systemMediaListener);
    systemMediaListener = null;
  }

  if (mode === 'system' && typeof window.matchMedia === 'function') {
    systemMediaListener = (event) => {
      document.documentElement.dataset.theme = event.matches ? 'dark' : 'light';
    };
    window.matchMedia(SYSTEM_DARK_MEDIA_QUERY).addEventListener('change', systemMediaListener);
  }

  void window.yibiao.ui.setNativeTheme(mode).catch(() => {
    // 非 Electron 环境（如纯浏览器预览）下没有原生主题可同步，忽略即可
  });
}
