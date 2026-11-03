import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DOMAIN_SECTIONS, readDomainConfig } from '../lib/application_config.mjs';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function hashValue(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

async function readText(filePath) {
  if (DOMAIN_SECTIONS[path.basename(filePath)]) {
    const loaded = readDomainConfig(filePath);
    if (loaded.canonical) {
      const content = loaded.value ? JSON.stringify(loaded.value) : '';
      return { content, hash: hashText(content), included: Boolean(loaded.value), warning: loaded.value ? '' : 'missing' };
    }
  }
  try {
    const content = await fs.readFile(filePath, "utf8");
    return { content, hash: hashText(content), included: true, warning: "" };
  } catch (error) {
    return { content: "", hash: "", included: false, warning: error?.code === "ENOENT" ? "missing" : String(error?.message || error) };
  }
}

function compactLines(text = "", maxLines = 24) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[-*_]{3,}$/.test(line))
    .slice(0, maxLines)
    .join("\n");
}

function summarizeWorkflowRules(raw = "") {
  try {
    const json = JSON.parse(raw);
    const triage = json.triage || {};
    return JSON.stringify({
      version: triage.version || "",
      primary_question: triage.research_focus?.primary_question || "",
      priority_rules: triage.priority_rules || {},
      grading_rules: triage.grading_rules || {},
      uncertain_boundaries: triage.uncertain_boundaries || [],
      keyword_policy: triage.keyword_policy || {},
    }, null, 2).slice(0, 5000);
  } catch {
    return compactLines(raw, 30);
  }
}

function summarizeSearchContext(raw = "") {
  try {
    const json = JSON.parse(raw);
    return JSON.stringify({
      databases: json.databases || [],
      days_back: json.days_back || null,
      query: json.query || "",
      keyword_groups: json.keyword_groups || {},
    }, null, 2).slice(0, 3000);
  } catch {
    return compactLines(raw, 20);
  }
}

function summarizeSuggestions(raw = "") {
  try {
    const rawHash = hashText(raw);
    const log = JSON.parse(raw);
    const suggestions = Array.isArray(log.suggestions) ? log.suggestions : [];
    const accepted = suggestions
      .filter((entry) => entry.status === "accepted" || entry.status === "revised")
      .map((entry) => entry.revised_rule || entry.rule_text || entry.suggested_rule || "")
      .filter(Boolean)
      .slice(0, 20);
    const pending = suggestions
      .filter((entry) => entry.status === "candidate" || entry.status === "pending")
      .map((entry) => entry.rule_text || entry.suggested_rule || "")
      .filter(Boolean)
      .slice(0, 20);
    return {
      accepted_summary: accepted.join("\n"),
      pending_summary: pending.join("\n"),
      pending_count: suggestions.filter((entry) => entry.status === "candidate" || entry.status === "pending").length,
      pending_hash: hashText(pending.join("\n")),
      pending_log_hash: rawHash,
    };
  } catch {
    return { accepted_summary: "", pending_summary: "", pending_count: 0, pending_hash: "", pending_log_hash: "" };
  }
}

function sourceRecord({ relativePath, type, readResult, official, gradeReview, preferenceLearning }) {
  return {
    path: relativePath,
    type,
    hash: readResult.hash,
    included: readResult.included,
    warning: readResult.warning,
    included_for_grade_review: gradeReview,
    included_for_preference_learning: preferenceLearning,
    included_as_official_rule: official,
    can_be_used_for_grading: official,
  };
}

export async function buildLlmRuleContextSummary({
  root = process.cwd(),
  reviewRoot = path.join(root, "review_results", "文献评价"),
} = {}) {
  const standardsRel = path.join("review_results", "文献评价", "screening_standards.md");
  const workflowRel = path.join("config", "review-workflow-rules.json");
  const pubmedRel = path.join("config", "pubmed_pmc_search.json");
  const suggestionsRel = path.join("review_results", "文献评价", "standards_rule_suggestions_log.json");
  const standards = await readText(path.join(reviewRoot, "screening_standards.md"));
  const workflowRules = await readText(path.join(root, workflowRel));
  const pubmed = await readText(path.join(root, pubmedRel));
  const suggestions = await readText(path.join(reviewRoot, "standards_rule_suggestions_log.json"));
  const suggestionSummary = summarizeSuggestions(suggestions.content);

  const sources = [
    sourceRecord({
      relativePath: standardsRel,
      type: "official_screening_standards",
      readResult: standards,
      official: true,
      gradeReview: true,
      preferenceLearning: true,
    }),
    sourceRecord({
      relativePath: workflowRel,
      type: "machine_grading_rules",
      readResult: workflowRules,
      official: true,
      gradeReview: true,
      preferenceLearning: true,
    }),
    {
      ...sourceRecord({
        relativePath: suggestionsRel,
        type: "accepted_rule_updates",
        readResult: suggestions,
        official: true,
        gradeReview: true,
        preferenceLearning: true,
      }),
      included_as_official_rule: true,
    },
    {
      ...sourceRecord({
        relativePath: pubmedRel,
        type: "search_context",
        readResult: pubmed,
        official: false,
        gradeReview: true,
        preferenceLearning: true,
      }),
      can_be_used_for_grading: false,
    },
  ];

  const summary = {
    prompt_version: "llm-rule-context-v1",
    sources,
    official_screening_standards_summary: compactLines(standards.content, 36),
    machine_grading_rules_summary: summarizeWorkflowRules(workflowRules.content),
    accepted_rule_updates_summary: suggestionSummary.accepted_summary,
    search_context_summary: summarizeSearchContext(pubmed.content),
    pending_suggestions_summary: suggestionSummary.pending_summary,
    pending_suggestions_metadata: {
      pending_suggestions_excluded_from_grade_review: true,
      pending_count: suggestionSummary.pending_count,
      pending_hash: suggestionSummary.pending_hash,
      pending_log_hash: suggestionSummary.pending_log_hash || suggestions.hash,
    },
    constraints: [
      "Pending suggestions and candidates are not official grading rules.",
      "Search context explains retrieval scope and terminology but is not a direct grading rule.",
      "Feedback-derived themes do not affect grading until accepted/revised into official standards.",
      "If title evidence is insufficient, keep rule_grade or mark needs_human_review.",
    ],
    warnings: sources.filter((source) => source.warning).map((source) => `${source.path}:${source.warning}`),
  };
  summary.context_hash = hashValue({
    prompt_version: summary.prompt_version,
    sources: summary.sources.map((source) => ({ path: source.path, type: source.type, hash: source.hash })),
    constraints: summary.constraints,
  });
  return summary;
}
