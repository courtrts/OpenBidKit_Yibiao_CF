const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

// 迁移漂移护栏：schemaVersion 必须与 migrations 最高版本一致，
// 否则新装库首启升到超出支持版本、二次启动被「版本高于当前客户端」拒绝，
// 存量用户的后续迁移（如 v24 可研导出选项列）永不执行。
// 注意：better-sqlite3 为 Electron ABI 编译，裸 node 无法实例化 Database，
// 这里用 stub db 验证迁移执行器的版本语义（真实 DDL 由 addColumnIfMissing /
// CREATE INDEX IF NOT EXISTS 的幂等性保证，与其他 20+ 迁移同模式）。
const { migrations, schemaVersion, applyMigrations } = require('./sqliteDatabase.cjs');

// 目录必须存在（生产由 createSqliteDatabase 的 mkdirSync 保证），文件不存在以跳过备份；
// clearDatabaseBackupFiles 会对所在目录做 readdirSync 备份清理。
const NON_EXISTENT_DB_PATH = path.join(os.tmpdir(), `zcode-migration-test-yibiao-${process.pid}.sqlite`);

function createStubDb(initialVersion) {
  const state = {
    userVersion: initialVersion,
    appliedVersions: [],
    executedSql: [],
  };
  return {
    _state: state,
    pragma(name, opts) {
      if (name === 'user_version' && opts && opts.simple) return state.userVersion;
      const match = /^user_version\s*=\s*(\d+)/.exec(String(name || ''));
      if (match) {
        state.userVersion = Number(match[1]);
        state.appliedVersions.push(state.userVersion);
        return null;
      }
      return null;
    },
    prepare() {
      return {
        all() {
          // 表/列清单一律视为空：健康修复分支退化为幂等 no-op 执行，
          // 测试聚焦迁移执行器的版本推进语义而非真实 DDL。
          return [];
        },
        run() {
          return { changes: 0 };
        },
        get() {
          return undefined;
        },
      };
    },
    exec(sql) {
      state.executedSql.push(sql);
    },
    transaction(fn) {
      return (arg) => fn(arg);
    },
  };
}

test('迁移版本护栏：migrations 最高版本与 schemaVersion 一致（防漂移）', () => {
  const versions = migrations.map((item) => item.version).sort((a, b) => a - b);
  assert.strictEqual(versions.length, migrations.length, '迁移不可缺失');
  assert.strictEqual(new Set(versions).size, versions.length, '迁移版本不可重复');
  for (let i = 1; i < versions.length; i += 1) {
    assert.ok(versions[i] > versions[i - 1], `迁移版本必须严格递增：${versions[i - 1]} → ${versions[i]}`);
  }
  assert.strictEqual(
    Math.max(...versions),
    schemaVersion,
    `migrations 最高版本（${Math.max(...versions)}）必须等于 schemaVersion（${schemaVersion}）`,
  );
});

test('迁移执行器：全新库从 0 升级到 schemaVersion，且二次启动不再抛错', () => {
  const fresh = createStubDb(0);
  applyMigrations(fresh, NON_EXISTENT_DB_PATH);
  assert.strictEqual(fresh._state.userVersion, schemaVersion, '全新库必须升级到 schemaVersion');
  assert.deepStrictEqual(
    fresh._state.appliedVersions,
    migrations.map((item) => item.version).sort((a, b) => a - b),
    '全新库必须按版本升序补跑全部迁移',
  );

  // 二次启动：user_version === schemaVersion → 仅健康检查、零迁移、不抛错
  const secondLaunch = createStubDb(schemaVersion);
  applyMigrations(secondLaunch, NON_EXISTENT_DB_PATH);
  assert.strictEqual(secondLaunch._state.userVersion, schemaVersion);
  assert.deepStrictEqual(secondLaunch._state.appliedVersions, [], '已达最高版本时不得再执行迁移');
});

test('迁移执行器：存量 v23 库补齐 v24（可研导出选项列）等缺失迁移', () => {
  const legacy = createStubDb(23);
  applyMigrations(legacy, NON_EXISTENT_DB_PATH);
  assert.strictEqual(legacy._state.userVersion, schemaVersion);
  assert.deepStrictEqual(legacy._state.appliedVersions, [24, 25], '存量 v23 库必须且只补跑 v24/v25');
});

test('迁移执行器：高于支持版本的库抛出友好错误（提示升级客户端）', () => {
  const tooNew = createStubDb(schemaVersion + 1);
  assert.throws(
    () => applyMigrations(tooNew, NON_EXISTENT_DB_PATH),
    /高于当前客户端支持版本/,
    '更高版本必须拒绝迁移并给出可行动提示',
  );
});
