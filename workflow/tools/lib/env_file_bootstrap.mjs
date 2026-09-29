import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseEnvFile } from './env_file_parser.mjs';
export { parseEnvFile } from './env_file_parser.mjs';

export function resolveDotEnvPath() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "../../..");
  return path.join(repoRoot, ".env");
}

function loadDotEnv() {
  if (process.env.PAPERECHO_SKIP_DOTENV === '1') return;
  const envPath = resolveDotEnvPath();
  if (!fs.existsSync(envPath)) return;

  let parsed = null;
  try {
    parsed = parseEnvFile(fs.readFileSync(envPath, "utf8"));
  } catch {
    return;
  }

  for (const [key, value] of Object.entries(parsed || {})) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();
