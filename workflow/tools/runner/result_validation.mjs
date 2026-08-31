import fs from "node:fs/promises";
import path from "node:path";

export function extractLastJsonObject(text = "") {
  let last = null;
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") depth += 1;
      else if (char === "}" && --depth === 0) {
        try {
          last = JSON.parse(text.slice(start, index + 1));
          start = index;
        } catch {}
        break;
      }
    }
  }
  return last;
}

function stageState(report, name) {
  const stage = (report?.stages || []).find((candidate) => candidate.name === name);
  if (!stage) return "MISSING";
  if (stage.exitCode === 0) return stage.status === "skipped" ? "SKIPPED" : "SUCCESS";
  if (name === "stage3_translation" && stage.exitCode === 2 && stage.status === "partial_failed") return "PARTIAL";
  return "FAILED";
}

function stage5State(report) {
  return String(report?.steps?.stage5_notification?.status || report?.stage5_notification?.status || "missing").toUpperCase();
}

function monthlyState(mode, report) {
  if (mode === "local") return "NOT_APPLICABLE";
  const audit = report?.artifacts?.stage4_run_report?.data?.steps?.stage4_export_audit || report?.artifacts?.stage4_export_audit;
  if (!audit?.monthly_docx_report_generated) return "NOT_DUE";
  return audit.monthly_docx_report_updated ? "UPDATED" : "GENERATED";
}

function stageSummary(mode, report) {
  if (mode === "local") return { stage1: report?.ok ? "SUCCESS" : "FAILED", stage2: "NOT_APPLICABLE", stage3: "NOT_APPLICABLE", stage4: report?.export_path ? "SUCCESS" : "FAILED" };
  return {
    stage1: stageState(report, "stage1"),
    stage2: stageState(report, "stage2_writeback"),
    stage3: stageState(report, "stage3_translation"),
    stage4: stageState(report, "stage4_exports"),
  };
}

function inspectLlmEvidence(value, pathParts = [], result = { observed: false, fallback: false }) {
  if (!value || typeof value !== "object") return result;
  for (const [key, child] of Object.entries(value)) {
    const currentPath = [...pathParts, key];
    const relevant = currentPath.some((part) => /llm|overview|translation/i.test(part));
    if (relevant && ["real_request_sent", "cached_real_request_sent"].includes(key) && child === true) result.observed = true;
    if (relevant && key === "status" && ["generated", "success"].includes(String(child).toLowerCase())) result.observed = true;
    if (relevant && key === "status" && String(child).toLowerCase() === "fallback") result.fallback = true;
    if (relevant && ["blocker", "fallbackReason", "fallback_reason", "error_type"].includes(key) && String(child || "").trim()) result.fallback = true;
    if (typeof child === "object") inspectLlmEvidence(child, currentPath, result);
  }
  return result;
}

export async function validateProductionResult({ options, plan, processResult, fsApi = fs } = {}) {
  if (processResult.signal) return { ok: false, reason: "canceled", exitCode: 7 };
  if (processResult.code !== 0) return { ok: false, reason: "production_entry_failed", productionExitCode: processResult.code, exitCode: 5 };
  const report = extractLastJsonObject(processResult.stdout);
  if (!report) return { ok: false, reason: "production_result_missing", exitCode: 6 };
  const runId = String(options.mode === "local" ? report.run_id : report.runId || "").trim();
  if (!runId) return { ok: false, reason: "current_run_id_missing", exitCode: 6 };
  const manifestPath = path.join(plan.runRoot, runId, "run_group.json");
  let manifest;
  try { manifest = JSON.parse(await fsApi.readFile(manifestPath, "utf8")); }
  catch { return { ok: false, reason: "current_run_group_missing", runId, exitCode: 6 }; }
  if (manifest.runId !== runId) return { ok: false, reason: "run_group_id_mismatch", runId, exitCode: 6 };
  if (manifest.schemaVersion !== 1) return { ok: false, reason: "run_group_schema_mismatch", runId, exitCode: 6 };
  if (manifest.pipelineMode !== options.mode) return { ok: false, reason: "run_group_mode_mismatch", runId, exitCode: 6 };
  if (manifest.status !== "completed") return { ok: false, reason: "run_group_not_completed", runId, exitCode: 6 };
  if (options.resume) {
    if (runId !== options.resume || report.resume !== true) return { ok: false, reason: "resume_result_mismatch", runId, exitCode: 6 };
    if (report.status !== "completed") return { ok: false, reason: "resume_incomplete", runId, recoveryStatus: report.status, exitCode: 6 };
    return { ok: true, exitCode: 0, runId, resume: true, manifest: { schemaVersion: manifest.schemaVersion, status: manifest.status, pipelineMode: manifest.pipelineMode }, recoveryStatus: report.status };
  }
  const radarProfile = options.profile === "radar";
  const stages = stageSummary(options.mode, report);
  if (Object.values(stages).includes("FAILED") || Object.values(stages).includes("MISSING")) return { ok: false, reason: "required_stage_failed", runId, stages, exitCode: 6 };
  const stage5 = stage5State(report);
  const stage5Accepted = radarProfile
    ? ["ACCEPTED", "SKIPPED"].includes(stage5)
    : ["SENT", "SKIPPED"].includes(stage5) && (!(plan.emailRequested || options.email) || stage5 === "SENT");
  if (!stage5Accepted) return { ok: false, reason: "stage5_requirement_failed", runId, stages, stage5, exitCode: 6 };
  const xlsxRegistered = (manifest.artifacts || []).some((artifact) => artifact.kind === "weekly_export" && artifact.retention === "30d");
  if (radarProfile && xlsxRegistered) return { ok: false, reason: "radar_xlsx_registered", runId, exitCode: 6 };
  if (!radarProfile && !xlsxRegistered) return { ok: false, reason: "xlsx_not_registered", runId, exitCode: 6 };
  const radarAudit = report?.artifacts?.radar_audit;
  if (radarProfile && (!radarAudit?.currentRun || radarAudit?.data?.zoteroWriteCount !== 0 || radarAudit?.data?.xlsxWriteCount !== 0)) {
    return { ok: false, reason: "radar_audit_unverified", runId, exitCode: 6 };
  }
  const llmEvidence = options.requireLlm ? inspectLlmEvidence(report) : null;
  if (options.requireLlm && (!llmEvidence.observed || llmEvidence.fallback)) return { ok: false, reason: "real_llm_result_unverified_or_fallback", runId, exitCode: 6 };
  const housekeeping = report.housekeeping || {};
  return {
    ok: true,
    exitCode: 0,
    runId,
    manifest: { schemaVersion: manifest.schemaVersion, status: manifest.status, pipelineMode: manifest.pipelineMode },
    stages,
    stage5,
    xlsxRegistered,
    monthly: radarProfile ? "NOT_APPLICABLE" : monthlyState(options.mode, report),
    housekeeping: { warnings: housekeeping.warnings || [] },
    ephemeralCleanup: {
      failedCount: Number(housekeeping.immediateFailedCount || 0),
      remaining: Number(housekeeping.registeredEphemeralsRemaining || 0),
    },
    localZotero: options.mode === "local" ? "NOT_APPLICABLE" : "BY_BACKEND",
    llm: options.requireLlm ? "VERIFIED_REAL" : "NOT_REQUIRED",
  };
}
