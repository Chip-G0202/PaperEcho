import { normalizeStage2MembershipMutationResult } from "../lib/zotero_backend_contract.mjs";
import { recordCollectionScopeBlock } from "../lib/zotero_collection_guard.mjs";

export async function runGuardedBulkWritebackMutation({
  operations = [],
  apply = false,
  dryRun = !apply,
  guardCheck = { ok: true },
  writer = null,
} = {}) {
  const list = Array.isArray(operations) ? operations : [];
  const result = {
    ok: true,
    dry_run: Boolean(dryRun || !apply),
    apply: Boolean(apply && !dryRun),
    planned_operation_count: list.length,
    write_success_count: 0,
    write_failure_count: 0,
    write_failures: [],
    guard_blocked_count: 0,
    writer_called: false,
  };

  if (result.dry_run) {
    return result;
  }

  if (!guardCheck?.ok) {
    const reason = guardCheck?.reason || "bulk_writeback_guard_blocked";
    result.ok = false;
    result.guard_blocked_count = list.length;
    result.write_failure_count = list.length;
    result.write_failures = list.map((operation) => ({
      operation,
      error: reason,
      blocked: true,
    }));
    return result;
  }

  if (typeof writer !== "function") {
    throw new Error("bulk_writeback_writer_required");
  }

  for (const operation of list) {
    try {
      result.writer_called = true;
      await writer(operation);
      result.write_success_count++;
    } catch (error) {
      result.write_failure_count++;
      result.write_failures.push({
        operation,
        error: error?.message || String(error),
      });
    }
  }

  result.ok = result.write_failure_count === 0;
  return result;
}

export async function addItemToWorthyCollectionWithGuard({
  itemKey = "",
  worthyKey = "",
  zoteroBackend = null,
  zoteroBackendCall = null,
  mcpToolCall = null,
  id = 700000,
  collectionGuard = null,
  collectionScopeBlocks = null,
  apply = true,
  dryRun = !apply,
  role = "worthy_target",
  phase = "add_to_worthy",
  verify = false,
} = {}) {
  const callZotero = zoteroBackendCall || mcpToolCall;
  const contractBackend = zoteroBackend || callZotero?.adapter || null;
  const operation = {
    action: "add_items_to_collection",
    role,
    phase,
    collectionKey: worthyKey,
    itemKey,
    itemKeys: [itemKey],
  };
  let contractResult = null;
  const guardCheck = collectionGuard
    ? collectionGuard.checkCollectionKey(worthyKey, { action: "add_items_to_collection", role })
    : { ok: true };

  const result = await runGuardedBulkWritebackMutation({
    operations: [operation],
    apply,
    dryRun,
    guardCheck,
    writer: async (op) => {
      if (typeof contractBackend?.addItemsToCollections === "function") {
        const operations = [{ collectionKey: op.collectionKey, itemKeys: op.itemKeys, role: op.role, phase: op.phase }];
        try {
          const raw = await contractBackend.addItemsToCollections(operations, { verify, stage: phase, id });
          const applied = [
            ...(Array.isArray(raw?.added) ? raw.added : []),
            ...(Array.isArray(raw?.already) ? raw.already : []),
            ...(Array.isArray(raw?.applied) ? raw.applied : []),
          ].map((entry) => (typeof entry === "string" ? { itemKey: entry, collectionKey: op.collectionKey } : entry));
          contractResult = normalizeStage2MembershipMutationResult({
            method: "addItemsToCollections",
            operations,
            applied,
            missing: raw?.missing || [],
            failed: raw?.failed || [],
          });
        } catch (error) {
          contractResult = normalizeStage2MembershipMutationResult({
            method: "addItemsToCollections",
            operations,
            backendError: error?.message || String(error),
          });
        }
        return;
      }
      if (typeof callZotero !== "function") throw new Error("bulk_writeback_zotero_writer_required");
      await callZotero("add_items_to_collection", { collectionKey: op.collectionKey, itemKeys: op.itemKeys }, id);
    },
  });

  if (contractResult) {
    result.ok = contractResult.ok;
    result.write_success_count = contractResult.success_count;
    result.write_failure_count = contractResult.failure_count;
    result.write_failures = contractResult.failures.map((failure) => ({
      itemKey: failure.itemKey || itemKey,
      collectionKey: failure.collectionKey || worthyKey,
      error: failure.error || "add_items_to_collection_failed",
      phase,
      operation,
      blocked: Boolean(failure.blocked),
      missing: Boolean(failure.missing),
    }));
  }

  if (!result.ok) {
    result.write_failures = result.write_failures.map((failure) => {
      if (failure.blocked) {
        return recordCollectionScopeBlock(collectionScopeBlocks, guardCheck, {
          itemKey,
          phase,
          error: `collection_scope_blocked:${guardCheck?.reason || "guard_blocked"}`,
        });
      }
      return {
        itemKey: failure.itemKey || itemKey,
        collectionKey: failure.collectionKey || worthyKey,
        error: failure.error,
        phase: "add_to_worthy",
        operation: failure.operation,
        missing: Boolean(failure.missing),
      };
    });
  }

  return result;
}

export async function addItemToCollectionWithGuard(options = {}) {
  return addItemToWorthyCollectionWithGuard({
    ...options,
    worthyKey: options.collectionKey || options.worthyKey,
    role: options.role || "managed_collection",
    phase: options.phase || "add_to_collection",
  });
}

