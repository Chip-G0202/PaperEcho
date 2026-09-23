import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadWorkflowRules } from "../tools/lib/literature_config.mjs";
import { classifyItem } from "../tools/stage1/rule_classifier.mjs";
import { buildWritebackReadyItems } from "../tools/lib/pipeline_stage_support.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("loadWorkflowRules defaults to project config root", () => {
  const rules = loadWorkflowRules();
  assert.equal(rules.path, path.join(repoRoot, "config", "review-workflow-rules.json"));
  assert.deepEqual(rules.warnings, []);
  assert.ok(rules.config.triage?.research_focus?.core_biology_terms?.includes("example biological context"));
});

test("configured topic groups, rather than a lone broad term, determine admission", () => {
  assert.equal(classifyItem({
    title: "Developing example biological context opportunities",
    abstract: "",
  }).grade, "D");

  assert.equal(classifyItem({
    title: "Synthetic example exposure links example biological context to example mechanism evidence",
    abstract: "",
  }).grade, "A");

  assert.equal(classifyItem({ title: "example biological context in example study design" }).grade, "D");
  assert.equal(classifyItem({ title: "example biological context with example mechanism" }).grade, "C");
  assert.equal(classifyItem({ title: "example exposure in example study design" }).grade, "B");
});

test("a semantic D review remains auditable but is not admitted to Zotero", () => {
  const review = { title: "Unrelated result", grade: "C", rule_grade: "C", final_grade: "C", llm_review_grade: "D", needs_human_review: true };
  const majorReview = { title: "Major disagreement", grade: "B", rule_grade: "B", final_grade: "B", llm_review_grade: "D", needs_human_review: true };
  const admitted = { title: "Relevant result", grade: "C", rule_grade: "C", final_grade: "C", llm_review_grade: "C" };
  assert.deepEqual(buildWritebackReadyItems([review, majorReview, admitted]).map((item) => item.title), ["Relevant result"]);
});
