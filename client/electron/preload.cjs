const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 统一包装 invoke：Electron 会把 handler 抛出的错误包装成
// "Error invoking remote method '<channel>': Error: <原始消息>"，
// 渲染层 140+ 处直接展示 error.message，统一在这里剥掉技术性前缀。
function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((error) => {
    const text = String(error?.message || error || '');
    const stripped = text.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
    throw new Error(stripped || text);
  });
}

const bridge = {
  appName: '易标投标工具箱',
  platform: process.platform,
  getVersion: () => invoke('app:get-version'),
  getGpuHardwareAccelerationStatus: () => invoke('app:get-gpu-hardware-acceleration-status'),
  saveGpuHardwareAccelerationPreference: (enabled) => invoke('app:save-gpu-hardware-acceleration-preference', enabled),
  startGpuHardwareAccelerationTrial: () => invoke('app:start-gpu-hardware-acceleration-trial'),
  relaunchWithGpuHardwareAccelerationDisabled: () => invoke('app:relaunch-with-gpu-hardware-acceleration-disabled'),
  requiredOnlineServices: {
    getStatus: () => invoke('required-online-services:get-status'),
  },
  donation: {
    getConfig: () => invoke('donation:get-config'),
    createTip: (request) => invoke('donation:create-tip', request),
    getOrderStatus: (merchantOrderNo) => invoke('donation:get-order-status', merchantOrderNo),
    finalizeOrderStatus: (merchantOrderNo) => invoke('donation:finalize-order-status', merchantOrderNo),
    onPrompt: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('donation:prompt', listener);
      return () => ipcRenderer.removeListener('donation:prompt', listener);
    },
    onPaid: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('donation:paid', listener);
      return () => ipcRenderer.removeListener('donation:paid', listener);
    },
  },
  getLatestVersion: () => invoke('app:get-latest-version'),
  getUpdateDownloadUrl: () => invoke('app:get-update-download-url'),
  openExternal: (url) => invoke('app:open-external', url),
  checkUpdate: () => invoke('app:check-update'),
  startUpdate: () => invoke('app:start-update'),
  quitAndInstall: () => invoke('app:quit-and-install'),
  onUpdateProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:update-progress', listener);
    return () => ipcRenderer.removeListener('app:update-progress', listener);
  },
  onUpdateDownloaded: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:update-downloaded', listener);
    return () => ipcRenderer.removeListener('app:update-downloaded', listener);
  },
  onUpdateError: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:update-error', listener);
    return () => ipcRenderer.removeListener('app:update-error', listener);
  },
  onPluginUpdatesAvailable: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('plugins:updates-available', listener);
    return () => ipcRenderer.removeListener('plugins:updates-available', listener);
  },
  database: {
    getStatus: () => invoke('workspace-database:get-status'),
    onStatus: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('workspace-database:status', listener);
      return () => ipcRenderer.removeListener('workspace-database:status', listener);
    },
  },
  ui: {
    setCurrentView: (view) => invoke('ui:set-current-view', view),
    setNativeTheme: (mode) => invoke('ui:set-native-theme', mode),
  },
  config: {
    load: () => invoke('config:load'),
    save: (config) => invoke('config:save', config),
    listModels: (config) => invoke('config:list-models', config),
    getModelInfo: (modelName) => invoke('config:get-model-info', modelName),
    openConfigFolder: () => invoke('config:open-config-folder'),
  },
  license: {
    getStatus: () => invoke('license:get-status'),
    refresh: () => invoke('license:refresh'),
    importOfflineFile: () => invoke('license:import-offline-file'),
    activateOfflineCode: (code) => invoke('license:activate-offline-code', code),
  },
  ai: {
    chat: (request) => invoke('ai:chat', request),
    requestJson: (request) => invoke('ai:request-json', request),
    testImageModel: (config) => invoke('ai:test-image-model', config),
    onHttpError: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('ai:http-error', listener);
      return () => ipcRenderer.removeListener('ai:http-error', listener);
    },
  },
  autoConfirmation: {
    getState: () => invoke('auto-confirmation:get-state'),
    setEnabled: (enabled) => invoke('auto-confirmation:set-enabled', enabled),
    onChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('auto-confirmation:state', listener);
      ipcRenderer.send('auto-confirmation:subscribe');
      return () => ipcRenderer.removeListener('auto-confirmation:state', listener);
    },
  },
  agent: {
    run: (payload) => invoke('agent:run', payload),
    selfCheck: () => invoke('agent:self-check'),
    exportSelfCheckReport: (payload) => invoke('agent:export-self-check-report', payload),
    getStatus: () => invoke('agent:get-status'),
    restart: (reason) => invoke('agent:restart', reason),
    getPendingQuestion: () => invoke('agent:get-pending-question'),
    answerQuestion: (payload) => invoke('agent:answer-question', payload),
    suppressQuestionAutoAnswer: (payload) => invoke('agent:suppress-question-auto-answer', payload),
    onStatus: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('agent:status', listener);
      ipcRenderer.send('agent:subscribe');
      return () => ipcRenderer.removeListener('agent:status', listener);
    },
    onQuestion: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('agent:question-state', listener);
      ipcRenderer.send('agent:subscribe');
      return () => ipcRenderer.removeListener('agent:question-state', listener);
    },
  },
  developerTokenStats: {
    openWindow: () => invoke('developer-token-stats:open-window'),
    get: () => invoke('developer-token-stats:get'),
    reset: () => invoke('developer-token-stats:reset'),
    onChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('developer-token-stats:changed', listener);
      return () => ipcRenderer.removeListener('developer-token-stats:changed', listener);
    },
  },
  developerAgentMonitor: {
    openWindow: () => invoke('developer-agent-monitor:open-window'),
    openWorkspace: (workspaceDir) => invoke('developer-agent-monitor:open-workspace', workspaceDir),
    attach: () => invoke('developer-agent-monitor:attach'),
    detach: () => invoke('developer-agent-monitor:detach'),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('developer-agent-monitor:event', listener);
      return () => ipcRenderer.removeListener('developer-agent-monitor:event', listener);
    },
  },
  developerExpansionReplaceTest: {
    run: (payload) => invoke('developer-expansion-replace-test:run', payload),
  },
  file: {
    selectDuplicateCheckFiles: (options) => invoke('file:select-duplicate-check-files', options),
    /** 把拖拽进来的 File 对象换成本地绝对路径，供各上传区拖拽导入使用 */
    getPathForFile: (file) => webUtils.getPathForFile(file),
  },
  knowledgeBase: {
    list: () => invoke('knowledge-base:list'),
    createFolder: (name) => invoke('knowledge-base:create-folder', name),
    renameFolder: (folderId, name) => invoke('knowledge-base:rename-folder', folderId, name),
    reorderFolder: (draggedFolderId, targetFolderId, position) => invoke('knowledge-base:reorder-folder', draggedFolderId, targetFolderId, position),
    deleteFolder: (folderId) => invoke('knowledge-base:delete-folder', folderId),
    deleteDocument: (documentId) => invoke('knowledge-base:delete-document', documentId),
    moveDocument: (documentId, targetFolderId, targetDocumentId, position) => invoke('knowledge-base:move-document', documentId, targetFolderId, targetDocumentId, position),
    uploadDocuments: (folderId) => invoke('knowledge-base:upload-documents', folderId),
    retryDocument: (documentId) => invoke('knowledge-base:retry-document', documentId),
    startMatching: (documentId, batchSize) => invoke('knowledge-base:start-matching', documentId, batchSize), // batchSize 已忽略
    readMarkdown: (documentId) => invoke('knowledge-base:read-markdown', documentId),
    readItems: (documentId) => invoke('knowledge-base:read-items', documentId),
    readAnalysis: (documentId) => invoke('knowledge-base:read-analysis', documentId),
    onEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('knowledge-base:event', listener);
      return () => ipcRenderer.removeListener('knowledge-base:event', listener);
    },
  },
  technicalPlan: {
    loadState: () => invoke('technical-plan:load-state'),
    importTenderDocument: (filePaths) => invoke('technical-plan:import-tender-document', filePaths),
    removeTenderDocument: (sourceId) => invoke('technical-plan:remove-tender-document', sourceId),
    importOriginalPlanDocument: (filePaths) => invoke('technical-plan:import-original-plan-document', filePaths),
    checkBidSections: () => invoke('technical-plan:check-bid-sections'),
    selectBidSection: (selectedSection) => invoke('technical-plan:select-bid-section', selectedSection),
    readTenderMarkdown: () => invoke('technical-plan:read-tender-markdown'),
    readTenderSourceMarkdown: (sourceId) => invoke('technical-plan:read-tender-source-markdown', sourceId),
    readOriginalPlanMarkdown: () => invoke('technical-plan:read-original-plan-markdown'),
    updateStep: (step) => invoke('technical-plan:update-step', step),
    setWorkflowKind: (workflowKind) => invoke('technical-plan:set-workflow-kind', workflowKind),
    switchWorkflowKind: (workflowKind) => invoke('technical-plan:switch-workflow-kind', workflowKind),
    saveBidAnalysisConfig: (payload) => invoke('technical-plan:save-bid-analysis-config', payload),
    saveOutlineConfig: (payload) => invoke('technical-plan:save-outline-config', payload),
    saveOutlineSelection: (payload) => invoke('tasks:confirm-outline-selection', payload),
    saveOutline: (outlineData) => invoke('technical-plan:save-outline', outlineData),
    saveGlobalFactsConfig: (payload) => invoke('technical-plan:save-global-facts-config', payload),
    saveGlobalFacts: (globalFacts) => invoke('technical-plan:save-global-facts', globalFacts),
    saveContentGenerationOptions: (options) => invoke('technical-plan:save-content-generation-options', options),
    saveChapterContent: (payload) => invoke('technical-plan:save-chapter-content', payload),
    clear: () => invoke('technical-plan:clear'),
    openBidTemplate: () => invoke('technical-plan:open-bid-template'),
  },
  feasibilityReport: {
    loadState: () => invoke('feasibility-report:load-state'),
    importSourceDocuments: (filePaths) => invoke('feasibility-report:import-source-documents', filePaths),
    removeSourceDocument: (sourceId) => invoke('feasibility-report:remove-source-document', sourceId),
    readSourceMarkdown: (sourceId) => invoke('feasibility-report:read-source-markdown', sourceId),
    readCombinedSourceMarkdown: () => invoke('feasibility-report:read-combined-source-markdown'),
    updateStep: (step) => invoke('feasibility-report:update-step', step),
    saveProjectInfo: (projectInfo) => invoke('feasibility-report:save-project-info', projectInfo),
    saveExportOptions: (exportOptions) => invoke('feasibility-report:save-export-options', exportOptions),
    saveAnalysis: (markdown) => invoke('feasibility-report:save-analysis', markdown),
    saveOutlineConfig: (payload) => invoke('feasibility-report:save-outline-config', payload),
    saveOutline: (payload) => invoke('feasibility-report:save-outline', payload),
    saveKeyParameters: (markdown) => invoke('feasibility-report:save-key-parameters', markdown),
    saveChapterContent: (payload) => invoke('feasibility-report:save-chapter-content', payload),
    clear: () => invoke('feasibility-report:clear'),
  },
  duplicateCheck: {
    loadState: () => invoke('duplicate-check:load-state'),
    saveFiles: (payload) => invoke('duplicate-check:save-files', payload),
    saveUiState: (payload) => invoke('duplicate-check:save-ui-state', payload),
    updateState: (partial) => invoke('duplicate-check:update-state', partial),
    exportExcel: (request) => invoke('duplicate-check:export-excel', request),
    clear: () => invoke('duplicate-check:clear'),
  },
  rejectionCheck: {
    loadState: () => invoke('rejection-check:load-state'),
    importDocument: (role, filePaths) => invoke('rejection-check:import-document', role, filePaths),
    importTenderFromTechnicalPlan: () => invoke('rejection-check:import-tender-from-technical-plan'),
    removeDocument: (role, documentId) => invoke('rejection-check:remove-document', role, documentId),
    saveUiState: (payload) => invoke('rejection-check:save-ui-state', payload),
    updateState: (partial) => invoke('rejection-check:update-state', partial),
    exportExcel: (request) => invoke('rejection-check:export-excel', request),
    clear: () => invoke('rejection-check:clear'),
  },
  templates: {
    list: () => invoke('templates:list'),
    get: (templateId) => invoke('templates:get', templateId),
    create: (config) => invoke('templates:create', config),
    update: (templateId, config) => invoke('templates:update', templateId, config),
    delete: (templateId) => invoke('templates:delete', templateId),
  },
  tasks: {
    startBidSectionExtraction: (payload) => invoke('tasks:start-bid-section-extraction', payload),
    startBidAnalysis: (payload) => invoke('tasks:start-bid-analysis', payload),
    startOutlineGeneration: (payload) => invoke('tasks:start-outline-generation', payload),
    suppressOutlineSelectionAutoConfirmation: (payload) => invoke('tasks:suppress-outline-selection-auto-confirmation', payload),
    startGlobalFactsGeneration: (payload) => invoke('tasks:start-global-facts-generation', payload),
    startContentGeneration: (payload) => invoke('tasks:start-content-generation', payload),
    pauseContentGeneration: () => invoke('tasks:pause-content-generation'),
    startRejectionItemsExtraction: (payload) => invoke('tasks:start-rejection-items-extraction', payload),
    startRejectionCheck: (payload) => invoke('tasks:start-rejection-check', payload),
    startDuplicateAnalysis: (payload) => invoke('tasks:start-duplicate-analysis', payload),
    startFeasibilityAnalysis: (payload) => invoke('tasks:start-feasibility-analysis', payload),
    startFeasibilityOutline: (payload) => invoke('tasks:start-feasibility-outline', payload),
    startFeasibilityParameters: (payload) => invoke('tasks:start-feasibility-parameters', payload),
    startFeasibilityContent: (payload) => invoke('tasks:start-feasibility-content', payload),
    pauseFeasibilityContent: () => invoke('tasks:pause-feasibility-content'),
    startFeasibilityHumanWriting: (payload) => invoke('tasks:start-feasibility-human-writing', payload),
    cancelFeasibilityTask: (payload) => invoke('tasks:cancel-feasibility-task', payload),
    getActiveTasks: () => invoke('tasks:get-active'),
    onTaskEvent: (callback) => {
      ipcRenderer.send('tasks:subscribe');
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('tasks:event', listener);
      return () => ipcRenderer.removeListener('tasks:event', listener);
    },
  },
  export: {
    exportWord: (payload) => invoke('export:word', payload),
    openFile: (filePath) => invoke('export:open-file', filePath),
    onWordExportProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('export:word-progress', listener);
      return () => ipcRenderer.removeListener('export:word-progress', listener);
    },
  },
  systemFonts: {
    list: () => invoke('system-fonts:list'),
  },
  plugins: {
    getAvailablePlugins: () => invoke('plugins:getAvailablePlugins'),
    install: (pluginId) => invoke('plugins:install', pluginId),
    installOffline: () => invoke('plugins:installOffline'),
    uninstall: (pluginId) => invoke('plugins:uninstall', pluginId),
    enable: (pluginId) => invoke('plugins:enable', pluginId),
    disable: (pluginId) => invoke('plugins:disable', pluginId),
    update: (pluginId) => invoke('plugins:update', pluginId),
    checkUpdates: () => invoke('plugins:checkUpdates'),
    updateAll: () => invoke('plugins:updateAll'),
    openConfig: (pluginId) => invoke('plugins:openConfig', pluginId),
    refreshMarket: () => invoke('plugins:refreshMarket'),
    clearUpdateFailedState: (pluginId) => invoke('plugins:clearUpdateFailedState', pluginId),
    notifyEvent: (pluginId, event, payload) => invoke('plugins:notify-event', pluginId, event, payload),
  },
};

contextBridge.exposeInMainWorld('yibiao', bridge);

contextBridge.exposeInMainWorld('yibiaoClient', {
  appName: bridge.appName,
  platform: bridge.platform,
});
