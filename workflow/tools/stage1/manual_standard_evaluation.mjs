import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  buildPubMedQueryFromKeywordGroups,
  loadPubMedKeywordGroupsFromConfig,
  normalizePubMedKeywordGroups,
  updatePubMedPmcKeywordGroups,
} from "../lib/literature_config.mjs";
import {
  getPreferenceLearningConfig,
  understandPreferenceEvaluation,
} from "../lib/preference_learning_support.mjs";
import {
  generateUnifiedPendingRuleSuggestions,
  writeUnifiedPendingRuleSuggestions,
} from "../lib/unified_pending_rule_suggestions.mjs";
import {
  generateRuleSuggestionsFromFeedback,
  loadRuleSuggestionsLog,
  syncSuggestionsToScreeningStandardsMd,
} from "../lib/screening_standards_rule_suggestions.mjs";
import {
  SCREENING_STANDARDS_SOURCE_NAME,
  cleanScreeningStandardsMarkdown,
  collapseBlankLines,
  readScreeningStandardsFile,
  ruleSuggestionsLogPath,
  screeningStandardsDocxPath,
  screeningStandardsPath,
} from "../lib/screening_standards_paths.mjs";
import {
  parseScreeningStandardsDocx,
  processUserSuggestionDecisions,
  readJsonIfExists,
  syncScreeningStandardsDocx,
} from "./screening_standards_docx.mjs";

function applyRuleModifications(content, output = {}) {
  let next = cleanScreeningStandardsMarkdown(content);
  for (const deletion of output.rules_deleted || []) {
    const line = String(deletion || "").trim();
    if (line) next = next.replace(line, "");
  }
  for (const change of output.rules_changed || []) {
    const from = String(change?.from || "").trim();
    const to = String(change?.to || "").trim();
    if (from && to && next.includes(from)) next = next.replace(from, to);
  }
  const additions = (output.rules_added || []).map((line) => String(line || "").trim()).filter((line) => line && !next.includes(line));
  if (additions.length) {
    const marker = "\n## 相对降权";
    if (next.includes(marker)) {
      next = next.replace(marker, `\n${additions.join("\n")}\n${marker}`);
    } else {
      next = `${next.trimEnd()}\n\n${additions.join("\n")}\n`;
    }
  }
  return collapseBlankLines(next);
}

function emptyAudit({ auditPath, llmConfig = null, pubmedQueryBefore = "", pubmedQueryAfter = "" } = {}) {
  return {
    generated_at: new Date().toISOString(),
    mode: "propose",
    applied: false,
    formal_rules_modified: false,
    pubmed_config_modified: false,
    direct_apply_requires_explicit_config: true,
    evaluation_text_hash: "",
    evaluation_text_excerpt: "",
    proposed_count: 0,
    proposed_changes: [],
    skipped_direct_apply_reason: "",
    partial_failure: false,
    planned_changes: null,
    actual_rule_changes: null,
    actual_keyword_changes: null,
    explicit_marker_found: false,
    preference_learning_architecture: {
      feedback_learning_role: "evidence_and_theme_extraction",
      pending_suggestion_writer: "unified_pending_suggestion_generator",
      pending_used_for_current_grading: false,
    },
    manual_standard_evaluation_architecture: {
      docx_evaluation_default_mode: "propose",
      direct_apply_requires_explicit_config: true,
    },
    evaluation_text_original: "",
    evaluation_processed: false,
    evaluation_cleared: false,
    llm_model: llmConfig?.model || "",
    llm_config_path: llmConfig?.configPath || "",
    llm_api_key_configured: Boolean(llmConfig?.apiKeyConfigured),
    llm_api_key_source: llmConfig?.apiKeyEnvName || "",
    llm_api_key_source_kind: llmConfig?.apiKeyEnvName === "PREFERENCE_LEARNING_API_KEY"
      ? "direct"
      : llmConfig?.apiKeyEnvName === "TITLE_TRANSLATION_API_KEY"
        ? "fallback"
        : "",
    llm_unavailable: false,
    rules_added: [],
    rules_deleted: [],
    rules_changed: [],
    keywords_added: { required: [], optional: [], negative: [] },
    keywords_removed: [],
    negative_keywords_added: [],
    keyword_table_synced: false,
    keyword_table_changed: false,
    keyword_groups_before: null,
    keyword_groups_after: null,
    pubmed_query_before: pubmedQueryBefore,
    pubmed_query_after: pubmedQueryAfter,
    unmapped_feedback: [],
    blockers: [],
    audit_path: auditPath || "",
  };
}

