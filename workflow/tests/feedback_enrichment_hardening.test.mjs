import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { enrichArchivePlanWithZoteroTitleMatches as enrich } from "../tools/maintenance/zotero_feedback_collection_corrections.mjs";
import { runFeedbackItemActionsStep } from "../tools/stage1/feedback_item_actions_step.mjs";
import { buildCorrectionPlan } from "../tools/maintenance/zotero_feedback_collection_corrections.mjs";

const result = (value) => ({ content: [{ text: JSON.stringify(value) }] });
const row = (title) => ({ status: "needs_review", reason: "no_matching_literature_record", feedback: { english_title: title, feedback: "upgrade" }, record: {} });
const empty = { live_items: {} };

test("1070 rows survive, equivalent titles fan out, complete search evidence avoids details", async () => {
  const rows = Array.from({ length: 1070 }, (_, i) => row(`Title ${i % 10}`));
  let searches = 0, progress;
  await enrich(rows, { localLibraryIndex: empty, onProgress: (p) => { progress = p; }, mcpToolCall: async (name, args) => {
    assert.equal(name, "search_library"); searches++;
    return result([{ key: `KEY${searches}`, title: args.title, tags: ["B专题相关"] }]);
  } });
  assert.equal(rows.length, 1070);
  assert.equal(rows.filter((r) => r.status === "planned").length, 1070);
  assert.equal(searches, 10);
  assert.equal(progress.cacheHits, 1060);
  assert.equal(progress.status, "completed");
});

test("negative results cache in run only; transient failures fail closed, never become negatives", async () => {
  let calls = 0;
  const lookup = async () => { calls++; return result([]); };
  await enrich([row("Absent"), row("ABSENT")], { localLibraryIndex: empty, mcpToolCall: lookup });
  assert.equal(calls, 1);
  await enrich([row("Absent")], { localLibraryIndex: empty, mcpToolCall: lookup });
  assert.equal(calls, 2);
  await assert.rejects(enrich([row("A"), row("A")], { localLibraryIndex: empty, mcpToolCall: async () => { throw new Error("503 temporary"); } }), { status: "failed", code: "FEEDBACK_ENRICHMENT_INCOMPLETE" });
});

test("stable key detail reads cache; partial local misses use remote; ambiguity is preserved for drop", async () => {
  let details = 0, searches = 0;
  const rows = [row("A"), row("B")];
  await enrich(rows, { localLibraryIndex: { ...empty, coverage: { zotero: { complete: false } } }, mcpToolCall: async (name, args) => {
    if (name === "search_library") { searches++; return result([{ key: "KEY", title: args.title }]); }
    details++; return result({ title: "A", tags: ["B专题相关"] });
  } });
  assert.equal(searches, 2); assert.equal(details, 1);
  const drop = row("Ambiguous"); drop.feedback.feedback = "drop";
  await enrich([drop], { localLibraryIndex: empty, mcpToolCall: async () => result([{ key: "ONE", title: "Ambiguous" }, { key: "TWO", title: "Ambiguous" }]) });
  assert.equal(drop.status, "conflict");
});

test("deadline stops scheduling, reports heartbeat before return, retains every input row", async () => {
  let calls = 0; const snapshots = [];
  const rows = Array.from({ length: 1070 }, (_, i) => row(`Title ${i}`));
  await assert.rejects(enrich(rows, { localLibraryIndex: empty, timeoutMs: 70, heartbeatMs: 10, onProgress: (p) => snapshots.push(p), mcpToolCall: async () => { calls++; await new Promise((r) => setTimeout(r, 150)); return result([]); } }), { status: "timed_out" });
  assert.equal(calls, 1); assert.equal(rows.length, 1070);
  assert.ok(snapshots.filter((p) => p.status === "running").length >= 3);
  assert.equal(snapshots.at(-1).status, "timed_out");
  assert.throws(() => buildCorrectionPlan({ archivePlan: rows }), { status: "timed_out" });
  await new Promise((r) => setTimeout(r, 170));
  assert.equal(calls, 1);
});

test("abort signal interrupts with no next query", async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(enrich([row("A"), row("B")], { localLibraryIndex: empty, signal: controller.signal, mcpToolCall: async () => { calls++; controller.abort(); return result([]); } }), { status: "interrupted" });
  assert.equal(calls, 1);
});

test("Stage1 enrichment timeout prevents collection discovery, apply and consumable plan", async () => {
  const root = path.resolve("tests/runs/feedback-enrichment");
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, "case-"));
  const calls = [];
  try {
    await assert.rejects(runFeedbackItemActionsStep({ connectorOk: true, researchRoot: dir, reviewRoot: dir, pipeDir: dir, startedAt: new Date().toISOString(), applyItemActions: true, timingContext: { recordTiming() {}, flushTimingDiagnostics() {}, lastKnownPhase: "plan_build" }, dependencies: {
      scanFeedbackRows: async () => [{}], scanLiteratureRecords: async () => [], buildMovePlan: () => [row("A"), row("B")],
      enrichmentOptions: { localLibraryIndex: empty, timeoutMs: 40, heartbeatMs: 10 },
      createCompatMcpToolCall: async () => async (name) => { calls.push(name); await new Promise((r) => setTimeout(r, 100)); return result([]); },
    } }), { status: "timed_out" });
    assert.deepEqual(calls, ["search_library"]);
    await assert.rejects(fs.access(path.join(dir, "feedback_item_actions_plan.json")));
    const progress = JSON.parse(await fs.readFile(path.join(dir, "feedback_item_actions_progress.json"), "utf8"));
    assert.equal(progress.status, "timed_out"); assert.equal(progress.correction_mutation_started, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
