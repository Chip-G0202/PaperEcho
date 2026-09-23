import fs from "node:fs/promises";
import path from "node:path";
import { formatStage5Report } from "./report_summary.mjs";
import { emailTransportConfig, sendStage5Email } from "./email_sender.mjs";
import { readNotificationReceipt, receiptPathFor, recipientHash, writeNotificationReceipt } from "./email_receipt.mjs";
import { generateLiteratureOverview } from "./literature_overview.mjs";
import { deliverReliableNotification } from "../notification/delivery.mjs";

const MAX_ATTACHMENTS = 1;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const ALLOWED = new Map([["monthly_docx", ".docx"]]);

export function resolveStage5Request(argv = process.argv.slice(2), env = process.env) {
  const equals = argv.find((arg) => String(arg).startsWith("--email="));
  const index = argv.indexOf("--email");
  const cliRecipient = equals ? String(equals).slice("--email=".length) : index >= 0 ? argv[index + 1] : "";
  const recipient = String(cliRecipient || env.PAPERFLOW_REPORT_TO || env.NOTIFICATION_EMAIL || "").trim();
  return { recipient, forceResend: argv.includes("--force-resend"), source: cliRecipient ? "cli" : env.PAPERFLOW_REPORT_TO ? "PAPERFLOW_REPORT_TO" : env.NOTIFICATION_EMAIL ? "NOTIFICATION_EMAIL" : "none" };
}

export function isValidRecipient(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "")) && String(value).length <= 254; }
function isWithin(root, candidate) { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }

export async function prepareStage5Attachments(runSummary, { fsApi = fs } = {}) {
  const artifacts = (Array.isArray(runSummary.artifacts) ? runSummary.artifacts : [])
    .filter((item) => item.kind !== "weekly_xlsx");
  if (artifacts.length > MAX_ATTACHMENTS) throw Object.assign(new Error("ATTACHMENT_COUNT_LIMIT"), { category: "attachment_limit" });
  const attachments = [];
  let totalBytes = 0;
  for (const item of artifacts) {
    const extension = ALLOWED.get(item.kind);
    if (!extension) throw Object.assign(new Error(`ATTACHMENT_KIND_BLOCKED:${item.kind || "missing"}`), { category: "attachment_blocked" });
    const resolved = path.resolve(String(item.path || ""));
    if (!isWithin(runSummary.outputRoot, resolved)) throw Object.assign(new Error("ATTACHMENT_OUTSIDE_OUTPUT_ROOT"), { category: "attachment_path_blocked" });
    if (path.extname(resolved).toLowerCase() !== extension) throw Object.assign(new Error("ATTACHMENT_EXTENSION_BLOCKED"), { category: "attachment_blocked" });
    let stat;
    try { stat = await fsApi.stat(resolved); }
    catch (error) { throw Object.assign(new Error(`ATTACHMENT_UNREADABLE:${error?.code || "unknown"}`), { category: "attachment_unreadable" }); }
    if (!stat.isFile()) throw Object.assign(new Error("ATTACHMENT_NOT_FILE"), { category: "attachment_unreadable" });
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) throw Object.assign(new Error("ATTACHMENT_TOTAL_SIZE_LIMIT"), { category: "attachment_limit" });
    attachments.push({ filename: path.basename(String(item.displayName || resolved)), path: resolved, sizeBytes: stat.size });
  }
  return attachments;
}

