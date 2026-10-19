import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { migrationFixture, upgradeFileHashes } from '../../tests/helpers/upgrade_migration_fixture.mjs';
import { inspectRestoreTransaction } from '../tools/recovery/restore_transaction_status.mjs';
import { validateOperationLedger } from '../tools/recovery/operation_ledger.mjs';
import { validateNotificationReceipt } from '../tools/stage5/email_receipt.mjs';

test('completed ledger, receipt and nine data owners survive migration without reactivation or source changes', async t => {
  const f = await migrationFixture(t, { schema: 5, history: true });
  const result = await f.execute(); assert.equal(result.status, 'committed'); assert.equal(result.ownerCoverage.length, 9);
  assert.ok(result.ownerCoverage.every(owner => owner.status === 'covered'));
  for (const file of ['operation_ledger.json', 'stage5/email_receipt.json']) {
    const relative = path.join('review_results/pipeline/dummy-history', file);
    assert.deepEqual(await fs.readFile(path.join(f.target, relative)), await fs.readFile(path.join(f.data, relative)));
  }
  assert.equal(validateOperationLedger(JSON.parse(await fs.readFile(path.join(f.target, 'review_results/pipeline/dummy-history/operation_ledger.json')))).status, 'completed');
  assert.equal(validateNotificationReceipt(JSON.parse(await fs.readFile(path.join(f.target, 'review_results/pipeline/dummy-history/stage5/email_receipt.json')))).status, 'accepted');
  assert.equal(result.doctor.canRun, false); assert.equal(result.reactivatedClaims, false);
  assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes); assert.equal((await f.recover({ rollback: true })).status, 'rolled-back');
});

test('staging ENOSPC and postpublication Doctor failure roll back without modifying source or backup', async t => {
  for (const cause of ['disk', 'doctor']) {
    const f = await migrationFixture(t, { secret: false }); const archive = await fs.readFile(f.backup); let fired = false;
    const fsApi = { ...fs, open: async (...args) => {
      if (cause === 'disk' && args[1] === 'wx' && path.basename(args[0]) === '.paperecho-restore.json') { fired = true; throw Object.assign(new Error('DUMMY_DISK_FULL'), { code: 'ENOSPC' }); }
      return fs.open(...args);
    } };
    await assert.rejects(f.execute({ service: { fsApi, hook: async phase => {
      if (cause === 'doctor' && phase === 'NEW_PUBLISHED') { fired = true; await fs.unlink(path.join(f.targetApp, 'resources/core/workflow/tools/web/static/index.html')); }
    } } }), e => e.code === (cause === 'disk' ? 'ENOSPC' : 'RESTORE_DOCTOR_BLOCKED'));
    assert.equal(fired, true); assert.equal(inspectRestoreTransaction(f.target).state, 'ROLLED_BACK');
    assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes); assert.deepEqual(await fs.readFile(f.backup), archive);
    assert.equal((await f.recover()).status, 'rolled-back');
  }
});

test('real unsafe Secret DACL is rejected during staging; junctions and unsupported plans never publish', async t => {
  const f = await migrationFixture(t);
  const script = `$ErrorActionPreference='Stop';$file=[IO.FileInfo]::new($env:TEST_FILE);$acl=[IO.FileSystemAclExtensions]::GetAccessControl($file,[Security.AccessControl.AccessControlSections]::Access);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'));[IO.FileSystemAclExtensions]::SetAccessControl($file,$acl);$again=[IO.FileSystemAclExtensions]::GetAccessControl($file,[Security.AccessControl.AccessControlSections]::Access);if (@($again.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -eq 'S-1-1-0' -and $_.AccessControlType -eq 'Allow'}).Count -lt 1) {throw 'FIXTURE_INVALID'}`;
  let fired = false;
  await assert.rejects(f.execute({ service: { hook: async (phase, { stage }) => {
    if (phase !== 'STAGING_before-publish') return; fired = true;
    await promisify(execFile)(process.env.PWSH_PATH || 'pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEST_FILE: path.join(stage, '.env') } });
  } } }), /CREDENTIAL_ACL_UNSAFE/);
  assert.equal(fired, true); assert.equal(inspectRestoreTransaction(f.target).state, 'ROLLED_BACK'); assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes);
  const other = await migrationFixture(t, { secret: false }), alias = path.join(other.data, 'linked-directory');
  await fs.symlink(path.join(other.root, 'new-program'), alias, 'junction');
  await assert.rejects(other.execute(), /BACKUP_PATH_UNSAFE/); await fs.unlink(alias);
  for (const schema of [1, 2, 999]) {
    await fs.writeFile(path.join(other.root, 'plan.json'), JSON.stringify({ ...other.plan, sourceSchema: schema }));
    await assert.rejects(other.execute(), /UPGRADE_EXECUTION_PATH_BLOCKED/);
  }
  assert.equal(inspectRestoreTransaction(other.target).state, 'ABSENT');
});
