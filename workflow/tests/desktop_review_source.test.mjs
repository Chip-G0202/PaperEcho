import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  filterDesktopReviewSourceByWritebackSummary,
  buildStage1WritebackCorrelationKey,
} from "../tools/lib/pipeline_stage_support.mjs";
import {
  buildStage4StandaloneExportSource,
} from "../tools/stage4/finalize_exports_support.mjs";

// ── Factories matching real pipeline structures ──────────────────────────────

/**
 * Stage 1 candidate: comes from RSS / PubMed / PMC via run_review_results_pipeline.mjs.
 * Has title, source_channel, grade, doi, pmid, journal — but NO itemKey.
 */
function stage1Candidate(overrides) {
  return {
    title: "exampleInflammatoryProcess in example condition",
    source_channel: "database",
    grade: "A",
    grade_label: "A课题相关",
    doi: "10.0000/example.011",
    pmid: "990000001",
    journal: "Nature Neuroscience",
    ...overrides,
  };
}

/**
 * Stage 2 writeback item: built by buildWritebackItemRecord in writeback_support.mjs.
 * Has itemKey (Zotero-assigned), title, source_channel, grade.
 */
function writebackItem(itemKey, overrides) {
  return {
    itemKey,
    title: "exampleInflammatoryProcess in example condition",
    中文标题: "虚构主题中的示例机制",
    grade: "A",
    grade_label: "A课题相关",
    source_channel: "database",
    source_collection: "数据库检索",
    grade_collection: "A课题相关",
    backfill_short_title: true,
    ...overrides,
  };
}

function desktopSource(items) {
  return { triaged: items };
}

function writebackSummary(items) {
  return { writeback_items: items };
}

function verifiedWritebackSummary({ attempted = [], verified = [], identities = null, identitySetMatch = true } = {}) {
  const verifiedItems = verified.map((item) => ({
    ...item,
    verified_identity: item.verified_identity || `doi:${String(item.doi || item.DOI || "").toLowerCase()}`,
  }));
  return {
    writeback_items: attempted,
    verified_write_evidence_required: true,
    verified_write_items: verifiedItems,
    verified_business_write_identities: identities || verifiedItems.map((item) => item.verified_identity),
    verified_write_identity_set_match: identitySetMatch,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildStage1WritebackCorrelationKey", () => {
  it("produces identical keys for Stage 1 candidate and writeback item with same title/source_channel/grade", () => {
    const candidate = stage1Candidate({});
    const wbItem = writebackItem("ABCD1234", {});
    assert.equal(
      buildStage1WritebackCorrelationKey(candidate),
      buildStage1WritebackCorrelationKey(wbItem),
    );
  });

  it("resolves grade through grade_label when grade is absent", () => {
    const key1 = buildStage1WritebackCorrelationKey({ title: "T", source_channel: "rss", grade_label: "B专题相关" });
    const key2 = buildStage1WritebackCorrelationKey({ title: "T", source_channel: "rss", grade: "B" });
    // grade_label "B专题相关" ≠ grade "B" — this is intentional deterministic behavior
    assert.notEqual(key1, key2);
  });

  it("normalizes whitespace in title", () => {
    const key1 = buildStage1WritebackCorrelationKey({ title: "  Multiple   Spaces  ", source_channel: "db", grade: "A" });
    const key2 = buildStage1WritebackCorrelationKey({ title: "Multiple Spaces", source_channel: "db", grade: "A" });
    assert.equal(key1, key2);
  });

  it("treats null/undefined fields as empty strings", () => {
    const key = buildStage1WritebackCorrelationKey({ title: "T" });
    // key format: title||sourceChannel||grade → "T" + "||" + "" + "||" + "" = "T||||"
    assert.equal(key, "T||||");
  });
});