export async function runStage5Notification({ runSummary, literatureItems = [], recipient, forceResend = false, transport, config = {} } = {}) {
  if (!String(recipient || "").trim()) return { status: "skipped", reason: "recipient_not_configured", attachments: [] };
  if (!isValidRecipient(recipient)) return { status: "failed", reason: "recipient_invalid", attachments: [] };
  const normalizedRecipient = String(recipient).trim().toLowerCase();
  const stateRoot = path.resolve(config.runStateRoot || runSummary.outputRoot);
  const receiptPath = receiptPathFor(stateRoot);
  const legacyReceiptPath = receiptPathFor(runSummary.outputRoot);
  const fsApi = config.fsApi || fs;
  let attachments = [];
  try {
    const previous = await readNotificationReceipt(receiptPath, { fsApi, allowLegacy: true })
      || (legacyReceiptPath !== receiptPath ? await readNotificationReceipt(legacyReceiptPath, { fsApi, allowLegacy: true }) : null);
    const sameRecipient = previous?.recipientHash === recipientHash(normalizedRecipient) && previous?.runId === runSummary.runId;
    if (!forceResend && sameRecipient && (previous.status === "accepted" || previous.status === "sent")) return { status: "skipped", reason: "already_sent", receiptStatus: "accepted", messageId: previous.messageId || "", receiptPath, attachments: [] };
    if (!forceResend && sameRecipient && previous.status === "unknown") return { status: "unknown", reason: "possibly_accepted_no_retry", receiptStatus: "unknown", receiptPath, attachments: [], possibleAccepted: true };
    if (!forceResend && sameRecipient && previous.schemaVersion === 2 && previous.status === "pending" && previous.attempts > 0) {
      const uncertain = { ...previous, status: "unknown", updatedAt: new Date().toISOString(), lastSmtp: { outcome: "unknown", category: "interrupted_after_attempt_started", responseCode: null, acceptedCount: 0, rejectedCount: 0 } };
      await writeNotificationReceipt(receiptPath, uncertain, { fsApi });
      return { status: "unknown", reason: "possibly_accepted_no_retry", receiptStatus: "unknown", receiptPath, attachments: [], possibleAccepted: true };
    }
    attachments = await prepareStage5Attachments(runSummary, { fsApi });
    if (!transport) {
      const mailConfig = emailTransportConfig(config.env || process.env);
      if (!mailConfig.configured) throw Object.assign(new Error(mailConfig.error), { category: mailConfig.missing.length ? "transport_not_configured" : "smtp_config_invalid" });
    }
    const overview = await generateLiteratureOverview({ runSummary, literatureItems, llmClient: config.llmClient || null, runtime: config.llmRuntime || null, fsApi, stateRoot, legacyStateRoot: runSummary.outputRoot });
    const report = formatStage5Report(runSummary, { overview: overview.overview });
    const delivery = await deliverReliableNotification({
      receiptPath,
      legacyReceiptPath,
      notificationType: "run_summary",
      runId: runSummary.runId,
      businessSubject: runSummary.runId,
      eventEpoch: runSummary.runId,
      payload: { ...report, attachments },
      recipient: normalizedRecipient,
      ledgerOperationId: config.ledgerOperationId || "",
      retryFailed: true,
      force: forceResend,
      transport: transport || ((message) => sendStage5Email(message, { env: config.env || process.env })),
      env: config.env || process.env,
      fsApi,
      hooks: config.deliveryHooks || {},
    });
    if (delivery.status === "accepted") {
      const already = delivery.reason === "already_accepted";
      return { status: already ? "skipped" : "sent", reason: already ? "already_sent" : "sent", receiptStatus: "accepted", messageId: delivery.receipt?.messageId || "", receiptPath, attachments: attachments.map((item) => item.filename) };
    }
    if (delivery.status === "unknown") return { status: "unknown", reason: delivery.reason, receiptStatus: "unknown", receiptPath, attachments: attachments.map((item) => item.filename), possibleAccepted: true };
    if (delivery.status === "pending") return { status: "skipped", reason: "send_in_progress", receiptStatus: "pending", receiptPath, attachments: [] };
    return { status: "failed", reason: delivery.reason, receiptStatus: "failed", receiptPath, attachments: attachments.map((item) => item.filename) };
  } catch (error) {
    const missingRetainedArtifact = forceResend && ["attachment_unreadable", "attachment_blocked"].includes(String(error?.category || ""));
    const reason = missingRetainedArtifact ? "run_artifacts_expired_or_missing" : String(error?.category || "notification_receipt_or_payload_failed");
    const safeError = missingRetainedArtifact ? "运行结果已过保留期或附件不存在" : ["transport_not_configured", "smtp_config_invalid"].includes(reason) ? String(error?.message || reason).slice(0, 240) : reason;
    return { status: "failed", reason, error: safeError, receiptStatus: "failed", receiptPath, attachments: attachments.map((item) => item.filename) };
  }
}
