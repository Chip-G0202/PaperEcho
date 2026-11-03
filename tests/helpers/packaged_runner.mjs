import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { getCurrentFuseWire, FuseState } from '../../desktop/electron-poc/node_modules/@electron/fuses/dist/index.js';
import { fuseConfig } from '../../desktop/electron-poc/package-win.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(repo, 'tests/runs/phase2b');
const { output, report: buildReport } = JSON.parse(await fs.readFile(path.join(base, 'latest-build.json'), 'utf8'));
const fixture = await fs.mkdtemp(path.join(base, '独立 测试-'));
const application = path.join(fixture, '程序 目录'); const data = path.join(fixture, '用户 数据');
await fs.cp(output, application, { recursive: true });
const sources = JSON.parse(await fs.readFile(buildReport, 'utf8')).sources;
for (const source of sources) {
  const target = path.join(application, 'resources/core', source);
  if (source.startsWith('tests/helpers/')) await fs.copyFile(path.join(repo, source), target);
  else assert.deepEqual(await fs.readFile(target), await fs.readFile(path.join(repo, source)), 'stale packaged business source');
}
await fs.mkdir(path.join(data, 'config'), { recursive: true });
await fs.writeFile(path.join(data, '.packaged-smoke-fixture'), 'dummy-only');
await fs.writeFile(path.join(data, 'input.json'), JSON.stringify([{ title: 'Packaged dummy local paper', doi: '10.1234/dummy-packaged' }]));
await fs.writeFile(path.join(data, 'config/paperecho.config.json'), JSON.stringify({ schemaVersion: 2, mode: 'local', common: { projectRoot: '..', llm: { enabled: false, mode: 'disabled' }, email: { enabled: false }, radar: { enabled: true } }, local: { input: '../input.json', outputRoot: '../local' } }));
const exe = path.join(application, 'PaperEcho.exe');
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE,
  ...(process.env.PWSH_PATH ? { PWSH_PATH: process.env.PWSH_PATH } : {}),
  PATH: '', PAPERECHO_LAYOUT: 'installed', PAPERECHO_DATA_ROOT: data, PAPERECHO_SKIP_DOTENV: '1', TEMP: path.join(data, '.cache/tmp'), TMP: path.join(data, '.cache/tmp') };
