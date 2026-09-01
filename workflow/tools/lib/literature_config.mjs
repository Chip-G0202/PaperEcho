import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function configPath(root, name) {
  return path.join(root || repoRoot(), "config", name);
}

function readJsonConfig(filePath, fallback) {
  if (!fs.existsSync(filePath)) return { config: fallback, path: filePath, warnings: ["config_missing_using_default"] };
  try {
    return { config: JSON.parse(fs.readFileSync(filePath, "utf8")), path: filePath, warnings: [] };
  } catch (error) {
    throw new Error(`CONFIG_PARSE_ERROR ${filePath}: ${error.message}`);
  }
}

function enabled(entry) {
  return entry?.enabled !== false;
}

export function loadRssSources({ root } = {}) {
  const filePath = configPath(root, "rss_sources.json");
  const { config, path: resolvedPath, warnings } = readJsonConfig(filePath, { sources: [] });
  const rawSources = Array.isArray(config) ? config : Array.isArray(config.sources) ? config.sources : [];
  const sources = rawSources
    .map((entry) => typeof entry === "string" ? { url: entry, enabled: true } : entry)
    .filter((entry) => enabled(entry) && String(entry?.url || "").trim())
    .map((entry) => ({ name: String(entry.name || entry.url).trim(), url: String(entry.url).trim() }));
  return { path: resolvedPath, sources, warnings, raw_count: rawSources.length, enabled_count: sources.length };
}

function safePositiveInteger(value, fallback, warnings, field) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  warnings.push(`${field}_invalid_using_default_${fallback}`);
  return fallback;
}

function uniq(values) {
  return Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)));
}

function normalizeRequiredGroups(value) {
  if (!Array.isArray(value)) return [];
  if (value.every((entry) => typeof entry === "string")) return [uniq(value)];
  return value
    .map((group) => uniq(Array.isArray(group) ? group : [group]))
    .filter((group) => group.length);
}

export function normalizePubMedKeywordGroups(value = {}) {
  return {
    required: normalizeRequiredGroups(value.required),
    optional: uniq(value.optional || []),
    negative: uniq(value.negative || []),
  };
}

function stripOuterParens(value) {
  let out = String(value || "").trim();
  while (out.startsWith("(") && out.endsWith(")")) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

export function parsePubMedQueryKeywordGroups(query = "") {
  const raw = String(query || "").trim();
  if (!raw) return normalizePubMedKeywordGroups();
  const notMatch = raw.match(/\s+NOT\s+\(([^)]*)\)\s*$/i);
  const negative = notMatch ? uniq(notMatch[1].split(/\s+OR\s+/i)) : [];
  const positiveRaw = notMatch ? raw.slice(0, notMatch.index).trim() : raw;
  const required = positiveRaw
    .split(/\s+AND\s+/i)
    .map((part) => uniq(stripOuterParens(part).split(/\s+OR\s+/i)))
    .filter((group) => group.length);
  return normalizePubMedKeywordGroups({ required, optional: [], negative });
}

export function buildPubMedQueryFromKeywordGroups(groups = {}) {
  const normalized = normalizePubMedKeywordGroups(groups);
  const positive = normalized.required
    .filter((group) => group.length)
    .map((group) => `(${group.join(" OR ")})`);
  const negative = normalized.negative.length ? `NOT (${normalized.negative.join(" OR ")})` : "";
  return [...positive, negative].filter(Boolean).join(" AND ").replace(/\s+AND\s+NOT\s+/i, " NOT ");
}

export function loadPubMedKeywordGroupsFromConfig(config = {}) {
  if (config.keyword_groups && typeof config.keyword_groups === "object") {
    return normalizePubMedKeywordGroups(config.keyword_groups);
  }
  return parsePubMedQueryKeywordGroups(config.query || "");
}

function buildPubMedQueryFromRequiredGroups(required = []) {
  return required
    .map((group) => uniq(group))
    .filter((group) => group.length)
    .map((group) => `(${group.join(" OR ")})`)
    .join(" AND ");
}

