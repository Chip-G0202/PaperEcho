import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { acquireWorkflowLease, acquireRunLease, releaseRunLease } from '../tools/recovery/operation_ledger.mjs';
import { inspectStartupRecovery, acquireStartupWorkflowLease, createRunRecoveryCoordinator, resumeRunFromLedger } from '../tools/recovery/run_recovery.mjs';
import { startRunGroup, finishRunGroup } from '../tools/lib/runtime_housekeeping.mjs';
import { main as runner } from '../tools/runner/main.mjs';
import { buildRuntimeConfig } from '../tools/lib/runtime_config.mjs';
import { restoreTransactionRoot, restoreTargetKey, inspectRestoreTransaction } from '../tools/recovery/restore_transaction_status.mjs';
import { EXIT_CODES } from '../tools/runner/constants.mjs';
import { workflowLedgerStatus } from '../tools/lib/orchestrator_status.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const processHelper = path.join(repo, 'tests/helpers/startup_process.mjs');
async function fixture(t) {
  const base = path.join(repo, 'tests/runs/phase10'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, '启动 安全-')), children = [];
  const runRoot = path.join(root, 'data/runs');
  t.after(async () => {
    for (const item of children) if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill();
    await Promise.all(children.map(item => item.closed));
    assert.ok(!path.relative(base, root).startsWith('..')); await fs.rm(root, { recursive: true, force: true });
  });
  const launch = (command, kind, nonce = '') => {
    const child = spawn(process.execPath, [processHelper, command, runRoot, kind, nonce], { cwd: repo, windowsHide: true,
      env: { ...process.env, PAPERECHO_SKIP_DOTENV: '1', PAPERECHO_LAYOUT: 'installed', PAPERECHO_APPLICATION_ROOT: path.join(root, 'app'), PAPERECHO_DATA_ROOT: path.join(root, 'data'), PAPERECHO_CACHE_ROOT: path.join(root, 'cache') },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const messages = [], pending = [];
    child.on('message', value => { const index = pending.findIndex(x => x.step === value.step || value.step === 'failed');
      if (index < 0) messages.push(value); else { const waiter = pending.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(value); } });
    const closed = new Promise(resolve => child.once('close', code => resolve(code)));
    const next = step => { const index = messages.findIndex(x => x.step === step || x.step === 'failed'); if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => { const waiter = { step, resolve }; waiter.timer = setTimeout(() => reject(new Error('STARTUP_FIXTURE_TIMEOUT')), 15000); pending.push(waiter); }); };
    const item = { child, closed, next }; children.push(item); return item;
  };
  return { root, runRoot, launch };
}

test('expired foreign run and workflow leases remain untouched and block admission', async t => {
  const f = await fixture(t);
  for (const acquire of [acquireRunLease, acquireWorkflowLease]) {
    const lease = await acquire({ runRoot: f.runRoot, runId: 'startup-crash', profile: 'standard', ttlMs: 1 }, { hostname: 'foreign-fixture', clock: () => new Date('2000-01-01') });
    const before = await fs.readFile(lease.leasePath);
    const result = await acquire({ runRoot: f.runRoot, runId: 'startup-crash', profile: 'standard' });
    assert.equal(result.acquired, false); assert.ok(before.equals(await fs.readFile(lease.leasePath)));
    await releaseRunLease(lease);
  }
});

async function registered(f, runId = 'registered', completed = false) {
  await startRunGroup({ runRoot: f.runRoot, runId, pipelineMode: 'local' });
  const c = await createRunRecoveryCoordinator({ runRoot: f.runRoot, runId, mode: 'local', profile: 'standard', configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath: path.join(f.runRoot, runId, 'input_artifact.json') });
  await c.persistArtifact([]);
  if (completed) {
    for (const stage of ['stage1', 'state_persist', 'stage4_exports']) await c.store.setStage(stage, 'verified');
    await c.store.setStage('stage5_notification', 'skipped'); await c.store.setRunStatus('completed', 'completed');
  }
  await finishRunGroup({ manifestPath: path.join(f.runRoot, runId, 'run_group.json'), status: completed ? 'completed' : 'interrupted' });
  return c;
}

