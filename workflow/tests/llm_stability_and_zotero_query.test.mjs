import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureWorkflowStartupReady } from "../tools/lib/workflow_startup_ready.mjs";
import {
  writeZoteroLibraryIndex,
} from "../tools/lib/zotero_library_index_store.mjs";
import {
  buildCorrectionPlan,
  enrichArchivePlanWithZoteroTitleMatches,
  sanitizeZoteroSearchQuery,
} from "../tools/maintenance/zotero_feedback_collection_corrections.mjs";

const MISSING_LOCAL_INDEX_PATH = "workflow/tests/fixtures/missing-zotero-index.json";

function mcpResult(value) {
  return { content: [{ text: JSON.stringify(value) }] };
}

test("sanitizeZoteroSearchQuery converts Greek beta only for MCP query use", () => {
  assert.equal(sanitizeZoteroSearchQuery("IFN-β response"), "IFN-beta response");
});

test("sanitizeZoteroSearchQuery removes control characters and caps query length", () => {
  const long = `Alpha\u0000\u200B\r\n\tBeta ${"x".repeat(420)}`;
  const sanitized = sanitizeZoteroSearchQuery(long);
  assert.equal(sanitized.includes("\u0000"), false);
  assert.equal(sanitized.includes("\u200B"), false);
  assert.equal(/\s{2,}/.test(sanitized), false);
  assert.equal(sanitized.startsWith("Alpha Beta "), true);
  assert.equal(sanitized.length, 300);
});

test("search_library uses cleaned variant only after reliable zero response", async () => {
  const searchedTitles = [];
  const archivePlan = [{
    status: "needs_review",
    reason: "no_matching_literature_record",
    feedback: { english_title: "IFN-β response", feedback: "keep" },
    record: {},
  }];

  const mcpToolCall = async (name, args) => {
    if (name === "search_library") {
      searchedTitles.push(args.title);
      if (args.title.includes("β")) {
        return mcpResult([]);
      }
      return mcpResult({ results: [{ key: "ABC123", title: "IFN-beta response" }] });
    }
    if (name === "get_item_details") {
      return mcpResult({ title: "IFN-β response", tags: ["B专题相关"] });
    }
    throw new Error(`unexpected MCP tool: ${name}`);
  };

  await enrichArchivePlanWithZoteroTitleMatches(archivePlan, { mcpToolCall, localIndexPath: MISSING_LOCAL_INDEX_PATH });

  assert.deepEqual(searchedTitles, ["IFN-β response", "IFN-beta response"]);
  assert.equal(archivePlan[0].match_key, "IFN-β response");
  assert.equal(archivePlan[0].record.title, "IFN-beta response");
  assert.equal(archivePlan[0].zotero_title_query_diagnostics.sanitized_query_used, true);

});

test("search_library falls back to shortened query only after reliable zeros", async () => {
  const searchedTitles = [];
  const originalTitle = `IFN-\u200Bβ response ${"example topic term 011 ".repeat(30)}`;
  const cleanedOriginalTitle = originalTitle.trim();
  const archivePlan = [{
    status: "needs_review",
    reason: "no_matching_literature_record",
    feedback: { english_title: originalTitle, feedback: "keep" },
    record: {},
  }];

  const mcpToolCall = async (name, args) => {
    if (name === "search_library") {
      searchedTitles.push(args.title);
      if (searchedTitles.length < 3) {
        return mcpResult([]);
      }
      return mcpResult({ results: [{ key: "ABC123", title: originalTitle }] });
    }
    if (name === "get_item_details") {
      return mcpResult({ title: originalTitle, tags: ["B专题相关"] });
    }
    throw new Error(`unexpected MCP tool: ${name}`);
  };

  await enrichArchivePlanWithZoteroTitleMatches(archivePlan, { mcpToolCall, localIndexPath: MISSING_LOCAL_INDEX_PATH });

  assert.equal(searchedTitles.length, 3);
  assert.equal(searchedTitles[0], cleanedOriginalTitle);
  assert.equal(searchedTitles[1].length, 300);
  assert.equal(searchedTitles[2].length < searchedTitles[1].length, true);
  assert.equal(archivePlan[0].match_key, cleanedOriginalTitle);
  assert.equal(archivePlan[0].record.title, originalTitle);
  assert.equal(archivePlan[0].zotero_title_query_diagnostics.fallback_used, "shortened");
  assert.equal(archivePlan[0].zotero_title_query_diagnostics.shortened_query_used, true);
});

