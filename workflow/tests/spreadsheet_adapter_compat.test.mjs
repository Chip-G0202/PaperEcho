import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { exportAllResearchOsXlsxWithNodeFallback } from "../tools/stage4/spreadsheet_adapter.mjs";
import { buildFinalExportPayload, isManualReviewReachable } from '../tools/stage4/finalize_exports_support.mjs';
import { enrichManualReviewTitles } from '../tools/stage1/manual_review_translation_step.mjs';
import { getReviewDisplayMetadata } from '../tools/lib/review_display_metadata.mjs';
import { parseRssItems } from '../tools/stage1/retrieval_step.mjs';
import { buildWritebackReadyItems } from '../tools/lib/pipeline_stage_support.mjs';

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

  it('exports held Manual translations and English fallback independently of Zotero write eligibility', async () => {
    for (const state of ['translated','cached','disabled','failed']) {
      const item={title:'Synthetic held paper',doi:'10.1234/held-export',rule_grade:'D',llm_review_grade:'B',final_grade:'D',grade:'D',semantic_stage_status:'completed',pre_llm_skip_writeback:true,source_platform:'rss',publicationTitle:'Synthetic Journal'};
      let calls=0;
      const enriched=await enrichManualReviewTitles([item],{enabled:!['cached','disabled'].includes(state),translateTitlesBatchImpl:async titles=>{
        calls++;return {map:new Map(titles.map(title=>[title,state==='failed'?{ok:false}:{ok:true,zh:'人工复核合成中文标题'}]))};
      }});
      assert.equal(calls,['translated','failed'].includes(state)?1:0);
      const writebackReady=buildWritebackReadyItems(enriched.items);
      assert.equal(writebackReady.length,0);
      const translationCache=state==='cached'?new Map([['synthetic held paper',{ok:true,zh:'人工复核合成中文标题'}]]):null;
      const payload=buildFinalExportPayload({writebackReady,allAbcItems:[],manualCandidates:enriched.items,translationCache});
      assert.equal(payload.triaged.length,1);assert.equal(isManualReviewReachable(payload.triaged[0]),true);
      assert.equal(payload.triaged[0].final_grade,'D');assert.equal(payload.triaged[0].doi,item.doi);
      const expected=['translated','cached'].includes(state)?'人工复核合成中文标题':item.title;
      const exported=await exportRows(payload.triaged);
      assert.equal(exported.dailyRows.length,0);assert.equal(exported.reviewRows.length,1);
      assert.equal(exported.reviewRows[0][1],expected);
      const display=getReviewDisplayMetadata(payload.triaged[0],{translationCache});
      assert.equal(exported.reviewRows[0][1],display.translatedTitle||display.title);
    }
  });

  it('keeps RSS venue and safe source fallback consistent across both XLSX sheets and Control Center', async () => {
    const rss=(channel,source={})=>parseRssItems(`<rss><channel><title>${channel}</title><item><title>Synthetic venue paper</title></item></channel></rss>`,'https://example.org/feed',source)[0];
    const cases=[
      [rss('AAAS: Science Advances: Table of Contents',{publicationTitle:'Science Advances'}),'Science Advances'],
      [rss('Latest Results',{name:'Canonical source label',publicationTitle:'Journal of Neuroinflammation'}),'Journal of Neuroinflammation'],
      [rss('Latest Results',{name:'Neuroscience RSS'}),'RSS'],
      [rss('Neuroscience Research Roundup',{name:'Latest Results'}),'RSS'],
      [{...rss('Latest Results'),source_title:'AAAS Feed'},'RSS'],
      [{...rss('Latest Results'),'container-title':'Synthetic Container Journal'},'Synthetic Container Journal'],
      [{source_platform:'pubmed',journal:'Synthetic PubMed Journal'},'Synthetic PubMed Journal'],
      [{source_platform:'pmc',publicationTitle:'Synthetic PMC Journal'},'Synthetic PMC Journal'],
      [{source_platform:'openalex',publicationTitle:'Synthetic OpenAlex Journal'},'Synthetic OpenAlex Journal'],
    ];
    const items=cases.flatMap(([metadata],index)=>[
      {...metadata,title:`Synthetic normal ${index}`,doi:`10.1234/venue-normal-${index}`,rule_grade:'B',llm_review_grade:'B',final_grade:'B',translatedTitle:'普通文献合成译题'},
      {...metadata,title:`Synthetic manual ${index}`,doi:`10.1234/venue-manual-${index}`,rule_grade:'D',llm_review_grade:'B',final_grade:'D',semantic_stage_status:'completed',pre_llm_skip_writeback:true,translatedTitle:'人工复核合成译题'},
    ]);
    const exported=await exportRows(items);
    assert.equal(exported.dailyRows.length,cases.length);assert.equal(exported.reviewRows.length,cases.length);
    for (const [index,[metadata,expected]] of cases.entries()) {
      const display=getReviewDisplayMetadata(items[index*2]);
      assert.equal(display.journal||display.source,expected);
      assert.equal(exported.dailyRows[index][5],expected);assert.equal(exported.reviewRows[index][2],expected);
      assert.equal(exported.dailyRows[index][1],getReviewDisplayMetadata(items[index*2]).translatedTitle);
      assert.equal(exported.reviewRows[index][1],getReviewDisplayMetadata(items[index*2+1]).translatedTitle);
      if(metadata.feed_title)assert.equal(display.rawSourceLabel,metadata.feed_title);
    }
    assert.equal(cases[2][0].publicationTitle,'');assert.equal(cases[2][0].feed_name,'Neuroscience RSS');
  });
});
