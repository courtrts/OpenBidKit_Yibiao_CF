import {
  DEFAULT_MODEL_INFO_SOURCE_URL,
  MODEL_INFO_CACHE_INDEX_KEY,
  MODEL_INFO_CACHE_OVERRIDES_KEY,
  MODEL_INFO_CACHE_STATUS_KEY,
  MODEL_INFO_SOURCE_URL_KEY,
} from '../constants.js';
import { fetchWithTimeout } from '../utils.js';

const CACHE_VERSION = 3;
const REASONING_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODALITY_ORDER = ['text', 'image', 'pdf', 'audio', 'video'];
const CAPABILITY_STATUSES = new Set(['supported', 'unsupported', 'mixed', 'unknown']);
const DEFAULT_CONCURRENCY_LIMIT = 10;
const DEFAULT_REQUEST_MODE = 'stream';
// 模型目录源响应体上限：无上限的 response.text() 会被篡改/故障源返回的超大
// JSON 顶穿 isolate 内存上限（1101），故流式读取并在超限即中止。
const MODEL_INFO_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
// 失败响应的错误体只需要留诊断片段，上限远小于目录体。
const MODEL_INFO_ERROR_BODY_MAX_BYTES = 2048;
// 人工覆盖条数上限：覆盖存于单个 KV 值，公开读路径每次请求都整体 parse，
// 条数不设上限会让读成本随脚本化保存单调上涨。
const MODEL_INFO_MAX_OVERRIDES = 1000;
// 空目录/骤降保护阈值：源返回 200 空壳（网关错误体、路径配错）或模型数较
// 上次成功目录跌去九成以上，默认按同步失败处理并保留旧索引（force 可覆盖）。
const MODEL_INFO_DROP_GUARD_RATIO = 0.1;

