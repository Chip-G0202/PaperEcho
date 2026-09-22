/**
 * Zotero Adapter
 *
 * 统一适配层，自动检测并选择后端，支持降级链：
 * - 有 API Key + 个人文库数字 User ID → Web API 模式（无桌面端）
 * - 否则 → 桌面 CLI 模式（需要 Zotero 桌面端 + cli-anything-zotero）
 *
 * 降级链：Web API 失败 → CLI → 失败才报错。
 */

import { ZoteroWebApiBackend } from "./zotero_web_api_backend.mjs";
import { ZoteroCliBackend } from "./zotero_cli_backend.mjs";
import { ZoteroBackendBase } from "./zotero_backend_base.mjs";

let _adapterInstance = null;

export class ZoteroAdapter {
  constructor() {
    this.backend = null;
    this.mode = null;
    this._initialized = false;
    this._fallbackUsed = false;
    this._fallbackReason = null;
  }

  /**
   * 初始化适配器，自动选择后端（含降级链）
   */
  async initialize(options = {}) {
    const {
      preferredMode = process.env.ZOTERO_BACKEND || "auto",
      log = console.log,
    } = options;

    const hasWebApiConfig = Boolean(process.env.ZOTERO_API_KEY && process.env.ZOTERO_USER_ID);

    // 决定后端尝试顺序
    let backendOrder;
    if (preferredMode === "web_api" || preferredMode === "webapi") {
      backendOrder = ["web_api"];
    } else if (preferredMode === "desktop_cli" || preferredMode === "cli") {
      backendOrder = ["cli"];
    } else {
      // auto: 有 Web API 配置就优先用 Web API，否则用 CLI
      backendOrder = hasWebApiConfig ? ["web_api", "cli"] : ["cli"];
    }

    // 尝试每个后端，第一个成功的就用
    const errors = [];
    for (const targetMode of backendOrder) {
      try {
        if (targetMode === "web_api") {
          if (!hasWebApiConfig) {
            throw new Error("Web API mode requires ZOTERO_API_KEY and ZOTERO_USER_ID");
          }
          this.backend = new ZoteroWebApiBackend();
          this.mode = "web_api";
          log("[Adapter] Trying Web API backend (no desktop required)...");
        } else {
          this.backend = new ZoteroCliBackend();
          this.mode = "cli";
          log("[Adapter] Trying desktop CLI backend (Zotero desktop required)...");
        }

        // 验证连接
        const readyResult = await this.backend.ensureReady({ log });
        if (!readyResult.ok) {
          throw new Error(`Backend not ready: ${JSON.stringify(readyResult.diagnostics)}`);
        }

        // 记录降级信息
        if (errors.length > 0) {
          this._fallbackUsed = true;
          this._fallbackReason = `Previous backend failed: ${errors.map((e) => e.message).join("; ")}`;
          log(`[Adapter] Fallback to ${this.mode} backend. Reason: ${this._fallbackReason}`);
        }

        this._initialized = true;
        log(`[Adapter] Using ${this.mode} backend`);

        return {
          mode: this.mode,
          backend: this.backend.backendType,
          fallbackUsed: this._fallbackUsed,
          fallbackReason: this._fallbackReason,
          ...readyResult,
        };
      } catch (error) {
        errors.push(error);
        log(`[Adapter] ${targetMode} backend failed: ${error.message}`);
      }
    }

    // 所有后端都失败
    const errorMessage = `All Zotero backends failed: ${errors.map((e) => e.message).join("; ")}`;
    throw new Error(errorMessage);
  }

  _ensureInitialized() {
    if (!this._initialized || !this.backend) {
      throw new Error("ZoteroAdapter not initialized. Call initialize() first.");
    }
  }

  /**
   * 获取诊断信息
   */
  getDiagnostics() {
    return {
      mode: this.mode,
      backend: this.backend?.backendType || "none",
      fallbackUsed: this._fallbackUsed,
      fallbackReason: this._fallbackReason,
      initialized: this._initialized,
    };
  }

  // ─── 代理所有后端方法 ───

  get backendType() {
    return this.backend?.backendType || "none";
  }

  get supportsConcurrentReads() { return this.backend?.supportsConcurrentReads === true; }

  async ping() {
    this._ensureInitialized();
    return this.backend.ping();
  }

  async ensureReady(options = {}) {
    this._ensureInitialized();
    return this.backend.ensureReady(options);
  }

