import { loadWorkflowRules } from "../lib/literature_config.mjs";
import { normalizeGradeLetter } from "../lib/grade_primitives.mjs";
import { normalizeIdentifier, normalizeTitleForDedupe as normTitle } from "../lib/dedupe_key.mjs";

const WORKFLOW_RULES = loadWorkflowRules().config;
const TRIAGE_RULES = WORKFLOW_RULES.triage || {};

// Stage 1 semantic grade synthesis helpers.

const GRADE_NUMERIC = { A: 1, B: 2, C: 3, D: 4 };
const NUMERIC_TO_GRADE = { 1: "A", 2: "B", 3: "C", 4: "D" };

export function buildFeedbackIndex(signals = []) {
  const index = new Map();
  for (const sig of signals) {
    const feedback = String(sig.feedback || "").trim().toLowerCase();
    let direction = "ignored";
    if (feedback === "keep" || feedback === "upgrade") direction = "positive";
    else if (feedback === "drop" || feedback === "downgrade") direction = "negative";
    if (direction === "ignored") continue;
    const entry = {
      direction,
      title: sig.english_title || "",
      title_translation: sig.title_translation || sig.titleContext || "",
    };
    const itemKey = String(sig.itemKey || sig.item_key || "").trim();
    if (itemKey) index.set(`key:${itemKey}`, entry);
    const doi = normalizeIdentifier(sig.doi || sig.DOI);
    if (doi) index.set(`doi:${doi}`, entry);
    const enKey = normTitle(sig.english_title || "");
    if (enKey) index.set(`title:${enKey}`, entry);
    const zhKey = normTitle(sig.title_translation || "");
    if (zhKey && zhKey !== enKey) index.set(`title:${zhKey}`, entry);
  }
  return index;
}

