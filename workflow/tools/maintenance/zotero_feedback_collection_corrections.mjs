import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeTitleForExistingDedupe } from "../lib/literature_identity.mjs";
import { enrichmentAbort, withZoteroLookupSignal } from "../lib/zotero_lookup_scope.mjs";
import { buildRuntimeConfig } from "../lib/runtime_config.mjs";
import { parseToolText } from "../lib/writeback_support.mjs";
import {
  getDefaultZoteroLibraryIndexPath,
  readZoteroLibraryIndex,
} from "../lib/zotero_library_index_store.mjs";
import { ensureZoteroBackendReady } from "../lib/ensure_zotero_backend_ready.mjs";
import { createCompatMcpToolCall } from "../lib/zotero_backend_compat.mjs";
import {
  buildZoteroCollectionGuard,
  recordCollectionScopeBlock,
  summarizeCollectionScopeBlocks,
} from "../lib/zotero_collection_guard.mjs";
import {
  buildMovePlan,
  scanFeedbackRows,
  scanLiteratureRecords,
} from "./archive_history_by_feedback.mjs";

const ROOT_COLLECTION = "文献池";
const OLD_ARCHIVE_COLLECTION = "历史反馈归档";
const DELETE_REVIEW_COLLECTION = "待删除";
const LEVELS = ["A课题相关", "B专题相关", "C领域相关", "D无关"];
const MAX_ZOTERO_SEARCH_QUERY_LENGTH = 300;

function cleanText(value) {
  return String(value || "").trim();
}

export function sanitizeZoteroSearchQuery(input) {
  return cleanText(input)
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, " ")
    .replace(/[αΑ]/g, "alpha")
    .replace(/[βΒ]/g, "beta")
    .replace(/[γΓ]/g, "gamma")
    .replace(/[δΔ]/g, "delta")
    .replace(/[κΚ]/g, "kappa")
    .replace(/[λΛ]/g, "lambda")
    .replace(/[μΜ]/g, "mu")
    .replace(/[ωΩ]/g, "omega")
    .replace(/[\u2010-\u2015\u2212\uff0d]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B\u02BC\u2032\uff07]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\uff02]/g, '"')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ZOTERO_SEARCH_QUERY_LENGTH)
    .trim();
}

function hasNonAscii(value) {
  return /[^\x00-\x7F]/.test(String(value || ""));
}

function isMcpParseError(error) {
  const raw = String(error?.message || error || "");
  return /"code"\s*:\s*-32700/.test(raw) || /parse error/i.test(raw);
}

function shortQueryPreview(value) {
  return cleanText(value).slice(0, 80);
}

