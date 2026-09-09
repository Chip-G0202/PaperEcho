import { terminalWorkflowStatus } from "../lib/orchestrator_status.mjs";
import fs from "node:fs/promises";

import { hashFile } from "./operation_ledger.mjs";

function evidence(value) {
  return value && typeof value === "object" ? value : { detail: String(value || "") };
}

export function createFileReconciler({ execute = null, fsApi = fs } = {}) {
  return {
    async observe(operation) {
      const filePath = operation.target?.path;
      try {
        const actualHash = await hashFile(filePath, { fsApi });
        const expectedHash = operation.target?.outputHash || operation.verification?.outputHash || "";
        if (!expectedHash) return { state: "ambiguous", evidence: { exists: true, actualHash, reason: "expected_hash_missing" } };
        return actualHash === expectedHash
          ? { state: "match", evidence: { exists: true, outputHash: actualHash } }
          : { state: "conflict", evidence: { exists: true, expectedHash, actualHash } };
      } catch (error) {
        if (error?.code === "ENOENT") return { state: "absent", evidence: { exists: false } };
        return { state: "conflict", evidence: { reason: String(error?.message || error).slice(0, 200) } };
      }
    },
    async execute(operation, context) {
      if (typeof execute !== "function") throw new Error("FILE_RECOVERY_EXECUTOR_UNAVAILABLE");
      return execute(operation, context);
    },
    async verify(operation, context) {
      return this.observe(operation, context);
    },
  };
}

export async function verifyWorkbookFile(filePath) {
  try {
    const exceljs = await import("exceljs");
    const Workbook = exceljs.Workbook || exceljs.default?.Workbook;
    if (!Workbook) throw new Error("EXCELJS_WORKBOOK_UNAVAILABLE");
    const workbook = new Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheets = workbook.worksheets.map((sheet) => sheet.name);
    const required = ["每日反馈", "需人工复核"];
    return required.every((name) => sheets.includes(name))
      ? { state: "match", evidence: { sheets: required } }
      : { state: "conflict", evidence: { reason: "required_sheets_missing", sheets } };
  } catch (error) {
    return { state: "conflict", evidence: { reason: "workbook_unreadable", error: String(error?.message || error).slice(0, 160) } };
  }
}

export function createWorkbookReconciler({ execute = null, fsApi = fs } = {}) {
  return {
    async observe(operation) {
      const filePath = operation.target?.path;
      if (!filePath) return { state: "absent", evidence: { reason: "output_path_missing" } };
      try {
        const actualHash = await hashFile(filePath, { fsApi });
        const expectedHash = operation.target?.outputHash || operation.verification?.outputHash || "";
        if (expectedHash && actualHash !== expectedHash) return { state: "conflict", evidence: { expectedHash, actualHash } };
        if (!expectedHash && /^[a-f0-9]{64}$/.test(String(operation.inputVersion || "")) && actualHash === operation.inputVersion) return { state: "absent", evidence: { reason: "output_unchanged_since_started", actualHash } };
        const verified = await verifyWorkbookFile(filePath);
        return verified.state === "match" ? { ...verified, target: { outputHash: actualHash }, evidence: { ...verified.evidence, outputHash: actualHash } } : verified;
      } catch (error) { return error?.code === "ENOENT" ? { state: "absent", evidence: { exists: false } } : { state: "conflict", evidence: { reason: String(error?.message || error) } }; }
    },
    async execute(operation, context) {
      if (typeof execute !== "function") throw new Error("WORKBOOK_RECOVERY_EXECUTOR_UNAVAILABLE");
      return execute(operation, context);
    },
    async verify(operation, context) { return this.observe(operation, context); },
  };
}

