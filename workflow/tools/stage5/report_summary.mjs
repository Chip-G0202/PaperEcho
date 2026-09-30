import { escapeHtml, renderEmailLayout } from "./email_layout.mjs";
import { buildStage5ViewModel, buildWeeklyNotificationContent } from "./notification_content.mjs";
import { literatureCards, literatureText } from './radar_report.mjs';
export { escapeHtml, buildStage5ViewModel };
function hasNumber(value) { return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)); }

export function formatStage5Report(runSummary, options = {}) {
  return renderWeeklyReport(buildWeeklyNotificationContent(runSummary, options));
}

export function renderWeeklyReport(content) {
  const view = { ...content.summary, ...content.sections, mode: content.mode, runId: content.runId, subject: content.subject };
  const createdHtml = view.created === null ? "" : `<tr><td style="padding:18px 28px 8px;"><div style="font-size:28px;font-weight:700;">${view.created === 0 ? "本次没有新增文献" : `本次新增 ${escapeHtml(view.created)} 篇文献`}</div></td></tr>`;
  const gradesHtml = !view.gradesAvailable ? "" : `<tr><td style="padding:10px 28px;"><div style="font-size:16px;font-weight:700;margin-bottom:8px;">分级情况</div><table role="presentation" width="100%" cellspacing="0" cellpadding="8"><tr>${["A", "B", "C", "D"].map((grade) => `<td align="center" style="border:1px solid #dfe4ea;"><strong>${grade}</strong><br>${hasNumber(view.grades[grade]) ? escapeHtml(view.grades[grade]) : "—"} 篇</td>`).join("")}</tr></table></td></tr>`;
  const overviewHtml = view.overview ? `<tr><td style="padding:14px 28px;"><div style="font-size:16px;font-weight:700;margin-bottom:8px;">本轮文献概况</div><div style="font-size:14px;line-height:1.75;">${escapeHtml(view.overview)}</div></td></tr>` : "";
  const { integrityLines } = content.sections;
  const integrityHtml = integrityLines.length ? `<tr><td style="padding:14px 28px;background:#f4f7fb;"><div style="font-size:16px;font-weight:700;margin-bottom:8px;">本周文献完整性变化</div>${integrityLines.map((item) => `<div style="font-size:14px;line-height:1.7;">• ${escapeHtml(item)}</div>`).join("")}</td></tr>` : "";
  const warningsHtml = !view.warnings.length ? "" : `<tr><td style="padding:14px 28px;background:#fff8e6;"><div style="font-size:16px;font-weight:700;margin-bottom:8px;">提醒</div>${view.warnings.map((item) => `<div style="font-size:14px;line-height:1.7;">• ${escapeHtml(item)}</div>`).join("")}${view.remainingWarnings ? `<div style="font-size:13px;margin-top:6px;">另有 ${view.remainingWarnings} 条提醒，请查看导出结果。</div>` : ""}</td></tr>`;
  const html = renderEmailLayout({ title: content.title, subtitle: `运行成功 · ${view.mode}`, body: `${createdHtml}${gradesHtml}${overviewHtml}${integrityHtml}${warningsHtml}${literatureCards(content.items)}`, footer: `${escapeHtml(view.mode)}<br>Run ID: ${escapeHtml(view.runId)}<br>由 PaperEcho 自动生成` });
  const lines = ["PaperEcho 文献流程已完成", `运行成功 · ${view.mode}`];
  if (view.created !== null) lines.push("", view.created === 0 ? "本次没有新增文献" : `本次新增：${view.created} 篇`);
  if (view.gradesAvailable) lines.push("", "分级：", `A ${view.grades.A ?? "—"} / B ${view.grades.B ?? "—"} / C ${view.grades.C ?? "—"} / D ${view.grades.D ?? "—"}`);
  if (view.overview) lines.push("", "本轮文献概况：", view.overview);
  if (integrityLines.length) lines.push("", "本周文献完整性变化：", ...integrityLines.map((item) => `- ${item}`));
  if (view.warnings.length) lines.push("", "提醒：", ...view.warnings.map((item) => `- ${item}`), ...(view.remainingWarnings ? [`另有 ${view.remainingWarnings} 条提醒，请查看导出结果。`] : []));
  lines.push(...literatureText(content.items), "", `Run ID：${view.runId}`, "由 PaperEcho 自动生成");
  return { subject: view.subject, html, text: lines.join("\n") };
}
