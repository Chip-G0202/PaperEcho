import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODES, PROFILES, RUNNER_SCHEMA_VERSION, SUPPORTED_RUNNER_CONFIG_SCHEMAS } from "./constants.mjs";
import { canonicalQueryHash } from "../stage1/source_state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, "config", "paperecho.config.json");

const SECTION_KEYS = Object.freeze({
  common: new Set(["projectRoot", "llm", "email", "cleanup", "journalQualityApiKeyEnv"]),
  llm: new Set(["enabled", "mode", "requireRealModel", "preferenceApiKeyEnv", "translationApiKeyEnv", "preferenceConfig", "translationConfig"]),
  email: new Set(["enabled", "recipient", "smtp"]),
  smtp: new Set(["host", "user", "passwordEnv", "port", "secure", "from"]),
  cleanup: new Set(["enabled", "retentionDays"]),
  desktop: new Set(["enabled", "zoteroExe", "cliTool", "writebackBatchSize", "startupRetries", "startupIntervalMs", "postStartDelayMs"]),
  web: new Set(["enabled", "apiKeyEnv", "userId", "apiBase", "requestConcurrency"]),
  local: new Set(["enabled", "input", "outputRoot", "feedback"]),
  sourceState: new Set(["root"]),
  notifications: new Set(["failure", "health", "receiptStore"]),
  failure: new Set(["enabled"]),
  health: new Set(["enabled", "consecutiveThreshold"]),
  receiptStore: new Set(["root", "retryFailed", "unknownPolicy"]),
  radar: new Set(["enabled", "dailyTime", "retentionDays"]),
  integrity: new Set(["enabled"]),
});
const V2_COMMON_KEYS = new Set(["sourceState", "notifications", "radar", "integrity"]);

export class RunnerConfigurationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RunnerConfigurationError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new RunnerConfigurationError(code, message, details);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function validateKeys(value, section, schemaVersion = 1) {
  if (value == null) return {};
  if (!isObject(value)) fail("CONFIG_SECTION_INVALID", `${section} must be an object`, { section });
  const allowed = section === "common" && schemaVersion === 2 ? new Set([...SECTION_KEYS.common, ...V2_COMMON_KEYS]) : SECTION_KEYS[section];
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("CONFIG_FIELD_UNKNOWN", `${section}.${key} is not supported`, { section, field: key });
  }
  return value;
}

function optionalBoolean(value, field) {
  if (value == null) return;
  if (typeof value !== "boolean") fail("CONFIG_TYPE_INVALID", `${field} must be boolean or null`, { field });
}

function optionalString(value, field) {
  if (value == null) return;
  if (typeof value !== "string") fail("CONFIG_TYPE_INVALID", `${field} must be string or null`, { field });
}

function optionalInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null) return;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail("CONFIG_TYPE_INVALID", `${field} must be an integer between ${min} and ${max}`, { field });
  }
}

function validateEnabledSections(config) {
  for (const mode of MODES) {
    const section = config?.[mode];
    if (section == null) continue;
    if (!isObject(section)) fail("CONFIG_SECTION_INVALID", `${mode} must be an object`, { section: mode });
    optionalBoolean(section.enabled, `${mode}.enabled`);
  }
}

