import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { BackupService, validateBackupManifest } from '../tools/lib/backup_service.mjs';
import { BACKUP_LIMITS, sha256, openBackup, sealBackup } from '../tools/lib/backup_format.mjs';
import { resolveRuntimePaths, resolveApplicationRuntimeContext } from '../tools/lib/runtime_config.mjs';
import { secureCredentialFile } from '../tools/lib/credential_file_security.mjs';
import { acquireWorkflowLease, releaseRunLease, createOperationLedger } from '../tools/recovery/operation_ledger.mjs';
import { backupMain, readBackupPassword } from '../tools/runner/backup.mjs';
import { runLocalPipeline } from '../tools/local/main.mjs';
import { importLocalCandidates } from '../tools/local/local_import.mjs';
import { main as runnerMain } from '../tools/runner/main.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const password = () => Buffer.from('dummy-backup-password-only');
async function fixture(t, layout = 'installed', freshRuns = false) {
  const base = path.join(repo, 'tests/runs/backup'); await fs.mkdir(base, { recursive: true });
  const home = await fs.mkdtemp(path.join(base, '备份 安全-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const app = path.join(home, 'app'); await fs.mkdir(app);
  const env = { PAPERECHO_APPLICATION_ROOT: app, PAPERECHO_LAYOUT: layout, PAPERECHO_SKIP_DOTENV: '1', ...(layout === 'installed' ? { PAPERECHO_DATA_ROOT: path.join(home, 'data') } : {}) };
  const p = resolveRuntimePaths({ env });
  const seed = { 'config/paperecho.config.json': JSON.stringify({ schemaVersion: 6, mode: 'local', common: { projectRoot: '..', llm: { enabled: false, mode: 'disabled' }, email: { enabled: false } }, local: { input: '../input.json', outputRoot: '../local' } }),
    '.env': 'SMTP_PASS=dummy-local-secret-value\n', 'input.json': '[{"title":"dummy-private-research-title","doi":"10.1234/dummy-backup-local"}]',
    'review_results/文献评价/screening_standards.md': 'dummy-private-rules', 'review_results/文献评价/standards_rule_suggestions_log.json': '{"suggestions":[]}',
    'review_results/文献评价/research_evaluations/dummy.json': '{"text":"dummy-private-feedback"}', 'review_results/文献评价/paper_feedback.json': '{"history":["dummy-private-review"]}',
    'review_results/文献评价/2026/周报.xlsx': 'dummy-binary-export', 'review_results/run_manifests/dummy.json': '{}',
    'local/state/papers.json': '{"schema_version":1,"papers":[]}', 'local/feedback/events.jsonl': '{}\n', 'local/runs/dummy/notification_receipt.json': '{}',
    'local/runs/tmp/recovery.json': '{}', 'local/runs/cache/notification_receipt.json': '{}',
    'local/runs/dummy/recovery.json': '{"status":"interrupted"}', 'local/runs/dummy/operation_ledger.json': JSON.stringify(createOperationLedger({ runId: 'dummy', mode: 'local', profile: 'standard', configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath: 'input_artifact.json' })),
    'logs/runtime.jsonl': 'dummy-raw-log-excluded', '.cache/dummy': 'dummy-cache-excluded', 'review_results/translation_cache.json': '{}' };
  for (const [name, bytes] of Object.entries(seed)) { if (freshRuns && name.startsWith('local/runs/')) continue; const file = path.join(p.userDataRoot, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); }
  await secureCredentialFile(p.secretPath);
  const context = await resolveApplicationRuntimeContext({ cwd: app, env, readOnly: true });
  context.backupInputs = [path.join(p.userDataRoot, 'input.json')]; context.backupConfigHash = sha256(await fs.readFile(p.configPath));
  const output = path.join(home, '备份.pebackup'); const make = options => new BackupService({ context, env, ...options });
  return { home, app, env, p, context, output, make, seed };
}
async function snapshot(root) {
  const result = {};
  const visit = async dir => { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isDirectory()) await visit(file); else { const s = await fs.lstat(file); result[path.relative(root, file)] = [s.mode, s.mtimeMs, sha256(await fs.readFile(file))]; } } };
  await visit(root); return result;
}
async function decoded(file) {
  const contents = new Map(); const manifest = await openBackup(await fs.readFile(file), password(), validateBackupManifest, (entry, bytes) => contents.set(entry.path, Buffer.from(bytes)));
  return { manifest, contents };
}

