import { ALLOWED_EVENTS, DATASET } from '../constants.js';
import { json, methodNotAllowed, requireAdmin, unauthorized } from '../http.js';
import { queryAnalytics } from '../services/analyticsQuery.js';
import { businessDateRangeCondition, businessDateTimeSqlExpression, getBusinessDateDaysAgo, getBusinessToday, isValidProjectName, logQueryError, normalizeText, safePage, sqlString } from '../utils.js';

export async function handleLatest(request, env, url) {
  if (request.method !== 'GET') {
    return methodNotAllowed();
  }

  if (!requireAdmin(request, env)) {
    return unauthorized();
  }

  const projectName = normalizeText(url.searchParams.get('projectName'), 80);
  const page = safePage(url.searchParams.get('page'));
  const event = normalizeText(url.searchParams.get('event'), 50);
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  if (!isValidProjectName(projectName) || (event && !ALLOWED_EVENTS.has(event))) {
    return json({ code: 400, message: 'invalid params' }, { status: 400 });
  }

  const project = sqlString(projectName);
  const eventCondition = event ? `AND blob2 = ${sqlString(event)}` : '';
  // 近 90 天业务日窗口（与 projects.js 的 AE 兜底查询一致）：
  // 原始事件保留在 AE 中不受影响，这里只是限制管理端分页扫描范围，避免全历史扫描推高 AE 行扫描成本。
  const dateWindow = businessDateRangeCondition(getBusinessDateDaysAgo(89), getBusinessToday());

  const totalSql = `
    SELECT
      SUM(_sample_interval) AS total
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND ${dateWindow}
      ${eventCondition}
  `;

  const sql = `
    SELECT
      ${businessDateTimeSqlExpression()} AS eventTime,
      blob1 AS projectName,
      blob2 AS event,
      blob3 AS page,
      blob4 AS version,
      blob5 AS platform,
      blob6 AS arch,
      blob7 AS clientId,
      blob8 AS clientCreatedAt
    FROM ${DATASET}
    WHERE blob1 = ${project}
      AND ${dateWindow}
      ${eventCondition}
    ORDER BY eventTime DESC, clientId DESC, event DESC, page DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  try {
    const [latest, total] = await Promise.all([
      queryAnalytics(env, sql),
      queryAnalytics(env, totalSql),
    ]);
    return json({
      code: 0,
      page,
      pageSize,
      event,
      total: Number(total.data?.[0]?.total || 0),
      // AE 的 WHERE 中 timestamp 会被 SELECT 别名遮蔽成 String，因此查询内
      // 使用 eventTime 别名，返回给客户端时仍保持 timestamp 字段名。
      events: (latest.data || []).map((row) => {
        const { eventTime, ...rest } = row;
        return { ...rest, timestamp: eventTime };
      }),
    });
  } catch (error) {
    logQueryError('latest', error);
    return json({ code: 500, message: 'query failed' }, { status: 500 });
  }
}
