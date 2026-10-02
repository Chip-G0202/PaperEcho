import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunRecoveryCoordinator, resumeRunFromLedger } from '../tools/recovery/run_recovery.mjs';
import { OperationLedgerStore } from '../tools/recovery/operation_ledger.mjs';
import { runStage5Notification } from '../tools/stage5/main.mjs';
import { sendRadarAggregateNotification, radarNotificationReceiptPath } from '../tools/stage5/radar_notification.mjs';
import { completeLedgerNotification } from '../tools/notification/ledger_bridge.mjs';
import { notificationIdentity, recipientHash, receiptPathFor, readNotificationReceipt, writeNotificationReceipt } from '../tools/stage5/email_receipt.mjs';
import { recordRadarNotificationOutcome, selectRadarNotificationCandidates } from '../tools/radar/state.mjs';
import { canonicalQueryHash } from '../tools/stage1/source_state.mjs';
import { renderLegacyQqNotification } from '../tools/notification/qq_renderer.mjs';

const base = fileURLToPath(new URL('../../tests/runs/qq-recovery/', import.meta.url));
const configHash = 'a'.repeat(64);
const recipient = 'reader@example.test';
async function fixture(t, profile, emailOutcome, qqOutcome, enabled = { email: true, qq: true }) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runId = `${profile}-fixture`;
  const state = path.join(root, runId);
  const coordinator = await createRunRecoveryCoordinator({ runRoot: root, runId, mode: 'web', profile, launcherId: 'web-fixed-launcher/runner', configHash, inputHash: configHash, artifactPath: path.join(state, 'business.json') });
  const items = [{ title: 'Existing business title', translatedTitle: '已有业务标题', journal: 'Fixture journal', year: 2026, final_grade: 'A', grade_reason: 'Existing reason' }];
  const audit = { candidateCount: 5, generatedAt: '2026-09-30T07:00:00Z' };
  await coordinator.persistArtifact(items, items);
  for (const name of Object.keys(coordinator.store.ledger.stages).filter(name => name !== 'stage5_notification')) await coordinator.store.setStage(name, profile === 'radar' && name !== 'stage1' ? 'skipped' : 'verified');
  const before = await fs.readFile(path.join(state, 'business.json'), 'utf8');
  await fs.writeFile(path.join(state, 'run_group.json'), JSON.stringify({ schemaVersion: 1, runId, pipelineMode: 'web', status: 'completed_with_warnings', artifacts: [] }));
  const indexPath = path.join(root, 'fixture-index.json');
  const selected = (await selectRadarNotificationCandidates(indexPath, items)).selected;
  const receiptPath = profile === 'radar' ? radarNotificationReceiptPath(state, runId, items, audit) : receiptPathFor(state);
  const type = profile === 'radar' ? 'radar_business' : 'run_summary';
  const emailOperation = enabled.email ? await coordinator.prepareFileOperation({ type: 'notification', targetId: recipientHash(recipient), targetPath: receiptPath, input: { runId }, retryable: false,
    intent: { notificationType: type, eventEpoch: runId, ...(profile === 'radar' ? { radarCompletionHash: canonicalQueryHash(selected) } : {}) } }) : null;
  const messages = { email: [], qq: [] };
  const transport = channel => async message => {
    if (channel === 'email' && enabled.qq) {
      const qqOperation = coordinator.store.ledger.operations.find(item => item.intent.channel === 'qq');
      assert.ok(qqOperation, 'QQ must be planned before Email is sent');
      const prepared = await readNotificationReceipt(qqOperation.target.path);
      assert.equal(prepared.status, 'pending'); assert.equal(prepared.attempts, 0);
      assert.equal(prepared.recoveryData.content.runId, runId);
      assert.equal(prepared.ledgerOperationId, qqOperation.idempotencyKey);
    }
    messages[channel].push(message); const outcome = channel === 'email' ? emailOutcome : qqOutcome;
    return outcome === 'unknown' ? {} : { accepted: outcome === 'accepted', category: channel === 'qq' ? 'qq_rate_limited' : 'smtp_rejected' };
  };
  const env = { PAPERECHO_CONFIG_SCHEMA_VERSION: '5', PAPERECHO_EMAIL_ENABLED: String(enabled.email), PAPERECHO_QQ_CHANNEL: JSON.stringify({ enabled: enabled.qq, appId: 'fake-app', targetType: 'user', targetId: 'fake-openid' }) };
  const initial = profile === 'radar' ? await sendRadarAggregateNotification({ runId, urgentItems: items, audit, notificationSelection: selected, recipient: enabled.email ? recipient : '', runStateRoot: state, env,
    ledgerOperationId: emailOperation?.idempotencyKey, transport: transport('email'), qqTransport: transport('qq'), recoveryCoordinator: coordinator })
    : await runStage5Notification({ runSummary: { runId, pipelineMode: 'web', finishedAt: audit.generatedAt, counts: { created: 1, grades: { A: 1 } }, artifacts: [], outputRoot: state }, recipient: enabled.email ? recipient : '', transport: transport('email'),
      config: { env, runStateRoot: state, ledgerOperationId: emailOperation?.idempotencyKey, qqTransport: transport('qq'), recoveryCoordinator: coordinator } });
  if (emailOperation) {
    const delivered = initial.channels.email;
    const receipt = await readNotificationReceipt(receiptPath);
    await completeLedgerNotification(coordinator.store, emailOperation, { ...delivered, status: delivered.status === 'sent' ? 'accepted' : delivered.status, receipt, receiptPath });
  }
  await coordinator.store.setStage('stage5_notification', initial.notificationStatus === 'completed' ? 'verified' : 'failed');
  await coordinator.store.setRunStatus(initial.notificationStatus === 'completed' ? 'completed' : 'incomplete');
  const resume = (extra = {}) => resumeRunFromLedger({ runRoot: root, runId, mode: 'web', profile, configHash,
    beforeReconcile: async () => assert.fail('business preparation must not run'), buildReconcilers: async () => assert.fail('retrieval / ranking / Zotero / export must not run'),
    notification: { recipient, env, transport: async message => { messages.email.push(message); return { accepted: true }; }, qqTransport: async message => { messages.qq.push(message); return { accepted: true }; },
      recordRadarOutcome: (entries, result) => recordRadarNotificationOutcome(indexPath, entries, result), ...extra },
  });
  return { root, runId, state, initial, messages, coordinator, before, resume };
}

