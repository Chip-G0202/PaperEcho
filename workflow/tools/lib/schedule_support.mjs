import fs from "node:fs/promises";
import path from "node:path";
import { withAtomicJsonLock, writeAtomicJson } from "./atomic_json.mjs";

const ASIA_SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const SLOT_HOUR_LOCAL = 15;

// Central ownership map for runtime_state.json fields that influence scheduling
// or stateful stage gates. Keep this descriptive only; do not migrate or rename
// persisted runtime_state fields here.
export const RUNTIME_STATE_FIELD_OWNERSHIP = Object.freeze({
  last_successful_scheduled_run_at: Object.freeze({
    semantics: "Beijing 15:00 planned slot of the last successfully exported scheduled Weekly run.",
    owner: "Stage 4 final export success path",
    usage: "Primary seven-day cadence anchor for the scheduled daily entry.",
    write_boundary: "Written atomically after the scheduled Weekly export commits, independently of notification outcome.",
  }),
  last_successful_full_run_at: Object.freeze({
    semantics: "Timestamp recorded after a scheduled/background complete workflow finishes successfully; manual runs do not advance scheduled cadence.",
    owner: "Stage 4 final export success path",
    usage: "Reference field for the outer orchestrator interval gate.",
    write_boundary: "Write only after scheduled/background final export succeeds; manual success writes last_successful_manual_run_at instead.",
  }),
  last_accepted_planned_slot_at: Object.freeze({
    semantics: "Planned slot accepted and processed by Stage 1.",
    owner: "Stage 1 pipeline",
    usage: "Reference field for the Stage 1 internal interval gate.",
    write_boundary: "Stage 1 owns accepted-slot state; Stage 4 currently mirrors current_planned_slot_at for compatibility.",
  }),
  last_translation_pool_scan_at: Object.freeze({
    semantics: "Most recent Stage 3 translation pool scan execution time.",
    owner: "Stage 3 translation backfill",
    usage: "Controls or records translation pool scan cadence.",
    write_boundary: "Write only when the Stage 3 pool scan executes.",
  }),
  last_translation_pool_scan_planned_slot_at: Object.freeze({
    semantics: "Legacy planned-slot field for translation pool scan state.",
    owner: "Legacy Stage 3 translation backfill",
    usage: "Legacy audit context only; no active reader should depend on it.",
    write_boundary: "Legacy field; no longer written. Do not delete historical persisted values.",
    legacy: true,
  }),
});

export function buildRuntimeStateDiagnostics({
  referenceStateField = null,
  writtenStateFields = [],
} = {}) {
  const fieldOwnership = {};
  for (const field of Object.keys(RUNTIME_STATE_FIELD_OWNERSHIP)) {
    fieldOwnership[field] = RUNTIME_STATE_FIELD_OWNERSHIP[field];
  }
  return {
    reference_state_field: referenceStateField,
    written_state_fields: Array.isArray(writtenStateFields) ? [...writtenStateFields] : [],
    field_ownership: fieldOwnership,
  };
}

export function resolveRuntimeStateReference(runtimeState = {}, referenceFields = []) {
  for (const field of referenceFields) {
    const value = runtimeState?.[field];
    if (value) {
      return {
        reference_state_field: field,
        last_reference_time: value,
      };
    }
  }
  return {
    reference_state_field: null,
    last_reference_time: null,
  };
}

export function buildIntervalGateDiagnostics({
  gateName,
  trigger = "unknown",
  forceRun = false,
  manualTrigger = "unknown",
  intervalInfo = {},
  referenceStateField = null,
  lastReferenceTime = null,
  skipReason = "",
  source = "",
  writtenStateFields = [],
} = {}) {
  return {
    gate_name: gateName || "unknown_interval_gate",
    trigger: String(trigger || "unknown") || "unknown",
    force_run: Boolean(forceRun),
    manual_trigger: manualTrigger,
    interval_days: intervalInfo.run_interval_days,
    reference_state_field: referenceStateField,
    last_reference_time: lastReferenceTime || null,
    runtime_state_diagnostics: buildRuntimeStateDiagnostics({
      referenceStateField,
      writtenStateFields,
    }),
    planned_slot: intervalInfo.current_planned_slot_at || null,
    run_due: Boolean(intervalInfo.run_due),
    skipped_due_to_interval: Boolean(intervalInfo.skipped_due_to_interval),
    skip_reason: skipReason || "",
    next_eligible_run_at: intervalInfo.next_eligible_run_at || "unknown",
    source,
  };
}

function toBeijingDate(date) {
  return new Date(date.getTime() + ASIA_SHANGHAI_OFFSET_MS);
}

