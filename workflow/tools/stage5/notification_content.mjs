import { createHash } from 'node:crypto';
function modeLabel(mode) { return ({ desktop: "Desktop", web: "Web", local: "Local" })[mode] || "PaperEcho"; }
function dateText(summary) { return String(summary.finishedAt || summary.startedAt || "").slice(0, 10); }
function warningText(value) { return String(value || "").replace(/[A-Za-z]:[\\/][^\s]+|\/(?:Users|home)\/[^\s]+/g, "[路径已隐藏]").replace(/\s+/g, " ").trim().slice(0, 120); }
function hasNumber(value) { return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)); }

// Pure projection of existing business results. Never supplies a new clock value.
function literatureContent(items = []) {
  return items.filter((item) => item && ["A", "B", "C"].includes(String(item.final_grade || item.grade || "").slice(0, 1).toUpperCase()) && item.excluded !== true).map((item) => ({
    id: String(item.itemKey || item.id || item.stable_id || item.doi || item.pmid || item.pmcid || createHash('sha256').update(JSON.stringify([item.title, item.year, item.journal])).digest('hex')),
    title: String(item.title || "未提供标题"),
    translatedTitle: String(item.translatedTitle || item.translated_title || item.title_translation || item.shortTitle || ""),
    journal: String(item.journal || item.publicationTitle || item.source || item.source_type || ""),
    year: String(item.year || ""),
    source: String(item.source_type || item.source || ''),
    grade: String(item.final_grade || item.grade).slice(0, 1).toUpperCase(),
    reason: String(item.recommendation_reason || item.semantic_reason || item.grade_reason || ""),
    url: /^https?:\/\/[^\s]+$/i.test(String(item.url || "")) ? String(item.url) : "",
    identifier: item.doi ? `DOI: ${item.doi}` : item.pmid ? `PMID: ${item.pmid}` : "",
  }));
}
export function buildRadarNotificationContent(items = [], { runId = "", audit = {} } = {}) {
  const papers = literatureContent(items);
  const summary = [];
  if (hasNumber(audit.candidateCount)) summary.push({ label: "本轮候选", value: Number(audit.candidateCount) });
  summary.push({ label: "本封推荐", value: papers.length });
  summary.push({ label: "A 级文献", value: papers.filter((item) => item.grade === "A").length });
  const content = {
    eventId: String(runId), eventType: "radar_completed", title: "今日文献速览", generatedAt: String(audit.generatedAt || ""), date: String(audit.generatedAt || "").slice(0, 10), runId: String(runId),
    subject: `PaperEcho Daily Radar：${papers.length} 篇文献`, summary, items: papers,
    businessStatus: audit.status, notificationStatus: audit.notificationStatus,
    sections: { overview: typeof audit.overview === 'string' ? audit.overview : '', warnings: (audit.warnings || []).map(warningText).filter(Boolean) },
  };
  content.summaryView = notificationSummary(content);
  return content;
}

export function buildStage5ViewModel(runSummary, { overview = "" } = {}) {
  const created = hasNumber(runSummary.counts?.created) ? Number(runSummary.counts.created) : null;
  const grades = runSummary.counts?.grades || {};
  const gradesAvailable = ["A", "B", "C", "D"].some((grade) => hasNumber(grades[grade]));
  const attention = runSummary.attention || {};
  const warnings = [];
  if (Number(attention.humanReviewCount) > 0) warnings.push(`有 ${Number(attention.humanReviewCount)} 篇文献等级需人工确认，请在 PaperEcho 工作台处理。`);
  if (Number(attention.pendingRuleCount) > 0) warnings.push(`有 ${Number(attention.pendingRuleCount)} 条筛选规则待确认，请在“待确认规则建议”中处理。`);
  warnings.push(...(runSummary.warnings || []).map(warningText).filter(Boolean));
  const date = dateText(runSummary);
  const mode = modeLabel(runSummary.pipelineMode);
  const subjectLead = created === 0 ? "本轮无新增文献" : created === null ? "文献流程完成" : `本次新增 ${created} 篇文献`;
  const integrity = runSummary.integrity || {};
  const integrityChanged = ["newlyConfirmedRetractions", "newCorrections", "newExpressionsOfConcern", "appliedRetractions", "pendingDelete", "confirmedNotApplied", "unresolvedConflicts"].some((key) => Number(integrity[key] || 0) > 0);
  return { created, grades, gradesAvailable, integrity, integrityChanged, warnings: warnings.slice(0, 3), remainingWarnings: Math.max(0, warnings.length - 3), overview: String(overview || "").trim(), mode, date, runId: runSummary.runId, subject: `[PaperEcho] ${subjectLead} · ${mode}${date ? ` · ${date}` : ""}` };
}

