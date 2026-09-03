/**
 * Zotero CLI Backend
 *
 * 通过 cli-anything-zotero (zotero-cli) 命令行工具与 Zotero 桌面端通信。
 *
 * 特点：
 * - 需要 Zotero 桌面端运行
 * - 需要 cli-anything-zotero 已安装 (npm install -g cli-anything-zotero)
 * - 通过子进程调用 zotero-cli 命令
 * - Collection 写入包含 verify 机制
 *
 * 未来将完全替代 MCP 后端。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ZoteroBackendBase, createVerifyResult, createWriteResult } from "./zotero_backend_base.mjs";
import { executeCli, checkCliAvailable, getDefaultCliTool } from "./zotero_cli_executor.mjs";
import { launchZoteroDesktop } from "./zotero_desktop_launcher.mjs";
import { wait } from './async_utils.mjs';
import {
  isDefinitelyFailedWithoutSideEffect,
  legacyCreateFallbackEnabled,
  uncertainCreateError,
} from "./zotero_create_safety.mjs";
import { EphemeralRegistry, getActiveEphemeralRegistry, registerEphemeral } from "./ephemeral_registry.mjs";

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_RETRIES = 3;
const DEFAULT_INTERVAL_MS = 2000;
const STDIN_RUNNER_PATH = fileURLToPath(new URL("./zotero_cli_stdin_runner.py", import.meta.url));



/**
 * 从 CLI JSON 输出中提取数据
 * cli-anything-zotero 输出格式可能直接是数组/对象，或包装在 { data: ... } 中
 */
function extractData(result, fallback = null) {
  if (!result.data) return fallback;
  // 如果有 data 字段，优先用它
  if (result.data.data !== undefined) return result.data.data;
  return result.data;
}

/**
 * 从集合树中递归提取所有集合
 */
function flattenCollectionsTree(tree, parentKey = null) {
  const result = [];
  if (!Array.isArray(tree)) return result;
  for (const node of tree) {
    result.push({
      key: node.key || node.id || "",
      name: node.name || node.collectionName || node.data?.name || node.data?.collectionName || "",
      parentCollection: parentKey || node.parentCollection || node.data?.parentCollection || false,
      version: node.version || 0,
      meta: node.meta || {},
      data: node.data || node,
    });
    if (node.children || node.subcollections) {
      result.push(...flattenCollectionsTree(node.children || node.subcollections, node.key || node.id));
    }
  }
  return result;
}

export function buildAddItemsToCollectionJs(itemKeys, collectionKey) {
  return `return await (async () => {
  const itemKeys = ${JSON.stringify(itemKeys)};
  const collectionKey = ${JSON.stringify(collectionKey)};
  const libraryID = Zotero.Libraries.userLibraryID;
  const collection = Zotero.Collections.getByLibraryAndKey(libraryID, collectionKey);
  if (!collection) throw new Error("collection_not_found:" + collectionKey);
  const collectionID = collection.id;
  const added = [];
  const already = [];
  const failed = [];
  for (const itemKey of itemKeys) {
    try {
      const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
      if (!item) {
        failed.push({ itemKey, error: "item_not_found" });
        continue;
      }
      if ((item.getCollections() || []).includes(collectionID)) {
        already.push(itemKey);
        added.push(itemKey);
        continue;
      }
      item.addToCollection(collectionID);
      await item.saveTx();
      added.push(itemKey);
    } catch (error) {
      failed.push({ itemKey, error: String(error && error.message || error) });
    }
  }
  return { added, already, failed };
})();`;
}

export function buildAddItemsToCollectionsJs(operations) {
  return `return await (async () => {
  const operations = ${JSON.stringify(operations)};
  const libraryID = Zotero.Libraries.userLibraryID;
  const collectionByKey = new Map();
  const itemToCollections = new Map();
  const added = [];
  const already = [];
  const failed = [];
  for (const op of operations) {
    const collectionKey = String(op.collectionKey || "");
    if (!collectionKey) continue;
    let collection = collectionByKey.get(collectionKey);
    if (!collectionByKey.has(collectionKey)) {
      collection = Zotero.Collections.getByLibraryAndKey(libraryID, collectionKey);
      collectionByKey.set(collectionKey, collection || null);
    }
    if (!collection) {
      failed.push({ collectionKey, error: "collection_not_found" });
      continue;
    }
    for (const itemKey of (op.itemKeys || [])) {
      if (!itemToCollections.has(itemKey)) itemToCollections.set(itemKey, []);
      itemToCollections.get(itemKey).push({ collectionKey, collectionID: collection.id });
    }
  }
  for (const [itemKey, targets] of itemToCollections.entries()) {
    try {
      const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
      if (!item) {
        for (const target of targets) failed.push({ itemKey, collectionKey: target.collectionKey, error: "item_not_found" });
        continue;
      }
      const current = new Set(item.getCollections() || []);
      let changed = false;
      for (const target of targets) {
        if (current.has(target.collectionID)) {
          already.push({ itemKey, collectionKey: target.collectionKey });
          added.push({ itemKey, collectionKey: target.collectionKey, already: true });
          continue;
        }
        item.addToCollection(target.collectionID);
        current.add(target.collectionID);
        changed = true;
        added.push({ itemKey, collectionKey: target.collectionKey });
      }
      if (changed) await item.saveTx();
    } catch (error) {
      for (const target of targets) failed.push({ itemKey, collectionKey: target.collectionKey, error: String(error && error.message || error) });
    }
  }
  return { added, already, failed };
})();`;
}

