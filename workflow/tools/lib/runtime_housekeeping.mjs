import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerEphemeral } from "./ephemeral_registry.mjs";

export const HOUSEKEEPING_SCHEMA_VERSION = 1;
export const RUN_GROUP_SCHEMA_VERSION = 1;
export const DEFAULT_RETENTION_DAYS = 30;
export const FULL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DATE_DIR_RE = /^\d{2}\.\d{1,2}\.\d{1,2}$/;
const PROTECTED_NAMES = new Set([
  "screening_standards.docx",
  "screening_standards.backup.docx",
  "screening_standards.before_llm_refine.docx",
  "current_literature_index.json",
  "current_library_index.json",
  "papers.json",
  "dedupe-index.json",
  "learning-state.json",
  "events.jsonl",
  "translation_cache.json",
  "runtime_state.json",
  "urgent_queue.json",
  "review_backlog.json",
  "operation_ledger.json",
  "email_receipt.json",
  "notification_receipt.json",
  ".env",
  ".git",
  "config",
  "tests",
  "fixtures",
  "README.md",
]);

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value || 0);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isStrictChild(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isRootPath(value) {
  const resolved = path.resolve(value);
  return path.parse(resolved).root === resolved;
}

function relativeArtifact(entry = {}) {
  const value = String(entry.path || "").trim();
  if (!value || path.isAbsolute(value)) throw new Error("RUN_GROUP_ARTIFACT_PATH_INVALID");
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error("RUN_GROUP_ARTIFACT_PATH_OUTSIDE_ROOT");
  const retention = String(entry.retention || "30d");
  if (!["30d", "protected", "ephemeral"].includes(retention)) throw new Error("RUN_GROUP_RETENTION_INVALID");
  return { kind: String(entry.kind || "artifact"), rootKey: String(entry.rootKey || "runs"), path: normalized, retention };
}

async function atomicWriteJson(filePath, value, { fsApi = fs } = {}) {
  await fsApi.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryRegistration = registerEphemeral({ path: temporary, ownerStage: "runtime_housekeeping", cleanupWhen: "always_after_close" });
  try {
    await fsApi.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fsApi.rename(temporary, filePath);
    temporaryRegistration.forget();
  } catch (error) {
    temporaryRegistration.markClosed();
    await fsApi.unlink(temporary).then(() => temporaryRegistration.forget()).catch(() => {});
    throw error;
  }
}

async function readJson(filePath, fsApi = fs) {
  try { return JSON.parse(await fsApi.readFile(filePath, "utf8")); } catch { return null; }
}

export function resolveHousekeepingConfig(env = process.env) {
  const enabledRaw = String(env.PAPERFLOW_CLEANUP_ENABLED ?? "true").trim().toLowerCase();
  const enabledValues = new Map([["true", true], ["1", true], ["yes", true], ["false", false], ["0", false], ["no", false]]);
  const retentionRaw = String(env.PAPERFLOW_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS).trim();
  const retentionDays = Number(retentionRaw);
  const warnings = [];
  if (!enabledValues.has(enabledRaw)) warnings.push("PAPERFLOW_CLEANUP_ENABLED_INVALID");
  if (!/^\d+$/.test(retentionRaw) || !Number.isSafeInteger(retentionDays)) warnings.push("PAPERFLOW_RETENTION_DAYS_INVALID");
  return {
    valid: warnings.length === 0,
    enabled: enabledValues.get(enabledRaw) ?? false,
    retentionDays: warnings.length ? null : retentionDays,
    warnings,
  };
}

export function runGroupPath(runRoot, runId) {
  return path.join(path.resolve(runRoot), String(runId), "run_group.json");
}

export function runStateRoot(runRoot, runId) {
  return path.join(path.resolve(runRoot), String(runId));
}

export async function startRunGroup({ runRoot, runId, pipelineMode, startedAt, artifacts = [], references = {}, fsApi = fs } = {}) {
  if (!String(runId || "").trim()) throw new Error("RUN_GROUP_ID_REQUIRED");
  const manifestPath = runGroupPath(runRoot, runId);
  const directory = path.dirname(manifestPath);
  await fsApi.mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, "run.lock");
  const handle = await fsApi.open(lockPath, "wx");
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: startedAt || new Date().toISOString() })); }
  finally { await handle.close(); }
  const manifest = {
    schemaVersion: RUN_GROUP_SCHEMA_VERSION,
    runId: String(runId),
    pipelineMode: String(pipelineMode || "local"),
    status: "running",
    startedAt: String(startedAt || new Date().toISOString()),
    finishedAt: "",
    artifacts: artifacts.map(relativeArtifact),
    references: { monthlyAggregationPending: Boolean(references.monthlyAggregationPending) },
  };
  await atomicWriteJson(manifestPath, manifest, { fsApi });
  return { manifestPath, lockPath, manifest };
}

