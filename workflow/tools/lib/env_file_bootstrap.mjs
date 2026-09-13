import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseEnvFile(text) {
  const out = {};
  const lines = String(text || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    let value = line.slice(idx + 1);
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      value = trimmed.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trimEnd();
    }
    out[key] = value;
  }
  return out;
}

export function resolveDotEnvPath() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "../../..");
  return path.join(repoRoot, ".env");
}

function loadDotEnv() {
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
