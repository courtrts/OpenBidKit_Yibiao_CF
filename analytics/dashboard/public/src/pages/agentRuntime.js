import { assertReady, buildRangeQuery, getEncodedProjectAndDays, loadProjectOptions, requestJson, saveSettings } from '../api.js';
import { escapeHtml, formatNumber, formatPercent } from '../render.js';
import { state } from '../state.js';

// 明细表渲染上限：服务端历史查询已 LIMIT（基数治理口径），此处再截断只防极端
// 数据量下浏览器无界 DOM 卡死；汇总卡不受影响（服务端独立聚合）。
const MAX_RENDERED_MODEL_ROWS = 500;

function renderModelRows(models = [], truncated = false) {
  if (!models.length) {
    return '<div class="empty">暂无模型维度数据</div>';
  }

  const visible = models.slice(0, MAX_RENDERED_MODEL_ROWS);
  const moreNote = models.length > visible.length
    ? `<div class="agent-runtime-note">仅显示前 ${visible.length} 行（共 ${models.length} 行${truncated ? '，且数据源已按量截断' : ''}）</div>`
    : (truncated ? '<div class="agent-runtime-note">数据源已按量截断，低频组合未包含在内</div>' : '');

  return `
    <table>
      <thead>
        <tr>
          <th>运行时</th>
          <th>服务商</th>
          <th>域名</th>
          <th>模型</th>
          <th>成功</th>
          <th>失败</th>
          <th>总数</th>
          <th>模型口径任务</th>
          <th>模型重试次数</th>
          <th>最终成功率</th>
          <th>失败率</th>
          <th>模型重试率</th>
          <th>模型重试成功率</th>
        </tr>
      </thead>
      <tbody>${visible.map((row) => `
        <tr>
          <td><code>${escapeHtml(row.runtime || '-')}</code></td>
          <td><code>${escapeHtml(row.provider || '-')}</code></td>
          <td><code>${escapeHtml(row.endpointHost || row.endpoint_host || '-')}</code></td>
          <td><code>${escapeHtml(row.model || '-')}</code></td>
          <td>${formatNumber(row.successCount)}</td>
          <td>${formatNumber(row.failedCount)}</td>
          <td>${formatNumber(row.totalCount)}</td>
          <td>${formatNumber(row.modelRunCount)}</td>
          <td>${formatNumber(row.retryCount)}</td>
          <td>${formatPercent(row.successRate)}</td>
          <td>${formatPercent(row.failureRate)}</td>
          <td>${formatPercent(row.retryRate)}</td>
          <td>${formatPercent(row.retrySuccessRate)}</td>
        </tr>
      `).join('')}</tbody>
    </table>
    ${moreNote}
  `;
}

function renderRuntimeRows(runtimes = []) {
  if (!runtimes.length) {
    return '<div class="empty">暂无运行时维度数据</div>';
  }

  return `
    <table>
      <thead>
        <tr>
          <th>运行时</th>
          <th>成功</th>
          <th>失败</th>
          <th>总数</th>
          <th>模型口径任务</th>
          <th>模型重试次数</th>
          <th>最终成功率</th>
          <th>失败率</th>
          <th>模型重试率</th>
          <th>模型重试成功率</th>
        </tr>
      </thead>
      <tbody>${runtimes.map((row) => `
        <tr>
          <td><code>${escapeHtml(row.runtime || '-')}</code></td>
          <td>${formatNumber(row.successCount)}</td>
          <td>${formatNumber(row.failedCount)}</td>
          <td>${formatNumber(row.totalCount)}</td>
          <td>${formatNumber(row.modelRunCount)}</td>
          <td>${formatNumber(row.retryCount)}</td>
          <td>${formatPercent(row.successRate)}</td>
          <td>${formatPercent(row.failureRate)}</td>
          <td>${formatPercent(row.retryRate)}</td>
          <td>${formatPercent(row.retrySuccessRate)}</td>
        </tr>
      `).join('')}</tbody>
    </table>
  `;
}

function renderAgentRuntime(stats = {}) {
  const successCount = Number(stats.successCount || 0);
  const failedCount = Number(stats.failedCount || 0);
  const totalCount = Number(stats.totalCount || 0);
  const successRate = Number(stats.successRate || 0);
  const failureRate = Number(stats.failureRate || 0);
  const retryRate = Number(stats.retryRate || 0);
  const retryCount = Number(stats.retryCount || 0);
  const retriedRunCount = Number(stats.retriedRunCount || 0);
  const retrySuccessCount = Number(stats.retrySuccessCount || 0);
  const retrySuccessRate = Number(stats.retrySuccessRate || 0);
  const modelRunCount = Number(stats.modelRunCount || 0);
  const runtimes = Array.isArray(stats.runtimes) ? stats.runtimes : [];
  const models = Array.isArray(stats.models) ? stats.models : [];
  const truncated = Boolean(stats.truncated);

  state.agentRuntime.innerHTML = `
    <div class="agent-runtime-layout">
      <div class="agent-runtime-card panel">
        <h3>Agent分析</h3>
        <span>Agent 最终成功率</span>
        <strong>${formatPercent(successRate)}</strong>
        <div class="agent-runtime-metrics">
          <div><small>成功次数</small><b>${formatNumber(successCount)}</b></div>
          <div><small>失败次数</small><b>${formatNumber(failedCount)}</b></div>
          <div><small>总数</small><b>${formatNumber(totalCount)}</b></div>
          <div><small>模型口径任务</small><b>${formatNumber(modelRunCount)}</b></div>
          <div><small>模型重试次数</small><b>${formatNumber(retryCount)}</b></div>
          <div><small>模型重试任务数</small><b>${formatNumber(retriedRunCount)}</b></div>
          <div><small>模型重试后成功</small><b>${formatNumber(retrySuccessCount)}</b></div>
          <div><small>最终成功率</small><b>${formatPercent(successRate)}</b></div>
          <div><small>失败率</small><b>${formatPercent(failureRate)}</b></div>
          <div><small>模型重试率</small><b>${formatPercent(retryRate)}</b></div>
          <div><small>模型重试成功率</small><b>${formatPercent(retrySuccessRate)}</b></div>
        </div>
        <div class="agent-runtime-note">口径：成功率 = 成功/(成功+失败)；用户取消、断连与队列暂停不计入分母，任务卡死超时计为失败</div>
      </div>
      <div class="agent-runtime-breakdown panel">
        <h3>运行时维度</h3>
        ${renderRuntimeRows(runtimes)}
      </div>
    </div>
  `;
  state.agentRuntimeModels.innerHTML = renderModelRows(models, truncated);
}

export async function loadAgentRuntime() {
  assertReady();
  await loadProjectOptions();
  saveSettings();

  const range = String(state.agentRange.value || 'history');
  const { projectName } = getEncodedProjectAndDays();
  const data = await requestJson(`/api/agent-runtime?projectName=${projectName}&${buildRangeQuery(range)}`);
  renderAgentRuntime(data.agentRuntime || {});
}