export function deriveSemanticGradeFromFeedbackMatches({
  searchResults = [],
  feedbackIndex = new Map(),
  ruleGrade = "",
} = {}) {
  const ruleNum = GRADE_NUMERIC[ruleGrade];
  if (!ruleNum) {
    return { semanticGrade: "", semanticReason: "", matchedFeedbackCount: 0, skippedReason: "invalid_rule_grade" };
  }
  if (!feedbackIndex.size) {
    return { semanticGrade: "", semanticReason: "", matchedFeedbackCount: 0, skippedReason: "no_feedback_index" };
  }

  const matchedEntries = [];
  const seenKeys = new Set();

  for (const result of searchResults) {
    const score = Number(result.score || 0);
    let matchedEntry = null;

    const rItemKey = String(result.item_key || result.itemKey || "").trim();
    if (rItemKey) {
      matchedEntry = feedbackIndex.get(`key:${rItemKey}`);
    }
    if (!matchedEntry) {
      const rDoi = normalizeIdentifier(result.doi || result.DOI);
      if (rDoi) {
        matchedEntry = feedbackIndex.get(`doi:${rDoi}`);
      }
    }
    if (!matchedEntry) {
      const rTitle = normTitle(result.title || "");
      if (rTitle) {
        matchedEntry = feedbackIndex.get(`title:${rTitle}`);
      }
    }

    if (!matchedEntry) continue;

    const dedupeKey = `${matchedEntry.direction}:${matchedEntry.title}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    matchedEntries.push({
      direction: matchedEntry.direction,
      score,
      title: result.title || "",
    });
  }

  if (matchedEntries.length === 0) {
    return { semanticGrade: "", semanticReason: "", matchedFeedbackCount: 0, skippedReason: "no_feedback_match" };
  }

  let adjustment = 0;
  const reasons = [];
  for (const entry of matchedEntries) {
    const weight = entry.score >= 0.5 ? 1 : 0.5;
    if (entry.direction === "positive") {
      adjustment -= weight;
      reasons.push(`+${entry.title.slice(0, 60)}`);
    } else if (entry.direction === "negative") {
      adjustment += weight;
      reasons.push(`-${entry.title.slice(0, 60)}`);
    }
  }

  const roundedAdj = Math.round(adjustment);
  if (roundedAdj === 0) {
    return {
      semanticGrade: "",
      semanticReason: `混合反馈(${matchedEntries.length}条匹配)，不调整`,
      matchedFeedbackCount: matchedEntries.length,
      skippedReason: "neutral_feedback",
    };
  }

  const newNum = Math.max(1, Math.min(4, ruleNum + roundedAdj));
  const semanticGrade = NUMERIC_TO_GRADE[newNum];
  const direction = roundedAdj > 0 ? "下调" : "上调";
  const semanticReason = `语义复审${direction}(${matchedEntries.length}条反馈匹配): ${reasons.slice(0, 3).join("; ")}`;

  return { semanticGrade, semanticReason, matchedFeedbackCount: matchedEntries.length, skippedReason: "" };
}


/**
 * Derive semantic grade purely from current research standards (no feedback dependency).
 * Uses review-workflow-rules.json research_focus term lists + optional auxiliary evidence to evaluate
 * whether an item aligns with the current research direction.
 */
export function deriveSemanticGradeFromStandards({
  item = {},
  ruleGrade = "",
  searchResults = [],
  researchFocus = null,
} = {}) {
  const focus = researchFocus || (TRIAGE_RULES && TRIAGE_RULES.research_focus) || {};
  const text = [
    item.title,
    item.abstract,
    item.summary,
    item.abstractText,
  ].filter(Boolean).join(" ").toLowerCase();

  const exposureTerms = focus.core_exposure_terms || [];
  const biologyTerms = focus.core_biology_terms || [];
  const mechanismTerms = focus.mechanism_terms || [];

  function countHits(terms) {
    let hits = 0;
    for (const t of terms) {
      if (text.includes(String(t).toLowerCase())) hits++;
    }
    return hits;
  }

  const exposureHits = countHits(exposureTerms);
  const biologyHits = countHits(biologyTerms);
  const mechanismHits = countHits(mechanismTerms);

  // Also check caller-supplied auxiliary evidence.
  let searchEvidence = 0;
  if (searchResults.length > 0) {
    for (const r of searchResults) {
      const rText = String(r.title || "").toLowerCase();
      const rExposure = exposureTerms.some((t) => rText.includes(String(t).toLowerCase()));
      const rBiology = biologyTerms.some((t) => rText.includes(String(t).toLowerCase()));
      if (rExposure && rBiology) searchEvidence += 2;
      else if (rBiology) searchEvidence += 1;
    }
  }

  const strongUpgrade = (exposureHits >= 1 && biologyHits >= 2) || (biologyHits >= 3 && mechanismHits >= 1);
  const mediumUpgrade = biologyHits >= 2 || (exposureHits >= 1 && biologyHits >= 1);

  const ruleNum = GRADE_NUMERIC[ruleGrade];
  if (!ruleNum) {
    return { semanticGrade: ruleGrade, semanticReason: "invalid_rule_grade", semanticConfidence: 0, semanticSource: "standards" };
  }

  let adjustment = 0;
  const reasons = [];

  if (strongUpgrade) {
    adjustment = -1;
    reasons.push("\u547d\u4e2d\u6838\u5fc3\u7814\u7a76\u6807\u51c6(exposure=" + exposureHits + ", biology=" + biologyHits + ", mechanism=" + mechanismHits + ")");
  } else if (mediumUpgrade) {
    adjustment = -1;
    reasons.push("\u90e8\u5206\u547d\u4e2d\u7814\u7a76\u6807\u51c6(biology=" + biologyHits + ", exposure=" + exposureHits + ")");
  } else {
    // No positive signal is NOT a downgrade reason.
    // Insufficient evidence: keep rule grade with low confidence.
    if (searchEvidence > 0) {
      reasons.push("\u8bcd\u8868\u547d\u4e2d\u4e0d\u8db3\uff0c\u4f46\u8bed\u4e49\u90bb\u5c45\u6709" + searchEvidence + "\u6761\u76f8\u5173\u8bc1\u636e\uff0c\u4fdd\u6301\u89c4\u5219\u7b49\u7ea7");
    } else {
      reasons.push("\u8bcd\u8868\u8bc1\u636e\u4e0d\u8db3\uff0c\u4fdd\u6301\u89c4\u5219\u7b49\u7ea7");
    }
  }

  const newNum = Math.max(1, Math.min(4, ruleNum + adjustment));
  const semanticGrade = NUMERIC_TO_GRADE[newNum] || ruleGrade;

  const confidence = Math.min(1, (exposureHits + biologyHits + mechanismHits + searchEvidence) / 6);
  return {
    semanticGrade,
    semanticReason: reasons.join("; "),
    semanticConfidence: Math.round(confidence * 100) / 100,
    semanticSource: searchResults.length > 0 ? "standards_with_auxiliary_evidence" : "standards",
  };
}
export function synthesizeFinalGrade({ ruleGrade, semanticGrade, semanticReason = "", flags = {} } = {}) {
  const ruleNorm = normalizeGradeLetter(ruleGrade);
  const semanticNorm = normalizeGradeLetter(semanticGrade);

  if (!ruleNorm) {
    return { finalGrade: ruleNorm, needsHumanReview: false, disagreementType: "" };
  }
  if (!semanticNorm) {
    return { finalGrade: ruleNorm, needsHumanReview: false, disagreementType: "" };
  }
  if (ruleNorm === semanticNorm) {
    return { finalGrade: ruleNorm, needsHumanReview: false, disagreementType: "" };
  }

  const ruleNum = GRADE_NUMERIC[ruleNorm];
  const semanticNum = GRADE_NUMERIC[semanticNorm];
  const diff = Math.abs(semanticNum - ruleNum);

  if (diff >= 2) {
    return {
      finalGrade: ruleNorm,
      needsHumanReview: true,
      disagreementType: `semantic_${diff >= 3 ? "extreme" : "major"}_divergence`,
    };
  }

  const direction = semanticNum < ruleNum ? "upgrade" : "downgrade";
  if (ruleNorm === "C" && semanticNorm === "D") {
    return {
      finalGrade: ruleNorm,
      needsHumanReview: true,
      disagreementType: "semantic_downgrade_review",
    };
  }
  return {
    finalGrade: semanticNorm,
    needsHumanReview: false,
    disagreementType: `semantic_${direction}`,
  };
}

export function synthesizeLlmReview({ ruleGrade, llmGrade, confidence, llmNeedsHumanReview, semanticReason, flags }) {
  const ruleNorm = normalizeGradeLetter(ruleGrade);
  const llmNorm = normalizeGradeLetter(llmGrade);
  if (!llmNorm) return { finalGrade: ruleNorm, needsHumanReview: false, disagreementType: "" };
  if (ruleNorm === 'D' && llmNorm === 'D') return synthesizeFinalGrade({ ruleGrade: ruleNorm, semanticGrade: llmNorm });
  if (llmNeedsHumanReview) return { finalGrade: ruleNorm, needsHumanReview: true, disagreementType: "llm_requested_review" };
  if (confidence === "low" && ruleNorm && llmNorm !== ruleNorm) {
    return { finalGrade: ruleNorm, needsHumanReview: true, disagreementType: "llm_low_confidence_conflict" };
  }
  return synthesizeFinalGrade({ ruleGrade: ruleNorm, semanticGrade: llmNorm, semanticReason, flags });
}

// Grade review owns eligibility. Old pending artifacts overwrote its boolean,
// so recover the decision from their preserved LLM result, never disagreement alone.
export function isManualReviewEligible(item = {}) {
  const rule = normalizeGradeLetter(item.rule_grade || item.ruleGrade || item.grade);
  const semantic = normalizeGradeLetter(item.llm_review_grade || item.llmReviewGrade || item.semantic_grade || item.semanticGrade || item.semantic_review?.grade);
  if ((rule === 'D' && semantic === 'D') || ['auto_d', 'manual_abc', 'manual_d'].includes(item.manual_review_state)) return false;
  if (item.review_required || item.reviewRequired || item.semantic_review?.review_required) return true;
  if (item.llm_review?.llm_review_grade) {
    return synthesizeLlmReview({ ruleGrade: rule, llmGrade: item.llm_review.llm_review_grade,
      confidence: item.llm_review.confidence, llmNeedsHumanReview: item.llm_review.needs_human_review }).needsHumanReview;
  }
  if (item.semantic_source === 'llm_title_review_failed') return true;
  if (item.semantic_source === 'llm_title_review_missing') return false;
  if (item.review_consensus_required === true && item.manual_review_state === 'pending') {
    return ['llm_requested_review', 'llm_low_confidence_conflict', 'semantic_downgrade_review',
      'semantic_major_divergence', 'semantic_extreme_divergence', 'llm_review_failed'].includes(item.disagreement_type);
  }
  return Boolean(item.needs_human_review || item.needsHumanReview || item.semantic_review?.needs_human_review);
}
