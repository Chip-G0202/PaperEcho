import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { transactionFixture, testPassword, fileHashes } from '../../tests/helpers/restore_transaction_fixture.mjs';
import { restoreTransactionRoot, inspectRestoreTransaction } from '../tools/recovery/restore_transaction_status.mjs';
import { backupMain } from '../tools/runner/backup.mjs';
import { resolveApplicationRuntimeContext } from '../tools/lib/runtime_config.mjs';
import { createControlServices } from '../tools/lib/control_application_services.mjs';
import { acquireWorkflowLease } from '../tools/recovery/operation_ledger.mjs';
import { RuntimeLog } from '../tools/lib/runtime_logging.mjs';
import { startControlCenter } from '../tools/web/server.mjs';

test('explicit CLI confirmation is independent of password; readonly preflight and concurrent admission preserve data', async t => {
  const f = await transactionFixture(t), before = await fileHashes(f.target); let output = '';
  const stdin = new PassThrough(); stdin.end('dummy-transaction-password\n');
  assert.equal(await backupMain(['--restore-existing', f.input, '--target-data-root', f.target, '--password-stdin'], { env: f.env, stdin, stdout: { write: v => output += v } }), 2);
  assert.equal(JSON.parse(output).code, 'RESTORE_CONFIRMATION_REQUIRED'); assert.deepEqual(await fileHashes(f.target), before);
  let entered, release; const waiting = new Promise(r => entered = r), gate = new Promise(r => release = r);
  const running = f.make({ hook: async phase => { if (phase === 'PREPARED') { entered(); await gate; } } }).replace({ input: f.input, target: f.target, password: testPassword(), confirm: async () => true });
  try {
    await waiting;
    await assert.rejects(f.replace(), /RESTORE_TRANSACTION_RETAINED/);
    await assert.rejects(acquireWorkflowLease({ runRoot: path.join(f.target, 'local/runs'), runId: 'dummy-active', profile: 'standard' }), /RESTORE_RECOVERY_REQUIRED/);
    const env = { ...f.env, PAPERECHO_DATA_ROOT: f.target }, context = await resolveApplicationRuntimeContext({ env, readOnly: true });
    const services = createControlServices({ root: f.app, context, env });
    assert.equal((await new RuntimeLog({ env }).write('RUNNER_STARTED')).ok, false);
    await assert.rejects(fs.access(path.join(f.target, 'logs')));
    const report = await services.doctor.status(); assert.equal(report.canRun, false); assert.equal(report.checks.find(c => c.checkId === 'restore.transaction').status, 'FAIL');
    const setup = await services.setup.status(); assert.equal(setup.restoreRequired, true); assert.equal(setup.needsSetup, false);
  } finally { release(); }
  assert.equal((await running).status, 'committed');
});

