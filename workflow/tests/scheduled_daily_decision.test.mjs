import assert from 'node:assert/strict';
import test from 'node:test';
import { decideScheduledDaily, readScheduledRuntimeState } from '../tools/lib/schedule_support.mjs';

const day = (offset, hour = 7) => new Date(Date.UTC(2026, 8, 21 + offset, hour));
const baseline = { last_successful_scheduled_run_at: day(0).toISOString(), last_successful_full_run_at: day(0, 8).toISOString(), last_accepted_planned_slot_at: day(0).toISOString() };
const select = (offset, overrides = {}) => decideScheduledDaily({ now: day(offset), runtimeState: baseline, statePresent: true, radarEnabled: true, ...overrides });

test('first valid slot runs Weekly, then six Radar slots and another Weekly', () => {
  assert.equal(decideScheduledDaily({ now: day(0), runtimeState: {}, statePresent: true }).selectedFlow, 'weekly');
  for (let offset = 1; offset <= 6; offset += 1) assert.equal(select(offset).selectedFlow, 'radar');
  assert.equal(select(7).selectedFlow, 'weekly');
});

test('before 15:00 Beijing does not reserve work, including a missed Weekly day', () => {
  const early = select(8, { now: day(8, 6) });
  assert.equal(early.allowed, false);
  assert.equal(early.reason, 'before_scheduled_slot');
  assert.equal(early.selectedFlow, null);
});

test('cross-midnight completion preserves the original successful planned slot', () => {
  const state = { ...baseline, last_successful_full_run_at: new Date('2026-09-21T16:30:00.000Z').toISOString() };
  assert.equal(select(6, { runtimeState: state }).selectedFlow, 'radar');
  const due = select(7, { runtimeState: state });
  assert.equal(due.selectedFlow, 'weekly');
  assert.equal(due.referenceSlot, baseline.last_successful_scheduled_run_at);
});

test('missed Radar and due days do not create historical catch-up decisions', () => {
  const result = select(8);
  assert.equal(result.selectedFlow, 'weekly');
  assert.equal(result.plannedSlot, day(8).toISOString());
});

test('current Weekly mode is used only when due and does not reset the cycle', () => {
  assert.equal(select(6, { weeklyMode: 'complete' }).selectedFlow, 'radar');
  assert.equal(select(7, { weeklyMode: 'complete' }).weeklyMode, 'complete');
  assert.throws(() => select(7, { weeklyMode: 'radar' }), /SCHEDULE_WEEKLY_MODE_INVALID/);
});

test('Radar enable is checked only on Radar days', () => {
  assert.equal(select(7, { radarEnabled: false }).selectedFlow, 'weekly');
  assert.equal(select(1, { radarEnabled: false }).reason, 'scheduled_radar_disabled');
});

test('legacy completion field is used only when the successful planned slot is absent', () => {
  const legacy = { last_successful_full_run_at: day(0, 8).toISOString() };
  assert.equal(select(7, { runtimeState: legacy }).referenceField, 'last_successful_full_run_at');
  assert.throws(() => select(7, { runtimeState: { ...legacy, last_successful_scheduled_run_at: 'bad' } }), /SCHEDULE_STATE_INVALID/);
});

test('corrupted, contradictory and future state fail closed', () => {
  for (const state of [
    { last_successful_manual_run_at: day(0).toISOString() },
    { last_successful_scheduled_run_at: 'not-a-date' },
    { ...baseline, last_accepted_planned_slot_at: day(1).toISOString() },
    { ...baseline, last_successful_full_run_at: day(-1).toISOString() },
    { ...baseline, last_successful_scheduled_run_at: day(9).toISOString() },
  ]) assert.throws(() => select(7, { runtimeState: state }), /SCHEDULE_STATE_INVALID/);
  assert.throws(() => select(7, { intervalDays: 14 }), /SCHEDULE_INTERVAL_UNSUPPORTED/);
});

test('state reader distinguishes missing, unreadable and malformed from an empty initial state', async () => {
  const absent = await readScheduledRuntimeState('unused', { readFile: async () => { const error = new Error('absent'); error.code = 'ENOENT'; throw error; } });
  assert.deepEqual(absent, { statePresent: false, runtimeState: null });
  const empty = await readScheduledRuntimeState('unused', { readFile: async () => '{}' });
  assert.equal(decideScheduledDaily({ now: day(0), ...empty }).selectedFlow, 'weekly');
  await assert.rejects(readScheduledRuntimeState('unused', { readFile: async () => '{' }), /SCHEDULE_STATE_INVALID:json/);
  await assert.rejects(readScheduledRuntimeState('unused', { readFile: async () => { throw new Error('permission'); } }), /SCHEDULE_STATE_UNREADABLE/);
});
