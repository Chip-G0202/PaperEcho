import fs from 'node:fs/promises';
import path from 'node:path';
import { decideScheduledDaily, plannedSlotCalendarDateKey, readScheduledRuntimeState, resolvePlannedSlotAt, scheduleDayDecisionPath } from './schedule_support.mjs';
import { OperationLedgerStore } from '../recovery/operation_ledger.mjs';

const safeReason = (error) => {
  const code = String(error?.message || 'SCHEDULE_STATUS_UNAVAILABLE');
  return /^SCHEDULE_[A-Z_]+(?::[a-z_]+)?$/.test(code) ? code : 'SCHEDULE_STATUS_UNAVAILABLE';
};

export class ControlScheduleStatusService {
  constructor({ context, config, fsApi = fs, clock = () => new Date(), loadLedger = (input) => OperationLedgerStore.load(input, { fsApi }) }) {
    Object.assign(this, { context, config, fsApi, clock, loadLedger });
  }

  async status() {
    const now = this.clock();
    const plannedSlot = resolvePlannedSlotAt(now).toISOString();
    const result = {
      status: 'ready', timezone: 'Asia/Shanghai', scheduledTime: '15:00',
      runtimePath: this.context.mode || null, radarEnabled: false,
      today: { plannedSlot, selectedFlow: null, reason: null },
      weekly: { lastSuccessfulPlannedSlot: null, nextDuePlannedSlot: null },
      currentRun: null, notification: null,
    };
    try {
      const owner = (await this.config.readOwnerOrTemplate('paperecho.config.json')).value;
      result.runtimePath = owner.mode || this.context.mode || null;
      result.radarEnabled = owner.common?.radar?.enabled === true;
      if (result.runtimePath === 'local') { result.status = 'unsupported'; return result; }
      if (!['desktop', 'web'].includes(result.runtimePath)) throw new Error('SCHEDULE_MODE_UNSUPPORTED');
      const intervalDays = Number(this.context.env?.review_results_RUN_INTERVAL_DAYS || 7);
      const weeklyMode = owner.profile || 'standard';
      const state = await readScheduledRuntimeState(path.join(this.context.researchRoot, 'runtime_state.json'), this.fsApi);
      // Preview no earlier than the planned slot. A Weekly may finish later that day.
      const preview = decideScheduledDaily({ now: new Date(now) < new Date(plannedSlot) ? plannedSlot : now, ...state, weeklyMode, radarEnabled: true, intervalDays });
      const decision = decideScheduledDaily({ now, ...state, weeklyMode, radarEnabled: result.radarEnabled, intervalDays });
      result.today = { plannedSlot, selectedFlow: preview.selectedFlow, reason: decision.reason };
      result.weekly = { lastSuccessfulPlannedSlot: preview.referenceSlot || null, nextDuePlannedSlot: preview.nextWeeklySlot || null };
      result.status = decision.reason === 'before_scheduled_slot' ? 'before_slot'
        : decision.reason === 'scheduled_radar_disabled' ? 'radar_disabled' : 'ready';

      const dateKey = plannedSlotCalendarDateKey(now);
      let claim;
      try { claim = JSON.parse(await this.fsApi.readFile(scheduleDayDecisionPath(path.join(this.context.researchRoot, 'schedule_decisions'), dateKey), 'utf8')); }
      catch (error) { if (error?.code !== 'ENOENT') throw new Error('SCHEDULE_DAY_DECISION_UNREADABLE'); }
      if (!claim) return result;
      if (new Date(now) < new Date(plannedSlot)) throw new Error('SCHEDULE_DAY_DECISION_BEFORE_SLOT');
      if (claim.schemaVersion !== 1 || claim.dateKey !== dateKey || claim.plannedSlotAt !== plannedSlot
        || !['weekly_takeover', 'radar'].includes(claim.decision) || typeof claim.businessRunId !== 'string'
        || (claim.businessRunId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(claim.businessRunId))) throw new Error('SCHEDULE_DAY_DECISION_INVALID');
      const flow = claim.decision === 'weekly_takeover' ? 'weekly' : 'radar';
      result.today.selectedFlow = flow;
      if (!claim.businessRunId) {
        result.status = 'recovery_required';
        result.currentRun = { flow, state: 'unconfirmed', business: 'unconfirmed' };
        return result;
      }
      let ledger;
      try { ledger = (await this.loadLedger({ runRoot: path.join(this.context.reviewRoot, 'runs'), runId: claim.businessRunId })).ledger; }
      catch {
        result.status = 'recovery_required';
        result.currentRun = { flow, state: 'unconfirmed', business: 'unconfirmed' };
        return result;
      }
      const businessComplete = flow === 'weekly'
        ? ledger.stages?.stage4_exports?.status === 'verified' && preview.referenceSlot === plannedSlot
        : ledger.status === 'completed';
      const notification = ledger.stages?.stage5_notification?.status;
      result.notification = notification === 'failed' ? 'pending' : notification === 'verified' ? 'completed' : null;
      const stateLabel = ledger.status === 'completed' ? 'completed'
        : ledger.status === 'running' ? 'running'
          : ['failed', 'incomplete', 'interrupted', 'timed_out'].includes(ledger.status) ? 'recovery_required' : 'unconfirmed';
      result.currentRun = { flow, state: stateLabel, business: businessComplete ? 'completed' : stateLabel === 'running' ? 'running' : 'not_completed' };
      if (stateLabel === 'recovery_required' || stateLabel === 'unconfirmed') result.status = 'recovery_required';
      else if (stateLabel === 'completed') result.status = 'ready';
      return result;
    } catch (error) {
      return { ...result, status: 'invalid', reason: safeReason(error), today: { plannedSlot, selectedFlow: null, reason: null }, weekly: { lastSuccessfulPlannedSlot: null, nextDuePlannedSlot: null }, currentRun: null, notification: null };
    }
  }
}
