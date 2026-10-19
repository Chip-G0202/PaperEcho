import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { migrationFixture, upgradeFileHashes } from '../../tests/helpers/upgrade_migration_fixture.mjs';
import { inspectRestoreTransaction, restoreTransactionRoot, assertRestoreWritable } from '../tools/recovery/restore_transaction_status.mjs';
import { secureCredentialFile } from '../tools/lib/credential_file_security.mjs';
import { UpgradeMigrationService } from '../tools/lib/upgrade_migration_service.mjs';
import { acquireWorkflowLease, acquireRunLease } from '../tools/recovery/operation_ledger.mjs';
import { readBoundedJson } from '../tools/lib/atomic_json.mjs';

test('real schema3 migration uses the canonical converter, preserves nine owners and original bytes, and rollback is idempotent', async t => {
  const f = await migrationFixture(t, { schema: 3 });
  const result = await f.execute(); assert.equal(result.status, 'committed');
  assert.deepEqual(result.conversion, ['config-3-to-6', 'nine-owner-integrity', 'history-remains-inactive']);
  assert.equal(result.ownerCoverage.length, 9); assert.ok(result.ownerCoverage.every(owner => owner.status === 'covered'));
  const upgraded = JSON.parse(await fs.readFile(path.join(f.target, 'config/paperecho.config.json')));
  assert.equal(upgraded.schemaVersion, 6); assert.equal(upgraded.common.notifications.channels.wechat.enabled, false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.target, 'config/paperecho.config.json.v3-backup'))), f.config);
  assert.equal(result.doctor.checks.find(c => c.checkId === 'configuration').status, 'PASS');
  assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes);
  await secureCredentialFile(path.join(f.target, '.env'), { checkOnly: true });
  assert.equal(JSON.parse(await fs.readFile(path.join(f.target, '.paperecho-restore.json'))).workflowAllowed, false);
  const repeated = await f.execute(); assert.equal(repeated.operationId, result.operationId); assert.equal(repeated.status, 'committed');
  const rollback = await f.recover({ rollback: true }); assert.equal(rollback.status, 'rolled-back');
  await assert.rejects(fs.lstat(f.target), e => e.code === 'ENOENT');
  assert.equal(inspectRestoreTransaction(f.target).blocking, false);
  assert.equal((await f.recover()).operationId, result.operationId);
  assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes);
});

test('schema4/5 conversions are real; schema6 Portable relocation is byte-preserving with historical activation blocked', async t => {
  for (const [schema, targetLayout] of [[4, 'installed'], [5, 'installed'], [6, 'portable']]) {
    const f = await migrationFixture(t, { schema, targetLayout });
    const result = await f.execute(); assert.equal(result.status, 'committed');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.target, 'config/paperecho.config.json'))).schemaVersion, 6);
    if (schema === 6) assert.deepEqual(await fs.readFile(path.join(f.target, 'config/paperecho.config.json')), await fs.readFile(f.context.configPath));
    else assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.target, `config/paperecho.config.json.v${schema}-backup`))), f.config);
    assert.equal(result.doctor.canRun, false); assert.equal(result.reactivatedClaims, false);
    assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes);
    await f.recover({ rollback: true }); assert.equal(inspectRestoreTransaction(f.target).state, 'ROLLED_BACK');
  }
});

test('ordinary roots, absent confirmation, edited plans and changed source content are rejected before publication', async t => {
  const f = await migrationFixture(t, { secret: false });
  await assert.rejects(new UpgradeMigrationService({ env: f.hostEnv }).execute({ workspace: path.join(f.root, 'ordinary-user-data') }), /UPGRADE_ISOLATED_WORKSPACE_REQUIRED/);
  await assert.rejects(f.make().execute({ workspace: f.root }), /UPGRADE_CONFIRMATION_REQUIRED/);
  const file = path.join(f.root, 'plan.json');
  await fs.writeFile(file, JSON.stringify({ ...f.plan, configHash: '0'.repeat(64) }));
  await assert.rejects(f.execute(), /UPGRADE_PLAN_STALE_OR_BLOCKED/); await fs.writeFile(file, JSON.stringify(f.plan));
  await fs.appendFile(path.join(f.data, 'input.json'), ' '); const changed = await upgradeFileHashes(f.data);
  await assert.rejects(f.execute(), /UPGRADE_PLAN_STALE_OR_BLOCKED/);
  assert.deepEqual(await upgradeFileHashes(f.data), changed); assert.equal(inspectRestoreTransaction(f.target).state, 'ABSENT');
  await assert.rejects(fs.lstat(f.target), e => e.code === 'ENOENT');
});

