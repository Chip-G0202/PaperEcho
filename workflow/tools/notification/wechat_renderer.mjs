import { boundedText, summaryBlocks } from './text_presentation.mjs';
import { escapeHtml } from '../stage5/email_layout.mjs';
// Official HTML body contract: https://github.com/wxpusher/wxpusher-docs
// Product budgets remain 8000 bytes/part and 24000 bytes/event.
export const WECHAT_PART_BYTES = 8000;
export function renderWechatNotification(content) {
  let budget = 6000; let html;
  do {
    html = summaryBlocks(content, budget).map((block, index) => index === 0 ? '<h2>' + escapeHtml(block.value) + '</h2>' : index === 1 ? '<p><strong>' + escapeHtml(block.value) + '</strong></p>' : '<p>' + (block.label ? '<strong>' + escapeHtml(block.label) + '</strong><br>' : '') + escapeHtml(block.value).replaceAll('\n', '<br>') + '</p>').join('');
    budget = Math.floor(budget / 2);
  } while (Buffer.byteLength(html) > WECHAT_PART_BYTES);
  return { messages: [{ contentType: 2, content: html, summary: Array.from(boundedText(content.title || 'PaperEcho 通知测试', 200)).slice(0, 100).join('') }] };
}
