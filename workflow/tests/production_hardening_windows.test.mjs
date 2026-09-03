import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeAtomicJson } from "../tools/lib/atomic_json.mjs";
import { ZoteroCliBackend } from "../tools/lib/zotero_cli_backend.mjs";
import { canonicalQueryHash } from "../tools/stage1/source_state.mjs";
import { createRunRecoveryCoordinator } from "../tools/recovery/run_recovery.mjs";
import { reconcileOperationLedger } from "../tools/recovery/reconciliation.mjs";
import { runStage4WorkbookExport } from "../tools/stage4/export_execution_step.mjs";
import {
  DAILY_REVIEW_HEADERS,
  HUMAN_REVIEW_HEADERS,
  exportAllResearchOsXlsxWithNodeFallback,
  validateWeeklyWorkbook,
} from "../tools/stage4/spreadsheet_adapter.mjs";

async function sandbox(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("atomic JSON succeeds on the first rename", async (t) => {
  const root = await sandbox(t, "paperecho-atomic-first-");
  const target = path.join(root, "state.json");
  let calls = 0;
  await writeAtomicJson(target, { stable: true }, {
    renameImpl: async (source, destination) => { calls += 1; await fs.rename(source, destination); },
    sleep: async () => assert.fail("sleep must not run"),
  });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { stable: true });
});

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`atomic JSON retries transient ${code} and then succeeds`, async (t) => {
    const root = await sandbox(t, `paperecho-atomic-${code.toLowerCase()}-`);
    const target = path.join(root, "state.json");
    const delays = [];
    let calls = 0;
    await writeAtomicJson(target, { stable: true }, {
      renameImpl: async (source, destination) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error(code), { code });
        await fs.rename(source, destination);
      },
      sleep: async (delay) => delays.push(delay),
    });
    assert.equal(calls, 2);
    assert.deepEqual(delays, [10]);
  });
}

test("atomic JSON fails after bounded transient retries and cleans its temp", async (t) => {
  const root = await sandbox(t, "paperecho-atomic-exhausted-");
  const target = path.join(root, "state.json");
  let calls = 0;
  await assert.rejects(() => writeAtomicJson(target, { stable: false }, {
    renameImpl: async () => { calls += 1; throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
    sleep: async () => {},
    renameAttempts: 3,
  }), /busy/);
  assert.equal(calls, 3);
  assert.deepEqual(await fs.readdir(root), []);
});

test("atomic JSON does not retry unrelated rename failures", async (t) => {
  const root = await sandbox(t, "paperecho-atomic-unrelated-");
  const target = path.join(root, "state.json");
  let calls = 0;
  await assert.rejects(() => writeAtomicJson(target, { stable: false }, {
    renameImpl: async () => { calls += 1; throw Object.assign(new Error("invalid"), { code: "EINVAL" }); },
    sleep: async () => assert.fail("sleep must not run"),
  }), /invalid/);
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(root), []);
});

test("small and oversized metadata batches use stdin without metadata in argv", async () => {
  for (const title of ["中文 \"quote\"\nline\\tail", `超长标题${"字".repeat(40000)}`]) {
    const calls = [];
    const backend = new ZoteroCliBackend({
      executeCli: async (tool, args, options) => {
        calls.push({ tool, args, options });
        return { exitCode: 0, stdout: "", stderr: "", data: { updated: ["ITEM1"], failed: [] } };
      },
    });
    const result = await backend.writeMetadataBatch([{ itemKey: "ITEM1", fields: { shortTitle: title } }]);
    assert.deepEqual(result.updated, ["ITEM1"]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].args[0], /zotero_cli_stdin_runner\.py$/);
    assert.equal(calls[0].args.some((arg) => String(arg).includes(title)), false);
    assert.equal(calls[0].options.stdin.includes(JSON.stringify(title).slice(1, -1)), true);
  }
});

