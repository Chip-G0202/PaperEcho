import { renderEmailLayout, escapeHtml } from './email_layout.mjs';

export function renderTestNotification(content) {
  const text = [content.title, content.message, content.generatedAt].join('\n');
  const body = `<tr><td style="padding:24px 28px;"><p>${escapeHtml(content.message)}</p><p>${escapeHtml(content.generatedAt)}</p></td></tr>`;
  return { subject: content.title, text, html: renderEmailLayout({ title: content.title, subtitle: '邮箱通知检查', body, footer: '由 PaperEcho 自动生成', responsive: true }) };
}
