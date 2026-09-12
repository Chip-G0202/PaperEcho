import fs from "node:fs";
import { createHash } from "node:crypto";
import { normalizeSuggestionStatus } from "./screening_standards_rewrite_plan.mjs";
import { writeUnifiedPendingRuleSuggestions } from './unified_pending_rule_suggestions.mjs';

export function normalizeRuleForDedup(rule) {
  return String(rule || "").toLowerCase().replace(/[\s\u3000]+/g, " ").replace(/[.,;:·。、；：]+$/g, "").trim();
}

function ruleHash(rule) {
  return createHash("sha1").update(normalizeRuleForDedup(rule)).digest("hex").slice(0, 12);
}

function generateSuggestionId(generatedAt) {
  const d = new Date(generatedAt || Date.now());
  const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const r = String(Math.floor(Math.random() * 900) + 100);
  return `SUG-${ds}-${r}`;
}

function feedbackWeight(feedback) {
  if (feedback === "keep") return 0.5;
  if (feedback === "upgrade") return 1;
  if (feedback === "downgrade") return 1;
  if (feedback === "drop") return 1.8;
  return 0;
}

export async function loadRuleSuggestionsLog(logPath) {
  try { return JSON.parse(await fs.promises.readFile(logPath, "utf8")); } catch { return { suggestions: [] }; }
}

export async function writeRuleSuggestionsLog(logPath, log) {
  return writeUnifiedPendingRuleSuggestions(logPath, log);
}

