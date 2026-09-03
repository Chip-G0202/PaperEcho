import fs from "node:fs/promises";
import path from "node:path";

import { callJsonLlm, hashText, resolveLlmRuntime } from "../lib/llm_json_support.mjs";
import { createServiceConcurrencyController } from "../lib/adaptive_concurrency.mjs";
import { normalizeGradeLetter } from "../lib/grade_primitives.mjs";
import { synthesizeFinalGrade } from "./semantic_grade_synthesis.mjs";

const DEFAULT_ELIGIBLE_RULE_GRADES = ["A", "B", "C"];

export function resolveGradeReviewItemLimit(config = {}, {
  candidateCount = 0,
  runtimeOverride = null,
  defaultLimit = 50,
} = {}) {
  const runtimeLimit = Number(runtimeOverride);
  if (Number.isInteger(runtimeLimit) && runtimeLimit > 0) {
    return { maxItems: runtimeLimit, source: "runtime_override" };
  }

  const configuredLimit = Number(config.max_grade_review_items);
  const coverageMode = String(config.max_grade_review_items_mode || "").trim().toLowerCase();
  if (coverageMode === "full_coverage_by_default" && (!Number.isFinite(configuredLimit) || configuredLimit <= 0)) {
    return { maxItems: Math.max(1, Number(candidateCount) || 0), source: "full_coverage" };
  }
  if (Number.isInteger(configuredLimit) && configuredLimit > 0) {
    return { maxItems: configuredLimit, source: "config" };
  }
  return { maxItems: Math.max(1, Number(defaultLimit) || 50), source: "default" };
}

export function resolveEligibleRuleGrades(config = {}) {
  const configured = Array.isArray(config.eligible_rule_grades)
    ? config.eligible_rule_grades.map(normalizeGradeLetter).filter(Boolean)
    : [];
  if (configured.length) return [...new Set(configured)];
  const legacyScope = String(config.review_scope || "").trim();
  if (legacyScope === "all") return ["A", "B", "C", "D"];
  if (legacyScope === "B_C_D") return ["B", "C", "D"];
  if (legacyScope === "B_C_only") return ["B", "C"];
  return DEFAULT_ELIGIBLE_RULE_GRADES.slice();
}

export function buildLlmReviewCandidates(items = [], {
  eligibleRuleGrades = DEFAULT_ELIGIBLE_RULE_GRADES,
  duplicateRemovedCount = 0,
} = {}) {
  const eligibleSet = new Set((eligibleRuleGrades || DEFAULT_ELIGIBLE_RULE_GRADES).map(normalizeGradeLetter).filter(Boolean));
  const sourceItems = Array.isArray(items) ? items : [];
  const isEligible = (item) => eligibleSet.has(String(item?.rule_grade || item?.grade || "").trim().toUpperCase());
  const eligibleBeforeExistingDedupe = sourceItems.filter((item) => item && isEligible(item));
  const candidates = eligibleBeforeExistingDedupe.filter((item) => item.pre_llm_skip_writeback !== true);
  const excludedNonAbcCount = Math.max(0, sourceItems.length - eligibleBeforeExistingDedupe.length);
  const excludedNotDedupedCount = Math.max(0, Number(duplicateRemovedCount || 0));
  const summary = {
    llm_review_candidate_count: eligibleBeforeExistingDedupe.length,
    llm_review_candidates_count: candidates.length,
    abc_grade_items_count: eligibleBeforeExistingDedupe.length,
    excluded_non_abc_count: excludedNonAbcCount,
    excluded_not_deduped_count: excludedNotDedupedCount,
    skip_reason: candidates.length ? "" : "no_eligible_items",
  };
  return {
    candidates,
    summary,
    telemetry: {
      llm_review_candidate_count: summary.llm_review_candidate_count,
      llm_review_candidates_count: summary.llm_review_candidates_count,
      abc_grade_items_count: summary.abc_grade_items_count,
      excluded_non_abc_count: summary.excluded_non_abc_count,
      excluded_not_deduped_count: summary.excluded_not_deduped_count,
    },
  };
}

function reviewScopeAllows(ruleGrade, eligibleRuleGrades = DEFAULT_ELIGIBLE_RULE_GRADES) {
  const grade = normalizeGradeLetter(ruleGrade);
  return Boolean(grade && eligibleRuleGrades.includes(grade));
}

function itemId(item, index) {
  return String(item.id || item.itemKey || item.item_key || item.doi || item.pmid || `item-${index + 1}`);
}

function buildReviewItems(items = [], config = {}) {
  const maxItems = Math.max(1, Number(config.max_grade_review_items || 100));
  const eligibleRuleGrades = resolveEligibleRuleGrades(config);
  return items
    .map((item, index) => {
      const ruleGrade = normalizeGradeLetter(item.rule_grade || item.grade);
      return {
        id: itemId(item, index),
        title: String(item.title || "").trim(),
        rule_grade: ruleGrade,
        current_llm_review_grade: normalizeGradeLetter(item.llm_review_grade || item.semantic_grade),
        current_semantic_grade: normalizeGradeLetter(item.semantic_grade),
        current_final_grade: normalizeGradeLetter(item.final_grade),
        _item: item,
      };
    })
    .filter((entry) => entry.title && reviewScopeAllows(entry.rule_grade, eligibleRuleGrades))
    .slice(0, maxItems);
}