await fs.mkdir(env.TEMP, { recursive: true });
async function run(command, args, overrides = {}, shell = false, input = '') {
  // The exact-pixel GUI matrix explicitly runs at 100%; leave product/system DPI unchanged.
  if (command === exe && args.includes('--smoke')) args = ['--force-device-scale-factor=1', ...args];
  const began = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: os.tmpdir(), env: { ...env, ...overrides }, shell, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (input) child.stdin.end(input);
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('PACKAGED_TIMEOUT')); }, 60000);
    child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, ms: Math.round(performance.now() - began), output: output.slice(-65536), pid: child.pid }); });
  });
}
async function inventory(root) {
  const map = {};
  async function visit(directory) {
    for (const e of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, e.name); assert.ok(!e.isSymbolicLink());
      if (e.isDirectory()) await visit(file);
      else { const relative = path.relative(root, file); assert.ok(!/(^|[\\/])\.env($|\.)|paperecho\.config\.json$|review_results[\\/]|\.log$/.test(relative), 'forbidden packaged content'); map[relative] = createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
    }
  }
  await visit(root); return map;
}
const before = await inventory(application);
const wire = await getCurrentFuseWire(exe);
for (const key of Object.keys(fuseConfig).filter(x => /^\d+$/.test(x))) assert.equal(wire[key], fuseConfig[key] ? FuseState.ENABLE : FuseState.DISABLE);
const require = createRequire(new URL('../../desktop/electron-poc/package-win.mjs', import.meta.url));
const { NtExecutable, NtExecutableResource } = await import(pathToFileURL(require.resolve('resedit')).href);
const { getRawHeader } = await import(pathToFileURL(require.resolve('@electron/asar')).href);
const entries = NtExecutableResource.from(NtExecutable.from(await fs.readFile(exe))).entries;
const integrity = entries.find(e => e.type === 'INTEGRITY' && e.id === 'ELECTRONASAR');
assert.ok(integrity, 'ASAR integrity metadata missing');
const digest = createHash('sha256').update(getRawHeader(path.join(application, 'resources/app.asar')).headerString).digest('hex');
assert.equal(JSON.parse(Buffer.from(integrity.bin).toString('utf8'))[0].value, digest);
// Deny writes only on this disposable application copy; never change a real installation ACL.
assert.ok(path.relative(base, application) && !path.relative(base, application).startsWith('..'));
const whoami = path.join(process.env.SystemRoot, 'System32/whoami.exe');
const icacls = path.join(process.env.SystemRoot, 'System32/icacls.exe');
const sid = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh']).toString().match(/S-1-[0-9-]+/)[0];
// Generic W includes SYNCHRONIZE, also needed by executable handles; deny mutation rights explicitly.
execFileSync(icacls, [application, '/deny', `*${sid}:(OI)(CI)(WD,AD,WEA,WA,DE,DC)`]);
try {
await assert.rejects(fs.writeFile(path.join(application, 'forbidden-write'), 'dummy'), error => ['EACCES', 'EPERM'].includes(error.code));
const gui = await run(exe, ['--smoke']);
assert.equal(gui.code, 0, 'packaged GUI: ' + gui.output);
const report = JSON.parse(await fs.readFile(path.join(data, 'smoke/smoke-report.json')));
assert.equal(report.views.length, 24); assert.equal(report.ownedServerClosed, true); assert.equal(report.pathEmpty, true);
for (const p of report.processes) assert.throws(() => process.kill(p.pid, 0), 'orphan process');
const cmd = path.join(application, 'PaperEcho-headless.cmd');
const check = await run('"' + cmd + '"', ['--check', '--mode', 'local'], {}, true);
assert.equal(check.code, 0, 'headless wrapper: ' + check.output);
const preflight = check.output.split(/\r?\n/).filter(x => x.startsWith('{')).map(x => JSON.parse(x)).find(x => x.type === 'preflight');
assert.equal(preflight?.canRun, true); assert.deepEqual(preflight.requiredMissing, []);
assert.equal(preflight.mode, 'local'); assert.ok(preflight.readiness.some(x => x.name === 'production_entry' && x.status === 'ready'));
async function dataSnapshot(directory, { directoryTimes = true, temporaryRoot = '' } = {}) {
  const entries = {};
  if (temporaryRoot) assert.ok(path.relative(directory, temporaryRoot) && !path.relative(directory, temporaryRoot).startsWith('..') && !path.isAbsolute(path.relative(directory, temporaryRoot)));
  async function visit(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name); const stat = await fs.stat(file);
    assert.equal((await fs.lstat(file)).isSymbolicLink(), false);
    if (temporaryRoot && path.relative(temporaryRoot, file) === '') continue;
    entries[path.relative(directory, file)] = [stat.mode, entry.isDirectory() && (!directoryTimes || temporaryRoot && file === path.dirname(temporaryRoot)) ? null : stat.mtimeMs, entry.isDirectory() ? null : createHash('sha256').update(await fs.readFile(file)).digest('hex')];
    if (entry.isDirectory()) await visit(file);
  } }
  await visit(directory); return entries;
}
const doctorBefore = await dataSnapshot(data);
const doctor = await run('"' + cmd + '"', ['--doctor'], {}, true);
const doctorReport = JSON.parse(doctor.output);
assert.equal(doctor.code, doctorReport.status === 'FAIL' ? 2 : doctorReport.status === 'UNKNOWN' ? 3 : 0);
assert.equal(doctorReport.canRun, true); assert.ok(doctorReport.checks.some(x => x.checkId === 'runtime.node' && x.summary.includes('Electron')));
assert.deepEqual(await dataSnapshot(data), doctorBefore, 'packaged Doctor must not write user state');
assert.throws(() => process.kill(doctor.pid, 0), 'Doctor orphan process');
const core = path.join(application, 'resources/core');
const probe = await run(exe, [path.join(core, 'tests/helpers/packaged_probe.mjs')], { ELECTRON_RUN_AS_NODE: '1' });
assert.equal(probe.code, 0, 'headless probe: ' + probe.output);
const headless = JSON.parse(await fs.readFile(path.join(data, 'headless-probe.json')));
const bad = await run('"' + cmd + '"', ['--unknown-option'], {}, true); assert.notEqual(bad.code, 0);
const nodeOptions = await run(exe, ['-e', "process.stdout.write('fuse-options-ignored')"], { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=does-not-exist' });
assert.equal(nodeOptions.code, 0); assert.equal(nodeOptions.output.trim(), 'fuse-options-ignored');
const wizardReports = []; const loggingRoots = [data];
for (const [width, height] of [[1920,1080],[1366,768],[390,844]]) {
  const implicit = width === 1920;
  const localAppData = path.join(fixture, 'Windows Local AppData');
  const wizardData = implicit ? path.join(localAppData, 'PaperEcho/workspaces/default') : path.join(fixture, `首次配置-${width}`);
  const rootOverrides = implicit ? { PAPERECHO_DATA_ROOT: '', PAPERECHO_WORKSPACE_ID: '', LOCALAPPDATA: localAppData } : { PAPERECHO_DATA_ROOT: wizardData };
  await fs.mkdir(wizardData, { recursive: true });
  await fs.writeFile(path.join(wizardData, '.packaged-smoke-fixture'), 'dummy-only');
  await fs.writeFile(path.join(wizardData, '.first-run-smoke.json'), JSON.stringify({ width, height }));
  await fs.writeFile(path.join(wizardData, 'input.json'), '[]');
  const wizardRun = await run(exe, ['--smoke'], { ...rootOverrides, TITLE_TRANSLATION_API_KEY: 'dummy-external-wizard' });
  assert.equal(wizardRun.code, 0, `wizard ${width}: ${wizardRun.output}`);
  const wizardReport = JSON.parse(await fs.readFile(path.join(wizardData, 'smoke/smoke-report.json')));
  assert.equal(wizardReport.views.length, 5); assert.equal(wizardReport.ownedServerClosed, true);
  assert.ok(Object.values(wizardReport.wizard).every(Boolean));
  for (const p of wizardReport.processes) assert.throws(() => process.kill(p.pid, 0), 'wizard orphan process');
  const wizardCheck = await run('"' + cmd + '"', ['--check', '--mode', 'local'], { ...rootOverrides, PAPERECHO_SKIP_DOTENV: '' }, true);
  assert.equal(wizardCheck.code, 0, 'configured wizard headless check');
  wizardReports.push({ width, height, ...wizardReport.wizard, headlessCode: wizardCheck.code });
  loggingRoots.push(wizardData);
}
for (const root of loggingRoots) {
  const logs = path.join(root, 'logs');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(logs, 'runtime.owner.json'), 'utf8')), { schemaVersion: 1, owner: 'paperecho-runtime-log', maxBytes: 1048576, archives: 1 });
  const names = await fs.readdir(logs);
  assert.ok(names.every(name => ['runtime.owner.json', 'runtime.jsonl', 'runtime.previous.jsonl'].includes(name)), 'leftover log staging/lock');
  const records = [];
  for (const name of names.filter(name => name.endsWith('.jsonl'))) {
    const bytes = await fs.readFile(path.join(logs, name)); assert.ok(bytes.length <= 1048576);
    const text = bytes.toString('utf8'); assert.ok(text.endsWith('\n'));
    assert.doesNotMatch(text, /dummy-|Packaged dummy|\bat .*\.mjs:/);
    records.push(...text.trim().split('\n').map(JSON.parse));
  }
  for (const code of ['GUI_STARTED', 'GUI_READY', 'GUI_EXIT', 'HEADLESS_STARTED', 'RUNNER_STARTED', 'RUNNER_PREFLIGHT_READY']) assert.ok(records.some(record => record.code === code), 'packaged log event missing: ' + code);
  assert.equal(new Set(records.map(record => record.eventId)).size, records.length);
}
assert.deepEqual(await inventory(application), before, 'application directory was modified');
// Existing writer locks change only their parent directory entry timestamps.
// Preserve names/modes and every file's bytes/mtime; Doctor still checks all times.
const { secureCredentialFile } = await import('../../workflow/tools/lib/credential_file_security.mjs');
await fs.writeFile(path.join(data, '.env'), '', { flag: 'wx', mode: 0o600 });
await secureCredentialFile(path.join(data, '.env'));
await fs.writeFile(path.join(data, '.env'), 'SMTP_PASS=dummy-packaged-restore-value\n');
const backupBefore = await dataSnapshot(data, { directoryTimes: false });
const backupOutput = path.join(fixture, '用户 备份.pebackup');
const backup = await run('"' + cmd + '"', ['--backup', '"' + backupOutput + '"', '--password-stdin'], {}, true, 'dummy-packaged-backup-password\n');
assert.equal(backup.code, 0, 'packaged backup failed: ' + backup.output);
assert.equal(JSON.parse(backup.output).status, 'created');
const verifyRoot = path.join(fixture, 'verify-no-workspace');
const verify = await run('"' + cmd + '"', ['--verify-backup', '"' + backupOutput + '"', '--password-stdin'], { PAPERECHO_DATA_ROOT: verifyRoot }, true, 'dummy-packaged-backup-password\n');
assert.equal(verify.code, 0, 'packaged verify failed: ' + verify.output);
assert.equal(JSON.parse(verify.output).authenticated, true);
assert.equal(JSON.parse(verify.output).restoreReady, false);
await assert.rejects(fs.access(verifyRoot));
assert.deepEqual(await dataSnapshot(data, { directoryTimes: false }), backupBefore, 'backup/verify changed source user state');
const restoreTarget = path.join(fixture, '全新 恢复数据');
const restored = await run('"' + cmd + '"', ['--restore-backup', '"' + backupOutput + '"', '--target-data-root', '"' + restoreTarget + '"', '--password-stdin'], {}, true, 'dummy-packaged-backup-password\n');
assert.equal(restored.code, 0, 'packaged restore failed: ' + restored.output);
const restoreResult = JSON.parse(restored.output); assert.equal(restoreResult.status, 'restored'); assert.equal(restoreResult.byteIdentical, true); assert.equal(restoreResult.reactivatedClaims, false);
const { openBackup } = await import('../../workflow/tools/lib/backup_format.mjs');
const { validateBackupManifest } = await import('../../workflow/tools/lib/backup_service.mjs');
const manifest = await openBackup(await fs.readFile(backupOutput), Buffer.from('dummy-packaged-backup-password'), validateBackupManifest);
for (const file of manifest.files) assert.equal(createHash('sha256').update(await fs.readFile(path.join(restoreTarget, file.path))).digest('hex'), file.sha256);
const { resolveRuntimePaths } = await import('../../workflow/tools/lib/runtime_config.mjs');
const restoredPaths = resolveRuntimePaths({ applicationRoot: application, env: { ...env, PAPERECHO_DATA_ROOT: restoreTarget } });
// PowerShell ACL inspection uses the formal Temporary Root for transient runtime
// files. Keep strict business snapshots and require this one directory to be empty.
const restoredBefore = await dataSnapshot(restoreTarget, { temporaryRoot: restoredPaths.tempRoot });
const restoredDoctor = await run('"' + cmd + '"', ['--doctor'], { PAPERECHO_DATA_ROOT: restoreTarget }, true);
const restoredReport = JSON.parse(restoredDoctor.output); assert.equal(restoredReport.canRun, false);
assert.equal(restoredReport.checks.find(x => x.checkId === 'configuration')?.status, 'PASS'); assert.equal(restoredReport.checks.find(x => x.checkId === 'secrets')?.status, 'PASS');
assert.deepEqual(await dataSnapshot(restoreTarget, { temporaryRoot: restoredPaths.tempRoot }), restoredBefore, 'restored Doctor wrote persistent user data');
assert.deepEqual(await fs.readdir(restoredPaths.tempRoot), [], 'Doctor left temporary runtime files');
const restoredCheck = await run('"' + cmd + '"', ['--check'], { PAPERECHO_DATA_ROOT: restoreTarget }, true);
assert.notEqual(restoredCheck.code, 0, 'restored history cannot activate without review');
for (const file of manifest.files) assert.equal(createHash('sha256').update(await fs.readFile(path.join(restoreTarget, file.path))).digest('hex'), file.sha256, 'restored check changed business data');
assert.deepEqual(await dataSnapshot(data, { directoryTimes: false }), backupBefore, 'restore changed source workspace');
for (const process of [backup, verify, restored, restoredDoctor, restoredCheck]) assert.throws(() => globalThis.process.kill(process.pid, 0), 'backup/restore orphan process');
// Explicit confirmation is injected into the real packaged CLI entry, never via
// a production env switch or --force. All inputs are this dummy-only fixture.
const runnerUrl = pathToFileURL(path.join(application, 'resources/core/workflow/tools/runner/main.mjs')).href;
const runtimeUrl = pathToFileURL(path.join(application, 'resources/core/desktop/electron-poc/runtime.mjs')).href;
const transactionCache = path.join(fixture, '独立 事务缓存'); await fs.mkdir(path.join(transactionCache, 'tmp'), { recursive: true });
async function transactionCli(args, input = '') {
  const code = `if(!process.versions.electron)throw Error('PACKAGED_RUNTIME_REQUIRED');const args=${JSON.stringify(args)};process.argv=[process.execPath,'packaged-confirmation-test',...args];const {preparePackagedRuntime}=await import(${JSON.stringify(runtimeUrl)});preparePackagedRuntime({readOnly:true});const {main}=await import(${JSON.stringify(runnerUrl)});process.exitCode=await main(args,{confirmRestore:async()=>true});`;
  const selectedRoot = args[args.indexOf('--target-data-root') + 1];
  const result = await run(exe, ['--input-type=module', '-e', code], { ELECTRON_RUN_AS_NODE: '1', PAPERECHO_DATA_ROOT: selectedRoot, PAPERECHO_CACHE_ROOT: transactionCache }, false, input);
  assert.equal(result.code, 0, 'packaged transaction CLI: ' + result.output);
  assert.throws(() => process.kill(result.pid, 0)); return JSON.parse(result.output);
}
const transactionBefore = await dataSnapshot(restoreTarget, { directoryTimes: false });
const transactionPreview = await transactionCli(['--restore-preflight', backupOutput, '--target-data-root', restoreTarget, '--password-stdin'], 'dummy-packaged-backup-password\n');
assert.equal(transactionPreview.confirmationRequired, true);
const committed = await transactionCli(['--restore-existing', backupOutput, '--target-data-root', restoreTarget, '--password-stdin'], 'dummy-packaged-backup-password\n');
assert.equal(committed.status, 'committed'); assert.equal(committed.rollbackRetained, true);
const { restoreTransactionRoot } = await import('../../workflow/tools/recovery/restore_transaction_status.mjs');
assert.deepEqual(await dataSnapshot(path.join(restoreTransactionRoot(restoreTarget), 'old'), { directoryTimes: false }), transactionBefore);
assert.equal((await transactionCli(['--restore-rollback', '--target-data-root', restoreTarget])).status, 'rolled-back');
assert.deepEqual(await dataSnapshot(restoreTarget, { directoryTimes: false }), transactionBefore);
const pendingRoot = path.join(fixture, '中断 恢复数据');
const pendingSetup = await run('"' + cmd + '"', ['--restore-backup', '"' + backupOutput + '"', '--target-data-root', '"' + pendingRoot + '"', '--password-stdin'], {}, true, 'dummy-packaged-backup-password\n');
assert.equal(pendingSetup.code, 0, 'pending GUI fixture restore'); assert.throws(() => process.kill(pendingSetup.pid, 0));
const transactionUrl = pathToFileURL(path.join(application, 'resources/core/workflow/tools/recovery/restore_transaction.mjs')).href;
const pauseCode = `process.argv=[process.execPath,'packaged-crash-test','--restore-existing'];const {preparePackagedRuntime}=await import(${JSON.stringify(runtimeUrl)});preparePackagedRuntime({readOnly:true});const {RestoreTransaction}=await import(${JSON.stringify(transactionUrl)});await new RestoreTransaction({hook:async phase=>{if(phase==='NEW_PUBLISHED'){process.send({phase});await new Promise(()=>setInterval(()=>{},1000));}}}).replace({input:${JSON.stringify(backupOutput)},target:${JSON.stringify(pendingRoot)},password:Buffer.from('dummy-packaged-backup-password'),confirm:async()=>true});`;
const paused = spawn(exe, ['--input-type=module', '-e', pauseCode], { cwd: fixture, env: { ...env, ELECTRON_RUN_AS_NODE: '1', PAPERECHO_DATA_ROOT: pendingRoot, PAPERECHO_CACHE_ROOT: transactionCache }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
const pausedClosed = new Promise(resolve => paused.once('close', resolve)); let pauseTimer;
try {
  await new Promise((resolve, reject) => {
    pauseTimer = setTimeout(() => reject(new Error('PACKAGED_TRANSACTION_PHASE_TIMEOUT')), 60000);
    paused.once('error', reject); paused.once('close', () => reject(new Error('PACKAGED_TRANSACTION_EARLY_EXIT')));
    paused.once('message', message => message.phase === 'NEW_PUBLISHED' ? resolve() : reject(new Error('PACKAGED_TRANSACTION_PHASE_INVALID')));
  }); clearTimeout(pauseTimer);
  const pendingBefore = await dataSnapshot(pendingRoot, { directoryTimes: false });
  const recoveryGui = await run(exe, ['--smoke', '--smoke-restore'], { PAPERECHO_DATA_ROOT: pendingRoot });
  assert.equal(recoveryGui.code, 0, 'packaged recovery GUI: ' + recoveryGui.output);
  const recoveryReport = JSON.parse(await fs.readFile(path.join(restoreTransactionRoot(pendingRoot), 'gui-cache/smoke/smoke-report.json')));
  assert.deepEqual(recoveryReport.views, [[1920, 1080], [1366, 768], [390, 844]].map(([width, height]) => ({ width, height, route: 'system', restoreBlocked: true })));
  assert.equal(recoveryReport.ownedServerClosed, true);
  for (const child of recoveryReport.processes) assert.throws(() => process.kill(child.pid, 0));
  assert.deepEqual(await dataSnapshot(pendingRoot, { directoryTimes: false }), pendingBefore);
} finally { clearTimeout(pauseTimer); paused.kill('SIGKILL'); await pausedClosed; }
assert.throws(() => process.kill(paused.pid, 0));
assert.equal((await transactionCli(['--restore-recover', '--target-data-root', pendingRoot])).status, 'rolled-back');
assert.deepEqual(await dataSnapshot(data, { directoryTimes: false }), backupBefore, 'transaction changed source workspace');
assert.deepEqual(await inventory(application), before, 'transaction changed application');
for (const run of [gui, check, probe, bad, nodeOptions]) assert.throws(() => process.kill(run.pid, 0));
const sizes = await Promise.all(Object.keys(before).map(f => fs.stat(path.join(application, f))));
await fs.writeFile(path.join(fixture, 'report.json'), JSON.stringify({ application, data, sizeBytes: sizes.reduce((n, s) => n + s.size, 0), fileCount: sizes.length, fuses: wire, gui: { startupMs: report.startupMs, idleWorkingSetMiB: report.idleWorkingSetMiB, views: report.views.length }, wizardReports, headless, check: { code: check.code, durationMs: check.ms }, exceptionCode: bad.code, pathEmpty: true, cwdOutsideRepo: true, noOrphans: true, applicationUnchanged: true, readOnlyApplication: true, asarIntegrityMatch: true }, null, 2));
await fs.writeFile(path.join(base, 'latest-smoke.json'), JSON.stringify({ report: path.join(fixture, 'report.json') }));
console.log('PACKAGED_GUI_HEADLESS_PASSED ' + path.join(fixture, 'report.json'));
} finally {
  execFileSync(icacls, [application, '/remove:d', `*${sid}`]);
}
