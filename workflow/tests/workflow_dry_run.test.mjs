import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "workflow", "tools", "maintenance", "workflow_dry_run.mjs");

function runDryRun(args = []) {
  const isolatedRoot = mkdtempSync(path.join(os.tmpdir(), "paperecho-dry-run-test-"));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: isolatedRoot,
      encoding: "utf8",
      timeout: 10000,
    });
    return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

// --- Help ---

test("workflow_dry_run --help shows usage", () => {
  const { stdout, status } = runDryRun(["--help"]);
  assert.equal(status, 0);
  assert.ok(stdout.includes("Usage:"));
  assert.ok(stdout.includes("--mode"));
  assert.ok(stdout.includes("--json"));
  assert.ok(stdout.includes("--fixture"));
});

// --- Headless mode ---

test("workflow_dry_run --mode headless runs without crash", () => {
  const { stdout, status } = runDryRun(["--mode", "headless"]);
  assert.equal(status, 0);
  assert.ok(stdout.includes("Source Selection"));
  assert.ok(stdout.includes("Retrieval Plan"));
  assert.ok(stdout.includes("Mock Dedupe"));
  assert.ok(stdout.includes("Headless Readiness"));
});

test("workflow_dry_run --mode headless reports source selection", () => {
  const { stdout } = runDryRun(["--mode", "headless", "--json"]);
  const j = JSON.parse(stdout);
  assert.equal(j.mode, "headless");
  assert.ok(j.sourceSelection.domain);
  assert.ok(Array.isArray(j.sourceSelection.enabledSources));
  assert.ok(Array.isArray(j.retrievalPlan.sources));
});

test("workflow_dry_run --mode headless reports gaps without .env", () => {
  const { stdout } = runDryRun(["--mode", "headless", "--json"]);
  const j = JSON.parse(stdout);
  assert.ok(j.readinessGaps.headless);
  assert.ok(Array.isArray(j.readinessGaps.headless.gaps));
  assert.ok(j.readinessGaps.headless.skipped.length > 0);
});

// --- Desktop mode ---

test("workflow_dry_run --mode desktop runs without crash", () => {
  const { stdout, status } = runDryRun(["--mode", "desktop"]);
  assert.equal(status, 0);
  assert.ok(stdout.includes("Desktop Readiness"));
});

test("workflow_dry_run --mode desktop reports writeback plan", () => {
  const { stdout } = runDryRun(["--mode", "desktop", "--json"]);
  const j = JSON.parse(stdout);
  assert.equal(j.mode, "desktop");
  assert.ok(j.readinessGaps.desktop);
  assert.ok(j.readinessGaps.desktop.skipped.some(s => s.action === "zotero_desktop_write"));
});

// --- All mode ---

test("workflow_dry_run --mode all aggregates both paths", () => {
  const { stdout } = runDryRun(["--mode", "all", "--json"]);
  const j = JSON.parse(stdout);
  assert.equal(j.mode, "all");
  assert.ok(j.readinessGaps.headless);
  assert.ok(j.readinessGaps.desktop);
});

// --- JSON output ---

test("workflow_dry_run --json output is valid JSON with expected fields", () => {
  const { stdout } = runDryRun(["--json"]);
  const j = JSON.parse(stdout);
  assert.ok("mode" in j);
  assert.ok("dryRun" in j);
  assert.ok("timestamp" in j);
  assert.ok("platform" in j);
  assert.ok("sourceSelection" in j);
  assert.ok("retrievalPlan" in j);
  assert.ok("mockDedupe" in j);
  assert.ok("readinessGaps" in j);
  assert.ok("overall" in j);
  assert.equal(j.dryRun, true);
});

// --- No secrets ---

test("workflow_dry_run does not output secret values", () => {
  const { stdout } = runDryRun(["--json"]);
  const lower = stdout.toLowerCase();
  assert.ok(!lower.includes("sk-"));
  assert.ok(!lower.includes("password"));
  assert.ok(!stdout.includes("your_translation_api_key_here"));
  assert.ok(!stdout.includes("your_easyscholar_secret_key_here"));
});

// --- No real API calls ---

test("workflow_dry_run skipped actions include no real fetches", () => {
  const { stdout } = runDryRun(["--mode", "all", "--json"]);
  const j = JSON.parse(stdout);
  const allSkipped = [
    ...(j.readinessGaps.headless?.skipped || []),
    ...(j.readinessGaps.desktop?.skipped || []),
  ];
  assert.ok(allSkipped.some(s => s.action === "fetch_pubmed"));
  assert.ok(allSkipped.some(s => s.action === "fetch_openalex"));
  assert.ok(allSkipped.some(s => s.action === "fetch_rss"));
  assert.ok(allSkipped.some(s => s.action === "send_email"));
  assert.ok(allSkipped.some(s => s.action === "cleanup_apply"));
});

// --- Source selection disabled source not in plan ---

test("workflow_dry_run disabled source not enabled in retrieval plan", () => {
  const { stdout } = runDryRun(["--mode", "headless", "--json"]);
  const j = JSON.parse(stdout);
  // Current config is biomedical, so openalex should be disabled
  const openalex = j.retrievalPlan.sources.find(s => s.name === "openalex");
  assert.equal(openalex.enabled, false);
});

// --- Mock dedupe ---

test("workflow_dry_run mock dedupe simulation works", () => {
  const { stdout } = runDryRun(["--json"]);
  const j = JSON.parse(stdout);
  assert.ok(j.mockDedupe);
  assert.ok(j.mockDedupe.inputCount > 0);
  assert.ok(j.mockDedupe.dedupedCount > 0);
  assert.ok(j.mockDedupe.dedupedCount <= j.mockDedupe.inputCount);
  assert.ok("bySource" in j.mockDedupe);
  assert.equal(j.mockDedupe.bySource.rss, 3);
  assert.equal(j.mockDedupe.bySource.pubmed, 3);
  assert.equal(j.mockDedupe.inputCount, 6);
  assert.equal(j.mockDedupe.duplicatesRemoved, 1);
});

// --- Default dry-run ---

test("workflow_dry_run defaults to dry-run", () => {
  const { stdout } = runDryRun(["--json"]);
  const j = JSON.parse(stdout);
  assert.equal(j.dryRun, true);
});
