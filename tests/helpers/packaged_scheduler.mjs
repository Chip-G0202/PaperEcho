import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { getCurrentFuseWire, FuseState, FuseV1Options as F } from '../../desktop/electron-poc/node_modules/@electron/fuses/dist/index.js';
import { windowsArgument } from '../../workflow/tools/lib/os_scheduler.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(repo, 'tests/runs/scheduler'); await fs.mkdir(base, { recursive: true });
const root = await fs.mkdtemp(path.join(base, '打包 & (离线)-'));
const { output, report: reportFile } = JSON.parse(await fs.readFile(path.join(repo, 'tests/runs/phase2b/latest-build.json')));
const app = path.join(root, '程序 & (空格)'); await fs.cp(output, app, { recursive: true });
for (const source of JSON.parse(await fs.readFile(reportFile)).sources) assert.deepEqual(await fs.readFile(path.join(app, 'resources/core', source)), await fs.readFile(path.join(repo, source)), 'stale package source');
const exe = path.join(app, 'PaperEcho.exe'); const wire = await getCurrentFuseWire(exe);
assert.equal(wire[F.RunAsNode], FuseState.ENABLE); assert.equal(wire[F.EnableNodeOptionsEnvironmentVariable], FuseState.DISABLE);
assert.equal(wire[F.OnlyLoadAppFromAsar], FuseState.ENABLE); assert.equal(wire[F.EnableEmbeddedAsarIntegrityValidation], FuseState.ENABLE);
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, LOCALAPPDATA: path.join(root, 'isolated-local-appdata'),
  ...(process.env.PWSH_PATH ? { PWSH_PATH: process.env.PWSH_PATH } : {}),
  PATH: '', PAPERECHO_SKIP_DOTENV: '1', TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp') };
await fs.mkdir(env.TEMP);
async function inventory(dir) {
  const result = {};
  async function walk(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name); const stat = await fs.lstat(file); assert.equal(stat.isSymbolicLink(), false);
    result[path.relative(root, file)] = [stat.size, stat.mtimeMs, stat.mode]; if (e.isDirectory()) await walk(file);
  } }
  await walk(dir); return result;
}
const programBefore = await inventory(app); const outcomes = []; const pids = [];
async function run(argv, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    // Pass exactly the native quoted argv used in the generated Windows XML.
    const child = spawn(exe, argv.map(windowsArgument), { argv0: windowsArgument(exe), env: { ...env, ...extraEnv }, cwd: os.tmpdir(), shell: false, windowsHide: true, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('PACKAGED_SCHEDULER_TIMEOUT')); }, 90000);
    child.stdout.on('data', b => output = (output + b).slice(-65536)); child.stderr.on('data', b => errors = (errors + b).slice(-4096));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); pids.push(child.pid);
      const lines = output.split(/\r?\n/).filter(s => s.startsWith('{')).map(s => JSON.parse(s));
      const report = lines.find(s => s.osMutation === false); if (report?.runtime?.pid) pids.push(report.runtime.pid);
      resolve({ code, report, lines, stderr: errors.length > 0 });
    });
  });
}
for (const layout of ['installed', 'portable']) {
  const data = layout === 'portable' ? path.join(app, 'data') : path.join(root, '用户 & (数据)');
  const cache = layout === 'portable' ? path.join(app, 'cache') : path.join(data, '.cache');
  await fs.mkdir(path.join(data, 'config'), { recursive: true }); await fs.mkdir(cache, { recursive: true });
  const config = { schemaVersion: 6, mode: 'desktop', profile: 'standard', scheduler: { schemaVersion: 1, enabled: true, time: '15:00', timezone: 'Asia/Shanghai' },
    common: { projectRoot: '..', llm: { enabled: false, mode: 'disabled' }, email: { enabled: false }, radar: { enabled: true } },
    desktop: { enabled: true, zoteroExe: exe, cliTool: exe } };
  await fs.writeFile(path.join(data, 'config/paperecho.config.json'), JSON.stringify(config));
  const args = ['--headless', '--runtime-layout', layout, '--user-data-root', data, '--cache-root', cache];
  const before = await inventory(data);
  for (const command of ['--schedule-preflight', '--schedule-dry-run']) {
    const result = await run([...args, command]);
    assert.equal(result.code, 0, JSON.stringify({ step: command, status: result.report?.status, checks: result.report?.checks, stderr: result.stderr }));
    assert.equal(result.report.status, 'PASS'); assert.equal(result.report.runtime.embedded, true); assert.equal(result.report.runtime.browserProcess, false);
    assert.equal(result.report.runtime.node, '24.21.0'); assert.equal(result.report.osMutation, false); assert.equal(result.report.schedule.layout, layout);
    assert.ok(!JSON.stringify(result.report).includes(root));
    if (command === '--schedule-dry-run') assert.match(result.report.definition.content, /__USER_DATA_ROOT__/);
    outcomes.push({ layout, command, status: result.report.status, embedded: true, noBrowserProcess: true });
  }
  assert.deepEqual(await inventory(data), before);
  const unknown = await run([...args, '--schedule-dry-run'], { TITLE_TRANSLATION_API_KEY: 'dummy-external-packaged-scheduler' });
  assert.equal(unknown.code, 3); assert.equal(unknown.report.status, 'UNKNOWN'); assert.equal(unknown.report.definition, undefined);
  await fs.writeFile(path.join(data, '.paperecho-restore.json'), JSON.stringify({ schemaVersion: 1, stateReviewRequired: true }));
  const blocked = await run([...args, '--schedule-dry-run']); assert.equal(blocked.code, 2); assert.equal(blocked.report.status, 'FAIL'); assert.equal(blocked.report.definition, undefined);
  await fs.unlink(path.join(data, '.paperecho-restore.json'));
  // Existing --check remains GUI-independent, using the same explicit roots.
  const check = await run([...args, '--check', '--mode', 'desktop']); assert.equal(check.code, 0); assert.equal(check.lines.find(x => x.type === 'preflight')?.canRun, true);
}
// Portable mutable children are intentionally within Application Root; compare
// only program resources after removing those inventory entries, not user data.
const programAfter = await inventory(app);
for (const key of Object.keys(programAfter)) if (/^[^\\/]+[\\/](data|cache)([\\/]|$)/.test(key)) delete programAfter[key];
// inventory keys include the literal application folder, which itself has a new mtime.
delete programAfter[path.relative(root, app)]; delete programBefore[path.relative(root, app)];
assert.deepEqual(programAfter, programBefore);
for (const pid of pids) assert.throws(() => process.kill(pid, 0), 'orphan packaged scheduler process');
console.log(JSON.stringify({ status: 'PASS', scenarios: outcomes.length, layouts: ['installed', 'portable'], emptyPath: true, cwdOutsideRepo: true,
  runtimeNode: '24.21.0', nativeExeEntry: true, realOsRegistration: false, unknownSecretBlocked: true, restoredHistoryBlocked: true, sourceUnchanged: true, noOrphans: true, fuses: 'verified' }));
