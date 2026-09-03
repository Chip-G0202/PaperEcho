import fs from "node:fs/promises";
import path from "node:path";
import { buildStandardSummary } from "../stage1/preference_refinement.mjs";
import { cleanJournalName } from "../lib/journal_name_cleaner.mjs";
import { inspectXlsxWorkbook } from "../lib/review_workbook_reader.mjs";

export const EXPORT_METHODS = {
  CODEX_SPREADSHEET: "codex_spreadsheet",
  NODE_FALLBACK: "node_fallback",
  PYTHON_SPAWN_LEGACY: "python_spawn_legacy",
  MANUAL_REQUIRED: "manual_required",
};

export const EXPORT_FALLBACK_CHAIN = [
  EXPORT_METHODS.CODEX_SPREADSHEET,
  EXPORT_METHODS.NODE_FALLBACK,
  EXPORT_METHODS.PYTHON_SPAWN_LEGACY,
  EXPORT_METHODS.MANUAL_REQUIRED,
];

export const PREFERENCE_AUDIT_SHEET_NAMES = ["偏好学习摘要", "偏好证据明细", "筛选标准变更", "本次筛选影响", "当前筛选标准摘要"];
export const STANDARD_SUMMARY_HEADERS = ["当前筛选标准", "我的评价"];
export const STANDARD_SUMMARY_SHEET_SCHEMA = "zh_two_column";
export const STANDARD_SUMMARY_FEEDBACK_OPTIONS = [
  "accurate", "too_broad", "too_narrow", "wrong_focus", "missing_priority", "over_excluding", "under_excluding", "needs_more_clinical_focus", "other",
  "准确", "太宽泛", "太窄", "重点错了", "缺少重点", "过度排除", "排除不足", "需要更偏临床", "其他",
];

export const DAILY_REVIEW_HEADERS = ["英文标题", "标题翻译", "规则等级", "语义等级", "最终等级", "期刊/来源", "反馈", "评价"];

export const HUMAN_REVIEW_HEADERS = ["标题", "标题翻译", "期刊/来源", "发表日期", "规则等级", "语义等级", "最终等级", "是否需人工复核", "分歧类型", "语义调整原因", "人工确认等级"];

export async function validateWeeklyWorkbook(filePath) {
  const errors = [];
  let inspection;
  try {
    inspection = inspectXlsxWorkbook(filePath);
  } catch (error) {
    return { ok: false, errors: [`workbook_unreadable:${String(error?.message || error)}`], sheets: [], formula_errors: [] };
  }
  const sheetNames = [...inspection.sheets.keys()];
  for (const required of ["每日反馈", "需人工复核"]) {
    if (!inspection.sheets.has(required)) errors.push(`required_sheet_missing:${required}`);
  }
  const daily = inspection.sheets.get("每日反馈") || [];
  const review = inspection.sheets.get("需人工复核") || [];
  const headerMatches = (rows, expected) => expected.every((value, index) => String(rows?.[0]?.[index] || "").trim() === value);
  if (!headerMatches(daily, DAILY_REVIEW_HEADERS)) errors.push("daily_headers_invalid");
  if (!headerMatches(review, HUMAN_REVIEW_HEADERS)) errors.push("human_review_headers_invalid");
  for (let index = 1; index < daily.length; index++) {
    if (String(daily[index]?.[6] || "").trim()) errors.push(`daily_feedback_not_blank:G${index + 1}`);
    if (String(daily[index]?.[7] || "").trim()) errors.push(`daily_comment_not_blank:H${index + 1}`);
  }
  for (let index = 1; index < review.length; index++) {
    if (String(review[index]?.[10] || "").trim()) errors.push(`human_confirmation_not_blank:K${index + 1}`);
  }
  if (inspection.formula_errors.length) errors.push(`formula_errors:${inspection.formula_errors.length}`);
  return { ok: errors.length === 0, errors, sheets: sheetNames, formula_errors: inspection.formula_errors };
}

export async function detectCodexSpreadsheetAvailability() {
  try {
    await import("@oai/artifact-tool");
    return { available: true, reason: null };
  } catch (err) {
    const rawReason = String(err?.message || err || "").trim();
    const reason = rawReason.includes("@oai/artifact-tool")
      ? `Spreadsheets plugin unavailable in this execution context (artifact-tool not visible here): ${rawReason}`
      : `Spreadsheets plugin unavailable in this execution context: ${rawReason || "unknown import failure"}`;
    return { available: false, reason };
  }
}

