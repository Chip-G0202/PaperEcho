import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertProfileCapability, runtimeProfile } from "../lib/profile_capabilities.mjs";

import { buildRuntimeConfig } from "../lib/runtime_config.mjs";
import { REVIEW_REPORT_LABEL, REVIEW_WORKBOOK_FILE_NAME, dayLabel, isLastDueRunOfMonth, monthLabel, yyMd } from "../lib/report_period_support.mjs";
import {
  buildStage4RuntimeStateUpdate,
  fmtDate,
  markStage4ExportFailure,
  writeSuccessfulRuntimeState,
} from "./export_io.mjs";
import {
  collectMonthlyRunArtifacts,
  maybeGenerateMonthlyReport,
} from "./monthly_report_support.mjs";
import { prepareStage4ExportSource } from "./export_source_step.mjs";
import { runStage4WorkbookExport } from "./export_execution_step.mjs";
import { buildExportManifest, buildRunSummary, pipelineModeFromBackend } from "../lib/run_summary.mjs";

const RUNTIME = buildRuntimeConfig();
const RESEARCH_ROOT = RUNTIME.researchRoot;
const REVIEW_ROOT = RUNTIME.reviewRoot;
const RUNTIME_STATE_PATH = path.join(RESEARCH_ROOT, "runtime_state.json");
const TODAY = RUNTIME.now;

export { buildStage4RuntimeStateUpdate };

