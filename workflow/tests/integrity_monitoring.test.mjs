import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  integrityEvidenceFingerprint,
  normalizeCrossrefIntegrity,
  normalizePubMedIntegrity,
  resolveIntegrityStatus,
} from "../tools/integrity/evidence.mjs";
import { runWeeklyIntegrityMonitor } from "../tools/integrity/main.mjs";
import {
  buildIntegrityMutationPlan,
  excludeConfirmedRetractionsFromWeekly,
  managedCollectionIdsForRecord,
  resolveIntegrityMutationTarget,
} from "../tools/integrity/mutation_plan.mjs";
import { fetchCrossrefIntegrity, fetchPubMedIntegrityBatch } from "../tools/integrity/providers.mjs";
import {
  advanceIntegrityBootstrap,
  integrityEligibleRecords,
  mergeIntegrityProviderResults,
  selectIntegrityCheckBatch,
} from "../tools/integrity/state.mjs";
import { emptyZoteroLibraryIndex, readZoteroLibraryIndex, writeZoteroLibraryIndex } from "../tools/lib/zotero_library_index_store.mjs";
import { parsePubMedIntegrityRecords } from "../tools/stage1/retrieval_step.mjs";

const fixtureRoot = path.join(import.meta.dirname, "fixtures", "integrity");

function record(overrides = {}) {
  return {
    canonical_id: "doi:10.1000/original",
    identity: { doi: "10.1000/original", pmid: "100" },
    title: "Original",
    presence: { zotero: { itemKey: "ITEM1", collections: ["POOL", "GRADE", "USER-SAME-NAME"], tags: [{ tag: "UserTag" }] } },
    ...overrides,
  };
}

function success(provider, evidence = [], conflicts = []) { return { provider, status: "success", checked: true, empty: evidence.length === 0, evidence, conflicts }; }

test("Crossref original target accepts structured updated-by retraction", async () => {
  const work = JSON.parse(await fs.readFile(path.join(fixtureRoot, "crossref-original.json")));
  const result = normalizeCrossrefIntegrity(work);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].kind, "retraction");
  assert.equal(result.evidence[0].direction, "updated-by");
  assert.equal(result.evidence[0].targetDoi, "10.1000/original");
});

test("Crossref notice update-to is excluded from target status", () => {
  const result = normalizeCrossrefIntegrity({ DOI: "10.1000/notice", "update-to": [{ DOI: "10.1000/original", type: "retraction", "asserted-by": "publisher" }] });
  assert.equal(result.evidence.length, 0);
  assert.equal(result.directionalExclusions.length, 1);
  assert.equal(resolveIntegrityStatus(result.evidence, result.conflicts).status, "unknown");
});

test("Crossref relation keys preserve original/notice direction", () => {
  const original = normalizeCrossrefIntegrity({ DOI: "10.1/a", relation: { "is-corrected-by": [{ id: "10.1/c", "id-type": "doi" }] } });
  const notice = normalizeCrossrefIntegrity({ DOI: "10.1/c", relation: { "has-correction": [{ id: "10.1/a", "id-type": "doi" }] } });
  assert.equal(original.evidence[0].kind, "correction");
  assert.equal(notice.evidence.length, 0);
  assert.equal(notice.directionalExclusions.length, 1);
});

test("Retraction Watch same record-id conflict fails closed", () => {
  const result = normalizeCrossrefIntegrity({ DOI: "10.1/a", "updated-by": [
    { DOI: "10.1/n1", type: "retraction", "record-id": "RW-1" },
    { DOI: "10.1/n2", type: "correction", "record-id": "RW-1" },
  ] });
  assert.equal(result.conflicts[0].reason, "same_record_id_conflict");
  assert.equal(resolveIntegrityStatus(result.evidence, result.conflicts).status, "unknown");
});

test("independent PubMed evidence confirms retraction despite Retraction Watch conflict", () => {
  const rw = normalizeCrossrefIntegrity({ DOI: "10.1/a", "updated-by": [
    { DOI: "10.1/n1", type: "retraction", "record-id": "RW-1" },
    { DOI: "10.1/n2", type: "correction", "record-id": "RW-1" },
  ] });
  const pm = normalizePubMedIntegrity({ pmid: "100", relations: [{ refType: "RetractionIn", targetPmid: "200" }] });
  const resolved = resolveIntegrityStatus([...rw.evidence, ...pm.evidence], rw.conflicts);
  assert.equal(resolved.status, "retraction");
  assert.deepEqual(resolved.confirmedBy, ["pubmed"]);
});