describe("filterDesktopReviewSourceByWritebackSummary", () => {
  // ── Requirement 1: Stage 1 has no itemKey, match via title+source_channel+grade ──
  it("matches Stage 1 candidates (no itemKey) to writeback_items via correlation key", () => {
    const candidates = [
      stage1Candidate({ title: "Paper A" }),
      stage1Candidate({ title: "Paper B" }),
      stage1Candidate({ title: "Paper C" }),
    ];
    const wbItems = [
      writebackItem("KEY_A", { title: "Paper A" }),
      writebackItem("KEY_C", { title: "Paper C" }),
    ];

    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      writebackSummary(wbItems),
    );

    assert.equal(result.status, "ok");
    assert.equal(result.candidateCount, 3);
    assert.equal(result.writebackItemCount, 2);
    assert.equal(result.keptCount, 2);
    assert.equal(result.unmatchedCandidateCount, 1);
  });

  // ── Requirement 2: itemKey is backfilled from writeback item ──
  it("backfills itemKey from matched writeback item onto output", () => {
    const candidates = [
      stage1Candidate({ title: "Backfill Me" }),
    ];
    const wbItems = [
      writebackItem("ZOTERO_KEY_XYZ", { title: "Backfill Me" }),
    ];

    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      writebackSummary(wbItems),
    );

    assert.equal(result.source.triaged[0].itemKey, "ZOTERO_KEY_XYZ");
    assert.equal(result.source.triaged[0].写回状态, "已写回");
  });

  // ── Requirement 3: does NOT require Stage 1 candidate to have itemKey ──
  it("works when no candidate has itemKey field", () => {
    const candidates = [
      { title: "Pure Stage1", source_channel: "rss", grade: "B", doi: "10.x/y" },
    ];
    const wbItems = [
      writebackItem("RSSKEY1", { title: "Pure Stage1", source_channel: "rss", grade: "B" }),
    ];

    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      writebackSummary(wbItems),
    );

    assert.equal(result.status, "ok");
    assert.equal(result.keptCount, 1);
    assert.equal(result.source.triaged[0].itemKey, "RSSKEY1");
  });

  // ── Requirement 4: empty writeback_items → empty triaged ──
  it("returns empty triaged with no_new_writeback_items when writeback_items is empty", () => {
    const candidates = [stage1Candidate({})];
    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      writebackSummary([]),
    );

    assert.equal(result.status, "no_new_writeback_items");
    assert.equal(result.source.triaged.length, 0);
    assert.equal(result.keptCount, 0);
    assert.equal(result.candidateCount, 1);
  });

  // ── Requirement 5: missing writebackSummary → degraded ──
  it("returns degraded when writebackSummary is null", () => {
    const candidates = [stage1Candidate({})];
    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      null,
    );

    assert.equal(result.status, "degraded_missing_writeback_summary");
    assert.equal(result.source.triaged.length, 0);
  });

  it("returns degraded when writebackSummary is undefined", () => {
    const candidates = [stage1Candidate({})];
    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      undefined,
    );

    assert.equal(result.status, "degraded_missing_writeback_summary");
    assert.equal(result.source.triaged.length, 0);
  });

  it("returns degraded when writeback_items field is missing", () => {
    const candidates = [stage1Candidate({})];
    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      { other_field: true },
    );

    assert.equal(result.status, "degraded_writeback_items_missing");
    assert.equal(result.source.triaged.length, 0);
  });

  // ── Requirement 6: writeback side duplicate key → ambiguous, no auto-match ──
  it("does not auto-match when writeback side has duplicate correlation key", () => {
    const candidates = [
      stage1Candidate({ title: "Dup Title" }),
    ];
    const wbItems = [
      writebackItem("KEY1", { title: "Dup Title" }),
      writebackItem("KEY2", { title: "Dup Title" }),
    ];

    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      writebackSummary(wbItems),
    );

    assert.equal(result.status, "ok");
    assert.equal(result.keptCount, 0);
    assert.equal(result.ambiguousWritebackKeyCount, 1);
    assert.equal(result.unmatchedCandidateCount, 1);
  });

  // ── Requirement 7: candidate side duplicate key → ambiguous, no auto-match ──
  it("does not auto-match when candidate side has duplicate correlation key", () => {
    const candidates = [
      stage1Candidate({ title: "Same Title" }),
      stage1Candidate({ title: "Same Title" }),
    ];
    const wbItems = [
      writebackItem("KEY1", { title: "Same Title" }),
    ];

    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      writebackSummary(wbItems),
    );

    assert.equal(result.status, "ok");
    assert.equal(result.keptCount, 0);
    assert.equal(result.ambiguousCandidateKeyCount, 1);
    assert.equal(result.unmatchedCandidateCount, 2);
  });

  // ── Requirement 8: similar but not identical title → no match ──
  it("does not match titles that differ even slightly", () => {
    const candidates = [
      stage1Candidate({ title: "exampleInflammatoryProcess in example condition" }),
    ];
    const wbItems = [
      writebackItem("KEY1", { title: "exampleInflammatoryProcess in a different example condition" }),
    ];

    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      writebackSummary(wbItems),
    );

    assert.equal(result.status, "ok");
    assert.equal(result.keptCount, 0);
    assert.equal(result.unmatchedCandidateCount, 1);
  });

  // ── Requirement 9: missing key fields → no fallback to title-only ──
  it("does not match when candidate lacks source_channel", () => {
    const candidates = [
      { title: "Title Only", grade: "A" }, // no source_channel
    ];
    const wbItems = [
      writebackItem("KEY1", { title: "Title Only", source_channel: "database", grade: "A" }),
    ];

    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      writebackSummary(wbItems),
    );

    // candidate key = "Title Only|||A" vs writeback key = "Title Only||database||A"
    assert.equal(result.status, "ok");
    assert.equal(result.keptCount, 0);
  });

  it("does not match when writeback item lacks grade", () => {
    const candidates = [
      stage1Candidate({ title: "No Grade Wb" }),
    ];
    const wbItems = [
      { itemKey: "KEY1", title: "No Grade Wb", source_channel: "database" }, // no grade
    ];

    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      writebackSummary(wbItems),
    );

    // candidate key = "No Grade Wb||database||A" vs writeback key = "No Grade Wb||database||"
    assert.equal(result.status, "ok");
    assert.equal(result.keptCount, 0);
  });

  // ── Requirement 10: real field structure simulation ──
  it("handles full real-world scenario with mixed candidates and writeback", () => {
    const candidates = [
      stage1Candidate({ title: "RSS Paper Alpha", source_channel: "rss", grade: "A" }),
      stage1Candidate({ title: "PubMed Paper Beta", source_channel: "database", grade: "B" }),
      stage1Candidate({ title: "PMC Paper Gamma", source_channel: "database", grade: "C" }),
      stage1Candidate({ title: "Unmatched Paper", source_channel: "rss", grade: "A" }),
      stage1Candidate({ title: "D Grade Paper", source_channel: "database", grade: "D" }),
    ];
    const wbItems = [
      writebackItem("ZOT_A", { title: "RSS Paper Alpha", source_channel: "rss", grade: "A" }),
      writebackItem("ZOT_B", { title: "PubMed Paper Beta", source_channel: "database", grade: "B" }),
      writebackItem("ZOT_C", { title: "PMC Paper Gamma", source_channel: "database", grade: "C" }),
    ];

    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      writebackSummary(wbItems),
    );

    assert.equal(result.status, "ok");
    assert.equal(result.candidateCount, 5);
    assert.equal(result.writebackItemCount, 3);
    assert.equal(result.keptCount, 3);
    assert.equal(result.unmatchedCandidateCount, 2);
    assert.equal(result.unmatchedWritebackCount, 0);
    assert.equal(result.ambiguousCandidateKeyCount, 0);
    assert.equal(result.ambiguousWritebackKeyCount, 0);

    // Verify itemKey backfill
    const keys = result.source.triaged.map((it) => it.itemKey);
    assert.deepEqual(keys, ["ZOT_A", "ZOT_B", "ZOT_C"]);

    // Verify 写回状态
    for (const item of result.source.triaged) {
      assert.equal(item.写回状态, "已写回");
    }

    // Verify original fields preserved
    assert.equal(result.source.triaged[0].title, "RSS Paper Alpha");
    assert.equal(result.source.triaged[0].source_channel, "rss");
    assert.equal(result.source.triaged[0].grade, "A");
  });

  // ── Edge: invalid desktop source ──
  it("returns invalid_desktop_source when desktopSource is null", () => {
    const result = filterDesktopReviewSourceByWritebackSummary(
      null,
      writebackSummary([writebackItem("KEY1")]),
    );
    assert.equal(result.status, "invalid_desktop_source");
    assert.equal(result.source.triaged.length, 0);
  });

  it("returns invalid_desktop_source when triaged is not an array", () => {
    const result = filterDesktopReviewSourceByWritebackSummary(
      { triaged: "not_array" },
      writebackSummary([writebackItem("KEY1")]),
    );
    assert.equal(result.status, "invalid_desktop_source");
  });

  // ── Edge: grade field resolution via grade_label / 推荐等级 ──
  it("matches when grade is provided via grade_label field", () => {
    const candidates = [
      { title: "Grade Via Label", source_channel: "rss", grade_label: "B" },
    ];
    const wbItems = [
      { itemKey: "KEY_B", title: "Grade Via Label", source_channel: "rss", grade_label: "B" },
    ];

    const result = filterDesktopReviewSourceByWritebackSummary(
      desktopSource(candidates),
      writebackSummary(wbItems),
    );

    // Both resolve grade through grade_label → "B", keys should match
    assert.equal(result.status, "ok");
    assert.equal(result.keptCount, 1);
    assert.equal(result.source.triaged[0].itemKey, "KEY_B");
  });
});

