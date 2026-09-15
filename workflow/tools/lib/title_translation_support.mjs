import fs from "node:fs/promises";
import fsSync from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceConcurrencyController, parseServerDelayMs } from "./adaptive_concurrency.mjs";
import { registerEphemeral } from "./ephemeral_registry.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "../../..");
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, "config", "title_translation.config.json");
const DEFAULT_PROMPT_PATH = path.join(REPO_ROOT, "prompts", "title_translation.md");
export const DEFAULT_CACHE_PATH = path.resolve(process.env.ZOTERO_PROJECT_ROOT || process.cwd(), "review_results", "translation_cache.json");
const DEFAULT_PROMPT_TEMPLATE = [
  "你是一名专注于生物医药与环境健康方面的学术论文翻译者，请提供从英文到中文的熟练且准确的翻译。翻译时，确保准确性和严谨。请提供翻译结果，无需额外说明。",
  "",
  "${sourceText}",
].join("\n");

const DEFAULT_CONFIG = {
  enabled: true,
  model: "",
  temperature: 0.3,
  top_p: 0.85,
  stream: true,
  thinking: false,
  timeout_ms: 30000,
  max_retries: 2,
  batch_size: 10,
  concurrency_limit: 64,
  provider_concurrency_limit: 2500,
  user_id: "zotero-mcp-literature-workflow",
  fallback_to_english: true,
  rate_limit: {
    rpm: 100,
    tpm: 10_000_000,
  },
  prompt_file: "config/prompt-title-translation.md",
};

function toPosix(p) {
  return String(p || "").replace(/\\/g, "/");
}

