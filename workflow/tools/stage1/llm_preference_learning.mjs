import fs from "node:fs/promises";
import path from "node:path";

import { callJsonLlm, hashInput, resolveLlmRuntime } from "../lib/llm_json_support.mjs";

const SUPPORTED_FEEDBACK = new Set(["keep", "drop", "upgrade", "downgrade"]);

function normalizeFeedbackRow(row = {}, index = 0) {
  const feedback = String(row.feedback || row["反馈"] || "").trim().toLowerCase();
  const title = String(row.title || row.english_title || row.title_context || row["英文标题"] || row["标题"] || row["题名"] || "").trim();
  return {
    id: String(row.id || row.itemKey || row.item_key || `feedback-${index + 1}`),
    row: row.row || row.source_row || index + 1,
    title,
    feedback,
    user_comment: String(row.user_comment || row.comment || row.evaluation || row["评价"] || row["备注"] || "").trim(),
    rule_grade: String(row.rule_grade || row["规则等级"] || "").trim().slice(0, 1).toUpperCase(),
    llm_review_grade: String(row.llm_review_grade || row.semantic_grade || row["语义等级"] || "").trim().slice(0, 1).toUpperCase(),
    semantic_grade: String(row.semantic_grade || row.llm_review_grade || row["语义等级"] || "").trim().slice(0, 1).toUpperCase(),
    final_grade: String(row.final_grade || row["最终等级"] || "").trim().slice(0, 1).toUpperCase(),
  };
}

export function buildLlmPreferenceInput(feedbackRows = [], { maxFeedbackItems = 100 } = {}) {
  return feedbackRows
    .map(normalizeFeedbackRow)
    .filter((row) => row.title && SUPPORTED_FEEDBACK.has(row.feedback))
    .slice(0, Math.max(1, Number(maxFeedbackItems || 100)));
}

export function buildPreferenceLearningInputs({
  feedbackLearning = {},
  config = {},
} = {}) {
  const feedbackRows = Array.isArray(feedbackLearning?.signals) ? feedbackLearning.signals : [];
  const inputs = buildLlmPreferenceInput(feedbackRows, { maxFeedbackItems: config.max_feedback_items || 100 });
  return {
    inputs,
    feedbackRows,
    feedbackSource: feedbackLearning?.path || "",
    summary: {
      feedback_rows_total: feedbackRows.length,
      feedback_rows_used: inputs.length,
      excluded_count: Math.max(0, feedbackRows.length - inputs.length),
      skipped_reason: inputs.length ? "" : "no_supported_feedback_rows",
    },
  };
}

function buildPrompt(rows) {
  return [
    "你是医学文献筛选偏好学习助手。只输出 JSON，不要输出 markdown 或解释。",
    "任务：根据 keep/drop/upgrade/downgrade 和用户评价归纳偏好证据、主题和可人工确认的 suggestion candidates。",
    "约束：不得直接生成正式规则修改；不得直接写 Pending Rule Suggestions log；drop/downgrade 不等于主题不感兴趣，必须区分原因类型。",
    "原因类型只能是 topic_preference、scope_mismatch、grading_error、quality_issue、duplicate、availability_issue、unclear。",
    "只有适合影响规则的原因才生成 suggestion_candidates；如果用户评价不足以说明原因，不要过度归纳。",
    "规则正文、主题、理由和风险说明统一使用简洁中文，保留必要专业缩写。不得输出示例占位符、乱码、无依据或重复建议；没有明确证据时返回空列表。",
    "official_screening_standards 约束归纳边界；search_context 只帮助理解术语和检索范围。",
    "输出 schema: {\"preference_summary\":{},\"preference_themes\":[{\"theme\":\"\",\"polarity\":\"positive|negative|upgrade_pattern|downgrade_pattern\",\"inferred_reason_type\":\"topic_preference|scope_mismatch|grading_error|quality_issue|duplicate|availability_issue|unclear\",\"should_affect_rules\":true,\"evidence_feedback_types\":[],\"evidence_titles\":[],\"confidence\":\"low|medium|high\",\"risk\":\"\"}],\"suggestion_candidates\":[{\"id\":\"\",\"source\":\"llm_preference_learning\",\"target\":\"screening_standards.md|review-workflow-rules.json|pubmed_pmc_search.json|unknown\",\"change_type\":\"add_rule|revise_rule|delete_rule|add_keyword|remove_keyword|add_downgrade_signal|other\",\"rule_text\":\"\",\"rationale\":\"\",\"evidence_feedback_types\":[],\"evidence_titles\":[],\"confidence\":\"low|medium|high\",\"risk\":\"\",\"requires_human_approval\":true}],\"warnings\":[]}",
    "",
    JSON.stringify({ feedback_rows: rows }, null, 2),
  ].join("\n");
}

function normalizeConfidence(value) {
  const raw = String(value || "").trim().toLowerCase();
  return ["low", "medium", "high"].includes(raw) ? raw : "low";
}