test("independent Crossref publisher evidence confirms despite conflicting RW data", () => {
  const rw = normalizeCrossrefIntegrity({ DOI: "10.1/a", "updated-by": [
    { DOI: "10.1/n1", type: "retraction", "record-id": "RW-1" },
    { DOI: "10.1/n2", type: "correction", "record-id": "RW-1" },
    { DOI: "10.1/n3", type: "retraction", "asserted-by": "publisher" },
  ] });
  assert.equal(resolveIntegrityStatus(rw.evidence, rw.conflicts).status, "retraction");
});

test("PubMed parser reads CommentsCorrections without title matching", async () => {
  const parsed = parsePubMedIntegrityRecords(await fs.readFile(path.join(fixtureRoot, "pubmed-relations.xml"), "utf8"));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].relations.map((item) => item.refType), ["RetractionIn", "ErratumIn"]);
});

test("PubMed *In applies to original while *Of is notice-only", () => {
  const original = normalizePubMedIntegrity({ pmid: "100", relations: [{ refType: "RetractionIn", targetPmid: "200" }] });
  const notice = normalizePubMedIntegrity({ pmid: "200", relations: [{ refType: "RetractionOf", targetPmid: "100" }] });
  assert.equal(original.evidence[0].kind, "retraction");
  assert.equal(notice.evidence.length, 0);
  assert.equal(notice.directionalExclusions[0].direction, "update-to");
});

test("corrected-and-republished is manual review and never auto-delete", () => {
  const result = normalizePubMedIntegrity({ pmid: "100", relations: [{ refType: "CorrectedandRepublishedIn", targetPmid: "202" }] });
  const resolved = resolveIntegrityStatus(result.evidence, []);
  assert.equal(resolved.status, "unknown");
  assert.equal(resolved.manualReview, true);
});

test("status precedence is retraction over EoC over correction", () => {
  const correction = normalizePubMedIntegrity({ pmid: "100", relations: [{ refType: "ErratumIn", targetPmid: "2" }] }).evidence[0];
  const concern = normalizePubMedIntegrity({ pmid: "100", relations: [{ refType: "ExpressionOfConcernIn", targetPmid: "3" }] }).evidence[0];
  const retraction = normalizePubMedIntegrity({ pmid: "100", relations: [{ refType: "RetractionIn", targetPmid: "4" }] }).evidence[0];
  assert.equal(resolveIntegrityStatus([correction, concern, retraction]).status, "retraction");
  assert.equal(resolveIntegrityStatus([correction, concern]).status, "expression_of_concern");
});

test("evidence fingerprint ignores order and observation timestamps", () => {
  const one = [{ source: "pubmed", kind: "retraction", observedAt: "a" }, { source: "crossref_publisher", kind: "correction" }];
  const two = [{ source: "crossref_publisher", kind: "correction" }, { source: "pubmed", kind: "retraction", observedAt: "b" }];
  assert.equal(integrityEvidenceFingerprint(one), integrityEvidenceFingerprint(two));
});

test("successful empty check advances lastCheckedAt without fabricating evidence", () => {
  const merged = mergeIntegrityProviderResults({}, [success("crossref")], { now: "2026-08-01T00:00:00Z" });
  assert.equal(merged.state.lastCheckedAt, "2026-08-01T00:00:00.000Z");
  assert.equal(merged.state.evidence.length, 0);
  assert.equal(merged.allRequiredSuccessful, true);
});

test("provider outage records attempt but does not advance lastCheckedAt", () => {
  const previous = { currentStatus: "unknown", lastCheckedAt: "2026-07-01T00:00:00.000Z" };
  const merged = mergeIntegrityProviderResults(previous, [{ provider: "crossref", status: "outage", checked: false, evidence: [], error: "HTTP_503" }], { now: "2026-08-01T00:00:00Z" });
  assert.equal(merged.state.lastCheckedAt, previous.lastCheckedAt);
  assert.equal(merged.state.providerChecks.crossref.lastAttemptAt, "2026-08-01T00:00:00.000Z");
  assert.equal(merged.allRequiredSuccessful, false);
});

