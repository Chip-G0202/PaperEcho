import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildWritebackReadyItems } from "../tools/lib/pipeline_stage_support.mjs";
import { writeZoteroLibraryIndex } from "../tools/lib/zotero_library_index_store.mjs";
import { runPreLlmDedupeStep, selectPreLlmDedupeCandidates } from "../tools/stage1/pre_llm_dedupe_step.mjs";
import { classifyPreLlmZoteroExistingDuplicates } from "../tools/stage1/zotero_existing_dedupe.mjs";

const MISSING_LOCAL_INDEX_PATH = "workflow/tests/fixtures/missing-zotero-index.json";

function mcpResult(value) {
  return { content: [{ text: JSON.stringify(value) }] };
}

function makeCollectionMcp({ poolItems = [], trashItems = [], worthyItems = [], failSearch = false } = {}) {
  const detailsByKey = new Map([...poolItems, ...trashItems, ...worthyItems].map((item) => [item.key, item]));
  const calls = [];
  const mcpToolCall = async (name, args) => {
    calls.push({ name, args });
    if (name === "get_collections") {
      return mcpResult([
        { key: "pool", name: "文献池" },
        { key: "worthy", name: "值得精读" },
      ]);
    }
    if (name === "get_subcollections") {
      return mcpResult([{ key: "trash", name: "待删除", parentCollection: "pool" }]);
    }
    if (name === "get_collection_items") {
      if (args.collectionKey === "pool") return mcpResult(poolItems.map((item) => ({ key: item.key })));
      if (args.collectionKey === "trash") return mcpResult(trashItems.map((item) => ({ key: item.key })));
      if (args.collectionKey === "worthy") return mcpResult(worthyItems.map((item) => ({ key: item.key })));
      return mcpResult([]);
    }
    if (name === "get_item_details") {
      const item = detailsByKey.get(args.itemKey);
      return mcpResult(item ? { key: item.key, data: item } : {});
    }
    if (name === "search_library") {
      if (failSearch) throw new Error('MCP search_library failed: {"code":-32700,"message":"Parse error"}');
      const query = String(args.q || "").trim().toLowerCase();
      const hits = [...detailsByKey.values()].filter((item) => {
        return [
          item.DOI,
          item.doi,
          item.pmid,
          item.pmcid,
          item.url,
          item.title,
        ].some((value) => String(value || "").trim().toLowerCase() === query);
      }).map((item) => ({ key: item.key, itemKey: item.key, ...item }));
      if (hits.length) return mcpResult(hits);
      return mcpResult([]);
    }
    throw new Error(`unexpected MCP tool ${name}`);
  };
  return { mcpToolCall, calls };
}

test("pre-LLM Zotero dedupe skips strong-key existing duplicates and keeps new candidates", async () => {
  const candidates = [
    { id: "dup", title: "Duplicate paper", doi: "https://doi.org/10.0000/example.001BC", grade: "B", rule_grade: "B" },
    { id: "new", title: "New paper", doi: "10.0000/example.004", grade: "B", rule_grade: "B" },
  ];
  const { mcpToolCall } = makeCollectionMcp({
    poolItems: [{ key: "EXIST1", DOI: "10.0000/example.001bc", title: "Duplicate paper" }],
  });

  const result = await classifyPreLlmZoteroExistingDuplicates(candidates, { mcpToolCall, localIndexPath: MISSING_LOCAL_INDEX_PATH });

  assert.deepEqual(result.newCandidatesForLlmReview.map((item) => item.id), ["new"]);
  assert.deepEqual(result.skippedExistingBeforeLlmReview.map((item) => item.id), ["dup"]);
  assert.equal(candidates[0].pre_llm_zotero_existing_duplicate, true);
  assert.equal(candidates[0].pre_llm_skip_writeback, true);
  assert.equal(result.diagnostics.pre_llm_existing_duplicate_by_reason.doi, 1);
  assert.equal(result.diagnostics.llm_review_candidate_count_before_zotero_dedupe, 2);
  assert.equal(result.diagnostics.llm_review_candidate_count_after_zotero_dedupe, 1);
});

