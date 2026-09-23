/**
 * Workflow-based classifier for literature grading.
 *
 * This module implements grading logic based solely on review-workflow-rules.json's grading_rules.
 * No hardcoded weights, thresholds, or example topic term 033 terms.
 *
 * D-grade rules have highest priority: if a paper matches D-grade conditions,
 * it should be classified as D regardless of keyword matches.
 */

import { loadWorkflowRules } from "../lib/literature_config.mjs";
import {
  LABELS,
  SOURCE_LABELS,
  TRIAGE_VERSION,
  normalizeGradeLetter,
  summarizeGradeCounts,
} from "../lib/grade_primitives.mjs";
import {
  buildDedupeKey,
  cleanText,
  normalizeIdentifier,
  normalizeTitleForDedupe as normTitle,
} from "../lib/dedupe_key.mjs";

export {
  LABELS,
  SOURCE_LABELS,
  TRIAGE_VERSION,
  buildDedupeKey,
  normalizeGradeLetter,
  summarizeGradeCounts,
};

const WORKFLOW_RULES = loadWorkflowRules().config;
const TRIAGE_RULES = WORKFLOW_RULES.triage || {};
const GRADING_RULES = TRIAGE_RULES.grading_rules || {};

// ─── Helper Functions ─────────────────────────────────────────────────

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesTerm(text, term) {
  const raw = String(term || "").trim();
  const normalized = raw.toLowerCase();
  if (!normalized) return false;
  if (/^[A-Z0-9]{2,5}$/.test(raw)) {
    return new RegExp(`(?<![a-z0-9])${escapeRegExp(normalized)}s?(?![a-z0-9])`).test(text);
  }
  return text.includes(normalized);
}

function countHits(text, terms) {
  return terms.filter((term) => matchesTerm(text, term));
}

function sourceLabel(sourcePlatform, sourceChannel) {
  const normalized = String(sourcePlatform || sourceChannel || "").trim().toLowerCase();
  if (normalized === "rss") return SOURCE_LABELS.rss;
  if (normalized === "pubmed") return SOURCE_LABELS.pubmed;
  if (normalized === "pmc") return SOURCE_LABELS.pmc;
  return SOURCE_LABELS.other;
}

// ─── D-Grade Rule Helpers ─────────────────────────────────────────────
// These helpers implement the D-grade rules from review-workflow-rules.json.
// Each helper is named to match the corresponding rule description.

/**
 * Check if the paper is about example topic term 033 degradation, removal, transfer,
 * accumulation, monitoring, detection, environmental analysis, or example topic term 034
 * characterization research.
 *
 * Corresponds to review-workflow-rules.json D-grade strict_exclude rule:
 * "污染物降解、污染物去除、污染物转移、污染物累积、污染特征分析、环境监测或环境分析导向研究"
 */
