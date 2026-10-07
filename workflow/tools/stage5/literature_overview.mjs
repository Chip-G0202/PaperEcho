import fs from "node:fs/promises";
import path from "node:path";

import { callJsonLlm, hashInput, resolveLlmRuntime } from "../lib/llm_json_support.mjs";
import { readReceipt, writeReceipt } from "./email_receipt.mjs";

export const OVERVIEW_INPUT_MAX_CHARS = 60000;
const OVERVIEW_SCHEMA_VERSION = 2;
const OVERVIEW_PROMPT_VERSION = "title-overview-v3";
const OVERVIEW_MAX_CHARS = 220;
const TITLE_MAX_CHARS = 500;
const GRADE_PRIORITY = { A: 0, B: 1, C: 2 };

function clean(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function selectOverviewLiterature(items = []) {
  const byTitle = new Map();
  items.forEach((item, index) => {
    const title = clean(item?.title, TITLE_MAX_CHARS);
    const grade = clean(item?.grade || item?.final_grade, 1).toUpperCase();
    if (!title || !(grade in GRADE_PRIORITY)) return;
    const existing = byTitle.get(title);
    if (!existing) byTitle.set(title, { title, grade, index });
    else if (GRADE_PRIORITY[grade] < GRADE_PRIORITY[existing.grade]) existing.grade = grade;
  });
  const itemsSelected = [...byTitle.values()]
    .sort((a, b) => GRADE_PRIORITY[a.grade] - GRADE_PRIORITY[b.grade] || a.index - b.index)
    .map(({ title, grade }) => ({ grade, title }));
  const gradeCounts = { A: 0, B: 0, C: 0 };
  for (const item of itemsSelected) gradeCounts[item.grade] += 1;
  return { items: itemsSelected, sourceCount: itemsSelected.length, gradeCounts };
}

function inputChars(items) {
  return JSON.stringify({ items }).length;
}

export function batchOverviewLiterature(items, maxChars = OVERVIEW_INPUT_MAX_CHARS) {
  const batches = [];
  let batch = [];
  for (const item of items) {
    if (batch.length && inputChars([...batch, item]) > maxChars) {
      batches.push(batch);
      batch = [];
    }
    batch.push(item);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function fallbackTitles(items) {
  const chosen = [];
  for (const grade of ["A", "B", "C"]) {
    for (const item of items.filter((entry) => entry.grade === grade).slice(0, 2)) {
      if (chosen.length < 5) chosen.push(`《${clean(item.title, 60)}》`);
    }
  }
  return chosen;
}

export function deterministicOverview(items = [], created = null) {
  if (created === 0) return "本轮没有新增文献。";
  const titles = fallbackTitles(items);
  if (titles.length) return `根据本轮 A、B、C 级文献标题，研究内容主要涉及${titles.join("、")}等主题，详细结果请查看附件。`;
  return "本轮新增文献中暂无可用于总体概括的 A、B 或 C 级标题，详细结果请查看附件。";
}

function promptFor(kind) {
  if (kind === "merge") return "仅依据 input.summaries 合并为 JSON {\"overview\":\"...\"}。输出中文 2-3 句总体概况，目标不超过180个中文字符；总结主要研究主题、对象、暴露因素、方法或趋势，不逐篇罗列，不添加输入外信息。";
  if (kind === "batch") return "仅依据 input.items 中的文献等级与标题，以 JSON {\"overview\":\"...\"} 输出一份非常短的中文主题摘要。不得逐篇罗列，不得声称阅读过摘要或全文，不得编造标题中没有的信息。";
  return "仅依据 input.items 中的全部 A、B、C 级文献标题，以 JSON {\"overview\":\"...\"} 输出中文 2-3 句总体概况，目标不超过180个中文字符。总结主要研究主题、研究对象、暴露因素、方法或趋势；不逐篇罗列，不声称阅读过摘要或全文，不添加标题中没有的信息，不夸大等级数量或价值，不总结 D 级内容。信息有限时使用‘根据本轮文献标题，研究主要集中在……’。";
}

async function callOverview({ kind, input, llmRuntime, llmClient }) {
  const prompt = `${promptFor(kind)}\n\ninput:\n${JSON.stringify(input)}`;
  const result = await callJsonLlm({ taskType: "literature_overview", prompt, input, runtime: llmRuntime, cacheEnabled: false, llmClient });
  const overview = clean(result?.output?.overview, OVERVIEW_MAX_CHARS);
  return { result, overview: result?.ok && overview ? overview : "" };
}

export function overviewArtifactPath(outputRoot) {
  return path.join(path.resolve(outputRoot), "stage5", "literature_overview.json");
}

export async function generateLiteratureOverview({ runSummary, literatureItems = [], llmClient = null, runtime = null, fsApi = fs, maxInputChars = OVERVIEW_INPUT_MAX_CHARS, stateRoot = "", legacyStateRoot = "" } = {}) {
  const selected = selectOverviewLiterature(literatureItems);
  const inputHash = hashInput({ schemaVersion: OVERVIEW_SCHEMA_VERSION, promptVersion: OVERVIEW_PROMPT_VERSION, items: selected.items });
  const artifactPath = overviewArtifactPath(stateRoot || runSummary.outputRoot);
  const cached = await readReceipt(artifactPath, { fsApi })
    || (legacyStateRoot && path.resolve(legacyStateRoot) !== path.resolve(stateRoot || runSummary.outputRoot)
      ? await readReceipt(overviewArtifactPath(legacyStateRoot), { fsApi })
      : null);
  if (cached?.schemaVersion === OVERVIEW_SCHEMA_VERSION && cached?.inputHash === inputHash && cached?.overview) return { ...cached, cacheHit: true, artifactPath };

  const batches = selected.items.length ? batchOverviewLiterature(selected.items, maxInputChars) : [];
  let overview = deterministicOverview(selected.items, runSummary.counts?.created);
  let status = "fallback";
  let fallbackReason = selected.items.length ? "llm_unavailable" : "no_abc_titles";
  let model = "";
  if (selected.items.length && runSummary.counts?.created !== 0) {
    const llmRuntime = { ...(runtime || resolveLlmRuntime()), max_retries: 0, temperature: 0, stream: false };
    let finalCall;
    if (batches.length === 1) {
      finalCall = await callOverview({ kind: "single", input: { items: batches[0] }, llmRuntime, llmClient });
    } else {
      const summaries = [];
      let failedResult = null;
      for (const batch of batches) {
        const called = await callOverview({ kind: "batch", input: { items: batch }, llmRuntime, llmClient });
        if (!called.overview) { failedResult = called.result; break; }
        summaries.push(called.overview);
      }
      finalCall = failedResult ? { result: failedResult, overview: "" } : await callOverview({ kind: "merge", input: { summaries }, llmRuntime, llmClient });
    }
    if (finalCall.overview) {
      overview = finalCall.overview;
      status = "generated";
      fallbackReason = "";
      model = String(finalCall.result.model || llmRuntime.model || "").slice(0, 120);
    } else {
      fallbackReason = String(finalCall.result?.blocker || finalCall.result?.error_type || "invalid_llm_overview").slice(0, 120);
    }
  }
  const artifact = { schemaVersion: OVERVIEW_SCHEMA_VERSION, runId: runSummary.runId, inputHash, status, overview, generatedAt: new Date().toISOString(), sourceCount: selected.sourceCount, gradeCounts: selected.gradeCounts, batchCount: batches.length, model, fallbackReason };
  try { await writeReceipt(artifactPath, artifact, { fsApi }); } catch {}
  return { ...artifact, cacheHit: false, artifactPath };
}
