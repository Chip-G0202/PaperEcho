import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildExportManifest, buildRunSummary, pipelineModeFromBackend } from "../tools/lib/run_summary.mjs";

test("desktop web and local summaries share one schema without invented counts", () => {
  for (const pipelineMode of ["desktop", "web", "local"]) {
    const summary = buildRunSummary({ runId: `${pipelineMode}-1`, pipelineMode, status: "success", outputRoot: "." });
    assert.equal(summary.schemaVersion, 1);
    assert.deepEqual(summary.counts, {
      retrieved: null, created: null, updated: null, deduped: null, feedback: null, translated: null,
      grades: { A: null, B: null, C: null, D: null },
    });
  }
  assert.equal(pipelineModeFromBackend("web_api"), "web");
  assert.equal(pipelineModeFromBackend("cli"), "desktop");
});

test("summary maps existing report fields and keeps only mail artifact kinds", () => {
  const summary = buildRunSummary({
    runId: "r1", pipelineMode: "desktop", status: "success",
    runReport: { counts: { fetched_count: 9, duplicate_removed_count: 2, grade_counts: { A: 1, B: 2, C: 3, D: 1 } } },
    writebackSummary: { counters: { created: 4 } }, translationSummary: { success_count: 3 }, feedbackCount: 2,
    artifacts: [{ kind: "weekly_xlsx", path: "x", displayName: "x.xlsx", sizeBytes: 1 }, { kind: "timings", path: "y" }],
  });
  assert.equal(summary.counts.retrieved, 9);
  assert.equal(summary.counts.created, 4);
  assert.equal(summary.counts.deduped, 2);
  assert.equal(summary.counts.feedback, 2);
  assert.equal(summary.counts.translated, 3);
  assert.deepEqual(summary.counts.grades, { A: 1, B: 2, C: 3, D: 1 });
  assert.deepEqual(summary.artifacts.map((item) => item.kind), ["weekly_xlsx"]);
});

test("created items define both created count and grades for the same run scope", () => {
  const createdItems = [{ grade: "A" }, { final_grade: "B" }, { grade: "C" }, { grade: "" }];
  const summary = buildRunSummary({ runId: "r-created", pipelineMode: "local", status: "success", createdItems, localPersistence: { created: 99 }, gradeCounts: { A: 99 } });
  assert.equal(summary.counts.created, 4);
  assert.deepEqual(summary.counts.grades, { A: 1, B: 1, C: 1, D: 0 });
});

test("summary maps human-review and pending-rule attention without reading exports", () => {
  const summary = buildRunSummary({
    runId: "r-attention", pipelineMode: "local", status: "success", humanReviewCount: 2,
    runReport: { steps: { standards_rule_suggestions: { standards_rule_suggestions_pending_count: 3 } } },
  });
  assert.deepEqual(summary.attention, { humanReviewCount: 2, pendingRuleCount: 3 });
});

test("summary distinguishes current integrity confirmations from applied mutations", () => {
  const summary = buildRunSummary({
    runId: "r-integrity", pipelineMode: "desktop", status: "success",
    runReport: { steps: { literature_integrity: { newly_confirmed_retraction_count: 2, new_correction_count: 1, new_expression_of_concern_count: 1, conflict_count: 3 } } },
    writebackSummary: { integrity: { results: [
      { targetStatus: "retraction", status: "applied" },
      { targetStatus: "retraction", status: "pending_delete" },
      { targetStatus: "correction", status: "confirmed_not_applied" },
    ] } },
  });
  assert.deepEqual(summary.integrity, { newlyConfirmedRetractions: 2, newCorrections: 1, newExpressionsOfConcern: 1, appliedRetractions: 1, pendingDelete: 1, confirmedNotApplied: 1, unresolvedConflicts: 3 });
});

test("export manifest uses only explicit current-run xlsx and docx paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperflow-manifest-"));
  const xlsx = path.join(root, "周报.xlsx");
  const docx = path.join(root, "月报.docx");
  await fs.writeFile(xlsx, "xlsx");
  await fs.writeFile(docx, "docx");
  await fs.writeFile(path.join(root, "timings.json"), "{}");
  const manifest = await buildExportManifest({ actual_output_path: xlsx, monthly_docx_report_path: docx }, { outputRoot: root });
  assert.deepEqual(manifest.artifacts.map((item) => item.kind), ["weekly_xlsx", "monthly_docx"]);
  assert.deepEqual(manifest.artifacts.map((item) => item.displayName), ["周报.xlsx", "月报.docx"]);
  assert.equal(manifest.artifacts.some((item) => item.path.endsWith("timings.json")), false);
});
