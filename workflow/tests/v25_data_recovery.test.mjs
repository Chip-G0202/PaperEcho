import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { migrationFixture, upgradePassword, upgradeFileHashes } from '../../tests/helpers/upgrade_migration_fixture.mjs';
import { blockMigrationNetwork, terminateMigrationAt, recoverMigrationInFreshProcess } from '../../tests/helpers/upgrade_migration_process.mjs';
import { BackupService, BACKUP_DATA_OWNERS } from '../tools/lib/backup_service.mjs';
import { sha256 } from '../tools/lib/backup_format.mjs';
import { UPGRADE_COMPATIBILITY } from '../tools/lib/upgrade_preflight_service.mjs';
import { resolveRuntimePaths } from '../tools/lib/runtime_config.mjs';
import { secureCredentialFile } from '../tools/lib/credential_file_security.mjs';
import { createControlServices } from '../tools/lib/control_application_services.mjs';
import { readCanonicalFeedback } from '../tools/lib/control_feedback_service.mjs';
import { ResearchEvaluationService } from '../tools/lib/research_evaluation_service.mjs';
import { validateOperationLedger } from '../tools/recovery/operation_ledger.mjs';
import { validateNotificationReceipt } from '../tools/stage5/email_receipt.mjs';
import { inspectRestoreTransaction, restoreTransactionRoot, assertRestoreWritable } from '../tools/recovery/restore_transaction_status.mjs';
import { runPreflight } from '../tools/runner/preflight.mjs';
import net from 'node:net';
import tls from 'node:tls';

test('migration offline guard detects forbidden HTTP, TCP and TLS attempts and restores the original transports', () => {
  const original = [globalThis.fetch, net.connect, tls.connect], guard = blockMigrationNetwork();
  try {
    for (const call of [() => fetch('https://fixture.invalid'), () => net.connect(1, 'fixture.invalid'), () => tls.connect(1, 'fixture.invalid')]) {
      assert.throws(call, /MIGRATION_EXTERNAL_CALL_FORBIDDEN/);
    }
    assert.equal(guard.calls, 3);
  } finally { guard.restore(); }
  assert.deepEqual([globalThis.fetch, net.connect, tls.connect], original);
});

function offline(t) {
  const network = blockMigrationNetwork();
  t.after(() => { network.restore(); assert.equal(network.calls, 0, 'migration must never contact a provider or notification transport'); });
}
async function intact(f, backupSha) {
  assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes);
  assert.equal(sha256(await fs.readFile(f.backup)), backupSha);
  await secureCredentialFile(path.join(f.data, '.env'), { checkOnly: true });
}
const targetEnvironment = (f, layout = 'installed') => ({ ...f.hostEnv, PAPERECHO_LAYOUT: layout, PAPERECHO_DATA_ROOT: f.target });
async function blockedAdmission(f, layout, reason) {
  const report = await runPreflight({ mode: 'local', profile: 'standard', input: path.join(f.target, 'input.json'), outputRoot: path.join(f.target, 'local') },
    { env: targetEnvironment(f, layout), repoRoot: f.targetApp });
  assert.equal(report.canRun, false); assert.ok(report.requiredMissing.some(item => item.name === reason));
}
async function preservedOwners(f, manifest) {
  assert.deepEqual(Object.keys(manifest.ownerInventory).sort(), [...BACKUP_DATA_OWNERS].sort());
  assert.ok(BACKUP_DATA_OWNERS.every(owner => manifest.ownerInventory[owner] > 0));
  for (const file of manifest.files) assert.equal(sha256(await fs.readFile(path.join(f.target, file.path))), file.sha256, `owner bytes: ${file.owner}`);
  const review = path.join(f.target, 'review_results/文献评价');
  const feedback = await readCanonicalFeedback(review); assert.equal(feedback.history.length, 1); assert.equal(feedback.history[0].feedback, 'upgrade');
  const events = await new ResearchEvaluationService({ root: f.target, reviewRoot: review }).snapshotEvents();
  assert.equal(events.find(event => event.requestId === 'dummy-direction').status, 'pending');
  const history = path.join(f.target, 'review_results/pipeline/dummy-history');
  assert.equal(validateOperationLedger(JSON.parse(await fs.readFile(path.join(history, 'operation_ledger.json')))).status, 'completed');
  assert.equal(validateNotificationReceipt(JSON.parse(await fs.readFile(path.join(history, 'stage5/email_receipt.json')))).status, 'accepted');
  const items = JSON.parse(await fs.readFile(path.join(history, 'triaged_items.json'))); assert.equal(items[0].journal, '合成测试期刊');
  await secureCredentialFile(path.join(f.target, '.env'), { checkOnly: true });
}

