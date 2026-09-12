import { assertReady, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { eventLabels, pageLabels } from '../labels.js';
import { renderTable, updateLatestPager } from '../render.js';
import { appState, state } from '../state.js';

const allowedEvents = ['app_open', 'page_view', 'config_usage', 'ai_request', 'resource_click', 'agent_runtime'];

function ensureEventOptions() {
  if (state.latestEventOptions.children.length) return;
  for (const event of allowedEvents) {
    const option = document.createElement('option');
    option.value = event;
    // 下拉展示中文标签，value 仍是事件码（与 /api/latest 的 event 参数口径一致）
    option.textContent = eventLabels[event] || event;
    state.latestEventOptions.appendChild(option);
  }
}

export async function loadLatest(options = {}) {
  if (options.resetLatestPage) {
    appState.latestPage = 1;
  }

  assertReady();
  await loadProjectOptions();
  saveSettings();
  ensureEventOptions();

  const { projectName } = getEncodedProjectAndDays();
  const event = state.latestEventFilter.value.trim();
  const eventQuery = event ? `&event=${encodeURIComponent(event)}` : '';
  const latest = await requestJson(`/api/latest?projectName=${projectName}&page=${appState.latestPage}${eventQuery}`);

  appState.latestTotal = Number(latest.total || 0);
  appState.latestPage = Number(latest.page || appState.latestPage);
  updateLatestPager();

  const events = (latest.events || [])
    .map((row) => ({
      ...row,
      // 未知事件/页面回退原始值，不丢排查信息
      eventLabel: eventLabels[row.event] || row.event || '-',
      pageLabel: pageLabels[row.page] || row.page || '-',
    }))
    .sort((left, right) => Date.parse(right.timestamp || '') - Date.parse(left.timestamp || ''));

  renderTable(state.latestTable, events, [
    { key: 'timestamp', label: '时间' },
    { key: 'eventLabel', label: '事件' },
    { key: 'pageLabel', label: '页面' },
    { key: 'version', label: '版本', code: true },
    { key: 'platform', label: '平台' },
    { key: 'arch', label: '架构' },
    { key: 'clientCreatedAt', label: '创建日期' },
    { key: 'clientId', label: '客户端ID', code: true },
  ], '暂无最近事件');
}
