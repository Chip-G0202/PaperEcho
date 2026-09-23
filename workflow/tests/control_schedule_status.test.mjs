import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ControlScheduleStatusService } from '../tools/lib/control_schedule_status_service.mjs';
import { scheduleDayDecisionPath } from '../tools/lib/schedule_support.mjs';

const root = path.resolve('workflow/tests/.schedule-status-fixture');
const researchRoot = path.join(root, 'review_results');
const reviewRoot = path.join(researchRoot, '文献评价');
const slot = '2026-09-21T07:00:00.000Z';
const today = '2026-09-23T07:00:00.000Z';
const weeklyDue = '2026-09-28T07:00:00.000Z';

function fixture({ now = today, state, mode = 'desktop', radarEnabled = true, profile = 'standard', claim, ledger, intervalDays = 7 } = {}) {
  const files = new Map();
  const statePath = path.join(researchRoot, 'runtime_state.json');
  if (state !== undefined) files.set(statePath, typeof state === 'string' ? state : JSON.stringify(state));
  if (claim) files.set(scheduleDayDecisionPath(path.join(researchRoot, 'schedule_decisions'), claim.dateKey), JSON.stringify(claim));
  const reads = [];
  const fsApi = { readFile: async (file) => { reads.push(file); if (files.has(file)) return files.get(file); const error = new Error('missing'); error.code = 'ENOENT'; throw error; } };
  const config = { readOwnerOrTemplate: async () => ({ value: { mode, profile, common: { radar: { enabled: radarEnabled } } } }) };
  const service = new ControlScheduleStatusService({
    context: { mode, researchRoot, reviewRoot, env: { review_results_RUN_INTERVAL_DAYS: intervalDays } }, config, fsApi,
    clock: () => new Date(now),
    loadLedger: async ({ runId }) => { if (!ledger || runId !== claim?.businessRunId) throw new Error('missing'); return { ledger }; },
  });
  return { service, files, reads, statePath };
}
const anchor = { last_successful_scheduled_run_at: slot, last_successful_full_run_at: '2026-09-21T08:00:00.000Z' };
const claimed = (dateKey, plannedSlotAt, decision = 'weekly_takeover') => ({ schemaVersion: 1, dateKey, plannedSlotAt, decision, businessRunId: 'weekly-1' });

test('status read uses shared decision without writing, claiming, or preflight', async () => {
  const fx = fixture({ state: anchor });
  const before = [...fx.files];
  const result = await fx.service.status();
  assert.equal(result.today.selectedFlow, 'radar');
  assert.equal(result.weekly.lastSuccessfulPlannedSlot, slot);
  assert.equal(result.weekly.nextDuePlannedSlot, weeklyDue);
  assert.deepEqual([...fx.files], before);
  assert.equal(fx.reads.some((file) => String(file).includes('schedule_decisions')), true);
  assert.equal(fx.reads.some((file) => String(file).includes('zotero')), false);
  assert.equal(JSON.stringify(result).includes('businessRunId'), false);
});

test('first run, before-slot preview, missed Radar, and Weekly due follow the shared owner', async () => {
  const first = await fixture({ state: {}, now: today }).service.status();
  assert.equal(first.today.selectedFlow, 'weekly');
  assert.equal(first.weekly.lastSuccessfulPlannedSlot, null);
  const early = await fixture({ state: anchor, now: '2026-09-23T06:00:00.000Z' }).service.status();
  assert.equal(early.status, 'before_slot');
  assert.equal(early.today.selectedFlow, 'radar');
  const missed = await fixture({ state: anchor, now: '2026-09-25T07:00:00.000Z' }).service.status();
  assert.equal(missed.today.selectedFlow, 'radar');
  assert.equal(missed.today.plannedSlot, '2026-09-25T07:00:00.000Z');
  const due = await fixture({ state: anchor, now: weeklyDue }).service.status();
  assert.equal(due.today.selectedFlow, 'weekly');
});

test('cross-midnight completion keeps the successful planned slot', async () => {
  const late = { ...anchor, last_successful_full_run_at: '2026-09-21T16:30:00.000Z' };
  const result = await fixture({ state: late, now: weeklyDue }).service.status();
  assert.equal(result.weekly.lastSuccessfulPlannedSlot, slot);
  assert.equal(result.today.selectedFlow, 'weekly');
});

test('invalid state and unsupported Local do not invent a scheduled flow', async () => {
  for (const state of ['{', { last_successful_scheduled_run_at: 'bad' }]) {
    const result = await fixture({ state }).service.status();
    assert.equal(result.status, 'invalid');
    assert.equal(result.today.selectedFlow, null);
  }
  const local = await fixture({ mode: 'local', state: anchor }).service.status();
  assert.equal(local.status, 'unsupported');
  assert.equal(local.today.selectedFlow, null);
});

test('disabled Radar stays selected and does not become Weekly', async () => {
  const result = await fixture({ state: anchor, radarEnabled: false }).service.status();
  assert.equal(result.status, 'radar_disabled');
  assert.equal(result.today.selectedFlow, 'radar');
  assert.equal(result.weekly.nextDuePlannedSlot, weeklyDue);
});

test('claimed run reports recovery and separates Weekly export from failed notification', async () => {
  const claim = claimed('2026-09-28', weeklyDue);
  const pending = await fixture({ now: '2026-09-28T09:00:00.000Z', state: { ...anchor, last_successful_scheduled_run_at: weeklyDue, last_successful_full_run_at: '2026-09-28T08:00:00.000Z' }, claim,
    ledger: { status: 'failed', stages: { stage4_exports: { status: 'verified' }, stage5_notification: { status: 'failed' } } } }).service.status();
  assert.equal(pending.status, 'recovery_required');
  assert.equal(pending.today.selectedFlow, 'weekly');
  assert.equal(pending.currentRun.business, 'completed');
  assert.equal(pending.notification, 'pending');
  const failed = await fixture({ now: weeklyDue, state: anchor, claim,
    ledger: { status: 'failed', stages: { stage4_exports: { status: 'failed' } } } }).service.status();
  assert.equal(failed.currentRun.business, 'not_completed');
  assert.equal(failed.weekly.lastSuccessfulPlannedSlot, slot);
  const unknown = await fixture({ now: weeklyDue, state: anchor, claim }).service.status();
  assert.equal(unknown.currentRun.state, 'unconfirmed');
  assert.equal(unknown.status, 'recovery_required');
});
