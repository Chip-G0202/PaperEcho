import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrateApplicationConfig } from '../lib/application_config_migration.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 2 || argv[0] !== '--root') throw new Error('CONFIG_MIGRATION_REQUIRES_ROOT');
  const root = path.resolve(argv[1]);
  // The caller supplies legacy environment; importing this command never loads a repository .env.
  return migrateApplicationConfig({ root, env });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((result) => console.log(JSON.stringify(result))).catch(() => { console.error('CONFIG_MIGRATION_FAILED: check legacy configuration; original files retained.'); process.exitCode = 1; });
}
