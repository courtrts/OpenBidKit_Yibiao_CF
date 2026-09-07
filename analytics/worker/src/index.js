import { corsHeaders, json } from './http.js';
import { handleAgentRuntime } from './routes/agentRuntime.js';
import { handleAdminAgentErrorConfig, handleAdminAgentErrorDownload, handleAdminAgentErrors, handleAgentErrorIngest } from './routes/agentErrors.js';
import { handleClients, handleClientDetail, handleIpStats } from './routes/clients.js';
import { handleConfigUsage, handleModelUsage } from './routes/configUsage.js';
import { handleGitHubRepoStats } from './routes/githubRepoStats.js';
import { handleHealth } from './routes/health.js';
import { handleAdminIpBlocks, handlePublicIpBlocks } from './routes/ipBlocks.js';
import { handleAdminVersionBlocks } from './routes/versionBlocks.js';
import { handleLatest } from './routes/latest.js';
import { handleLicenseActivate, handleLicenseConfig, handleOfflineLicense } from './routes/license.js';
import { handleAdminModelInfoCache, handleAdminModelInfoOverride, handleAdminModelInfoSource, handlePublicModelInfo } from './routes/modelInfo.js';
import { handleAdminNotice, handlePublicNotice, handlePublicNoticeDelivered } from './routes/notice.js';
import { handleOverview } from './routes/overview.js';
import { handleProjects } from './routes/projects.js';
import { handleRetention } from './routes/retention.js';
import { handleAdminResources, handlePublicResources, handleResourceImage } from './routes/resources.js';
import { handleAdminPluginSync, handleAdminPlugins, handlePublicPluginDownload, handlePublicPlugins } from './routes/plugins.js';
import { handleTrack } from './routes/track.js';
import { handleTraffic } from './routes/traffic.js';
import { cleanupExpiredAgentErrors } from './services/agentErrorStore.js';
import { isRequestIpBlocked } from './services/ipBlockStore.js';
import {
  catchUpIncompleteRollups,
  refreshOverviewAiTotals,
  rollupYesterdayForAllProjects,
} from './services/analyticsStatsStore.js';

const routes = new Map([
  ['/health', (request, env) => handleHealth(env)],
  ['/ip-blocks', handlePublicIpBlocks],
  ['/track', handleTrack],
  ['/agent-errors', handleAgentErrorIngest],
  ['/license/activate', handleLicenseActivate],
  ['/notice', handlePublicNotice],
  ['/notice/delivered', handlePublicNoticeDelivered],
  ['/model-info', handlePublicModelInfo],
  ['/resources', handlePublicResources],
  ['/resource-image', handleResourceImage],
  ['/plugins', handlePublicPlugins],
  ['/plugins/download', handlePublicPluginDownload],
  ['/api/projects', handleProjects],
  ['/api/notice', handleAdminNotice],
  ['/api/model-info-cache', handleAdminModelInfoCache],
  ['/api/model-info-cache/source', handleAdminModelInfoSource],
  ['/api/model-info-cache/override', handleAdminModelInfoOverride],
  ['/api/resources', handleAdminResources],
  ['/api/plugins', handleAdminPlugins],
  ['/api/plugins/sync', handleAdminPluginSync],
  ['/api/overview', handleOverview],
  ['/api/clients', handleClients],
  ['/api/client-detail', handleClientDetail],
  ['/api/ip-stats', handleIpStats],
  ['/api/traffic', handleTraffic],
  ['/api/latest', handleLatest],
  ['/api/license-config', handleLicenseConfig],
  ['/api/license/offline', handleOfflineLicense],
  ['/api/retention', handleRetention],
  ['/api/config-usage', handleConfigUsage],
  ['/api/model-usage', handleModelUsage],
  ['/api/agent-runtime', handleAgentRuntime],
  ['/api/agent-errors/config', handleAdminAgentErrorConfig],
  ['/api/agent-errors/download', handleAdminAgentErrorDownload],
  ['/api/agent-errors', handleAdminAgentErrors],
  ['/api/github-repo-stats', handleGitHubRepoStats],
  ['/api/ip-blocks', handleAdminIpBlocks],
  ['/api/version-blocks', handleAdminVersionBlocks],
]);

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/ip-blocks' && !url.pathname.startsWith('/api/') && await isRequestIpBlocked(env, request)) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    const handler = routes.get(url.pathname);
    if (handler) {
      return handler(request, env, url);
    }

    return json({ code: 404, message: 'not found' }, { status: 404 });
  },

  // 免费套餐适配：单一 cron（0 17 * * * UTC = 北京时间 01:00）顺序执行全部每日任务。
  // 各步骤独立 try/catch：某一步失败不阻塞后续步骤；汇总阶段本身幂等
  // （stats_rollup_runs / stats_rollup_stages 到分块级别的成功标记），
  // 中断的部分由 catchUpIncompleteRollups 在当天/次日补跑，不会重复累计。
  // 注意：模型目录同步（syncModelInfoCache）不放在 cron 里——models.dev/api.json
  // 约 4.5MB，单次 JSON.parse 就要数十毫秒 CPU，超出免费套餐每次调用 10ms 的
  // CPU 预算。免费部署下 /model-info 返回 503、客户端回退手动录入；升级付费后
  // 可在 dashboard 手动同步（POST /api/model-info-cache）或恢复原 6-cron 配置。
  async scheduled(event, env) {
    try {
      await rollupYesterdayForAllProjects(env);
    } catch (error) {
      console.error('[analytics] yesterday rollup failed, catch-up will retry', error?.message || String(error));
    }
    try {
      await catchUpIncompleteRollups(env);
    } catch (error) {
      console.error('[analytics] catch-up rollup failed', error?.message || String(error));
    }
    try {
      await refreshOverviewAiTotals(env);
    } catch (error) {
      console.error('[analytics] overview AI totals refresh failed', error?.message || String(error));
    }
    try {
      await cleanupExpiredAgentErrors(env);
    } catch (error) {
      console.error('[analytics] agent error cleanup failed', error?.message || String(error));
    }
  },
};