export async function writeTagSetWithGuard({
  itemKey = "",
  tags = [],
  zoteroBackend = null,
  zoteroBackendCall = null,
  mcpToolCall = null,
  id = 650000,
  apply = true,
  dryRun = !apply,
  guardCheck = { ok: true },
  action = "set",
  phase = "tag_cleanup",
} = {}) {
  const callZotero = zoteroBackendCall || mcpToolCall;
  const contractBackend = zoteroBackend || callZotero?.adapter || null;
  const operation = {
    action: "write_tag",
    tagAction: action,
    itemKey,
    tags: Array.isArray(tags) ? tags : [],
  };
  let contractResult = null;

  const result = await runGuardedBulkWritebackMutation({
    operations: [operation],
    apply,
    dryRun,
    guardCheck,
    writer: async (op) => {
      if (typeof contractBackend?.writeTagsBatch === "function") {
        const operations = [{ action, itemKey: op.itemKey, tags: op.tags }];
        try {
          const raw = await contractBackend.writeTagsBatch(operations, { stage: phase, id });
          contractResult = normalizeStage2MembershipMutationResult({
            method: "writeTagsBatch",
            operations,
            applied: raw?.applied || [],
            missing: raw?.missing || [],
            failed: raw?.failed || [],
          });
        } catch (error) {
          contractResult = normalizeStage2MembershipMutationResult({
            method: "writeTagsBatch",
            operations,
            backendError: error?.message || String(error),
          });
        }
        return;
      }
      if (typeof callZotero !== "function") throw new Error("bulk_writeback_zotero_writer_required");
      await callZotero("write_tag", { action, itemKey: op.itemKey, tags: op.tags }, id);
    },
  });

  if (contractResult) {
    result.ok = contractResult.ok;
    result.write_success_count = contractResult.success_count;
    result.write_failure_count = contractResult.failure_count;
    result.write_failures = contractResult.failures.map((failure) => ({
      itemKey: failure.itemKey || itemKey,
      error: failure.error || "write_tag_failed",
      phase,
      operation,
      blocked: Boolean(failure.blocked),
      missing: Boolean(failure.missing),
    }));
  }

  if (!result.ok) {
    result.write_failures = result.write_failures.map((failure) => ({
      itemKey: failure.itemKey || itemKey,
      error: failure.error,
      phase,
      operation: failure.operation,
      blocked: Boolean(failure.blocked),
      missing: Boolean(failure.missing),
    }));
  }

  return result;
}

export async function removeItemFromCollectionWithGuard({
  itemKey = "",
  collectionKey = "",
  role = "collection",
  phase = "remove_from_collection",
  zoteroBackend = null,
  zoteroBackendCall = null,
  mcpToolCall = null,
  id = 720000,
  collectionGuard = null,
  collectionScopeBlocks = null,
  apply = true,
  dryRun = !apply,
} = {}) {
  const callZotero = zoteroBackendCall || mcpToolCall;
  const contractBackend = zoteroBackend || callZotero?.adapter || null;
  const operation = {
    action: "remove_items_from_collection",
    role,
    phase,
    collectionKey,
    itemKey,
    itemKeys: [itemKey],
  };
  let contractResult = null;
  const guardCheck = collectionGuard
    ? collectionGuard.checkCollectionKey(collectionKey, { action: "remove_items_from_collection", role })
    : { ok: true };

  const result = await runGuardedBulkWritebackMutation({
    operations: [operation],
    apply,
    dryRun,
    guardCheck,
    writer: async (op) => {
      if (typeof contractBackend?.removeItemsFromCollections === "function") {
        const operations = [{ collectionKey: op.collectionKey, itemKeys: op.itemKeys, role: op.role, phase: op.phase }];
        try {
          const raw = await contractBackend.removeItemsFromCollections(operations, { stage: phase, id });
          contractResult = normalizeStage2MembershipMutationResult({
            method: "removeItemsFromCollections",
            operations,
            applied: raw?.applied || [],
            missing: raw?.missing || [],
            failed: raw?.failed || [],
          });
        } catch (error) {
          contractResult = normalizeStage2MembershipMutationResult({
            method: "removeItemsFromCollections",
            operations,
            backendError: error?.message || String(error),
          });
        }
        return;
      }
      if (typeof callZotero !== "function") throw new Error("bulk_writeback_zotero_writer_required");
      await callZotero("remove_items_from_collection", { collectionKey: op.collectionKey, itemKeys: op.itemKeys }, id);
    },
  });

  if (contractResult) {
    result.ok = contractResult.ok;
    result.write_success_count = contractResult.success_count;
    result.write_failure_count = contractResult.failure_count;
    result.write_failures = contractResult.failures.map((failure) => ({
      itemKey: failure.itemKey || itemKey,
      collectionKey: failure.collectionKey || collectionKey,
      error: failure.error || "remove_items_from_collection_failed",
      phase,
      operation,
      blocked: Boolean(failure.blocked),
      missing: Boolean(failure.missing),
    }));
  }

  if (!result.ok) {
    result.write_failures = result.write_failures.map((failure) => {
      if (failure.blocked) {
        const block = recordCollectionScopeBlock(collectionScopeBlocks, guardCheck, {
          itemKey,
          phase,
          error: `collection_scope_blocked:${guardCheck?.reason || "guard_blocked"}`,
        });
        return { ...block, operation: failure.operation };
      }
      return {
        itemKey: failure.itemKey || itemKey,
        collectionKey: failure.collectionKey || collectionKey,
        error: failure.error,
        phase,
        operation: failure.operation,
        missing: Boolean(failure.missing),
      };
    });
  }

  return result;
}
