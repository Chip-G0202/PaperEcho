import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretService, CONTROL_SECRET_NAMES } from '../tools/lib/control_credentials_service.mjs';
import { parseEnvFile } from '../tools/lib/env_file_bootstrap.mjs';
const base = fileURLToPath(new URL('./.control-test-tmp/', import.meta.url));
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'credentials-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('credentials replace/clear round trip preserves unknown entries and redacts previous values', async (t) => {
  const root = await fixture(t); const file = path.join(root, '.env'); const env = {};
  const unknown = '# 中文说明\r\nUNKNOWN = "keep # exact"\r\nPORT=5678 # unchanged\r\n';
  await fs.writeFile(file, unknown);
  const service = new SecretService({ root, env });
  for (const id of CONTROL_SECRET_NAMES) {
    const value = `new-${id}-带空格 # 密码'`;
    const receipt = await service.replace(id, value);
    assert.equal(JSON.stringify(receipt).includes(value), false);
    assert.equal(parseEnvFile(await fs.readFile(file, 'utf8'))[id], value);
    assert.equal(env[id], value);
    assert.equal((await service.list()).find((item) => item.id === id).configured, true);
    assert.equal(JSON.stringify(await service.list()).includes(value), false);
    await service.clear(id);
    assert.equal(parseEnvFile(await fs.readFile(file, 'utf8'))[id], '');
    assert.equal(env[id], '');
    assert.equal((await service.list()).find((item) => item.id === id).configured, false);
    assert.equal(service.redact(`failure ${value}`), 'failure [REDACTED]');
  }
  assert.ok((await fs.readFile(file, 'utf8')).startsWith(unknown));
  assert.deepEqual((await fs.readdir(root)).sort(), ['.env']);
});
test('credentials fail closed on malformed env, invalid key/value and external overrides', async (t) => {
  const root = await fixture(t); const file = path.join(root, '.env');
  const service = new SecretService({ root, env: {} });
  for (const text of ['BROKEN', 'A="unterminated\n', 'A=one\nA=two\n', 'export A=one\n']) {
    await fs.writeFile(file, text);
    await assert.rejects(service.replace('SMTP_PASS', 'private'), /FORMAT_UNSUPPORTED/);
    assert.equal(await fs.readFile(file, 'utf8'), text);
    assert.equal((await service.list()).every((item) => !item.writable), true);
  }
  await fs.writeFile(file, 'UNCHANGED=yes\n');
  await assert.rejects(service.replace('PATH', 'bad'), /KEY_NOT_ALLOWED/);
  await assert.rejects(service.clear('__proto__'), /KEY_NOT_ALLOWED/);
  for (const value of ['', 'a\nb', 'a\r', '\0', 'both\'"', 'x'.repeat(4097)]) await assert.rejects(service.replace('SMTP_PASS', value), /VALUE_INVALID/);
  const injected = new SecretService({ root, env: { SMTP_PASS: 'external-private' } });
  await assert.rejects(injected.clear('SMTP_PASS'), /EXTERNALLY_MANAGED/);
  assert.equal(await fs.readFile(file, 'utf8'), 'UNCHANGED=yes\n');
});
test('credential atomic failure leaves old file/env intact and errors contain no raw input or path', async (t) => {
  const root = await fixture(t); const file = path.join(root, '.env');
  await fs.writeFile(file, 'SMTP_PASS="old-private"\n');
  const env = { SMTP_PASS: 'old-private' };
  const service = new SecretService({ root, env, atomicOptions: { renameImpl: async () => { throw new Error(`new-private ${root}`); } } });
  await assert.rejects(service.replace('SMTP_PASS', 'new-private'), (error) => {
    assert.equal(error.message, 'CREDENTIAL_WRITE_FAILED');
    assert.equal(error.stack.includes('new-private'), false); assert.equal(error.stack.includes(root), false); return true;
  });
  assert.equal(await fs.readFile(file, 'utf8'), 'SMTP_PASS="old-private"\n');
  assert.equal(env.SMTP_PASS, 'old-private');
  assert.deepEqual(await fs.readdir(root), ['.env']);
});
