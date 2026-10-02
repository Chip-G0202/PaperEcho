import { summaryBlocks } from './text_presentation.mjs';
// Native post title and paragraph rows; no unverified Markdown/style fields.
// Product budgets: 6000 text bytes, 16 KiB request including signing.
export function renderFeishuNotification(content) {
  const blocks = summaryBlocks(content, 6000);
  return { msg_type: 'post', content: { post: { zh_cn: {
    title: blocks[0].value,
    content: blocks.slice(1).flatMap(block => [...(block.label ? [[{ tag: 'text', text: '【' + block.label + '】' }]] : []), [{ tag: 'text', text: block.value }]]),
  } } } };
}