function validateCommon(common, schemaVersion = 1) {
  const value = validateKeys(common, "common", schemaVersion);
  optionalString(value.projectRoot, "common.projectRoot");
  optionalString(value.journalQualityApiKeyEnv, "common.journalQualityApiKeyEnv");

  const llm = validateKeys(value.llm, "llm");
  optionalBoolean(llm.enabled, "common.llm.enabled");
  optionalString(llm.mode, "common.llm.mode");
  if (llm.mode != null && !["disabled", "mock", "real"].includes(llm.mode)) fail("CONFIG_VALUE_INVALID", "common.llm.mode must be disabled, mock, or real", { field: "common.llm.mode" });
  optionalBoolean(llm.requireRealModel, "common.llm.requireRealModel");
  optionalString(llm.preferenceApiKeyEnv, "common.llm.preferenceApiKeyEnv");
  optionalString(llm.translationApiKeyEnv, "common.llm.translationApiKeyEnv");
  optionalString(llm.preferenceConfig, "common.llm.preferenceConfig");
  optionalString(llm.translationConfig, "common.llm.translationConfig");
  if (llm.enabled === false && llm.requireRealModel === true) fail("CONFIG_VALUE_CONFLICT", "common.llm cannot be disabled and require a real model", { section: "common" });

  const email = validateKeys(value.email, "email");
  optionalBoolean(email.enabled, "common.email.enabled");
  optionalString(email.recipient, "common.email.recipient");
  const smtp = validateKeys(email.smtp, "smtp");
  for (const field of ["host", "user", "passwordEnv", "from"]) optionalString(smtp[field], `common.email.smtp.${field}`);
  optionalInteger(smtp.port, "common.email.smtp.port", { min: 1, max: 65535 });
  optionalBoolean(smtp.secure, "common.email.smtp.secure");

  const cleanup = validateKeys(value.cleanup, "cleanup");
  optionalBoolean(cleanup.enabled, "common.cleanup.enabled");
  optionalInteger(cleanup.retentionDays, "common.cleanup.retentionDays", { min: 0, max: 36500 });
  let sourceState = {};
  let notifications = {};
  let failure = {};
  let health = {};
  let receiptStore = {};
  if (schemaVersion === 2) {
    sourceState = validateKeys(value.sourceState, "sourceState");
    optionalString(sourceState.root, "common.sourceState.root");
    notifications = validateKeys(value.notifications, "notifications");
    failure = validateKeys(notifications.failure, "failure");
    optionalBoolean(failure.enabled, "common.notifications.failure.enabled");
    health = validateKeys(notifications.health, "health");
    optionalBoolean(health.enabled, "common.notifications.health.enabled");
    optionalInteger(health.consecutiveThreshold, "common.notifications.health.consecutiveThreshold", { min: 2, max: 20 });
    receiptStore = validateKeys(notifications.receiptStore, "receiptStore");
    optionalString(receiptStore.root, "common.notifications.receiptStore.root");
    optionalBoolean(receiptStore.retryFailed, "common.notifications.receiptStore.retryFailed");
    optionalString(receiptStore.unknownPolicy, "common.notifications.receiptStore.unknownPolicy");
    if (receiptStore.unknownPolicy != null && receiptStore.unknownPolicy !== "hold") fail("CONFIG_VALUE_INVALID", "common.notifications.receiptStore.unknownPolicy must be hold", { field: "common.notifications.receiptStore.unknownPolicy" });
    for (const section of ["radar", "integrity"]) {
      const reserved = validateKeys(value[section], section);
      optionalBoolean(reserved.enabled, `common.${section}.enabled`);
      if (section === "radar") {
        optionalString(reserved.dailyTime, "common.radar.dailyTime");
        if (reserved.dailyTime != null && reserved.dailyTime !== "15:00") fail("CONFIG_VALUE_INVALID", "common.radar.dailyTime must be 15:00", { field: "common.radar.dailyTime" });
        optionalInteger(reserved.retentionDays, "common.radar.retentionDays", { min: 0, max: 36500 });
      }
    }
  }
  return { value, llm, email, smtp, cleanup, sourceState, notifications, failure, health, receiptStore };
}

function validatePathSection(mode, raw) {
  const value = validateKeys(raw, mode);
  optionalBoolean(value.enabled, `${mode}.enabled`);
  if (mode === "desktop") {
    for (const field of ["zoteroExe", "cliTool"]) optionalString(value[field], `desktop.${field}`);
    optionalInteger(value.writebackBatchSize, "desktop.writebackBatchSize", { min: 1, max: 50 });
    optionalInteger(value.startupRetries, "desktop.startupRetries", { min: 1, max: 300 });
    optionalInteger(value.startupIntervalMs, "desktop.startupIntervalMs", { min: 1, max: 120000 });
    optionalInteger(value.postStartDelayMs, "desktop.postStartDelayMs", { min: 0, max: 120000 });
  } else if (mode === "web") {
    for (const field of ["apiKeyEnv", "userId", "apiBase"]) optionalString(value[field], `web.${field}`);
    optionalInteger(value.requestConcurrency, "web.requestConcurrency", { min: 1, max: 4 });
  } else {
    for (const field of ["input", "outputRoot", "feedback"]) optionalString(value[field], `local.${field}`);
  }
  return value;
}

