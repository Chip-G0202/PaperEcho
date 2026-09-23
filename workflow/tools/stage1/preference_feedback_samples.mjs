// preference_feedback_samples.mjs
// Logic for building feedback semantic samples from learning signals.

import { nowIso, normalizeFeedback, directionFromFeedback, feedbackProfile, clamp, uniq, stableHash } from "./preference_utils.mjs";

// ─── Constants ───────────────────────────────────────────────────────

const TOPIC_PATTERNS = [
  { tag: "sglt2", label: "SGLT2", pattern: /\bsglt-?2\b/i },
  { tag: "glp-1", label: "GLP-1", pattern: /\bglp-?1\b/i },
  { tag: "diabetes", label: "diabetes", pattern: /\bdiabet/i },
  { tag: "obesity", label: "obesity", pattern: /\bobes/i },
  { tag: "heart_failure", label: "heart failure", pattern: /heart failure|心衰/i },
  { tag: "cardiovascular", label: "cardiovascular disease", pattern: /cardiovascular|心血管/i },
  { tag: "ckd", label: "CKD", pattern: /\bckd\b|chronic kidney disease|慢性肾病/i },
  { tag: "renal", label: "renal outcomes", pattern: /\brenal\b|kidney|肾/i },
  { tag: "hypertension", label: "hypertension", pattern: /hypertension|blood pressure|高血压/i },
  { tag: "mortality", label: "mortality", pattern: /mortality|death|死亡/i },
  { tag: "hospitalization", label: "hospitalization", pattern: /hospitali[sz]ation|住院/i },
  { tag: "safety", label: "safety outcomes", pattern: /safety|adverse|不良反应|安全性/i },
];

const STUDY_PATTERNS = [
  { tag: "randomized_trial", label: "randomized trial", pattern: /randomi[sz]ed|clinical trial|试验/i },
  { tag: "meta_analysis", label: "meta-analysis", pattern: /meta-analysis|systematic review|系统综述|荟萃/i },
  { tag: "cohort", label: "cohort", pattern: /cohort|registry|队列/i },
  { tag: "guideline", label: "guideline", pattern: /guideline|consensus|指南|共识/i },
  { tag: "case_report", label: "case report", pattern: /case report|病例/i },
  { tag: "animal_study", label: "animal study", pattern: /animal|mouse|mice|rat|rats|zebrafish|小鼠|大鼠|斑马鱼/i },
  { tag: "in_vitro", label: "体外细胞实验", pattern: /in vitro|cell line|细胞实验|细胞系/i },
  { tag: "mechanistic_study", label: "mechanistic study", pattern: /mechanis|pathway|signaling|通路|机制/i },
  { tag: "human_outcome", label: "human clinical outcome", pattern: /patient|human|clinical outcome|hard endpoint|人群|临床结局|硬终点/i },
];

const EXCLUSION_PATTERNS = [
  { tag: "animal_only", label: "animal-only", pattern: /仅动物|animal only|animal study|动物实验|动物研究|动物|mouse|mice|rat|rats|zebrafish|小鼠|大鼠|斑马鱼/i },
  { tag: "in_vitro_only", label: "in-vitro only", pattern: /in vitro|cell line|细胞实验|细胞系/i },
  { tag: "basic_mechanism_only", label: "basic mechanism only", pattern: /基础机制|mechanis|pathway|signaling|通路|机制/i },
  { tag: "irrelevant_disease_context", label: "irrelevant disease context", pattern: /无关|不相关|irrelevant/i },
  { tag: "low_evidence", label: "low evidence", pattern: /low evidence|证据弱|证据不足/i },
  { tag: "non_medical", label: "non-medical", pattern: /architecture|social media|digital media|虚拟建筑|社交媒体|心理学/i },
];

// ─── Helper Functions ────────────────────────────────────────────────

function matchTags(text, patterns) {
  const haystack = String(text || "");
  return patterns.filter((entry) => entry.pattern.test(haystack)).map((entry) => entry.tag);
}