  async getCollections(options = {}) {
    this._ensureInitialized();
    return this.backend.getCollections(options);
  }

  async getSubcollections(collectionKey, recursive = false) {
    this._ensureInitialized();
    return this.backend.getSubcollections(collectionKey, recursive);
  }

  async getCollectionItems(collectionKey, options = {}) {
    this._ensureInitialized();
    return this.backend.getCollectionItems(collectionKey, options);
  }

  async ensureCollectionPath(pathArray, options = {}) {
    this._ensureInitialized();
    return this.backend.ensureCollectionPath(pathArray, options);
  }

  async createCollection(name, parentKey = null) {
    this._ensureInitialized();
    return this.backend.createCollection(name, parentKey);
  }

  async ensureWritebackCollections(options = {}) {
    this._ensureInitialized();
    return this.backend.ensureWritebackCollections(options);
  }

  async deleteCollection(collectionKey, options = {}) {
    this._ensureInitialized();
    return this.backend.deleteCollection(collectionKey, options);
  }

  async addItemsToCollection(itemKeys, collectionKey, options = {}) {
    this._ensureInitialized();
    return this.backend.addItemsToCollection(itemKeys, collectionKey, options);
  }

  async addItemsToCollections(operations, options = {}) {
    this._ensureInitialized();
    if (
      typeof this.backend.addItemsToCollections === "function"
      && this.backend.addItemsToCollections !== ZoteroBackendBase.prototype.addItemsToCollections
    ) {
      return this.backend.addItemsToCollections(operations, options);
    }
    const result = { added: [], already: [], failed: [] };
    for (const operation of Array.isArray(operations) ? operations : []) {
      const one = await this.backend.addItemsToCollection(operation.itemKeys || [], operation.collectionKey, options);
      result.added.push(...(one.added || []).map((itemKey) => ({ itemKey, collectionKey: operation.collectionKey })));
      result.failed.push(...(one.failed || []).map((failure) => ({ ...failure, collectionKey: operation.collectionKey })));
    }
    return result;
  }

  async removeItemsFromCollection(itemKeys, collectionKey, options = {}) {
    this._ensureInitialized();
    return this.backend.removeItemsFromCollection(itemKeys, collectionKey, options);
  }

  async removeItemsFromCollections(operations = [], options = {}) {
    this._ensureInitialized();
    const result = { applied: [], missing: [], failed: [] };
    for (const operation of Array.isArray(operations) ? operations : []) {
      try {
        const one = await this.backend.removeItemsFromCollection(operation.itemKeys || [], operation.collectionKey, options);
        const removed = Array.isArray(one?.removed) ? one.removed : operation.itemKeys || [];
        result.applied.push(...removed.map((itemKey) => ({
          itemKey,
          collectionKey: operation.collectionKey,
        })));
        result.failed.push(...(one?.failed || []).map((failure) => ({
          ...failure,
          collectionKey: operation.collectionKey,
        })));
      } catch (error) {
        for (const itemKey of operation.itemKeys || []) {
          result.failed.push({ itemKey, collectionKey: operation.collectionKey, error: error?.message || String(error) });
        }
      }
    }
    return result;
  }

  async verifyItemsInCollection(itemKeys, collectionKey, options = {}) {
    this._ensureInitialized();
    return this.backend.verifyItemsInCollection(itemKeys, collectionKey, options);
  }

  async moveItemsBetweenCollections(itemKeys, fromCollectionKey, toCollectionKey, options = {}) {
    this._ensureInitialized();
    return this.backend.moveItemsBetweenCollections(itemKeys, fromCollectionKey, toCollectionKey, options);
  }

  async getItemDetails(itemKey, mode = "preview") {
    this._ensureInitialized();
    return this.backend.getItemDetails(itemKey, mode);
  }

  async getItemsDetails(itemKeys = [], mode = "preview") {
    this._ensureInitialized();
    if (typeof this.backend.getItemsDetails === "function") {
      return this.backend.getItemsDetails(itemKeys, mode);
    }
    return Promise.all((Array.isArray(itemKeys) ? itemKeys : []).map((itemKey) => this.backend.getItemDetails(itemKey, mode)));
  }

  async getItems(itemKeys = [], options = {}) {
    return this.getItemsDetails(itemKeys, options.mode || "preview");
  }

