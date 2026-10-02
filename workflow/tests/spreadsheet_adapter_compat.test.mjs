import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { exportAllResearchOsXlsxWithNodeFallback } from "../tools/stage4/spreadsheet_adapter.mjs";

async function exportRows(triaged) {
  const base = path.resolve('tests/runs/spreadsheet-compat');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "case-"));
  const sourcePath = path.join(root, "source.json");
  const reviewDayDir = path.join(root, "review");
  await fs.mkdir(reviewDayDir, { recursive: true });
  await fs.writeFile(sourcePath, JSON.stringify({ triaged: triaged.map((item,index)=>({doi:`10.1234/compat-${index}`,...item})), reportContext: {} }), "utf8");
  const result = await exportAllResearchOsXlsxWithNodeFallback({
    sourcePath,
    reviewRootDir: root,
    reviewWeekDir: root,
    reviewDayDir,
    dateStr: "2026-06-22",
    weekLabel: "26.06",
    dayLabel: "06.22",
  });
  const ExcelJS = await import("exceljs");
  const Workbook = ExcelJS.default?.Workbook || ExcelJS.Workbook;
  const wb = new Workbook();
  await wb.xlsx.readFile(result.outputs.every_other_day_report);
  const dailySheet = wb.getWorksheet("每日反馈");
  const reviewSheet = wb.getWorksheet("需人工复核");
  const readRows = (sheet) => {
    const rows = [];
    for (let rowIndex = 2; rowIndex <= sheet.rowCount; rowIndex += 1) {
      const row = sheet.getRow(rowIndex);
      const values = row.values.slice(1);
      if (values.every((value) => value === null || value === undefined || value === "")) continue;
      rows.push(values);
    }
    return rows;
  };
  return {
    headers: dailySheet.getRow(1).values.slice(1),
    dailyRows: readRows(dailySheet),
    reviewRows: readRows(reviewSheet),
  };
}

describe("spreadsheet_adapter llm_review_grade compatibility", () => {
  it("exports semantic grade from llm_review_grade before semantic_grade without changing headers", async () => {
    const exported = await exportRows([
      { title: "llm only", rule_grade: "C", llm_review_grade: "B", final_grade: "B", journal: "Journal A" },
      { title: "both", rule_grade: "C", llm_review_grade: "A", semantic_grade: "B", final_grade: "A", journal: "Journal B" },
      { title: "legacy", rule_grade: "C", semantic_grade: "B", final_grade: "B", journal: "Journal C" },
      { title: "nested", rule_grade: "C", semantic_review: { grade: "A" }, final_grade: "A", journal: "Journal D" },
    ]);

    assert.deepEqual(exported.headers, ["英文标题", "标题翻译", "规则等级", "语义等级", "最终等级", "期刊/来源", "反馈", "评价"]);
    assert.deepEqual(exported.dailyRows.map((row) => row[3]), ["B", "B"]);
    assert.deepEqual(exported.reviewRows.map((row) => row[5]), ["A", "A"]); // C→A is a large grade gap.
  });

  it("keeps explicit review separate from legacy disagreement evidence", async () => {
    const exported = await exportRows([
      { title: "daily item", rule_grade: "C", llm_review_grade: "B", final_grade: "B", semantic_source: "llm_title_review_grade", journal: "Journal A" },
      { title: "explicit review", rule_grade: "C", llm_review_grade: "D", final_grade: "C", needs_human_review: true, disagreement_type: "semantic_downgrade_review", journal: "Journal B" },
      { title: "legacy mismatch", rule_grade: "B", llm_review_grade: "A", final_grade: "B", semantic_mismatch: true, journal: "Journal C" },
    ]);

    const dailyTitles = exported.dailyRows.map((row) => row[0]);
    const reviewTitles = exported.reviewRows.map((row) => row[0]);

    assert.deepEqual(dailyTitles, ["daily item", "legacy mismatch"]);
    assert.deepEqual(reviewTitles, ["explicit review"]);
    assert.equal(dailyTitles.some((title) => reviewTitles.includes(title)), false);
    assert.equal(exported.dailyRows[0][3], "B");
    assert.deepEqual(exported.reviewRows.map((row) => row[4]), ["C"]);
  });

  it("writes the canonical translatedTitle to the XLSX translation column", async () => {
    const exported = await exportRows([{ title: "English source title", translatedTitle: "中文标题", rule_grade: "A", semantic_grade:"A", final_grade: "A" }]);
    assert.equal(exported.dailyRows[0][0], "English source title");
    assert.equal(exported.dailyRows[0][1], "中文标题");
    assert.notEqual(exported.dailyRows[0][0], exported.dailyRows[0][1]);
  });
});
