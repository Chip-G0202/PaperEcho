#!/usr/bin/env node

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const OFFICIAL_REPO = "https://github.com/Chip-G0202/PaperEcho.git";
export const CONTRACT_REL = "skills/paperecho-update/references/update-contract.json";
export const UPDATE_STATE_REL = ".paperecho/update/state.json";
export const UPDATE_LOCK_REL = ".paperecho/update/update.lock.json";
export const CONTRACT_SCHEMA_VERSION = 1;
export const UPDATER_STATE_SCHEMA_VERSION = 1;
export const UPDATE_LOCK_TTL_MS = 30 * 60 * 1000;

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const STABLE_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;

function slash(value) { return String(value).replaceAll("\\", "/"); }
function uniq(values) { return [...new Set(values)]; }
function existsSync(file) { try { fsSync.accessSync(file); return true; } catch { return false; } }
function cleanError(error) { return String(error?.message || error || "unknown_error").replace(/[\r\n]+/g, " ").slice(0, 500); }

export function parseStableTag(tag) {
  const match = STABLE_RE.exec(String(tag || ""));
  if (!match) return null;
  return { tag, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0), explicitPatch: match[3] != null };
}

export function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  return 0;
}

export function parseRemoteTags(text) {
  const refs = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^([0-9a-f]{40,64})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (!match) continue;
    const tag = match[2];
    const record = refs.get(tag) || { tag, object: null, commit: null };
    if (match[3]) record.commit = match[1];
    else { record.object = match[1]; if (!record.commit) record.commit = match[1]; }
    refs.set(tag, record);
  }
  return [...refs.values()];
}

export function selectLatestStable(records) {
  const stable = records.map((record) => ({ ...record, version: parseStableTag(record.tag) })).filter((record) => record.version && record.commit);
  const groups = new Map();
  for (const record of stable) {
    const key = `${record.version.major}.${record.version.minor}.${record.version.patch}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  for (const [key, group] of groups) {
    if (new Set(group.map((record) => record.commit)).size > 1) {
      const error = new Error(`AMBIGUOUS_SEMANTIC_VERSION_${key}`);
      error.code = "ambiguous_semantic_version";
      error.tags = group.map((record) => record.tag).sort();
      throw error;
    }
  }
  stable.sort((a, b) => compareVersions(b.version, a.version) || Number(a.version.explicitPatch) - Number(b.version.explicitPatch) || a.tag.localeCompare(b.tag));
  if (!stable.length) throw Object.assign(new Error("NO_STABLE_RELEASE_TAG"), { code: "no_stable_release" });
  const selected = stable[0];
  const equivalentTags = stable.filter((record) => compareVersions(record.version, selected.version) === 0).map((record) => record.tag).sort();
  return { ...selected, equivalentTags };
}

export function normalizeRepoUrl(value) {
  let normalized = String(value || "").trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  normalized = normalized.replace(/^git@github\.com:/i, "https://github.com/").replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/");
  return normalized.toLowerCase();
}

export function isOfficialRepo(value) { return normalizeRepoUrl(value) === normalizeRepoUrl(OFFICIAL_REPO); }

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", windowsHide: true, env: options.env || process.env, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${command} failed: ${String(result.stderr || result.stdout || "").trim().slice(0, 500)}`);
    error.code = "command_failed";
    error.status = result.status;
    throw error;
  }
  return String(result.stdout || "").trim();
}

export function git(args, cwd, runner = runCommand) { return runner("git", args, { cwd }); }

export function validateRelativePath(relative) {
  const raw = String(relative || "");
  const normalized = slash(raw);
  if (!raw || path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw Object.assign(new Error(`UNSAFE_RELATIVE_PATH_${raw}`), { code: "unsafe_path" });
  }
  return normalized.replace(/^\.\//, "");
}

export async function resolveInside(root, relative, { allowMissing = true } = {}) {
  const safe = validateRelativePath(relative);
  const rootReal = await fs.realpath(root);
  const target = path.resolve(rootReal, ...safe.split("/"));
  const prefix = `${rootReal}${path.sep}`;
  if (target !== rootReal && !target.startsWith(prefix)) throw Object.assign(new Error("PATH_ESCAPE"), { code: "path_escape" });
  let cursor = target;
  while (cursor !== rootReal) {
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) {
        const resolved = await fs.realpath(cursor);
        if (resolved !== rootReal && !resolved.startsWith(prefix)) throw Object.assign(new Error("SYMLINK_ESCAPE"), { code: "symlink_escape" });
      }
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      cursor = path.dirname(cursor);
    }
  }
  if (!allowMissing) await fs.lstat(target);
  return target;
}

export function validateContract(contract) {
  if (!contract || contract.schemaVersion !== CONTRACT_SCHEMA_VERSION) throw Object.assign(new Error("UPDATE_CONTRACT_UNSUPPORTED"), { code: "contract_unsupported" });
  if (!isOfficialRepo(contract.sourceRepo)) throw Object.assign(new Error("UPDATE_CONTRACT_REPO_MISMATCH"), { code: "contract_repo_mismatch" });
  for (const key of ["managedRoots", "managedFiles", "managedConfigFiles", "persistentRoots", "persistentFiles"]) {
    if (!Array.isArray(contract[key])) throw Object.assign(new Error(`UPDATE_CONTRACT_${key}_MISSING`), { code: "contract_invalid" });
    contract[key].forEach(validateRelativePath);
  }
  if (!contract.compatibility || contract.managedManifestVersion !== 1) throw Object.assign(new Error("UPDATE_CONTRACT_COMPATIBILITY_MISSING"), { code: "contract_invalid" });
  return contract;
}