test("stdin transport surfaces spawn and non-zero child failures", async () => {
  const spawnFailure = new ZoteroCliBackend({ executeCli: async () => { throw new Error("stdin_broken"); } });
  await assert.rejects(() => spawnFailure.writeMetadataBatch([{ itemKey: "I", fields: { shortTitle: "中文" } }]), /stdin_broken/);
  const exitFailure = new ZoteroCliBackend({ executeCli: async () => ({ exitCode: 7, stdout: "", stderr: "bridge failed", data: null }) });
  await assert.rejects(() => exitFailure.writeMetadataBatch([{ itemKey: "I", fields: { shortTitle: "中文" } }]), /code 7.*bridge failed/);
});

test("metadata notApplicable closes as a verified no-op and resume skips it", async (t) => {
  const runRoot = await sandbox(t, "paperecho-metadata-noop-");
  const runId = "metadata-noop";
  const hash = canonicalQueryHash({ stable: true });
  const coordinator = await createRunRecoveryCoordinator({
    runRoot,
    runId,
    mode: "web",
    profile: "standard",
    launcherId: "test",
    configHash: hash,
    inputHash: hash,
    artifactPath: path.join(runRoot, runId, "input.json"),
  });
  await coordinator.persistArtifact([], []);
  const operations = await coordinator.prepareMetadata([{ itemKey: "ITEM1", fields: { shortTitle: "" } }]);
  await coordinator.completeMetadata(operations, { notApplicable: ["ITEM1"] });
  const operation = coordinator.store.ledger.operations[0];
  assert.equal(operation.status, "verified");
  assert.equal(operation.verification.notApplicable, true);
  assert.equal(operation.verification.outcome, "verified_no_op");
  let observed = 0;
  let executed = 0;
  const resumed = await reconcileOperationLedger({
    store: coordinator.store,
    reconcilers: { zotero_metadata: { observe: async () => { observed += 1; return { state: "absent" }; }, execute: async () => { executed += 1; } } },
  });
  assert.equal(resumed.outcomes[0].action, "skipped_verified");
  assert.equal(observed, 0);
  assert.equal(executed, 0);
  assert.equal(operation.verification.version, undefined);
});

