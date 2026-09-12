const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { gzip } = require('node:zlib');

const gzipAsync = promisify(gzip);
const SENSITIVE_KEY_PATTERN = /api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|mineru[_-]?token|password|passwd|secret|cookie|session[_-]?token/i;

// 收集配置中的全部凭据值，用于清除错误文本和任务正文中的已知密钥。
function collectConfiguredSecrets(value, secrets = new Set(), ancestors = new WeakSet()) {
  if (!value || typeof value !== 'object' || ancestors.has(value)) return secrets;
  ancestors.add(value);
  try {
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key) && typeof item === 'string' && item.trim()) secrets.add(item);
      if (item && typeof item === 'object') collectConfiguredSecrets(item, secrets, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
  return secrets;
}

// 清除字符串中的已配置凭据和常见认证信息格式。
// 除 config 原值外，还按形态匹配常见 API 密钥（sk-* / AWS AKIA*）：工作区文件
// 与 LLM 响应里可能出现 config 之外的密钥（.env、agent 读写的 token），仅靠
// config 原值替换覆盖不到。
function redactText(value, configuredSecrets) {
  let text = String(value || '');
  for (const secret of configuredSecrets) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    // 以字面量 :// 为锚点：旧写法“贪婪 * 紧跟必选 ://”在无 :// 的大文本上
    // 会二次回溯（256KB 即分钟级挂起）；锚点后各段字符集互斥，线性扫描。
    .replace(/:\/\/[^\s/@:]*:[^\s/@]*@/g, '://[REDACTED]:[REDACTED]@')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&#\s]*/gi, '$1[REDACTED]');
}

function redactBinary(buffer, configuredSecrets) {
  const result = Buffer.from(buffer);
  for (const secret of configuredSecrets) {
    const secretBuffer = Buffer.from(secret, 'utf-8');
    if (!secretBuffer.length) continue;
    let offset = result.indexOf(secretBuffer);
    while (offset >= 0) {
      result.fill(42, offset, offset + secretBuffer.length);
      offset = result.indexOf(secretBuffer, offset + secretBuffer.length);
    }
  }
  return result;
}