function buildPrompt(reviewItems, ruleContextSummary = null, { strictJsonRetry = false } = {}) {
  return [
    "你是医学文献 title-only 分级复审助手。只输出 valid JSON，不要输出 markdown、代码块、解释或非 JSON 文本。",
    "任务：只基于文章标题进行 LLM title review。可以参考 rule_grade、official_screening_standards 和 machine_grading_rules；不要假设摘要、全文或 PDF 信息。",
    "official_screening_standards 和 machine_grading_rules 是主要规则依据。Search context 只帮助理解术语和检索范围，不是直接升级/降级规则。",
    "Pending suggestions、candidate themes 和 feedback-derived themes 不是正式规则，不能作为当前分级依据。",
    "不要围绕任何固定示例或硬编码领域提示判断；从标题中通用识别主题、研究对象、模型、机制、方法、别名、缩写、实验系统等。",
    "标题证据不足时保持 rule_grade，或设置 needs_human_review=true。",
    "输出要求：",
    "- 必须输出纯 JSON，不包含 markdown 代码块标记、反引号、或外层 prose。",
    "- 只能输出一个 JSON object，顶层必须包含 items 数组和 warnings 数组。",
    "- 不要输出注释、尾随逗号、未转义换行、undefined、NaN 或 JSON 以外文本。",
    "- 每个 item 的 reason 控制在 120 chars 以内。简短理由即可。",
    "- reason 不要重复 title、rule text 或长规则解释。",
    "- 不要输出 evidence_terms、recognized_concepts、概念列表、长 rationale 或重复规则解释。",
    "- 不使用未在 schema 中列出的额外字段。",
    strictJsonRetry ? "严格重试要求：上一次输出不是可解析 JSON。本次必须只返回完整、可被 JSON.parse 解析的单一 JSON object。" : "",
    "输出 schema: {\"items\":[{\"id\":\"\",\"title\":\"\",\"rule_grade\":\"A|B|C|D\",\"llm_review_grade\":\"A|B|C|D\",\"confidence\":\"low|medium|high\",\"reason\":\"\",\"needs_human_review\":true}],\"warnings\":[]}",
    "",
    JSON.stringify({
      review_scope: { scope: "title_only", abstract_used: false, full_text_used: false },
      rule_context_summary: ruleContextSummary,
      items: reviewItems.map(({ _item, ...entry }) => entry),
    }, null, 2),
  ].join("\n");
}

export function gradeReviewPromptContractHash() {
  return hashText(buildPrompt([], null));
}

function confidenceToScore(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "high") return 0.9;
  if (raw === "medium") return 0.65;
  return 0.3;
}

function normalizeReviewOutput(output = {}) {
  const items = Array.isArray(output.items) ? output.items : [];
  return items.map((entry) => ({
    id: String(entry.id || "").trim(),
    title: String(entry.title || "").trim(),
    rule_grade: normalizeGradeLetter(entry.rule_grade),
    llm_review_grade: normalizeGradeLetter(entry.llm_review_grade || entry.llm_grade),
    confidence: ["low", "medium", "high"].includes(String(entry.confidence || "").toLowerCase()) ? String(entry.confidence).toLowerCase() : "low",
    reason: String(entry.reason || "").trim(),
    evidence_terms: Array.isArray(entry.evidence_terms) ? entry.evidence_terms.map(String).filter(Boolean).slice(0, 8) : [],
    recognized_concepts: Array.isArray(entry.recognized_concepts) ? entry.recognized_concepts.slice(0, 8) : [],
    needs_human_review: Boolean(entry.needs_human_review),
  })).filter((entry) => entry.id && entry.llm_review_grade);
}

function ruleContextForGradeReview(ruleContextSummary = null) {
  if (!ruleContextSummary || typeof ruleContextSummary !== "object") return ruleContextSummary;
  const pendingText = String(ruleContextSummary.pending_suggestions_summary || "");
  return {
    ...ruleContextSummary,
    pending_suggestions_summary: "",
    pending_suggestions_metadata: {
      pending_suggestions_excluded_from_grade_review: true,
      pending_count: Number(ruleContextSummary.pending_suggestions_metadata?.pending_count || (pendingText ? 1 : 0)),
      pending_hash: ruleContextSummary.pending_suggestions_metadata?.pending_hash || "",
      pending_log_hash: ruleContextSummary.pending_suggestions_metadata?.pending_log_hash || "",
    },
  };
}

