import fs from "node:fs/promises";
import path from "node:path";
import { fmtDateRfc } from "../lib/date_label_support.mjs";
import { resolvePlannedSlotAt } from "../lib/schedule_support.mjs";
import { withAtomicJsonLock, writeAtomicJson } from "../lib/atomic_json.mjs";

export function fmtDate(d) {
  return fmtDateRfc(d);
}

export function buildStage4RuntimeStateUpdate({
  runtimeState = {},
  runReport = {},
  now = new Date(),
  completedAt = null,
} = {}) {
  const completedIso = completedAt ? new Date(completedAt).toISOString() : now.toISOString();
  const triggerMode = String(runReport?.triggerMode || runReport?.trigger_mode || runReport?.interval_gate_diagnostics?.trigger || "").trim().toLowerCase();
  const scheduledTrigger = triggerMode === "scheduled" || triggerMode === "background";
  const plannedSlot = runReport?.current_planned_slot_at || runReport?.interval_gate_diagnostics?.planned_slot;
  const nextState = { ...runtimeState };
  if (scheduledTrigger) {
    if (typeof plannedSlot !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(plannedSlot)
      || !Number.isFinite(Date.parse(plannedSlot)) || resolvePlannedSlotAt(plannedSlot).toISOString() !== plannedSlot) {
      throw new Error("SCHEDULE_SUCCESS_SLOT_INVALID");
    }
    nextState.last_successful_full_run_at = completedIso;
    nextState.last_successful_scheduled_run_at = plannedSlot;
    nextState.last_accepted_planned_slot_at = plannedSlot;
  } else {
    nextState.last_successful_manual_run_at = completedIso;
  }
  return nextState;
}

export async function readJsonIfPresent(filePath) {
  try {
    return {
      ok: true,
      value: JSON.parse(await fs.readFile(filePath, "utf8")),
      missing: false,
      error: null,
    };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { ok: false, value: null, missing: true, error: err };
    }
    throw err;
  }
}

export async function writeSuccessfulRuntimeState({
  runtimeStatePath,
  runReport,
  now = new Date(),
}) {
  await withAtomicJsonLock(runtimeStatePath, async () => {
    let runtimeState;
    try { runtimeState = JSON.parse(await fs.readFile(runtimeStatePath, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") throw new Error(error instanceof SyntaxError ? "SCHEDULE_STATE_INVALID:json" : "SCHEDULE_STATE_UNREADABLE");
      runtimeState = {};
    }
    if (!runtimeState || typeof runtimeState !== "object" || Array.isArray(runtimeState)) throw new Error("SCHEDULE_STATE_INVALID:root");
    const nextState = buildStage4RuntimeStateUpdate({ runtimeState, runReport, now });
    await writeAtomicJson(runtimeStatePath, nextState);
  });
}

export async function markStage4ExportFailure({
  runReportPath,
  err,
  date = new Date(),
}) {
  const runReport = JSON.parse(await fs.readFile(runReportPath, "utf8"));
  runReport.failures = Array.isArray(runReport.failures) ? runReport.failures : [];
  runReport.failures.push({ stage: "stage4_monthly_synthesis_export", reason: String(err?.message || err), at: new Date().toISOString() });
  runReport.steps = runReport.steps || {};
  const synthesisStep = {
    ok: false,
    completed: false,
    date: fmtDate(date),
    downgrade_reason: String(err?.message || err),
    export_policy: "codex_spreadsheet_first_for_daily_and_monthly_docx",
  };
  runReport.steps.med_monthly_synthesis = synthesisStep;
  runReport.steps.med_weekly_synthesis = {
    ...synthesisStep,
    legacy_alias_for: "med_monthly_synthesis",
  };
  await fs.writeFile(runReportPath, JSON.stringify(runReport, null, 2), "utf8");
}

export async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}