// 将诊断数据转换为可序列化结构，并在独立进程中完成全部脱敏。
function sanitizeValue(value, configuredSecrets, ancestors = new WeakSet(), keyName = '') {
  if (SENSITIVE_KEY_PATTERN.test(keyName)) return value ? '[REDACTED]' : value;
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return redactText(value, configuredSecrets);
  if (typeof value === 'function') return `[Function:${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return String(value);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { type: 'Buffer', encoding: 'base64', data: redactBinary(Buffer.from(value), configuredSecrets).toString('base64') };
  }
  if (value instanceof Date) return value.toISOString();
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, configuredSecrets, ancestors));
    const result = {};
    for (const key of Object.getOwnPropertyNames(value)) {
      try {
        result[key] = sanitizeValue(value[key], configuredSecrets, ancestors, key);
      } catch (error) {
        result[key] = `[Unreadable:${redactText(error?.message || error, configuredSecrets)}]`;
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function isProbablyText(buffer) {
  if (!buffer.length) return true;
  return !buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

// 工作区采集预算：此前无上限递归读全归档，超大工作区会让独立进程内存尖峰，
// 且压缩后仍可能超过服务端 10MB 上限整包丢失。诊断价值集中在小文件（任务输出、
// 日志），大文件只保留元数据。
const MAX_WORKSPACE_FILES = 200;
const MAX_TEXT_FILE_CONTENT_BYTES = 256 * 1024;
const MAX_BINARY_FILE_CONTENT_BYTES = 64 * 1024;
const MAX_WORKSPACE_TOTAL_CONTENT_BYTES = 4 * 1024 * 1024;
// 敏感目录整体跳过（.git 历史可能含凭据且体积巨大）；敏感文件名模式命中时
// 只保留元数据、不上传正文（凭据文件即使经过脱敏也不应离开用户机器）。
const SENSITIVE_DIR_NAMES = new Set(['.git', 'node_modules']);
const SENSITIVE_FILE_NAME_PATTERN = /^\.env(\..+)?$|\.(key|pem|p12|pfx|keystore|jks|der)$|^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$|credential/i;

// 在独立进程中读取任务归档，不阻塞 Electron 主进程。
function collectWorkspaceFiles(rootDir, configuredSecrets) {
  const root = String(rootDir || '').trim();
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  let totalContentBytes = 0;
  function visit(currentDir) {
    if (files.length >= MAX_WORKSPACE_FILES) return;
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (files.length >= MAX_WORKSPACE_FILES) return;
      const filePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!SENSITIVE_DIR_NAMES.has(entry.name.toLowerCase())) visit(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(filePath);
      const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
      if (SENSITIVE_FILE_NAME_PATTERN.test(entry.name)) {
        files.push({
          path: relativePath,
          size: stat.size,
          modified_at: stat.mtime.toISOString(),
          redacted: 'sensitive-file',
        });
        continue;
      }
      if (totalContentBytes >= MAX_WORKSPACE_TOTAL_CONTENT_BYTES) {
        files.push({
          path: relativePath,
          size: stat.size,
          modified_at: stat.mtime.toISOString(),
          skipped: 'content-budget-exhausted',
        });
        continue;
      }
      const maxContentBytes = stat.size > MAX_TEXT_FILE_CONTENT_BYTES ? MAX_TEXT_FILE_CONTENT_BYTES : stat.size;
      const fileDescriptor = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(Math.min(maxContentBytes, stat.size));
      try {
        fs.readSync(fileDescriptor, buffer, 0, buffer.length, 0);
      } finally {
        fs.closeSync(fileDescriptor);
      }
      const textFile = isProbablyText(buffer);
      if (!textFile && stat.size > MAX_BINARY_FILE_CONTENT_BYTES) {
        // 大二进制（图片/PDF/压缩包）诊断价值低且撑大报告，只留元数据。
        files.push({
          path: relativePath,
          size: stat.size,
          modified_at: stat.mtime.toISOString(),
          skipped: 'large-binary',
        });
        continue;
      }
      // 不能命名为 entry：会遮蔽 for 循环变量并让循环体前部的 entry 引用
      // 落入 TDZ（Cannot access 'entry' before initialization）。
      const fileEntry = {
        path: relativePath,
        absolute_path: redactText(filePath, configuredSecrets),
        size: stat.size,
        modified_at: stat.mtime.toISOString(),
        encoding: textFile ? 'utf-8' : 'base64',
        content: textFile ? redactText(buffer.toString('utf-8'), configuredSecrets) : redactBinary(buffer, configuredSecrets).toString('base64'),
      };
      if (stat.size > buffer.length) fileEntry.truncated = `前 ${buffer.length} 字节，共 ${stat.size} 字节`;
      files.push(fileEntry);
      totalContentBytes += buffer.length;
    }
  }
  visit(root);
  return files;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
}

function createReportMeta(job, error, originalBytes, compressedBytes, configuredSecrets) {
  return {
    schemaVersion: job.schemaVersion,
    reportId: job.reportId,
    projectName: job.projectName,
    occurredAt: job.occurredAt,
    version: job.app.version,
    platform: job.app.platform,
    arch: job.app.arch,
    clientId: job.client.clientId,
    clientCreatedAt: job.client.clientCreatedAt,
    runtime: job.runtimeId,
    model: redactText(job.config?.model_name || '', configuredSecrets).slice(0, 160),
    errorName: redactText(error?.name || 'Error', configuredSecrets).slice(0, 120),
    errorCode: redactText(error?.code || error?.cause?.code || '', configuredSecrets).slice(0, 120),
    errorSummary: redactText(error?.message || 'Agent 执行失败', configuredSecrets).slice(0, 1000),
    originalBytes,
    compressedBytes,
  };
}

// 独立进程完成完整诊断包构造、压缩和上传。
async function runReport(job) {
  const configuredSecrets = [...collectConfiguredSecrets(job.config)].filter(Boolean).sort((left, right) => right.length - left.length);
  const error = job.error;
  const report = {
    schema_version: job.schemaVersion,
    report_id: job.reportId,
    occurred_at: job.occurredAt,
    app: sanitizeValue(job.app, configuredSecrets),
    client: {
      client_id: job.client.clientId,
      client_created_at: job.client.clientCreatedAt,
      license_payload: sanitizeValue(job.license.payload, configuredSecrets),
    },
    system: {
      os: {
        type: os.type(),
        release: os.release(),
        version: os.version(),
        arch: os.arch(),
        hostname: os.hostname(),
        total_memory: os.totalmem(),
        free_memory: os.freemem(),
        cpus: os.cpus().map((cpu) => ({ model: cpu.model, speed: cpu.speed })),
      },
      process: sanitizeValue(job.mainProcess, configuredSecrets),
      report_process: { pid: process.pid },
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      paths: sanitizeValue(job.paths, configuredSecrets),
    },
    runtime: job.runtimeId,
    task: sanitizeValue(job.task, configuredSecrets),
    user_task_context: sanitizeValue(job.userTaskContext || {}, configuredSecrets),
    error: sanitizeValue(error, configuredSecrets),
    config: sanitizeValue(job.config, configuredSecrets),
    workspace: {
      root: redactText(job.workspaceDir, configuredSecrets),
      files: collectWorkspaceFiles(job.workspaceDir, configuredSecrets),
    },
  };
  const source = Buffer.from(JSON.stringify(report), 'utf-8');
  const compressed = await gzipAsync(source, { level: 6 });
  if (!compressed.length || compressed.length > job.maxCompressedBytes) return;
  const meta = createReportMeta(job, error, source.length, compressed.length, configuredSecrets);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), job.uploadTimeoutMs);
  try {
    const response = await fetch(job.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(compressed.length),
        'X-Yibiao-Report-Meta': base64UrlJson(meta),
        'X-Yibiao-License': base64UrlJson(job.license),
      },
      body: compressed,
      signal: controller.signal,
    });
    await response.arrayBuffer().catch(() => undefined);
  } finally {
    clearTimeout(timeout);
  }
}

// 仅在 utilityProcess 环境（有 parentPort）注册消息入口，普通 node 进程
// require 本文件（单元测试）时不会因 parentPort 缺失而崩溃。
if (process.parentPort) {
  process.parentPort.once('message', (event) => {
    void runReport(event.data)
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}

// 测试导出：采集与脱敏纯函数供 node --test 直接断言，utilityProcess.fork
// 入口不依赖 module.exports，生产路径行为不变。
module.exports = {
  __test: {
    collectWorkspaceFiles,
    redactText,
    sanitizeValue,
  },
};
