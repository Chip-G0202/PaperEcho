import path from 'node:path';
import { BackupService, backupSafePath, readBackupFile } from '../lib/backup_service.mjs';
import { backupError, sha256 } from '../lib/backup_format.mjs';
import { resolveRuntimePaths, resolveApplicationRuntimeContext } from '../lib/runtime_config.mjs';
import { parseRunnerArgs } from './args.mjs';
import { resolveRunnerConfiguration } from './config_loader.mjs';
import { createInterface } from 'node:readline/promises';

async function confirmTarget(summary, { stdin, stderr, confirmRestore }) {
  // Test harnesses inject a callback, never a production env flag or --force.
  if (confirmRestore) return await confirmRestore(summary) === true;
  if (!stdin.isTTY || !stderr.isTTY) return false;
  stderr.write(JSON.stringify(summary) + '\n');
  const terminal = createInterface({ input: stdin, output: stderr });
  try { return await terminal.question('Type REPLACE ' + summary.target + ' to confirm replacement (or rollback): ') === 'REPLACE ' + summary.target; }
  finally { terminal.close(); }
}

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
export async function backupMain(argv, { env = process.env, cwd, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, confirmRestore } = {}) {
  let password;
  try {
    const action = argv[0];
    if (['--restore-existing', '--restore-preflight', '--restore-recover', '--restore-rollback'].includes(action)) {
      const { RestoreTransaction } = await import('../recovery/restore_transaction.mjs');
      const transaction = new RestoreTransaction({ applicationRoot: cwd, env });
      const confirm = summary => confirmTarget(summary, { stdin, stderr, confirmRestore });
      let result;
      if (['--restore-recover', '--restore-rollback'].includes(action)) {
        if (argv.length !== 3 || argv[1] !== '--target-data-root' || !path.isAbsolute(argv[2] || '')) throw backupError('BACKUP_ARGUMENT_INVALID');
        result = await transaction.recover({ target: argv[2], rollback: action === '--restore-rollback', confirm });
      } else {
        if (![4, 5].includes(argv.length) || argv[2] !== '--target-data-root' || !path.isAbsolute(argv[1] || '') || !path.isAbsolute(argv[3] || '') || argv.length === 5 && argv[4] !== '--password-stdin') throw backupError('BACKUP_ARGUMENT_INVALID');
        // Non-interactive replacement is refused before consuming the password.
        if (action === '--restore-existing' && !confirmRestore && !stdin.isTTY) throw Object.assign(new Error('RESTORE_CONFIRMATION_REQUIRED'), { code: 'RESTORE_CONFIRMATION_REQUIRED' });
        password = await readBackupPassword(stdin, stderr, argv.includes('--password-stdin'));
        const input = { input: argv[1], target: argv[3], password, confirm };
        result = action === '--restore-preflight' ? await transaction.preflight(input) : await transaction.replace(input);
      }
      stdout.write(JSON.stringify(result) + '\n'); return 0;
    }
    if (action === '--restore-backup') {
      if (![4, 5].includes(argv.length) || argv[2] !== '--target-data-root' || argv.length === 5 && argv[4] !== '--password-stdin' || !path.isAbsolute(argv[1] || '') || !path.isAbsolute(argv[3] || '')) throw backupError('BACKUP_ARGUMENT_INVALID');
      password = await readBackupPassword(stdin, stderr, argv.includes('--password-stdin'));
      const { RestoreService } = await import('../lib/restore_service.mjs');
      const result = await new RestoreService({ ...(cwd ? { applicationRoot: cwd } : {}), env }).restore({ input: argv[1], target: argv[3], password });
      stdout.write(JSON.stringify(result) + '\n'); return 0;
    }
    if (!['--backup', '--verify-backup', '--verify-backup-data'].includes(action) || !argv[1] || argv[1].startsWith('--') || argv.slice(2).some(x => x !== '--password-stdin') || argv.length > 3) throw backupError('BACKUP_ARGUMENT_INVALID');
    if (!path.isAbsolute(argv[1])) throw backupError('BACKUP_PATH_ABSOLUTE_REQUIRED');
    password = await readBackupPassword(stdin, stderr, argv.includes('--password-stdin'));
    let context;
    if (action !== '--verify-backup') {
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
    const result = action === '--backup' ? await service.create({ output: argv[1], password })
      : action === '--verify-backup-data' ? await service.verifyData({ input: argv[1], password }) : await service.verify({ input: argv[1], password });
    stdout.write(JSON.stringify(result) + '\n'); return 0;
  } catch (error) {
    const code = /^(?:BACKUP|RESTORE)_[A-Z_]+$/.test(error?.code) ? error.code : ['ENOSPC', 'EACCES', 'EPERM'].includes(error?.code) ? `BACKUP_${error.code}` : 'BACKUP_FAILED';
    stdout.write(JSON.stringify({ schemaVersion: 1, status: 'failed', code }) + '\n'); return 2;
  } finally { password?.fill(0); }
}
