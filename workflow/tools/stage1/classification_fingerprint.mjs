import { hashInput } from "../lib/llm_json_support.mjs";
import {
  getLiteratureDedupeFingerprints,
  getLiteratureIdentityKeys,
  normalizeTitleForExistingDedupe,
} from "../lib/literature_identity.mjs";

export const CLASSIFICATION_FINGERPRINT_SCHEMA_VERSION = 1;
export const CLASSIFIER_SCHEMA_VERSION = "paper-echo-weekly-classifier-v1";

function clean(value) { return String(value || "").trim(); }
function grade(value) { return clean(value).slice(0, 1).toUpperCase(); }

function normalizeAuthors(value) {
  const values = Array.isArray(value) ? value : clean(value) ? [value] : [];
  return values.map((author) => {
    if (typeof author === "string") return clean(author).toLowerCase();
    return clean(author?.name || [author?.firstName, author?.lastName].filter(Boolean).join(" ")).toLowerCase();
  }).filter(Boolean);
}

export function classificationMetadata(item = {}) {
  const identity = getLiteratureDedupeFingerprints(item);
  return {
    title: normalizeTitleForExistingDedupe(item.title || ""),
    journal: clean(item.journal || item.publicationTitle || item.source_title).normalize("NFKC").toLowerCase(),
    authors: normalizeAuthors(item.authors || item.creators || item.author),
    abstract: clean(item.abstract || item.abstractNote || item.summary).normalize("NFKC").replace(/\s+/g, " "),
    publicationType: clean(item.publication_type || item.publicationType || item.itemType).toLowerCase(),
    doi: identity.doi,
    pmid: identity.pmid,
    pmcid: identity.pmcid,
    arxiv: identity.arxiv,
    openalex: identity.openalex,
    url: identity.url,
  };
}

function feedbackSemanticInput(feedback = {}) {
  const signals = Array.isArray(feedback.signals) ? feedback.signals : [];
  const normalizeSignal = (item = {}) => ({
    title: clean(item.title || item.english_title || item["英文标题"]),
    translatedTitle: clean(item.translated_title || item.title_translation || item["标题翻译"] || item["中文标题"]),
    feedback: clean(item.feedback || item.action).toLowerCase(),
    comment: clean(item.comment || item.user_comment || item["评价"] || item["备注"]),
  });
  return {
    hardPositiveTerms: [...new Set((feedback.hardPositiveTerms || []).map(clean).filter(Boolean))].sort(),
    hardNegativeTerms: [...new Set((feedback.hardNegativeTerms || []).map(clean).filter(Boolean))].sort(),
    signals: signals.map(normalizeSignal).filter((item) => item.title || item.translatedTitle || item.feedback || item.comment),
    metaPreferenceSignals: Array.isArray(feedback.metaPreferenceSignals) ? feedback.metaPreferenceSignals : [],
  };
}

function standardsSemanticInput(standards = {}) {
  return {
    topicDefinition: standards.topic_definition || "",
    hardExcludes: standards.hard_excludes || [],
    positivePreferences: standards.positive_preferences || [],
    negativePreferences: standards.negative_preferences || [],
    gradeRules: standards.grade_rules || {},
    caveats: standards.caveats || [],
  };
}

export function stableModelProviderConfig(runtime = {}) {
  const runtimeMode = clean(runtime.llm_mode || "real").toLowerCase();
  return {
    provider: clean(runtime.provider || runtime.vendor),
    endpoint: clean(runtime.endpoint).toLowerCase(),
    model: clean(runtime.model),
    mode: runtimeMode === "mock" ? "mock" : "real",
  };
}

export function stableModelParameters(runtime = {}) {
  return {
    temperature: runtime.temperature ?? 0,
    topP: runtime.top_p ?? 1,
    maxOutputTokens: runtime.max_output_tokens ?? 3000,
    thinking: runtime.thinking && typeof runtime.thinking === "object" ? runtime.thinking : clean(runtime.thinking),
    stream: false,
  };
}