function normalizeAdaptiveQueryConfig(value = {}, warnings = []) {
  const enabled = value?.enabled === true;
  const targetMin = safePositiveInteger(value?.target_min, 100, warnings, "adaptive_query.target_min");
  let targetMax = safePositiveInteger(value?.target_max, 250, warnings, "adaptive_query.target_max");
  if (targetMax < targetMin) {
    warnings.push("adaptive_query_target_max_below_min_using_min");
    targetMax = targetMin;
  }
  return {
    enabled,
    mode: String(value?.mode || "runtime_only"),
    target_min: targetMin,
    target_max: targetMax,
    mechanism_terms: uniq(value?.mechanism_terms || []),
  };
}

function candidateCountStatus(count, plan = {}) {
  const n = Number(count || 0);
  if (n < Number(plan.target_min || 0)) return "below_target";
  if (n > Number(plan.target_max || 0)) return "above_target";
  return "within_target";
}

function distanceFromTarget(count, plan = {}) {
  const n = Number(count || 0);
  if (n < Number(plan.target_min || 0)) return Number(plan.target_min || 0) - n;
  if (n > Number(plan.target_max || 0)) return n - Number(plan.target_max || 0);
  return 0;
}

export function buildAdaptivePubMedQueryPlan(adaptiveQuery = {}, keywordGroups = {}, fallbackQuery = "", warnings = []) {
  const config = normalizeAdaptiveQueryConfig(adaptiveQuery, warnings);
  const groups = normalizePubMedKeywordGroups(keywordGroups);
  const exposureGroup = groups.required[0] || [];
  const biologyGroup = groups.required[1] || [];
  const mechanismGroup = uniq([
    ...(groups.required[2] || []),
    ...(groups.optional || []),
    ...(config.mechanism_terms || []),
  ]);
  const fallback = String(fallbackQuery || buildPubMedQueryFromKeywordGroups(groups)).trim();
  if (!config.enabled || !exposureGroup.length || !biologyGroup.length) {
    return {
      enabled: false,
      runtime_only: config.mode === "runtime_only",
      target_min: config.target_min,
      target_max: config.target_max,
      selected_tier: "configured",
      tiers: {
        configured: {
          tier: "configured",
          query: fallback,
        },
      },
      warnings,
    };
  }
  const normalQuery = buildPubMedQueryFromRequiredGroups([exposureGroup, biologyGroup]);
  const broadenedQuery = mechanismGroup.length
    ? buildPubMedQueryFromRequiredGroups([exposureGroup, uniq([...biologyGroup, ...mechanismGroup])])
    : normalQuery;
  const narrowedQuery = mechanismGroup.length
    ? buildPubMedQueryFromRequiredGroups([exposureGroup, biologyGroup, mechanismGroup])
    : normalQuery;
  return {
    enabled: true,
    runtime_only: config.mode === "runtime_only",
    target_min: config.target_min,
    target_max: config.target_max,
    selected_tier: "normal",
    tiers: {
      normal: { tier: "normal", query: normalQuery },
      broadened: { tier: "broadened", query: broadenedQuery },
      narrowed: { tier: "narrowed", query: narrowedQuery },
    },
    warnings,
  };
}
/**
 * Derive a retrieval execution plan from a source selection config.
 * Pure function — does not read files, access network, or call APIs.
 *
 * @param {Object} sourceSelection - output of loadSourceSelectionConfig()
 * @returns {{ rssEnabled: boolean, pubmedEnabled: boolean, openalexEnabled: boolean, semanticScholarEnabled: boolean, manualConfirmationRequired: boolean }}
 */
export function resolveRetrievalPlan(sourceSelection) {
  const enabled = sourceSelection?.enabled_sources || [];
  return {
    rssEnabled: enabled.includes("rss"),
    pubmedEnabled: enabled.includes("pubmed_pmc"),
    openalexEnabled: enabled.includes("openalex"),
    semanticScholarEnabled: enabled.includes("semantic_scholar"),
    crossrefRescueEnabled: sourceSelection?.retrieval?.crossref?.rescue_enabled === true,
    europePmcRescueEnabled: sourceSelection?.retrieval?.europe_pmc?.rescue_enabled === true
      && sourceSelection?.retrieval?.europe_pmc?.validated_unique_recall === true,
    manualConfirmationRequired: sourceSelection?.require_manual_confirmation === true,
  };
}

