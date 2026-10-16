import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretService, CONTROL_SECRET_NAMES } from '../tools/lib/control_credentials_service.mjs';
import { parseEnvFile, loadDotEnv, environmentForControlChild } from '../tools/lib/env_file_bootstrap.mjs';
import { copyEnvironment, mapCredentialReference, redactSecrets } from '../tools/lib/credential_registry.mjs';
import { redactText } from '../tools/runner/main.mjs';
import { secureCredentialFile } from '../tools/lib/credential_file_security.mjs';
import { execFileSync } from 'node:child_process';
const base = fileURLToPath(new URL('../../tests/runs/credentials/', import.meta.url));
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'credentials-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Isolate ACL tests from host/sandbox-specific inherited principals.
  const file = path.join(root, '.env'); await fs.writeFile(file, ''); await secureCredentialFile(file);
  return root;
}
test('credentials replace/clear round trip preserves unknown entries and redacts previous values', async (t) => {
  const shorter = 'dummy-contained-secret'; const longer = `${shorter}-extra-material`;
  const sibling = `different-material-${longer.slice(-8)}`;
  const input = [longer, shorter, sibling, longer, longer.slice(0, 8), longer.slice(-8)].join(' | ');
  const expected = Array(6).fill('[REDACTED]').join(' | ');
  for (const values of [[shorter, longer, sibling], [sibling, longer, shorter], [longer, shorter, sibling]]) {
    const env = Object.fromEntries(CONTROL_SECRET_NAMES.map((id, i) => [id, values[i % values.length]]));
    for (const redact of [text => redactSecrets(text, values), text => redactText(text, env), text => new SecretService({ env }).redact(text)]) {
      assert.equal(redact(input) === expected, true, 'overlapping credentials and fingerprints must be entirely redacted in any registration order');
    }
  }
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
  const env = {}; loadDotEnv({ env, envPath: file });
  const service = new SecretService({ root, env, atomicOptions: { renameImpl: async () => { throw new Error(`new-private ${root}`); } } });
  await assert.rejects(service.replace('SMTP_PASS', 'new-private'), (error) => {
    assert.equal(error.message, 'CREDENTIAL_WRITE_FAILED');
    assert.equal(error.stack.includes('new-private'), false); assert.equal(error.stack.includes(root), false); return true;
  });
  assert.equal(await fs.readFile(file, 'utf8'), 'SMTP_PASS="old-private"\n');
  assert.equal(env.SMTP_PASS, 'old-private');
  assert.deepEqual(await fs.readdir(root), ['.env']);
});

test('trusted load provenance survives runtime copies; identical injections and custom references stay read-only', async t => {
  const root = await fixture(t); const file = path.join(root, '.env');
  await fs.writeFile(file, 'SMTP_PASS="same-dummy-private"\nCUSTOM_SECRET="custom-dummy-private"\n');
  const local = {}; loadDotEnv({ env: local, envPath: file });
  const service = new SecretService({ root, env: copyEnvironment(local) });
  assert.equal((await service.list()).find(x => x.id === 'SMTP_PASS').storageClass, 'local-managed');
  await service.replace('SMTP_PASS', 'next-dummy-private');
  for (const env of [{ SMTP_PASS: 'same-dummy-private' }, { ...local }]) {
    loadDotEnv({ env, envPath: file });
    const external = new SecretService({ root, env });
    assert.equal((await external.list()).find(x => x.id === 'SMTP_PASS').storageClass, 'external-managed');
    await assert.rejects(external.replace('SMTP_PASS', 'never-saved'), /EXTERNALLY_MANAGED/);
  }
  const wrongRoot = await fixture(t);
  const unknown = new SecretService({ root: wrongRoot, env: local });
  const status = (await unknown.list()).find(x => x.id === 'SMTP_PASS');
  assert.equal(status.storageClass, 'unknown'); assert.equal(status.writable, false);
  await assert.rejects(unknown.clear('SMTP_PASS'), /EXTERNALLY_MANAGED/);
  const mapped = copyEnvironment(local); mapped.SMTP_PASS = local.CUSTOM_SECRET;
  mapCredentialReference(mapped, local, 'SMTP_PASS', 'CUSTOM_SECRET');
  const reference = new SecretService({ root, env: mapped });
  await assert.rejects(reference.replace('SMTP_PASS', 'never-saved'), /EXTERNALLY_MANAGED/);
  assert.equal((await reference.smtpStatus('CUSTOM_SECRET')).writable, false);
  assert.equal(reference.redact(local.CUSTOM_SECRET), '[REDACTED]');
  assert.equal(environmentForControlChild(local).SMTP_PASS, undefined);
  assert.equal(environmentForControlChild({ SMTP_PASS: 'external-dummy' }).SMTP_PASS, 'external-dummy');
});

test('Windows/POSIX credential ACL is enforced on empty temporary files and final rename; concurrent fields survive', async t => {
  const root = await fixture(t); const env = {}; const checked = [];
  const secureFile = async (file, options) => {
    if (!options.checkOnly) assert.equal((await fs.stat(file)).size, 0, 'secure before writing secret bytes');
    await secureCredentialFile(file, options);
    await secureCredentialFile(file, { checkOnly: true }); checked.push(path.basename(file));
  };
  const service = new SecretService({ root, env, atomicOptions: { secureFile } });
  // Await both writers even on failure, so fixture cleanup cannot race a live writer.
  const writes = await Promise.allSettled([service.replace('SMTP_PASS', 'smtp-concurrent-dummy'), service.replace('SEMANTIC_SCHOLAR_API_KEY', 'scholar-concurrent-dummy')]);
  assert.equal(writes.every(result => result.status === 'fulfilled'), true, 'both bounded concurrent writes must finish successfully');
  const values = parseEnvFile(await fs.readFile(path.join(root, '.env'), 'utf8'));
  assert.equal(values.SMTP_PASS, 'smtp-concurrent-dummy'); assert.equal(values.SEMANTIC_SCHOLAR_API_KEY, 'scholar-concurrent-dummy');
  assert.ok(checked.includes('.env')); assert.ok(checked.some(file => file.endsWith('.tmp')));
  assert.deepEqual(await fs.readdir(root), ['.env']);
});