export function buildClassificationContext({
  workflowRules = {},
  screeningStandards = {},
  feedbackLearning = {},
  promptHash = "",
  ruleContextHash = "",
  runtime = {},
  classifierCodeVersion = "",
} = {}) {
  return {
    schemaVersion: CLASSIFICATION_FINGERPRINT_SCHEMA_VERSION,
    gradingRulesHash: hashInput(workflowRules?.config || workflowRules || {}),
    userCriteriaFeedbackHash: hashInput({
      standards: standardsSemanticInput(screeningStandards),
      feedback: feedbackSemanticInput(feedbackLearning),
    }),
    promptHash: clean(promptHash),
    ruleContextHash: clean(ruleContextHash),
    modelProviderConfigHash: hashInput(stableModelProviderConfig(runtime)),
    modelParametersHash: hashInput(stableModelParameters(runtime)),
    classifierCodeVersion: clean(classifierCodeVersion),
    classifierSchemaVersion: CLASSIFIER_SCHEMA_VERSION,
  };
}

export function classificationContextComplete(context = {}) {
  const hashes = [
    context.gradingRulesHash,
    context.userCriteriaFeedbackHash,
    context.promptHash,
    context.ruleContextHash,
    context.modelProviderConfigHash,
    context.modelParametersHash,
  ];
  return context.schemaVersion === CLASSIFICATION_FINGERPRINT_SCHEMA_VERSION
    && hashes.every((value) => /^[a-f0-9]{64}$/.test(String(value || "")))
    && Boolean(clean(context.classifierCodeVersion))
    && context.classifierSchemaVersion === CLASSIFIER_SCHEMA_VERSION;
}

export function buildClassificationFingerprintRecord(item = {}, context = {}) {
  const canonicalIdentity = getLiteratureIdentityKeys(item)[0] || "";
  const metadataHash = hashInput(classificationMetadata(item));
  const parts = {
    schemaVersion: CLASSIFICATION_FINGERPRINT_SCHEMA_VERSION,
    canonicalIdentity,
    metadataHash,
    gradingRulesHash: context.gradingRulesHash || "",
    userCriteriaFeedbackHash: context.userCriteriaFeedbackHash || "",
    promptHash: context.promptHash || "",
    ruleContextHash: context.ruleContextHash || "",
    modelProviderConfigHash: context.modelProviderConfigHash || "",
    classifierCodeVersion: context.classifierCodeVersion || "",
    classifierSchemaVersion: context.classifierSchemaVersion || "",
    modelParametersHash: context.modelParametersHash || "",
    ruleGrade: grade(item.rule_grade || item.ruleGrade || item.grade),
  };
  const complete = Boolean(canonicalIdentity && parts.ruleGrade && classificationContextComplete(context));
  return { fingerprint: hashInput(parts), parts, complete };
}

export function buildClassificationSnapshot(item = {}) {
  return {
    ruleGrade: grade(item.rule_grade || item.ruleGrade || item.grade),
    llmGrade: grade(item.llm_review_grade || item.llmGrade || item.semantic_grade),
    finalGrade: grade(item.final_grade || item.finalGrade || item.grade),
    semanticReason: clean(item.semantic_reason),
    semanticConfidence: item.semantic_confidence ?? null,
    semanticSource: clean(item.semantic_source),
    needsHumanReview: Boolean(item.needs_human_review),
    disagreementType: clean(item.disagreement_type),
  };
}

export function classificationSnapshotComplete(snapshot = {}) {
  return Boolean(grade(snapshot.ruleGrade) && grade(snapshot.llmGrade) && grade(snapshot.finalGrade));
}

export function applyClassificationSnapshot(item, snapshot = {}) {
  item.rule_grade = grade(snapshot.ruleGrade);
  item.llm_review_grade = grade(snapshot.llmGrade);
  item.semantic_grade = grade(snapshot.llmGrade);
  item.final_grade = grade(snapshot.finalGrade);
  item.semantic_reason = clean(snapshot.semanticReason);
  item.semantic_confidence = snapshot.semanticConfidence ?? 0;
  item.semantic_source = clean(snapshot.semanticSource) || "llm_title_review_grade";
  item.needs_human_review = Boolean(snapshot.needsHumanReview);
  item.disagreement_type = clean(snapshot.disagreementType);
  return item;
}

export function hasReliableLlmClassification(item = {}) {
  return Boolean(grade(item.llm_review_grade || item.semantic_grade))
    && new Set(["llm_title_review", "llm_title_review_grade"]).has(clean(item.semantic_source));
}
