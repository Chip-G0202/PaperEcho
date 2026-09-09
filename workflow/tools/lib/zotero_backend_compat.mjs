/**
 * Zotero Backend Compatibility Layer
 *
 * 提供 mcpToolCall 兼容接口，使现有代码可以通过适配层访问 Zotero。
 *
 * 使用方法：
 *   import { createCompatMcpToolCall } from "./lib/zotero_backend_compat.mjs";
 *   const mcpToolCall = await createCompatMcpToolCall();
 *   const result = await mcpToolCall("get_collections", { mode: "complete", limit: 1000 }, 1);
 *
 * 返回格式与原有 mcpToolCall 一致：
 *   { content: [{ text: "..." }] }
 */

import { getZoteroAdapter } from "./zotero_adapter.mjs";
import { throwIfWorkflowCanceled } from "./workflow_cancellation.mjs";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeCollectionTree(collections, parentKey = null) {
  const list = asArray(collections);
  if (list.some((node) => Array.isArray(node?.subcollections) || Array.isArray(node?.children))) {
    return list.map((node) => ({
      ...node,
      subcollections: normalizeCollectionTree(node.subcollections || node.children || [], node.key),
    }));
  }

  const byKey = new Map();
  for (const collection of list) {
    if (!collection?.key) continue;
    byKey.set(collection.key, { ...collection, subcollections: [] });
  }
  const roots = [];
  for (const node of byKey.values()) {
    const parent = node.parentCollection || node.parent || false;
    if (parent && byKey.has(parent)) {
      byKey.get(parent).subcollections.push(node);
    } else if (!parentKey || parent === parentKey) {
      roots.push(node);
    }
  }
  return roots;
}

function normalizeWriteItemResult(result, args) {
  const itemKey = result?.data?.itemKey || result?.itemKey || result?.key || "";
  return {
    ok: Boolean(itemKey),
    data: {
      itemKey,
      key: itemKey,
      itemType: args?.itemType || result?.itemType || "",
    },
    itemKey,
    key: itemKey,
    raw: result,
  };
}

function itemDataFromWriteArgs(args = {}, inputIndex = null) {
  return {
    inputIndex,
    itemType: args.itemType,
    ...(args.fields || {}),
    tags: args.tags || [],
    collections: args.collections || [],
  };
}

/**
 * MCP 操作名到适配器方法的映射
 */
const MCP_TO_ADAPTER = {
  get_collections: (adapter, args) => adapter.getCollections(args),
  create_collection: (adapter, args) => adapter.createCollection(args.name, args.parentCollection || null),
  get_subcollections: async (adapter, args) => {
    const result = await adapter.getSubcollections(args.collectionKey, args.recursive || false);
    return args.recursive ? normalizeCollectionTree(result, args.collectionKey) : result;
  },
  get_collection_items: (adapter, args) => adapter.getCollectionItems(args.collectionKey, args),
  get_item_details: (adapter, args) => adapter.getItemDetails(args.itemKey, args.mode || "preview"),
  get_items_details: (adapter, args) => adapter.getItemsDetails(args.itemKeys || [], args.mode || "preview"),
  search_library: (adapter, args) => adapter.searchLibrary(args),
  ensure_writeback_collections: (adapter, args) => adapter.ensureWritebackCollections(args),
  add_items_to_collection: (adapter, args) => adapter.addItemsToCollection(args.itemKeys, args.collectionKey, { verify: false }),
  add_items_to_collections: (adapter, args) => adapter.addItemsToCollections(args.operations || [], { verify: false }),
  remove_items_from_collection: (adapter, args) => adapter.removeItemsFromCollection(args.itemKeys, args.collectionKey, { verify: false }),
  write_tag: (adapter, args) => adapter.writeTag(args),
  write_item: (adapter, args) => {
    if (args.itemKey) {
      const { itemKey, ...fields } = args;
      return adapter.updateItem(itemKey, fields);
    }
    const itemData = itemDataFromWriteArgs(args);
    return adapter.createItem(itemData).then((result) => normalizeWriteItemResult(result, args));
  },
  write_items: async (adapter, args) => {
    const requests = Array.isArray(args?.items) ? args.items : [];
    const itemsData = requests.map((request, index) => itemDataFromWriteArgs(request, request.inputIndex ?? index));
    const results = await adapter.createItems(itemsData);
    // Convert array to { created, failed } format expected by writeback_execution
    const created = [];
    const failed = [];
    for (const result of results) {
      if (result.key && !result.error) {
        created.push({ inputIndex: result.inputIndex, itemKey: result.key, key: result.key });
      } else {
        failed.push({ inputIndex: result.inputIndex, error: result.error || "create_failed" });
      }
    }
    return { created, failed };
  },
  delete_items: (adapter, args) => adapter.deleteItems(args.itemKeys || []),
  write_metadata: (adapter, args) => adapter.writeMetadata(args.itemKey, args.fields || args),
  write_metadata_batch: (adapter, args) => adapter.writeMetadataBatch(args.updates || []),
  delete_collection: (adapter, args) => adapter.deleteCollection(args.collectionKey, args),
};

