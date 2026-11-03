import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { radarClassificationFingerprint, radarNotificationFingerprint, selectRadarNotificationCandidates, recordRadarNotificationOutcome } from '../tools/radar/state.mjs';
import { findLiteratureRecord, readZoteroLibraryIndex, updateSharedLiteratureRecordState } from '../tools/lib/zotero_library_index_store.mjs';

const paper = { doi: '10.1000/stable', title: 'Stable paper', rule_grade: 'A', llm_review_grade: 'A', final_grade: 'A', llm_review: { confidence: 'high', reason: 'first' } };
async function fixture(t, notification) {
  await fs.mkdir('tests/runs/radar-fingerprint', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('tests/runs/radar-fingerprint/case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'index.json');
  if (notification) await updateSharedLiteratureRecordState(file, [{ item: paper, patch: { radar_notification: notification, integrity: { status: 'protected' } } }]);
  return { file, notification: async () => findLiteratureRecord((await readZoteroLibraryIndex(file)).index, paper).radar_notification };
}

test('V2 hashes normalized DOI or title and only substantive grades/confidence', () => {
  const stable = radarNotificationFingerprint(paper);
  assert.match(stable, /^v2:[a-f0-9]{64}$/);
  assert.equal(radarNotificationFingerprint({ ...paper, id: 'random', doi: 'HTTPS://DOI.ORG/10.1000/STABLE', title: 'changed metadata', journal: 'Other', timestamp: 'new', llm_review: { reason: 'different', confidence: 'HIGH', id: 'batch' } }), stable);
  for (const key of ['rule_grade', 'llm_review_grade', 'final_grade']) assert.notEqual(radarNotificationFingerprint({ ...paper, [key]: 'B' }), stable);
  assert.notEqual(radarNotificationFingerprint({ ...paper, llm_review: { confidence: 'medium' } }), stable);
  const titleOnly = { ...paper, doi: '', title: 'Café — Study' };
  assert.equal(radarNotificationFingerprint(titleOnly), radarNotificationFingerprint({ ...titleOnly, id: 'other', pmid: 'changed', title: ' CAFE - study ', llm_review: { confidence: 'high', reason: 'changed' } }));
  const numeric = { ...paper, llm_review: {}, semantic_confidence: 0.9 };
  assert.equal(radarNotificationFingerprint(numeric), stable);
  assert.notEqual(radarNotificationFingerprint(numeric), radarNotificationFingerprint({ ...numeric, semantic_confidence: 0.65 }));
  assert.equal(radarNotificationFingerprint({ ...numeric, semantic_confidence: undefined }), radarNotificationFingerprint({ ...numeric, semantic_confidence: 'untrusted' }));
});

test('new notifications use V2; reason drift never repeats accepted or unknown results', async t => {
  for (const status of ['accepted', 'unknown']) {
    const f = await fixture(t);
    const first = await selectRadarNotificationCandidates(f.file, [paper]);
    assert.equal(first.selected[0].fingerprint, radarNotificationFingerprint(paper));
    await recordRadarNotificationOutcome(f.file, first.selected, { status });
    for (let run = 0; run < 2; run++) {
      const next = await selectRadarNotificationCandidates(f.file, [{ ...paper, id: run, llm_review: { confidence: 'high', reason: `drift ${run}` } }]);
      assert.equal(next.selected.length, 0);
      assert.equal(next.suppressed[0].reason, status === 'accepted' ? 'already_delivered' : 'unknown_held');
    }
    assert.equal((await selectRadarNotificationCandidates(f.file, [{ ...paper, final_grade: 'B' }])).selected.length, 1);
  }
});

test('exact Legacy matches establish only proven V2 baselines without notification or history loss', async t => {
  for (const field of ['deliveredFingerprint', 'unknownFingerprint']) {
    const legacy = radarClassificationFingerprint(paper);
    const f = await fixture(t, { [field]: legacy, lastOutcome: 'unknown', lastOutcomeAt: 'old-time', lastDecisionFingerprint: legacy });
    const result = await selectRadarNotificationCandidates(f.file, [paper]);
    assert.equal(result.selected.length, 0);
    const saved = await f.notification();
    assert.equal(saved[field], radarNotificationFingerprint(paper));
    assert.equal(saved.lastDecisionFingerprint, legacy);
    assert.equal(saved.lastOutcomeAt, 'old-time');
    assert.equal(findLiteratureRecord((await readZoteroLibraryIndex(f.file)).index, paper).integrity.status, 'protected');
    assert.equal((await selectRadarNotificationCandidates(f.file, [{ ...paper, llm_review: { confidence: 'high', reason: 'changed' } }])).selected.length, 0);
  }
});

test('unmatched Legacy history retains exact old decisions and is never blindly baselined', async t => {
  const old = radarClassificationFingerprint(paper);
  const f = await fixture(t, { deliveredFingerprint: old });
  const before = await fs.readFile(f.file, 'utf8');
  for (const changed of [{ ...paper, llm_review: { confidence: 'high', reason: 'drift' } }, { ...paper, final_grade: 'B' }]) {
    const result = await selectRadarNotificationCandidates(f.file, [changed]);
    assert.equal(result.selected[0].fingerprint, radarClassificationFingerprint(changed));
    assert.equal(result.compatibility[0].status, 'legacy_unmatched');
    assert.equal(await fs.readFile(f.file, 'utf8'), before);
  }
});

test('baseline save failure fails closed and leaves old bytes intact', async t => {
  const f = await fixture(t, { deliveredFingerprint: radarClassificationFingerprint(paper) });
  const before = await fs.readFile(f.file, 'utf8');
  await assert.rejects(selectRadarNotificationCandidates(f.file, [paper], { persist: async () => { throw new Error('save failed'); } }), /save failed/);
  await assert.rejects(selectRadarNotificationCandidates(f.file, [paper], { persist: async () => ({ ok: false }) }), /BASELINE_SAVE_FAILED/);
  await assert.rejects(updateSharedLiteratureRecordState(f.file, [{ item: paper, patch: () => { throw new Error('locked update failed'); } }]), /locked update failed/);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['index.json']);
});

test('locked baseline compare preserves a concurrent outcome and other notification slots', async t => {
  const legacy = radarClassificationFingerprint(paper), newer = radarNotificationFingerprint({ ...paper, final_grade: 'B' });
  const f = await fixture(t, { deliveredFingerprint: legacy });
  await selectRadarNotificationCandidates(f.file, [paper], { persist: async (file, updates) => {
    await updateSharedLiteratureRecordState(file, [{ item: paper, patch: { radar_notification: { deliveredFingerprint: newer, unknownFingerprint: legacy, marker: 'keep' } } }]);
    return updateSharedLiteratureRecordState(file, updates);
  } });
  const saved = await f.notification();
  assert.equal(saved.deliveredFingerprint, newer);
  assert.equal(saved.unknownFingerprint, radarNotificationFingerprint(paper));
  assert.equal(saved.marker, 'keep');
  await recordRadarNotificationOutcome(f.file, [{ item: paper, fingerprint: newer }], { status: 'failed' });
  assert.equal((await f.notification()).unknownFingerprint, saved.unknownFingerprint);
});

test('old replay digests stay Legacy and unsupported versions fail closed', async t => {
  const f = await fixture(t);
  const legacy = radarClassificationFingerprint(paper);
  await recordRadarNotificationOutcome(f.file, [{ item: paper, fingerprint: legacy }], { status: 'accepted' });
  assert.equal((await f.notification()).deliveredFingerprint, legacy);
  assert.equal((await selectRadarNotificationCandidates(f.file, [paper])).selected.length, 0);
  await updateSharedLiteratureRecordState(f.file, [{ item: paper, patch: { radar_notification: { deliveredFingerprint: 'v3:' + 'a'.repeat(64) } } }]);
  await assert.rejects(selectRadarNotificationCandidates(f.file, [paper]), /FINGERPRINT_UNSUPPORTED/);
});

test('legacy failed attempts remain retryable; missing delivery evidence is never treated as new', async t => {
  const legacy = radarClassificationFingerprint(paper);
  const f = await fixture(t, { lastOutcome: 'failed', lastDecisionFingerprint: legacy });
  const result = await selectRadarNotificationCandidates(f.file, [paper]);
  assert.equal(result.selected[0].fingerprint, legacy);
  await recordRadarNotificationOutcome(f.file, result.selected, { status: 'accepted' });
  assert.equal((await selectRadarNotificationCandidates(f.file, [paper])).selected.length, 0);
  assert.equal((await f.notification()).deliveredFingerprint, radarNotificationFingerprint(paper));
  await updateSharedLiteratureRecordState(f.file, [{ item: paper, patch: { radar_notification: { lastOutcome: 'accepted', lastDecisionFingerprint: legacy } } }]);
  await assert.rejects(selectRadarNotificationCandidates(f.file, [paper]), /HISTORY_INCOMPLETE/);
});

test('unreadable history and corruption before a locked baseline save never become new notifications', async t => {
  const f = await fixture(t, { deliveredFingerprint: radarClassificationFingerprint(paper) });
  await assert.rejects(selectRadarNotificationCandidates(f.file, [paper], { persist: async (file, updates) => {
    await fs.writeFile(file, 'corrupt');
    return updateSharedLiteratureRecordState(file, updates);
  } }), /CONDITIONAL_UPDATE_UNUSABLE/);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'corrupt');
  await assert.rejects(selectRadarNotificationCandidates(f.file, [paper]), /HISTORY_UNREADABLE/);
  assert.equal(await fs.readFile(f.file, 'utf8'), 'corrupt');
});