test("confirmed retraction is sticky across empty, outage, and conflict", () => {
  const previous = { currentStatus: "retraction", evidence: [], lastCheckedAt: "2026-07-01T00:00:00.000Z" };
  for (const result of [success("crossref"), { provider: "crossref", status: "timeout", checked: false, evidence: [] }, success("crossref", [], [{ source: "crossref_retraction_watch", recordId: "x" }])]) {
    assert.equal(mergeIntegrityProviderResults(previous, [result]).state.currentStatus, "retraction");
  }
});

test("eligible scope requires active Zotero presence and DOI or PMID", () => {
  const index = { records: { a: record(), b: record({ canonical_id: "b", presence: { local: {} } }), c: record({ canonical_id: "c", identity: {}, presence: { zotero: { itemKey: "C" } } }) } };
  assert.deepEqual(integrityEligibleRecords(index).map((item) => item.canonical_id), ["doi:10.1000/original"]);
});

test("bootstrap is bounded, checkpointed, and resumable", () => {
  const records = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`r${index}`, record({ canonical_id: `r${index}`, identity: { pmid: String(index + 1) }, presence: { zotero: { itemKey: `K${index}` } } })]));
  const first = selectIntegrityCheckBatch({ records, integrity_monitoring: { bootstrap: {} } }, { maxRecords: 2 });
  assert.equal(first.selected.length, 2);
  const progressed = advanceIntegrityBootstrap(first.bootstrap, first.selected.map((item) => ({ canonicalId: item.canonical_id, allRequiredSuccessful: true })), { now: "2026-08-01" });
  const second = selectIntegrityCheckBatch({ records, integrity_monitoring: { bootstrap: progressed } }, { maxRecords: 2, now: "2026-08-02" });
  assert.equal(second.selected.length, 2);
  assert.equal(new Set([...first.selected, ...second.selected].map((item) => item.canonical_id)).size, 4);
});

test("failed bootstrap identity remains pending while normal progress continues", () => {
  const bootstrap = { eligible_total: 2, completed_identities: [] };
  const progressed = advanceIntegrityBootstrap(bootstrap, [{ canonicalId: "a", allRequiredSuccessful: false }, { canonicalId: "b", allRequiredSuccessful: true }]);
  assert.deepEqual(progressed.completed_identities, ["b"]);
  assert.equal(progressed.bootstrap_complete, false);
});

test("retraction target uses one stable trash ID and only registered managed collection IDs", () => {
  const index = { collections: { POOL: { role: "pool", name: "文献池" }, GRADE: { role: "grade", name: "A课题相关" }, TRASH: { role: "trash", name: "待删除" } } };
  const item = record({ integrity: { currentStatus: "retraction" } });
  const target = resolveIntegrityMutationTarget(index, item);
  assert.equal(target.addCollectionId, "TRASH");
  assert.deepEqual(target.removeCollectionIds, ["POOL", "GRADE"]);
  assert.equal(target.removeCollectionIds.includes("USER-SAME-NAME"), false);
});

test("ambiguous trash IDs fail closed", () => {
  const target = resolveIntegrityMutationTarget({ collections: { A: { role: "trash" }, B: { role: "trash" } } }, record({ integrity: { currentStatus: "retraction" } }));
  assert.equal(target.blocked, true);
  assert.equal(target.reason, "trash_collection_ambiguous");
});

test("correction and EoC plans are additive-tag targets", () => {
  for (const status of ["correction", "expression_of_concern"]) {
    const target = resolveIntegrityMutationTarget({ collections: {} }, record({ integrity: { currentStatus: status } }));
    assert.equal(target.blocked, false);
    assert.equal(target.addTags.length, 1);
    assert.equal("removeCollectionIds" in target, false);
  }
});

test("mutation target fingerprint is stable and duplicate evidence does not duplicate action", () => {
  const item = record({ integrity: { currentStatus: "correction", evidenceFingerprint: "evidence-a" } });
  const index = { records: { [item.canonical_id]: item }, collections: {} };
  const one = buildIntegrityMutationPlan(index, [item.canonical_id]);
  const two = buildIntegrityMutationPlan(index, [item.canonical_id]);
  assert.equal(one.length, 1);
  assert.equal(one[0].target.targetFingerprint, two[0].target.targetFingerprint);
});

test("confirmed retraction wins over ordinary weekly admission", () => {
  const index = { records: { a: record({ integrity: { currentStatus: "retraction" } }) } };
  const filtered = excludeConfirmedRetractionsFromWeekly([{ doi: "10.1000/original" }, { doi: "10.1000/other" }], index);
  assert.deepEqual(filtered, [{ doi: "10.1000/other" }]);
});