test('cold startup and complete prior runs are read-only; newer completion never hides unfinished work', async t => {
  const f = await fixture(t);
  assert.equal((await inspectStartupRecovery(f)).state, 'SAFE_TO_CONTINUE');
  await assert.rejects(fs.access(f.runRoot));
  await registered(f, 'complete', true);
  const before = await fs.readFile(path.join(f.runRoot, 'complete/operation_ledger.json'));
  assert.equal((await inspectStartupRecovery(f)).state, 'SAFE_TO_CONTINUE');
  assert.ok(before.equals(await fs.readFile(path.join(f.runRoot, 'complete/operation_ledger.json'))));
  await registered(f, 'unfinished'); await registered(f, 'newer-complete', true);
  const state = await inspectStartupRecovery(f); assert.equal(state.state, 'RECOVERY_REQUIRED'); assert.equal(state.runId, 'unfinished');
  assert.equal((await inspectStartupRecovery({ ...f, resumeRunId: 'unfinished' })).canResume, true);
  assert.equal((await inspectStartupRecovery({ ...f, resumeRunId: 'unfinished', automatic: true })).canResume, false);
  const rejected = await acquireStartupWorkflowLease({ ...f, runId: 'new-rejected', profile: 'standard' });
  assert.equal(rejected.acquired, false); await assert.rejects(fs.access(path.join(f.runRoot, 'new-rejected'))); await assert.rejects(fs.access(path.join(f.runRoot, '.workflow.lease.json')));
});

test('malformed, linked, unbound and legacy admission facts fail closed without changing their bytes', async t => {
  const f = await fixture(t), c = await registered(f);
  const ledger = c.store.filePath, before = await fs.readFile(ledger), link = path.join(f.root, 'linked.json');
  await fs.link(ledger, link); assert.equal((await inspectStartupRecovery(f)).state, 'UNKNOWN'); await fs.unlink(link);
  await fs.writeFile(ledger, '{'); assert.equal((await inspectStartupRecovery(f)).state, 'UNKNOWN'); assert.equal(await fs.readFile(ledger, 'utf8'), '{'); await fs.writeFile(ledger, before);
  await c.store.mutate(next => { next.artifact.path = path.join(f.root, 'outside.json'); }); assert.equal((await inspectStartupRecovery(f)).state, 'UNKNOWN');
  await fs.writeFile(path.join(f.runRoot, '.runner.operation.lock'), '{"pid":123}'); assert.equal((await inspectStartupRecovery(f)).code, 'STARTUP_LEGACY_ADMISSION_UNCONFIRMED');
});

test('formal no-effect skip is terminal, while a skipped record with started effects remains blocked', async t => {
  const f = await fixture(t), runId = 'interval-skip';
  await startRunGroup({ runRoot: f.runRoot, runId, pipelineMode: 'web' });
  const c = await createRunRecoveryCoordinator({ runRoot: f.runRoot, runId, mode: 'web', profile: 'standard', configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath: path.join(f.runRoot, runId, 'input_artifact.json') });
  await c.store.setRunStatus('skipped', 'skipped');
  await finishRunGroup({ manifestPath: path.join(f.runRoot, runId, 'run_group.json'), status: 'skipped' });
  assert.equal((await inspectStartupRecovery(f)).state, 'SAFE_TO_CONTINUE');
  await c.prepareFileOperation({ type: 'zotero_item_create', targetId: 'dummy', input: {}, inputVersion: 1 });
  assert.equal((await inspectStartupRecovery(f)).blocking, true);
});

test('zero-effect business completion needs authoritative stage and artifact facts, never empty-ledger success', async t => {
  const f = await fixture(t), c = await registered(f, 'empty-business', true);
  await c.store.setRunStatus(workflowLedgerStatus('completed', c.store.ledger.operations), 'completed');
  assert.equal(c.store.ledger.status, 'incomplete');
  assert.equal((await inspectStartupRecovery(f)).state, 'SAFE_TO_CONTINUE');
  await c.store.setStage('stage1', 'pending'); assert.equal((await inspectStartupRecovery(f)).blocking, true);
  await c.store.setStage('stage1', 'verified');
  await c.store.mutate(next => { next.artifact.hash = 'pending'; }); assert.equal((await inspectStartupRecovery(f)).blocking, true);
});

