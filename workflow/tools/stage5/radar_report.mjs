import { escapeHtml, renderEmailLayout } from './email_layout.mjs';
import { notificationSummary } from './notification_content.mjs';

export function formatRadarReport(content) {
  const view = notificationSummary(content);
  const grades = ['A', 'B', 'C', 'D'];
  const gradesAvailable = grades.some(grade => view.grades[grade] !== null);
  const body = '<tr><td style="padding:18px 28px 8px;"><div style="font-size:28px;font-weight:700;">' + view.totalLabel + ' ' + escapeHtml(view.total) + ' 篇</div></td></tr>'
    + (gradesAvailable ? '<tr><td style="padding:10px 28px;"><div style="font-size:16px;font-weight:700;margin-bottom:8px;">' + escapeHtml(view.gradesLabel || '分级情况') + '</div><table role="presentation" width="100%" cellspacing="0" cellpadding="8"><tr>' + grades.map(grade => '<td align="center" style="border:1px solid #dfe4ea;"><strong>' + grade + '</strong><br>' + escapeHtml(view.grades[grade] ?? '—') + ' 篇</td>').join('') + '</tr></table></td></tr>' : '')
    + (view.overview ? '<tr><td style="padding:14px 28px;"><div style="font-size:16px;font-weight:700;margin-bottom:8px;">本轮文献概况</div><div style="font-size:14px;line-height:1.75;">' + escapeHtml(view.overview) + '</div></td></tr>' : '')
    + (view.alerts.length ? '<tr><td style="padding:14px 28px;background:#fff8e6;"><div style="font-size:16px;font-weight:700;margin-bottom:8px;">提醒</div>' + view.alerts.map(alert => '<div style="font-size:14px;line-height:1.7;">• ' + escapeHtml(alert) + '</div>').join('') + '</td></tr>' : '');
  const html = renderEmailLayout({ brand: view.brand, title: content.title, subtitle: view.status + ' · ' + view.date, body, footer: (content.runId ? 'Run ID: ' + escapeHtml(content.runId) + '<br>' : '') + '由 PaperEcho 自动生成', responsive: true });
  const lines = [view.brand, content.title, view.status, view.date, '', view.totalLabel + ' ' + view.total + ' 篇', ...(gradesAvailable ? [(view.gradesLabel || '分级') + '：' + grades.map(grade => grade + ' ' + (view.grades[grade] ?? '—')).join(' / ')] : []), ...(view.overview ? ['', '本轮文献概况：', view.overview] : []), ...(view.alerts.length ? ['', '提醒：', ...view.alerts] : []), '', ...(content.runId ? ['Run ID：' + content.runId] : []), '由 PaperEcho 自动生成'];
  return { subject: content.subject, html, text: lines.join('\n'), attachments: [] };
}
