import { NOTICE_CONTENT_MAX_LENGTH, NOTICE_TITLE_MAX_LENGTH } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import {
  buildNoticeKey,
  deleteStoredNotice,
  incrementDeliveredUserCount,
  listProjectNotices,
  readProjectNotice,
  readStoredNotice,
  restoreStoredNotice,
  saveStoredNotice,
  writeLatestNotice,
} from '../services/noticeStore.js';
import { getRequestClientIp, isValidProjectName, normalizeText, shouldSkipDuplicateWrite } from '../utils.js';

function normalizeBooleanValue(value, defaultValue = true) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return defaultValue;
}
import { rejectOversizedBody } from '../http.js';

export async function handlePublicNotice(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  try {
    const notice = await readProjectNotice(env, projectName);
    return json({
      code: 0,
      notice: notice?.enabled && notice.content ? notice : null,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] public notice failed', error?.message || String(error));
    return json({ code: 0, notice: null }, { headers: { 'Cache-Control': 'no-store' } });
  }
}

// 接收客户端公告弹窗展示后的送达计数。
export async function handlePublicNoticeDelivered(request, env) {
  if (request.method !== 'POST') {
    return methodNotAllowed();
  }

  if (!env.RESOURCE_DB) {
    return json({ code: 500, message: 'notice database is not configured' }, { status: 500 });
  }

  const oversized = rejectOversizedBody(request, 2048);
  if (oversized) return oversized;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid json body' }, { status: 400 });
  }

  const projectName = normalizeText(body.projectName || body.project_name, 80);
  const noticeId = normalizeText(body.noticeId || body.notice_id, 80);
  if (!isValidProjectName(projectName) || !noticeId) {
    return json({ code: 400, message: 'invalid projectName or noticeId' }, { status: 400 });
  }

  // 同一出口 IP 对同一公告的重复送达 60s 内只计一次，防公开端点被刷计数/写配额
  if (shouldSkipDuplicateWrite(`notice-delivered:${getRequestClientIp(request)}|${projectName}/${noticeId}`)) {
    return json({ code: 0 }, { headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const deliveredUserCount = await incrementDeliveredUserCount(env, projectName, noticeId);
    if (deliveredUserCount === null) {
      return json({ code: 404, message: 'notice not found' }, { status: 404 });
    }
    return json({ code: 0, deliveredUserCount }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] notice delivered count failed', error?.message || String(error));
    return json({ code: 500, message: 'notice delivered count failed' }, { status: 500 });
  }
}

export async function handleAdminNotice(request, env, url) {
  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  if (!env.RESOURCE_DB || !env.NOTICE_STORE) {
    return json({ code: 500, message: 'notice storage is not configured' }, { status: 500 });
  }

  if (request.method === 'GET') {
    return handleAdminGetNotice(env, url);
  }

  if (request.method === 'POST') {
    return handleAdminSaveNotice(request, env);
  }

  if (request.method === 'DELETE') {
    return handleAdminDeleteNotice(env, url);
  }

  return methodNotAllowed();
}

async function handleAdminGetNotice(env, url) {
  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  try {
    const [notices, currentNotice] = await Promise.all([
      listProjectNotices(env, projectName),
      readProjectNotice(env, projectName),
    ]);
    return json({
      code: 0,
      notices: notices.map((notice) => ({
        ...notice,
        current: currentNotice?.id === notice.clientNoticeId,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[analytics] admin notices query failed', error?.message || String(error));
    return json({ code: 500, message: 'notices query failed' }, { status: 500 });
  }
}

async function handleAdminSaveNotice(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ code: 400, message: 'invalid json body' }, { status: 400 });
  }

  const id = normalizeText(body.id, 120);
  const projectName = normalizeText(body.projectName || body.project_name, 80);
  const title = normalizeText(body.title, NOTICE_TITLE_MAX_LENGTH);
  const content = normalizeText(body.content || body.markdown, NOTICE_CONTENT_MAX_LENGTH);

  if (!isValidProjectName(projectName)) {
    return json({ code: 400, message: 'invalid projectName' }, { status: 400 });
  }

  if (!title) {
    return json({ code: 400, message: 'missing title' }, { status: 400 });
  }

  if (!content) {
    return json({ code: 400, message: 'missing content' }, { status: 400 });
  }

  try {
    // 快照更新前的旧行：KV 写失败时用于把 D1 恢复回旧 client_notice_id 与送达计数
    //（若在 saveStoredNotice 之后才读，读到的已是新值，补偿形同虚设）。
    const previous = id ? await readStoredNotice(env, projectName, id).catch(() => null) : null;
    const notice = await saveStoredNotice(env, {
      id,
      projectName,
      enabled: normalizeBooleanValue(body.enabled, true),
      title,
      content,
    });
    if (!notice) {
      return json({ code: 404, message: 'notice not found' }, { status: 404 });
    }
    try {
      // 更新分支（有 id）失败时恢复旧行并回写 KV，避免 D1 已换代而 KV 仍是旧公告、
      // 且 delivered_user_count 被重置的静默分叉（新增分支保持整行回滚）。
      await writeLatestNotice(env, notice);
    } catch (error) {
      if (!id) {
        await deleteStoredNotice(env, projectName, notice.id).catch(() => undefined);
      } else if (previous) {
        await restoreStoredNotice(env, previous).catch(() => undefined);
        await writeLatestNotice(env, previous).catch(() => undefined);
      }
      console.error('[analytics] notice KV sync failed', error?.message || String(error));
      return json({ code: 500, message: 'notice save failed (KV sync)' }, { status: 500 });
    }
    return json({ code: 0, notice: { ...notice, current: true } });
  } catch (error) {
    console.error('[analytics] save notice failed', error?.message || String(error));
    return json({ code: 500, message: 'notice save failed' }, { status: 500 });
  }
}

async function handleAdminDeleteNotice(env, url) {
  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const id = normalizeText(url.searchParams.get('id'), 120);
  if (!isValidProjectName(projectName) || !id) {
    return json({ code: 400, message: 'invalid projectName or id' }, { status: 400 });
  }

  try {
    const notice = await readStoredNotice(env, projectName, id);
    if (!notice) {
      return json({ code: 404, message: 'notice not found' }, { status: 404 });
    }
    // 先删 D1 行，再依据删除后的最新 current 决定是否清 KV：
    // 避免基于并发保存前的旧快照判定误删新公告的 KV，或 KV 先删后 D1 失败留下「可见却取不到」的分叉。
    await deleteStoredNotice(env, projectName, id);
    const remaining = await readProjectNotice(env, projectName).catch(() => null);
    if (!remaining) {
      await env.NOTICE_STORE.delete(buildNoticeKey(projectName));
    }
    return json({ code: 0, notice: null });
  } catch (error) {
    console.error('[analytics] delete notice failed', error?.message || String(error));
    return json({ code: 500, message: 'notice delete failed' }, { status: 500 });
  }
}