export function resolvePlannedSlotAt(date) {
  const bj = toBeijingDate(new Date(date));
  const slot = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), SLOT_HOUR_LOCAL, 0, 0, 0));
  return new Date(slot.getTime() - ASIA_SHANGHAI_OFFSET_MS);
}

export function plannedSlotCalendarDateKey(date) {
  const plannedSlot = resolvePlannedSlotAt(date);
  const localSlot = toBeijingDate(plannedSlot);
  return `${localSlot.getUTCFullYear()}-${String(localSlot.getUTCMonth() + 1).padStart(2, "0")}-${String(localSlot.getUTCDate()).padStart(2, "0")}`;
}

export function scheduleDayDecisionPath(stateRoot, dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ""))) throw new Error("SCHEDULE_DATE_KEY_INVALID");
  return path.join(path.resolve(stateRoot), "v1", `${dateKey}.json`);
}

export async function claimScheduleDayDecision({
  stateRoot,
  now = new Date(),
  weeklyDue = false,
  requestedProfile = "radar",
  runId,
  fsApi = fs,
  atomicWriter = writeAtomicJson,
  clock = () => new Date(),
} = {}) {
  const dateKey = plannedSlotCalendarDateKey(now);
  const filePath = scheduleDayDecisionPath(stateRoot, dateKey);
  return withAtomicJsonLock(filePath, async () => {
    let existing = null;
    try { existing = JSON.parse(await fsApi.readFile(filePath, "utf8")); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (existing) {
      if (existing.schemaVersion !== 1 || existing.dateKey !== dateKey || !new Set(["weekly_takeover", "radar"]).has(existing.decision)) {
        throw new Error("SCHEDULE_DAY_DECISION_INVALID");
      }
      if (existing.decision === "weekly_takeover" && requestedProfile === "weekly" && !existing.businessRunId) {
        existing.businessRunId = String(runId || "");
        existing.claimedAt = clock().toISOString();
        await atomicWriter(filePath, existing, { fsApi });
        return { ...existing, filePath, created: false, duplicateTrigger: false, claimedExistingDecision: true };
      }
      return { ...existing, filePath, created: false, duplicateTrigger: Boolean(existing.businessRunId), claimedExistingDecision: false };
    }
    const decision = weeklyDue ? "weekly_takeover" : "radar";
    const value = {
      schemaVersion: 1,
      dateKey,
      plannedSlotAt: resolvePlannedSlotAt(now).toISOString(),
      decision,
      businessRunId: decision === "radar" || requestedProfile === "weekly" ? String(runId || "") : "",
      createdAt: clock().toISOString(),
    };
    if (decision === "radar" && !value.businessRunId) throw new Error("SCHEDULE_DAY_RUN_ID_REQUIRED");
    await atomicWriter(filePath, value, { fsApi });
    return { ...value, filePath, created: true, duplicateTrigger: false };
  }, { fsApi, clock });
}

function parseNullableIso(value) {
  if (value === undefined || value === null || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function evaluateRunInterval({
  now = new Date(),
  lastSuccessfulRunAt = null,
  intervalDays = 7,
  forceRun = false,
} = {}) {
  const normalizedIntervalDays = (() => {
    const n = Number(intervalDays);
    return Number.isFinite(n) && n > 0 ? n : 7;
  })();
  const currentRunAt = new Date(now).toISOString();
  const currentSlot = resolvePlannedSlotAt(now);
  const currentSlotIso = currentSlot.toISOString();
  const lastAcceptedSlot = parseNullableIso(lastSuccessfulRunAt)
    ? resolvePlannedSlotAt(lastSuccessfulRunAt)
    : null;
  const lastAcceptedSlotIso = lastAcceptedSlot ? lastAcceptedSlot.toISOString() : null;

  const slotIntervalMs = Math.max(1, Math.round(normalizedIntervalDays * 24 * 60 * 60 * 1000));
  const elapsedHoursSinceLastSuccess = lastAcceptedSlot
    ? (currentSlot.getTime() - lastAcceptedSlot.getTime()) / 3600000
    : null;
  const runDue = lastAcceptedSlot === null || (elapsedHoursSinceLastSuccess !== null && currentSlot.getTime() - lastAcceptedSlot.getTime() >= slotIntervalMs);
  const nextEligibleRunAt = lastAcceptedSlot
    ? new Date(lastAcceptedSlot.getTime() + slotIntervalMs).toISOString()
    : currentSlotIso;
  const skippedDueToInterval = !runDue && !forceRun;

  return {
    run_interval_days: normalizedIntervalDays,
    last_successful_run_at: lastSuccessfulRunAt,
    last_accepted_planned_slot_at: lastAcceptedSlotIso,
    current_run_at: currentRunAt,
    current_planned_slot_at: currentSlotIso,
    elapsed_hours_since_last_success: elapsedHoursSinceLastSuccess,
    run_due: runDue,
    force_run: Boolean(forceRun),
    skipped_due_to_interval: skippedDueToInterval,
    next_eligible_run_at: nextEligibleRunAt,
  };
}

function scheduleInstant(value, field, { plannedSlot = false } = {}) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`SCHEDULE_STATE_INVALID:${field}`);
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value
    || (plannedSlot && resolvePlannedSlotAt(instant).toISOString() !== value)) {
    throw new Error(`SCHEDULE_STATE_INVALID:${field}`);
  }
  return instant;
}

