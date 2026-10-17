import fs from "node:fs";
import path from "node:path";
import { resolveRuntimePaths, assertRuntimeDataPath } from './runtime_config.mjs';

import { parseEnvFile } from './env_file_parser.mjs';
import { markLocalCredential, credentialOrigin, copyEnvironment } from './credential_registry.mjs';
export { parseEnvFile } from './env_file_parser.mjs';

export function resolveDotEnvPath({ env = process.env } = {}) {
  const paths = resolveRuntimePaths({ env });
  return assertRuntimeDataPath(paths, paths.secretPath);
}

export function loadDotEnv({ env = process.env, envPath = resolveDotEnvPath({ env }) } = {}) {
  if (env.PAPERECHO_SKIP_DOTENV === '1') return env;
  const paths = resolveRuntimePaths({ env });
  assertRuntimeDataPath(paths, path.resolve(envPath));
  if (!fs.existsSync(envPath)) return;
  if (paths.layout !== 'dev') {
    const stat = fs.lstatSync(envPath);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('RUNTIME_SECRET_PATH_UNSAFE');
  }

  let parsed = null;
  try {
    parsed = parseEnvFile(fs.readFileSync(envPath, "utf8"));
  } catch {
    return;
  }

  for (const [key, value] of Object.entries(parsed || {})) {
    if (['PAPERECHO_LAYOUT', 'PAPERECHO_APPLICATION_ROOT', 'PAPERECHO_RESOURCE_ROOT', 'PAPERECHO_DATA_ROOT', 'PAPERECHO_CACHE_ROOT', 'PAPERECHO_WORKSPACE_ID'].includes(key)) continue;
    if (!(key in env)) {
      env[key] = value;
      markLocalCredential(env, key, path.resolve(envPath));
    }
  }
  return env;
}

// A freshly launched Control Center must load local values itself. External
// injections, including identical values, remain untouched and win as before.
export function environmentForControlChild(env) {
  const child = copyEnvironment(env);
  for (const name of Object.keys(child)) if (credentialOrigin(env, name).kind === 'local-managed') delete child[name];
  return child;
}

if (!process.argv.some(x => ['--backup', '--verify-backup', '--restore-backup'].includes(x))) loadDotEnv();