test('scheduled startup rejects unfinished runs and live owners before selection or external business calls', async t => {
  const f = await fixture(t), env = { PAPERECHO_LAYOUT: 'installed', PAPERECHO_APPLICATION_ROOT: path.join(f.root, 'app'), PAPERECHO_DATA_ROOT: path.join(f.root, 'data'), PAPERECHO_CACHE_ROOT: path.join(f.root, 'cache'), PAPERECHO_SKIP_DOTENV: '1' };
  f.runRoot = buildRuntimeConfig({ env }).runRoot;
  const c = await registered(f, 'unfinished'); let selections = 0, productions = 0;
  const dependencies = { env, stdout: { write() {} }, stderr: { write() {} }, runtimeLog: { write: async () => ({ ok: true }) },
    resolveRunnerConfigurationImpl: async options => ({ options, env }), selectScheduledDailyRunImpl: async () => { selections++; assert.fail('unsafe selection'); },
    runProductionImpl: async () => { productions++; assert.fail('unsafe side effect'); } };
  const before = await fs.readFile(c.store.filePath);
  assert.equal(await runner(['--run', '--mode', 'desktop', '--scheduled-daily'], dependencies), 5);
  assert.ok(before.equals(await fs.readFile(c.store.filePath)));
  const lease = await acquireWorkflowLease({ runRoot: f.runRoot, runId: 'live', profile: 'standard' });
  try { assert.equal(await runner(['--run', '--mode', 'desktop', '--scheduled-daily'], dependencies), 5); }
  finally { await releaseRunLease(lease); }
  assert.equal(selections, 0); assert.equal(productions, 0);
});

for (const phase of ['claim', 'ledger', 'accepted', 'unknown']) test(`real Runner termination at ${phase} preserves facts and prevents blind replay on restart`, async t => {
  const f = await fixture(t), child = f.launch('runner', phase);
  assert.equal((await child.next('boundary')).phase, phase); child.child.kill(); await child.closed;
  assert.equal((await fs.readdir(f.runRoot)).some(name => name === '.runner.operation.lock'), false);
  const dependencies = { clock: () => new Date(Date.now() + 120000) };
  const state = await inspectStartupRecovery({ ...f, resumeRunId: 'startup-crash', automatic: true }, dependencies);
  assert.equal(state.state, phase === 'claim' ? 'UNKNOWN' : 'RECOVERY_REQUIRED');
  if (phase === 'claim') { assert.equal(state.code, 'STARTUP_ORPHAN_LEASE_UNCONFIRMED'); return; }
  assert.equal(state.canResume, phase === 'accepted');
  const ledgerPath = path.join(f.runRoot, 'startup-crash/operation_ledger.json'), before = await fs.readFile(ledgerPath);
  const refused = await acquireStartupWorkflowLease({ ...f, runId: 'new-run', profile: 'standard' }, dependencies);
  assert.equal(refused.acquired, false); assert.ok(before.equals(await fs.readFile(ledgerPath)));
  if (!['accepted', 'unknown'].includes(phase)) return;
  const store = JSON.parse(before), receiptPath = store.operations[0].target.path, receiptBefore = await fs.readFile(receiptPath);
  const result = await resumeRunFromLedger({ runRoot: f.runRoot, runId: 'startup-crash', mode: 'local', profile: 'standard', configHash: 'a'.repeat(64),
    notification: { transport: () => assert.fail('no external replay'), recipient: 'fixture@example.invalid' }, buildReconcilers: () => assert.fail('no repeated business work') });
  assert.equal(result.status, phase === 'accepted' ? 'completed' : 'blocked');
  assert.ok(receiptBefore.equals(await fs.readFile(receiptPath)));
  if (phase === 'accepted') {
    const repeated = await resumeRunFromLedger({ runRoot: f.runRoot, runId: 'startup-crash', mode: 'local', profile: 'standard', configHash: 'a'.repeat(64),
      notification: { transport: () => assert.fail('no duplicate notification'), recipient: 'fixture@example.invalid' }, buildReconcilers: () => assert.fail('no repeated business work') });
    assert.equal(repeated.status, 'completed'); assert.equal((await inspectStartupRecovery(f, dependencies)).state, 'SAFE_TO_CONTINUE');
  }
});

for (const kind of ['run', 'workflow']) test(`real ${kind} owner termination and concurrent stale takeover elect one live owner`, async t => {
  const f = await fixture(t), old = f.launch('old', kind);
  assert.equal((await old.next('claimed')).acquired, true);
  const acquire = kind === 'run' ? acquireRunLease : acquireWorkflowLease;
  assert.equal((await acquire({ runRoot: f.runRoot, runId: 'startup-crash', profile: 'standard' })).acquired, false, 'expiry never steals a live process');
  old.child.kill(); await old.closed;
  const a = f.launch('race', kind), b = f.launch('race', kind);
  assert.equal((await a.next('before.link')).step, 'before.link'); assert.equal((await b.next('before.link')).step, 'before.link');
  a.child.send('continue'); b.child.send('continue');
  const results = await Promise.all([a.next('claimed'), b.next('claimed')]);
  assert.equal(results.filter(x => x.acquired).length, 1); assert.equal(results.filter(x => x.acquired === false).length, 1);
  const directory = kind === 'run' ? path.join(f.runRoot, 'startup-crash') : f.runRoot;
  const archives = (await fs.readdir(directory)).filter(x => x.includes('.takeover.'));
  assert.equal(archives.length, 1); assert.equal((await fs.lstat(path.join(directory, archives[0]))).nlink, 1);
});

