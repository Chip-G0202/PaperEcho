export function boundedText(value, budget) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\p{Surrogate}/gu, '\ufffd');
  if (Buffer.byteLength(text) <= budget) return text;
  let result = '';
  for (const { segment } of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)) { if (Buffer.byteLength(result + segment + '…') > budget) break; result += segment; }
  return result + '…';
}
export function presentNotificationText(content, budget) {
  if (content.eventType === 'notification_test') return `PaperEcho 通知测试\n${boundedText(content.generatedAt, 100)}\n仅用于验证平台 API 是否接受消息。`;
  let summary;
  if (content.eventType === 'radar_completed') summary = (content.summary || []).map(item => `${item.label}：${item.value}`).join(' · ');
  else if (content.eventType === 'weekly_completed') {
    const value = content.summary || {}; const sections = content.sections || {};
    summary = [value.created == null ? '文献流程完成' : `本次新增：${value.created} 篇`, value.gradesAvailable ? ['A','B','C','D'].filter(grade => value.grades?.[grade] != null).map(grade => `${grade}：${value.grades[grade]}`).join(' / ') : '', sections.overview, ...(sections.integrityLines || []), ...(sections.warnings || []), sections.remainingWarnings ? `另有 ${sections.remainingWarnings} 项提醒` : ''].filter(Boolean).join('\n');
  } else throw new Error('NOTIFICATION_CONTENT_EVENT_UNSUPPORTED');
  let text = `PaperEcho / ${boundedText(content.title, 150)}\n日期：${boundedText(content.date, 100)}\n${boundedText(summary, Math.min(1600, Math.floor(budget / 3)))}`;
  const items = content.items || []; let included = 0;
  for (const item of items) {
    const paper = [`[${item.grade}] ${boundedText(item.title, 900)}`, item.translatedTitle && boundedText(item.translatedTitle, 900), [item.journal, item.year, item.source].filter(Boolean).map(value => boundedText(value, 160)).join(' / '), item.reason && `推荐理由：${boundedText(item.reason, 900)}`].filter(Boolean).join('\n');
    const suffix = included + 1 < items.length ? `\n另有 ${items.length - included - 1} 项未展开` : '';
    if (Buffer.byteLength(text + '\n\n' + paper + suffix) > budget) break;
    text += '\n\n' + paper; included++;
  }
  if (included < items.length) text += `\n另有 ${items.length - included} 项未展开`;
  return text;
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