function synthesizeLlmReview({ ruleGrade, llmGrade, confidence, llmNeedsHumanReview, semanticReason, flags }) {
  const ruleNorm = normalizeGradeLetter(ruleGrade);
  const llmNorm = normalizeGradeLetter(llmGrade);
  if (!llmNorm) return { finalGrade: ruleNorm, needsHumanReview: false, disagreementType: "" };
  if (llmNeedsHumanReview) {
    return { finalGrade: ruleNorm, needsHumanReview: true, disagreementType: "llm_requested_review" };
  }
  if (confidence === "low" && ruleNorm && llmNorm !== ruleNorm) {
    return { finalGrade: ruleNorm, needsHumanReview: true, disagreementType: "llm_low_confidence_conflict" };
  }
  return synthesizeFinalGrade({ ruleGrade: ruleNorm, semanticGrade: llmNorm, semanticReason, flags });
}

export function applyReviewToItems(reviewItems, llmItems, { failedReviewItemIds = new Set() } = {}) {
  const byId = new Map(llmItems.map((entry) => [entry.id, entry]));
  const stats = {
    items_reviewed: reviewItems.length,
    items_with_semantic_grade: 0,
    items_needing_human_review: 0,
    final_grade_unchanged: 0,
    final_grade_upgraded: 0,
    final_grade_downgraded: 0,
  };
  const gradeOrder = { A: 1, B: 2, C: 3, D: 4 };
  const applied = [];
  for (const reviewItem of reviewItems) {
    const target = reviewItem._item;
    const llm = byId.get(reviewItem.id);
    target.rule_grade = reviewItem.rule_grade;
    if (!llm) {
      target.llm_review_grade = "";
      target.semantic_grade = "";
      target.final_grade = reviewItem.rule_grade;
      target.semantic_reason = failedReviewItemIds.has(reviewItem.id)
        ? "LLM复审批次失败，保持规则等级并进入人工复核"
        : "LLM复审未返回该条目，保持规则等级";
      target.semantic_confidence = 0;
      target.semantic_source = failedReviewItemIds.has(reviewItem.id)
        ? "llm_title_review_failed"
        : "llm_title_review_missing";
      target.needs_human_review = failedReviewItemIds.has(reviewItem.id);
      target.disagreement_type = failedReviewItemIds.has(reviewItem.id) ? "llm_review_failed" : "";
      if (target.needs_human_review) stats.items_needing_human_review += 1;
      continue;
    }
    const synthesized = synthesizeLlmReview({
      ruleGrade: reviewItem.rule_grade,
      llmGrade: llm.llm_review_grade,
      confidence: llm.confidence,
      llmNeedsHumanReview: llm.needs_human_review,
      semanticReason: llm.reason,
      flags: target.flags,
    });
    target.llm_review_grade = llm.llm_review_grade;
    target.semantic_grade = llm.llm_review_grade;
    target.semantic_reason = llm.reason;
    target.semantic_confidence = confidenceToScore(llm.confidence);
    target.semantic_source = "llm_title_review";
    target.llm_review = llm;
    target.final_grade = synthesized.finalGrade;
    target.needs_human_review = synthesized.needsHumanReview;
    target.disagreement_type = synthesized.disagreementType;
    stats.items_with_semantic_grade += 1;
    if (target.needs_human_review) stats.items_needing_human_review += 1;
    if (target.final_grade === reviewItem.rule_grade) {
      stats.final_grade_unchanged += 1;
    } else if ((gradeOrder[target.final_grade] || 4) < (gradeOrder[reviewItem.rule_grade] || 4)) {
      stats.final_grade_upgraded += 1;
    } else {
      stats.final_grade_downgraded += 1;
    }
    applied.push({ ...llm, final_grade: target.final_grade, disagreement_type: target.disagreement_type });
  }
  return { stats, applied };
}

function isJsonParseFailure(llm = {}) {
  return llm.error_type === "llm_json_parse_failed"
    || llm.blocker === "llm_json_failed"
    || /json|array element|object|parse|invalid/i.test(String(llm.error || llm.parse_error_summary || ""));
}

function summarizeLlmFailure(llm = {}, {
  batchIndex = null,
  batchSize = 0,
  attempt = 1,
  retryOfBatchIndex = null,
} = {}) {
  return {
    failed_batch_index: batchIndex,
    failed_batch_size: batchSize,
    failed_batch_attempt: attempt,
    retry_of_batch_index: retryOfBatchIndex,
    failed_batch_error_type: llm.error_type || llm.blocker || "llm_grade_review_failed",
    parse_error_summary: String(llm.parse_error_summary || llm.error || "").replace(/\s+/g, " ").trim().slice(0, 220),
    raw_response_length: Number.isFinite(Number(llm.raw_response_length)) ? Number(llm.raw_response_length) : null,
    raw_response_hash: String(llm.raw_response_hash || ""),
    parse_error_offset: Number.isFinite(Number(llm.parse_error_offset)) ? Number(llm.parse_error_offset) : null,
    request_would_have_been_sent: Boolean(llm.request_would_have_been_sent),
    real_request_sent: Boolean(llm.real_request_sent),
    cache_hit: Boolean(llm.cache_hit),
  };
}

