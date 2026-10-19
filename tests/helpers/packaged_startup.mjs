// Offline final-source startup gate. The driver uses Node; every application
// check, interrupted writer and recovery runs in the actual packaged binary.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const self = fileURLToPath(import.meta.url), mode = process.argv[2];
const load = (core, file) => import(pathToFileURL(path.join(core, file)).href);
if (['--crash', '--recover'].includes(mode)) {
  const core = process.argv[3];
  assert.equal(process.versions.electron, '44.7.2'); assert.equal(process.type, undefined); assert.equal(process.env.PATH, '');
  const { preparePackagedRuntime } = await load(core, 'desktop/electron-poc/runtime.mjs');
  const paths = preparePackagedRuntime({ readOnly: true }); assert.equal(path.resolve(paths.resourceRoot), path.resolve(core));
  const runRoot = path.join(paths.userDataRoot, 'local/runs'), runId = process.argv[4];
  const { acquireWorkflowLease, releaseRunLease } = await load(core, 'workflow/tools/recovery/operation_ledger.mjs');
  const { createRunRecoveryCoordinator, resumeRunFromLedger, acquireStartupWorkflowLease } = await load(core, 'workflow/tools/recovery/run_recovery.mjs');
  if (mode === '--crash') {
    const { startRunGroup } = await load(core, 'workflow/tools/lib/runtime_housekeeping.mjs');
    const { createNotificationReceipt, writeNotificationReceipt } = await load(core, 'workflow/tools/stage5/email_receipt.mjs');
    assert.equal((await acquireWorkflowLease({ runRoot, runId, profile: 'standard', ttlMs: 1 }, { clock: () => new Date('2000-01-01') })).acquired, true);
    await startRunGroup({ runRoot, runId, pipelineMode: 'local' });
    const c = await createRunRecoveryCoordinator({ runRoot, runId, mode: 'local', profile: 'standard', configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath: path.join(runRoot, runId, 'input_artifact.json') });
    await c.persistArtifact([]);
    for (const stage of ['stage1', 'state_persist', 'stage4_exports']) await c.store.setStage(stage, 'verified');
    const receiptPath = path.join(runRoot, runId, 'stage5/email_receipt.json');
    const operation = await c.prepareFileOperation({ type: 'notification', targetId: 'dummy', targetPath: receiptPath, input: {}, retryable: false, intent: { notificationType: 'run_summary', eventEpoch: runId } });
    const receipt = createNotificationReceipt({ notificationType: 'run_summary', runId, businessSubject: runId, eventEpoch: runId, payload: {}, recipient: 'fixture@example.invalid', ledgerOperationId: operation.idempotencyKey });
    receipt.status = runId === 'accepted' ? 'accepted' : 'unknown'; await writeNotificationReceipt(receiptPath, receipt);
    process.on('message', () => {}); process.send({ step: 'persisted' });
  } else {
    const lease = await acquireStartupWorkflowLease({ runRoot, runId, resumeRunId: runId, profile: 'standard', dataRoots: [paths.userDataRoot] });
    assert.equal(lease.acquired, true);
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        const result = await resumeRunFromLedger({ runRoot, runId, mode: 'local', profile: 'standard', configHash: 'a'.repeat(64),
          notification: { recipient: 'fixture@example.invalid', transport: () => assert.fail('NO_NOTIFICATION_REPLAY') }, buildReconcilers: () => assert.fail('NO_BUSINESS_REPLAY') });
        assert.equal(result.status, 'completed');
      }
    } finally { await releaseRunLease(lease); }
    console.log('PACKAGED_RECOVERY_IDEMPOTENT');
  }
} else {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const { output, report } = JSON.parse(await fs.readFile(path.join(repo, 'tests/runs/phase2b/latest-build.json')));
  const sources = JSON.parse(await fs.readFile(report)).sources;
  for (const source of sources.filter(file => !file.startsWith('tests/helpers/'))) assert.deepEqual(await fs.readFile(path.join(output, 'resources/core', source)), await fs.readFile(path.join(repo, source)), 'STALE_PACKAGED_SOURCE');
  const base = path.join(repo, 'tests/runs/phase10'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'packaged-startup-')), pids = [], results = [];
  console.log('PACKAGED_STARTUP_FIXTURE ' + path.basename(root));
  const outside = path.parse(repo).root;
  const safeEnv = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, PATH: '', PAPERECHO_SKIP_DOTENV: '1' };
  async function run(exe, args, env, crash = false) {
    if (args.includes('--smoke')) args = ['--force-device-scale-factor=1', ...args];
    const child = spawn(exe, args, { cwd: outside, env, windowsHide: true, shell: false, stdio: crash ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] }); pids.push(child.pid);
    let text = '', timer;
    child.stdout.on('data', b => { text = (text + b).slice(-32768); }); child.stderr.on('data', b => { text = (text + b).slice(-32768); });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, text })); });
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PACKAGED_STARTUP_TIMEOUT')), 90000); });
      if (crash) { await Promise.race([new Promise(resolve => child.once('message', m => { assert.equal(m.step, 'persisted'); resolve(); })), closed.then(() => assert.fail('CRASH_BOUNDARY_NOT_REACHED')), timeout]); child.kill(); }
      return await Promise.race([closed, timeout]);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill(); await closed; } }
  }
  async function businessSnapshot(data) {
    const hashes = {};
    async function visit(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { if (['.cache', 'logs', 'smoke'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name); assert.equal(entry.isSymbolicLink(), false); if (entry.isDirectory()) await visit(file); else hashes[path.relative(data, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex'); } }
    await visit(data); return hashes;
  }
  for (const layout of ['installed', 'portable']) {
    const app = path.join(root, layout, '程序 目录'); await fs.cp(output, app, { recursive: true });
    for (const source of sources.filter(file => file.startsWith('tests/helpers/'))) await fs.copyFile(path.join(repo, source), path.join(app, 'resources/core', source));
    const data = layout === 'portable' ? path.join(app, 'data') : path.join(root, layout, '用户 数据');
    await fs.mkdir(path.join(data, 'config'), { recursive: true });
    await fs.writeFile(path.join(data, '.packaged-smoke-fixture'), 'dummy-only'); await fs.writeFile(path.join(data, 'input.json'), '[]');
    await fs.writeFile(path.join(data, 'config/paperecho.config.json'), JSON.stringify({ schemaVersion: 6, mode: 'local', common: { projectRoot: '..', llm: { enabled: false, mode: 'disabled' }, email: { enabled: false } }, local: { input: '../input.json', outputRoot: '../local' } }));
    const exe = path.join(app, 'PaperEcho.exe'), core = path.join(app, 'resources/core');
    const temp = path.join(layout === 'portable' ? app : data, '.cache/tmp'); await fs.mkdir(temp, { recursive: true });
    const env = { ...safeEnv, TEMP: temp, TMP: temp, ELECTRON_RUN_AS_NODE: '1', PAPERECHO_LAYOUT: layout, PAPERECHO_DATA_ROOT: data };
    const headless = path.join(core, 'desktop/electron-poc/headless.mjs');
    const cold = await run(exe, [headless, '--check'], env); assert.equal(cold.code, 0, 'COLD_HEADLESS_CHECK');
    if (mode === '--cold-only') {
      await fs.writeFile(path.join(data, '.startup-cold-smoke-fixture'), 'dummy-only');
      const guiEnv = { ...env }; delete guiEnv.ELECTRON_RUN_AS_NODE;
      assert.equal((await run(exe, ['--smoke'], guiEnv)).code, 0, 'CLEAN_GUI_COLD_STARTUP');
      const report = JSON.parse(await fs.readFile(path.join(data, 'smoke/smoke-report.json')));
      assert.ok(report.checks.includes('configured clean GUI cold startup')); assert.equal(report.ownedServerClosed, true); pids.push(...report.processes.map(item => item.pid));
      results.push({ layout, cleanGuiColdStartup: true, coldHeadlessCheck: true }); continue;
    }
    await run(exe, [self, '--crash', core, 'accepted'], env, true);
    const before = await businessSnapshot(data);
    assert.notEqual((await run(exe, [headless, '--check'], env)).code, 0);
    const doctor = await run(exe, [headless, '--doctor'], env); const report = JSON.parse(doctor.text.trim());
    assert.ok(report.checks.some(x => x.checkId === 'workflow.startup' && x.status === 'FAIL'));
    assert.deepEqual(await businessSnapshot(data), before, 'DOCTOR_AND_CHECK_BUSINESS_READ_ONLY');
    assert.equal((await run(exe, [self, '--recover', core, 'accepted'], env)).code, 0, 'PACKAGED_SAFE_RECOVERY');
    assert.equal((await run(exe, [headless, '--check'], env)).code, 0, 'RESTART_AFTER_RECOVERY');
    await run(exe, [self, '--crash', core, 'unknown'], env, true);
    const unknown = await businessSnapshot(data); assert.notEqual((await run(exe, [headless, '--check'], env)).code, 0);
    assert.deepEqual(await businessSnapshot(data), unknown, 'UNKNOWN_OUTCOME_PRESERVED');
    {
      await fs.writeFile(path.join(data, '.startup-smoke-fixture'), 'dummy-only');
      const guiEnv = { ...env }; delete guiEnv.ELECTRON_RUN_AS_NODE;
      const gui = await run(exe, ['--smoke'], guiEnv);
      const codes = [...new Set(gui.text.match(/ERR_[A-Z_]+|0x[0-9A-Fa-f]{8}|UnknownVizError/g) || [])].slice(0, 8);
      assert.equal(gui.code, 0, 'PACKAGED_BLOCKED_GUI_DIAGNOSTICS ' + codes.join(','));
      const guiReport = JSON.parse(await fs.readFile(path.join(data, 'smoke/smoke-report.json')));
      assert.equal(guiReport.views.length, 24); assert.deepEqual(guiReport.runtimeErrors, []); assert.deepEqual(guiReport.consoleErrors, []);
      assert.equal(guiReport.ownedServerClosed, true);
      pids.push(...guiReport.processes.map(item => item.pid));
    }
    results.push({ layout, coldCheck: true, crashBlocked: true, doctorReadOnly: true, acceptedNotReplayed: true, idempotentRecovery: true, restart: true, unknownPreserved: true });
  }
  for (const pid of pids) assert.throws(() => process.kill(pid, 0));
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify({ results, emptyPath: true, outsideCwd: true, embeddedRuntime: true, noOrphans: true }));
  console.log('PACKAGED_STARTUP_GATE_PASSED');
}