test("managed collection lookup is ID-based and preserves same-name user collection", () => {
  const index = { collections: { POOL: { role: "pool", name: "文献池" } } };
  assert.deepEqual(managedCollectionIdsForRecord(index, record()), ["POOL"]);
});

test("Crossref provider uses exact DOI endpoint and structured JSON only", async () => {
  let seen;
  const result = await fetchCrossrefIntegrity("https://doi.org/10.1000/ORIGINAL", { attempts: 1, fetchImpl: async (url, options) => {
    seen = { url, options };
    return { ok: true, status: 200, headers: { get: () => "" }, text: async () => JSON.stringify({ message: { DOI: "10.1000/original", "updated-by": [] } }) };
  } });
  assert.equal(seen.url, "https://api.crossref.org/works/10.1000%2Foriginal");
  assert.equal(seen.options.method, "GET");
  assert.equal(result.status, "success");
  assert.equal(result.empty, true);
});

test("PubMed provider batches IDs with POST and distinguishes missing partial records", async () => {
  const xml = await fs.readFile(path.join(fixtureRoot, "pubmed-relations.xml"), "utf8");
  let seen;
  const results = await fetchPubMedIntegrityBatch(["100", "200", "999"], { attempts: 1, fetchImpl: async (url, options) => {
    seen = { url, options };
    return { ok: true, status: 200, headers: { get: () => "" }, text: async () => xml };
  } });
  assert.equal(seen.options.method, "POST");
  assert.match(seen.options.body, /id=100%2C200%2C999/);
  assert.equal(results.get("100").status, "success");
  assert.equal(results.get("999").status, "partial");
});

test("weekly monitor is disabled by default and Radar always skips", async () => {
  assert.equal((await runWeeklyIntegrityMonitor({ enabled: false })).status, "disabled");
  assert.equal((await runWeeklyIntegrityMonitor({ enabled: true, profile: "radar" })).reason, "weekly_only");
});

test("weekly monitor checkpoints state atomically and is idempotent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-integrity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "review_results", "shared", "current_literature_index.json");
  const index = emptyZoteroLibraryIndex();
  index.live_items.ITEM1 = { itemKey: "ITEM1", title: "Original", doi: "10.1000/original", pmid: "100", collections: [], indexed_at: "2026-08-01T00:00:00Z" };
  index.records["doi:10.1000/original"] = record();
  await writeZoteroLibraryIndex(indexPath, index);
  const crossref = async () => success("crossref");
  const pubmed = async (pmids) => new Map(pmids.map((pmid) => [pmid, success("pubmed")]));
  const first = await runWeeklyIntegrityMonitor({ enabled: true, indexPath, now: new Date("2026-08-01T00:00:00Z"), fetchCrossref: crossref, fetchPubmedBatch: pubmed });
  const second = await runWeeklyIntegrityMonitor({ enabled: true, indexPath, now: new Date("2026-08-01T00:01:00Z"), fetchCrossref: crossref, fetchPubmedBatch: pubmed });
  assert.equal(first.checkedCount, 1);
  assert.equal(second.checkedCount, 0);
  const persisted = await readZoteroLibraryIndex(indexPath);
  assert.equal(persisted.index.integrity_monitoring.bootstrap.bootstrap_complete, true);
  assert.equal(persisted.index.records["doi:10.1000/original"].integrity.currentStatus, "unknown");
});

test("full shared-index refresh preserves integrity namespace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-integrity-refresh-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "index.json");
  const old = emptyZoteroLibraryIndex();
  old.live_items.ITEM1 = { itemKey: "ITEM1", title: "Original", doi: "10.1000/original" };
  old.records["doi:10.1000/original"] = record({ integrity: { currentStatus: "retraction" } });
  old.integrity_monitoring.bootstrap = { completed_identities: ["doi:10.1000/original"] };
  await writeZoteroLibraryIndex(file, old);
  const refreshed = emptyZoteroLibraryIndex();
  refreshed.coverage.zotero.complete = true;
  refreshed.live_items.ITEM1 = { itemKey: "ITEM1", title: "Original", doi: "10.1000/original" };
  await writeZoteroLibraryIndex(file, refreshed);
  const read = await readZoteroLibraryIndex(file);
  assert.equal(read.index.records["doi:10.1000/original"].integrity.currentStatus, "retraction");
  assert.deepEqual(read.index.integrity_monitoring.bootstrap.completed_identities, ["doi:10.1000/original"]);
});