test('interrupted lease archive publication stays blocked without deleting either hardlink', async t => {
  const f = await fixture(t), old = f.launch('old', 'workflow'); await old.next('claimed'); old.child.kill(); await old.closed;
  const interrupted = f.launch('interrupted', 'workflow'); assert.equal((await interrupted.next('after.link')).step, 'after.link'); interrupted.child.kill(); await interrupted.closed;
  const names = await fs.readdir(f.runRoot); assert.equal(names.length, 2);
  await assert.rejects(acquireWorkflowLease({ runRoot: f.runRoot, runId: 'startup-crash', profile: 'standard' }), /WORKFLOW_LEASE_UNREADABLE/);
  assert.deepEqual(await fs.readdir(f.runRoot), names);
  for (const name of names) assert.equal((await fs.lstat(path.join(f.runRoot, name))).nlink, 2);
});

test('only a real direct child with matching parent identity borrows without releasing the parent lease', async t => {
  const f = await fixture(t), lease = await acquireWorkflowLease({ runRoot: f.runRoot, runId: 'startup-crash', profile: 'standard' });
  const bad = f.launch('borrow', 'workflow', 'forged-fixture'); assert.equal((await bad.next('borrowed')).acquired, false);
  const child = f.launch('borrow', 'workflow', lease.lease.ownerId), result = await child.next('borrowed');
  assert.equal(result.acquired, true); assert.equal(result.borrowed, true); assert.equal(result.released, false);
  assert.equal(JSON.parse(await fs.readFile(lease.leasePath)).ownerId, lease.lease.ownerId); await releaseRunLease(lease);
});

test('scheduled skips cannot bypass PREPARED restore or migration transactions', async t => {
  const f=await fixture(t), data=path.join(f.root,'data');
  const env={PAPERECHO_LAYOUT:'installed',PAPERECHO_APPLICATION_ROOT:path.join(f.root,'app'),PAPERECHO_DATA_ROOT:data,PAPERECHO_CACHE_ROOT:path.join(f.root,'cache'),PAPERECHO_SKIP_DOTENV:'1'};
  await fs.mkdir(buildRuntimeConfig({env}).runRoot,{recursive:true});
  const tx=restoreTransactionRoot(data), file=path.join(tx,'status.json');
  let selections=0, productions=0, text='';
  const dependencies={env,stdout:{write:v=>{text+=v;}},stderr:{write(){}},runtimeLog:{write:async()=>({ok:true})},
    resolveRunnerConfigurationImpl:async options=>({options,env}),
    selectScheduledDailyRunImpl:async()=>{selections++;return {status:'before_scheduled_slot',decision:{reason:'before_scheduled_slot'}};},
    runProductionImpl:async()=>{productions++;assert.fail('no external business');}};
  for(const kind of ['restore-existing','upgrade-new-root']){
    await fs.mkdir(tx);
    await fs.writeFile(file,JSON.stringify({schemaVersion:1,owner:'paperecho-restore',operationId:'00000000-0000-4000-8000-000000000001',targetKey:restoreTargetKey(data),kind,state:'PREPARED'}));
    const before=await fs.readFile(file);text='';
    assert.equal(inspectRestoreTransaction(data).state,'PREPARED');
    assert.equal(await runner(['--run','--scheduled-daily','--mode','desktop'],dependencies),EXIT_CODES.pipeline);
    assert.deepEqual(JSON.parse(text.trim()),{type:'schedule',status:'recovery_required',reason:'RESTORE_RECOVERY_REQUIRED'});
    assert.deepEqual(await fs.readFile(file),before);assert.equal(selections,0);assert.equal(productions,0);
    await fs.rm(tx,{recursive:true});
  }
  assert.equal(await runner(['--run','--scheduled-daily','--mode','desktop'],dependencies),EXIT_CODES.success);
  assert.equal(selections,1);assert.equal(productions,0);
});
