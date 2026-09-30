function modeLabel(mode) { return ({ desktop: "Desktop", web: "Web", local: "Local" })[mode] || "PaperEcho"; }
function dateText(summary) { return String(summary.finishedAt || summary.startedAt || "").slice(0, 10); }
function warningText(value) { return String(value || "").replace(/[A-Za-z]:[\\/][^\s]+|\/(?:Users|home)\/[^\s]+/g, "[路径已隐藏]").replace(/\s+/g, " ").trim().slice(0, 120); }
function hasNumber(value) { return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)); }

// Pure projection of existing business results. Never supplies a new clock value.
export function buildRadarNotificationContent(items = [], { runId = "", audit = {} } = {}) {
  const papers = items.filter((item) => item && ["A", "B", "C"].includes(String(item.final_grade || item.grade || "").slice(0, 1).toUpperCase())).map((item) => ({
    title: String(item.title || "未提供标题"),
    translatedTitle: String(item.translatedTitle || item.translated_title || item.title_translation || item.shortTitle || ""),
    journal: String(item.journal || item.publicationTitle || item.source || item.source_type || ""),
    year: String(item.year || ""),
    grade: String(item.final_grade || item.grade).slice(0, 1).toUpperCase(),
    reason: String(item.semantic_reason || item.grade_reason || ""),
    url: /^https?:\/\/[^\s]+$/i.test(String(item.url || "")) ? String(item.url) : "",
    identifier: item.doi ? `DOI: ${item.doi}` : item.pmid ? `PMID: ${item.pmid}` : "",
  }));
  const summary = [];
  if (hasNumber(audit.candidateCount)) summary.push({ label: "本轮候选", value: Number(audit.candidateCount) });
  summary.push({ label: "本封推荐", value: papers.length });
  summary.push({ label: "A 级文献", value: papers.filter((item) => item.grade === "A").length });
  return {
    eventType: "radar_completed", title: "今日文献速览", generatedAt: String(audit.generatedAt || ""), date: String(audit.generatedAt || "").slice(0, 10), runId: String(runId),
    subject: `PaperEcho Daily Radar：${papers.length} 篇文献`, summary, items: papers,
  };
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
  return {
    eventType: "weekly_completed", title: "文献流程已完成", generatedAt: String(runSummary.finishedAt || runSummary.startedAt || ""), date: view.date, runId: view.runId, subject: view.subject, mode: view.mode,
    summary: { created: view.created, grades: view.grades, gradesAvailable: view.gradesAvailable },
    sections: { overview: view.overview, integrityLines, warnings: view.warnings, remainingWarnings: view.remainingWarnings },
  };
}
export function buildTestNotificationContent({ generatedAt }) {
  return { eventType: 'notification_test', title: 'PaperEcho 通知测试', generatedAt, message: '通知测试成功' };
}
