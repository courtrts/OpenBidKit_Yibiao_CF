import { internalErrorMessage, json, methodNotAllowed, rejectOversizedBody, requireAdmin, unauthorized } from '../http.js';
import { normalizeLicenseConfig, readLicenseConfig, saveLicenseConfig } from '../services/licenseStore.js';
import { signPayload, verifySignedObject } from '../services/licenseCrypto.js';
import { isValidProjectName, normalizeText } from '../utils.js';

const LICENSE_PLANS = new Set(['free', 'personal_premium', 'enterprise_premium']);
const FINGERPRINT_VERSION = '2026-01';
const OFFLINE_LICENSE_CODE_PREFIX = 'YB-LICENSE-';
const DEFAULT_APP_ID = 'com.yibiao.openbidkit';
const DEFAULT_PRODUCT_NAME = '易标投标工具箱';

function addDaysIso(days) {
  return new Date(Date.now() + Math.max(1, Number(days || 1)) * 86400000).toISOString();
}

function normalizeBooleanText(value) {
  return value === true ? 'true' : 'false';
}

function normalizeBooleanValue(value, defaultValue = true) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return defaultValue;
}

// 双通道（在线激活/离线签发）统一的配置兜底：KV 故障时返回与 readLicenseConfig
// 完全相同的归一默认值，绝不采信请求体——否则同一请求在 KV 健康/故障两种状态下
// 会签出弹窗开关语义不同的授权。
async function resolveLicenseConfigOrDefaults(env, projectName) {
  try {
    return await readLicenseConfig(env, projectName);
  } catch {
    return normalizeLicenseConfig({ projectName }, projectName);
  }
}

function normalizeExpiresAt(value) {
  const text = normalizeText(value, 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    // 纯日期按业务日（Asia/Shanghai）当日 23:59:59 解释，与系统其余时间语义一致；
    // 原实现按 UTC 日末解释，实际有效期比管理员预期多约 8 小时。
    const expiresAt = new Date(`${text}T23:59:59.999+08:00`);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new Error('invalid expiresAt');
    }
    return expiresAt.toISOString();
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new Error('invalid expiresAt');
  }
  return date.toISOString();
}