export function buildWriteMetadataBatchJs(updates) {
  return `return await (async () => {
  const updates = ${JSON.stringify(updates)};
  const libraryID = Zotero.Libraries.userLibraryID;
  const updated = [];
  const failed = [];
  for (const update of updates) {
    const itemKey = String(update.itemKey || "");
    const fields = update.fields || {};
    try {
      const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
      if (!item) {
        failed.push({ itemKey, error: "item_not_found" });
        continue;
      }
      for (const [field, value] of Object.entries(fields)) {
        item.setField(field, value);
      }
      await item.saveTx();
      updated.push(itemKey);
    } catch (error) {
      failed.push({ itemKey, error: String(error && error.message || error) });
    }
  }
  return { updated, failed };
})();`;
}

export function buildCreateItemJs(itemData) {
  const input = normalizeCreateItemInput(itemData);
  return `return await (async () => {
  const input = ${JSON.stringify(input)};
  const libraryID = Zotero.Libraries.userLibraryID;
  const result = await createOne(input, libraryID);
  return { key: result.itemKey, itemKey: result.itemKey, createMode: "js_bridge" };

  async function createOne(input, libraryID) {
    const item = new Zotero.Item(input.itemType || "journalArticle");
    item.libraryID = libraryID;
    for (const [field, value] of Object.entries(input.fields || {})) {
      try {
        item.setField(field, value);
      } catch (error) {
        if (field !== "extra" && field !== "title") throw error;
      }
    }
    for (const tag of (input.tags || [])) item.addTag(tag);
    await item.saveTx();
    for (const collectionKey of (input.collectionKeys || [])) {
      const collection = Zotero.Collections.getByLibraryAndKey(libraryID, collectionKey);
      if (!collection) throw new Error("collection_not_found:" + collectionKey);
      item.addToCollection(collection.id);
    }
    if ((input.collectionKeys || []).length) await item.saveTx();
    return { itemKey: item.key };
  }
})();`;
}

function normalizeCreateItemInput(itemData = {}) {
  const rawCollections = itemData.collections || [];
  const collectionKeys = rawCollections
    .map((c) => (typeof c === "string" ? c : c?.key || ""))
    .filter(Boolean);
  const fields = { ...itemData, ...(itemData.fields || {}) };
  delete fields.inputIndex; delete fields.itemType; delete fields.fields; delete fields.tags; delete fields.collections; delete fields.action; delete fields._target_collections;
  const cleanFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === "" || value === null || value === undefined) continue;
    cleanFields[key] = value;
  }
  const tags = (itemData.tags || [])
    .map((tag) => (typeof tag === "string" ? tag : tag?.tag || tag?.name || ""))
    .filter(Boolean);
  return {
    inputIndex: Number.isFinite(Number(itemData.inputIndex)) ? Number(itemData.inputIndex) : null,
    itemType: itemData.itemType || "journalArticle",
    fields: cleanFields,
    tags,
    collectionKeys,
  };
}

export function buildCreateItemsJs(itemsData = []) {
  const inputs = (Array.isArray(itemsData) ? itemsData : []).map(normalizeCreateItemInput);
  return `return await (async () => {
  const inputs = ${JSON.stringify(inputs)};
  const libraryID = Zotero.Libraries.userLibraryID;
  const created = [];
  const failed = [];
  for (const input of inputs) {
    try {
      const item = await createOne(input, libraryID);
      created.push({
        inputIndex: input.inputIndex,
        key: item.key,
        itemKey: item.key,
        createMode: "js_bridge_batch",
      });
    } catch (error) {
      failed.push({
        inputIndex: input.inputIndex,
        error: String(error && error.message || error),
      });
    }
  }
  return { created, failed };

  async function createOne(input, libraryID) {
    const item = new Zotero.Item(input.itemType || "journalArticle");
    item.libraryID = libraryID;
    for (const [field, value] of Object.entries(input.fields || {})) {
      try {
        item.setField(field, value);
      } catch (error) {
        if (field !== "extra" && field !== "title") throw error;
      }
    }
    for (const tag of (input.tags || [])) item.addTag(tag);
    await item.saveTx();
    for (const collectionKey of (input.collectionKeys || [])) {
      const collection = Zotero.Collections.getByLibraryAndKey(libraryID, collectionKey);
      if (!collection) throw new Error("collection_not_found:" + collectionKey);
      item.addToCollection(collection.id);
    }
    if ((input.collectionKeys || []).length) await item.saveTx();
    return item;
  }
})();`;
}

