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
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => fs.readFile(file, 'utf8').then(JSON.parse);
const write = (file, data) => fs.writeFile(file, JSON.stringify(data), { flag: 'wx' });

// A dedicated child process is mandatory: poison is installed before domain imports.
export async function exerciseOfflineScheduler({ base, mode = 'desktop', failDelivery = false }) {
  assert.ok(['desktop', 'web'].includes(mode));
  const allowedBase = path.join(repo, 'tests/runs/scheduler-offline');
  assert.equal(path.resolve(base), path.resolve(allowedBase));
  await fs.mkdir(base, { recursive: true });
  const root = path.join(base, randomUUID()); await fs.mkdir(root);
  await write(path.join(root, 'fixture.json'), { owner: 'offline-scheduler-v1', mode });
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
    const { OperationLedgerStore } = await load('workflow/tools/recovery/operation_ledger.mjs');
    const { sendRadarAggregateNotification } = await load('workflow/tools/stage5/radar_notification.mjs');
    const { recordRadarNotificationOutcome } = await load('workflow/tools/radar/state.mjs');
    const { getDefaultZoteroLibraryIndexPath } = await load('workflow/tools/lib/zotero_library_index_store.mjs');
    const { resolvePlannedSlotAt, scheduleDayDecisionPath, plannedSlotCalendarDateKey } = await load('workflow/tools/lib/schedule_support.mjs');
    const now = new Date(), slot = resolvePlannedSlotAt(now);
    // Fixture clock is explicit; never change Windows time or the formal 15:00 rule.
    now.setTime(slot.getTime() + 60000);
    const config = buildRuntimeConfig({ env: process.env, cwd: root, now });
    assert.equal(path.resolve(config.projectRoot), root);
    await fs.mkdir(config.researchRoot, { recursive: true });
    const previous = new Date(slot.getTime() - 86400000).toISOString();
    await write(path.join(config.researchRoot, 'runtime_state.json'), {
      last_successful_scheduled_run_at: previous, last_accepted_planned_slot_at: previous,
    });
    const resolved = { options: { mode, profile: 'standard', action: 'run', scheduledDaily: true,
      resume: '', email: 'fixture@example.invalid', configSummary: {} }, env: { ...process.env },
      config: { schemaVersion: 2, common: { radar: { enabled: true } } } };
    const selection = await selectScheduledDailyRun(resolved, { now, repoRoot: root });
    assert.equal(selection.status, 'ready'); assert.equal(selection.resolved.options.profile, 'radar');
    const runRoot = path.join(config.reviewRoot, 'runs');
    assert.deepEqual(await fs.readdir(runRoot).catch(e => { if (e.code === 'ENOENT') return []; throw e; }), []);
    const claimFile = scheduleDayDecisionPath(path.join(config.researchRoot, 'schedule_decisions'), plannedSlotCalendarDateKey(now));
    await assert.rejects(fs.stat(claimFile), { code: 'ENOENT' });
    const runId = 'offline-' + randomUUID();
    const configHash = withRunnerProfile(resolved, 'radar').options.recoveryConfigHash;
    const coordinator = await createRunRecoveryCoordinator({ runRoot, runId, mode, profile: 'radar',
      launcherId: 'offline-scheduler-fixture', configHash, inputHash: 'b'.repeat(64) });
    const auditPath = path.join(runRoot, runId, 'radar_audit.json');
    let retrievals = 0, deliveries = 0;
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
    const claimBytes = await fs.readFile(claimFile);
    assert.equal(JSON.parse(claimBytes).businessRunId, runId);
    assert.equal(coordinator.store.ledger.operations.length, 1);
    let store = await OperationLedgerStore.load({ runRoot, runId });
    if (failDelivery) {
      assert.notEqual(report.status, 'completed'); assert.notEqual(store.ledger.status, 'completed');
      const resumeSelection = await selectScheduledDailyRun(resolved, { now, repoRoot: root });
      assert.equal(resumeSelection.status, 'resume'); assert.equal(resumeSelection.runId, runId);
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
      store = await OperationLedgerStore.load({ runRoot, runId });
    } else assert.equal(report.status, 'completed');
    assert.equal(store.ledger.status, 'completed');
    const ledgerBytes = await fs.readFile(store.filePath);
    for (let n = 0; n < 2; n++) {
      const duplicate = await selectScheduledDailyRun(resolved, { now, repoRoot: root });
      assert.equal(duplicate.status, 'already_completed'); assert.equal(duplicate.runId, runId);
      assert.deepEqual(await fs.readFile(claimFile), claimBytes);
      assert.deepEqual(await fs.readFile(store.filePath), ledgerBytes);
    }
    assert.equal(retrievals, 1); assert.equal(externalCalls, 0);
    assert.equal(deliveries, failDelivery ? 2 : 1);
    return { root, mode, runId, status: 'PASS', initialClaimAbsent: true, initialLedgerEmpty: true,
      stage0Called: true, retrievals, deliveries, failureRecovered: failDelivery,
      completedLedger: true, duplicate: 'already_completed', claimSha256: digest(claimBytes),
      ledgerSha256: digest(ledgerBytes), externalCalls, osTriggerEvidence: false,
      clock: 'TEST_ONLY_CURRENT_DAY_15_01_NOT_OS_TIME_EVIDENCE' };
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, originalEnv);
    for (const [owner, key, value] of originals) owner[key] = value; syncBuiltinESMExports();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.length === 4 && ['desktop','web'].includes(process.argv[2]) && ['success','failure'].includes(process.argv[3]));
    console.log(JSON.stringify(await exerciseOfflineScheduler({ base: path.join(repo, 'tests/runs/scheduler-offline'),
      mode: process.argv[2], failDelivery: process.argv[3] === 'failure' })));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
