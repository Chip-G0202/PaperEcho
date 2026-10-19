import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApplicationRuntimeContext } from '../tools/lib/runtime_config.mjs';
import { createControlServices } from '../tools/lib/control_application_services.mjs';
import { SecretService } from '../tools/lib/control_credentials_service.mjs';
import { ConfigService } from '../tools/lib/control_config_service.mjs';
import { SetupService } from '../tools/lib/control_setup_service.mjs';
import { main as runnerMain } from '../tools/runner/main.mjs';
import { createRunRecoveryCoordinator } from '../tools/recovery/run_recovery.mjs';
import { startRunGroup, finishRunGroup } from '../tools/lib/runtime_housekeeping.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('configured recovery and unknown startup facts stay out of initialization without rewriting saved owners', async t => {
  const f = await fixture(t); await configure(f);
  const context = await resolveApplicationRuntimeContext({ cwd: f.app, env: f.env, readOnly: true });
  const runRoot = context.runRoot, runId = 'interrupted-setup';
  const before = await fs.readFile(f.file);
  await startRunGroup({ runRoot, runId, pipelineMode: 'local' });
  const c = await createRunRecoveryCoordinator({ runRoot, runId, mode: 'local', profile: 'standard', configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath: path.join(runRoot, runId, 'input_artifact.json') });
  await c.persistArtifact([]); await finishRunGroup({ manifestPath: path.join(runRoot, runId, 'run_group.json'), status: 'interrupted' });
  for (const corrupt of [false, true]) {
    if (corrupt) await fs.writeFile(c.store.filePath, '{');
    const status = await f.services.setup.status();
    assert.equal(status.canRun, false); assert.equal(status.needsSetup, false); assert.equal(status.recoveryRequired, true);
    assert.ok(before.equals(await fs.readFile(f.file)));
    if (corrupt) assert.equal(await fs.readFile(c.store.filePath, 'utf8'), '{');
  }
});
async function fixture(t, layout = 'installed') {
  const base = path.join(repo, 'tests/runs/phase4'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, '首次 运行-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'app'); const data = layout === 'dev' ? app : layout === 'portable' ? path.join(app, 'data') : path.join(root, 'data');
  await fs.mkdir(path.join(app, 'config'), { recursive: true });
  await fs.copyFile(path.join(repo, 'config/paperecho.config.example.json'), path.join(app, 'config/paperecho.config.example.json'));
  const env = { PAPERECHO_LAYOUT: layout, PAPERECHO_APPLICATION_ROOT: app, ...(layout === 'dev' ? {} : { PAPERECHO_DATA_ROOT: data }), PAPERECHO_SKIP_DOTENV: '1', PATH: '' };
  const context = await resolveApplicationRuntimeContext({ cwd: app, env });
  const services = createControlServices({ root: app, context, env });
  const file = path.join(data, 'config/paperecho.config.json');
  return { root, app, data, env, context, services, file };
}
async function configure(f) {
  await fs.writeFile(path.join(f.data, 'input.json'), '[]');
  return f.services.config.updateMany([{ id: 'runtime.mode', value: 'local' }, { id: 'local.input', value: '../input.json' }, { id: 'local.output', value: '../local' }]);
}
test('fresh Installed/Portable/Dev setup saves through ConfigService and resumes without flags', async t => {
  for (const layout of ['installed', 'portable', 'dev']) {
    const f = await fixture(t, layout);
    const initial = await f.services.setup.status(); assert.equal(initial.needsSetup, true); assert.equal(initial.persisted, false);
    await assert.rejects(fs.access(f.file));
    assert.equal(initial.roots.userDataRoot, f.context.userDataRoot);
    await f.services.config.update('runtime.mode', 'local');
    assert.equal((await f.services.setup.status()).canRun, false);
    await configure(f); const before = await fs.readFile(f.file, 'utf8');
    const status = await f.services.setup.status(); assert.equal(status.canRun, true); assert.equal(status.needsSetup, false);
    assert.equal(await fs.readFile(f.file, 'utf8'), before);
    const again = await resolveApplicationRuntimeContext({ cwd: f.app, env: f.env });
    assert.equal((await createControlServices({ root: f.app, env: f.env, context: again }).setup.status()).needsSetup, false);
    await configure(f); assert.equal(await fs.readFile(f.file, 'utf8'), before);
    const sink = { write() {} }; assert.equal(await runnerMain(['--check', '--config', f.file], { env: f.env, stdout: sink, stderr: sink }), 0);
  }
});
test('old and unfinished configuration is readable without auto-overwrite; conflicts fail closed', async t => {
  const f = await fixture(t);
  await configure(f); const old = JSON.parse(await fs.readFile(f.file, 'utf8')); old.mode = null; old.common.email.enabled = false;
  await fs.writeFile(f.file, JSON.stringify(old)); const before = await fs.readFile(f.file, 'utf8');
  const context = await resolveApplicationRuntimeContext({ cwd: f.app, env: f.env });
  assert.equal((await createControlServices({ root: f.app, context, env: f.env }).setup.status()).canRun, false);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  const conflict = { ...f.env, PAPERECHO_DATA_ROOT: f.app };
  await assert.rejects(resolveApplicationRuntimeContext({ cwd: f.app, env: conflict }), /RUNTIME_INSTALLED_BOUNDARY/);
});
test('save failure preserves previous state and setup can retry; Secret owner remains write-only', async t => {
  const f = await fixture(t); await configure(f); const before = await fs.readFile(f.file, 'utf8');
  let fail = true;
  const config = new ConfigService({ root: f.data, env: f.env, configPath: f.file, atomicOptions: { validateTemporary: async () => { if (fail) throw new Error('DUMMY_SAVE_FAILED'); } } });
  await assert.rejects(config.update('local.input', '../missing.json'), /DUMMY_SAVE_FAILED/);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  fail = false; await config.update('local.input', '../missing.json');
  assert.equal((await new SetupService({ config, context: f.context, env: f.env }).status()).canRun, false);
  await configure(f); assert.equal((await f.services.setup.status()).canRun, true);
  const env = { ...f.env, TITLE_TRANSLATION_API_KEY: 'dummy-external-only' };
  const secrets = new SecretService({ root: f.data, env });
  const statuses = await secrets.list(); const external = statuses.find(x => x.id === 'TITLE_TRANSLATION_API_KEY');
  assert.equal(external.storageClass, 'external-managed'); assert.equal(external.writable, false);
  assert.ok(!JSON.stringify(statuses).includes('dummy-external-only'));
  await assert.rejects(secrets.replace('TITLE_TRANSLATION_API_KEY', 'dummy-replacement'), /CREDENTIAL_EXTERNALLY_MANAGED/);
  assert.ok(!JSON.stringify(await f.services.setup.status()).includes('dummy-external-only'));
});
