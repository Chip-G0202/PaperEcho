import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunRecoveryCoordinator, resumeRunFromLedger } from '../../tools/recovery/run_recovery.mjs';
import { runStage5Notification } from '../../tools/stage5/main.mjs';
import { sendRadarAggregateNotification, radarNotificationReceiptPath } from '../../tools/stage5/radar_notification.mjs';
import { completeLedgerNotification } from '../../tools/notification/ledger_bridge.mjs';
import { recipientHash, receiptPathFor, readNotificationReceipt } from '../../tools/stage5/email_receipt.mjs';
import { CHANNEL_IDS } from '../../tools/notification/channels.mjs';
import { recordRadarNotificationOutcome } from '../../tools/radar/state.mjs';
const base = fileURLToPath(new URL('../../../tests/runs/channel-fixtures/', import.meta.url));
export async function businessChannelsFixture(t, { profile = 'standard', enabled = CHANNEL_IDS, failed = [], unknown = [] } = {}) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base,'case-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runId = `channels-${profile}`; const state = path.join(root,runId); const hash = 'b'.repeat(64); const recipient = 'reader@example.test';
  const coordinator = await createRunRecoveryCoordinator({ runRoot: root, runId, mode: 'web', profile, launcherId: 'web-fixed-launcher/runner', configHash: hash, inputHash: hash, artifactPath: path.join(state,'business.json') });
  const items = [{ id: 'paper', title: 'Canonical paper', final_grade: 'A', translatedTitle: '既有文献', semantic_reason: 'Existing reason' }]; const audit = { generatedAt: '2026-09-30T00:00:00Z', candidateCount: 5 };
  await coordinator.persistArtifact(items, items);
  for (const stage of Object.keys(coordinator.store.ledger.stages).filter(name => name !== 'stage5_notification')) await coordinator.store.setStage(stage, profile === 'radar' && stage !== 'stage1' ? 'skipped' : 'verified');
  const before = await fs.readFile(path.join(state,'business.json'), 'utf8');
  const receiptPath = profile === 'radar' ? radarNotificationReceiptPath(state,runId,items,audit) : receiptPathFor(state);
  const type = profile === 'radar' ? 'radar_business' : 'run_summary';
  const emailOperation = enabled.includes('email') ? await coordinator.prepareFileOperation({ type: 'notification', targetId: recipientHash(recipient), targetPath: receiptPath, input: { runId }, retryable: false, intent: { notificationType: type, eventEpoch: runId } }) : null;
  const env = { PAPERECHO_CONFIG_SCHEMA_VERSION: '6', PAPERECHO_EMAIL_ENABLED: String(enabled.includes('email')) };
  for (const id of CHANNEL_IDS.filter(id => id !== 'email')) env[`PAPERECHO_${id.toUpperCase()}_CHANNEL`] = JSON.stringify({ enabled: enabled.includes(id), appId: 'fixture', targetType: 'user', targetId: 'fixture-recipient', uid: 'UID_' + 'generatedFixture' });
  const messages = Object.fromEntries(CHANNEL_IDS.map(id => [id, []]));
  const send = (id, resume = false) => async message => { messages[id].push(message); return !resume && unknown.includes(id) ? {} : { accepted: resume || !failed.includes(id), category: 'provider_rejected' }; };
  const transports = Object.fromEntries(CHANNEL_IDS.filter(id => id !== 'email').map(id => [id, send(id)]));
  const initial = profile === 'radar' ? await sendRadarAggregateNotification({ runId, urgentItems: items, audit, recipient, runStateRoot: state, env, transport: send('email'), channelTransports: transports, recoveryCoordinator: coordinator, ledgerOperationId: emailOperation?.idempotencyKey })
    : await runStage5Notification({ runSummary: { runId, pipelineMode: 'web', finishedAt: audit.generatedAt, counts: { created: 1, grades: { A: 1 } }, artifacts: [], outputRoot: state }, literatureItems: items, recipient, transport: send('email'), config: { env, runStateRoot: state, channelTransports: transports, recoveryCoordinator: coordinator, ledgerOperationId: emailOperation?.idempotencyKey } });
  if (emailOperation) await completeLedgerNotification(coordinator.store, emailOperation, { ...initial.channels.email, status: initial.channels.email.status === 'sent' ? 'accepted' : initial.channels.email.status, receipt: await readNotificationReceipt(receiptPath), receiptPath });
  await coordinator.store.setStage('stage5_notification', initial.notificationStatus === 'completed' ? 'verified' : 'failed'); await coordinator.store.setRunStatus(initial.notificationStatus === 'completed' ? 'completed' : 'incomplete');
  const resume = () => resumeRunFromLedger({ runRoot: root, runId, mode: 'web', profile, configHash: hash, beforeReconcile: async () => assert.fail('business must not run'), buildReconcilers: async () => assert.fail('business must not run'), notification: { recipient, env, transport: send('email', true), recordRadarOutcome: (entries,result) => recordRadarNotificationOutcome(path.join(root,'index.json'),entries,result), channelTransports: Object.fromEntries(CHANNEL_IDS.filter(id => id !== 'email').map(id => [id, send(id,true)])) } });
  return { root, state, initial, messages, resume, coordinator, before };
}
