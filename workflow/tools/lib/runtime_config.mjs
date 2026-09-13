import path from "node:path";
import { fileURLToPath } from "node:url";
import { yyMd, isoWeek } from "./date_label_support.mjs";

function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

function normalizePath(p) {
  return toPosix(path.resolve(p));
}

function argValue(argv = [], name) {
  const prefix = `--${name}=`;
  const inline = argv.find((entry) => String(entry || "").startsWith(prefix));
  if (inline) return String(inline).slice(prefix.length);
  const index = argv.findIndex((entry) => String(entry || "") === `--${name}`);
  if (index >= 0 && index + 1 < argv.length) return String(argv[index + 1] || "");
  return "";
}

function hasArg(argv = [], name) {
  return argv.some((entry) => String(entry || "") === `--${name}` || String(entry || "").startsWith(`--${name}=`));
}

function parseBoolean(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function parsePositiveInteger(raw, fallback = null) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function normalizeLlmMode(raw, fallback = "real") {
  const value = String(raw || "").trim().toLowerCase();
  return ["disabled", "mock", "real"].includes(value) ? value : fallback;
}

function normalizeSampleStrategy(raw, fallback = "default") {
  const value = String(raw || "").trim().toLowerCase();
  return ["default", "representative"].includes(value) ? value : fallback;
}

function resolveUnderRoot(root, raw, fallback) {
  const value = String(raw || fallback || "").trim();
  if (!value) return normalizePath(root);
  if (path.isAbsolute(value)) return normalizePath(value);
  return normalizePath(path.join(root, value));
}


function defaultProjectRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return normalizePath(path.resolve(here, "../../.."));
}

export function buildRuntimeConfig({ cwd = process.cwd(), env = process.env, argv = process.argv, now } = {}) {
  if (!now) {
    const overrideDate = String(env.review_results_OVERRIDE_DATE || "").trim();
    now = overrideDate ? new Date(overrideDate) : new Date();
  }
  const repoRoot = defaultProjectRoot();
  const fixtureRoot = argValue(argv, "fixture-root");
  const outputRootRaw = argValue(argv, "output-root") || env.review_results_OUTPUT_ROOT || "";
  const projectRoot = normalizePath(env.ZOTERO_PROJECT_ROOT || cwd || repoRoot);
  const resolvedFixtureRoot = fixtureRoot ? normalizePath(fixtureRoot) : "";
  const outputRoot = outputRootRaw ? normalizePath(outputRootRaw) : "";
  const outputBase = outputRoot || projectRoot;
  const researchRoot = resolveUnderRoot(outputBase, env.review_results_ROOT, "review_results");
  const reviewRoot = resolveUnderRoot(outputBase, "", "review_results/文献评价");
  const legacyDesktopReviewRoot = resolveUnderRoot(
    outputBase,
    env.LEGACY_DESKTOP_REVIEW_ROOT || env.DESKTOP_REVIEW_ROOT_LEGACY || env.DESKTOP_REVIEW_ROOT,
    "review_results/文献评价",
  );
  const translationCachePath = normalizePath(path.join(researchRoot, "translation_cache.json"));
  const week = isoWeek(now);
  const day = yyMd(now);
  const pipelineDir = normalizePath(path.join(researchRoot, "pipeline", day));
  const toolsDir = normalizePath(path.join(repoRoot, "workflow/tools"));

  return {
    platform: process.platform,
    now,
    repoRoot,
    projectRoot,
    fixtureRoot: resolvedFixtureRoot,
    outputRoot,
    researchRoot,
    reviewRoot,
    legacyDesktopReviewRoot,
    translationCachePath,
    week,
    day,
    pipelineDir,
    zoteroExe: env.ZOTERO_EXE || "",
    externalLauncher: String(env.ZOTERO_EXTERNAL_LAUNCHER || "").trim().toLowerCase(),
    pwshPath: toPosix(env.PWSH_PATH || "pwsh"),
    scripts: {
      stage1: `${toolsDir}/stage1/main.mjs`,
      zoteroReady: `${toolsDir}/stage0/check_zotero_backend_ready.mjs`,
      stage2: `${toolsDir}/stage2/main.mjs`,
      stage3: `${toolsDir}/stage3/main.mjs`,
      stage4: `${toolsDir}/stage4/main.mjs`,
    },
  };
}

