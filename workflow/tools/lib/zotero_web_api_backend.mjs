/**
 * Zotero Web API Backend
 *
 * 使用 Zotero REST API (api.zotero.org) 的后端实现。
 *
 * 特点：
 * - 无需 Zotero 桌面端运行
 * - 需要 Zotero 账号 + API Key
 * - 直接通过 HTTP 与 Zotero 云服务交互
 * - 支持所有读写操作
 * - Collection 写入包含 verify 机制
 */

import { ZoteroBackendBase, createVerifyResult, createWriteResult } from "./zotero_backend_base.mjs";
import { wait } from './async_utils.mjs';
import { createServiceConcurrencyController, parseServerDelayMs } from "./adaptive_concurrency.mjs";
import { randomUUID } from "node:crypto";

export const ZOTERO_WEB_API_BASE = "https://api.zotero.org";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 3;
const DEFAULT_INTERVAL_MS = 2000;
const MAX_BATCH_SIZE = 50; // Zotero Web API v3 limit: max 50 items per create/update/delete
export const DEFAULT_REQUEST_CONCURRENCY = 4;
export const MAX_REQUEST_CONCURRENCY = 4;

export function resolveWebApiRequestConcurrency(value, fallback = DEFAULT_REQUEST_CONCURRENCY) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_REQUEST_CONCURRENCY, Math.max(1, Math.trunc(parsed)));
}

