import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importLocalCandidates } from "../tools/local/local_import.mjs";
import { atomicWriteJson, LocalRepository, readFeedbackJsonl } from "../tools/local/local_repository.mjs";
import { parseLocalArgs, runLocalPipeline } from "../tools/local/main.mjs";
import { formatTimingSummary } from "../tools/local/local_timing.mjs";
import { prepareLocalStage4ExportSource } from "../tools/stage4/export_source_step.mjs";
import { translateTitlesBatch } from "../tools/lib/title_translation_support.mjs";
import { createRunRecoveryCoordinator } from '../tools/recovery/run_recovery.mjs';
import { runStage5Notification } from '../tools/stage5/main.mjs';

async function tempDir() { return fs.mkdtemp(path.join(os.tmpdir(), "paperflow-local-")); }
function sharedIndexPath(root) { return path.join(root, "shared", "current_literature_index.json"); }

test('Local v5 partial channel failure preserves business, export and successful Email receipt', async t => {
  const root = await tempDir(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputRoot = path.join(root, 'out'); const input = path.join(root, 'input.json'); const runId = 'qq-local';
  await fs.writeFile(input, JSON.stringify([{ title: 'Paper fixture', doi: '10.1234/qq-local' }]));
  const coordinator = await createRunRecoveryCoordinator({ runRoot: path.join(outputRoot, 'runs'), runId, mode: 'local', profile: 'standard', configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath: path.join(outputRoot, 'runs', runId, 'input_artifact.json') });
  const env = { PAPERECHO_CONFIG_SCHEMA_VERSION: '5', PAPERECHO_QQ_CHANNEL: JSON.stringify({ enabled: true, appId: 'fixture', targetType: 'user', targetId: 'fixture' }) };
  const messages = { email: 0, qq: 0 };
  const result = await runLocalPipeline({ runId, recoveryCoordinator: coordinator, outputRoot, input, llmMode: 'disabled', recipient: 'reader@example.test' }, {
    env, sharedIndexPath: sharedIndexPath(root), runStage1: fakeStage1(root, []),
    runStage4Export: async ({ paths }) => { await fs.mkdir(path.dirname(paths.requestedOutputPath), { recursive: true }); await fs.writeFile(paths.requestedOutputPath, 'fixture export'); return { exportAudit: { actual_output_path: paths.requestedOutputPath }, exportManifest: { schemaVersion: 1, outputRoot, artifacts: [] } }; },
    runStage5Notification: request => runStage5Notification({ ...request, transport: async () => { messages.email++; return { accepted: true }; }, config: { ...request.config, qqTransport: async () => { messages.qq++; return { accepted: false, category: 'qq_rate_limited' }; } } }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.stage5_notification.businessStatus, 'success');
  assert.equal(result.stage5_notification.channels.email.status, 'sent');
  assert.equal(result.stage5_notification.channels.qq.status, 'failed');
  assert.deepEqual(messages, { email: 1, qq: 1 });
  assert.equal(coordinator.store.ledger.stages.stage4_exports.status, 'verified');
  assert.equal(coordinator.store.ledger.status, 'incomplete');
  assert.equal(await fs.readFile(result.export_path, 'utf8'), 'fixture export');
});

test("local runtime config resolves CLI paths without changing shared defaults", () => {
  const parsed = parseLocalArgs(["--output-root", "tmp/local", "--input=data/items.json", "--llm-mode", "mock", "--email", "reader@example.test", "--force-resend"]);
  assert.equal(path.isAbsolute(parsed.outputRoot), true);
  assert.equal(path.isAbsolute(parsed.input), true);
  assert.equal(parsed.llmMode, "mock");
  assert.equal(parsed.recipient, "reader@example.test");
  assert.equal(parsed.forceResend, true);
});

test("imports JSON and JSONL with per-record validation", async () => {
  const root = await tempDir();
  await fs.writeFile(path.join(root, "a.json"), JSON.stringify([{ title: "Paper A", doi: "https://doi.org/10.0000/example.038" }]));
  await fs.writeFile(path.join(root, "b.jsonl"), `${JSON.stringify({ title: "Paper B", pmid: "2" })}\nnot-json\n${JSON.stringify({ title: "missing id" })}\n`);
  const result = await importLocalCandidates(root);
  assert.equal(result.items.length, 2);
  assert.equal(result.errors.length, 2);
  assert.equal(result.errors[0].line, 2);
});

test("repository is idempotent, atomic, and feedback is auditable", async () => {
  const root = await tempDir();
  const repository = await new LocalRepository(root, { sharedIndexPath: sharedIndexPath(root) }).load();
  const item = { title: "Clinical outcome study", doi: "10.2/test", grade: "A", final_grade: "A" };
  assert.deepEqual(repository.upsertPapers([item], { runId: "r1" }), { created: 1, updated: 0, total: 1 });
  await repository.save();
  assert.deepEqual(repository.upsertPapers([item], { runId: "r2" }), { created: 0, updated: 1, total: 1 });
  await repository.appendFeedback({ local_paper_id: repository.papers[0].local_id, action: "upgrade", payload: { title: item.title, comment: "core topic" } }, { runId: "r2" });
  assert.equal((await readFeedbackJsonl(repository.feedbackPath)).length, 1);
  assert.equal((await fs.readdir(repository.stateDir)).some((name) => name.endsWith(".tmp")), false);
  assert.equal(JSON.stringify(repository.papers).includes("itemKey"), false);
});

test("atomic JSON rename failure preserves formal state and removes only its temporary file", async () => {
  const root = await tempDir();
  const target = path.join(root, "state.json");
  await fs.writeFile(target, '{"stable":true}\n');
  const fsApi = Object.create(fs);
  fsApi.rename = async () => { throw Object.assign(new Error("rename_blocked"), { code: "EACCES" }); };
  await assert.rejects(() => atomicWriteJson(target, { stable: false }, { fsApi }), /rename_blocked/);
  assert.equal(await fs.readFile(target, "utf8"), '{"stable":true}\n');
  assert.equal((await fs.readdir(root)).some((name) => name.endsWith(".tmp")), false);
});

test("real Local Stage1 completes while every poison Zotero boundary stays unused", async () => {
  const root = await tempDir();
  const input = path.join(root, "input.json");
  await fs.writeFile(input, JSON.stringify([{ title: "Clinical trial outcome", doi: "10.0000/example.047" }]));
  const calls = { ensureBackendReady: 0, backendFactory: 0, desktopLauncher: 0, stage2: 0, stage3: 0 };
  const poison = (name) => async () => { calls[name] += 1; throw new Error(`POISON_${name}`); };
  const result = await runLocalPipeline({ outputRoot: path.join(root, "out"), input, llmMode: "disabled" }, {
    sharedIndexPath: sharedIndexPath(root),
    zoteroBoundaries: {
      ensureBackendReady: poison("ensureBackendReady"),
      backendFactory: poison("backendFactory"),
      desktopLauncher: poison("desktopLauncher"),
      stage2: poison("stage2"),
      stage3: poison("stage3"),
    },
    runStage4Export: async () => ({ exportAudit: { actual_output_path: path.join(root, "out.xlsx") }, exportManifest: { schemaVersion: 1, outputRoot: root, artifacts: [] }, terminalExportError: null }),
  });
  assert.deepEqual(calls, { ensureBackendReady: 0, backendFactory: 0, desktopLauncher: 0, stage2: 0, stage3: 0 });
  const papers = JSON.parse(await fs.readFile(path.join(root, "out", "state", "papers.json"), "utf8"));
  assert.equal(papers.papers.length, 1);
  assert.equal(["A", "B", "C", "D"].includes(papers.papers[0].grade), true);
  assert.equal(/itemKey|collections|attachments|rating/.test(JSON.stringify(papers)), false);
  const timing = JSON.parse(await fs.readFile(result.timing_path, "utf8"));
  assert.equal(timing.schema_version, 1);
  assert.equal(timing.run_id, result.run_id);
  assert.equal(timing.status, "success");
  assert.equal(Number.isFinite(timing.total_duration_ms), true);
  assert.deepEqual(timing.stages.map((stage) => stage.name), ["configuration", "state_load", "local_import", "retrieval", "feedback_load", "stage1_pipeline", "title_translation", "state_persist", "stage4_export", "stage5_notification"]);
  assert.equal(timing.stages.find((stage) => stage.name === "retrieval").status, "skipped");
  assert.equal(timing.stages.find((stage) => stage.name === "stage5_notification").status, "skipped");
  for (const stage of timing.stages) {
    assert.equal(Number.isFinite(stage.duration_ms) && stage.duration_ms >= 0, true);
    assert.equal(["success", "skipped"].includes(stage.status), true);
    assert.equal(timing.total_duration_ms + 0.001 >= stage.duration_ms, true);
  }
  assert.match(formatTimingSummary(timing), /Timing:[\s\S]*stage1_pipeline[\s\S]*total/);
});

test("Local generates and persists title translation once through the shared cache", async () => {
  const root = await tempDir();
  const outputRoot = path.join(root, "out");
  const input = path.join(root, "input.json");
  const cachePath = path.join(root, "translation_cache.json");
  const english = "English-only clinical literature title";
  await fs.writeFile(input, JSON.stringify([{ title: english, doi: "10.0000/example.049" }]));
  let translatorCalls = 0;
  const batch = (titles, concurrency, options) => translateTitlesBatch(titles, concurrency, {
    ...options,
    translateOneImpl: async () => { translatorCalls += 1; return { ok: true, zh: "仅生成一次的中文标题" }; },
    runtime: { concurrencyLimit: 1, providerConcurrencyLimit: 1, batchSize: 1, model: "mock", temperature: 0, top_p: 1, stream: false, rateLimit: {} },
  });
  const baseStage1 = fakeStage1(root, []);
  const stage1 = async (options) => {
    const result = await baseStage1(options);
    result.triagedAll = result.triagedAll.map((item) => ({ ...item, grade: "A", final_grade: "A" }));
    return result;
  };
  const dependencies = { sharedIndexPath: sharedIndexPath(root), translationCachePath: cachePath, translateTitlesBatch: batch, runStage1: stage1, runStage4Export: fakeExport };
  const first = await runLocalPipeline({ outputRoot, input, llmMode: "disabled" }, dependencies);
  const second = await runLocalPipeline({ outputRoot, input, llmMode: "disabled" }, dependencies);
  const snapshot = JSON.parse(await fs.readFile(path.join(outputRoot, "state", "papers.json"), "utf8"));
  assert.equal(first.persistence.created, 1);
  assert.equal(second.persistence.created, 0);
  assert.equal(first.run_summary.counts.created, 1);
  assert.deepEqual(first.run_summary.counts.grades, { A: 1, B: 0, C: 0, D: 0 });
  assert.equal(second.run_summary.counts.created, 0);
  assert.deepEqual(second.run_summary.counts.grades, { A: 0, B: 0, C: 0, D: 0 });
  assert.equal(translatorCalls, 1);
  assert.equal(snapshot.papers[0].title, english);
  assert.equal(snapshot.papers[0].translatedTitle, "仅生成一次的中文标题");
});

function fakeStage1(root, observed, { fail = false } = {}) {
  return async (options) => {
    observed.push(options.normalizedFeedbackRows.map((row) => row.event_id));
    if (fail) throw new Error("preference_learning_failed");
    const pipeDir = path.join(root, `pipe-${observed.length}`);
    await fs.mkdir(pipeDir, { recursive: true });
    await fs.writeFile(path.join(pipeDir, "preference_learning_audit.json"), "{}");
    return { ok: true, pipeDir, report: { steps: {}, counts: {}, failures: [] }, triagedAll: options.candidateSource || [] };
  };
}

const fakeExport = async () => ({ exportAudit: { actual_output_path: "local.xlsx" }, exportManifest: { schemaVersion: 1, outputRoot: ".", artifacts: [] }, terminalExportError: null });

for (const env of [{ PAPERECHO_EMAIL_ENABLED: 'false' }, { PAPERECHO_NOTIFY_WEEKLY: 'false' }]) test('Local disabled notification completes business and creates no recovery operation', async (t) => {
  const root = await tempDir(); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputRoot = path.join(root, 'out'); const input = path.join(root, 'input.json');
  await fs.writeFile(input, JSON.stringify([{ title: 'Paper fixture', doi: '10.1234/disabled-local' }]));
  const runId = 'disabled-local';
  const coordinator = await createRunRecoveryCoordinator({ runRoot: path.join(outputRoot, 'runs'), runId, mode: 'local', profile: 'standard', configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath: path.join(outputRoot, 'runs', runId, 'input_artifact.json') });
  const result = await runLocalPipeline({ runId, recoveryCoordinator: coordinator, outputRoot, input, llmMode: 'disabled', recipient: 'reader@example.test' }, {
    env, sharedIndexPath: sharedIndexPath(root), runStage1: fakeStage1(root, []),
    runStage4Export: async ({ paths }) => { await fs.mkdir(path.dirname(paths.requestedOutputPath), { recursive: true }); await fs.writeFile(paths.requestedOutputPath, 'fixture export'); return { exportAudit: { actual_output_path: paths.requestedOutputPath }, exportManifest: { schemaVersion: 1, outputRoot, artifacts: [] } }; },
  });
  assert.equal(result.ok, true); assert.equal(result.stage5_notification.status, 'skipped');
  assert.equal(result.stage5_notification.reason, env.PAPERECHO_EMAIL_ENABLED === 'false' ? 'channel_disabled' : 'notification_policy_disabled');
  assert.equal(coordinator.store.ledger.status, 'completed');
  assert.equal(coordinator.store.ledger.operations.some((operation) => operation.type === 'notification'), false);
  assert.equal(coordinator.store.ledger.stages.stage4_exports.status, 'verified'); assert.equal(coordinator.store.ledger.stages.stage5_notification.status, 'verified');
});

test("Local calls shared Stage5 with recipient and force-resend after Stage4", async () => {
  const root = await tempDir();
  const outputRoot = path.join(root, "out");
  const input = path.join(root, "input.json");
  await fs.writeFile(input, JSON.stringify([{ title: "Paper", doi: "10.0000/example.045" }]));
  const observed = [];
  const result = await runLocalPipeline({ outputRoot, input, llmMode: "disabled", recipient: "reader@example.test", forceResend: true }, {
    sharedIndexPath: sharedIndexPath(root),
    runStage1: fakeStage1(root, []),
    runStage4Export: fakeExport,
    runStage5Notification: async (request) => { observed.push(request); return { status: "sent", reason: "sent", attachments: [] }; },
  });
  assert.equal(result.stage5_notification.status, "sent");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].runSummary.pipelineMode, "local");
  assert.equal(observed[0].recipient, "reader@example.test");
  assert.equal(observed[0].forceResend, true);
  assert.equal(observed[0].config.runStateRoot, path.join(outputRoot, "runs", result.run_id));
  const runGroup = JSON.parse(await fs.readFile(path.join(outputRoot, "runs", result.run_id, "run_group.json"), "utf8"));
  assert.equal(runGroup.status, "completed");
  assert.equal(runGroup.pipelineMode, "local");
  await assert.rejects(fs.stat(path.join(outputRoot, "runs", result.run_id, "local_export_source.json")), { code: "ENOENT" });
  assert.equal(result.housekeeping.immediateDeletedFiles, 1);
  assert.equal(result.timings.stages.find((stage) => stage.name === "stage5_notification").status, "success");
});

test("Local Stage5 failure preserves Stage1-4 state and fails the run", async () => {
  const root = await tempDir();
  const outputRoot = path.join(root, "out");
  const input = path.join(root, "input.json");
  await fs.writeFile(input, JSON.stringify([{ title: "Paper", doi: "10.0000/example.045-fail" }]));
  await assert.rejects(() => runLocalPipeline({ outputRoot, input, llmMode: "disabled", recipient: "reader@example.test" }, {
    sharedIndexPath: sharedIndexPath(root), runStage1: fakeStage1(root, []), runStage4Export: fakeExport,
    runStage5Notification: async () => ({ status: "failed", reason: "mock_failure", attachments: [] }),
  }), /STAGE5_NOTIFICATION_FAILED:mock_failure/);
  assert.equal((await fs.stat(path.join(outputRoot, "state", "papers.json"))).isFile(), true);
  const [runId] = await fs.readdir(path.join(outputRoot, "runs"));
  await assert.rejects(fs.stat(path.join(outputRoot, "runs", runId, "local_export_source.json")), { code: "ENOENT" });
});

test("Local keeps local_export_source.json when Stage4 does not consume it", async () => {
  const root = await tempDir();
  const outputRoot = path.join(root, "out");
  const input = path.join(root, "input.json");
  await fs.writeFile(input, JSON.stringify([{ title: "Paper", doi: "10.0000/example.044" }]));
  await assert.rejects(() => runLocalPipeline({ outputRoot, input, llmMode: "disabled" }, {
    sharedIndexPath: sharedIndexPath(root), runStage1: fakeStage1(root, []), runStage4Export: async () => { throw new Error("mock_stage4_failure"); },
  }), /mock_stage4_failure/);
  const runIds = (await fs.readdir(path.join(outputRoot, "runs"))).filter((name) => !name.endsWith(".json"));
  assert.equal((await fs.stat(path.join(outputRoot, "runs", runIds[0], "local_export_source.json"))).isFile(), true);
});

test("feedback checkpoint consumes each event once and only after learning succeeds", async () => {
  const root = await tempDir();
  const outputRoot = path.join(root, "out");
  const input = path.join(root, "input.json");
  await fs.writeFile(input, JSON.stringify([{ title: "Paper", doi: "10.0000/example.041" }]));
  const repository = await new LocalRepository(outputRoot, { sharedIndexPath: sharedIndexPath(root) }).load();
  repository.upsertPapers([{ title: "Paper", doi: "10.0000/example.041", grade: "A" }]);
  await repository.save();
  const localId = repository.papers[0].local_id;
  const feedback1 = path.join(root, "feedback-1.jsonl");
  await fs.writeFile(feedback1, [
    JSON.stringify({ event_id: "e1", local_paper_id: localId, action: "upgrade", payload: { title: "Paper" } }),
    JSON.stringify({ event_id: "e1", local_paper_id: localId, action: "upgrade", payload: { title: "Paper" } }),
  ].join("\n") + "\n");
  const observed = [];
  const common = { outputRoot, input, llmMode: "disabled" };
  const dependencies = { sharedIndexPath: sharedIndexPath(root), runStage1: fakeStage1(root, observed), runStage4Export: fakeExport };
  const first = await runLocalPipeline({ ...common, feedback: feedback1 }, dependencies);
  const second = await runLocalPipeline(common, dependencies);
  assert.equal(first.feedback_events_used, 1);
  assert.equal(second.feedback_events_used, 0);

  const feedback2 = path.join(root, "feedback-2.jsonl");
  await fs.writeFile(feedback2, `${JSON.stringify({ event_id: "e2", local_paper_id: localId, action: "keep", payload: { title: "Paper" } })}\n`);
  const third = await runLocalPipeline({ ...common, feedback: feedback2 }, dependencies);
  assert.equal(third.feedback_events_used, 1);
  assert.deepEqual(observed, [["e1"], [], ["e2"]]);
  assert.equal(new Set([first.run_id, second.run_id, third.run_id]).size, 3);
  assert.equal(new Set([first.timing_path, second.timing_path, third.timing_path]).size, 3);
  assert.equal((await Promise.all([first, second, third].map((result) => fs.stat(result.timing_path)))).every((stat) => stat.isFile()), true);
  assert.deepEqual([first, second, third].map((result) => result.timings.stages.find((stage) => stage.name === "feedback_load").metadata.feedback_consumed_count), [1, 0, 1]);
  const learning = await repository.loadLearningState();
  assert.deepEqual(learning.consumed_feedback_event_ids, ["e1", "e2"]);
});

test("failed preference learning leaves feedback pending for the next run", async () => {
  const root = await tempDir();
  const outputRoot = path.join(root, "out");
  const input = path.join(root, "input.json");
  await fs.writeFile(input, JSON.stringify([{ title: "Paper", doi: "10.0000/example.043" }]));
  const repository = await new LocalRepository(outputRoot, { sharedIndexPath: sharedIndexPath(root) }).load();
  repository.upsertPapers([{ title: "Paper", doi: "10.0000/example.043", grade: "A" }]);
  await repository.save();
  const feedback = path.join(root, "feedback.jsonl");
  await fs.writeFile(feedback, `${JSON.stringify({ event_id: "retry-1", local_paper_id: repository.papers[0].local_id, action: "drop", payload: { title: "Paper" } })}\n`);
  const failedObserved = [];
  let failure;
  try {
    await runLocalPipeline({ outputRoot, input, feedback, llmMode: "disabled" }, { sharedIndexPath: sharedIndexPath(root), runStage1: fakeStage1(root, failedObserved, { fail: true }), runStage4Export: fakeExport });
  } catch (error) { failure = error; }
  assert.match(failure?.message || "", /preference_learning_failed/);
  const failedRunDirs = await fs.readdir(path.join(outputRoot, "runs"));
  const failedTiming = JSON.parse(await fs.readFile(path.join(outputRoot, "runs", failedRunDirs[0], "timings.json"), "utf8"));
  assert.equal(failedTiming.status, "failed");
  assert.equal(failedTiming.stages.at(-1).name, "stage1_pipeline");
  assert.equal(failedTiming.stages.at(-1).status, "failed");
  assert.deepEqual((await repository.loadLearningState()).consumed_feedback_event_ids, []);
  const retryObserved = [];
  const result = await runLocalPipeline({ outputRoot, input, llmMode: "disabled" }, { sharedIndexPath: sharedIndexPath(root), runStage1: fakeStage1(root, retryObserved), runStage4Export: fakeExport });
  assert.equal(result.feedback_events_used, 1);
  assert.deepEqual(retryObserved, [["retry-1"]]);
});

test("timing write failure fails successful business and never replaces a business error", async () => {
  const root = await tempDir();
  const input = path.join(root, "input.json");
  await fs.writeFile(input, JSON.stringify([{ title: "Paper", doi: "10.0000/example.048" }]));
  const observed = [];
  const successRoot = path.join(root, "success");
  const fsApi = Object.create(fs);
  fsApi.rename = async () => { throw new Error("timing_rename_failed"); };
  const atomicTimingFailure = (filePath, value) => atomicWriteJson(filePath, value, { fsApi });
  await assert.rejects(() => runLocalPipeline({ outputRoot: successRoot, input, llmMode: "disabled" }, { sharedIndexPath: sharedIndexPath(root), runStage1: fakeStage1(root, observed), runStage4Export: fakeExport, writeTiming: atomicTimingFailure }), /timing_rename_failed/);
  const failedTimingRunDirs = await fs.readdir(path.join(successRoot, "runs"));
  assert.equal((await fs.readdir(path.join(successRoot, "runs", failedTimingRunDirs[0]))).some((name) => name.endsWith(".tmp")), false);
  const writeFailure = async () => { throw new Error("timing_write_failed"); };
  let businessFailure;
  try {
    await runLocalPipeline({ outputRoot: path.join(root, "business"), input, llmMode: "disabled" }, { sharedIndexPath: sharedIndexPath(root), runStage1: fakeStage1(root, observed, { fail: true }), runStage4Export: fakeExport, writeTiming: writeFailure });
  } catch (error) { businessFailure = error; }
  assert.equal(businessFailure.message, "preference_learning_failed");
  assert.match(businessFailure.timing_write_error, /timing_write_failed/);
});

test("local Stage4 source strips Zotero-only fields", async () => {
  const root = await tempDir();
  const sourcePath = path.join(root, "run", "local_export_source.json");
  const source = await prepareLocalStage4ExportSource({ papers: [{ local_id: "lp_1", title: "A", grade: "A", itemKey: "NO", collections: ["NO"] }], sourcePath, runReport: { steps: {}, counts: {}, failures: [] } });
  assert.equal(source.finalPayload.source_type, "local");
  assert.equal(JSON.stringify(source.finalPayload).includes("itemKey"), false);
});

test("all-invalid import fails without creating repository state", async () => {
  const root = await tempDir();
  const input = path.join(root, "bad.json");
  await fs.writeFile(input, JSON.stringify([{ title: "No identifier" }]));
  await assert.rejects(() => importLocalCandidates(input), /LOCAL_IMPORT_NO_VALID_ITEMS/);
  await assert.rejects(() => fs.stat(path.join(root, "state", "papers.json")), { code: "ENOENT" });
});
