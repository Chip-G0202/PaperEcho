import { writeAtomicJson } from "../lib/atomic_json.mjs";
import { loadPubMedPmcSearchConfig, loadWorkflowRules } from "../lib/literature_config.mjs";
import { resolveLlmRuntime } from "../lib/llm_json_support.mjs";
// Internal stage notice:
// This script implements the current Stage 1 / primary pipeline logic.
// It is not the recommended standalone entry point for end users.
// The official workflow entry point is workflow/tools/stage0/main.mjs.
import "../lib/env_file_bootstrap.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildStage1ArtifactManifest } from "./artifact_manifest.mjs";
import { buildCompletedStage1RunReport, buildStage1RunReport, buildStage1SkipRunReport } from "./run_report_builder.mjs";
import { buildStage1DedupSummary } from "./dedup_summary.mjs";
import { buildStage1TriageSummary } from "./triage_summary.mjs";
import { writeStage1CompletedArtifacts } from "./artifact_writer.mjs";
import { LABELS, TRIAGE_VERSION } from "../lib/grade_primitives.mjs";
import { classifyItem } from "./rule_classifier.mjs";
import { loadScreeningStandards } from "./screening_standards_parser.mjs";
import { ensureZoteroBackendReady } from "../lib/ensure_zotero_backend_ready.mjs";
import { checkPwshVersionGate } from "./pwsh_gate.mjs";
import { buildRuntimeConfig, buildRuntimeSafetyConfig } from "../lib/runtime_config.mjs";
import { applyJournalQualityGate, buildEasyScholarSummary, buildJournalQualityConfig } from "./easyscholar_journal_quality_gate.mjs";
import { dayLabel as reviewDayLabel, monthLabel as reviewMonthLabel } from "../lib/report_period_support.mjs";
import { runLlmGradeReviewStep } from "./llm_grade_review_step.mjs";
import { countPotentialDuplicateTitles, dedupWithDiagnostics } from "./dedupe_step.mjs";
import { runPreLlmDedupeStep } from "./pre_llm_dedupe_step.mjs";
import { loadFixtureCandidates } from "./fixture_input.mjs";
import { isoWeek, yyMd } from "../lib/date_label_support.mjs";
import { formatStage1Date, resolveStage1ManualTrigger } from "./runtime_context.mjs";
import { evaluateStage1IntervalGate } from "./interval_gate_step.mjs";
import { runRuleSuggestionStep } from "./rule_suggestions_step.mjs";
import { runScreeningStandardsSyncStep } from "./screening_standards_sync_step.mjs";
import { buildLlmReviewCandidates, gradeReviewPromptContractHash, resolveEligibleRuleGrades, resolveGradeReviewItemLimit } from "./llm_grade_reviewer.mjs";
import { runSourceSelectionAndFetch } from "./source_selection_step.mjs";
import { runPreferenceLearningPhase } from "./preference_learning_step.mjs";
import { runFeedbackActionsAndWriteback } from "./feedback_actions_step.mjs";
import { preparePendingPaperReview, attachPendingPaperReview, finalizePendingPaperReview } from "../lib/pending_paper_review.mjs";
import {
  finalizeRadarStage1,
  isRadarProfile,
  prepareRadarCandidatePool,
  radarPreferenceLearningPlaceholder,
  radarRunArtifactDir,
} from "./radar_step.mjs";
import { buildClassificationContext } from "./classification_fingerprint.mjs";
import { buildLlmRuleContextSummary } from "./llm_rule_context.mjs";
import { getDefaultZoteroLibraryIndexPath } from "../lib/zotero_library_index_store.mjs";
import { runWeeklyIntegrityMonitor } from "../integrity/main.mjs";
import { excludeConfirmedRetractionsFromWeekly } from "../integrity/mutation_plan.mjs";
import {
  applyWeeklyClassificationReuse,
  ensureWeeklyRadarClassificationCoverage,
  finalizeWeeklyRadarReview,
  prepareWeeklyCandidatePool,
} from "./weekly_merge_step.mjs";


export { dedupWithDiagnostics } from "./dedupe_step.mjs";
export { loadFixtureCandidates } from "./fixture_input.mjs";

export function preserveStage1PreferenceLearningContext(preferenceLearning = {}) {
  return {
    preferenceAuditWithImpact: preferenceLearning.preferenceAudit || {},
    preferenceLearningInputs: preferenceLearning.preferenceLearningInputs || { feedbackRows: [], feedbackSource: "none" },
  };
}

const RUNTIME = buildRuntimeConfig();
const ROOT = RUNTIME.projectRoot;
const RESEARCH_ROOT = RUNTIME.researchRoot;
const REVIEW_ROOT = RUNTIME.reviewRoot;
const PW_SH = RUNTIME.pwshPath;
const DESKTOP_REVIEW_ROOT = RUNTIME.legacyDesktopReviewRoot;
const RUNTIME_STATE_PATH = path.join(RESEARCH_ROOT, "runtime_state.json");
let latestTimingDiagnostics = null;

function parseBooleanFlag(value) {
  return /^(1|true|yes)$/i.test(String(value || "").trim());
}