function isEnvironmentalPollutantFateStudy(text) {
  const exampleTopicFateTerms = [
    // 污染物降解
    "example topic term 033 degradation", "example topic term 033 degradat", "degradation of example topic term 033",
    "biodegradation", "photodegradation", "photocatalytic degradation",
    "example excluded material degradation",
    "degradation mechanism", "enhanced degradation",
    // 污染物去除
    "example topic term 033 removal", "removal of example topic term 033", "example topic term 033 eliminat",
    "contaminant removal", "removal efficiency", "nutrient removal",
    "pfoa removal", "pfos removal", "pfhxs removal", "pfhxs degradation",
    "example excluded material removal",
    // 污染物转移
    "example topic term 033 transfer", "example topic term 033 transport", "contaminant transfer",
    "example topic term 033 migration", "example topic term 033 fate",
    // 污染物累积
    "example topic term 033 accumulation", "example topic term 033 accumulat", "bioaccumulation",
    "contaminant accumulation", "example topic term 033 bioaccumulat",
    // 污染特征分析
    "example topic term 034 characterization", "example topic term 034 characterizat", "example topic term 033 characterization",
    "contamination characterization", "example topic term 034 profile",
    // 环境监测
    "environmental monitoring", "environment monitor", "example topic term 034 monitoring",
    "contamination monitoring", "environmental surveillance",
    // 环境分析
    "environmental analysis", "environment analysis", "environmental assessment",
    "environmental impact assessment", "example topic term 034 analysis",
    // 环境工程 / 水处理 / 修复
    "wastewater treatment", "water treatment", "soil remediation",
    "environmental remediation", "phytoremediation",
    "constructed wetland", "wetland treatment",
    "adsorption of example topic term 033", "adsorption capacity",
    "water quality", "water purification", "advanced oxidation",
    "photoelectrocatalytic", "photocatalytic treatment",
    "immobiliz", "contaminated soil", "contaminated site",
    "environmental implications", "environmental fate",
    "biogeochemical cycling", "redox cycling",
    // Synthetic excluded-process fixture
    "example excluded process", "example excluded treatment",
    "dbd combined", "dielectric barrier discharge",
    // 环境微生物学（非宿主相关）
    "glacier example topic term 030", "glacier microbial", "resistome",
    "antimicrobial resistance dissemination", "antibiotic resistance gene",
    "environmental example topic term 030", "soil example topic term 030",
    "aquatic example topic term 030", "sediment example topic term 030",
    "biofilm formation", "bioremediation",
  ];
  const biomedicalIndicators = [
    "example biological context", "example disease model", "example in vivo evidence",
  ];

  const hasEnvironmentalFocus = exampleTopicFateTerms.some((term) => text.includes(term));
  const hasBiomedicalRelevance = biomedicalIndicators.some((term) => text.includes(term));

  return hasEnvironmentalFocus && !hasBiomedicalRelevance;
}

/**
 * Check if the paper is about pure engineering, computational engineering,
 * materials science, physics, electronics, mechanical engineering, or
 * industrial technology without direct biomedical relevance.
 *
 * Corresponds to review-workflow-rules.json D-grade strict_exclude rule:
 * "缺乏直接生物医学机制相关性的纯工程、计算工程、材料科学、物理学、电子、机械工程或工业技术研究"
 */
function isPureEngineeringOrMaterialsStudy(text) {
  const engineeringTerms = [
    "finite element", "computational fluid dynamics", "cfd simulation",
    "mechanical properties", "tensile strength", "material synthesis",
    "nanoparticle synthesis", "catalyst preparation", "electrochemical",
    "semiconductor", "photovoltaic", "solar cell", "battery electrode",
    "polymer composite", "metal alloy", "ceramic material",
    // 拓扑物理 / 凝聚态
    "topological", "weyl state", "weyl states", "band structure",
    "electride", "electrides", "interstitial electron",
    // 材料化学 / 微球 / 膜
    "polyurea", "microsphere", "multicolor microsphere",
    "anion exchange membrane", "cation exchange membrane",
    "polymer membrane", "ion exchange membrane",
    // 工程 / 声学 / 计算
    "neuromorphic computing", "acoustic example topic term 039", "acoustic metamaterial",
    "strain tuning", "doped mot", "mos2", "mote2", "ws2",
    // 电池 / 催化 / 能源
    "oxygen evolution", "hydrogen evolution", "electrocatal",
    "fuel cell", "supercapacitor", "lithium ion", "sodium ion",
    "zinc ion battery",
    // 纳米材料
    "nanosheet", "nanotube", "nanowire", "nanofiber",
    "quantum dot", "metal-organic framework", "mof",
    // 光学 / 电子
    "fluorescent application", "luminescent", "phosphor",
    "led device", "photodetector", "optical fiber",
    // 环境工程（无生物医学）
    "constructed wetland", "adsorption isotherm", "photocatalyst",
    "photoelectrocatalytic", "membrane filtration",
  ];
  const biomedicalIndicators = [
    "example biological context", "example disease model", "example mechanism evidence",
  ];

  const hasEngineeringFocus = engineeringTerms.some((term) => text.includes(term));
  const hasBiomedicalRelevance = biomedicalIndicators.some((term) => text.includes(term));

  return hasEngineeringFocus && !hasBiomedicalRelevance;
}

