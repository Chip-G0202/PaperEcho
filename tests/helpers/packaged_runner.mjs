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
await fs.writeFile(path.join(data, 'config/paperecho.config.json'), JSON.stringify({ schemaVersion: 2, mode: 'local', common: { projectRoot: data, llm: { enabled: false, mode: 'disabled' }, email: { enabled: false }, radar: { enabled: true } }, local: { input: '../input.json', outputRoot: '../local' } }));
const exe = path.join(application, 'PaperEcho.exe');
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE,
  ...(process.env.PWSH_PATH ? { PWSH_PATH: process.env.PWSH_PATH } : {}),
  PATH: '', PAPERECHO_LAYOUT: 'installed', PAPERECHO_DATA_ROOT: data, PAPERECHO_SKIP_DOTENV: '1', TEMP: path.join(data, '.cache/tmp'), TMP: path.join(data, '.cache/tmp') };
await fs.mkdir(env.TEMP, { recursive: true });
async function run(command, args, overrides = {}, shell = false) {
  const began = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: os.tmpdir(), env: { ...env, ...overrides }, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
async function dataSnapshot(directory) {
  const entries = {};
  async function visit(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name); const stat = await fs.stat(file);
    entries[path.relative(directory, file)] = [stat.mode, stat.mtimeMs, entry.isDirectory() ? null : createHash('sha256').update(await fs.readFile(file)).digest('hex')];
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
const wizardReports = [];
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
}
assert.deepEqual(await inventory(application), before, 'application directory was modified');
for (const run of [gui, check, probe, bad, nodeOptions]) assert.throws(() => process.kill(run.pid, 0));
const sizes = await Promise.all(Object.keys(before).map(f => fs.stat(path.join(application, f))));
await fs.writeFile(path.join(fixture, 'report.json'), JSON.stringify({ application, data, sizeBytes: sizes.reduce((n, s) => n + s.size, 0), fileCount: sizes.length, fuses: wire, gui: { startupMs: report.startupMs, idleWorkingSetMiB: report.idleWorkingSetMiB, views: report.views.length }, wizardReports, headless, check: { code: check.code, durationMs: check.ms }, exceptionCode: bad.code, pathEmpty: true, cwdOutsideRepo: true, noOrphans: true, applicationUnchanged: true, readOnlyApplication: true, asarIntegrityMatch: true }, null, 2));
await fs.writeFile(path.join(base, 'latest-smoke.json'), JSON.stringify({ report: path.join(fixture, 'report.json') }));
console.log('PACKAGED_GUI_HEADLESS_PASSED ' + path.join(fixture, 'report.json'));
} finally {
  execFileSync(icacls, [application, '/remove:d', `*${sid}`]);
}
