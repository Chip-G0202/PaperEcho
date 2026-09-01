import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runStage5Notification, prepareStage5Attachments, resolveStage5Request } from "../tools/stage5/main.mjs";
import { formatStage5Report } from "../tools/stage5/report_summary.mjs";
import { receiptPathFor } from "../tools/stage5/email_receipt.mjs";
import { emailTransportConfig, sendStage5Email } from "../tools/stage5/email_sender.mjs";

const DISABLED_LLM = { llmRuntime: { llm_mode: "disabled", apiKeyConfigured: false } };

async function fixture({ monthly = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperflow-stage5-"));
  const xlsx = path.join(root, "周报.xlsx");
  await fs.writeFile(xlsx, "xlsx");
  const artifacts = [{ kind: "weekly_xlsx", path: xlsx, displayName: "周报.xlsx", sizeBytes: 4 }];
  if (monthly) {
    const docx = path.join(root, "月报.docx");
    await fs.writeFile(docx, "docx");
    artifacts.push({ kind: "monthly_docx", path: docx, displayName: "月报.docx", sizeBytes: 4 });
  }
  return { root, summary: { schemaVersion: 1, runId: "run-1", pipelineMode: "desktop", status: "success", startedAt: "2026-07-13T01:00:00Z", finishedAt: "2026-07-13T01:01:00Z", durationMs: 60000, counts: { retrieved: 10, created: 4, updated: null, deduped: 2, feedback: 1, translated: 3, grades: { A: 1, B: 2, C: 3, D: 4 } }, warnings: ["unsafe <tag> & note"], errors: [], artifacts, outputRoot: root } };
}

test("mock transport sends HTML and text with explicit safe attachments and writes receipt", async () => {
  const { root, summary } = await fixture({ monthly: true });
  let captured;
  const result = await runStage5Notification({ runSummary: summary, recipient: "reader@example.test", transport: async (message) => { captured = message; return { messageId: message.messageId, accepted: true, acceptedCount: 1 }; }, config: DISABLED_LLM });
  assert.equal(result.status, "sent");
  assert.deepEqual(captured.attachments.map((item) => item.filename), ["周报.xlsx", "月报.docx"]);
  assert.doesNotMatch(captured.html, />附件</);
  assert.doesNotMatch(captured.text, /附件：/);
  assert.doesNotMatch(captured.html, /2026-07-13T01:01:00Z|2026-07-13 01:01:00/);
  assert.match(captured.html, /unsafe &lt;tag&gt; &amp; note/);
  assert.doesNotMatch(captured.text, /<html|<tr|<td/);
  assert.match(captured.html, /本次新增 4 篇文献[\s\S]*分级情况[\s\S]*本轮文献概况/);
  assert.match(captured.text, /本次新增：4 篇[\s\S]*分级：[\s\S]*本轮文献概况/);
  assert.equal(captured.text.includes("run-1"), true);
  assert.equal(captured.html.includes("run-1"), true);
  for (const removed of ["更新", "Feedback", "标题翻译", "总耗时", "去重"]) {
    assert.equal(captured.html.includes(removed), false);
    assert.equal(captured.text.includes(removed), false);
  }
  assert.ok(captured.html.indexOf("本次新增") < captured.html.indexOf("分级情况"));
  assert.ok(captured.html.indexOf("分级情况") < captured.html.indexOf("本轮文献概况"));
  assert.doesNotMatch(captured.html, /<script|https?:\/\/|<img/i);
  const receipt = JSON.parse(await fs.readFile(receiptPathFor(root), "utf8"));
  assert.equal(receipt.status, "accepted");
  assert.match(receipt.messageId, /^<paperecho\./);
  assert.equal(receipt.recipientHash.length, 64);
  assert.equal(JSON.stringify(receipt).includes("reader@example.test"), false);
  assert.equal(JSON.stringify(receipt).includes("password"), false);
});

test("missing recipient skips and invalid recipient fails without transport calls", async () => {
  const { summary } = await fixture();
  let calls = 0;
  const transport = async () => { calls += 1; };
  assert.deepEqual(await runStage5Notification({ runSummary: summary, recipient: "", config: { env: {} } }), { status: "skipped", reason: "recipient_not_configured", attachments: [] });
  assert.equal((await runStage5Notification({ runSummary: summary, recipient: "not-an-email", transport })).reason, "recipient_invalid");
  assert.equal(calls, 0);
});

test("recipient resolution is CLI then PAPERFLOW_REPORT_TO then legacy env", () => {
  const env = { PAPERFLOW_REPORT_TO: "new@example.test", NOTIFICATION_EMAIL: "legacy@example.test" };
  assert.deepEqual(resolveStage5Request(["--email", "cli@example.test", "--force-resend"], env), { recipient: "cli@example.test", forceResend: true, source: "cli" });
  assert.equal(resolveStage5Request([], env).recipient, "new@example.test");
  assert.equal(resolveStage5Request([], { NOTIFICATION_EMAIL: "legacy@example.test" }).recipient, "legacy@example.test");
});

test("explicit recipient without configured transport fails clearly", async () => {
  const { summary } = await fixture();
  const result = await runStage5Notification({ runSummary: summary, recipient: "reader@example.test", config: { env: {} } });
  assert.deepEqual([result.status, result.reason], ["failed", "transport_not_configured"]);
  assert.match(result.error, /Missing: SMTP_HOST, SMTP_USER, SMTP_PASS/);
});

test("SMTP config needs only host user pass and derives optional defaults", () => {
  const base = { SMTP_HOST: "smtp.example.test", SMTP_USER: "sender@example.test", SMTP_PASS: "x" };
  assert.deepEqual(emailTransportConfig(base), { configured: true, missing: [], error: "", port: 465, secure: true, from: "sender@example.test" });
  assert.equal(emailTransportConfig({ ...base, SMTP_PORT: "587" }).secure, false);
  assert.equal(emailTransportConfig({ ...base, SMTP_PORT: "465" }).secure, true);
  assert.equal(emailTransportConfig({ ...base, SMTP_PORT: "465", SMTP_SECURE: "false" }).secure, false);
  assert.equal(emailTransportConfig({ ...base, SMTP_PORT: "587", SMTP_SECURE: "true" }).secure, true);
});

test("SMTP config reports only missing required fields and rejects invalid optional values", () => {
  const base = { SMTP_HOST: "smtp.example.test", SMTP_USER: "sender@example.test", SMTP_PASS: "x" };
  assert.equal(emailTransportConfig({ SMTP_USER: "sender@example.test" }).error, "SMTP is not configured. Missing: SMTP_HOST, SMTP_PASS");
  assert.match(emailTransportConfig({ ...base, SMTP_USER: "" }).error, /Missing: SMTP_USER/);
  assert.match(emailTransportConfig({ ...base, SMTP_PASS: "" }).error, /Missing: SMTP_PASS/);
  assert.match(emailTransportConfig({ ...base, SMTP_PORT: "70000" }).error, /SMTP_PORT/);
  assert.match(emailTransportConfig({ ...base, SMTP_SECURE: "maybe" }).error, /SMTP_SECURE/);
  assert.match(emailTransportConfig({ ...base, SMTP_FROM: "invalid" }).error, /valid email address/);
});

test("successful receipt prevents duplicates while force resend sends again", async () => {
  const { summary } = await fixture();
  let calls = 0;
  const transport = async (message) => { calls += 1; return { messageId: message.messageId, accepted: true, acceptedCount: 1 }; };
  assert.equal((await runStage5Notification({ runSummary: summary, recipient: "reader@example.test", transport, config: DISABLED_LLM })).status, "sent");
  assert.equal((await runStage5Notification({ runSummary: summary, recipient: "reader@example.test", transport, config: DISABLED_LLM })).reason, "already_sent");
  assert.equal((await runStage5Notification({ runSummary: summary, recipient: "reader@example.test", forceResend: true, transport, config: DISABLED_LLM })).status, "sent");
  assert.equal(calls, 2);
});

test("force resend reuses the literature overview without another LLM call", async () => {
  const { summary } = await fixture();
  let llmCalls = 0;
  let sends = 0;
  const input = {
    runSummary: summary,
    literatureItems: [{ title: "New paper", abstract: "Study abstract", grade: "A", source: "PubMed" }],
    recipient: "reader@example.test",
    transport: async (message) => { sends += 1; return { messageId: message.messageId, accepted: true, acceptedCount: 1 }; },
    config: { llmClient: async () => { llmCalls += 1; return { overview: "本轮文献聚焦示例研究主题，并涉及相关对象与研究方法。现有概况仅依据输入标题和摘要。" }; }, llmRuntime: { llm_mode: "real", apiKeyConfigured: true, model: "mock", max_retries: 0 } },
  };
  assert.equal((await runStage5Notification(input)).status, "sent");
  assert.equal((await runStage5Notification({ ...input, forceResend: true })).status, "sent");
  assert.equal(llmCalls, 1);
  assert.equal(sends, 2);
});

test("failed receipt preserves exports and allows retry", async () => {
  const { root, summary } = await fixture();
  const failed = await runStage5Notification({ runSummary: summary, recipient: "reader@example.test", transport: async () => { throw Object.assign(new Error("mock failure"), { code: "EAUTH" }); }, config: DISABLED_LLM });
  assert.deepEqual([failed.status, failed.reason], ["failed", "eauth"]);
  assert.equal(await fs.readFile(summary.artifacts[0].path, "utf8"), "xlsx");
  const retried = await runStage5Notification({ runSummary: summary, recipient: "reader@example.test", transport: async (message) => ({ messageId: message.messageId, accepted: true, acceptedCount: 1 }), config: DISABLED_LLM });
  assert.equal(retried.status, "sent");
  assert.equal(JSON.parse(await fs.readFile(receiptPathFor(root), "utf8")).messageId, retried.messageId);
});

test("ambiguous SMTP timeout is unknown and never reported sent or auto-retried", async () => {
  const { summary } = await fixture();
  let calls = 0;
  const transport = async () => { calls += 1; throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); };
  const first = await runStage5Notification({ runSummary: summary, recipient: "reader@example.test", transport, config: DISABLED_LLM });
  const second = await runStage5Notification({ runSummary: summary, recipient: "reader@example.test", transport, config: DISABLED_LLM });
  assert.equal(first.status, "unknown");
  assert.equal(first.possibleAccepted, true);
  assert.equal(second.status, "unknown");
  assert.equal(calls, 1);
});