function collapseBlankLines(text) {
  return String(text || "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export async function processUserSuggestionDecisions(parsedDocx, { logPath, noFormalRuleApply = false } = {}) {
  const { processUserSuggestionDecisions: adapter } = await import('../stage1/screening_standards_docx.mjs');
  const { default: path } = await import('node:path');
  return adapter(parsedDocx, { reviewRoot: path.dirname(logPath), logPath, noFormalRuleApply });
}

export function syncSuggestionsToScreeningStandardsMd(currentContent, decisions) {
  if (!decisions.length) return { content: currentContent, added: 0, skippedDuplicate: 0 };
  let added = 0;
  let skippedDuplicate = 0;
  const sections = currentContent.split(/(?=\n## )/);
  const priorityIdx = sections.findIndex((s) => s.includes("## 优先关注"));
  const downrankIdx = sections.findIndex((s) => s.includes("## 相对降权"));
  const excludeIdx = sections.findIndex((s) => s.includes("## 严格排除"));
  const insertIdx = downrankIdx >= 0 ? downrankIdx : excludeIdx >= 0 ? excludeIdx : sections.length - 1;
  for (const decision of decisions) {
    const ruleText = String(decision.rule || "").trim();
    if (!ruleText) continue;
    if (normalizeRuleForDedup(currentContent).includes(normalizeRuleForDedup(ruleText))) { skippedDuplicate++; continue; }
    const isExclude = /排除|exclude|禁止/i.test(ruleText);
    const isPriority = /优先关注|优先纳入|prefer/i.test(ruleText);
    if (isExclude && excludeIdx >= 0) {
      sections[excludeIdx] = sections[excludeIdx].trimEnd() + `\n* ${ruleText}\n`;
    } else if (isPriority && priorityIdx >= 0) {
      sections[priorityIdx] = sections[priorityIdx].trimEnd() + `\n* ${ruleText}\n`;
    } else if (downrankIdx >= 0) {
      sections[downrankIdx] = sections[downrankIdx].trimEnd() + `\n* ${ruleText}\n`;
    } else {
      sections[insertIdx] = sections[insertIdx].trimEnd() + `\n* ${ruleText}\n`;
    }
    added++;
  }
  return { content: collapseBlankLines(sections.join("")), added, skippedDuplicate };
}

function dedupSuggestions(suggestions, existingContent, log) {
  const existingNorms = new Set();
  for (const rule of (existingContent || "").split("\n").map((l) => l.replace(/^\*\s*/, "").trim()).filter(Boolean)) {
    const norm = normalizeRuleForDedup(rule);
    if (norm.length >= 4) existingNorms.add(norm);
  }
  const seenHashes = new Set((log.suggestions || []).map((s) => s.suggestion_hash));
  const out = [];
  for (const s of suggestions) {
    const hash = s.suggestion_hash || ruleHash(s.suggested_rule);
    s.suggestion_hash = hash;
    if (seenHashes.has(hash)) continue;
    if (existingNorms.has(normalizeRuleForDedup(s.suggested_rule))) continue;
    seenHashes.add(hash);
    out.push(s);
  }
  return out;
}

export function generateRuleSuggestionsFromFeedback({ feedbackSignals = [], feedbackSource = "", standardsContent = "", screeningStandards = null, existingSuggestionsLog = null, generatedAt } = {}) {
  const suggestions = [];
  if (!feedbackSignals.length) return { suggestions, reason: "no_feedback_signals" };

  const hardExcludes = screeningStandards?.hard_excludes || [];
  const positivePrefs = screeningStandards?.positive_preferences || [];
  const negativePrefs = screeningStandards?.negative_preferences || [];
  const existingRuleTexts = [...hardExcludes, ...positivePrefs, ...negativePrefs].map((r) => normalizeRuleForDedup(r.rule || r));

  const negativeSignals = feedbackSignals.filter((s) => s.feedback === "drop" || s.feedback === "downgrade");
  const positiveSignals = feedbackSignals.filter((s) => s.feedback === "keep" || s.feedback === "upgrade");

  const topicPatterns = [
    { tag: "animal study", pattern: /\banimal\b|mouse|mice|rat\b|rats\b|zebrafish|小鼠|大鼠|斑马鱼/i },
    { tag: "example topic term 038", pattern: /\bexample topic term 038\b|cell line|细胞/i },
    { tag: "mechanism", pattern: /\bmechanis|pathway|signaling|通路|机制/i },
    { tag: "clinical outcome", pattern: /\bpatient|clinical outcome|人群|临床结局/i },
    { tag: "omics", pattern: /\bomics\b|transcriptom|proteom|metabolom|单细胞|组学/i },
    { tag: "plant", pattern: /\bplant\b|植物/i },
    { tag: "non-mammal", pattern: /\binsect\b|nematode|线虫|昆虫|酵母|果蝇/i },
    { tag: "engineering", pattern: /\bengineering\b|材料科学|电子|机械/i },
    { tag: "AI/algorithm", pattern: /\bartificial intelligence\b|\bAI\b|algorithm|算法/i },
  ];

  function matchTopics(text) {
    const haystack = String(text || "");
    return topicPatterns.filter((p) => p.pattern.test(haystack)).map((p) => p.tag);
  }

  const negTagCounts = {};
  const negTagTitles = {};
  for (const s of negativeSignals) {
    const text = `${s.title_context || ""} ${s.english_title || ""} ${s.comment || ""}`;
    const tags = matchTopics(text);
    const weight = feedbackWeight(s.feedback);
    for (const tag of tags) {
      negTagCounts[tag] = (negTagCounts[tag] || 0) + weight;
      negTagTitles[tag] = negTagTitles[tag] || [];
      if (negTagTitles[tag].length < 3 && s.english_title) negTagTitles[tag].push(s.english_title);
    }
  }

  for (const [tag, count] of Object.entries(negTagCounts)) {
    if (count < 1.5) continue;
    const normalizedTag = normalizeRuleForDedup(tag);
    if (existingRuleTexts.some((r) => r.includes(normalizedTag))) continue;
    const confidence = count >= 4 ? "medium" : "low";
    const ruleText = `降权${tag}相关研究，除非具有突出机制深度或与当前课题直接相关`;
    suggestions.push({
      suggestion_id: generateSuggestionId(generatedAt),
      action: "add",
      type: "negative_preference",
      suggested_rule: ruleText,
      evidence_count: count,
      example_items: negTagTitles[tag] || [],
      confidence,
      status: "pending",
      revised_rule: "",
      requires_manual_review: false,
      reason: `基于${count.toFixed(1)} 份 drop/downgrade 加权反馈的聚合`,
      suggestion_hash: ruleHash(ruleText),
      generated_at: generatedAt,
      feedback_source: feedbackSource,
    });
  }

  const hardExcludeStrongTags = new Set(["engineering", "AI/algorithm", "plant", "non-mammal"]);
  const exclusionWords = /排除|exclude|irrelevant|无关|与课题无关|完全不相关|不应纳入|不应该/i;
  for (const [tag, count] of Object.entries(negTagCounts)) {
    if (count < 2.5) continue;
    const normalizedTag = normalizeRuleForDedup(tag);
    if (existingRuleTexts.some((r) => r.includes(normalizedTag))) continue;
    const isStrongExclusionTag = hardExcludeStrongTags.has(tag);
    const hasExclusionLanguage = (negTagTitles[tag] || []).some((t) => exclusionWords.test(t));
    if (!isStrongExclusionTag && !hasExclusionLanguage) continue;
    const ruleText = `排除${tag}相关研究，除非具有直接生物医学机制相关性或疾病相关性`;
    suggestions.push({
      suggestion_id: generateSuggestionId(generatedAt),
      action: "add",
      type: "hard_exclude",
      suggested_rule: ruleText,
      evidence_count: count,
      example_items: negTagTitles[tag] || [],
      confidence: count >= 5 ? "medium" : "low",
      status: "pending",
      revised_rule: "",
      requires_manual_review: true,
      reason: `基于${count.toFixed(1)} 份 drop/downgrade 加权反馈聚合，建议严格排除；需人工确认`,
      suggestion_hash: ruleHash(ruleText),
      generated_at: generatedAt,
      feedback_source: feedbackSource,
    });
  }

  const posTagCounts = {};
  const posTagTitles = {};
  for (const s of positiveSignals) {
    const text = `${s.title_context || ""} ${s.english_title || ""} ${s.comment || ""}`;
    const tags = matchTopics(text);
    const weight = feedbackWeight(s.feedback);
    for (const tag of tags) {
      posTagCounts[tag] = (posTagCounts[tag] || 0) + weight;
      posTagTitles[tag] = posTagTitles[tag] || [];
      if (posTagTitles[tag].length < 3 && s.english_title) posTagTitles[tag].push(s.english_title);
    }
  }

  for (const [tag, count] of Object.entries(posTagCounts)) {
    if (count < 2) continue;
    const normalizedTag = normalizeRuleForDedup(tag);
    if (existingRuleTexts.some((r) => r.includes(normalizedTag))) continue;
    const ruleText = `优先关注${tag}相关研究`;
    suggestions.push({
      suggestion_id: generateSuggestionId(generatedAt),
      action: "add",
      type: "positive_preference",
      suggested_rule: ruleText,
      evidence_count: count,
      example_items: posTagTitles[tag] || [],
      confidence: count >= 5 ? "medium" : "low",
      status: "pending",
      revised_rule: "",
      requires_manual_review: false,
      reason: `基于${count.toFixed(1)} 份 keep/upgrade 加权反馈的聚合`,
      suggestion_hash: ruleHash(ruleText),
      generated_at: generatedAt,
      feedback_source: feedbackSource,
    });
  }

  const deduped = dedupSuggestions(suggestions, standardsContent, existingSuggestionsLog || { suggestions: [] });
  return { suggestions: deduped, reason: deduped.length ? "suggestions_generated" : "no_actionable_suggestions" };
}