for (const profile of ['radar', 'standard']) {
  for (const [email, qq] of [['accepted', 'accepted'], ['accepted', 'failed'], ['failed', 'accepted'], ['failed', 'failed']]) test(`${profile}: Email ${email}, QQ ${qq}; partial business success and channel-only formal resume`, async t => {
    const f = await fixture(t, profile, email, qq);
    assert.equal(f.initial.businessStatus, 'success');
    assert.equal(f.initial.channels.email.status, email === 'accepted' ? profile === 'radar' ? 'accepted' : 'sent' : 'failed');
    assert.equal(f.initial.channels.qq.status, qq);
    assert.equal(f.initial.notificationStatus, email === 'accepted' && qq === 'accepted' ? 'completed' : 'incomplete');
    assert.equal(f.coordinator.store.ledger.operations.filter(item => item.type === 'notification').length, 2);
    const first = await f.resume();
    assert.equal(first.status, 'completed');
    assert.equal(first.notificationOnly, true);
    assert.equal(f.messages.email.length, email === 'accepted' ? 1 : 2);
    assert.equal(f.messages.qq.length, qq === 'accepted' ? 1 : 2);
    for (const channel of ['email', 'qq']) if (f.messages[channel].length === 2) assert.deepEqual(f.messages[channel][0], f.messages[channel][1]);
    const lengths = { email: f.messages.email.length, qq: f.messages.qq.length };
    assert.equal((await f.resume()).status, 'completed');
    assert.deepEqual({ email: f.messages.email.length, qq: f.messages.qq.length }, lengths);
    assert.equal(await fs.readFile(path.join(f.state, 'business.json'), 'utf8'), f.before);
    const store = await OperationLedgerStore.load({ runRoot: f.root, runId: f.runId });
    assert.equal(store.ledger.operations.every(item => item.status === 'verified'), true);
  });
  for (const enabled of [{ email: false, qq: true }, { email: true, qq: false }, { email: false, qq: false }]) test(`${profile}: disabled channel creates no delivery or recovery pending (${JSON.stringify(enabled)})`, async t => {
    const f = await fixture(t, profile, 'accepted', 'accepted', enabled);
    assert.equal(f.initial.businessStatus, 'success');
    assert.equal(f.initial.notificationStatus, 'completed');
    for (const channel of ['email', 'qq']) {
      assert.equal(f.messages[channel].length, Number(enabled[channel]));
      if (!enabled[channel]) assert.equal(f.initial.channels[channel].status, 'skipped');
    }
    assert.equal(f.coordinator.store.ledger.operations.length, Number(enabled.email) + Number(enabled.qq));
  });
  test(`${profile}: QQ unknown is held while failed Email can independently resume`, async t => {
    const f = await fixture(t, profile, 'failed', 'unknown');
    const result = await f.resume();
    assert.equal(result.status, 'incomplete');
    assert.equal(result.channels.find(item => item.channel === 'qq').reason, 'notification_possibly_accepted');
    assert.equal(f.messages.email.length, 2);
    assert.equal(f.messages.qq.length, 1);
    await f.resume();
    assert.equal(f.messages.email.length, 2);
    assert.equal(f.messages.qq.length, 1);
  });
}

