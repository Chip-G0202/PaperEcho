import test from "node:test";
import assert from "node:assert/strict";
import { enrichArchivePlanWithZoteroTitleMatches as enrich, buildFeedbackQueryVariants } from "../tools/maintenance/zotero_feedback_collection_corrections.mjs";
const result = (x) => ({ content: [{ text: JSON.stringify(x) }] });
const row = (title, extra = {}) => ({ status: "needs_review", reason: "no_matching_literature_record", feedback: { english_title: title, feedback: "upgrade" }, ...extra });

test("1000 rows: stable keys, canonical identities, duplicate variants and conditional details bound serial requests", async () => {
  const index = { live_items: {}, records: {}, coverage: { zotero: { complete: false } } };
  const rows = Array.from({ length: 800 }, (_, i) => row(`Synthetic topic ${i % 600}`, { original_level: "B专题相关" }));
  for (let i = 0; i < 200; i++) {
    const key = `LOCAL${i}`;
    index.live_items[key] = { itemKey: key, title: `Existing topic ${i}`, doi: `10.1234/${i}`, tags: ["B专题相关"] };
    rows.push(i % 2 ? row(`Different title ${i}`, { feedback: { doi: `10.1234/${i}`, feedback: "upgrade" } }) : row(`Existing topic ${i}`, { record: { itemKey: key } }));
  }
  let progress;
  await enrich(rows, { localLibraryIndex: index, onProgress: (p) => { progress = p; }, mcpToolCall: async (name, args) => {
    assert.equal(name, "search_library");
    const n = Number(args.title.match(/\d+$/)[0]);
    return result(n < 200 ? [{ key: `REMOTE${n}`, title: args.title }] : []);
  } });
  assert.equal(rows.length, 1000); assert.equal(progress.completed, 1000);
  assert.equal(progress.localResolved, 200); assert.equal(progress.identityResolved, 100);
  assert.equal(progress.remoteRows, 800); assert.equal(progress.uniqueRemoteTasks, 600);
  assert.equal(progress.searchRequests, 600); assert.equal(progress.detailRequests, 0);
  assert.equal(progress.remoteRequests, 600); assert.equal(progress.cacheHits, 200);
  assert.equal(progress.searchOriginalRequests + progress.searchCleanedRequests + progress.searchShortenedRequests, 600);
});

test("equivalent variants deduplicate before request and remote canonical response populates exact alias cache", async () => {
  assert.equal(buildFeedbackQueryVariants("Title—Case").length, 1);
  const rows = [row("IFN-β response", { feedback: { english_title: "IFN-β response", feedback: "keep" } }), row("IFN-beta response", { feedback: { english_title: "IFN-beta response", feedback: "keep" } })];
  let progress;
  await enrich(rows, { localLibraryIndex: { live_items: {} }, onProgress: (p) => { progress = p; }, mcpToolCall: async (name, args) => {
    assert.equal(name, "search_library"); return result(args.title.includes("β") ? [] : [{ key: "EXACT", title: "IFN-beta response" }]);
  } });
  assert.equal(progress.searchOriginalRequests, 1); assert.equal(progress.searchCleanedRequests, 1);
  assert.equal(progress.aliasCacheHits, 1); assert.equal(progress.detailRequests, 0);
  assert.equal(rows[0].record.itemKey, rows[1].record.itemKey);
});

test("fallback query shared with another task hits variant cache even for no-match", async () => {
  const title = 'Long alpha beta ' + 'topic '.repeat(80);
  const fallback = buildFeedbackQueryVariants(title).at(-1).query;
  let calls = 0, progress;
  await enrich([row(title), row(fallback)], { localLibraryIndex: { live_items: {} }, onProgress: (p) => { progress = p; }, mcpToolCall: async () => { calls++; return result([]); } });
  assert.equal(calls, buildFeedbackQueryVariants(title).length);
  assert.ok(progress.cacheHits >= 1); assert.equal(progress.detailRequests, 0);
});

test("ambiguous/fuzzy results create no identity aliases; parse transient does not fan out", async () => {
  let calls = 0, progress;
  await assert.rejects(enrich([row('Long title ' + 'topic '.repeat(80))], { localLibraryIndex: { live_items: {} }, onProgress: (p) => { progress = p; }, mcpToolCall: async () => { calls++; throw new Error('Parse error -32700'); } }), { status: "failed" });
  assert.equal(calls, 1); assert.equal(progress.transientFailures, 1); assert.equal(progress.searchCleanedRequests, 0); assert.equal(progress.searchShortenedRequests, 0);
  calls = 0;
  const rows = [row('Title'), row('Another title')];
  await enrich(rows, { localLibraryIndex: { live_items: {} }, mcpToolCall: async () => { calls++; return result([{ key: 'ONE', title: 'Title' }, { key: 'TWO', title: 'Title' }]); } });
  assert.equal(calls, 2); assert.equal(rows[0].status, 'conflict'); assert.equal(rows[1].record, undefined);
});

test("known feedback key and canonical record resolve without title lookup; conflicting IDs remain ambiguous", async () => {
  const records = { one: { canonical_id: 'doi:10.1234/a', identity: { doi: '10.1234/a' }, title: 'Canonical', presence: { zotero: { itemKey: 'ONE', tags: ['B专题相关'] } } } };
  const rows = [row('Old', { feedback: { itemKey: 'ONE', feedback: 'keep' } }), row('Old', { record: { stable_id: 'doi:10.1234/a' } })];
  await enrich(rows, { localLibraryIndex: { records, live_items: {} }, mcpToolCall: async () => { throw Error('unexpected request'); } });
  assert.ok(rows.every(r => r.record.itemKey === 'ONE'));
});

test("feedback final grade is sufficient evidence; missing grade fetches details once per stable key", async () => {
  let details = 0;
  const rows = [row('First', { feedback: { english_title: 'First', feedback: 'upgrade', raw: { '最终等级': 'B' } } }), row('Second')];
  await enrich(rows, { localLibraryIndex: { live_items: {} }, mcpToolCall: async (name, args) => {
    if (name === 'search_library') return result([{ key: 'ONE', title: args.title }]);
    details++; return result({ itemKey: 'ONE', tags: ['B专题相关'] });
  } });
  assert.equal(details, 1); assert.ok(rows.every(r=>r.assigned_level === 'A课题相关'));
});