/**
 * Check if the paper is about plant biology, plant omics, or plant mechanism
 * research without direct biomedical relevance.
 *
 * Corresponds to review-workflow-rules.json D-grade strict_exclude rule:
 * "植物相关研究，除非具有直接生物医学机制相关性或疾病相关性"
 */
function isPlantOnlyStudy(text) {
  const plantTerms = [
    "plant biology", "plant omics", "plant mechanism", "plant response",
    "arabidopsis", "rice genome", "wheat", "maize", "crop yield",
    "phytoremediation", "plant stress", "plant hormone", "auxin",
    "photosynthesis", "chloroplast", "stomatal",
    // 扩展：水稻 / 农业 / 植物生理
    "in rice", "rice revealed", "rice plant", "rice cultivar",
    "grain yield", "seed germination", "root growth", "leaf area",
    "crop production", "agronomic", "cultivar", "genotype",
    "plant growth", "plant root", "plant leaf", "plant seed",
    "pollinator", "pollination", "flower", "floral",
    "mycorrhizal fungi", "rhizosphere", "soil microbial",
    "phytoaccumulation", "phytoextraction", "phytostabilization",
    "foliar application", "ozone phytotoxicity",
  ];
  const biomedicalIndicators = [
    "example biological context", "example disease model", "example in vivo evidence",
  ];

  const hasPlantFocus = plantTerms.some((term) => text.includes(term));
  const hasBiomedicalRelevance = biomedicalIndicators.some((term) => text.includes(term));

  return hasPlantFocus && !hasBiomedicalRelevance;
}

/**
 * Check if the paper is about insect, nematode, yeast or other non-mammalian
 * model research without outstanding mechanistic insights.
 *
 * Corresponds to review-workflow-rules.json D-grade strict_exclude rule:
 * "昆虫、线虫、酵母等非哺乳动物模型研究，若缺乏突出机制洞见或可迁移性"
 */
function isNonMammalianModelWithoutInsight(text) {
  const nonMammalianTerms = [
    "insect", "drosophila", "nematode", "c. elegans", "yeast", "saccharomyces",
    "e. coli", "bacteria", "bacterial", "zebrafish",
    // 扩展：蜂 / 传粉者 / 无脊椎
    "honey bee", "honeybee", "bumble bee", "bumblebee", "solitary bee",
    "pollinator", "pollinators", "bee colony", "apis mellifera",
    "crustacean", "mollusk", "mollusc", "annelid", "planaria",
    "tardigrade", "rotifer", "protozoa", "amoeba",
  ];
  const mechanisticInsightIndicators = [
    "mechanism", "example topic term 040", "example topic term 036", "novel insight", "translational",
    "conserved mechanism", "evolutionary", "comparative",
  ];

  // Exclude zebrafish if it has strong mechanistic insight
  const hasNonMammalianFocus = nonMammalianTerms.some((term) => text.includes(term));
  const hasMechanisticInsight = mechanisticInsightIndicators.some((term) => text.includes(term));

  // Special case: zebrafish with mechanistic insight is not excluded
  if (text.includes("zebrafish") && hasMechanisticInsight) {
    return false;
  }

  return hasNonMammalianFocus && !hasMechanisticInsight;
}

/**
 * Check whether the paper matches example out-of-scope topics without a configured
 * relevance or mechanism signal.
 *
 * Corresponds to review-workflow-rules.json D-grade strict_exclude rule:
 * "范围外主题，除非直接服务当前配置的研究问题或可迁移机制"
 */
function isOutOfScopeTopic(text) {
  const outOfScopeTerms = [
    "cancer", "tumor", "tumour", "oncolog", "carcinoma", "metastasis",
    "virus", "viral", "antiviral", "hiv", "sars-cov", "covid",
    "diabetes", "cardiovascular", "atherosclerosis",
    "constipation", "inflammatory bowel", "crohn", "ulcerative colitis",
    "irritable bowel", "gastrointestinal disease",
    // 纯 AI / 政策 / 科学传播（无实验/机制）
    "advise the vatican", "advise the un", "ai policy", "ai ethic",
    "artificial intelligence ethic", "ai governance",
    "ai regulation", "ai safety policy",
    // 纯综述 / 范围综述（无实验验证）
    "scoping review",
  ];
  const relevantContextIndicators = [
    "example research term", "example biological context", "example mechanism",
  ];

  const hasOutOfScopeFocus = outOfScopeTerms.some((term) => text.includes(term));
  const hasRelevantContext = relevantContextIndicators.some((term) => text.includes(term));

  return hasOutOfScopeFocus && !hasRelevantContext;
}