function sameKeywordGroups(a, b) {
  return JSON.stringify(normalizePubMedKeywordGroups(a || {})) === JSON.stringify(normalizePubMedKeywordGroups(b || {}));
}

function syncPubMedConfigFromDocxKeywordTable(filePath, parsedKeywordState, currentConfig = {}, { write = true } = {}) {
  const beforeGroups = loadPubMedKeywordGroupsFromConfig(currentConfig);
  const afterGroups = normalizePubMedKeywordGroups(parsedKeywordState || {});
  const queryBefore = String(currentConfig.query || buildPubMedQueryFromKeywordGroups(beforeGroups));
  const queryAfter = buildPubMedQueryFromKeywordGroups(afterGroups);
  const changed = !sameKeywordGroups(beforeGroups, afterGroups) || queryBefore !== queryAfter;
  if (changed && write) {
    fs.writeFileSync(filePath, `${JSON.stringify({
      ...currentConfig,
      keyword_groups: afterGroups,
      query: queryAfter,
    }, null, 2)}\n`, "utf8");
  }
  return {
    changed,
    keyword_groups_before: beforeGroups,
    keyword_groups_after: afterGroups,
    query_before: queryBefore,
    query_after: queryAfter,
  };
}

function textHash(text) {
  return createHash("sha256").update(String(text || "")).digest("hex");
}

function textExcerpt(text, length = 400) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, length);
}

function resolveManualStandardEvaluationConfig(config = {}) {
  const mode = String(config.mode || "propose").trim();
  return {
    enabled: config.enabled !== false,
    mode: ["propose", "apply_if_explicit", "direct_apply"].includes(mode) ? mode : "propose",
    allow_direct_apply: Boolean(config.allow_direct_apply),
    clear_evaluation_after_success: Boolean(config.clear_evaluation_after_success),
    require_explicit_apply_marker: config.require_explicit_apply_marker !== false,
    no_formal_rule_apply: Boolean(config.no_formal_rule_apply),
    direct_apply_markers: Array.isArray(config.direct_apply_markers)
      ? config.direct_apply_markers.map(String)
      : ["[DIRECT_APPLY]", "DIRECT_APPLY_RULES", "直接应用正式规则"],
  };
}

function hasDirectApplyMarker(text, config) {
  const value = String(text || "");
  return config.direct_apply_markers.some((marker) => marker && value.includes(marker));
}

function buildManualEvaluationSuggestionCandidates(output = {}, { evaluationText = "", generatedAt = new Date().toISOString() } = {}) {
  const candidates = [];
  for (const rule of Array.isArray(output.rules_added) ? output.rules_added : []) {
    candidates.push({
      source: "docx_manual_evaluation",
      target: "screening_standards.md",
      change_type: "add_rule",
      rule_text: rule,
      rationale: "Proposed from screening_standards.docx evaluation area.",
      evidence_text_excerpt: textExcerpt(evaluationText),
      confidence: "low",
      risk: "Manual evaluation text requires confirmation before changing formal rules.",
      risk_level: "medium",
      created_at: generatedAt,
    });
  }
  for (const rule of Array.isArray(output.rules_deleted) ? output.rules_deleted : []) {
    candidates.push({
      source: "docx_manual_evaluation",
      target: "screening_standards.md",
      change_type: "delete_rule",
      rule_text: rule,
      rationale: "Proposed deletion from screening_standards.docx evaluation area.",
      evidence_text_excerpt: textExcerpt(evaluationText),
      confidence: "low",
      risk: "Rule deletion is high risk and requires confirmation.",
      risk_level: "high",
      created_at: generatedAt,
    });
  }
  for (const rule of Array.isArray(output.rules_changed) ? output.rules_changed : []) {
    const ruleText = typeof rule === "string" ? rule : `${rule.before || ""} -> ${rule.after || ""}`.trim();
    candidates.push({
      source: "docx_manual_evaluation",
      target: "screening_standards.md",
      change_type: "revise_rule",
      rule_text: ruleText,
      rationale: "Proposed revision from screening_standards.docx evaluation area.",
      evidence_text_excerpt: textExcerpt(evaluationText),
      confidence: "low",
      risk: "Rule revision requires confirmation.",
      risk_level: "medium",
      created_at: generatedAt,
    });
  }
  const keywordsAdded = output.keywords_added || {};
  for (const [group, values] of Object.entries(keywordsAdded)) {
    for (const value of Array.isArray(values) ? values.flat() : []) {
      candidates.push({
        source: "docx_manual_evaluation",
        target: "pubmed_pmc_search.json",
        change_type: "add_keyword",
        rule_text: `Add ${group} search keyword: ${value}`,
        rationale: "Proposed search keyword change from screening_standards.docx evaluation area.",
        evidence_text_excerpt: textExcerpt(evaluationText),
        confidence: "low",
        risk: "Search configuration changes can alter retrieval scope.",
        risk_level: "high",
        created_at: generatedAt,
      });
    }
  }
  for (const value of Array.isArray(output.keywords_removed) ? output.keywords_removed : []) {
    candidates.push({
      source: "docx_manual_evaluation",
      target: "pubmed_pmc_search.json",
      change_type: "remove_keyword",
      rule_text: `Remove search keyword: ${value}`,
      rationale: "Proposed search keyword removal from screening_standards.docx evaluation area.",
      evidence_text_excerpt: textExcerpt(evaluationText),
      confidence: "low",
      risk: "Search configuration changes can alter retrieval scope.",
      risk_level: "high",
      created_at: generatedAt,
    });
  }
  for (const value of Array.isArray(output.negative_keywords_added) ? output.negative_keywords_added : []) {
    candidates.push({
      source: "docx_manual_evaluation",
      target: "pubmed_pmc_search.json",
      change_type: "add_keyword",
      rule_text: `Add negative search keyword: ${value}`,
      rationale: "Proposed negative search keyword from screening_standards.docx evaluation area.",
      evidence_text_excerpt: textExcerpt(evaluationText),
      confidence: "low",
      risk: "Search configuration changes can alter retrieval scope.",
      risk_level: "high",
      created_at: generatedAt,
    });
  }
  return candidates;
}

