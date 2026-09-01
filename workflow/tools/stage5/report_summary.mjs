export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function modeLabel(mode) { return ({ desktop: "Desktop", web: "Web", local: "Local" })[mode] || "PaperEcho"; }
function dateText(summary) { return String(summary.finishedAt || summary.startedAt || "").slice(0, 10); }
function warningText(value) { return String(value || "").replace(/[A-Za-z]:[\\/][^\s]+|\/(?:Users|home)\/[^\s]+/g, "[路径已隐藏]").replace(/\s+/g, " ").trim().slice(0, 120); }
function hasNumber(value) { return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)); }

export function buildStage5ViewModel(runSummary, { overview = "" } = {}) {
  const created = hasNumber(runSummary.counts?.created) ? Number(runSummary.counts.created) : null;
  const grades = runSummary.counts?.grades || {};
  const gradesAvailable = ["A", "B", "C", "D"].some((grade) => hasNumber(grades[grade]));
  const attention = runSummary.attention || {};
  const warnings = [];
  if (Number(attention.humanReviewCount) > 0) warnings.push(`有 ${Number(attention.humanReviewCount)} 篇文献等级需人工确认，请在周报表格的“需人工复核”中处理。`);
  if (Number(attention.pendingRuleCount) > 0) warnings.push(`有 ${Number(attention.pendingRuleCount)} 条筛选规则待确认，请在“待确认规则建议”中处理。`);
  warnings.push(...(runSummary.warnings || []).map(warningText).filter(Boolean));
  const date = dateText(runSummary);
  const mode = modeLabel(runSummary.pipelineMode);
  const subjectLead = created === 0 ? "本轮无新增文献" : created === null ? "文献流程完成" : `本次新增 ${created} 篇文献`;
  const integrity = runSummary.integrity || {};
  const integrityChanged = ["newlyConfirmedRetractions", "newCorrections", "newExpressionsOfConcern", "appliedRetractions", "pendingDelete", "confirmedNotApplied", "unresolvedConflicts"].some((key) => Number(integrity[key] || 0) > 0);
  return { created, grades, gradesAvailable, integrity, integrityChanged, warnings: warnings.slice(0, 3), remainingWarnings: Math.max(0, warnings.length - 3), overview: String(overview || "").trim(), mode, date, runId: runSummary.runId, subject: `[PaperEcho] ${subjectLead} · ${mode}${date ? ` · ${date}` : ""}` };
}

export function formatStage5Report(runSummary, options = {}) {
  const view = buildStage5ViewModel(runSummary, options);
  const createdHtml = view.created === null ? "" : `<tr><td style="padding:18px 28px 8px;"><div style="font-size:28px;font-weight:700;">${view.created === 0 ? "本次没有新增文献" : `本次新增 ${escapeHtml(view.created)} 篇文献`}</div></td></tr>`;
  const gradesHtml = !view.gradesAvailable ? "" : `<tr><td style="padding:10px 28px;"><div style="font-size:16px;font-weight:700;margin-bottom:8px;">分级情况</div><table role="presentation" width="100%" cellspacing="0" cellpadding="8"><tr>${["A", "B", "C", "D"].map((grade) => `<td align="center" style="border:1px solid #dfe4ea;"><strong>${grade}</strong><br>${hasNumber(view.grades[grade]) ? escapeHtml(view.grades[grade]) : "—"} 篇</td>`).join("")}</tr></table></td></tr>`;
  const overviewHtml = view.overview ? `<tr><td style="padding:14px 28px;"><div style="font-size:16px;font-weight:700;margin-bottom:8px;">本轮文献概况</div><div style="font-size:14px;line-height:1.75;">${escapeHtml(view.overview)}</div></td></tr>` : "";
  const integrityLines = view.integrityChanged ? [
    Number(view.integrity.newlyConfirmedRetractions) > 0 ? `新确认撤稿：${Number(view.integrity.newlyConfirmedRetractions)} 篇` : "",
    Number(view.integrity.appliedRetractions) > 0 ? `撤稿处置已应用：${Number(view.integrity.appliedRetractions)} 篇` : "",
    Number(view.integrity.pendingDelete) > 0 ? `已进入待删除但仍需继续清理：${Number(view.integrity.pendingDelete)} 篇` : "",
    Number(view.integrity.confirmedNotApplied) > 0 ? `已确认但未应用：${Number(view.integrity.confirmedNotApplied)} 篇` : "",
    Number(view.integrity.newCorrections) > 0 ? `新更正：${Number(view.integrity.newCorrections)} 篇` : "",
    Number(view.integrity.newExpressionsOfConcern) > 0 ? `新关注声明：${Number(view.integrity.newExpressionsOfConcern)} 篇` : "",
    Number(view.integrity.unresolvedConflicts) > 0 ? `未解决证据冲突：${Number(view.integrity.unresolvedConflicts)} 项` : "",
  ].filter(Boolean) : [];
  const integrityHtml = integrityLines.length ? `<tr><td style="padding:14px 28px;background:#f4f7fb;"><div style="font-size:16px;font-weight:700;margin-bottom:8px;">本周文献完整性变化</div>${integrityLines.map((item) => `<div style="font-size:14px;line-height:1.7;">• ${escapeHtml(item)}</div>`).join("")}</td></tr>` : "";
  const warningsHtml = !view.warnings.length ? "" : `<tr><td style="padding:14px 28px;background:#fff8e6;"><div style="font-size:16px;font-weight:700;margin-bottom:8px;">提醒</div>${view.warnings.map((item) => `<div style="font-size:14px;line-height:1.7;">• ${escapeHtml(item)}</div>`).join("")}${view.remainingWarnings ? `<div style="font-size:13px;margin-top:6px;">另有 ${view.remainingWarnings} 条提醒，请查看导出结果。</div>` : ""}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f7fa;color:#172033;font-family:Arial,'Microsoft YaHei',sans-serif;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:24px 12px;"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#fff;border:1px solid #dfe4ea;"><tr><td style="padding:26px 28px 12px;"><div style="font-size:12px;color:#52606d;">PaperEcho</div><h1 style="font-size:23px;margin:7px 0;">文献流程已完成</h1><div style="font-size:14px;">运行成功 · ${escapeHtml(view.mode)}</div></td></tr>${createdHtml}${gradesHtml}${overviewHtml}${integrityHtml}${warningsHtml}<tr><td style="padding:18px 28px;font-size:12px;color:#697386;">${escapeHtml(view.mode)}<br>Run ID: ${escapeHtml(view.runId)}<br>由 PaperEcho 自动生成</td></tr></table></td></tr></table></body></html>`;
  const lines = ["PaperEcho 文献流程已完成", `运行成功 · ${view.mode}`];
  if (view.created !== null) lines.push("", view.created === 0 ? "本次没有新增文献" : `本次新增：${view.created} 篇`);
  if (view.gradesAvailable) lines.push("", "分级：", `A ${view.grades.A ?? "—"} / B ${view.grades.B ?? "—"} / C ${view.grades.C ?? "—"} / D ${view.grades.D ?? "—"}`);
  if (view.overview) lines.push("", "本轮文献概况：", view.overview);
  if (integrityLines.length) lines.push("", "本周文献完整性变化：", ...integrityLines.map((item) => `- ${item}`));
  if (view.warnings.length) lines.push("", "提醒：", ...view.warnings.map((item) => `- ${item}`), ...(view.remainingWarnings ? [`另有 ${view.remainingWarnings} 条提醒，请查看导出结果。`] : []));
  lines.push("", `Run ID：${view.runId}`, "由 PaperEcho 自动生成");
  return { subject: view.subject, html, text: lines.join("\n") };
}