async function saveWorkbook(workbook, outputPath) {
  const { SpreadsheetFile } = await import("@oai/artifact-tool");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const xlsx = await SpreadsheetFile.exportXlsx(workbook);
  await xlsx.save(outputPath);
  return outputPath;
}

function createWorkbookWithSheet(Workbook, name) {
  const wb = Workbook.create();
  const ws = wb.worksheets.add(name);
  return { wb, ws };
}

/**
 * Extract a grade letter (A/B/C/D) from an item, trying multiple field names.
 */
function getValueByPath(item, key) {
  if (!key.includes(".")) return item?.[key];
  return key.split(".").reduce((current, part) => current?.[part], item);
}

function extractGradeLetter(item, keys) {
  for (const k of keys) {
    const raw = String(getValueByPath(item, k) || "").trim();
    if (!raw) continue;
    const m = raw.match(/^[ABCD]/i);
    if (m) return m[0].toUpperCase();
  }
  return "";
}

/**
 * Clean journal/source name by removing common RSS/feed noise.
 * Delegates to shared journal_name_cleaner module.
 */
function cleanJournalSource(item) {
  // Try each candidate independently: if a field is present but cleans to
  // noise (e.g. "Latest Results", "Example Topic Current Issue"), fall through to
  // the next candidate instead of stopping at the first truthy value.
  const candidates = [
    item?.journal,
    item?.publicationTitle,
    item?.["container-title"],
    item?.source,
    item?.source_title,
    item?.source_platform,
  ];
  for (const c of candidates) {
    const cleaned = cleanJournalName(String(c || "").trim());
    if (cleaned) return cleaned;
  }
  return "";
}

function isHumanReviewItem(item) {
  return Boolean(
    item?.needs_human_review
      || item?.needsHumanReview
      || item?.review_required
      || item?.reviewRequired
      || item?.semantic_review?.needs_human_review
      || item?.semantic_review?.review_required
      || item?.semantic_mismatch
      || item?.semantic_rescue
  );
}

function toDailyRows(triaged) {
  const banned = new Set(["D", "D无关"]);
  return triaged
    .filter((it) => {
      const finalGrade = extractGradeLetter(it, ["final_grade", "finalGrade", "adjusted_grade", "grade"]) ||
        extractGradeLetter(it, ["rule_grade", "ruleGrade", "original_grade", "initial_grade"]);
      const label = String(it?.["推荐等级"] || "");
      return !banned.has(finalGrade) && !banned.has(label) && !banned.has(String(it?.grade || "")) && !isHumanReviewItem(it);
    })
    .map((it) => {
      const translated = it?.translatedTitle || it?.["标题翻译"] || it?.["中文标题"] || it?.shortTitle || it?.title || "";
      const ruleGrade = extractGradeLetter(it, ["rule_grade", "ruleGrade", "original_grade", "initial_grade", "grade"]);
      const semanticGrade = extractGradeLetter(it, ["llm_review_grade", "llmReviewGrade", "semantic_grade", "semanticGrade", "semantic_review.grade", "semanticPreference.grade"]);
      const finalGrade = extractGradeLetter(it, ["final_grade", "finalGrade", "adjusted_grade", "grade"]);
      const source = cleanJournalSource(it);
      return [
        it?.title || "",
        translated,
        ruleGrade,
        semanticGrade,
        finalGrade,
        source,
        "",
        "",
      ];
    });
}

/**
 * Grade ordering: A > B > C > D
 */
const GRADE_ORDER = { A: 0, B: 1, C: 2, D: 3 };

/**
 * Build rows for the "需人工复核" sheet from triaged items.
 * Only includes items explicitly flagged with needs_human_review (e.g. C→D auto-blocked).
 * Auto-adopted adjustments (B→A, C→B, B→C) are visible in 每日反馈 but do NOT enter this sheet.
 */