function summarizeBatchTimings(entries = [], {
  plannedBatchCount = 0,
  configuredBatchSize = 0,
  batchConcurrency = 1,
  retryBatchCount = 0,
  splitBatchCount = 0,
  retrySuccessCount = 0,
  splitSuccessCount = 0,
} = {}) {
  const durations = entries.map((entry) => Number(entry.duration_ms)).filter((value) => Number.isFinite(value));
  const responseLengths = entries.map((entry) => Number(entry.raw_response_length)).filter((v) => Number.isFinite(v) && v > 0);
  const promptLengths = entries.map((entry) => Number(entry.prompt_length)).filter((v) => Number.isFinite(v) && v > 0);
  const totalResponseChars = responseLengths.reduce((sum, v) => sum + v, 0);
  const totalPromptChars = promptLengths.reduce((sum, v) => sum + v, 0);
  const totalItemsInBatchEntries = entries.reduce((sum, e) => sum + Number(e.item_count || 0), 0);
  const slowestTop5 = [...entries]
    .sort((a, b) => Number(b.duration_ms || 0) - Number(a.duration_ms || 0))
    .slice(0, 5)
    .map((entry) => ({
      batch_index: entry.batch_index,
      retry_of_batch_index: entry.retry_of_batch_index,
      attempt: entry.attempt,
      item_count: entry.item_count,
      duration_ms: entry.duration_ms,
      raw_response_length: entry.raw_response_length ?? null,
      prompt_length: entry.prompt_length ?? null,
      parse_error_offset: entry.parse_error_offset ?? null,
      ok: entry.ok,
      parse_failure: entry.parse_failure,
      json_repaired: entry.json_repaired,
      cache_hit: entry.cache_hit,
      mock_response_used: entry.mock_response_used,
      real_request_sent: entry.real_request_sent,
      error_summary: entry.error_summary,
    }));
  return {
    total_batches: plannedBatchCount,
    configured_batch_size: configuredBatchSize,
    effective_batch_size: configuredBatchSize,
    batch_concurrency: batchConcurrency,
    effective_batch_concurrency: batchConcurrency,
    total_request_attempts: entries.length,
    retry_count: retryBatchCount,
    retry_success_count: retrySuccessCount,
    split_count: splitBatchCount,
    split_success_count: splitSuccessCount,
    parse_failure_count: entries.filter((entry) => entry.parse_failure).length,
    repaired_json_count: entries.filter((entry) => entry.json_repaired).length,
    repair_success_count: entries.filter((entry) => entry.json_repaired).length,
    repair_attempt_count: entries.filter((entry) => entry.parse_failure || entry.json_repaired).length,
    avg_duration_ms: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    max_duration_ms: durations.length ? Math.max(...durations) : null,
    avg_response_length: responseLengths.length ? totalResponseChars / responseLengths.length : null,
    max_response_length: responseLengths.length ? Math.max(...responseLengths) : null,
    avg_prompt_length: promptLengths.length ? totalPromptChars / promptLengths.length : null,
    max_prompt_length: promptLengths.length ? Math.max(...promptLengths) : null,
    total_prompt_chars: totalPromptChars,
    total_response_chars: totalResponseChars,
    estimated_output_chars_per_item: totalItemsInBatchEntries > 0 && responseLengths.length > 0
      ? Math.round(totalResponseChars / totalItemsInBatchEntries)
      : null,
    slowest_top5: slowestTop5,
    batch_timings: entries,
  };
}

function buildPromptTelemetry(prompt) {
  const text = String(prompt || "");
  return {
    prompt_length: text.length,
    prompt_hash: hashText(text),
    prompt_preview_truncated: text.slice(0, 200),
  };
}