// 清理并稳定排序模型输入、输出模态。
function normalizeModalities(values) {
  const modalities = Array.isArray(values)
    ? [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))]
    : [];
  return modalities.sort((left, right) => {
    const leftIndex = MODALITY_ORDER.indexOf(left);
    const rightIndex = MODALITY_ORDER.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

// 根据图片输入和文本输出能力判断单个来源是否支持图片理解。
function getImageInputCapability(inputModalities, outputModalities) {
  if (!inputModalities.length || !outputModalities.length) return null;
  return inputModalities.includes('image') && outputModalities.includes('text');
}

// 汇总同名模型在不同来源中的布尔能力支持情况。
function resolveCapabilityStatus(capabilities) {
  if (!capabilities.length || capabilities.some((value) => value === null)) return 'unknown';
  if (capabilities.every(Boolean)) return 'supported';
  if (capabilities.every((value) => !value)) return 'unsupported';
  return 'mixed';
}

// 将单个模型记录合并到按模型 ID 聚合的临时索引。
function mergeModelRecord(records, modelId, model) {
  const id = String(modelId || '').trim();
  if (!id) return;

  const record = records.get(id) || {
    effortSets: [],
    context: 0,
    output: 0,
    inputModalities: [],
    outputModalities: [],
    imageInputCapabilities: [],
    temperatureCapabilities: [],
    sourceCount: 0,
  };
  record.sourceCount += 1;
  const effortOption = Array.isArray(model?.reasoning_options)
    ? model.reasoning_options.find((option) => option?.type === 'effort')
    : null;
  const efforts = Array.isArray(effortOption?.values)
    ? [...new Set(effortOption.values
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean))]
    : [];
  if (efforts.length) record.effortSets.push(efforts);

  const hasInputModalities = Array.isArray(model?.modalities?.input);
  const hasOutputModalities = Array.isArray(model?.modalities?.output);
  const inputModalities = normalizeModalities(model?.modalities?.input);
  const outputModalities = normalizeModalities(model?.modalities?.output);
  record.inputModalities = normalizeModalities([...record.inputModalities, ...inputModalities]);
  record.outputModalities = normalizeModalities([...record.outputModalities, ...outputModalities]);
  record.imageInputCapabilities.push(hasInputModalities && hasOutputModalities
    ? getImageInputCapability(inputModalities, outputModalities)
    : null);
  record.temperatureCapabilities.push(typeof model?.temperature === 'boolean' ? model.temperature : null);

  const context = Number(model?.limit?.context || 0);
  const output = Number(model?.limit?.output || 0);
  if (Number.isFinite(context) && context > record.context) record.context = Math.floor(context);
  if (Number.isFinite(output) && output > record.output) record.output = Math.floor(output);
  records.set(id, record);
}

// 按固定顺序整理思考强度，未知扩展值排在末尾。
function sortReasoningEfforts(efforts) {
  return [...efforts].sort((left, right) => {
    const leftIndex = REASONING_EFFORT_ORDER.indexOf(left);
    const rightIndex = REASONING_EFFORT_ORDER.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

// 统一模型能力记录格式，供自动索引和人工覆盖共同使用。
function normalizeModelInfoRecord(model) {
  const inputModalities = normalizeModalities(model?.inputModalities);
  const outputModalities = normalizeModalities(model?.outputModalities);
  const inferredImageInputStatus = getImageInputCapability(inputModalities, outputModalities);
  return {
    reasoningEfforts: Array.isArray(model?.reasoningEfforts)
      ? [...new Set(model.reasoningEfforts.map((value) => String(value || '').trim()).filter(Boolean))]
      : [],
    context: Math.max(0, Math.floor(Number(model?.context) || 0)),
    output: Math.max(0, Math.floor(Number(model?.output) || 0)),
    inputModalities,
    outputModalities,
    imageInputStatus: CAPABILITY_STATUSES.has(model?.imageInputStatus)
      ? model.imageInputStatus
      : inferredImageInputStatus === null ? 'unknown' : inferredImageInputStatus ? 'supported' : 'unsupported',
    temperatureStatus: CAPABILITY_STATUSES.has(model?.temperatureStatus) ? model.temperatureStatus : 'unknown',
    concurrencyLimit: Number.isFinite(Number(model?.concurrencyLimit)) && Number(model.concurrencyLimit) > 0
      ? Math.floor(Number(model.concurrencyLimit))
      : DEFAULT_CONCURRENCY_LIMIT,
    requestMode: model?.requestMode === 'normal' ? 'normal' : DEFAULT_REQUEST_MODE,
    sourceCount: Math.max(0, Math.floor(Number(model?.sourceCount) || 0)),
  };
}

// 把 models.dev 兼容目录转换为客户端查询所需的精简能力索引。
export function buildModelInfoIndex(catalog, sourceBytes, syncedAt = new Date().toISOString(), sourceUrl = DEFAULT_MODEL_INFO_SOURCE_URL) {
  const providers = catalog && typeof catalog === 'object' ? Object.values(catalog) : [];
  const records = new Map();
  let sourceModelCount = 0;

  providers.forEach((provider) => {
    if (!provider?.models || typeof provider.models !== 'object') return;
    Object.entries(provider.models).forEach(([modelKey, model]) => {
      sourceModelCount += 1;
      const modelId = String(model?.id || '').trim();
      mergeModelRecord(records, modelKey, model);
      if (modelId && modelId !== modelKey) mergeModelRecord(records, modelId, model);
    });
  });

  const models = {};
  let reasoningEffortModelCount = 0;
  let imageInputModelCount = 0;
  let mixedImageInputModelCount = 0;
  let temperatureModelCount = 0;
  let mixedTemperatureModelCount = 0;
  for (const [modelId, record] of records.entries()) {
    const reasoningEfforts = record.effortSets.length
      ? sortReasoningEfforts(record.effortSets[0].filter((effort) => record.effortSets.every((values) => values.includes(effort))))
      : [];
    if (reasoningEfforts.length) reasoningEffortModelCount += 1;
    const imageInputStatus = resolveCapabilityStatus(record.imageInputCapabilities);
    const temperatureStatus = resolveCapabilityStatus(record.temperatureCapabilities);
    if (imageInputStatus === 'supported') imageInputModelCount += 1;
    if (imageInputStatus === 'mixed') mixedImageInputModelCount += 1;
    if (temperatureStatus === 'supported') temperatureModelCount += 1;
    if (temperatureStatus === 'mixed') mixedTemperatureModelCount += 1;
    models[modelId] = {
      reasoningEfforts,
      context: record.context,
      output: record.output,
      inputModalities: record.inputModalities,
      outputModalities: record.outputModalities,
      imageInputStatus,
      temperatureStatus,
      concurrencyLimit: DEFAULT_CONCURRENCY_LIMIT,
      requestMode: DEFAULT_REQUEST_MODE,
      sourceCount: record.sourceCount,
    };
  }

  return {
    version: CACHE_VERSION,
    sourceUrl,
    syncedAt,
    sourceBytes,
    providerCount: providers.length,
    sourceModelCount,
    indexedModelCount: Object.keys(models).length,
    reasoningEffortModelCount,
    imageInputModelCount,
    mixedImageInputModelCount,
    temperatureModelCount,
    mixedTemperatureModelCount,
    models,
  };
}

// 读取 KV 中最近一次模型信息同步状态。
export async function readModelInfoCacheStatus(env) {
  if (!env.NOTICE_STORE) return null;
  const raw = await env.NOTICE_STORE.get(MODEL_INFO_CACHE_STATUS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 索引解析结果的 isolate 级记忆化。目录同步后索引 JSON 可达数 MB，
// 每次请求整体 JSON.parse 会吃掉免费套餐 10ms CPU 预算的大头（同步前索引为
// null、成本为零，问题只出现在同步后的公开 /model-info 与管理端列表页）。
// 键取 status 小对象里的 lastSuccessAt|sourceBytes（一次小 KV 读即可判定）：
// 键不变直接复用已解析对象；sync 先写索引再写 status，至多一个秒级窗口内
// 读到旧解析结果，对目录型数据可接受。GET 抛错时不更新键，下次请求自动重试。
let indexMemo = { key: '', value: null };

export async function readModelInfoCacheIndex(env) {
  if (!env.NOTICE_STORE) return null;
  const status = await readModelInfoCacheStatus(env);
  const key = status ? `${status.lastSuccessAt || ''}|${status.sourceBytes ?? ''}` : 'empty';
  if (indexMemo.key === key) {
    return indexMemo.value;
  }
  const raw = await env.NOTICE_STORE.get(MODEL_INFO_CACHE_INDEX_KEY);
  let parsed = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  // 只缓存解析成功且版本匹配的索引：解析失败（null）不更新键，下一次请求会
  // 重新读取 KV 重试，避免一次坏数据被记忆化“固化”成持续 503；CACHE_VERSION
  // 升级后残留的旧版索引按不可用处理（触发下次同步重建），而不是被
  // normalize 逐字段静默兜底。
  if (parsed && parsed.version === CACHE_VERSION) {
    indexMemo = { key, value: parsed };
    return parsed;
  }
  return null;
}

// 读取管理员人工覆盖记录；该数据不会被自动同步任务修改。
export async function readModelInfoOverrides(env) {
  if (!env.NOTICE_STORE) return { version: CACHE_VERSION, models: {} };
  const raw = await env.NOTICE_STORE.get(MODEL_INFO_CACHE_OVERRIDES_KEY);
  if (!raw) return { version: CACHE_VERSION, models: {} };
  try {
    const overrides = JSON.parse(raw);
    return {
      version: CACHE_VERSION,
      models: overrides?.models && typeof overrides.models === 'object' ? overrides.models : {},
    };
  } catch {
    return { version: CACHE_VERSION, models: {} };
  }
}

// 读取指定模型的精简能力信息。
export async function readCachedModelInfo(env, modelName) {
  if (!env.NOTICE_STORE) return { available: false, index: null, model: null };
  const normalizedName = String(modelName || '').trim();
  const [index, overrides] = await Promise.all([
    readModelInfoCacheIndex(env),
    readModelInfoOverrides(env),
  ]);
  const override = overrides.models[normalizedName] || null;
  const sourceModel = index?.models?.[normalizedName] || null;
  return {
    available: Boolean(index || override),
    index,
    model: override || sourceModel ? normalizeModelInfoRecord(override || sourceModel) : null,
  };
}

// 返回管理端分页表格使用的最终索引，人工覆盖记录优先于自动同步值。
export async function listAdminModelInfo(env, options = {}) {
  const [index, overrides] = await Promise.all([
    readModelInfoCacheIndex(env),
    readModelInfoOverrides(env),
  ]);
  const sourceModels = index?.models && typeof index.models === 'object' ? index.models : {};
  const overrideModels = overrides.models;
  const query = String(options.query || '').trim().toLocaleLowerCase();
  const overriddenOnly = options.scope === 'overridden';
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(options.pageSize) || 50)));
  const requestedPage = Math.max(1, Math.floor(Number(options.page) || 1));

  const modelNames = [...new Set([...Object.keys(sourceModels), ...Object.keys(overrideModels)])]
    .filter((modelName) => !query || modelName.toLocaleLowerCase().includes(query))
    .filter((modelName) => !overriddenOnly || Boolean(overrideModels[modelName]))
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' }));
  const total = modelNames.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const models = modelNames.slice((page - 1) * pageSize, page * pageSize).map((modelName) => {
    const override = overrideModels[modelName] || null;
    const model = normalizeModelInfoRecord(override || sourceModels[modelName]);
    return {
      modelName,
      ...model,
      overridden: Boolean(override),
      updatedAt: override?.updatedAt || index?.syncedAt || '',
    };
  });

  return {
    available: Boolean(index),
    models,
    total,
    page,
    pageSize,
    overrideCount: Object.keys(overrideModels).length,
  };
}

// 保存一条完整的管理员人工覆盖记录。
export async function saveModelInfoOverride(env, modelName, model) {
  const overrides = await readModelInfoOverrides(env);
  // 新增覆盖（非更新已有条目）时校验总条数，防止脚本化保存让单 KV 值逼近 25MB。
  if (!overrides.models[modelName] && Object.keys(overrides.models).length >= MODEL_INFO_MAX_OVERRIDES) {
    const error = new Error(`人工覆盖已达 ${MODEL_INFO_MAX_OVERRIDES} 条上限，请先删除部分覆盖再保存`);
    error.statusCode = 400;
    throw error;
  }
  const record = normalizeModelInfoRecord(model);
  overrides.models[modelName] = {
    ...record,
    reasoningEfforts: sortReasoningEfforts(record.reasoningEfforts),
    updatedAt: new Date().toISOString(),
  };
  await env.NOTICE_STORE.put(MODEL_INFO_CACHE_OVERRIDES_KEY, JSON.stringify(overrides));
  return overrides.models[modelName];
}

// 删除人工覆盖，使该模型立即恢复最近一次自动同步值。
export async function deleteModelInfoOverride(env, modelName) {
  const overrides = await readModelInfoOverrides(env);
  const existed = Boolean(overrides.models[modelName]);
  if (!existed) return false;
  delete overrides.models[modelName];
  if (Object.keys(overrides.models).length) {
    await env.NOTICE_STORE.put(MODEL_INFO_CACHE_OVERRIDES_KEY, JSON.stringify(overrides));
  } else {
    await env.NOTICE_STORE.delete(MODEL_INFO_CACHE_OVERRIDES_KEY);
  }
  return true;
}

// 校验模型目录源地址。只允许 http(s)，并拒绝回环、链路本地、云元数据和内网地址，
// 防止管理端把数据源指向内网服务（SSRF）。自部署 models.dev 兼容目录请提供公网可达域名。
// IPv6 字面量在 URL.hostname 中带方括号，且 127.0.0.1/169.254.169.254 等内网地址
// 可以 IPv6 形式（::1、::ffff:127.0.0.1）表达——先剥离方括号、把 IPv4 映射地址
// 还原成内嵌 IPv4 走同一套规则，其余仍含 ':' 的 host 全部是 IPv6 形式，合法目录
// 源都是域名，一律拒绝，堵住前缀黑名单被 IPv6 写法绕过的缺口。
export function validateModelInfoSourceUrl(value) {
  const text = String(value || '').trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: 'sourceUrl 不是合法 URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'sourceUrl 仅支持 http/https' };
  }
  let host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const mappedIpv4 = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedIpv4) host = mappedIpv4[1];
  if (
    host.includes(':')
    || host === 'localhost'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host === 'metadata.google.internal'
    || host.startsWith('127.')
    || host.startsWith('10.')
    || host.startsWith('169.254.')
    || host.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || host === '0.0.0.0'
  ) {
    return { ok: false, message: 'sourceUrl 不允许指向内网/回环/元数据地址，请使用公网可达域名' };
  }
  return { ok: true, sourceUrl: url.toString() };
}

// 解析当前生效的模型目录源地址。优先级：管理端 KV 设置 > 环境变量 MODEL_INFO_SOURCE_URL > 默认值。
// 支持指向任意第三方或自部署的 models.dev 兼容目录（{"provider": {"models": {...}}} 格式）。
export async function resolveModelInfoSourceUrl(env) {
  if (env.NOTICE_STORE) {
    try {
      const raw = await env.NOTICE_STORE.get(MODEL_INFO_SOURCE_URL_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const sourceUrl = String(parsed?.sourceUrl || '').trim();
        if (sourceUrl) {
          const checked = validateModelInfoSourceUrl(sourceUrl);
          if (checked.ok) return { sourceUrl: checked.sourceUrl, origin: 'admin' };
          console.warn(`[analytics] invalid model info source in KV, falling through: ${checked.message}`);
        }
      }
    } catch (error) {
      console.warn(`[analytics] model info source KV read failed: ${error?.message || String(error)}`);
    }
  }
  const envUrl = String(env.MODEL_INFO_SOURCE_URL || '').trim();
  if (envUrl) {
    const checked = validateModelInfoSourceUrl(envUrl);
    if (checked.ok) return { sourceUrl: checked.sourceUrl, origin: 'env' };
    console.warn(`[analytics] invalid MODEL_INFO_SOURCE_URL env, using default: ${checked.message}`);
  }
  return { sourceUrl: DEFAULT_MODEL_INFO_SOURCE_URL, origin: 'default' };
}

// 保存（或删除）管理端设置的模型目录源地址。传空值时删除 KV 设置，回退到 env/默认值。
export async function saveModelInfoSourceUrl(env, sourceUrl) {
  if (!env.NOTICE_STORE) throw new Error('NOTICE_STORE is not configured');
  const text = String(sourceUrl || '').trim();
  if (!text) {
    await env.NOTICE_STORE.delete(MODEL_INFO_SOURCE_URL_KEY);
    return { cleared: true };
  }
  const checked = validateModelInfoSourceUrl(text);
  if (!checked.ok) throw new Error(checked.message);
  await env.NOTICE_STORE.put(MODEL_INFO_SOURCE_URL_KEY, JSON.stringify({
    sourceUrl: checked.sourceUrl,
    updatedAt: new Date().toISOString(),
  }));
  return { cleared: false, sourceUrl: checked.sourceUrl };
}

// 读取响应体并施加字节上限：Content-Length 预检 + 流式累计，超限立即中止。
// 外部目录源不受信任，无上限的 response.text() 会被超大响应顶穿 isolate 内存。
async function readBodyCapped(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) {
    throw new Error('model info source response too large');
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      bytes += value.length;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('model info source response too large');
      }
      text += decoder.decode(value, { stream: true });
    }
  }
  return text + decoder.decode();
}