/**
 * 创建兼容的 mcpToolCall 函数
 *
 * @param {Object} options
 * @param {Object} options.adapterOptions - 传递给 adapter.initialize() 的选项
 * @returns {Promise<Function>} mcpToolCall 兼容函数
 */
export async function createCompatMcpToolCall(options = {}) {
  const adapter = await getZoteroAdapter(options.adapterOptions || {});

  /**
   * mcpToolCall 兼容函数
   *
   * @param {string} name - MCP 操作名
   * @param {Object} args - 操作参数
   * @param {number} id - 调用 ID
   * @returns {Promise<{content: [{text: string}]}>} 与原 mcpToolCall 格式一致
   */
  async function mcpToolCall(name, args, id) {
    throwIfWorkflowCanceled();
    const handler = MCP_TO_ADAPTER[name];
    if (!handler) {
      throw new Error(`Unknown MCP operation: ${name}`);
    }

    const result = await handler(adapter, args);

    // 包装为原 mcpToolCall 返回格式
    return {
      content: [{ text: JSON.stringify(result) }],
    };
  }

  // 附加适配器信息
  mcpToolCall.adapter = adapter;
  mcpToolCall.backendType = adapter.backendType;
  mcpToolCall.readConcurrencySafe = adapter.supportsConcurrentReads === true;

  return mcpToolCall;
}

/**
 * 创建带 verify 的 mcpToolCall 版本
 * collection 操作会自动 verify
 */
export async function createVerifiedMcpToolCall(options = {}) {
  const adapter = await getZoteroAdapter(options.adapterOptions || {});

  const VERIFIED_MCP_TO_ADAPTER = {
    ...MCP_TO_ADAPTER,
    add_items_to_collection: (adapter, args) => adapter.addItemsToCollection(args.itemKeys, args.collectionKey, { verify: true }),
    add_items_to_collections: (adapter, args) => adapter.addItemsToCollections(args.operations || [], { verify: true }),
    remove_items_from_collection: (adapter, args) => adapter.removeItemsFromCollection(args.itemKeys, args.collectionKey, { verify: true }),
  };

  async function mcpToolCall(name, args, id) {
    throwIfWorkflowCanceled();
    const handler = VERIFIED_MCP_TO_ADAPTER[name];
    if (!handler) {
      throw new Error(`Unknown MCP operation: ${name}`);
    }

    const result = await handler(adapter, args);
    return { content: [{ text: JSON.stringify(result) }] };
  }

  mcpToolCall.adapter = adapter;
  mcpToolCall.backendType = adapter.backendType;

  return mcpToolCall;
}

export default {
  createCompatMcpToolCall,
  createVerifiedMcpToolCall,
};
