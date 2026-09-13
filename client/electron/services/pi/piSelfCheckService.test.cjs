'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { sanitizeDiagnosisInput } = require('./piSelfCheckService.cjs');
const SERVICE_SOURCE = fs.readFileSync(path.join(__dirname, 'piSelfCheckService.cjs'), 'utf-8');

test('C1 JSON 序列化形态的 Windows 用户路径整段脱敏（修复前正则失效原样外发）', () => {
  const input = {
    environment: {
      app: { user_data: 'C:\\Users\\Admin\\AppData\\Roaming\\yibiao' },
      paths: { runtime_root: 'D:\\temp\\temp\\OpenBidKit\\client\\agent-runtime\\pi' },
    },
  };
  const sanitized = sanitizeDiagnosisInput(input);
  assert.ok(!sanitized.includes('Admin'), '用户名不得外发');
  assert.ok(!sanitized.includes('Users'), '路径段不得残留');
  assert.ok(sanitized.includes('%LOCAL_PATH%'), '应替换为占位符');
  assert.ok(sanitized.includes('runtime_root'), 'JSON 键名应保留供定位');
});

test('C1 错误堆栈中的本机路径脱敏（真实形态：内存单反斜杠，序列化后为转义形态）', () => {
  const input = {
    agent_check: {
      error: { message: 'EPERM: operation not permitted', stack: 'Error: EPERM\n    at D:\\temp\\app\\services\\pi\\piRuntimeService.cjs:1498:20' },
    },
  };
  const sanitized = sanitizeDiagnosisInput(input);
  assert.ok(!sanitized.includes('piRuntimeService.cjs'), '堆栈中的路径段不得外发');
  assert.ok(!sanitized.includes('temp'), '路径盘符目录不得外发');
  assert.ok(sanitized.includes('%LOCAL_PATH%'), '应替换为占位符');
  assert.ok(sanitized.includes('EPERM'), '错误形态信息应保留供诊断');
});

test('C1 POSIX 家目录脱敏（/home 与 /Users）', () => {
  const sanitized = sanitizeDiagnosisInput({ home: '/home/alice/work', mac: '/Users/bob/data' });
  assert.ok(!sanitized.includes('alice'), 'POSIX 用户名不得外发');
  assert.ok(!sanitized.includes('bob'), 'macOS 用户名不得外发');
  assert.strictEqual((sanitized.match(/%LOCAL_PATH%/g) || []).length, 2);
});

test('C1 远程 URL 与主机路径不受影响（不误伤诊断价值）', () => {
  const input = { base_url: 'https://api.example.com/v1', odd: 'https://home/segment' };
  const sanitized = sanitizeDiagnosisInput(input);
  assert.ok(sanitized.includes('https://api.example.com/v1'), '正常端点不得被改写');
  assert.ok(sanitized.includes('https://home/segment'), 'URL 主机路径不得被误伤');
});

test('C1 凭据类键名置 [REDACTED]（既有口径保持）', () => {
  const sanitized = sanitizeDiagnosisInput({ api_key: 'sk-secret', Authorization: 'Bearer x', refresh_token: 't' });
  assert.ok(!sanitized.includes('sk-secret'));
  assert.ok(!sanitized.includes('Bearer x'));
  assert.ok(!sanitized.includes('"t"'));
  assert.strictEqual((sanitized.match(/\[REDACTED\]/g) || []).length, 3);
});

test('C1 超长诊断输入截断到 24000（既有上限保持）', () => {
  const sanitized = sanitizeDiagnosisInput({ blob: 'x'.repeat(40000) });
  assert.ok(sanitized.length <= 24000);
});

test('C1 诊断输入净化必须位于 AI 请求内容构造之前（源断言）', () => {
  const start = SERVICE_SOURCE.indexOf('async function analyzePiSelfCheckWithModel(');
  assert.notStrictEqual(start, -1);
  const region = SERVICE_SOURCE.slice(start, SERVICE_SOURCE.indexOf('\n}', start));
  assert.match(region, /sanitizeDiagnosisInput\(input\)/);
  // 旧的单反斜杠 Users 正则必须已被替换（对 JSON 转义文本无效）
  assert.ok(!SERVICE_SOURCE.includes("replace(/[A-Za-z]:\\\\Users\\\\[^\\\\\"\\\\s]+/g, '%USERPROFILE%')"));
});