export function chooseAdaptivePubMedQueryTier(plan = {}, attempts = []) {
  const usableAttempts = (attempts || [])
    .filter((attempt) => attempt && attempt.tier && Number.isFinite(Number(attempt.count)));
  if (!plan?.enabled || !usableAttempts.length) {
    const fallback = usableAttempts[0] || { tier: "configured", count: 0 };
    return {
      ...fallback,
      candidate_count_status: candidateCountStatus(fallback.count, plan),
      selected_reason: plan?.enabled ? "no_adaptive_attempts" : "adaptive_disabled",
    };
  }
  const normal = usableAttempts.find((attempt) => attempt.tier === "normal") || usableAttempts[0];
  const normalStatus = candidateCountStatus(normal.count, plan);
  const preferredTier = normalStatus === "below_target" ? "broadened" : normalStatus === "above_target" ? "narrowed" : "normal";
  const preferred = usableAttempts.find((attempt) => attempt.tier === preferredTier);
  const selected = preferred || usableAttempts
    .slice()
    .sort((a, b) => distanceFromTarget(a.count, plan) - distanceFromTarget(b.count, plan))[0];
  return {
    ...selected,
    candidate_count_status: candidateCountStatus(selected.count, plan),
    selected_reason: selected.tier === "normal" ? "normal_within_or_closest" : `${normalStatus}_using_${selected.tier}`,
  };
}

function removeTerms(groups, terms) {
  const removeSet = new Set(uniq(terms).map((term) => term.toLowerCase()));
  if (!removeSet.size) return groups;
  return {
    required: groups.required.map((group) => group.filter((term) => !removeSet.has(term.toLowerCase()))).filter((group) => group.length),
    optional: groups.optional.filter((term) => !removeSet.has(term.toLowerCase())),
    negative: groups.negative.filter((term) => !removeSet.has(term.toLowerCase())),
  };
}

export function applyKeywordModifications(groups = {}, modifications = {}) {
  let next = normalizePubMedKeywordGroups(groups);
  next = removeTerms(next, modifications.keywords_removed || []);
  const added = modifications.keywords_added || {};
  const requiredAdds = normalizeRequiredGroups(added.required || []);
  next.required = [...next.required, ...requiredAdds].map(uniq).filter((group) => group.length);
  next.optional = uniq([...next.optional, ...(Array.isArray(added.optional) ? added.optional : [])]);
  next.negative = uniq([
    ...next.negative,
    ...(Array.isArray(added.negative) ? added.negative : []),
    ...(Array.isArray(modifications.negative_keywords_added) ? modifications.negative_keywords_added : []),
  ]);
  return normalizePubMedKeywordGroups(next);
}

