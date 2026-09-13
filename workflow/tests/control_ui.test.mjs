import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import '../../tests/control_review_workspace.test.mjs';
const html = await fs.readFile(new URL('../tools/web/static/index.html', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../tools/web/static/styles.css', import.meta.url), 'utf8');
const app = await fs.readFile(new URL('../tools/web/static/app.js', import.meta.url), 'utf8');
test('UI shell keeps five real routes, skip target, live status and collapsible navigation', () => {
  const routes = [...html.matchAll(/data-page="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(routes, ['home', 'weekly', 'feedback', 'settings', 'system']);
  assert.match(html, /href="#content"/); assert.match(html, /<main[^>]*id="content"[^>]*tabindex="-1"/);
  assert.match(html, /id="menu-toggle"[^>]*aria-controls="sidebar"[^>]*aria-expanded="false"/);
  assert.match(html, /id="notice"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotThrow(() => new vm.Script(app));
});
test('UI renders untrusted content through text nodes and keeps credentials write-only', () => {
  assert.doesNotMatch(app, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\(/);
  assert.match(app, /node\.textContent = text/);
  assert.match(app, /input\.type = 'password'/);
  assert.match(app, /const value = input\.value; input\.value = ''/);
  assert.doesNotMatch(app, /input\.value\s*=\s*item\.(?:value|secret|password)/);
  assert.match(app, /连接测试尚未开放/);
});
test('UI feedback and responsive contracts retain fail-closed messaging and accessible state', () => {
  assert.match(app, /aria-label', '反馈类型'/);
  assert.match(app, /application_status === 'requires_manual_action'/);
  assert.match(app, /尚未正式应用/);
  assert.match(app, /humanApproval: true/);
  assert.match(app, /aria-describedby/); assert.match(app, /aria-invalid/);
  assert.match(css, /--focus:/); assert.match(css, /:focus-visible/);
  assert.match(css, /\[hidden\]\{display:none!important\}/);
  assert.match(css, /@media\(max-width:760px\)/); assert.match(css, /position:static/);
  assert.match(css, /overflow-wrap:anywhere/);
});
