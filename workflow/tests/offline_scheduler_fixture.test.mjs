import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);

for (const mode of ['desktop','web']) for (const outcome of ['success','failure']) {
  test(`offline scheduled ${mode}: fresh claim, ${outcome}, durable dedup without providers`, async () => {
    const { stdout } = await run(process.execPath, [path.join(repo, 'tests/helpers/offline_scheduler_fixture.mjs'), mode, outcome],
      { cwd: repo, timeout: 60000, maxBuffer: 32768, env: { SystemRoot: process.env.SystemRoot, PAPERECHO_SKIP_DOTENV: '1' } });
    const report = JSON.parse(stdout);
    assert.equal(report.status, 'PASS'); assert.equal(report.stage0Called, true);
    assert.equal(report.initialClaimAbsent, true); assert.equal(report.initialLedgerEmpty, true);
    assert.equal(report.completedLedger, true); assert.equal(report.retrievals, 1);
    assert.equal(report.failureRecovered, outcome === 'failure'); assert.equal(report.externalCalls, 0);
    assert.equal(report.osTriggerEvidence, false); assert.equal(report.duplicate, 'already_completed');
    // Only this returned UUID directory, with matching fixture owner, may be removed.
    assert.equal(path.dirname(report.root), path.join(repo, 'tests/runs/scheduler-offline'));
    assert.match(path.basename(report.root), /^[a-f0-9-]{36}$/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(report.root, 'fixture.json'))), { owner: 'offline-scheduler-v1', mode });
    await fs.rm(report.root, { recursive: true });
    await assert.rejects(fs.stat(report.root), { code: 'ENOENT' });
  });
}