export function buildWeeklyNotificationContent(runSummary, options = {}) {
  const view = buildStage5ViewModel(runSummary, options);
  const integrityLines = view.integrityChanged ? [
    Number(view.integrity.newlyConfirmedRetractions) > 0 ? `新确认撤稿：${Number(view.integrity.newlyConfirmedRetractions)} 篇` : "",
    Number(view.integrity.appliedRetractions) > 0 ? `撤稿处置已应用：${Number(view.integrity.appliedRetractions)} 篇` : "",
    Number(view.integrity.pendingDelete) > 0 ? `已进入待删除但仍需继续清理：${Number(view.integrity.pendingDelete)} 篇` : "",
    Number(view.integrity.confirmedNotApplied) > 0 ? `已确认但未应用：${Number(view.integrity.confirmedNotApplied)} 篇` : "",
    Number(view.integrity.newCorrections) > 0 ? `新更正：${Number(view.integrity.newCorrections)} 篇` : "",
    Number(view.integrity.newExpressionsOfConcern) > 0 ? `新关注声明：${Number(view.integrity.newExpressionsOfConcern)} 篇` : "",
    Number(view.integrity.unresolvedConflicts) > 0 ? `未解决证据冲突：${Number(view.integrity.unresolvedConflicts)} 项` : "",
  ].filter(Boolean) : [];
  const content = {
    eventId: String(view.runId || ''), eventType: "weekly_completed", title: "文献流程已完成", generatedAt: String(runSummary.finishedAt || runSummary.startedAt || ""), date: view.date, period: { start: String(runSummary.startedAt || '').slice(0, 10), end: view.date }, runId: view.runId, subject: view.subject, mode: view.mode,
    // Highlights are the existing business order's prefix, never a new ranking.
    items: literatureContent(options.literatureItems).slice(0, 5),
    summary: { created: view.created, grades: view.grades, gradesAvailable: view.gradesAvailable },
    sections: { overview: view.overview, integrityLines, warnings: view.warnings, remainingWarnings: view.remainingWarnings },
    businessStatus: runSummary.status, notificationStatus: runSummary.notificationStatus, recoveryState: runSummary.recoveryState,
  };
  content.summaryView = notificationSummary(content);
  return content;
}
// WHAT TO SHOW stays here, including the compatibility projection for old content.
// Items remain internal replay data; no outbound renderer displays a paper list.
export function notificationSummary(content) {
  if (content.summaryView) return content.summaryView;
  if (content.eventType === 'notification_test') return { brand: 'PaperEcho · 通知测试', status: '通知测试', date: content.generatedAt || '', total: null, grades: {}, overview: '仅用于验证平台 API 是否接受消息。', alerts: [] };
  const radar = content.eventType === 'radar_completed';
  if (!radar && content.eventType !== 'weekly_completed') throw new Error('NOTIFICATION_CONTENT_EVENT_UNSUPPORTED');
  const sections = content.sections || {};
  const grades = Object.fromEntries(['A', 'B', 'C', 'D'].map(grade => [grade, radar ? (content.items || []).filter(item => item.grade === grade).length : hasNumber(content.summary?.grades?.[grade]) ? Number(content.summary.grades[grade]) : null]));
  const alerts = [...(sections.integrityLines || []), ...(sections.warnings || [])];
  if (sections.remainingWarnings) alerts.push(`另有 ${sections.remainingWarnings} 条提醒，请查看导出结果。`);
  if (['incomplete', 'unknown'].includes(content.notificationStatus)) alerts.push(content.notificationStatus === 'unknown' ? '通知结果尚不确定，请在工作台核对。' : '通知尚未完成，请在工作台核对。');
  if (content.recoveryState === 'pending') alerts.push('恢复尚未完成，请在工作台核对。');
  const status = String(content.businessStatus || 'completed');
  const statusText = /failed|error|incomplete/.test(status) ? '文献流程未完成' : /partial/.test(status) ? '文献流程部分完成' : radar ? 'Radar 检查已完成' : '文献流程已完成';
  return { brand: `PaperEcho · ${radar ? 'Daily Radar' : '周报'}`, status: statusText, date: content.date || '', totalLabel: radar ? '本轮推荐' : '本次新增',
    total: radar ? (content.items || []).length : hasNumber(content.summary?.created) ? Number(content.summary.created) : null,
    grades, overview: sections.overview || (radar ? (content.summary || []).filter(item => item.label !== 'A 级文献').map(item => `${item.label}：${item.value} 篇`).join(' · ') : ''), alerts };
}
export function buildTestNotificationContent({ generatedAt }) {
  return { eventType: 'notification_test', title: 'PaperEcho 通知测试', generatedAt, message: '通知测试成功' };
}
