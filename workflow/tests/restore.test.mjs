import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BackupService, validateBackupManifest } from '../tools/lib/backup_service.mjs';
import { RestoreService } from '../tools/lib/restore_service.mjs';
import { holdRestoreParent } from '../tools/lib/restore_filesystem.mjs';
import { sha256, openBackup, sealBackup } from '../tools/lib/backup_format.mjs';
import { resolveApplicationRuntimeContext } from '../tools/lib/runtime_config.mjs';
import { secureCredentialFile } from '../tools/lib/credential_file_security.mjs';
import { createOperationLedger } from '../tools/recovery/operation_ledger.mjs';
import { backupMain } from '../tools/runner/backup.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const password = () => Buffer.from('dummy-restore-password-only');
async function snapshot(root) {
  const result = {};
  const visit = async dir => { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) await visit(p); else { const s = await fs.lstat(p); result[path.relative(root, p)] = [s.mode, s.mtimeMs, sha256(await fs.readFile(p))]; } } };
  await visit(root); return result;
}
async function fixture(t) {
  const base = path.join(repo, 'tests/runs/restore'); await fs.mkdir(base, { recursive: true });
  const home = await fs.mkdtemp(path.join(base, '恢复 安全-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const app = path.join(home, 'app'), data = path.join(home, 'source');
  for (const name of ['workflow/tools/runner/main.mjs', 'workflow/tools/web/static/index.html', 'config/paperecho.config.example.json']) {
    await fs.mkdir(path.dirname(path.join(app, name)), { recursive: true }); await fs.copyFile(path.join(repo, name), path.join(app, name));
  }
  const env = { PAPERECHO_APPLICATION_ROOT: app, PAPERECHO_LAYOUT: 'installed', PAPERECHO_DATA_ROOT: data, PAPERECHO_SKIP_DOTENV: '1', ZOTERO_API_KEY: 'dummy-external-restore-only' };
  const seed = {
    'config/paperecho.config.json': JSON.stringify({ schemaVersion: 6, mode: 'local', common: { projectRoot: '..', llm: { enabled: false, mode: 'disabled' }, email: { enabled: false } }, local: { input: '../input.json', outputRoot: '../local' } }),
    '.env': 'SMTP_PASS=dummy-restore-local-value\n', 'input.json': '[{"title":"dummy-restore-paper","doi":"10.1234/dummy-restore"}]',
    'review_results/文献评价/screening_standards.md': 'dummy-private-rules', 'review_results/文献评价/standards_rule_suggestions_log.json': '{"suggestions":[]}',
    'review_results/文献评价/research_evaluations/dummy.json': '{"text":"dummy-private-feedback"}', 'review_results/文献评价/paper_feedback.json': '{"history":[]}',
    'review_results/文献评价/2026/周报.xlsx': 'dummy-export-bytes', 'review_results/run_manifests/dummy.json': '{}',
    'local/state/papers.json': '{"schema_version":1,"papers":[]}', 'local/feedback/events.jsonl': '{}\n',
    'local/runs/dummy/notification_receipt.json': '{}', 'local/runs/dummy/recovery.json': '{"status":"interrupted"}',
    'local/runs/dummy/operation_ledger.json': JSON.stringify(createOperationLedger({ runId: 'dummy', mode: 'local', profile: 'standard', configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath: 'input_artifact.json' })),
  };
  for (const [name, value] of Object.entries(seed)) { const p = path.join(data, name); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, value); }
  await secureCredentialFile(path.join(data, '.env'));
  const context = await resolveApplicationRuntimeContext({ cwd: app, env, readOnly: true });
  context.backupInputs = [path.join(data, 'input.json')]; context.backupConfigHash = sha256(await fs.readFile(context.configPath));
  const input = path.join(home, 'encrypted.pebackup'); await new BackupService({ context, env }).create({ output: input, password: password() });
  const contents = new Map(); const manifest = await openBackup(await fs.readFile(input), password(), validateBackupManifest, (file, bytes) => contents.set(file.path, Buffer.from(bytes)));
  t.after(() => { for (const bytes of contents.values()) bytes.fill(0); });
  const target = path.join(home, '全新 restored'); const make = options => new RestoreService({ env, ...options });
  const restore = options => make().restore({ input, target, password: password(), ...options });
  const before = await snapshot(data), backupHash = sha256(await fs.readFile(input));
  const unchanged = async () => { assert.deepEqual(await snapshot(data), before); assert.equal(sha256(await fs.readFile(input)), backupHash); };
  const noStaging = async () => assert.deepEqual((await fs.readdir(home)).filter(x => x.startsWith('.paperecho-restore-')), []);
  return { home, app, data, env, input, target, make, restore, manifest, contents, unchanged, noStaging };
}

test('Windows NTFS holds ancestors and directory rename never replaces an existing empty target', async t => {
  const base = path.join(repo, 'tests/runs/restore'); await fs.mkdir(base, { recursive: true });
  const home = await fs.mkdtemp(path.join(base, 'native-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const parent = path.join(home, 'parent'); await fs.mkdir(parent);
  const stage = path.join(parent, 'stage'), target = path.join(parent, 'existing');
  const guard = await holdRestoreParent(stage);
  try {
    await secureCredentialFile(stage, { checkOnly: true }); await fs.mkdir(target);
    const identity = (await fs.stat(target)).ino;
    await assert.rejects(fs.rename(stage, target)); assert.equal((await fs.stat(target)).ino, identity); assert.deepEqual(await fs.readdir(target), []);
    await assert.rejects(fs.rename(parent, path.join(home, 'moved'))); guard.assertHeld();
  } finally { await guard.release(); }
  await fs.rename(parent, path.join(home, 'moved'));
});

test('real Backup Verify Restore preserves every owner/hash and Doctor is read-only; historical claims cannot run', async t => {
  const f = await fixture(t); const verified = await new BackupService().verify({ input: f.input, password: password() }); assert.equal(verified.authenticated, true);
  Object.defineProperty(f.env, 'ZOTERO_API_KEY', { get() { throw new Error('EXTERNAL_VALUE_MUST_NOT_BE_READ'); } });
  const result = await f.restore(); assert.equal(result.status, 'restored'); assert.equal(result.byteIdentical, true); assert.equal(result.externalSecretCount, 1);
  assert.equal(result.reactivatedClaims, false); assert.equal(result.requiresStateReview, true); assert.equal(result.doctor.canRun, false);
  for (const id of ['configuration', 'secrets']) assert.equal(result.doctor.checks.find(x => x.checkId === id)?.status, 'PASS');
  for (const file of f.manifest.files) assert.equal(sha256(await fs.readFile(path.join(f.target, file.path))), file.sha256);
  assert.equal((await new BackupService().verify({ input: f.input, password: password() })).authenticated, true);
  await assert.rejects(fs.access(path.join(f.target, 'local/runs/.workflow.lease.json')));
  await secureCredentialFile(path.join(f.target, '.env'), { checkOnly: true }); await f.unchanged(); await f.noStaging();
});

test('wrong password, tampering and truncation never create a destination or plaintext staging', async t => {
  const f = await fixture(t);
  await assert.rejects(f.restore({ password: Buffer.from('dummy-wrong-password') }), /BACKUP_AUTH_FAILED/);
  const bytes = await fs.readFile(f.input); bytes[48] ^= 1; const altered = path.join(f.home, 'altered.pebackup'); await fs.writeFile(altered, bytes);
  await assert.rejects(f.restore({ input: altered }), /BACKUP_AUTH_FAILED/); await fs.writeFile(altered, bytes.subarray(0, 40)); await assert.rejects(f.restore({ input: altered }));
  await assert.rejects(fs.access(f.target)); await f.noStaging(); await f.unchanged();
});

test('authenticated schema, path, duplicate, missing owner, prefix conflict and old active lease refuse publication', async t => {
  const f = await fixture(t);
  const extra = value => ({ path: value, owner: 'run-recovery', size: 2, sha256: sha256(Buffer.from('{}')) });
  const cases = [
    m => { m.schemaVersion = 999; }, m => { m.files[0].path = '../escape'; },
    m => { m.files[0].path = 'C:/escape'; }, m => { m.files[0].path = 'config/CON'; },
    m => { m.files[0].size = 64 * 1048576 + 1; },
    m => { m.files.push({ ...m.files[0], path: m.files[0].path.toUpperCase() }); },
    m => { m.configEntry = 'missing.json'; },
    (m, bytes) => { m.files.push(extra('local/runs/dummy/old.lease.json')); bytes.push(Buffer.from('{}')); m.totalBytes += 2; m.ownerInventory['run-recovery']++; },
    (m, bytes) => { for (const name of ['collision', 'collision/child']) { m.files.push({ ...extra(name), owner: 'user-input' }); bytes.push(Buffer.from('{}')); m.totalBytes += 2; m.ownerInventory['user-input']++; } },
  ];
  for (const mutate of cases) {
    const m = structuredClone(f.manifest), bytes = m.files.map(x => f.contents.get(x.path)); mutate(m, bytes);
    const input = path.join(f.home, 'invalid.pebackup'); await fs.writeFile(input, await sealBackup(m, bytes, password()));
    await assert.rejects(f.restore({ input })); await assert.rejects(fs.access(f.target)); await f.noStaging();
  }
  await f.unchanged();
});

test('existing roots, workspace overlap, input overlap and junction/hardlink paths cannot overwrite data', async t => {
  const f = await fixture(t); await fs.mkdir(f.target);
  await assert.rejects(f.restore(), /RESTORE_TARGET_EXISTS/); assert.deepEqual(await fs.readdir(f.target), []);
  for (const target of [f.data, path.join(f.data, 'nested'), f.app, f.home]) await assert.rejects(f.restore({ target }));
  const external = path.join(f.home, 'external'); await fs.mkdir(external);
  const junction = path.join(f.home, 'junction'); await fs.symlink(external, junction, 'junction');
  await assert.rejects(f.restore({ target: path.join(junction, 'child') })); assert.deepEqual(await fs.readdir(external), []);
  const link = path.join(f.home, 'hardlink'); await fs.link(f.input, link); await assert.rejects(f.restore({ input: link, target: path.join(f.home, 'fresh') })); await fs.unlink(link);
  await f.unchanged(); await f.noStaging();
});

test('absolute legacy configuration is refused rather than changing bytes or reading another workspace', async t => {
  const f = await fixture(t), m = structuredClone(f.manifest);
  const config = JSON.parse(f.contents.get(m.configEntry)); config.common.projectRoot = f.data;
  const changed = Buffer.from(JSON.stringify(config)); const entry = m.files.find(x => x.path === m.configEntry); m.totalBytes += changed.length - entry.size; entry.size = changed.length; entry.sha256 = sha256(changed);
  const input = path.join(f.home, 'absolute.pebackup'); await fs.writeFile(input, await sealBackup(m, m.files.map(x => x.path === m.configEntry ? changed : f.contents.get(x.path)), password()));
  await assert.rejects(f.restore({ input }), /RESTORE_PATH_MAPPING_REQUIRED/); await assert.rejects(fs.access(f.target)); await f.noStaging(); await f.unchanged();
});

test('disk/permission/write/rename failure and cancellation remove only owned private staging', async t => {
  const f = await fixture(t);
  for (const code of ['ENOSPC', 'EACCES']) {
    const service = f.make({ fsApi: { ...fs, open: async (file, flags, ...args) => { if (flags === 'wx') throw Object.assign(new Error('dummy'), { code }); return fs.open(file, flags, ...args); } } });
    await assert.rejects(service.restore({ input: f.input, target: f.target, password: password() })); await assert.rejects(fs.access(f.target)); await f.noStaging();
  }
  const aborted = new AbortController();
  await assert.rejects(f.make({ hook: async step => { if (step === 'staging-created') aborted.abort(); } }).restore({ input: f.input, target: f.target, password: password(), signal: aborted.signal }));
  await assert.rejects(f.make({ fsApi: { ...fs, rename: async () => { throw Object.assign(new Error('dummy'), { code: 'EACCES' }); } } }).restore({ input: f.input, target: f.target, password: password() }));
  await assert.rejects(fs.access(f.target)); await f.noStaging(); await f.unchanged();
});

test('late target creation is refused; cleanup failure is explicit and the private orphan remains identifiable', async t => {
  const f = await fixture(t);
  await assert.rejects(f.make({ hook: async (step, { target }) => { if (step === 'before-publish') await fs.mkdir(target); } }).restore({ input: f.input, target: f.target, password: password() }), /RESTORE_TARGET_EXISTS/);
  assert.deepEqual(await fs.readdir(f.target), []); await f.noStaging();
  const target = path.join(f.home, 'cleanup-target'); let owned;
  await assert.rejects(f.make({ hook: async (step, { stage }) => { if (step === 'staging-created') { owned = stage; throw new Error('dummy'); } }, fsApi: { ...fs, rm: async () => { throw Object.assign(new Error('dummy'), { code: 'EACCES' }); } } }).restore({ input: f.input, target, password: password() }), /RESTORE_CLEANUP_REQUIRED/);
  await secureCredentialFile(owned, { checkOnly: true }); await fs.rm(owned, { recursive: true }); await assert.rejects(fs.access(target)); await f.unchanged();
});

test('unsafe restored Secret ACL fails closed before publication', async t => {
  const f = await fixture(t); let unsafeDaclConfirmed = false; let aclProcess;
  const hook = async (step, { stage }) => {
    if (step !== 'before-publish') return;
    // Read/persist Access only: Set-Acl's generic descriptor persistence can
    // request SeSecurityPrivilege although this fixture needs only a DACL ACE.
    const script = `
$ErrorActionPreference='Stop'
$file=[IO.FileInfo]::new($env:RESTORE_TEST_FILE)
$sections=[Security.AccessControl.AccessControlSections]
$sidType=[Security.Principal.SecurityIdentifier]
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$owner=[IO.FileSystemAclExtensions]::GetAccessControl($file,$sections::Owner).GetOwner($sidType)
$acl=[IO.FileSystemAclExtensions]::GetAccessControl($file,$sections::Access)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sidType::new('S-1-1-0'),'Read','Allow'))
[IO.FileSystemAclExtensions]::SetAccessControl($file,$acl)
$read=[IO.FileSystemAclExtensions]::GetAccessControl($file,$sections::Access)
$rules=@($read.GetAccessRules($true,$true,$sidType)|Where-Object{$_.IdentityReference.Value -eq 'S-1-1-0' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData) -ne 0})
$ownerAfter=[IO.FileSystemAclExtensions]::GetAccessControl($file,$sections::Owner).GetOwner($sidType)
@{unsafeDacl=(@($rules|Where-Object{$_.AccessControlType -eq 'Allow' -and -not $_.IsInherited}).Count -gt 0 -and @($rules|Where-Object{$_.AccessControlType -eq 'Deny'}).Count -eq 0);ownerUnchanged=($owner.Value -eq $ownerAfter.Value);ownerMatchesCurrentUser=($owner.Value -eq $identity.User.Value);protected=$read.AreAccessRulesProtected;elevated=([Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))}|ConvertTo-Json -Compress
`;
    const task = promisify(execFile)(process.env.PWSH_PATH || 'pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 2048, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, RESTORE_TEST_FILE: path.join(stage, '.env') } });
    aclProcess = task.child;
    const state = JSON.parse((await task).stdout);
    assert.equal(state.unsafeDacl, true); assert.equal(state.ownerUnchanged, true);
    assert.equal(state.ownerMatchesCurrentUser, true); assert.equal(state.protected, true);
    t.diagnostic('ACL_FIXTURE_NON_ELEVATED=' + !state.elevated);
    unsafeDaclConfirmed = true;
  };
  await assert.rejects(f.make({ hook }).restore({ input: f.input, target: f.target, password: password() }), /CREDENTIAL_ACL_UNSAFE/);
  assert.equal(unsafeDaclConfirmed, true); assert.throws(() => process.kill(aclProcess.pid, 0));
  await assert.rejects(fs.access(f.target)); await f.noStaging(); await f.unchanged();
});

test('concurrent services publish only one complete root and reject same-instance overlap', async t => {
  const f = await fixture(t); let release, entered;
  const gate = new Promise(r => { release = r; }), waiting = new Promise(r => { entered = r; });
  const service = f.make({ hook: async step => { if (step === 'staging-created') { entered(); await gate; } } });
  const first = service.restore({ input: f.input, target: f.target, password: password() });
  try {
    await waiting; await assert.rejects(service.restore({ input: f.input, target: f.target, password: password() }), /RESTORE_BUSY/);
    const second = await f.restore(); assert.equal(second.status, 'restored');
  } finally { release(); await assert.rejects(first, /RESTORE_TARGET_EXISTS/); }
  await f.noStaging(); await f.unchanged();
});

test('CLI Restore requires explicit target, uses protected stdin and never invokes ordinary workflow', async t => {
  const f = await fixture(t); let output = '';
  const stdin = new PassThrough(); stdin.end('dummy-restore-password-only\n');
  assert.equal(await backupMain(['--restore-backup', f.input, '--target-data-root', f.target, '--password-stdin'], { env: f.env, stdin, stdout: { write: s => { output += s; } } }), 0);
  assert.equal(JSON.parse(output).status, 'restored'); assert.doesNotMatch(output, /dummy-restore-password|dummy-restore-local|dummy-private/);
  for (const args of [['--restore-backup', f.input], ['--restore-backup', f.input, '--target-data-root', f.target, '--force']]) {
    output = ''; assert.equal(await backupMain(args, { env: f.env, stdout: { write: s => { output += s; } } }), 2); assert.equal(JSON.parse(output).code, 'BACKUP_ARGUMENT_INVALID');
  }
  await f.unchanged(); await f.noStaging();
});
