import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRadarNotificationContent, buildWeeklyNotificationContent } from "../workflow/tools/stage5/notification_content.mjs";
import { formatRadarReport } from "../workflow/tools/stage5/radar_report.mjs";
import { formatStage5Report } from "../workflow/tools/stage5/report_summary.mjs";
import { sendRadarAggregateNotification, radarNotificationReceiptPath } from "../workflow/tools/stage5/radar_notification.mjs";
import { runStage5Notification } from "../workflow/tools/stage5/main.mjs";
import { readNotificationReceipt } from "../workflow/tools/stage5/email_receipt.mjs";

const audit = { candidateCount: 12, generatedAt: "2026-09-30T07:00:00.000Z" };
const papers = ["A", "B", "C", "D"].map((grade) => ({ title: `English ${grade}`, translatedTitle: `中文 ${grade}`, journal: "Journal", year: "2026", final_grade: grade, semantic_reason: `Existing reason ${grade}`, rule_grade: "D", url: "https://example.test/paper" }));
const summary = { runId: "weekly-fixture", pipelineMode: "desktop", finishedAt: audit.generatedAt, status: "completed", counts: { created: 3, grades: { A: 1, B: 1, C: 1, D: 0 } }, attention: { humanReviewCount: 1, pendingRuleCount: 2 }, artifacts: [], integrity: { newlyConfirmedRetractions: 1 } };

test("content projects existing Radar fields and excludes D without regrading", () => {
  const before = structuredClone(papers);
  const content = buildRadarNotificationContent(papers, { runId: "radar-fixture", audit });
  assert.equal(content.eventType, "radar_completed");
  assert.equal(content.runId, "radar-fixture");
  assert.equal(content.date, "2026-09-30");
  assert.deepEqual(content.items.map((item) => item.grade), ["A", "B", "C"]);
  assert.deepEqual(content.summary.map((item) => item.value), [12, 3, 1]);
  assert.equal(content.items[0].reason, "Existing reason A");
  assert.deepEqual(papers, before);
});

test("zero and partial Radar results render without invented metadata", () => {
  const empty = formatRadarReport(buildRadarNotificationContent([]));
  assert.match(empty.text, /本轮推荐 0 篇/);
  assert.doesNotMatch(empty.text, /本轮候选|undefined|null/);
  const partial = formatRadarReport(buildRadarNotificationContent([{ title: "English only", final_grade: "B" }]));
  assert.match(partial.text, /本轮推荐 1 篇/);
  assert.doesNotMatch(partial.text, /English only/);
  assert.doesNotMatch(partial.html, /推荐理由|undefined|null/);
});

test("Radar HTML and text use the same content with title hierarchy, summary and footer", () => {
  const result = formatRadarReport(buildRadarNotificationContent(papers, { runId: "radar-fixture", audit }));
  for (const text of ["PaperEcho · Daily Radar", "2026-09-30", "本轮文献概况", "本轮候选：12", "本轮推荐 3 篇", "分级", "radar-fixture", "由 PaperEcho 自动生成"]) {
    assert.ok(result.html.includes(text), text);
    assert.ok(result.text.includes(text), text);
  }
  assert.doesNotMatch(result.html + result.text, /English [ABCD]|中文 [ABCD]|Existing reason|级文献|查看原文|Rule:|LLM:|Confidence:|rule_grade/);
  assert.deepEqual(result.attachments, []);
});

test("all external Radar text is escaped; text preserves literal characters; unsafe URLs omitted", () => {
  const value = `<script>alert('x' & "y")</script>&amp;`;
  const content = buildRadarNotificationContent([{ title: value, translatedTitle: value, journal: value, year: value, final_grade: "A", semantic_reason: value, doi: value, url: "javascript:alert(1)" }], { runId: value, audit: { generatedAt: value, overview: value } });
  const message = formatRadarReport(content);
  assert.doesNotMatch(message.html, /<script>|javascript:/);
  assert.ok(message.html.includes("&lt;script&gt;alert(&#39;x&#39; &amp; &quot;y&quot;)&lt;/script&gt;&amp;amp;"));
  assert.ok(message.text.includes(value));
  const safe = formatRadarReport(buildRadarNotificationContent([{ title: "Link", final_grade: "A", url: 'https://example.test/?q="x"&v=1' }]));
  assert.doesNotMatch(safe.html, /href=|example.test/);
});

test("Weekly content and renderer preserve counts, grades, overview, integrity and warnings", () => {
  const content = buildWeeklyNotificationContent(summary, { overview: "Overview <safe>" });
  assert.equal(content.eventType, "weekly_completed");
  assert.equal(content.generatedAt, audit.generatedAt);
  const result = formatStage5Report(summary, { overview: "Overview <safe>" });
  for (const text of ["本次新增", "分级", "本轮文献概况", "新确认撤稿", "需人工确认", "待确认", "weekly-fixture"]) {
    assert.ok(result.html.includes(text), text);
    assert.ok(result.text.includes(text), text);
  }
  assert.match(result.html, /Overview &lt;safe&gt;/);
  assert.match(result.text, /Overview <safe>/);
  assert.ok(result.html.indexOf("分级情况") < result.html.indexOf("本轮文献概况"));
});

test("Weekly long overview wraps inside the responsive email layout; article identifiers remain private", () => {
  const doi = "10.example/" + "longidentifier".repeat(12);
  const item = { title: "Long title & <literal text>", translatedTitle: "中文译名", final_grade: "A", doi, semantic_reason: "Existing reason" };
  const overview = "Overview " + "long-summary".repeat(100);
  const message = formatStage5Report(summary, { literatureItems: [item], overview });
  assert.match(message.html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(message.html, /table-layout:fixed;overflow-wrap:anywhere;word-break:break-word/);
  assert.ok(message.html.includes(overview));
  assert.ok(message.text.includes(overview));
  assert.doesNotMatch(message.html + message.text, /10.example|Long title|中文译名|Existing reason/);
  assert.equal(message.subject, formatStage5Report(summary).subject);
});

for (const kind of ["radar", "weekly"]) test(`${kind} notification-only retry uses same receipt and sends effectively once`, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "notification-content-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const business = structuredClone(kind === "radar" ? { status: "completed", audit, papers } : summary);
  const before = structuredClone(business);
  const messages = [];
  const invoke = (transport) => kind === "radar"
    ? sendRadarAggregateNotification({ runId: "radar-fixture", urgentItems: business.papers, audit: business.audit, recipient: "reader@example.test", runStateRoot: root, transport })
    : runStage5Notification({ runSummary: { ...business, outputRoot: root }, recipient: "reader@example.test", transport, config: { runStateRoot: root, env: {}, llmClient: null } });
  const failed = await invoke(async (message) => { messages.push(message); return { accepted: false, rejectedCount: 1 }; });
  assert.equal(failed.status, "failed");
  assert.equal((await readNotificationReceipt(failed.receiptPath)).status, "failed");
  const accepted = await invoke(async (message) => { messages.push(message); return { accepted: true, acceptedCount: 1 }; });
  assert.ok(["sent", "accepted"].includes(accepted.status));
  await invoke(async () => assert.fail("duplicate send"));
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], messages[1]);
  assert.equal((await readNotificationReceipt(accepted.receiptPath)).attempts, 2);
  assert.deepEqual(business, before);
  if (kind === "radar") assert.equal(accepted.receiptPath, radarNotificationReceiptPath(root, "radar-fixture", papers, audit));
});