export async function reconcileOperationLedger({ store, reconcilers = {}, context = {}, hooks = {} } = {}) {
  if (!store?.ledger) throw new Error("RECOVERY_LEDGER_REQUIRED");
  const outcomes = [];
  let globalBlocked = false;
  for (const snapshot of store.ledger.operations) {
    let operation = store.ledger.operations.find((item) => item.idempotencyKey === snapshot.idempotencyKey);
    if (operation.status === "verified") {
      outcomes.push({ idempotencyKey: operation.idempotencyKey, status: "verified", action: "skipped_verified" });
      continue;
    }
    if (globalBlocked) {
      outcomes.push({ idempotencyKey: operation.idempotencyKey, status: operation.status, action: "blocked_by_global_conflict" });
      continue;
    }
    const dependenciesReady = operation.dependsOn.every((key) => store.ledger.operations.find((item) => item.idempotencyKey === key)?.status === "verified");
    if (!dependenciesReady) {
      outcomes.push({ idempotencyKey: operation.idempotencyKey, status: operation.status, action: "dependency_pending" });
      continue;
    }
    const reconciler = reconcilers[operation.type];
    if (!reconciler || typeof reconciler.observe !== "function") {
      await store.transition(operation.idempotencyKey, "conflict", { error: "RECOVERY_RECONCILER_UNAVAILABLE", verification: { reason: "reconciler_unavailable" } });
      outcomes.push({ idempotencyKey: operation.idempotencyKey, status: "conflict", action: "unsupported" });
      if (operation.scope === "global") globalBlocked = true;
      continue;
    }
    const observed = await reconciler.observe(operation, context);
    if (operation.status === "conflict") {
      outcomes.push({ idempotencyKey: operation.idempotencyKey, status: "conflict", action: "conflict_preserved" });
      if (operation.scope === "global") globalBlocked = true;
      continue;
    }
    if (["conflict", "ambiguous"].includes(observed.state)) {
      await store.transition(operation.idempotencyKey, "conflict", { verification: evidence(observed.evidence), error: observed.state === "ambiguous" ? "REMOTE_FACT_AMBIGUOUS" : "REMOTE_FACT_CONFLICT" });
      outcomes.push({ idempotencyKey: operation.idempotencyKey, status: "conflict", action: observed.state });
      if (operation.scope === "global") globalBlocked = true;
      continue;
    }
    if (observed.state === "match") {
      if (operation.status === "pending" || operation.status === "failed") {
        await store.transition(operation.idempotencyKey, "started", { verification: evidence(observed.evidence) });
        operation = store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
      }
      if (operation.status !== "remote_observed") await store.transition(operation.idempotencyKey, "remote_observed", { verification: evidence(observed.evidence), target: observed.target });
      operation = store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
      const verified = typeof reconciler.verify === "function" ? await reconciler.verify(operation, context) : observed;
      if (verified.state === "match") {
        await store.transition(operation.idempotencyKey, "verified", { verification: evidence(verified.evidence) });
        outcomes.push({ idempotencyKey: operation.idempotencyKey, status: "verified", action: "adopted_observed" });
      } else {
        await store.transition(operation.idempotencyKey, "conflict", { verification: evidence(verified.evidence), error: "WRITEBACK_VERIFICATION_FAILED" });
        outcomes.push({ idempotencyKey: operation.idempotencyKey, status: "conflict", action: "verification_failed" });
        if (operation.scope === "global") globalBlocked = true;
      }
      continue;
    }
    if (observed.state !== "absent") throw new Error("RECOVERY_OBSERVATION_INVALID");
    if (!operation.retryable || operation.type === "notification") {
      await store.transition(operation.idempotencyKey, "conflict", { verification: evidence(observed.evidence), error: operation.type === "notification" ? "NOTIFICATION_RECEIPT_SEMANTICS_REQUIRED" : "OPERATION_NOT_RETRYABLE" });
      outcomes.push({ idempotencyKey: operation.idempotencyKey, status: "conflict", action: "conservative_stop" });
      if (operation.scope === "global") globalBlocked = true;
      continue;
    }
    if (operation.status !== "started") await store.transition(operation.idempotencyKey, "started", { verification: evidence(observed.evidence) });
    await hooks.afterStarted?.(operation, store);
    try {
      const result = await reconciler.execute(operation, context);
      await hooks.afterExecute?.(operation, result, store);
      await store.transition(operation.idempotencyKey, "remote_observed", { verification: evidence(result?.evidence), target: result?.target, intent: result?.intent });
      await hooks.afterObserved?.(operation, result, store);
      operation = store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
      const verified = typeof reconciler.verify === "function" ? await reconciler.verify(operation, context) : await reconciler.observe(operation, context);
      if (verified.state !== "match") throw new Error("WRITEBACK_VERIFICATION_FAILED");
      await store.transition(operation.idempotencyKey, "verified", { verification: evidence(verified.evidence) });
      outcomes.push({ idempotencyKey: operation.idempotencyKey, status: "verified", action: "executed" });
    } catch (error) {
      const current = store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
      if (!["remote_observed", "verified", "conflict"].includes(current.status)) {
        await store.transition(operation.idempotencyKey, "failed", { error: String(error?.message || error) });
      }
      throw error;
    }
  }
  const statuses = store.ledger.operations.map((operation) => operation.status);
  const operationsStatus = statuses.length > 0 && statuses.every((value) => value === "verified") ? "completed" : statuses.includes("conflict") ? "completed_with_conflicts" : "incomplete";
  const terminal = store.ledger.workflowStatus || (["timed_out", "interrupted"].includes(store.ledger.status) ? store.ledger.status : null);
  const status = terminal && terminalWorkflowStatus(terminal) !== "completed" ? terminalWorkflowStatus(terminal) : operationsStatus;
  await store.setRunStatus(status);
  return { status, outcomes, globalBlocked };
}
