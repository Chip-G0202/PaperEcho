/**
 * Source selection and retrieval step.
 *
 * Determines which retrieval sources to run based on source_selection.json,
 * executes the enabled sources, and returns the results.
 */
import { loadSourceSelectionConfig, loadOpenAlexConfig, resolveRetrievalPlan } from "../lib/literature_config.mjs";
import path from "node:path";
import { runSelectedRetrievalSources } from "./retrieval_step.mjs";
import { buildStage1SourceSummary } from "./source_summary.mjs";
import { commitRetrievalTransaction, RETRIEVAL_AUDIT_SCHEMA_VERSION, sourceHealthObservations } from "./source_state.mjs";
import { dedupWithDiagnostics } from "./dedupe_step.mjs";
import { buildSearchIntent } from "./search_intent.mjs";
import {
  buildRetrievalSufficiencySummary,
  fetchCrossrefRescue,
  fetchEuropePmcRescue,
  fetchSemanticScholar,
} from "./retrieval_sources.mjs";

function isoDate(value) {
  const text = String(value || "").trim().replace(/\//g, "-");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function daysAgo(now, days) {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - Math.max(1, Number(days || 10)));
  return date.toISOString().slice(0, 10);
}

function disabledSource(source, reason = "disabled") {
  return {
    items: [], failed: [], config: { enabled: false, warnings: [] }, audit: [], stateUpdates: [], skipped_reason: reason,
    metrics: { source, queryVariantCount: 0, requestCount: 0, totalReported: 0, fetched: 0, normalized: 0, uniqueAfterMerge: 0, duplicateCount: 0, errorCount: 0, "429Count": 0, zeroReason: reason, degraded: false },
  };
}

function compactMetrics(source, result, items = result?.items || []) {
  if (result?.metrics) return result.metrics;
  const failed = result?.failed || [];
  return {
    source, queryVariantCount: result?.audit?.length || (result?.audit ? 1 : 0), requestCount: 0,
    totalReported: items.length, fetched: items.length, normalized: items.length,
    uniqueAfterMerge: 0, duplicateCount: 0, errorCount: failed.length, "429Count": 0,
    zeroReason: items.length ? "" : failed.length ? "source_failure" : "healthy_zero", degraded: failed.length > 0,
  };
}

function safeAdapterFailure(source, error) {
  const message = String(error?.message || error);
  return {
    ...disabledSource(source, "source_failure"),
    failed: [{ source, stage: "adapter", error: message }],
    audit: [{ source, complete: false, itemCount: 0, failureStage: "adapter" }],
    metrics: { ...disabledSource(source).metrics, source, errorCount: 1, zeroReason: "source_failure", degraded: true },
  };
}

function generalSearchIntent(openAlexCfg, sourceSelection, now) {
  return buildSearchIntent({
    query: openAlexCfg?.query || "",
    keywordGroups: openAlexCfg?.keyword_groups || null,
    dateRange: {
      from: isoDate(openAlexCfg?.filters?.from_publication_date) || daysAgo(now, openAlexCfg?.days_back || 10),
      to: isoDate(openAlexCfg?.filters?.to_publication_date) || new Date(now).toISOString().slice(0, 10),
    },
    publicationTypes: [openAlexCfg?.filters?.type].filter(Boolean),
    domainHints: [sourceSelection.research_domain],
    sourceHints: sourceSelection.enabled_sources,
  });
}

function biomedicalSearchIntent(pubmedPmcConfig, sourceSelection) {
  return buildSearchIntent({
    query: pubmedPmcConfig?.effective_query || pubmedPmcConfig?.query || "",
    keywordGroups: pubmedPmcConfig?.keyword_groups || null,
    dateRange: { from: isoDate(pubmedPmcConfig?.minDate), to: isoDate(pubmedPmcConfig?.maxDate) },
    domainHints: [sourceSelection.research_domain],
    sourceHints: sourceSelection.enabled_sources,
  });
}

function expandedPrimarySources(sourceSelection, pubmedPmcConfig) {
  return (sourceSelection.primary_sources || []).flatMap((source) => source === "pubmed_pmc" ? (pubmedPmcConfig?.databases || ["pubmed"]) : [source]);
}

/**
 * Run source selection and retrieval.
 *
 * @param {Object} options
 * @param {string} options.root - Project root
 * @param {Object} options.pubmedPmcConfig - PubMed/PMC config
 * @param {Object} options.now - Current date
 * @returns {Promise<{merged: Array, sourceSummary: Object, sourceSelection: Object, rss: Object, db: Object, openalex: Object}>}
 */
export async function runSourceSelectionAndFetch({ root, pubmedPmcConfig, now, pipeDir = "", profile = "weekly", sourceStateRoot = "", fetchers = {}, deferCommit = false }) {
  // Load source selection config
  const sourceSelection = loadSourceSelectionConfig({ root });
  const { rssEnabled, pubmedEnabled, openalexEnabled, semanticScholarEnabled, crossrefRescueEnabled, europePmcRescueEnabled, manualConfirmationRequired } = resolveRetrievalPlan(sourceSelection);

  // Build source selection report
  const sourceSelectionReport = {
    ok: true,
    research_domain: sourceSelection.research_domain,
    primary_sources: sourceSelection.primary_sources,
    supplemental_sources: sourceSelection.supplemental_sources,
    enabled_sources: sourceSelection.enabled_sources || [],
    require_manual_confirmation: manualConfirmationRequired,
    warnings: sourceSelection.warnings || [],
    retrieval_policy: sourceSelection.retrieval,
  };

  // Load OpenAlex config if enabled
  const openAlexCfg = (openalexEnabled || semanticScholarEnabled) ? loadOpenAlexConfig({ root }) : null;
  const generalIntent = generalSearchIntent(openAlexCfg, sourceSelection, now);
  const biomedicalIntent = biomedicalSearchIntent(pubmedPmcConfig, sourceSelection);
  const domain = sourceSelection.research_domain;
  const generalDomain = ["non_biomedical_stem", "education_social_science", "mixed_biomedical_technical"].includes(domain);
  const biomedicalDomain = ["biomedical", "mixed_biomedical_technical"].includes(domain);

  // Run retrieval
  const stateRoot = sourceStateRoot || path.join(root, "review_results", "source_state");
  const { rss, db, openalex, semanticScholar } = await runSelectedRetrievalSources({
    root,
    pubmedPmcConfig,
    openAlexConfig: openAlexCfg ? {
      ...openAlexCfg,
      diagnostics_enabled: sourceSelection.retrieval.diagnostics.enabled,
      diagnostic_probe_budget: sourceSelection.retrieval.diagnostics.probe_budget,
      request_budget: sourceSelection.retrieval.openalex.request_budget,
      semantic_rescue_enabled: sourceSelection.retrieval.openalex.semantic_rescue_enabled,
      semantic_rescue_max_results: sourceSelection.retrieval.openalex.semantic_rescue_max_results,
    } : null,
    searchIntent: generalIntent,
    semanticScholarConfig: sourceSelection.retrieval.semantic_scholar,
    semanticScholarApiKey: process.env.SEMANTIC_SCHOLAR_API_KEY || "",
    plan: { rssEnabled, pubmedEnabled, openalexEnabled, semanticScholarEnabled },
    profile,
    stateRoot,
    now,
    fetchers: { ...fetchers, fetchSemanticScholar: fetchers.fetchSemanticScholar || fetchSemanticScholar },
  });

  const threshold = sourceSelection.retrieval.diagnostics.low_yield_threshold;
  const generalPrimary = dedupWithDiagnostics([...(openalex.items || []), ...(semanticScholar.items || [])]).items;
  const biomedicalPrimary = dedupWithDiagnostics(db.items || []).items;
  const generalCompilerDegraded = Boolean(openalex.metrics?.queryCompilerDegraded || semanticScholar.metrics?.queryCompilerDegraded);
  const crossrefTriggered = crossrefRescueEnabled && generalDomain && generalIntent.expression && (generalPrimary.length < threshold || generalCompilerDegraded);
  const europePmcConfigured = sourceSelection.retrieval.europe_pmc.rescue_enabled === true;
  const europePmcTriggered = europePmcRescueEnabled && biomedicalDomain && biomedicalIntent.expression
    && (biomedicalPrimary.length < threshold || sourceSelection.retrieval.europe_pmc.include_preprints === true);
  const [crossref, europePmc] = await Promise.all([
    crossrefTriggered
      ? Promise.resolve((fetchers.fetchCrossrefRescue || fetchCrossrefRescue)(generalIntent, { ...sourceSelection.retrieval.crossref, enabled: true }, { profile, stateRoot, now })).catch((error) => safeAdapterFailure("crossref", error))
      : Promise.resolve(disabledSource("crossref", crossrefRescueEnabled ? "not_triggered_sufficient_primary" : "not_enabled")),
    europePmcTriggered
      ? Promise.resolve((fetchers.fetchEuropePmcRescue || fetchEuropePmcRescue)(biomedicalIntent, { ...sourceSelection.retrieval.europe_pmc, enabled: true }, { profile, stateRoot, now })).catch((error) => safeAdapterFailure("europe_pmc", error))
      : Promise.resolve(disabledSource("europe_pmc", europePmcConfigured && !europePmcRescueEnabled ? "production_validation_required" : europePmcRescueEnabled ? "not_triggered_sufficient_primary" : "not_enabled")),
  ]);

  const retrievalItems = [...rss.items, ...db.items, ...openalex.items, ...semanticScholar.items, ...crossref.items, ...europePmc.items];
  const retrievalMerged = dedupWithDiagnostics(retrievalItems).items;
  const healthResults = {
    ...(rssEnabled ? { rss: { ...rss, metrics: compactMetrics("rss", rss) } } : {}),
    ...Object.fromEntries((pubmedPmcConfig?.databases || []).map((database) => {
      const items = db.items.filter((item) => item.source_platform === database);
      const failed = db.failed.filter((entry) => entry.source === database);
      return [database, { ...db, items, failed, metrics: compactMetrics(database, { ...db, failed }, items) }];
    })),
    ...(openalexEnabled ? { openalex } : {}),
    ...(semanticScholarEnabled ? { semantic_scholar: semanticScholar } : {}),
    crossref,
    europe_pmc: europePmc,
  };
  const retrievalHealth = {
    ...buildRetrievalSufficiencySummary(healthResults, retrievalMerged, {
      primarySources: expandedPrimarySources(sourceSelection, pubmedPmcConfig),
      compilerDegraded: Boolean(openalex.metrics?.queryCompilerDegraded || semanticScholar.metrics?.queryCompilerDegraded),
      queryOverConstrained: Boolean(openalex.metrics?.queryOverConstrained),
    }),
    lowYieldThreshold: threshold,
    crossrefRescueTriggered: crossrefTriggered,
    europePmcRescueTriggered: europePmcTriggered,
    europePmcProductionValidated: sourceSelection.retrieval.europe_pmc.validated_unique_recall === true,
  };

  let retrievalAuditPath = "";
  let retrievalTransaction = null;
  if (pipeDir) {
    retrievalAuditPath = path.join(pipeDir, "retrieval_audit.json");
    const sourceAudits = [...(rss.audit || []), ...(db.audit || []), ...(openalex.audit || []), ...(semanticScholar.audit || []), ...(crossref.audit || []), ...(europePmc.audit || [])];
    const artifact = {
      schemaVersion: RETRIEVAL_AUDIT_SCHEMA_VERSION,
      profile,
      generatedAt: new Date(now).toISOString(),
      complete: rss.failed.length === 0 && db.failed.length === 0 && openalex.failed.length === 0 && semanticScholar.failed.length === 0 && crossref.failed.length === 0 && europePmc.failed.length === 0
        && sourceAudits.every((entry) => entry.complete === true),
      sources: sourceAudits,
      candidateCounts: { rss: rss.items.length, pubmedPmc: db.items.length, openalex: openalex.items.length, semanticScholar: semanticScholar.items.length, crossref: crossref.items.length, europePmc: europePmc.items.length },
      candidates: { rss: rss.items, pubmedPmc: db.items, openalex: openalex.items, semanticScholar: semanticScholar.items, crossref: crossref.items, europePmc: europePmc.items },
      retrievalHealth,
    };
    retrievalTransaction = {
      artifactPath: retrievalAuditPath,
      artifact,
      stateUpdates: [...(rss.stateUpdates || []), ...(db.stateUpdates || []), ...(openalex.stateUpdates || []), ...(semanticScholar.stateUpdates || []), ...(crossref.stateUpdates || []), ...(europePmc.stateUpdates || [])],
    };
    if (!deferCommit) await commitRetrievalTransaction(retrievalTransaction);
  }

  // Build source summary
  const sourceCollectionSummary = buildStage1SourceSummary({
    sources: [
      {
        name: "rss",
        enabled: rssEnabled,
        triggered: rssEnabled,
        itemsCollectedCount: rss.items.length,
        enteredPreDedupCollection: rss.items.length > 0,
        skippedReason: !rssEnabled ? "not_enabled_in_source_selection" : (rss.items.length === 0 ? "no_items" : null),
        failureReason: rss.failed.length > 0 ? "partial_failure" : null,
        degraded: rss.failed.length > 0,
        warningsCount: (rss.config?.warnings || []).length,
      },
      {
        name: "pubmed_pmc",
        enabled: pubmedEnabled,
        triggered: pubmedEnabled,
        itemsCollectedCount: db.items.length,
        enteredPreDedupCollection: db.items.length > 0,
        skippedReason: !pubmedEnabled ? "not_enabled_in_source_selection" : (db.items.length === 0 ? "no_items" : null),
        failureReason: db.failed.length > 0 ? "partial_failure" : null,
        degraded: db.failed.length > 0,
        warningsCount: (db.config?.warnings || []).length,
      },
      {
        name: "openalex",
        enabled: openalexEnabled,
        triggered: openalexEnabled,
        itemsCollectedCount: openalex.items.length,
        enteredPreDedupCollection: openalex.items.length > 0,
        skippedReason: !openalexEnabled ? "not_enabled_in_source_selection" : (openalex.items.length === 0 ? "no_items" : null),
        failureReason: openalex.failed.length > 0 ? "partial_failure" : null,
        degraded: openalex.failed.length > 0,
        warningsCount: (openalex.config?.warnings || []).length,
      },
      {
        name: "semantic_scholar",
        enabled: semanticScholarEnabled,
        triggered: semanticScholarEnabled,
        itemsCollectedCount: semanticScholar.items.length,
        enteredPreDedupCollection: semanticScholar.items.length > 0,
        skippedReason: !semanticScholarEnabled ? "not_enabled_in_source_selection" : (semanticScholar.items.length === 0 ? "no_items" : null),
        failureReason: semanticScholar.failed.length > 0 ? "partial_failure" : null,
        degraded: semanticScholar.failed.length > 0,
        warningsCount: 0,
      },
      {
        name: "crossref",
        enabled: crossrefRescueEnabled,
        triggered: crossrefTriggered,
        itemsCollectedCount: crossref.items.length,
        enteredPreDedupCollection: crossref.items.length > 0,
        skippedReason: crossrefTriggered ? (crossref.items.length === 0 ? "no_items" : null) : crossref.skipped_reason,
        failureReason: crossref.failed.length > 0 ? "partial_failure" : null,
        degraded: crossref.failed.length > 0,
        warningsCount: 0,
      },
      {
        name: "europe_pmc",
        enabled: europePmcRescueEnabled,
        triggered: europePmcTriggered,
        itemsCollectedCount: europePmc.items.length,
        enteredPreDedupCollection: europePmc.items.length > 0,
        skippedReason: europePmcTriggered ? (europePmc.items.length === 0 ? "no_items" : null) : europePmc.skipped_reason,
        failureReason: europePmc.failed.length > 0 ? "partial_failure" : null,
        degraded: europePmc.failed.length > 0,
        warningsCount: 0,
      },
    ],
    preDedupItemsCount: retrievalItems.length,
  });

  return {
    sourceSelection: sourceSelectionReport,
    sourceCollectionSummary,
    rss,
    db,
    openalex,
    semanticScholar,
    crossref,
    europePmc,
    retrievalHealth,
    retrievalAuditPath,
    retrievalTransaction,
    healthObservations: sourceHealthObservations([...(rss.stateUpdates || []), ...(db.stateUpdates || []), ...(openalex.stateUpdates || []), ...(semanticScholar.stateUpdates || []), ...(crossref.stateUpdates || []), ...(europePmc.stateUpdates || [])]),
  };
}