function toHumanReviewRows(triaged) {
  const rows = [];
  for (const it of triaged) {
    const ruleGrade = extractGradeLetter(it, ["rule_grade", "ruleGrade", "original_grade", "initial_grade", "grade"]);
    const semanticGrade = extractGradeLetter(it, ["llm_review_grade", "llmReviewGrade", "semantic_grade", "semanticGrade", "semantic_review.grade", "semanticPreference.grade"]);
    const finalGrade = extractGradeLetter(it, ["final_grade", "finalGrade", "adjusted_grade", "grade"]);
    if (!isHumanReviewItem(it)) continue;

    // Divergence type (for display only)
    const gradesDiffer = ruleGrade && semanticGrade && ruleGrade !== semanticGrade;

    // Determine divergence type
    let divergenceType = "";
    if (gradesDiffer) {
      const ro = GRADE_ORDER[ruleGrade] ?? 99;
      const so = GRADE_ORDER[semanticGrade] ?? 99;
      divergenceType = so < ro ? "语义上调" : so > ro ? "语义降权提醒" : "";
    }

    // Semantic reason
    const semanticReason = String(
      it?.semantic_reason || it?.semanticReason ||
      it?.semantic_review?.reason || it?.semantic_adjustment_reason || ""
    ).trim();

    const translated = it?.translatedTitle || it?.["标题翻译"] || it?.["中文标题"] || it?.shortTitle || it?.title || "";
    const source = cleanJournalSource(it);
    const pubDate = it?.date || it?.publicationDate || it?.publication_date || "-";

    rows.push([
      it?.title || "",
      translated,
      source,
      pubDate,
      ruleGrade,
      semanticGrade,
      finalGrade,
      "是",
      divergenceType,
      semanticReason,
      "", // 人工确认等级 — left empty for user
    ]);
  }
  return rows;
}

function writeHeader(sheet, range, headers) {
  sheet.getRange(range).values = [headers];
  sheet.getRange(range).format = {
    fill: "#1F4E78",
    font: { bold: true, color: "#FFFFFF" },
  };
}

export function buildStandardSummarySheetRows(preferenceAudit = {}, generatedAt = "") {
  const explicitRows = Array.isArray(preferenceAudit?.sheets?.standard_summary) ? preferenceAudit.sheets.standard_summary : [];
  const currentSummary = preferenceAudit?.current_standard_summary || null;
  const fallbackClusters = preferenceAudit?.clusters || preferenceAudit?.store?.clusters || [];
  const fallbackChanges = preferenceAudit?.cluster_changes || preferenceAudit?.sheets?.changes || [];
  const usingFallback = explicitRows.length === 0;
  const unavailable = !currentSummary && fallbackClusters.length === 0;
  const summary = currentSummary || buildStandardSummary(fallbackClusters, fallbackChanges);
  const fallbackText = buildCompactStandardSummaryText(summary, { unavailable });
  const fallbackRow = {
    "当前筛选标准": fallbackText,
    "我的评价": "",
  };
  const rows = explicitRows.length
    ? explicitRows.map((row) => ({
      "当前筛选标准": row?.["当前筛选标准"] || row?.standard_summary_text || buildCompactStandardSummaryText({
        one_sentence_summary: row?.one_sentence_summary || fallbackText,
        priority_summary: row?.current_priority_summary || row?.priority_summary || "",
        downrank_summary: row?.current_downrank_summary || row?.downrank_summary || "",
        uncertain_boundaries: row?.uncertain_boundaries || "",
        caveats: row?.caveats || "",
      }, { unavailable }),
      "我的评价": "",
    }))
    : [fallbackRow];
  return {
    rows,
    metadata: {
      standard_summary_generated: Boolean(currentSummary || fallbackClusters.length || explicitRows.length),
      standard_summary_generated_from_fallback: usingFallback,
      standard_summary_unavailable: unavailable,
      standard_summary_sheet_schema: STANDARD_SUMMARY_SHEET_SCHEMA,
      standard_summary_user_feedback_columns_present: false,
      standard_summary_sheet_name: PREFERENCE_AUDIT_SHEET_NAMES[4],
    },
  };
}

function buildCompactStandardSummaryText(summary = {}, { unavailable = false } = {}) {
  const lines = [];
  const oneSentence = String(summary?.one_sentence_summary || "").trim();
  const priority = String(summary?.priority_summary || summary?.current_priority_summary || "").trim();
  const downrank = String(summary?.downrank_summary || summary?.current_downrank_summary || "").trim();
  const uncertain = String(summary?.uncertain_boundaries || "").trim();
  const caveats = String(summary?.caveats || "").trim();
  if (unavailable || !oneSentence) {
    lines.push("当前稳定筛选标准仍有限，以下为基于现有反馈的暂定理解：");
  } else {
    lines.push(oneSentence);
  }
  if (priority) lines.push(`优先关注：${priority}`);
  if (downrank) lines.push(`相对降权：${downrank}`);
  if (uncertain) lines.push(`不确定边界：${uncertain}`);
  if (caveats) lines.push(`注意：${caveats}`);
  return lines.join("\n");
}

