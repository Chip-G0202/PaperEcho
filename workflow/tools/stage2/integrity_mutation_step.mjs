import { readZoteroLibraryIndex, updateIntegrityMonitoringState } from "../lib/zotero_library_index_store.mjs";
import { addItemToCollectionWithGuard, removeItemFromCollectionWithGuard, writeTagSetWithGuard } from "./mutation_guard.mjs";

function itemCollections(item = {}) { return new Set((item?.data?.collections || item?.collections || []).map((value) => String(value?.key || value?.id || value))); }
function itemTags(item = {}) { return new Set((item?.data?.tags || item?.tags || []).map((value) => String(value?.tag || value?.name || value))); }
async function readItem(backend, itemKey) { return (await backend.getItems([itemKey], { stage: "stage2_integrity_verify" }))?.[0] || null; }

export async function runIntegrityMutationStep({ plan = [], indexPath, zoteroBackend, collectionGuard, collectionScopeBlocks = [], recovery = null } = {}) {
  if (!plan.length) return { status: "skipped", reason: "no_integrity_changes", confirmedCount: 0, appliedCount: 0, pendingDeleteCount: 0, blockedCount: 0, results: [] };
  if (!recovery?.store || typeof recovery.prepareIntegrityOperations !== "function") return { status: "blocked", reason: "operation_ledger_required", confirmedCount: plan.length, appliedCount: 0, pendingDeleteCount: 0, blockedCount: plan.length, results: [] };
  const prepared = await recovery.prepareIntegrityOperations({ plan, indexPath });
  const results = [];
  const commitApplication = async (entry, target, operation, state) => {
    if (!operation) return false;
    await recovery.startOperation(operation);
    const read = await readZoteroLibraryIndex(indexPath);
    const integrity = read.index.records[entry.canonicalId].integrity;
    const updated = await updateIntegrityMonitoringState(indexPath, { recordUpdates: [{ canonicalId: entry.canonicalId, integrity: { ...integrity, application: { targetFingerprint: target.targetFingerprint, state, lastAppliedAt: new Date().toISOString(), ledgerOperationId: operation.idempotencyKey } } }] });
    await recovery.completeOperation(operation, updated.ok, { canonicalId: entry.canonicalId, targetFingerprint: target.targetFingerprint, applicationState: state }, updated.reason);
    return updated.ok;
  };
  for (const record of prepared) {
    const { entry } = record;
    const target = entry.target || {};
    if (target.blocked) { results.push({ canonicalId: entry.canonicalId, targetStatus: target.status, status: "blocked", reason: target.reason }); continue; }
    let trashVerified = target.status !== "retraction";
    let failed = false;
    let removeFailureCount = 0;
    for (const operation of record.operations) {
      const dependenciesReady = operation.dependsOn.every((key) => recovery.store.ledger.operations.find((item) => item.idempotencyKey === key)?.status === "verified");
      if (!dependenciesReady) { failed = true; continue; }
      await recovery.startOperation(operation);
      let mutation;
      if (operation.type === "zotero_collection_add") mutation = await addItemToCollectionWithGuard({ itemKey: target.itemKey, collectionKey: operation.target.collectionId, role: "trash", phase: "integrity_pending_delete_add", verify: true, zoteroBackend, collectionGuard, collectionScopeBlocks, apply: true, dryRun: false });
      else if (operation.type === "zotero_collection_remove") mutation = await removeItemFromCollectionWithGuard({ itemKey: target.itemKey, collectionKey: operation.target.collectionId, role: "integrity_managed_removal", phase: "integrity_managed_remove", zoteroBackend, collectionGuard, collectionScopeBlocks, apply: true, dryRun: false });
      else mutation = await writeTagSetWithGuard({ itemKey: target.itemKey, tags: [operation.target.tag], action: "add", phase: "integrity_status_tag", zoteroBackend, apply: true, dryRun: false });
      const current = mutation.ok ? await readItem(zoteroBackend, target.itemKey) : null;
      const verified = operation.type === "zotero_tag_add" ? itemTags(current).has(operation.target.tag) : itemCollections(current).has(operation.target.collectionId) === (operation.type === "zotero_collection_add");
      await recovery.completeOperation(operation, mutation.ok && verified, { itemKey: target.itemKey, collectionId: operation.target.collectionId || "", tag: operation.target.tag || "", readbackVerified: verified }, mutation.write_failures?.[0]?.error || "integrity_readback_failed");
      if (operation.type === "zotero_collection_add") {
        trashVerified = mutation.ok && verified;
        if (trashVerified) await commitApplication(entry, target, record.pendingCommit, "pending_delete");
      }
      if (!mutation.ok || !verified) { failed = true; if (operation.type === "zotero_collection_remove") removeFailureCount += 1; }
    }
    const applicationState = target.status === "retraction" && trashVerified && failed ? "pending_delete" : (!failed ? "applied" : "confirmed_not_applied");
    if (!failed && record.commit) await commitApplication(entry, target, record.commit, "applied");
    results.push({ canonicalId: entry.canonicalId, targetStatus: target.status, status: applicationState, trashVerified, removeFailureCount });
  }
  return {
    status: results.some((item) => item.status === "confirmed_not_applied" || item.status === "blocked") ? "completed_with_pending" : "completed",
    confirmedCount: plan.length, appliedCount: results.filter((item) => item.status === "applied").length,
    pendingDeleteCount: results.filter((item) => item.status === "pending_delete").length,
    blockedCount: results.filter((item) => item.status === "blocked" || item.status === "confirmed_not_applied").length,
    results,
  };
}
