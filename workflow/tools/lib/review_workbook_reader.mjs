import fs from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { dayLabel, monthLabel } from "./report_period_support.mjs";

const FEEDBACK_ALIASES = ["feedback", "Feedback", "反馈", "用户反馈"];
const COMMENT_ALIASES = ["comment", "Comment", "备注", "评价备注"];
const ENGLISH_TITLE_ALIASES = ["英文标题", "title", "Title", "English Title"];
const TRANSLATION_ALIASES = ["标题翻译", "translated_title", "title_translation"];
const CHINESE_TITLE_ALIASES = ["中文标题"];
const STANDARD_SUMMARY_SHEET = "当前筛选标准摘要";
const SUMMARY_TEXT_ALIASES = ["当前筛选标准", "standard_summary_text"];
const SUMMARY_EVALUATION_ALIASES = ["我的评价", "user_evaluation_text"];
const SUMMARY_FEEDBACK_ALIASES = ["user_feedback_on_summary", "标准摘要反馈", "筛选标准反馈"];
const SUMMARY_COMMENT_ALIASES = ["user_comment_on_summary", "标准摘要备注", "筛选标准备注"];
const SUMMARY_CORRECTION_ALIASES = ["user_correction_hint", "修正提示", "修正方向"];
const SUMMARY_FIELD_ALIASES = {
  one_sentence_summary: ["one_sentence_summary"],
  current_priority_summary: ["current_priority_summary"],
  current_downrank_summary: ["current_downrank_summary"],
  uncertain_boundaries: ["uncertain_boundaries"],
  caveats: ["caveats"],
};

const SUMMARY_FEEDBACK_NORMALIZATION = new Map([
  ["accurate", "accurate"],
  ["准确", "accurate"],
  ["too_broad", "too_broad"],
  ["太宽泛", "too_broad"],
  ["too_narrow", "too_narrow"],
  ["太窄", "too_narrow"],
  ["wrong_focus", "wrong_focus"],
  ["重点错了", "wrong_focus"],
  ["missing_priority", "missing_priority"],
  ["缺少重点", "missing_priority"],
  ["over_excluding", "over_excluding"],
  ["过度排除", "over_excluding"],
  ["under_excluding", "under_excluding"],
  ["排除不足", "under_excluding"],
  ["needs_more_clinical_focus", "needs_more_clinical_focus"],
  ["需要更偏临床", "needs_more_clinical_focus"],
  ["other", "other"],
  ["其他", "other"],
]);