async function writeAnonymousWorkbook(filePath, { feedback = "", formulaError = false } = {}) {
  const ExcelJS = await import("exceljs");
  const Workbook = ExcelJS.Workbook || ExcelJS.default?.Workbook;
  const workbook = new Workbook();
  const daily = workbook.addWorksheet("每日反馈");
  daily.addRow(DAILY_REVIEW_HEADERS);
  daily.addRow(["Anonymous title", "匿名标题", "A", "A", "A", "Journal", feedback, ""]);
  const review = workbook.addWorksheet("需人工复核");
  review.addRow(HUMAN_REVIEW_HEADERS);
  for (const sheet of [daily, review]) {
    for (let column = 1; column <= sheet.columnCount; column++) {
      sheet.getCell(1, column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
      sheet.getCell(1, column).font = { bold: true, color: { argb: "FFFFFFFF" } };
    }
  }
  if (formulaError) daily.getCell("A2").value = { formula: "1/0", result: "#DIV/0!" };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await workbook.xlsx.writeFile(filePath);
  return {
    rows_count: 1,
    excluded_d_count: 0,
    daily_workbook_sheets: ["每日反馈", "需人工复核"],
    outputs: { every_other_day_report: filePath },
  };
}

test("independent reader rejects changed blanks and formula errors", async (t) => {
  const root = await sandbox(t, "paperecho-xlsx-validation-");
  const changedBlank = path.join(root, "changed-blank.xlsx");
  const formulaError = path.join(root, "formula-error.xlsx");
  await writeAnonymousWorkbook(changedBlank, { feedback: "10" });
  await writeAnonymousWorkbook(formulaError, { formulaError: true });
  const blankValidation = await validateWeeklyWorkbook(changedBlank);
  const formulaValidation = await validateWeeklyWorkbook(formulaError);
  assert.equal(blankValidation.ok, false);
  assert.equal(blankValidation.errors.includes("daily_feedback_not_blank:G2"), true);
  assert.equal(formulaValidation.ok, false);
  assert.equal(formulaValidation.errors.some((error) => error.startsWith("formula_errors:")), true);
});

test("invalid preferred workbook is rejected and node fallback is rebuilt from pristine source", async (t) => {
  const root = await sandbox(t, "paperecho-xlsx-fallback-");
  const sourcePath = path.join(root, "source.json");
  const finalPath = path.join(root, "review", "周报.xlsx");
  const payload = { triaged: [{ title: "Anonymous", grade: "A", rule_grade: "A", final_grade: "A", publicationTitle: "Journal" }] };
  await fs.writeFile(sourcePath, JSON.stringify(payload), "utf8");
  const sourcePaths = [];
  const result = await runStage4WorkbookExport({
    paths: { sourcePath, reviewRoot: root, reviewMonthDir: root, reviewDayDir: path.dirname(finalPath), requestedOutputPath: finalPath, exportInputFiles: [sourcePath] },
    labels: { dateStr: "2026-07-03", reviewMonthLabel: "26.07", reviewDayLabel: "07.03" },
    source: { runReport: { counts: {} }, writebackSummary: {}, backfillReport: {}, sourceFilterAudit: {}, fallbackExportFields: {} },
    dependencies: {
      detectCodexSpreadsheetAvailability: async () => ({ available: true, reason: null }),
      detectNodeFallbackAvailability: async () => ({ available: true, reason: null }),
      exportWithCodexSpreadsheet: async (options) => {
        sourcePaths.push(options.sourcePath);
        return writeAnonymousWorkbook(path.join(options.reviewDayDir, "周报.xlsx"), { feedback: "10" });
      },
      exportWithNodeFallback: async (options) => {
        sourcePaths.push(options.sourcePath);
        assert.deepEqual(JSON.parse(await fs.readFile(options.sourcePath, "utf8")), payload);
        return exportAllResearchOsXlsxWithNodeFallback(options);
      },
    },
  });
  assert.equal(result.terminalExportError, null);
  assert.equal(result.exportAudit.export_method, "node_fallback");
  assert.equal(result.exportAudit.export_degrade_reason, "codex_spreadsheet_validation_failed_using_node_fallback");
  assert.equal(result.exportAudit.preferred_writer_rejection.includes("daily_feedback_not_blank:G2"), true);
  assert.deepEqual(sourcePaths, [sourcePath, sourcePath]);
  assert.equal((await validateWeeklyWorkbook(finalPath)).ok, true);
  const ExcelJS = await import("exceljs");
  const Workbook = ExcelJS.Workbook || ExcelJS.default?.Workbook;
  const reopened = new Workbook();
  await reopened.xlsx.readFile(finalPath);
  assert.equal(reopened.getWorksheet("每日反馈").getCell("A1").font.bold, true);
  assert.equal((await fs.readdir(path.dirname(finalPath))).some((name) => name.startsWith(".paperecho-stage4-")), false);
});

test("a rejected intermediate is never promoted when no fallback is available", async (t) => {
  const root = await sandbox(t, "paperecho-xlsx-no-promotion-");
  const sourcePath = path.join(root, "source.json");
  const finalPath = path.join(root, "review", "周报.xlsx");
  await fs.writeFile(sourcePath, JSON.stringify({ triaged: [] }), "utf8");
  const result = await runStage4WorkbookExport({
    paths: { sourcePath, reviewRoot: root, reviewMonthDir: root, reviewDayDir: path.dirname(finalPath), requestedOutputPath: finalPath, exportInputFiles: [sourcePath] },
    labels: { dateStr: "2026-07-03", reviewMonthLabel: "26.07", reviewDayLabel: "07.03" },
    source: { runReport: { counts: {} }, writebackSummary: {}, backfillReport: {}, sourceFilterAudit: {}, fallbackExportFields: {} },
    dependencies: {
      detectCodexSpreadsheetAvailability: async () => ({ available: true, reason: null }),
      detectNodeFallbackAvailability: async () => ({ available: false, reason: "disabled_for_test" }),
      exportWithCodexSpreadsheet: async (options) => writeAnonymousWorkbook(path.join(options.reviewDayDir, "周报.xlsx"), { formulaError: true }),
    },
  });
  assert.equal(result.exportAudit.stage4_export_status, "failed");
  await assert.rejects(() => fs.access(finalPath), /ENOENT/);
});
