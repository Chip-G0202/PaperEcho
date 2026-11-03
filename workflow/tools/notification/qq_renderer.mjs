import { presentNotificationText, summaryBlocks } from './text_presentation.mjs';
import { escapeHtml } from '../stage5/email_layout.mjs';
// PaperEcho product budget, not a verified QQ provider hard limit.
export const QQ_TEXT_BUDGET_BYTES = 5000;
export function renderQqNotification(content) {
  // Native single/group Markdown needs no template. Count bytes after escaping.
  for (let budget = 4000; budget >= 125; budget = Math.floor(budget / 2)) {
    const text = summaryBlocks(content, budget).map((block, index) => {
      const value = escapeHtml(block.value).replace(/[\\`*_{}[\]()+#!|.\-~]/g, '\\$&');
      return index === 0 ? '# ' + value : block.label ? '**' + block.label + '**\n' + value : '**' + value + '**';
    }).join('\n\n');
    if (Buffer.byteLength(text, 'utf8') <= QQ_TEXT_BUDGET_BYTES) return { msg_type: 2, markdown: { content: text } };
  }
  return renderLegacyQqNotification(content);
}

// Exact historical summary for receipt-verified recovery and safe fallback.
export function renderLegacyQqNotification(content) {
  return { msg_type: 0, content: presentNotificationText(content, QQ_TEXT_BUDGET_BYTES) };
}