test('unsafe real DACL, unknown schedule claim, tampered backup and occupied files fail safely', async t => {
  const f = await transactionFixture(t), before = await fileHashes(f.target);
  const decisions = path.join(f.target, 'review_results/schedule_decisions/v1'); await fs.mkdir(decisions, { recursive: true });
  await fs.writeFile(path.join(decisions, '2026-10-17.json'), '{"schemaVersion":1}');
  await assert.rejects(f.replace(), /RESTORE_CLAIM_UNKNOWN/); await fs.unlink(path.join(decisions, '2026-10-17.json'));
  const bytes = await fs.readFile(f.input); bytes[48] ^= 1; const altered = path.join(f.home, 'tampered.pebackup'); await fs.writeFile(altered, bytes);
  await assert.rejects(f.replace({ input: altered }), /BACKUP_AUTH_FAILED/);
  assert.equal(inspectRestoreTransaction(f.target).state, 'ABSENT');
  const script = `$ErrorActionPreference='Stop';$file=[IO.FileInfo]::new($env:TEST_FILE);$acl=[IO.FileSystemAclExtensions]::GetAccessControl($file,[Security.AccessControl.AccessControlSections]::Access);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'));[IO.FileSystemAclExtensions]::SetAccessControl($file,$acl);$again=[IO.FileSystemAclExtensions]::GetAccessControl($file,[Security.AccessControl.AccessControlSections]::Access);if (@($again.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -eq 'S-1-1-0' -and $_.AccessControlType -eq 'Allow'}).Count -lt 1) {throw 'FIXTURE_INVALID'}`;
  await assert.rejects(f.make({ hook: async (phase, { stage }) => {
    if (phase !== 'STAGING_before-publish') return;
    await promisify(execFile)(process.env.PWSH_PATH || 'pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 1024, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEST_FILE: path.join(stage, '.env') } });
  } }).replace({ input: f.input, target: f.target, password: testPassword(), confirm: async () => true }), /CREDENTIAL_ACL_UNSAFE/);
  assert.deepEqual(await fileHashes(f.target), before); assert.equal(inspectRestoreTransaction(f.target).state, 'ROLLED_BACK');
  const occupied = await transactionFixture(t), original = await fileHashes(occupied.target); let handle;
  try {
    await assert.rejects(occupied.make({ hook: async phase => { if (phase === 'PREPARED') handle = await fs.open(path.join(occupied.target, 'input.json'), 'r'); } }).replace({ input: occupied.input, target: occupied.target, password: testPassword(), confirm: async () => true }), e => e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
  } finally { await handle?.close(); }
  assert.deepEqual(await fileHashes(occupied.target), original);
});

test('journal ENOSPC and postpublication Doctor failure cannot commit and retain the original root', async t => {
  for (const cause of ['journal', 'doctor']) {
    const f = await transactionFixture(t), before = await fileHashes(f.target); let fired = false;
    const fsApi = { ...fs, open: async (...args) => {
      const h = await fs.open(...args); if (cause !== 'journal' || args[1] !== 'wx') return h;
      return { writeFile: async value => { let record; try { record = JSON.parse(value); } catch {}
        if (record?.state === 'NEW_PUBLISHED' && !fired) { fired = true; throw Object.assign(new Error('DUMMY_DISK_FULL'), { code: 'ENOSPC' }); }
        return h.writeFile(value); }, sync: () => h.sync(), close: () => h.close() };
    } };
    await assert.rejects(f.make({ fsApi, hook: async (phase, { target }) => {
      if (cause === 'doctor' && phase === 'NEW_PUBLISHED') { fired = true; await fs.unlink(path.join(f.app, 'workflow/tools/web/static/index.html')); }
    } }).replace({ input: f.input, target: f.target, password: testPassword(), confirm: async () => true }));
    assert.equal(fired, true); assert.deepEqual(await fileHashes(f.target), before);
    assert.equal(inspectRestoreTransaction(f.target).state, 'ROLLED_BACK');
    await fs.access(path.join(restoreTransactionRoot(f.target), 'rejected'));
  }
});

test('a Control Center opened on the old directory cannot mutate the replacement workspace', async t => {
  const f = await transactionFixture(t), env = { ...f.env, PAPERECHO_DATA_ROOT: f.target };
  const context = await resolveApplicationRuntimeContext({ env, readOnly: true });
  const services = createControlServices({ root: f.app, context, env });
  const running = await startControlCenter({ root: f.app, context, services, env, port: 0 });
  try {
    await f.replace(); const before = await fileHashes(f.target);
    const session = await fetch(running.url + '/api/session'), cookie = session.headers.get('set-cookie').split(';')[0], { token } = await session.json();
    const response = await fetch(running.url + '/api/settings', { method: 'POST', headers: { cookie, origin: running.url, 'x-csrf-token': token, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 409); assert.equal((await response.json()).error, 'WORKSPACE_CHANGED');
    assert.deepEqual(await fileHashes(f.target), before);
  } finally { running.server.closeAllConnections(); await new Promise(resolve => running.server.close(resolve)); }
});

test('selected current root requires a stable external runtime cache before replacement or crash recovery', async t => {
  const f = await transactionFixture(t), before = await fileHashes(f.target);
  const current = { ...f.env, PAPERECHO_DATA_ROOT: f.target };
  await assert.rejects(f.make({ env: current }).preflight({ input: f.input, target: f.target, password: testPassword() }), /RESTORE_TEMP_CONFLICT/);
  assert.deepEqual(await fileHashes(f.target), before); assert.equal(inspectRestoreTransaction(f.target).state, 'ABSENT');
  const cache = path.join(f.home, 'runtime-cache'); await fs.mkdir(path.join(cache, 'tmp'), { recursive: true });
  const service = f.make({ env: { ...current, PAPERECHO_CACHE_ROOT: cache } });
  const result = await service.replace({ input: f.input, target: f.target, password: testPassword(), confirm: async () => true });
  assert.equal(result.status, 'committed');
  assert.equal((await service.recover({ target: f.target, rollback: true, confirm: async () => true })).status, 'rolled-back');
  assert.deepEqual(await fileHashes(f.target), before);
});