export function pickTopicLabels(tags) {
  const lookup = new Map(TOPIC_PATTERNS.map((entry) => [entry.tag, entry.label]));
  return tags.map((tag) => lookup.get(tag) || tag);
}

export function pickScopeLabels(tags) {
  const studyLookup = new Map(STUDY_PATTERNS.map((entry) => [entry.tag, entry.label]));
  const exclusionLookup = new Map(EXCLUSION_PATTERNS.map((entry) => [entry.tag, entry.label]));
  return tags.map((tag) => studyLookup.get(tag) || exclusionLookup.get(tag) || tag);
}

export function summarizeNeighbors(results = []) {
  return (results || []).slice(0, 3).map((entry) => entry?.title).filter(Boolean).join(" | ");
}

function inferEvidenceFeatures({
  comment = "",
  titleContext = "",
  englishTitle = "",
  titleTranslation = "",
  direction = "ignored",
  feedbackStrength = "ignored",
}) {
  const commentText = String(comment || "").trim();
  const titleText = [titleContext, titleTranslation, englishTitle].filter(Boolean).join(" ");
  const fullText = [commentText, titleText].filter(Boolean).join(" ");
  const topicTags = uniq([
    ...matchTags(commentText, TOPIC_PATTERNS),
    ...matchTags(titleText, TOPIC_PATTERNS),
  ]);
  const studyTags = uniq([
    ...matchTags(commentText, STUDY_PATTERNS),
    ...matchTags(titleText, STUDY_PATTERNS),
  ]);
  const exclusionTags = uniq([
    ...matchTags(commentText, EXCLUSION_PATTERNS),
    ...matchTags(titleText, EXCLUSION_PATTERNS),
  ]);
  const keyTerms = uniq([...topicTags, ...studyTags, ...exclusionTags]);
  const clinicalFocus = topicTags.some((tag) => ["heart_failure", "cardiovascular", "renal", "ckd", "mortality", "hospitalization", "safety"].includes(tag))
    || studyTags.includes("human_outcome")
    || /clinical outcome|hard endpoint|临床结局|硬终点/i.test(fullText);
  const prefersClinicalOverMechanism = direction === "positive" && /人群结局|临床结局|硬终点|比机制更重要|关注.*结局/i.test(commentText);
  const titleOnly = !commentText;
  let scopeTags = uniq([
    ...studyTags.filter((tag) => ["randomized_trial", "meta_analysis", "cohort", "guideline", "case_report", "animal_study", "in_vitro", "mechanistic_study", "human_outcome"].includes(tag)),
    ...exclusionTags,
    ...(clinicalFocus ? ["clinical_outcome"] : []),
  ]);
  if (prefersClinicalOverMechanism) {
    scopeTags = scopeTags.filter((tag) => !["mechanistic_study", "basic_mechanism_only"].includes(tag));
  }
  const extractedReason = commentText || titleContext || titleTranslation || englishTitle || "";
  const extractedTerms = uniq([
    ...pickTopicLabels(topicTags),
    ...pickScopeLabels(scopeTags),
  ]);

  let preferenceHint = "needs_more_feedback";
  if (direction === "positive") {
    preferenceHint = clinicalFocus || feedbackStrength === "upgrade" ? "strong_positive" : "soft_positive";
  } else if (direction === "negative") {
    preferenceHint = exclusionTags.length || feedbackStrength === "drop" ? "negative_preference" : "exclusion_hint";
  } else if (direction === "ambiguous") {
    preferenceHint = "ambiguous";
  }

  return {
    topic_tags: topicTags,
    study_tags: studyTags,
    exclusion_tags: exclusionTags,
    scope_tags: scopeTags,
    key_terms: keyTerms,
    extracted_terms: extractedTerms,
    extracted_reason: extractedReason,
    clinical_focus: clinicalFocus,
    title_only: titleOnly,
    preference_hint: preferenceHint,
  };
}