export async function runResearchOsPipeline({
  argv = process.argv,
  candidateSource = null,
  existingItemLookup = null,
  feedbackActionSink = null,
  normalizedFeedbackRows = null,
  feedbackSource = "",
  skipZotero = null,
  zoteroBoundaries = {},
} = {}) {
  const totalStarted = Date.now();
  const runProfile = String(process.env.PAPERECHO_RUN_PROFILE || "standard").trim().toLowerCase();
  const radarProfile = isRadarProfile(runProfile);
  const zoteroSkipped = skipZotero == null ? radarProfile : Boolean(skipZotero);
  const runId = String(process.env.PAPERECHO_RUN_ID || "");
  const exportLimitArg = argv.find((x) => x.startsWith("--export-limit="));
  const exportLimit = exportLimitArg ? Number(exportLimitArg.split("=")[1]) : null;
  const now = RUNTIME.now;
  const dateStr = formatStage1Date(now);
  const week = isoWeek(now);
  const day = yyMd(now);
  const monthDir = reviewMonthLabel(now);
  const reviewDayDirName = reviewDayLabel(now);
  const pipeDir = RUNTIME.pipelineDir;
  await fs.mkdir(pipeDir, { recursive: true });
  await fs.mkdir(REVIEW_ROOT, { recursive: true });

  const runIntervalDays = Number(process.env.review_results_RUN_INTERVAL_DAYS || 7);
  const triggerMode = process.env.review_results_ORCHESTRATOR_TRIGGER || "";
  const manualTrigger = resolveStage1ManualTrigger(triggerMode);
  const explicitForceRun = parseBooleanFlag(process.env.FORCE_review_results_RUN) || parseBooleanFlag(process.env.review_results_FORCE_RUN);
  const {
    forceRun,
    runDue,
    intervalInfo,
    nextEligibleRunAt,
    currentRunAtIso,
    intervalGateDiagnostics,
  } = await evaluateStage1IntervalGate({
    runtimeStatePath: RUNTIME_STATE_PATH,
    now,
    runIntervalDays,
    triggerMode,
    manualTrigger,
    explicitForceRun: explicitForceRun || radarProfile,
  });
  if (!runDue && !forceRun) {
    const skipReport = buildStage1SkipRunReport({
      startedAt: currentRunAtIso,
      intervalInfo,
      intervalGateDiagnostics,
      triggerMode,
      forceRun,
      monthDir,
      reviewDayDir: reviewDayDirName,
      exportRoot: REVIEW_ROOT,
    });
    skipReport.stage1_artifact_manifest = buildStage1ArtifactManifest({
      pipelineDay: day,
      pipelineDir: pipeDir,
      mode: "skipped",
    });
    await fs.writeFile(path.join(pipeDir, "run_skip_report.json"), JSON.stringify(skipReport, null, 2), "utf8");
    await fs.writeFile(path.join(pipeDir, "run_report.json"), JSON.stringify(skipReport, null, 2), "utf8");
    console.log(JSON.stringify({ ok: true, skipped: true, reason: "interval_not_reached", next_eligible_run_at: nextEligibleRunAt }, null, 2));
    return;
  }

  let report = buildStage1RunReport({
    startedAt: new Date().toISOString(),
    date: dateStr,
    monthDir,
    reviewDayDir: reviewDayDirName,
    weekDir: week,
    dayDir: day,
    intervalInfo,
    intervalGateDiagnostics,
    triggerMode,
    forceRun,
    exportRoot: REVIEW_ROOT,
  });
  const timingDiagnosticsPath = path.join(pipeDir, "timing_diagnostics.json");
  let lastCompletedTimingName = "";
  let lastKnownPhase = "report_initialized";
  let timingWrites = Promise.resolve();
  const writeTimingDiagnostics = async (reason, extra = {}) => {
    if (extra.last_known_phase) lastKnownPhase = extra.last_known_phase;
    latestTimingDiagnostics = {
      path: timingDiagnosticsPath,
      generated_at: new Date().toISOString(),
      reason,
      stage_timings: report.stage_timings,
      last_completed_timing_name: lastCompletedTimingName,
      last_known_phase: lastKnownPhase,
      ...extra,
    };
    const snapshot = structuredClone(latestTimingDiagnostics);
    timingWrites = timingWrites.then(() => writeAtomicJson(timingDiagnosticsPath, snapshot));
    await timingWrites;
  };
  const flushTimingDiagnostics = (reason, extra = {}) => {
    return writeTimingDiagnostics(reason, extra).catch(() => {});
  };
  const recordTiming = (name, startedMs, extra = {}) => {
    report.stage_timings[name] = {
      status: "completed",
      ms: Date.now() - startedMs,
      ...extra,
    };
    lastCompletedTimingName = name;
    lastKnownPhase = name;
    flushTimingDiagnostics("recordTiming", { timing_name: name });
  };
  // --- Preference learning phase ---
  const pubmedPmcConfigPath = path.join(ROOT, "config", "pubmed_pmc_search.json");
  const pubmedPmcConfig = loadPubMedPmcSearchConfig({ root: ROOT, now: new Date() });
  const llmPreferenceStarted = Date.now();
  const preferenceLearning = radarProfile ? radarPreferenceLearningPlaceholder() : await runPreferenceLearningPhase({
    reviewRoot: REVIEW_ROOT,
    desktopRoot: DESKTOP_REVIEW_ROOT,
    researchRoot: RESEARCH_ROOT,
    root: ROOT,
    pipeDir,
    now,
    workflowRules: loadWorkflowRules(),
    normalizedFeedbackRows,
    feedbackSource,
  });

  // Update report with preference learning results
  report.steps.manual_standard_evaluation = preferenceLearning.manualStandardEvaluation;
  report.manual_standard_evaluation_default_enabled = true;
  report.manual_standard_evaluation_api_key_configured = Boolean(preferenceLearning.manualStandardEvaluation?.llm_api_key_configured);
  report.manual_standard_evaluation_api_key_source = preferenceLearning.manualStandardEvaluation?.llm_api_key_source || "";
  report.steps.feedback_learning = preferenceLearning.feedbackLearning;
  report.steps.med_query_learning = preferenceLearning.medQueryLearning;
  report.preference_learning_execution_summary = preferenceLearning.preferenceLearningExecutionSummary;

  recordTiming("llm_preference_learning", llmPreferenceStarted, {
    method: "llm_preference_learning",
    ok: Boolean(preferenceLearning.llmPreferenceReport.ok),
    skipped: Boolean(preferenceLearning.llmPreferenceReport.skipped),
    mock_response_used: Boolean(preferenceLearning.llmPreferenceReport.mock_response_used),
    real_request_sent: Boolean(preferenceLearning.llmPreferenceReport.real_request_sent),
  });
  recordTiming("semantic_preference_refinement", llmPreferenceStarted, {
    method: "llm_preference_learning",
    replaced_by: "llm_preference_learning",
    enabled: Boolean(preferenceLearning.llmPreferenceReport.enabled),
    semantic_search_used: false,
    semantic_status_checked: false,
    semantic_queries_attempted: 0,
    semantic_queries_failed: 0,
    llm_preference_learning_ok: Boolean(preferenceLearning.llmPreferenceReport.ok),
    llm_preference_learning_skipped: Boolean(preferenceLearning.llmPreferenceReport.skipped),
  });

  // --- Pwsh gate and connector ---
  report.steps.pwsh_gate = zoteroSkipped ? { pwsh_gate_passed: true, skipped: true, reason: radarProfile ? "radar_no_writeback" : "local_mode" } : checkPwshVersionGate(PW_SH);
  if (!report.steps.pwsh_gate.pwsh_gate_passed && !report.steps.pwsh_gate.pwsh_version_unknown) {
    report.failures.push({
      stage: "pwsh_gate",
      reason: report.steps.pwsh_gate.pwsh_gate_message,
      pwsh_required_min_version: report.steps.pwsh_gate.pwsh_required_min_version,
      pwsh_detected_version: report.steps.pwsh_gate.pwsh_detected_version,
      pwsh_version_unknown: report.steps.pwsh_gate.pwsh_version_unknown,
    });
  }
  try {
    if (zoteroSkipped) {
      report.steps.connector = { ok: false, skipped: true, local_mode: !radarProfile, radar_no_writeback: radarProfile, probe_attempted: false, writeback_attempted: false };
    } else {
      const ensureBackendReady = zoteroBoundaries.ensureBackendReady || ensureZoteroBackendReady;
      report.steps.connector = await ensureBackendReady({ retries: 1, intervalMs: 1000, postStartDelayMs: 0 });
    }
  } catch (err) {
    report.steps.connector = { ok: false, error: String(err?.message || err), errorCode: err?.code };
  }

  // --- Source selection: determine which retrieval sources to run ---
  const fetchStarted = Date.now();
  const fixture = await loadFixtureCandidates({
    fixtureRoot: RUNTIME.fixtureRoot,
    dryRun: buildRuntimeSafetyConfig({ runtime: RUNTIME, argv }).dry_run,
    allowFixture: parseBooleanFlag(process.env.PAPERFLOW_ALLOW_FIXTURE_INPUT),
  });
  const radarArtifactDir = radarProfile ? radarRunArtifactDir(REVIEW_ROOT, runId) : "";
  const sourceResult = Array.isArray(candidateSource)
    ? {
        sourceSelection: { ok: true, research_domain: "local", primary_sources: ["local_import"], supplemental_sources: [], enabled_sources: ["local_import"], require_manual_confirmation: false, warnings: [] },
        sourceCollectionSummary: { pre_dedup_items_count: candidateSource.length, local_input: true },
        rss: { items: candidateSource, failed: [], config: { warnings: [] } },
        db: { items: [], failed: [], config: { databases: [], warnings: [] } },
        openalex: { items: [], failed: [], config: { warnings: [] }, skipped_reason: "local_input" },
        semanticScholar: { items: [], failed: [], config: { warnings: [] }, skipped_reason: "local_input" },
        crossref: { items: [], failed: [], config: { warnings: [] }, skipped_reason: "local_input" },
        europePmc: { items: [], failed: [], config: { warnings: [] }, skipped_reason: "local_input" },
        retrievalHealth: null,
      }
    : fixture.enabled
    ? {
        sourceSelection: {
          ok: true,
          research_domain: "fixture",
          primary_sources: ["fixture"],
          supplemental_sources: [],
          enabled_sources: ["rss"],
          require_manual_confirmation: false,
          warnings: [],
          fixture_path: fixture.path,
        },
        sourceCollectionSummary: {
          pre_dedup_items_count: fixture.items.length,
          fixture_input: true,
        },
        rss: { items: fixture.items, failed: [], config: { enabled_count: 0, warnings: [], path: fixture.path } },
        db: { items: [], failed: [], config: { databases: [], warnings: [] } },
        openalex: { items: [], failed: [], config: { warnings: [] }, skipped_reason: "fixture_input" },
        semanticScholar: { items: [], failed: [], config: { warnings: [] }, skipped_reason: "fixture_input" },
        crossref: { items: [], failed: [], config: { warnings: [] }, skipped_reason: "fixture_input" },
        europePmc: { items: [], failed: [], config: { warnings: [] }, skipped_reason: "fixture_input" },
        retrievalHealth: null,
      }
    : await runSourceSelectionAndFetch({
        root: ROOT,
        pubmedPmcConfig,
        now,
        pipeDir: radarProfile ? radarArtifactDir : pipeDir,
        profile: radarProfile ? "radar" : "weekly",
        sourceStateRoot: process.env.PAPERECHO_SOURCE_STATE_ROOT || path.join(RESEARCH_ROOT, "source_state"),
        deferCommit: radarProfile,
      });
  const { sourceSelection, sourceCollectionSummary, rss, db, openalex, semanticScholar, crossref, europePmc, retrievalHealth = null, retrievalAuditPath = "", retrievalTransaction = null } = sourceResult;
  const rssEnabled = sourceSelection.enabled_sources?.includes("rss") ?? false;
  const pubmedEnabled = sourceSelection.enabled_sources?.includes("pubmed_pmc") ?? false;
  const openalexEnabled = sourceSelection.enabled_sources?.includes("openalex") ?? false;
  const manualConfirmationRequired = sourceSelection.require_manual_confirmation ?? false;

  report.steps.source_selection = sourceSelection;
  report.stage_timings.fetch = { status: "completed", ms: Date.now() - fetchStarted };
  report.counts.rss_raw = rss.items.length;
  report.counts.db_raw = db.items.length;
  report.counts.openalex_raw = openalex.items.length;
  report.counts.semantic_scholar_raw = semanticScholar.items.length;
  report.counts.crossref_raw = crossref.items.length;
  report.counts.europe_pmc_raw = europePmc.items.length;
  report.failures.push(...rss.failed.map((f) => ({ stage: "rss", ...f })));
  report.failures.push(...db.failed.map((f) => ({ stage: "pubmed", ...f })));
  report.failures.push(...openalex.failed.map((f) => ({ stage: "openalex", ...f })));
  report.failures.push(...semanticScholar.failed.map((f) => ({ stage: "semantic_scholar", ...f })));
  report.failures.push(...crossref.failed.map((f) => ({ stage: "crossref", ...f })));
  report.failures.push(...europePmc.failed.map((f) => ({ stage: "europe_pmc", ...f })));

  report.steps.med_entry_parallel = {
    ok: true,
    rss_raw: rss.items.length,
    db_raw: db.items.length,
    openalex_raw: openalex.items.length,
    semantic_scholar_raw: semanticScholar.items.length,
    crossref_raw: crossref.items.length,
    europe_pmc_raw: europePmc.items.length,
    rss_failures: rss.failed.length,
    db_failures: db.failed.length,
    openalex_failures: openalex.failed.length,
    semantic_scholar_failures: semanticScholar.failed.length,
    crossref_failures: crossref.failed.length,
    europe_pmc_failures: europePmc.failed.length,
    rss_config_path: rss.config?.path || "",
    rss_sources_enabled: rss.config?.enabled_count || 0,
    pubmed_pmc_config_path: db.config?.path || "",
    pubmed_pmc_databases: db.config?.databases || [],
    pubmed_pmc_days_back: db.config?.days_back ?? 10,
    pubmed_pmc_mindate: db.config?.minDate || "",
    pubmed_pmc_maxdate: db.config?.maxDate || "",
    pubmed_pmc_warnings: db.config?.warnings || [],
    openalex_skipped_reason: openalex.skipped_reason || openalex.config?.skipped_reason || null,
    source_selection_domain: sourceSelection.research_domain,
    source_selection_enabled: sourceSelection.enabled_sources,
    source_selection_manual_confirmation: manualConfirmationRequired,
    source_collection_summary: sourceCollectionSummary,
    retrieval_health: retrievalHealth,
  };

  report.steps.retrieval_health = retrievalHealth;
  const rawCandidates = [...rss.items, ...db.items, ...openalex.items, ...semanticScholar.items, ...crossref.items, ...europePmc.items];
  const llmRuntime = resolveLlmRuntime();
  const weeklyRadarMergeEnabled = !radarProfile && !zoteroSkipped && Boolean(runId);
  const radarPreparation = radarProfile
    ? await prepareRadarCandidatePool({ projectRoot: ROOT, reviewRoot: REVIEW_ROOT, runId, currentCandidates: rawCandidates })
    : null;
  const weeklyPreparation = weeklyRadarMergeEnabled
    ? await prepareWeeklyCandidatePool({ projectRoot: ROOT, runId, currentCandidates: rawCandidates, llmRuntime })
    : null;
  const currentCandidates = radarPreparation?.candidates || weeklyPreparation?.candidates || rawCandidates;
  const pendingPreparation = !radarProfile && !zoteroSkipped
    ? await preparePendingPaperReview({ reviewRoot: REVIEW_ROOT, candidates: currentCandidates })
    : null;
  const dedupeInput = pendingPreparation?.input || currentCandidates;
  const dedupeStarted = Date.now();
  const dedupeResult = dedupWithDiagnostics(dedupeInput);
  const merged = dedupeResult.items;
  if (pendingPreparation) attachPendingPaperReview(merged, pendingPreparation);
  const dedupSummary = buildStage1DedupSummary({
    inputItems: dedupeInput,
    dedupedItems: merged,
    dedupDiagnostics: dedupeResult.diagnostics,    dedupKeyStrategy: "doi > pmid > pmcid > url > normalized_title",
  });
  report.steps.dedupe = {
    ok: true,
    ...dedupeResult.diagnostics,
    dedup_summary: dedupSummary,
  };
  report.stage_timings.dedupe = {
    status: "completed",
    ms: Date.now() - dedupeStarted,
    fetched_count: dedupeResult.diagnostics.fetched_count,
    deduped_count: dedupeResult.diagnostics.deduped_count,
    duplicate_removed_count: dedupeResult.diagnostics.duplicate_removed_count,
  };
  const triageStandards = loadScreeningStandards(REVIEW_ROOT);
  report.triage_standards = {
    path: triageStandards.path || "",
    loaded: Boolean(triageStandards.loaded),
    parsed: Boolean(triageStandards.parsed),
    rules_count: (triageStandards.hard_excludes || []).length,
    error: triageStandards.error || "",
  };
  if (!triageStandards.parsed) {
    report.failures.push({ stage: "triage_standards", reason: "screening_standards_unavailable_using_fallback", fallback: "hardcoded_keywords_only" });
  }
  const triageStarted = Date.now();
  let triagedAll = merged.map((it) => {
    const scored = classifyItem(it, report.steps.feedback_learning || { hardPositiveTerms: [], hardNegativeTerms: [] }, triageStandards);
    return {
      ...it,
      grade: scored.grade,
      grade_label: scored.grade_label,
      grade_reason: scored.grade_reason,
      classification_reason: scored.classification_reason,
      hard_excluded: scored.hard_excluded,
      matched_standard_rules: scored.matched_standard_rules,
      standards_used: scored.standards_used,
      matched_signals: scored.matched_signals,
      source: scored.source,
      dedupe_key: scored.dedupe_key,
      writeback_ready: scored.writeback_ready,
      flags: scored.flags,
      triage_version: scored.triage_version,
      推荐等级: scored.grade_label,
      中文标题: "",
      推荐理由: scored.grade_reason,
      评分明细: scored,
    };
  });
  recordTiming("rule_based_triage", triageStarted, {
    input_count: merged.length,
    output_count: triagedAll.length,
  });

  const stage1TriageSummary = buildStage1TriageSummary({
    items: triagedAll,
    llmReviewCandidateCount: 0, // filled after LLM candidate selection
    writebackReadyItemsCount: 0, // filled after writeback ready artifact
  });
  report.steps.triage = { ok: true, triage_summary: stage1TriageSummary };
  const triageSummary = stage1TriageSummary;

  const workflowRulesForQualityGate = loadWorkflowRules();
  const llmReviewConfig = { ...(workflowRulesForQualityGate?.config?.llm_review || {}) };
  if (radarProfile) llmReviewConfig.eligible_rule_grades = ["A", "B", "C"];
  else if (pendingPreparation) llmReviewConfig.eligible_rule_grades = ["A", "B", "C", "D"];
  let classificationRuleContext = null;
  try {
    classificationRuleContext = await buildLlmRuleContextSummary({ root: ROOT, reviewRoot: REVIEW_ROOT });
  } catch {
    classificationRuleContext = null;
  }
  const classificationContext = buildClassificationContext({
    workflowRules: workflowRulesForQualityGate,
    screeningStandards: triageStandards,
    feedbackLearning: report.steps.feedback_learning,
    promptHash: gradeReviewPromptContractHash(),
    ruleContextHash: classificationRuleContext?.context_hash || "",
    runtime: llmRuntime,
    classifierCodeVersion: TRIAGE_VERSION,
  });
  const llmCachePath = path.join(pipeDir, "llm_cache.json");
  let maxGradeReviewItemsSource = "default";
  let effectiveMaxGradeReviewItems = llmReviewConfig.max_grade_review_items || 50;
  let effectiveGradeReviewBatchSize = llmReviewConfig.grade_review_batch_size || llmReviewConfig.batch_size || 25;
  let gradeReviewBatchSizeSource = "default";
  const preferenceAuditPath = path.join(pipeDir, "preference_learning_audit.json");
  const { preferenceAuditWithImpact, preferenceLearningInputs } = preserveStage1PreferenceLearningContext(preferenceLearning);
  const qualityGateStarted = Date.now();
  const qualityGate = await applyJournalQualityGate(triagedAll, {
    config: buildJournalQualityConfig(workflowRulesForQualityGate.config || workflowRulesForQualityGate),
    cachePath: path.join(RESEARCH_ROOT, "journal_quality_cache.json"),
  });
  triagedAll = qualityGate.items;
  const weeklyReuse = weeklyRadarMergeEnabled
    ? applyWeeklyClassificationReuse(triagedAll, classificationContext)
    : { decisions: [], reusedCount: 0, regradeCount: 0 };
  if (weeklyPreparation) report.steps.weekly_radar_merge = { ...weeklyPreparation.audit, classification: weeklyReuse };
  const llmReviewCandidateTelemetry = buildLlmReviewCandidates(triagedAll, {
    eligibleRuleGrades: resolveEligibleRuleGrades(llmReviewConfig),
    duplicateRemovedCount: report.steps.dedupe.duplicate_removed_count ?? 0,
  });
  const llmReviewCandidateCount = llmReviewCandidateTelemetry.summary.llm_review_candidate_count;
  report.steps.dedupe.llm_review_candidate_count = llmReviewCandidateCount;
  report.steps.dedupe.duplicates_still_reviewed_count = countPotentialDuplicateTitles(triagedAll);
  report.steps.dedupe.excluded_non_abc_count = llmReviewCandidateTelemetry.summary.excluded_non_abc_count;
  report.steps.dedupe.excluded_not_deduped_count = llmReviewCandidateTelemetry.summary.excluded_not_deduped_count;
  report.steps.journal_quality_gate = {
    ...qualityGate.report,
    audit_path: path.join(pipeDir, "pubmed_journal_quality_gate_report.json"),
  };
  report.steps.journal_quality_gate.easy_scholar_summary = buildEasyScholarSummary(qualityGate.report);
  report.easy_scholar_summary = report.steps.journal_quality_gate.easy_scholar_summary;
  report.stage_timings.journal_quality_gate = { status: "completed", ms: Date.now() - qualityGateStarted };
  await fs.writeFile(report.steps.journal_quality_gate.audit_path, JSON.stringify(report.steps.journal_quality_gate, null, 2), "utf8");

  const preLlmExistingDedupeStarted = Date.now();
  const preLlmDedupeStep = await runPreLlmDedupeStep({
    triagedItems: triagedAll,
    llmReviewConfig,
    duplicateRemovedCount: report.steps.dedupe.duplicate_removed_count ?? 0,
    llmReviewCandidateCount,
    connectorOk: Boolean(report.steps.connector?.ok),
    existingItemLookup,
    zoteroBackendFactory: zoteroBoundaries.backendFactory,
  });
  const preLlmExistingDedupe = preLlmDedupeStep.preLlmExistingDedupe;
  const llmReviewCandidateSelection = preLlmDedupeStep.llmReviewCandidateSelection;
  const weeklyClassificationCoverage = weeklyPreparation
    ? ensureWeeklyRadarClassificationCoverage({ items: triagedAll, llmReviewItems: preLlmDedupeStep.llmReviewItems })
    : { llmReviewItems: preLlmDedupeStep.llmReviewItems, restoredExistingCount: 0, forcedReviewCount: 0 };
  const llmReviewItems = weeklyClassificationCoverage.llmReviewItems;
  if (weeklyPreparation) report.steps.weekly_radar_merge.classification_coverage = {
    restoredExistingCount: weeklyClassificationCoverage.restoredExistingCount,
    forcedReviewCount: weeklyClassificationCoverage.forcedReviewCount,
    llmReviewItemCount: llmReviewItems.length,
  };
  const gradeReviewItemLimit = resolveGradeReviewItemLimit(llmReviewConfig, {
    candidateCount: llmReviewItems.length,
    runtimeOverride: buildRuntimeSafetyConfig({ runtime: RUNTIME, argv }).max_grade_review_items,
  });
  llmReviewConfig.max_grade_review_items = gradeReviewItemLimit.maxItems;
  effectiveMaxGradeReviewItems = gradeReviewItemLimit.maxItems;
  maxGradeReviewItemsSource = gradeReviewItemLimit.source;
  report.steps.pre_llm_zotero_existing_dedupe = preLlmExistingDedupe.diagnostics;
  report.steps.dedupe.pre_llm_zotero_existing_dedupe = preLlmExistingDedupe.diagnostics;
  report.steps.dedupe.llm_review_candidate_count_before_zotero_dedupe = llmReviewCandidateCount;
  report.steps.dedupe.llm_review_candidate_count_after_zotero_dedupe = preLlmExistingDedupe.diagnostics.llm_review_candidate_count_after_zotero_dedupe;
  report.steps.dedupe.skipped_llm_review_existing_count = preLlmExistingDedupe.diagnostics.skipped_llm_review_existing_count;
  report.steps.dedupe.duplicate_check_failed_reviewed_count = preLlmExistingDedupe.diagnostics.duplicate_check_failed_reviewed_count;
  recordTiming("pre_llm_zotero_existing_dedupe", preLlmExistingDedupeStarted, {
    ok: Boolean(preLlmExistingDedupe.diagnostics.ok),
    pre_llm_zotero_duplicate_checked_count: Number(preLlmExistingDedupe.diagnostics.pre_llm_zotero_duplicate_checked_count || 0),
    pre_llm_existing_duplicate_count: Number(preLlmExistingDedupe.diagnostics.pre_llm_existing_duplicate_count || 0),
    pre_llm_duplicate_check_failed_count: Number(preLlmExistingDedupe.diagnostics.pre_llm_duplicate_check_failed_count || 0),
    llm_review_candidate_count_before_zotero_dedupe: Number(preLlmExistingDedupe.diagnostics.llm_review_candidate_count_before_zotero_dedupe || 0),
    llm_review_candidate_count_after_zotero_dedupe: Number(preLlmExistingDedupe.diagnostics.llm_review_candidate_count_after_zotero_dedupe || 0),
    skipped_llm_review_existing_count: Number(preLlmExistingDedupe.diagnostics.skipped_llm_review_existing_count || 0),
    duplicate_check_failed_reviewed_count: Number(preLlmExistingDedupe.diagnostics.duplicate_check_failed_reviewed_count || 0),
    search_library_parse_error_count: Number(preLlmExistingDedupe.diagnostics.search_library_parse_error_count || 0),
    search_query_fallback_success_count: Number(preLlmExistingDedupe.diagnostics.search_query_fallback_success_count || 0),
  });

  // ─── LLM Grade Review Pass ──────────────────────────────────────────
  const { llmGradeReport, semanticGradingReport } = await runLlmGradeReviewStep({
    triagedAll,
    llmReviewItems,
    llmReviewCandidateCount,
    preLlmExistingDedupe,
    llmReviewConfig,
    llmRuntime,
    llmCachePath,
    pipeDir,
    report,
    recordTiming,
    reviewConfig: {
      effectiveMaxGradeReviewItems,
      maxGradeReviewItemsSource,
      effectiveGradeReviewBatchSize,
      gradeReviewBatchSizeSource,
    },
    root: ROOT,
    reviewRoot: REVIEW_ROOT,
    mergedCount: merged.length,
    ruleContextSummary: classificationRuleContext,
  });
  if (pendingPreparation) {
    report.steps.pending_paper_review = {
      ...await finalizePendingPaperReview({ reviewRoot: REVIEW_ROOT, items: triagedAll }),
      previously_confirmed_injected: pendingPreparation.injectedCount,
    };
  }
  if (weeklyPreparation) {
    const weeklyFinalize = await finalizeWeeklyRadarReview({
      items: triagedAll,
      classificationContext,
      runId,
      paths: weeklyPreparation.paths,
    });
    report.steps.weekly_radar_merge = { ...report.steps.weekly_radar_merge, lifecycle: weeklyFinalize };
  }
  const preferenceAuditStarted = Date.now();
  await fs.writeFile(preferenceAuditPath, JSON.stringify(preferenceAuditWithImpact, null, 2), "utf8");
  recordTiming("preference_audit", preferenceAuditStarted, {
    triaged_count: triagedAll.length,
    audit_path: preferenceAuditPath,
    timing_scope: "exclusive_artifact_write",
    excludes: ["journal_quality_gate", "pre_llm_zotero_existing_dedupe", "llm_grade_review", "semantic_grading"],
  });

  // ─── Rule Suggestion Generation ──────────────────────────────────────
  const ruleSuggestionsStarted = Date.now();
  const ruleSuggestionsReport = radarProfile ? { status: "skipped", reason: "radar_profile", standards_rule_suggestions_count: 0 } : await runRuleSuggestionStep({
    reviewRoot: REVIEW_ROOT,
    root: ROOT,
    pipeDir,
    startedAt: report.started_at,
    feedbackLearning: report.steps.feedback_learning,
    manualStandardEvaluation: report.steps.manual_standard_evaluation,
  });
  report.steps.standards_rule_suggestions = ruleSuggestionsReport;

  // ─── Screening Standards Sync Summary ────────────────────────────────
  const screeningStandardsSyncSummary = radarProfile ? { status: "skipped", reason: "radar_profile" } : runScreeningStandardsSyncStep({
    ruleSuggestionsReport,
    manualStandardEvaluation: report.steps.manual_standard_evaluation,
    medQueryLearning: report.steps.med_query_learning,
    preferenceLearningInputs,
  });
  report.screening_standards_sync_summary = screeningStandardsSyncSummary;
  report.steps.med_query_learning.screening_standards_sync_summary = screeningStandardsSyncSummary;
  recordTiming("rule_suggestions", ruleSuggestionsStarted, {
    status: ruleSuggestionsReport.suggestions_error ? "error" : "completed",
    suggestions_count: Number(ruleSuggestionsReport.standards_rule_suggestions_count || 0),
  });

  // ─── Feedback Item Actions ──────────────────────────────────────────
  const feedbackItemActionsStarted = Date.now();
  const feedbackActionsResult = await runFeedbackActionsAndWriteback({
    report,
    triagedAll,
    llmReviewCandidateSelection,
    connectorOk: Boolean(report.steps.connector?.ok),
    researchRoot: RESEARCH_ROOT,
    reviewRoot: REVIEW_ROOT,
    pipeDir,
    startedAt: report.started_at,
    timingContext: { recordTiming, flushTimingDiagnostics, lastKnownPhase },
    exportLimit,
    translationCachePath: RUNTIME.translationCachePath,
    feedbackActionSink,
    normalizedFeedbackRows: normalizedFeedbackRows || [],
    skipItemActions: radarProfile,
    noWriteback: radarProfile,
  }).catch(async (error) => {
    if (error.code === "FEEDBACK_ENRICHMENT_INCOMPLETE") {
      report.status = error.status;
      report.steps.feedback_item_actions = error.feedbackItemActionsReport;
      await writeAtomicJson(path.join(pipeDir, "run_report.json"), report);
    }
    throw error;
  });
  lastKnownPhase = feedbackActionsResult.lastKnownPhase;
  let { writebackReady } = feedbackActionsResult;
  const { triaged, abcAllItems, translationConfig } = feedbackActionsResult;
  let integrityResult;
  try {
    integrityResult = await runWeeklyIntegrityMonitor({
      profile: runProfile,
      indexPath: getDefaultZoteroLibraryIndexPath(ROOT),
      pipeDir,
      now,
    });
    if (integrityResult.updatedIndex) writebackReady = excludeConfirmedRetractionsFromWeekly(writebackReady, integrityResult.updatedIndex);
  } catch (error) {
    integrityResult = { status: "degraded", reason: String(error?.message || error).slice(0, 200), checkedCount: 0, plan: [] };
  }
  report.steps.literature_integrity = {
    status: integrityResult.status,
    reason: integrityResult.reason || "",
    checked_count: Number(integrityResult.checkedCount || 0),
    newly_confirmed_retraction_count: Number(integrityResult.newlyConfirmedRetractionCount || 0),
    changed_count: Number(integrityResult.changedCount || 0),
    conflict_count: Number(integrityResult.conflictCount || 0),
    new_correction_count: (integrityResult.changes || []).filter((change) => change.toStatus === "correction").length,
    new_expression_of_concern_count: (integrityResult.changes || []).filter((change) => change.toStatus === "expression_of_concern").length,
    mutation_plan_count: Array.isArray(integrityResult.plan) ? integrityResult.plan.length : 0,
  };

  report = buildCompletedStage1RunReport({
    report,
    mergedCount: merged.length,
    rssItemsCount: rss.items.length,
    dbItemsCount: db.items.length,
    triagedAll,
    triaged,
    triageSummary,
    exportLimit,
    translationConfig,
    translationCachePath: RUNTIME.translationCachePath,
    triageDurationMs: Date.now() - triageStarted,
    triageVersion: TRIAGE_VERSION,
    labels: LABELS,
    dateStr,
    starMigrationDefaults: {
      default_mode: process.env.ZOTERO_STAR_MIGRATION_MODE || "expand",
      default_window_days: Number(process.env.ZOTERO_STAR_MIGRATION_WINDOW_DAYS || 10) || 10,
      default_star_threshold: Number(process.env.ZOTERO_STAR_MIGRATION_MIN_STARS || 4) || 4,
    },
  });

  report.stage1_artifact_manifest = buildStage1ArtifactManifest({
    pipelineDay: day,
    pipelineDir: pipeDir,
    mode: "completed",
    written: "planned",
    retrievalWritten: radarProfile ? false : Boolean(retrievalAuditPath),
  });
  const finalArtifactWritesStarted = Date.now();
  await writeStage1CompletedArtifacts({
    pipeDir,
    rssItems: rss.items,
    rssFailed: rss.failed,
    dbItems: db.items,
    mergedItems: merged,
    triagedAll,
    triaged,
    writebackReady,
    dateStr,
    report,
    abcAllItems,
    preferenceAuditWithImpact,
  });
  const radarResult = radarProfile ? await finalizeRadarStage1({
    projectRoot: ROOT,
    artifactDir: radarPreparation.artifactDir,
    runId,
    triagedItems: triagedAll,
    llmGradeReport,
    classificationContext,
    retrievalTransaction,
    paths: radarPreparation.paths,
  }) : null;
  if (radarResult) {
    report.profile = "radar";
    report.steps.radar = radarResult.audit;
    report.radar_artifact_path = radarResult.auditPath;
  }
  recordTiming("final_artifact_writes", finalArtifactWritesStarted, {
    artifact_count_before_final_report: 11,
  });

  // Legacy compatibility: the writer includes the first run_report.json write
  // (reported as "planned" manifest) and desktop_daily_review_source.json.
  // Below we finalize the manifest and write the final run_report.json.

  report.steps.med_monthly_synthesis = { ok: false, deferred_until: "workflow/tools/stage4/main.mjs" };
  report.steps.med_weekly_synthesis = {
    ...report.steps.med_monthly_synthesis,
    legacy_alias_for: "med_monthly_synthesis",
  };
  report.stage_timings.total = { status: "completed", ms: Date.now() - totalStarted };
  const llmHealthSummaries = [report.llm_review_execution_summary, report.preference_learning_execution_summary].filter(Boolean);
  const llmHealthObserved = llmHealthSummaries.some((summary) => summary.enabled === true && (summary.triggered === true || summary.degraded === true));
  report.notification_health_observations = [
    ...(sourceResult.healthObservations || []),
    ...(llmHealthObserved ? [{ kind: "llm", healthKey: "llm:stage1:preference_and_grade", degraded: llmHealthSummaries.some((summary) => summary.degraded === true), subject: { label: "stage1_llm" } }] : []),
  ];
  report.stage1_artifact_manifest = buildStage1ArtifactManifest({
    pipelineDay: day,
    pipelineDir: pipeDir,
    mode: "completed",
    written: true,
    retrievalWritten: radarProfile ? Boolean(radarResult?.audit?.watermarkCommitted) : Boolean(retrievalAuditPath),
  });
  await fs.writeFile(path.join(pipeDir, "run_report.json"), JSON.stringify(report, null, 2), "utf8");

  console.log(JSON.stringify({ ok: true, output_dir: pipeDir, counts: report.counts, connector_ok: report.steps.connector.ok }, null, 2));
  return { ok: true, pipeDir, report, triagedAll, writebackReady, abcAllItems, radar: radarResult };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runResearchOsPipeline().catch(async (err) => {
    if (latestTimingDiagnostics?.path) {
      try {
        await fs.writeFile(latestTimingDiagnostics.path, JSON.stringify({
          ...latestTimingDiagnostics,
          generated_at: new Date().toISOString(),
          reason: "top_level_catch",
          error: {
            name: err?.name || "",
            message: String(err?.message || err),
            code: err?.code || "",
          },
        }, null, 2), "utf8");
      } catch {}
    }
    console.error(err);
    process.exit(1);
  });
}
