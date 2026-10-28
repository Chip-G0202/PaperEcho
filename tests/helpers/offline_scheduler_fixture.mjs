// TEST ONLY: real Stage0/schedule/recovery owners, synthetic retrieval and delivery.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL, URL as NativeURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import childProcess from 'node:child_process';

const repo = fileURLToPath(new NativeURL('../../', import.meta.url));
const base = path.join(repo, 'tests/runs/scheduler-offline');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, data) => fs.writeFile(file, JSON.stringify(data), { flag: 'wx' });
async function unlinked(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    assert.equal((await fs.lstat(current)).isSymbolicLink(), false, 'FIXTURE_LINK_REJECTED');
    if (current === path.dirname(current)) break;
  }
}
async function boundedJson(file) {
  await unlinked(file);
  const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 16384, 'FIXTURE_FILE_UNSAFE');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// A dedicated child process is mandatory: poison is installed before domain imports.
export async function exerciseOfflineScheduler({ operation, reference, mode = 'desktop', failDelivery = false }) {
  assert.ok(['init','run','inspect'].includes(operation), 'FIXTURE_OPERATION_INVALID');
  assert.ok(['desktop', 'web'].includes(mode), 'FIXTURE_MODE_INVALID');
  if (operation === 'init') {
    await unlinked(repo);
    // Check existing ancestors before mkdir, including a test-base junction.
    let dir = repo;
    for (const part of ['tests','runs','scheduler-offline']) {
      dir = path.join(dir, part);
      await fs.mkdir(dir).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await unlinked(dir);
    }
    reference = randomUUID();
  }
  assert.match(reference || '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/, 'FIXTURE_REFERENCE_INVALID');
  const root = path.join(base, reference);
  if (operation === 'init') await fs.mkdir(root);
  await unlinked(root);
  let manifest;
  if (operation !== 'init') {
    const marker = await boundedJson(path.join(root, 'fixture.json'));
    manifest = await boundedJson(path.join(root, 'manifest.json'));
    assert.equal(marker.owner, 'offline-scheduler-v2'); assert.equal(marker.reference, reference);
    assert.equal(digest(JSON.stringify(manifest)), marker.manifestHash, 'FIXTURE_MANIFEST_CHANGED');
    assert.equal(manifest.schemaVersion, 2); assert.equal(manifest.reference, reference);
    assert.ok(['desktop','web'].includes(manifest.mode)); assert.equal(typeof manifest.failDelivery, 'boolean');
    mode = manifest.mode; failDelivery = manifest.failDelivery;
  }
  const originalEnv = { ...process.env }, originals = [];
  let externalCalls = 0;
  const deny = () => { externalCalls++; throw new Error('OFFLINE_EXTERNAL_EFFECT_BLOCKED'); };
  for (const [owner, keys] of [[globalThis, ['fetch']], [http, ['request','get']], [https, ['request','get']],
    [net, ['connect','createConnection']], [tls, ['connect']], [net.Socket.prototype, ['connect']],
    [childProcess, ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']]]) {
    for (const key of keys) { originals.push([owner, key, owner[key]]); owner[key] = deny; }
  }
  syncBuiltinESMExports();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PAPERECHO_SKIP_DOTENV: '1', ZOTERO_PROJECT_ROOT: root,
    ZOTERO_BACKEND: mode === 'web' ? 'web_api' : 'desktop_cli', PAPERECHO_RUN_PROFILE: 'radar',
    PAPERECHO_CONFIG_SCHEMA_VERSION: '2', PAPERECHO_EMAIL_ENABLED: 'true', PAPERECHO_RADAR_ENABLED: 'true',
    PAPERFLOW_REPORT_TO: 'fixture@example.invalid', review_results_ORCHESTRATOR_TRIGGER: 'scheduled' });
  const load = file => import(pathToFileURL(path.join(repo, file)).href);
  try {
    const { buildRuntimeConfig } = await load('workflow/tools/lib/runtime_config.mjs');
    const { selectScheduledDailyRun } = await load('workflow/tools/runner/scheduled_daily.mjs');
    const { withRunnerProfile } = await load('workflow/tools/runner/config_loader.mjs');
    const { runZoteroLiteratureFilter } = await load('workflow/tools/stage0/main.mjs');
    const { createRunRecoveryCoordinator, resumeRunFromLedger } = await load('workflow/tools/recovery/run_recovery.mjs');
    const { OperationLedgerStore, acquireWorkflowLease, releaseRunLease } = await load('workflow/tools/recovery/operation_ledger.mjs');
    const { sendRadarAggregateNotification } = await load('workflow/tools/stage5/radar_notification.mjs');
    const { recordRadarNotificationOutcome } = await load('workflow/tools/radar/state.mjs');
    const { getDefaultZoteroLibraryIndexPath } = await load('workflow/tools/lib/zotero_library_index_store.mjs');
    const { resolvePlannedSlotAt, scheduleDayDecisionPath, plannedSlotCalendarDateKey } = await load('workflow/tools/lib/schedule_support.mjs');
    if (operation === 'init') {
      const slot = resolvePlannedSlotAt(new Date());
      manifest = { schemaVersion: 2, reference, mode, failDelivery,
        now: new Date(slot.getTime() + 60000).toISOString(), slot: slot.toISOString() };
    }
    // Persisted fixture clock, not Windows catch-up evidence or a system-time change.
    const now = new Date(manifest.now), slot = resolvePlannedSlotAt(now);
    assert.equal(slot.toISOString(), manifest.slot);
    assert.equal(now.getTime(), slot.getTime() + 60000);
    const config = buildRuntimeConfig({ env: process.env, cwd: root, now });
    assert.equal(path.resolve(config.projectRoot), root);
    if (operation === 'init') {
      await fs.mkdir(config.researchRoot, { recursive: true });
      const previous = new Date(slot.getTime() - 86400000).toISOString();
      await write(path.join(config.researchRoot, 'runtime_state.json'), {
        last_successful_scheduled_run_at: previous, last_accepted_planned_slot_at: previous,
      });
      await write(path.join(root, 'manifest.json'), manifest);
      await write(path.join(root, 'fixture.json'), { owner: 'offline-scheduler-v2', reference,
        manifestHash: digest(JSON.stringify(manifest)) });
    }
    const resolved = { options: { mode, profile: 'standard', action: 'run', scheduledDaily: true,
      resume: '', email: 'fixture@example.invalid', configSummary: {} }, env: { ...process.env },
      config: { schemaVersion: 2, common: { radar: { enabled: true } } } };
    const runRoot = path.join(config.reviewRoot, 'runs');
    const claimFile = scheduleDayDecisionPath(path.join(config.researchRoot, 'schedule_decisions'), plannedSlotCalendarDateKey(now));
    if (operation === 'init') {
      assert.deepEqual(await fs.readdir(runRoot).catch(e => { if (e.code === 'ENOENT') return []; throw e; }), []);
      await assert.rejects(fs.stat(claimFile), { code: 'ENOENT' });
      return { status: 'initialized', reference, root, pid: process.pid, slot: manifest.slot,
        initialClaimAbsent: true, initialLedgerEmpty: true, externalCalls, osTriggerEvidence: false };
    }
    const runId = 'offline-' + reference;
    const configHash = withRunnerProfile(resolved, 'radar').options.recoveryConfigHash;
    const auditPath = path.join(runRoot, runId, 'radar_audit.json');
    let retrievals = 0, deliveries = 0, action;
    const snapshot = async () => {
      const selection = await selectScheduledDailyRun(resolved, { now, repoRoot: root });
      let store, claimBytes, ledgerBytes, receipt;
      try {
        claimBytes = await fs.readFile(claimFile);
        assert.equal(JSON.parse(claimBytes).businessRunId, runId);
        store = await OperationLedgerStore.load({ runRoot, runId });
        ledgerBytes = await fs.readFile(store.filePath);
        const notification = store.ledger.operations.find(value => value.type === 'notification');
        if (notification) receipt = await boundedJson(notification.target.path);
      } catch (error) { if (error.code !== 'ENOENT' || selection.status !== 'ready') throw error; }
      const audit = await boundedJson(auditPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      return { status: selection.status, ledgerStatus: store?.ledger.status || 'absent', reference, root,
        runId: store?.ledger.runId || null, pid: process.pid, slot: manifest.slot, action,
        retrievals, deliveries, stage1Executions: audit ? 1 : 0, deliveryAttempts: receipt?.attempts || 0,
        claimSha256: claimBytes ? digest(claimBytes) : null, ledgerSha256: ledgerBytes ? digest(ledgerBytes) : null,
        auditSha256: audit ? digest(JSON.stringify(audit)) : null, externalCalls, osTriggerEvidence: false };
    };
    if (operation === 'inspect') return await snapshot();
    const lease = await acquireWorkflowLease({ runRoot, runId, profile: 'radar' });
    assert.equal(lease.acquired, true, 'FIXTURE_ACTIVE_LEASE');
    try {
    const selection = await selectScheduledDailyRun(resolved, { now, repoRoot: root });
    if (selection.status === 'already_completed') { action = 'duplicate'; return await snapshot(); }
    if (selection.status === 'resume') {
      const resumed = await resumeRunFromLedger({ runRoot, runId, mode, profile: 'radar', configHash,
        buildReconcilers: async () => { throw new Error('NOTIFICATION_ONLY_RECOVERY_EXPECTED'); },
        notification: { recipient: 'fixture@example.invalid', env: { ...process.env },
          transport: async () => { deliveries++; return { accepted: true, acceptedCount: 1 }; },
          recordRadarOutcome: async (entries, outcome) => {
            await recordRadarNotificationOutcome(getDefaultZoteroLibraryIndexPath(root), entries, outcome);
            return { ok: true };
          } },
      });
      assert.equal(resumed.status, 'completed'); assert.equal(resumed.notificationOnly, true);
      action = 'recovered'; return await snapshot();
    }
    assert.equal(selection.status, 'ready'); assert.equal(selection.resolved.options.profile, 'radar');
    const coordinator = await createRunRecoveryCoordinator({ runRoot, runId, mode, profile: 'radar',
      launcherId: 'offline-scheduler-fixture', configHash, inputHash: 'b'.repeat(64) });
    const item = { title: 'Synthetic scheduler paper', doi: '10.1000/offline-scheduler', grade: 'A',
      rule_grade: 'A', final_grade: 'A', semantic_grade: 'A', llm_review_grade: 'A', semantic_source: 'llm_title_review' };
    const transport = async () => { deliveries++; return failDelivery
      ? { accepted: false, category: 'configuration', retryable: false }
      : { accepted: true, acceptedCount: 1 }; };
    const report = await runZoteroLiteratureFilter({ config, runId, recoveryCoordinator: coordinator,
      triggerMode: 'scheduled', runMode: { isManualOrForce: false }, stage1Only: false, argv: [], clock: () => now,
      env: { ...process.env, PAPERECHO_SCHEDULED_DAILY: '1', PAPERECHO_SCHEDULED_SLOT: slot.toISOString(),
        PAPERECHO_SCHEDULED_FLOW: 'radar', PAPERECHO_SCHEDULED_WEEKLY_MODE: '' },
      ensureStartupReady: async () => ({ ok: true, strategy: 'synthetic-external-readiness' }),
      runStage: async stage => {
        assert.equal(stage.name, 'stage1'); retrievals++;
        const audit = { candidateCount: 1, zoteroWriteCount: 0, xlsxWriteCount: 0 };
        await write(auditPath, audit);
        return { exitCode: 0, data: { triagedAll: [item], radar: { auditPath, audit, urgentItems: [item] } } };
      },
      radarStage5Runner: input => sendRadarAggregateNotification({ ...input, transport }),
      researchEvaluationService: { safely: async () => ({ status: 'no-synthetic-feedback' }) },
    });
    assert.equal(retrievals, 1);
    assert.equal(coordinator.store.ledger.operations.length, 1);
    const store = await OperationLedgerStore.load({ runRoot, runId });
    if (failDelivery) {
      assert.notEqual(report.status, 'completed'); assert.notEqual(store.ledger.status, 'completed');
      action = 'failed';
    } else {
      assert.equal(report.status, 'completed'); assert.equal(store.ledger.status, 'completed'); action = 'executed';
    }
    assert.equal(retrievals, 1); assert.equal(externalCalls, 0);
    assert.equal(deliveries, 1);
    return await snapshot();
    } finally { await releaseRunLease(lease); }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, originalEnv);
    for (const [owner, key, value] of originals) owner[key] = value; syncBuiltinESMExports();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, value, scenario] = process.argv.slice(2);
    assert.ok(operation === 'init' ? process.argv.length === 5 && ['success','failure'].includes(scenario) : process.argv.length === 4);
    const beforeEnv = { ...process.env };
    const result = await exerciseOfflineScheduler(operation === 'init'
      ? { operation, mode: value, failDelivery: scenario === 'failure' } : { operation, reference: value });
    assert.deepEqual({ ...process.env }, beforeEnv);
    console.log(JSON.stringify({ ...result, environmentRestored: true }));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
