import { summaryBlocks } from './text_presentation.mjs';
import { escapeHtml } from '../stage5/email_layout.mjs';
function escapeMarkdown(value) { return escapeHtml(value).replace(/[\\`*_{}[\]()+#!|.\-]/g, '\\$&'); }
// Official classic Markdown; retain PaperEcho's conservative 1800-byte budget.
export function renderWecomNotification(content) {
  let budget = 1400, text;
  do {
    text = summaryBlocks(content, budget).map((block, index) => index === 0 ? '# ' + escapeMarkdown(block.value) : block.label ? '**' + block.label + '**\n' + escapeMarkdown(block.value) : '**' + escapeMarkdown(block.value) + '**').join('\n\n');
    budget = Math.floor(budget / 2);
  } while (Buffer.byteLength(text) > 1800);
  return { msgtype: 'markdown', markdown: { content: text } };
}