async function backupFormalFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  const backupPath = `${filePath}.backup`;
  await fs.promises.copyFile(filePath, backupPath);
  return backupPath;
}

async function writeAudit(filePath, audit) {
  if (!filePath) return;
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  let history = [];
  try {
    const previous = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    history = Array.isArray(previous.history) ? previous.history : [];
    const { history: _history, ...previousSnapshot } = previous;
    if (Object.keys(previousSnapshot).length) history.push(previousSnapshot);
  } catch {}
  await fs.promises.writeFile(filePath, `${JSON.stringify({ ...audit, history }, null, 2)}\n`, "utf8");
}

// DOCX remains an input adapter; both inputs execute the same evaluation core.
export async function processManualStandardEvaluation(options = {}) {
  return processResearchEvaluationInput(options);
}

export async function processResearchEvaluation(text, options = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('EVALUATION_TEXT_INVALID');
  return processResearchEvaluationInput({
    ...options, evaluationText: text.trim(),
    manualStandardEvaluationConfig: { ...options.manualStandardEvaluationConfig, mode: 'propose', allow_direct_apply: false },
  });
}

async function processResearchEvaluationInput({
  reviewRoot,
  pubmedConfigPath,
  auditPath,
  llmClient = null,
  llmRuntime = null,
  manualStandardEvaluationConfig = {},
  evaluationText = null,
} = {}) {
  const mdPath = screeningStandardsPath(reviewRoot);
  const docxPath = screeningStandardsDocxPath(reviewRoot);
  let pubmedConfig = readJsonIfExists(pubmedConfigPath);
  const pubmedQueryBefore = String(pubmedConfig.query || buildPubMedQueryFromKeywordGroups(loadPubMedKeywordGroupsFromConfig(pubmedConfig)));
  const llmConfig = llmRuntime || getPreferenceLearningConfig();
  const audit = emptyAudit({ auditPath, llmConfig, pubmedQueryBefore, pubmedQueryAfter: pubmedQueryBefore });
  const modeConfig = resolveManualStandardEvaluationConfig(manualStandardEvaluationConfig);
  audit.mode = modeConfig.mode;
  audit.no_formal_rule_apply = modeConfig.no_formal_rule_apply;
  audit.formal_writes_allowed = !modeConfig.no_formal_rule_apply;

  let parsed;
  try {
    if (evaluationText !== null) {
      parsed = {
        evaluation_text: evaluationText,
        rules_text: (await readScreeningStandardsFile(reviewRoot)).content,
        keyword_state: loadPubMedKeywordGroupsFromConfig(pubmedConfig),
        suggestions_table: [],
      };
    } else {
    if (!fs.existsSync(docxPath)) {
      await syncScreeningStandardsDocx(reviewRoot, { pubmedConfigPath });
    }
    parsed = await parseScreeningStandardsDocx(docxPath);
    }
  } catch (error) {
    audit.blockers.push("docx_unreadable");
    audit.error = String(error?.message || error);
    await writeAudit(auditPath, audit);
    return audit;
  }

  const explicitMarkerFound = hasDirectApplyMarker(parsed.evaluation_text, modeConfig);
  audit.explicit_marker_found = explicitMarkerFound;
  const directApplyRequested = modeConfig.mode === "direct_apply"
    || (modeConfig.mode === "apply_if_explicit" && explicitMarkerFound);
  const directApplyAllowed = directApplyRequested
    && modeConfig.allow_direct_apply
    && !modeConfig.no_formal_rule_apply
    && (modeConfig.mode === "direct_apply" || !modeConfig.require_explicit_apply_marker || explicitMarkerFound);
  const keywordTableSync = syncPubMedConfigFromDocxKeywordTable(pubmedConfigPath, parsed.keyword_state, pubmedConfig, {
    write: directApplyAllowed,
  });
  pubmedConfig = {
    ...pubmedConfig,
    keyword_groups: keywordTableSync.keyword_groups_after,
    query: keywordTableSync.query_after,
  };
  Object.assign(audit, {
    keyword_table_synced: true,
    keyword_table_changed: directApplyAllowed && keywordTableSync.changed,
    keyword_groups_before: keywordTableSync.keyword_groups_before,
    keyword_groups_after: keywordTableSync.keyword_groups_after,
    pubmed_query_after: directApplyAllowed ? keywordTableSync.query_after : pubmedQueryBefore,
    pubmed_config_modified: directApplyAllowed && keywordTableSync.changed,
  });

  // Process user suggestion decisions from docx
  const resolvedSuggestionsLogPath = ruleSuggestionsLogPath(reviewRoot);
  let userDecisionResult = { decisions: [], log: null };
  try {
    userDecisionResult = await processUserSuggestionDecisions(parsed, { reviewRoot, logPath: resolvedSuggestionsLogPath, noFormalRuleApply: modeConfig.no_formal_rule_apply });
    audit.suggestion_decision_receipts = userDecisionResult.receipts || [];
    if (userDecisionResult.decisions.length) {
      const decisionSync = syncSuggestionsToScreeningStandardsMd(
        await fs.promises.readFile(mdPath, "utf8"),
        userDecisionResult.decisions,
      );
      if (decisionSync.added > 0 && !modeConfig.no_formal_rule_apply) {
        await fs.promises.writeFile(mdPath, decisionSync.content, "utf8");
      }
      audit.suggestions_decisions_applied = userDecisionResult.decisions.length;
      audit.suggestions_added_to_md = modeConfig.no_formal_rule_apply ? 0 : decisionSync.added;
      audit.suggestions_planned_but_not_applied = modeConfig.no_formal_rule_apply ? decisionSync.added : 0;
      if (modeConfig.no_formal_rule_apply && decisionSync.added > 0) {
        audit.planned_but_not_applied = true;
        audit.formal_writes_blocked_count = Number(audit.formal_writes_blocked_count || 0) + 1;
      }
      audit.suggestions_skipped_duplicate = decisionSync.skippedDuplicate;
    }
  } catch (err) {
    audit.suggestions_decision_error = String(err?.message || err);
  }

  audit.evaluation_text_original = parsed.evaluation_text;
  audit.evaluation_text_hash = textHash(parsed.evaluation_text);
  audit.evaluation_text_excerpt = textExcerpt(parsed.evaluation_text);
  if (!parsed.evaluation_text) {
    audit.blockers.push("no_evaluation_input");
    const current = await readScreeningStandardsFile(reviewRoot);
    const cleaned = cleanScreeningStandardsMarkdown(current.content);
    if (cleaned !== current.content && !modeConfig.no_formal_rule_apply) await fs.promises.writeFile(mdPath, cleaned, "utf8");
    if (cleaned !== current.content && modeConfig.no_formal_rule_apply) {
      audit.planned_but_not_applied = true;
      audit.formal_writes_blocked_count = Number(audit.formal_writes_blocked_count || 0) + 1;
    }
    await writeAudit(auditPath, audit);
    return audit;
  }

  if (!modeConfig.enabled) {
    audit.blockers.push("manual_standard_evaluation_disabled");
    await writeAudit(auditPath, audit);
    return audit;
  }

  if (directApplyRequested && !directApplyAllowed && !modeConfig.no_formal_rule_apply) {
    audit.skipped_direct_apply_reason = modeConfig.no_formal_rule_apply
      ? "no_formal_rule_apply"
      : !modeConfig.allow_direct_apply
      ? "allow_direct_apply_false"
      : "explicit_marker_missing";
    if (modeConfig.no_formal_rule_apply) {
      audit.planned_but_not_applied = true;
      audit.formal_writes_blocked_count = Number(audit.formal_writes_blocked_count || 0) + 1;
    }
    await writeAudit(auditPath, audit);
    return audit;
  }

  const llm = await understandPreferenceEvaluation({
    evaluation_text: parsed.evaluation_text,
    current_rules: parsed.rules_text,
    current_keywords: keywordTableSync.keyword_groups_after,
    current_pubmed_query: keywordTableSync.query_after,
  }, { runtime: llmConfig, llmClient });

  if (!llm.ok) {
    audit.blockers.push(llm.blocker || "llm_unavailable");
    audit.llm_unavailable = llm.blocker === "llm_unavailable" || llm.blocker === "missing_preference_learning_api_key";
    audit.llm_validation_reason = llm.validation_reason || "";
    audit.llm_error = llm.error || "";
    audit.llm_output = llm.output;
    await writeAudit(auditPath, audit);
    return audit;
  }

  const output = llm.output;
  const generatedAt = audit.generated_at;
  const proposedChanges = buildManualEvaluationSuggestionCandidates(output, {
    evaluationText: parsed.evaluation_text,
    generatedAt,
  });
  audit.parsed_result = output;
  audit.llm_output = output;
  audit.llm_raw_text = llm.raw_text || "";
  audit.proposed_changes = proposedChanges;
  audit.proposed_count = proposedChanges.length;
  audit.planned_changes = {
    rules_added: output.rules_added || [],
    rules_deleted: output.rules_deleted || [],
    rules_changed: output.rules_changed || [],
    keywords_added: output.keywords_added || { required: [], optional: [], negative: [] },
    keywords_removed: output.keywords_removed || [],
    negative_keywords_added: output.negative_keywords_added || [],
  };

  if (!directApplyAllowed) {
    const existingLog = await loadRuleSuggestionsLog(resolvedSuggestionsLogPath);
    const unified = generateUnifiedPendingRuleSuggestions({
      manualEvaluationCandidates: proposedChanges,
      existingSuggestionsLog: existingLog,
      generatedAt,
    });
    await writeUnifiedPendingRuleSuggestions(resolvedSuggestionsLogPath, unified.log);
    if (evaluationText === null) await syncScreeningStandardsDocx(reviewRoot, {
      pubmedConfigPath,
      evaluationText: modeConfig.clear_evaluation_after_success ? "" : parsed.evaluation_text,
      suggestionsLogPath: resolvedSuggestionsLogPath,
    });
    Object.assign(audit, {
      evaluation_processed: true,
      evaluation_cleared: modeConfig.clear_evaluation_after_success,
      applied: false,
      formal_rules_modified: false,
      pubmed_config_modified: false,
      skipped_direct_apply_reason: modeConfig.no_formal_rule_apply && directApplyRequested ? "no_formal_rule_apply" : "mode_propose",
      no_formal_rule_apply: modeConfig.no_formal_rule_apply,
      planned_but_not_applied: Boolean(modeConfig.no_formal_rule_apply && directApplyRequested),
      formal_writes_blocked_count: modeConfig.no_formal_rule_apply && directApplyRequested ? 1 : 0,
      suggestions_log_path: resolvedSuggestionsLogPath,
      suggestions_appended: unified.added_count,
      suggestions_merged_duplicate: unified.merged_duplicate_count,
      suggestions_rejected_duplicate_skipped: unified.rejected_duplicate_skipped_count,
      rules_added: output.rules_added,
      rules_deleted: output.rules_deleted,
      rules_changed: output.rules_changed,
      keywords_added: output.keywords_added,
      keywords_removed: output.keywords_removed,
      negative_keywords_added: output.negative_keywords_added,
      unmapped_feedback: output.unmapped_feedback,
    });
    await writeAudit(auditPath, audit);
    return audit;
  }

  const beforeMd = await fs.promises.readFile(mdPath, "utf8");
  let queryUpdate = { query_after: keywordTableSync.query_after };
  try {
    audit.md_backup_path = await backupFormalFile(mdPath);
    audit.pubmed_config_backup_path = await backupFormalFile(pubmedConfigPath);
    await writeAudit(auditPath, audit);
    const afterMd = applyRuleModifications(beforeMd, output);
    await fs.promises.writeFile(mdPath, afterMd, "utf8");
    audit.formal_rules_modified = afterMd !== beforeMd;
    queryUpdate = updatePubMedPmcKeywordGroups(pubmedConfigPath, output);
    audit.pubmed_config_modified = true;
    await syncScreeningStandardsDocx(reviewRoot, {
      pubmedConfigPath,
      evaluationText: modeConfig.clear_evaluation_after_success ? "" : parsed.evaluation_text,
      previousText: beforeMd,
      suggestionsLogPath: resolvedSuggestionsLogPath,
    });
  } catch (err) {
    audit.partial_failure = true;
    audit.error = String(err?.message || err);
    await writeAudit(auditPath, audit);
    return audit;
  }

  Object.assign(audit, {
    evaluation_processed: true,
    evaluation_cleared: modeConfig.clear_evaluation_after_success,
    applied: true,
    rules_added: output.rules_added,
    rules_deleted: output.rules_deleted,
    rules_changed: output.rules_changed,
    keywords_added: output.keywords_added,
    keywords_removed: output.keywords_removed,
    negative_keywords_added: output.negative_keywords_added,
    pubmed_query_after: queryUpdate.query_after,
    unmapped_feedback: output.unmapped_feedback,
    actual_rule_changes: {
      rules_added: output.rules_added,
      rules_deleted: output.rules_deleted,
      rules_changed: output.rules_changed,
    },
    actual_keyword_changes: {
      keywords_added: output.keywords_added,
      keywords_removed: output.keywords_removed,
      negative_keywords_added: output.negative_keywords_added,
    },
  });
  await writeAudit(auditPath, audit);
  return audit;
}

