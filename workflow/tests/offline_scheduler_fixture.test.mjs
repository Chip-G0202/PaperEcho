import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(repo, 'tests/runs/scheduler-offline');
const run = promisify(execFile);
const invoke = async (...args) => {
  const { stdout } = await run(process.execPath, [path.join(repo, 'tests/helpers/offline_scheduler_fixture.mjs'), ...args],
    { cwd: repo, timeout: 60000, maxBuffer: 32768, env: { SystemRoot: process.env.SystemRoot, PAPERECHO_SKIP_DOTENV: '1' } });
  return JSON.parse(stdout);
};
async function inventory(root) {
  const files = {};
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) await visit(file);
      else files[path.relative(root, file)] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  await visit(root); return files;
}
async function cleanup(created) {
  assert.equal(path.dirname(created.root), base);
  assert.equal(path.basename(created.root), created.reference);
  assert.equal((await fs.lstat(created.root)).isSymbolicLink(), false);
  const marker = JSON.parse(await fs.readFile(path.join(created.root, 'fixture.json')));
  assert.equal(marker.owner, 'offline-scheduler-v2'); assert.equal(marker.reference, created.reference);
  await fs.rm(created.root, { recursive: true });
  await assert.rejects(fs.stat(created.root), { code: 'ENOENT' });
}

for (const mode of ['desktop','web']) for (const outcome of ['success','failure']) {
  test(`persistent offline ${mode}: cross-process ${outcome}, claim/ledger recovery and dedup`, async () => {
    const created = await invoke('init', mode, outcome);
    assert.equal(created.initialClaimAbsent, true); assert.equal(created.initialLedgerEmpty, true);
    const observations = [created];
    const call = async operation => { const result = await invoke(operation, created.reference); observations.push(result); return result; };
    const initialBytes = await inventory(created.root);
    const empty = await call('inspect');
    assert.equal(empty.ledgerStatus, 'absent'); assert.equal(empty.stage1Executions, 0);
    assert.deepEqual(await inventory(created.root), initialBytes, 'inspect must not write');
    const first = await call('run');
    assert.equal(first.retrievals, 1); assert.equal(first.deliveries, 1);
    assert.equal(first.action, outcome === 'failure' ? 'failed' : 'executed');
    assert.ok(first.claimSha256); assert.ok(first.runId);
    let completed = first;
    if (outcome === 'failure') {
      const failed = await call('inspect');
      assert.notEqual(failed.ledgerStatus, 'completed'); assert.equal(failed.status, 'resume');
      completed = await call('run');
      assert.equal(completed.action, 'recovered'); assert.equal(completed.retrievals, 0);
      assert.equal(completed.deliveries, 1); assert.equal(completed.claimSha256, first.claimSha256);
    }
    assert.equal(completed.ledgerStatus, 'completed');
    assert.equal(completed.deliveryAttempts, outcome === 'failure' ? 2 : 1);
    const completedBytes = await inventory(created.root);
    const inspected = await call('inspect');
    assert.equal(inspected.ledgerStatus, 'completed'); assert.equal(inspected.stage1Executions, 1);
    assert.deepEqual(await inventory(created.root), completedBytes);
    const duplicate = await call('run');
    assert.equal(duplicate.action, 'duplicate'); assert.equal(duplicate.status, 'already_completed');
    assert.equal(duplicate.retrievals, 0); assert.equal(duplicate.deliveries, 0);
    const final = await call('inspect');
    assert.equal(final.ledgerSha256, completed.ledgerSha256);
    assert.equal(final.claimSha256, first.claimSha256); assert.equal(final.auditSha256, first.auditSha256);
    assert.equal(final.stage1Executions, 1); assert.deepEqual(await inventory(created.root), completedBytes);
    assert.equal(new Set(observations.map(value => value.pid)).size, observations.length, 'separate exited processes required');
    for (const value of observations) {
      assert.equal(value.root, created.root); assert.equal(value.reference, created.reference);
      assert.equal(value.slot, created.slot); assert.equal(value.externalCalls, 0);
      assert.equal(value.environmentRestored, true); assert.equal(value.osTriggerEvidence, false);
    }
    await cleanup(created);
  });
}

test('persistent fixture rejects invalid, missing, unowned, modified and linked references without writes', async () => {
  await assert.rejects(invoke('inspect', '../outside'), /FIXTURE_REFERENCE_INVALID/);
  await assert.rejects(invoke('run', randomUUID()), /ENOENT/);
  const unowned = randomUUID(), unownedRoot = path.join(base, unowned);
  await fs.mkdir(unownedRoot); await fs.writeFile(path.join(unownedRoot, 'sentinel'), 'synthetic');
  const before = await inventory(unownedRoot);
  await assert.rejects(invoke('run', unowned), /ENOENT/);
  assert.deepEqual(await inventory(unownedRoot), before);
  await fs.rm(unownedRoot, { recursive: true });
  const created = await invoke('init', 'desktop', 'success');
  const link = path.join(base, randomUUID());
  await fs.symlink(created.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(invoke('inspect', path.basename(link)), /FIXTURE_LINK_REJECTED/);
  await fs.unlink(link);
  const file = path.join(created.root, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(file)); manifest.mode = 'local';
  await fs.writeFile(file, JSON.stringify(manifest));
  const changed = await inventory(created.root);
  await assert.rejects(invoke('inspect', created.reference), /FIXTURE_MANIFEST_CHANGED/);
  assert.deepEqual(await inventory(created.root), changed);
  await cleanup(created);
});