export async function exportAllResearchOsXlsxWithCodexSpreadsheet({
  sourcePath,
  reviewRootDir,
  reviewWeekDir,
  reviewDayDir,
  dateStr,
  weekLabel,
  dayLabel,
}) {
  const { Workbook } = await import("@oai/artifact-tool");
  const payload = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  const triaged = Array.isArray(payload?.triaged) ? payload.triaged : [];
  const ctx = payload?.reportContext || {};
  const preferenceAudit = ctx?.preferenceLearningAudit || {};

  const dailyRows = toDailyRows(triaged);
  const exportPaths = {
    every_other_day_report: path.join(reviewDayDir, "周报.xlsx"),
  };

  const { wb: daily, ws: dailySheet } = createWorkbookWithSheet(Workbook, "每日反馈");
  const allDaily = [DAILY_REVIEW_HEADERS, ...dailyRows];
  const colCount = DAILY_REVIEW_HEADERS.length;
  const lastCol = String.fromCharCode(64 + colCount);
  dailySheet.getRange(`A1:${lastCol}${allDaily.length}`).values = allDaily;
  writeHeader(dailySheet, "A1:" + lastCol + "1", DAILY_REVIEW_HEADERS);
  dailySheet.freezePanes.freezeRows(1);
  const maxRow = Math.max(allDaily.length, 2);
  // C=规则等级, D=语义等级, E=最终等级 → A/B/C/D dropdown
  dailySheet.getRange(`C2:C${maxRow}`).dataValidation = { rule: { type: "list", values: ["A", "B", "C", "D"] } };
  dailySheet.getRange(`D2:D${maxRow}`).dataValidation = { rule: { type: "list", values: ["A", "B", "C", "D"] } };
  dailySheet.getRange(`E2:E${maxRow}`).dataValidation = { rule: { type: "list", values: ["A", "B", "C", "D"] } };
  // G=反馈 → keep/drop/upgrade/downgrade
  dailySheet.getRange(`G2:G${maxRow}`).dataValidation = { rule: { type: "list", values: ["keep", "drop", "upgrade", "downgrade"] } };

  // Add "需人工复核" sheet
  const reviewRows = toHumanReviewRows(triaged);
  const reviewSheet = daily.worksheets.add("需人工复核");
  const reviewColCount = HUMAN_REVIEW_HEADERS.length;
  const reviewLastCol = String.fromCharCode(64 + reviewColCount);
  const allReview = [HUMAN_REVIEW_HEADERS, ...reviewRows];
  reviewSheet.getRange(`A1:${reviewLastCol}${allReview.length}`).values = allReview;
  writeHeader(reviewSheet, "A1:" + reviewLastCol + "1", HUMAN_REVIEW_HEADERS);
  reviewSheet.freezePanes.freezeRows(1);
  // K=人工确认等级 → A/B/C/D dropdown (only if there are rows)
  if (reviewRows.length > 0) {
    const reviewMaxRow = Math.max(allReview.length, 2);
    reviewSheet.getRange(`K2:K${reviewMaxRow}`).dataValidation = { rule: { type: "list", values: ["A", "B", "C", "D"] } };
  }

  await saveWorkbook(daily, exportPaths.every_other_day_report);

  return {
    headers: DAILY_REVIEW_HEADERS,
    rows_count: dailyRows.length,
    excluded_d_count: triaged.length - dailyRows.length,
    human_review_rows_count: reviewRows.length,
    total_export_rows_count: dailyRows.length + reviewRows.length,
    daily_workbook_sheets: ["每日反馈", "需人工复核"],
    preference_learning_sheets: ["每日反馈"],
    standard_summary_sheet_exported: false,
    standard_summary_sheet_name: "",
    standard_summary_sheet_schema: "",
    standard_summary_generated: Boolean(preferenceAudit?.current_standard_summary),
    standard_summary_generated_from_fallback: false,
    standard_summary_unavailable: false,
    standard_summary_user_feedback_columns_present: false,
    standard_summary_headers: [],
    outputs: exportPaths,
  };
}

/**
 * Detect whether exceljs is available for node_fallback export.
 * Uses dynamic import to avoid hard dependency.
 */
