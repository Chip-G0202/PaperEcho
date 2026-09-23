import { buildRuntimeStateDiagnostics, evaluateRunInterval } from "../lib/schedule_support.mjs";
import { REVIEW_REPORT_LABEL } from "../lib/report_period_support.mjs";

export const AUTOMATION_NAME = "zotero-literature-filter";

function parseBooleanFlag(value) {
  return /^(1|true|yes)$/i.test(String(value || "").trim());
}

export function parseForceRun(env = process.env) {
  return parseBooleanFlag(env.FORCE_review_results_RUN) || parseBooleanFlag(env.review_results_FORCE_RUN);
}

export function parseTriggerMode(env = process.env, argv = process.argv) {
  const fromEnv = String(env.review_results_ORCHESTRATOR_TRIGGER || env.ZOTERO_ORCHESTRATOR_TRIGGER || "").trim().toLowerCase();
  if (fromEnv) return fromEnv;
  if ((argv || []).includes("--manual")) return "manual";
  const arg = (argv || []).find((x) => x.startsWith("--trigger="));
  const fromArg = arg ? String(arg.split("=")[1] || "").trim().toLowerCase() : "";
  return fromArg || "manual";
}

export function isManualTrigger(triggerMode) {
  const v = String(triggerMode || "").trim().toLowerCase();
  return v !== "scheduled" && v !== "background";
}

export async function evaluateOrchestratorIntervalGate(config, clock, readJson, { triggerMode = "manual", scheduledDailyDecision = null } = {}) {
  const manualTrigger = isManualTrigger(triggerMode);
  const referenceStateField = scheduledDailyDecision?.referenceField || "last_successful_full_run_at";
  let lastSuccessfulRunAt = null;
  if (scheduledDailyDecision) lastSuccessfulRunAt = scheduledDailyDecision.referenceSlot;
  else {
    try {
      const runtimeState = await readJson(`${config.researchRoot}/runtime_state.json`);
      lastSuccessfulRunAt = runtimeState?.[referenceStateField] || null;
    } catch {}
  }
  const explicitForceRun = parseForceRun(process.env);
  const intervalDays = Number(process.env.review_results_RUN_INTERVAL_DAYS || 7);
  const intervalInfo = evaluateRunInterval({
    now: clock(),
    lastSuccessfulRunAt,
    intervalDays,
    forceRun: manualTrigger || explicitForceRun,
  });
  if (scheduledDailyDecision && intervalInfo.skipped_due_to_interval !== (scheduledDailyDecision.selectedFlow === "radar")) {
    throw new Error("SCHEDULE_STAGE0_INTERVAL_MISMATCH");
  }
  const skipReason = intervalInfo.skipped_due_to_interval
    ? "interval_not_reached"
    : manualTrigger
      ? "manual_bypass"
      : explicitForceRun
        ? "force_run_bypass"
        : lastSuccessfulRunAt
          ? "run_due"
          : "no_previous_run";
  const diagnostics = {
    gate_name: "orchestrator_interval_gate",
    trigger: String(triggerMode || "unknown") || "unknown",
    force_run: Boolean(manualTrigger || explicitForceRun),
    manual_trigger: Boolean(manualTrigger),
    interval_days: intervalInfo.run_interval_days,
    reference_state_field: referenceStateField,
    last_reference_time: lastSuccessfulRunAt || null,
    runtime_state_diagnostics: buildRuntimeStateDiagnostics({
      referenceStateField,
      writtenStateFields: [],
    }),
    planned_slot: intervalInfo.current_planned_slot_at || null,
    run_due: Boolean(intervalInfo.run_due),
    skipped_due_to_interval: Boolean(intervalInfo.skipped_due_to_interval),
    skip_reason: skipReason,
    next_eligible_run_at: intervalInfo.next_eligible_run_at || "unknown",
    source: "evaluateOrchestratorIntervalGate",
  };
  const skipReport = !manualTrigger && intervalInfo.skipped_due_to_interval
    ? {
      started_at: intervalInfo.current_run_at,
      skipped: true,
      reason: "interval_not_reached",
      automation_name: AUTOMATION_NAME,
      triggerMode,
      forceRun: false,
      explicitForceRun: false,
      bypassIntervalGate: false,
      bypassReason: null,
      ...intervalInfo,
      report_cadence: "weekly",
      report_label: REVIEW_REPORT_LABEL,
      synthesis_cadence: "monthly",
      synthesis_label: "月报",
      export_root: config.reviewRoot,
      desktop_export_disabled: true,
      interval_gate_diagnostics: diagnostics,
    }
    : null;
  return { skipReport, diagnostics };
}

export function parseStage1Only(env = process.env, argv = process.argv) {
  const flag = (argv || []).includes("--stage1-only");
  const fromEnv = /^(1|true|yes)$/i.test(String(env.review_results_STAGE1_ONLY || "").trim());
  return flag || fromEnv;
}

export function detectRunMode(env = process.env, argv = process.argv) {
  const triggerMode = parseTriggerMode(env, argv);
  const manualTrigger = isManualTrigger(triggerMode);
  const forceRun = manualTrigger || parseForceRun(env);
  const isScheduled = triggerMode === "scheduled" || triggerMode === "background";
  const isManualOrForce = manualTrigger || forceRun;
  const explicitForceRun = parseForceRun(env);
  return { triggerMode, isScheduled, isManualOrForce, forceRun, explicitForceRun };
}
