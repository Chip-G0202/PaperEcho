import fs from "node:fs";
import path from "node:path";
import {
  buildPubMedQueryFromKeywordGroups,
  loadPubMedKeywordGroupsFromConfig,
} from "../lib/literature_config.mjs";
import {
  buildDocxBuffer,
  escapeXml,
  lineDiff,
  parseZipEntries,
  tableRowsFromXml,
  textFromXml,
} from "../lib/screening_standards_docx_support.mjs";
import {
  SCREENING_STANDARDS_BACKUP_FILE_NAME,
  cleanScreeningStandardsMarkdown,
  readScreeningStandardsFile,
  ruleSuggestionsLogPath,
  screeningStandardsDocxPath,
  screeningStandardsLastSyncedPath,
  screeningStandardsPath,
} from "../lib/screening_standards_paths.mjs";
import { RuleSuggestionService } from "../lib/control_rule_suggestion_service.mjs";
import { suggestionObjectsFromTable, normalizeSuggestionStatus } from "../lib/screening_standards_rewrite_plan.mjs";

async function backupDocx(docxPath) {
  if (!fs.existsSync(docxPath)) return null;
  const dir = path.dirname(docxPath);
  const fixedBackupPath = path.join(dir, SCREENING_STANDARDS_BACKUP_FILE_NAME);
  await fs.promises.copyFile(docxPath, fixedBackupPath);
  return fixedBackupPath;
}

function defaultPubmedConfigPath(reviewRoot) {
  return path.join(path.dirname(path.dirname(reviewRoot)), "config", "pubmed_pmc_search.json");
}

export async function processUserSuggestionDecisions(parsedDocx, { reviewRoot, logPath, pubmedConfigPath, noFormalRuleApply = false } = {}) {
  if (logPath && path.resolve(logPath) !== path.resolve(ruleSuggestionsLogPath(reviewRoot))) throw new Error('SUGGESTION_LOG_OWNER_MISMATCH');
  const service = new RuleSuggestionService({ reviewRoot, pubmedConfigPath: pubmedConfigPath || defaultPubmedConfigPath(reviewRoot), noFormalRuleApply });
  const receipts = [];
  for (const row of suggestionObjectsFromTable(parsedDocx?.suggestions_table)) {
    const status = normalizeSuggestionStatus(row.status).status;
    const decision = { accept: 'accepted', reject: 'rejected', revise: 'revised' }[status];
    if (!decision) continue;
    try {
      receipts.push(await service.decide({ id: row.suggestion_id, decision, revisedRule: row.revised_rule, humanApproval: true }));
    } catch (error) {
      receipts.push({ id: row.suggestion_id, status: 'blocked', code: error.message });
    }
  }
  // Formal mutations have already run through the service. Do not replay them.
  return { decisions: [], receipts, log: await service.readLog() };
}


function standardSummaryToLines(summary = {}) {
  return [
    summary.one_sentence_summary,
    summary.priority_summary ? `优先关注：${summary.priority_summary}` : "",
    summary.downrank_summary ? `相对降权：${summary.downrank_summary}` : "",
    summary.uncertain_boundaries ? `不确定边界：${summary.uncertain_boundaries}` : "",
    summary.caveats ? `注意事项：${summary.caveats}` : "",
  ].map((line) => String(line || "").trim()).filter(Boolean);
}

export function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function keywordRows(keywordGroups = {}) {
  const groups = keywordGroups || {};
  return [
    ["类别", "英文关键词/短语", "说明"],
    ["核心必须词", (groups.required || []).map((group) => (group || []).join("; ")).join(" | "), "组内 OR，组间 AND"],
    ["可选扩展词", (groups.optional || []).join("; "), "用于维护偏好，不进入硬性 PubMed 查询"],
    ["排除词", (groups.negative || []).join("; "), "生成 NOT (...)"],
  ];
}