function weekNumber(d) { const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const dayNum = date.getUTCDay() || 7; date.setUTCDate(date.getUTCDate() + 4 - dayNum); const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1)); return Math.ceil((((date - yearStart) / 86400000) + 1) / 7); }
function isoWeek(d) { const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const dayNum = date.getUTCDay() || 7; date.setUTCDate(date.getUTCDate() + 4 - dayNum); const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1)); const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7); return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`; }
function yyMd(d) { return `${String(d.getFullYear()).slice(2)}.${d.getMonth() + 1}.${d.getDate()}`; }
function desktopWeekLabel(d) { return `${String(d.getFullYear()).slice(2)} Week${weekNumber(d)}`; }
function fmtDateRfc(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function normalizeFeedback(v) { return String(v || "").trim().toLowerCase(); }
function escapeXml(s) { return String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'"); }
function cleanHeader(s) { return String(s || "").replace(/^\uFEFF/, "").replace(/\s+/g, " ").trim(); }
function normalizeAlias(s) { return cleanHeader(s).toLowerCase(); }

function colRefToIndex(ref = "") {
  const letters = String(ref).match(/[A-Z]+/i)?.[0] || "";
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSharedStrings(sharedXml) {
  return Array.from(String(sharedXml || "").matchAll(/<[^:<>\s]*:?si[^>]*>([\s\S]*?)<\/[^:<>\s]*:?si>/g)).map((si) => {
    return Array.from(String(si[1] || "").matchAll(/<[^:<>\s]*:?t[^>]*>([\s\S]*?)<\/[^:<>\s]*:?t>/g)).map((m) => escapeXml(m[1])).join("");
  });
}

function parseZipEntries(buffer) {
  const entries = new Map();
  let pos = 0;
  while (pos + 30 <= buffer.length) {
    if (buffer.readUInt32LE(pos) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(pos + 8);
    const compSize = buffer.readUInt32LE(pos + 18);
    const nameLen = buffer.readUInt16LE(pos + 26);
    const extraLen = buffer.readUInt16LE(pos + 28);
    const name = buffer.slice(pos + 30, pos + 30 + nameLen).toString("utf8");
    const dataStart = pos + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compSize;
    const comp = buffer.slice(dataStart, dataEnd);
    const data = method === 0 ? comp : method === 8 ? inflateRawSync(comp) : Buffer.alloc(0);
    entries.set(name, data.toString("utf8"));
    pos = dataEnd;
  }
  return entries;
}

function parseRelationshipTargets(relsXml) {
  const relMap = new Map();
  for (const match of String(relsXml || "").matchAll(/<Relationship([^>]*)\/?>/g)) {
    const attrs = match[1] || "";
    const id = (attrs.match(/\bId="([^"]+)"/) || [])[1] || "";
    const target = (attrs.match(/\bTarget="([^"]+)"/) || [])[1] || "";
    if (id && target) relMap.set(id, target.replace(/^\//, ""));
  }
  return relMap;
}

export function buildCandidateFeedbackFiles(now, { reviewRoot, desktopRoot, projectRoot, researchRoot, lookbackDays = 7 }) {
  const filesByDay = [];
  for (let d = 1; d <= lookbackDays; d++) {
    const prev = new Date(now);
    prev.setDate(prev.getDate() - d);
    const day = yyMd(prev);
    const week = isoWeek(prev);
    const month = monthLabel(prev);
    const monthDay = dayLabel(prev);
    const legacyProjectRoot = projectRoot || path.dirname(researchRoot || "");
    const workbookNames = ["周报.xlsx", "隔日报.xlsx", "daily_review.xlsx"];
    const dayDirs = [
      path.join(reviewRoot, month, monthDay),
      path.join(desktopRoot, month, monthDay),
      path.join(legacyProjectRoot, "文献评价", month, monthDay),
      path.join(reviewRoot, desktopWeekLabel(prev), day),
      path.join(desktopRoot, desktopWeekLabel(prev), day),
      path.join(legacyProjectRoot, "文献评价", desktopWeekLabel(prev), day),
      path.join(researchRoot, week, day),
    ];
    const dayFiles = dayDirs.flatMap((dir) => workbookNames.map((name) => path.join(dir, name)));
    filesByDay.push({ date: fmtDateRfc(prev), day, paths: dayFiles });
  }
  return filesByDay;
}

function sourceForPath(p, { reviewRoot, desktopRoot, projectRoot, researchRoot }) {
  if (!p) return "";
  if (p.startsWith(reviewRoot)) return "review_results_review_root";
  if (p.startsWith(desktopRoot)) return "desktop_legacy_fallback";
  if (p.startsWith(path.join(projectRoot, "文献评价"))) return "project_root_legacy_fallback";
  if (p.startsWith(researchRoot)) return "review_results_pipeline_legacy_fallback";
  return "unknown";
}

export function readXlsxSheets(filePath) {
  const entries = parseZipEntries(fs.readFileSync(filePath));
  const workbook = entries.get("xl/workbook.xml");
  if (!workbook) throw new Error("workbook_xml_missing");
  const rels = entries.get("xl/_rels/workbook.xml.rels") || "";
  const shared = parseSharedStrings(entries.get("xl/sharedStrings.xml") || "");
  const sheetDefs = Array.from(workbook.matchAll(/<[^:<>\s]*:?sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g)).map((m) => ({ name: m[1], rid: m[2] }));
  const relMap = new Map(Array.from(parseRelationshipTargets(rels).entries()).map(([id, target]) => [id, target.startsWith("xl/") ? target : `xl/${target}`]));
  const sheets = new Map();
  for (const sheet of sheetDefs) {
    const target = relMap.get(sheet.rid);
    if (!target) continue;
    const xml = entries.get(target);
    if (!xml) continue;
    const rows = [];
    for (const rowMatch of xml.matchAll(/<[^:<>\s]*:?row[^>]*>([\s\S]*?)<\/[^:<>\s]*:?row>/g)) {
      const rowXml = rowMatch[1];
      const cells = [];
      for (const c of rowXml.matchAll(/<[^:<>\s]*:?c([^>]*)>([\s\S]*?)<\/[^:<>\s]*:?c>|<[^:<>\s]*:?c([^>]*)\/>/g)) {
        const attrs = c[1] || c[3] || "";
        const inner = c[2] || "";
        const ref = (attrs.match(/\br="([^"]+)"/) || [])[1] || "";
        const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || "";
        const colIdx = colRefToIndex(ref);
        const v = (inner.match(/<[^:<>\s]*:?v[^>]*>([\s\S]*?)<\/[^:<>\s]*:?v>/) || [])[1] || "";
        let value = "";
        if (t === "s") value = shared[Number(v) || 0] || "";
        else if (t === "inlineStr") value = Array.from(inner.matchAll(/<[^:<>\s]*:?t[^>]*>([\s\S]*?)<\/[^:<>\s]*:?t>/g)).map((m) => escapeXml(m[1])).join("");
        else if (t === "str") value = escapeXml(v || (inner.match(/<[^:<>\s]*:?t[^>]*>([\s\S]*?)<\/[^:<>\s]*:?t>/) || [])[1] || "");
        else if (t === "b") value = v === "1" ? "true" : "false";
        else value = escapeXml(v || (inner.match(/<[^:<>\s]*:?t[^>]*>([\s\S]*?)<\/[^:<>\s]*:?t>/) || [])[1] || "");
        if (colIdx >= 0) cells[colIdx] = value;
      }
      rows.push(cells.map((x) => (x == null ? "" : x)));
    }
    sheets.set(sheet.name, rows);
  }
  return sheets;
}

export function inspectXlsxWorkbook(filePath) {
  const entries = parseZipEntries(fs.readFileSync(filePath));
  const sheets = readXlsxSheets(filePath);
  const formula_errors = [];
  for (const [entryName, xml] of entries.entries()) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(entryName)) continue;
    for (const cell of String(xml || "").matchAll(/<[^:<>\s]*:?c([^>]*)>([\s\S]*?)<\/[^:<>\s]*:?c>/g)) {
      const attrs = cell[1] || "";
      const inner = cell[2] || "";
      const ref = (attrs.match(/\br="([^"]+)"/) || [])[1] || "";
      const error = (inner.match(/<[^:<>\s]*:?v[^>]*>([\s\S]*?)<\/[^:<>\s]*:?v>/) || [])[1] || "formula_error";
      const hasFormula = /<[^:<>\s]*:?f(?:\s[^>]*)?>/.test(inner);
      const cachedFormulaError = hasFormula && /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA)$/i.test(escapeXml(error));
      if (!/\bt="e"/.test(attrs) && !cachedFormulaError) continue;
      formula_errors.push({ entry: entryName, cell: ref, error: escapeXml(error) });
    }
  }
  return { sheets, formula_errors };
}

function numericOnly(arr) {
  return arr.length > 0 && arr.every((x) => /^\d+$/.test(cleanHeader(x)));
}

function findBestHeaderRow(rows, aliases = []) {
  const normalizedAliases = aliases.map(normalizeAlias);
  let headerRowIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const candidate = (rows[i] || []).map(cleanHeader).filter(Boolean);
    const lower = candidate.map((x) => x.toLowerCase());
    const hits = normalizedAliases.filter((entry) => lower.includes(entry)).length;
    const score = hits * 5 + candidate.length * 0.01;
    if (score > bestScore) {
      bestScore = score;
      headerRowIdx = i;
    }
  }
  return headerRowIdx;
}

function resolveHeader(headerMap, aliases = []) {
  return aliases.find((alias) => headerMap.has(normalizeAlias(alias))) || "";
}

function parseFeedbackRows(rows, selectedFile) {
  const headerRowIdx = findBestHeaderRow(rows, [...FEEDBACK_ALIASES, ...COMMENT_ALIASES, ...ENGLISH_TITLE_ALIASES, ...TRANSLATION_ALIASES, ...CHINESE_TITLE_ALIASES]);
  const headers = (rows[headerRowIdx] || []).map(cleanHeader);
  const headerMap = new Map(headers.map((h, i) => [normalizeAlias(h), i]).filter(([h]) => h));
  const feedbackHeader = resolveHeader(headerMap, FEEDBACK_ALIASES);
  const commentHeader = resolveHeader(headerMap, COMMENT_ALIASES);
  const englishHeader = resolveHeader(headerMap, ENGLISH_TITLE_ALIASES);
  const transHeader = resolveHeader(headerMap, TRANSLATION_ALIASES);
  const chineseHeader = resolveHeader(headerMap, CHINESE_TITLE_ALIASES);
  const titleHeader = transHeader || chineseHeader || englishHeader;
  const columns = {
    feedback: Boolean(feedbackHeader),
    comment: Boolean(commentHeader),
    english_title: Boolean(englishHeader),
    title_translation: Boolean(transHeader),
    chinese_title: Boolean(chineseHeader),
  };
  const counts = { rows_total: Math.max(rows.length - (headerRowIdx + 1), 0), rows_with_feedback: 0, rows_with_comment: 0, keep: 0, upgrade: 0, drop: 0, downgrade: 0, unknown_feedback: 0, empty_feedback: 0 };
  const outRows = [];
  const learningSignals = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const at = (h) => (h ? cleanHeader(row[headerMap.get(normalizeAlias(h))] || "") : "");
    const feedback = normalizeFeedback(at(feedbackHeader));
    const comment = at(commentHeader);
    const englishTitle = at(englishHeader);
    const titleTranslation = transHeader ? at(transHeader) : (chineseHeader ? at(chineseHeader) : "");
    const titleContext = (titleTranslation || at(chineseHeader) || englishTitle).trim();
    if (comment) counts.rows_with_comment += 1;
    if (!feedback) {
      counts.empty_feedback += 1;
      continue;
    }
    counts.rows_with_feedback += 1;
    if (feedback === "keep") counts.keep += 1;
    else if (feedback === "upgrade") counts.upgrade += 1;
    else if (feedback === "drop") counts.drop += 1;
    else if (feedback === "downgrade") counts.downgrade += 1;
    else counts.unknown_feedback += 1;
    learningSignals.push({
      row: i + 1,
      feedback,
      comment,
      english_title: englishTitle,
      title_translation: titleTranslation,
      title_context: titleContext,
      title_translation_missing: !titleTranslation,
      comment_empty: !comment,
      ambiguous_reason: (!["keep", "upgrade", "drop", "downgrade"].includes(feedback) ? "unknown_feedback_value" : ""),
    });
    outRows.push({ feedback, comment, english_title: englishTitle, title_translation: titleTranslation, title_context: titleContext, row: i + 1, source_file: selectedFile });
  }
  const validHeaders = headers.filter(Boolean);
  return {
    headers: validHeaders,
    columns,
    rows: outRows,
    counts,
    learningSignals,
    missing_columns: [columns.feedback ? null : "feedback"].filter(Boolean),
    titleHeader: Boolean(titleHeader),
    headerRowIdx,
    hasValidHeaderSignals: validHeaders.length > 0 && !numericOnly(validHeaders),
  };
}

function inferAffectedSummarySection(feedback) {
  if (["accurate", "missing_priority", "needs_more_clinical_focus", "wrong_focus", "too_narrow"].includes(feedback)) return "current_priority_summary";
  if (["over_excluding", "under_excluding"].includes(feedback)) return "current_downrank_summary";
  if (feedback === "too_broad") return "caveats";
  return "one_sentence_summary";
}

function inferSummaryFeedbackIntent(text = "") {
  const raw = cleanHeader(text);
  const lower = raw.toLowerCase();
  const exact = SUMMARY_FEEDBACK_NORMALIZATION.get(raw) || SUMMARY_FEEDBACK_NORMALIZATION.get(lower);
  if (exact) return exact;
  if (/太宽泛|过于宽泛|范围太大|too\s*broad/.test(raw)) return "too_broad";
  if (/太窄|漏掉了|范围太小|too\s*narrow/.test(raw)) return "too_narrow";
  if (/重点不对|关注错了|重点错了|wrong\s*focus/.test(raw)) return "wrong_focus";
  if (/缺少重点|应该更关注|missing\s*priority/.test(raw)) return "missing_priority";
  if (/过度排除|不要一概排除|不[要能]一概排除|over[-_\s]*excluding/.test(raw)) return "over_excluding";
  if (/排除不足|应该排除更多|under[-_\s]*excluding/.test(raw)) return "under_excluding";
  if (/更偏临床|更关注临床结局|临床结局|needs_more_clinical_focus/.test(raw)) return "needs_more_clinical_focus";
  if (/可以|准确|基本正确|没问题|accurate/.test(raw)) return "accurate";
  return raw ? "other" : "";
}

export function parseStandardSummaryFeedbackRows(rows, selectedFile) {
  const aliases = [
    ...SUMMARY_TEXT_ALIASES,
    ...SUMMARY_EVALUATION_ALIASES,
    ...SUMMARY_FEEDBACK_ALIASES,
    ...SUMMARY_COMMENT_ALIASES,
    ...SUMMARY_CORRECTION_ALIASES,
    ...Object.values(SUMMARY_FIELD_ALIASES).flat(),
  ];
  const headerRowIdx = findBestHeaderRow(rows, aliases);
  const headers = (rows[headerRowIdx] || []).map(cleanHeader);
  const headerMap = new Map(headers.map((h, i) => [normalizeAlias(h), i]).filter(([h]) => h));
  const summaryTextHeader = resolveHeader(headerMap, SUMMARY_TEXT_ALIASES);
  const evaluationHeader = resolveHeader(headerMap, SUMMARY_EVALUATION_ALIASES);
  const feedbackHeader = resolveHeader(headerMap, SUMMARY_FEEDBACK_ALIASES);
  const commentHeader = resolveHeader(headerMap, SUMMARY_COMMENT_ALIASES);
  const correctionHeader = resolveHeader(headerMap, SUMMARY_CORRECTION_ALIASES);
  const summaryFieldHeaders = Object.fromEntries(Object.entries(SUMMARY_FIELD_ALIASES).map(([key, value]) => [key, resolveHeader(headerMap, value)]));
  const schema = summaryTextHeader && evaluationHeader ? "zh_two_column" : "legacy_enriched";
  const outRows = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const at = (h) => (h ? cleanHeader(row[headerMap.get(normalizeAlias(h))] || "") : "");
    const standardSummaryText = at(summaryTextHeader) || [
      at(summaryFieldHeaders.one_sentence_summary),
      at(summaryFieldHeaders.current_priority_summary),
      at(summaryFieldHeaders.current_downrank_summary),
      at(summaryFieldHeaders.uncertain_boundaries),
      at(summaryFieldHeaders.caveats),
    ].filter(Boolean).join("\n");
    const userEvaluationText = at(evaluationHeader);
    const rawFeedback = at(feedbackHeader);
    const userComment = userEvaluationText || at(commentHeader);
    const correctionHint = at(correctionHeader);
    const userFeedback = inferSummaryFeedbackIntent(rawFeedback || userEvaluationText || userComment || correctionHint);
    if (!userFeedback && !userComment && !correctionHint) continue;
    outRows.push({
      source_file: selectedFile,
      source_sheet: STANDARD_SUMMARY_SHEET,
      source_row: i + 1,
      source_section: inferAffectedSummarySection(userFeedback),
      standard_summary_text: standardSummaryText,
      user_evaluation_text: userEvaluationText || userComment || correctionHint,
      inferred_issue_type: userFeedback || "other",
      one_sentence_summary: at(summaryFieldHeaders.one_sentence_summary),
      current_priority_summary: at(summaryFieldHeaders.current_priority_summary),
      current_downrank_summary: at(summaryFieldHeaders.current_downrank_summary),
      uncertain_boundaries: at(summaryFieldHeaders.uncertain_boundaries),
      caveats: at(summaryFieldHeaders.caveats),
      user_feedback_on_summary: userFeedback,
      user_comment_on_summary: userComment,
      user_correction_hint: correctionHint,
    });
  }
  return {
    sheet_present: true,
    sheet_name: STANDARD_SUMMARY_SHEET,
    schema,
    headers: headers.filter(Boolean),
    rows: outRows,
    feedback_rows: outRows.length,
    feedback_header_detected: Boolean(feedbackHeader || evaluationHeader),
    comment_header_detected: Boolean(commentHeader),
    correction_header_detected: Boolean(correctionHeader),
  };
}

export function readPreviousFeedbackWorkbook(now, opts = {}) {
  const lookbackDays = Number(opts.lookbackDays || 7);
  const filesByDay = buildCandidateFeedbackFiles(now, { ...opts, lookbackDays });
  const allPaths = filesByDay.flatMap((d) => d.paths);
  const checkedFiles = [];
  const result = {
    ok: false,
    selected_previous_feedback_file: null,
    selected_feedback_file_source: "",
    selected_feedback_date: "",
    lookup_paths: allPaths,
    checked_files: checkedFiles,
    workbook_read_method: "node_xlsx",
    python_read_attempted: false,
    python_read_failed: false,
    workbook_unreadable: false,
    sheet_name: null,
    detected_headers: [],
    columns: { feedback: false, comment: false, english_title: false, title_translation: false, chinese_title: false },
    missing_columns: [],
    rows: [],
    counts: { rows_total: 0, rows_with_feedback: 0, rows_with_comment: 0, keep: 0, upgrade: 0, drop: 0, downgrade: 0, unknown_feedback: 0, empty_feedback: 0 },
    blockers: [],
    warnings: [],
    learning_signals: [],
    summary_feedback: {
      sheet_present: false,
      sheet_name: STANDARD_SUMMARY_SHEET,
      schema: "",
      headers: [],
      rows: [],
      feedback_rows: 0,
      warnings: [],
    },
  };

  let firstExistingPath = null;
  let firstExistingDate = "";

  for (const dayEntry of filesByDay) {
    for (const p of dayEntry.paths) {
      if (!fs.existsSync(p)) continue;
      checkedFiles.push({ path: p, date: dayEntry.date, day: dayEntry.day, has_feedback: false });
      if (!firstExistingPath) { firstExistingPath = p; firstExistingDate = dayEntry.date; }
      try {
        const workbookSheets = readXlsxSheets(p);
        const reviewSheetName = workbookSheets.has("每日反馈") ? "每日反馈" : (Array.from(workbookSheets.keys())[0] || null);
        const reviewRows = reviewSheetName ? (workbookSheets.get(reviewSheetName) || []) : [];
        const parsed = parseFeedbackRows(reviewRows, p);
        if (parsed.counts.rows_with_feedback > 0) {
          const summaryRows = workbookSheets.get(STANDARD_SUMMARY_SHEET);
          result.ok = true;
          result.selected_previous_feedback_file = p;
          result.selected_feedback_file_source = sourceForPath(p, opts);
          result.selected_feedback_date = dayEntry.date;
          result.sheet_name = reviewSheetName;
          result.detected_headers = parsed.headers;
          result.columns = parsed.columns;
          result.rows = parsed.rows;
          result.counts = parsed.counts;
          result.missing_columns = parsed.missing_columns;
          result.learning_signals = parsed.learningSignals;
          result.summary_feedback = summaryRows ? parseStandardSummaryFeedbackRows(summaryRows, p) : result.summary_feedback;
          checkedFiles[checkedFiles.length - 1].has_feedback = true;
          if (parsed.headers.length === 0) result.blockers.push("headers_empty");
          if (!parsed.hasValidHeaderSignals) result.blockers.push("header_row_not_found");
          if (parsed.hasValidHeaderSignals && !parsed.columns.feedback) result.blockers.push("required_feedback_columns_missing");
          return result;
        }
      } catch (err) {
        result.warnings.push(`day_${dayEntry.date}_file_${path.basename(p)}: ${String(err?.message || err)}`);
      }
    }
  }

  if (firstExistingPath) {
    result.selected_previous_feedback_file = firstExistingPath;
    result.selected_feedback_file_source = sourceForPath(firstExistingPath, opts);
    result.selected_feedback_date = firstExistingDate;
  }
  if (checkedFiles.length === 0) {
    result.blockers.push("previous_feedback_file_not_found");
  } else {
    result.blockers.push("no_supported_feedback_rows");
  }
  return result;
}

export const REVIEW_WORKBOOK_ALIASES = {
  FEEDBACK_ALIASES,
  COMMENT_ALIASES,
  ENGLISH_TITLE_ALIASES,
  TRANSLATION_ALIASES,
  CHINESE_TITLE_ALIASES,
  SUMMARY_FEEDBACK_ALIASES,
  SUMMARY_TEXT_ALIASES,
  SUMMARY_EVALUATION_ALIASES,
  SUMMARY_COMMENT_ALIASES,
  SUMMARY_CORRECTION_ALIASES,
  STANDARD_SUMMARY_SHEET,
};