describe("buildStage4StandaloneExportSource", () => {
  function manyCandidates(count, matched = []) {
    const matchedByTitle = new Map(matched.map((item) => [item.title, item]));
    return Array.from({ length: count }, (_, i) => {
      const title = `Paper ${i}`;
      return stage1Candidate({
        title,
        source_channel: matchedByTitle.get(title)?.source_channel || "rss",
        grade: matchedByTitle.get(title)?.grade || "C",
      });
    });
  }

  it("filters standalone Stage 4 source from 342 ABC candidates down to the 3 writeback items", () => {
    const wbItems = [
      writebackItem("KEY_1", { title: "Paper 0", source_channel: "rss", grade: "C" }),
      writebackItem("KEY_2", { title: "Paper 100", source_channel: "rss", grade: "C" }),
      writebackItem("KEY_3", { title: "Paper 341", source_channel: "rss", grade: "C" }),
    ];
    const result = buildStage4StandaloneExportSource({
      desktopSource: desktopSource(manyCandidates(342, wbItems)),
      writebackReady: manyCandidates(342, wbItems),
      writebackSummary: writebackSummary(wbItems),
    });

    assert.equal(result.filter.status, "ok");
    assert.equal(result.filter.candidateCount, 342);
    assert.equal(result.filter.writebackItemCount, 3);
    assert.equal(result.filter.keptCount, 3);
    assert.equal(result.allAbcItems.length, 3);
    assert.deepEqual(result.allAbcItems.map((item) => item.itemKey), ["KEY_1", "KEY_2", "KEY_3"]);
  });

  it("does not fall back to full ABC candidates when writeback_items is empty", () => {
    const result = buildStage4StandaloneExportSource({
      desktopSource: desktopSource(manyCandidates(342)),
      writebackReady: manyCandidates(342),
      writebackSummary: writebackSummary([]),
    });

    assert.equal(result.filter.status, "no_new_writeback_items");
    assert.equal(result.filter.keptCount, 0);
    assert.equal(result.allAbcItems.length, 0);
  });

  it("degrades without exporting full ABC candidates when writeback summary is missing", () => {
    const result = buildStage4StandaloneExportSource({
      desktopSource: desktopSource(manyCandidates(342)),
      writebackReady: manyCandidates(342),
      writebackSummary: null,
    });

    assert.equal(result.filter.status, "degraded_missing_writeback_summary");
    assert.equal(result.filter.keptCount, 0);
    assert.equal(result.allAbcItems.length, 0);
    assert.match(result.filter.warning, /missing/i);
  });

  it("does not auto-match ambiguous candidate correlation keys", () => {
    const result = buildStage4StandaloneExportSource({
      desktopSource: desktopSource([
        stage1Candidate({ title: "Ambiguous", source_channel: "rss", grade: "C" }),
        stage1Candidate({ title: "Ambiguous", source_channel: "rss", grade: "C" }),
      ]),
      writebackReady: [],
      writebackSummary: writebackSummary([
        writebackItem("KEY_1", { title: "Ambiguous", source_channel: "rss", grade: "C" }),
      ]),
    });

    assert.equal(result.filter.ambiguousCandidateKeyCount, 1);
    assert.equal(result.filter.keptCount, 0);
    assert.equal(result.allAbcItems.length, 0);
  });

  it("does not auto-match ambiguous writeback correlation keys", () => {
    const result = buildStage4StandaloneExportSource({
      desktopSource: desktopSource([
        stage1Candidate({ title: "Ambiguous WB", source_channel: "rss", grade: "C" }),
      ]),
      writebackReady: [],
      writebackSummary: writebackSummary([
        writebackItem("KEY_1", { title: "Ambiguous WB", source_channel: "rss", grade: "C" }),
        writebackItem("KEY_2", { title: "Ambiguous WB", source_channel: "rss", grade: "C" }),
      ]),
    });

    assert.equal(result.filter.ambiguousWritebackKeyCount, 1);
    assert.equal(result.filter.keptCount, 0);
    assert.equal(result.allAbcItems.length, 0);
  });

  it("reports exactly two verified writes when the third attempted item conflicted", () => {
    const candidates = [
      stage1Candidate({ title: "Verified A", doi: "10.3000/a" }),
      stage1Candidate({ title: "Conflict B", doi: "10.3000/b" }),
      stage1Candidate({ title: "Verified C", doi: "10.3000/c" }),
    ];
    const attempted = candidates.map((item, index) => writebackItem(`KEY-${index + 1}`, item));
    const verified = [attempted[0], attempted[2]];
    const result = buildStage4StandaloneExportSource({
      desktopSource: desktopSource(candidates),
      writebackReady: candidates,
      writebackSummary: verifiedWritebackSummary({ attempted, verified }),
    });
    assert.equal(result.filter.status, "ok");
    assert.equal(result.allAbcItems.length, 2);
    assert.deepEqual(result.allAbcItems.map((item) => item.title), ["Verified A", "Verified C"]);
    assert.deepEqual(
      new Set(result.allAbcItems.map((item) => `doi:${item.doi}`)),
      new Set(result.filter.verifiedBusinessWriteIdentities),
    );
  });

  it("does not present a remote-unknown attempt as written", () => {
    const candidate = stage1Candidate({ title: "Remote unknown", doi: "10.3000/unknown" });
    const attempted = [writebackItem("UNKNOWN-1", candidate)];
    const result = buildStage4StandaloneExportSource({
      desktopSource: desktopSource([candidate]),
      writebackReady: [candidate],
      writebackSummary: verifiedWritebackSummary({ attempted, verified: [] }),
    });
    assert.equal(result.filter.status, "no_new_writeback_items");
    assert.equal(result.allAbcItems.length, 0);
  });

  it("fails closed when the report identity set differs from ledger-verified identities", () => {
    const candidate = stage1Candidate({ title: "Mismatch", doi: "10.3000/mismatch" });
    const written = writebackItem("MISMATCH-1", candidate);
    const result = buildStage4StandaloneExportSource({
      desktopSource: desktopSource([candidate]),
      writebackReady: [candidate],
      writebackSummary: verifiedWritebackSummary({ attempted: [written], verified: [written], identities: ["doi:10.3000/other"] }),
    });
    assert.equal(result.filter.status, "degraded_verified_write_identity_set_mismatch");
    assert.equal(result.allAbcItems.length, 0);
  });

  it("uses verified business evidence even when queue consumption still needs resume", () => {
    const candidate = stage1Candidate({ title: "Verified before consume", doi: "10.3000/resume" });
    const written = writebackItem("RESUME-1", candidate);
    const summary = {
      ...verifiedWritebackSummary({ attempted: [written], verified: [written] }),
      radar_queue_results: [{ identity: "doi:10.3000/resume", status: "claimed" }],
    };
    const result = buildStage4StandaloneExportSource({ desktopSource: desktopSource([candidate]), writebackReady: [candidate], writebackSummary: summary });
    assert.equal(result.filter.status, "ok");
    assert.equal(result.allAbcItems.length, 1);
    assert.equal(result.allAbcItems[0].itemKey, "RESUME-1");
  });
});
