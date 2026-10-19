import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireWorkflowLease, acquireRunLease, releaseRunLease } from '../../workflow/tools/recovery/operation_ledger.mjs';
import { main as runner } from '../../workflow/tools/runner/main.mjs';
import { createRunRecoveryCoordinator } from '../../workflow/tools/recovery/run_recovery.mjs';
import { startRunGroup } from '../../workflow/tools/lib/runtime_housekeeping.mjs';
import { createNotificationReceipt, writeNotificationReceipt } from '../../workflow/tools/stage5/email_receipt.mjs';

// Every process is owned and awaited by the isolated startup test fixture.
const [command, runRoot, kind = 'workflow', parentOwnerId = ''] = process.argv.slice(2);
process.on('message', message => { if (message === 'exit') process.exit(0); });
const proceed = () => new Promise(resolve => process.once('message', message => { if (message === 'continue') resolve(); }));
try {
  if (command === 'runner') {
    const code = await runner(['--run', '--mode', 'local'], { env: process.env, runtimeLog: { write: async () => ({ ok: true }) }, stdout: { write() {} }, stderr: { write() {} },
      resolveRunnerConfigurationImpl: async options => ({ options: { ...options, outputRoot: path.dirname(runRoot) }, env: process.env }),
      runPreflightImpl: async () => ({ canRun: true, status: 'ready', requiredMissing: [] }),
      buildExecutionPlanImpl: () => ({ runRoot, runId: 'startup-crash', childEnv: process.env }),
      runProductionImpl: async () => {
        if (kind === 'claim') { process.send({ step: 'boundary', phase: kind }); await proceed(); }
        await startRunGroup({ runRoot, runId: 'startup-crash', pipelineMode: 'local' });
        const coordinator = await createRunRecoveryCoordinator({ runRoot, runId: 'startup-crash', mode: 'local', profile: 'standard', configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath: path.join(runRoot, 'startup-crash/input_artifact.json') });
        await coordinator.persistArtifact([{ title: 'dummy startup fixture', doi: '10.1234/startup-fixture' }]);
        if (['accepted', 'unknown'].includes(kind)) {
          for (const stage of ['stage1', 'state_persist', 'stage4_exports']) await coordinator.store.setStage(stage, 'verified');
          const receiptPath = path.join(runRoot, 'startup-crash/stage5/email_receipt.json');
          const operation = await coordinator.prepareFileOperation({ type: 'notification', targetId: 'fixture', targetPath: receiptPath, input: {}, retryable: false,
            intent: { notificationType: 'run_summary', eventEpoch: 'startup-crash' } });
          const receipt = createNotificationReceipt({ notificationType: 'run_summary', runId: 'startup-crash', businessSubject: 'startup-crash', eventEpoch: 'startup-crash', payload: {}, recipient: 'fixture@example.invalid', ledgerOperationId: operation.idempotencyKey });
          receipt.status = kind; await writeNotificationReceipt(receiptPath, receipt);
        }
        process.send({ step: 'boundary', phase: kind }); await proceed();
        return { code: 1, childExitConfirmed: true, stdout: '' };
      }, validateProductionResultImpl: async () => ({ exitCode: 0 }) });
    process.send({ step: 'runner.result', code });
  } else {
  const options = { runRoot, runId: 'startup-crash', profile: 'standard', ...(command === 'old' ? { ttlMs: 1 } : {}), parentOwnerId };
  const fsApi = { ...fs, link: async (...args) => {
    if (command === 'race') { process.send({ step: 'before.link' }); await proceed(); }
    const result = await fs.link(...args);
    if (command === 'interrupted') { process.send({ step: 'after.link' }); await proceed(); }
    return result;
  } };
  const lease = await (kind === 'run' ? acquireRunLease : acquireWorkflowLease)(options,
    { fsApi, ...(command === 'old' ? { clock: () => new Date('2000-01-01') } : {}) });
  if (command === 'borrow') {
    const release = await releaseRunLease(lease);
    process.send({ step: 'borrowed', acquired: lease.acquired, borrowed: lease.borrowed, released: release.released });
  } else process.send({ step: 'claimed', acquired: lease.acquired, reason: lease.reason || null });
  }
} catch (error) {
  process.send({ step: 'failed', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'LEASE_INSPECTION_FAILED' });
}
