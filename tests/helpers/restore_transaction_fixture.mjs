import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupService } from '../../workflow/tools/lib/backup_service.mjs';
import { sha256 } from '../../workflow/tools/lib/backup_format.mjs';
import { holdRestoreParent } from '../../workflow/tools/lib/restore_filesystem.mjs';
import { secureCredentialFile } from '../../workflow/tools/lib/credential_file_security.mjs';
import { resolveApplicationRuntimeContext } from '../../workflow/tools/lib/runtime_config.mjs';
import { RestoreTransaction } from '../../workflow/tools/recovery/restore_transaction.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
export const testPassword = () => Buffer.from('dummy-transaction-password');
export async function transactionFixture(t) {
  const parent = path.join(repo, 'tests/runs/restore-transaction'); await fs.mkdir(parent, { recursive: true });
  const home = await fs.mkdtemp(path.join(parent, '事务 安全-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const app = path.join(home, 'app'), source = path.join(home, 'source'), target = path.join(home, 'current');
  for (const file of ['config/paperecho.config.example.json', 'workflow/tools/runner/main.mjs', 'workflow/tools/web/static/index.html']) {
    await fs.mkdir(path.dirname(path.join(app, file)), { recursive: true }); await fs.copyFile(path.join(repo, file), path.join(app, file));
  }
  for (const [root, value] of [[source, 'dummy-new'], [target, 'dummy-old']]) {
    const guard = await holdRestoreParent(root); await guard.release();
    await fs.mkdir(path.join(root, 'config')); await fs.mkdir(path.join(root, '.cache/tmp'), { recursive: true });
    await fs.mkdir(path.join(root, 'local/runs'), { recursive: true });
    await fs.mkdir(path.join(root, 'local/state')); await fs.mkdir(path.join(root, 'local/feedback'));
    await fs.mkdir(path.join(root, 'review_results/文献评价'), { recursive: true });
    await fs.writeFile(path.join(root, 'config/paperecho.config.json'), JSON.stringify({ schemaVersion: 6, mode: 'local', common: { projectRoot: '..', llm: { enabled: false, mode: 'disabled' }, email: { enabled: false } }, local: { input: '../input.json', outputRoot: '../local' } }));
    await fs.writeFile(path.join(root, '.env'), '', { mode: 0o600 }); await secureCredentialFile(path.join(root, '.env'));
    await fs.writeFile(path.join(root, '.env'), 'SMTP_PASS=' + value + '-secret\n');
    await fs.writeFile(path.join(root, 'input.json'), JSON.stringify([{ title: value, doi: '10.1234/' + value }]));
    await fs.writeFile(path.join(root, 'local/state/papers.json'), JSON.stringify({ schema_version: 1, papers: [], note: value }));
    await fs.writeFile(path.join(root, 'local/feedback/events.jsonl'), '{}\n');
    await fs.writeFile(path.join(root, 'review_results/文献评价/screening_standards.md'), value);
  }
  const env = { PAPERECHO_APPLICATION_ROOT: app, PAPERECHO_LAYOUT: 'installed', PAPERECHO_DATA_ROOT: source, PAPERECHO_SKIP_DOTENV: '1' };
  const context = await resolveApplicationRuntimeContext({ env, readOnly: true });
  context.backupInputs = [path.join(source, 'input.json')]; context.backupConfigHash = sha256(await fs.readFile(context.configPath));
  const input = path.join(home, 'new.pebackup'); await new BackupService({ context, env }).create({ output: input, password: testPassword() });
  const make = options => new RestoreTransaction({ env, ...options });
  return { home, app, source, target, input, env, make, replace: options => make().replace({ input, target, password: testPassword(), confirm: async () => true, ...options }) };
}
export async function fileHashes(root) {
  const result = {};
  const walk = async dir => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name); if (entry.isDirectory()) await walk(file); else result[path.relative(root, file)] = sha256(await fs.readFile(file));
  } }; await walk(root); return result;
}