export async function detectNodeFallbackAvailability() {
  try {
    await import("exceljs");
    return { available: true, reason: null };
  } catch (err) {
    return { available: false, reason: String(err?.message || err) };
  }
}

/**
 * Export xlsx using exceljs (node_fallback).
 * Replicates the same sheet structure and data validation as the Codex spreadsheet capability path.
 */
export async function exportAllResearchOsXlsxWithNodeFallback({
  sourcePath,
  reviewRootDir,
  reviewWeekDir,
  reviewDayDir,
  dateStr,
  weekLabel,
  dayLabel,
}) {
  const ExcelJS = await import("exceljs");
  const Workbook = ExcelJS.default?.Workbook || ExcelJS.Workbook;
  const wb = new Workbook();

  const payload = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  const triaged = Array.isArray(payload?.triaged) ? payload.triaged : [];
  const ctx = payload?.reportContext || {};
  const preferenceAudit = ctx?.preferenceLearningAudit || {};

  const dailyRows = toDailyRows(triaged);
  const exportPaths = {
    every_other_day_report: path.join(reviewDayDir, "周报.xlsx"),
  };

  // --- Sheet 1: 每日反馈 ---
  const dailySheet = wb.addWorksheet("每日反馈");
  dailySheet.addRow(DAILY_REVIEW_HEADERS);
  for (const row of dailyRows) dailySheet.addRow(row);

  // Header styling: dark blue background, white bold text
  const colCount = DAILY_REVIEW_HEADERS.length;
  for (let c = 1; c <= colCount; c++) {
    const cell = dailySheet.getCell(1, c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  }
  dailySheet.views = [{ state: "frozen", ySplit: 1 }];

  // Data validation: C/D/E = grade A/B/C/D, G = feedback keep/drop/upgrade/downgrade
  const maxRow = Math.max(dailyRows.length + 1, 2);
  for (let r = 2; r <= maxRow; r++) {
    dailySheet.getCell(r, 3).dataValidation = { type: "list", formulae: ['"A,B,C,D"'], showErrorMessage: true };
    dailySheet.getCell(r, 4).dataValidation = { type: "list", formulae: ['"A,B,C,D"'], showErrorMessage: true };
    dailySheet.getCell(r, 5).dataValidation = { type: "list", formulae: ['"A,B,C,D"'], showErrorMessage: true };
    dailySheet.getCell(r, 7).dataValidation = { type: "list", formulae: ['"keep,drop,upgrade,downgrade"'], showErrorMessage: true };
  }

  // --- Sheet 2: 需人工复核 ---
  const reviewRows = toHumanReviewRows(triaged);
  const reviewSheet = wb.addWorksheet("需人工复核");
  reviewSheet.addRow(HUMAN_REVIEW_HEADERS);
  for (const row of reviewRows) reviewSheet.addRow(row);

  // Header styling
  const reviewColCount = HUMAN_REVIEW_HEADERS.length;
  for (let c = 1; c <= reviewColCount; c++) {
    const cell = reviewSheet.getCell(1, c);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  }
  reviewSheet.views = [{ state: "frozen", ySplit: 1 }];

  // K column = 人工确认等级 dropdown
  if (reviewRows.length > 0) {
    const reviewMaxRow = Math.max(reviewRows.length + 1, 2);
    for (let r = 2; r <= reviewMaxRow; r++) {
      reviewSheet.getCell(r, 11).dataValidation = { type: "list", formulae: ['"A,B,C,D"'], showErrorMessage: true };
    }
  }

  // Save
  await fs.mkdir(path.dirname(exportPaths.every_other_day_report), { recursive: true });
  await wb.xlsx.writeFile(exportPaths.every_other_day_report);

  return {
    headers: DAILY_REVIEW_HEADERS,
    rows_count: dailyRows.length,
    excluded_d_count: triaged.length - dailyRows.length,
    human_review_rows_count: reviewRows.length,
    total_export_rows_count: dailyRows.length + reviewRows.length,
    daily_workbook_sheets: ["每日反馈", "需人工复核"],
    preference_learning_sheets: ["每日反馈"],
    standard_summary_sheet_exported: false,
    standard_summary_sheet_name: "",
    standard_summary_sheet_schema: "",
    standard_summary_generated: Boolean(preferenceAudit?.current_standard_summary),
    standard_summary_generated_from_fallback: false,
    standard_summary_unavailable: false,
    standard_summary_user_feedback_columns_present: false,
    standard_summary_headers: [],
    outputs: exportPaths,
  };
}