export function buildLocalRuntimeConfig({ cwd = process.cwd(), argv = process.argv.slice(2), defaultRoot = "" } = {}) {
  const fallbackRoot = defaultRoot || path.join(cwd, "review_results", "local");
  const outputRoot = normalizePath(argValue(argv, "output-root") || fallbackRoot);
  const resolveOptional = (name) => {
    const value = argValue(argv, name);
    return value ? normalizePath(path.isAbsolute(value) ? value : path.join(cwd, value)) : "";
  };
  return {
    mode: "local",
    source_type: "local",
    outputRoot,
    inputPath: resolveOptional("input"),
    feedbackPath: resolveOptional("feedback"),
    fixtureRoot: resolveOptional("fixture-root"),
    llmMode: argValue(argv, "llm-mode") || "disabled",
  };
}

export function buildRuntimeSafetyConfig({ argv = process.argv, env = process.env, runtime = buildRuntimeConfig({ argv, env }) } = {}) {
  const dryRunCli = ["dry-run", "no-write", "no-zotero-write", "skip-writeback"].find((name) => hasArg(argv, name));
  const dryRunEnv = [
    "review_results_DRY_RUN",
    "review_results_NO_WRITE",
    "ZOTERO_DRY_RUN",
  ].find((name) => parseBoolean(env[name], false));
  const dryRunExplicit = dryRunCli ? true : dryRunEnv ? true : parseBoolean(env.review_results_DRY_RUN, false);
  const dryRun = Boolean(dryRunExplicit);
  const dryRunSource = dryRunCli ? "CLI" : dryRunEnv ? "env" : dryRun ? "unknown" : "none";
  const skipZoteroMcp = hasArg(argv, "skip-zotero-mcp")
    ? true
    : dryRun
      ? true
      : parseBoolean(env.SKIP_ZOTERO_MCP, false);
  const noFormalRuleApply = hasArg(argv, "no-formal-rule-apply")
    ? true
    : dryRun
      ? true
      : parseBoolean(env.NO_FORMAL_RULE_APPLY, false);
  const cliLlmMode = argValue(argv, "llm-mode");
  const requestedLlmMode = cliLlmMode || env.LLM_MODE || (dryRun ? "disabled" : "real");
  const requestedMode = normalizeLlmMode(requestedLlmMode, dryRun ? "disabled" : "real");
  const explicitRealRequested = Boolean((cliLlmMode || env.LLM_MODE) && requestedMode === "real");
  const llmMode = dryRun && requestedMode === "real" && !explicitRealRequested ? "disabled" : requestedMode;
  const sampleLimit = parsePositiveInteger(argValue(argv, "sample-limit") || env.review_results_SAMPLE_LIMIT, null);
  const sampleStrategy = normalizeSampleStrategy(argValue(argv, "sample-strategy") || env.review_results_SAMPLE_STRATEGY, "default");
  const fetchLimit = parsePositiveInteger(argValue(argv, "fetch-limit") || env.review_results_FETCH_LIMIT, null);
  const maxGradeReviewItems = parsePositiveInteger(argValue(argv, "max-grade-review-items") || env.review_results_MAX_GRADE_REVIEW_ITEMS, null);
  const gradeReviewBatchSize = parsePositiveInteger(argValue(argv, "grade-review-batch-size") || env.review_results_GRADE_REVIEW_BATCH_SIZE, null);
  const allowNetworkFetch = hasArg(argv, "allow-network-fetch")
    ? true
    : parseBoolean(env.review_results_ALLOW_NETWORK_FETCH, false);
  const allowOfficialDryRun = hasArg(argv, "allow-dry-run-on-official-root")
    || parseBoolean(env.ALLOW_DRY_RUN_ON_OFFICIAL_ROOT, false);
  const officialResearchRoot = normalizePath(path.join(runtime.repoRoot, "review_results"));
  const officialReviewRoot = normalizePath(path.join(runtime.repoRoot, "review_results", "文献评价"));
  const usingOfficialRoot = runtime.researchRoot === officialResearchRoot || runtime.reviewRoot === officialReviewRoot;
  const officialRootProtected = Boolean(dryRun && usingOfficialRoot && !allowOfficialDryRun);
  const networkFetchFailSafeReasons = [];
  if (dryRun && allowNetworkFetch) {
    if (!runtime.outputRoot) networkFetchFailSafeReasons.push("network_output_root_required");
    if (!skipZoteroMcp) networkFetchFailSafeReasons.push("network_requires_skip_zotero_mcp");
    if (!noFormalRuleApply) networkFetchFailSafeReasons.push("network_requires_no_formal_rule_apply");
    if (!fetchLimit && !sampleLimit) networkFetchFailSafeReasons.push("network_fetch_limit_required");
    if (officialRootProtected) networkFetchFailSafeReasons.push("network_official_root_protected");
  }
  const networkFetchAllowed = Boolean(dryRun && allowNetworkFetch && networkFetchFailSafeReasons.length === 0);

  return {
    dry_run: dryRun,
    dry_run_source: dryRunSource,
    skip_zotero_mcp: skipZoteroMcp,
    llm_mode: llmMode,
    no_formal_rule_apply: noFormalRuleApply,
    sample_limit: sampleLimit,
    sample_strategy: sampleStrategy,
    fetch_limit: fetchLimit,
    max_grade_review_items: maxGradeReviewItems,
    grade_review_batch_size: gradeReviewBatchSize,
    allow_network_fetch: Boolean(allowNetworkFetch),
    network_fetch_allowed: networkFetchAllowed,
    network_fetch_fail_safe_reasons: networkFetchFailSafeReasons,
    output_root: runtime.outputRoot || runtime.researchRoot,
    official_root_protected: officialRootProtected,
    formal_writes_allowed: !noFormalRuleApply && !dryRun,
    fail_safe_blocked: officialRootProtected || networkFetchFailSafeReasons.length > 0,
    allow_dry_run_on_official_root: Boolean(allowOfficialDryRun),
    llm_real_requested_but_blocked: Boolean(dryRun && requestedMode === "real" && !explicitRealRequested),
  };
}

