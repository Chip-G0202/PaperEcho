import path from "node:path";

import { deliverReliableNotification } from "../notification/delivery.mjs";
import { notificationIdentity, notificationReceiptPathFor } from "./email_receipt.mjs";

function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildRadarAggregateMessage(items = []) {
  const rows = items.map((item) => {
    const id = item.doi ? `DOI: ${item.doi}` : item.pmid ? `PMID: ${item.pmid}` : "ID: unavailable";
    const confidence = item.semantic_confidence || item.llm_review?.confidence || "";
    const text = [item.title, item.journal, id, item.url, `Final: ${item.final_grade}`, `Rule: ${item.rule_grade} — ${item.grade_reason || ""}`, `LLM: ${item.llm_review_grade} — ${item.semantic_reason || ""}`, confidence ? `Confidence: ${confidence}` : ""].filter(Boolean).join("\n");
    const html = `<li><strong>${escapeHtml(item.title)}</strong><br>${escapeHtml(item.journal || "")}<br>${escapeHtml(id)}<br>${escapeHtml(item.url || "")}<br>Final: ${escapeHtml(item.final_grade)}<br>Rule: ${escapeHtml(item.rule_grade)} — ${escapeHtml(item.grade_reason || "")}<br>LLM: ${escapeHtml(item.llm_review_grade)} — ${escapeHtml(item.semantic_reason || "")}${confidence ? `<br>Confidence: ${escapeHtml(confidence)}` : ""}</li>`;
    return { text, html };
  });
  return {
    subject: `PaperEcho Daily Radar：${items.length} 篇紧急 A`,
    text: `PaperEcho Daily Radar\n\n${rows.map((row) => row.text).join("\n\n")}`,
    html: `<h1>PaperEcho Daily Radar</h1><ol>${rows.map((row) => row.html).join("")}</ol>`,
    attachments: [],
  };
}

export function radarNotificationReceiptPath(runStateRoot, runId, urgentItems = []) {
  const payload = buildRadarAggregateMessage(urgentItems);
  const identity = notificationIdentity({ notificationType: "radar_business", businessSubject: "urgent_a_aggregate", eventEpoch: runId, payload });
  return notificationReceiptPathFor(path.resolve(runStateRoot), identity.receiptId);
}

export async function sendRadarAggregateNotification({
  runId,
  urgentItems = [],
  recipient,
  runStateRoot,
  transport,
  env = process.env,
  fsApi,
  clock,
  ledgerOperationId = "",
} = {}) {
  if (!urgentItems.length) return { status: "skipped", reason: "no_urgent_items", attempted: false, attachments: [] };
  if (!String(recipient || "").trim()) return { status: "skipped", reason: "recipient_not_configured", attempted: false, attachments: [] };
  const payload = buildRadarAggregateMessage(urgentItems);
  const receiptPath = radarNotificationReceiptPath(runStateRoot, runId, urgentItems);
  const delivered = await deliverReliableNotification({
    receiptPath,
    notificationType: "radar_business",
    runId,
    businessSubject: "urgent_a_aggregate",
    eventEpoch: runId,
    payload,
    recipient,
    ledgerOperationId,
    transport,
    env,
    fsApi,
    clock,
  });
  return { ...delivered, attachments: [] };
}