test("attachment whitelist path count and size guards reject unsafe manifests", async () => {
  const { root, summary } = await fixture();
  await assert.rejects(() => prepareStage5Attachments({ ...summary, artifacts: [{ kind: "timings", path: path.join(root, "timings.json") }] }), /ATTACHMENT_KIND_BLOCKED/);
  await assert.rejects(() => prepareStage5Attachments({ ...summary, artifacts: [{ kind: "weekly_xlsx", path: path.join(root, "..", "outside.xlsx") }] }), /ATTACHMENT_OUTSIDE_OUTPUT_ROOT/);
  await assert.rejects(() => prepareStage5Attachments({ ...summary, artifacts: [...summary.artifacts, ...summary.artifacts, ...summary.artifacts] }), /ATTACHMENT_COUNT_LIMIT/);
  const fakeFs = { stat: async () => ({ isFile: () => true, size: 20 * 1024 * 1024 + 1 }) };
  await assert.rejects(() => prepareStage5Attachments(summary, { fsApi: fakeFs }), /ATTACHMENT_TOTAL_SIZE_LIMIT/);
});

test("receipt atomic rename failure leaves no temporary file", async () => {
  const { root, summary } = await fixture();
  const fsApi = Object.create(fs);
  fsApi.rename = async () => { throw Object.assign(new Error("rename blocked"), { code: "EACCES" }); };
  const result = await runStage5Notification({ runSummary: summary, recipient: "reader@example.test", transport: async (message) => ({ messageId: message.messageId, accepted: true, acceptedCount: 1 }), config: { ...DISABLED_LLM, fsApi } });
  assert.equal(result.status, "failed");
  const stage5Dir = path.join(root, "stage5");
  assert.equal((await fs.readdir(stage5Dir)).some((name) => name.endsWith(".tmp")), false);
});

