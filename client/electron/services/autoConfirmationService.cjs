const AUTO_CONFIRMATION_DELAY_MS = 8_000;

// 管理所有待确认项的自动提交计时，不理解具体选项和业务内容。
function createAutoConfirmationService({ configStore, delayMs = AUTO_CONFIRMATION_DELAY_MS }) {
  const entries = new Map();
  const listeners = new Set();

  // 读取全局自动确认开关。
  function getState() {
    return { enabled: Boolean(configStore.load().agent_auto_answer_enabled) };
  }

  // 向确认项所属业务同步当前截止时间。
  function notifyEntry(entry) {
    try {
      entry.onStateChange?.({ auto_answer_at: entry.autoAnswerAt || undefined });
    } catch {}
  }

  // 清理指定确认项当前正在运行的计时器。
  function clearTimer(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.autoAnswerAt = '';
  }

  // 根据全局配置和当前确认项状态重新安排计时。
  function refreshEntry(entry) {
    clearTimer(entry);
    if (getState().enabled && !entry.suppressed) {
      entry.autoAnswerAt = new Date(Date.now() + delayMs).toISOString();
      entry.timer = setTimeout(() => {
        if (entries.get(entry.id) !== entry) return;
        entry.timer = null;
        entry.autoAnswerAt = '';
        notifyEntry(entry);
        void Promise.resolve().then(() => entry.submit()).catch((error) => {
          // 自动提交失败不得静默：把失败位同步给所属业务，由其提示用户手动提交。
          if (entries.get(entry.id) !== entry) return;
          console.error('[auto-confirmation] 自动提交失败', error?.message || String(error));
          try { entry.onSubmitError?.(error); } catch {}
          try { entry.onStateChange?.({ auto_answer_at: undefined, auto_submit_failed: true }); } catch {}
        });
      }, delayMs);
    }
    notifyEntry(entry);
  }

  // 注册一个由业务提供默认提交行为的待确认项。
  function register({ id, submit, onStateChange, onSubmitError }) {
    unregister(id);
    const entry = {
      id,
      submit,
      onStateChange,
      onSubmitError,
      timer: null,
      autoAnswerAt: '',
      suppressed: false,
    };
    entries.set(id, entry);
    refreshEntry(entry);
    return () => unregister(id);
  }

  // 用户修改当前选择后，停止该确认项本轮自动提交。
  function suppress(id) {
    const entry = entries.get(id);
    if (!entry || entry.suppressed) return;
    entry.suppressed = true;
    clearTimer(entry);
    notifyEntry(entry);
  }

  // 确认项完成或失效后移除其计时状态。
  function unregister(id) {
    const entry = entries.get(id);
    if (!entry) return;
    clearTimer(entry);
    entries.delete(id);
  }

  // 配置被其他保存入口修改时同步所有待确认项。
  function handleConfigChanged(nextConfig = {}, previousConfig = {}) {
    if (Boolean(nextConfig.agent_auto_answer_enabled) === Boolean(previousConfig.agent_auto_answer_enabled)) return;
    const state = getState();
    entries.forEach((entry) => refreshEntry(entry));
    listeners.forEach((listener) => {
      try { listener(state); } catch {}
    });
  }

  // 保存全局开关，并立即更新尚未被用户操作暂停的确认项。
  function setEnabled(enabled) {
    const previousEnabled = getState().enabled;
    const result = configStore.save({ agent_auto_answer_enabled: Boolean(enabled) });
    const state = getState();
    handleConfigChanged(
      { agent_auto_answer_enabled: state.enabled },
      { agent_auto_answer_enabled: previousEnabled },
    );
    return { ...result, ...state };
  }

  // 订阅全局自动确认开关变化。
  function onChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // 关闭服务并清理所有未完成计时。
  function close() {
    entries.forEach((entry) => clearTimer(entry));
    entries.clear();
    listeners.clear();
  }

  return {
    getState,
    setEnabled,
    handleConfigChanged,
    onChanged,
    register,
    suppress,
    unregister,
    close,
  };
}

module.exports = {
  createAutoConfirmationService,
};