export async function readContract(root) {
  try { return validateContract(JSON.parse(await fs.readFile(path.join(root, ...CONTRACT_REL.split("/")), "utf8"))); }
  catch (error) { if (error?.code === "ENOENT") throw Object.assign(new Error("UPDATE_CONTRACT_MISSING"), { code: "contract_missing" }); throw error; }
}

async function readGitOrigin(root, runner = runCommand) {
  try { return git(["remote", "get-url", "origin"], root, runner); } catch { return ""; }
}

export async function validateInstallCandidate(root, { runner = runCommand } = {}) {
  const absolute = path.resolve(root);
  const markers = ["workflow", "skills", "package.json", "AGENTS.md", "workflow/tools/runner/main.mjs", "skills/paperecho-workflow"];
  const evidence = markers.filter((relative) => existsSync(path.join(absolute, ...relative.split("/"))));
  const gitInstall = existsSync(path.join(absolute, ".git"));
  const origin = gitInstall ? await readGitOrigin(absolute, runner) : "";
  const wrongRemote = Boolean(origin && !isOfficialRepo(origin));
  return { path: absolute, valid: evidence.length >= 5 && !wrongRemote, confidence: evidence.length + (isOfficialRepo(origin) ? 3 : 0), evidence, gitInstall, origin: origin ? (isOfficialRepo(origin) ? OFFICIAL_REPO : "non_official") : "", wrongRemote };
}

