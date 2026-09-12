import { assertReady, buildRangeQuery, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { getPageLabel } from '../labels.js';
import { renderTable } from '../render.js';
import { state } from '../state.js';

export async function loadTraffic() {
  assertReady();
  await loadProjectOptions();
  saveSettings();

  const range = state.trafficRange.value;
  const { projectName } = getEncodedProjectAndDays();
  const summary = await requestJson(`/api/traffic?projectName=${projectName}&${buildRangeQuery(range)}`);
  const pages = (summary.pages || []).map((row) => ({
    ...row,
    pageLabel: getPageLabel(row.page),
  }));

  renderTable(state.pagesTable, pages, [
    { key: 'pageLabel', label: '功能名称' },
    { key: 'page', label: '路由', code: true },
    { key: 'count', label: range === 'history' ? '累计访问量' : '访问量' },
  ], '暂无页面访问数据');

  renderTable(state.versionsTable, summary.versions || [], [
    { key: 'version', label: '版本', code: true },
    { key: 'count', label: range === 'history' ? '累计事件数' : '事件数' },
    { key: 'clients', label: '客户端数' },
  ], '暂无版本数据');
}