test('new backup uses the vetted source credential DACL and unsafe source credentials remain blocked', async t => {
  const f = await fixture(t); const destination = path.join(f.home, 'private-exports');
  await fs.mkdir(destination); await secureCredentialFile(destination);
  const output = path.join(destination, 'encrypted.pebackup');
  const pwsh = process.env.PWSH_PATH; assert.ok(pwsh && path.isAbsolute(pwsh));
  const addAce = (file, sid) => execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop';$f=[IO.FileInfo]::new($env:ACL_TEST_FILE);$a=[IO.FileSystemAclExtensions]::GetAccessControl($f,[Security.AccessControl.AccessControlSections]::Access);$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($env:ACL_TEST_SID),'ReadAndExecute','Allow'));[IO.FileSystemAclExtensions]::SetAccessControl($f,$a)"],
  { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ACL_TEST_FILE: file, ACL_TEST_SID: sid }, timeout: 15000, stdio: 'pipe' });
  const aclState = file => JSON.parse(execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command',
    "$a=Get-Acl -LiteralPath $env:ACL_TEST_FILE;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;@{ownerCurrent=($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid);protected=$a.AreAccessRulesProtected;rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{currentUser=($_.IdentityReference.Value -eq $sid);system=($_.IdentityReference.Value -eq 'S-1-5-18');family=(($_.IdentityReference.Value -split '-')[0..3] -join '-');type=[string]$_.AccessControlType;inherited=$_.IsInherited;rights=[string]$_.FileSystemRights}})}|ConvertTo-Json -Depth 5 -Compress"],
  { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ACL_TEST_FILE: file }, timeout: 15000, encoding: 'utf8' }));
  let reproduced = 0; const states = {};
  const fsApi = { ...fs, open: async (...args) => {
    if (args[1] === 'r') states.beforeVerifyOpen = aclState(args[0]);
    const handle = await fs.open(...args);
    try {
      if (args[1] === 'wx' && path.basename(args[0]).startsWith('.paperecho-backup-') && args[0].endsWith('.partial')) {
        assert.equal(reproduced, 0); addAce(args[0], 'S-1-5-5-4294967294-4294967294');
        await assert.rejects(secureCredentialFile(args[0]), /CREDENTIAL_ACL_UNSAFE/); reproduced++;
      }
      if (args[1] === 'r') {
        states.afterVerifyOpen = aclState(args[0]);
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); states.afterVerifyRead = aclState(args[0]); };
      }
      return handle;
    } catch (error) { await handle.close(); throw error; }
  } };
  assert.equal((await f.make({ fsApi }).create({ output, password: password() })).status, 'created');
  assert.equal(reproduced, 1); await secureCredentialFile(output, { checkOnly: true });
  assert.equal(states.beforeVerifyOpen.ownerCurrent, true); assert.equal(states.beforeVerifyOpen.protected, true);
  assert.deepEqual(states.beforeVerifyOpen, states.afterVerifyOpen); assert.deepEqual(states.beforeVerifyOpen, states.afterVerifyRead);
  t.diagnostic('ACL_STATES=' + JSON.stringify(states));
  assert.equal((await f.make().verify({ input: output, password: password() })).status, 'verified');
  const tamper = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    try { if (args[1] === 'r') addAce(args[0], 'S-1-1-0'); return handle; }
    catch (error) { await handle.close(); throw error; }
  } };
  const originalAcl = execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command',
    "[IO.FileSystemAclExtensions]::GetAccessControl([IO.FileInfo]::new($env:ACL_TEST_FILE),[Security.AccessControl.AccessControlSections]::Access).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)"],
  { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ACL_TEST_FILE: output }, timeout: 15000, encoding: 'utf8' }).trim();
  const originalState = aclState(output); let used = false; let validationError; let cleanupError;
  try {
    await assert.rejects(f.make({ fsApi: tamper }).withVerifiedContents({ input: output, password: password() }, () => { used = true; }), /CREDENTIAL_ACL_UNSAFE/);
    assert.equal(used, false);
    assert.ok(aclState(output).rules.some(rule => rule.family === 'S-1-1-0'));
  } catch (error) { validationError = error; }
  finally {
    try {
      assert.equal(await fs.realpath(output), output); assert.equal((await fs.lstat(output)).nlink, 1);
      execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop';$a=[Security.AccessControl.FileSecurity]::new();$a.SetSecurityDescriptorSddlForm($env:ACL_TEST_DACL,[Security.AccessControl.AccessControlSections]::Access);[IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($env:ACL_TEST_FILE),$a)"],
      { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ACL_TEST_FILE: output, ACL_TEST_DACL: originalAcl }, timeout: 15000, stdio: 'pipe' });
      assert.deepEqual(aclState(output), originalState); await secureCredentialFile(output, { checkOnly: true });
    } catch (error) { cleanupError = error; }
  }
  t.diagnostic(`ACL_NEGATIVE validation=${validationError ? 'failed' : 'rejected-as-expected'} cleanup=${cleanupError ? 'failed' : 'restored'} callbackUsed=${used}`);
  const errors = [validationError, cleanupError].filter(Boolean); if (errors.length) throw new AggregateError(errors, 'ACL_NEGATIVE_OR_CLEANUP_FAILED');
  assert.equal((await f.make().verify({ input: output, password: password() })).status, 'verified');
  const tamperedOutput = path.join(destination, 'tampered-must-not-publish.pebackup');
  await assert.rejects(f.make({ fsApi: tamper }).create({ output: tamperedOutput, password: password() }), /CREDENTIAL_ACL_UNSAFE/);
  await assert.rejects(fs.access(tamperedOutput), error => error.code === 'ENOENT');
  addAce(f.p.secretPath, 'S-1-1-0');
  await assert.rejects(secureCredentialFile(f.p.secretPath, { checkOnly: true }), /CREDENTIAL_ACL_UNSAFE/);
  await assert.rejects(f.make().verifyData({ input: output, password: password() }), /CREDENTIAL_ACL_UNSAFE/);
  const rejected = path.join(destination, 'must-not-publish.pebackup');
  await assert.rejects(f.make().create({ output: rejected, password: password() }), /CREDENTIAL_ACL_UNSAFE/);
  await assert.rejects(fs.access(rejected), error => error.code === 'ENOENT');
});
test('Dev/Portable/Installed real encrypted backup preserves all formal owners and source bytes; offline Verify is read-only', async t => {
  for (const layout of ['dev', 'portable', 'installed']) {
    const f = await fixture(t, layout); const before = await snapshot(f.p.userDataRoot);
    const result = await f.make().create({ output: f.output, password: password() }); assert.equal(result.status, 'created');
    const bytes = await fs.readFile(f.output);
    for (const sensitive of ['dummy-local-secret', 'dummy-private', f.p.userDataRoot, 'SMTP_PASS', 'manifest.json']) assert.ok(!bytes.includes(Buffer.from(sensitive)));
    const { manifest, contents } = await decoded(f.output); assert.equal(manifest.status, 'complete'); assert.equal(manifest.layout, layout);
    for (const [name, value] of Object.entries(f.seed).filter(([name]) => !/^(logs|\.cache)\//.test(name) && !name.endsWith('translation_cache.json'))) assert.equal(contents.get(name)?.toString(), value, name);
    assert.ok([...contents.keys()].every(name => !/\.lock$|\.lease\.json$|\.tmp$/.test(name)));
    assert.ok(manifest.excluded.some(x => x.reason === 'never-reactivate')); assert.equal(manifest.restorePolicy.reactivateClaims, false);
    assert.equal(manifest.roots.data, '.'); assert.ok(manifest.roots.runRoots.includes('local/runs')); assert.deepEqual(manifest.roots.inputs, ['input.json']);
    const verified = await new BackupService().verify({ input: f.output, password: password() });
    assert.equal(verified.authenticated, true); assert.equal(verified.restoreReady, false); assert.equal(verified.requiresRestorePlanning, true);
    assert.deepEqual(await snapshot(f.p.userDataRoot), before);
  }
});
test('external managed credential values are never read, including custom references', async t => {
  const f = await fixture(t); f.context.backupSecretNames = ['CUSTOM_DUMMY_KEY'];
  for (const id of ['ZOTERO_API_KEY', 'CUSTOM_DUMMY_KEY']) Object.defineProperty(f.env, id, { get() { throw new Error('EXTERNAL_VALUE_READ'); }, enumerable: true });
  await f.make().create({ output: f.output, password: password() });
  assert.deepEqual((await decoded(f.output)).manifest.externalSecrets.sort(), ['CUSTOM_DUMMY_KEY', 'ZOTERO_API_KEY']);
});
test('workspace mismatch and external owners fail before any snapshot is published', async t => {
  const a = await fixture(t), b = await fixture(t); const before = await snapshot(a.p.userDataRoot); const other = await snapshot(b.p.userDataRoot);
  await assert.rejects(a.make({ env: b.env }).create({ output: a.output, password: password() }), /BACKUP_TARGET_UNSAFE/);
  a.context.backupInputs.push(path.join(b.p.userDataRoot, 'input.json'));
  await assert.rejects(a.make().create({ output: a.output, password: password() }), /BACKUP_EXTERNAL_OWNER/);
  assert.deepEqual(await snapshot(a.p.userDataRoot), before); assert.deepEqual(await snapshot(b.p.userDataRoot), other); await assert.rejects(fs.access(a.output));
});
test('wrong password, tampering, truncation and unsupported format refuse authenticated results', async t => {
  const f = await fixture(t); await f.make().create({ output: f.output, password: password() }); const bytes = await fs.readFile(f.output);
  await assert.rejects(f.make().verify({ input: f.output, password: Buffer.from('dummy-wrong-password') }), /BACKUP_AUTH_FAILED/);
  for (const [index, transform] of [b => { b[8] ^= 1; return b; }, b => { b[45] ^= 1; return b; }, b => b.subarray(0, b.length - 9), b => { b[7] = 50; return b; }].entries()) {
    const file = path.join(f.home, `corrupt-${index}.pebackup`); await fs.writeFile(file, transform(Buffer.from(bytes)), { flag: 'wx' }); await secureCredentialFile(file, { source: f.output }); await assert.rejects(f.make().verify({ input: file, password: password() }), /BACKUP_(AUTH_FAILED|FORMAT_UNSUPPORTED)/);
  }
});
test('authenticated malformed manifest, duplicate/traversal/missing owners, hashes and compatibility are rejected', async t => {
  const f = await fixture(t); await f.make().create({ output: f.output, password: password() }); const { manifest, contents } = await decoded(f.output);
  const malformed = [m => { m.schemaVersion = 99; }, m => { m.files[0].path = '../escape'; }, m => { m.files[1].path = m.files[0].path; }, m => { m.files[0].size = BACKUP_LIMITS.fileBytes + 1; }, m => { m.files[0].sha256 = '0'.repeat(64); }, m => { m.configEntry = 'other.json'; }, m => { m.ownerInventory.config++; }, m => { m.restorePolicy.reactivateClaims = true; }, m => { m.encryption.N = 1; }];
  for (const [index, mutate] of malformed.entries()) {
    const m = structuredClone(manifest); mutate(m); const bytes = await sealBackup(m, manifest.files.map(file => contents.get(file.path)), password());
    const file = path.join(f.home, `malformed-${index}.pebackup`); await fs.writeFile(file, bytes, { flag: 'wx' }); await secureCredentialFile(file, { source: f.output }); await assert.rejects(f.make().verify({ input: file, password: password() }), /BACKUP_/);
  }
});
test('source links, hardlinks, unsafe target paths and existing outputs never overwrite protected data', async t => {
  const f = await fixture(t); await fs.writeFile(f.output, 'protected-existing');
  await assert.rejects(f.make().create({ output: f.output, password: password() }), /BACKUP_TARGET_EXISTS/); assert.equal(await fs.readFile(f.output, 'utf8'), 'protected-existing');
  await assert.rejects(f.make().create({ output: path.join(f.app, 'bad'), password: password() }), /BACKUP_TARGET_UNSAFE/);
  await assert.rejects(f.make().create({ output: path.join(f.p.userDataRoot, 'bad'), password: password() }), /BACKUP_TARGET_UNSAFE/);
  const protectedFile = path.join(f.home, 'protected'); await fs.writeFile(protectedFile, 'dummy-protected');
  const linked = path.join(f.p.userDataRoot, 'config/linked.json'); await fs.link(protectedFile, linked);
  await assert.rejects(f.make().create({ output: path.join(f.home, 'hardlink'), password: password() }), /BACKUP_PATH_UNSAFE/); await fs.unlink(linked);
  const outside = path.join(f.home, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, path.join(f.p.userDataRoot, 'review_results/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.make().create({ output: path.join(f.home, 'symlink'), password: password() }), /BACKUP_PATH_UNSAFE/); assert.equal(await fs.readFile(protectedFile, 'utf8'), 'dummy-protected'); assert.deepEqual(await fs.readdir(outside), []);
});
test('workflow and writer locks reject backup without takeover; backup excludes competing Local entry', async t => {
  const f = await fixture(t); const lease = await acquireWorkflowLease({ runRoot: f.context.runRoot, runId: 'dummy-live', profile: 'standard' });
  await assert.rejects(f.make().create({ output: f.output, password: password() }), /BACKUP_WORKFLOW_BUSY/); assert.equal(await fs.readFile(lease.leasePath, 'utf8').then(x => JSON.parse(x).ownerId), lease.lease.ownerId); await releaseRunLease(lease);
  const lock = f.p.secretPath + '.lock'; await fs.writeFile(lock, 'dummy-existing-lock');
  await assert.rejects(f.make().create({ output: f.output, password: password() })); assert.equal(await fs.readFile(lock, 'utf8'), 'dummy-existing-lock'); await fs.unlink(lock);
  const rollback = f.p.secretPath + '.dummy.rollback'; await fs.writeFile(rollback, 'dummy-recovery-secret');
  await assert.rejects(f.make().create({ output: f.output, password: password() }), /BACKUP_CREDENTIAL_RECOVERY_REQUIRED/); assert.equal(await fs.readFile(rollback, 'utf8'), 'dummy-recovery-secret'); await fs.unlink(rollback);
  await f.make({ hook: async step => { if (step === 'captured') await assert.rejects(runLocalPipeline({ outputRoot: f.context.localRepository.root }), /LOCAL_WORKFLOW_BUSY/); } }).create({ output: f.output, password: password() });
});
test('concurrent exports are bounded across instances and locks release after rejection', async t => {
  const f = await fixture(t); let enter; let release; const started = new Promise(r => enter = r); const gate = new Promise(r => release = r);
  const service = f.make({ hook: async step => { if (step === 'captured') { enter(); await gate; } } }); const task = service.create({ output: f.output, password: password() }); await started;
  try {
    await assert.rejects(service.create({ output: path.join(f.home, 'second'), password: password() }), /BACKUP_BUSY/);
    await assert.rejects(f.make().create({ output: path.join(f.home, 'third'), password: password() }), /BACKUP_WRITER_BUSY/);
  } finally { release(); await task; }
  assert.equal((await f.make().verify({ input: f.output, password: password() })).status, 'verified');
});
test('Runner admission remains held during child completion and blocks backup without interrupting work', async t => {
  const f = await fixture(t, 'installed', true); let completed = false;
  const code = await runnerMain(['--run', '--mode', 'local'], { cwd: f.app, env: f.env, stdout: { write() {} }, stderr: { write() {} }, runtimeLog: { write: async () => ({ ok: true }) },
    resolveRunnerConfigurationImpl: async options => ({ options, env: f.env }), runPreflightImpl: async () => ({ canRun: true, status: 'ready', requiredMissing: [] }),
    buildExecutionPlanImpl: () => ({ runRoot: f.context.runRoot, runId: 'dummy' }),
    runProductionImpl: async () => { await assert.rejects(f.make().create({ output: f.output, password: password() }), /BACKUP_WORKFLOW_BUSY/); completed = true; return { code: 0, stdout: '{}' }; },
    validateProductionResultImpl: async () => { await assert.rejects(f.make().create({ output: f.output, password: password() }), /BACKUP_WORKFLOW_BUSY/); return { exitCode: 0 }; } });
  assert.equal(code, 0); assert.equal(completed, true); await assert.rejects(fs.access(path.join(f.context.runRoot, '.runner.operation.lock')));
});
test('Local lease and real run registration share one run identity and release on failure', async t => {
  const f = await fixture(t); let checked = false;
  const imported = await importLocalCandidates(path.join(f.p.userDataRoot, 'input.json'));
  assert.equal(imported.items.length, 1); assert.equal(imported.errors.length, 0);
  assert.equal(imported.items[0].source_file, path.join(f.p.userDataRoot, 'input.json'));
  await assert.rejects(runLocalPipeline({ outputRoot: f.context.localRepository.root, input: path.join(f.p.userDataRoot, 'input.json'), llmMode: 'disabled' }, {
    sharedIndexPath: path.join(f.p.userDataRoot, 'review_results/shared/current_literature_index.json'),
    runStage1: async ({ candidateSource }) => { assert.equal(candidateSource.length, 1); assert.equal(candidateSource[0].doi, imported.items[0].doi); throw new Error('DUMMY_LOCAL_STOP'); },
    writeTiming: async file => { const lease = JSON.parse(await fs.readFile(path.join(f.context.runRoot, '.workflow.lease.json'))); assert.equal(lease.runId, path.basename(path.dirname(file))); checked = true; },
  }), /DUMMY_LOCAL_STOP/);
  assert.equal(checked, true); await assert.rejects(fs.access(path.join(f.context.runRoot, '.workflow.lease.json')));
});
test('source mutation, limits, interrupted creation and disk-full leave no valid output or temporary copies', async t => {
  const f = await fixture(t); const before = await snapshot(f.p.userDataRoot); const cancel = new AbortController();
  const diskFull = { ...fs, open: async (...args) => { const h = await fs.open(...args); if (args[1] !== 'wx') return h; return { close: () => h.close(), writeFile: async () => { throw Object.assign(new Error('dummy-private'), { code: 'ENOSPC' }); } }; } };
  await assert.rejects(f.make({ fsApi: diskFull }).create({ output: f.output, password: password() }), error => error.code === 'ENOSPC');
  await assert.rejects(f.make({ hook: async step => { if (step === 'captured') cancel.abort(); } }).create({ output: f.output, password: password(), signal: cancel.signal }));
  assert.deepEqual(await snapshot(f.p.userDataRoot), before);
  const input = path.join(f.p.userDataRoot, 'input.json');
  await assert.rejects(f.make({ hook: async step => { if (step === 'captured') await fs.writeFile(input, 'dummy-edited'); } }).create({ output: f.output, password: password() }), /BACKUP_SOURCE_CHANGED/);
  const large = path.join(f.p.userDataRoot, 'review_results/large'); const h = await fs.open(large, 'w'); await h.truncate(BACKUP_LIMITS.fileBytes + 1); await h.close();
  await assert.rejects(f.make().create({ output: f.output, password: password() }), /BACKUP_LIMIT_EXCEEDED/);
  assert.ok(!(await fs.readdir(f.home)).some(x => x.endsWith('.partial') || x.endsWith('.pebackup')));
});
test('password channels and exclusive CLI Backup/Verify never echo secrets or run workflow/Doctor', async t => {
  const f = await fixture(t); const invoke = async args => { const stdin = new PassThrough(); let text = ''; const entry = args[0] === '--verify-backup-data' ? runnerMain : backupMain; const task = entry(args, { env: f.env, cwd: f.app, stdin, stdout: { write: x => text += x }, stderr: { write() {} } }); stdin.end(Buffer.concat([password(), Buffer.from('\n')])); const code = await task; assert.ok(!text.includes(password().toString()) && !text.includes('dummy-private') && !text.includes('SMTP_PASS')); return { code, result: JSON.parse(text) }; };
  assert.equal((await invoke(['--backup', f.output, '--password-stdin'])).code, 0);
  const before = await snapshot(f.p.userDataRoot); assert.equal((await invoke(['--verify-backup', f.output, '--password-stdin'])).result.authenticated, true); assert.deepEqual(await snapshot(f.p.userDataRoot), before);
  const audit = await invoke(['--verify-backup-data', f.output, '--password-stdin']);
  assert.equal(audit.code, 0); assert.equal(audit.result.status, 'data-preserved'); assert.equal(audit.result.installerAuthorization, false);
  assert.deepEqual(await snapshot(f.p.userDataRoot), before);
  assert.equal((await invoke(['--backup', f.output, '--run'])).result.code, 'BACKUP_ARGUMENT_INVALID');
  await assert.rejects(readBackupPassword(new PassThrough(), { write() {} }), /BACKUP_PASSWORD_CHANNEL_REQUIRED/);
  const terminal = new PassThrough(); terminal.isTTY = true; const modes = []; terminal.setRawMode = x => modes.push(x);
  const entered = readBackupPassword(terminal, { write() {} }); terminal.end(Buffer.concat([Buffer.from('dummy-密'), Buffer.from([127]), Buffer.from('password\n')]));
  assert.equal((await entered).toString(), 'dummy-password'); assert.deepEqual(modes, [true, false]);
});

test('authenticated backup data audit detects changed, missing and extra owner bytes without repairing user data', async t => {
  const f = await fixture(t, 'installed', true); await f.make().create({ output: f.output, password: password() });
  const before = await snapshot(f.p.userDataRoot), archive = await fs.readFile(f.output);
  const audit = await f.make().verifyData({ input: f.output, password: password() });
  assert.equal(audit.status, 'data-preserved'); assert.equal(audit.readOnly, true); assert.equal(audit.restoreReady, false);
  assert.ok(Object.values(audit.ownerInventory).every(count => count > 0));
  assert.deepEqual(await snapshot(f.p.userDataRoot), before);
  await assert.rejects(f.make().verifyData({ input: f.output, password: Buffer.from('dummy-wrong-password') }), /BACKUP_AUTH_FAILED/);
  await assert.rejects(new BackupService({ env: f.env }).verifyData({ input: f.output, password: password() }), /BACKUP_CONTEXT_REQUIRED/);
  await assert.rejects(new BackupService({ env: f.env, context: { ...f.context, userDataRoot: f.home } }).verifyData({ input: f.output, password: password() }), /BACKUP_TARGET_UNSAFE/);
  await assert.rejects(new BackupService({ env: f.env, context: { ...f.context, backupInputs: [path.join(f.home, 'outside-input.json')] } }).verifyData({ input: f.output, password: password() }), /BACKUP_EXTERNAL_OWNER/);
  const file = path.join(f.p.userDataRoot, 'input.json'), saved = await fs.readFile(file);
  await fs.writeFile(file, 'dummy-user-edit');
  await assert.rejects(f.make().verifyData({ input: f.output, password: password() }), /BACKUP_DATA_MISMATCH/);
  assert.equal(await fs.readFile(file, 'utf8'), 'dummy-user-edit');
  await fs.unlink(file); await assert.rejects(f.make().verifyData({ input: f.output, password: password() }), /BACKUP_DATA_MISMATCH/);
  await fs.writeFile(file, saved);
  const extra = path.join(f.p.userDataRoot, 'local/state/new-owner.json'); await fs.writeFile(extra, '{}');
  await assert.rejects(f.make().verifyData({ input: f.output, password: password() }), /BACKUP_DATA_MISMATCH/);
  assert.equal(await fs.readFile(extra, 'utf8'), '{}'); await fs.unlink(extra);
  assert.equal((await f.make().verifyData({ input: f.output, password: password() })).status, 'data-preserved');
  assert.deepEqual(await fs.readFile(f.output), archive);
});