function shortErrorSummary(error) {
  return String(error?.message || error || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function buildTokenFallbackQuery(value) {
  const tokens = sanitizeZoteroSearchQuery(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 3)
    .slice(0, 12);
  return tokens.join(" ").slice(0, 180).trim();
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function writeCsv(filePath, rows, headers) {
  const text = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${text}\n`, "utf8");
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function defaultMcpToolCall(name, args, id) {
  if (!defaultMcpToolCall.backendToolCall) {
    defaultMcpToolCall.backendToolCall = await createCompatMcpToolCall();
  }
  return defaultMcpToolCall.backendToolCall(name, args, id);
}

async function ensureMcpReady(mcpToolCall) {
  return ensureZoteroBackendReady();
}

function collectionKey(collection) {
  return collection?.key || collection?.collectionKey || "";
}

function parentKey(collection) {
  return collection?.parentCollection || collection?.parent || false;
}

function collectionName(collection) {
  return cleanText(collection?.name);
}

function childrenOf(collections, parent) {
  return collections.filter((collection) => parentKey(collection) === parent);
}

function findTopCollection(collections, name) {
  return collections.find((collection) => collectionName(collection) === name && !parentKey(collection)) || null;
}

function findChild(collections, parent, name) {
  const key = collectionKey(parent);
  return collections.find((collection) => parentKey(collection) === key && collectionName(collection) === name) || null;
}

function findGradeCollection(collections, date, level, rootName = ROOT_COLLECTION) {
  const root = findTopCollection(collections, rootName);
  if (!root) return null;
  const dateCollection = findChild(collections, root, date);
  if (!dateCollection) return null;
  return findChild(collections, dateCollection, level);
}

function findDeleteReviewCollection(collections, rootName = ROOT_COLLECTION) {
  const root = findTopCollection(collections, rootName);
  if (!root) return null;
  return findChild(collections, root, DELETE_REVIEW_COLLECTION);
}

function descendantsDepthFirst(collections, root) {
  const out = [];
  function visit(node, depth) {
    for (const child of childrenOf(collections, collectionKey(node))) visit(child, depth + 1);
    out.push({ collection: node, depth });
  }
  visit(root, 0);
  return out.sort((a, b) => b.depth - a.depth).map((x) => x.collection);
}

function flattenCollections(collections) {
  const out = [];
  function visit(collection) {
    out.push(collection);
    for (const child of Array.isArray(collection?.subcollections) ? collection.subcollections : []) visit(child);
  }
  for (const collection of Array.isArray(collections) ? collections : []) visit(collection);
  return out;
}

function normalizeItemKey(value) {
  return cleanText(value).toUpperCase();
}

function feedbackAction(entry) {
  return cleanText(entry.feedback?.feedback).toLowerCase();
}

function normalizeLevel(value) {
  const text = cleanText(value);
  if (!text) return "";
  if (LEVELS.includes(text)) return text;
  const upper = text.toUpperCase();
  if (upper === "A") return "A课题相关";
  if (upper === "B") return "B专题相关";
  if (upper === "C") return "C领域相关";
  if (upper === "D") return "D无关";
  if (text.includes("课题")) return "A课题相关";
  if (text.includes("专题")) return "B专题相关";
  if (text.includes("领域")) return "C领域相关";
  if (text.includes("无关")) return "D无关";
  return "";
}

function levelFromFeedbackAction(action, currentLevel) {
  const current = normalizeLevel(currentLevel);
  const idx = LEVELS.indexOf(current);
  if (action === "keep") return current;
  if (action === "drop") return "D无关";
  if (action === "upgrade") return idx > 0 ? LEVELS[idx - 1] : current || "";
  if (action === "downgrade") return idx >= 0 && idx < LEVELS.length - 1 ? LEVELS[idx + 1] : "";
  return "";
}

function isDropAction(entry) {
  return feedbackAction(entry) === "drop" || entry.assigned_level === "D无关";
}

function baseAction(entry) {
  return {
    itemKey: normalizeItemKey(entry.record?.itemKey),
    title: entry.record?.title || entry.feedback?.title || "",
    date: entry.date || "",
    feedback_action: feedbackAction(entry),
    original_level: entry.original_level || "",
    assigned_level: entry.assigned_level || "",
    feedback_source: entry.feedback_source || "",
    feedback_row: entry.feedback_row || "",
    match_method: entry.match_method || "",
    match_key: entry.match_key || "",
    source_path: entry.source_path || "",
  };
}

function correctionActionForEntry(entry, collections) {
  const base = baseAction(entry);
  if (entry.status !== "planned") return { ...base, status: entry.status || "needs_review", action: "manual_review", reason: entry.reason || entry.conflict_category || "not_auto_plannable" };
  if (!base.itemKey) return { ...base, status: "needs_review", action: "manual_review", reason: "item_key_missing" };
  if (feedbackAction(entry) === "keep" || entry.assigned_level === entry.original_level) {
    return { ...base, status: "no_op", action: "keep_no_change", reason: "" };
  }
  const source = findGradeCollection(collections, entry.date, entry.original_level);
  if (isDropAction(entry)) {
    return {
      ...base,
      status: "drop_manual_delete_required",
      action: "manual_delete_zotero_item",
      reason: "zotero_item_delete_tool_unverified",
      source_collection_key: collectionKey(source),
      target_collection_key: "",
      source_collection_role: "grade",
    };
  }
  if (!source) return { ...base, status: "needs_review", action: "manual_review", reason: "source_grade_collection_missing" };
  const target = findGradeCollection(collections, entry.date, entry.assigned_level);
  if (!target) return { ...base, status: "needs_review", action: "manual_review", reason: "target_grade_collection_missing", source_collection_key: collectionKey(source) };
  return {
    ...base,
    status: "planned",
    action: "move_between_grade_collections",
    source_collection_key: collectionKey(source),
    target_collection_key: collectionKey(target),
    source_collection_role: "grade",
  };
}

function blockAction(action, check, blocks, extra = {}) {
  recordCollectionScopeBlock(blocks, check, { itemKey: action.itemKey || "", phase: "feedback_correction_plan", ...extra });
  action.status = "collection_scope_blocked";
  action.reason = check.reason || "collection_scope_blocked";
  return action;
}

function applyCollectionGuardToAction(action, collectionGuard, blocks) {
  if (!collectionGuard || action.status !== "planned") return action;
  if (action.action === "move_between_grade_collections") {
    const target = collectionGuard.checkCollectionKey(action.target_collection_key, { action: "add_items_to_collection", role: "target_grade" });
    if (!target.ok) return blockAction(action, target, blocks);
    const source = collectionGuard.checkCollectionKey(action.source_collection_key, { action: "remove_items_from_collection", role: "source_grade" });
    if (!source.ok) return blockAction(action, source, blocks);
  }
  if (action.action === "move_drop_to_delete_review_collection") {
    if (action.target_collection_key) {
      const target = collectionGuard.checkCollectionKey(action.target_collection_key, { action: "add_items_to_collection", role: "delete_review_target" });
      if (!target.ok) return blockAction(action, target, blocks);
    }
    if (action.source_collection_key) {
      const source = collectionGuard.checkCollectionKey(action.source_collection_key, { action: "remove_items_from_collection", role: "source_grade" });
      if (!source.ok) return blockAction(action, source, blocks);
    }
  }
  if (action.action === "delete_old_archive_collection") {
    const target = collectionGuard.checkCollectionKey(action.collection_key, { action: "delete_collection", role: "cleanup_target" });
    if (!target.ok) return blockAction(action, target, blocks);
  }
  return action;
}

export function buildCorrectionPlan({
  archivePlan = [],
  collections = [],
  includeArchiveCleanup = true,
  dropMode = "manual",
  collectionGuard = null,
  collectionScopeBlocks = null,
} = {}) {
  const actions = archivePlan.map((entry) => {
    const action = correctionActionForEntry(entry, collections);
    if (dropMode === "quarantine" && action.status === "drop_manual_delete_required") {
      const target = findDeleteReviewCollection(collections);
      const nextAction = {
        ...action,
        status: "planned",
        action: "move_drop_to_delete_review_collection",
        reason: "drop_quarantine_before_manual_delete",
        target_collection_key: collectionKey(target),
        target_collection_name: DELETE_REVIEW_COLLECTION,
      };
      const existingDeleteKeys = collectionGuard?.specialNameToKeys?.[DELETE_REVIEW_COLLECTION] || [];
      if (!target && existingDeleteKeys.length > 0) {
        return blockAction(nextAction, {
          ok: false,
          reason: existingDeleteKeys.length > 1 ? "special_collection_ambiguous" : "delete_review_collection_not_under_pool",
          action: "create_collection",
          role: "delete_review_target",
          collectionKey: existingDeleteKeys.join(","),
          collectionName: DELETE_REVIEW_COLLECTION,
        }, Array.isArray(collectionScopeBlocks) ? collectionScopeBlocks : []);
      }
      return nextAction;
    }
    return action;
  });
  const oldRoot = findTopCollection(collections, OLD_ARCHIVE_COLLECTION);
  const cleanupActions = oldRoot && includeArchiveCleanup
    ? descendantsDepthFirst(collections, oldRoot).map((collection) => ({
      status: "planned",
      action: "delete_old_archive_collection",
      collection_key: collectionKey(collection),
      collection_name: collectionName(collection),
      deleteItems: false,
    }))
    : [];
  const blocks = Array.isArray(collectionScopeBlocks) ? collectionScopeBlocks : [];
  for (const action of actions) applyCollectionGuardToAction(action, collectionGuard, blocks);
  for (const action of cleanupActions) applyCollectionGuardToAction(action, collectionGuard, blocks);
  return {
    actions,
    cleanup_actions: cleanupActions,
    ...(collectionGuard?.audit || {}),
    ...summarizeCollectionScopeBlocks(blocks),
  };
}

function levelFromZoteroDetails(details = {}) {
  for (const tag of Array.isArray(details.tags) ? details.tags : []) {
    const value = typeof tag === "string" ? tag : tag?.tag;
    const level = normalizeLevel(value);
    if (level) return level;
  }
  return "";
}

function normalizeLocalTitle(value) {
  return normalizeTitleForExistingDedupe(value);
}

function resolveZoteroTitleMatchFromLocalIndex(feedback, localLibraryIndex) {
  const title = cleanText(feedback?.english_title || feedback?.title || feedback?.translated_title);
  if (!title || !localLibraryIndex?.live_items) return null;
  const target = normalizeLocalTitle(title);
  if (!target) return null;
  const hits = Object.values(localLibraryIndex.live_items || {}).filter((item) => normalizeLocalTitle(item.title) === target);
  const diagnostics = {
    original_query_had_unicode: hasNonAscii(title),
    original_query_length: title.length,
    sanitized_query_used: false,
    sanitized_retry_reason: "",
    sanitized_query_length: sanitizeZoteroSearchQuery(title).length,
    sanitized_query_truncated: sanitizeZoteroSearchQuery(title).length < cleanText(title).length,
    shortened_query_used: false,
    fallback_used: "local_zotero_index",
    query_preview: shortQueryPreview(title),
  };
  if (hits.length !== 1) return { status: hits.length > 1 ? "ambiguous" : "missing", title, hits: hits.length, hitItems: hits, query_diagnostics: diagnostics };
  const item = hits[0];
  return { status: "matched", title, itemKey: item.itemKey, details: item, query_diagnostics: diagnostics };
}

async function resolveZoteroTitleMatch(feedback, mcpToolCall, id, { localLibraryIndex = null } = {}) {
  const title = cleanText(feedback?.english_title || feedback?.title || feedback?.translated_title);
  if (!title) return null;
  const localMatch = resolveZoteroTitleMatchFromLocalIndex(feedback, localLibraryIndex);
  if (localMatch?.status === "matched" || localMatch?.status === "ambiguous") return localMatch;
  const originalQueryHadUnicode = hasNonAscii(title);
  const sanitizedTitle = sanitizeZoteroSearchQuery(title);
  const diagnostics = {
    original_query_had_unicode: originalQueryHadUnicode,
    original_query_length: title.length,
    sanitized_query_used: false,
    sanitized_retry_reason: "",
    sanitized_query_length: sanitizedTitle.length,
    sanitized_query_truncated: sanitizedTitle.length < cleanText(title).length,
    shortened_query_used: false,
    fallback_used: "",
    query_preview: shortQueryPreview(title),
  };
  let resultPayload;
  try {
    resultPayload = await mcpToolCall("search_library", { title, titleOperator: "exact", limit: 5, mode: "preview" }, id);
  } catch (error) {
    if (!isMcpParseError(error)) throw error;
    diagnostics.error_code = "-32700";
    diagnostics.error_summary = shortErrorSummary(error);
    if (!sanitizedTitle || sanitizedTitle === title) {
      return { status: "missing", title, hits: 0, query_diagnostics: { ...diagnostics, fallback_used: "skip_after_parse_error" } };
    }
    diagnostics.sanitized_query_used = true;
    diagnostics.sanitized_retry_reason = "mcp_parse_error";
    diagnostics.sanitized_query_preview = shortQueryPreview(sanitizedTitle);
    diagnostics.fallback_used = "sanitized";
    try {
      resultPayload = await mcpToolCall("search_library", { title: sanitizedTitle, titleOperator: "exact", limit: 5, mode: "preview" }, id + 2);
    } catch (sanitizedError) {
      if (!isMcpParseError(sanitizedError)) throw sanitizedError;
      const tokenQuery = buildTokenFallbackQuery(sanitizedTitle);
      diagnostics.sanitized_error_summary = shortErrorSummary(sanitizedError);
      diagnostics.shortened_query_length = tokenQuery.length;
      diagnostics.shortened_query_preview = shortQueryPreview(tokenQuery);
      if (!tokenQuery || tokenQuery === sanitizedTitle) {
        return { status: "missing", title, hits: 0, query_diagnostics: { ...diagnostics, fallback_used: "skip_after_parse_error" } };
      }
      diagnostics.shortened_query_used = true;
      diagnostics.fallback_used = "shortened";
      try {
        resultPayload = await mcpToolCall("search_library", { title: tokenQuery, titleOperator: "exact", limit: 5, mode: "preview" }, id + 4);
      } catch (tokenError) {
        if (!isMcpParseError(tokenError)) throw tokenError;
        return {
          status: "missing",
          title,
          hits: 0,
          query_diagnostics: {
            ...diagnostics,
            token_error_summary: shortErrorSummary(tokenError),
            fallback_used: "skip_after_parse_error",
          },
        };
      }
    }
  }
  const result = parseToolText(resultPayload);
  if (result?.error) throw new Error("feedback_title_search_failed");
  const candidates = Array.isArray(result?.results) ? result.results : Array.isArray(result) ? result : null;
  if (!candidates) throw new Error("feedback_title_search_invalid_response");
  const hits = candidates.map((hit) => ({ ...hit, ...(hit.data || {}) })).filter((hit) =>
    normalizeLocalTitle(hit.title) === normalizeLocalTitle(title) ||
    sanitizeZoteroSearchQuery(hit.title).toLowerCase() === sanitizedTitle.toLowerCase());
  // A capped response cannot prove uniqueness, even if only one returned hit is exact.
  if (candidates.length >= 5) return { status: "ambiguous", title, hits: hits.length, hitItems: [], query_diagnostics: diagnostics };
  if (hits.length !== 1) return { status: hits.length > 1 ? "ambiguous" : "missing", title, hits: hits.length, hitItems: hits, query_diagnostics: diagnostics };
  const itemKey = normalizeItemKey(hits[0].key || hits[0].itemKey);
  if (!itemKey) return { status: "missing", title, hits: hits.length, query_diagnostics: diagnostics };
  const details = levelFromZoteroDetails(hits[0]) ? hits[0] : parseToolText(await mcpToolCall("get_item_details", { itemKey, mode: "complete" }, id + 1));
  return { status: "matched", title, itemKey, details, query_diagnostics: diagnostics };
}

async function zoteroItemExists(itemKey, mcpToolCall, id, { localLibraryIndex = null } = {}) {
  if (!itemKey) return false;
  if (localLibraryIndex?.live_items?.[itemKey]) return true;
  const result = parseToolText(await mcpToolCall("get_item_details", { itemKey, mode: "preview" }, id));
  return !String(result?.error || "").match(/not found/i);
}

export async function enrichArchivePlanWithZoteroTitleMatches(archivePlan, {
  mcpToolCall = defaultMcpToolCall, localLibraryIndex = null, localIndexPath = "",
  timeoutMs = Number(process.env.PAPERECHO_FEEDBACK_ENRICHMENT_TIMEOUT_MS || 1800000),
  signal, onProgress = async () => {}, heartbeatMs = 10000,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid_feedback_enrichment_timeout");
  const controller = new AbortController();
  const started = Date.now();
  const progress = { phase: "feedback_item_actions.enrichArchivePlanWithZoteroTitleMatches", status: "running", startedAt: new Date(started).toISOString(), total: archivePlan.length, totalPlanItems: archivePlan.length, localResolved: 0, remoteRequired: 0, uniqueRemoteQueries: 0, completed: 0, remaining: archivePlan.length, matched: 0, noMatch: 0, ambiguous: 0, errors: 0, cacheHits: 0, remoteRequests: 0, enumeration: "unavailable_no_verified_adapter_contract", concurrency: 1 };
  let writes = Promise.resolve();
  const publish = () => {
    const snapshot = { ...progress, remaining: Math.max(0, progress.total - progress.completed), elapsedMs: Date.now() - started, lastProgressAt: new Date().toISOString() };
    writes = writes.then(() => onProgress(snapshot));
    return writes;
  };
  const interrupt = () => controller.abort(enrichmentAbort("interrupted"));
  const message = (value) => { if (value?.type === "paperecho_cancel") controller.abort(enrichmentAbort(value.status === "timed_out" ? "timed_out" : "interrupted")); };
  signal?.addEventListener("abort", interrupt, { once: true });
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  process.on("message", message);
  if (signal?.aborted) interrupt();
  const deadline = setTimeout(() => controller.abort(enrichmentAbort("timed_out")), timeoutMs);
  const heartbeat = setInterval(() => { publish().catch(() => controller.abort(enrichmentAbort("failed"))); }, Math.max(5, heartbeatMs));
  const checkAbort = () => controller.signal.throwIfAborted();
  const queries = new Set();
  const calls = new Map();
  const call = async (name, args, id) => {
    checkAbort();
    const key = name === "search_library" ? `${name}:${String(args.title || args.query || "").trim().toLowerCase()}` : name === "get_item_details" ? `${name}:${args.itemKey}` : "";
    if (key && calls.has(key)) { progress.cacheHits++; return calls.get(key); }
    progress.remoteRequests++;
    if (name === "search_library") queries.add(normalizeLocalTitle(args.title));
    progress.uniqueRemoteQueries = queries.size;
    const result = await withZoteroLookupSignal(controller.signal, () => mcpToolCall(name, args, id));
    checkAbort();
    const parsed = parseToolText(result);
    if (parsed?.error && !/not found/i.test(String(parsed.error))) throw new Error("feedback_lookup_backend_error");
    if (key) calls.set(key, result);
    return result;
  };
  let abortListener;
  try {
    await publish();
    if (!localLibraryIndex) {
      const read = await readZoteroLibraryIndex(localIndexPath || getDefaultZoteroLibraryIndexPath(process.env.ZOTERO_PROJECT_ROOT || process.cwd()));
      localLibraryIndex = read.usable ? read.index : { live_items: {} };
    }
    for (const entry of archivePlan) {
      const titleMatch = resolveZoteroTitleMatchFromLocalIndex(entry.feedback, localLibraryIndex);
      const knownKey = localLibraryIndex.live_items?.[normalizeItemKey(entry.record?.itemKey)];
      if (!knownKey && titleMatch?.status !== "matched" && titleMatch?.status !== "ambiguous") progress.remoteRequired++;
    }
    await publish();
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
    });
    await Promise.race([enrichArchivePlanRows(archivePlan, { mcpToolCall: call, localLibraryIndex, progress, checkAbort, resolvedCache: new Map() }), aborted]);
    checkAbort();
    progress.status = "completed";
    await publish();
    return archivePlan;
  } catch (error) {
    progress.status = controller.signal.aborted ? controller.signal.reason.status : "failed";
    progress.errors++;
    await publish();
    throw Object.assign(error, { code: "FEEDBACK_ENRICHMENT_INCOMPLETE", status: progress.status, progress: { ...progress }, noCorrectionSideEffects: true });
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    controller.signal.removeEventListener("abort", abortListener);
    signal?.removeEventListener("abort", interrupt);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("message", message);
  }
}

async function enrichArchivePlanRows(archivePlan, { mcpToolCall, localLibraryIndex = null, localIndexPath = "", progress, checkAbort, resolvedCache }) {
  let effectiveLocalIndex = localLibraryIndex;
  if (!effectiveLocalIndex) {
    const read = await readZoteroLibraryIndex(localIndexPath || getDefaultZoteroLibraryIndexPath(process.env.ZOTERO_PROJECT_ROOT || process.cwd()));
    if (read.usable) effectiveLocalIndex = read.index;
  }
  let seq = 0;
  const additions = [];
  for (const entry of archivePlan || []) {
    checkAbort();
    try {
    if (entry._zotero_title_expanded) continue;
    const currentItemKey = normalizeItemKey(entry.record?.itemKey);
    let staleItemKey = false;
    if (entry.status === "planned" && currentItemKey) {
      try {
        staleItemKey = !(await zoteroItemExists(currentItemKey, mcpToolCall, 894000 + seq * 5, { localLibraryIndex: effectiveLocalIndex }));
      } catch (error) {
        throw error;
      }
    }
    const missingItemKey = entry.status === "planned" && !entry.record?.itemKey;
    const unmatched = entry.status === "needs_review" && entry.reason === "no_matching_literature_record";
    const duplicateLocalMatches = entry.status === "conflict" && entry.conflict_category === "one_feedback_multiple_literature";
    if (!missingItemKey && !staleItemKey && !unmatched && !duplicateLocalMatches) continue;
    const lookupKey = normalizeLocalTitle(entry.feedback?.english_title || entry.feedback?.title || entry.feedback?.translated_title);
    let resolved;
    if (resolvedCache.has(lookupKey)) {
      progress.cacheHits++;
      resolved = resolvedCache.get(lookupKey);
    } else {
      resolved = await resolveZoteroTitleMatch(entry.feedback, mcpToolCall, 895000 + seq * 5, { localLibraryIndex: effectiveLocalIndex });
      checkAbort();
      if (resolved?.query_diagnostics?.fallback_used === "skip_after_parse_error") throw new Error("feedback_title_query_unresolved_parse_error");
      resolvedCache.set(lookupKey, resolved);
    }
    if (resolved?.query_diagnostics?.fallback_used === "local_zotero_index") progress.localResolved++;
    if (resolved?.status === "matched") progress.matched++;
    else if (resolved?.status === "ambiguous") progress.ambiguous++;
    else progress.noMatch++;
    seq += 1;
    if (resolved?.query_diagnostics) entry.zotero_title_query_diagnostics = resolved.query_diagnostics;
    if (!resolved || resolved.status !== "matched") {
      if (resolved?.status === "ambiguous") {
        entry.status = "conflict";
        entry.reason = "ambiguous_zotero_title_match";
        entry.conflict_category = "ambiguous_title_match";
        entry.unresolved_reason = "ambiguous_title_match";
      }
      continue;
    }
    const originalLevel = entry.original_level || levelFromZoteroDetails(resolved.details);
    const action = feedbackAction(entry);
    const assignedLevel = entry.assigned_level && entry.assigned_level !== "needs_review"
      ? entry.assigned_level
      : levelFromFeedbackAction(action, originalLevel);
    if (!originalLevel || !assignedLevel) {
      entry.reason = "zotero_title_match_without_level";
      entry.unresolved_reason = "insufficient_level_evidence";
      entry.record = { ...(entry.record || {}), itemKey: resolved.itemKey, title: resolved.details?.title || resolved.title };
      continue;
    }
    entry.status = "planned";
    entry.reason = staleItemKey ? "stale_item_key_replaced_by_english_title" : "zotero_item_resolved_by_english_title";
    entry.match_method = "zotero_title_exact";
    entry.match_key = resolved.title;
    entry.zotero_title_query_diagnostics = resolved.query_diagnostics || null;
    entry.confidence = 0.95;
    entry.original_level = originalLevel;
    entry.assigned_level = assignedLevel;
    entry.source_path = entry.source_path || `zotero:${resolved.itemKey}`;
    entry.record = {
      ...(entry.record || {}),
      title: resolved.details?.title || resolved.title,
      itemKey: resolved.itemKey,
      record_key: `zotero:${resolved.itemKey}`,
      source_kind: "zotero_mcp_search_library",
    };
    } finally { progress.completed++; }
  }
  archivePlan.push(...additions);
  return archivePlan;
}

export async function applyCorrectionPlan(plan, {
  mcpToolCall = defaultMcpToolCall,
  applyMovesAndCleanup = true,
  applyDropQuarantine = false,
  collectionGuard = null,
  collectionScopeBlocks = null,
} = {}) {
  const locallyCreatedAllowedCollectionKeys = new Set();
  if (applyMovesAndCleanup) {
    for (const action of plan.actions || []) {
      if (action.status !== "planned" || action.action !== "move_between_grade_collections") continue;
      try {
        if (collectionGuard) {
          const target = collectionGuard.checkCollectionKey(action.target_collection_key, { action: "add_items_to_collection", role: "target_grade" });
          if (!target.ok) {
            recordCollectionScopeBlock(collectionScopeBlocks, target, { itemKey: action.itemKey || "", phase: "feedback_correction_apply" });
            action.status = "collection_scope_blocked";
            action.reason = target.reason;
            continue;
          }
          const source = collectionGuard.checkCollectionKey(action.source_collection_key, { action: "remove_items_from_collection", role: "source_grade" });
          if (!source.ok) {
            recordCollectionScopeBlock(collectionScopeBlocks, source, { itemKey: action.itemKey || "", phase: "feedback_correction_apply" });
            action.status = "collection_scope_blocked";
            action.reason = source.reason;
            continue;
          }
        }
        await mcpToolCall("add_items_to_collection", { collectionKey: action.target_collection_key, itemKeys: [action.itemKey] }, 870000);
        await mcpToolCall("remove_items_from_collection", { collectionKey: action.source_collection_key, itemKeys: [action.itemKey] }, 870001);
        action.status = "moved";
      } catch (error) {
        action.status = "error";
        action.error = String(error?.message || error);
      }
    }
    for (const action of plan.cleanup_actions || []) {
      if (action.status !== "planned" || action.action !== "delete_old_archive_collection") continue;
      try {
        if (collectionGuard) {
          const target = collectionGuard.checkCollectionKey(action.collection_key, { action: "delete_collection", role: "cleanup_target" });
          if (!target.ok) {
            recordCollectionScopeBlock(collectionScopeBlocks, target, { phase: "feedback_correction_apply" });
            action.status = "collection_scope_blocked";
            action.reason = target.reason;
            continue;
          }
        }
        await mcpToolCall("delete_collection", { collectionKey: action.collection_key, deleteItems: false }, 880000);
        action.status = "deleted_collection_only";
      } catch (error) {
        action.status = "collection_cleanup_required";
        action.error = String(error?.message || error);
      }
    }
  }
  if (applyDropQuarantine) {
    let deleteReviewCollectionKey = "";
    for (const action of plan.actions || []) {
      if (action.status === "planned" && action.action === "move_drop_to_delete_review_collection" && action.target_collection_key) {
        deleteReviewCollectionKey = action.target_collection_key;
        break;
      }
    }
    if (!deleteReviewCollectionKey) {
      const existingDeleteKeys = collectionGuard?.specialNameToKeys?.[DELETE_REVIEW_COLLECTION] || [];
      if (existingDeleteKeys.length > 0) {
        const reason = existingDeleteKeys.length > 1 ? "special_collection_ambiguous" : "delete_review_collection_not_under_pool";
        for (const action of plan.actions || []) {
          if (action.action !== "move_drop_to_delete_review_collection") continue;
          action.status = "collection_scope_blocked";
          action.reason = reason;
        }
        recordCollectionScopeBlock(collectionScopeBlocks, {
          action: "create_collection",
          role: "delete_review_target",
          collectionKey: existingDeleteKeys.join(","),
          collectionName: DELETE_REVIEW_COLLECTION,
          reason,
        }, { phase: "feedback_correction_create_delete_review" });
        return plan;
      }
      if (collectionGuard) {
        const parent = collectionGuard.checkCollectionKey(plan.root_collection_key, { action: "create_collection", role: "delete_review_parent" });
        if (!parent.ok) {
          for (const action of plan.actions || []) {
            if (action.action !== "move_drop_to_delete_review_collection") continue;
            action.status = "collection_scope_blocked";
            action.reason = parent.reason;
          }
          recordCollectionScopeBlock(collectionScopeBlocks, parent, { phase: "feedback_correction_create_delete_review" });
          return plan;
        }
      }
      const created = parseToolText(await mcpToolCall("create_collection", { name: DELETE_REVIEW_COLLECTION, parentCollection: plan.root_collection_key }, 890000));
      deleteReviewCollectionKey = collectionKey(created);
      if (deleteReviewCollectionKey) locallyCreatedAllowedCollectionKeys.add(deleteReviewCollectionKey);
      for (const action of plan.actions || []) {
        if (action.action === "move_drop_to_delete_review_collection") action.target_collection_key = deleteReviewCollectionKey;
      }
    }
    for (const action of plan.actions || []) {
      if (action.status !== "planned" || action.action !== "move_drop_to_delete_review_collection") continue;
      try {
        if (collectionGuard) {
          if (!locallyCreatedAllowedCollectionKeys.has(action.target_collection_key)) {
            const target = collectionGuard.checkCollectionKey(action.target_collection_key, { action: "add_items_to_collection", role: "delete_review_target" });
            if (!target.ok) {
              recordCollectionScopeBlock(collectionScopeBlocks, target, { itemKey: action.itemKey || "", phase: "feedback_correction_apply" });
              action.status = "collection_scope_blocked";
              action.reason = target.reason;
              continue;
            }
          }
          if (action.source_collection_key) {
            const source = collectionGuard.checkCollectionKey(action.source_collection_key, { action: "remove_items_from_collection", role: "source_grade" });
            if (!source.ok) {
              recordCollectionScopeBlock(collectionScopeBlocks, source, { itemKey: action.itemKey || "", phase: "feedback_correction_apply" });
              action.status = "collection_scope_blocked";
              action.reason = source.reason;
              continue;
            }
          }
        }
        await mcpToolCall("add_items_to_collection", { collectionKey: action.target_collection_key, itemKeys: [action.itemKey] }, 890100);
        if (action.source_collection_key) {
          await mcpToolCall("remove_items_from_collection", { collectionKey: action.source_collection_key, itemKeys: [action.itemKey] }, 890101);
        }
        action.status = "moved_to_delete_review";
      } catch (error) {
        action.status = "error";
        action.error = String(error?.message || error);
      }
    }
  }
  return plan;
}

function summarize(plan, mode) {
  const all = [...(plan.actions || []), ...(plan.cleanup_actions || [])];
  const count = (status) => all.filter((entry) => entry.status === status).length;
  return {
    generated_at: new Date().toISOString(),
    mode,
    total_actions: all.length,
    moved: count("moved"),
    planned: count("planned"),
    no_op: count("no_op"),
    drop_manual_delete_required: count("drop_manual_delete_required"),
    moved_to_delete_review: count("moved_to_delete_review"),
    needs_review: count("needs_review"),
    collection_scope_blocked: count("collection_scope_blocked"),
    errors: count("error"),
    collection_cleanup_required: count("collection_cleanup_required"),
    deleted_collection_only: count("deleted_collection_only"),
    collection_scope_blocked_count: Number(plan.collection_scope_blocked_count || count("collection_scope_blocked")),
    collection_scope_blocked_samples: plan.collection_scope_blocked_samples || [],
  };
}

function actionRows(plan) {
  return [...(plan.actions || []), ...(plan.cleanup_actions || [])].map((entry) => ({
    status: entry.status,
    action: entry.action,
    itemKey: entry.itemKey || "",
    date: entry.date || "",
    original_level: entry.original_level || "",
    assigned_level: entry.assigned_level || "",
    source_collection_key: entry.source_collection_key || "",
    target_collection_key: entry.target_collection_key || "",
    collection_key: entry.collection_key || "",
    collection_name: entry.collection_name || "",
    deleteItems: entry.deleteItems === false ? "false" : entry.deleteItems || "",
    feedback_action: entry.feedback_action || "",
    feedback_source: entry.feedback_source || "",
    feedback_row: entry.feedback_row || "",
    title: entry.title || "",
    reason: entry.reason || "",
    error: entry.error || "",
  }));
}

async function writeReports(manifestRoot, plan, summary) {
  const suffix = summary.mode === "dry-run" ? "dry_run" : `${summary.mode}_${summary.generated_at.replace(/[:.]/g, "-")}`;
  const manifestPath = path.join(manifestRoot, `zotero_feedback_collection_corrections_${suffix}.json`);
  const csvPath = path.join(manifestRoot, `zotero_feedback_collection_corrections_${suffix}.csv`);
  const dropCsvPath = path.join(manifestRoot, `drop_manual_delete_required_${suffix}.csv`);
  const deleteReviewCsvPath = path.join(manifestRoot, `drop_delete_review_${suffix}.csv`);
  const cleanupCsvPath = path.join(manifestRoot, `old_archive_collection_cleanup_${suffix}.csv`);
  const headers = ["status", "action", "itemKey", "date", "original_level", "assigned_level", "source_collection_key", "target_collection_key", "collection_key", "collection_name", "deleteItems", "feedback_action", "feedback_source", "feedback_row", "title", "reason", "error"];
  await writeCsv(csvPath, actionRows(plan), headers);
  await writeCsv(dropCsvPath, actionRows({ actions: plan.actions.filter((x) => x.status === "drop_manual_delete_required") }), headers);
  await writeCsv(deleteReviewCsvPath, actionRows({ actions: plan.actions.filter((x) => x.action === "move_drop_to_delete_review_collection") }), headers);
  await writeCsv(cleanupCsvPath, actionRows({ cleanup_actions: plan.cleanup_actions }), headers);
  await writeJson(manifestPath, {
    summary,
    csv_path: csvPath,
    drop_manual_delete_required_csv_path: dropCsvPath,
    drop_delete_review_csv_path: deleteReviewCsvPath,
    old_archive_collection_cleanup_csv_path: cleanupCsvPath,
    safety: {
      removes_from_old_grade_collections_only_after_add: true,
      removes_source_collections: false,
      deletes_zotero_items: false,
      moves_drop_items_to_delete_review_only_when_apply_quarantine_drops: summary.mode === "apply-quarantine-drops",
      deletes_attachments: false,
      moves_pdf_files: false,
      accesses_zotero_sqlite: false,
      triggers_rss_pubmed_fetch: false,
      old_archive_delete_items: false,
    },
    ...plan,
  });
  return { manifestPath, csvPath, dropCsvPath, deleteReviewCsvPath, cleanupCsvPath };
}

export async function readCollections(mcpToolCall) {
  const top = parseToolText(await mcpToolCall("get_collections", { mode: "complete", limit: 1000 }, 850000));
  const out = Array.isArray(top) ? [...top] : [];
  for (const rootName of [ROOT_COLLECTION, OLD_ARCHIVE_COLLECTION]) {
    const root = findTopCollection(out, rootName);
    if (!root?.key) continue;
    const descendants = parseToolText(await mcpToolCall("get_subcollections", { collectionKey: root.key, recursive: true }, 850100 + out.length));
    for (const item of flattenCollections(descendants)) out.push(item);
  }
  const byKey = new Map();
  for (const collection of out) byKey.set(collectionKey(collection), collection);
  return [...byKey.values()];
}

export async function runZoteroFeedbackCollectionCorrections({
  argv = process.argv,
  runtime = buildRuntimeConfig(),
  mcpToolCall = defaultMcpToolCall,
} = {}) {
  const apply = argv.includes("--apply");
  const quarantineDropItems = argv.includes("--apply-quarantine-drops") || argv.includes("--dry-run-quarantine-drops");
  const weekArg = argv.find((arg) => arg.startsWith("--review-week-root="));
  const reviewWeekRoot = weekArg ? weekArg.split("=").slice(1).join("=") : path.join(runtime.reviewRoot, "26 Week21");
  await ensureMcpReady(mcpToolCall);
  const collections = await readCollections(mcpToolCall);
  const collectionScopeBlocks = [];
  const collectionGuard = buildZoteroCollectionGuard(collections);
  const root = findTopCollection(collections, ROOT_COLLECTION);
  const records = await scanLiteratureRecords(runtime.researchRoot);
  const feedbackRows = await scanFeedbackRows(reviewWeekRoot);
  const archivePlan = buildMovePlan({ records, feedbackRows, archiveRoot: path.join(runtime.researchRoot, "literature_archive") });
  await enrichArchivePlanWithZoteroTitleMatches(archivePlan, { mcpToolCall });
  const plan = buildCorrectionPlan({
    archivePlan,
    collections,
    includeArchiveCleanup: true,
    dropMode: quarantineDropItems ? "quarantine" : "manual",
    collectionGuard,
    collectionScopeBlocks,
  });
  plan.root_collection_key = collectionKey(root);
  Object.assign(plan, collectionGuard.audit, summarizeCollectionScopeBlocks(collectionScopeBlocks));
  if (quarantineDropItems && !plan.root_collection_key) throw new Error("root collection 文献池 not found");
  if (apply || argv.includes("--apply-quarantine-drops")) {
    await applyCorrectionPlan(plan, {
      mcpToolCall,
      applyMovesAndCleanup: apply,
      applyDropQuarantine: argv.includes("--apply-quarantine-drops"),
      collectionGuard,
      collectionScopeBlocks,
    });
    Object.assign(plan, summarizeCollectionScopeBlocks(collectionScopeBlocks));
  }
  const summary = summarize(plan, argv.includes("--apply-quarantine-drops") ? "apply-quarantine-drops" : quarantineDropItems ? "dry-run-quarantine-drops" : apply ? "apply" : "dry-run");
  const reports = await writeReports(path.join(runtime.researchRoot, "run_manifests"), plan, summary);
  return { ...reports, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runZoteroFeedbackCollectionCorrections().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