export async function applyScreeningStandardsLearningUpdate(reviewRoot, audit = {}, { generatedAt = new Date().toISOString(), suggestionsLogPath = null, mode = "legacy_apply", noFormalRuleApply = false } = {}) {
  if (mode === "feedback_learning_disabled" || mode === "disabled" || noFormalRuleApply) {
    return {
      path: screeningStandardsPath(reviewRoot),
      loaded: false,
      created: false,
      cleaned: false,
      used_as_primary_rationale_source: true,
      change_markup_applied: false,
      additions_count: 0,
      deletions_count: 0,
      docx_path: screeningStandardsDocxPath(reviewRoot),
      docx_snapshot_path: "",
      docx_synced: false,
      source_name: SCREENING_STANDARDS_SOURCE_NAME,
      feedback_learning_can_modify_formal_rules: false,
      apply_screening_standards_learning_update_called: false,
      apply_screening_standards_learning_update_mode: mode,
      no_formal_rule_apply: Boolean(noFormalRuleApply),
      planned_but_not_applied: Boolean(noFormalRuleApply),
      formal_files_modified: false,
      skipped_reason: noFormalRuleApply ? "no_formal_rule_apply" : "feedback_learning_cannot_modify_formal_rules",
    };
  }
  const current = await readScreeningStandardsFile(reviewRoot);
  let content = cleanScreeningStandardsMarkdown(current.content);
  const deletions = [];
  for (const change of Array.isArray(audit.summary_change_log) ? audit.summary_change_log : []) {
    if (String(change?.change_type || "") === "retired") {
      const statement = String(change?.statement || change?.rationale || "").trim();
      if (statement && content.includes(statement)) deletions.push(statement);
    }
  }
  if (deletions.length) {
    for (const deletion of deletions) content = content.replace(deletion, "");
  }
  if (deletions.length || content !== current.content) {
    content = collapseBlankLines(content);
  }
  if (content !== current.content) {
    await fs.promises.writeFile(current.path, content, "utf8");
  }
  let evaluationText = null;
  const docxPath = screeningStandardsDocxPath(reviewRoot);
  try {
    if (fs.existsSync(docxPath)) {
      evaluationText = (await parseScreeningStandardsDocx(docxPath)).evaluation_text || null;
    }
  } catch {}
  const docxSync = await syncScreeningStandardsDocx(reviewRoot, { evaluationText, suggestionsLogPath });
  return {
    path: current.path,
    loaded: current.loaded,
    created: current.created,
    cleaned: current.cleaned,
    used_as_primary_rationale_source: true,
    change_markup_applied: deletions.length > 0,
    additions_count: 0,
    deletions_count: deletions.length,
    docx_path: docxSync.docx_path,
    docx_snapshot_path: docxSync.snapshot_path,
    docx_synced: true,
    source_name: current.source_name,
  };
}