// 从配置的目录源同步模型信息并原子替换客户端使用的精简索引。
// options.force=true 时跳过空目录/骤降保护（dashboard「强制同步」按钮）。
export async function syncModelInfoCache(env, trigger = 'manual', options = {}) {
  if (!env.NOTICE_STORE) throw new Error('NOTICE_STORE is not configured');

  const { sourceUrl } = await resolveModelInfoSourceUrl(env);
  const attemptedAt = new Date().toISOString();
  const previousStatus = await readModelInfoCacheStatus(env);
  try {
    const response = await fetchWithTimeout(sourceUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'OpenBidKit-Yibiao-Analytics',
      },
      cache: 'no-store',
    }, 30000);
    if (!response.ok) {
      const errorText = await readBodyCapped(response, MODEL_INFO_ERROR_BODY_MAX_BYTES).catch(() => '');
      throw new Error(`models.dev API ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const sourceText = await readBodyCapped(response, MODEL_INFO_SOURCE_MAX_BYTES);
    const catalog = JSON.parse(sourceText);
    const index = buildModelInfoIndex(catalog, new TextEncoder().encode(sourceText).length, attemptedAt, sourceUrl);

    // 空目录/骤降保护（阈值见 MODEL_INFO_DROP_GUARD_RATIO）：源返回 200 空壳或
    // 模型数较上次成功目录跌去九成以上时，按失败处理走下方 catch——记录 failed
    // 状态并保留旧索引，而不是把残缺目录写入覆盖全量模型能力。
    const force = options.force === true;
    const previousCount = Number(previousStatus?.indexedModelCount || 0);
    if (index.indexedModelCount === 0
      || (previousCount > 0 && !force && index.indexedModelCount < previousCount * MODEL_INFO_DROP_GUARD_RATIO)) {
      const error = new Error(index.indexedModelCount === 0
        ? '目录源返回空目录，已保留旧索引（确认换源无误后可强制同步覆盖）'
        : `目录模型数从 ${previousCount} 骤降至 ${index.indexedModelCount}，已保留旧索引（确认换源无误后可强制同步覆盖）`);
      error.statusCode = 502;
      throw error;
    }

    const status = {
      status: 'success',
      trigger,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: attemptedAt,
      error: '',
      sourceUrl: index.sourceUrl,
      sourceBytes: index.sourceBytes,
      providerCount: index.providerCount,
      sourceModelCount: index.sourceModelCount,
      indexedModelCount: index.indexedModelCount,
      reasoningEffortModelCount: index.reasoningEffortModelCount,
      imageInputModelCount: index.imageInputModelCount,
      mixedImageInputModelCount: index.mixedImageInputModelCount,
      temperatureModelCount: index.temperatureModelCount,
      mixedTemperatureModelCount: index.mixedTemperatureModelCount,
    };

    await env.NOTICE_STORE.put(MODEL_INFO_CACHE_INDEX_KEY, JSON.stringify(index));
    await env.NOTICE_STORE.put(MODEL_INFO_CACHE_STATUS_KEY, JSON.stringify(status));
    return { index, status };
  } catch (error) {
    const status = {
      ...(previousStatus || {}),
      status: 'failed',
      trigger,
      lastAttemptAt: attemptedAt,
      error: error?.message || String(error),
      sourceUrl,
    };
    await env.NOTICE_STORE.put(MODEL_INFO_CACHE_STATUS_KEY, JSON.stringify(status));
    throw error;
  }
}
