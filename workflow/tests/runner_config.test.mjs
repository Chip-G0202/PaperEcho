import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseRunnerArgs } from "../tools/runner/args.mjs";
import { resolveRunnerConfiguration } from "../tools/runner/config_loader.mjs";
import { EXIT_CODES } from "../tools/runner/constants.mjs";
import { main as runnerMain, redactText } from "../tools/runner/main.mjs";
import { buildExecutionPlan, runPreflight } from "../tools/runner/preflight.mjs";

function sink() {
  let value = "";
  return { write(chunk) { value += String(chunk); }, text() { return value; } };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-config-"));
  const configPath = path.join(root, "paperecho config.json");
  const input = path.join(root, "input.json");
  const outputRoot = path.join(root, "output");
  const entry = path.join(root, "entry.mjs");
  await fs.writeFile(input, "[]\n");
  await fs.writeFile(entry, "export {};\n");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, configPath, input, outputRoot, entry };
}

async function writeConfig(configPath, value) {
  await fs.writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`);
}

function parse(argv, cwd) {
  return parseRunnerArgs(argv, { cwd, allowUnresolvedMode: true });
}

function configFor(mode, paths, overrides = {}) {
  const sections = {
    desktop: { enabled: mode === "desktop", zoteroExe: "Zotero/zotero.exe", cliTool: "zotero-cli" },
    web: { enabled: mode === "web", apiKeyEnv: "TEST_ZOTERO_KEY", userId: "12345" },
    local: { enabled: mode === "local", input: "input.json", outputRoot: "output" },
  };
  return {
    schemaVersion: 1,
    profile: "standard",
    common: { cleanup: { enabled: true, retentionDays: 21 } },
    ...sections,
    ...overrides,
  };
}

test("one enabled module selects Desktop, Web, or Local and reuses common settings", async (t) => {
  for (const mode of ["desktop", "web", "local"]) {
    await t.test(mode, async (t) => {
      const paths = await fixture(t);
      await writeConfig(paths.configPath, configFor(mode, paths));
      const env = { TEST_ZOTERO_KEY: "web-secret" };
      const resolved = await resolveRunnerConfiguration(parse(["--check", "--config", paths.configPath], paths.root), { cwd: paths.root, env });
      assert.equal(resolved.options.mode, mode);
      assert.equal(resolved.options.configSummary.modeSource, `${mode}.enabled`);
      assert.deepEqual(resolved.options.configSummary.sectionsChecked, ["common", mode]);
      assert.equal(resolved.env.PAPERFLOW_CLEANUP_ENABLED, "true");
      assert.equal(resolved.env.PAPERFLOW_RETENTION_DAYS, "21");
      if (mode === "desktop") assert.equal(resolved.env.ZOTERO_DESKTOP_CLI_TOOL, "zotero-cli");
      if (mode === "web") assert.equal(resolved.env.ZOTERO_API_KEY, "web-secret");
      if (mode === "local") {
        assert.equal(resolved.options.input, paths.input);
        assert.equal(resolved.options.outputRoot, paths.outputRoot);
        assert.equal(resolved.options.llmMode, "disabled");
      }
    });
  }
});

test("mode selection is deterministic and never inferred from residual environment", async (t) => {
  const paths = await fixture(t);
  const ambiguous = configFor("desktop", paths, { desktop: { enabled: true }, web: { enabled: true }, local: { enabled: false } });
  await writeConfig(paths.configPath, ambiguous);
  await assert.rejects(
    resolveRunnerConfiguration(parse(["--check", "--config", paths.configPath], paths.root), { cwd: paths.root, env: {} }),
    (error) => error.code === "CONFIG_MODE_AMBIGUOUS",
  );

  ambiguous.mode = "web";
  await writeConfig(paths.configPath, ambiguous);
  const explicit = await resolveRunnerConfiguration(parse(["--check", "--config", paths.configPath], paths.root), { cwd: paths.root, env: { ZOTERO_API_KEY: "legacy" } });
  assert.equal(explicit.options.mode, "web");

  const override = await resolveRunnerConfiguration(parse(["--mode", "local", "--check", "--config", paths.configPath], paths.root), { cwd: paths.root, env: {} });
  assert.equal(override.options.mode, "local");
  assert.match(override.warnings[0], /overrides configured mode web/);

  await assert.rejects(
    resolveRunnerConfiguration(parse(["--mode", "desktop", "--fixed-mode", "--check", "--config", paths.configPath], paths.root), { cwd: paths.root, env: {} }),
    (error) => error.code === "CONFIG_FIXED_MODE_CONFLICT",
  );

  await assert.rejects(
    resolveRunnerConfiguration(parse(["--check"], paths.root), {
      cwd: paths.root,
      env: { ZOTERO_API_KEY: "residual", ZOTERO_BACKEND: "web_api" },
      defaultConfigPath: path.join(paths.root, "missing.json"),
      existsSync: () => false,
    }),
    (error) => error.code === "CONFIG_MODE_REQUIRED",
  );
});

test("precedence is CLI then unified config then environment", async (t) => {
  const paths = await fixture(t);
  await writeConfig(paths.configPath, {
    schemaVersion: 1,
    mode: "local",
    profile: "complete",
    common: {
      email: { enabled: true, recipient: "config@example.invalid", smtp: { host: "config.smtp.invalid" } },
      cleanup: { enabled: true, retentionDays: 7 },
    },
    local: { enabled: true, input: "input.json", outputRoot: "output" },
  });
  const env = { PAPERFLOW_REPORT_TO: "env@example.invalid", SMTP_HOST: "env.smtp.invalid", PAPERFLOW_RETENTION_DAYS: "90" };
  const fromConfig = await resolveRunnerConfiguration(parse(["--check", "--config", paths.configPath], paths.root), { cwd: paths.root, env });
  assert.equal(fromConfig.options.profile, "complete");
  assert.equal(fromConfig.options.email, "config@example.invalid");
  assert.equal(fromConfig.env.SMTP_HOST, "config.smtp.invalid");
  assert.equal(fromConfig.env.PAPERFLOW_RETENTION_DAYS, "7");

  const cliInput = path.join(paths.root, "cli.json");
  const cliOutput = path.join(paths.root, "cli-output");
  const fromCli = await resolveRunnerConfiguration(parse([
    "--mode", "local", "--check", "--config", paths.configPath,
    "--profile", "standard", "--email", "cli@example.invalid",
    "--input", cliInput, "--output-root", cliOutput,
  ], paths.root), { cwd: paths.root, env });
  assert.equal(fromCli.options.profile, "standard");
  assert.equal(fromCli.options.email, "cli@example.invalid");
  assert.equal(fromCli.options.input, cliInput);
  assert.equal(fromCli.options.outputRoot, cliOutput);
});

test("secret references expose presence only and selected paths stay isolated", async (t) => {
  const paths = await fixture(t);
  await writeConfig(paths.configPath, {
    schemaVersion: 1,
    mode: "local",
    common: {
      journalQualityApiKeyEnv: "TEST_JOURNAL_KEY",
      llm: { enabled: true, preferenceApiKeyEnv: "TEST_LLM_KEY", translationApiKeyEnv: "TEST_TRANSLATION_KEY" },
      email: { smtp: { passwordEnv: "TEST_SMTP_PASS" } },
    },
    desktop: { enabled: false, cliTool: "unused-cli" },
    web: { enabled: false, apiKeyEnv: "TEST_ZOTERO_KEY" },
    local: { enabled: true, input: "input.json", outputRoot: "output" },
  });
  const env = {
    TEST_JOURNAL_KEY: "journal-secret",
    TEST_LLM_KEY: "llm-secret",
    TEST_TRANSLATION_KEY: "translation-secret",
    TEST_SMTP_PASS: "smtp-secret",
    TEST_ZOTERO_KEY: "web-secret",
  };
  const resolved = await resolveRunnerConfiguration(parse(["--check", "--config", paths.configPath], paths.root), { cwd: paths.root, env });
  assert.equal(resolved.env.EASYSCHOLAR_SECRET_KEY, "journal-secret");
  assert.equal(resolved.env.PREFERENCE_LEARNING_API_KEY, "llm-secret");
  assert.equal(resolved.env.TITLE_TRANSLATION_API_KEY, "translation-secret");
  assert.equal(resolved.env.SMTP_PASS, "smtp-secret");
  assert.equal(resolved.env.ZOTERO_API_KEY, undefined);
  assert.equal(resolved.env.ZOTERO_DESKTOP_CLI_TOOL, undefined);
  const summary = JSON.stringify(resolved.options.configSummary);
  for (const secret of Object.values(env)) assert.equal(summary.includes(secret), false);
  assert.equal(resolved.options.configSummary.secretStatus.SMTP_PASS.configured, true);
  assert.equal(redactText("journal-secret", resolved.env), "[REDACTED]");
});

test("missing secret alias overrides a residual canonical secret without revealing it", async (t) => {
  const paths = await fixture(t);
  await writeConfig(paths.configPath, {
    schemaVersion: 1,
    mode: "web",
    web: { enabled: true, apiKeyEnv: "MISSING_ZOTERO_KEY" },
  });
  const resolved = await resolveRunnerConfiguration(parse(["--check", "--config", paths.configPath], paths.root), { cwd: paths.root, env: { ZOTERO_API_KEY: "stale-secret" } });
  assert.equal(resolved.env.ZOTERO_API_KEY, undefined);
  assert.deepEqual(resolved.options.configSummary.secretStatus.ZOTERO_API_KEY, { env: "MISSING_ZOTERO_KEY", configured: false });
  assert.equal(JSON.stringify(resolved.options.configSummary).includes("stale-secret"), false);
});

test("invalid, unsupported, unknown, and missing config files fail closed", async (t) => {
  const paths = await fixture(t);
  const cli = parse(["--check", "--config", paths.configPath], paths.root);
  const cases = [
    ["{", "CONFIG_JSON_INVALID"],
    [JSON.stringify({ schemaVersion: 3, mode: "local" }), "CONFIG_SCHEMA_UNSUPPORTED"],
    [JSON.stringify({ schemaVersion: 1, mode: "local", local: { enabled: true, apiKey: "forbidden" } }), "CONFIG_FIELD_UNKNOWN"],
  ];
  for (const [raw, code] of cases) {
    await fs.writeFile(paths.configPath, raw);
    await assert.rejects(resolveRunnerConfiguration(cli, { cwd: paths.root, env: {} }), (error) => error.code === code);
  }
  await fs.rm(paths.configPath, { force: true });
  await assert.rejects(resolveRunnerConfiguration(cli, { cwd: paths.root, env: {} }), (error) => error.code === "CONFIG_FILE_UNREADABLE" && !error.message.includes(paths.root));
});

test("resolver reloads the file on every invocation for continue semantics", async (t) => {
  const paths = await fixture(t);
  const config = configFor("local", paths);
  config.common.email = { enabled: true, recipient: "first@example.invalid" };
  await writeConfig(paths.configPath, config);
  const cli = parse(["--check", "--config", paths.configPath], paths.root);
  const first = await resolveRunnerConfiguration(cli, { cwd: paths.root, env: {} });
  config.common.email.recipient = "second@example.invalid";
  await writeConfig(paths.configPath, config);
  const second = await resolveRunnerConfiguration(cli, { cwd: paths.root, env: {} });
  assert.equal(first.options.email, "first@example.invalid");
  assert.equal(second.options.email, "second@example.invalid");
});

test("schema v1 preserves legacy behavior and cannot enable new notifiers", async (t) => {
  const paths = await fixture(t);
  await writeConfig(paths.configPath, configFor("local", paths));
  const resolved = await resolveRunnerConfiguration(parse(["--check", "--config", paths.configPath], paths.root), { cwd: paths.root, env: { PAPERECHO_FAILURE_NOTIFIER_ENABLED: "true", PAPERECHO_HEALTH_NOTIFIER_ENABLED: "true" } });
  assert.equal(resolved.options.configSummary.schemaVersion, 1);
  assert.equal(resolved.env.PAPERECHO_CONFIG_SCHEMA_VERSION, "1");
  assert.equal(resolved.env.PAPERECHO_FAILURE_NOTIFIER_ENABLED, undefined);
  assert.equal(resolved.env.PAPERECHO_HEALTH_NOTIFIER_ENABLED, undefined);
});

test("schema v2 enables only configured notification capabilities with safe defaults", async (t) => {
  const paths = await fixture(t);
  const config = configFor("local", paths, {
    schemaVersion: 2,
    common: {
      sourceState: { root: "source-state" },
      notifications: { failure: { enabled: true }, health: { enabled: true, consecutiveThreshold: 2 }, receiptStore: { root: "receipts", retryFailed: true, unknownPolicy: "hold" } },
      radar: { enabled: true }, integrity: { enabled: true, bootstrapBatchSize: 25, crossrefConcurrency: 2, pubmedBatchSize: 180, cacheTtlDays: 7 },
    },
  });
  await writeConfig(paths.configPath, config);
  const resolved = await resolveRunnerConfiguration(parse(["--check", "--config", paths.configPath], paths.root), { cwd: paths.root, env: {} });
  assert.equal(resolved.env.PAPERECHO_CONFIG_SCHEMA_VERSION, "2");
  assert.equal(resolved.env.PAPERECHO_FAILURE_NOTIFIER_ENABLED, "true");
  assert.equal(resolved.env.PAPERECHO_HEALTH_NOTIFIER_ENABLED, "true");
  assert.equal(resolved.env.PAPERECHO_NOTIFICATION_UNKNOWN_POLICY, "hold");
  assert.equal(resolved.env.SMTP_HOST, undefined);
  assert.equal(resolved.env.PAPERECHO_RADAR_ENABLED, "true");
  assert.equal(resolved.env.PAPERECHO_INTEGRITY_ENABLED, "true");
  assert.equal(resolved.env.PAPERECHO_INTEGRITY_BOOTSTRAP_BATCH_SIZE, "25");
  assert.equal(resolved.env.PAPERECHO_INTEGRITY_CROSSREF_CONCURRENCY, "2");
  assert.equal(resolved.env.PAPERECHO_INTEGRITY_PUBMED_BATCH_SIZE, "180");
  assert.equal(resolved.env.PAPERECHO_INTEGRITY_CACHE_TTL_DAYS, "7");
  assert.equal(resolved.warnings.length, 0);
});

test("schema v2 canonical hash excludes secret values", async (t) => {
  const paths = await fixture(t);
  await writeConfig(paths.configPath, {
    schemaVersion: 2, mode: "local",
    common: { email: { smtp: { passwordEnv: "TEST_SMTP_PASS" } }, notifications: { failure: { enabled: true } } },
    local: { enabled: true, input: "input.json", outputRoot: "output" },
  });
  const cli = parse(["--check", "--config", paths.configPath], paths.root);
  const first = await resolveRunnerConfiguration(cli, { cwd: paths.root, env: { TEST_SMTP_PASS: "first-secret" } });
  const second = await resolveRunnerConfiguration(cli, { cwd: paths.root, env: { TEST_SMTP_PASS: "second-secret" } });
  assert.equal(first.options.recoveryConfigHash, second.options.recoveryConfigHash);
  assert.equal(JSON.stringify(first.options).includes("first-secret"), false);
});

test("configuration blocking happens before preflight or production", async (t) => {
  const paths = await fixture(t);
  await writeConfig(paths.configPath, { schemaVersion: 1, desktop: { enabled: true }, web: { enabled: true } });
  let preflightCalls = 0;
  let productionCalls = 0;
  const stderr = sink();
  const code = await runnerMain(["--run", "--config", paths.configPath], {
    cwd: paths.root,
    env: {},
    runPreflightImpl: async () => { preflightCalls += 1; },
    runProductionImpl: async () => { productionCalls += 1; },
    stdout: sink(),
    stderr,
  });
  assert.equal(code, EXIT_CODES.configuration);
  assert.equal(preflightCalls, 0);
  assert.equal(productionCalls, 0);
  assert.match(stderr.text(), /CONFIG_MODE_AMBIGUOUS/);
});

test("ready unified config reaches one selected production mapping", async (t) => {
  const paths = await fixture(t);
  await writeConfig(paths.configPath, configFor("local", paths));
  let seenOptions;
  let productionCalls = 0;
  const code = await runnerMain(["--run", "--config", paths.configPath], {
    cwd: paths.root,
    env: {},
    runPreflightImpl: async (options) => {
      seenOptions = options;
      return { status: "ready", mode: options.mode, profile: options.profile, requiredMissing: [], canRun: true };
    },
    buildExecutionPlanImpl: (options, dependencies) => ({ entry: "local-entry", args: [], childEnv: dependencies.env, cwd: paths.root, runRoot: "runs", mode: options.mode }),
    runProductionImpl: async (plan) => { productionCalls += 1; assert.equal(plan.mode, "local"); return { code: 0, stdout: "{}", stderr: "" }; },
    validateProductionResultImpl: async () => ({ ok: true, exitCode: 0 }),
    stdout: sink(), stderr: sink(),
  });
  assert.equal(code, 0);
  assert.equal(seenOptions.mode, "local");
  assert.equal(productionCalls, 1);
});

test("execution plans map Desktop/Web to Stage0 semantics and strip Zotero from Local", async (t) => {
  const paths = await fixture(t);
  const entries = { desktop: "desktop-stage0", web: "web-stage0", local: "local-entry" };
  const base = { action: "run", profile: "standard", email: "", llmMode: "", forceResend: false, requireLlm: false, input: paths.input, outputRoot: paths.outputRoot, feedback: "" };
  const desktop = buildExecutionPlan({ ...base, mode: "desktop", input: "", outputRoot: "" }, { env: {}, repoRoot: paths.root, entries });
  const web = buildExecutionPlan({ ...base, mode: "web", input: "", outputRoot: "" }, { env: { ZOTERO_API_KEY: "secret" }, repoRoot: paths.root, entries });
  const local = buildExecutionPlan({ ...base, mode: "local" }, { env: { ZOTERO_API_KEY: "poison", ZOTERO_BACKEND: "web_api" }, repoRoot: paths.root, entries });
  assert.equal(desktop.entry, path.resolve("desktop-stage0"));
  assert.equal(web.entry, path.resolve("web-stage0"));
  assert.equal(desktop.childEnv.ZOTERO_BACKEND, "cli");
  assert.equal(web.childEnv.ZOTERO_BACKEND, "web_api");
  assert.equal(local.entry, path.resolve("local-entry"));
  assert.equal(local.childEnv.ZOTERO_API_KEY, undefined);
  assert.equal(local.childEnv.ZOTERO_BACKEND, undefined);
});

test("preflight reports only common plus selected path and a secret-free retry", async (t) => {
  const paths = await fixture(t);
  const options = {
    mode: "local", action: "check", profile: "standard", input: "", outputRoot: "", feedback: "", email: "",
    llmMode: "disabled", forceResend: false, requireLlm: false, configPath: paths.configPath,
    configSummary: { sectionsChecked: ["common", "local"], secretStatus: {} }, configWarnings: [],
  };
  const report = await runPreflight(options, {
    env: { ZOTERO_API_KEY: "poison" },
    entries: { desktop: paths.entry, web: paths.entry, local: paths.entry },
    existsSync: (value) => value === paths.entry,
    resolveLlmRuntimeImpl: () => ({ apiKeyConfigured: false }),
  });
  assert.equal(report.canRun, false);
  assert.deepEqual(Object.keys(report.missingBySection), ["common", "local"]);
  assert.equal("desktop" in report.missingBySection, false);
  assert.equal("web" in report.missingBySection, false);
  assert.match(report.retryCommand, /--config/);
  assert.equal(JSON.stringify(report).includes("poison"), false);
});

test("legacy direct Runner mode remains compatible without a unified file", async (t) => {
  const paths = await fixture(t);
  const cli = parse(["--mode", "local", "--check", "--input", paths.input, "--output-root", paths.outputRoot], paths.root);
  const resolved = await resolveRunnerConfiguration(cli, {
    cwd: paths.root,
    env: { PAPERFLOW_CLEANUP_ENABLED: "false" },
    defaultConfigPath: path.join(paths.root, "absent.json"),
    existsSync: () => false,
  });
  assert.equal(resolved.options.mode, "local");
  assert.equal(resolved.options.llmMode, "disabled");
  assert.equal(resolved.env.PAPERFLOW_CLEANUP_ENABLED, "false");
  assert.equal(resolved.options.configSource, "none");
});

test("config tests expose no real external client", () => {
  const source = [resolveRunnerConfiguration, runPreflight, buildExecutionPlan].map(String).join("\n");
  assert.doesNotMatch(source, /await fetch\(|nodemailer|zotero-cli app ping|runStage[12345]\(/);
});
