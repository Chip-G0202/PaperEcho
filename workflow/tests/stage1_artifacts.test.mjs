import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildTranslationBackfillInput, buildWritebackReadyArtifact } from "../tools/lib/pipeline_stage_support.mjs";
import { buildStage1ArtifactManifest } from "../tools/stage1/artifact_manifest.mjs";
import { buildCompletedStage1RunReport, buildStage1RunReport, buildStage1SkipRunReport } from "../tools/stage1/run_report_builder.mjs";

describe("Stage 1 artifact builders", () => {

  it("buildStage1ArtifactManifest marks writeback_ready_items as the Stage 2 dependency", () => {
    const pipelineDir = path.join("review_results", "pipeline", "06.29");
    const manifest = buildStage1ArtifactManifest({
      pipelineDay: "06.29",
      pipelineDir,
      mode: "completed",
      written: true,
      retrievalWritten: false,
    });

    const writebackReady = manifest.required_for_stage2.find((artifact) => artifact.name === "writeback_ready_items.json");
    assert.ok(writebackReady);
    assert.equal(writebackReady.path, path.join(pipelineDir, "writeback_ready_items.json"));
    assert.equal(writebackReady.required, true);
    assert.equal(writebackReady.written, true);
    assert.equal(writebackReady.stage_dependency, "stage2");
    assert.equal(writebackReady.guarded_by_orchestrator, true);
    const retrievalAudit = manifest.audit_outputs.find((artifact) => artifact.name === "retrieval_audit.json");
    assert.equal(retrievalAudit.written, false);
    assert.equal(JSON.stringify(manifest).includes("full item title"), false);
  });

  it("buildStage1ArtifactManifest reports internal skip outputs without claiming writeback ready was written", () => {
    const pipelineDir = path.join("review_results", "pipeline", "06.29");
    const previousEnv = process.env.review_results_RUN_INTERVAL_DAYS;
    process.env.review_results_RUN_INTERVAL_DAYS = "must-not-be-read";
    try {
      const manifest = buildStage1ArtifactManifest({
        pipelineDay: "06.29",
        pipelineDir,
        mode: "skipped",
      });

      const skipReport = manifest.skipped_outputs.find((artifact) => artifact.name === "run_skip_report.json");
      const runReport = manifest.report_outputs.find((artifact) => artifact.name === "run_report.json");
      const writebackReady = manifest.required_for_stage2.find((artifact) => artifact.name === "writeback_ready_items.json");

      assert.equal(skipReport.path, path.join(pipelineDir, "run_skip_report.json"));
      assert.equal(skipReport.written, true);
      assert.equal(runReport.written, true);
      assert.equal(writebackReady.written, "skipped");
      assert.equal(writebackReady.stage_dependency, "stage2");
      assert.equal(writebackReady.guarded_by_orchestrator, true);
      assert.equal(process.env.review_results_RUN_INTERVAL_DAYS, "must-not-be-read");
    } finally {
      if (previousEnv === undefined) delete process.env.review_results_RUN_INTERVAL_DAYS;
      else process.env.review_results_RUN_INTERVAL_DAYS = previousEnv;
    }
  });

  it("buildStage1RunReport initializes compatible run report containers", () => {
    const intervalInfo = {
      current_run_at: "2026-06-29T07:00:00.000Z",
      run_due: true,
      elapsed_hours_since_last_success: 48,
      next_eligible_run_at: "2026-07-01T07:00:00.000Z",
    };
    const intervalGateDiagnostics = {
      gate_name: "stage1_internal_interval_gate",
      reference_state_field: "last_accepted_planned_slot_at",
    };

    const report = buildStage1RunReport({
      startedAt: "2026-06-29T07:01:00.000Z",
      date: "2026-06-29",
      monthDir: "26.06",
      reviewDayDir: "06.29",
      weekDir: "26 Week27",
      dayDir: "06.29",
      intervalInfo,
      intervalGateDiagnostics,
      triggerMode: "manual",
      forceRun: false,
      exportRoot: "review_results/文献评价",
    });

    assert.equal(report.started_at, "2026-06-29T07:01:00.000Z");
    assert.equal(report.report_label, "周报");
    assert.equal(report.synthesis_label, "月报");
    assert.deepEqual(report.steps, {});
    assert.deepEqual(report.counts, {});
    assert.deepEqual(report.failures, []);
    assert.deepEqual(report.pending_zotero_writeback, []);
    assert.deepEqual(report.interval_gate_diagnostics, intervalGateDiagnostics);
    assert.equal(report.run_due, true);
  });

  it("buildStage1SkipRunReport keeps interval skip report schema", () => {
    const skipReport = buildStage1SkipRunReport({
      startedAt: "2026-06-29T07:00:00.000Z",
      intervalInfo: {
        current_run_at: "2026-06-29T07:00:00.000Z",
        run_due: false,
        next_eligible_run_at: "2026-07-01T07:00:00.000Z",
      },
      intervalGateDiagnostics: { skip_reason: "interval_not_reached" },
      triggerMode: "scheduled",
      forceRun: false,
      monthDir: "26.06",
      reviewDayDir: "06.29",
      exportRoot: "review_results/文献评价",
    });

    assert.equal(skipReport.skipped, true);
    assert.equal(skipReport.reason, "interval_not_reached");
    assert.equal(skipReport.report_cadence, "weekly");
    assert.equal(skipReport.desktop_export_disabled, true);
    assert.deepEqual(skipReport.interval_gate_diagnostics, { skip_reason: "interval_not_reached" });
  });

  it("buildCompletedStage1RunReport preserves telemetry and assembles final report fields without side effects", () => {
    const previousEnv = process.env.ZOTERO_STAR_MIGRATION_MODE;
    process.env.ZOTERO_STAR_MIGRATION_MODE = "must-not-be-read";
    try {
      const baseReport = {
        steps: {
          connector: { ok: true },
          feedback_learning: { ok: true, path: "previous.xlsx" },
          med_query_learning: {
            preference_learning_summary_exported: true,
            screening_standards_sync_summary: { evaluation_text_cleared: true },
          },
          dedupe: {
            fetched_count: 4,
            deduped_count: 3,
            duplicate_removed_count: 1,
            llm_review_candidate_count: 2,
            llm_review_candidate_count_before_zotero_dedupe: 2,
            llm_review_candidate_count_after_zotero_dedupe: 1,
            duplicates_still_reviewed_count: 0,
            excluded_non_abc_count: 1,
            excluded_not_deduped_count: 1,
          },
          pre_llm_zotero_existing_dedupe: {
            pre_llm_existing_duplicate_count: 1,
            skipped_llm_review_existing_count: 1,
            skipped_writeback_pre_llm_existing_count: 1,
          },
          journal_quality_gate: {
            easyscholar_summary: { queried_count: 2, cache_hit_count: 1 },
          },
        },
        counts: { rss_raw: 2, db_raw: 2 },
        failures: [],
        pending_zotero_writeback: [],
        stage_timings: {},
        llm_review_candidate_summary: { llm_review_candidates_count: 1 },
        screening_standards_sync_summary: { evaluation_text_cleared: true },
      };
      const triagedAll = [
        { id: "a", grade: "A", grade_label: "A课题相关" },
        { id: "b", grade: "B", grade_label: "B专题相关" },
        { id: "d", grade: "D", grade_label: "D无关" },
      ];
      const triaged = triagedAll.slice(0, 2);

      const report = buildCompletedStage1RunReport({
        report: baseReport,
        mergedCount: 3,
        rssItemsCount: 2,
        dbItemsCount: 2,
        triagedAll,
        triaged,
        triageSummary: {
          grade_counts: { A: 1, B: 1, D: 1 },
          writeback_candidate_count: 2,
          skipped_d_count: 1,
          uncertain_count: 0,
        },
        exportLimit: null,
        translationConfig: {
          model: "mock-model",
          apiKeyConfigured: false,
          batchSize: 10,
          temperature: 0,
        },
        translationCachePath: "cache/title_translation_cache.json",
        triageDurationMs: 12,
        triageVersion: "test-triage",
        labels: { A: "A课题相关", B: "B专题相关", C: "C领域相关", D: "D无关" },
        dateStr: "2026-06-29",
        starMigrationDefaults: {
          default_mode: "expand",
          default_window_days: 10,
          default_star_threshold: 4,
        },
      });

      assert.equal(baseReport.steps.translation, undefined);
      assert.equal(report.steps.translation.provider, "mock-model");
      assert.equal(report.steps.med_daily_triage.exported_count, 2);
      assert.equal(report.steps.daily_export_counts.exported["A课题相关"], 1);
      assert.equal(report.counts.merged, 3);
      assert.equal(report.counts.daily_export, 2);
      assert.deepEqual(report.llm_review_candidate_summary, { llm_review_candidates_count: 1 });
      assert.deepEqual(report.steps.journal_quality_gate.easyscholar_summary, { queried_count: 2, cache_hit_count: 1 });
      assert.equal(report.steps.med_query_learning.preference_learning_summary_exported, true);
      assert.deepEqual(report.screening_standards_sync_summary, { evaluation_text_cleared: true });
      assert.equal(report.pending_zotero_writeback[0].star_migration.default_mode, "expand");
      assert.equal(report.stage_timings.zotero_writeback.status, "skipped");
      assert.equal(process.env.ZOTERO_STAR_MIGRATION_MODE, "must-not-be-read");
    } finally {
      if (previousEnv === undefined) delete process.env.ZOTERO_STAR_MIGRATION_MODE;
      else process.env.ZOTERO_STAR_MIGRATION_MODE = previousEnv;
    }
  });

  it("buildWritebackReadyArtifact preserves Stage 1 to Stage 2 artifact schema and order", () => {
    const translationCache = new Map([["a title", { ok: true, zh: "甲标题" }]]);
    const items = [
      { id: "a1", title: "A title", grade: "A", grade_label: "A课题相关", grade_reason: "topic", source_channel: "rss", doi: "10/a" },
      { id: "d1", title: "D title", grade: "D", grade_label: "D无关", grade_reason: "out", source_channel: "pubmed" },
      { id: "b-skip", title: "B skipped", grade: "B", grade_label: "B专题相关", pre_llm_skip_writeback: true, source_channel: "rss" },
      { id: "c1", title: "C title", grade: "C", "推荐等级": "C领域相关", "推荐理由": "field", "中文标题": "既有中文", source_channel: "pubmed" },
    ];

    const artifact = buildWritebackReadyArtifact(items, { translationCache });

    assert.deepEqual(artifact.items.map((item) => item.id), ["a1", "c1"]);
    assert.equal(artifact.items[0]["推荐等级"], "A课题相关");
    assert.equal(artifact.items[0]["推荐理由"], "topic");
    assert.equal(artifact.items[0]["标题翻译"], "甲标题");
    assert.equal(artifact.items[0]["中文标题"], "甲标题");
    assert.equal(artifact.items[0].backfill_short_title, true);
    assert.equal(artifact.items[1]["推荐等级"], "C领域相关");
    assert.equal(artifact.items[1]["推荐理由"], "field");
    assert.equal(artifact.items[1]["中文标题"], "既有中文");
    assert.equal(artifact.summary.input_count, 4);
    assert.equal(artifact.summary.item_count, 2);
    assert.equal(artifact.summary.excluded_count, 2);
    assert.equal(artifact.summary.export_limit, null);
  });

  it("buildWritebackReadyArtifact applies existing export limit and remains Stage 2 compatible", () => {
    const artifact = buildWritebackReadyArtifact([
      { title: "A title", grade: "A", grade_label: "A课题相关", source_channel: "rss" },
      { title: "B title", grade: "B", grade_label: "B专题相关", source_channel: "pubmed" },
    ], { exportLimit: 1 });

    assert.equal(artifact.items.length, 1);
    assert.equal(artifact.summary.item_count_before_export_limit, 2);
    assert.equal(artifact.summary.item_count, 1);
    const stage2Item = artifact.items[0];
    assert.equal(stage2Item.title, "A title");
    assert.equal(stage2Item.grade, "A");
    assert.equal(stage2Item.source_channel, "rss");
    assert.equal(stage2Item.backfill_short_title, true);
    assert.equal(stage2Item["推荐等级"], "A课题相关");

    const backfillInput = buildTranslationBackfillInput({
      writeback_items: [{ ...stage2Item, itemKey: "Z1" }],
    });
    assert.deepEqual(backfillInput, [{
      itemKey: "Z1",
      title: "A title",
      中文标题: "",
      grade: "A",
      source_channel: "rss",
    }]);
  });

  it("buildWritebackReadyArtifact handles empty input without side effects", () => {
    const previousEnv = process.env.ZOTERO_MCP_URL;
    process.env.ZOTERO_MCP_URL = "must-not-be-read";
    try {
      const artifact = buildWritebackReadyArtifact([], { exportLimit: 10 });
      assert.deepEqual(artifact.items, []);
      assert.equal(artifact.summary.input_count, 0);
      assert.equal(artifact.summary.item_count, 0);
      assert.equal(artifact.summary.excluded_count, 0);
      assert.equal(process.env.ZOTERO_MCP_URL, "must-not-be-read");
    } finally {
      if (previousEnv === undefined) delete process.env.ZOTERO_MCP_URL;
      else process.env.ZOTERO_MCP_URL = previousEnv;
    }
  });
});