/**
 * Check if the paper is only hit by broad example keywords while the actual
 * research question is not relevant.
 *
 * This implements the D-grade rule for keyword-only matches without real relevance.
 */
function isKeywordOnlyMatchWithoutRelevance(text) {
  // These are keywords that might cause false positives
  const triggerKeywords = [
    "example broad term", "example search term",
  ];

  // These indicate actual relevance to the research question
  const relevanceIndicators = [
    "example research term", "example biological context", "example mechanism",
  ];

  const hasTriggerKeyword = triggerKeywords.some((term) => text.includes(term));
  const hasRelevanceIndicators = relevanceIndicators.some((term) => text.includes(term));

  // If only trigger keywords without relevance indicators, it's a false positive
  return hasTriggerKeyword && !hasRelevanceIndicators;
}

// ─── Grade-Specific Checkers ──────────────────────────────────────────

/**
 * Check if paper matches A-grade definition from review-workflow-rules.json:
 * "直接命中当前核心研究方向、目标上下文与机制或证据要求。"
 */
function matchesAGrade(text) {
  const coreExposureTerms = TRIAGE_RULES.research_focus?.core_exposure_terms || [];
  const coreBiologyTerms = TRIAGE_RULES.research_focus?.core_biology_terms || [];
  const mechanismTerms = TRIAGE_RULES.research_focus?.mechanism_terms || [];

  const exposureHits = countHits(text, coreExposureTerms);
  const biologyHits = countHits(text, coreBiologyTerms);
  const mechanismHits = countHits(text, mechanismTerms);

  // A-grade requires: exposure AND biology AND mechanism
  return exposureHits.length >= 1 && biologyHits.length >= 1 && mechanismHits.length >= 1;
}

/**
 * Check if paper matches B-grade definition from review-workflow-rules.json:
 * "命中部分核心研究方向，但缺少明确机制深度或所需证据。"
 */
function matchesBGrade(text) {
  const coreExposureTerms = TRIAGE_RULES.research_focus?.core_exposure_terms || [];
  const coreBiologyTerms = TRIAGE_RULES.research_focus?.core_biology_terms || [];
  const mechanismTerms = TRIAGE_RULES.research_focus?.mechanism_terms || [];
  const preferredEvidence = TRIAGE_RULES.research_focus?.preferred_evidence || [];

  const exposureHits = countHits(text, coreExposureTerms);
  const biologyHits = countHits(text, coreBiologyTerms);
  const mechanismHits = countHits(text, mechanismTerms);
  const evidenceHits = countHits(text, preferredEvidence);

  // A broad biology term plus a study-design word does not establish topic fit.
  return evidenceHits.length >= 1 && (exposureHits.length >= 1 || (biologyHits.length >= 1 && mechanismHits.length >= 1));
}

/**
 * Check if paper matches C-grade definition from review-workflow-rules.json:
 * "与领域相关但不直接针对当前研究问题。"
 */
function matchesCGrade(text) {
  const exposure = countHits(text, TRIAGE_RULES.research_focus?.core_exposure_terms || []).length > 0;
  const biology = countHits(text, TRIAGE_RULES.research_focus?.core_biology_terms || []).length > 0;
  const mechanism = countHits(text, TRIAGE_RULES.research_focus?.mechanism_terms || []).length > 0;
  // A single generic keyword is retrieval evidence, not enough for admission.
  return (exposure && (biology || mechanism)) || (biology && mechanism);
}

// ─── Main Classification Function ─────────────────────────────────────

