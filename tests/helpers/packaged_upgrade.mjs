import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { upgradeFixture, upgradePassword, upgradeFileHashes } from './upgrade_fixture.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(repo, 'tests/runs/upgrade-packaged'); await fs.mkdir(base, { recursive: true });
const root = await fs.mkdtemp(path.join(base, '离线 & 升级-')); const app = path.join(root, '程序 & 空格');
const { output, report } = JSON.parse(await fs.readFile(path.join(repo, 'tests/runs/phase2b/latest-build.json'))); await fs.cp(output, app, { recursive: true });
for (const file of JSON.parse(await fs.readFile(report)).sources) assert.deepEqual(await fs.readFile(path.join(app, 'resources/core', file)), await fs.readFile(path.join(repo, file)), 'stale packaged source');
const exe = path.join(app, 'PaperEcho.exe'); const pids = []; const cases = [];
async function programMetadata() {
  const entries = {};
  const walk = async dir => { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); const stat = await fs.lstat(file);
    assert.equal(stat.isSymbolicLink(), false); entries[path.relative(app, file)] = [stat.size, stat.mtimeMs, stat.mode]; if (e.isDirectory()) await walk(file); } };
  await walk(app); return entries;
}
const programBefore = await programMetadata();
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: '', LOCALAPPDATA: path.join(root, 'isolated-appdata'),
  TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), PWSH_PATH: process.env.PWSH_PATH, PAPERECHO_SKIP_DOTENV: '1' };
await fs.mkdir(env.TEMP);
async function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { env, cwd: os.tmpdir(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = ''; let stderrPresent = false; const timer = setTimeout(() => { child.kill(); reject(new Error('UPGRADE_PACKAGED_TIMEOUT')); }, 90000);
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.stdout.on('data', b => text = (text + b).slice(-65536)); child.stderr.on('data', () => { stderrPresent = true; });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => { clearTimeout(timer); pids.push(child.pid); const r = text.split(/\r?\n/).filter(s => s.startsWith('{')).map(s => JSON.parse(s)).find(s => s.scope === 'offline-upgrade-plan');
      if (r?.runtime?.pid) pids.push(r.runtime.pid); resolve({ code, report: r, stderrPresent }); });
  });
}
for (const options of [{ layout: 'installed', targetLayout: 'installed' }, { layout: 'portable', targetLayout: 'portable' }, { legacy: true, targetLayout: 'installed' }]) {
  const f = await upgradeFixture(null, { ...options, secret: false, applicationRoot: app });
  const roots = ['--headless', '--runtime-layout', 'installed', '--user-data-root', path.join(root, 'host-data'), '--cache-root', path.join(root, 'host-cache')];
  const input = ['--source-application-root', f.app, '--source-data-root', f.data, '--source-layout', f.input.sourceLayout, '--target-data-root', f.target, '--target-layout', f.input.targetLayout];
  const before = await upgradeFileHashes(f.root);
  for (const action of ['--upgrade-preflight', '--upgrade-dry-run']) {
    const result = await run([...roots, action, ...input, '--verified-backup', f.backup, '--password-stdin'], upgradePassword());
    assert.equal(result.code, 0, JSON.stringify({ step: action, checks: result.report?.checks, stderrPresent: result.stderrPresent }));
    assert.equal(result.report.status, 'PASS'); assert.equal(result.report.runtime.embedded, true); assert.equal(result.report.runtime.browserProcess, false);
    assert.equal(result.report.executionAllowed, false); assert.equal(result.report.osMutation, false); assert.equal(result.report.plan.rollback.backupVerified, true);
    assert.equal(result.report.source.releaseLine, options.legacy ? '2.5' : '2.6');
    assert.ok(!JSON.stringify(result.report).includes(f.root)); assert.doesNotMatch(JSON.stringify(result.report), /dummy-private|dummy-upgrade-local-secret/);
    assert.deepEqual(await upgradeFileHashes(f.root), before); await assert.rejects(fs.lstat(f.target), e => e.code === 'ENOENT');
    cases.push({ source: result.report.source.releaseLine, layout: f.input.sourceLayout, target: f.input.targetLayout, action, status: result.report.status });
  }
  const unknown = await run([...roots, '--upgrade-dry-run', ...input]); assert.equal(unknown.code, 3); assert.equal(unknown.report.status, 'UNKNOWN');
  assert.deepEqual(await upgradeFileHashes(f.root), before);
}
for (const pid of pids) assert.throws(() => process.kill(pid, 0), 'orphan packaged upgrade process');
assert.deepEqual(await programMetadata(), programBefore);
console.log(JSON.stringify({ status: 'PASS', scenarios: cases.length, sourceVersions: ['2.5-contract', '2.6'], targetLayouts: ['portable', 'installed'],
  nativeExe: true, embeddedNode: true, pathEmpty: true, cwdOutsideRepo: true, sourceHashesUnchanged: true, noMigrationRestoreOrOsRegistration: true, noOrphans: true }));