export function buildDocxParts({ previousText, currentText, keywordGroups, evaluationText, suggestions = [] }) {
  const diffParts = lineDiff(previousText, currentText).filter((part) => String(part.text || "").trim());
  const hasChanges = diffParts.some((p) => p.type === "add" || p.type === "delete") || suggestions.length > 0;
  const formatNotes = hasChanges ? [
    { text: "格式说明 / Format Notes", style: "Heading1" },
    { text: "• 黑色 / Black：已生效且本轮未变化的正式规则 / Active rule unchanged in this run" },
    { text: "• 红色 / Red：本轮新增或修改并已生效的正式规则 / Newly added or revised active rule in this run" },
    { text: "• 蓝色+删除线 / Blue+strikethrough：本轮删除或退休的规则 / Removed or retired rule in this run" },
    { text: "• 待确认建议是否生效只看\"状态\"列，不看颜色 / Rule suggestions are applied only according to the Status column, not by text color" },
    { text: "• Word 下拉不可用时，状态列可手动填写：pending/待定、accept/接受、reject/拒绝、revise/修改 / If Word dropdown is unavailable, manually enter one of the bilingual status values" },
  ] : [];
  const parts = [
    ...formatNotes,
    { text: "偏好规则", style: "Heading1" },
    ...diffParts,
    { text: "检索关键词", style: "Heading1" },
    { kind: "table", rows: keywordRows(keywordGroups) },
    { text: `PubMed query preview: ${buildPubMedQueryFromKeywordGroups(keywordGroups)}` },
    { text: "评价", style: "Heading1" },
    { text: "对偏好学习的意见可写在此处 / Comments on preference learning can be written here" },
    { text: "" },
    ...String(evaluationText || "").split(/\r?\n/).map((line) => ({ text: line })).filter((part) => String(part.text || "").trim()),
  ];
  parts.push({ text: "待确认规则建议 / Pending Rule Suggestions", style: "Heading1" });
  if (suggestions.length) {
    parts.push({ text: "状态选项 / Status options：pending/待定、accept/接受、reject/拒绝、revise/修改" });
    parts.push({ kind: "suggestions_table", rows: suggestions });
  } else {
    parts.push({ text: "本次暂无待确认规则建议 / No pending rule suggestions in this run" });
  }
  return parts;
}

export async function syncScreeningStandardsDocx(reviewRoot, { pubmedConfigPath = "", evaluationText = null, previousText = null, suggestions = [], suggestionsLogPath = null } = {}) {
  const current = await readScreeningStandardsFile(reviewRoot);
  const snapshotPath = screeningStandardsLastSyncedPath(reviewRoot);
  const docxPath = screeningStandardsDocxPath(reviewRoot);
  let previous = previousText ?? current.content;
  if (fs.existsSync(snapshotPath)) {
    previous = await fs.promises.readFile(snapshotPath, "utf8");
  }
  const resolvedPubmedConfigPath = pubmedConfigPath || defaultPubmedConfigPath(reviewRoot);
  const pubmedConfig = readJsonIfExists(resolvedPubmedConfigPath);
  let keywordGroups = loadPubMedKeywordGroupsFromConfig(pubmedConfig);

  // Fallback: if config keywords are empty, read from existing docx
  const hasRealKeywords = (keywordGroups.required || []).some((g) => g.length > 0) || (keywordGroups.optional || []).length > 0 || (keywordGroups.negative || []).length > 0;
  if (!hasRealKeywords && fs.existsSync(docxPath)) {
    try {
      const existingParsed = await parseScreeningStandardsDocx(docxPath);
      if (existingParsed.keyword_state && (existingParsed.keyword_state.required || []).length > 0) {
        keywordGroups = existingParsed.keyword_state;
      }
    } catch {}
  }

  // Fallback: only read evaluationText from existing docx when not explicitly provided (null).
  // Empty string ("") means "clear evaluation"; null means "not specified, preserve existing".
  if (evaluationText == null && fs.existsSync(docxPath)) {
    try {
      const existingParsed2 = await parseScreeningStandardsDocx(docxPath);
      if (existingParsed2.evaluation_text) evaluationText = existingParsed2.evaluation_text;
    } catch {}
  }

  // Load suggestions from log if not explicitly provided; only include unresolved pending items
  let allSuggestions = suggestions;
  if (!allSuggestions.length && suggestionsLogPath) {
    try {
      const log = JSON.parse(await fs.promises.readFile(suggestionsLogPath, "utf8"));
      allSuggestions = (log.suggestions || []).filter((s) => s.status === "pending" && !s.processed_at);
    } catch {}
  }
  // Fallback: preserve pending suggestions from existing docx when no other source
  if (!allSuggestions.length && !suggestionsLogPath && fs.existsSync(docxPath)) {
    try {
      const existingForSuggestions = await parseScreeningStandardsDocx(docxPath);
      const table = existingForSuggestions.suggestions_table || [];
      if (table.length > 1) {
        const hdrs = table[0].map((c) => String(c || "").trim());
        const statusIdx = hdrs.indexOf("状态");
        const pendingRows = table.slice(1).filter((row) => {
          const s = statusIdx >= 0 ? String(row[statusIdx] || "").trim().toLowerCase() : "";
          return s === "pending" || s === "待定";
        });
        if (pendingRows.length) {
          allSuggestions = pendingRows.map((row) => {
            const obj = {};
            hdrs.forEach((h, i) => { if (h) obj[h] = row[i] || ""; });
            obj.status = "pending";
            return obj;
          });
        }
      }
    } catch {}
  }

  // Extract unknown content blocks from existing docx before rebuilding
  let unknownBlocks = [];
  let backupPath = null;
  if (fs.existsSync(docxPath)) {
    try {
      const existingParsed3 = await parseScreeningStandardsDocx(docxPath);
      unknownBlocks = existingParsed3.unknown_blocks || [];
      // Also detect extra rule lines in docx that are NOT in the md
      const mdText = (current.content || "").toLowerCase();
      const rulesText = existingParsed3.rules_text || "";
      if (rulesText) {
        for (const line of rulesText.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed && !mdText.includes(trimmed.toLowerCase()) && !isManagedTemplateText(trimmed)) {
            unknownBlocks.push(`<w:p><w:r><w:t xml:space="preserve">${escapeXml(trimmed)}</w:t></w:r></w:p>`);
          }
        }
      }
    } catch {}

    backupPath = await backupDocx(docxPath);
  }

  const parts = buildDocxParts({ previousText: previous, currentText: current.content, keywordGroups, evaluationText, suggestions: allSuggestions });

  // Re-inject unknown blocks into the rebuilt docx to preserve user content
  await fs.promises.writeFile(docxPath, buildDocxBuffer(parts, { unknownBlocks }));
  await fs.promises.writeFile(snapshotPath, current.content, "utf8");
  return {
    docx_path: docxPath,
    docx_overwritten: true,
    docx_generated: false,
    unknown_blocks_preserved: unknownBlocks.length,
    backup_path: backupPath,
    snapshot_path: snapshotPath,
    markdown_path: current.path,
    additions_count: parts.filter((part) => part.type === "add").length,
    deletions_count: parts.filter((part) => part.type === "delete").length,
    suggestions_in_docx: allSuggestions.length,
  };
}