export function applySampleLimit(items = [], limit = null, appliedAt = "pre_triage") {
  const source = Array.isArray(items) ? items : [];
  const n = parsePositiveInteger(limit, null);
  const limited = n ? source.slice(0, n) : source.slice();
  return {
    items: limited,
    audit: {
      enabled: Boolean(n),
      limit: n,
      applied_at: appliedAt,
      input_count_before_limit: source.length,
      input_count_after_limit: limited.length,
    },
  };
}

// Optional interfaces share Runner configuration precedence and the workflow path owners.
export async function resolveApplicationRuntimeContext({ cwd = process.cwd(), env = process.env, argv = [] } = {}) {
  const { parseRunnerArgs } = await import('../runner/args.mjs');
  const { resolveRunnerConfiguration } = await import('../runner/config_loader.mjs');
  const { existsSync } = await import('node:fs');
  const cli = parseRunnerArgs(['--check', ...argv], { cwd, allowUnresolvedMode: true });
  const defaultConfigPath = path.join(cwd, 'config', 'paperecho.config.json');
  // The optional UI remains usable before a Runner config has been initialized.
  if (!cli.mode && !cli.configPath && !env.PAPERECHO_CONFIG && !existsSync(defaultConfigPath)) cli.mode = 'desktop';
  const resolved = await resolveRunnerConfiguration(cli, { cwd, env, defaultConfigPath });
  let runtimeEnv = resolved.env;
  let localRepository = null;
  if (resolved.options.mode === 'local') {
    const local = buildLocalRuntimeConfig({ cwd, argv: resolved.options.outputRoot ? ['--output-root', resolved.options.outputRoot] : [] });
    runtimeEnv = { ...runtimeEnv, review_results_OUTPUT_ROOT: local.outputRoot };
    const { LocalRepository } = await import('../local/local_repository.mjs');
    localRepository = new LocalRepository(local.outputRoot);
  }
  const runtime = buildRuntimeConfig({ cwd, env: runtimeEnv, argv: [] });
  return { ...runtime, env: runtimeEnv, mode: resolved.options.mode, configPath: resolved.options.configPath,
    runRoot: localRepository?.runsDir || path.join(runtime.reviewRoot, 'runs'),
    localRepository };
}
