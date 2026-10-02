import { presentNotificationText } from './text_presentation.mjs';
// PaperEcho product budget, not a verified QQ provider hard limit.
export const QQ_TEXT_BUDGET_BYTES = 5000;
export function renderQqNotification(content) {
  // Current outbound contract is text; template Markdown needs separately
  // provisioned provider capabilities, not assumed raw Markdown syntax.
  return { msg_type: 0, content: presentNotificationText(content, QQ_TEXT_BUDGET_BYTES) };
}
