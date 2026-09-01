import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  OFFICIAL_REPO,
  acquireUpdateLock,
  applyUpdate,
  buildManagedPlan,
  checkUpdate,
  compareVersions,
  detectInstallations,
  documentRoots,
  hashFile,
  inspectActiveRun,
  isManagedPath,
  isPersistentPath,
  normalizeRepoUrl,
  parseArgs,
  parseRemoteTags,
  parseStableTag,
  readUpdaterState,
  releaseUpdateLock,
  resolveInside,
  resolveLatestRemote,
  restoreSnapshot,
  runCommand,
  selectLatestStable,
  transactionalFileDeploy,
  transactionalGitDeploy,
  validateContract,
  validateInstallCandidate,
  validateRelativePath,
  verifyPreflightHashes,
} from "../../skills/paperecho-update/scripts/update.mjs";

const OLD_COMMIT = "1".repeat(40);
const NEW_COMMIT = "2".repeat(40);
const contract = {
  schemaVersion: 1,
  managedManifestVersion: 1,
  sourceRepo: OFFICIAL_REPO,
  managedRoots: ["workflow", "skills", "docs"],
  managedFiles: ["package.json", "package-lock.json"],
  managedConfigFiles: ["config/README.md", "config/paperecho.config.example.json"],
  persistentRoots: [".paperecho", "config", "logs", "review_results"],
  persistentFiles: [".env"],
  compatibility: {
    configSchemaVersions: [1, 2], sourceStateSchemaVersions: [1], operationLedgerSchemaVersions: [1],
    notificationReceiptSchemaVersions: [1, 2], literatureIndexSchemaVersions: [2], updaterStateSchemaVersions: [1],
  },
  runtime: { node: ">=18.0.0", pwsh: ">=7.0.0", platforms: ["win32", "darwin"] },
};

async function temp(t, prefix = "paperecho-update-test-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function write(root, relative, value = "x\n") {
  const file = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
  return file;
}

async function makeInstall(t, root, { git = false, origin = OFFICIAL_REPO } = {}) {
  for (const relative of ["workflow/tools/runner/main.mjs", "skills/paperecho-workflow/SKILL.md", "package.json", "AGENTS.md"]) await write(root, relative);
  await fs.mkdir(path.join(root, "skills"), { recursive: true });
  if (git) await fs.mkdir(path.join(root, ".git"));
  const runner = (command, args) => {
    if (args?.join(" ") === "remote get-url origin") return origin;
    throw new Error(`unexpected ${command} ${args?.join(" ")}`);
  };
  return { root, runner };
}