// A read-only decision shared by the scheduled Runner and Stage0. The Stage0
// claim remains the authority for admitting work on a particular day.
export function decideScheduledDaily({
  now = new Date(),
  runtimeState = null,
  statePresent = false,
  weeklyMode = "standard",
  radarEnabled = false,
  intervalDays = 7,
} = {}) {
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) throw new Error("SCHEDULE_TIME_INVALID");
  if (!["standard", "complete"].includes(weeklyMode)) throw new Error("SCHEDULE_WEEKLY_MODE_INVALID");
  if (intervalDays !== 7) throw new Error("SCHEDULE_INTERVAL_UNSUPPORTED");
  if (statePresent && (!runtimeState || typeof runtimeState !== "object" || Array.isArray(runtimeState))) throw new Error("SCHEDULE_STATE_INVALID:root");
  const state = runtimeState || {};
  const slot = resolvePlannedSlotAt(current);
  const plannedSlot = slot.toISOString();
  const has = (field) => Object.hasOwn(state, field);
  const plannedField = "last_successful_scheduled_run_at";
  const legacyField = "last_successful_full_run_at";
  let referenceSlot = null;
  let referenceField = null;
  if (has(plannedField)) {
    referenceSlot = scheduleInstant(state[plannedField], plannedField, { plannedSlot: true });
    referenceField = plannedField;
  } else if (has(legacyField)) {
    referenceSlot = resolvePlannedSlotAt(scheduleInstant(state[legacyField], legacyField));
    referenceField = legacyField;
  } else if (statePresent && Object.keys(state).length) {
    throw new Error("SCHEDULE_STATE_INVALID:missing_weekly_success");
  }
  if (has(legacyField) && referenceField === plannedField) {
    const completed = scheduleInstant(state[legacyField], legacyField);
    if (completed < referenceSlot || completed > current) throw new Error("SCHEDULE_STATE_INVALID:success_order");
  }
  if (referenceField === legacyField && scheduleInstant(state[legacyField], legacyField) > current) throw new Error("SCHEDULE_STATE_INVALID:future_completion");
  if (has("last_accepted_planned_slot_at")) {
    const accepted = scheduleInstant(state.last_accepted_planned_slot_at, "last_accepted_planned_slot_at", { plannedSlot: true });
    if (!referenceSlot || accepted > referenceSlot) throw new Error("SCHEDULE_STATE_INVALID:accepted_slot");
  }
  if (referenceSlot && referenceSlot > slot) throw new Error("SCHEDULE_STATE_INVALID:future_weekly_slot");
  if (current < slot) return { allowed: false, reason: "before_scheduled_slot", plannedSlot, selectedFlow: null, weeklyMode: null, referenceField };
  const due = !referenceSlot || slot.getTime() - referenceSlot.getTime() >= 7 * 86400000;
  const selectedFlow = due ? "weekly" : "radar";
  if (!due && !radarEnabled) return { allowed: false, reason: "scheduled_radar_disabled", plannedSlot, selectedFlow, weeklyMode: null, referenceField };
  return {
    allowed: true,
    reason: !referenceSlot ? "first_weekly" : due ? "weekly_due" : "weekly_not_due",
    plannedSlot,
    selectedFlow,
    weeklyMode: due ? weeklyMode : null,
    referenceField,
    referenceSlot: referenceSlot?.toISOString() || null,
    nextWeeklySlot: referenceSlot ? new Date(referenceSlot.getTime() + 7 * 86400000).toISOString() : plannedSlot,
  };
}

export async function readScheduledRuntimeState(filePath, fsApi = fs) {
  let raw;
  try { raw = await fsApi.readFile(filePath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return { statePresent: false, runtimeState: null };
    throw new Error("SCHEDULE_STATE_UNREADABLE");
  }
  try { return { statePresent: true, runtimeState: JSON.parse(raw) }; }
  catch { throw new Error("SCHEDULE_STATE_INVALID:json"); }
}
