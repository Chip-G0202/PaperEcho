import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getLiteratureIdentityKeys, LITERATURE_IDENTITY_PRIORITY } from "../tools/lib/literature_identity.mjs";
import {
  emptyZoteroLibraryIndex,
  findLiteratureRecord,
  getDefaultZoteroLibraryIndexPath,
  readZoteroLibraryIndex,
  updateLocalLiteratureIndexItems,
  updateZoteroLibraryIndexItems,
  writeZoteroLibraryIndex,
} from "../tools/lib/zotero_library_index_store.mjs";

test("all paths resolve one shared index and preserve namespaced presence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperflow-shared-index-"));
  const indexPath = getDefaultZoteroLibraryIndexPath(root);
  assert.equal(indexPath, path.join(root, "review_results", "shared", "current_literature_index.json"));
  await writeZoteroLibraryIndex(indexPath, {
    ...emptyZoteroLibraryIndex(),
    live_items: { Z1: { itemKey: "Z1", title: "Shared paper", doi: "https://doi.org/10.0000/example.038BC", collections: [], collection_roles: [] } },
  });
  await updateLocalLiteratureIndexItems(indexPath, [{ local_id: "lp_1", title: "Shared paper", doi: "10.0000/example.038BC", grade: "A" }], { outputRoot: path.join(root, "local") });
  const read = await readZoteroLibraryIndex(indexPath);
  const record = findLiteratureRecord(read.index, { doi: "https://doi.org/10.0000/example.038BC" });
  assert.equal(record.presence.zotero.itemKey, "Z1");
  assert.equal(record.presence.local.local_paper_id, "lp_1");
  assert.equal(record.presence.zotero.local_paper_id, undefined);
  assert.equal(record.presence.local.itemKey, undefined);
});

test("identity priority and normalization are shared", () => {
  assert.deepEqual(LITERATURE_IDENTITY_PRIORITY, ["doi", "pmid", "pmcid", "arxiv", "openalex", "url", "title"]);
  assert.deepEqual(getLiteratureIdentityKeys({ DOI: "https://doi.org/10.0000/example.051", arxiv_id: "2401.1", openalex_id: "https://openalex.org/W1", title: "A  title" }), [
    "doi:10.0000/example.051", "arxiv:2401.1", "openalex:w1", "title:a title",
  ]);
});

test("concurrent namespaced updates do not lose either presence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperflow-shared-concurrent-"));
  const indexPath = path.join(root, "index.json");
  await writeZoteroLibraryIndex(indexPath, { ...emptyZoteroLibraryIndex(), live_items: { Z1: { itemKey: "Z1", title: "One", doi: "10.0000/example.054" } } });
  await Promise.all([
    updateZoteroLibraryIndexItems(indexPath, { Z1: { shortTitle: "中文" } }),
    updateLocalLiteratureIndexItems(indexPath, [{ local_id: "lp_1", title: "One", doi: "10.0000/example.054" }], { outputRoot: root }),
  ]);
  const record = findLiteratureRecord((await readZoteroLibraryIndex(indexPath)).index, { doi: "10.0000/example.054" });
  assert.equal(record.presence.zotero.shortTitle, "中文");
  assert.equal(record.presence.local.local_paper_id, "lp_1");
});

test("failed atomic rename preserves formal index and removes its own temp", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperflow-shared-atomic-"));
  const indexPath = path.join(root, "index.json");
  await fs.mkdir(indexPath);
  await assert.rejects(() => writeZoteroLibraryIndex(indexPath, emptyZoteroLibraryIndex()));
  assert.equal((await fs.readdir(root)).some((name) => name.endsWith(".tmp")), false);
  assert.equal((await fs.stat(indexPath)).isDirectory(), true);
});