export function buildEnsureWritebackCollectionsJs({
  rootKey = "",
  monthName = "",
  dayName = "",
  sourceNames = [],
  gradeNames = [],
} = {}) {
  const plan = {
    rootKey,
    monthName,
    dayName,
    sourceNames: (Array.isArray(sourceNames) ? sourceNames : []).filter(Boolean),
    gradeNames: (Array.isArray(gradeNames) ? gradeNames : []).filter(Boolean),
  };
  return `return await (async () => {
  const plan = ${JSON.stringify(plan)};
  const libraryID = Zotero.Libraries.userLibraryID;
  const root = Zotero.Collections.getByLibraryAndKey(libraryID, plan.rootKey);
  if (!root) throw new Error("root_collection_not_found:" + plan.rootKey);
  const created = [];
  const existing = [];

  function collectionName(collection) {
    return String(collection && (collection.name || collection.collectionName || collection._name || "") || "");
  }

  function asRecord(collection, role, parentKey, createdNow) {
    return {
      key: collection.key,
      name: collectionName(collection),
      role,
      parentCollection: parentKey || false,
      created: Boolean(createdNow),
    };
  }

  function childrenOf(parent) {
    return Zotero.Collections.getByParent(parent.id) || [];
  }

  async function ensureChild(parent, name, role) {
    const existingChild = childrenOf(parent).find((collection) => collectionName(collection) === name);
    if (existingChild) {
      existing.push({ key: existingChild.key, name, role });
      return { collection: existingChild, record: asRecord(existingChild, role, parent.key, false) };
    }
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID;
    collection.name = name;
    collection.parentID = parent.id;
    await collection.saveTx();
    created.push({ key: collection.key, name, role });
    return { collection, record: asRecord(collection, role, parent.key, true) };
  }

  const month = await ensureChild(root, plan.monthName, "month");
  const day = await ensureChild(month.collection, plan.dayName, "day");
  const sources = {};
  for (const name of plan.sourceNames) {
    const ensured = await ensureChild(day.collection, name, "source");
    sources[name] = ensured.record;
  }
  const grades = {};
  for (const name of plan.gradeNames) {
    const ensured = await ensureChild(day.collection, name, "grade");
    grades[name] = ensured.record;
  }
  return {
    month: month.record,
    date: day.record,
    sources,
    grades,
    created,
    existing,
  };
})();`;
}

export function buildGetItemsDetailsJs(itemKeys, mode = "preview") {
  return `return await (async () => {
  const itemKeys = ${JSON.stringify(itemKeys)};
  const mode = ${JSON.stringify(mode)};
  const libraryID = Zotero.Libraries.userLibraryID;
  const out = [];
  function stableCollectionKey(value) {
    if (value && typeof value === "object" && value.key) return String(value.key);
    const raw = String(value == null ? "" : value).trim();
    if (!raw) return "";
    if (!/^\\d+$/.test(raw)) return raw;
    const collection = Zotero.Collections.get(Number(raw));
    return String(collection && collection.key || "");
  }
  for (const itemKey of itemKeys) {
    const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
    if (!item) {
      out.push({ key: itemKey, itemKey, missing: true });
      continue;
    }
    const data = {
      key: item.key,
      itemKey: item.key,
      itemType: item.itemType || "",
      title: item.getField("title") || "",
      DOI: item.getField("DOI") || "",
      doi: item.getField("DOI") || "",
      url: item.getField("url") || "",
      URL: item.getField("url") || "",
      extra: item.getField("extra") || "",
      shortTitle: item.getField("shortTitle") || "",
      dateAdded: item.dateAdded || "",
      dateModified: item.dateModified || "",
    };
    if (mode === "complete") {
      data.creators = item.getCreators ? item.getCreators() : [];
      data.tags = item.getTags ? item.getTags() : [];
      data.collections = item.getCollections ? item.getCollections().map(stableCollectionKey).filter(Boolean) : [];
    }
    out.push({ key: item.key, itemKey: item.key, data, title: data.title, missing: false });
  }
  return { items: out };
})();`;
}

export function buildDeleteItemsJs(itemKeys) {
  return `return await (async () => {
  const itemKeys = ${JSON.stringify(itemKeys)};
  const libraryID = Zotero.Libraries.userLibraryID;
  const deleted = [];
  const failed = [];
  for (const itemKey of itemKeys) {
    try {
      const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
      if (!item) {
        deleted.push(itemKey);
        continue;
      }
      await item.eraseTx();
      deleted.push(itemKey);
    } catch (error) {
      failed.push({ itemKey, error: String(error && error.message || error) });
    }
  }
  return { deleted, failed };
})();`;
}

