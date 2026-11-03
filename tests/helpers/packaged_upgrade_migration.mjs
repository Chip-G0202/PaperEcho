import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrationFixture, upgradeFileHashes, upgradePassword } from './upgrade_migration_fixture.mjs';
import { terminateMigrationAt } from './upgrade_migration_process.mjs';
import { holdRestoreParent } from '../../workflow/tools/lib/restore_filesystem.mjs';
import { sha256 } from '../../workflow/tools/lib/backup_format.mjs';
import { inspectRestoreTransaction } from '../../workflow/tools/recovery/restore_transaction_status.mjs';

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const outsideCwd = path.parse(repo).root;
assert.ok(path.relative(repo, outsideCwd).startsWith('..'), 'PACKAGED_CWD_MUST_BE_OUTSIDE_REPOSITORY');
const { output, report } = JSON.parse(await fs.readFile(path.join(repo, 'tests/runs/phase2b/latest-build.json')));
const sources = JSON.parse(await fs.readFile(report)).sources;
const parent = path.join(repo, 'tests/runs/phase6b'); await fs.mkdir(parent, { recursive: true });
let cases = 0;
for (const targetLayout of ['installed', 'portable']) for (const interrupted of [false, true]) {
  const workspace = path.join(parent, randomUUID()), app = path.join(workspace, 'new-program');
  const guard = await holdRestoreParent(workspace); await guard.release();
  const pids = [];
  try {
    await fs.cp(output, app, { recursive: true });
    const immutable = [...sources.map(file => path.join('resources/core', file)), 'PaperEcho.exe', 'resources/app.asar'];
    const hashes = {};
    for (const file of immutable) hashes[file] = sha256(await fs.readFile(path.join(app, file)));
    for (const file of sources) assert.equal(hashes[path.join('resources/core', file)], sha256(await fs.readFile(path.join(repo, file))), 'STALE_PACKAGED_SOURCE');
    const f = await migrationFixture(null, { workspace, applicationRoot: app, schema: targetLayout === 'installed' ? 3 : 6, targetLayout, history: true });
    const archive = sha256(await fs.readFile(f.backup));
    const exe = path.join(app, 'PaperEcho.exe'), cache = path.join(workspace, 'host-cache');
    await fs.mkdir(path.join(cache, 'tmp'), { recursive: true });
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: '', PWSH_PATH: process.env.PWSH_PATH,
      LOCALAPPDATA: path.join(workspace, 'isolated-appdata'), TEMP: path.join(cache, 'tmp'), TMP: path.join(cache, 'tmp'), PAPERECHO_SKIP_DOTENV: '1' };
    assert.ok(path.isAbsolute(env.PWSH_PATH || ''), 'PWSH_PATH_REQUIRED_FOR_EMPTY_PATH');
    const roots = ['--headless', '--runtime-layout', 'installed', '--user-data-root', path.join(workspace, 'host-data'), '--cache-root', cache];
    async function run(action, password) {
      const args = [...roots, action, '--isolated-workspace', workspace, '--confirm-plan', f.plan.id, ...(action === '--upgrade-execute' ? ['--password-stdin'] : [])];
      return new Promise((resolve, reject) => {
        const child = spawn(exe, args, { env, cwd: outsideCwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        let text = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('PACKAGED_MIGRATION_TIMEOUT')); }, 90000);
        child.stdin.on('error', () => {}); child.stdin.end(password);
        child.stdout.on('data', chunk => text = (text + chunk).slice(-65536)); child.stderr.on('data', () => {});
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => {
          clearTimeout(timer); pids.push(child.pid);
          try {
            const value = text.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line)).at(-1);
            if (value?.runtime?.pid) pids.push(value.runtime.pid);
            resolve({ code, value });
          } catch { reject(new Error('PACKAGED_MIGRATION_INVALID_REPORT')); }
        });
      });
    }
    const wrong = await run('--upgrade-execute', Buffer.from('dummy-wrong-migration-password'));
    assert.equal(wrong.code, 3); assert.equal(wrong.value.code, 'UPGRADE_PLAN_STALE_OR_BLOCKED');
    assert.equal(inspectRestoreTransaction(f.target).state, 'ABSENT'); cases++;
    if (interrupted) {
      const runtime = await terminateMigrationAt(f, 'NEW_PUBLISHED', { runtime: exe,
        serviceURL: pathToFileURL(path.join(app, 'resources/core/workflow/tools/lib/upgrade_migration_service.mjs')).href,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, cwd: outsideCwd });
      assert.equal(runtime.embedded, true); assert.equal(runtime.browserProcess, false);
      assert.equal(inspectRestoreTransaction(f.data).blocking, true); assert.equal(inspectRestoreTransaction(f.target).blocking, true);
      const recovered = await run('--upgrade-recover'); assert.equal(recovered.code, 0, recovered.value?.code); assert.equal(recovered.value.status, 'rolled-back'); cases++;
    } else {
      const result = await run('--upgrade-execute', upgradePassword());
      assert.equal(result.code, 0, result.value?.code); assert.equal(result.value.status, 'committed'); assert.equal(result.value.runtime.embedded, true); assert.equal(result.value.runtime.browserProcess, false);
      assert.equal(result.value.doctor.canRun, false); assert.equal(result.value.reactivatedClaims, false); assert.equal(result.value.osMutation, false);
      assert.ok(result.value.ownerCoverage.every(owner => owner.status === 'covered')); cases++;
      const repeated = await run('--upgrade-execute', upgradePassword()); assert.equal(repeated.code, 0); assert.equal(repeated.value.operationId, result.value.operationId); cases++;
      const rollback = await run('--upgrade-rollback'); assert.equal(rollback.code, 0, rollback.value?.code); assert.equal(rollback.value.status, 'rolled-back'); cases++;
    }
    const repeated = await run('--upgrade-recover'); assert.equal(repeated.code, 0, repeated.value?.code); assert.equal(repeated.value.status, 'rolled-back'); cases++;
    await assert.rejects(fs.lstat(f.target), error => error.code === 'ENOENT');
    assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes); assert.equal(sha256(await fs.readFile(f.backup)), archive);
    assert.equal(inspectRestoreTransaction(f.data).blocking, false);
    for (const file of immutable) assert.equal(sha256(await fs.readFile(path.join(app, file))), hashes[file], 'PROGRAM_FILE_CHANGED');
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), 'PACKAGED_MIGRATION_ORPHAN');
    console.log(JSON.stringify({ step: 'packaged-migration', targetLayout, interrupted, status: 'PASS' }));
  } finally {
    if (path.dirname(workspace) !== parent || !/^[a-f0-9-]{36}$/.test(path.basename(workspace))) throw new Error('FIXTURE_SCOPE_INVALID');
    await fs.rm(workspace, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ status: 'PASS', cases, targetLayouts: ['installed', 'portable'], nativeExe: true, embeddedNode: true,
  pathEmpty: true, cwdOutsideRepo: true, authenticatedBackup: true, sourceUnchanged: true, crashRecovery: true, rollback: true, noOsRegistration: true, noOrphans: true }));