function base64UrlEncodeText(value) {
  let binary = '';
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeOfflineLicenseCode(license) {
  return `${OFFLINE_LICENSE_CODE_PREFIX}${base64UrlEncodeText(JSON.stringify(license))}`;
}

function normalizeBuildInfo(buildAttestation) {
  const source = buildAttestation && typeof buildAttestation === 'object' ? buildAttestation : {};
  return {
    buildId: normalizeText(source.buildId, 120),
    gitCommitSha: normalizeText(source.gitCommitSha, 80),
    builtAt: normalizeText(source.builtAt, 40),
    keyId: normalizeText(source.keyId, 80),
  };
}

export async function handleLicenseActivate(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  // 激活是全 worker 单请求 CPU 最重的公开路径（验签+KV+签名），先拒大 body
  const oversized = rejectOversizedBody(request, 16384);
  if (oversized) return oversized;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid json body' }, { status: 400 });
  }

  const projectName = normalizeText(body.projectName || body.project_name, 80);
  const appId = normalizeText(body.appId || body.app_id, 120);
  const productName = normalizeText(body.productName || body.product_name, 120);
  const clientId = normalizeText(body.clientId || body.client_id, 120);
  const clientCreatedAt = normalizeText(body.clientCreatedAt || body.client_created_at, 20).slice(0, 10);
  const machineFingerprintHash = normalizeText(body.machineFingerprintHash || body.machine_fingerprint_hash, 128);
  const fingerprintVersion = normalizeText(body.fingerprintVersion || body.fingerprint_version, 40) || FINGERPRINT_VERSION;

  if (!isValidProjectName(projectName) || !appId || !clientId || !clientCreatedAt || !machineFingerprintHash) {
    return json({ code: 400, message: 'invalid params' }, { status: 400 });
  }

  const buildAttestation = body.buildAttestation || body.build_attestation || null;
  const sourceTrusted = await verifySignedObject(env, buildAttestation);
  const untrustedReason = sourceTrusted ? '' : 'build_signature_invalid';
  const config = await readLicenseConfig(env, projectName);
  // 公开激活端点只签发 free；付费计划走离线签发通道，或携带管理员令牌的请求。
  // 否则任何人都能自选 enterprise_premium 换取服务端签名的付费授权。
  const requestedPlan = LICENSE_PLANS.has(body.plan) ? body.plan : 'free';
  if (requestedPlan !== 'free' && !requireAdmin(request, env)) {
    return json({ code: 403, message: 'paid plan requires admin token' }, { status: 403 });
  }
  const plan = requestedPlan;
  const payload = {
    schemaVersion: 1,
    projectName,
    appId,
    productName,
    clientId,
    clientCreatedAt,
    machineFingerprintHash,
    fingerprintVersion,
    plan,
    status: 'active',
    issuedAt: new Date().toISOString(),
    expiresAt: addDaysIso(config.freeLicenseDays),
    sourceTrusted,
    sourceTrustedText: normalizeBooleanText(sourceTrusted),
    untrustedReason,
    keyId: normalizeText(env.LICENSE_KEY_ID || env.YIBIAO_LICENSE_KEY_ID || buildAttestation?.keyId || 'official-build-key-2026-01', 80),
    build: normalizeBuildInfo(buildAttestation),
    config: {
      freeLicenseDays: config.freeLicenseDays,
      expirePopupEnabled: config.expirePopupEnabled !== false,
      expirePopupDismissible: config.expirePopupDismissible !== false,
    },
  };

  try {
    const signature = await signPayload(env, payload);
    return json({ code: 0, license: { payload, signature } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[license] activate failed', error?.message || String(error));
    return json({ code: 500, message: 'license signing failed' }, { status: 500 });
  }
}

export async function handleLicenseConfig(request, env, url) {
  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  if (request.method === 'GET') {
    const projectName = normalizeText(url.searchParams.get('projectName'), 80);
    if (!isValidProjectName(projectName)) {
      return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
    }
    return json({ code: 0, config: await readLicenseConfig(env, projectName) }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ code: 400, message: 'invalid json body' }, { status: 400 });
    }
    try {
      return json({ code: 0, config: await saveLicenseConfig(env, body) }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      console.error('[license] save config failed', error?.message || String(error));
      return json({ code: 400, message: internalErrorMessage(error, 'save failed') }, { status: 400 });
    }
  }

  return methodNotAllowed();
}

export async function handleOfflineLicense(request, env) {
  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid json body' }, { status: 400 });
  }

  const projectName = normalizeText(body.projectName || body.project_name, 80);
  const clientId = normalizeText(body.clientId || body.client_id, 120);
  if (!isValidProjectName(projectName) || !clientId) {
    return json({ code: 400, message: 'invalid params' }, { status: 400 });
  }

  let expiresAt;
  try {
    expiresAt = normalizeExpiresAt(body.expiresAt || body.expires_at);
  } catch {
    return json({ code: 400, message: 'invalid expiresAt' }, { status: 400 });
  }

  // 展示口径与在线激活通道同源：统一读取项目级 KV 配置，故障时回落归一默认值。
  const licenseConfig = await resolveLicenseConfigOrDefaults(env, projectName);

  const payload = {
    schemaVersion: 1,
    activationMode: 'offline',
    projectName,
    appId: normalizeText(body.appId || body.app_id, 120) || DEFAULT_APP_ID,
    productName: normalizeText(body.productName || body.product_name, 120) || DEFAULT_PRODUCT_NAME,
    clientId,
    clientCreatedAt: normalizeText(body.clientCreatedAt || body.client_created_at, 20).slice(0, 10),
    machineFingerprintHash: normalizeText(body.machineFingerprintHash || body.machine_fingerprint_hash, 128),
    fingerprintVersion: normalizeText(body.fingerprintVersion || body.fingerprint_version, 40) || FINGERPRINT_VERSION,
    plan: 'offline',
    status: 'active',
    issuedAt: new Date().toISOString(),
    expiresAt,
    sourceTrusted: true,
    sourceTrustedText: 'true',
    untrustedReason: '',
    keyId: normalizeText(env.LICENSE_KEY_ID || env.YIBIAO_LICENSE_KEY_ID || 'official-build-key-2026-01', 80),
    build: normalizeBuildInfo(null),
    config: {
      freeLicenseDays: licenseConfig.freeLicenseDays,
      expirePopupEnabled: licenseConfig.expirePopupEnabled !== false,
      expirePopupDismissible: licenseConfig.expirePopupDismissible !== false,
    },
  };

  try {
    const signature = await signPayload(env, payload);
    const license = { payload, signature };
    return json({ code: 0, license, licenseCode: encodeOfflineLicenseCode(license) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[license] offline signing failed', error?.message || String(error));
    return json({ code: 500, message: 'license signing failed' }, { status: 500 });
  }
}