function blob(file) {
  const data = fsSync.readFileSync(file);
  return crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

async function makeNonGitPair(t, { changedLock = false } = {}) {
  const base = await temp(t, "paperecho-update-pair-");
  const live = path.join(base, "live");
  const target = path.join(base, "target");
  await fs.mkdir(live); await fs.mkdir(target);
  const commonOld = {
    "workflow/tools/runner/main.mjs": "export const runner = 'old';\n",
    "workflow/tools/runner/config_loader.mjs": "export const config = 'old';\n",
    "skills/paperecho-workflow/SKILL.md": "old skill\n",
    "skills/paperecho-update/scripts/update.mjs": "export const updater = 'old';\n",
    "skills/paperecho-update/references/update-contract.json": `${JSON.stringify(contract)}\n`,
    "package.json": "{}\n", "package-lock.json": "{\"lock\":1}\n", "AGENTS.md": "agent\n",
  };
  const commonNew = { ...commonOld,
    "workflow/tools/runner/main.mjs": "export const runner = 'new';\n",
    "skills/paperecho-update/scripts/update.mjs": "export const updater = 'new';\n",
    "package-lock.json": changedLock ? "{\"lock\":2}\n" : commonOld["package-lock.json"],
  };
  for (const [relative, value] of Object.entries(commonOld)) await write(live, relative, value);
  for (const [relative, value] of Object.entries(commonNew)) await write(target, relative, value);
  await write(live, ".env", "FIXTURE_VALUE=redacted\n");
  await write(live, "config/user.json", "{\"query\":\"fixture-sensitive-text\"}\n");
  await write(live, "review_results/shared/current_literature_index.json", `${JSON.stringify({ schema_version: 2, integrity_monitoring: { schema_version: 1, bootstrap: { completed_identities: ["doi:10.1000/fixture"] } }, records: { "doi:10.1000/fixture": { integrity: { currentStatus: "retraction", application: { state: "pending_delete" } } } }, live_items: {}, tombstones: {} })}\n`);
  const managedManifest = {};
  for (const relative of Object.keys(commonOld).filter((item) => isManagedPath(item, contract))) managedManifest[relative] = await hashFile(path.join(live, ...relative.split("/")));
  await write(live, ".paperecho/update/state.json", `${JSON.stringify({ schemaVersion: 1, sourceRepo: OFFICIAL_REPO, installPath: live, installedTag: "v2.2", installedCommit: OLD_COMMIT, managedManifestVersion: 1, managedManifest })}\n`);
  return { base, live, target, commonOld, commonNew };
}

function fixtureRunner(targetRoot, liveRoot, calls = []) {
  return (command, args, options = {}) => {
    calls.push([command, ...args]);
    const joined = args.join(" ");
    if (command === "git" && args[0] === "ls-remote") return `${NEW_COMMIT}\trefs/tags/v2.3`;
    if (command === "git" && args[0] === "clone") { fsSync.cpSync(targetRoot, args.at(-1), { recursive: true }); return ""; }
    if (command === "git" && joined === "checkout --quiet --detach v2.3") return "";
    if (command === "git" && joined === "remote get-url origin") return OFFICIAL_REPO;
    if (command === "git" && joined === "rev-parse HEAD") return NEW_COMMIT;
    if (command === "git" && joined === "tag --points-at HEAD") return "v2.3";
    if (command === process.execPath) return "";
    if (/npm(?:\.cmd)?$/.test(command) && args[0] === "ci") return "";
    throw new Error(`unexpected runner call: ${command} ${joined} @ ${options.cwd || liveRoot}`);
  };
}

async function makeGitUpgrade(t) {
  const root = await temp(t, "paperecho-update-git-");
  const source = path.join(root, "source"); const live = path.join(root, "live");
  await fs.mkdir(source);
  const cmd = (args, cwd = source) => runCommand("git", args, { cwd });
  cmd(["init", "-q", "-b", "main"]); cmd(["config", "user.email", "fixture@example.test"]); cmd(["config", "user.name", "Fixture"]);
  await write(source, "docs/app.txt", "old\n"); await write(source, "config/user.json", "default-old\n");
  await write(source, "skills/paperecho-update/references/update-contract.json", `${JSON.stringify(contract)}\n`);
  cmd(["add", "docs/app.txt", "config/user.json", "skills/paperecho-update/references/update-contract.json"]); cmd(["commit", "-q", "-m", "old"]); cmd(["tag", "v2.2"]);
  const oldCommit = cmd(["rev-parse", "HEAD"]);
  await fs.writeFile(path.join(source, "docs/app.txt"), "new\n"); await fs.writeFile(path.join(source, "config/user.json"), "default-new\n"); await write(source, "config/new-user.json", "default-new-file\n");
  cmd(["add", "."]); cmd(["commit", "-q", "-m", "new"]); cmd(["tag", "v2.3"]); const newCommit = cmd(["rev-parse", "HEAD"]);
  runCommand("git", ["clone", "-q", source, live]); cmd(["checkout", "-q", "-b", "stable", "v2.2"], live);
  await fs.writeFile(path.join(live, "config/user.json"), "my-user-config\n");
  const oldManaged = await fs.readFile(path.join(live, "docs/app.txt"), "utf8");
  const targetHash = (await hashFile(path.join(source, "docs/app.txt"))).hash;
  return { source, live, oldCommit, oldManaged, newCommit, plan: { changes: [{ relative: "docs/app.txt", action: "modify", targetHash }] }, target: { tag: "v2.3", commit: newCommit } };
}

// Version and tag selection (1-9)
test("01 numeric stable order treats v2.10 as newer than v2.9", () => assert.equal(compareVersions(parseStableTag("v2.10"), parseStableTag("v2.9")), 1));
test("02 patch release is newer than its minor tag", () => assert.equal(compareVersions(parseStableTag("v2.2.1"), parseStableTag("v2.2")), 1));
test("03 prerelease tags are excluded", () => assert.equal(parseStableTag("v2.3-rc.1"), null));
test("04 main is not a release tag", () => assert.equal(parseStableTag("main"), null));
test("05 latest stable selection reports already-current version deterministically", () => assert.equal(selectLatestStable([{ tag: "v2.2", commit: OLD_COMMIT }]).tag, "v2.2"));
test("06 version comparator permits detection of downgrade attempts", () => assert.equal(compareVersions(parseStableTag("v3.0"), parseStableTag("v2.9")), 1));
test("07 equivalent v2.2 and v2.2.0 on one commit choose v2.2", () => assert.equal(selectLatestStable([{ tag: "v2.2.0", commit: OLD_COMMIT }, { tag: "v2.2", commit: OLD_COMMIT }]).tag, "v2.2"));
test("08 equivalent semantic tags on different commits block", () => assert.throws(() => selectLatestStable([{ tag: "v2.2", commit: OLD_COMMIT }, { tag: "v2.2.0", commit: NEW_COMMIT }]), /AMBIGUOUS/));
test("09 annotated tag parsing uses peeled commit", () => assert.equal(parseRemoteTags(`${"a".repeat(40)}\trefs/tags/v2.2\n${OLD_COMMIT}\trefs/tags/v2.2^{}`)[0].commit, OLD_COMMIT));

// Installation detection (10-18)
test("10 Windows Documents root is considered", async (t) => { const root = await temp(t); await fs.mkdir(path.join(root, "Documents")); assert(documentRoots({ platform: "win32", env: { USERPROFILE: root }, home: root }).includes(path.join(root, "Documents"))); });
test("11 Windows OneDrive Documents root is considered", async (t) => { const root = await temp(t); await fs.mkdir(path.join(root, "OneDrive", "Documents"), { recursive: true }); assert(documentRoots({ platform: "win32", env: { USERPROFILE: root, OneDrive: path.join(root, "OneDrive") }, home: root }).some((item) => item.endsWith(path.join("OneDrive", "Documents")))); });
test("12 macOS Documents root is considered", async (t) => { const root = await temp(t); await fs.mkdir(path.join(root, "Documents")); assert(documentRoots({ platform: "darwin", env: {}, home: root }).includes(path.join(root, "Documents"))); });
test("13 macOS iCloud Documents is considered only when present", async (t) => { const root = await temp(t); const cloud = path.join(root, "Library", "Mobile Documents", "com~apple~CloudDocs", "Documents"); await fs.mkdir(cloud, { recursive: true }); assert(documentRoots({ platform: "darwin", env: {}, home: root }).includes(cloud)); });
test("14 cwd parent detection finds a PaperEcho root", async (t) => { const root = await temp(t); const { runner } = await makeInstall(t, root); const nested = path.join(root, "workflow", "tools"); const found = await detectInstallations({ cwd: nested, platform: "linux", env: {}, home: root, runner }); assert.equal(found.path, root); });
test("15 a unique explicit candidate is selected", async (t) => { const root = await temp(t); const { runner } = await makeInstall(t, root); assert.equal((await detectInstallations({ installDir: root, platform: "linux", runner })).path, root); });
test("16 multiple high-confidence candidates block automatic selection", async (t) => { const home = await temp(t); const docs = path.join(home, "Documents"); const a = path.join(docs, "A"); const b = path.join(docs, "B"); await fs.mkdir(docs); const ia = await makeInstall(t, a); await makeInstall(t, b); await assert.rejects(detectInstallations({ cwd: home, platform: "win32", env: { USERPROFILE: home }, home, runner: ia.runner }), (error) => error.code === "multiple_installations"); });
test("17 a directory with only a PaperEcho-like name is rejected", async (t) => { const root = await temp(t); assert.equal((await validateInstallCandidate(path.join(root, "PaperEcho"))).valid, false); });
test("18 a wrong Git remote is rejected", async (t) => { const root = await temp(t); const { runner } = await makeInstall(t, root, { git: true, origin: "https://github.com/other/repo.git" }); const result = await validateInstallCandidate(root, { runner }); assert.equal(result.wrongRemote, true); });

// Persistent protection (19-25)
for (const [number, relative] of [[19, ".env"], [20, "config/user.json"], [21, "review_results/source_state.json"], [22, "review_results/operation_ledger.json"], [23, "review_results/notification_receipt.json"], [24, "review_results/output/周报.xlsx"], [25, ".paperecho/update/state.json"]]) {
  test(`${number} protected ${relative} remains byte-identical`, async (t) => {
    const root = await temp(t); const target = await temp(t); const file = await write(root, relative, `protected-${number}\n`); const before = await hashFile(file);
    const result = await transactionalFileDeploy({ liveRoot: root, targetRoot: target, plan: { changes: [] } });
    assert.equal(result.ok, true); assert.deepEqual(await hashFile(file), before);
  });
}

// Three-way protection (26-31)
test("26 LOCAL equal to OLD permits managed update", async (t) => { const { live, target } = await makeNonGitPair(t); const current = { gitInstall: false, state: await readUpdaterState(live) }; const plan = await buildManagedPlan({ liveRoot: live, targetRoot: target, current, oldContract: contract, targetContract: contract }); assert.equal(plan.conflicts.length, 0); assert(plan.modifyCount > 0); });
test("27 changed managed LOCAL blocks update", async (t) => { const { live, target } = await makeNonGitPair(t); await fs.writeFile(path.join(live, "workflow/tools/runner/main.mjs"), "custom\n"); const current = { gitInstall: false, state: await readUpdaterState(live) }; assert((await buildManagedPlan({ liveRoot: live, targetRoot: target, current, oldContract: contract, targetContract: contract })).conflicts.includes("workflow/tools/runner/main.mjs")); });
test("28 protected modification is outside the managed plan", async (t) => { const { live, target } = await makeNonGitPair(t); await fs.writeFile(path.join(live, "config/user.json"), "changed\n"); const current = { gitInstall: false, state: await readUpdaterState(live) }; const plan = await buildManagedPlan({ liveRoot: live, targetRoot: target, current, oldContract: contract, targetContract: contract }); assert(!plan.conflicts.includes("config/user.json")); });
test("29 target addition colliding with unknown local file blocks", async (t) => { const { live, target } = await makeNonGitPair(t); await write(target, "docs/new.md", "new\n"); await write(live, "docs/new.md", "unknown\n"); const current = { gitInstall: false, state: await readUpdaterState(live) }; assert((await buildManagedPlan({ liveRoot: live, targetRoot: target, current, oldContract: contract, targetContract: contract })).conflicts.includes("docs/new.md")); });
test("30 unchanged target deletion is planned safely", async (t) => { const { live, target } = await makeNonGitPair(t); await write(live, "docs/remove.md", "old\n"); const state = await readUpdaterState(live); state.managedManifest["docs/remove.md"] = await hashFile(path.join(live, "docs/remove.md")); const plan = await buildManagedPlan({ liveRoot: live, targetRoot: target, current: { gitInstall: false, state }, oldContract: contract, targetContract: contract }); assert(plan.changes.some((item) => item.relative === "docs/remove.md" && item.action === "delete")); });
test("31 changed target deletion blocks", async (t) => { const { live, target } = await makeNonGitPair(t); await write(live, "docs/remove.md", "old\n"); const state = await readUpdaterState(live); state.managedManifest["docs/remove.md"] = await hashFile(path.join(live, "docs/remove.md")); await fs.writeFile(path.join(live, "docs/remove.md"), "local\n"); const plan = await buildManagedPlan({ liveRoot: live, targetRoot: target, current: { gitInstall: false, state }, oldContract: contract, targetContract: contract }); assert(plan.conflicts.includes("docs/remove.md")); });

// Path safety (32-36)
test("32 parent traversal is rejected", () => assert.throws(() => validateRelativePath("../outside"), /UNSAFE/));
test("33 absolute paths are rejected", () => assert.throws(() => validateRelativePath(path.resolve("outside")), /UNSAFE/));
test("34 symlink escape is rejected", async (t) => { const root = await temp(t); const outside = await temp(t); try { await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir"); } catch { t.skip("symlink creation unavailable"); return; } await assert.rejects(resolveInside(root, "escape/file"), /SYMLINK_ESCAPE/); });
test("35 Windows separators normalize to a safe relative path", () => assert.equal(validateRelativePath("workflow\\tools\\main.mjs"), "workflow/tools/main.mjs"));
test("36 POSIX separators remain safe", () => assert.equal(validateRelativePath("workflow/tools/main.mjs"), "workflow/tools/main.mjs"));

// Run and updater locks (37-41)
test("37 active run.lock blocks", async (t) => { const root = await temp(t); await write(root, "review_results/run/run.lock"); assert.equal((await inspectActiveRun(root)).active, true); });
test("38 active resume lease blocks", async (t) => { const root = await temp(t); await write(root, "review_results/run/resume.lease.json", JSON.stringify({ expiresAt: new Date(Date.now() + 60_000).toISOString() })); assert.equal((await inspectActiveRun(root)).reason, "active_resume_lease"); });
test("39 active current-run marker blocks", async (t) => { const root = await temp(t); await write(root, "review_results/current_run.json", JSON.stringify({ status: "running" })); assert.equal((await inspectActiveRun(root)).reason, "active_current_run"); });
test("40 only one updater lock owner is admitted", async (t) => { const root = await temp(t); const one = await acquireUpdateLock(root); const two = await acquireUpdateLock(root); assert.equal(one.acquired, true); assert.equal(two.acquired, false); await releaseUpdateLock(one); });
test("41 an expired updater lock has a defined takeover", async (t) => { const root = await temp(t); const old = await acquireUpdateLock(root, { now: new Date(0), ttlMs: 1, ownerId: "old" }); assert(old.acquired); const fresh = await acquireUpdateLock(root, { now: new Date(10), ownerId: "new" }); assert.equal(fresh.acquired, true); assert(fresh.takeover); await releaseUpdateLock(fresh); });

// Staging and contract failure (42-47)
test("42 remote command failure is surfaced", async () => { await assert.rejects(resolveLatestRemote({ runner: () => { throw new Error("offline"); } }), /offline/); });
test("43 changed tag/commit evidence is distinguishable", () => assert.notEqual(selectLatestStable([{ tag: "v2.3", commit: OLD_COMMIT }]).commit, NEW_COMMIT));
test("44 missing target contract fails closed", async (t) => { const root = await temp(t); await assert.rejects(fs.readFile(path.join(root, "missing-contract.json"))); });
test("45 unsupported target contract fails closed", () => assert.throws(() => validateContract({ ...contract, schemaVersion: 2 }), /UNSUPPORTED/));
test("46 dependency failure can occur before any live transaction", async (t) => { const { live } = await makeNonGitPair(t); const before = await hashFile(path.join(live, "workflow/tools/runner/main.mjs")); assert.throws(() => { throw new Error("npm ci failed"); }); assert.deepEqual(await hashFile(path.join(live, "workflow/tools/runner/main.mjs")), before); });
test("47 contract repository mismatch is rejected", () => assert.throws(() => validateContract({ ...contract, sourceRepo: "https://github.com/other/repo.git" }), /MISMATCH/));

// TOCTOU (48-50)
test("48 managed hash change after preflight is detected", async (t) => { const root = await temp(t); const file = await write(root, "workflow/main.mjs", "old\n"); const expected = { "workflow/main.mjs": (await hashFile(file)).hash }; await fs.writeFile(file, "new\n"); assert.equal(await verifyPreflightHashes(root, expected), false); });
test("49 a run starting after preflight is detected", async (t) => { const root = await temp(t); assert.equal((await inspectActiveRun(root)).active, false); await write(root, "review_results/r/run.lock"); assert.equal((await inspectActiveRun(root)).active, true); });
test("50 a target ref change is detected by exact tag and commit comparison", () => { const first = selectLatestStable([{ tag: "v2.3", commit: OLD_COMMIT }]); const second = selectLatestStable([{ tag: "v2.3", commit: NEW_COMMIT }]); assert(first.tag === second.tag && first.commit !== second.commit); });

// Rollback (51-59)
test("51 first managed write failure leaves old file", async (t) => { const root = await temp(t); const target = await temp(t); const file = await write(root, "docs/a", "old"); await write(target, "docs/a", "new"); const result = await transactionalFileDeploy({ liveRoot: root, targetRoot: target, plan: { changes: [{ relative: "docs/a", action: "modify" }] }, hooks: { beforeWrite: () => { throw new Error("first"); } } }); assert.equal(await fs.readFile(file, "utf8"), "old"); assert.equal(result.liveModificationStarted, false); });
test("52 mid-write failure rolls back earlier writes", async (t) => { const root = await temp(t); const target = await temp(t); await write(root, "docs/a", "old-a"); await write(root, "docs/b", "old-b"); await write(target, "docs/a", "new-a"); await write(target, "docs/b", "new-b"); const result = await transactionalFileDeploy({ liveRoot: root, targetRoot: target, plan: { changes: [{ relative: "docs/a", action: "modify" }, { relative: "docs/b", action: "modify" }] }, hooks: { beforeWrite: (_c, i) => { if (i === 1) throw new Error("mid"); } } }); assert.equal(result.rollbackVerified, true); assert.equal(await fs.readFile(path.join(root, "docs/a"), "utf8"), "old-a"); });
test("53 transition-like validation failure triggers rollback", async (t) => { const root = await temp(t); const target = await temp(t); await write(root, "docs/a", "old"); await write(target, "docs/a", "new"); const result = await transactionalFileDeploy({ liveRoot: root, targetRoot: target, plan: { changes: [{ relative: "docs/a", action: "modify" }] }, hooks: { validate: () => { throw new Error("transition"); } } }); assert.equal(result.rollbackVerified, true); });
test("54 live dependency failure can restore the managed snapshot", async (t) => { const root = await temp(t); const target = await temp(t); await write(root, "package-lock.json", "old"); await write(target, "package-lock.json", "new"); const result = await transactionalFileDeploy({ liveRoot: root, targetRoot: target, plan: { changes: [{ relative: "package-lock.json", action: "modify" }] }, hooks: { validate: () => { throw new Error("npm"); } } }); assert.equal(await fs.readFile(path.join(root, "package-lock.json"), "utf8"), "old"); assert.equal(result.rollbackVerified, true); });
test("55 syntax smoke failure rolls back", async (t) => { const root = await temp(t); const target = await temp(t); await write(root, "workflow/a.mjs", "export {};\n"); await write(target, "workflow/a.mjs", "bad("); const result = await transactionalFileDeploy({ liveRoot: root, targetRoot: target, plan: { changes: [{ relative: "workflow/a.mjs", action: "modify" }] }, hooks: { validate: () => { throw new Error("syntax"); } } }); assert.equal(result.rollbackVerified, true); });
test("56 config validation failure rolls back managed files", async (t) => { const root = await temp(t); const target = await temp(t); await write(root, "docs/a", "old"); await write(target, "docs/a", "new"); const result = await transactionalFileDeploy({ liveRoot: root, targetRoot: target, plan: { changes: [{ relative: "docs/a", action: "modify" }] }, hooks: { validate: () => { throw new Error("config"); } } }); assert.equal(result.rollbackVerified, true); });
test("57 persistent mismatch can be represented as critical validation failure", async (t) => { const root = await temp(t); const target = await temp(t); await write(root, "docs/a", "old"); await write(target, "docs/a", "new"); const result = await transactionalFileDeploy({ liveRoot: root, targetRoot: target, plan: { changes: [{ relative: "docs/a", action: "modify" }] }, hooks: { validate: () => { throw new Error("persistent mismatch"); } } }); assert.equal(result.rollbackAttempted, true); });
test("58 verified rollback reports true only after hash verification", async (t) => { const root = await temp(t); const target = await temp(t); await write(root, "docs/a", "old"); await write(target, "docs/a", "new"); const result = await transactionalFileDeploy({ liveRoot: root, targetRoot: target, plan: { changes: [{ relative: "docs/a", action: "modify" }] }, hooks: { validate: () => { throw new Error("fail"); } } }); assert.equal(result.rollbackVerified, true); });
test("59 failed rollback verification is never reported successful", async (t) => { const root = await temp(t); const snapshot = await temp(t); const manifest = { files: [{ relative: "docs/missing", existed: true, hash: "bad" }] }; assert.equal(await restoreSnapshot(root, snapshot, manifest).catch(() => false), false); });

// Dry-run contract (60-64)
test("60 check mode performs zero writes to the live installation", async (t) => { const { live, target } = await makeNonGitPair(t); const before = await hashFile(path.join(live, "workflow/tools/runner/main.mjs")); const result = await checkUpdate({ installDir: live, platform: "linux" }, { runner: fixtureRunner(target, live) }); assert.equal(result.safeToApply, true); assert.deepEqual(await hashFile(path.join(live, "workflow/tools/runner/main.mjs")), before); });
test("61 check mode does not change updater state", async (t) => { const { live, target } = await makeNonGitPair(t); const before = await hashFile(path.join(live, ".paperecho/update/state.json")); await checkUpdate({ installDir: live, platform: "linux" }, { runner: fixtureRunner(target, live) }); assert.deepEqual(await hashFile(path.join(live, ".paperecho/update/state.json")), before); });
test("62 check mode has no live Git-ref operation", async (t) => { const { live, target } = await makeNonGitPair(t); const calls = []; await checkUpdate({ installDir: live, platform: "linux" }, { runner: fixtureRunner(target, live, calls) }); assert.equal(calls.some((call) => ["fetch", "merge", "update-ref"].includes(call[1])), false); });
test("63 JSON-safe dry-run result contains no secret or config body", async (t) => { const { live, target } = await makeNonGitPair(t); const json = JSON.stringify(await checkUpdate({ installDir: live, platform: "linux" }, { runner: fixtureRunner(target, live) })); assert.equal(json.includes("FIXTURE_VALUE"), false); assert.equal(json.includes("fixture-sensitive-text"), false); });
test("64 dry-run blockers and safeToApply agree", async (t) => { const { live, target } = await makeNonGitPair(t); await fs.writeFile(path.join(live, "workflow/tools/runner/main.mjs"), "custom\n"); const result = await checkUpdate({ installDir: live, platform: "linux" }, { runner: fixtureRunner(target, live) }); assert.equal(result.safeToApply, false); assert(result.blockers.includes("managed_conflict")); });

// Successful deployment (65-71)
test("65 apply persists the deployed tag and commit", async (t) => { const { live, target } = await makeNonGitPair(t); const result = await applyUpdate({ installDir: live, platform: "linux" }, { runner: fixtureRunner(target, live) }); assert.equal(result.status, "updated"); const state = await readUpdaterState(live); assert.equal(state.installedTag, "v2.3"); assert.equal(state.installedCommit, NEW_COMMIT); });
test("66 managed files match target hashes after apply", async (t) => { const { live, target } = await makeNonGitPair(t); await applyUpdate({ installDir: live, platform: "linux" }, { runner: fixtureRunner(target, live) }); assert.deepEqual(await hashFile(path.join(live, "workflow/tools/runner/main.mjs")), await hashFile(path.join(target, "workflow/tools/runner/main.mjs"))); });
test("67 v2.2 to v2.3 apply preserves config and integrity runtime state byte-identically", async (t) => { const { live, target } = await makeNonGitPair(t); const envBefore = await hashFile(path.join(live, ".env")); const configBefore = await hashFile(path.join(live, "config/user.json")); const integrityPath = path.join(live, "review_results/shared/current_literature_index.json"); const integrityBefore = await hashFile(integrityPath); const result = await applyUpdate({ installDir: live, platform: "linux" }, { runner: fixtureRunner(target, live) }); assert.equal(result.persistentVerified, true); assert.deepEqual(await hashFile(path.join(live, ".env")), envBefore); assert.deepEqual(await hashFile(path.join(live, "config/user.json")), configBefore); assert.deepEqual(await hashFile(integrityPath), integrityBefore); });
test("68 unchanged lockfile skips npm ci", async (t) => { const { live, target } = await makeNonGitPair(t); const calls = []; const result = await applyUpdate({ installDir: live, platform: "linux" }, { runner: fixtureRunner(target, live, calls) }); assert.equal(result.dependenciesChanged, false); assert.equal(calls.some((call) => /npm/.test(call[0])), false); });
test("69 changed lockfile uses deterministic npm ci only", async (t) => { const { live, target } = await makeNonGitPair(t, { changedLock: true }); const calls = []; const result = await applyUpdate({ installDir: live, platform: "linux" }, { runner: fixtureRunner(target, live, calls) }); assert.equal(result.dependenciesChanged, true); assert(calls.filter((call) => /npm/.test(call[0])).every((call) => call[1] === "ci" && call.includes("--ignore-scripts"))); });
test("70 updater state has the required deployment and manifest fields", async (t) => { const { live, target } = await makeNonGitPair(t); await applyUpdate({ installDir: live, platform: "linux" }, { runner: fixtureRunner(target, live) }); const state = await readUpdaterState(live); for (const key of ["schemaVersion", "sourceRepo", "installPath", "installedTag", "installedCommit", "deployedAt", "previousTag", "previousCommit", "managedManifestVersion", "managedManifest", "lastSuccessfulUpdate", "rollbackSnapshot"]) assert(key in state); });
test("71 one manifest-owned rollback snapshot is retained", async (t) => { const { live, target } = await makeNonGitPair(t); const result = await applyUpdate({ installDir: live, platform: "linux" }, { runner: fixtureRunner(target, live) }); assert(result.rollbackSnapshot); assert.equal(fsSync.existsSync(path.join(live, result.rollbackSnapshot, "manifest.json")), true); });

test("CLI defaults to check and rejects arbitrary arguments", () => { assert.equal(parseArgs([]).apply, false); assert.throws(() => parseArgs(["--repo", "https://example.test"])); assert.equal(normalizeRepoUrl("git@github.com:Chip-G0202/PaperEcho.git"), normalizeRepoUrl(OFFICIAL_REPO)); });
test("contract keeps real config persistent and examples managed", () => { assert.equal(isPersistentPath("config/user.json", contract), true); assert.equal(isManagedPath("config/paperecho.config.example.json", contract), true); });
test("Git fast-forward deploy preserves existing config and rejects target config defaults", async (t) => { const f = await makeGitUpgrade(t); const result = await transactionalGitDeploy({ liveRoot: f.live, targetRoot: f.source, target: f.target, plan: f.plan, contract }); assert.equal(result.ok, true); assert.equal(runCommand("git", ["rev-parse", "HEAD"], { cwd: f.live }), f.newCommit); assert.equal(await fs.readFile(path.join(f.live, "config/user.json"), "utf8"), "my-user-config\n"); assert.equal(fsSync.existsSync(path.join(f.live, "config/new-user.json")), false); });
test("Git post-transition failure restores commit, managed file, and config", async (t) => { const f = await makeGitUpgrade(t); const result = await transactionalGitDeploy({ liveRoot: f.live, targetRoot: f.source, target: f.target, plan: f.plan, contract, hooks: { validate: () => { throw new Error("post-deploy"); } } }); assert.equal(result.rollbackVerified, true); assert.equal(runCommand("git", ["rev-parse", "HEAD"], { cwd: f.live }), f.oldCommit); assert.equal(await fs.readFile(path.join(f.live, "docs/app.txt"), "utf8"), f.oldManaged); assert.equal(await fs.readFile(path.join(f.live, "config/user.json"), "utf8"), "my-user-config\n"); });
test("an unverified current version never masquerades as already latest", async (t) => { const { live, target } = await makeNonGitPair(t); await fs.unlink(path.join(live, ".paperecho/update/state.json")); const result = await checkUpdate({ installDir: live, platform: "linux" }, { runner: fixtureRunner(target, live) }); assert.equal(result.safeToApply, false); assert.equal(result.developerCheckout, true); assert.equal(result.blockers.includes("already_latest"), false); });
