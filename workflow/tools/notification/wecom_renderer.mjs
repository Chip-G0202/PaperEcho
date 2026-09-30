import { presentNotificationText } from './text_presentation.mjs';
// Official text limit 2048 UTF-8 bytes; PaperEcho leaves a conservative margin.
export function renderWecomNotification(content) {
  return { msgtype: 'text', text: { content: presentNotificationText(content, 1800) } };
}
