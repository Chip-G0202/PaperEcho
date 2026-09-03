import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildPreferenceLearningInputs, runLlmPreferenceLearning } from "../tools/stage1/llm_preference_learning.mjs";
import { buildLlmReviewCandidates, resolveEligibleRuleGrades, resolveGradeReviewItemLimit, reviewGradesWithLlm } from "../tools/stage1/llm_grade_reviewer.mjs";
import { callJsonLlm, parseJsonOnlyWithInfo } from "../tools/lib/llm_json_support.mjs";
import { dedupWithDiagnostics } from "../tools/stage1/main.mjs";
import { understandPreferenceEvaluation } from "../tools/lib/preference_learning_support.mjs";
import { translateTitlesBatch } from "../tools/lib/title_translation_support.mjs";

describe("LLM workflow", () => {
  it("keeps the legacy Stage 1 review limit when config does not opt into full coverage", () => {
    assert.deepEqual(
      resolveGradeReviewItemLimit({}, { candidateCount: 481 }),
      { maxItems: 50, source: "default" },
    );
  });

  it("reviews every post-dedupe candidate when config explicitly opts into full coverage", () => {
    assert.deepEqual(
      resolveGradeReviewItemLimit(
        { max_grade_review_items: 0, max_grade_review_items_mode: "full_coverage_by_default" },
        { candidateCount: 481 },
      ),
      { maxItems: 481, source: "full_coverage" },
    );
  });

  it("keeps a runtime review limit run-scoped and ahead of configured full coverage", () => {
    const config = { max_grade_review_items: 0, max_grade_review_items_mode: "full_coverage_by_default" };

    assert.deepEqual(
      resolveGradeReviewItemLimit(config, { candidateCount: 481, runtimeOverride: 25 }),
      { maxItems: 25, source: "runtime_override" },
    );
    assert.deepEqual(
      resolveGradeReviewItemLimit(config, { candidateCount: 481 }),
      { maxItems: 481, source: "full_coverage" },
    );
    assert.equal(config.max_grade_review_items, 0);
  });

  it("fails closed on malformed runtime review limits", () => {
    assert.deepEqual(
      resolveGradeReviewItemLimit({}, { candidateCount: 481, runtimeOverride: "all" }),
      { maxItems: 50, source: "default" },
    );
    assert.deepEqual(
      resolveGradeReviewItemLimit({}, { candidateCount: 481, runtimeOverride: { maxItems: 481 } }),
      { maxItems: 50, source: "default" },
    );
  });

  it("preserves an explicit configured review cap", () => {
    assert.deepEqual(
      resolveGradeReviewItemLimit({ max_grade_review_items: 30 }, { candidateCount: 481 }),
      { maxItems: 30, source: "config" },
    );
  });

  it("disabled LLM mode skips without sending requests even when an API key exists", async () => {
    let called = false;
    const result = await callJsonLlm({
      taskType: "dry_run_disabled",
      prompt: "return json",
      input: { value: 1 },
      runtime: {
        llm_mode: "disabled",
        apiKeyConfigured: true,
        apiKey: "should-not-be-used",
        endpoint: "https://example.invalid/v1/chat/completions",
      },
      llmClient: async () => {
        called = true;
        return { ok: true };
      },
    });

    assert.equal(called, false);
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.blocker, "llm_disabled");
    assert.equal(result.request_would_have_been_sent, false);
  });

  it("mock LLM mode returns deterministic mock JSON without sending requests", async () => {
    let called = false;
    const result = await callJsonLlm({
      taskType: "preference_learning",
      prompt: "return json",
      input: { feedback_rows: [{ title: "A", feedback: "keep" }] },
      runtime: {
        llm_mode: "mock",
        apiKeyConfigured: true,
        apiKey: "should-not-be-used",
        endpoint: "https://example.invalid/v1/chat/completions",
      },
      llmClient: async () => {
        called = true;
        return { ok: true };
      },
    });

    assert.equal(called, false);
    assert.equal(result.ok, true);
    assert.equal(result.mock_response_used, true);
    assert.equal(result.request_would_have_been_sent, false);
    assert.equal(Array.isArray(result.output.preference_themes), true);
  });

  it("runs title translation batches with bounded concurrency", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "translation_concurrency_"));
    const titles = Array.from({ length: 12 }, (_, i) => `Title ${i + 1}`);
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await translateTitlesBatch(titles, undefined, {
      cachePath: path.join(tmpRoot, "translation-cache.json"),
      batchSize: 12,
      runtime: {
        batchSize: 12,
        concurrencyLimit: 4,
        providerConcurrencyLimit: 2500,
        model: "mock-model",
        temperature: 0,
        top_p: 1,
        stream: false,
        rateLimit: { rpm: null, tpm: null },
      },
      translateOneImpl: async (title) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return { ok: true, zh: `ZH ${title}` };
      },
    });

    assert.equal(result.usage.concurrency_limit, 4);
    assert.equal(maxInFlight, 4);
    assert.equal(result.map.size, 12);
    assert.equal(result.usage.request_timing.total_requests, 12);
    assert.equal(result.usage.request_timing.slowest_top5.length, 5);
    assert.ok(result.usage.request_timing.max_ms >= 0);
    assert.equal("title" in result.usage.request_timing.slowest_top5[0], false);
    assert.match(result.usage.request_timing.slowest_top5[0].title_hash, /^[0-9a-f]{64}$/);
  });

  it("returns and caches only safe raw response metadata for successful LLM JSON calls", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm_json_cache_"));
    const cachePath = path.join(tmpRoot, "llm-cache.json");
    const rawResponse = JSON.stringify({
      items: [{ id: "item-1", llm_review_grade: "B", confidence: "high", reason: "ok", needs_human_review: false }],
      warnings: [],
    });

    const result = await callJsonLlm({
      taskType: "grade_review",
      prompt: "return json",
      input: { items: [{ id: "item-1", title: "A", rule_grade: "B" }] },
      cachePath,
      runtime: {
        llm_mode: "real",
        apiKeyConfigured: true,
        apiKey: "should-not-be-used",
        apiKeyEnvName: "PREFERENCE_LEARNING_API_KEY",
        model: "mock-model",
        endpoint: "mock://llm",
      },
      llmClient: async () => rawResponse,
    });

    assert.equal(result.ok, true);
    assert.equal("raw_text" in result, false);
    assert.equal(result.raw_response_length, rawResponse.length);
    assert.match(result.raw_response_hash, /^[0-9a-f]{64}$/);

    const cache = JSON.parse(await fs.readFile(cachePath, "utf8"));
    const cachedEntry = cache[result.cache_key];
    assert.ok(cachedEntry);
    assert.equal("raw_text" in cachedEntry, false);
    assert.equal(cachedEntry.raw_response_length, rawResponse.length);
    assert.equal(cachedEntry.raw_response_hash, result.raw_response_hash);
  });

  it("cache hits do not count as current real LLM requests", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm_json_cache_hit_"));
    const cachePath = path.join(tmpRoot, "llm-cache.json");
    const input = { items: [{ id: "item-1", title: "A", rule_grade: "B" }] };
    let calls = 0;

    const first = await callJsonLlm({
      taskType: "grade_review",
      prompt: "return json",
      input,
      cachePath,
      runtime: {
        llm_mode: "real",
        apiKeyConfigured: true,
        apiKey: "should-not-be-used",
        apiKeyEnvName: "PREFERENCE_LEARNING_API_KEY",
        model: "mock-model",
        endpoint: "mock://llm",
      },
      llmClient: async () => {
        calls += 1;
        return { items: [{ id: "item-1", llm_review_grade: "B", confidence: "high", reason: "ok", needs_human_review: false }] };
      },
    });
    const second = await callJsonLlm({
      taskType: "grade_review",
      prompt: "return json",
      input,
      cachePath,
      runtime: {
        llm_mode: "real",
        apiKeyConfigured: true,
        apiKey: "should-not-be-used",
        apiKeyEnvName: "PREFERENCE_LEARNING_API_KEY",
        model: "mock-model",
        endpoint: "mock://llm",
      },
      llmClient: async () => {
        calls += 1;
        return {};
      },
    });

    assert.equal(first.cache_hit, false);
    assert.equal(second.cache_hit, true);
    assert.equal(second.request_would_have_been_sent, false);
    assert.equal(second.real_request_sent, false);
    assert.equal(calls, 1);
  });

  it("repairs missing commas between LLM JSON array elements", async () => {
    const malformed = `{
      "preference_themes": [
        {
          "theme": "example topic term 020l biology",
          "evidence_titles": [
            "Synthetic organelle fixture alpha"
            "Synthetic regulator fixture beta with Unicode 标题"
          ]
        }
        {
          "theme": "non-biological topics",
          "evidence_titles": ["Space telescope rescue"]
        }
      ],
      "suggestion_candidates": []
    }`;

    const parsed = parseJsonOnlyWithInfo(malformed);
    assert.equal(parsed.repaired, true);
    assert.equal(parsed.value.preference_themes.length, 2);
    assert.deepEqual(parsed.value.preference_themes[0].evidence_titles, [
      "Synthetic organelle fixture alpha",
      "Synthetic regulator fixture beta with Unicode 标题",
    ]);

    const llm = await callJsonLlm({
      taskType: "preference_learning",
      prompt: "return json",
      input: { feedback_rows: [{ title: "A", feedback: "keep" }] },
      runtime: {
        llm_mode: "real",
        apiKeyConfigured: true,
        apiKey: "should-not-be-used",
        apiKeyEnvName: "PREFERENCE_LEARNING_API_KEY",
        model: "mock-model",
        endpoint: "mock://llm",
      },
      cacheEnabled: false,
      llmClient: async () => malformed,
    });

    assert.equal(llm.ok, true);
    assert.equal(llm.json_repaired, true);
    assert.match(llm.parse_error_summary, /Expected|JSON/i);
  });

  it("keeps preference learning raw response content out of results", async () => {
    const raw = `SECRET_RAW_RESPONSE_SHOULD_NOT_LEAK
{
  "rules_added": ["prefer mechanistic example topic term 011 evidence"],
  "rules_deleted": [],
  "rules_changed": [],
  "keywords_added": { "required": [], "optional": [], "negative": [] },
  "keywords_removed": [],
  "negative_keywords_added": [],
  "unmapped_feedback": []
}`;

    const result = await understandPreferenceEvaluation(
      { evaluation_text: "prefer mechanistic example topic term 011 evidence" },
      {
        runtime: {
          llm_mode: "real",
          apiKeyConfigured: true,
          apiKey: "should-not-be-used",
          max_retries: 0,
          timeout_ms: 1000,
          promptTemplate: "${inputJson}",
        },
        llmClient: async () => raw,
      },
    );

    assert.equal(result.ok, true);
    assert.equal("raw_text" in result, false);
    assert.equal(result.raw_text_removed, true);
    assert.equal(result.raw_response_length, raw.length);
    assert.match(result.raw_response_hash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(result).includes("SECRET_RAW_RESPONSE_SHOULD_NOT_LEAK"), false);
  });

  it("generates auditable suggestion candidates from feedback rows without writing the pending log", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm_pref_"));
    const outputPath = path.join(tmpRoot, "llm_preference_learning.json");
    const suggestionsLogPath = path.join(tmpRoot, "rule_suggestions.json");
    const feedbackRows = [
      { title: "Synthetic model A reveals example mechanism evidence", feedback: "upgrade", user_comment: "configured model should be kept", rule_grade: "C", semantic_grade: "", final_grade: "C" },
      { title: "Synthetic out-of-scope dashboard fixture", feedback: "drop", user_comment: "outside configured scope", rule_grade: "B", semantic_grade: "", final_grade: "B" },
    ];

    const result = await runLlmPreferenceLearning({
      feedbackRows,
      outputPath,
      suggestionsLogPath,
      config: { enabled: true, preference_learning_enabled: true, cache_enabled: false, strict_json: false },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      llmClient: async () => ({
        preference_summary: {
          positive_interests: [{ theme: "example configured model", source_feedback_types: ["upgrade"], evidence_count: 1, representative_titles: [feedbackRows[0].title], representative_terms: ["Synthetic model A"], interpretation: "configured model evidence was under-ranked", confidence: "low" }],
          negative_interests: [],
          upgrade_patterns: [],
          downgrade_patterns: [],
        },
        preference_themes: [{
          theme: "mouse example topic term 011",
          polarity: "upgrade_pattern",
          inferred_reason_type: "grading_error",
          should_affect_rules: true,
          evidence_feedback_types: ["upgrade"],
          evidence_titles: [feedbackRows[0].title],
          confidence: "low",
          risk: "single-row evidence",
        }],
        suggestion_candidates: [{
          id: "llm-test-1",
          change_type: "add_rule",
          target: "screening_standards.md",
          rule_text: "Synthetic model A 等标题信号可作为示例模型证据。",
          rationale: "User upgraded a synthetic model title.",
          evidence_feedback_types: ["upgrade"],
          evidence_titles: [feedbackRows[0].title],
          confidence: "low",
          risk: "single-row evidence; requires confirmation",
          requires_human_approval: true,
        }],
        warnings: ["single evidence row; keep low confidence"],
      }),
    });

    assert.equal(result.ok, true);
    const written = JSON.parse(await fs.readFile(outputPath, "utf8"));
    assert.equal(written.suggestion_candidates.length, 1);
    assert.equal(written.pending_rule_suggestions.length, 0);
    await assert.rejects(() => fs.readFile(suggestionsLogPath, "utf8"), /ENOENT/);
  });

  it("writes LLM review grade to semantic_grade alias and synthesizes final grade deterministically", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm_grade_"));
    const outputPath = path.join(tmpRoot, "llm_grade_review.json");
    const items = [
      { id: "item-1", title: "Synthetic model A reveals example mechanism activation", grade: "C", rule_grade: "C" },
    ];

    const result = await reviewGradesWithLlm({
      items,
      outputPath,
      config: { enabled: true, grade_review_enabled: true, cache_enabled: false, review_scope: "B_C_only", max_grade_review_items: 20 },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      llmClient: async () => ({
        items: [{
          id: "item-1",
          title: items[0].title,
          rule_grade: "C",
          llm_review_grade: "B",
          confidence: "high",
          reason: "Synthetic model A matches the configured fixture.",
          needs_human_review: false,
        }],
      }),
    });

    assert.equal(result.ok, true);
    assert.equal(items[0].llm_review_grade, "B");
    assert.equal(items[0].semantic_grade, "B");
    assert.equal(items[0].final_grade, "B");
    assert.equal(items[0].semantic_source, "llm_title_review");
    assert.equal(result.semantic_grade_source, "llm_title_review_grade");
    assert.equal(items[0].needs_human_review, false);
    const written = JSON.parse(await fs.readFile(outputPath, "utf8"));
    assert.equal(Array.isArray(written.items[0].recognized_concepts), true);
    assert.equal(written.items[0].recognized_concepts.length, 0);
  });

  it("defaults LLM grade review eligibility to A/B/C and skips D", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm_grade_abc_"));
    const outputPath = path.join(tmpRoot, "llm_grade_review.json");
    const items = [
      { id: "a-1", title: "Synthetic A-grade fixture with Unicode 标题, HTML <tag> escaping, and a deliberately extended suffix", grade: "A", rule_grade: "A" },
      { id: "b-1", title: "Synthetic B-grade fixture for stable ordering", grade: "B", rule_grade: "B" },
      { id: "c-1", title: "Synthetic C-grade fixture for stable ordering", grade: "C", rule_grade: "C" },
      { id: "d-1", title: "Synthetic D-grade fixture for eligibility exclusion", grade: "D", rule_grade: "D" },
    ];

    const result = await reviewGradesWithLlm({
      items,
      outputPath,
      config: { enabled: true, grade_review_enabled: true, cache_enabled: false },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      llmClient: async (input) => ({
        items: input.items.map((item) => ({
          id: item.id,
          title: item.title,
          rule_grade: item.rule_grade,
          llm_review_grade: item.rule_grade,
          confidence: "high",
          reason: "keep rule grade",
          needs_human_review: false,
        })),
      }),
    });

    assert.deepEqual(resolveEligibleRuleGrades({}), ["A", "B", "C"]);
    assert.deepEqual(result.eligible_rule_grades, ["A", "B", "C"]);
    assert.equal(result.items_reviewed, 3);
    assert.equal(items[0].llm_review_grade, "A");
    assert.equal(items[1].llm_review_grade, "B");
    assert.equal(items[2].llm_review_grade, "C");
    assert.equal(items[3].llm_review_grade, "");
    assert.equal(items[3].final_grade, "D");
    const written = JSON.parse(await fs.readFile(outputPath, "utf8"));
    assert.deepEqual(written.eligible_rule_grades, ["A", "B", "C"]);
    assert.equal(written.llm_review_eligible_count, 3);
  });

  it("records LLM grade review progress without changing final grade synthesis", async () => {
    const progressEvents = [];
    const items = [
      { id: "a-1", title: "Synthetic A-grade review fixture", grade: "A", rule_grade: "A" },
      { id: "b-1", title: "Developmental example topic term 018", grade: "B", rule_grade: "B" },
    ];

    const result = await reviewGradesWithLlm({
      items,
      config: { enabled: true, grade_review_enabled: true, cache_enabled: false, batch_size: 1 },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      progressCallback: async (event) => progressEvents.push(event),
      llmClient: async (input) => ({
        items: input.items.map((item) => ({
          id: item.id,
          title: item.title,
          rule_grade: item.rule_grade,
          llm_review_grade: item.rule_grade === "A" ? "B" : "B",
          confidence: "high",
          reason: "test review",
          needs_human_review: false,
        })),
      }),
    });

    assert.equal(result.batches_attempted, 2);
    assert.equal(result.timing_diagnostics.total_batches, 2);
    assert.equal(result.timing_diagnostics.total_request_attempts, 2);
    assert.equal(result.timing_diagnostics.slowest_top5.length, 2);
    assert.equal("prompt" in result.timing_diagnostics, false);
    assert.equal("raw_response" in result.timing_diagnostics, false);
    assert.equal("prompt_preview" in result.timing_diagnostics.slowest_top5[0], false);
    assert.ok(progressEvents.some((event) => event.stage === "llm_grade_review_batch" && Number.isFinite(event.duration_ms)));
    assert.ok(progressEvents.some((event) => event.stage === "llm_grade_review" && event.status === "started"));
    assert.equal(progressEvents.filter((event) => event.stage === "llm_grade_review_batch" && event.status === "completed").length, 2);
    assert.equal(items[0].llm_review_grade, "B");
    assert.equal(items[0].final_grade, "B");
  });

  it("runs LLM grade review batches with bounded concurrency and stable item application", async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      id: `item-${index + 1}`,
      title: `Concurrent title ${index + 1}`,
      grade: "B",
      rule_grade: "B",
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await reviewGradesWithLlm({
      items,
      config: { enabled: true, grade_review_enabled: true, cache_enabled: false, batch_size: 2, batch_concurrency: 2 },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      llmClient: async (input) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, input.items[0].id === "item-1" ? 30 : 5));
        inFlight -= 1;
        return {
          items: input.items.map((item) => ({
            id: item.id,
            title: item.title,
            rule_grade: item.rule_grade,
            llm_review_grade: item.rule_grade,
            confidence: "high",
            reason: "keep rule grade",
            needs_human_review: false,
          })),
          warnings: [],
        };
      },
    });

    assert.equal(maxInFlight, 2);
    assert.equal(result.batch_concurrency, 2);
    assert.equal(result.timing_diagnostics.batch_concurrency, 2);
    assert.equal(result.timing_diagnostics.total_batches, 3);
    assert.equal(result.timing_diagnostics.total_request_attempts, 3);
    assert.ok(result.timing_diagnostics.total_prompt_chars > 0);
    assert.deepEqual(items.map((item) => item.llm_review_grade), ["B", "B", "B", "B", "B", "B"]);
  });

  it("retries a parse-failed grade review batch with stricter JSON before splitting", async () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      id: `item-${index + 1}`,
      title: `Test title ${index + 1}`,
      grade: "B",
      rule_grade: "B",
    }));
    const calls = [];
    const llmClient = async (input) => {
      calls.push({ size: input.items.length, retryMode: input.retry_mode || "" });
      if (calls.length === 1) return '{"items":[{"id":"broken"';
      return {
        items: input.items.map((item) => ({
          id: item.id,
          llm_review_grade: item.rule_grade,
          confidence: "medium",
          reason: "test review",
          needs_human_review: false,
        })),
        warnings: [],
      };
    };

    const result = await reviewGradesWithLlm({
      items,
      config: { batch_size: 10, max_grade_review_items: 10, cache_enabled: false },
      runtime: { llm_mode: "real", model: "test-model", endpoint: "mock://test" },
      llmClient,
    });

    assert.deepEqual(calls, [
      { size: 10, retryMode: "standard" },
      { size: 10, retryMode: "strict_json_retry" },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.retry_batch_count, 1);
    assert.equal(result.retry_success_count, 1);
    assert.equal(result.split_batch_count, 0);
    assert.equal(result.failed_batch_count, 0);
    assert.equal(result.failed_batch_attempt_count, 1);
    assert.equal(result.items_with_semantic_grade, 10);
  });

  it("splits grade review batches only after strict JSON retry also fails", async () => {
    const items = Array.from({ length: 6 }, (_, index) => ({
      id: `item-${index + 1}`,
      title: `Test title ${index + 1}`,
      grade: "B",
      rule_grade: "B",
    }));
    const calls = [];
    const llmClient = async (input) => {
      calls.push({ size: input.items.length, retryMode: input.retry_mode || "" });
      if (calls.length <= 2) return '{"items":[{"id":"broken"';
      return {
        items: input.items.map((item) => ({
          id: item.id,
          llm_review_grade: item.rule_grade,
          confidence: "medium",
          reason: "test review",
          needs_human_review: false,
        })),
        warnings: [],
      };
    };

    const result = await reviewGradesWithLlm({
      items,
      config: { batch_size: 6, max_grade_review_items: 6, cache_enabled: false },
      runtime: { llm_mode: "real", model: "test-model", endpoint: "mock://test" },
      llmClient,
    });

    assert.deepEqual(calls, [
      { size: 6, retryMode: "standard" },
      { size: 6, retryMode: "strict_json_retry" },
      { size: 3, retryMode: "split_after_parse_failure" },
      { size: 3, retryMode: "split_after_parse_failure" },
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.retry_batch_count, 1);
    assert.equal(result.retry_success_count, 0);
    assert.equal(result.split_batch_count, 2);
    assert.equal(result.split_success_count, 2);
    assert.equal(result.failed_batch_count, 0);
    assert.equal(result.failed_batch_attempt_count, 2);
    assert.equal(result.items_with_semantic_grade, 6);
  });

  it("copies pre-LLM Zotero dedupe diagnostics into grade review report", async () => {
    const items = [
      { id: "new", title: "New candidate", grade: "B", rule_grade: "B" },
      { id: "failed", title: "Duplicate check failed candidate", grade: "C", rule_grade: "C", pre_llm_duplicate_check_failed: true },
    ];

    const result = await reviewGradesWithLlm({
      items,
      config: { enabled: true, grade_review_enabled: true, cache_enabled: false, batch_size: 2 },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      reviewInputDiagnostics: {
        pre_llm_zotero_duplicate_check_enabled: true,
        pre_llm_eligible_count: 3,
        skipped_existing_before_review_count: 1,
        duplicate_check_failed_reviewed_count: 1,
      },
      llmClient: async (input) => ({
        items: input.items.map((item) => ({
          id: item.id,
          title: item.title,
          rule_grade: item.rule_grade,
          llm_review_grade: item.rule_grade,
          confidence: "high",
          reason: "keep rule grade",
          needs_human_review: false,
        })),
        warnings: [],
      }),
    });

    assert.equal(result.items_reviewed, 2);
    assert.equal(result.pre_llm_zotero_duplicate_check_enabled, true);
    assert.equal(result.pre_llm_eligible_count, 3);
    assert.equal(result.skipped_existing_before_review_count, 1);
    assert.equal(result.duplicate_check_failed_reviewed_count, 1);
  });

  it("keeps rule and final grades for eligible items skipped by max review cap", async () => {
    const items = [
      { id: "a-1", title: "example exposure example topic term 011 example topic term 040", grade: "A", rule_grade: "A" },
      { id: "b-1", title: "Developmental example topic term 018 example topic term 038", grade: "B", rule_grade: "B" },
      { id: "c-1", title: "exampleOrganelle in neural cells", grade: "C", rule_grade: "C" },
      { id: "d-1", title: "Wastewater treatment", grade: "D", rule_grade: "D" },
    ];

    const result = await reviewGradesWithLlm({
      items,
      config: { enabled: true, grade_review_enabled: true, cache_enabled: false, max_grade_review_items: 2 },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      llmClient: async (input) => ({
        items: input.items.map((item) => ({
          id: item.id,
          title: item.title,
          rule_grade: item.rule_grade,
          llm_review_grade: item.rule_grade,
          confidence: "high",
          reason: "keep rule grade",
          needs_human_review: false,
        })),
      }),
    });

    assert.equal(result.items_reviewed, 2);
    assert.equal(items[0].final_grade, "A");
    assert.equal(items[1].final_grade, "B");
    assert.equal(items[2].llm_review_grade, "");
    assert.equal(items[2].final_grade, "C");
    assert.equal(items[3].llm_review_grade, "");
    assert.equal(items[3].final_grade, "D");
  });

  it("uses rule_context_summary in title-only prompt without fixed mouse hints", async () => {
    let capturedInput;
    let capturedRuntime;
    const items = [
      { id: "item-1", title: "Inflammatory example topic term 040 activation", grade: "C", rule_grade: "C" },
    ];
    const ruleContextSummary = {
      prompt_version: "llm-rule-context-v1",
      context_hash: "context-hash",
      sources: [
        { path: "review_results/文献评价/screening_standards.md", type: "official_screening_standards", included_for_grade_review: true, included_as_official_rule: true },
        { path: "config/pubmed_pmc_search.json", type: "search_context", included_for_grade_review: true, included_as_official_rule: false, can_be_used_for_grading: false },
      ],
      official_screening_standards_summary: "正式规则摘要",
      machine_grading_rules_summary: "机器规则摘要",
      search_context_summary: "检索术语上下文",
      pending_suggestions_summary: "未确认建议摘要 SHOULD_NOT_REACH_GRADE_PROMPT",
      pending_suggestions_metadata: {
        pending_suggestions_excluded_from_grade_review: true,
        pending_count: 1,
        pending_hash: "pending-hash",
      },
      constraints: [
        "Pending suggestions and candidates are not official grading rules.",
        "Search context explains retrieval scope and terminology but is not a direct grading rule.",
      ],
    };

    await reviewGradesWithLlm({
      items,
      ruleContextSummary,
      config: { enabled: true, grade_review_enabled: true, cache_enabled: false, review_scope: "all" },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      llmClient: async (input, runtime) => {
        capturedInput = input;
        capturedRuntime = runtime;
        return {
          items: [{
            id: "item-1",
            title: items[0].title,
            rule_grade: "C",
            llm_review_grade: "C",
            confidence: "low",
            reason: "Title evidence is insufficient; keep rule grade.",
            needs_human_review: false,
          }],
        };
      },
    });

    assert.equal(capturedInput.rule_context_summary.context_hash, "context-hash");
    assert.equal(capturedInput.rule_context_summary.pending_suggestions_summary, "");
    assert.equal(capturedInput.rule_context_summary.pending_suggestions_metadata.pending_count, 1);
    assert.equal(capturedInput.rule_context_summary.pending_suggestions_metadata.pending_hash, "pending-hash");
    assert.equal(capturedInput.review_scope.scope, "title_only");
    assert.equal(capturedInput.review_scope.abstract_used, false);
    assert.equal("prompt_preview" in capturedRuntime, false);
    assert.equal(capturedRuntime.prompt_length > 0, true);
    assert.match(capturedRuntime.prompt_hash, /^[0-9a-f]{64}$/);
    assert.equal(capturedRuntime.prompt_preview_truncated.length <= 200, true);
    assert.equal(capturedRuntime.prompt_preview_truncated.includes("title-only"), true);
    assert.equal(/private_fixture_marker|private_model_hint/.test(capturedRuntime.prompt_preview_truncated), false);
    assert.equal(capturedRuntime.prompt_preview_truncated.includes("SHOULD_NOT_REACH_GRADE_PROMPT"), false);
  });

  it("reports slimmed_schema_version and estimated_output_chars_per_item in diagnostics", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm_slim_"));
    const outputPath = path.join(tmpRoot, "llm_grade_review.json");
    const items = [
      { id: "a-1", title: "Synthetic A-grade review fixture", grade: "A", rule_grade: "A" },
      { id: "b-1", title: "Developmental example topic term 018", grade: "C", rule_grade: "C" },
    ];

    const result = await reviewGradesWithLlm({
      items,
      outputPath,
      config: { enabled: true, grade_review_enabled: true, cache_enabled: false, batch_size: 2 },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      llmClient: async (input) => ({
        items: input.items.map((item) => ({
          id: item.id,
          title: item.title,
          rule_grade: item.rule_grade,
          llm_review_grade: item.rule_grade,
          confidence: "high",
          reason: "keep rule grade",
          needs_human_review: false,
        })),
      }),
    });

    assert.equal(result.slimmed_schema_version, "v1-evidence-fields-removed");
    assert.ok("timing_diagnostics" in result);
    assert.ok("estimated_output_chars_per_item" in result.timing_diagnostics);
    const written = JSON.parse(await fs.readFile(outputPath, "utf8"));
    assert.equal(written.slimmed_schema_version, "v1-evidence-fields-removed");
  });

 it("dedupes before LLM review diagnostics using DOI, PMID, PMCID, URL, then normalized title", () => {
   const input = [
     { title: "Variant title A", url: "https://example.org/paper/1", source: "rss" },
     { title: "Variant title B", url: "https://example.org/paper/1", source: "pubmed" },
     { title: "Shared DOI title", doi: "10.0000/example.001" },
     { title: "Different title", doi: " 10.0000/example.001 " },
     { title: "Normalized title: alpha-beta!" },
     { title: "Normalized title alpha beta" },
   ];

   const result = dedupWithDiagnostics(input);

   assert.equal(result.items.length, 3);
   assert.equal(result.diagnostics.fetched_count, 6);
   assert.equal(result.diagnostics.deduped_count, 3);
   assert.equal(result.diagnostics.duplicate_removed_count, 3);
   assert.equal(result.diagnostics.duplicate_groups.length, 3);
   assert.deepEqual(
     result.diagnostics.duplicate_groups.map((entry) => entry.key_type),
     ["url", "doi", "title"],
   );
 });

  it("reports shadow gating as diagnostic_only without skipping items", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm_shadow_"));
    const outputPath = path.join(tmpRoot, "llm_grade_review.json");
    const items = [
      { id: "a-1", title: "Synthetic A-grade review fixture", grade: "A", rule_grade: "A" },
      { id: "b-1", title: "Synthetic B-grade manual-review fixture", grade: "B", rule_grade: "B", needs_human_review: true, flags: {} },
      { id: "c-1", title: "Synthetic C-grade review fixture", grade: "C", rule_grade: "C" },
      { id: "d-1", title: "Synthetic D-grade excluded fixture", grade: "D", rule_grade: "D" },
    ];

    const result = await reviewGradesWithLlm({
      items,
      outputPath,
      config: { enabled: true, grade_review_enabled: true, cache_enabled: false, batch_size: 4 },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      llmClient: async (input) => ({
        items: input.items.map((item) => ({
          id: item.id,
          title: item.title,
          rule_grade: item.rule_grade,
          llm_review_grade: String.fromCharCode(item.rule_grade.charCodeAt(0) + (item.id === "c-1" ? 1 : 0)),
          confidence: item.needs_human_review ? "low" : "high",
          reason: item.needs_human_review ? "check details" : "keep rule grade",
          needs_human_review: item.needs_human_review || false,
        })),
      }),
    });

    assert.equal(result.items_reviewed, 3);
    assert.equal(result.llm_review_eligible_count, 3);

    const shadow = result.shadow_gating;
    assert.ok(shadow);
    assert.equal(shadow.enabled, true);
    assert.equal(shadow.mode, "diagnostic_only");
    assert.equal(typeof shadow.would_skip_count, "number");
    assert.equal(typeof shadow.would_review_count, "number");
    assert.equal(typeof shadow.would_skip_ratio, "number");
    assert.equal(typeof shadow.llm_changed_grade_count, "number");
    assert.equal(shadow.would_skip_count + shadow.would_review_count, 3);
    assert.ok("skip_reasons" in shadow);
    assert.ok(Array.isArray(shadow.changed_item_keys_safe));
    assert.equal(shadow.changed_item_keys_safe.includes("prompt_preview"), false);
    assert.equal(shadow.changed_item_keys_safe.includes("raw_response"), false);

    const written = JSON.parse(await fs.readFile(outputPath, "utf8"));
    assert.ok(written.shadow_gating);
    assert.equal(written.shadow_gating.mode, "diagnostic_only");
  });


  // ───────────────────────────────────────────────────────
  // LLM Grade Review Filter: dedup-passed + ABC grade only
  // ───────────────────────────────────────────────────────

  it("LLM grade review receives only dedup-passed ABC items and skips D/E/empty/non-ABC", async () => {
    const eligibleGradeSet = new Set(resolveEligibleRuleGrades({}));
    const items = [
      { id: "a1", title: "example exposure example topic term 011 example topic term 040", grade: "A", rule_grade: "A" },
      { id: "b1", title: "Developmental example topic term 018 example topic term 038", grade: "B", rule_grade: "B" },
      { id: "c1", title: "exampleOrganelle in neural cells", grade: "C", rule_grade: "C" },
      { id: "d1", title: "Wastewater treatment plant operations", grade: "D", rule_grade: "D" },
      { id: "e1", title: "Some E item", grade: "E", rule_grade: "" },
      { id: "n1", title: "No grade item", grade: "", rule_grade: "" },
      { id: "unk", title: "Unknown grade X", grade: "X", rule_grade: "" },
    ];

    const result = await reviewGradesWithLlm({
      items,
      config: { enabled: true, grade_review_enabled: true, cache_enabled: false },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      llmClient: async (input) => ({
        items: input.items.map((item) => ({
          id: item.id,
          title: item.title,
          rule_grade: item.rule_grade,
          llm_review_grade: item.rule_grade,
          confidence: "high",
          reason: "keep rule grade",
          needs_human_review: false,
        })),
      }),
    });

    assert.equal(result.items_reviewed, 3);
    assert.equal(result.llm_review_eligible_count, 3);
    // A/B/C got LLM review
    assert.equal(items[0].llm_review_grade, "A");
    assert.equal(items[0].semantic_grade, "A");
    assert.equal(items[1].llm_review_grade, "B");
    assert.equal(items[2].llm_review_grade, "C");
    // D/E/empty/unknown semantic fields cleared
    for (let i = 3; i < items.length; i++) {
      assert.equal(items[i].llm_review_grade, "");
      assert.equal(items[i].semantic_grade, "");
      assert.equal(items[i].semantic_source, "");
    }
  });

  it("buildPreferenceLearningInputs keeps supported feedback rows in order with compatible telemetry", () => {
    const feedbackLearning = {
      path: "review_results/文献评价/26 Week23/06.04/周报.xlsx",
      signals: [
        { id: "keep-1", title: "A valid keep row", feedback: "keep", comment: "useful" },
        { id: "drop-1", title: "A valid drop row", feedback: "drop", comment: "not relevant" },
        { id: "missing-title", title: "", feedback: "upgrade" },
        { id: "unsupported", title: "Unsupported action", feedback: "maybe" },
        { id: "downgrade-1", title: "A valid downgrade row", feedback: "downgrade" },
      ],
    };

    const result = buildPreferenceLearningInputs({ feedbackLearning, config: {} });

    assert.deepEqual(result.inputs.map((row) => row.id), ["keep-1", "drop-1", "downgrade-1"]);
    assert.deepEqual(result.feedbackRows, feedbackLearning.signals);
    assert.equal(result.feedbackSource, feedbackLearning.path);
    assert.equal(result.summary.feedback_rows_total, 5);
    assert.equal(result.summary.feedback_rows_used, 3);
    assert.equal(result.summary.excluded_count, 2);
    assert.equal(result.summary.skipped_reason, "");
  });

  it("buildPreferenceLearningInputs reports no_supported_feedback_rows without side effects", () => {
    const previousEnv = process.env.PREFERENCE_LEARNING_API_KEY;
    process.env.PREFERENCE_LEARNING_API_KEY = "must-not-be-read";
    try {
      const feedbackLearning = {
        path: "",
        signals: [
          { id: "missing-title", title: "", feedback: "keep" },
          { id: "unsupported", title: "Unsupported action", feedback: "maybe" },
        ],
      };

      const result = buildPreferenceLearningInputs({ feedbackLearning, config: {} });

      assert.deepEqual(result.inputs, []);
      assert.equal(result.summary.feedback_rows_total, 2);
      assert.equal(result.summary.feedback_rows_used, 0);
      assert.equal(result.summary.excluded_count, 2);
      assert.equal(result.summary.skipped_reason, "no_supported_feedback_rows");
      assert.equal(process.env.PREFERENCE_LEARNING_API_KEY, "must-not-be-read");
    } finally {
      if (previousEnv === undefined) delete process.env.PREFERENCE_LEARNING_API_KEY;
      else process.env.PREFERENCE_LEARNING_API_KEY = previousEnv;
    }
  });

  it("LLM grade review pipeline filter excludes dedup-skipped items even with ABC grade", async () => {
    const allItems = [
      { id: "a-kept", title: "A dedup-passed", grade: "A", rule_grade: "A" },
      { id: "b-kept", title: "B dedup-passed", grade: "B", rule_grade: "B" },
      { id: "a-skip", title: "A dedup-excluded", grade: "A", rule_grade: "A", pre_llm_skip_writeback: true },
      { id: "b-skip", title: "B dedup-excluded", grade: "B", rule_grade: "B", pre_llm_skip_writeback: true },
      { id: "c-skip", title: "C dedup-excluded", grade: "C", rule_grade: "C", pre_llm_skip_writeback: true },
    ];

    const { candidates: llmReviewItems } = buildLlmReviewCandidates(allItems, {
      eligibleRuleGrades: resolveEligibleRuleGrades({}),
    });

    assert.equal(llmReviewItems.length, 2);
    assert.deepEqual(llmReviewItems.map((it) => it.id), ["a-kept", "b-kept"]);

    const result = await reviewGradesWithLlm({
      items: llmReviewItems,
      config: { enabled: true, grade_review_enabled: true, cache_enabled: false },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      llmClient: async (input) => ({
        items: input.items.map((item) => ({
          id: item.id,
          title: item.title,
          rule_grade: item.rule_grade,
          llm_review_grade: item.rule_grade,
          confidence: "high",
          reason: "keep rule grade",
          needs_human_review: false,
        })),
      }),
    });

    assert.equal(result.items_reviewed, 2);
    assert.equal(llmReviewItems[0].llm_review_grade, "A");
    assert.equal(llmReviewItems[1].llm_review_grade, "B");
  });

  it("LLM grade review pipeline filter falls back from rule_grade to grade field", async () => {
    const eligibleGradeSet = new Set(resolveEligibleRuleGrades({}));
    const items = [
      { id: "by-grade", title: "Grade from grade field", grade: "A" },
      { id: "by-rule-grade", title: "Grade from rule_grade", rule_grade: "B", grade: "D" },
      { id: "both-match", title: "Both fields match", grade: "C", rule_grade: "C" },
      { id: "neither", title: "No grade at all" },
    ];

    // rule_grade || grade fallback pattern used by pipeline
    const eligible = items.filter((item) =>
      eligibleGradeSet.has(String(item.rule_grade || item.grade || "").trim().toUpperCase())
    );
    assert.equal(eligible.length, 3);
    assert.deepEqual(eligible.map((it) => it.id), ["by-grade", "by-rule-grade", "both-match"]);

    const result = await reviewGradesWithLlm({
      items,
      config: { enabled: true, grade_review_enabled: true, cache_enabled: false },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      llmClient: async (input) => ({
        items: input.items.map((item) => ({
          id: item.id,
          title: item.title,
          rule_grade: item.rule_grade || item.grade,
          llm_review_grade: item.rule_grade || item.grade,
          confidence: "high",
          reason: "keep rule grade",
          needs_human_review: false,
        })),
      }),
    });

    assert.equal(result.items_reviewed, 3);
    assert.equal(items[0].llm_review_grade, "A");
    assert.equal(items[1].llm_review_grade, "B");
    assert.equal(items[2].llm_review_grade, "C");
    assert.equal(items[3].llm_review_grade, "");
    assert.equal(items[3].final_grade, undefined);
  });

  it("LLM grade review candidate list count equals dedup-passed ABC items only", async () => {
    const allItems = [
      { id: "a1", title: "A title", grade: "A", rule_grade: "A" },
      { id: "b1", title: "B title", grade: "B", rule_grade: "B" },
      { id: "c1", title: "C title", grade: "C", rule_grade: "C" },
      { id: "d1", title: "D title", grade: "D", rule_grade: "D" },
      { id: "a-skip", title: "A skip", grade: "A", rule_grade: "A", pre_llm_skip_writeback: true },
    ];

    const { candidates: llmReviewItems } = buildLlmReviewCandidates(allItems, {
      eligibleRuleGrades: resolveEligibleRuleGrades({}),
    });

    assert.equal(llmReviewItems.length, 3);

    let capturedItemIds = null;
    const result = await reviewGradesWithLlm({
      items: llmReviewItems,
      config: { enabled: true, grade_review_enabled: true, cache_enabled: false },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      llmClient: async (input) => {
        capturedItemIds = input.items.map((item) => item.id).sort();
        return {
          items: input.items.map((item) => ({
            id: item.id,
            title: item.title,
            rule_grade: item.rule_grade,
            llm_review_grade: item.rule_grade,
            confidence: "high",
            reason: "keep rule grade",
            needs_human_review: false,
          })),
        };
      },
    });

   assert.equal(result.items_reviewed, 3);
   assert.deepEqual(capturedItemIds, ["a1", "b1", "c1"]);
 });

  // 岸岸岸 LLM review candidate telemetry 岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸岸

  it("buildLlmReviewCandidates selects dedup-passed ABC items in order and reports compatible telemetry", () => {
    const input = [
      { id: "a1", grade: "A", rule_grade: "A" },
      { id: "b1", grade: "B", rule_grade: "B" },
      { id: "d1", grade: "D", rule_grade: "D" },
      { id: "c1", grade: "C", rule_grade: "C" },
      { id: "e1", grade: "E", rule_grade: "" },
      { id: "empty", grade: "", rule_grade: "" },
      { id: "unknown", grade: "X", rule_grade: "" },
      { id: "a-skip", grade: "A", rule_grade: "A", pre_llm_skip_writeback: true },
      { id: "b-skip", grade: "B", rule_grade: "B", pre_llm_skip_writeback: true },
    ];

    const result = buildLlmReviewCandidates(input, {
      eligibleRuleGrades: resolveEligibleRuleGrades({}),
      duplicateRemovedCount: 2,
    });

    assert.deepEqual(result.candidates.map((item) => item.id), ["a1", "b1", "c1"]);
    assert.strictEqual(result.candidates[0], input[0]);
    assert.equal(result.summary.llm_review_candidate_count, 5);
    assert.equal(result.summary.llm_review_candidates_count, 3);
    assert.equal(result.summary.abc_grade_items_count, 5);
    assert.equal(result.summary.excluded_non_abc_count, 4);
    assert.equal(result.summary.excluded_not_deduped_count, 2);
    assert.equal(result.telemetry.llm_review_candidate_count, 5);
    assert.equal(result.telemetry.excluded_non_abc_count, 4);
    assert.equal(result.telemetry.excluded_not_deduped_count, 2);
    assert.deepEqual(input.map((item) => item.id), ["a1", "b1", "d1", "c1", "e1", "empty", "unknown", "a-skip", "b-skip"]);
  });

  it("buildLlmReviewCandidates preserves existing no-candidate telemetry semantics", () => {
    const result = buildLlmReviewCandidates([
      { id: "d1", grade: "D", rule_grade: "D" },
      { id: "empty", grade: "", rule_grade: "" },
      { id: "unknown", grade: "X", rule_grade: "" },
    ], { eligibleRuleGrades: resolveEligibleRuleGrades({}) });

    assert.deepEqual(result.candidates, []);
    assert.equal(result.summary.llm_review_candidate_count, 0);
    assert.equal(result.summary.llm_review_candidates_count, 0);
    assert.equal(result.summary.excluded_non_abc_count, 3);
    assert.equal(result.summary.skip_reason, "no_eligible_items");
  });

  it("computes excluded_non_abc_count and abc_grade_items_count from mixed grades", () => {
    const eligibleGradeSet = new Set(resolveEligibleRuleGrades({}));
    const items = [
      { id: "a1", grade: "A", rule_grade: "A" },
      { id: "b1", grade: "B", rule_grade: "B" },
      { id: "c1", grade: "C", rule_grade: "C" },
      { id: "d1", grade: "D", rule_grade: "D" },
      { id: "e1", grade: "E", rule_grade: "" },
      { id: "n1", grade: "", rule_grade: "" },
    ];

    const abcCount = items.filter((item) =>
      eligibleGradeSet.has(String(item.rule_grade || item.grade || "").trim().toUpperCase())
    ).length;
    const excludedNonAbc = items.length - abcCount;

    assert.equal(abcCount, 3);
    assert.equal(excludedNonAbc, 3);
    assert.equal(abcCount + excludedNonAbc, items.length);
  });

  it("computes llm_review_candidates_count from dedup-passed ABC items", () => {
    const allItems = [
      { id: "a1", grade: "A", rule_grade: "A" },
      { id: "b1", grade: "B", rule_grade: "B" },
      { id: "c1", grade: "C", rule_grade: "C" },
      // Pre-LLM dedup skipped (simulates Zotero existing duplicate)
      { id: "d-skip", grade: "D", rule_grade: "D" },
      { id: "a-skip", grade: "A", rule_grade: "A", pre_llm_skip_writeback: true },
    ];

    const { candidates: llmCandidates } = buildLlmReviewCandidates(allItems, {
      eligibleRuleGrades: resolveEligibleRuleGrades({}),
    });

    assert.equal(llmCandidates.length, 3);
    assert.deepEqual(llmCandidates.map((it) => it.id), ["a1", "b1", "c1"]);
  });

  it("reviewGradesWithLlm skipped with disabled config", async () => {
    const result = await reviewGradesWithLlm({
      items: [{ id: "a1", title: "Test", grade: "A", rule_grade: "A" }],
      config: { enabled: false, cache_enabled: false },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
    });

    assert.equal(result.enabled, false);
    assert.equal(result.skipped, true);
    assert.equal(result.skipped_reason, "disabled");
  });

  it("reviewGradesWithLlm skipped with no eligible items", async () => {
    const result = await reviewGradesWithLlm({
      items: [{ id: "d1", title: "Test", grade: "D", rule_grade: "D" }],
      config: { enabled: true, cache_enabled: false },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
    });

    assert.equal(result.enabled, true);
    assert.equal(result.skipped, true);
    assert.equal(result.skipped_reason, "no_eligible_items");
  });

  it("reviewGradesWithLlm skipped with llm_mode disabled in runtime", async () => {
    const result = await reviewGradesWithLlm({
      items: [{ id: "a1", title: "Test", grade: "A", rule_grade: "A" }],
      config: { enabled: true, cache_enabled: false },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200, llm_mode: "disabled" },
    });

    assert.equal(result.enabled, true);
    assert.equal(result.skipped, true);
    assert.equal(result.skipped_reason, "llm_disabled");
  });

  it("reviewGradesWithLlm not skipped when enabled with ABC candidates", async () => {
    const result = await reviewGradesWithLlm({
      items: [
        { id: "a1", title: "A study", grade: "A", rule_grade: "A" },
        { id: "b1", title: "B study", grade: "B", rule_grade: "B" },
      ],
      config: { enabled: true, cache_enabled: false },
      runtime: { apiKeyConfigured: true, model: "mock-model", endpoint: "mock://llm", max_retries: 0, timeout_ms: 1000, max_output_tokens: 1200 },
      llmClient: async (input) => ({
        items: input.items.map((item) => ({
          id: item.id,
          title: item.title,
          rule_grade: item.rule_grade,
          llm_review_grade: item.rule_grade,
          confidence: "high",
          reason: "keep rule grade",
          needs_human_review: false,
        })),
      }),
    });

    assert.equal(result.enabled, true);
    assert.equal(result.skipped, false);
    assert.equal(result.items_reviewed, 2);
  });
});