function fileExists(p) {
  if (!p) return false;
  try {
    return fsSync.existsSync(p);
  } catch {
    return false;
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function coerceNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = n;
  if (rounded < min) return fallback;
  if (rounded > max) return max;
  return rounded;
}

function coerceInteger(value, fallback, { min = 1, max = Infinity } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const integer = Math.floor(n);
  if (integer < min) return fallback;
  if (integer > max) return max;
  return integer;
}

function coerceOptionalInteger(value, fallback, { min = 1, max = Infinity } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (["none", "null", "false", "off", "unlimited"].includes(raw)) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const integer = Math.floor(n);
  if (integer < min) return fallback;
  if (integer > max) return max;
  return integer;
}

function coerceBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function hashDiagnosticText(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function summarizeRequestTimings(entries = []) {
  const durations = entries.map((entry) => Number(entry.duration_ms)).filter((value) => Number.isFinite(value));
  return {
    total_requests: entries.length,
    success_count: entries.filter((entry) => entry.ok).length,
    failure_count: entries.filter((entry) => !entry.ok).length,
    avg_ms: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    max_ms: durations.length ? Math.max(...durations) : null,
    slowest_top5: [...entries]
      .sort((a, b) => Number(b.duration_ms || 0) - Number(a.duration_ms || 0))
      .slice(0, 5)
      .map((entry) => ({
        index: entry.index,
        title_hash: entry.title_hash,
        duration_ms: entry.duration_ms,
        ok: entry.ok,
        error_summary: entry.error_summary,
      })),
  };
}

function resolveConfigPath() {
  return process.env.TITLE_TRANSLATION_CONFIG_PATH
    ? path.resolve(process.env.TITLE_TRANSLATION_CONFIG_PATH)
    : DEFAULT_CONFIG_PATH;
}

function normalizeModelName(value) {
  const model = String(value ?? "").trim();
  if (!model) return "";
  if (/^(your-model-name|auto|default)$/i.test(model)) return "";
  return model;
}

function firstConfiguredModel(...values) {
  for (const value of values) {
    const model = normalizeModelName(value);
    if (model) return model;
  }
  return "";
}

function isPlaceholderValue(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.startsWith("your_") || normalized.startsWith("your-")) return true;
  if (normalized.includes("your-api-endpoint") || normalized.includes("your_api_endpoint")) return true;
  return [
    "changeme",
    "change_me",
    "change-me",
    "placeholder",
    "example",
    "test",
  ].includes(normalized);
}

function normalizeSecretValue(value) {
  const raw = String(value ?? "").trim();
  return isPlaceholderValue(raw) ? "" : raw;
}

function normalizeEndpointValue(value) {
  const raw = String(value ?? "").trim();
  return isPlaceholderValue(raw) ? "" : raw;
}

function resolvePromptPath(configPath, promptFile) {
  const raw = String(promptFile || "").trim();
  if (!raw) return DEFAULT_PROMPT_PATH;
  if (path.isAbsolute(raw)) return path.resolve(raw);

  const repoRelative = path.resolve(REPO_ROOT, raw);
  if (fileExists(repoRelative)) return repoRelative;

  const configRelative = path.resolve(path.dirname(configPath), raw);
  if (fileExists(configRelative)) return configRelative;

  return repoRelative;
}

function loadConfigFile(configPath) {
  const raw = readJsonFile(configPath);
  return raw && typeof raw === "object" ? raw : {};
}

function resolveTranslationConfig({ env = process.env } = {}) {
  const configPath = env.TITLE_TRANSLATION_CONFIG_PATH
    ? path.resolve(env.TITLE_TRANSLATION_CONFIG_PATH)
    : resolveConfigPath();
  const fileConfig = loadConfigFile(configPath);
  const rateLimit = fileConfig.rate_limit || {};
  const promptFile = env.TITLE_TRANSLATION_PROMPT_FILE
    || fileConfig.prompt_file
    || DEFAULT_CONFIG.prompt_file;
  const resolvedPromptPath = resolvePromptPath(configPath, promptFile);
  const promptTemplate = fileExists(resolvedPromptPath)
    ? fsSync.readFileSync(resolvedPromptPath, "utf8")
    : DEFAULT_PROMPT_TEMPLATE;

  return {
    enabled: coerceBoolean(env.TITLE_TRANSLATION_ENABLED ?? fileConfig.enabled, DEFAULT_CONFIG.enabled),
    apiKeyConfigured: Boolean(normalizeSecretValue(env.TITLE_TRANSLATION_API_KEY)),
    endpoint: normalizeEndpointValue(env.TITLE_TRANSLATION_ENDPOINT)
      || normalizeEndpointValue(fileConfig.endpoint)
      || "",
    model: firstConfiguredModel(env.TITLE_TRANSLATION_MODEL, fileConfig.model, DEFAULT_CONFIG.model),
    cachePath: DEFAULT_CACHE_PATH,
    batchSize: coerceInteger(
      env.TITLE_TRANSLATION_BATCH_SIZE ?? fileConfig.batch_size,
      DEFAULT_CONFIG.batch_size,
      { min: 1, max: 10_000 },
    ),
    concurrencyLimit: coerceInteger(
      env.TRANSLATION_API_CONCURRENCY_LIMIT
        ?? env.TITLE_TRANSLATION_CONCURRENCY_LIMIT
        ?? fileConfig.concurrency_limit,
      DEFAULT_CONFIG.concurrency_limit,
      { min: 1, max: 2500 },
    ),
    providerConcurrencyLimit: coerceInteger(
      env.TRANSLATION_API_PROVIDER_CONCURRENCY_LIMIT
        ?? fileConfig.provider_concurrency_limit,
      DEFAULT_CONFIG.provider_concurrency_limit,
      { min: 1, max: 2500 },
    ),
    user_id: String(env.TRANSLATION_API_USER_ID || env.TITLE_TRANSLATION_USER_ID || fileConfig.user_id || DEFAULT_CONFIG.user_id).trim(),
    temperature: coerceNumber(
      env.TITLE_TRANSLATION_TEMPERATURE ?? fileConfig.temperature,
      DEFAULT_CONFIG.temperature,
      { min: -Infinity, max: Infinity },
    ),
    top_p: coerceNumber(
      env.TITLE_TRANSLATION_TOP_P ?? fileConfig.top_p,
      DEFAULT_CONFIG.top_p,
      { min: 0, max: 1 },
    ),
    stream: coerceBoolean(
      env.TITLE_TRANSLATION_STREAM ?? fileConfig.stream,
      DEFAULT_CONFIG.stream,
    ),
    thinking: coerceBoolean(
      env.TITLE_TRANSLATION_THINKING ?? fileConfig.thinking,
      DEFAULT_CONFIG.thinking,
    ),
    timeout_ms: coerceInteger(
      env.TITLE_TRANSLATION_TIMEOUT_MS ?? fileConfig.timeout_ms,
      DEFAULT_CONFIG.timeout_ms,
      { min: 1000, max: 120_000 },
    ),
    max_retries: coerceInteger(
      env.TITLE_TRANSLATION_MAX_RETRIES ?? fileConfig.max_retries,
      DEFAULT_CONFIG.max_retries,
      { min: 0, max: 20 },
    ),
    fallback_to_english: coerceBoolean(
      env.TITLE_TRANSLATION_FALLBACK_TO_ENGLISH ?? fileConfig.fallback_to_english,
      DEFAULT_CONFIG.fallback_to_english,
    ),
    rateLimit: {
      rpm: coerceInteger(
        env.TRANSLATION_API_RPM_LIMIT ?? rateLimit.rpm,
        DEFAULT_CONFIG.rate_limit.rpm,
        { min: 1, max: 1_000_000 },
      ),
      tpm: coerceOptionalInteger(
        env.TRANSLATION_API_TPM_LIMIT ?? rateLimit.tpm,
        DEFAULT_CONFIG.rate_limit.tpm,
        { min: 1, max: 10_000_000 },
      ),
    },
    promptFile: resolvedPromptPath,
    promptTemplate,
    configPath,
    configFile: fileConfig,
  };
}

export function getTranslationApiLimits() {
  const runtime = resolveTranslationConfig({ env: process.env });
  return {
    api_rpm_limit: (runtime.rateLimit || runtime.rate_limit || {}).rpm ?? null,
    api_tpm_limit: (runtime.rateLimit || runtime.rate_limit || {}).tpm ?? null,
    api_concurrency_limit: runtime.concurrencyLimit ?? null,
    provider_concurrency_limit: runtime.providerConcurrencyLimit ?? null,
    rpm_window_seconds: 60,
    tpm_window_seconds: 60,
  };
}

export async function waitForRateWindow({
  requestLog,
  tokenLog,
  rpmLimit,
  tpmLimit,
  estimatedTokens,
  nowMs = Date.now(),
}) {
  const reqCutoff = nowMs - 60_000;
  const tokCutoff = nowMs - 60_000;
  while (requestLog.length && requestLog[0] < reqCutoff) requestLog.shift();
  while (tokenLog.length && tokenLog[0].ts < tokCutoff) tokenLog.shift();
  const reqCount = requestLog.length;
  const tokUsed = tokenLog.reduce((sum, item) => sum + item.tokens, 0);
  let waitMs = 0;
  if (Number.isFinite(Number(rpmLimit)) && reqCount >= rpmLimit && requestLog.length) {
    waitMs = Math.max(waitMs, (requestLog[0] + 60_000) - nowMs + 5);
  }
  if (Number.isFinite(Number(tpmLimit)) && tokUsed + estimatedTokens > tpmLimit && tokenLog.length) {
    waitMs = Math.max(waitMs, (tokenLog[0].ts + 60_000) - nowMs + 5);
  }
  return Math.max(0, waitMs);
}

export function getTranslationConfig({ env = process.env } = {}) {
  const runtime = resolveTranslationConfig({ env });
  return {
    enabled: runtime.enabled,
    apiKeyConfigured: runtime.apiKeyConfigured,
    endpoint: runtime.endpoint,
    model: runtime.model,
    cachePath: runtime.cachePath,
    batchSize: runtime.batchSize,
    concurrency_limit: runtime.concurrencyLimit,
    provider_concurrency_limit: runtime.providerConcurrencyLimit,
    user_id: runtime.user_id,
    temperature: runtime.temperature,
    top_p: runtime.top_p,
    stream: runtime.stream,
    thinking: runtime.thinking,
    timeout_ms: runtime.timeout_ms,
    max_retries: runtime.max_retries,
    fallback_to_english: runtime.fallback_to_english,
    rate_limit: { ...runtime.rateLimit },
    prompt_file: toPosix(runtime.promptFile),
  };
}

export function renderTranslationPrompt(template, sourceText, { langFrom = "", langTo = "" } = {}) {
  const base = String(template || DEFAULT_PROMPT_TEMPLATE);
  return base
    .replaceAll("${sourceText}", String(sourceText || ""))
    .replaceAll("${langFrom}", String(langFrom || ""))
    .replaceAll("${langTo}", String(langTo || ""));
}

export function normalizeTitleCacheKey(title) {
  return String(title || "")
    .normalize("NFKC")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function resolveCachedTranslation(cache, title) {
  const key = normalizeTitleCacheKey(title);
  if (!key) return "";
  const entry = cache?.get ? cache.get(key) : cache?.[key];
  return String(entry?.zh || "").trim();
}

export async function loadTranslationCache(cachePath = DEFAULT_CACHE_PATH) {
  try {
    const raw = JSON.parse(await fs.readFile(cachePath, "utf8"));
    const cache = new Map();
    for (const [title, result] of Object.entries(raw || {})) {
      const key = normalizeTitleCacheKey(title);
      if (result?.ok && String(result.zh || "").trim()) {
        cache.set(key, {
          ok: true,
          zh: String(result.zh || "").trim(),
          reason: String(result.reason || ""),
        });
      }
    }
    return cache;
  } catch (error) {
    return new Map();
  }
}

export async function saveTranslationCache(cachePath = DEFAULT_CACHE_PATH, cache) {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const lockPath = `${cachePath}.lock`;
  const deadline = Date.now() + 5000;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 30000) { await fs.unlink(lockPath); continue; }
      } catch (statError) { if (statError?.code === "ENOENT") continue; }
      if (Date.now() >= deadline) throw new Error(`TRANSLATION_CACHE_LOCK_TIMEOUT:${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const temporary = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryRegistration = registerEphemeral({ path: temporary, ownerStage: "title_translation_cache", cleanupWhen: "always_after_close" });
  const lockRegistration = registerEphemeral({ path: lockPath, ownerStage: "title_translation_cache", cleanupWhen: "always_after_close" });
  try {
    const merged = await loadTranslationCache(cachePath);
    for (const [key, result] of (cache || new Map()).entries()) {
      if (result?.ok && String(result.zh || "").trim()) merged.set(key, result);
    }
    const serializable = Object.fromEntries([...merged.entries()].map(([key, result]) => [key, {
      ok: true,
      zh: String(result.zh || "").trim(),
      reason: String(result.reason || ""),
    }]));
    await fs.writeFile(temporary, JSON.stringify(serializable, null, 2), { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, cachePath);
    temporaryRegistration.forget();
  } catch (error) {
    temporaryRegistration.markClosed();
    try { await fs.unlink(temporary); temporaryRegistration.forget(); } catch {}
    throw error;
  } finally {
    await handle.close();
    lockRegistration.markClosed();
    try { await fs.unlink(lockPath); lockRegistration.forget(); } catch {}
  }
}

function estimateTokensByChars(text) {
  const chars = String(text || "").length;
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateMaxOutputTokens(itemCount) {
  const n = Math.max(1, Number(itemCount || 1));
  return Math.min(7000, Math.max(256, n * 96));
}

function normalizeTranslationText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/^\s*```(?:json|text)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

function extractUsage(data) {
  const usage = data?.usage || {};
  const input = Number(usage?.prompt_tokens ?? usage?.input_tokens);
  const output = Number(usage?.completion_tokens ?? usage?.output_tokens);
  const total = Number(usage?.total_tokens);
  if (!Number.isFinite(input) && !Number.isFinite(output) && !Number.isFinite(total)) {
    return { available: false, input_tokens: null, output_tokens: null, total_tokens: null };
  }
  return {
    available: true,
    input_tokens: Number.isFinite(input) ? input : null,
    output_tokens: Number.isFinite(output) ? output : null,
    total_tokens: Number.isFinite(total) ? total : null,
  };
}

function parseJsonArrayResponse(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  try {
    const parsed = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : null;
  } catch {}
  const first = t.indexOf("[");
  const last = t.lastIndexOf("]");
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(t.slice(first, last + 1));
      return Array.isArray(parsed) ? parsed : null;
    } catch {}
  }
  return null;
}

