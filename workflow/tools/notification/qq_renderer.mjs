// Product budget authorized for Phase 3, not a verified provider hard limit.
// Official SDK describes ~5000 characters; UTF-8 accounting is conservative:
// https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/utils/text-chunk.ts
export const QQ_TEXT_BUDGET_BYTES = 5000;
const clean = value => String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\p{Surrogate}/gu, '\ufffd').trim();
function bounded(value, budget) {
  const text = clean(value);
  if (Buffer.byteLength(text, 'utf8') <= budget) return text;
  let result = '';
  for (const { segment } of new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)) {
    if (Buffer.byteLength(result + segment + '…', 'utf8') > budget) break;
    result += segment;
  }
  return result + '…';
}
export function renderQqNotification(content) {
  let heading; let summary; let entries = [];
  if (content.eventType === 'notification_test') {
    return { msg_type: 0, content: `PaperEcho\nQQ 通知测试\n当前环境配置已能够调用 QQ 通知通道。\n时间：${bounded(content.generatedAt, 100)}` };
  }
  if (content.eventType === 'radar_completed') {
    heading = 'PaperEcho / Daily Radar';
    summary = (content.summary || []).map(item => `${bounded(item.label, 100)}：${bounded(item.value, 40)}`).join(' · ');
    entries = (content.items || []).map((item, index) => ({ item, index })).sort((a, b) => 'ABC'.indexOf(a.item.grade) - 'ABC'.indexOf(b.item.grade) || a.index - b.index).map(({ item }) => [
      `[${item.grade}] ${bounded(item.title, 650)}`,
      item.translatedTitle ? bounded(item.translatedTitle, 500) : '',
      [item.journal && bounded(item.journal, 160), item.year && bounded(item.year, 30)].filter(Boolean).join(' / '),
      item.reason ? `推荐理由：${bounded(item.reason, 250)}` : '',
    ].filter(Boolean).join('\n'));
  } else if (content.eventType === 'weekly_completed') {
    heading = 'PaperEcho / 周报';
    const value = content.summary || {};
    summary = value.created == null ? '文献流程完成' : `本次新增：${value.created} 篇`;
    if (value.gradesAvailable) summary += ' · ' + ['A', 'B', 'C', 'D'].filter(grade => value.grades?.[grade] != null).map(grade => `${grade}：${value.grades[grade]}`).join(' / ');
    const sections = content.sections || {};
    entries = [sections.overview ? `重点结果：${bounded(sections.overview, 1800)}` : '', ...(sections.integrityLines || []), ...(sections.warnings || [])].filter(Boolean).map(value => bounded(value, 1800));
    if (sections.remainingWarnings > 0) entries.push(`另有 ${sections.remainingWarnings} 项提醒，请在 PaperEcho 工作台查看。`);
  } else throw new Error('NOTIFICATION_CONTENT_EVENT_UNSUPPORTED');
  let text = `${heading}\n日期：${bounded(content.date || content.generatedAt || '未提供', 100)}\n${bounded(summary, 800)}`;
  let included = 0;
  for (const entry of entries) {
    const remaining = entries.length - included - 1;
    const suffix = remaining ? `\n还有 ${remaining} 项，请在 PaperEcho 工作台查看。` : '';
    if (Buffer.byteLength(text + '\n\n' + entry + suffix, 'utf8') > QQ_TEXT_BUDGET_BYTES) break;
    text += '\n\n' + entry;
    included++;
  }
  if (included < entries.length) text += `\n还有 ${entries.length - included} 项，请在 PaperEcho 工作台查看。`;
  return { msg_type: 0, content: text };
}