test("feedback title enrichment uses local Zotero index before search_library", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "feedback-local-index-"));
  const localIndexPath = path.join(dir, "current_library_index.json");
  try {
    await writeZoteroLibraryIndex(localIndexPath, {
      schema_version: 1,
      live_items: {
        ABC123: {
          itemKey: "ABC123",
          title: "Local matched title",
          tags: [{ tag: "B专题相关" }],
          collections: [{ key: "POOL", name: "文献池" }],
          collection_roles: ["pool"],
        },
      },
      tombstones: {},
    });
    const calls = [];
    const archivePlan = [{
      status: "needs_review",
      reason: "no_matching_literature_record",
      feedback: { english_title: "Local matched title", feedback: "upgrade" },
      record: {},
    }];

    await enrichArchivePlanWithZoteroTitleMatches(archivePlan, {
      localIndexPath,
      mcpToolCall: async (name) => {
        calls.push(name);
        throw new Error(`unexpected Zotero call: ${name}`);
      },
    });

    assert.equal(archivePlan[0].status, "planned");
    assert.equal(archivePlan[0].record.itemKey, "ABC123");
    assert.equal(archivePlan[0].zotero_title_query_diagnostics.fallback_used, "local_zotero_index");
    assert.deepEqual(calls, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("historical drop feedback plans quarantine in 文献池/待删除 without deleting the item", () => {
  const collections = [
    { key: "POOL", name: "文献池", parentCollection: false },
    { key: "DAY", name: "2026-07-02", parentCollection: "POOL" },
    { key: "GRADE", name: "B专题相关", parentCollection: "DAY" },
    { key: "TRASH", name: "待删除", parentCollection: "POOL" },
  ];
  const plan = buildCorrectionPlan({
    archivePlan: [{
      status: "planned",
      date: "2026-07-02",
      original_level: "B专题相关",
      assigned_level: "D无关",
      feedback: { feedback: "drop", english_title: "Anonymous title" },
      record: { itemKey: "ITEM1", title: "Anonymous title" },
    }],
    collections,
    includeArchiveCleanup: false,
    dropMode: "quarantine",
  });
  assert.equal(plan.actions[0].action, "move_drop_to_delete_review_collection");
  assert.equal(plan.actions[0].target_collection_key, "TRASH");
  assert.equal(plan.actions[0].source_collection_key, "GRADE");
  assert.equal(JSON.stringify(plan.actions[0]).includes("delete_zotero_item"), false);
});

test("workflow startup readiness reports removed local semantic backend dependency", async () => {
  const diagnostics = await ensureWorkflowStartupReady({
    dependencies: {
      ensureZoteroBackendReady: async () => ({ ok: true, backend: "mock" }),
      restartProcess: async () => ({ target: "zotero", killed: false, commands: [] }),
    },
  });

  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.zotero.ready, true);
  assert.equal(diagnostics.ollama.compatibility_only, true);
  assert.equal(diagnostics.ollama.compatibility_reason, "removed_llm_workflow");
  assert.equal(diagnostics.ollama.ollama_required, false);
  assert.equal(diagnostics.ollama.ollama_checked, false);
  assert.equal(diagnostics.ollama.semantic_backend_used, false);
  assert.equal(diagnostics.ollama.reason, "removed_llm_workflow");
});

test("legacy local semantic backend tools are removed from runtime path", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const removedPaths = [
    "tmp_fix_rss.mjs",
    "workflow/tools/check_ollama_ready.mjs",
    "workflow/tools/lib/ensure_ollama_ready.mjs",
    "workflow/tools/lib/zotero_semantic_search.mjs",
    "workflow/tools/probe_zotero_mcp_semantic_search.mjs",
  ];

  for (const relativePath of removedPaths) {
    await assert.rejects(
      () => fs.access(path.join(repoRoot, relativePath)),
      /ENOENT/,
      `${relativePath} should be removed`,
    );
  }

  const runtimeFiles = [
    "workflow/tools/stage0/main.mjs",
    "workflow/tools/stage1/main.mjs",
    "workflow/tools/lib/workflow_startup_ready.mjs",
    "workflow/tools/stage4/main.mjs",
  ];
  const forbiddenPatterns = [
    "ensureOllamaReady",
    "check_ollama_ready",
    "createZoteroSemanticAdapter",
    "zotero_semantic_search",
    "semanticSearch(",
    "searchBatch(",
  ];

  for (const relativePath of runtimeFiles) {
    const source = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
    for (const pattern of forbiddenPatterns) {
      assert.equal(
        source.includes(pattern),
        false,
        `${relativePath} should not include ${pattern}`,
      );
    }
  }
});

test("legacy semantic config and compatibility metadata are explicitly marked as removed LLM workflow remnants", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const workflowRules = JSON.parse(await fs.readFile(path.join(repoRoot, "config", "review-workflow-rules.json"), "utf8"));
  const config = workflowRules.config || workflowRules;

  assert.equal(config.llm_review.max_grade_review_items, 0);

  const startupSource = await fs.readFile(path.join(repoRoot, "workflow/tools", "lib", "workflow_startup_ready.mjs"), "utf8");
  assert.equal(startupSource.includes("compatibility_only: true"), true);

  const pipelineSource = await fs.readFile(path.join(repoRoot, "workflow/tools", "stage1", "preference_learning_step.mjs"), "utf8");
  assert.equal(pipelineSource.includes('compatibility_reason: "removed_llm_workflow"'), true);
  assert.equal(pipelineSource.includes("compatibility_only: true"), true);

  const dryRunSource = await fs.readFile(path.join(repoRoot, "workflow/tools", "lib", "writeback_pool_dry_run_support.mjs"), "utf8");
  assert.equal(dryRunSource.includes("candidateLookupCalls"), true);
  assert.equal(dryRunSource.includes("semanticSearchCalls: 0"), false);
});
