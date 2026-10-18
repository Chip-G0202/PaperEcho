import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupService } from '../../workflow/tools/lib/backup_service.mjs';
import { sha256 } from '../../workflow/tools/lib/backup_format.mjs';
import { resolveApplicationRuntimeContext } from '../../workflow/tools/lib/runtime_config.mjs';
import { secureCredentialFile } from '../../workflow/tools/lib/credential_file_security.mjs';
import { UpgradePreflightService } from '../../workflow/tools/lib/upgrade_preflight_service.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
export const upgradePassword = () => Buffer.from('dummy-upgrade-fixture-password');
export async function writeUpgradeFixture(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); }
export async function upgradeFileHashes(root) {
  const map = {};
  async function walk(dir) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name); const s = await fs.lstat(file);
    if (s.isSymbolicLink()) { map[path.relative(root, file)] = 'link'; continue; }
    if (entry.isDirectory()) await walk(file); else map[path.relative(root, file)] = sha256(await fs.readFile(file));
  } } await walk(root); return map;
}
export async function upgradeFixture(t, { legacy = false, schema = 6, layout = legacy ? 'dev' : 'installed', targetLayout = 'installed', applicationRoot, secret = true, externalSecretName = '' } = {}) {
  const base = path.join(repo, 'tests/runs/upgrade'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, '兼容 & 只读-')); t?.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'old-program'); const targetApp = applicationRoot || path.join(root, 'new-program');
  const data = layout === 'dev' ? app : layout === 'portable' ? path.join(app, 'data') : path.join(root, 'old-data');
  const target = targetLayout === 'portable' ? path.join(targetApp, 'future-data-' + path.basename(root)) : path.join(root, 'new-data');
  if (!applicationRoot) await writeUpgradeFixture(path.join(targetApp, 'resources/core/package.json'), { name: 'paperecho-core', version: '2.6.0', type: 'module' });
  if (legacy) {
    await writeUpgradeFixture(path.join(app, 'package.json'), { name: 'paperecho' });
    await writeUpgradeFixture(path.join(app, 'workflow/tools/lib/runtime_config.mjs'), await fs.readFile(path.join(repo, 'tests/helpers/upgrade-v2.5-runtime-contract.txt'), 'utf8'));
  } else await writeUpgradeFixture(path.join(app, 'resources/core/package.json'), { name: 'paperecho-core', version: '2.6.0', type: 'module' });
  const resource = legacy ? app : path.join(app, 'resources/core');
  for (const file of ['workflow/tools/runner/main.mjs', 'workflow/tools/web/static/index.html']) await writeUpgradeFixture(path.join(resource, file), 'synthetic-non-executable-contract-only');
  const config = { schemaVersion: schema, mode: 'local', profile: 'standard', common: { projectRoot: '..', llm: { enabled: false, mode: 'disabled' }, email: { enabled: false } }, local: { input: '../input.json', outputRoot: '../local' } };
  await writeUpgradeFixture(path.join(data, 'config/paperecho.config.json'), config);
  await writeUpgradeFixture(path.join(data, 'input.json'), [{ title: 'dummy-private-upgrade-title', doi: '10.1234/dummy-upgrade' }]);
  await writeUpgradeFixture(path.join(data, 'review_results/文献评价/screening_standards.md'), 'dummy-private-research-direction');
  await writeUpgradeFixture(path.join(data, 'review_results/文献评价/research_evaluations/events/dummy.json'), { schemaVersion: 1, text: 'dummy-private-research-feedback' });
  await writeUpgradeFixture(path.join(data, 'review_results/文献评价/paper_feedback.json'), {});
  await writeUpgradeFixture(path.join(data, 'review_results/pipeline/dummy/run_report.json'), { status: 'dummy-historical' });
  await writeUpgradeFixture(path.join(data, 'review_results/run_manifests/dummy.json'), {});
  await writeUpgradeFixture(path.join(data, 'local/state/papers.json'), { schema_version: 1, papers: [] });
  await writeUpgradeFixture(path.join(data, 'local/feedback/events.jsonl'), '{}\n');
  const env = { PAPERECHO_APPLICATION_ROOT: app, PAPERECHO_RESOURCE_ROOT: resource, PAPERECHO_LAYOUT: layout,
    ...(layout === 'dev' ? {} : { PAPERECHO_DATA_ROOT: data }), PAPERECHO_SKIP_DOTENV: '1' };
  if (secret) { await writeUpgradeFixture(path.join(data, '.env'), 'SMTP_PASS=dummy-upgrade-local-secret\n'); await secureCredentialFile(path.join(data, '.env')); }
  const context = await resolveApplicationRuntimeContext({ env, readOnly: true });
  context.backupInputs = [path.join(data, 'input.json')]; context.backupConfigHash = sha256(await fs.readFile(context.configPath));
  const backupEnv = externalSecretName ? { ...env, [externalSecretName]: 'dummy-external-backup-metadata-only' } : env;
  const backup = path.join(root, 'source.pebackup'); await new BackupService({ context, env: backupEnv }).create({ output: backup, password: upgradePassword() });
  const hostEnv = { PAPERECHO_APPLICATION_ROOT: targetApp, PAPERECHO_RESOURCE_ROOT: path.join(targetApp, 'resources/core'), PAPERECHO_LAYOUT: 'installed', PAPERECHO_DATA_ROOT: path.join(root, 'host-data'), PAPERECHO_SKIP_DOTENV: '1' };
  const input = { sourceApplicationRoot: app, sourceDataRoot: data, sourceLayout: layout, targetDataRoot: target, targetLayout, backup };
  const make = options => new UpgradePreflightService({ env: hostEnv, volume: async () => ({ filesystem: 'NTFS', freeBytes: 100000000000n }), ...options });
  return { root, app, targetApp, data, target, config, backup, context, env, hostEnv, input, make, inspect: options => make().inspect({ ...input, password: upgradePassword(), ...options }) };
}