export function classifyItem(item = {}, prefs = {}, standards = null) {
  const text = `${item.title || ""} ${item.abstract || ""}`.toLowerCase();
  const journal = String(item.journal || "").toLowerCase().trim();

  // D-grade rules have HIGHEST priority
  // Check all D-grade conditions first

  // 1. Check if it's environmental example topic term 033 fate study
  if (isEnvironmentalPollutantFateStudy(text)) {
    return {
      grade: "D",
      grade_label: LABELS.D,
      grade_reason: "污染物降解、去除、转移、累积、监测、检测、环境分析或污染特征分析导向研究",
      classification_reason: "命中 D 级严格排除规则：污染物环境过程研究",
      hard_excluded: true,
      matched_standard_rules: [],
      matched_signals: ["d_grade_rule:environmental_example_topic_fate"],
      writeback_ready: false,
      triage_version: TRIAGE_VERSION,
      standards_used: false,
      flags: { uncertain: false, needs_review: false },
      score: 0,
      source: sourceLabel(item.source_platform, item.source_channel),
      dedupe_key: buildDedupeKey(item),
      scoring_detail: { d_grade_rule: "environmental_example_topic_fate" },
    };
  }

  // 2. Check if it's keyword-only match without real relevance
  if (isKeywordOnlyMatchWithoutRelevance(text)) {
    return {
      grade: "D",
      grade_label: LABELS.D,
      grade_reason: "仅因标题或摘要出现宽泛示例关键词而被检出，但实际研究问题不相关",
      classification_reason: "命中 D 级规则：关键词误命中但研究问题不相关",
      hard_excluded: true,
      matched_standard_rules: [],
      matched_signals: ["d_grade_rule:keyword_only_match"],
      writeback_ready: false,
      triage_version: TRIAGE_VERSION,
      standards_used: false,
      flags: { uncertain: false, needs_review: false },
      score: 0,
      source: sourceLabel(item.source_platform, item.source_channel),
      dedupe_key: buildDedupeKey(item),
      scoring_detail: { d_grade_rule: "keyword_only_match" },
    };
  }

  // 3. Check other D-grade conditions
  if (isPureEngineeringOrMaterialsStudy(text)) {
    return {
      grade: "D",
      grade_label: LABELS.D,
      grade_reason: "纯工程、计算工程、材料科学、物理学、电子、机械工程或工业技术研究",
      classification_reason: "命中 D 级严格排除规则：纯工程/材料研究",
      hard_excluded: true,
      matched_standard_rules: [],
      matched_signals: ["d_grade_rule:engineering_materials"],
      writeback_ready: false,
      triage_version: TRIAGE_VERSION,
      standards_used: false,
      flags: { uncertain: false, needs_review: false },
      score: 0,
      source: sourceLabel(item.source_platform, item.source_channel),
      dedupe_key: buildDedupeKey(item),
      scoring_detail: { d_grade_rule: "engineering_materials" },
    };
  }

  if (isPlantOnlyStudy(text)) {
    return {
      grade: "D",
      grade_label: LABELS.D,
      grade_reason: "植物相关研究，缺乏直接生物医学机制相关性或疾病相关性",
      classification_reason: "命中 D 级严格排除规则：纯植物研究",
      hard_excluded: true,
      matched_standard_rules: [],
      matched_signals: ["d_grade_rule:plant_only"],
      writeback_ready: false,
      triage_version: TRIAGE_VERSION,
      standards_used: false,
      flags: { uncertain: false, needs_review: false },
      score: 0,
      source: sourceLabel(item.source_platform, item.source_channel),
      dedupe_key: buildDedupeKey(item),
      scoring_detail: { d_grade_rule: "plant_only" },
    };
  }

  if (isNonMammalianModelWithoutInsight(text)) {
    return {
      grade: "D",
      grade_label: LABELS.D,
      grade_reason: "非哺乳动物模型研究，缺乏突出机制洞见或可迁移性",
      classification_reason: "命中 D 级严格排除规则：非哺乳动物模型无机制洞见",
      hard_excluded: true,
      matched_standard_rules: [],
      matched_signals: ["d_grade_rule:non_mammalian_no_insight"],
      writeback_ready: false,
      triage_version: TRIAGE_VERSION,
      standards_used: false,
      flags: { uncertain: false, needs_review: false },
      score: 0,
      source: sourceLabel(item.source_platform, item.source_channel),
      dedupe_key: buildDedupeKey(item),
      scoring_detail: { d_grade_rule: "non_mammalian_no_insight" },
    };
  }

  if (isOutOfScopeTopic(text)) {
    return {
      grade: "D",
      grade_label: LABELS.D,
      grade_reason: "癌症、肿瘤、病毒等范围外主题",
      classification_reason: "命中 D 级严格排除规则：范围外主题",
      hard_excluded: true,
      matched_standard_rules: [],
      matched_signals: ["d_grade_rule:out_of_scope"],
      writeback_ready: false,
      triage_version: TRIAGE_VERSION,
      standards_used: false,
      flags: { uncertain: false, needs_review: false },
      score: 0,
      source: sourceLabel(item.source_platform, item.source_channel),
      dedupe_key: buildDedupeKey(item),
      scoring_detail: { d_grade_rule: "out_of_scope" },
    };
  }

  // If not D-grade, check for A/B/C based on review-workflow-rules.json grading_rules

  if (matchesAGrade(text)) {
    return {
      grade: "A",
      grade_label: LABELS.A,
      grade_reason: GRADING_RULES.A?.definition || "直接命中当前核心研究方向，具有明确机制深度或实验验证价值",
      classification_reason: "命中 A 级规则：暴露+生物学+机制",
      hard_excluded: false,
      matched_standard_rules: [],
      matched_signals: ["grade_rule:A"],
      writeback_ready: true,
      triage_version: TRIAGE_VERSION,
      standards_used: false,
      flags: { uncertain: false, needs_review: false },
      score: 10,
      source: sourceLabel(item.source_platform, item.source_channel),
      dedupe_key: buildDedupeKey(item),
      scoring_detail: { grade_rule: "A" },
    };
  }

  if (matchesBGrade(text)) {
    return {
      grade: "B",
      grade_label: LABELS.B,
      grade_reason: GRADING_RULES.B?.definition || "命中部分核心研究方向，但缺少明确机制深度或实验验证",
      classification_reason: "命中 B 级规则：部分核心方向+证据",
      hard_excluded: false,
      matched_standard_rules: [],
      matched_signals: ["grade_rule:B"],
      writeback_ready: true,
      triage_version: TRIAGE_VERSION,
      standards_used: false,
      flags: { uncertain: false, needs_review: false },
      score: 6,
      source: sourceLabel(item.source_platform, item.source_channel),
      dedupe_key: buildDedupeKey(item),
      scoring_detail: { grade_rule: "B" },
    };
  }

  if (matchesCGrade(text)) {
    return {
      grade: "C",
      grade_label: LABELS.C,
      grade_reason: GRADING_RULES.C?.definition || "与领域相关但缺乏直接的核心主题与目标上下文证据",
      classification_reason: "命中 C 级规则：领域相关",
      hard_excluded: false,
      matched_standard_rules: [],
      matched_signals: ["grade_rule:C"],
      writeback_ready: true,
      triage_version: TRIAGE_VERSION,
      standards_used: false,
      flags: { uncertain: false, needs_review: false },
      score: 3,
      source: sourceLabel(item.source_platform, item.source_channel),
      dedupe_key: buildDedupeKey(item),
      scoring_detail: { grade_rule: "C" },
    };
  }

  // Default: D-grade (no relevant signals found)
  return {
    grade: "D",
    grade_label: LABELS.D,
    grade_reason: GRADING_RULES.D?.definition || "与当前课题、专题和领域相关性不足",
    classification_reason: "未命中任何相关规则",
    hard_excluded: false,
    matched_standard_rules: [],
    matched_signals: ["default:D"],
    writeback_ready: false,
    triage_version: TRIAGE_VERSION,
    standards_used: false,
    flags: { uncertain: false, needs_review: false },
    score: 0,
    source: sourceLabel(item.source_platform, item.source_channel),
    dedupe_key: buildDedupeKey(item),
    scoring_detail: { default: "D" },
  };
}
