import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { upgradeFixture, upgradePassword, upgradeFileHashes, writeUpgradeFixture as write } from '../../tests/helpers/upgrade_fixture.mjs';
import { UpgradePreflightService, UPGRADE_COMPATIBILITY } from '../tools/lib/upgrade_preflight_service.mjs';
import { inspectBackupSources } from '../tools/lib/backup_service.mjs';
import { resolveRuntimePaths } from '../tools/lib/runtime_config.mjs';
import { main } from '../tools/runner/main.mjs';
import { restoreTransactionRoot } from '../tools/recovery/restore_transaction_status.mjs';
import { createOperationLedger } from '../tools/recovery/operation_ledger.mjs';
import { inspectRestoreVolume } from '../tools/lib/restore_filesystem.mjs';
const status = (report, id) => report.checks.find(c => c.checkId === id)?.status;
async function unchanged(f, action) { const before = await upgradeFileHashes(f.root); const report = await action(); assert.deepEqual(await upgradeFileHashes(f.root), before); return report; }
test('pinned v2.5 evidence is schema 6; 3/4/5 use existing pure chain; all owners and originals remain intact', async t => {
  for (const schema of [3, 4, 5, 6]) {
    const f = await upgradeFixture(t, { legacy: true, schema });
    const report = await unchanged(f, () => f.inspect()); assert.equal(report.status, 'PASS', JSON.stringify(report.checks));
    assert.equal(report.source.releaseLine, '2.5'); assert.equal(report.source.evidence, 'pinned-tag-runtime-contract');
    assert.equal(report.source.schema, schema); assert.equal(report.target.schema, 6); assert.equal(report.executionAllowed, false);
    assert.equal(report.plan.owners.length, 9); assert.ok(report.plan.owners.every(o => o.status === 'covered'));
    assert.equal(report.plan.scheduler, 'KEEP_ABSENT_DO_NOT_ENABLE'); assert.equal(report.plan.rollback.actualCrossVersionRestoreTested, false);
    assert.deepEqual(await f.inspect(), report); assert.equal(UPGRADE_COMPATIBILITY.taggedSchema, 6);
    const completed = new Set(); for (const step of report.plan.steps) { assert.ok(step.requires.every(id => completed.has(id))); completed.add(step.id); }
  }
});
test('current schema 6 and source layouts have stable offline plans, and target Portable/Installed remain distinct', async t => {
  for (const layout of ['dev', 'portable', 'installed']) for (const targetLayout of ['portable', 'installed']) {
    const f = await upgradeFixture(t, { layout, targetLayout, secret: false });
    const report = await unchanged(f, () => f.inspect()); assert.equal(report.status, 'PASS', JSON.stringify(report.checks));
    assert.equal(report.source.releaseLine, '2.6'); assert.equal(report.plan.sourceLayout, layout); assert.equal(report.plan.targetLayout, targetLayout);
    assert.equal(report.plan.secrets.localFile, false); assert.equal(report.plan.owners.find(o => o.id === 'secrets').status, 'not-present');
  }
});
test('legacy schema 1/2 are readable but full domain/env merge cannot be claimed as a safe readonly migration', async t => {
  for (const schema of [1, 2]) {
    const f = await upgradeFixture(t, { legacy: true, schema, secret: false });
    const r = await unchanged(f, () => f.inspect()); assert.equal(r.status, 'BLOCKED'); assert.equal(status(r, 'config.legacyDomainMerge'), 'BLOCKED');
    assert.equal(r.plan, undefined); assert.equal(r.executionAllowed, false);
  }
});
test('tagged v2.5 cannot claim the later scheduler extension despite sharing schema 6', async t => {
  const f = await upgradeFixture(t, { legacy: true, secret: false });
  await write(f.context.configPath, { ...f.config, scheduler: { schemaVersion: 1, enabled: false, time: '15:00', timezone: 'Asia/Shanghai' } });
  const r = await unchanged(f, () => f.inspect()); assert.equal(r.status, 'BLOCKED'); assert.equal(status(r, 'UPGRADE_SOURCE_SCHEDULER_UNSUPPORTED'), 'BLOCKED');
});
test('unknown schema, missing config, unknown version, corrupt or conflicting release evidence fail closed', async t => {
  const f = await upgradeFixture(t, { secret: false });
  for (const schemaVersion of [999, null]) { await write(f.context.configPath, { ...f.config, schemaVersion }); assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED'); }
  await fs.unlink(f.context.configPath); assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED'); await write(f.context.configPath, f.config);
  const metadata = path.join(f.app, 'resources/core/package.json'); await fs.unlink(metadata);
  const unknown = await unchanged(f, () => f.inspect()); assert.equal(unknown.status, 'UNKNOWN'); assert.equal(status(unknown, 'source.version'), 'UNKNOWN');
  await write(metadata, '{'); assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED');
  await write(metadata, { name: 'paperecho-core', version: '2.7.0' }); assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED');
});
test('root overlap, existing target, external owner, absolute legacy data mapping and unsupported target Dev are rejected', async t => {
  const f = await upgradeFixture(t, { secret: false });
  for (const targetDataRoot of [f.data, path.join(f.data, 'child'), path.dirname(f.data), f.app]) assert.equal((await unchanged(f, () => f.inspect({ targetDataRoot }))).status, 'BLOCKED');
  await fs.mkdir(f.target); assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED'); await fs.rmdir(f.target);
  assert.equal((await unchanged(f, () => f.inspect({ targetLayout: 'dev' }))).status, 'BLOCKED');
  const badLayout = await unchanged(f, () => f.inspect({ sourceLayout: 'dummy-private-invalid-layout' })); assert.equal(badLayout.status, 'BLOCKED'); assert.ok(!JSON.stringify(badLayout).includes('dummy-private-invalid-layout'));
  for (const projectRoot of [f.data, '../../outside']) {
    await write(f.context.configPath, { ...f.config, common: { ...f.config.common, projectRoot } });
    assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED');
  }
});
test('junction, hardlink and unsafe source files cannot cross the owned fixture boundary', async t => {
  const f = await upgradeFixture(t, { secret: false }); const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  const link = path.join(f.data, 'linked'); await fs.symlink(outside, link, 'junction'); assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED'); await fs.unlink(link);
  const hard = path.join(f.data, 'hard.json'); await fs.link(path.join(f.data, 'input.json'), hard); assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED'); await fs.unlink(hard);
  const codeLink = path.join(f.app, 'workflow'); await fs.symlink(outside, codeLink, 'junction'); assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED'); await fs.unlink(codeLink);
});
test('active lease, unfinished ledger and Restore transactions block without lock takeover or replay', async t => {
  const f = await upgradeFixture(t, { secret: false }); const lease = path.join(f.context.runRoot, '.workflow.lease.json');
  await write(lease, { schemaVersion: 1, runId: 'dummy', ownerId: 'dummy', hostname: os.hostname(), pid: process.pid, expiresAt: '2000-01-01T00:00:00Z' });
  assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED'); await fs.unlink(lease);
  const ledger = createOperationLedger({ runId: 'dummy', mode: 'local', profile: 'standard', configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath: f.data, stages: ['stage1'] });
  await write(path.join(f.context.runRoot, 'dummy/operation_ledger.json'), ledger);
  assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED'); await fs.rm(path.join(f.context.runRoot, 'dummy'), { recursive: true });
  await fs.mkdir(restoreTransactionRoot(f.data)); assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED'); await fs.rmdir(restoreTransactionRoot(f.data));
  await fs.mkdir(restoreTransactionRoot(f.target)); assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED');
  await fs.rmdir(restoreTransactionRoot(f.target));
  await write(path.join(f.context.researchRoot, 'schedule_decisions/v1/2026-10-18.json'), { schemaVersion: 1, businessRunId: 'dummy-unconfirmed' });
  const retained = await unchanged(f, () => f.inspect({ backup: undefined })); assert.notEqual(retained.status, 'PASS'); assert.equal(status(retained, 'workflow.retainedScheduleClaim'), 'UNKNOWN');
});
test('authenticated backup must match every current owner; no backup is UNKNOWN, wrong password/tamper/stale backup are refused', async t => {
  const f = await upgradeFixture(t, { secret: false });
  const missing = await unchanged(f, () => f.inspect({ backup: undefined, password: undefined })); assert.equal(missing.status, 'UNKNOWN'); assert.equal(missing.plan.rollback.backupVerified, false);
  assert.equal((await unchanged(f, () => f.inspect({ password: Buffer.from('dummy-wrong-upgrade-password') }))).status, 'BLOCKED');
  const bytes = await fs.readFile(f.backup); bytes[bytes.length - 1] ^= 1; const bad = path.join(f.root, 'bad.pebackup'); await fs.writeFile(bad, bytes);
  assert.equal((await unchanged(f, () => f.inspect({ backup: bad }))).status, 'BLOCKED');
  await write(path.join(f.data, 'review_results/unknown-owner.txt'), 'dummy-unexplained-new-content'); assert.equal((await unchanged(f, () => f.inspect())).status, 'BLOCKED');
});
test('local/external Secret requirements are separate, scheduler absent/disabled/enabled is preserved, no private content or paths leave the report', async t => {
  const f = await upgradeFixture(t); const r = await unchanged(f, () => f.inspect());
  assert.equal(r.plan.secrets.localFile, true); assert.equal(r.plan.secrets.externalCount, 0);
  const external = new UpgradePreflightService({ env: { ...f.hostEnv, SMTP_PASS: 'dummy-external-never-copied' }, volume: async () => ({ filesystem: 'NTFS', freeBytes: 100000000000n }) });
  const e = await unchanged(f, () => external.inspect({ ...f.input, password: upgradePassword() })); assert.equal(e.status, 'UNKNOWN'); assert.equal(e.plan.secrets.externalCount, 1);
  assert.doesNotMatch(JSON.stringify(e), /dummy-|old-data|old-program|new-program|source\.pebackup/); assert.ok(!JSON.stringify(e).includes(f.root));
  const recorded = await upgradeFixture(t, { secret: false, externalSecretName: 'QQ_BOT_APP_SECRET' });
  const priorExternal = await unchanged(recorded, () => recorded.inspect()); assert.equal(priorExternal.status, 'UNKNOWN');
  assert.deepEqual(priorExternal.plan.secrets.externalCredentialIds, ['QQ_BOT_APP_SECRET']); assert.ok(!JSON.stringify(priorExternal).includes('dummy-external-backup-metadata-only'));
  // A scheduler-only change deliberately invalidates prior backup evidence;
  // inspect without a backup and preserve the configured state in the plan.
  for (const enabled of [false, true]) { await write(f.context.configPath, { ...f.config, scheduler: { schemaVersion: 1, enabled, time: '15:00', timezone: 'Asia/Shanghai' } });
    const plan = await unchanged(f, () => f.inspect({ backup: undefined })); assert.equal(plan.plan.scheduler, 'PRESERVE_EXISTING_NO_REGISTRATION'); }
});
test('space, volume and permission evidence remain explicit; no writable probe or fallback can manufacture PASS', async t => {
  const f = await upgradeFixture(t, { secret: false });
  for (const [volume, expected] of [[async () => ({ filesystem: 'NTFS', freeBytes: 0n }), 'BLOCKED'], [async () => { throw new Error('dummy-private-failure'); }, 'UNKNOWN']]) {
    const r = await unchanged(f, () => f.make({ volume }).inspect({ ...f.input, password: upgradePassword() })); assert.equal(r.status, expected); assert.ok(!JSON.stringify(r).includes('dummy-private-failure'));
  }
});
test('real non-elevated NTFS DACL denying child creation is BLOCKED by readonly permission handles', async t => {
  const f = await upgradeFixture(t, { secret: false }); const parent = path.join(f.root, 'denied-parent'); await fs.mkdir(parent);
  const native = name => path.join(process.env.SystemRoot, 'System32', name);
  const sid = execFileSync(native('whoami.exe'), ['/user', '/fo', 'csv', '/nh']).toString().match(/S-1-[0-9-]+/)[0];
  execFileSync(native('icacls.exe'), [parent, '/deny', `*${sid}:(WD,AD)`], { stdio: 'pipe' });
  try {
    await assert.rejects(fs.mkdir(path.join(parent, 'must-fail')), e => ['EPERM', 'EACCES'].includes(e.code));
    const r = await unchanged(f, () => f.make({ volume: inspectRestoreVolume }).inspect({ ...f.input, targetDataRoot: path.join(parent, 'new-data'), password: upgradePassword() }));
    assert.equal(r.status, 'BLOCKED'); assert.equal(status(r, 'filesystem.parentWrite'), 'BLOCKED');
  } finally { execFileSync(native('icacls.exe'), [parent, '/remove:d', `*${sid}`], { stdio: 'pipe' }); }
});
test('CLI is exclusive, uses protected stdin for Verify and reports a plan rather than execution; source hashes remain identical', async t => {
  const f = await upgradeFixture(t, { secret: false }); const args = ['--upgrade-dry-run', '--source-application-root', f.app, '--source-data-root', f.data, '--source-layout', 'installed', '--target-data-root', f.target, '--target-layout', 'installed'];
  let output = ''; const stdout = { write: v => output += v };
  const before = await upgradeFileHashes(f.root);
  const code = await main([...args, '--verified-backup', f.backup, '--password-stdin'], { env: f.hostEnv, stdout, stderr: { write() {} }, stdin: Readable.from([upgradePassword()]), runtimeLog: { write: () => assert.fail('no logs') } });
  assert.equal(code, 0, output); assert.equal(JSON.parse(output).executionAllowed, false); assert.deepEqual(await upgradeFileHashes(f.root), before);
  output = ''; assert.equal(await main([...args, '--run'], { env: f.hostEnv, stdout }), 3); assert.doesNotMatch(output, /plan|dummy-|old-data/);
});
test('new readonly owner has no migration/restore execution or external service/OS registration calls', async () => {
  const source = await fs.readFile(new URL('../tools/lib/upgrade_preflight_service.mjs', import.meta.url), 'utf8');
  const mutableCall = /migrateApplicationConfig\(|\.create\(|\.restore\(|\.recover\(|\.writeFile\(|\.mkdir\(|\b(?:fs|transaction|restore|backup|service)\.replace\(|schtasks|Register-ScheduledTask|launchctl|fetch\(/;
  assert.equal(mutableCall.test(source), false, 'readonly owner must not call mutation or external execution APIs');
  assert.equal(/import[^;]*\b(?:migrateApplicationConfig|RestoreService|RestoreTransaction)\b/.test(source), false, 'readonly owner must not import mutable execution owners');
});
