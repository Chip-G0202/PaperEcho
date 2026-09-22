/**
 * Ensure Zotero Backend Ready
 *
 * Zotero backend readiness 检查入口。
 *
 * 设计原则：
 * - 支持双模式：Web API（无桌面端）和 Desktop CLI（桌面端）
 * - 根据环境变量自动选择后端
 * - 提供详细的诊断信息
 * - 不依赖 MCP HTTP endpoint
 */

import { ZoteroWebApiBackend } from "./zotero_web_api_backend.mjs";
import { ZoteroCliBackend } from "./zotero_cli_backend.mjs";

const DEFAULT_RETRIES = 3;
const DEFAULT_INTERVAL_MS = 2000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultBackendProbe({ backend }) {
  if (backend?.backendType === "cli" && typeof backend?.ping === "function") {
    const ok = await backend.ping();
    if (!ok) throw new Error("CLI app ping did not report connector_available=true");
    return;
  }
  if (typeof backend?.getCollections === "function") {
    await backend.getCollections({ limit: 1 });
  }
}

/**
 * 确保 Zotero 后端可用
 *
 * @param {Object} options
 * @param {string} options.preferredBackend - "web_api" | "cli" | "auto"
 * @param {boolean} options.throwOnFailure
 * @param {number} options.retries
 * @param {number} options.intervalMs
 * @param {boolean} options.launchDesktop - CLI only: permit starting Zotero Desktop when false is not supplied
 * @param {Function} options.log
 * @returns {Promise<{ok: boolean, backend: string, diagnostics: Object}>}
 */
export async function ensureZoteroBackendReady(options = {}) {
  const {
    preferredBackend = process.env.ZOTERO_BACKEND || "auto",
    throwOnFailure = true,
    retries = DEFAULT_RETRIES,
    intervalMs = DEFAULT_INTERVAL_MS,
    postStartDelayMs,
    launchDesktop,
    backendProbe = defaultBackendProbe,
    log = console.log,
  } = options;

  const hasWebApiConfig = Boolean(process.env.ZOTERO_API_KEY && process.env.ZOTERO_USER_ID);

  let backendOrder;
  if (preferredBackend === "web_api" || preferredBackend === "webapi") {
    backendOrder = ["web_api"];
  } else if (preferredBackend === "desktop_cli" || preferredBackend === "cli") {
    backendOrder = ["cli"];
  } else {
    // auto: 有 API key 就优先用无桌面 Web API
    backendOrder = hasWebApiConfig ? ["web_api", "cli"] : ["cli"];
  }

  const results = [];

  for (const backendType of backendOrder) {
    log(`[BackendReady] Probing ${backendType} backend...`);

    let backend;
    if (backendType === "web_api") {
      backend = new ZoteroWebApiBackend();
    } else {
      backend = new ZoteroCliBackend({
        desktopPostStartDelayMs: postStartDelayMs,
        ...(typeof launchDesktop === "boolean" ? { launchDesktop } : {}),
      });
    }

    const result = await backend.ensureReady({ retries, intervalMs, log });
    results.push({ backend: backendType, ...result });

    if (result.ok && typeof backendProbe === "function") {
      try {
        await backendProbe({
          backend,
          backendType,
          attempt: Number(result.diagnostics?.attempts || 1),
          result,
        });
      } catch (error) {
        const probed = {
          ok: false,
          started_now: Boolean(result.started_now),
          was_running: Boolean(result.was_running),
          diagnostics: {
            ...(result.diagnostics || {}),
            backend: backendType,
            error: `Backend probe failed: ${error?.message || String(error)}`,
            probe_failed: true,
          },
        };
        results[results.length - 1] = { backend: backendType, ...probed };
        log(`[BackendReady] ❌ ${backendType} backend probe failed: ${error?.message || String(error)}`);
        continue;
      }
    }

    if (result.ok) {
      log(`[BackendReady] ✅ ${backendType} backend ready`);
      return {
        ok: true,
        backend: backendType,
        diagnostics: result.diagnostics,
        allResults: results,
      };
    }

    log(`[BackendReady] ❌ ${backendType} backend failed: ${result.diagnostics?.error || "unknown"}`);
  }

  const errorMessage = `All Zotero backends failed. Tried: ${backendOrder.join(", ")}`;

  if (throwOnFailure) {
    const error = new Error(errorMessage);
    error.code = "ZOTERO_BACKEND_NOT_READY";
    error.details = { results };
    throw error;
  }

  return {
    ok: false,
    backend: null,
    error: errorMessage,
    results,
  };
}

/**
 * 获取推荐的后端类型
 */
export function getRecommendedBackend() {
  const hasWebApiConfig = Boolean(process.env.ZOTERO_API_KEY && process.env.ZOTERO_USER_ID);

  if (hasWebApiConfig) {
    return {
      backend: "web_api",
      reason: "ZOTERO_API_KEY and ZOTERO_USER_ID configured",
      desktopRequired: false,
    };
  }

  return {
    backend: "cli",
    reason: "No ZOTERO_API_KEY, falling back to desktop CLI (requires Zotero desktop)",
    desktopRequired: true,
  };
}

export default {
  ensureZoteroBackendReady,
  getRecommendedBackend,
};