export async function finishRunGroup({ manifestPath, status, finishedAt, pipelineMode, artifacts = [], monthlyAggregationPending, fsApi = fs } = {}) {
  const current = await readJson(manifestPath, fsApi);
  if (!current) return { updated: false, reason: "manifest_missing" };
  const additions = artifacts.map(relativeArtifact);
  const seen = new Set();
  const merged = [...(current.artifacts || []), ...additions].filter((entry) => {
    const key = `${entry.rootKey}:${entry.path}:${entry.retention}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const next = {
    ...current,
    ...(pipelineMode ? { pipelineMode: String(pipelineMode) } : {}),
    status: ["completed", "failed"].includes(status) ? status : "failed",
    finishedAt: String(finishedAt || new Date().toISOString()),
    artifacts: merged,
    references: {
      ...(current.references || {}),
      ...(monthlyAggregationPending === undefined ? {} : { monthlyAggregationPending: Boolean(monthlyAggregationPending) }),
    },
  };
  await atomicWriteJson(manifestPath, next, { fsApi });
  await fsApi.unlink(path.join(path.dirname(manifestPath), "run.lock")).catch(() => {});
  return { updated: true, manifest: next };
}

export async function releaseMonthlyAggregation({ runRoot, monthPrefix, monthArtifactPrefix = "", fsApi = fs } = {}) {
  let updated = 0;
  let entries = [];
  try { entries = await fsApi.readdir(runRoot, { withFileTypes: true }); } catch { return { updated }; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = runGroupPath(runRoot, entry.name);
    const manifest = await readJson(manifestPath, fsApi);
    const artifactMatch = monthArtifactPrefix && (manifest?.artifacts || []).some((artifact) => artifact.rootKey === "review" && String(artifact.path || "").split(/[\\/]/)[0] === monthArtifactPrefix);
    if (!manifest?.references?.monthlyAggregationPending || (!artifactMatch && !String(manifest.startedAt || "").startsWith(monthPrefix))) continue;
    manifest.references.monthlyAggregationPending = false;
    await atomicWriteJson(manifestPath, manifest, { fsApi });
    updated += 1;
  }
  return { updated };
}

async function rootInfo(root, { repoRoot, homeDir, fsApi }) {
  const resolved = path.resolve(String(root || ""));
  if (!String(root || "").trim() || isRootPath(resolved) || resolved === path.resolve(homeDir || os.homedir()) || (repoRoot && resolved === path.resolve(repoRoot))) {
    throw new Error("HOUSEKEEPING_DANGEROUS_ROOT");
  }
  const real = await fsApi.realpath(resolved).catch(() => resolved);
  return { resolved, real };
}

async function candidatePath(entry, roots, rootInfos, fsApi) {
  const root = roots[entry.rootKey];
  const info = rootInfos[entry.rootKey];
  if (!root || !info) throw new Error("RUN_GROUP_ROOT_KEY_INVALID");
  const candidate = path.resolve(root, entry.path);
  if (!isStrictChild(info.resolved, candidate)) throw new Error("HOUSEKEEPING_PATH_OUTSIDE_ROOT");
  let stat;
  try { stat = await fsApi.lstat(candidate); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (stat.isSymbolicLink()) throw new Error("HOUSEKEEPING_SYMLINK_BLOCKED");
  const real = await fsApi.realpath(candidate);
  if (!isStrictChild(info.real, real)) throw new Error("HOUSEKEEPING_REALPATH_OUTSIDE_ROOT");
  return { candidate, real, stat };
}

async function containsProtected(candidate, fsApi) {
  const stack = [candidate];
  while (stack.length) {
    const current = stack.pop();
    const stat = await fsApi.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("HOUSEKEEPING_SYMLINK_BLOCKED");
    const name = path.basename(current);
    if (PROTECTED_NAMES.has(name) || /^nr-[a-f0-9]{32}\.json$/i.test(name) || /^月报-.*\.docx$/i.test(name)) return true;
    if (!stat.isDirectory()) continue;
    for (const entry of await fsApi.readdir(current, { withFileTypes: true })) stack.push(path.join(current, entry.name));
  }
  return false;
}

function pidAlive(pid, processAlive = null) {
  if (processAlive) return Boolean(processAlive(pid));
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function activeRunLock(runDir, nowMs, { fsApi, processAlive, staleMs = FULL_SCAN_INTERVAL_MS }) {
  const lockPath = path.join(runDir, "run.lock");
  const lock = await readJson(lockPath, fsApi);
  if (!lock) return false;
  const created = asDate(lock.createdAt)?.getTime() || (await fsApi.stat(lockPath)).mtimeMs;
  return pidAlive(lock.pid, processAlive) || nowMs - created <= staleMs;
}

function completionTime(manifest, fallbackStat) {
  return asDate(manifest?.finishedAt || manifest?.completedAt || manifest?.metadata?.finishedAt)?.getTime() || fallbackStat?.mtimeMs || null;
}

export async function planRetentionCleanup({ runtimeRoot, runRoot, allowedRoots = {}, legacyRoots = [], retentionDays = DEFAULT_RETENTION_DAYS, currentRunId = "", now = new Date(), repoRoot = "", homeDir = os.homedir(), processAlive = null, fsApi = fs } = {}) {
  const roots = { runs: path.resolve(runRoot), ...Object.fromEntries(Object.entries(allowedRoots).map(([key, value]) => [key, path.resolve(value)])) };
  const result = { safe: true, scannedRuns: 0, eligibleRuns: 0, candidates: [], skippedProtected: 0, warnings: [] };
  if (!Number.isSafeInteger(Number(retentionDays)) || Number(retentionDays) < 0) return { ...result, safe: false, warnings: ["RETENTION_DAYS_INVALID"] };
  const rootInfos = {};
  try {
    await rootInfo(runtimeRoot, { repoRoot, homeDir, fsApi });
    for (const [key, root] of Object.entries(roots)) rootInfos[key] = await rootInfo(root, { repoRoot, homeDir, fsApi });
    for (const legacyRoot of legacyRoots) await rootInfo(legacyRoot, { repoRoot, homeDir, fsApi });
  } catch (error) {
    return { ...result, safe: false, warnings: [String(error?.message || error)] };
  }
  if (Number(retentionDays) === 0) return { ...result, disabled: true };
  const cutoff = now.getTime() - Number(retentionDays) * 86400000;
  const manifests = [];
  let entries = [];
  try { entries = await fsApi.readdir(runRoot, { withFileTypes: true }); } catch (error) {
    if (error?.code !== "ENOENT") return { ...result, safe: false, warnings: ["RUN_ROOT_UNREADABLE"] };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const manifestPath = runGroupPath(runRoot, entry.name);
    const manifest = await readJson(manifestPath, fsApi);
    if (!manifest || manifest.schemaVersion !== RUN_GROUP_SCHEMA_VERSION) continue;
    result.scannedRuns += 1;
    const runDir = path.dirname(manifestPath);
    const stat = await fsApi.stat(manifestPath).catch(() => null);
    const completed = completionTime(manifest, stat);
    const active = await activeRunLock(runDir, now.getTime(), { fsApi, processAlive });
    const protectedRun = manifest.runId === currentRunId || manifest.status === "running" || active || manifest.references?.monthlyAggregationPending || !completed || completed >= cutoff;
    manifests.push({ manifest, manifestPath, protectedRun, completed });
    if (protectedRun) result.skippedProtected += 1;
  }
  const protectedPaths = new Set();
  const manifestOwnedPaths = new Set();
  for (const item of manifests) {
    for (const artifact of item.manifest.artifacts || []) {
      const root = roots[artifact.rootKey];
      if (!root) continue;
      const absolute = path.resolve(root, artifact.path);
      if (isStrictChild(root, absolute)) manifestOwnedPaths.add(path.normalize(absolute));
    }
  }
  for (const item of manifests.filter((entry) => entry.protectedRun)) {
    for (const artifact of item.manifest.artifacts || []) protectedPaths.add(`${artifact.rootKey}:${path.normalize(artifact.path)}`);
  }
  for (const item of manifests.filter((entry) => !entry.protectedRun)) {
    const artifacts = [];
    try {
      for (const artifact of (item.manifest.artifacts || []).filter((entry) => entry.retention === "30d")) {
        if (protectedPaths.has(`${artifact.rootKey}:${path.normalize(artifact.path)}`)) throw new Error("RUN_ARTIFACT_SHARED_WITH_PROTECTED_RUN");
        const resolved = await candidatePath(artifact, roots, rootInfos, fsApi);
        if (!resolved) continue;
        if (await containsProtected(resolved.candidate, fsApi)) throw new Error("RUN_ARTIFACT_CONTAINS_PROTECTED_FILE");
        artifacts.push({ ...artifact, absolutePath: resolved.candidate });
      }
    } catch (error) {
      const reason = String(error?.message || error);
      if (["RUN_GROUP_ROOT_KEY_INVALID", "HOUSEKEEPING_PATH_OUTSIDE_ROOT", "HOUSEKEEPING_SYMLINK_BLOCKED", "HOUSEKEEPING_REALPATH_OUTSIDE_ROOT"].includes(reason)) {
        return { ...result, safe: false, eligibleRuns: 0, candidates: [], warnings: [...result.warnings, reason] };
      }
      result.skippedProtected += 1;
      result.warnings.push(reason);
      continue;
    }
    if (artifacts.length) result.candidates.push({ runId: item.manifest.runId, manifestPath: item.manifestPath, completedAt: new Date(item.completed).toISOString(), artifacts });
  }
  for (const legacyRoot of legacyRoots) {
    let legacyEntries = [];
    try { legacyEntries = await fsApi.readdir(legacyRoot, { withFileTypes: true }); } catch { continue; }
    const legacyInfo = await rootInfo(legacyRoot, { repoRoot, homeDir, fsApi });
    for (const entry of legacyEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !DATE_DIR_RE.test(entry.name)) continue;
      const candidate = path.join(legacyRoot, entry.name);
      const stat = await fsApi.lstat(candidate);
      result.scannedRuns += 1;
      if (manifestOwnedPaths.has(path.normalize(path.resolve(candidate)))) continue;
      const report = await readJson(path.join(candidate, "run_report.json"), fsApi)
        || await readJson(path.join(candidate, "orchestrator_report.json"), fsApi);
      const completed = completionTime(report, stat);
      if (!completed || completed >= cutoff || entry.name === currentRunId) { result.skippedProtected += 1; continue; }
      const real = await fsApi.realpath(candidate);
      try {
        if (!isStrictChild(legacyInfo.real, real)) return { ...result, safe: false, eligibleRuns: 0, candidates: [], warnings: [...result.warnings, "HOUSEKEEPING_REALPATH_OUTSIDE_ROOT"] };
        if (await containsProtected(candidate, fsApi)) { result.skippedProtected += 1; continue; }
      } catch (error) {
        const reason = String(error?.message || error);
        if (reason === "HOUSEKEEPING_SYMLINK_BLOCKED") return { ...result, safe: false, eligibleRuns: 0, candidates: [], warnings: [...result.warnings, reason] };
        result.skippedProtected += 1;
        result.warnings.push(reason);
        continue;
      }
      result.candidates.push({ runId: `legacy:${entry.name}`, completedAt: new Date(completed).toISOString(), artifacts: [{ kind: "legacy_pipeline", rootKey: "legacy", path: entry.name, absolutePath: candidate, retention: "30d" }] });
    }
  }
  result.eligibleRuns = result.candidates.length;
  return result;
}

async function treeStats(target, fsApi) {
  let files = 0;
  let bytes = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    const stat = await fsApi.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("HOUSEKEEPING_SYMLINK_BLOCKED");
    if (stat.isDirectory()) for (const entry of await fsApi.readdir(current)) stack.push(path.join(current, entry));
    else { files += 1; bytes += stat.size; }
  }
  return { files, bytes };
}

export async function writeHousekeepingReceipt({ runtimeRoot, receipt, fsApi = fs } = {}) {
  const receiptPath = path.join(path.resolve(runtimeRoot), "housekeeping", "last_cleanup.json");
  await atomicWriteJson(receiptPath, receipt, { fsApi });
  return receiptPath;
}

export async function recordImmediateCleanup({ runtimeRoot, summary = {}, fsApi = fs, now = new Date() } = {}) {
  const receiptPath = path.join(path.resolve(runtimeRoot), "housekeeping", "last_cleanup.json");
  const previous = await readJson(receiptPath, fsApi);
  const config = resolveHousekeepingConfig();
  const base = previous || {
    schemaVersion: HOUSEKEEPING_SCHEMA_VERSION, startedAt: now.toISOString(), finishedAt: now.toISOString(), retentionDays: config.retentionDays,
    dryRun: false, scannedRuns: 0, eligibleRuns: 0, deletedRuns: 0, deletedFiles: 0, deletedBytes: 0,
    skippedProtected: 0, failedCount: 0, warnings: [], samples: [], nextEligibleAt: new Date(now.getTime() + FULL_SCAN_INTERVAL_MS).toISOString(),
  };
  const receipt = {
    ...base,
    immediateDeletedFiles: Number(summary.immediateDeletedFiles || 0),
    immediateDeletedBytes: Number(summary.immediateDeletedBytes || 0),
    immediateFailedCount: Number(summary.immediateFailedCount || 0),
    warnings: [...(base.warnings || []), ...(summary.warnings || [])].slice(0, 10),
    samples: [...(base.samples || []), ...(summary.samples || []).map((item) => `ephemeral:${item}`)].slice(0, 8),
  };
  await writeHousekeepingReceipt({ runtimeRoot, receipt, fsApi });
  return { receiptPath, receipt };
}

async function acquireCleanupLock(runtimeRoot, { now, fsApi, processAlive }) {
  const lockPath = path.join(path.resolve(runtimeRoot), "housekeeping", "cleanup.lock");
  await fsApi.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await fsApi.open(lockPath, "wx");
    const registration = registerEphemeral({ path: lockPath, ownerStage: "runtime_housekeeping", cleanupWhen: "always_after_close" });
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: now.toISOString() }));
    await handle.close();
    return { acquired: true, lockPath, registration };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readJson(lockPath, fsApi);
    const stat = await fsApi.stat(lockPath).catch(() => null);
    const created = asDate(existing?.createdAt)?.getTime() || stat?.mtimeMs || now.getTime();
    if (!pidAlive(existing?.pid, processAlive) && now.getTime() - created > FULL_SCAN_INTERVAL_MS) {
      await fsApi.unlink(lockPath).catch(() => {});
      return acquireCleanupLock(runtimeRoot, { now, fsApi, processAlive });
    }
    return { acquired: false, lockPath };
  }
}

export async function runRetentionCleanup(options = {}) {
  const fsApi = options.fsApi || fs;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const config = options.config || resolveHousekeepingConfig(options.env || process.env);
  const base = {
    schemaVersion: HOUSEKEEPING_SCHEMA_VERSION, startedAt: now.toISOString(), finishedAt: now.toISOString(),
    retentionDays: config.retentionDays, dryRun: Boolean(options.dryRun), scannedRuns: 0, eligibleRuns: 0,
    deletedRuns: 0, deletedFiles: 0, deletedBytes: 0, immediateDeletedFiles: 0, immediateDeletedBytes: 0, immediateFailedCount: 0, skippedProtected: 0,
    failedCount: 0, warnings: [...(config.warnings || [])], samples: [], nextEligibleAt: new Date(now.getTime() + FULL_SCAN_INTERVAL_MS).toISOString(),
  };
  if (!config.valid || !config.enabled || config.retentionDays === 0) return { ...base, skipped: true, reason: !config.valid ? "invalid_config" : "cleanup_disabled" };
  const previousPath = path.join(path.resolve(options.runtimeRoot), "housekeeping", "last_cleanup.json");
  const previous = await readJson(previousPath, fsApi);
  if (!options.force && previous?.finishedAt && now.getTime() - new Date(previous.finishedAt).getTime() < FULL_SCAN_INTERVAL_MS) {
    return { ...base, skipped: true, reason: "scan_interval_not_reached", nextEligibleAt: previous.nextEligibleAt || base.nextEligibleAt };
  }
  let lock;
  try { lock = await acquireCleanupLock(options.runtimeRoot, { now, fsApi, processAlive: options.processAlive }); }
  catch (error) { return { ...base, skipped: true, reason: "cleanup_lock_failed", warnings: [String(error?.message || error)] }; }
  if (!lock.acquired) return { ...base, skipped: true, reason: "cleanup_in_progress" };
  try {
    const plan = await planRetentionCleanup({ ...options, retentionDays: config.retentionDays, now, fsApi });
    Object.assign(base, { scannedRuns: plan.scannedRuns, eligibleRuns: plan.eligibleRuns, skippedProtected: plan.skippedProtected });
    base.warnings.push(...plan.warnings.slice(0, 10));
    if (!plan.safe) {
      base.failedCount += 1;
    } else if (!options.dryRun) {
      const deletedPaths = new Set();
      for (const candidate of plan.candidates) {
        let runDeleted = true;
        const orderedArtifacts = [...candidate.artifacts].sort((a, b) => Number(a.rootKey === "runs") - Number(b.rootKey === "runs"));
        for (const artifact of orderedArtifacts) {
          if (deletedPaths.has(artifact.absolutePath)) continue;
          try {
            const stats = await treeStats(artifact.absolutePath, fsApi);
            await fsApi.rm(artifact.absolutePath, { recursive: true, force: false });
            deletedPaths.add(artifact.absolutePath);
            base.deletedFiles += stats.files;
            base.deletedBytes += stats.bytes;
            if (base.samples.length < 8) base.samples.push(`${artifact.rootKey}:${artifact.path}`);
          } catch (error) {
            if (error?.code !== "ENOENT") { base.failedCount += 1; base.warnings.push(String(error?.code || error?.message || error).slice(0, 120)); }
            runDeleted = false;
          }
        }
        if (runDeleted) base.deletedRuns += 1;
      }
    }
    base.finishedAt = new Date(Math.max(now.getTime(), Date.now())).toISOString();
    await writeHousekeepingReceipt({ runtimeRoot: options.runtimeRoot, receipt: base, fsApi });
    return { ...base, dryRun: Boolean(options.dryRun), safe: plan.safe, plan: options.dryRun ? plan : undefined };
  } finally {
    lock.registration?.markClosed();
    await fsApi.unlink(lock.lockPath).then(() => lock.registration?.forget()).catch(() => {});
  }
}