test("SMTP transport is injectable and carries text plus attachments without network", async () => {
  let options;
  let transportOptions;
  const result = await sendStage5Email({ to: "reader@example.test", subject: "s", html: "<b>x</b>", text: "x", attachments: [{ filename: "周报.xlsx", path: "safe.xlsx" }] }, {
    env: { SMTP_HOST: "smtp.invalid", SMTP_USER: "sender@example.test", SMTP_PASS: "test-only-value" },
    nodemailerLoader: async () => ({ createTransport: (value) => { transportOptions = value; return { sendMail: async (message) => { options = message; return { messageId: "mock-smtp", accepted: ["reader@example.test"], rejected: [], response: "250 accepted" }; } }; } }),
  });
  assert.equal(result.messageId, "mock-smtp");
  assert.deepEqual(transportOptions, { host: "smtp.invalid", port: 465, secure: true, auth: { user: "sender@example.test", pass: "test-only-value" } });
  assert.equal(options.text, "x");
  assert.equal(options.attachments[0].filename, "周报.xlsx");
  assert.equal(options.from, "sender@example.test");
  assert.equal(result.accepted, true);
});

test("Stage5 source has no Zotero imports", async () => {
  for (const file of ["main.mjs", "report_summary.mjs", "literature_overview.mjs", "email_sender.mjs", "email_receipt.mjs"]) {
    const source = await fs.readFile(path.join(process.cwd(), "workflow", "tools", "stage5", file), "utf8");
    assert.doesNotMatch(source, /zotero|LocalRepository|itemKey|collection/i);
  }
  const formatted = formatStage5Report((await fixture()).summary);
  assert.match(formatted.subject, /^\[PaperEcho\]/);
  assert.match(formatted.html, /PaperEcho/);
  assert.match(formatted.text, /^PaperEcho 文献流程已完成/);
  assert.match(formatted.html, /由 PaperEcho 自动生成/);
  assert.match(formatted.text, /由 PaperEcho 自动生成/);
  assert.doesNotMatch(`${formatted.subject}\n${formatted.html}\n${formatted.text}`, /\[Paperflow\]|由 Paperflow 自动生成/);
  assert.doesNotMatch(formatted.subject, /unknown/);
});

