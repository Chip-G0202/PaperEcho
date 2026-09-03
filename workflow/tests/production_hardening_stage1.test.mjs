import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { preserveStage1PreferenceLearningContext } from "../tools/stage1/main.mjs";
import { buildNormalizedFeedbackLearning } from "../tools/stage1/preference_learning_step.mjs";
import { buildCandidateFeedbackFiles, readPreviousFeedbackWorkbook } from "../tools/lib/review_workbook_reader.mjs";

async function readAnonymousWorkbook(t, rows) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-feedback-reader-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = {
    reviewRoot: path.join(root, "review"),
    desktopRoot: path.join(root, "desktop"),
    projectRoot: path.join(root, "project"),
    researchRoot: path.join(root, "research"),
    lookbackDays: 1,
  };
  const now = new Date("2026-07-03T12:00:00Z");
  const workbookPath = buildCandidateFeedbackFiles(now, options)[0].paths[0];
  await fs.mkdir(path.dirname(workbookPath), { recursive: true });
  const ExcelJS = await import("exceljs");
  const Workbook = ExcelJS.Workbook || ExcelJS.default?.Workbook;
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet("每日反馈");
  for (const row of rows) sheet.addRow(row);
  await workbook.xlsx.writeFile(workbookPath);
  return readPreviousFeedbackWorkbook(now, options);
}

test("feedback-only rows learn while comment remains optional", () => {
  const result = buildNormalizedFeedbackLearning([
    { id: "one", title: "Anonymous one", feedback: " KEEP " },
    { id: "two", title: "Anonymous two", feedback: "drop" },
    { id: "blank", title: "Anonymous blank", feedback: "" },
  ], "anonymous.jsonl");

  assert.equal(result.ok, true);
  assert.equal(result.rows_used, 2);
  assert.equal(result.diagnostics.columns.feedback, true);
  assert.equal(result.diagnostics.columns.comment, false);
  assert.deepEqual(result.signals.map((row) => row.feedback), ["keep", "drop"]);
  assert.deepEqual(result.diagnostics.preference_learning.blockers, []);
});

test("comment context is retained but comment-only rows do not become feedback", () => {
  const withComment = buildNormalizedFeedbackLearning([
    { title: "Anonymous", feedback: "upgrade", comment: "bounded context" },
  ]);
  assert.equal(withComment.rows_used, 1);
  assert.equal(withComment.rows_with_comment, 1);
  assert.equal(withComment.diagnostics.columns.comment, true);

  const commentOnly = buildNormalizedFeedbackLearning([
    { title: "Anonymous", comment: "context without decision" },
  ]);
  assert.equal(commentOnly.ok, false);
  assert.equal(commentOnly.rows_used, 0);
  assert.equal(commentOnly.diagnostics.columns.feedback, false);
  assert.deepEqual(commentOnly.diagnostics.preference_learning.blockers, ["required_feedback_columns_missing"]);
});

test("the unified workbook reader learns feedback without a comment column", async (t) => {
  const result = await readAnonymousWorkbook(t, [
    ["英文标题", "feedback"],
    ["Anonymous one", " KEEP "],
    ["Anonymous two", "drop"],
    ["Anonymous blank", ""],
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.columns.feedback, true);
  assert.equal(result.columns.comment, false);
  assert.equal(result.counts.rows_with_feedback, 2);
  assert.equal(result.counts.empty_feedback, 1);
  assert.deepEqual(result.learning_signals.map((row) => row.feedback), ["keep", "drop"]);
  assert.deepEqual(result.missing_columns, []);
});

test("the unified workbook reader does not treat comment-only rows as feedback", async (t) => {
  const result = await readAnonymousWorkbook(t, [
    ["英文标题", "comment"],
    ["Anonymous one", "context only"],
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.learning_signals.length, 0);
  assert.equal(result.blockers.includes("no_supported_feedback_rows"), true);
});

test("Stage1 aggregation preserves preference audit and learning inputs", () => {
  const preferenceAudit = {
    evidence_total: 3,
    clusters_total: 2,
    summary: { rows_with_feedback: 3 },
  };
  const preferenceLearningInputs = {
    feedbackRows: [{ id: "anonymous", feedback: "keep" }],
    feedbackSource: "anonymous.jsonl",
  };

  const result = preserveStage1PreferenceLearningContext({ preferenceAudit, preferenceLearningInputs });

  assert.deepEqual(result.preferenceAuditWithImpact, preferenceAudit);
  assert.deepEqual(result.preferenceLearningInputs, preferenceLearningInputs);
});
