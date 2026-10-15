import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnvFile } from './env_file_parser.mjs';
import { markLocalCredential, credentialOrigin, copyEnvironment } from './credential_registry.mjs';
export { parseEnvFile } from './env_file_parser.mjs';

export function resolveDotEnvPath() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "../../..");
  return path.join(repoRoot, ".env");
}

export function loadDotEnv({ env = process.env, envPath = resolveDotEnvPath() } = {}) {
  if (env.PAPERECHO_SKIP_DOTENV === '1') return env;
  if (!fs.existsSync(envPath)) return;

  let parsed = null;
  try {
    parsed = parseEnvFile(fs.readFileSync(envPath, "utf8"));
  } catch {
    return;
  }

  for (const [key, value] of Object.entries(parsed || {})) {
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

loadDotEnv();
