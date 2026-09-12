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

  // 客户端数两端口径已对齐（每个客户端按"最后使用的版本"归属，窗口 tab 取窗口内最后活跃版本、
  // 历史 tab 取全程最后活跃版本，封禁客户端两侧均排除），列合计可分别对上窗口/全程去重客户端数。
  renderTable(state.versionsTable, summary.versions || [], [
    { key: 'version', label: '版本', code: true },
    { key: 'count', label: range === 'history' ? '累计事件数' : '事件数' },
    { key: 'clients', label: range === 'history' ? '客户端数（最后活跃版本）' : '客户端数（窗口内最后活跃版本）' },
  ], '暂无版本数据');
}
