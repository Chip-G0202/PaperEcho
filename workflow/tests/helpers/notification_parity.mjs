import assert from 'node:assert/strict';
import { notificationSummary } from '../../tools/stage5/notification_content.mjs';

export function visibleSummary(text) {
  return text.replace(/<[^>]*>/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\\([\x60*_{}[\]()+#!|.\-\\])/g, '$1');
}
// Summary semantic parity; internal papers must never become outbound rows.
export function assertNotificationParity(content, text, { bounded = false } = {}) {
  text = visibleSummary(text);
  const view = notificationSummary(content);
  for (const value of [view.brand, view.status, view.date, view.totalLabel].filter(Boolean)) assert.ok(text.includes(value), value);
  if (view.total !== null) assert.ok(text.includes(String(view.total)), 'total');
  for (const [grade, count] of Object.entries(view.grades)) if (count !== null) assert.match(text, new RegExp(String.raw`${grade}\s*${count}(?:\D|$)`));
  if (view.overview) assert.ok(text.includes(bounded ? view.overview.slice(0, 24) : view.overview), 'overview');
  for (const alert of view.alerts) assert.ok(text.includes(alert), alert);
  for (const item of content.items) for (const value of [item.title, item.translatedTitle, item.reason, item.identifier].filter(Boolean)) assert.ok(!text.includes(value), 'paper detail: ' + value);
  assert.doesNotMatch(text, /项未展开|级文献/);
}
