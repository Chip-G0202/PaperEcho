// TEST-ONLY build validation; never imported by the packaged application.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

export async function nativeSmoke(bundle, parent, { execute = spawnSync, platform = process.platform, electronVersion } = {}) {
  if (platform !== 'darwin') throw new Error('MACOS_NATIVE_SMOKE_REQUIRED');
  const executable = path.join(bundle, 'Contents/MacOS/PaperEcho');
  await fs.access(executable, fs.constants.X_OK);
  const core = path.join(bundle, 'Contents/Resources/core');
  const metadata = JSON.parse(await fs.readFile(path.join(core, 'package.json'), 'utf8'));
  const fixture = await fs.mkdtemp(path.join(parent, 'native-smoke-'));
  const data = path.join(fixture, 'data'), home = path.join(fixture, 'home'), temp = path.join(fixture, 'tmp');
  for (const dir of [home, temp, path.join(data, 'config')]) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(data, 'input.json'), '[]');
  const config = JSON.stringify({ schemaVersion: 2, mode: 'local', common: { projectRoot: '..', llm: { enabled: false, mode: 'disabled' }, email: { enabled: false } }, local: { input: '../input.json', outputRoot: '../output' } });
  await fs.writeFile(path.join(data, 'config/paperecho.config.json'), config, { mode: 0o600 });
  // Allowlist rather than inheriting CI credentials, Node overrides or provider configuration.
  const env = { HOME: home, TMPDIR: temp, TEMP: temp, TMP: temp, PATH: '', LANG: 'en_US.UTF-8',
    PAPERECHO_SKIP_DOTENV: '1', PAPERECHO_LAYOUT: 'installed', PAPERECHO_DATA_ROOT: data };
  const report = { signature: 'NOT_CHECKED', runtime: 'NOT_RUN', headless: 'NOT_RUN', gui: 'NOT_TESTED', gatekeeper: 'NOT_TESTED' };
  function command(step, file, args, extraEnv = {}) {
    const result = execute(file, args, { cwd: fixture, env: { ...env, ...extraEnv }, shell: false,
      encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    report[step] = { exitCode: result.status ?? null, signal: result.signal || null, error: result.error?.code || null };
    if (result.error || result.signal || result.status !== 0) {
      const redact = text => String(text || '').split(fixture).join('<fixture>').split(bundle).join('<app>').slice(0, 4096);
      report[step].stderr = redact(result.stderr); report[step].stdout = redact(result.stdout);
      throw new Error(`MACOS_${step.toUpperCase()}_FAILED`);
    }
    return result.stdout;
  }
  try {
    // Verify only. Never re-sign, change quarantine, disable policy or use Developer ID credentials.
    // https://developer.apple.com/library/archive/technotes/tn2206/
    command('signature', '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
    const probe = `const {createRequire}=require('node:module');const r=createRequire(${JSON.stringify(path.join(core, 'package.json'))});const p=r('./package.json');for(const n of Object.keys(p.dependencies))r(n);console.log(JSON.stringify({arch:process.arch,electron:process.versions.electron,node:process.versions.node,dependencies:Object.keys(p.dependencies).sort()}));`;
    const runtime = JSON.parse(command('runtime', executable, ['-e', probe], { ELECTRON_RUN_AS_NODE: '1' }));
    assert.equal(runtime.arch, 'arm64'); assert.ok(runtime.electron);
    if (electronVersion) assert.equal(runtime.electron, electronVersion);
    assert.ok(Number(runtime.node?.split('.')[0]) >= 18);
    assert.deepEqual(runtime.dependencies, Object.keys(metadata.dependencies).sort());
    report.runtime.versions = runtime;
    // Native app entry, not system Node or a direct import of the Runner.
    const output = command('headless', executable, ['--headless', '--check', '--mode', 'local']);
    const preflight = output.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(value => value.type === 'preflight');
    assert.equal(preflight?.canRun, true); assert.equal(preflight.mode, 'local');
    assert.deepEqual(preflight.requiredMissing, []);
    assert.ok(preflight.readiness.some(value => value.name === 'production_entry' && value.status === 'ready'));
    assert.equal(await fs.readFile(path.join(data, 'config/paperecho.config.json'), 'utf8'), config);
    assert.equal(await fs.readFile(path.join(data, 'input.json'), 'utf8'), '[]');
    await assert.rejects(fs.access(path.join(data, 'output')), { code: 'ENOENT' });
    report.headless.preflight = { canRun: true, mode: 'local', productionExecuted: false };
    return report;
  } catch (error) {
    console.error(JSON.stringify({ type: 'mac-native-smoke-failure', code: error.code || error.message, ...report }));
    throw error;
  }
}