export async function reviewGradesWithLlm({
  items = [],
  outputPath = "",
  cachePath = "",
  config = {},
  runtime = resolveLlmRuntime(),
  llmClient = null,
  concurrencyController = null,
  progressCallback = null,
  researchFocusSummary = "",
  ruleContextSummary = null,
  reviewInputDiagnostics = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const enabled = config.enabled !== false && config.grade_review_enabled !== false;
  const eligibleRuleGrades = resolveEligibleRuleGrades(config);
  const reviewItems = buildReviewItems(items, config);
  const gradeReviewRuleContext = ruleContextForGradeReview(ruleContextSummary);
  const configuredBatchSize = Number(config.batch_size);
  const batchSize = Number.isFinite(configuredBatchSize) && configuredBatchSize > 0
    ? Math.floor(configuredBatchSize)
    : 20;
  const configuredBatchConcurrency = Number(config.batch_concurrency);
  const batchConcurrency = Number.isFinite(configuredBatchConcurrency) && configuredBatchConcurrency > 0
    ? Math.max(1, Math.floor(configuredBatchConcurrency))
    : 1;
  const controller = concurrencyController || createServiceConcurrencyController("llm", {
    minConcurrency: 1,
    initialConcurrency: batchConcurrency,
    maxConcurrency: batchConcurrency,
  });
  const plannedBatchCount = reviewItems.length ? Math.ceil(reviewItems.length / batchSize) : 0;
  const baseReport = {
    enabled,
    method: "llm_title_grade_review",
    generated_at: generatedAt,
    review_scope: "eligible_rule_grades",
    eligible_rule_grades: eligibleRuleGrades,
    grade_columns_semantics: {
      rule_grade: "rule_based_classifier_grade",
      semantic_grade: "llm_title_review_grade_export_alias",
      final_grade: "deterministic_synthesis_of_rule_and_llm_review",
    },
    llm_grade_review_scope: {
      scope: "title_only",
      abstract_used: false,
      full_text_used: false,
    },
    semantic_grade_source: "llm_title_review_grade",
    rule_context_summary: gradeReviewRuleContext,
    items_considered: items.length,
    items_reviewed: reviewItems.length,
    llm_review_eligible_count: reviewItems.length,
    planned_batch_count: plannedBatchCount,
    batch_concurrency: batchConcurrency,
    items_skipped_not_eligible: Math.max(0, items.length - reviewItems.length),
    items_with_semantic_grade: 0,
    items_needing_human_review: 0,
    final_grade_unchanged: 0,
    final_grade_upgraded: 0,
    final_grade_downgraded: 0,
    slimmed_schema_version: "v1-evidence-fields-removed",
    ...(reviewInputDiagnostics && typeof reviewInputDiagnostics === "object"
      ? {
        pre_llm_zotero_duplicate_check_enabled: Boolean(reviewInputDiagnostics.pre_llm_zotero_duplicate_check_enabled),
        pre_llm_eligible_count: Number(reviewInputDiagnostics.pre_llm_eligible_count || 0),
        skipped_existing_before_review_count: Number(reviewInputDiagnostics.skipped_existing_before_review_count || 0),
        duplicate_check_failed_reviewed_count: Number(reviewInputDiagnostics.duplicate_check_failed_reviewed_count || 0),
      }
      : {}),
    cache_hit: false,
    llm_model: runtime.model || "",
    llm_endpoint: runtime.endpoint || "",
    llm_api_key_source: runtime.apiKeyEnvName || "",
    items: [],
    warnings: [],
  };

  if (!enabled) {
    const skipped = { ...baseReport, ok: false, skipped: true, skipped_reason: "disabled" };
    if (outputPath) await fs.writeFile(outputPath, JSON.stringify(skipped, null, 2), "utf8");
    return skipped;
  }
  if (!reviewItems.length) {
    const skipped = { ...baseReport, ok: false, skipped: true, skipped_reason: "no_eligible_items" };
    for (const item of items) {
      item.rule_grade = item.rule_grade || item.grade;
      item.llm_review_grade = "";
      item.semantic_grade = "";
      item.final_grade = item.rule_grade || item.grade;
      item.semantic_reason = "";
      item.needs_human_review = false;
      item.disagreement_type = "";
    }
    if (outputPath) await fs.writeFile(outputPath, JSON.stringify(skipped, null, 2), "utf8");
    return skipped;
  }
  if (String(runtime.llm_mode || "").trim().toLowerCase() === "disabled") {
    for (const item of items) {
      item.rule_grade = item.rule_grade || item.grade;
      item.llm_review_grade = "";
      item.semantic_grade = "";
      item.final_grade = item.rule_grade || item.grade;
      item.semantic_reason = "";
      item.semantic_confidence = 0;
      item.semantic_source = "";
      item.needs_human_review = false;
      item.disagreement_type = "";
    }
    const skipped = {
      ...baseReport,
      ok: false,
      skipped: true,
      skipped_reason: "llm_disabled",
      batch_size: batchSize,
      batches_attempted: 0,
      warnings: ["llm_disabled"],
    };
    if (typeof progressCallback === "function") {
      await progressCallback({
        stage: "llm_grade_review",
        status: "skipped",
        eligible_count: reviewItems.length,
        planned_batch_count: plannedBatchCount,
        batch_size: batchSize,
        batch_concurrency: batchConcurrency,
        llm_mode: runtime.llm_mode || "disabled",
        eligible_rule_grades: eligibleRuleGrades,
        skipped_reason: "llm_disabled",
      });
    }
    if (outputPath) await fs.writeFile(outputPath, JSON.stringify(skipped, null, 2), "utf8");
    return skipped;
  }

  if (typeof progressCallback === "function") {
    await progressCallback({
      stage: "llm_grade_review",
      status: "started",
      eligible_count: reviewItems.length,
      planned_batch_count: plannedBatchCount,
      batch_size: batchSize,
      batch_concurrency: batchConcurrency,
      llm_mode: runtime.llm_mode || "real",
      eligible_rule_grades: eligibleRuleGrades,
    });
  }
  const normalizedItems = [];
  const failedBatchDiagnostics = [];
  const unresolvedFailureDiagnostics = [];
  const failedReviewItemIds = new Set();
  let cacheHitCount = 0;
  let mockResponseCount = 0;
  let realRequestCount = 0;
  let retryBatchCount = 0;
  let retrySuccessCount = 0;
  let splitBatchCount = 0;
  let splitSuccessCount = 0;
  let batchesAttempted = 0;
  const batchTimingEntries = [];

  const effectiveRuleContext = gradeReviewRuleContext || {
    prompt_version: "legacy-research-focus-summary",
    official_screening_standards_summary: "",
    machine_grading_rules_summary: researchFocusSummary,
    accepted_rule_updates_summary: "",
    search_context_summary: "",
    pending_suggestions_summary: "",
    constraints: [
      "Pending suggestions and candidates are not official grading rules.",
      "Search context explains retrieval scope and terminology but is not a direct grading rule.",
    ],
  };

  const recordLlmCounters = (llm) => {
    if (llm.cache_hit) cacheHitCount += 1;
    if (llm.mock_response_used) mockResponseCount += 1;
    if (llm.real_request_sent && !llm.cache_hit) realRequestCount += 1;
  };

  const runBatch = async (batch, {
    batchIndex,
    attempt = 1,
    retryOfBatchIndex = null,
    retryMode = "standard",
    strictJsonRetry = false,
    batchItemStartIndex = null,
  }) => {
    batchesAttempted += 1;
    const batchStarted = Date.now();
    const input = {
      review_scope: { scope: "title_only", abstract_used: false, full_text_used: false },
      rule_context_summary: effectiveRuleContext,
      retry_mode: retryMode,
      items: batch.map(({ _item, ...entry }) => entry),
    };
    const prompt = buildPrompt(batch, effectiveRuleContext, { strictJsonRetry });
    const promptTelemetry = buildPromptTelemetry(prompt);
    const llm = await callJsonLlm({
      taskType: "grade_review",
      prompt,
      input,
      runtime: { ...runtime, ...promptTelemetry },
      cachePath,
      cacheEnabled: config.cache_enabled !== false,
      llmClient,
      concurrencyController: controller,
    });
    recordLlmCounters(llm);
    const durationMs = Date.now() - batchStarted;
    batchTimingEntries.push({
      batch_index: batchIndex,
      retry_of_batch_index: retryOfBatchIndex,
      attempt,
      retry_mode: retryMode,
      item_count: batch.length,
      batch_item_start_index: Number.isFinite(Number(batchItemStartIndex)) ? Number(batchItemStartIndex) : null,
      batch_item_end_index: Number.isFinite(Number(batchItemStartIndex)) ? Number(batchItemStartIndex) + batch.length - 1 : null,
      duration_ms: durationMs,
      prompt_length: promptTelemetry.prompt_length,
      prompt_hash: promptTelemetry.prompt_hash,
      raw_response_length: Number.isFinite(Number(llm.raw_response_length)) ? Number(llm.raw_response_length) : null,
      parse_error_offset: Number.isFinite(Number(llm.parse_error_offset)) ? Number(llm.parse_error_offset) : null,
      ok: Boolean(llm.ok),
      parse_failure: isJsonParseFailure(llm),
      json_repaired: Boolean(llm.json_repaired),
      cache_hit: Boolean(llm.cache_hit),
      mock_response_used: Boolean(llm.mock_response_used),
      real_request_sent: Boolean(llm.real_request_sent),
      error_summary: llm.ok ? "" : String(llm.parse_error_summary || llm.error || llm.blocker || "").replace(/\s+/g, " ").trim().slice(0, 160),
    });
    if (llm.ok) {
      normalizedItems.push(...normalizeReviewOutput(llm.output));
      return { ok: true, llm, durationMs };
    }
    const diagnostic = summarizeLlmFailure(llm, {
      batchIndex,
      batchSize: batch.length,
      attempt,
      retryOfBatchIndex,
    });
    failedBatchDiagnostics.push(diagnostic);
    return { ok: false, llm, diagnostic, durationMs };
  };

  const batchDescriptors = [];
  for (let start = 0; start < reviewItems.length; start += batchSize) {
    batchDescriptors.push({
      start,
      batch: reviewItems.slice(start, start + batchSize),
      batchIndex: Math.floor(start / batchSize) + 1,
    });
  }

  const processBatch = async ({ batch, batchIndex, start }) => {
    if (typeof progressCallback === "function") {
      await progressCallback({
        stage: "llm_grade_review_batch",
        status: "started",
        batch_index: batchIndex,
        planned_batch_count: plannedBatchCount,
        batch_size: batch.length,
        batch_concurrency: batchConcurrency,
        cumulative_real_requests: realRequestCount,
      });
    }
    const result = await runBatch(batch, { batchIndex, attempt: 1, batchItemStartIndex: start });
    let finalResult = result;
    if (!result.ok && isJsonParseFailure(result.llm) && batch.length > 1) {
      retryBatchCount += 1;
      const retryResult = await runBatch(batch, {
        batchIndex,
        attempt: 2,
        retryOfBatchIndex: batchIndex,
        retryMode: "strict_json_retry",
        strictJsonRetry: true,
        batchItemStartIndex: start,
      });
      finalResult = retryResult;
      if (retryResult.ok) {
        retrySuccessCount += 1;
      } else if (isJsonParseFailure(retryResult.llm)) {
        const half = Math.ceil(batch.length / 2);
        const subBatches = [
          { items: batch.slice(0, half), startIndex: start },
          { items: batch.slice(half), startIndex: start + half },
        ].filter((entry) => entry.items.length > 0);
        splitBatchCount += subBatches.length;
        let splitFailures = 0;
        for (let i = 0; i < subBatches.length; i += 1) {
          const subBatch = subBatches[i];
          const subResult = await runBatch(subBatch.items, {
            batchIndex: `${batchIndex}.${i + 1}`,
            attempt: 3,
            retryOfBatchIndex: batchIndex,
            retryMode: "split_after_parse_failure",
            strictJsonRetry: true,
            batchItemStartIndex: subBatch.startIndex,
          });
          if (subResult.ok) {
            splitSuccessCount += 1;
          } else {
            splitFailures += 1;
            for (const item of subBatch.items) failedReviewItemIds.add(item.id);
            unresolvedFailureDiagnostics.push(subResult.diagnostic);
          }
        }
        finalResult = { ok: splitFailures === 0, llm: retryResult.llm, durationMs: retryResult.durationMs };
      } else {
        for (const item of batch) failedReviewItemIds.add(item.id);
        unresolvedFailureDiagnostics.push(retryResult.diagnostic);
      }
    } else if (!result.ok) {
      for (const item of batch) failedReviewItemIds.add(item.id);
      unresolvedFailureDiagnostics.push(result.diagnostic);
    }
    if (!finalResult.ok) {
      if (typeof progressCallback === "function") {
        await progressCallback({
          stage: "llm_grade_review_batch",
          status: "failed",
          batch_index: batchIndex,
          planned_batch_count: plannedBatchCount,
          batch_size: batch.length,
          batch_concurrency: batchConcurrency,
          cumulative_real_requests: realRequestCount,
          retry_batch_count: retryBatchCount,
          duration_ms: finalResult.durationMs,
          error: finalResult.llm.error || finalResult.llm.blocker || "llm_grade_review_failed",
        });
      }
    } else if (typeof progressCallback === "function") {
      await progressCallback({
        stage: "llm_grade_review_batch",
        status: "completed",
        batch_index: batchIndex,
        planned_batch_count: plannedBatchCount,
        batch_size: batch.length,
        batch_concurrency: batchConcurrency,
        success: true,
        cumulative_real_requests: realRequestCount,
        duration_ms: finalResult.durationMs,
        cache_hit: Boolean(finalResult.llm.cache_hit),
        mock_response_used: Boolean(finalResult.llm.mock_response_used),
      });
    }
    return finalResult;
  };

  await controller.map(batchDescriptors, processBatch, {
    classifyResult: (result) => result?.ok
      ? { ok: true }
      : { ok: false, reason: result?.llm?.error || result?.llm?.blocker || "llm_grade_review_failed" },
  });

  let report;
  {
    const { stats, applied } = applyReviewToItems(reviewItems, normalizedItems, { failedReviewItemIds });

    // Shadow gating diagnostics: simulate confidence-based gating without skipping any items
    const shadowGating = computeShadowGating(reviewItems, normalizedItems, failedReviewItemIds);

    for (const item of items) {
      if (!item.rule_grade) item.rule_grade = item.grade;
      if (!reviewScopeAllows(item.rule_grade, eligibleRuleGrades)) {
        item.semantic_grade = "";
        item.llm_review_grade = "";
        item.final_grade = item.rule_grade || item.grade;
        item.semantic_reason = "";
        item.semantic_confidence = 0;
        item.semantic_source = "";
        item.needs_human_review = false;
        item.disagreement_type = "";
      } else if (!item.final_grade) {
        item.semantic_grade = "";
        item.llm_review_grade = "";
        item.final_grade = item.rule_grade || item.grade;
        item.semantic_reason = "";
        item.semantic_confidence = 0;
        item.semantic_source = "";
        item.needs_human_review = false;
        item.disagreement_type = "";
      }
    }
    const hasFailedBatches = unresolvedFailureDiagnostics.length > 0;
    const timingDiagnostics = summarizeBatchTimings(batchTimingEntries, {
      plannedBatchCount,
      configuredBatchSize: batchSize,
      batchConcurrency,
      retryBatchCount,
      splitBatchCount,
      retrySuccessCount,
      splitSuccessCount,
    });
    report = {
      ...baseReport,
      ...stats,
      slimmed_schema_version: "v1-evidence-fields-removed",
      ok: !hasFailedBatches,
      skipped: false,
      blocker: hasFailedBatches ? "llm_grade_review_partial_failure" : "",
      error: hasFailedBatches ? (failedBatchDiagnostics[failedBatchDiagnostics.length - 1]?.parse_error_summary || "llm_grade_review_failed") : "",
      batch_size: batchSize,
      batch_concurrency: batchConcurrency,
      adaptive_concurrency: controller.snapshot(),
      batches_attempted: batchesAttempted,
      failed_batch_count: unresolvedFailureDiagnostics.length,
      retry_batch_count: retryBatchCount,
      retry_success_count: retrySuccessCount,
      split_batch_count: splitBatchCount,
      split_success_count: splitSuccessCount,
      failed_batches: unresolvedFailureDiagnostics,
      failed_batch_attempt_count: failedBatchDiagnostics.length,
      failed_batch_attempts: failedBatchDiagnostics,
      parse_failure_count: batchTimingEntries.filter((entry) => entry.parse_failure).length,
      repair_attempt_count: batchTimingEntries.filter((entry) => entry.parse_failure || entry.json_repaired).length,
      repair_success_count: batchTimingEntries.filter((entry) => entry.json_repaired).length,
      avg_response_length: timingDiagnostics.avg_response_length,
      max_response_length: timingDiagnostics.max_response_length,
      timing_diagnostics: timingDiagnostics,
      cache_hit: cacheHitCount > 0,
      cache_hit_count: cacheHitCount,
      mock_response_used: mockResponseCount > 0,
      mock_response_count: mockResponseCount,
      real_request_sent_count: realRequestCount,
      request_would_have_been_sent: realRequestCount > 0 || failedBatchDiagnostics.some((entry) => entry.request_would_have_been_sent),
      real_request_sent: realRequestCount > 0,
      shadow_gating: shadowGating,
      warnings: hasFailedBatches
        ? ["llm_grade_review_partial_failure", ...failedBatchDiagnostics.map((entry) => entry.parse_error_summary).filter(Boolean).slice(0, 3)]
        : [],
      items: applied,
    };
  }

  if (typeof progressCallback === "function") {
    await progressCallback({
      stage: "llm_grade_review",
      status: report.ok ? "completed" : "failed",
      eligible_count: reviewItems.length,
      planned_batch_count: plannedBatchCount,
      batch_concurrency: batchConcurrency,
      cumulative_real_requests: realRequestCount,
      items_with_semantic_grade: report.items_with_semantic_grade || 0,
      failed_batch_count: report.failed_batch_count || 0,
      retry_batch_count: report.retry_batch_count || 0,
      error: report.error || report.blocker || "",
    });
  }

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  }
  return report;
}

