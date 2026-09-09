// 侧边栏逻辑：宽屏折叠 / 窄屏抽屉
    (function () {
      const toggle = document.getElementById('sidebarToggle');
      const menuBtn = document.getElementById('topbarMenuButton');
      const overlay = document.getElementById('sidebarOverlay');
      const STORAGE_KEY = 'analytics_sidebar_collapsed';
      const NARROW = 900;

      function isNarrow() { return window.innerWidth <= NARROW; }

      // 宽屏：切换折叠
      function setCollapsed(collapsed) {
        document.body.classList.toggle('sidebar-collapsed', collapsed);
        try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); } catch (_) {}
      }

      // 窄屏：打开/关闭抽屉
      function setDrawerOpen(open) {
        document.body.classList.toggle('sidebar-drawer-open', open);
      }

      // 恢复宽屏折叠状态
      try {
        if (!isNarrow() && localStorage.getItem(STORAGE_KEY) === '1') {
          document.body.classList.add('sidebar-collapsed');
        }
      } catch (_) {}

      toggle.addEventListener('click', function () {
        if (isNarrow()) {
          setDrawerOpen(false);
        } else {
          setCollapsed(!document.body.classList.contains('sidebar-collapsed'));
        }
      });

      menuBtn && menuBtn.addEventListener('click', function () {
        setDrawerOpen(true);
      });

      overlay.addEventListener('click', function () {
        setDrawerOpen(false);
      });

      // 窗口调整时清理抽屉状态
      window.addEventListener('resize', function () {
        if (!isNarrow()) {
          setDrawerOpen(false);
        }
      });
    })();

// 原 inline onclick 迁移（配合 CSP script-src 'self'）
(function () {
  const reloadButton = document.getElementById('loadPluginsButton');
  reloadButton && reloadButton.addEventListener('click', function () {
    window.location.reload();
  });

  const newPluginButton = document.getElementById('newPluginButton');
  newPluginButton && newPluginButton.addEventListener('click', function () {
    const form = document.getElementById('pluginForm');
    form && form.scrollIntoView({ behavior: 'smooth' });
  });
})();