function normalizeOutput(output = {}) {
  const summary = output.preference_summary && typeof output.preference_summary === "object" ? output.preference_summary : {};
  const rawThemes = Array.isArray(output.preference_themes) ? output.preference_themes : [];
  const preference_themes = rawThemes.map((theme) => ({
    theme: String(theme.theme || "").trim(),
    polarity: String(theme.polarity || "").trim(),
    inferred_reason_type: String(theme.inferred_reason_type || "unclear").trim(),
    should_affect_rules: Boolean(theme.should_affect_rules),
    evidence_feedback_types: Array.isArray(theme.evidence_feedback_types) ? theme.evidence_feedback_types.map(String) : [],
    evidence_titles: Array.isArray(theme.evidence_titles) ? theme.evidence_titles.map(String).filter(Boolean).slice(0, 8) : [],
    confidence: normalizeConfidence(theme.confidence),
    risk: String(theme.risk || "").trim(),
  })).filter((theme) => theme.theme);
  const rawSuggestions = Array.isArray(output.suggestion_candidates)
    ? output.suggestion_candidates
    : Array.isArray(output.pending_rule_suggestions)
      ? output.pending_rule_suggestions
      : [];
  const suggestion_candidates = rawSuggestions.map((s, index) => ({
    id: String(s.id || `llm-suggestion-${index + 1}`).trim(),
    source: "llm_preference_learning",
    target: String(s.target || "screening_standards.md").trim(),
    change_type: String(s.change_type || s.type || "add_rule").trim(),
    rule_text: String(s.rule_text || s.suggested_rule || "").trim(),
    rationale: String(s.rationale || s.reason || "").trim(),
    evidence_feedback_types: Array.isArray(s.evidence_feedback_types) ? s.evidence_feedback_types.map(String) : [],
    evidence_titles: Array.isArray(s.evidence_titles) ? s.evidence_titles.map(String).filter(Boolean).slice(0, 8) : [],
    confidence: normalizeConfidence(s.confidence),
    risk: String(s.risk || "").trim(),
    requires_human_approval: true,
  })).filter((s) => s.rule_text && s.evidence_titles.length);
  return {
    preference_summary: summary,
    preference_themes,
    suggestion_candidates,
    warnings: Array.isArray(output.warnings) ? output.warnings.map(String) : [],
  };
}

export async function runLlmPreferenceLearning({
  feedbackRows = [],
  outputPath = "",
  suggestionsLogPath = "",
  cachePath = "",
  config = {},
  runtime = resolveLlmRuntime(),
  llmClient = null,
  generatedAt = new Date().toISOString(),
  feedbackSource = "",
} = {}) {
  const enabled = config.enabled !== false && config.preference_learning_enabled !== false;
  const preferenceInputs = buildPreferenceLearningInputs({
    feedbackLearning: { signals: feedbackRows, path: feedbackSource },
    config,
  });
  const rows = preferenceInputs.inputs;
  const base = {
    enabled,
    method: "llm_preference_learning",
    role: "evidence_and_theme_extraction",
    generated_at: generatedAt,
    feedback_rows_total: feedbackRows.length,
    feedback_rows_used: rows.length,
    preference_themes: [],
    suggestion_candidates: [],
    pending_rule_suggestions: [],
    warnings: [],
    cache_hit: false,
    llm_model: runtime.model || "",
    llm_endpoint: runtime.endpoint || "",
    llm_api_key_source: runtime.apiKeyEnvName || "",
  };
  if (!enabled) {
    const skipped = { ...base, ok: false, skipped: true, skipped_reason: "disabled" };
    if (outputPath) await fs.writeFile(outputPath, JSON.stringify(skipped, null, 2), "utf8");
    return skipped;
  }
  if (!rows.length) {
    const skipped = { ...base, ok: false, skipped: true, skipped_reason: "no_supported_feedback_rows" };
    if (outputPath) await fs.writeFile(outputPath, JSON.stringify(skipped, null, 2), "utf8");
    return skipped;
  }

  const input = { feedback_rows: rows };
  const prompt = buildPrompt(rows);
  const llm = await callJsonLlm({
    taskType: "preference_learning",
    prompt,
    input,
    runtime,
    cachePath,
    cacheEnabled: config.cache_enabled !== false,
    llmClient,
  });

  let result;
  if (!llm.ok) {
    result = {
      ...base,
      ok: false,
      skipped: Boolean(llm.skipped),
      blocker: llm.blocker || "llm_preference_learning_failed",
      error: llm.error || "",
      raw_response_length: Number.isFinite(Number(llm.raw_response_length)) ? Number(llm.raw_response_length) : null,
      raw_response_hash: llm.raw_response_hash || "",
      parse_error_summary: llm.parse_error_summary || "",
      warnings: llm.warnings || [],
      cache_hit: Boolean(llm.cache_hit),
      mock_response_used: Boolean(llm.mock_response_used),
      request_would_have_been_sent: Boolean(llm.request_would_have_been_sent),
      real_request_sent: Boolean(llm.real_request_sent),
    };
    if (config.strict_json) result.strict_json_failed = true;
  } else {
    const normalized = normalizeOutput(llm.output);
    result = {
      ...base,
      ok: true,
      skipped: false,
      preference_summary: normalized.preference_summary,
      preference_themes: normalized.preference_themes,
      suggestion_candidates: normalized.suggestion_candidates.map((candidate) => ({
        ...candidate,
        input_hash: hashInput({ candidate, feedbackSource }),
      })),
      pending_rule_suggestions: [],
      warnings: normalized.warnings,
      raw_response_length: Number.isFinite(Number(llm.raw_response_length)) ? Number(llm.raw_response_length) : null,
      raw_response_hash: llm.raw_response_hash || "",
      parse_error_summary: llm.parse_error_summary || "",
      cache_hit: Boolean(llm.cache_hit),
      cache_key: llm.cache_key || "",
      mock_response_used: Boolean(llm.mock_response_used),
      request_would_have_been_sent: Boolean(llm.request_would_have_been_sent),
      real_request_sent: Boolean(llm.real_request_sent),
      suggestions_log_path: suggestionsLogPath,
      suggestions_appended: 0,
      suggestions_skipped_duplicate: 0,
      pending_log_write_skipped_reason: "handled_by_unified_pending_suggestion_generator",
    };
  }
  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
  }
  return result;
}