test('unknown configuration, active lease and links remain blocked; low space and wrong password never publish', async t => {
  const f = await migrationFixture(t, { secret: false });
  await assert.rejects(f.execute({ password: Buffer.from('dummy-wrong-migration-password') }), /UPGRADE_PLAN_STALE_OR_BLOCKED/);
  await assert.rejects(f.execute({ service: { volume: async () => ({ filesystem: 'NTFS', freeBytes: 0n }) } }), /UPGRADE_PLAN_STALE_OR_BLOCKED/);
  await fs.writeFile(f.context.configPath, JSON.stringify({ ...f.config, unknownPrivateField: 'dummy-never-discard' }));
  await assert.rejects(f.execute(), /UPGRADE_PLAN_STALE_OR_BLOCKED/); await fs.writeFile(f.context.configPath, JSON.stringify(f.config));
  const lease = path.join(f.context.runRoot, '.workflow.lease.json'); await fs.mkdir(path.dirname(lease), { recursive: true }); await fs.writeFile(lease, '{}');
  await assert.rejects(f.execute(), /RESTORE_WORKSPACE_BUSY/); await fs.unlink(lease);
  const linked = path.join(f.data, 'linked-input.json'); await fs.link(path.join(f.data, 'input.json'), linked);
  await assert.rejects(f.execute(), /BACKUP_PATH_UNSAFE/); await fs.unlink(linked);
  assert.equal(inspectRestoreTransaction(f.target).state, 'ABSENT'); await assert.rejects(fs.lstat(f.target), e => e.code === 'ENOENT');
});

test('staging, conversion, prepublish and postpublish failures roll back while the original root stays byte-identical', async t => {
  for (const step of ['STAGING_staging-created', 'CONVERT_BEFORE', 'PREPARED', 'NEW_PUBLISHED', 'VERIFIED']) {
    const f = await migrationFixture(t, { schema: 3, secret: false }); let injected = false;
    await assert.rejects(f.execute({ service: { hook: async phase => { if (phase === step) { injected = true; throw new Error('dummy-injected-migration-failure'); } } } }), /dummy-injected-migration-failure/);
    assert.equal(injected, true); assert.equal(inspectRestoreTransaction(f.target).state, 'ROLLED_BACK');
    assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes); await assert.rejects(fs.lstat(f.target), e => e.code === 'ENOENT');
    assert.equal((await f.recover()).status, 'rolled-back');
  }
});

test('concurrent execution and both workspace writers fail closed; forged staging capabilities do not bypass admission', async t => {
  const f = await migrationFixture(t, { secret: false }); let entered, release, conversions = 0;
  const ready = new Promise(r => entered = r), gate = new Promise(r => release = r);
  const options = { service: { hook: async phase => { if (phase === 'CONVERT_BEFORE') conversions++; if (phase === 'PREPARED') { entered(); await gate; } } } };
  const run = f.execute(options);
  try {
    await ready;
    assert.equal(inspectRestoreTransaction(f.data).blocking, true); assert.equal(inspectRestoreTransaction(f.target).blocking, true);
    await assert.rejects(f.execute(), /UPGRADE_RECOVERY_REQUIRED/);
    assert.throws(() => assertRestoreWritable(f.context.configPath), /RESTORE_RECOVERY_REQUIRED/);
    await assert.rejects(fs.lstat(f.context.runRoot), e => e.code === 'ENOENT');
    await assert.rejects(acquireWorkflowLease({ runRoot: f.context.runRoot, runId: 'dummy-active', profile: 'standard' }), /RESTORE_RECOVERY_REQUIRED/);
    await assert.rejects(acquireRunLease({ runRoot: f.context.runRoot, runId: 'dummy-active' }), /RESTORE_RECOVERY_REQUIRED/);
    await assert.rejects(fs.lstat(f.context.runRoot), e => e.code === 'ENOENT');
    const root = restoreTransactionRoot(f.target), staged = path.join(root, 'new/config/paperecho.config.json');
    assert.throws(() => assertRestoreWritable(staged, { stagingGuard: { root, assertHeld() {} } }), /RESTORE_RECOVERY_REQUIRED/);
    const record = await readBoundedJson(root, path.join(root, 'status.json')); assert.equal(record.upgrade.planId, f.plan.id);
  } finally { release(); }
  assert.equal((await run).status, 'committed'); assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes);
  assert.doesNotThrow(() => assertRestoreWritable(f.context.configPath));
  assert.equal((await f.execute(options)).status, 'committed'); assert.equal(conversions, 1);
  const status = path.join(restoreTransactionRoot(f.target), 'status.json'), saved = await fs.readFile(status);
  try { await fs.writeFile(status, '{}'); assert.throws(() => assertRestoreWritable(path.join(f.target, 'config/paperecho.config.json')), /RESTORE_RECOVERY_REQUIRED/); }
  finally { await fs.writeFile(status, saved); }
  assert.equal((await f.recover()).status, 'committed'); assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes);
});

test('optional scheduler is retained without registration; external credentials cannot be silently copied', async t => {
  const scheduler = { schemaVersion: 1, enabled: false, time: '15:00', timezone: 'Asia/Shanghai' };
  const f = await migrationFixture(t, { legacy: false, scheduler });
  const before = await fs.readFile(f.context.configPath); await f.execute();
  assert.deepEqual(await fs.readFile(path.join(f.target, 'config/paperecho.config.json')), before);
  assert.deepEqual(JSON.parse(before).scheduler, scheduler); assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes);
  const external = await migrationFixture(t, { secret: false });
  await assert.rejects(new UpgradeMigrationService({ env: { ...external.hostEnv, SMTP_PASS: 'dummy-external-not-copied' } }).execute({ workspace: external.root, password: Buffer.from('dummy-upgrade-fixture-password'), confirm: async () => true }), /UPGRADE_PLAN_STALE_OR_BLOCKED/);
  await assert.rejects(fs.lstat(external.target), e => e.code === 'ENOENT');
});
