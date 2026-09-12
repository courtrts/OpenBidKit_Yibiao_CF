const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { __test } = require('./agentErrorReportProcess.cjs');

const { collectWorkspaceFiles, redactText } = __test;

function makeTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-agent-error-test-'));
}

test('redactText 形态脱敏：sk- 密钥、AWS AKIA、config 原值、query token', () => {
  const secrets = new Set(['my-configured-secret-value']);
  assert.match(redactText('key is sk-abcdefghijklmnopqrstuvwxyz123456 here', secrets), /\[REDACTED\]/);
  assert.doesNotMatch(redactText('key is sk-abcdefghijklmnopqrstuvwxyz123456 here', secrets), /sk-abc/);
  assert.match(redactText('aws AKIAIOSFODNN7EXAMPLE end', secrets), /\[REDACTED\]/);
  assert.match(redactText('value=my-configured-secret-value', secrets), /\[REDACTED\]/);
  assert.match(redactText('Bearer abc123.def456', secrets), /Bearer \[REDACTED\]/);
  assert.match(redactText('https://x.com/?access_token=zzz999', secrets), /access_token=\[REDACTED\]/);
  // 短随机串不误伤（低于 16 位不认为是密钥）
  assert.equal(redactText('prefix sk-short1 suffix', secrets), 'prefix sk-short1 suffix');
});

test('collectWorkspaceFiles：敏感文件只留元数据、大文件截断、预算与文件数上限', () => {
  const root = makeTempWorkspace();
  try {
    fs.writeFileSync(path.join(root, 'task-output.txt'), 'hello task output');
    fs.writeFileSync(path.join(root, '.env'), 'OPENAI_API_KEY=sk-secretsecretsecretsecret');
    fs.writeFileSync(path.join(root, 'api.key'), '-----BEGIN RSA PRIVATE KEY-----');
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'config'), '[core]');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'log.txt'), 'x'.repeat(300 * 1024));
    const binaryChunk = Buffer.alloc(100 * 1024, 1);
    binaryChunk.fill(0, 0, 4096);
    fs.writeFileSync(path.join(root, 'archive.bin'), binaryChunk);
    fs.writeFileSync(path.join(root, 'tiny.bin'), Buffer.from([1, 0, 2, 3]));

    const files = collectWorkspaceFiles(root, new Set());
    const byPath = new Map(files.map((file) => [file.path, file]));

    // 普通文本文件全文在包内
    assert.equal(byPath.get('task-output.txt')?.content, 'hello task output');
    assert.equal(byPath.get('task-output.txt')?.truncated, undefined);

    // 敏感文件：只有元数据，无 content/absolute_path
    const envEntry = byPath.get('.env');
    assert.equal(envEntry?.redacted, 'sensitive-file');
    assert.equal(envEntry?.content, undefined);
    assert.equal(envEntry?.absolute_path, undefined);
    assert.equal(byPath.get('api.key')?.redacted, 'sensitive-file');

    // 敏感目录整体跳过
    assert.equal(byPath.has('.git/config'), false);

    // 大文本文件截断到 256KB 并标注
    const logEntry = byPath.get('sub/log.txt');
    assert.equal(logEntry?.content.length, 256 * 1024);
    assert.match(logEntry?.truncated || '', /共 307200 字节/);

    // 大二进制只留元数据
    const binEntry = byPath.get('archive.bin');
    assert.equal(binEntry?.skipped, 'large-binary');
    assert.equal(binEntry?.content, undefined);

    // 小二进制保留内容
    assert.equal(typeof byPath.get('tiny.bin')?.content, 'string');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectWorkspaceFiles：正文总量超过 4MB 预算后仅保留元数据', () => {
  const root = makeTempWorkspace();
  try {
    // 17 个 300KB 文件：每个截断到 256KB 正文，16 个正好装满 4MB 预算，
    // 第 17 个应只剩元数据（content-budget-exhausted）。
    for (let index = 0; index < 17; index += 1) {
      fs.writeFileSync(path.join(root, `chunk-${index}.txt`), 'y'.repeat(300 * 1024));
    }
    const files = collectWorkspaceFiles(root, new Set());
    const withContent = files.filter((file) => typeof file.content === 'string');
    const budgetExhausted = files.filter((file) => file.skipped === 'content-budget-exhausted');
    assert.ok(withContent.length >= 1, '应有部分文件带正文');
    assert.ok(budgetExhausted.length >= 1, '超预算文件应只留元数据');
    const totalContent = withContent.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf-8'), 0);
    assert.ok(totalContent <= 4 * 1024 * 1024 + 256 * 1024, '正文总量不应远超预算');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectWorkspaceFiles：文件数超过 200 上限后停止采集', () => {
  const root = makeTempWorkspace();
  try {
    for (let index = 0; index < 205; index += 1) {
      fs.writeFileSync(path.join(root, `file-${String(index).padStart(3, '0')}.txt`), 'line');
    }
    const files = collectWorkspaceFiles(root, new Set());
    assert.ok(files.length <= 200, `文件数应不超过 200，实际 ${files.length}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('collectWorkspaceFiles：不存在的目录返回空数组', () => {
  assert.deepEqual(collectWorkspaceFiles(path.join(os.tmpdir(), 'yibiao-does-not-exist-x'), new Set()), []);
});