export async function finalizeResearchOsExports() {
  assertProfileCapability(runtimeProfile(), "xlsxWrite");
  const stageStarted = Date.now();
  const dateStr = fmtDate(TODAY);
  const pipelineDir = RUNTIME.pipelineDir;
  const reviewMonthLabel = monthLabel(TODAY);
  const reviewDayLabel = dayLabel(TODAY);
  const reviewMonthDir = path.join(REVIEW_ROOT, reviewMonthLabel);
  const reviewDayDir = path.join(reviewMonthDir, reviewDayLabel);
  const runIntervalDays = Number(process.env.review_results_RUN_INTERVAL_DAYS || 7);
  const shouldGenerateMonthlyReport = isLastDueRunOfMonth(TODAY, runIntervalDays);

  const runReportPath = path.join(pipelineDir, "run_report.json");
  const writebackReadyPath = path.join(pipelineDir, "writeback_ready_items.json");
  const backfillPath = path.join(pipelineDir, "abc_translation_backfill.json");
  const sourcePath = path.join(pipelineDir, "desktop_daily_review_source.json");
  const writebackSummaryPath = path.join(pipelineDir, "zotero_writeback_summary.json");
  const legacyWritebackSummaryPath = path.join(pipelineDir, "mcp_writeback_summary.json");
  const preferenceAuditPath = path.join(pipelineDir, "preference_learning_audit.json");
  const requestedOutputPath = path.join(reviewDayDir, REVIEW_WORKBOOK_FILE_NAME);
  const exportInputFiles = [writebackReadyPath, backfillPath, writebackSummaryPath, runReportPath, sourcePath];
  const paths = {
    pipelineDir,
    reviewRoot: REVIEW_ROOT,
    reviewMonthDir,
    reviewDayDir,
    runReportPath,
    writebackReadyPath,
    backfillPath,
    sourcePath,
    writebackSummaryPath,
    legacyWritebackSummaryPath,
    preferenceAuditPath,
    requestedOutputPath,
    exportInputFiles,
  };
  const labels = {
    dateStr,
    day: yyMd(TODAY),
    reviewMonthLabel,
    reviewDayLabel,
  };

  const source = await prepareStage4ExportSource({
    dateStr,
    paths,
    runtime: RUNTIME,
  });
  const recentRunArtifacts = await collectMonthlyRunArtifacts(RESEARCH_ROOT, TODAY);
  const { exportAudit, terminalExportError } = await runStage4WorkbookExport({
    paths,
    labels,
    source,
  });

  const monthlyReportResult = await maybeGenerateMonthlyReport({
    enabled: !terminalExportError && shouldGenerateMonthlyReport,
    outputDirectory: reviewMonthDir,
    now: TODAY,
    recentRunArtifacts,
    latestExportSummary: {
      status: exportAudit.stage4_export_status || "unknown",
      summary: exportAudit.export_error
        ? `Stage4 export failed: ${exportAudit.export_error}`
        : `Stage4 export ${exportAudit.stage4_export_status || "unknown"} by ${exportAudit.export_method || "unknown"}`,
      key_outputs: [exportAudit.actual_output_path || requestedOutputPath].filter(Boolean),
      export_error: exportAudit.export_error || null,
    },
  });
  exportAudit.monthly_report_due = shouldGenerateMonthlyReport;
  exportAudit.monthly_report_interval_days = runIntervalDays;
  exportAudit.monthly_docx_report_generated = monthlyReportResult.generated;
  exportAudit.monthly_docx_report_path = monthlyReportResult.outputPath;
  exportAudit.monthly_docx_data_source_note = monthlyReportResult.payload?.dataSourceNote || "";
  exportAudit.final_docx_outputs = monthlyReportResult.outputPath ? [monthlyReportResult.outputPath] : [];
  exportAudit.export_outputs = {
    ...(exportAudit.export_outputs || {}),
    ...(monthlyReportResult.outputPath ? { monthly_docx_report: monthlyReportResult.outputPath } : {}),
  };

  const runReport = source.runReport;
  runReport.steps = runReport.steps || {};
  runReport.steps.stage4_export_audit = exportAudit;
  const synthesisStep = {
    ok: !terminalExportError,
    completed: !terminalExportError,
    date: dateStr,
    export_policy: "codex_spreadsheet_first_for_daily_xlsx_with_monthly_docx",
    export_provider_priority: ["Spreadsheets", "node_fallback", "manual_required"],
    report_label: REVIEW_REPORT_LABEL,
    synthesis_label: "月报",
    downgrade_reason: terminalExportError ? String(terminalExportError.message || terminalExportError) : "",
    outputs: {
      ...(exportAudit.export_outputs || { every_other_day_report: requestedOutputPath }),
    },
  };
  runReport.steps.med_monthly_synthesis = synthesisStep;
  runReport.steps.med_weekly_synthesis = {
    ...synthesisStep,
    legacy_alias_for: "med_monthly_synthesis",
  };
  runReport.stage_timings = runReport.stage_timings || {};
  runReport.stage_timings.excel_export = {
    status: terminalExportError ? "failed" : "completed",
    ms: Date.now() - stageStarted,
    method: exportAudit.export_method,
  };

  await fs.writeFile(path.join(pipelineDir, "skill_alignment.json"), JSON.stringify(runReport.steps.skill_alignment || source.finalPayload.reportContext.skillAlignment, null, 2), "utf8");
  await fs.writeFile(runReportPath, JSON.stringify(runReport, null, 2), "utf8");
  if (terminalExportError) {
    throw terminalExportError;
  }
  await writeSuccessfulRuntimeState({
    runtimeStatePath: RUNTIME_STATE_PATH,
    runReport,
  });

  const exportManifest = await buildExportManifest(exportAudit, { outputRoot: REVIEW_ROOT });
  const literatureItems = (source.writebackSummary?.writeback_items || []).map((item) => ({
    title: item.title || "",
    grade: item.final_grade || item.grade || item.effective_grade || "",
  }));
  const finishedAt = new Date().toISOString();
  const runSummary = buildRunSummary({
    runId: process.env.review_results_RUN_ID || labels.day,
    pipelineMode: pipelineModeFromBackend(process.env.ZOTERO_BACKEND),
    status: "success",
    finishedAt,
    durationMs: Date.now() - stageStarted,
    runReport,
    writebackSummary: source.writebackSummary,
    translationSummary: source.backfillReport,
    createdItems: literatureItems,
    humanReviewCount: (source.finalPayload?.triaged || []).filter((item) => item?.needs_human_review).length,
    artifacts: exportManifest.artifacts,
    outputRoot: exportManifest.outputRoot,
  });
  console.log(JSON.stringify({ ok: true, stage: "finalize_exports", export: exportAudit }, null, 2));
  return { exportAudit, exportManifest, runSummary, literatureItems };
}

export async function markFinalizeExportsFailure(err) {
  try {
    await markStage4ExportFailure({
      runReportPath: path.join(RUNTIME.pipelineDir, "run_report.json"),
      err,
      date: TODAY,
    });
  } catch {}
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  finalizeResearchOsExports().catch(async (err) => {
    await markFinalizeExportsFailure(err);
    console.error(err);
    process.exit(1);
  });
}