export class ZoteroCliBackend extends ZoteroBackendBase {
  constructor(config = {}) {
    super();
    this.cliTool = config.cliTool || getDefaultCliTool("desktop");
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.retries = config.retries || DEFAULT_RETRIES;
    this.intervalMs = config.intervalMs || DEFAULT_INTERVAL_MS;
    this.launchDesktop = config.launchDesktop !== false;
    this.desktopPostStartDelayMs = config.desktopPostStartDelayMs || 5000;
    this.zoteroExe = config.zoteroExe || process.env.ZOTERO_EXE || "";
    this.launcher = config.launcher || launchZoteroDesktop;
    this.executeCli = config.executeCli || executeCli;
    this.checkCliAvailable = config.checkCliAvailable || checkCliAvailable;
    this.ephemeralRegistry = config.ephemeralRegistry || null;
  }

  get backendType() {
    return "cli";
  }

  /**
   * 执行 CLI 命令并返回解析后的数据
   */
  async _exec(args, options = {}) {
    const { timeoutMs = this.timeoutMs, retries = this.retries, intervalMs = this.intervalMs } = options;

    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await this.executeCli(this.cliTool, args, {
          timeoutMs,
          json: true,
        });

        if (result.exitCode !== 0) {
          throw new Error(`CLI exited with code ${result.exitCode}: ${result.stderr || result.stdout}`);
        }

        return result;
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await wait(intervalMs);
        }
      }
    }

    throw lastError || new Error(`CLI command failed after ${retries} attempts`);
  }

  // ─── 连接管理 ───

  async ping() {
    try {
      const result = await this._exec(["app", "ping"], { retries: 1, timeoutMs: 10000 });
      const data = extractData(result, result.data);
      return result.exitCode === 0 && data?.connector_available === true;
    } catch {
      return false;
    }
  }

  async ensureReady(options = {}) {
    const { retries = this.retries, intervalMs = this.intervalMs, log = console.log } = options;

    // 检查 CLI 工具是否可用
    const available = await this.checkCliAvailable(this.cliTool);
    if (!available) {
      return {
        ok: false,
        diagnostics: {
          backend: "cli",
          error: `Desktop CLI tool '${this.cliTool}' not found. Install cli-anything-zotero or set ZOTERO_DESKTOP_CLI_TOOL.`,
          cliTool: this.cliTool,
        },
      };
    }

    let launchResult = null;
    if (this.launchDesktop) {
      launchResult = await this.launcher({
        postStartDelayMs: this.desktopPostStartDelayMs,
        zoteroExe: this.zoteroExe,
        log,
      });
      if (!launchResult.ok) {
        return {
          ok: false,
          diagnostics: {
            backend: "cli",
            cliTool: this.cliTool,
            error: launchResult.error || "Zotero desktop launch failed",
            launch: launchResult,
          },
        };
      }
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      log(`[CLI] Probing attempt ${attempt}/${retries}...`);
      const ok = await this.ping();
      if (ok) {
        // Initialize session with default library
        try {
          await this.executeCli(this.cliTool, ["session", "use-library", "1"], { timeoutMs: 5000, json: false });
        } catch (e) {
          // Ignore session initialization errors
        }
        return {
          ok: true,
          started_now: Boolean(launchResult?.started_now),
          was_running: this.launchDesktop ? Boolean(launchResult?.was_running) : true,
          diagnostics: {
            backend: "cli",
            cliTool: this.cliTool,
            attempts: attempt,
            launch: launchResult,
          },
        };
      }
      if (attempt < retries) await wait(intervalMs);
    }

    return {
      ok: false,
      diagnostics: {
        backend: "cli",
        cliTool: this.cliTool,
        error: this.launchDesktop
          ? `Zotero desktop was launched or already running, but CLI connector was not ready after ${retries} attempts`
          : `CLI connector was not ready after ${retries} attempts`,
        launch: launchResult,
        was_running: Boolean(launchResult?.was_running),
        started_now: Boolean(launchResult?.started_now),
      },
    };
  }

  // ─── 集合读取 ───

  async getCollections(options = {}) {
    const result = await this._exec(["collection", "tree", "--json"]);
    const data = extractData(result, []);
    return Array.isArray(data) ? flattenCollectionsTree(data) : [];
  }

  async getSubcollections(collectionKey, recursive = false) {
    const all = await this.getCollections();
    const children = all.filter((c) => c.parentCollection === collectionKey);
    if (!recursive) return children;

    const byParent = new Map();
    for (const collection of all) {
      const parent = collection.parentCollection || "";
      if (!parent) continue;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(collection);
    }

    const result = [];
    const queue = [...children];
    const seen = new Set();
    while (queue.length) {
      const collection = queue.shift();
      if (!collection?.key || seen.has(collection.key)) continue;
      seen.add(collection.key);
      result.push(collection);
      queue.push(...(byParent.get(collection.key) || []));
    }
    return result;
  }

  async getCollectionItems(collectionKey, options = {}) {
    const args = ["collection", "items", collectionKey, "--json"];
    const result = await this._exec(args);
    const data = extractData(result, []);
    return Array.isArray(data) ? data : [];
  }

  // ─── 集合写入（带 verify） ───

  async ensureCollectionPath(pathArray, options = {}) {
    const created = [];
    const existing = [];
    let currentKey = null;

    const allCollections = await this.getCollections();

    for (const name of pathArray) {
      // 查找是否已存在
      const found = allCollections.find(
        (c) => c.name === name && (currentKey ? c.parentCollection === currentKey : !c.parentCollection)
      );

      if (found) {
        existing.push(found.key);
        currentKey = found.key;
      } else {
        // 创建新集合
        const newCol = await this.createCollection(name, currentKey);
        created.push(newCol.key);
        currentKey = newCol.key;
        // 刷新集合列表
        const refreshed = await this.getCollections();
        allCollections.length = 0;
        allCollections.push(...refreshed);
      }
    }

    return { created, existing, rootKey: currentKey };
  }

  async createCollection(name, parentKey = null) {
    const args = ["collection", "create", name, "--json"];
    if (parentKey) args.push("--parent", parentKey);

    const result = await this._exec(args);
    const data = extractData(result, {});
    return { key: data.key || data.id || "", name, parentCollection: parentKey || false };
  }

  async ensureWritebackCollections(options = {}) {
    const jsResult = await this._exec(
      ["js", buildEnsureWritebackCollectionsJs(options)],
      { retries: 1, timeoutMs: Math.max(30000, this.timeoutMs) }
    );
    return extractData(jsResult, {});
  }

  async deleteCollection(collectionKey, options = {}) {
    const args = ["collection", "delete", collectionKey, "--confirm"];
    if (options.deleteItems) args.push("--delete-items");
    await this._exec(args);
  }

  async addItemsToCollection(itemKeys, collectionKey, options = {}) {
    const { verify = false, skipOnVerifyFailure = true } = options;
    const result = { added: [], failed: [], verified: [] };
    const keys = [...new Set((itemKeys || []).filter(Boolean))];
    if (keys.length === 0) return result;

    try {
      const jsResult = await this._exec(
        ["js", buildAddItemsToCollectionJs(keys, collectionKey)],
        { retries: 1, timeoutMs: Math.max(30000, this.timeoutMs) }
      );
      const data = extractData(jsResult, {});
      const batchAdded = Array.isArray(data?.added) ? data.added : [];
      const batchAlready = Array.isArray(data?.already) ? data.already : [];
      result.added.push(...new Set([...batchAdded, ...batchAlready]));
      result.failed.push(...(Array.isArray(data?.failed) ? data.failed : []));
    } catch (batchError) {
      for (const itemKey of keys) {
        try {
          await this._exec(["item", "add-to-collection", itemKey, collectionKey], { retries: 1, timeoutMs: 15000 });
          result.added.push(itemKey);
        } catch (error) {
          result.failed.push({ itemKey, error: error.message });
          if (!skipOnVerifyFailure) throw error;
        }
      }
    }

    if (result.failed.length > 0 && !skipOnVerifyFailure) {
      throw new Error(`add_items_to_collection_failed:${result.failed[0].error || result.failed[0].itemKey}`);
    }

    for (const itemKey of keys) {
      if (result.added.includes(itemKey) || result.failed.some((failure) => failure.itemKey === itemKey)) continue;
      try {
        await this._exec(["item", "add-to-collection", itemKey, collectionKey], { retries: 1, timeoutMs: 15000 });
        result.added.push(itemKey);
      } catch (error) {
        result.failed.push({ itemKey, error: error.message });
        if (!skipOnVerifyFailure) throw error;
      }
    }

    if (verify && result.added.length > 0) {
      const verifyResult = await this.verifyItemsInCollection(result.added, collectionKey);
      result.verified = verifyResult.present;
      for (const missing of verifyResult.missing) {
        if (!result.failed.some((f) => f.itemKey === missing)) {
          result.failed.push({ itemKey: missing, error: "Verification failed: item not in collection" });
        }
      }
    }

    return result;
  }

  async addItemsToCollections(operations = [], options = {}) {
    const result = { added: [], already: [], failed: [] };
    const normalized = [];
    for (const operation of Array.isArray(operations) ? operations : []) {
      const collectionKey = String(operation?.collectionKey || "").trim();
      const itemKeys = [...new Set((operation?.itemKeys || []).map((key) => String(key || "").trim()).filter(Boolean))];
      if (collectionKey && itemKeys.length) normalized.push({ collectionKey, itemKeys });
    }
    if (!normalized.length) return result;

    const jsResult = await this._exec(
      ["js", buildAddItemsToCollectionsJs(normalized)],
      { retries: 1, timeoutMs: Math.max(30000, this.timeoutMs) }
    );
    const data = extractData(jsResult, {});
    result.added.push(...(Array.isArray(data?.added) ? data.added : []));
    result.already.push(...(Array.isArray(data?.already) ? data.already : []));
    result.failed.push(...(Array.isArray(data?.failed) ? data.failed : []));
    if (result.failed.length > 0 && options.skipOnVerifyFailure === false) {
      throw new Error(`add_items_to_collections_failed:${result.failed[0].error || result.failed[0].itemKey || result.failed[0].collectionKey}`);
    }
    return result;
  }

  async removeItemsFromCollection(itemKeys, collectionKey, options = {}) {
    const { verify = true, skipOnVerifyFailure = true } = options;
    const result = createWriteResult();

    for (const itemKey of itemKeys) {
      try {
        await this._exec(["collection", "remove-item", collectionKey, itemKey]);
        result.removed.push(itemKey);
      } catch (error) {
        result.failed.push({ itemKey, error: error.message });
        if (!skipOnVerifyFailure) throw error;
      }
    }

    // Verify
    if (verify && result.removed.length > 0) {
      const verifyResult = await this.verifyItemsInCollection(result.removed, collectionKey);
      for (const present of verifyResult.present) {
        if (!result.failed.some((f) => f.itemKey === present)) {
          result.failed.push({ itemKey: present, error: "Verification failed: item still in collection" });
        }
      }
      result.verified = verifyResult.missing;
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
      collectionItems.push(...page.map((i) => i.key || i));
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
    const args = ["item", "get", itemKey, "--json"];
    if (mode === "complete") args.push("--full");

    const result = await this._exec(args);
    return extractData(result, result.data);
  }

  async getItemsDetails(itemKeys = [], mode = "preview") {
    const keys = [...new Set((Array.isArray(itemKeys) ? itemKeys : []).map((key) => String(key || "").trim()).filter(Boolean))];
    if (!keys.length) return [];
    const out = [];
    const batchSize = 250;
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      const result = await this._exec(
        ["js", buildGetItemsDetailsJs(batch, mode)],
        { retries: 1, timeoutMs: Math.max(30000, this.timeoutMs) }
      );
      const data = extractData(result, []);
      const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
      if (Array.isArray(items)) out.push(...items);
    }
    return out;
  }

  async searchLibrary(options = {}) {
    const { q, title, limit = 25 } = options;
    const query = title || q || "";
    const args = ["item", "find", query, "--json"];
    if (limit) args.push("--limit", String(limit));

    const result = await this._exec(args);
    const data = extractData(result, []);
    return Array.isArray(data) ? data : [];
  }

  // ─── 项目写入 ───

  async createItem(itemData) {
    try {
      const jsResult = await this._exec(
        ["js", buildCreateItemJs(itemData)],
        { retries: 1, timeoutMs: Math.max(30000, this.timeoutMs) }
      );
      const data = extractData(jsResult, {});
      const key = data?.itemKey || data?.key || "";
      if (!key) throw new Error("js_create_item_no_key");
      return { ...itemData, key, itemKey: key, createMode: "js_bridge" };
    } catch (jsError) {
      if (legacyCreateFallbackEnabled() && process.env.ZOTERO_CLI_CREATE_ITEM_DISABLE_IMPORT_FALLBACK !== "1") {
        return this.createItemViaImport(itemData);
      }
      if (isDefinitelyFailedWithoutSideEffect(jsError)) throw jsError;
      const query = itemData?.DOI || itemData?.doi || itemData?.title || itemData?.fields?.DOI || itemData?.fields?.title || "";
      let matches = [];
      if (query) {
        try {
          const candidates = await this.searchLibrary({ q: query, limit: 8 });
          const expectedTitle = String(itemData?.title || itemData?.fields?.title || "").normalize("NFKC").trim().replace(/\\s+/g, " ").toLowerCase();
          const expectedDoi = String(itemData?.DOI || itemData?.doi || itemData?.fields?.DOI || "").trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
          matches = candidates.filter((candidate) => {
            const data = candidate?.data || candidate || {};
            const actualDoi = String(data.DOI || data.doi || "").trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "");
            if (expectedDoi && actualDoi) return expectedDoi === actualDoi;
            const actualTitle = String(data.title || candidate?.title || "").normalize("NFKC").trim().replace(/\\s+/g, " ").toLowerCase();
            return Boolean(expectedTitle && actualTitle === expectedTitle);
          });
        } catch {}
      }
      if (matches.length === 1) {
        const key = matches[0]?.itemKey || matches[0]?.key || matches[0]?.data?.itemKey || matches[0]?.data?.key || "";
        if (key) return { ...itemData, key, itemKey: key, createMode: "reconciled_js_bridge" };
      }
      throw uncertainCreateError(jsError, { candidateCount: matches.length, source: "zotero_cli_create_item" });
    }
  }

  async createItems(itemsData = []) {
    const inputs = Array.isArray(itemsData) ? itemsData : [];
    const result = { created: [], failed: [] };
    if (!inputs.length) return result;
    const createBatch = async (batch) => {
      const script = buildCreateItemsJs(batch);
      const timeoutMs = Math.max(
        30000,
        this.timeoutMs,
        batch.length * Number(process.env.ZOTERO_CLI_BATCH_CREATE_TIMEOUT_MS_PER_ITEM || 3000),
      );
      const jsResult = await this.executeCli(process.env.PYTHON || "python", [STDIN_RUNNER_PATH, "--wait", String(Math.ceil(timeoutMs / 1000))], {
        timeoutMs,
        json: true,
        stdin: script,
      });
      if (jsResult.exitCode !== 0) throw new Error(`CLI stdin runner exited with code ${jsResult.exitCode}: ${jsResult.stderr || jsResult.stdout}`);
      const data = extractData(jsResult, {});
      return {
        created: Array.isArray(data?.created) ? data.created : [],
        failed: Array.isArray(data?.failed) ? data.failed : [],
      };
    };
    const created = await createBatch(inputs);
    result.created.push(...created.created);
    result.failed.push(...created.failed);
    return result;
  }

  async deleteItems(itemKeys = []) {
    const keys = [...new Set((Array.isArray(itemKeys) ? itemKeys : []).map((key) => String(key || "").trim()).filter(Boolean))];
    const result = { deleted: [], failed: [] };
    if (!keys.length) return result;
    const jsResult = await this._exec(
      ["js", buildDeleteItemsJs(keys)],
      { retries: 1, timeoutMs: Math.max(30000, this.timeoutMs) }
    );
    const data = extractData(jsResult, {});
    result.deleted.push(...(Array.isArray(data?.deleted) ? data.deleted : []));
    result.failed.push(...(Array.isArray(data?.failed) ? data.failed : []));
    return result;
  }

  async createItemViaImport(itemData) {
    const tmpFile = path.join(os.tmpdir(), `zotero-cli-import-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    let ephemeralRegistry = this.ephemeralRegistry || getActiveEphemeralRegistry() || new EphemeralRegistry({ allowedRoots: [os.tmpdir()] });
    let temporaryRegistration = registerEphemeral({ path: tmpFile, ownerStage: "zotero_cli_import", cleanupWhen: "always_after_close" }, ephemeralRegistry);
    if (!temporaryRegistration.accepted) {
      ephemeralRegistry = new EphemeralRegistry({ allowedRoots: [os.tmpdir()] });
      temporaryRegistration = registerEphemeral({ path: tmpFile, ownerStage: "zotero_cli_import", cleanupWhen: "always_after_close" }, ephemeralRegistry);
    }
    const importTag = `codex-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const rawCollections = itemData.collections || [];
      const collectionKeys = rawCollections
        .map((c) => (typeof c === "string" ? c : c?.key || ""))
        .filter(Boolean);

      // Fields may be nested (buildCreateItemRequest) or flat (MCP_TO_ADAPTER.write_item)
      const fields = { ...itemData, ...(itemData.fields || {}) };
      delete fields.itemType; delete fields.fields; delete fields.tags; delete fields.collections; delete fields.action; delete fields._target_collections;
      const payload = {
        itemType: itemData.itemType || "journalArticle",
        ...fields,
        tags: (itemData.tags || []).map((t) => (typeof t === "string" ? { tag: t } : t)),
      };
      for (const [k, v] of Object.entries(payload)) {
        if (v === "" || v === null || v === undefined) delete payload[k];
      }

      fs.writeFileSync(tmpFile, JSON.stringify([payload]), "utf8");

      let primaryCollection = null;
      for (const c of rawCollections) {
        const name = typeof c === "object" ? (c?.name || "") : "";
        if (name && (name.includes("课题") || name.includes("专题") || name.includes("领域"))) {
          primaryCollection = typeof c === "string" ? c : c?.key;
          break;
        }
      }
      if (!primaryCollection && collectionKeys.length > 0) {
        primaryCollection = collectionKeys[0];
      }

      const args = ["import", "json", tmpFile, "--json"];
      if (primaryCollection) args.push("--collection", primaryCollection);
      args.push("--tag", importTag);

      const result = await this.executeCli(this.cliTool, args, {
        timeoutMs: this.timeoutMs,
        json: true,
      });

      if (result.exitCode !== 0) {
        throw new Error(`Create item failed: ${result.stderr || result.stdout}`);
      }

      // Find real key: search the target collection for the item with our import tag
      let realKey = "";
      const tmpTitle = (fields.title || itemData.title || "").slice(0, 60);
      await new Promise((r) => setTimeout(r, 800));

      if (primaryCollection) {
        try {
          const collResult = await this._exec(
            ["collection", "items", primaryCollection, "--json"],
            { retries: 1, timeoutMs: 10000 }
          );
          const collItems = extractData(collResult, []);
          if (Array.isArray(collItems)) {
            // Find by import tag
            const tagged = collItems.find((it) => {
              const tags = it.tags || [];
              return tags.some((t) => (t.tag || t.name || t) === importTag);
            });
            if (tagged) {
              realKey = tagged.key || "";
            }
            // Fallback: find by title (most recent)
            if (!realKey && tmpTitle) {
              const byTitle = collItems
                .filter((it) => (it.title || "").includes(tmpTitle))
                .sort((a, b) => String(b.dateAdded || "").localeCompare(String(a.dateAdded || "")));
              if (byTitle.length > 0) realKey = byTitle[0].key || "";
            }
          }
        } catch {}
      }

      // Final fallback: global search
      if (!realKey && tmpTitle) {
        try {
          const searchResults = await this.searchLibrary({ title: tmpTitle, limit: 10 });
          const sorted = searchResults
            .filter((it) => {
              const t = it.data?.title || it.title || "";
              return t.includes(tmpTitle) || tmpTitle.includes(t.slice(0, 40));
            })
            .sort((a, b) => String(b.dateAdded || "").localeCompare(String(a.dateAdded || "")));
          if (sorted.length > 0) realKey = sorted[0].key || sorted[0].data?.key || "";
        } catch {}
      }

      if (!realKey) {
        throw new Error(`create_item_no_key: imported (tag=${importTag}) but could not find item`);
      }

      // Clean up the import tag
      try {
        await this._exec(["item", "tag", realKey, "--remove", importTag], { retries: 1, timeoutMs: 8000 });
      } catch {}

      return { ...itemData, key: realKey, itemKey: realKey, createMode: "import_json" };
    } finally {
      temporaryRegistration.markClosed();
      await temporaryRegistration.cleanup({ success: true });
    }
  }

  async updateItem(itemKey, fields) {
    const args = ["item", "update", itemKey];
    for (const [key, value] of Object.entries(fields)) {
      if (key === "version") continue; // 跳过 version，CLI 自己处理
      args.push("--field", `${key}=${value}`);
    }

    await this._exec(args);
  }

  async writeTag(options) {
    const { action, itemKey, tags } = options;

    if (action === "set") {
      // 先移除所有标签，再添加
      const currentItem = await this.getItemDetails(itemKey);
      const currentTags = currentItem?.data?.tags || currentItem?.tags || [];
      for (const tag of currentTags) {
        const tagName = typeof tag === "string" ? tag : tag.tag;
        await this._exec(["item", "tag", itemKey, "--remove", tagName]).catch(() => {});
      }
      for (const tag of tags) {
        const tagName = typeof tag === "string" ? tag : tag.tag;
        await this._exec(["item", "tag", itemKey, "--add", tagName]);
      }
    } else if (action === "add") {
      for (const tag of tags) {
        const tagName = typeof tag === "string" ? tag : tag.tag;
        await this._exec(["item", "tag", itemKey, "--add", tagName]);
      }
    } else if (action === "remove") {
      for (const tag of tags) {
        const tagName = typeof tag === "string" ? tag : tag.tag;
        await this._exec(["item", "tag", itemKey, "--remove", tagName]);
      }
    } else {
      throw new Error(`Unknown tag action: ${action}`);
    }
  }

  async writeMetadata(itemKey, fields) {
    const args = ["item", "update", itemKey];
    for (const [key, value] of Object.entries(fields)) {
      args.push("--field", `${key}=${value}`);
    }
    await this._exec(args);
  }

  async writeMetadataBatch(updates = []) {
    const result = { updated: [], failed: [] };
    const normalized = [];
    for (const update of Array.isArray(updates) ? updates : []) {
      const itemKey = String(update?.itemKey || "").trim();
      const fields = update?.fields && typeof update.fields === "object" ? update.fields : {};
      if (!itemKey || Object.keys(fields).length === 0) continue;
      normalized.push({ itemKey, fields });
    }
    if (!normalized.length) return result;

    const jsResult = await this._exec(
      ["js", buildWriteMetadataBatchJs(normalized)],
      { retries: 1, timeoutMs: Math.max(30000, this.timeoutMs) }
    );
    const data = extractData(jsResult, {});
    result.updated.push(...(Array.isArray(data?.updated) ? data.updated : []));
    result.failed.push(...(Array.isArray(data?.failed) ? data.failed : []));
    return result;
  }
}

export default ZoteroCliBackend;