export function buildScreeningStandardsSyncPlan({
  syncSteps = [],
  evaluationTextConsumed = false,
  evaluationTextCleared = false,
  clearedReason = "",
  preferenceLearningInputsBuilt = false,
  notes = [],
} = {}) {
  const steps = Array.isArray(syncSteps)
    ? syncSteps.map((step) => ({
      name: String(step?.name || ""),
      purpose: String(step?.purpose || ""),
      attempted: Boolean(step?.attempted),
      docx_backup_expected: Boolean(step?.docxBackupExpected),
    })).filter((step) => step.name || step.purpose || step.attempted || step.docx_backup_expected)
    : [];
  const normalizedNotes = Array.isArray(notes)
    ? notes.map((note) => String(note || "").trim()).filter(Boolean)
    : [];
  return {
    sync_steps_count: steps.length,
    docx_sync_attempted: steps.some((step) => step.attempted),
    docx_backup_expected: steps.some((step) => step.docx_backup_expected),
    evaluation_text_consumed: Boolean(evaluationTextConsumed),
    evaluation_text_cleared: Boolean(evaluationTextCleared),
    cleared_reason: evaluationTextCleared ? String(clearedReason || "evaluation_processed_and_cleared") : "",
    preference_learning_inputs_built: Boolean(preferenceLearningInputsBuilt),
    notes: [...new Set(normalizedNotes)],
    sync_steps: steps,
  };
}

function parseKeywordTable(rows = []) {
  const out = { required: [], optional: [], negative: [] };
  for (const row of rows.slice(1)) {
    const category = String(row[0] || "").trim();
    const terms = String(row[1] || "").trim();
    if (category === "核心必须词") {
      out.required = terms.split("|").map((group) => group.split(";").map((term) => term.trim()).filter(Boolean)).filter((group) => group.length);
    } else if (category === "可选扩展词") {
      out.optional = terms.split(";").map((term) => term.trim()).filter(Boolean);
    } else if (category === "排除词") {
      out.negative = terms.split(";").map((term) => term.trim()).filter(Boolean);
    }
  }
  return out;
}