export async function parseStreamingTranslationText(res) {
  const reader = res.body?.getReader();
  if (!reader) {
    const fallback = await res.text().catch(() => "");
    return normalizeTranslationText(fallback);
  }

  const decoder = new TextDecoder("utf-8");
  let out = "";
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        const delta = j?.choices?.[0]?.delta?.content;
        if (typeof delta === "string") out += delta;
      } catch {}
    }
  }
  return normalizeTranslationText(out);
}

function buildTranslationRequestBody(runtime, prompt, { maxOutputTokens, stream = runtime.stream } = {}) {
  const thinking = runtime.thinking && typeof runtime.thinking === "object"
    ? runtime.thinking
    : runtime.thinking
      ? { type: "enabled" }
      : { type: "disabled" };
  const body = {
    temperature: runtime.temperature,
    top_p: runtime.top_p,
    stream: Boolean(stream),
    thinking,
    messages: [
      { role: "user", content: prompt },
    ],
  };
  if (String(runtime.user_id || "").trim()) {
    body.user_id = String(runtime.user_id).trim();
  }
  if (String(runtime.model || "").trim()) {
    body.model = runtime.model;
  }
  if (!stream) {
    body.max_tokens = Number(maxOutputTokens) || estimateMaxOutputTokens(1);
  }
  return body;
}

