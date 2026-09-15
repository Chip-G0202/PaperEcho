import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { renameWithTransientRetry } from "../lib/atomic_json.mjs";
import { registerEphemeral } from "../lib/ephemeral_registry.mjs";
import { canonicalQueryHash } from "../stage1/source_state.mjs";

export const NOTIFICATION_RECEIPT_SCHEMA_VERSION = 2;
export const NOTIFICATION_RECEIPT_STATUSES = new Set(["pending", "accepted", "unknown", "failed"]);

export function recipientHash(recipient) { return createHash("sha256").update(String(recipient).trim().toLowerCase()).digest("hex"); }
export function receiptPathFor(outputRoot) { return path.join(path.resolve(outputRoot), "stage5", "email_receipt.json"); }
export function notificationReceiptPathFor(storeRoot, receiptId) {
  if (!/^nr-[a-f0-9]{32}$/.test(String(receiptId || ""))) throw new Error("NOTIFICATION_RECEIPT_ID_INVALID");
  return path.join(path.resolve(storeRoot), `${receiptId}.json`);
}

function timestamp(clock = () => new Date()) { return clock().toISOString(); }

export function notificationIdentity({ notificationType, businessSubject, eventEpoch, payload }) {
  const payloadHash = canonicalQueryHash(payload || {});
  const dedupeKey = canonicalQueryHash({ notificationType, businessSubject, eventEpoch, payloadHash });
  return {
    payloadHash,
    dedupeKey,
    receiptId: `nr-${dedupeKey.slice(0, 32)}`,
    messageId: `<paperecho.${dedupeKey.slice(0, 40)}@notifications.local>`,
  };
}

export function createNotificationReceipt({ notificationType, runId, businessSubject, eventEpoch, payload, ledgerOperationId = "", recipient, clock } = {}) {
  const identity = notificationIdentity({ notificationType, businessSubject, eventEpoch, payload });
  const now = timestamp(clock);
  return validateNotificationReceipt({
    schemaVersion: NOTIFICATION_RECEIPT_SCHEMA_VERSION,
    ...identity,
    notificationType: String(notificationType || ""),
    runId: String(runId || ""),
    businessSubject: String(businessSubject || "").slice(0, 200),
    eventEpoch: String(eventEpoch || "").slice(0, 120),
    recipientHash: recipientHash(recipient),
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    lastSmtp: null,
    ledgerOperationId: String(ledgerOperationId || ""),
  });
}

export function validateNotificationReceipt(receipt) {
  if (receipt?.schemaVersion !== NOTIFICATION_RECEIPT_SCHEMA_VERSION) throw new Error(`NOTIFICATION_RECEIPT_SCHEMA_UNSUPPORTED_${receipt?.schemaVersion ?? "missing"}`);
  if (!/^nr-[a-f0-9]{32}$/.test(String(receipt.receiptId || ""))) throw new Error("NOTIFICATION_RECEIPT_ID_INVALID");
  for (const field of ["dedupeKey", "payloadHash", "recipientHash"]) {
    if (!/^[a-f0-9]{64}$/.test(String(receipt[field] || ""))) throw new Error(`NOTIFICATION_RECEIPT_${field.toUpperCase()}_INVALID`);
  }
  if (!NOTIFICATION_RECEIPT_STATUSES.has(receipt.status)) throw new Error("NOTIFICATION_RECEIPT_STATUS_INVALID");
  if (!Number.isSafeInteger(receipt.attempts) || receipt.attempts < 0) throw new Error("NOTIFICATION_RECEIPT_ATTEMPTS_INVALID");
  if (!/^<paperecho\.[a-f0-9]{40}@notifications\.local>$/.test(String(receipt.messageId || ""))) throw new Error("NOTIFICATION_MESSAGE_ID_INVALID");
  return receipt;
}

export async function readReceipt(receiptPath, { fsApi = fs } = {}) {
  try { return JSON.parse(await fsApi.readFile(receiptPath, "utf8")); } catch { return null; }
}

export async function readNotificationReceipt(receiptPath, { fsApi = fs, allowLegacy = false } = {}) {
  let value;
  try { value = JSON.parse(await fsApi.readFile(receiptPath, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (allowLegacy && value?.schemaVersion === 1) return value;
  return validateNotificationReceipt(value);
}

export async function writeReceipt(receiptPath, receipt, { fsApi = fs } = {}) {
  await fsApi.mkdir(path.dirname(receiptPath), { recursive: true });
  const temporary = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryRegistration = registerEphemeral({ path: temporary, ownerStage: "stage5_receipt", cleanupWhen: "always_after_close" });
  let handle;
  try {
    handle = await fsApi.open(temporary, "wx");
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    if (typeof handle.sync === "function") await handle.sync();
    await handle.close();
    handle = null;
    await renameWithTransientRetry(temporary, receiptPath, { renameImpl: (source, target) => fsApi.rename(source, target) });
    temporaryRegistration.forget();
  } finally {
    if (handle) await handle.close().catch(() => {});
    temporaryRegistration.markClosed();
    await fsApi.unlink(temporary).then(() => temporaryRegistration.forget()).catch(() => {});
  }
}


export async function writeNotificationReceipt(receiptPath, receipt, options = {}) {
  validateNotificationReceipt(receipt);
  return writeReceipt(receiptPath, receipt, options);
}

export async function withReceiptLock(receiptPath, operation, { fsApi = fs } = {}) {
  const lockPath = `${receiptPath}.lock`;
  await fsApi.mkdir(path.dirname(receiptPath), { recursive: true });
  let handle;
  try { handle = await fsApi.open(lockPath, "wx"); }
  catch (error) { if (error?.code === "EEXIST") return { locked: false }; throw error; }
  const lockRegistration = registerEphemeral({ path: lockPath, ownerStage: "stage5_receipt", cleanupWhen: "always_after_close" });
  try { return { locked: true, value: await operation() }; }
  finally { await handle.close().catch(() => {}); lockRegistration.markClosed(); await fsApi.unlink(lockPath).then(() => lockRegistration.forget()).catch(() => {}); }
}