test('temporary and final ACL failures preserve old file/environment and remove protected rollback/temp files', async t => {
  for (const failFinal of [false, true]) {
    const root = await fixture(t); const file = path.join(root, '.env'); const original = 'SMTP_PASS="old-acl-dummy"\n';
    await fs.writeFile(file, original); const env = {}; loadDotEnv({ env, envPath: file });
    const service = new SecretService({ root, env, atomicOptions: { secureFile: async (target, options) => {
      if (failFinal ? target === file : !options.checkOnly) throw new Error('CREDENTIAL_ACL_UNSAFE');
      await secureCredentialFile(target, options);
    } } });
    await assert.rejects(service.replace('SMTP_PASS', 'new-acl-dummy'), /ACL_UNSAFE/);
    assert.equal(await fs.readFile(file, 'utf8'), original); assert.equal(env.SMTP_PASS, 'old-acl-dummy');
    assert.deepEqual(await fs.readdir(root), ['.env']);
  }
});

test('ACL rollback retries transient rename errors but preserves recovery evidence on persistent failure', async t => {
  for (const persistent of [false, true]) {
    const root = await fixture(t); const file = path.join(root, '.env'); const original = 'SMTP_PASS="dummy-rollback-old"\n';
    await fs.writeFile(file, original); const env = {}; loadDotEnv({ env, envPath: file }); let attempts = 0;
    const service = new SecretService({ root, env, atomicOptions: {
      secureFile: async (target, options) => { if (target === file && options.checkOnly) throw new Error('CREDENTIAL_ACL_UNSAFE'); await secureCredentialFile(target, options); },
      renameImpl: async (from, to) => {
        if (from.endsWith('.rollback') && (++attempts === 1 || persistent)) throw Object.assign(new Error('dummy transient rename'), { code: 'EPERM' });
        await fs.rename(from, to);
      },
    } });
    await assert.rejects(service.replace('SMTP_PASS', 'dummy-rollback-new'), persistent ? /CREDENTIAL_RECOVERY_REQUIRED/ : /CREDENTIAL_ACL_UNSAFE/);
    assert.equal(env.SMTP_PASS, 'dummy-rollback-old'); assert.ok(attempts > 1 && attempts <= 4);
    const rollback = (await fs.readdir(root)).filter(x => x.endsWith('.rollback'));
    if (persistent) { assert.equal(rollback.length, 1); assert.equal(await fs.readFile(path.join(root, rollback[0]), 'utf8'), original); await secureCredentialFile(path.join(root, rollback[0]), { checkOnly: true }); }
    else { assert.equal(await fs.readFile(file, 'utf8'), original); assert.deepEqual(await fs.readdir(root), ['.env']); }
  }
});

test('fresh processes load saved dummy credentials and preserve external priority without disclosing values', async t => {
  const root = await fixture(t); const file = path.join(root, '.env');
  await new SecretService({ root, env: {} }).replace('SMTP_PASS', 'saved-process-dummy');
  const module = new URL('../tools/lib/env_file_bootstrap.mjs', import.meta.url).href;
  const script = `import {loadDotEnv} from ${JSON.stringify(module)}; const env=JSON.parse(process.argv[2]); loadDotEnv({env,envPath:process.argv[1]}); if(env.SMTP_PASS!==process.argv[3])process.exit(2); console.log('verified');`;
  for (const [env, expected] of [[{}, 'saved-process-dummy'], [{ SMTP_PASS: 'external-process-dummy' }, 'external-process-dummy']]) {
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script, file, JSON.stringify(env), expected], { env: { ...process.env, PAPERECHO_SKIP_DOTENV: '1' }, encoding: 'utf8', windowsHide: true }).trim(), 'verified');
  }
});

test('credential writer rejects junction ancestors and hardlinks without changing targets', async t => {
  const root = await fixture(t); const real = path.join(root, 'real'); const junction = path.join(root, 'linked');
  await fs.mkdir(real); await fs.writeFile(path.join(real, '.env'), 'SMTP_PASS="linked-dummy"\n');
  await fs.symlink(real, junction, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new SecretService({ root: junction, env: {} }).replace('SMTP_PASS', 'new-dummy'), /PATH_UNSAFE/);
  const hardRoot = path.join(root, 'hardlink-target'); await fs.mkdir(hardRoot);
  await fs.link(path.join(real, '.env'), path.join(hardRoot, '.env'));
  assert.equal((await fs.stat(path.join(hardRoot, '.env'))).nlink, 2);
  await assert.rejects(new SecretService({ root: hardRoot, env: {} }).replace('SMTP_PASS', 'new-dummy'), /PATH_UNSAFE/);
  assert.equal(await fs.readFile(path.join(real, '.env'), 'utf8'), 'SMTP_PASS="linked-dummy"\n');
});