test('v2.5 schema6 data contract reaches fresh Installed and Portable roots without conversion, lost owners or activation', async t => {
  offline(t);
  const contract = await fs.readFile(new URL('../../tests/helpers/upgrade-v2.5-runtime-contract.txt', import.meta.url), 'utf8');
  assert.equal(sha256(contract.replace(/\r\n/g, '\n')), UPGRADE_COMPATIBILITY.legacyRuntimeSha256);
  assert.equal(UPGRADE_COMPATIBILITY.taggedSchema, 6);
  for (const layout of ['installed', 'portable']) await t.test(layout, async t => {
    const f = await migrationFixture(t, { schema: 6, history: true, targetLayout: layout });
    assert.equal(f.beforeBackup.status, 'UNKNOWN'); assert.equal(f.beforeBackup.source.releaseLine, '2.5');
    assert.equal(f.beforeBackup.source.evidence, 'pinned-tag-runtime-contract'); assert.equal(f.beforeBackup.source.revision, UPGRADE_COMPATIBILITY.legacyTag);
    const before = await upgradeFileHashes(f.root), backupSha = sha256(await fs.readFile(f.backup));
    const preview = await f.inspect(); assert.equal(preview.status, 'PASS'); assert.equal(preview.executionAllowed, false);
    assert.equal(preview.source.schema, 6); assert.equal(preview.plan.targetSchema, 6); assert.equal(preview.plan.scheduler, 'KEEP_ABSENT_DO_NOT_ENABLE');
    assert.deepEqual(await upgradeFileHashes(f.root), before); await assert.rejects(fs.lstat(f.target), e => e.code === 'ENOENT');
    const backups = new BackupService(); assert.equal((await backups.verify({ input: f.backup, password: upgradePassword() })).authenticated, true);
    await assert.rejects(backups.verify({ input: f.backup, password: Buffer.from('dummy-wrong-data-password') }), /BACKUP_AUTH_FAILED/);
    let manifest; await backups.withVerifiedContents({ input: f.backup, password: upgradePassword() }, value => { manifest = structuredClone(value); }, false);
    await fs.mkdir(f.target); await fs.writeFile(path.join(f.target, 'must-survive'), 'dummy-existing-data', { flag: 'wx' });
    await assert.rejects(f.execute(), /UPGRADE_PLAN_STALE_OR_BLOCKED/); assert.equal(await fs.readFile(path.join(f.target, 'must-survive'), 'utf8'), 'dummy-existing-data');
    await fs.unlink(path.join(f.target, 'must-survive')); await fs.rmdir(f.target);
    const result = await f.execute(); assert.equal(result.status, 'committed');
    assert.deepEqual(result.conversion, ['config-schema6-no-op', 'nine-owner-integrity', 'history-remains-inactive']);
    assert.equal(result.ownerCoverage.length, 9); assert.ok(result.ownerCoverage.every(owner => owner.status === 'covered'));
    assert.equal(resolveRuntimePaths({ env: targetEnvironment(f, layout) }).userDataRoot, f.target);
    assert.equal(result.reactivatedClaims, false); assert.equal(result.osMutation, false); await preservedOwners(f, manifest);
    const receipt = JSON.parse(await fs.readFile(path.join(f.target, '.paperecho-restore.json'))); assert.equal(receipt.workflowAllowed, false);
    const snapshot = await upgradeFileHashes(f.target);
    const doctor = await createControlServices({ root: f.targetApp, env: targetEnvironment(f, layout) }).doctor.status();
    assert.equal(doctor.checks.find(c => c.checkId === 'restore.transaction').status, 'PASS');
    await blockedAdmission(f, layout, 'restored history review');
    assert.equal((await f.execute()).operationId, result.operationId);
    const recovered = await recoverMigrationInFreshProcess(f); assert.equal(recovered.status, 'committed'); assert.equal(recovered.operationId, result.operationId);
    assert.deepEqual(await upgradeFileHashes(f.target), snapshot); await intact(f, backupSha);
    assert.equal((await recoverMigrationInFreshProcess(f, { rollback: true })).status, 'rolled-back');
    await assert.rejects(fs.lstat(f.target), e => e.code === 'ENOENT'); await intact(f, backupSha);
  });
});

test('v2.5 controlled postpublication failure rolls back with protected credentials and a repeatable fresh-process recovery', async t => {
  offline(t);
  const f = await migrationFixture(t, { schema: 6, history: true }); const backupSha = sha256(await fs.readFile(f.backup)); let fired = false;
  await assert.rejects(f.execute({ service: { hook: async phase => { if (phase === 'NEW_PUBLISHED') { fired = true; throw new Error('DUMMY_V25_FAILURE'); } } } }), /DUMMY_V25_FAILURE/);
  assert.equal(fired, true); assert.equal(inspectRestoreTransaction(f.target).state, 'ROLLED_BACK');
  await secureCredentialFile(path.join(restoreTransactionRoot(f.target), 'rejected/.env'), { checkOnly: true });
  const recovered = await recoverMigrationInFreshProcess(f); assert.equal(recovered.status, 'rolled-back');
  assert.deepEqual(await recoverMigrationInFreshProcess(f), recovered); await intact(f, backupSha);
  await assert.rejects(fs.lstat(f.target), e => e.code === 'ENOENT');
});

test('v2.5 schema6 process crashes preserve the journal, block writers and recover idempotently in a new process', async t => {
  offline(t);
  for (const phase of ['PREPARED', 'NEW_PUBLISHED', 'COMMITTED']) await t.test(phase, async t => {
    const f = await migrationFixture(t, { schema: 6, history: true }); const backupSha = sha256(await fs.readFile(f.backup));
    await terminateMigrationAt(f, phase);
    const committed = phase === 'COMMITTED'; assert.equal(inspectRestoreTransaction(f.target).blocking, !committed);
    assert.equal(inspectRestoreTransaction(f.data).blocking, !committed);
    if (!committed) {
      assert.throws(() => assertRestoreWritable(f.context.configPath), /RESTORE_RECOVERY_REQUIRED/);
      await assert.rejects(f.execute(), /UPGRADE_RECOVERY_REQUIRED/);
      await blockedAdmission(f, 'installed', 'restore transaction');
    }
    const recovered = await recoverMigrationInFreshProcess(f); assert.equal(recovered.status, committed ? 'committed' : 'rolled-back');
    assert.deepEqual(await recoverMigrationInFreshProcess(f), recovered); await intact(f, backupSha);
    assert.equal(inspectRestoreTransaction(f.data).blocking, false);
    if (committed) { await blockedAdmission(f, 'installed', 'restored history review'); assert.equal((await recoverMigrationInFreshProcess(f, { rollback: true })).status, 'rolled-back'); }
    await assert.rejects(fs.lstat(f.target), e => e.code === 'ENOENT');
  });
});
