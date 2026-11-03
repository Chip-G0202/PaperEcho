// Real encrypted backup/data/ACL checks; installer and OS-state responses here are
// simulated, explicitly testOnly, and cannot replace the mandatory Guest Gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { upgradeFixture, upgradePassword, upgradeFileHashes, writeUpgradeFixture } from '../../tests/helpers/upgrade_fixture.mjs';
import { UpgradePreflightService } from '../tools/lib/upgrade_preflight_service.mjs';
import { sha256 } from '../tools/lib/backup_format.mjs';
import { confirmReinstallPlan, upgradeMain } from '../tools/runner/upgrade.mjs';
import { WindowsTaskScheduler } from '../tools/lib/windows_task_scheduler.mjs';
import { resolveRuntimePaths } from '../tools/lib/runtime_config.mjs';
import { inspectWindowsInstaller } from '../tools/lib/windows_installer_metadata.mjs';

test('native installer inspection reads an uninstalled test database without changing its bytes or registration', async t => {
  assert.equal(process.platform, 'win32');
  const base = path.resolve('tests/runs/safe-reinstall-metadata'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'native-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "空 格's.msi"), payload = path.join(root, 'dummy-stream');
  const productCode = `{${randomUUID().toUpperCase()}}`;
  await fs.writeFile(payload, 'unexecuted test stream');
  const rows = [['ProductCode', productCode], ['UpgradeCode', '{7395EC5E-338E-4E71-92A2-579BD64EE6E4}'], ['ProductVersion', '2.6.1'], ['ProductName', 'PaperEcho TEST ONLY']];
  const spec = path.join(root, 'database.json');
  await fs.writeFile(spec, JSON.stringify({ tables: { Property: { columns: 'Property CHAR(72) NOT NULL, Value CHAR(0)', key: 'Property', rows } }, msi: file, payload, packageCode: `{${randomUUID().toUpperCase()}}` }));
  // Database authoring only: this fixture has no installation sequence or files.
  execFileSync(process.env.PWSH_PATH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.resolve('desktop/electron-poc/installer-database.ps1'), '-Specification', spec], { timeout: 30000, stdio: 'pipe' });
  const before = sha256(await fs.readFile(file));
  for (let i = 0; i < 2; i++) {
    const result = await inspectWindowsInstaller(file, { applicationRoot: path.join(root, 'uninstalled-app') });
    assert.equal(result.productCode, productCode); assert.equal(result.version, '2.6.1');
    assert.equal(result.productState, -1); assert.equal(result.signatureStatus, 'NotSigned');
    assert.match(result.userSid, /^S-1-/); assert.equal(result.applicationRunning, false);
    assert.equal(result.sha256, before); assert.equal(sha256(await fs.readFile(file)), before);
  }
});

async function fixture(t) {
  const f = await upgradeFixture(t, { layout: 'installed', legacy: false });
  await writeUpgradeFixture(path.join(f.app, 'PaperEcho-headless.cmd'), 'dummy-unexecuted-headless');
  await writeUpgradeFixture(path.join(f.app, 'resources/core/workflow/tools/lib/restore_service.mjs'), 'dummy-unexecuted-recovery-contract');
  const installers = {};
  for (const [role, patch, digit] of [['old', 0, '1'], ['new', 1, '2']]) {
    const file = path.join(f.root, role + '.msi'); await fs.writeFile(file, 'dummy-package-' + role);
    installers[role] = { path: file, sha256: sha256(await fs.readFile(file)), version: '2.6.' + patch,
      productCode: `{${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}}` };
  }
  const state = { oldState: 5, newState: -1, appRunning: false, schedule: { status: 'PASS', osMutation: false, exists: false }, packageCalls: 0 };
  const installerInspector = async file => {
    state.packageCalls++;
    const role = file === installers.old.path ? 'old' : 'new';
    return { ...installers[role], sha256: sha256(await fs.readFile(file)), upgradeCode: '{7395EC5E-338E-4E71-92A2-579BD64EE6E4}',
      productName: 'PaperEcho TEST ONLY', productState: role === 'old' ? state.oldState : state.newState,
      isAdmin: false, applicationRunning: state.appRunning, userSid: 'S-1-5-21-100-200-300-1001', signatureStatus: 'NotSigned', signerThumbprint: '' };
  };
  const make = extra => new UpgradePreflightService({ env: f.hostEnv, volume: async () => ({ filesystem: 'NTFS', freeBytes: 100000000000n }),
    installerInspector, scheduleInspector: async () => structuredClone(state.schedule),
    testPackageTrust: async (expected, actual) => expected.sha256 === actual.sha256, ...extra });
  const input = { ...f.input, installers, password: upgradePassword() };
  return { ...f, installers, state, make, input, inspect: extra => make().inspectReinstall({ ...input, ...extra }) };
}