export async function mapWithConcurrency(items, concurrency, mapper, { controller = null, observe = true, classifyResult = null } = {}) {
  const source = Array.isArray(items) ? items : [];
  if (!source.length) return [];
  if (controller) return controller.map(source, mapper, { observe, classifyResult });
  const results = new Array(source.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(resolveWebApiRequestConcurrency(concurrency), source.length) }, async () => {
    while (cursor < source.length) {
      const index = cursor++;
      results[index] = await mapper(source[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 标准化 API 响应中的集合数据
 */
function normalizeCollection(c) {
  return {
    key: c.key,
    name: c.data?.name || c.name || "",
    parentCollection: c.data?.parentCollection || c.parentCollection || false,
    version: c.version || 0,
    meta: c.meta || {},
    data: c.data || c,
  };
}

/**
 * 标准化 API 响应中的项目数据
 */
function normalizeItem(item) {
  return {
    key: item.key,
    version: item.version || 0,
    data: item.data || item,
    meta: item.meta || {},
  };
}

function firstSuccessfulKey(successful) {
  if (!successful) return "";
  if (Array.isArray(successful)) return successful[0]?.key || "";
  if (typeof successful === "object") {
    const first = Object.values(successful)[0];
    return first?.key || "";
  }
  return "";
}

function firstFailureMessage(failed, fallback) {
  const first = failed && typeof failed === "object" ? Object.values(failed)[0] : null;
  return first?.message || fallback;
}

function writeToken() {
  return randomUUID().replaceAll("-", "");
}

function isPreconditionError(error) {
  return error?.status === 412 || error?.status === 428;
}

function safeResponseText(text, apiKey) {
  const value = String(text || "");
  return (apiKey ? value.replaceAll(apiKey, "[REDACTED]") : value).slice(0, 2000);
}

export class ZoteroWebApiBackend extends ZoteroBackendBase {
  constructor(config = {}) {
    super();
    this.userId = config.userId || process.env.ZOTERO_USER_ID || "";
    this.apiKey = config.apiKey || process.env.ZOTERO_API_KEY || "";
    this.apiBase = config.apiBase || process.env.ZOTERO_API_BASE || ZOTERO_WEB_API_BASE;
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.retries = config.retries || DEFAULT_RETRIES;
    this.intervalMs = config.intervalMs || DEFAULT_INTERVAL_MS;
    this.requestConcurrency = resolveWebApiRequestConcurrency(config.requestConcurrency ?? process.env.ZOTERO_WEB_API_REQUEST_CONCURRENCY);
    this.concurrencyController = config.concurrencyController || createServiceConcurrencyController("zotero_web_api", {
      minConcurrency: 1,
      initialConcurrency: this.requestConcurrency,
      maxConcurrency: this.requestConcurrency,
    });
    this._backoffUntil = 0;
    this.libraryVersion = 0;
    this._stats = { retryAfterCount: 0, backoffCount: 0, rateLimitCount: 0 };
  }

  get backendType() {
    return "web_api";
  }

  /**
   * 发送 API 请求
   */
  async _request(method, path, body = null, options = {}) {
    const requestStartedAt = Date.now();
    // Respect Backoff header: wait if needed
    const now = Date.now();
    if (this._backoffUntil > now) {
      const waitMs = this._backoffUntil - now;
      await new Promise((r) => setTimeout(r, waitMs));
    }

    if (!this.userId) throw new Error("Missing ZOTERO_USER_ID");
    const url = `${this.apiBase}/users/${this.userId}${path}`;
    const headers = {
      "Zotero-API-Key": this.apiKey,
      "Zotero-API-Version": "3",
      "Content-Type": "application/json",
    };

    // 版本冲突保护：写操作携带 If-Unmodified-Since-Version 头
    if (options.ifUnmodifiedSinceVersion != null && options.ifUnmodifiedSinceVersion > 0) {
      headers["If-Unmodified-Since-Version"] = String(options.ifUnmodifiedSinceVersion);
    }
    if (options.writeToken) headers["Zotero-Write-Token"] = String(options.writeToken);

    const fetchOptions = {
      method,
      headers,
      signal: AbortSignal.timeout(options.timeoutMs || this.timeoutMs),
    };

    if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
      fetchOptions.body = JSON.stringify(body);
    }

    const maxAttempts = Math.max(1, Number(options.retries ?? this.retries) || 1);
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(url, fetchOptions);

        // 处理限流
        // Process Backoff header (proactive throttling)
        const backoffHeader = response.headers.get("Backoff");
        if (backoffHeader) {
          const backoffMs = parseServerDelayMs(backoffHeader);
          if (backoffMs > 0) {
            this._backoffUntil = Date.now() + backoffMs;
            this._stats.backoffCount++;
            this.concurrencyController.recordServerDirective({ backoffMs });
          }
        }

        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          const retryAfter = retryAfterHeader == null ? 10000 : parseServerDelayMs(retryAfterHeader);
          this._backoffUntil = Math.max(this._backoffUntil, Date.now() + retryAfter);
          this._stats.retryAfterCount++;
          this._stats.rateLimitCount++;
          const rateLimitError = Object.assign(new Error("Zotero Web API rate limit"), {
            status: 429,
            retryAfterMs: retryAfter,
            adaptiveRecorded: true,
          });
          this.concurrencyController.recordFailure(rateLimitError);
          if (attempt < maxAttempts) {
            await wait(retryAfter);
            continue;
          }
          rateLimitError.message = `Rate limited after ${attempt} attempts`;
          throw rateLimitError;
        }

        if (!response.ok) {
          const text = safeResponseText(await response.text().catch(() => ""), this.apiKey);
          const error = new Error(`Zotero API ${method} ${path} failed: HTTP ${response.status} - ${text}`);
          error.status = response.status;
          throw error;
        }

        // 处理不同响应类型
        const contentType = response.headers.get("Content-Type") || "";
        if (contentType.includes("application/json")) {
          const data = await response.json();
          this.concurrencyController.recordSuccess(Date.now() - requestStartedAt);
          return {
            ok: true,
            data,
            totalResults: Number(response.headers.get("Total-Results") || 0),
            lastModifiedVersion: Number(response.headers.get("Last-Modified-Version") || 0),
          };
        }

        this.concurrencyController.recordSuccess(Date.now() - requestStartedAt);
        return {
          ok: true,
          data: null,
          text: await response.text(),
          lastModifiedVersion: Number(response.headers.get("Last-Modified-Version") || 0),
        };
      } catch (error) {
        lastError = error;
        if (!error?.adaptiveRecorded) this.concurrencyController.recordFailure(error);
        if (isPreconditionError(error)) throw error;
        if (attempt < maxAttempts) {
          await wait(this.intervalMs);
        }
      }
    }

    throw lastError || new Error(`Request failed after ${maxAttempts} attempts`);
  }

  /** Backward-compatible identity lookup; formal Runner configuration requires an explicit User ID. */
  async resolveUserId(options = {}) {
    if (this.userId) {
      return this.userId;
    }
    if (!this.apiKey) {
      throw new Error("Missing ZOTERO_API_KEY");
    }

    const response = await fetch(`${this.apiBase}/keys/current`, {
      method: "GET",
      headers: {
        "Zotero-API-Key": this.apiKey,
        "Zotero-API-Version": "3",
      },
      signal: AbortSignal.timeout(options.timeoutMs || this.timeoutMs),
    });
    if (!response.ok) {
      const text = safeResponseText(await response.text().catch(() => ""), this.apiKey);
      throw new Error(`Zotero API key lookup failed: HTTP ${response.status} - ${text}`);
    }
    const data = await response.json();
    const userId = data?.userID || data?.userId || data?.user?.id || "";
    if (!userId) {
      throw new Error("Zotero API key lookup did not return userID");
    }
    this.userId = String(userId);
    return this.userId;
  }

  // ─── 连接管理 ───

  async ping() {
    try {
      const result = await this._request("GET", "/items?limit=1", null, { retries: 1, timeoutMs: 10000 });
      return result.ok;
    } catch {
      return false;
    }
  }

  /**
   * 获取项目的当前 version（用于乐观锁）
   */
  async _getItemVersion(itemKey) {
    const result = await this._request("GET", `/items/${itemKey}`, null, { retries: 1 });
    return result.data?.version || 0;
  }

  async _getLibraryVersion() {
    const result = await this._request("GET", "/items?limit=1", null, { retries: 1 });
    const version = Number(result.lastModifiedVersion || 0);
    if (version <= 0) throw new Error("zotero_library_version_missing");
    this.libraryVersion = version;
    return version;
  }

  _requireVersion(version, context) {
    const parsed = Number(version || 0);
    if (parsed <= 0) throw new Error(`${context}_version_missing`);
    return parsed;
  }

  _requestConcurrency(options = {}) {
    return resolveWebApiRequestConcurrency(options.requestConcurrency, this.requestConcurrency);
  }

  getConcurrencySnapshot() {
    return this.concurrencyController.snapshot();
  }

  async ensureReady(options = {}) {
    const { retries = this.retries, intervalMs = this.intervalMs, log = console.log } = options;

    if (!this.apiKey) {
      return {
        ok: false,
        diagnostics: {
          backend: "web_api",
          error: "Missing ZOTERO_API_KEY",
          userId: this.userId ? "configured" : "missing",
          apiKey: this.apiKey ? "configured" : "missing",
        },
      };
    }

    if (!this.userId) {
      return {
        ok: false,
        diagnostics: {
          backend: "web_api",
          error: "Missing ZOTERO_USER_ID",
          userId: "missing",
          apiKey: "configured",
        },
      };
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      log(`[WebAPI] Probing attempt ${attempt}/${retries}...`);
      const ok = await this.ping();
      if (ok) {
        return {
          ok: true,
          started_now: false,
          was_running: true,
          diagnostics: { backend: "web_api", attempts: attempt, userId: "configured" },
        };
      }
      if (attempt < retries) await wait(intervalMs);
    }

    return {
      ok: false,
      diagnostics: { backend: "web_api", error: `Failed after ${retries} attempts`, attempts: retries },
    };
  }

  // ─── 集合读取 ───

  async getCollections(options = {}) {
    const { limit = 100 } = options;
    const pageSize = Math.min(100, limit);
    const result = await this._request("GET", `/collections/top?limit=${pageSize}`);
    const items = (result.data || []).map(normalizeCollection);
    if (items.length < pageSize || items.length >= limit) {
      return items.slice(0, limit);
    }
    const total = result.totalResults || items.length;
    const target = Math.min(total, limit);
    if (items.length >= target) return items;
    const seen = new Set(items.map(c => c.key));
    const all = [...items];
    let currentOffset = items.length;
    while (all.length < target) {
      const nextPageSize = Math.min(100, target - all.length);
      const nextResult = await this._request("GET", `/collections/top?limit=${nextPageSize}&offset=${currentOffset}`);
      const page = (nextResult.data || []).map(normalizeCollection);
      if (page.length === 0) break;
      for (const c of page) {
        if (c.key && !seen.has(c.key)) { seen.add(c.key); all.push(c); }
      }
      currentOffset += page.length;
      if (page.length < nextPageSize) break;
    }
    return all;
  }

  async getAllCollections() {
    // Fetch all collections (not just top-level) in paginated calls
    const pageSize = 100;
    const result = await this._request("GET", `/collections?limit=${pageSize}`);
    const items = (result.data || []).map(normalizeCollection);
    const total = result.totalResults || items.length;
    if (items.length >= total) return items;
    const all = [...items];
    let offset = items.length;
    while (all.length < total) {
      const next = await this._request("GET", `/collections?limit=${pageSize}&offset=${offset}`);
      const page = (next.data || []).map(normalizeCollection);
      if (page.length === 0) break;
      all.push(...page);
      offset += page.length;
      if (page.length < pageSize) break;
    }
    return all;
  }

  async getSubcollections(collectionKey, recursive = false) {
    const result = await this._request("GET", `/collections/${collectionKey}/collections`);
    const children = (result.data || []).map(normalizeCollection);

    if (recursive) {
      for (const child of children) {
        child.subcollections = await this.getSubcollections(child.key, true);
      }
    }

    return children;
  }

  async getCollectionItems(collectionKey, options = {}) {
    const { limit = 100, offset = 0 } = options;
    const result = await this._request("GET", `/collections/${collectionKey}/items?limit=${limit}&offset=${offset}`);
    return (result.data || []).map(normalizeItem);
  }

  // ─── 集合写入（带 verify） ───

  async ensureCollectionPath(pathArray, options = {}) {
    const created = [];
    const existing = [];
    let currentKey = null;
    let currentPath = "";

    for (const name of pathArray) {
      currentPath = currentPath ? `${currentPath}/${name}` : name;

      // 查找是否已存在
      let found = null;
      if (currentKey) {
        const children = await this.getSubcollections(currentKey);
        found = children.find((c) => c.name === name);
      } else {
        const all = await this.getCollections({ limit: 100 });
        found = all.find((c) => c.name === name && !c.parentCollection);
      }

      if (found) {
        existing.push(found.key);
        currentKey = found.key;
      } else {
        const newCol = await this.createCollection(name, currentKey);
        created.push(newCol.key);
        currentKey = newCol.key;
      }
    }

    return { created, existing, rootKey: currentKey };
  }

  async ensureWritebackCollections(options = {}) {
    if (options.rootKey && options.monthName && options.dayName) {
      const created = [];
      const existing = [];
      const ensureChild = async (parentKey, name, role) => {
        const children = await this.getSubcollections(parentKey);
        const found = children.find((collection) => collection.name === name);
        if (found) {
          const record = { key: found.key, name, role, parentCollection: parentKey, created: false };
          existing.push(record);
          return record;
        }
        const newCollection = await this.createCollection(name, parentKey);
        const record = { key: newCollection.key, name, role, parentCollection: parentKey, created: true };
        created.push(record);
        return record;
      };
      const month = await ensureChild(options.rootKey, options.monthName, "month");
      const date = await ensureChild(month.key, options.dayName, "day");
      const sources = {};
      for (const name of options.sourceNames || []) sources[name] = await ensureChild(date.key, name, "source");
      const grades = {};
      for (const name of options.gradeNames || []) grades[name] = await ensureChild(date.key, name, "grade");
      return { month, date, sources, grades, created, existing };
    }

    const { dateLabel, sourceName, gradeName } = options;
    const rootCollection = options.rootCollection || options.rootCollectionName || "文献池";

    // Ensure the date collection exists
    const datePath = [rootCollection, dateLabel];
    const dateCollection = await this.ensureCollectionPath(datePath);

    // Ensure source collection (RSS/DB)
    const sourcePath = [rootCollection, dateLabel, sourceName];
    const sourceCollection = await this.ensureCollectionPath(sourcePath);

    // Ensure grade collection (A/B/C)
    const gradePath = [rootCollection, dateLabel, gradeName];
    const gradeCollection = await this.ensureCollectionPath(gradePath);

    return {
      dateCollection: dateCollection?.rootKey || "",
      sourceCollection: sourceCollection?.rootKey || "",
      gradeCollection: gradeCollection?.rootKey || "",
    };
  }

  async createCollection(name, parentKey = null) {
    const body = { name };
    if (parentKey) body.parentCollection = parentKey;

    const result = await this._request("POST", "/collections", [body], {
      retries: 1,
      writeToken: writeToken(),
    });

    const key = firstSuccessfulKey(result.data?.successful) || result.data?.key || "";
    if (!key) throw new Error(firstFailureMessage(result.data?.failed, "create_collection_failed"));

    return { key, name, parentCollection: parentKey || false };
  }

  async deleteCollection(collectionKey, options = {}) {
    // Get collection version first (Zotero API requires If-Unmodified-Since-Version for DELETE)
    const collectionResult = await this._request("GET", `/collections/${collectionKey}`);
    const collection = Array.isArray(collectionResult.data) ? collectionResult.data[0] : collectionResult.data;
    const version = collection?.version || 0;
    this._requireVersion(version, "delete_collection");
    await this._request("DELETE", `/collections/${collectionKey}`, null, {
      retries: 1,
      ifUnmodifiedSinceVersion: version
    });
  }

  async deleteItems(itemKeys = [], options = {}) {
    const keys = [...new Set((Array.isArray(itemKeys) ? itemKeys : []).map((key) => String(key || "").trim()).filter(Boolean))];
    const result = { deleted: [], failed: [] };
    if (!keys.length) return result;

    let libraryVersion = Number(options.libraryVersion || this.libraryVersion || 0);
    if (libraryVersion <= 0) libraryVersion = await this._getLibraryVersion();
    for (let offset = 0; offset < keys.length; offset += MAX_BATCH_SIZE) {
      const chunk = keys.slice(offset, offset + MAX_BATCH_SIZE);
      try {
        const response = await this._request("DELETE", `/items?itemKey=${chunk.map(encodeURIComponent).join(",")}`, null, {
          retries: 1,
          ifUnmodifiedSinceVersion: libraryVersion,
        });
        libraryVersion = this._requireVersion(response.lastModifiedVersion, "delete_items_response");
        this.libraryVersion = libraryVersion;
        result.deleted.push(...chunk);
      } catch (error) {
        result.failed.push(...chunk.map((key) => ({ key, error: error?.message || String(error) })));
        if (isPreconditionError(error)) {
          const remaining = keys.slice(offset + chunk.length);
          result.failed.push(...remaining.map((key) => ({ key, error: error?.message || String(error) })));
          break;
        }
      }
    }

    result.libraryVersion = this.libraryVersion;
    return result;
  }

  async addItemsToCollection(itemKeys, collectionKey, options = {}) {
    const { verify = true, skipOnVerifyFailure = true } = options;
    const result = createWriteResult();
    result.unchanged = [];

    // Batch read item versions and current collections with bounded concurrency.
    const itemData = new Map();
    const itemReads = await mapWithConcurrency(itemKeys, this._requestConcurrency(options), async (itemKey) => {
        try {
          const itemResult = await this._request("GET", `/items/${itemKey}`);
          const item = itemResult.data;
          return { itemKey, currentCollections: item?.data?.collections || [], version: this._requireVersion(item?.version, "add_to_collection") };
        } catch (e) {
          return { itemKey, error: "fetch_failed: " + e.message };
        }
    }, { controller: this.concurrencyController, observe: false });
    for (const read of itemReads) {
      if (read.error) result.failed.push({ itemKey: read.itemKey, error: read.error });
      else itemData.set(read.itemKey, { currentCollections: read.currentCollections, version: read.version });
    }

    // Prepare batch payload for items that need updating
    const batchPayload = [];
    const batchKeys = [];
    for (const itemKey of itemKeys) {
      const data = itemData.get(itemKey);
      if (!data) continue; // Already in failed
      if (data.currentCollections.includes(collectionKey)) {
        result.added.push(itemKey); // Already in collection
        continue;
      }
      const newCollections = [...data.currentCollections, collectionKey];
      batchPayload.push({ key: itemKey, version: data.version, collections: newCollections });
      batchKeys.push(itemKey);
    }

    // Send batch PATCH in chunks of MAX_BATCH_SIZE (with inter-chunk delay)
    for (let offset = 0; offset < batchPayload.length; offset += MAX_BATCH_SIZE) {
      // No unconditional delay - let _request handle rate limits via Backoff/429
      const chunk = batchPayload.slice(offset, offset + MAX_BATCH_SIZE);
      const chunkKeys = batchKeys.slice(offset, offset + MAX_BATCH_SIZE);
      try {
        const patchResult = await this._request("PATCH", "/items", chunk);
        const responseData = patchResult.data;
        const successful = responseData?.successful || {};
        const responseUnchanged = responseData?.unchanged || {};
        const batchFailed = responseData?.failed || {};

        for (let i = 0; i < chunkKeys.length; i++) {
          const key = chunkKeys[i];
          const successEntry = successful[String(i)];
          const unchangedEntry = responseUnchanged[String(i)];
          const failedEntry = batchFailed[String(i)];

          if (successEntry) {
            result.added.push(key);
          } else if (unchangedEntry) {
            result.unchanged.push(key);
          } else if (failedEntry) {
            result.failed.push({ itemKey: key, error: failedEntry.message || "batch_add_failed" });
          } else {
            result.failed.push({ itemKey: key, error: "batch_add_result_missing" });
          }
        }
      } catch (e) {
        if (isPreconditionError(e)) {
          result.failed.push(...chunkKeys.map((itemKey) => ({ itemKey, error: e.message })));
          continue;
        }
        // Fallback to individual updates
        for (const key of chunkKeys) {
          try {
            const data = itemData.get(key);
            const newCollections = [...data.currentCollections, collectionKey];
            await this._request("PATCH", `/items/${key}`, {
              collections: newCollections,
            }, {
              retries: 1,
              ifUnmodifiedSinceVersion: data.version,
            });
            result.added.push(key);
          } catch (e2) {
            result.failed.push({ itemKey: key, error: e2.message });
            if (!skipOnVerifyFailure) throw e2;
          }
        }
      }
    }

    // Verify
    const verifyKeys = [...result.added, ...result.unchanged];
    if (verify && verifyKeys.length > 0) {
      const verifyResult = await this.verifyItemsInCollection(verifyKeys, collectionKey);
      result.verified = verifyResult.present;
      for (const missing of verifyResult.missing) {
        if (!result.failed.some((f) => f.itemKey === missing)) {
          result.failed.push({ itemKey: missing, error: "Verification failed: item not in collection" });
        }
      }
    }

    return result;
  }

  async addItemsToCollections(operations, options = {}) {
    const { verify = true, skipOnVerifyFailure = true } = options;
    const result = { added: [], already: [], failed: [], verified: [] };
    const keysByCollection = new Map();

    for (const operation of Array.isArray(operations) ? operations : []) {
      const collectionKey = String(operation?.collectionKey || "").trim();
      const itemKeys = Array.isArray(operation?.itemKeys) ? operation.itemKeys : [operation?.itemKeys];
      if (!collectionKey) continue;
      const existing = keysByCollection.get(collectionKey) || [];
      const seen = new Set(existing);
      for (const rawKey of itemKeys) {
        const itemKey = String(rawKey || "").trim();
        if (itemKey && !seen.has(itemKey)) {
          existing.push(itemKey);
          seen.add(itemKey);
        }
      }
      if (existing.length) keysByCollection.set(collectionKey, existing);
    }
    if (!keysByCollection.size) return result;

    const desiredByItem = new Map();
    for (const [collectionKey, itemKeys] of keysByCollection) {
      for (const itemKey of itemKeys) {
        const desired = desiredByItem.get(itemKey) || [];
        desired.push(collectionKey);
        desiredByItem.set(itemKey, desired);
      }
    }

    // Read every shared item once, then write its complete collection union once.
    const itemKeys = [...desiredByItem.keys()];
    const itemData = new Map();
    const itemReads = await mapWithConcurrency(itemKeys, this._requestConcurrency(options), async (itemKey) => {
      try {
        const itemResult = await this._request("GET", `/items/${itemKey}`);
        const item = itemResult.data;
        return {
          itemKey,
          currentCollections: Array.isArray(item?.data?.collections) ? item.data.collections : [],
          version: this._requireVersion(item?.version, "add_to_collections"),
        };
      } catch (error) {
        return { itemKey, error: `fetch_failed: ${error?.message || String(error)}` };
      }
    }, { controller: this.concurrencyController, observe: false });

    for (const read of itemReads) {
      if (read.error) {
        for (const collectionKey of desiredByItem.get(read.itemKey) || []) {
          result.failed.push({ itemKey: read.itemKey, collectionKey, error: read.error });
        }
      } else {
        itemData.set(read.itemKey, read);
      }
    }

    const payload = [];
    const pendingByItem = new Map();
    for (const itemKey of itemKeys) {
      const data = itemData.get(itemKey);
      if (!data) continue;
      const current = new Set(data.currentCollections);
      const pending = [];
      for (const collectionKey of desiredByItem.get(itemKey) || []) {
        const association = { itemKey, collectionKey };
        if (current.has(collectionKey)) result.already.push(association);
        else {
          current.add(collectionKey);
          pending.push(association);
        }
      }
      if (pending.length) {
        pendingByItem.set(itemKey, pending);
        payload.push({ key: itemKey, version: data.version, collections: [...current] });
      }
    }

    for (let offset = 0; offset < payload.length; offset += MAX_BATCH_SIZE) {
      const chunk = payload.slice(offset, offset + MAX_BATCH_SIZE);
      try {
        const patchResult = await this._request("PATCH", "/items", chunk);
        const successful = patchResult.data?.successful || {};
        const unchanged = patchResult.data?.unchanged || {};
        const failed = patchResult.data?.failed || {};
        for (let index = 0; index < chunk.length; index += 1) {
          const itemKey = chunk[index].key;
          const associations = pendingByItem.get(itemKey) || [];
          if (successful[String(index)]) result.added.push(...associations);
          else if (unchanged[String(index)]) result.already.push(...associations);
          else {
            const error = failed[String(index)]?.message || "batch_add_result_missing";
            result.failed.push(...associations.map((association) => ({ ...association, error })));
          }
        }
      } catch (error) {
        if (isPreconditionError(error)) {
          for (const entry of chunk) {
            result.failed.push(...(pendingByItem.get(entry.key) || []).map((association) => ({
              ...association,
              error: error?.message || String(error),
            })));
          }
          continue;
        }

        // A transport/batch failure degrades to one version-guarded write per item,
        // still applying the complete collection union rather than one write per collection.
        for (const entry of chunk) {
          try {
            await this._request("PATCH", `/items/${entry.key}`, {
              collections: entry.collections,
            }, {
              retries: 1,
              ifUnmodifiedSinceVersion: entry.version,
            });
            result.added.push(...(pendingByItem.get(entry.key) || []));
          } catch (fallbackError) {
            result.failed.push(...(pendingByItem.get(entry.key) || []).map((association) => ({
              ...association,
              error: fallbackError?.message || String(fallbackError),
            })));
          }
        }
      }
    }

    if (verify) {
      for (const [collectionKey, collectionItemKeys] of keysByCollection) {
        const failedKeys = new Set(result.failed
          .filter((failure) => failure.collectionKey === collectionKey)
          .map((failure) => failure.itemKey));
        const verifyKeys = collectionItemKeys.filter((itemKey) => !failedKeys.has(itemKey));
        if (!verifyKeys.length) continue;
        const verifyResult = await this.verifyItemsInCollection(verifyKeys, collectionKey);
        result.verified.push(...verifyResult.present.map((itemKey) => ({ itemKey, collectionKey })));
        for (const itemKey of verifyResult.missing) {
          result.failed.push({ itemKey, collectionKey, error: "Verification failed: item not in collection" });
        }
      }
    }

    if (result.failed.length && !skipOnVerifyFailure) {
      const failure = result.failed[0];
      throw new Error(`add_items_to_collections_failed:${failure.error || failure.itemKey || failure.collectionKey}`);
    }
    return result;
  }

  async removeItemsFromCollection(itemKeys, collectionKey, options = {}) {
    const { verify = true, skipOnVerifyFailure = true } = options;
    const result = createWriteResult();

    for (const itemKey of itemKeys) {
      try {
        // 获取项目当前版本
        const itemResult = await this._request("GET", `/items/${itemKey}`);
        const item = itemResult.data;

        // 从项目的 collections 列表中移除
        const currentCollections = item?.data?.collections || [];
        const newCollections = currentCollections.filter((c) => c !== collectionKey);
        const itemVersion = item?.version || 0;
        await this._request("PATCH", `/items/${itemKey}`, {
          collections: newCollections,
        }, {
          retries: 1,
          ifUnmodifiedSinceVersion: itemVersion,
        });

        result.removed.push(itemKey);
      } catch (error) {
        result.failed.push({ itemKey, error: error.message });
        if (!skipOnVerifyFailure) throw error;
      }
    }

    // Verify
    if (verify && result.removed.length > 0) {
      const verifyResult = await this.verifyItemsInCollection(result.removed, collectionKey);
      // 对于 remove，verify 成功意味着项目不再存在
      for (const present of verifyResult.present) {
        if (!result.failed.some((f) => f.itemKey === present)) {
          result.failed.push({ itemKey: present, error: "Verification failed: item still in collection" });
        }
      }
      result.verified = verifyResult.missing; // 不在集合中 = 验证通过
    }

    return result;
  }

  async verifyItemsInCollection(itemKeys, collectionKey, options = {}) {
    const result = createVerifyResult();

    // 获取集合中的所有项目 key
    const collectionItems = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const page = await this.getCollectionItems(collectionKey, { limit, offset });
      if (!page.length) break;
      collectionItems.push(...page.map((i) => i.key));
      if (page.length < limit) break;
      offset += limit;
    }

    const collectionSet = new Set(collectionItems);
    for (const key of itemKeys) {
      if (collectionSet.has(key)) {
        result.present.push(key);
      } else {
        result.missing.push(key);
      }
    }

    result.success = result.missing.length === 0;
    return result;
  }

  async moveItemsBetweenCollections(itemKeys, fromCollectionKey, toCollectionKey, options = {}) {
    const result = { moved: [], failed: [] };

    for (const itemKey of itemKeys) {
      try {
        // 1. Add to target + verify
        const addResult = await this.addItemsToCollection([itemKey], toCollectionKey, { verify: true });

        if (addResult.failed.length > 0) {
          result.failed.push({ itemKey, error: `Add verification failed: ${addResult.failed[0].error}` });
          continue;
        }

        // 2. Remove from source + verify
        const removeResult = await this.removeItemsFromCollection([itemKey], fromCollectionKey, { verify: true });

        if (removeResult.failed.length > 0) {
          // Rollback: remove from target
          await this.removeItemsFromCollection([itemKey], toCollectionKey, { verify: false }).catch(() => {});
          result.failed.push({ itemKey, error: `Remove verification failed: ${removeResult.failed[0].error}` });
          continue;
        }

        result.moved.push(itemKey);
      } catch (error) {
        result.failed.push({ itemKey, error: error.message });
      }
    }

    return result;
  }

  // ─── 项目读取 ───

  async getItemDetails(itemKey, mode = "preview") {
    const result = await this._request("GET", `/items/${itemKey}`);
    return normalizeItem(result.data);
  }

  async getItemsDetails(itemKeys = [], mode = "preview", options = {}) {
    return mapWithConcurrency(itemKeys, this._requestConcurrency(options), (itemKey) => this.getItemDetails(itemKey, mode), {
      controller: this.concurrencyController,
      observe: false,
    });
  }

  async searchLibrary(options = {}) {
    const { q, title, titleOperator, limit = 25, mode = "preview" } = options;
    let path = `/items?limit=${limit}&itemType=-attachment%20%7C%7C%20note`;

    if (q) {
      path += `&q=${encodeURIComponent(q)}&qmode=everything`;
    } else if (title) {
      path += `&q=${encodeURIComponent(title)}&qmode=titleCreatorYear`;
    }

    const result = await this._request("GET", path);
    return (result.data || []).map(normalizeItem);
  }

  // ─── 项目写入 ───

  async createItem(itemData) {
    // Strip non-Zotero fields that would cause API rejection
    const { inputIndex, action, ...cleanData } = itemData || {};
    const result = await this._request("POST", "/items", [cleanData], { retries: 1, writeToken: writeToken() });
    const responseData = result.data;
    const key = firstSuccessfulKey(responseData?.successful) || responseData?.key || "";
    if (!key) throw new Error(firstFailureMessage(responseData?.failed, "create_item_failed"));
    return { key, ...cleanData };
  }

  async createItems(itemsData = []) {
    if (!itemsData.length) return [];
    // Chunk by MAX_BATCH_SIZE (Zotero Web API v3 limit)
    const allResults = [];
    for (let offset = 0; offset < itemsData.length; offset += MAX_BATCH_SIZE) {
      const chunk = itemsData.slice(offset, offset + MAX_BATCH_SIZE);
      const chunkResult = await this._createItemsChunk(chunk, offset);
      allResults.push(...chunkResult);
    }
    return allResults;
  }

  async _createItemsChunk(itemsData, indexOffset = 0) {
    // Strip non-Zotero fields that would cause API rejection
    const cleanItems = itemsData.map(({ inputIndex, action, ...rest }) => rest);
    // Zotero API supports batch create with POST /items
    const result = await this._request("POST", "/items", cleanItems, { retries: 1, writeToken: writeToken() });
    const responseData = result.data;
    const successful = responseData?.successful || {};
    const unchanged = responseData?.unchanged || {};
    const failed = responseData?.failed || {};

    // Map results back to input order
    return itemsData.map((itemData, index) => {
      const successEntry = successful[String(index)];
      if (successEntry) {
        return { key: successEntry.key, ...itemData };
      }
      const unchangedEntry = unchanged[String(index)];
      if (unchangedEntry) {
        return { key: unchangedEntry.key, ...itemData };
      }
      const failedEntry = failed[String(index)];
      return { key: "", error: failedEntry?.message || "create_failed", ...itemData };
    });
  }

  async updateItem(itemKey, fields) {
    const version = this._requireVersion(fields.version || await this._getItemVersion(itemKey), "update_item");
    const { version: _, ...updateFields } = fields;
    await this._request("PATCH", `/items/${itemKey}`, updateFields, {
      retries: 1,
      ifUnmodifiedSinceVersion: version,
    });
  }

  async writeTag(options) {
    const { action, itemKey, tags } = options;

    // 获取当前项目
    const itemResult = await this._request("GET", `/items/${itemKey}`);
    const currentTags = itemResult.data?.data?.tags || [];

    let newTags;
    if (action === "set") {
      newTags = tags.map((t) => (typeof t === "string" ? { tag: t } : t));
    } else if (action === "add") {
      const existing = new Set(currentTags.map((t) => t.tag));
      newTags = [...currentTags];
      for (const t of tags) {
        const tagName = typeof t === "string" ? t : t.tag;
        if (!existing.has(tagName)) {
          newTags.push({ tag: tagName });
        }
      }
    } else if (action === "remove") {
      const removeSet = new Set(tags.map((t) => (typeof t === "string" ? t : t.tag)));
      newTags = currentTags.filter((t) => !removeSet.has(t.tag));
    } else {
      throw new Error(`Unknown tag action: ${action}`);
    }

    const version = this._requireVersion(itemResult.data?.version || await this._getItemVersion(itemKey), "write_tag");
    await this._request("PATCH", `/items/${itemKey}`, { tags: newTags }, {
      retries: 1,
      ifUnmodifiedSinceVersion: version,
    });
  }

  async writeMetadataBatch(updates = []) {
    if (!updates.length) return { updated: [], unchanged: [], failed: [], versions: {}, libraryVersion: this.libraryVersion };

    const updated = [];
    const unchanged = [];
    const failed = [];
    const updatedVersions = {};
    const currentData = {};

    // Get versions for all items in batch (much more efficient than individual calls)
    const itemKeys = updates.map(u => u.itemKey).filter(Boolean);
    const versions = Object.fromEntries(updates.map((update) => [
      update.itemKey,
      Number(update.version || update.fields?.version || 0),
    ]).filter(([key, version]) => key && version > 0));
    const missingVersionKeys = itemKeys.filter((key) => !versions[key]);
    const VERSION_BATCH_SIZE = 50; // Zotero API supports up to 50 items per request
    for (let offset = 0; offset < missingVersionKeys.length; offset += VERSION_BATCH_SIZE) {
      const chunk = missingVersionKeys.slice(offset, offset + VERSION_BATCH_SIZE);
      try {
        // Fetch multiple items in a single API call
        const result = await this._request('GET', '/items?itemKey=' + chunk.join(','));
        const items = Array.isArray(result.data) ? result.data : [];
        for (const item of items) {
          const key = item.key || item.data?.key;
          if (key) {
            versions[key] = Number(item.version || item.data?.version || 0);
            currentData[key] = item.data || {};
          }
        }
        // Mark items that weren't found
        for (const key of chunk) {
          if (!versions[key]) {
            failed.push({ itemKey: key, error: 'fetch_version_failed: item not found' });
          }
        }
      } catch (e) {
        // Fallback to individual fetches on batch failure
        for (const key of chunk) {
          try {
            versions[key] = await this._getItemVersion(key);
          } catch (e2) {
            failed.push({ itemKey: key, error: 'fetch_version_failed: ' + e2.message });
          }
        }
      }
    }

    // Prepare batch payload for items that have versions
    const batchPayload = [];
    const batchKeys = [];
    for (const update of updates) {
      const { itemKey, version: updateVersion, fields: fieldsWrapper, ...rest } = update;
      const fields = fieldsWrapper || rest;
      const version = versions[itemKey];
      if (!version) continue; // Already in failed
      const { version: fieldVersion, ...metadataFields } = fields;
      if (currentData[itemKey] && Object.entries(metadataFields).every(([name, value]) => JSON.stringify(currentData[itemKey][name]) === JSON.stringify(value))) {
        unchanged.push(itemKey);
        continue;
      }
      batchPayload.push({ key: itemKey, version, ...metadataFields });
      batchKeys.push(itemKey);
    }

    // Send batch PATCH in chunks of MAX_BATCH_SIZE (with inter-chunk delay)
    for (let offset = 0; offset < batchPayload.length; offset += MAX_BATCH_SIZE) {
      // No unconditional delay - let _request handle rate limits via Backoff/429
      const chunk = batchPayload.slice(offset, offset + MAX_BATCH_SIZE);
      const chunkKeys = batchKeys.slice(offset, offset + MAX_BATCH_SIZE);
      try {
        const result = await this._request("POST", "/items", chunk);
        const responseData = result.data;
        if (Number(result.lastModifiedVersion || 0) > 0) this.libraryVersion = Number(result.lastModifiedVersion);
        const successful = responseData?.successful || {};
        const responseUnchanged = responseData?.unchanged || {};
        const batchFailed = responseData?.failed || {};

        // Map results back
        for (let i = 0; i < chunkKeys.length; i++) {
          const key = chunkKeys[i];
          const successEntry = successful[String(i)];
          const unchangedEntry = responseUnchanged[String(i)];
          const failedEntry = batchFailed[String(i)];

          if (successEntry) {
            updated.push(key);
            updatedVersions[key] = Number(successEntry.version || result.lastModifiedVersion || 0);
          } else if (unchangedEntry) {
            unchanged.push(key);
          } else if (failedEntry) {
            failed.push({ itemKey: key, error: failedEntry.message || "batch_update_failed" });
          } else {
            failed.push({ itemKey: key, error: "batch_update_result_missing" });
          }
        }
      } catch (e) {
        failed.push(...chunkKeys.map((itemKey) => ({ itemKey, error: e.message })));
      }
    }

    return { updated, unchanged, failed, versions: updatedVersions, libraryVersion: this.libraryVersion };
  }

  async writeMetadata(itemKey, fields) {
    const version = this._requireVersion(await this._getItemVersion(itemKey), "write_metadata");
    await this._request("PATCH", `/items/${itemKey}`, fields, {
      retries: 1,
      ifUnmodifiedSinceVersion: version,
    });
  }
}

export default ZoteroWebApiBackend;
