// Fixed public metadata only. No titles, prompts, credentials, paths or provider errors.
export const RUN_PHASES = Object.freeze([
  ['feedback_learning','反馈学习'], ['retrieval','检索'], ['dedupe','去重'],
  ['rule_based_triage','规则初评'], ['journal_quality_gate','期刊过滤'],
  ['pre_llm_zotero_existing_dedupe','库内去重'], ['llm_grade_review','AI 复审'],
  ['manual_title_translation','条件补译'], ['rule_suggestions','规则建议'],
  ['feedback_item_actions','反馈处理'], ['literature_integrity','完整性检测'],
  ['stage2_writeback','写回 Zotero'], ['stage3_translation','标题补翻'], ['stage4_exports','导出'],
]);
export const PROGRESS_IDS = new Set([...RUN_PHASES.map(([id])=>id), 'stage1', 'zotero_backend_ready']);
const began = new Map();
export function emitRunProgress(id, status, detail = {}) {
  if (process.env.PAPERECHO_CONTROL_RUN !== '1' || !process.send || !PROGRESS_IDS.has(id)) return;
  if (status === 'running') began.set(id, Date.now());
  const milliseconds = Number.isFinite(detail.ms) ? detail.ms : began.has(id) ? Date.now()-began.get(id) : null;
  const message = { type: 'paperecho-run-progress', id, status,
    ...(milliseconds !== null ? { milliseconds: Math.max(0, milliseconds) } : {}) };
  try { process.send(message, () => {}); } catch { /* Losing the UI channel cannot change business outcome. */ }
}
export function finishRunPhase(id, result = {}, milliseconds) {
  const skipped = result.skipped || result.skipped_reason || String(result.status || '').startsWith('skipped') || result.enabled === false || result.status === 'disabled';
  emitRunProgress(id, skipped ? 'skipped' : result.ok === false || result.status === 'failed' || result.status === 'error' || result.status === 'degraded' ? 'failed' : 'completed', {ms:milliseconds});
}