test('safe reinstall readiness binds a real backup and data to simulated installer evidence; confirmation is explicit, cancellable and revalidated', async t => {
  const f = await fixture(t), before = await upgradeFileHashes(f.root);
  const report = await f.inspect();
  assert.equal(report.status, 'READY_FOR_USER_CONFIRMATION', JSON.stringify(report));
  assert.equal(report.testOnly, true); assert.equal(report.uninstallAllowed, false); assert.equal(report.osMutation, false);
  assert.equal(report.plan.atomicRollback, false); assert.equal(report.plan.backupVerified, true); assert.equal(report.plan.downtimeRequired, true);
  const options = { expectedPlanId: report.plan.id, stdin: new PassThrough(), stderr: { write() {} } };
  let validated = 0;
  const cancelled = await confirmReinstallPlan(report, { ...options, confirmReinstall: async () => false, revalidate: async () => { throw new Error('CANCEL_MUST_NOT_PROCEED'); } });
  assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.uninstallAllowed, false);
  await assert.rejects(confirmReinstallPlan(report, options), /UPGRADE_REINSTALL_CONFIRMATION_REQUIRED/);
  await assert.rejects(confirmReinstallPlan({ status: 'BLOCKED' }, { ...options, confirmReinstall: async () => true }), /UPGRADE_REINSTALL_PREFLIGHT_BLOCKED/);
  await assert.rejects(confirmReinstallPlan(report, { ...options, expectedPlanId: '0'.repeat(64), confirmReinstall: async () => true }), /UPGRADE_REINSTALL_PLAN_STALE/);
  await assert.rejects(confirmReinstallPlan(report, { ...options, confirmReinstall: async () => true }), /UPGRADE_REINSTALL_REVALIDATION_REQUIRED/);
  const confirm = async () => confirmReinstallPlan(report, { ...options, confirmReinstall: async () => true, revalidate: async () => { validated++; return f.inspect(); } });
  const approved = await confirm(); const repeated = await confirm();
  assert.equal(approved.status, 'USER_CONFIRMED_MANUAL_REINSTALL'); assert.equal(approved.uninstallAllowed, true);
  assert.equal(approved.executionAllowed, false); assert.equal(approved.osMutation, false); assert.equal(approved.approvalId, repeated.approvalId); assert.equal(validated, 2);
  assert.deepEqual(await upgradeFileHashes(f.root), before);
  const input = path.join(f.data, 'input.json');
  await assert.rejects(confirmReinstallPlan(report, { ...options, confirmReinstall: async () => { await fs.writeFile(input, 'dummy-changed-during-prompt'); return true; }, revalidate: () => f.inspect() }), /UPGRADE_REINSTALL_PLAN_STALE/);
  assert.equal(await fs.readFile(input, 'utf8'), 'dummy-changed-during-prompt');
});

test('safe reinstall simulated negative prerequisites never authorize uninstall or silently trust unknown installation states', async t => {
  const f = await fixture(t), before = await upgradeFileHashes(f.root);
  const check = async (extra, code) => { const r = await f.inspect(extra); assert.equal(r.status, 'BLOCKED'); assert.equal(r.uninstallAllowed, false); assert.equal(r.code, code, JSON.stringify(r)); };
  await check({ backup: undefined }, 'UPGRADE_REINSTALL_ROOT_UNSAFE');
  await check({ password: Buffer.from('dummy-wrong-password') }, 'UPGRADE_REINSTALL_PREFLIGHT_BLOCKED');
  await check({ installers: undefined }, 'UPGRADE_INSTALLER_REFERENCE_REQUIRED');
  const missing = structuredClone(f.installers); missing.old.path = path.join(f.root, 'missing.msi');
  await check({ installers: missing }, 'UPGRADE_INSTALLER_MISSING');
  const changed = structuredClone(f.installers); changed.old.sha256 = '0'.repeat(64);
  await check({ installers: changed }, 'UPGRADE_INSTALLER_IDENTITY_MISMATCH');
  assert.equal((await f.make({ testPackageTrust: undefined }).inspectReinstall(f.input)).code, 'UPGRADE_INSTALLER_TRUST_UNVERIFIED');
  f.state.oldState = 1; await check({}, 'UPGRADE_REINSTALL_STATE_UNSAFE'); f.state.oldState = 5;
  f.state.appRunning = true; await check({}, 'UPGRADE_REINSTALL_APPLICATION_BUSY'); f.state.appRunning = false;
  f.state.schedule = { status: 'UNKNOWN', osMutation: false, exists: false }; await check({}, 'UPGRADE_REINSTALL_SCHEDULE_BUSY_OR_UNKNOWN');
  f.state.schedule = { status: 'PASS', osMutation: false, exists: true, definitionMatches: true, currentUser: true, leastPrivilege: true, interactiveToken: true, enabled: true, runningInstances: 0 };
  await check({}, 'UPGRADE_REINSTALL_SCHEDULE_BUSY_OR_UNKNOWN');
  f.state.schedule.enabled = false; f.state.schedule.runningInstances = 1;
  await check({}, 'UPGRADE_REINSTALL_SCHEDULE_BUSY_OR_UNKNOWN');
  assert.deepEqual(await upgradeFileHashes(f.root), before);
});

test('presence-only schedule inspection emits only a query and cannot register a fabricated fallback spec', async t => {
  const f = await fixture(t); let calls = 0;
  const adapter = new WindowsTaskScheduler({ transport: async request => { calls++; assert.equal(request.operation, 'query'); assert.equal(request.definition, undefined); return { schemaVersion: 1, status: 'PASS', exists: false }; } });
  const result = await adapter.inspectPresence(resolveRuntimePaths({ env: f.env }));
  assert.equal(result.exists, false); assert.equal(result.presenceOnly, true); assert.equal(result.osMutation, false); assert.equal(calls, 1);
});

test('headless confirmation without live authorization fails before reading a request or consuming a password', async () => {
  let output = '', consumed = false; const stdin = new PassThrough(); stdin.on('data', () => { consumed = true; });
  const code = await upgradeMain(['--reinstall-confirm', '--request', path.resolve('tests/runs/no-read-request.json'), '--confirm-plan', 'a'.repeat(64), '--password-stdin'],
    { stdin, stdout: { write: value => output += value }, stderr: { write() {} } });
  assert.equal(code, 3); assert.equal(JSON.parse(output).code, 'UPGRADE_REINSTALL_CONFIRMATION_REQUIRED'); assert.equal(consumed, false); stdin.destroy();
});