export function updatePubMedPmcKeywordGroups(filePath, modifications = {}) {
  const raw = readJsonConfig(filePath, {}).config;
  const beforeGroups = loadPubMedKeywordGroupsFromConfig(raw);
  const queryBefore = String(raw.query || buildPubMedQueryFromKeywordGroups(beforeGroups));
  const nextGroups = applyKeywordModifications(beforeGroups, modifications);
  const queryAfter = buildPubMedQueryFromKeywordGroups(nextGroups);
  const nextConfig = {
    ...raw,
    keyword_groups: nextGroups,
    query: queryAfter,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return {
    config: nextConfig,
    keyword_groups_before: beforeGroups,
    keyword_groups_after: nextGroups,
    query_before: queryBefore,
    query_after: queryAfter,
  };
}

export function formatNcbiDate(date) {
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

export function buildDateRangeFromDaysBack(now = new Date(), daysBack = 10) {
  const max = new Date(now);
  const min = new Date(now);
  min.setDate(max.getDate() - daysBack);
  return { minDate: formatNcbiDate(min), maxDate: formatNcbiDate(max) };
}

export function loadPubMedPmcSearchConfig({ root, now = new Date() } = {}) {
  const filePath = configPath(root, "pubmed_pmc_search.json");
  const fallback = {
    databases: ["pubmed"],
    days_back: 10,
    retmax: 300,
    page_size: 500,
    detail_batch_size: 200,
    max_results: 100000,
    overlap_days: 3,
    sort: "date",
    datetype: "pdat",
    query: "(example research term) AND (example method term)",
  };
  const { config, path: resolvedPath, warnings } = readJsonConfig(filePath, fallback);
  const daysBack = safePositiveInteger(config.days_back, 10, warnings, "days_back");
  const retmax = safePositiveInteger(config.retmax, 300, warnings, "retmax");
  const pageSize = safePositiveInteger(config.page_size, 500, warnings, "page_size");
  const detailBatchSize = safePositiveInteger(config.detail_batch_size, 200, warnings, "detail_batch_size");
  const maxResults = safePositiveInteger(config.max_results, 100000, warnings, "max_results");
  const overlapDays = safePositiveInteger(config.overlap_days, 3, warnings, "overlap_days");
  const databases = (Array.isArray(config.databases) ? config.databases : fallback.databases)
    .map((db) => String(db || "").trim().toLowerCase())
    .filter((db) => db === "pubmed" || db === "pmc");
  if (!databases.length) {
    warnings.push("databases_invalid_using_pubmed");
    databases.push("pubmed");
  }
  const keywordGroups = loadPubMedKeywordGroupsFromConfig(config);
  const query = String(config.query || buildPubMedQueryFromKeywordGroups(keywordGroups) || fallback.query).trim() || fallback.query;
  const adaptiveQueryPlan = buildAdaptivePubMedQueryPlan(config.adaptive_query || {}, keywordGroups, query, warnings);
  const effectiveQuery = adaptiveQueryPlan.enabled ? adaptiveQueryPlan.tiers.normal.query : query;
  const dateRange = buildDateRangeFromDaysBack(now, daysBack);
  return {
    path: resolvedPath,
    databases,
    days_back: daysBack,
    retmax,
    page_size: Math.min(pageSize, 10000),
    detail_batch_size: Math.min(detailBatchSize, 200),
    max_results: maxResults,
    overlap_days: overlapDays,
    sort: String(config.sort || fallback.sort),
    datetype: String(config.datetype || fallback.datetype),
    query,
    effective_query: effectiveQuery,
    pubmed_query_tier: adaptiveQueryPlan.enabled ? "normal" : "configured",
    adaptive_query: config.adaptive_query || null,
    adaptive_query_plan: adaptiveQueryPlan,
    keyword_groups: keywordGroups,
    ...dateRange,
    warnings,
  };
}

export function buildNcbiESearchUrl(cfg, database = "pubmed", options = {}) {
  const params = new URLSearchParams({
    db: database,
    retmode: "json",
    retstart: String(options.retstart || 0),
    retmax: String(options.retmax || cfg.page_size || cfg.retmax || 300),
    sort: cfg.sort || "date",
    term: cfg.effective_query || cfg.query,
  });
  if (options.includeDate !== false) {
    params.set("datetype", options.datetype || cfg.datetype || "pdat");
    params.set("mindate", options.minDate || cfg.minDate);
    params.set("maxdate", options.maxDate || cfg.maxDate);
  }
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params.toString()}`;
}

export function loadWorkflowRules({ root } = {}) {
  const filePath = configPath(root, "review-workflow-rules.json");
  const fallback = {
    triage: {
      version: "2026-05-21-v2",
      labels: { A: "A课题相关", B: "B专题相关", C: "C领域相关", D: "D无关" },
      source_labels: { rss: "RSS", pubmed: "PubMed", pmc: "PMC", other: "other" },
      terms: {
        pollutant: ["example research term"],
        core_topic: ["example biological context"],
        mechanism: ["example mechanism"],
      },
      journal_whitelist: ["example journal"],
      weights: { pollutant: 1.6, core_topic: 1.5, mechanism: 0.7, journal_quality: 1.2, feedback_positive: 0.6, feedback_negative: -1.0 },
      thresholds: { A_score: 6.0, A_min_pollutant_hits: 2, A_min_core_hits: 2, B_score: 3.4, C_score: 1.4, B_uncertain_below: 4.2, C_uncertain_below: 2.3 },
      grade_reasons: { A: "直接命中当前课题关键词组合，与核心课题问题高度贴合。", B: "与当前专题或邻近专题明显相关，可作为专题背景或方法参考。", C: "与所在研究领域相关，但距离当前课题和专题较远，低优先级保留。", D: "与当前课题、专题和领域相关性不足，仅保留审计记录。" },
      journal_quality_filter: {
        enabled: true,
        apply_to_sources: ["pubmed", "pmc"],
        min_impact_factor: 3,
        exclude_cas_small_partitions: ["4区"],
        exclude_preprints: true,
        preprint_sources: ["bioRxiv", "medRxiv", "arXiv", "Research Square", "SSRN"],
        exclude_non_research_records: true,
        non_research_title_prefixes: ["Correction to:", "Correction:", "Erratum:", "Retraction:", "Withdrawn:"],
        missing_policy: "keep",
        rate_limit_per_second: 2,
      },
    },
  };
  return readJsonConfig(filePath, fallback);
}

const VALID_DOMAINS = [
  "biomedical",
  "non_biomedical_stem",
  "education_social_science",
  "mixed_biomedical_technical",
  "unknown",
];

const VALID_SOURCES = ["rss", "pubmed_pmc", "openalex", "semantic_scholar"];

export function loadSourceSelectionConfig({ root } = {}) {
  const filePath = configPath(root, "source_selection.json");
  const fallback = {
    research_domain: "biomedical",
    domain_options: {
      biomedical: { primary_sources: ["pubmed_pmc"], supplemental_sources: ["rss"] },
      non_biomedical_stem: { primary_sources: ["openalex", "semantic_scholar"], supplemental_sources: ["rss"] },
      education_social_science: { primary_sources: ["openalex", "semantic_scholar"], supplemental_sources: ["rss"] },
      mixed_biomedical_technical: { primary_sources: ["pubmed_pmc", "openalex"], supplemental_sources: ["semantic_scholar", "rss"] },
      unknown: { primary_sources: [], supplemental_sources: ["rss"] },
    },
    override_enabled_sources: null,
    require_manual_confirmation: false,
    retrieval: {},
  };
  const { config, path: resolvedPath, warnings } = readJsonConfig(filePath, fallback);
  const domain = VALID_DOMAINS.includes(config.research_domain) ? config.research_domain : "unknown";
  if (!VALID_DOMAINS.includes(config.research_domain)) {
    warnings.push("invalid_research_domain_using_unknown");
  }
  const domainOption = config.domain_options?.[domain] || fallback.domain_options[domain] || fallback.domain_options.unknown;
  const primarySources = (domainOption.primary_sources || []).filter((s) => VALID_SOURCES.includes(s));
  const supplementalSources = (domainOption.supplemental_sources || []).filter((s) => VALID_SOURCES.includes(s));
  let enabledSources;
  if (Array.isArray(config.override_enabled_sources) && config.override_enabled_sources.length > 0) {
    enabledSources = config.override_enabled_sources.filter((s) => VALID_SOURCES.includes(s));
  } else {
    enabledSources = [...new Set([...primarySources, ...supplementalSources])];
  }
  const requireManualConfirmation = config.require_manual_confirmation === true;
  if (requireManualConfirmation && domain === "unknown") {
    warnings.push("manual_confirmation_required_unknown_domain");
  }
  return {
    path: resolvedPath,
    research_domain: domain,
    primary_sources: primarySources,
    supplemental_sources: supplementalSources,
    enabled_sources: enabledSources,
    require_manual_confirmation: requireManualConfirmation,
    retrieval: {
      diagnostics: {
        enabled: config.retrieval?.diagnostics?.enabled === true,
        low_yield_threshold: safePositiveInteger(config.retrieval?.diagnostics?.low_yield_threshold, 5, warnings, "retrieval.diagnostics.low_yield_threshold"),
        probe_budget: safePositiveInteger(config.retrieval?.diagnostics?.probe_budget, 6, warnings, "retrieval.diagnostics.probe_budget"),
      },
      openalex: {
        request_budget: safePositiveInteger(config.retrieval?.openalex?.request_budget, 8, warnings, "retrieval.openalex.request_budget"),
        semantic_rescue_enabled: config.retrieval?.openalex?.semantic_rescue_enabled === true,
        semantic_rescue_max_results: safePositiveInteger(config.retrieval?.openalex?.semantic_rescue_max_results, 25, warnings, "retrieval.openalex.semantic_rescue_max_results"),
      },
      semantic_scholar: {
        request_budget: safePositiveInteger(config.retrieval?.semantic_scholar?.request_budget, 4, warnings, "retrieval.semantic_scholar.request_budget"),
        concurrency: safePositiveInteger(config.retrieval?.semantic_scholar?.concurrency, 1, warnings, "retrieval.semantic_scholar.concurrency"),
        max_encoded_url_length: safePositiveInteger(config.retrieval?.semantic_scholar?.max_encoded_url_length, 3800, warnings, "retrieval.semantic_scholar.max_encoded_url_length"),
        max_query_characters: safePositiveInteger(config.retrieval?.semantic_scholar?.max_query_characters, 3500, warnings, "retrieval.semantic_scholar.max_query_characters"),
      },
      crossref: {
        rescue_enabled: config.retrieval?.crossref?.rescue_enabled === true,
        request_budget: safePositiveInteger(config.retrieval?.crossref?.request_budget, 4, warnings, "retrieval.crossref.request_budget"),
        query_budget: safePositiveInteger(config.retrieval?.crossref?.query_budget, 3, warnings, "retrieval.crossref.query_budget"),
      },
      europe_pmc: {
        rescue_enabled: config.retrieval?.europe_pmc?.rescue_enabled === true,
        validated_unique_recall: config.retrieval?.europe_pmc?.validated_unique_recall === true,
        request_budget: safePositiveInteger(config.retrieval?.europe_pmc?.request_budget, 4, warnings, "retrieval.europe_pmc.request_budget"),
        include_preprints: config.retrieval?.europe_pmc?.include_preprints === true,
        synonym: config.retrieval?.europe_pmc?.synonym === true,
      },
    },
    warnings,
  };
}

export function loadOpenAlexConfig({ root } = {}) {
  const filePath = configPath(root, "openalex_search.json");
  const fallback = {
    enabled: false,
    query: "",
    days_back: 10,
    overlap_days: 3,
    per_page: 50,
    max_pages: 10000,
    mailto: "",
    filters: { type: "article", is_oa: null, from_publication_date: null, to_publication_date: null, concepts: [], default_search: "example topic term 010" },
    sort: "relevance_score:desc",
    select: "id,doi,title,publication_year,publication_date,authorships,primary_location,abstract_inverted_index,open_access,type",
  };
  const { config, path: resolvedPath, warnings } = readJsonConfig(filePath, fallback);
  const enabled = config.enabled === true;
  const query = String(config.query || "").trim();
  const daysBack = safePositiveInteger(config.days_back, 10, warnings, "days_back");
  const overlapDays = safePositiveInteger(config.overlap_days, 3, warnings, "overlap_days");
  const perPage = safePositiveInteger(config.per_page, 50, warnings, "per_page");
  const maxPages = safePositiveInteger(config.max_pages, 10000, warnings, "max_pages");
  if (!enabled) {
    warnings.push("openalex_disabled");
  }
  if (enabled && !query && !(config.keyword_groups && typeof config.keyword_groups === "object")) {
    warnings.push("openalex_enabled_but_empty_query");
  }
  return {
    path: resolvedPath,
    enabled,
    query,
    keyword_groups: config.keyword_groups && typeof config.keyword_groups === "object" ? config.keyword_groups : null,
    days_back: daysBack,
    overlap_days: overlapDays,
    per_page: Math.min(perPage, 200),
    max_pages: maxPages,
    mailto: String(config.mailto || "").trim(),
    filters: {
      type: String(config.filters?.type || "article"),
      is_oa: config.filters?.is_oa ?? null,
      from_publication_date: config.filters?.from_publication_date ?? null,
      to_publication_date: config.filters?.to_publication_date ?? null,
      concepts: Array.isArray(config.filters?.concepts) ? config.filters.concepts : [],
      default_search: String(config.filters?.default_search || "example topic term 010"),
    },
    sort: String(config.sort || fallback.sort),
    select: String(config.select || fallback.select),
    request_budget: safePositiveInteger(config.request_budget, 8, warnings, "openalex.request_budget"),
    max_query_characters: safePositiveInteger(config.max_query_characters, 1400, warnings, "openalex.max_query_characters"),
    diagnostic_probe_budget: safePositiveInteger(config.diagnostic_probe_budget, 6, warnings, "openalex.diagnostic_probe_budget"),
    semantic_rescue_enabled: config.semantic_rescue_enabled === true,
    semantic_rescue_max_results: safePositiveInteger(config.semantic_rescue_max_results, 25, warnings, "openalex.semantic_rescue_max_results"),
    warnings,
  };
}