function computeShadowGating(reviewItems, normalizedItems, failedReviewItemIds) {
  const normalizedById = new Map(normalizedItems.map((entry) => [entry.id, entry]));
  const shadow = {
    enabled: true,
    mode: "diagnostic_only",
    gating_criteria_summary: "rule_grade confidence >= medium AND grade unchanged AND not near A/B or C/D boundary AND no conflict flags AND no human review marker AND no failed batch",
    skip_reasons: {},
  };
  let wouldSkipCount = 0;
  let wouldReviewCount = 0;

  for (const reviewItem of reviewItems) {
    if (failedReviewItemIds.has(reviewItem.id)) {
      wouldReviewCount += 1;
      continue;
    }
    const llm = normalizedById.get(reviewItem.id);
    if (!llm) {
      wouldReviewCount += 1;
      continue;
    }

    const ruleGrade = reviewItem.rule_grade;
    const llmGrade = llm.llm_review_grade;
    const confidence = llm.confidence || "low";
    const needsHumanReview = Boolean(llm.needs_human_review);
    const gradeChanged = Boolean(llmGrade && ruleGrade && llmGrade !== ruleGrade);
    const highConfidence = confidence === "high" || confidence === "medium";
    const notNearBoundary = !(
      (ruleGrade === "A" && llmGrade === "B") ||
      (ruleGrade === "B" && (llmGrade === "A" || llmGrade === "C")) ||
      (ruleGrade === "C" && (llmGrade === "B" || llmGrade === "D")) ||
      (ruleGrade === "D" && llmGrade === "C")
    );
    const noConflictFlags = !needsHumanReview;

    if (highConfidence && !gradeChanged && notNearBoundary && noConflictFlags) {
      wouldSkipCount += 1;
      shadow.skip_reasons.high_confidence_unchanged_no_conflict = (shadow.skip_reasons.high_confidence_unchanged_no_conflict || 0) + 1;
    } else {
      wouldReviewCount += 1;
      if (gradeChanged) {
        shadow.skip_reasons.grade_changed = (shadow.skip_reasons.grade_changed || 0) + 1;
      }
      if (!highConfidence) {
        shadow.skip_reasons.low_confidence = (shadow.skip_reasons.low_confidence || 0) + 1;
      }
      if (needsHumanReview) {
        shadow.skip_reasons.needs_human_review = (shadow.skip_reasons.needs_human_review || 0) + 1;
      }
    }
  }

  shadow.would_skip_count = wouldSkipCount;
  shadow.would_review_count = wouldReviewCount;
  shadow.would_skip_ratio = (wouldSkipCount + wouldReviewCount) > 0
    ? Number((wouldSkipCount / (wouldSkipCount + wouldReviewCount)).toFixed(4))
    : 0;

  // Among items that would be skipped, track if LLM would have changed their grade
  const wouldSkipChanged = normalizedItems.filter((n) => {
    const ri = reviewItems.find((r) => r.id === n.id);
    return Boolean(ri && n.llm_review_grade && n.llm_review_grade !== ri.rule_grade);
  });
  shadow.llm_changed_grade_count = wouldSkipChanged.length;
  shadow.llm_changed_grade_ratio = wouldSkipCount > 0
    ? Number((wouldSkipChanged.length / wouldSkipCount).toFixed(4))
    : 0;
  shadow.changed_item_keys_safe = wouldSkipChanged.slice(0, 20).map((n) => n.id);

  return shadow;
}