function buildEvidenceId(sourceFile, row, feedback, titleContext, comment) {
  return `evidence-${stableHash([sourceFile, row, feedback, titleContext, comment].join("|"))}`;
}

function buildEvidenceRecord(signal, sourceFile, generatedAt) {
  const feedback = normalizeFeedback(signal.feedback);
  const direction = signal.ambiguous_reason ? "ambiguous" : directionFromFeedback(feedback);
  const feedbackMeta = feedbackProfile(feedback);
  const comment = String(signal.comment || "").trim();
  const englishTitle = String(signal.english_title || "").trim();
  const titleTranslation = String(signal.title_translation || "").trim();
  const titleContext = String(signal.title_context || titleTranslation || englishTitle || "").trim();
  const titleTranslationMissing = Boolean(signal.title_translation_missing || !titleTranslation);
  const commentEmpty = !comment;
  const acceptedForLearning = direction === "positive" || direction === "negative" || direction === "ambiguous";
  let confidence = 0.58;
  if (direction === "positive" || direction === "negative") confidence += 0.06 + (feedbackMeta.weight * 0.02);
  if (!commentEmpty) confidence += 0.1;
  if (titleTranslationMissing) confidence -= 0.09;
  if (commentEmpty) confidence -= 0.12;
  if (direction === "ambiguous") confidence -= 0.14;
  if (direction === "ignored") confidence = 0;

  const features = inferEvidenceFeatures({
    comment,
    titleContext,
    englishTitle,
    titleTranslation,
    direction,
    feedbackStrength: feedbackMeta.strength,
  });

  const evidenceId = buildEvidenceId(sourceFile, signal.row || -1, feedback, titleContext, comment);
  return {
    evidence_id: evidenceId,
    row_index: Number(signal.row || -1),
    source_file: sourceFile,
    source_sheet: "每日反馈",
    source_row: Number(signal.row || -1),
    feedback,
    comment,
    english_title: englishTitle,
    title_translation: titleTranslation,
    title_context: titleContext,
    title_context_source: titleTranslation ? "title_translation" : "english_title_fallback",
    direction,
    feedback_strength: feedbackMeta.strength,
    feedback_weight: feedbackMeta.weight,
    confidence: clamp(Number(confidence.toFixed(2)), 0, 0.95),
    extracted_terms: features.extracted_terms,
    extracted_reason: features.extracted_reason,
    comment_empty: commentEmpty,
    title_translation_missing: titleTranslationMissing,
    accepted_for_learning: acceptedForLearning,
    accepted_for_preference_update: acceptedForLearning,
    ignored_reason: acceptedForLearning ? "" : (feedback ? "unsupported_feedback_value" : "missing_feedback"),
    ambiguous_reason: String(signal.ambiguous_reason || ((direction === "ignored" && feedback) ? "unrecognized_feedback" : "")).trim(),
    created_at: nowIso(generatedAt),
    semantic_query: [titleContext, comment].filter(Boolean).join("; "),
    evidence_fields: {
      used_title_translation: Boolean(titleTranslation),
      used_english_title_fallback: !titleTranslation,
      used_comment: !commentEmpty,
    },
    missing_title_translation: titleTranslationMissing,
    preference_type: features.preference_hint,
    topic_tags: features.topic_tags,
    study_tags: features.study_tags,
    exclusion_tags: features.exclusion_tags,
    scope_tags: features.scope_tags,
    key_terms: features.key_terms,
    title_only: features.title_only,
  };
}

// ─── Exported Functions ──────────────────────────────────────────────

export function buildFeedbackSemanticSamples(feedbackLearning = {}, sourceFile = "", options = {}) {
  const signals = Array.isArray(feedbackLearning.signals) ? feedbackLearning.signals : [];
  const generatedAt = nowIso(options.generatedAt);
  return signals.map((signal) => buildEvidenceRecord(signal, sourceFile, generatedAt));
}