async function fetchTranslation(runtime, prompt, { maxOutputTokens, stream = runtime.stream } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("translation_timeout")), runtime.timeout_ms);
  try {
    const res = await fetch(runtime.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${String(process.env.TITLE_TRANSLATION_API_KEY || "")}`,
      },
      body: JSON.stringify(buildTranslationRequestBody(runtime, prompt, { maxOutputTokens, stream })),
      signal: controller.signal,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const err = new Error(`HTTP_${res.status}${t ? `:${t.slice(0, 180)}` : ""}`);
      err.status = res.status;
      err.retryAfterMs = parseServerDelayMs(res.headers.get("Retry-After"));
      err.backoffMs = parseServerDelayMs(res.headers.get("Backoff"));
      throw err;
    }

    if (stream) {
      return {
        text: await parseStreamingTranslationText(res),
        usage: { available: false, input_tokens: null, output_tokens: null, total_tokens: null },
        response_excerpt: "",
      };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.delta?.content ?? data?.output_text ?? data?.text ?? "";
    const text = normalizeTranslationText(content);
    return {
      text,
      usage: extractUsage(data),
      response_excerpt: text.slice(0, 600),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function translateWithRuntime(title, {
  runtime = resolveTranslationConfig(),
  rateState = null,
  concurrencyController = null,
} = {}) {
  const q = String(title || "").trim();
  if (!q) return { ok: false, zh: q, reason: "empty" };
  if (!runtime.apiKeyConfigured) {
    return runtime.fallback_to_english
      ? { ok: false, zh: q, reason: "missing_api_key" }
      : { ok: false, zh: "", reason: "missing_api_key" };
  }

  const prompt = renderTranslationPrompt(runtime.promptTemplate, q);
  const rateLimit = runtime.rateLimit || runtime.rate_limit || { rpm: null, tpm: null };
  const requestLog = rateState?.requestLog || [];
  const tokenLog = rateState?.tokenLog || [];
  const maxRetries = Math.max(0, Number(runtime.max_retries || 0));

  let lastErr = "unknown";
  // Allow more retries for 429 rate limit errors
  const maxRetriesFor429 = Math.max(maxRetries, 5);
  for (let attempt = 0; attempt <= maxRetriesFor429; attempt += 1) {
    try {
      const estimatedTokens = estimateTokensByChars(prompt) + estimateMaxOutputTokens(1);
      const nowMs = Date.now();
      const reqCutoff = nowMs - 60_000;
      const tokCutoff = nowMs - 60_000;
      while (requestLog.length && requestLog[0] < reqCutoff) requestLog.shift();
      while (tokenLog.length && tokenLog[0].ts < tokCutoff) tokenLog.shift();
      const reqCount = requestLog.length;
      const tokUsed = tokenLog.reduce((sum, item) => sum + item.tokens, 0);
      let waitMs = 0;
      if (Number.isFinite(Number(rateLimit.rpm)) && reqCount >= rateLimit.rpm && requestLog.length) {
        waitMs = Math.max(waitMs, (requestLog[0] + 60_000) - nowMs + 5);
      }
      if (Number.isFinite(Number(rateLimit.tpm)) && tokUsed + estimatedTokens > rateLimit.tpm && tokenLog.length) {
        waitMs = Math.max(waitMs, (tokenLog[0].ts + 60_000) - nowMs + 5);
      }
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      const response = await fetchTranslation(runtime, prompt, { stream: runtime.stream });
      requestLog.push(Date.now());
      tokenLog.push({ ts: Date.now(), tokens: estimatedTokens });
      const zh = normalizeTranslationText(response.text);
      if (zh) return { ok: true, zh };
      lastErr = "empty_translation";
    } catch (error) {
      lastErr = String(error?.message || error || "unknown");
      concurrencyController?.recordFailure(error);
      const status = Number(error?.status || 0);
      const retryable = status === 429 || status >= 500 || /abort|timeout/i.test(lastErr);
      const effectiveMax = status === 429 ? maxRetriesFor429 : maxRetries;
      if (!retryable || attempt >= effectiveMax) break;
      // 429 rate limit needs longer backoff than server errors
      const baseDelay = status === 429 ? 3000 : 500;
      const backoff = baseDelay * (2 ** attempt);
      const jitter = Math.floor(Math.random() * 1000);
      const serverDelay = Math.max(Number(error?.retryAfterMs || 0), Number(error?.backoffMs || 0));
      await new Promise((resolve) => setTimeout(resolve, Math.max(serverDelay, backoff + jitter)));
    }
  }

  return runtime.fallback_to_english
    ? { ok: false, zh: q, reason: lastErr }
    : { ok: false, zh: "", reason: lastErr };
}

export async function callMimoTranslateStream(title, options = {}) {
  const runtime = options.runtime || resolveTranslationConfig();
  const result = await translateWithRuntime(title, { runtime, rateState: options.rateState || null });
  return result.ok ? result.zh : result.zh;
}

export async function callMimoTranslateBatch(batchItems, {
  runtime = resolveTranslationConfig(),
  rateState = null,
} = {}) {
  const items = Array.isArray(batchItems) ? batchItems : [];
  const results = [];
  const usage = {
    available: true,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cache_hits: 0,
    cache_misses: 0,
    api_items: 0,
    api_calls: 0,
    retries: 0,
    max_output_tokens: estimateMaxOutputTokens(items.length || 1),
    max_output_tokens_per_call: estimateMaxOutputTokens(1),
    batch_size: Math.max(1, Number(runtime.batchSize || items.length || 1)),
    model: runtime.model,
    temperature: runtime.temperature,
    top_p: runtime.top_p,
    stream: runtime.stream,
    rate_limit_wait_count: 0,
    rate_limit_wait_ms: 0,
    rate_limit_error_count: 0,
    api_rpm_limit: (runtime.rateLimit || runtime.rate_limit || {}).rpm ?? null,
    api_tpm_limit: (runtime.rateLimit || runtime.rate_limit || {}).tpm ?? null,
    api_concurrency_limit: runtime.concurrencyLimit ?? null,
    provider_concurrency_limit: runtime.providerConcurrencyLimit ?? null,
    rpm_window_seconds: 60,
    tpm_window_seconds: 60,
    estimated_tokens: 0,
    token_estimation_method: "chars_div_4_plus_max_output_tokens",
    warnings: [],
    abnormal_batches: [],
  };

  for (const item of items) {
    const translated = await translateWithRuntime(item?.en || "", { runtime, rateState });
    results.push({ id: String(item?.id ?? ""), zh: translated.ok ? translated.zh : translated.zh });
    if (translated.ok) {
      usage.api_items += 1;
      usage.api_calls += 1;
    } else if (!runtime.fallback_to_english && !String(translated.zh || "").trim()) {
      usage.warnings.push(String(translated.reason || "translation_failed"));
    }
  }

  return {
    ok: true,
    items: results,
    usage,
    response_excerpt: "",
    error: "",
  };
}

export async function translateOne(title, options = {}) {
  const runtime = options.runtime || resolveTranslationConfig();
  const result = await translateWithRuntime(title, {
    runtime,
    rateState: options.rateState || null,
    concurrencyController: options.concurrencyController || null,
  });
  if (result?.ok && String(result.zh || "").trim() && options.onTranslated) {
    try { await options.onTranslated(result.zh); } catch {}
  }
  return result;
}

export async function translateTitlesBatch(titles, concurrency = undefined, {
  cachePath = DEFAULT_CACHE_PATH,
  translateOneImpl = translateOne,
  batchSize = undefined,
  runtime = resolveTranslationConfig(),
  concurrencyController = null,
} = {}) {
  const cache = await loadTranslationCache(cachePath);
  const out = new Map();
  const uniqTitles = [...new Set(titles.map((x) => String(x || "").trim()).filter(Boolean))];
  const configuredConcurrency = Math.max(1, Number(concurrency || runtime.concurrencyLimit || 8));
  const providerConcurrency = Math.max(1, Number(runtime.providerConcurrencyLimit || configuredConcurrency));
  const effectiveConcurrency = Math.max(1, Math.min(configuredConcurrency, providerConcurrency));
  const usage = {
    total_items: uniqTitles.length,
    cache_hits: 0,
    cache_misses: 0,
    api_items: 0,
    api_calls: 0,
    retries: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    usage_available: true,
    batch_size: Math.max(1, Number(batchSize || runtime.batchSize || concurrency || 10)),
    concurrency_limit: effectiveConcurrency,
    requested_concurrency_limit: configuredConcurrency,
    provider_concurrency_limit: providerConcurrency,
    model: runtime.model,
    temperature: runtime.temperature,
    top_p: runtime.top_p,
    stream: runtime.stream,
    max_output_tokens: estimateMaxOutputTokens(1),
    max_output_tokens_per_call: estimateMaxOutputTokens(1),
    warnings: [],
    abnormal_batches: [],
    estimated_tokens: 0,
    token_estimation_method: "chars_div_4_plus_max_output_tokens",
    rate_limit_wait_count: 0,
    rate_limit_wait_ms: 0,
    rate_limit_error_count: 0,
    api_rpm_limit: (runtime.rateLimit || runtime.rate_limit || {}).rpm ?? null,
    api_tpm_limit: (runtime.rateLimit || runtime.rate_limit || {}).tpm ?? null,
    api_concurrency_limit: runtime.concurrencyLimit ?? null,
    effective_concurrency_limit: effectiveConcurrency,
    rate_limit: {
      rpm: (runtime.rateLimit || runtime.rate_limit || {}).rpm ?? null,
      tpm: (runtime.rateLimit || runtime.rate_limit || {}).tpm ?? null,
    },
    rpm_window_seconds: 60,
    tpm_window_seconds: 60,
  };
  const rateState = { requestLog: [], tokenLog: [] };
  const requestTimings = [];
  const controller = concurrencyController || createServiceConcurrencyController("llm", {
    minConcurrency: 1,
    initialConcurrency: effectiveConcurrency,
    maxConcurrency: effectiveConcurrency,
  });

  const missing = [];
  for (const title of uniqTitles) {
    const key = normalizeTitleCacheKey(title);
    if (cache.has(key)) {
      usage.cache_hits += 1;
      out.set(title, cache.get(key));
    } else {
      usage.cache_misses += 1;
      missing.push({ key, title });
    }
  }

  for (let i = 0; i < missing.length; i += usage.batch_size) {
    const batch = missing.slice(i, i + usage.batch_size);
    const translatedBatch = await controller.map(batch, async (ref, requestIndex) => {
      const requestStarted = Date.now();
      try {
        const translated = await translateOneImpl(ref.title, { runtime, rateState, cachePath, concurrencyController: controller });
        return {
          ref,
          translated,
          timing: {
            index: requestIndex + 1,
            title_hash: hashDiagnosticText(ref.title),
            duration_ms: Date.now() - requestStarted,
            ok: Boolean(translated?.ok),
            error_summary: translated?.ok ? "" : String(translated?.reason || "translation_failed").replace(/\s+/g, " ").trim().slice(0, 160),
          },
        };
      } catch (error) {
        error.translationTiming = {
          index: requestIndex + 1,
          title_hash: hashDiagnosticText(ref.title),
          duration_ms: Date.now() - requestStarted,
          ok: false,
          error_summary: String(error?.message || error).replace(/\s+/g, " ").trim().slice(0, 160),
        };
        throw error;
      }
    }, {
      classifyResult: ({ translated }) => translated?.ok
        ? { ok: true }
        : { ok: false, reason: translated?.reason || "translation_failed", status: translated?.status || 0 },
    });
    for (const { ref, translated, timing } of translatedBatch) {
      requestTimings.push(timing);
      out.set(ref.title, translated);
      if (translated?.ok && String(translated.zh || "").trim()) cache.set(ref.key, translated);
    }
  }

  usage.request_timing = summarizeRequestTimings(requestTimings);
  usage.adaptive_concurrency = controller.snapshot();
  await saveTranslationCache(cachePath, cache);
  return { map: out, usage };
}
