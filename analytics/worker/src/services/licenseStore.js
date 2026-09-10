import { DEFAULT_FREE_LICENSE_DAYS, LICENSE_CONFIG_KEY_PREFIX } from '../constants.js';
import { formatNoticeTime, isValidProjectName, normalizeText } from '../utils.js';

export function buildLicenseConfigKey(projectName) {
  return `${LICENSE_CONFIG_KEY_PREFIX}${projectName}`;
}

function normalizeFreeLicenseDays(value) {
  const number = Number(value || DEFAULT_FREE_LICENSE_DAYS);
  return Number.isFinite(number) && number > 0 ? Math.min(3650, Math.floor(number)) : DEFAULT_FREE_LICENSE_DAYS;
}

function normalizeBooleanValue(value, defaultValue = true) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return defaultValue;
}

export function normalizeLicenseConfig(config, projectName = '') {
  const source = config && typeof config === 'object' ? config : {};
  return {
    projectName: normalizeText(source.projectName || projectName, 80),
    freeLicenseDays: normalizeFreeLicenseDays(source.freeLicenseDays ?? source.free_license_days),
    // 布尔值必须归一：管理端 POST 字符串 "false" 时若用 ?? 直通，
    // 会被 `!== false` 判断放行并签进客户端 license payload，弹窗开关语义反转。
    expirePopupEnabled: normalizeBooleanValue(source.expirePopupEnabled ?? source.expire_popup_enabled, true),
    expirePopupDismissible: normalizeBooleanValue(source.expirePopupDismissible ?? source.expire_popup_dismissible, true),
    updatedAt: normalizeText(source.updatedAt || source.updated_at, 40),
  };
}

export async function readLicenseConfig(env, projectName) {
  const normalizedProjectName = normalizeText(projectName, 80);
  const defaultConfig = normalizeLicenseConfig({ updatedAt: '' }, normalizedProjectName);
  if (!isValidProjectName(normalizedProjectName) || !env.NOTICE_STORE) {
    return defaultConfig;
  }
  const raw = await env.NOTICE_STORE.get(buildLicenseConfigKey(normalizedProjectName));
  if (!raw) {
    return defaultConfig;
  }
  try {
    return normalizeLicenseConfig(JSON.parse(raw), normalizedProjectName);
  } catch {
    return defaultConfig;
  }
}

export async function saveLicenseConfig(env, input) {
  if (!env.NOTICE_STORE) {
    throw new Error('NOTICE_STORE is not configured');
  }
  const projectName = normalizeText(input.projectName || input.project_name, 80);
  if (!isValidProjectName(projectName)) {
    throw new Error('invalid projectName');
  }
  const config = normalizeLicenseConfig({
    ...input,
    projectName,
    updatedAt: formatNoticeTime(),
  }, projectName);
  await env.NOTICE_STORE.put(buildLicenseConfigKey(projectName), JSON.stringify(config));
  return config;
}