async function boundedDirectories(root, maxDepth = 3, limit = 2000) {
  const out = [];
  const queue = [{ dir: path.resolve(root), depth: 0 }];
  while (queue.length && out.length < limit) {
    const current = queue.shift();
    let entries;
    try { entries = await fs.readdir(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink?.() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const dir = path.join(current.dir, entry.name);
      out.push(dir);
      if (current.depth + 1 < maxDepth) queue.push({ dir, depth: current.depth + 1 });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function documentRoots({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const roots = [];
  if (platform === "win32") {
    if (env.USERPROFILE) roots.push(path.join(env.USERPROFILE, "Documents"), path.join(env.USERPROFILE, "OneDrive", "Documents"));
    for (const [key, value] of Object.entries(env)) if (/^OneDrive/i.test(key) && value) roots.push(path.join(value, "Documents"));
  } else if (platform === "darwin") {
    roots.push(path.join(home, "Documents"), path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Documents"));
  }
  return uniq(roots.map((item) => path.resolve(item))).filter(existsSync);
}

export async function detectInstallations({ installDir, cwd = process.cwd(), platform = process.platform, env = process.env, home = os.homedir(), runner = runCommand, searchDepth = 3 } = {}) {
  const direct = [];
  if (installDir) direct.push(path.resolve(installDir));
  else {
    let cursor = path.resolve(cwd);
    for (let depth = 0; depth <= 3; depth += 1) { direct.push(cursor); const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent; }
  }
  const candidates = [];
  if (!installDir) for (const root of documentRoots({ platform, env, home })) candidates.push(root, ...(await boundedDirectories(root, searchDepth)));
  const checked = [];
  for (const candidate of uniq([...direct, ...candidates])) {
    const result = await validateInstallCandidate(candidate, { runner });
    if (result.valid || result.wrongRemote) checked.push(result);
  }
  const valid = checked.filter((item) => item.valid).sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path));
  if (installDir && !valid.length) throw Object.assign(new Error("INSTALL_DIR_NOT_PAPERECHO"), { code: checked.some((item) => item.wrongRemote) ? "wrong_remote" : "install_not_found", candidates: checked });
  if (valid.length > 1) throw Object.assign(new Error("MULTIPLE_INSTALLATIONS"), { code: "multiple_installations", candidates: valid });
  if (!valid.length) throw Object.assign(new Error("PAPERECHO_INSTALL_NOT_FOUND"), { code: "install_not_found", candidates: checked });
  return valid[0];
}

export async function readUpdaterState(root) {
  try {
    const state = JSON.parse(await fs.readFile(path.join(root, ...UPDATE_STATE_REL.split("/")), "utf8"));
    if (state.schemaVersion !== UPDATER_STATE_SCHEMA_VERSION || !isOfficialRepo(state.sourceRepo)) throw new Error("UPDATER_STATE_UNTRUSTED");
    return state;
  } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

export async function inspectCurrentVersion(root, { runner = runCommand } = {}) {
  const gitInstall = existsSync(path.join(root, ".git"));
  if (!gitInstall) {
    const state = await readUpdaterState(root);
    return state ? { gitInstall: false, currentVersion: state.installedTag, currentCommit: state.installedCommit, developerCheckout: false, state } : { gitInstall: false, currentVersion: null, currentCommit: null, developerCheckout: true, state: null };
  }
  const origin = await readGitOrigin(root, runner);
  const head = git(["rev-parse", "HEAD"], root, runner);
  const tags = git(["tag", "--points-at", "HEAD"], root, runner).split(/\r?\n/).filter(Boolean).map((tag) => ({ tag, commit: head }));
  let current = null;
  try { if (tags.length) current = selectLatestStable(tags); } catch {}
  return { gitInstall: true, origin, currentVersion: current?.tag || null, currentCommit: head, developerCheckout: !current || !isOfficialRepo(origin), state: await readUpdaterState(root).catch(() => null) };
}

export async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const data = await fs.readFile(file);
  hash.update(data);
  return { hash: hash.digest("hex"), size: data.length };
}

async function walkFiles(root, relative = "", { maxDepth = 20 } = {}) {
  if (relative.split("/").filter(Boolean).length > maxDepth) throw new Error("MANAGED_TREE_TOO_DEEP");
  const directory = path.join(root, ...relative.split("/").filter(Boolean));
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const rel = slash(path.posix.join(relative, entry.name));
    if (entry.isSymbolicLink()) throw Object.assign(new Error(`UNSUPPORTED_SYMLINK_${rel}`), { code: "unsupported_symlink" });
    if (entry.isDirectory()) files.push(...await walkFiles(root, rel, { maxDepth }));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

function under(relative, root) { return relative === root || relative.startsWith(`${root}/`); }
export function isPersistentPath(relative, contract) {
  const rel = slash(relative);
  if ((contract.managedConfigFiles || []).includes(rel)) return false;
  return contract.persistentFiles.includes(rel) || contract.persistentRoots.some((root) => under(rel, slash(root)));
}

export function isManagedPath(relative, contract) {
  const rel = slash(relative);
  if (isPersistentPath(rel, contract)) return false;
  return contract.managedFiles.includes(rel) || (contract.managedConfigFiles || []).includes(rel) || contract.managedRoots.some((root) => under(rel, slash(root)));
}

export async function listManagedFiles(root, contract) {
  const files = new Set();
  for (const relative of [...contract.managedFiles, ...(contract.managedConfigFiles || [])]) if (existsSync(path.join(root, ...relative.split("/")))) files.add(slash(relative));
  for (const managedRoot of contract.managedRoots) for (const file of await walkFiles(root, slash(managedRoot))) if (isManagedPath(file, contract)) files.add(file);
  return [...files].sort();
}

async function gitObjectHash(root, commit, relative, runner) {
  try { return git(["rev-parse", `${commit}:${slash(relative)}`], root, runner); }
  catch { return null; }
}

export async function buildManagedPlan({ liveRoot, targetRoot, current, oldContract, targetContract, runner = runCommand }) {
  const targetFiles = await listManagedFiles(targetRoot, targetContract);
  let oldFiles;
  const manifest = current.state?.managedManifest || {};
  if (current.gitInstall) {
    const listed = git(["ls-tree", "-r", "--name-only", current.currentCommit], liveRoot, runner).split(/\r?\n/).filter(Boolean);
    oldFiles = listed.filter((file) => isManagedPath(file, oldContract));
  } else oldFiles = Object.keys(manifest);
  const all = uniq([...oldFiles, ...targetFiles]).sort();
  const changes = [];
  const conflicts = [];
  const preflightHashes = {};
  for (const relative of all) {
    validateRelativePath(relative);
    const livePath = await resolveInside(liveRoot, relative);
    const targetPath = await resolveInside(targetRoot, relative);
    const local = existsSync(livePath) ? await hashFile(livePath) : null;
    const next = existsSync(targetPath) ? await hashFile(targetPath) : null;
    const oldHash = current.gitInstall ? await gitObjectHash(liveRoot, current.currentCommit, relative, runner) : manifest[relative]?.hash || null;
    const localIdentity = current.gitInstall && local ? git(["hash-object", `--path=${relative}`, livePath], liveRoot, runner) : local?.hash || null;
    const nextIdentity = current.gitInstall && next ? git(["hash-object", `--path=${relative}`, targetPath], targetRoot, runner) : next?.hash || null;
    if (local) preflightHashes[relative] = local.hash;
    if (!oldHash && local) { conflicts.push(relative); continue; }
    if (oldHash && (!local || localIdentity !== oldHash)) { conflicts.push(relative); continue; }
    if (!oldHash && next) changes.push({ relative, action: "add", targetHash: next.hash });
    else if (oldHash && !next) changes.push({ relative, action: "delete", oldHash });
    else if (oldHash && next && oldHash !== nextIdentity) changes.push({ relative, action: "modify", oldHash, targetHash: next.hash });
  }
  return { changes, conflicts, preflightHashes, addCount: changes.filter((item) => item.action === "add").length, modifyCount: changes.filter((item) => item.action === "modify").length, deleteCount: changes.filter((item) => item.action === "delete").length };
}

async function boundedNamedFiles(root, names, maxDepth = 6, limit = 5000) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  let seen = 0;
  while (queue.length && seen < limit) {
    const current = queue.shift();
    let entries;
    try { entries = await fs.readdir(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      if (entry.isSymbolicLink?.()) continue;
      const target = path.join(current.dir, entry.name);
      if (entry.isFile() && names.has(entry.name)) found.push(target);
      else if (entry.isDirectory() && current.depth < maxDepth && !SKIP_DIRS.has(entry.name)) queue.push({ dir: target, depth: current.depth + 1 });
      if (seen >= limit) break;
    }
  }
  return found;
}

export async function inspectActiveRun(root, { now = Date.now() } = {}) {
  const roots = [path.join(root, ".paperecho"), path.join(root, "review_results")].filter(existsSync);
  const markers = [];
  for (const scanRoot of roots) markers.push(...await boundedNamedFiles(scanRoot, new Set(["run.lock", "resume.lease.json", "current_run.json"])));
  for (const marker of markers) {
    const name = path.basename(marker);
    if (name === "run.lock") return { active: true, reason: "active_run_lock", marker: slash(path.relative(root, marker)) };
    try {
      const value = JSON.parse(await fs.readFile(marker, "utf8"));
      if (name === "resume.lease.json" && (!value.expiresAt || Date.parse(value.expiresAt) > now)) return { active: true, reason: "active_resume_lease", marker: slash(path.relative(root, marker)) };
      if (name === "current_run.json" && ["running", "started", "resuming"].includes(String(value.status).toLowerCase())) return { active: true, reason: "active_current_run", marker: slash(path.relative(root, marker)) };
    } catch { return { active: true, reason: "unreadable_run_marker", marker: slash(path.relative(root, marker)) }; }
  }
  return { active: false, reason: null, marker: null };
}

export async function acquireUpdateLock(root, { now = new Date(), ttlMs = UPDATE_LOCK_TTL_MS, ownerId = randomUUID() } = {}) {
  const lockPath = path.join(root, ...UPDATE_LOCK_REL.split("/"));
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const lock = { schemaVersion: 1, ownerId, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
  try {
    const handle = await fs.open(lockPath, "wx");
    try { await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
    return { acquired: true, lockPath, lock, takeover: null };
  } catch (error) { if (error?.code !== "EEXIST") throw error; }
  let previous;
  try { previous = JSON.parse(await fs.readFile(lockPath, "utf8")); } catch { return { acquired: false, reason: "update_lock_unreadable", lockPath }; }
  if (!previous.expiresAt || Date.parse(previous.expiresAt) > now.getTime()) return { acquired: false, reason: "update_lock_active", lockPath };
  const stalePath = `${lockPath}.stale.${String(previous.ownerId || "unknown").replace(/[^A-Za-z0-9_-]/g, "-")}`;
  try { await fs.rename(lockPath, stalePath); } catch { return { acquired: false, reason: "update_lock_race", lockPath }; }
  const acquired = await acquireUpdateLock(root, { now, ttlMs, ownerId });
  acquired.takeover = { stalePath };
  return acquired;
}

export async function releaseUpdateLock(handle) {
  if (!handle?.acquired) return false;
  try {
    const current = JSON.parse(await fs.readFile(handle.lockPath, "utf8"));
    if (current.ownerId !== handle.lock.ownerId) return false;
    await fs.unlink(handle.lockPath);
    return true;
  } catch { return false; }
}

export async function resolveLatestRemote({ runner = runCommand, repo = OFFICIAL_REPO } = {}) {
  if (!isOfficialRepo(repo)) throw Object.assign(new Error("UNTRUSTED_REPOSITORY"), { code: "untrusted_repository" });
  return selectLatestStable(parseRemoteTags(runner("git", ["ls-remote", "--tags", OFFICIAL_REPO], {})));
}

export async function stageTarget(target, { runner = runCommand, repo = OFFICIAL_REPO, tempRoot = os.tmpdir() } = {}) {
  if (!isOfficialRepo(repo)) throw Object.assign(new Error("UNTRUSTED_REPOSITORY"), { code: "untrusted_repository" });
  const staging = await fs.mkdtemp(path.join(tempRoot, "paperecho-update-stage-"));
  try {
    runner("git", ["clone", "--quiet", "--no-checkout", OFFICIAL_REPO, staging], {});
    runner("git", ["checkout", "--quiet", "--detach", target.tag], { cwd: staging });
    const origin = runner("git", ["remote", "get-url", "origin"], { cwd: staging });
    const commit = runner("git", ["rev-parse", "HEAD"], { cwd: staging });
    const exact = runner("git", ["tag", "--points-at", "HEAD"], { cwd: staging }).split(/\r?\n/);
    if (!isOfficialRepo(origin) || commit !== target.commit || !exact.includes(target.tag)) throw Object.assign(new Error("STAGED_TARGET_MISMATCH"), { code: "target_mismatch" });
    return { staging, contract: await readContract(staging), commit };
  } catch (error) { await fs.rm(staging, { recursive: true, force: true }); throw error; }
}

export async function validateCompatibility(root, contract) {
  const probes = [
    ["config/paperecho.config.json", "configSchemaVersions"],
    ["review_results/source_state.json", "sourceStateSchemaVersions"],
    ["review_results/operation_ledger.json", "operationLedgerSchemaVersions"],
    ["review_results/notification_receipt.json", "notificationReceiptSchemaVersions", "schemaVersion"],
    ["review_results/shared/current_literature_index.json", "literatureIndexSchemaVersions", "schema_version"],
  ];
  const checked = [];
  for (const [relative, key, versionField = "schemaVersion"] of probes) {
    const file = path.join(root, ...relative.split("/"));
    if (!existsSync(file)) continue;
    const stat = await fs.stat(file);
    if (stat.size > 1024 * 1024) throw Object.assign(new Error(`STATE_TOO_LARGE_${relative}`), { code: "state_unverifiable" });
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(contract.compatibility[key]) || !contract.compatibility[key].includes(value[versionField])) throw Object.assign(new Error(`SCHEMA_INCOMPATIBLE_${relative}`), { code: "schema_incompatible" });
    checked.push(relative);
  }
  return { compatible: true, checked };
}

export async function validateStaging(staging, { lockfileChanged = false, runner = runCommand } = {}) {
  for (const relative of ["skills/paperecho-update/scripts/update.mjs", "workflow/tools/runner/main.mjs"]) runner(process.execPath, ["--check", relative], { cwd: staging });
  runner(process.execPath, ["--input-type=module", "-e", "await import('./workflow/tools/runner/main.mjs'); await import('./workflow/tools/runner/config_loader.mjs')"], { cwd: staging });
  if (lockfileChanged) runner(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts"], { cwd: staging });
  return true;
}

async function snapshotFiles(root, relatives, snapshotRoot) {
  const records = [];
  for (const relative of uniq(relatives).sort()) {
    const source = await resolveInside(root, relative);
    const record = { relative, existed: existsSync(source), hash: null, size: 0 };
    if (record.existed) {
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`SNAPSHOT_UNSUPPORTED_${relative}`);
      const digest = await hashFile(source);
      Object.assign(record, digest);
      const target = path.join(snapshotRoot, "files", ...relative.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
    records.push(record);
  }
  const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), files: records };
  await fs.writeFile(path.join(snapshotRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

async function atomicCopy(source, target, ownerId) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.paperecho-update-${ownerId}-${path.basename(target)}.tmp`);
  await fs.copyFile(source, temporary);
  await fs.rename(temporary, target);
}

export async function restoreSnapshot(root, snapshotRoot, manifest) {
  for (const record of manifest.files) {
    const target = await resolveInside(root, record.relative);
    if (record.existed) await atomicCopy(path.join(snapshotRoot, "files", ...record.relative.split("/")), target, "rollback");
    else await fs.unlink(target).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
  for (const record of manifest.files) {
    const target = await resolveInside(root, record.relative);
    if (!record.existed) { if (existsSync(target)) return false; }
    else if ((await hashFile(target)).hash !== record.hash) return false;
  }
  return true;
}

export async function verifyPreflightHashes(root, hashes) {
  for (const [relative, expected] of Object.entries(hashes)) {
    const file = await resolveInside(root, relative);
    if (!existsSync(file) || (await hashFile(file)).hash !== expected) return false;
  }
  return true;
}

export async function transactionalFileDeploy({ liveRoot, targetRoot, plan, persistentFiles = [], hooks = {} }) {
  const ownerId = randomUUID();
  const updateRoot = path.join(liveRoot, ".paperecho", "update");
  const snapshotRoot = path.join(updateRoot, "snapshots", `${Date.now()}-${ownerId}`);
  await fs.mkdir(snapshotRoot, { recursive: true });
  const affected = [...plan.changes.map((item) => item.relative), ...persistentFiles];
  const manifest = await snapshotFiles(liveRoot, affected, snapshotRoot);
  let liveModificationStarted = false;
  try {
    let index = 0;
    for (const change of plan.changes) {
      await hooks.beforeWrite?.(change, index);
      const live = await resolveInside(liveRoot, change.relative);
      if (change.action === "delete") { await fs.unlink(live); liveModificationStarted = true; }
      else { await atomicCopy(await resolveInside(targetRoot, change.relative, { allowMissing: false }), live, ownerId); liveModificationStarted = true; }
      await hooks.afterWrite?.(change, index);
      index += 1;
    }
    await hooks.validate?.();
    return { ok: true, snapshotRoot, manifest, liveModificationStarted, rollbackAttempted: false, rollbackVerified: false };
  } catch (error) {
    const rollbackVerified = liveModificationStarted ? await restoreSnapshot(liveRoot, snapshotRoot, manifest).catch(() => false) : true;
    return { ok: false, error: cleanError(error), snapshotRoot, manifest, liveModificationStarted, rollbackAttempted: liveModificationStarted, rollbackVerified };
  }
}

async function listPersistentFiles(root, contract) {
  const files = [];
  for (const relative of contract.persistentFiles) if (existsSync(path.join(root, ...relative.split("/")))) files.push(relative);
  for (const persistentRoot of contract.persistentRoots) {
    if (persistentRoot === "node_modules" || under(persistentRoot, ".paperecho/update")) continue;
    for (const file of await walkFiles(root, persistentRoot, { maxDepth: 12 }).catch(() => [])) if (!under(file, ".paperecho/update") && isPersistentPath(file, contract)) files.push(file);
  }
  return uniq(files).sort();
}

export async function transactionalGitDeploy({ liveRoot, targetRoot, target, plan, contract, runner = runCommand, hooks = {} }) {
  const ownerId = randomUUID();
  const snapshotRoot = path.join(liveRoot, ".paperecho", "update", "snapshots", `${Date.now()}-${ownerId}`);
  await fs.mkdir(snapshotRoot, { recursive: true });
  const tracked = git(["ls-files"], liveRoot, runner).split(/\r?\n/).filter(Boolean);
  const targetPersistent = targetRoot ? await listPersistentFiles(targetRoot, contract) : [];
  const oldTrackedPersistent = tracked.filter((relative) => isPersistentPath(slash(relative), contract));
  const protectedPersistent = uniq([...oldTrackedPersistent, ...targetPersistent]);
  const affected = uniq([...plan.changes.map((item) => item.relative), ...protectedPersistent]);
  const manifest = await snapshotFiles(liveRoot, affected, snapshotRoot);
  const oldCommit = git(["rev-parse", "HEAD"], liveRoot, runner);
  let branch = null;
  try { branch = git(["symbolic-ref", "--short", "-q", "HEAD"], liveRoot, runner); } catch {}
  let liveModificationStarted = false;
  let transitioned = false;
  try {
    await hooks.beforeTransition?.();
    if (oldTrackedPersistent.length) git(["checkout", "--quiet", oldCommit, "--", ...oldTrackedPersistent], liveRoot, runner);
    liveModificationStarted = oldTrackedPersistent.length > 0;
    git(["fetch", "--quiet", "--no-tags", "origin", `refs/tags/${target.tag}`], liveRoot, runner);
    if (git(["rev-parse", "FETCH_HEAD"], liveRoot, runner) !== target.commit) throw new Error("LIVE_FETCH_TARGET_MISMATCH");
    if (branch) git(["merge", "--ff-only", "--no-edit", target.commit], liveRoot, runner);
    else git(["checkout", "--quiet", "--detach", target.commit], liveRoot, runner);
    transitioned = true;
    liveModificationStarted = true;
    await restoreSnapshot(liveRoot, snapshotRoot, { ...manifest, files: manifest.files.filter((item) => protectedPersistent.includes(item.relative)) });
    await hooks.validate?.();
    return { ok: true, snapshotRoot, manifest, liveModificationStarted, rollbackAttempted: false, rollbackVerified: false, branch, oldCommit };
  } catch (error) {
    let rollbackVerified = !liveModificationStarted;
    if (liveModificationStarted) {
      try {
        if (transitioned) {
          if (branch) git(["update-ref", `refs/heads/${branch}`, oldCommit, target.commit], liveRoot, runner);
          else git(["update-ref", "HEAD", oldCommit, target.commit], liveRoot, runner);
          git(["read-tree", oldCommit], liveRoot, runner);
        }
        rollbackVerified = await restoreSnapshot(liveRoot, snapshotRoot, manifest);
        rollbackVerified = rollbackVerified && git(["rev-parse", "HEAD"], liveRoot, runner) === oldCommit;
      } catch { rollbackVerified = false; }
    }
    return { ok: false, error: cleanError(error), snapshotRoot, manifest, liveModificationStarted, rollbackAttempted: liveModificationStarted, rollbackVerified, branch, oldCommit };
  }
}

async function persistentIntegrity(root, contract) {
  const files = await listPersistentFiles(root, contract);
  const snapshot = {};
  for (const relative of uniq(files)) { const value = await hashFile(path.join(root, ...relative.split("/"))); snapshot[relative] = value; }
  return snapshot;
}

function equalIntegrity(before, after) {
  const keys = uniq([...Object.keys(before), ...Object.keys(after)]).sort();
  return keys.every((key) => before[key]?.hash === after[key]?.hash && before[key]?.size === after[key]?.size);
}

export async function writeUpdaterState(root, state) {
  const target = path.join(root, ...UPDATE_STATE_REL.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
}

async function pruneSnapshots(root, keep = 2) {
  const directory = path.join(root, ".paperecho", "update", "snapshots");
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
  const owned = [];
  for (const entry of entries) if (entry.isDirectory() && existsSync(path.join(directory, entry.name, "manifest.json"))) owned.push(entry.name);
  for (const name of owned.sort().slice(0, Math.max(0, owned.length - keep))) await fs.rm(path.join(directory, name), { recursive: true, force: true });
}

export async function preflight(options = {}, deps = {}) {
  const runner = deps.runner || runCommand;
  const blockers = [];
  let install;
  let target;
  let staged;
  let current;
  let plan = { changes: [], conflicts: [], preflightHashes: {}, addCount: 0, modifyCount: 0, deleteCount: 0 };
  let activeRun = { active: false };
  let compatibility = { compatible: false };
  try { install = await detectInstallations({ installDir: options.installDir, cwd: options.cwd, platform: options.platform, env: options.env, home: options.home, runner }); }
  catch (error) { blockers.push(error.code || "install_detection_failed"); return { status: "blocked", safeToApply: false, blockers, error: cleanError(error), candidates: error.candidates || [] }; }
  try { target = await resolveLatestRemote({ runner }); } catch (error) { blockers.push(error.code || "remote_unavailable"); }
  try { current = await inspectCurrentVersion(install.path, { runner }); } catch (error) { blockers.push("current_version_unverified"); }
  if (current?.developerCheckout) blockers.push("developer_checkout");
  if (current?.origin && !isOfficialRepo(current.origin)) blockers.push("wrong_remote");
  if (target && current?.currentVersion) {
    const comparison = compareVersions(parseStableTag(current.currentVersion), target.version);
    if (comparison > 0) blockers.push("downgrade_forbidden");
  }
  if (target) {
    try {
      staged = await stageTarget(target, { runner, tempRoot: deps.tempRoot || os.tmpdir() });
      const oldContract = await readContract(install.path);
      compatibility = await validateCompatibility(install.path, staged.contract);
      if (current?.currentVersion) plan = await buildManagedPlan({ liveRoot: install.path, targetRoot: staged.staging, current, oldContract, targetContract: staged.contract, runner });
      if (current?.gitInstall) {
        try { git(["merge-base", "--is-ancestor", current.currentCommit, target.commit], staged.staging, runner); }
        catch { blockers.push("non_fast_forward"); }
      }
      if (plan.conflicts.length) blockers.push("managed_conflict");
      const liveLock = existsSync(path.join(install.path, "package-lock.json")) ? (await hashFile(path.join(install.path, "package-lock.json"))).hash : null;
      const targetLock = existsSync(path.join(staged.staging, "package-lock.json")) ? (await hashFile(path.join(staged.staging, "package-lock.json"))).hash : null;
      const lockfileChanged = liveLock !== targetLock;
      await validateStaging(staged.staging, { lockfileChanged, runner });
      staged.lockfileChanged = lockfileChanged;
    } catch (error) { blockers.push(error.code || "staging_validation_failed"); }
  }
  activeRun = await inspectActiveRun(install.path);
  if (activeRun.active) blockers.push("active_run");
  const comparableVersion = Boolean(target && current?.currentVersion);
  const versionComparison = comparableVersion ? compareVersions(parseStableTag(current.currentVersion), target.version) : null;
  const updateAvailable = versionComparison != null && versionComparison < 0;
  if (versionComparison === 0) blockers.push("already_latest");
  const safeToApply = blockers.length === 0 && updateAvailable;
  return { status: safeToApply ? "ready" : "blocked", platform: options.platform || process.platform, installPath: install.path, detectionEvidence: install.evidence, currentVersion: current?.currentVersion || null, currentCommit: current?.currentCommit || null, latestStableTag: target?.tag || null, latestCommit: target?.commit || null, updateAvailable, developerCheckout: current?.developerCheckout ?? true, configCompatible: compatibility.compatible === true, stateCompatible: compatibility.compatible === true, contractCompatible: Boolean(staged?.contract), activeRun: activeRun.active, lockfileChanged: staged?.lockfileChanged ?? null, managedChanges: { addCount: plan.addCount, modifyCount: plan.modifyCount, deleteCount: plan.deleteCount }, persistentProtectedCount: staged ? Object.keys(await persistentIntegrity(install.path, staged.contract)).length : 0, conflicts: plan.conflicts, safeToApply, blockers: uniq(blockers), _internal: { install, target, staged, current, plan } };
}

function publicReport(report) { const { _internal, ...safe } = report; return safe; }

export async function applyUpdate(options = {}, deps = {}) {
  const report = await preflight(options, deps);
  if (!report.safeToApply) { if (report._internal?.staged?.staging) await fs.rm(report._internal.staged.staging, { recursive: true, force: true }); return publicReport(report); }
  const { install, target, staged, current, plan } = report._internal;
  let lock;
  let transaction;
  let beforePersistent;
  try {
    lock = await acquireUpdateLock(install.path, deps.lockOptions);
    if (!lock.acquired) return { status: "blocked", safeToApply: false, failedStage: "update_lock", liveModificationStarted: false, rollbackAttempted: false, rollbackVerified: false, blockers: [lock.reason] };
    if ((await inspectActiveRun(install.path)).active) throw Object.assign(new Error("ACTIVE_RUN_AFTER_PREFLIGHT"), { stage: "toctou", code: "active_run" });
    const currentAgain = await inspectCurrentVersion(install.path, { runner: deps.runner || runCommand });
    if (currentAgain.currentCommit !== current.currentCommit || currentAgain.currentVersion !== current.currentVersion) throw Object.assign(new Error("CURRENT_VERSION_CHANGED_AFTER_PREFLIGHT"), { stage: "toctou", code: "current_version_toctou" });
    if (!await verifyPreflightHashes(install.path, plan.preflightHashes)) throw Object.assign(new Error("MANAGED_CHANGED_AFTER_PREFLIGHT"), { stage: "toctou", code: "managed_toctou" });
    const latestAgain = await resolveLatestRemote({ runner: deps.runner || runCommand });
    if (latestAgain.tag !== target.tag || latestAgain.commit !== target.commit) throw Object.assign(new Error("TARGET_CHANGED_AFTER_PREFLIGHT"), { stage: "toctou", code: "target_toctou" });
    beforePersistent = await persistentIntegrity(install.path, staged.contract);
    transaction = current.gitInstall
      ? await transactionalGitDeploy({ liveRoot: install.path, targetRoot: staged.staging, target, plan, contract: staged.contract, runner: deps.runner || runCommand, hooks: deps.hooks || {} })
      : await transactionalFileDeploy({ liveRoot: install.path, targetRoot: staged.staging, plan, hooks: deps.hooks || {} });
    if (!transaction.ok) throw Object.assign(new Error(transaction.error), { stage: "deploy", transaction });
    if (staged.lockfileChanged) (deps.runner || runCommand)(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts"], { cwd: install.path });
    await validateStaging(install.path, { lockfileChanged: false, runner: deps.runner || runCommand });
    if (current.gitInstall && git(["rev-parse", "HEAD"], install.path, deps.runner || runCommand) !== target.commit) throw Object.assign(new Error("DEPLOYED_COMMIT_MISMATCH"), { stage: "post_validation" });
    for (const change of plan.changes) {
      const live = await resolveInside(install.path, change.relative);
      if (change.action === "delete") { if (existsSync(live)) throw Object.assign(new Error("MANAGED_DELETE_MISMATCH"), { stage: "post_validation" }); }
      else if (!existsSync(live) || (await hashFile(live)).hash !== change.targetHash) throw Object.assign(new Error("MANAGED_HASH_MISMATCH"), { stage: "post_validation" });
    }
    const afterPersistent = await persistentIntegrity(install.path, staged.contract);
    if (!equalIntegrity(beforePersistent, afterPersistent)) throw Object.assign(new Error("PERSISTENT_INTEGRITY_MISMATCH"), { stage: "persistent_integrity" });
    const now = new Date().toISOString();
    const managedManifest = {};
    for (const relative of await listManagedFiles(install.path, staged.contract)) managedManifest[relative] = await hashFile(path.join(install.path, ...relative.split("/")));
    await writeUpdaterState(install.path, { schemaVersion: 1, sourceRepo: OFFICIAL_REPO, installPath: install.path, installedTag: target.tag, installedCommit: target.commit, deployedAt: now, previousTag: current.currentVersion, previousCommit: current.currentCommit, managedManifestVersion: 1, managedManifest, lastSuccessfulUpdate: now, rollbackSnapshot: { path: slash(path.relative(install.path, transaction.snapshotRoot)), createdAt: transaction.manifest.createdAt } });
    await pruneSnapshots(install.path, 2);
    return { status: "updated", oldTag: current.currentVersion, oldCommit: current.currentCommit, newTag: target.tag, newCommit: target.commit, installPath: install.path, managedAdded: plan.addCount, managedModified: plan.modifyCount, managedDeleted: plan.deleteCount, persistentVerified: true, dependenciesChanged: staged.lockfileChanged, validationPassed: true, rollbackSnapshot: slash(path.relative(install.path, transaction.snapshotRoot)), liveModificationStarted: true, rollbackAttempted: false, rollbackVerified: false };
  } catch (error) {
    let rollbackVerified = error.transaction?.rollbackVerified ?? false;
    let rollbackAttempted = error.transaction?.rollbackAttempted ?? false;
    if (transaction?.ok && transaction.liveModificationStarted) {
      rollbackAttempted = true;
      if (current.gitInstall) {
        try {
          if (transaction.branch) (deps.runner || runCommand)("git", ["update-ref", `refs/heads/${transaction.branch}`, current.currentCommit, target.commit], { cwd: install.path });
          else (deps.runner || runCommand)("git", ["update-ref", "HEAD", current.currentCommit, target.commit], { cwd: install.path });
          (deps.runner || runCommand)("git", ["read-tree", current.currentCommit], { cwd: install.path });
          rollbackVerified = await restoreSnapshot(install.path, transaction.snapshotRoot, transaction.manifest);
        } catch { rollbackVerified = false; }
      } else rollbackVerified = await restoreSnapshot(install.path, transaction.snapshotRoot, transaction.manifest).catch(() => false);
      if (rollbackVerified && staged.lockfileChanged) {
        try { (deps.runner || runCommand)(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts"], { cwd: install.path }); }
        catch { rollbackVerified = false; }
      }
      if (rollbackVerified) {
        try { await validateStaging(install.path, { lockfileChanged: false, runner: deps.runner || runCommand }); }
        catch { rollbackVerified = false; }
      }
    }
    return { status: "failed", failedStage: error.stage || "apply", liveModificationStarted: Boolean(transaction?.liveModificationStarted || error.transaction?.liveModificationStarted), rollbackAttempted, rollbackVerified, blockers: [error.code || cleanError(error)] };
  } finally {
    if (lock?.acquired) await releaseUpdateLock(lock);
    if (staged?.staging) await fs.rm(staged.staging, { recursive: true, force: true });
  }
}

export function parseArgs(argv) {
  const options = { apply: false, json: false, installDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--check") options.apply = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--install-dir") { options.installDir = argv[++index]; if (!options.installDir) throw new Error("--install-dir requires a path"); }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export async function checkUpdate(options = {}, deps = {}) {
  const report = await preflight(options, deps);
  if (report._internal?.staged?.staging) await fs.rm(report._internal.staged.staging, { recursive: true, force: true });
  return publicReport(report);
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) { process.stderr.write(`${cleanError(error)}\n`); return 2; }
  const report = options.apply ? await applyUpdate(options) : await checkUpdate(options);
  process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : `${JSON.stringify(report, null, 2)}\n`);
  const onlyAlreadyLatest = report.blockers?.length === 1 && report.blockers[0] === "already_latest";
  return report.status === "updated" || report.status === "ready" || onlyAlreadyLatest ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main();