const KNOWN_SECTIONS = new Set(["偏好规则", "格式说明 / Format Notes", "格式说明", "检索关键词", "评价", "待确认规则建议", "待确认规则建议 / Pending Rule Suggestions", "用户保留内容", "用户保留内容 / Preserved User Content"]);
const GUIDE_TEXT_PREFIX = "对偏好学习的意见";

// Template/system text patterns that must not be preserved as user content
const MANAGED_CONTENT_MARKERS = [
  "用户保留内容 / Preserved User Content",
  "以下内容来自上一次 docx 中系统未识别的区域",
  "状态选项 / Status options",
  "格式说明 / Format Notes",
  "待确认规则建议 / Pending Rule Suggestions",
  "本次暂无待确认规则建议",
  "No pending rule suggestions",
  "对偏好学习的意见可写在此处",
  "黑体",
  "红色",
  "蓝色",
  "删除线",
  "待确认建议是否生效",
  "Word 下拉不可用时",
  "pending/待定",
  "accept/接受",
  "reject/拒绝",
  "revise/修改",
  "Active rule unchanged",
  "Newly added or revised",
  "Removed or retired",
  "Rule suggestions are applied",
  "If Word dropdown is unavailable",
];

function isManagedTemplateText(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  return MANAGED_CONTENT_MARKERS.some((marker) => t.includes(marker));
}

export async function parseScreeningStandardsDocx(docxPath) {
  const entries = parseZipEntries(await fs.promises.readFile(docxPath));
  const documentXml = entries.get("word/document.xml");
  if (!documentXml) throw new Error("docx_document_xml_missing");
  const sectionNames = [];
  const sectionLines = { "偏好规则": [], "评价": [] };
  let keywordTable = [];
  let queryPreview = "";
  let suggestionsTable = [];
  let currentSection = "";
  const unknownBlocks = [];
  for (const match of documentXml.matchAll(/<w:p[\s\S]*?<\/w:p>|<w:tbl[\s\S]*?<\/w:tbl>/g)) {
    const block = match[0];
    if (block.startsWith("<w:tbl")) {
      if (currentSection === "检索关键词") keywordTable = tableRowsFromXml(block);
      else if (currentSection === "待确认规则建议" || currentSection === "待确认规则建议 / Pending Rule Suggestions") suggestionsTable = tableRowsFromXml(block);
      else unknownBlocks.push(block);
      continue;
    }
    const text = textFromXml(block).trim();
    if (KNOWN_SECTIONS.has(text)) {
      currentSection = text;
      sectionNames.push(text);
      continue;
    }
    let captured = false;
    if (currentSection === "偏好规则" && text) { sectionLines["偏好规则"].push(text); captured = true; }
    if (currentSection === "检索关键词" && text.startsWith("PubMed query preview:")) { queryPreview = text.replace(/^PubMed query preview:\s*/, ""); captured = true; }
    if (currentSection === "评价" && text && !text.startsWith(GUIDE_TEXT_PREFIX)) { sectionLines["评价"].push(text); captured = true; }
    if (!captured && currentSection && !KNOWN_SECTIONS.has(currentSection)) unknownBlocks.push(block);
    if (!captured && !currentSection) unknownBlocks.push(block);
    if (!captured && KNOWN_SECTIONS.has(currentSection) && text) unknownBlocks.push(block);
  }
  // Filter out managed template/system blocks from unknown blocks to prevent recursive pollution
  const filteredUnknownBlocks = unknownBlocks.filter((block) => {
    const textMatch = block.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g);
    if (!textMatch) return true;
    const text = textMatch.map((m) => m.replace(/<[^>]+>/g, "")).join("");
    return !isManagedTemplateText(text);
  });

  return {
    section_names: sectionNames,
    rules_text: sectionLines["偏好规则"].join("\n"),
    keyword_state: parseKeywordTable(keywordTable),
    keyword_table_rows: keywordTable,
    query_preview: queryPreview,
    evaluation_text: sectionLines["评价"].join("\n").trim(),
    suggestions_table: suggestionsTable,
    unknown_blocks: filteredUnknownBlocks,
    unknown_block_count: filteredUnknownBlocks.length,
  };
}
