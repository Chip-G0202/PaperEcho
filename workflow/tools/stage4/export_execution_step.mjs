import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  EXPORT_METHODS,
  EXPORT_FALLBACK_CHAIN,
  detectCodexSpreadsheetAvailability,
  exportAllResearchOsXlsxWithCodexSpreadsheet,
  detectNodeFallbackAvailability,
  exportAllResearchOsXlsxWithNodeFallback,
  validateWeeklyWorkbook,
} from "./spreadsheet_adapter.mjs";
import { REVIEW_WORKBOOK_FILE_NAME } from "../lib/report_period_support.mjs";

function shortError(error) {
  return String(error?.message || error || "unknown_error").replace(/\s+/g, " ").slice(0, 300);
}

export async function runValidatedWeeklyWriter({
  writer,
  writerArgs,
  finalPath,
  validator = validateWeeklyWorkbook,
  fsApi = fs,
} = {}) {
  await fsApi.mkdir(path.dirname(finalPath), { recursive: true });
  const stagingDir = await fsApi.mkdtemp(path.join(path.dirname(finalPath), ".paperecho-stage4-"));
  const promotionPath = `${finalPath}.${process.pid}.${randomUUID()}.validated.tmp`;
  try {
    const result = await writer({ ...writerArgs, reviewDayDir: stagingDir });
    const producedPath = result?.outputs?.every_other_day_report || "";
    if (!producedPath) throw new Error("WEEKLY_WRITER_OUTPUT_MISSING");
    const validation = await validator(producedPath);
    if (!validation?.ok) throw new Error(`WEEKLY_WORKBOOK_VALIDATION_FAILED:${(validation?.errors || []).join("|")}`);
    await fsApi.copyFile(producedPath, promotionPath);
    const promotionValidation = await validator(promotionPath);
    if (!promotionValidation?.ok) throw new Error(`WEEKLY_PROMOTION_VALIDATION_FAILED:${(promotionValidation?.errors || []).join("|")}`);
    await fsApi.rename(promotionPath, finalPath);
    return {
      ...result,
      outputs: { ...(result.outputs || {}), every_other_day_report: finalPath },
      workbook_validation: promotionValidation,
    };
  } finally {
    await fsApi.unlink(promotionPath).catch(() => {});
    await fsApi.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runStage4WorkbookExport({
  paths,
  labels,
  source,
  dependencies = {},
} = {}) {
  const detectSpreadsheet = dependencies.detectCodexSpreadsheetAvailability || detectCodexSpreadsheetAvailability;
  const detectNode = dependencies.detectNodeFallbackAvailability || detectNodeFallbackAvailability;
  const codexWriter = dependencies.exportWithCodexSpreadsheet || exportAllResearchOsXlsxWithCodexSpreadsheet;
  const nodeWriter = dependencies.exportWithNodeFallback || exportAllResearchOsXlsxWithNodeFallback;
  const validatedWriter = dependencies.runValidatedWeeklyWriter || runValidatedWeeklyWriter;
  const validator = dependencies.validateWeeklyWorkbook || validateWeeklyWorkbook;
  const fsApi = dependencies.fsApi || fs;
  const spreadsheetAvailability = await detectSpreadsheet();
  const nodeFallbackAvailability = await detectNode();
  const fallbackChain = EXPORT_FALLBACK_CHAIN;
  const {
    runReport,
    writebackSummary,
    backfillReport,
    sourceFilterAudit,
    fallbackExportFields,
  } = source;
  const writerArgs = {
    sourcePath: paths.sourcePath,
    reviewRootDir: paths.reviewRoot,
    reviewWeekDir: paths.reviewMonthDir,
    reviewDayDir: paths.reviewDayDir,
    dateStr: labels.dateStr,
    weekLabel: labels.reviewMonthLabel,
    dayLabel: labels.reviewDayLabel,
  };
  const finalPath = paths.requestedOutputPath || path.join(paths.reviewDayDir, REVIEW_WORKBOOK_FILE_NAME);
  let res = null;
  let selectedMethod = "";
  let selectedProvider = "";
  let preferredWriterRejection = "";
  let nodeWriterRejection = "";

  if (spreadsheetAvailability.available) {
    try {
      res = await validatedWriter({ writer: codexWriter, writerArgs, finalPath, validator, fsApi });
      selectedMethod = EXPORT_METHODS.CODEX_SPREADSHEET;
      selectedProvider = "Spreadsheets";
    } catch (error) {
      preferredWriterRejection = shortError(error);
    }
  }
  if (!res && nodeFallbackAvailability.available) {
    try {
      res = await validatedWriter({ writer: nodeWriter, writerArgs, finalPath, validator, fsApi });
      selectedMethod = EXPORT_METHODS.NODE_FALLBACK;
      selectedProvider = "exceljs";
    } catch (error) {
      nodeWriterRejection = shortError(error);
    }
  }

  if (res) {
    const usedNodeFallback = selectedMethod === EXPORT_METHODS.NODE_FALLBACK;
    const sheets = Array.isArray(res.daily_workbook_sheets) ? res.daily_workbook_sheets : [];
    const exportAudit = {
      stage4_export_status: "success",
      export_method: selectedMethod,
      export_skill: usedNodeFallback ? "exceljs" : "codex_spreadsheet",
      export_provider: selectedProvider,
      codex_spreadsheet_available: Boolean(spreadsheetAvailability.available),
      codex_spreadsheet_unavailable_reason: spreadsheetAvailability.available ? null : spreadsheetAvailability.reason,
      spreadsheets_plugin_available: Boolean(spreadsheetAvailability.available),
      spreadsheets_plugin_unavailable_reason: spreadsheetAvailability.available ? null : spreadsheetAvailability.reason,
      node_fallback_available: Boolean(nodeFallbackAvailability.available),
      export_degraded: usedNodeFallback,
      export_degrade_reason: usedNodeFallback
        ? (preferredWriterRejection ? "codex_spreadsheet_validation_failed_using_node_fallback" : "codex_spreadsheet_unavailable_using_node_fallback")
        : "",
      preferred_writer_rejection: preferredWriterRejection || null,
      workbook_validation: res.workbook_validation,
      export_root: paths.reviewRoot,
      requested_output_path: paths.requestedOutputPath,
      actual_output_path: res.outputs?.every_other_day_report || null,
      desktop_export_disabled: true,
      export_input_files: paths.exportInputFiles,
      export_rows_count: res.rows_count,
      source_filter: sourceFilterAudit,
      ...fallbackExportFields,
      export_excluded_d_count: Number(runReport?.counts?.d_skipped || res.excluded_d_count || 0),
      export_writeback_failures_count: Array.isArray(writebackSummary?.failures) ? writebackSummary.failures.length : 0,
      export_translation_failures_count: Number(backfillReport?.failure_count || 0),
      export_error: null,
      export_fallback_chain: fallbackChain,
      final_xlsx_outputs: [REVIEW_WORKBOOK_FILE_NAME],
      final_docx_outputs: [],
      monthly_docx_report_path: null,
      monthly_docx_report_generated: false,
      monthly_docx_data_source_note: "",
      export_generated_at: new Date().toISOString(),
      manual_required: false,
      export_outputs: { ...res.outputs },
      daily_workbook_sheets: sheets.length ? sheets : ["每日反馈", "需人工复核"],
      standard_summary_sheet_exported: Boolean(res.standard_summary_sheet_exported),
      standard_summary_sheet_name: res.standard_summary_sheet_name || "",
      standard_summary_sheet_schema: res.standard_summary_sheet_schema || "",
      standard_summary_generated: Boolean(res.standard_summary_generated),
      standard_summary_generated_from_fallback: Boolean(res.standard_summary_generated_from_fallback),
      standard_summary_unavailable: Boolean(res.standard_summary_unavailable),
      standard_summary_user_feedback_columns_present: Boolean(res.standard_summary_user_feedback_columns_present),
    };
    return { exportAudit, terminalExportError: null };
  }

  const exportError = [
    spreadsheetAvailability.available ? preferredWriterRejection : `codex_spreadsheet:${spreadsheetAvailability.reason}`,
    nodeFallbackAvailability.available ? nodeWriterRejection : `node_fallback:${nodeFallbackAvailability.reason}`,
  ].filter(Boolean).join("; ");
  const exportAudit = {
    stage4_export_status: "failed",
    export_method: EXPORT_METHODS.MANUAL_REQUIRED,
    export_skill: null,
    export_provider: null,
    codex_spreadsheet_available: Boolean(spreadsheetAvailability.available),
    codex_spreadsheet_unavailable_reason: spreadsheetAvailability.available ? null : spreadsheetAvailability.reason,
    spreadsheets_plugin_available: Boolean(spreadsheetAvailability.available),
    spreadsheets_plugin_unavailable_reason: spreadsheetAvailability.available ? null : spreadsheetAvailability.reason,
    node_fallback_available: Boolean(nodeFallbackAvailability.available),
    node_fallback_unavailable_reason: nodeFallbackAvailability.available ? null : nodeFallbackAvailability.reason,
    export_output_path: null,
    export_root: paths.reviewRoot,
    requested_output_path: paths.requestedOutputPath,
    actual_output_path: null,
    desktop_export_disabled: true,
    export_input_files: paths.exportInputFiles,
    export_rows_count: 0,
    source_filter: sourceFilterAudit,
    ...fallbackExportFields,
    export_excluded_d_count: Number(runReport?.counts?.d_skipped || 0),
    export_writeback_failures_count: Array.isArray(writebackSummary?.failures) ? writebackSummary.failures.length : 0,
    export_translation_failures_count: Number(backfillReport?.failure_count || 0),
    export_error: exportError || "all_export_methods_unavailable",
    export_degraded: true,
    export_degrade_reason: "all_export_methods_unavailable_or_rejected",
    preferred_writer_rejection: preferredWriterRejection || null,
    node_writer_rejection: nodeWriterRejection || null,
    export_fallback_chain: fallbackChain,
    final_xlsx_outputs: [REVIEW_WORKBOOK_FILE_NAME],
    final_docx_outputs: [],
    monthly_docx_report_path: null,
    monthly_docx_report_generated: false,
    monthly_docx_data_source_note: "",
    export_generated_at: new Date().toISOString(),
    manual_required: true,
    manual_steps: [
      "Ensure @oai/artifact-tool is available in Codex runtime, or install exceljs: npm install exceljs",
      "Rerun: node workflow/tools/stage4/main.mjs",
    ],
  };
  return { exportAudit, terminalExportError: new Error(`ALL_EXPORT_METHODS_UNAVAILABLE_OR_REJECTED: ${exportAudit.export_error}`) };
}
