import assert from 'node:assert/strict';

// Fixtures use distinct short titles: validate meaning/order, not whole messages.
export function assertNotificationParity(content, text, { prefix = false } = {}) {
  const included = content.items.filter(item => text.includes(item.title));
  assert.deepEqual(included.map(item => item.id), content.items.slice(0, included.length).map(item => item.id));
  if (!prefix) assert.equal(included.length, content.items.length);
  let position = -1;
  for (const item of included) {
    const next = text.indexOf(item.title); assert.ok(next > position); position = next;
    assert.ok(text.includes(`[${item.grade}]`));
    for (const value of [item.translatedTitle, item.reason, item.journal, item.year, item.source].filter(Boolean)) assert.ok(text.includes(value), value);
  }
  if (prefix && included.length < content.items.length) assert.match(text, new RegExp(`(?:还有|另有) ${content.items.length - included.length} 项`));
  return included.map(item => item.id);
}
