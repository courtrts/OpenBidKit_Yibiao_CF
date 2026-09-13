'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_SOURCE = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf-8');
const { userFacingTaskError } = require('../utils/taskErrorText.cjs');

function regionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notStrictEqual(start, -1, `未找到起始标记：${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notStrictEqual(end, -1, `未找到结束标记：${endMarker}`);
  return source.slice(start, end);
}

test('C1 占位通道错误文案经 userFacingTaskError 净化（不再拼接 raw error.message）', () => {
  const region = regionBetween(INDEX_SOURCE, 'function registerUnavailableWorkspaceDatabaseIpc(', 'function registerWorkspaceDatabaseStatusIpc');
  assert.match(region, /userFacingTaskError\(error, '本地数据库初始化失败，请重启应用重试'\)/);
  assert.ok(!region.includes('工作区数据库初始化失败：${'), 'raw 模板拼接必须移除');
  assert.match(region, /console\.error\('\[ipc\] 工作区数据库初始化失败', error\)/, '诊断通道必须保留原始错误');
});

test('C1 状态事件 message 同口径净化（门控屏直显面）', () => {
  const region = regionBetween(INDEX_SOURCE, 'const startWorkspaceDatabase = () => {', 'if (mainWindow.webContents.isLoading())');
  assert.match(region, /message: userFacingTaskError\(error, '本地数据库初始化失败，请重启应用重试'\)/);
  assert.ok(!region.includes('本地数据库初始化失败：${'), 'raw 模板拼接必须移除');
});

test('C1 净化保留版本过新标记文案（门控屏「下载新版客户端」联动不破坏）', () => {
  const tooNew = new Error('本地数据库版本 26 高于当前客户端支持版本 25，请升级客户端后再使用技术方案功能。');
  const sanitized = userFacingTaskError(tooNew, '兜底');
  assert.match(sanitized, /高于当前客户端支持版本/);
  assert.match(sanitized, /请升级客户端/);
});

test('C1 SQLite 风格 raw 消息脱敏：本机路径替换、换行剥离、长度截断', () => {
  const raw = new Error('SQLITE_CANTOPEN: unable to open database file at C:\\Users\\Admin\\AppData\\Roaming\\yibiao\\workspace.db\nin prepare');
  const sanitized = userFacingTaskError(raw, '兜底');
  assert.ok(!sanitized.includes('C:\\Users'), '本机路径不得残留');
  assert.match(sanitized, /\[路径\]/);
  assert.ok(!sanitized.includes('\n'), '换行必须剥离');
  assert.ok(sanitized.length <= 200);

  const long = new Error('x'.repeat(5000));
  assert.ok(userFacingTaskError(long, '兜底').length <= 200);
});
