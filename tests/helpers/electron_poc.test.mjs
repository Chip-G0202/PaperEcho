import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { sandboxWorkspace, sandboxBase, acquireServer, allowedDocument, allowedSupportDownload, preferences } from '../../desktop/electron-poc/shell.mjs';
process.env.PAPERECHO_SKIP_DOTENV = '1';
test('only bounded same-origin support ZIP blobs may use the desktop save dialog', () => {
  const origin = 'http://127.0.0.1:8765';
  const input = { url: `blob:${origin}/dummy-id`, documentURL: origin + '/#system', mime: 'application/zip', filename: 'paperecho-support.zip', bytes: 2048 };
  assert.equal(allowedSupportDownload(input, origin), true);
  for (const invalid of [{ url: 'https://example.invalid/file.zip' }, { url: 'blob:http://127.0.0.1:9999/dummy' }, { filename: '../paperecho-support.zip' }, { filename: 'other.zip' }, { mime: 'text/html' }, { bytes: 0 }, { bytes: 65537 }, { documentURL: origin + '/api/session' }]) assert.equal(allowedSupportDownload({ ...input, ...invalid }, origin), false);
});
const { requestLocal } = await import('../../workflow/tools/web/launcher.mjs');
async function fixture(t) {
  await fs.mkdir(sandboxBase, { recursive: true });
  const root = await sandboxWorkspace(await fs.mkdtemp(path.join(sandboxBase, 'unit-')));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
test('sandbox and renderer policy fail closed', async t => {
  await assert.rejects(sandboxWorkspace(path.resolve(sandboxBase, '..', 'outside')), /SANDBOX_REQUIRED/);
  assert.deepEqual(preferences, { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
  const origin = 'http://127.0.0.1:8765';
  assert.equal(allowedDocument(origin + '/#feedback', origin), true);
  for (const value of ['file:///dummy', 'javascript:void(0)', 'https://example.invalid', origin + '/api/session', origin + '/?x', 'http://localhost:8765/']) assert.equal(allowedDocument(value, origin), false);
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'config', 'paperecho.config.json'), JSON.stringify({ schemaVersion: 2, mode: 'local', common: { projectRoot: path.join(sandboxBase, 'outside') } }));
  await assert.rejects(acquireServer(root), /SANDBOX_REQUIRED/);
});
test('same workspace reuses; other workspace separates; reused close preserves independent server', async t => {
  const root = await fixture(t); const other = await fixture(t);
  const a = await acquireServer(root, { port: 28765 }); t.after(() => a.close());
  const b = await acquireServer(root, { port: 28765 });
  assert.equal(a.owned, true); assert.equal(b.owned, false); assert.equal(b.url, a.url);
  await b.close(); assert.equal((await requestLocal(a.url + '/api/ready')).status, 200);
  const c = await acquireServer(other, { port: 28765 }); t.after(() => c.close());
  assert.notEqual(c.url, a.url); assert.equal(c.owned, true);
});
test('foreign listener is never loaded or terminated', async t => {
  const root = await fixture(t); const foreign = http.createServer((_q, s) => s.end('foreign'));
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  await assert.rejects(acquireServer(root, { port: foreign.address().port }), /PORT_OCCUPIED/);
  assert.equal(foreign.listening, true);
});
test('real HTTP session/Host/Origin/CSRF and credentials remain guarded', async t => {
  const a = await acquireServer(await fixture(t), { port: 28766 }); t.after(() => a.close());
  const get = route => requestLocal(a.url + route);
  assert.equal((await get('/api/credentials')).status, 403);
  assert.equal((await get('/api/settings')).status, 403);
  assert.equal((await requestLocal(a.url + '/api/ready', { headers: { Host: 'evil.invalid' } })).status, 403);
  const s = await get('/api/session'); const cookie = s.headers['set-cookie'][0].split(';')[0];
  const headers = { Cookie: cookie, Origin: a.url, 'X-CSRF-Token': s.json.token, 'Content-Type': 'application/json' };
  for (const change of [{ Origin: 'https://evil.invalid' }, { 'X-CSRF-Token': '' }]) assert.equal((await requestLocal(a.url + '/api/research', { method: 'POST', headers: { ...headers, ...change }, body: '{}' })).status, 403);
  const credentials = await requestLocal(a.url + '/api/credentials', { headers: { Cookie: cookie } });
  assert.equal(credentials.status, 200);
  assert.equal(JSON.stringify(credentials.json).includes('process.env'), false);
});
