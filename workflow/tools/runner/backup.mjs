import path from 'node:path';
import { BackupService, backupSafePath, readBackupFile } from '../lib/backup_service.mjs';
import { backupError, sha256 } from '../lib/backup_format.mjs';
import { resolveRuntimePaths, resolveApplicationRuntimeContext } from '../lib/runtime_config.mjs';
import { parseRunnerArgs } from './args.mjs';
import { resolveRunnerConfiguration } from './config_loader.mjs';

// Passwords are accepted only from a non-echoing terminal or explicit stdin pipe.
export async function readBackupPassword(input = process.stdin, output = process.stderr, pipe = false) {
  if (!input.isTTY && !pipe || input.isTTY && !input.setRawMode) throw backupError('BACKUP_PASSWORD_CHANNEL_REQUIRED');
  if (input.isTTY) { output.write('Backup password (at least 12 UTF-8 bytes; not stored): '); input.setRawMode(true); }
  return new Promise((resolve, reject) => {
    const bytes = []; let length = 0;
    const finish = error => { input.off('data', onData); input.off('end', onEnd); input.off('error', onError); input.pause(); if (input.isTTY) { input.setRawMode(false); output.write('\n'); }
      const value = Buffer.from(bytes); bytes.fill(0); error ? (value.fill(0), reject(error)) : resolve(value); };
    const onError = () => finish(backupError('BACKUP_PASSWORD_INPUT_FAILED'));
    const onEnd = () => finish(length ? null : backupError('BACKUP_PASSWORD_INPUT_FAILED'));
    const onData = chunk => { for (const b of Buffer.from(chunk)) {
      if (b === 3 && input.isTTY) return finish(backupError('BACKUP_CANCELLED'));
      if (b === 10 || b === 13) return finish();
      if ((b === 8 || b === 127) && input.isTTY) { let removed; do { removed = bytes.pop(); if (removed !== undefined) length--; } while (bytes.length && (removed & 0xc0) === 0x80); continue; }
      if (b < 32) return finish(backupError('BACKUP_PASSWORD_INVALID'));
      bytes.push(b); if (++length > 1024) return finish(backupError('BACKUP_PASSWORD_INVALID'));
    } };
    input.on('data', onData); input.once('end', onEnd); input.once('error', onError); input.resume();
  });
}
export async function backupMain(argv, { env = process.env, cwd, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin } = {}) {
  let password;
  try {
    const action = argv[0];
    if (!['--backup', '--verify-backup'].includes(action) || !argv[1] || argv[1].startsWith('--') || argv.slice(2).some(x => x !== '--password-stdin') || argv.length > 3) throw backupError('BACKUP_ARGUMENT_INVALID');
    if (!path.isAbsolute(argv[1])) throw backupError('BACKUP_PATH_ABSOLUTE_REQUIRED');
    password = await readBackupPassword(stdin, stderr, argv.includes('--password-stdin'));
    let context;
    if (action === '--backup') {
      const paths = resolveRuntimePaths({ ...(cwd ? { applicationRoot: cwd } : {}), env });
      await backupSafePath(paths.configPath);
      const backupConfigHash = sha256(await readBackupFile(paths.configPath, 1048576));
      // Only bootstrap/path controls reach the config resolver. No external
      // credential values are read, copied or serialised for a backup.
      const safeEnv = Object.fromEntries(['PAPERECHO_LAYOUT', 'PAPERECHO_APPLICATION_ROOT', 'PAPERECHO_RESOURCE_ROOT', 'PAPERECHO_DATA_ROOT', 'PAPERECHO_CACHE_ROOT', 'PAPERECHO_WORKSPACE_ID', 'LOCALAPPDATA', 'PAPERECHO_CONFIG', 'ZOTERO_PROJECT_ROOT', 'review_results_ROOT', 'review_results_OUTPUT_ROOT', 'PAPERECHO_SOURCE_STATE_ROOT', 'PAPERECHO_NOTIFICATION_RECEIPT_ROOT'].filter(k => Object.hasOwn(env, k)).map(k => [k, env[k]]));
      if (safeEnv.PAPERECHO_CONFIG && path.resolve(safeEnv.PAPERECHO_CONFIG) !== path.resolve(paths.configPath)) throw backupError('BACKUP_EXTERNAL_OWNER');
      const cli = parseRunnerArgs(['--check'], { cwd: paths.userDataRoot, allowUnresolvedMode: true });
      const resolved = await resolveRunnerConfiguration(cli, { cwd: paths.applicationRoot, env: safeEnv, defaultConfigPath: paths.configPath, readOnly: true });
      context = await resolveApplicationRuntimeContext({ cwd: paths.applicationRoot, env: safeEnv, readOnly: true });
      context.backupInputs = [resolved.options.input, resolved.options.feedback].filter(Boolean);
      context.backupConfigHash = backupConfigHash;
      context.backupSecretNames = [];
      const references = object => { for (const [key, value] of Object.entries(object || {})) { if (/Env$/.test(key) && typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value)) context.backupSecretNames.push(value); else if (value && typeof value === 'object') references(value); } };
      references(resolved.config);
      if (sha256(await readBackupFile(paths.configPath, 1048576)) !== backupConfigHash) throw backupError('BACKUP_CONFIG_CHANGED');
    }
    const service = new BackupService({ context, env });
    const result = action === '--backup' ? await service.create({ output: argv[1], password }) : await service.verify({ input: argv[1], password });
    stdout.write(JSON.stringify(result) + '\n'); return 0;
  } catch (error) {
    const code = /^BACKUP_[A-Z_]+$/.test(error?.code) ? error.code : ['ENOSPC', 'EACCES', 'EPERM'].includes(error?.code) ? `BACKUP_${error.code}` : 'BACKUP_FAILED';
    stdout.write(JSON.stringify({ schemaVersion: 1, status: 'failed', code }) + '\n'); return 2;
  } finally { password?.fill(0); }
}
