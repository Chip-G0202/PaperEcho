import { boundedText, presentNotificationText } from './text_presentation.mjs';
// Product budgets: 6000 UTF-8 text bytes, 16 KiB serialized request including signing.
export function renderFeishuNotification(content) {
  return { msg_type: 'post', content: { post: { zh_cn: {
    title: boundedText(content.title || 'PaperEcho 通知测试', 150),
    content: [[{ tag: 'text', text: presentNotificationText(content, 6000) }]],
  } } } };
}
