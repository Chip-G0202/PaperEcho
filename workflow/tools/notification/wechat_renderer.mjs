import { boundedText, presentNotificationText, splitUtf8Paragraphs } from './text_presentation.mjs';
// Official raw limits: 40000 characters AND 65535 UTF-8 bytes, plus converted HTML.
// https://github.com/wxpusher/wxpusher-docs#发送消息-idsend-msg
// Product: <=8000 bytes/part, <=24000 bytes/event. Text avoids Markdown expansion.
export const WECHAT_PART_BYTES = 8000;
export function renderWechatNotification(content) {
  return { messages: splitUtf8Paragraphs(presentNotificationText(content, 24000), WECHAT_PART_BYTES).map(text => ({ contentType: 1, content: text, summary: Array.from(boundedText(content.title || 'PaperEcho 通知测试', 200)).slice(0, 100).join('') })) };
}
