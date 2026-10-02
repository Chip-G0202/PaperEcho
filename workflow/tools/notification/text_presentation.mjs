import { notificationSummary } from '../stage5/notification_content.mjs';

export function boundedText(value, budget) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\p{Surrogate}/gu, '\ufffd').trim();
  if (Buffer.byteLength(text) <= budget) return text;
  let result = '';
  for (const { segment } of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)) { if (Buffer.byteLength(result + segment + '…') > budget) break; result += segment; }
  return result + '…';
}
export function summaryBlocks(content, budget) {
  const view = notificationSummary(content);
  const blocks = [{ value: view.brand }, { value: view.status }, { label: '日期', value: boundedText(view.date || '未提供', 100) }];
  if (view.total !== null) blocks.push({ label: view.totalLabel, value: `${view.total} 篇` });
  if (Object.values(view.grades).some(value => value !== null)) blocks.push({ label: '分级', value: ['A', 'B', 'C', 'D'].map(grade => `${grade} ${view.grades[grade] ?? '—'}`).join(' ｜ ') });
  // Reserve space for actual alerts before shortening the overview.
  const alerts = boundedText(view.alerts.join('\n'), Math.floor(budget / 2));
  const used = Buffer.byteLength(blocks.map(block => `${block.label || ''}\n${block.value}`).join('\n\n') + alerts) + 100;
  if (view.overview) blocks.push({ label: '本轮概况', value: boundedText(view.overview, Math.max(40, budget - used)) });
  if (alerts) blocks.push({ label: '提醒', value: alerts });
  return blocks;
}
export function presentNotificationText(content, budget) {
  return summaryBlocks(content, budget).map(block => block.label ? `【${block.label}】\n${block.value}` : block.value).join('\n\n');
}
export function splitUtf8Paragraphs(text, budget) {
  const chunks = []; let current = '';
  for (const paragraph of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    if (Buffer.byteLength(current + paragraph) <= budget) { current += paragraph; continue; }
    if (current) { chunks.push(current); current = ''; }
    for (const { segment } of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(paragraph)) {
      if (Buffer.byteLength(segment) > budget) throw new Error('NOTIFICATION_GRAPHEME_TOO_LARGE');
      if (Buffer.byteLength(current + segment) > budget) { chunks.push(current); current = ''; }
      current += segment;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