test("pre-LLM Zotero dedupe uses local library index without backend calls", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pre-llm-local-index-"));
  const localIndexPath = path.join(dir, "current_library_index.json");
  try {
    await writeZoteroLibraryIndex(localIndexPath, {
      schema_version: 1,
      coverage: { zotero: { complete: true, scope: "test_fixture" } },
      live_items: {
        EXIST1: {
          itemKey: "EXIST1",
          title: "Duplicate local paper",
          doi: "10.0000/example.016",
          collections: [{ key: "POOL", name: "文献池" }],
          collection_roles: ["pool"],
        },
        EXIST2: {
          itemKey: "EXIST2",
          title: "Duplicate source grade paper",
          doi: "10.0000/example.023",
          collections: [
            { key: "SRC", name: "RSS订阅" },
            { key: "GRADE", name: "B专题相关" },
          ],
          collection_roles: ["source", "grade"],
        },
      },
      tombstones: {},
    });
    const calls = [];
    const result = await classifyPreLlmZoteroExistingDuplicates([
      { id: "dup", title: "Duplicate local paper", doi: "10.0000/example.016", grade: "B", rule_grade: "B" },
      { id: "dup-source-grade", title: "Duplicate source grade paper", doi: "10.0000/example.023", grade: "B", rule_grade: "B" },
      { id: "new", title: "New local paper", doi: "10.0000/example.018", grade: "B", rule_grade: "B" },
    ], {
      localIndexPath,
      mcpToolCall: async (name) => {
        calls.push(name);
        throw new Error(`unexpected Zotero call: ${name}`);
      },
    });

    assert.deepEqual(result.skippedExistingBeforeLlmReview.map((item) => item.id), ["dup", "dup-source-grade"]);
    assert.deepEqual(result.newCandidatesForLlmReview.map((item) => item.id), ["new"]);
    assert.equal(result.diagnostics.lookup_strategy, "complete_local_index");
    assert.equal(result.diagnostics.local_zotero_index_used, true);
    assert.equal(result.diagnostics.local_index_live_items_loaded, 2);
    assert.deepEqual(calls, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("pre-LLM Zotero dedupe keeps candidates when verified local index matches are stale", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pre-llm-stale-local-index-"));
  const localIndexPath = path.join(dir, "current_library_index.json");
  try {
    await writeZoteroLibraryIndex(localIndexPath, {
      schema_version: 1,
      live_items: {
        STALE1: {
          itemKey: "STALE1",
          title: "Deleted local-index paper",
          doi: "10.0000/example.024",
          collections: [{ key: "POOL", name: "文献池" }],
          collection_roles: ["pool"],
        },
      },
      tombstones: {},
    });
    const calls = [];
    const result = await classifyPreLlmZoteroExistingDuplicates([
      { id: "stale", title: "Deleted local-index paper", doi: "10.0000/example.024", grade: "B", rule_grade: "B" },
    ], {
      localIndexPath,
      verifyLocalIndexMatches: true,
      mcpToolCall: async (name, args) => {
        calls.push({ name, args });
        if (name === "get_items_details") return mcpResult(args.itemKeys.map((itemKey) => ({ key: itemKey, itemKey, missing: true })));
        if (name === "get_item_details") return mcpResult({});
        throw new Error(`unexpected Zotero call: ${name}`);
      },
    });

    assert.deepEqual(result.skippedExistingBeforeLlmReview, []);
    assert.deepEqual(result.newCandidatesForLlmReview.map((item) => item.id), ["stale"]);
    assert.equal(result.diagnostics.local_index_match_verification_enabled, true);
    assert.equal(result.diagnostics.local_index_match_batch_verification_enabled, true);
    assert.equal(result.diagnostics.local_index_match_batch_request_count, 1);
    assert.equal(result.diagnostics.local_index_match_batch_fallback_count, 0);
    assert.equal(result.diagnostics.local_index_stale_match_count, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "get_items_details");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("pre-LLM Zotero dedupe still skips verified live local-index matches", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pre-llm-live-local-index-"));
  const localIndexPath = path.join(dir, "current_library_index.json");
  try {
    await writeZoteroLibraryIndex(localIndexPath, {
      schema_version: 1,
      live_items: {
        EXIST1: {
          itemKey: "EXIST1",
          title: "Live local-index paper",
          doi: "10.0000/example.015",
          collections: [{ key: "POOL", name: "文献池" }],
          collection_roles: ["pool"],
        },
      },
      tombstones: {},
    });
    const result = await classifyPreLlmZoteroExistingDuplicates([
      { id: "live", title: "Live local-index paper", doi: "10.0000/example.015", grade: "B", rule_grade: "B" },
    ], {
      localIndexPath,
      verifyLocalIndexMatches: true,
      mcpToolCall: async (name, args) => {
        if (name === "get_items_details") return mcpResult(args.itemKeys.map((itemKey) => ({ key: itemKey, itemKey, data: { key: itemKey, title: "Live local-index paper", DOI: "10.0000/example.015" } })));
        if (name === "get_item_details") return mcpResult({ key: args.itemKey, data: { key: args.itemKey, title: "Live local-index paper", DOI: "10.0000/example.015" } });
        throw new Error(`unexpected Zotero call: ${name}`);
      },
    });

    assert.deepEqual(result.skippedExistingBeforeLlmReview.map((item) => item.id), ["live"]);
    assert.deepEqual(result.newCandidatesForLlmReview, []);
    assert.equal(result.diagnostics.local_index_match_verified_count, 1);
    assert.equal(result.diagnostics.local_index_stale_match_count, 0);
    assert.equal(result.diagnostics.local_index_match_batch_request_count, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("pre-LLM dedupe step uses local index even when connector is unavailable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pre-llm-step-local-index-"));
  const localIndexPath = path.join(dir, "current_library_index.json");
  try {
    await writeZoteroLibraryIndex(localIndexPath, {
      schema_version: 1,
      live_items: {
        EXIST1: {
          itemKey: "EXIST1",
          title: "Connectorless duplicate paper",
          doi: "10.0000/example.009",
          collections: [{ key: "POOL", name: "文献池" }],
          collection_roles: ["pool"],
        },
      },
      tombstones: {},
    });
    const result = await runPreLlmDedupeStep({
      triagedItems: [
        { id: "dup", title: "Connectorless duplicate paper", doi: "10.0000/example.009", grade: "B", rule_grade: "B" },
        { id: "new", title: "Connectorless new paper", doi: "10.0000/example.018", grade: "B", rule_grade: "B" },
      ],
      llmReviewConfig: { eligible_rule_grades: ["A", "B", "C"] },
      connectorOk: false,
      localIndexPath,
    });

    assert.equal(result.preLlmExistingDedupe.diagnostics.ok, true);
    assert.equal(result.preLlmExistingDedupe.diagnostics.local_zotero_index_used, true);
    assert.deepEqual(result.preLlmExistingDedupe.skippedExistingBeforeLlmReview.map((item) => item.id), ["dup"]);
    assert.deepEqual(result.preLlmExistingDedupe.newCandidatesForLlmReview.map((item) => item.id), ["new"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("pre-LLM Zotero dedupe keeps candidates for LLM when duplicate check setup fails", async () => {
  const candidates = [
    { id: "a", title: "A candidate", doi: "10.0000/example.001", grade: "B", rule_grade: "B" },
    { id: "b", title: "B candidate", doi: "10.0000/example.003", grade: "C", rule_grade: "C" },
  ];
  const mcpToolCall = async () => {
    throw new Error("MCP unavailable");
  };

  const result = await classifyPreLlmZoteroExistingDuplicates(candidates, { mcpToolCall, localIndexPath: MISSING_LOCAL_INDEX_PATH });

  assert.deepEqual(result.newCandidatesForLlmReview.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(result.duplicateCheckFailedCandidates.map((item) => item.id), ["a", "b"]);
  assert.equal(result.diagnostics.pre_llm_duplicate_check_failed_count, 2);
  assert.equal(result.diagnostics.duplicate_check_failed_reviewed_count, 2);
});

test("pre-LLM Zotero dedupe does not skip low-confidence short title-only matches", async () => {
  const candidates = [
    { id: "short", title: "Short", grade: "B", rule_grade: "B" },
  ];
  const { mcpToolCall } = makeCollectionMcp({
    poolItems: [{ key: "EXIST1", title: "Short" }],
  });

  const result = await classifyPreLlmZoteroExistingDuplicates(candidates, { mcpToolCall, localIndexPath: MISSING_LOCAL_INDEX_PATH });

  assert.deepEqual(result.newCandidatesForLlmReview.map((item) => item.id), ["short"]);
  assert.equal(result.skippedExistingBeforeLlmReview.length, 0);
  assert.equal(result.diagnostics.possible_duplicate_count, 0);
});

test("pre-LLM search_library parse errors do not skip candidates", async () => {
  const candidates = [
    { id: "parse", title: "IFN-β response title with enough length", grade: "B", rule_grade: "B" },
  ];
  const { mcpToolCall } = makeCollectionMcp({ failSearch: true });

  const result = await classifyPreLlmZoteroExistingDuplicates(candidates, { mcpToolCall, localIndexPath: MISSING_LOCAL_INDEX_PATH });

  assert.deepEqual(result.newCandidatesForLlmReview.map((item) => item.id), ["parse"]);
  assert.equal(result.diagnostics.search_library_parse_error_count > 0, true);
  assert.equal(result.diagnostics.pre_llm_existing_duplicate_count, 0);
});

test("writeback ready builder excludes pre-LLM skipped existing duplicates", () => {
  const items = [
    { id: "dup", title: "Duplicate", grade: "B", pre_llm_skip_writeback: true },
    { id: "new", title: "New", grade: "B" },
  ];

  const ready = buildWritebackReadyItems(items);

  assert.deepEqual(ready.map((item) => item.id), ["new"]);
});

test("pre-LLM dedupe candidate selection follows formal LLM review eligibility only", () => {
  const { preLlmCheckCandidates, llmReviewCandidateSelection } = selectPreLlmDedupeCandidates({
    triagedItems: [
      { id: "display-d", title: "Display D", grade: "D无关" },
      { id: "letter-d", title: "Letter D", grade: "D", rule_grade: "D" },
      { id: "candidate-c", title: "Candidate C", grade: "C", rule_grade: "C" },
    ],
    llmReviewConfig: { eligible_rule_grades: ["A", "B", "C"] },
  });

  assert.deepEqual(preLlmCheckCandidates.map((item) => item.id), ["candidate-c"]);
  assert.equal(llmReviewCandidateSelection.summary.excluded_non_abc_count, 2);
});