  async searchLibrary(options = {}) {
    this._ensureInitialized();
    return this.backend.searchLibrary(options);
  }

  async createItem(itemData) {
    this._ensureInitialized();
    return this.backend.createItem(itemData);
  }

  async createItems(itemsData = []) {
    this._ensureInitialized();
    if (
      typeof this.backend.createItems === "function"
      && this.backend.createItems !== ZoteroBackendBase.prototype.createItems
    ) {
      return this.backend.createItems(itemsData);
    }
    const result = { created: [], failed: [] };
    const items = Array.isArray(itemsData) ? itemsData : [];
    for (let i = 0; i < items.length; i += 1) {
      try {
        const created = await this.backend.createItem(items[i]);
        result.created.push({
          inputIndex: items[i]?.inputIndex ?? i,
          key: created?.key || created?.itemKey || "",
          itemKey: created?.itemKey || created?.key || "",
          createMode: created?.createMode || "per_item_fallback",
        });
      } catch (error) {
        result.failed.push({
          inputIndex: items[i]?.inputIndex ?? i,
          error: error?.message || String(error),
        });
      }
    }
    return result;
  }

  async deleteItems(itemKeys = []) {
    this._ensureInitialized();
    if (
      typeof this.backend.deleteItems === "function"
      && this.backend.deleteItems !== ZoteroBackendBase.prototype.deleteItems
    ) {
      return this.backend.deleteItems(itemKeys);
    }
    const result = { deleted: [], failed: [] };
    for (const itemKey of Array.isArray(itemKeys) ? itemKeys : []) {
      result.failed.push({ itemKey, error: "delete_items_not_supported" });
    }
    return result;
  }

  async deleteCollections(collectionKeys = [], options = {}) {
    this._ensureInitialized();
    const keys = [...new Set((Array.isArray(collectionKeys) ? collectionKeys : [])
      .map((key) => String(key || "").trim())
      .filter(Boolean))];
    const result = { deleted: [], failed: [] };
    for (const collectionKey of keys) {
      try {
        await this.backend.deleteCollection(collectionKey, options);
        result.deleted.push(collectionKey);
      } catch (error) {
        result.failed.push({ collectionKey, error: error?.message || String(error) });
      }
    }
    return result;
  }

  async updateItem(itemKey, fields) {
    this._ensureInitialized();
    return this.backend.updateItem(itemKey, fields);
  }

  async writeTag(options) {
    this._ensureInitialized();
    return this.backend.writeTag(options);
  }

  async writeTagsBatch(operations = [], options = {}) {
    this._ensureInitialized();
    const result = { applied: [], missing: [], failed: [] };
    for (const operation of Array.isArray(operations) ? operations : []) {
      try {
        await this.backend.writeTag(operation);
        result.applied.push({ itemKey: operation.itemKey, action: operation.action || "set" });
      } catch (error) {
        result.failed.push({ itemKey: operation.itemKey, error: error?.message || String(error) });
      }
    }
    return result;
  }

  async writeMetadata(itemKey, fields) {
    this._ensureInitialized();
    return this.backend.writeMetadata(itemKey, fields);
  }

  async writeMetadataBatch(updates) {
    this._ensureInitialized();
    if (
      typeof this.backend.writeMetadataBatch === "function"
      && this.backend.writeMetadataBatch !== ZoteroBackendBase.prototype.writeMetadataBatch
    ) {
      return this.backend.writeMetadataBatch(updates);
    }
    const result = { updated: [], failed: [] };
    for (const update of Array.isArray(updates) ? updates : []) {
      try {
        await this.backend.writeMetadata(update.itemKey, update.fields || {});
        result.updated.push(update.itemKey);
      } catch (error) {
        result.failed.push({ itemKey: update.itemKey, error: error?.message || String(error) });
      }
    }
    return result;
  }
}

/**
 * 获取全局适配器实例（单例模式）
 */
export async function getZoteroAdapter(options = {}) {
  if (!_adapterInstance) {
    _adapterInstance = new ZoteroAdapter();
    await _adapterInstance.initialize(options);
  }
  return _adapterInstance;
}

/**
 * 重置全局适配器实例（用于测试）
 */
export function resetZoteroAdapter() {
  _adapterInstance = null;
}

export default {
  ZoteroAdapter,
  getZoteroAdapter,
  resetZoteroAdapter,
};