function safeConfigPath(filePath, cwd) {
  if (!filePath) return null;
  const relative = path.relative(cwd, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : `<external>/${path.basename(filePath)}`;
}

function resolveRelative(value, configDir) {
  if (!String(value || "").trim()) return "";
  return path.resolve(configDir, String(value).trim());
}

function setEnvValue(target, name, value) {
  if (value === undefined || value === null || value === "") return;
  target[name] = typeof value === "boolean" ? String(value) : String(value);
}

function mapSecretReference({ target, sourceEnv, canonicalName, envName, secretStatus }) {
  if (!String(envName || "").trim()) return;
  const sourceName = String(envName).trim();
  const value = String(sourceEnv[sourceName] || "");
  if (value) target[canonicalName] = value;
  else delete target[canonicalName];
  secretStatus[canonicalName] = { env: sourceName, configured: Boolean(value) };
}

async function loadConfigFile({ requestedPath, source, fsApi, cwd }) {
  if (!requestedPath) return { config: null, configPath: "", source: "none" };
  let raw;
  try { raw = await fsApi.readFile(requestedPath, "utf8"); }
  catch (error) {
    fail("CONFIG_FILE_UNREADABLE", `PaperEcho config is not readable: ${safeConfigPath(requestedPath, cwd)}`, { source, path: safeConfigPath(requestedPath, cwd), reason: error?.code || "read_failed" });
  }
  let config;
  try { config = JSON.parse(raw); }
  catch (error) { fail("CONFIG_JSON_INVALID", `PaperEcho config JSON is invalid: ${error.message}`, { path: safeConfigPath(requestedPath, cwd) }); }
  if (!isObject(config)) fail("CONFIG_ROOT_INVALID", "PaperEcho config root must be an object");
  if (!SUPPORTED_RUNNER_CONFIG_SCHEMAS.has(config.schemaVersion)) fail("CONFIG_SCHEMA_UNSUPPORTED", "PaperEcho config schemaVersion must be 1 or 2", { schemaVersion: config.schemaVersion ?? null });
  for (const key of Object.keys(config)) {
    if (!new Set(["schemaVersion", "mode", "profile", "common", "desktop", "web", "local"]).has(key)) fail("CONFIG_FIELD_UNKNOWN", `top-level field ${key} is not supported`, { field: key });
  }
  optionalString(config.mode, "mode");
  if (config.mode != null && !MODES.has(config.mode)) fail("CONFIG_MODE_INVALID", `mode must be desktop, web, local, or null`, { mode: config.mode });
  optionalString(config.profile, "profile");
  if (config.profile != null && !PROFILES.has(config.profile)) fail("CONFIG_PROFILE_INVALID", "profile must be standard, complete, or radar", { profile: config.profile });
  validateEnabledSections(config);
  return { config, configPath: requestedPath, source };
}

function selectConfigMode(config) {
  if (!config) return { mode: "", source: "none", enabled: [] };
  const enabled = [...MODES].filter((mode) => config?.[mode]?.enabled === true);
  if (config.mode) return { mode: config.mode, source: "config.mode", enabled };
  if (enabled.length === 1) return { mode: enabled[0], source: `${enabled[0]}.enabled`, enabled };
  if (enabled.length > 1) fail("CONFIG_MODE_AMBIGUOUS", "multiple path modules are enabled; set mode explicitly", { enabled });
  return { mode: "", source: "none", enabled };
}

export async function resolveRunnerConfiguration(cliOptions, dependencies = {}) {
  const cwd = dependencies.cwd || process.cwd();
  const env = dependencies.env || process.env;
  const fsApi = dependencies.fsApi || fs;
  const existsSync = dependencies.existsSync || fsSync.existsSync;
  const defaultConfigPath = dependencies.defaultConfigPath || DEFAULT_CONFIG_PATH;
  const explicitConfigPath = String(cliOptions.configPath || "").trim();
  const envConfigPath = String(env.PAPERECHO_CONFIG || "").trim();
  let requestedPath = "";
  let configSource = "none";
  if (explicitConfigPath) {
    requestedPath = explicitConfigPath;
    configSource = "cli";
  } else if (envConfigPath) {
    requestedPath = path.resolve(cwd, envConfigPath);
    configSource = "environment";
  } else if (existsSync(defaultConfigPath)) {
    requestedPath = defaultConfigPath;
    configSource = "default_file";
  }

  const loaded = await loadConfigFile({ requestedPath, source: configSource, fsApi, cwd });
  const config = loaded.config;
  const configSelection = selectConfigMode(config);
  const warnings = [];
  if (cliOptions.fixedMode && configSelection.mode && configSelection.mode !== cliOptions.mode) {
    fail("CONFIG_FIXED_MODE_CONFLICT", `fixed ${cliOptions.mode} launcher conflicts with configured ${configSelection.mode} mode`, { launcherMode: cliOptions.mode, configuredMode: configSelection.mode });
  }
  const mode = cliOptions.mode || configSelection.mode;
  if (!mode) fail("CONFIG_MODE_REQUIRED", "select a mode or enable exactly one path module", { enabled: configSelection.enabled });
  if (cliOptions.mode && configSelection.mode && cliOptions.mode !== configSelection.mode && !cliOptions.fixedMode) {
    warnings.push(`CLI mode ${cliOptions.mode} overrides configured mode ${configSelection.mode}`);
  }

  const configSchemaVersion = config?.schemaVersion || 0;
  const common = validateCommon(config?.common, configSchemaVersion || 1);
  const pathSection = validatePathSection(mode, config?.[mode]);
  const configDir = loaded.configPath ? path.dirname(loaded.configPath) : cwd;
  const effectiveEnv = { ...env };
  const secretStatus = {};
  effectiveEnv.PAPERECHO_CONFIG_SCHEMA_VERSION = String(configSchemaVersion);
  for (const name of ["PAPERECHO_FAILURE_NOTIFIER_ENABLED", "PAPERECHO_HEALTH_NOTIFIER_ENABLED", "PAPERECHO_HEALTH_DEGRADATION_THRESHOLD", "PAPERECHO_NOTIFICATION_RECEIPT_ROOT", "PAPERECHO_NOTIFICATION_HEALTH_ROOT", "PAPERECHO_NOTIFICATION_RETRY_FAILED", "PAPERECHO_NOTIFICATION_UNKNOWN_POLICY", "PAPERECHO_SOURCE_STATE_ROOT"]) delete effectiveEnv[name];

  if (has(common.value, "projectRoot") && common.value.projectRoot) effectiveEnv.ZOTERO_PROJECT_ROOT = resolveRelative(common.value.projectRoot, configDir);
  if (has(common.cleanup, "enabled")) setEnvValue(effectiveEnv, "PAPERFLOW_CLEANUP_ENABLED", common.cleanup.enabled);
  if (has(common.cleanup, "retentionDays")) setEnvValue(effectiveEnv, "PAPERFLOW_RETENTION_DAYS", common.cleanup.retentionDays);
  if (configSchemaVersion === 2) {
    setEnvValue(effectiveEnv, "PAPERECHO_FAILURE_NOTIFIER_ENABLED", common.failure.enabled === true);
    setEnvValue(effectiveEnv, "PAPERECHO_HEALTH_NOTIFIER_ENABLED", common.health.enabled === true);
    setEnvValue(effectiveEnv, "PAPERECHO_HEALTH_DEGRADATION_THRESHOLD", common.health.consecutiveThreshold ?? 2);
    setEnvValue(effectiveEnv, "PAPERECHO_NOTIFICATION_RETRY_FAILED", common.receiptStore.retryFailed !== false);
    setEnvValue(effectiveEnv, "PAPERECHO_NOTIFICATION_UNKNOWN_POLICY", common.receiptStore.unknownPolicy || "hold");
    if (common.receiptStore.root) effectiveEnv.PAPERECHO_NOTIFICATION_RECEIPT_ROOT = resolveRelative(common.receiptStore.root, configDir);
    if (common.sourceState.root) effectiveEnv.PAPERECHO_SOURCE_STATE_ROOT = resolveRelative(common.sourceState.root, configDir);
    effectiveEnv.PAPERECHO_NOTIFICATION_HEALTH_ROOT = path.join(path.dirname(effectiveEnv.PAPERECHO_NOTIFICATION_RECEIPT_ROOT || effectiveEnv.PAPERECHO_SOURCE_STATE_ROOT || resolveRelative("../review_results/source_state", configDir)), "notification_health");
    setEnvValue(effectiveEnv, "PAPERECHO_RADAR_ENABLED", common.value.radar?.enabled === true);
    if (common.value.radar?.dailyTime) setEnvValue(effectiveEnv, "PAPERECHO_RADAR_DAILY_TIME", common.value.radar.dailyTime);
    if (has(common.value.radar, "retentionDays")) setEnvValue(effectiveEnv, "PAPERECHO_RADAR_RETENTION_DAYS", common.value.radar.retentionDays);
    if (common.value.integrity?.enabled === true) warnings.push("common.integrity is reserved; integrity monitoring remains disabled in v2.1");
  }
  if (has(common.value, "journalQualityApiKeyEnv")) {
    mapSecretReference({ target: effectiveEnv, sourceEnv: env, canonicalName: "EASYSCHOLAR_SECRET_KEY", envName: common.value.journalQualityApiKeyEnv, secretStatus });
  }

  if (has(common.llm, "preferenceConfig") && common.llm.preferenceConfig) effectiveEnv.PREFERENCE_LEARNING_CONFIG_PATH = resolveRelative(common.llm.preferenceConfig, configDir);
  if (has(common.llm, "translationConfig") && common.llm.translationConfig) effectiveEnv.TITLE_TRANSLATION_CONFIG_PATH = resolveRelative(common.llm.translationConfig, configDir);
  if (has(common.llm, "preferenceApiKeyEnv")) mapSecretReference({ target: effectiveEnv, sourceEnv: env, canonicalName: "PREFERENCE_LEARNING_API_KEY", envName: common.llm.preferenceApiKeyEnv, secretStatus });
  if (has(common.llm, "translationApiKeyEnv")) mapSecretReference({ target: effectiveEnv, sourceEnv: env, canonicalName: "TITLE_TRANSLATION_API_KEY", envName: common.llm.translationApiKeyEnv, secretStatus });

  const smtpMap = { host: "SMTP_HOST", user: "SMTP_USER", port: "SMTP_PORT", secure: "SMTP_SECURE", from: "SMTP_FROM" };
  for (const [field, name] of Object.entries(smtpMap)) if (has(common.smtp, field)) setEnvValue(effectiveEnv, name, common.smtp[field]);
  if (has(common.smtp, "passwordEnv")) mapSecretReference({ target: effectiveEnv, sourceEnv: env, canonicalName: "SMTP_PASS", envName: common.smtp.passwordEnv, secretStatus });

  if (mode === "desktop") {
    if (pathSection.zoteroExe) effectiveEnv.ZOTERO_EXE = resolveRelative(pathSection.zoteroExe, configDir);
    if (pathSection.cliTool) effectiveEnv.ZOTERO_DESKTOP_CLI_TOOL = pathSection.cliTool;
    if (has(pathSection, "writebackBatchSize")) setEnvValue(effectiveEnv, "ZOTERO_CLI_WRITEBACK_BATCH_SIZE", pathSection.writebackBatchSize);
    if (has(pathSection, "startupRetries")) setEnvValue(effectiveEnv, "WORKFLOW_STARTUP_ZOTERO_BACKEND_RETRIES", pathSection.startupRetries);
    if (has(pathSection, "startupIntervalMs")) setEnvValue(effectiveEnv, "WORKFLOW_STARTUP_ZOTERO_BACKEND_INTERVAL_MS", pathSection.startupIntervalMs);
    if (has(pathSection, "postStartDelayMs")) setEnvValue(effectiveEnv, "WORKFLOW_STARTUP_ZOTERO_POST_START_DELAY_MS", pathSection.postStartDelayMs);
  } else if (mode === "web") {
    if (has(pathSection, "apiKeyEnv")) mapSecretReference({ target: effectiveEnv, sourceEnv: env, canonicalName: "ZOTERO_API_KEY", envName: pathSection.apiKeyEnv, secretStatus });
    if (pathSection.userId) effectiveEnv.ZOTERO_USER_ID = pathSection.userId;
    if (pathSection.apiBase) effectiveEnv.ZOTERO_API_BASE = pathSection.apiBase;
    if (has(pathSection, "requestConcurrency")) setEnvValue(effectiveEnv, "ZOTERO_WEB_API_REQUEST_CONCURRENCY", pathSection.requestConcurrency);
  }

  const provided = cliOptions.provided || {};
  const profile = provided.profile ? cliOptions.profile : (config?.profile || cliOptions.profile || "standard");
  if (profile === "radar" && configSchemaVersion !== 2) fail("CONFIG_RADAR_REQUIRES_SCHEMA_V2", "Radar profile requires schemaVersion 2", { profile });
  if (profile === "radar" && common.value.radar?.enabled !== true) fail("CONFIG_RADAR_NOT_ENABLED", "Radar profile requires common.radar.enabled=true", { profile });
  const configRequireLlm = common.llm.requireRealModel === true;
  const requireLlm = Boolean(cliOptions.requireLlm || configRequireLlm);
  let llmMode = cliOptions.llmMode;
  if (!provided.llmMode && !cliOptions.requireLlm) {
    if (configRequireLlm) llmMode = "real";
    else if (common.llm.enabled === false) llmMode = "disabled";
    else if (common.llm.mode) llmMode = common.llm.mode;
    else if (mode === "local" && common.llm.enabled !== true) llmMode = "disabled";
  }
  if (llmMode) effectiveEnv.LLM_MODE = llmMode;

  let email = cliOptions.email;
  if (!provided.email && config?.common?.email) {
    if (common.email.enabled === false) {
      email = "";
      delete effectiveEnv.PAPERFLOW_REPORT_TO;
      delete effectiveEnv.NOTIFICATION_EMAIL;
    } else if (common.email.recipient) email = common.email.recipient;
  }

  const input = provided.input ? cliOptions.input : resolveRelative(pathSection.input, configDir);
  const outputRoot = provided.outputRoot ? cliOptions.outputRoot : resolveRelative(pathSection.outputRoot, configDir);
  const feedback = provided.feedback ? cliOptions.feedback : resolveRelative(pathSection.feedback, configDir);
  const configPathDisplay = safeConfigPath(loaded.configPath, cwd);
  const options = {
    ...cliOptions,
    mode,
    profile,
    email,
    input: mode === "local" ? input : "",
    outputRoot: mode === "local" ? outputRoot : "",
    feedback: mode === "local" ? feedback : "",
    llmMode,
    requireLlm,
    configPath: loaded.configPath,
    configSource,
    configSummary: {
      schemaVersion: config?.schemaVersion || null,
      path: configPathDisplay,
      source: configSource,
      modeSource: cliOptions.mode ? (cliOptions.fixedMode ? "fixed_launcher" : "cli") : configSelection.source,
      selectedMode: mode,
      profile,
      sectionsChecked: ["common", mode],
      secretStatus,
    },
    configWarnings: warnings,
    recoveryConfigHash: canonicalQueryHash({
      schemaVersion: config?.schemaVersion || RUNNER_SCHEMA_VERSION,
      config: config || {},
      effective: { mode, profile, llmMode, requireLlm, emailRequested: Boolean(email) },
    }),
  };
  return { options, env: effectiveEnv, config, warnings };
}