test("report hides empty regions, preserves grade zeroes, and folds warnings", () => {
  const base = { schemaVersion: 1, runId: "r", pipelineMode: "local", status: "success", startedAt: "2026-07-13T00:00:00Z", finishedAt: "2026-07-13T00:01:00Z", durationMs: null, warnings: [], errors: [], artifacts: [], outputRoot: "." };
  const zero = formatStage5Report({ ...base, counts: { created: 0, grades: { A: 0, B: 0, C: 0, D: 0 } } }, { overview: "本轮没有新增文献。" });
  assert.match(zero.html, /本次没有新增文献/);
  assert.match(zero.html, />0 篇</);
  assert.doesNotMatch(zero.html, />附件</);
  assert.doesNotMatch(zero.html, />提醒</);
  const missing = formatStage5Report({ ...base, counts: { created: null, grades: { A: null, B: null, C: null, D: null } }, warnings: ["a", "b", "c", "d"] });
  assert.doesNotMatch(missing.html, /本次新增|本次没有新增|分级情况/);
  assert.match(missing.html, /另有 1 条提醒/);
});

test("weekly report shows only current integrity changes and separates confirmed from applied", async () => {
  const base = (await fixture()).summary;
  const changed = formatStage5Report({ ...base, integrity: { newlyConfirmedRetractions: 2, appliedRetractions: 1, pendingDelete: 1, newCorrections: 1, newExpressionsOfConcern: 0, confirmedNotApplied: 0, unresolvedConflicts: 0 } });
  assert.match(changed.text, /新确认撤稿：2 篇/);
  assert.match(changed.text, /撤稿处置已应用：1 篇/);
  assert.match(changed.text, /仍需继续清理：1 篇/);
  const unchanged = formatStage5Report({ ...base, integrity: { newlyConfirmedRetractions: 0, appliedRetractions: 0, pendingDelete: 0, newCorrections: 0, newExpressionsOfConcern: 0, confirmedNotApplied: 0, unresolvedConflicts: 0 } });
  assert.doesNotMatch(unchanged.text, /文献完整性变化/);
});

test("report turns review and pending-rule counts into concise action reminders", () => {
  const summary = {
    schemaVersion: 1, runId: "attention", pipelineMode: "local", status: "success",
    finishedAt: "2026-07-13T07:00:00.000Z",
    counts: { created: 2, grades: { A: 1, B: 1, C: 0, D: 0 } },
    attention: { humanReviewCount: 2, pendingRuleCount: 3 }, warnings: [], errors: [], artifacts: [], outputRoot: ".",
  };
  const formatted = formatStage5Report(summary, { overview: "根据本轮 A/B/C 级文献标题形成总体概况。" });
  assert.match(formatted.html, /有 2 篇文献等级需人工确认，请在周报表格的“需人工复核”中处理/);
  assert.match(formatted.text, /有 3 条筛选规则待确认，请在“待确认规则建议”中处理/);
  assert.match(formatted.html, /由 PaperEcho 自动生成/);
  assert.doesNotMatch(formatted.html, /由 Paperflow(?: Stage5)? 自动生成/);
  assert.doesNotMatch(formatted.html, /07:00:00|>附件</);
});