test('QQ and Email identities are deterministic, distinct; old Email identity and case-sensitive QQ recipient survive', () => {
  const input = { notificationType: 'channel_test', businessSubject: 'same-event', eventEpoch: 'same-epoch', payload: { content: 'same' } };
  const email = notificationIdentity(input);
  assert.deepEqual(notificationIdentity({ ...input, channel: 'email' }), email);
  const qq = notificationIdentity({ ...input, channel: 'qq' });
  assert.notEqual(email.receiptId, qq.receiptId);
  assert.deepEqual(notificationIdentity({ ...input, channel: 'qq' }), qq);
  assert.notEqual(recipientHash('user:AbC', 'qq'), recipientHash('user:abc', 'qq'));
  assert.equal(recipientHash('A@example.test'), recipientHash('a@example.test'));
});

test('QQ tampered recovery content cannot send or rerun business', async t => {
  const f = await fixture(t, 'standard', 'accepted', 'failed');
  const op = f.coordinator.store.ledger.operations.find(item => item.intent.channel === 'qq');
  const file = op.target.path;
  const receipt = await readNotificationReceipt(file);
  receipt.recoveryData.content.summary.created = 999;
  receipt.recoveryData.content.summaryView.total = 999;
  await writeNotificationReceipt(file, receipt);
  const result = await f.resume();
  assert.equal(result.status, 'incomplete');
  assert.equal(result.channels.find(item => item.channel === 'qq').reason, 'notification_payload_changed');
  assert.equal(f.messages.email.length, 1);
  assert.equal(f.messages.qq.length, 1);
});

test('historical text receipt resumes its exact summary once without changing identity', async t => {
  const f = await fixture(t, 'standard', 'accepted', 'failed');
  const op = f.coordinator.store.ledger.operations.find(item => item.intent.channel === 'qq');
  const receipt = await readNotificationReceipt(op.target.path);
  const payload = renderLegacyQqNotification(receipt.recoveryData.content);
  Object.assign(receipt, notificationIdentity({ notificationType: receipt.notificationType, businessSubject: receipt.businessSubject, eventEpoch: receipt.eventEpoch, payload, channel: 'qq' }));
  await writeNotificationReceipt(op.target.path, receipt);
  assert.equal((await f.resume()).status, 'completed');
  assert.equal(f.messages.qq[1].msg_type, 0);
  assert.equal(f.messages.qq[1].content, payload.content);
  assert.equal((await readNotificationReceipt(op.target.path)).receiptId, receipt.receiptId);
  await f.resume();
  assert.equal(f.messages.qq.length, 2);
});
