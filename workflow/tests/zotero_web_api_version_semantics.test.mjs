import assert from "node:assert/strict";
import test from "node:test";

import { ZoteroWebApiBackend } from "../tools/lib/zotero_web_api_backend.mjs";

function jsonResponse(status, data = {}, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["Content-Type", "application/json"], ...Object.entries(headers)]),
    json: async () => data,
    text: async () => "",
  };
}

test('collection reads exclude deleted markers in either API location without losing active false markers', async () => {
  const backend = new ZoteroWebApiBackend({ userId: 'fixture-library', apiKey: 'mock' });
  const entries = [
    ...[true, 1, '1', 'true', ' TRUE '].flatMap((deleted, i) => [
      { key: `TOP${i}`, deleted, data: { name: '26.10', parentCollection: 'ROOT', deleted: false } },
      { key: `DATA${i}`, data: { name: '26.10', parentCollection: 'ROOT', deleted } },
    ]),
    ...[undefined, false, 0, '0', 'false'].map((deleted, i) => ({ key: `LIVE${i}`, deleted, data: { name: '26.10', parentCollection: 'ROOT', deleted } })),
  ];
  backend._request = async method => { assert.equal(method, 'GET'); return { data: entries, totalResults: entries.length }; };
  const expected = entries.filter(c => c.key.startsWith('LIVE')).map(c => c.key);
  for (const collections of [await backend.getCollections(), await backend.getAllCollections(), await backend.getSubcollections('ROOT')]) assert.deepEqual(collections.map(c => c.key), expected);
});

test('deleted month is never reused; normal creation keeps parent and repeat execution reuses only active collections', async () => {
  const backend = new ZoteroWebApiBackend({ userId: 'fixture-library', apiKey: 'mock' });
  const entries = [{ key: 'ROOT', data: { name: '文献池', parentCollection: false } },
    { key: '52UAIEVB', deleted: 1, data: { name: '26.10', parentCollection: 'ROOT' } }];
  const posts = [];
  backend._request = async (method, endpoint, body) => {
    if (method === 'POST') {
      assert.equal(endpoint, '/collections'); posts.push(body);
      const key = `NEW${posts.length}`; entries.push({ key, data: body[0] });
      return { data: { successful: { 0: { key } } } };
    }
    assert.equal(method, 'GET');
    if (endpoint.startsWith('/collections/top?')) return { data: entries.filter(c => !c.data.parentCollection) };
    const parent = endpoint.match(/^\/collections\/([^/]+)\/collections$/)?.[1];
    assert.ok(parent); assert.notEqual(parent, '52UAIEVB');
    return { data: entries.filter(c => c.data.parentCollection === parent) };
  };
  const input = { rootKey: 'ROOT', monthName: '26.10', dayName: '26.10.27', sourceNames: ['RSS订阅'], gradeNames: ['A课题相关'] };
  const first = await backend.ensureWritebackCollections(input);
  assert.equal(first.month.key, 'NEW1'); assert.equal(first.month.parentCollection, 'ROOT');
  assert.deepEqual(posts[0], [{ name: '26.10', parentCollection: 'ROOT' }]);
  const count = posts.length;
  const second = await backend.ensureWritebackCollections(input);
  assert.equal(second.month.key, first.month.key); assert.equal(second.created.length, 0); assert.equal(posts.length, count);
  assert.equal((await backend.ensureCollectionPath(['文献池', '26.10'])).rootKey, first.month.key);
  assert.equal(posts.length, count);
});

test('filtering deleted collections does not change raw pagination offsets or hide active later pages', async () => {
  const backend = new ZoteroWebApiBackend({ userId: 'fixture-library', apiKey: 'mock' });
  const offsets = [];
  backend._request = async (_method, endpoint) => {
    const offset = Number(new URL(endpoint, 'https://mock.invalid').searchParams.get('offset') || 0); offsets.push(offset);
    return { totalResults: 101, data: offset === 0 ? Array.from({ length: 100 }, (_, i) => ({ key: `DEL${i}`, deleted: 1, data: { name: '26.10' } })) : [{ key: 'LIVE', data: { name: '26.10' } }] };
  };
  assert.deepEqual((await backend.getCollections({ limit: 101 })).map(c => c.key), ['LIVE']);
  assert.deepEqual(offsets, [0, 100]); offsets.length = 0;
  assert.deepEqual((await backend.getAllCollections()).map(c => c.key), ['LIVE']); assert.deepEqual(offsets, [0, 100]);
});

test("412 and 428 fail immediately without ordinary retries", async () => {
  for (const status of [412, 428]) {
    const backend = new ZoteroWebApiBackend({ userId: "u", apiKey: "k", retries: 3, intervalMs: 1 });
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { calls += 1; return jsonResponse(status); };
    try {
      await assert.rejects(() => backend._request("PATCH", "/items/K1", { title: "x" }), new RegExp(`HTTP ${status}`));
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("existing-object writes fail closed when no positive version is available", async () => {
  const backend = new ZoteroWebApiBackend({ userId: "u", apiKey: "k" });
  backend._getItemVersion = async () => 0;
  let writes = 0;
  backend._request = async () => { writes += 1; return { data: {} }; };
  await assert.rejects(() => backend.updateItem("K1", { title: "x" }), /version_missing/);
  await assert.rejects(() => backend.writeMetadata("K1", { title: "x" }), /version_missing/);
  assert.equal(writes, 0);
});

test("unversioned creates use a stable 32-character write token per request and batches at 50", async () => {
  const backend = new ZoteroWebApiBackend({ userId: "u", apiKey: "k" });
  const requests = [];
  backend._request = async (method, path, body, options) => {
    requests.push({ method, path, size: body.length, token: options.writeToken });
    return { data: { successful: Object.fromEntries(body.map((_, index) => [index, { key: `K${requests.length}_${index}` }])) } };
  };
  const results = await backend.createItems(Array.from({ length: 51 }, (_, index) => ({ inputIndex: index, title: `T${index}` })));
  assert.equal(results.length, 51);
  assert.deepEqual(requests.map((request) => request.size), [50, 1]);
  assert.ok(requests.every((request) => /^[a-f0-9]{32}$/.test(request.token)));
  assert.notEqual(requests[0].token, requests[1].token);
});

test("single-object create surfaces the per-item failed response", async () => {
  const backend = new ZoteroWebApiBackend({ userId: "u", apiKey: "k" });
  backend._request = async () => ({ data: { successful: {}, unchanged: {}, failed: { 0: { message: "invalid item" } } } });
  await assert.rejects(() => backend.createItem({ title: "bad" }), /invalid item/);
});

test("batch metadata keeps successful, unchanged, failed, and missing results distinct", async () => {
  const backend = new ZoteroWebApiBackend({ userId: "u", apiKey: "k" });
  const methods = [];
  backend._request = async (method) => {
    methods.push(method);
    if (method === "GET") return { data: ["K1", "K2", "K3", "K4"].map((key, index) => ({ key, version: index + 1 })) };
    return {
      data: {
        successful: { 0: { key: "K1" } },
        unchanged: { 1: "K2" },
        failed: { 2: { key: "K3", message: "invalid" } },
      },
    };
  };
  const result = await backend.writeMetadataBatch(["K1", "K2", "K3", "K4"].map((itemKey) => ({ itemKey, fields: { title: itemKey } })));
  assert.deepEqual(result.updated, ["K1"]);
  assert.deepEqual(result.unchanged, ["K2"]);
  assert.deepEqual(result.failed, [
    { itemKey: "K3", error: "invalid" },
    { itemKey: "K4", error: "batch_update_result_missing" },
  ]);
  assert.deepEqual(methods, ["GET", "POST"]);
});

test("batch metadata uses POST batches of at most 50 and preserves per-item versions", async () => {
  for (const count of [1, 49, 50, 51, 241]) {
    const backend = new ZoteroWebApiBackend({ userId: "u", apiKey: "k" });
    const gets = [], posts = [];
    backend._request = async (method, path, body) => {
      if (method === "GET") {
        const keys = path.split("itemKey=")[1].split(",");
        gets.push(keys);
        return { data: keys.map((key, index) => ({ key, version: index + 1 })) };
      }
      posts.push(body);
      return {
        data: { successful: Object.fromEntries(body.map((entry, index) => [index, { key: entry.key, version: 100 + index }])) },
        lastModifiedVersion: 999,
      };
    };
    const result = await backend.writeMetadataBatch(Array.from({ length: count }, (_, index) => ({ itemKey: `K${index}`, fields: { shortTitle: `T${index}` } })));
    assert.equal(result.updated.length, count);
    assert.ok(gets.every((batch) => batch.length <= 50));
    assert.ok(posts.every((batch) => batch.length <= 50));
    assert.deepEqual(posts.map((batch) => batch.length), count <= 50 ? [count] : count === 51 ? [50, 1] : [50, 50, 50, 50, 41]);
    assert.equal(result.libraryVersion, 999);
    assert.equal(result.versions.K0, 100);
  }
});

test("batch metadata reuses known versions and fetches only missing versions", async () => {
  const backend = new ZoteroWebApiBackend({ userId: "u", apiKey: "k" });
  const requests = [];
  backend._request = async (method, path, body) => {
    requests.push({ method, path, body });
    if (method === "GET") return { data: [{ key: "K2", version: 22 }] };
    return { data: { successful: { 0: { version: 31 }, 1: { version: 32 } } }, lastModifiedVersion: 32 };
  };
  const result = await backend.writeMetadataBatch([
    { itemKey: "K1", version: 11, fields: { shortTitle: "A" } },
    { itemKey: "K2", fields: { shortTitle: "B" } },
  ]);
  assert.equal(requests.filter((request) => request.method === "GET").length, 1);
  assert.match(requests[0].path, /itemKey=K2$/);
  assert.deepEqual(requests.find((request) => request.method === "POST").body.map((entry) => entry.version), [11, 22]);
  assert.deepEqual(result.updated, ["K1", "K2"]);

  requests.length = 0;
  await backend.writeMetadataBatch([{ itemKey: "K1", version: 11, fields: { shortTitle: "A" } }]);
  assert.equal(requests.filter((request) => request.method === "GET").length, 0);
});

test("batch metadata skips POST when fetched metadata already matches", async () => {
  const backend = new ZoteroWebApiBackend({ userId: "u", apiKey: "k" });
  const methods = [];
  backend._request = async (method) => {
    methods.push(method);
    if (method === "GET") return { data: [{ key: "K1", version: 1, data: { shortTitle: "same", collections: ["C"], tags: [{ tag: "keep" }], creators: [{ lastName: "Keep" }] } }] };
    throw new Error("POST should not be called");
  };
  const result = await backend.writeMetadataBatch([{ itemKey: "K1", fields: { shortTitle: "same" } }]);
  assert.deepEqual(methods, ["GET"]);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.unchanged, ["K1"]);
});

test("batch metadata transport failure propagates without per-item request amplification", async () => {
  const backend = new ZoteroWebApiBackend({ userId: "u", apiKey: "k" });
  let singleWrites = 0;
  backend.writeMetadata = async () => { singleWrites++; };
  backend._request = async (method) => {
    if (method === "GET") return { data: [{ key: "K1", version: 1 }, { key: "K2", version: 2 }] };
    throw new Error("HTTP 500");
  };
  const result = await backend.writeMetadataBatch(["K1", "K2"].map((itemKey) => ({ itemKey, fields: { shortTitle: itemKey } })));
  assert.equal(singleWrites, 0);
  assert.equal(result.failed.length, 2);
});

test("batch precondition failures do not fall back to unguarded item writes", async () => {
  for (const status of [412, 428]) {
    const backend = new ZoteroWebApiBackend({ userId: "u", apiKey: "k" });
    let fallbackWrites = 0;
    backend.writeMetadata = async () => { fallbackWrites += 1; };
    backend._request = async (method) => {
      if (method === "GET") return { data: [{ key: "K1", version: 1 }] };
      const error = new Error(`HTTP ${status}`);
      error.status = status;
      throw error;
    };
    const result = await backend.writeMetadataBatch([{ itemKey: "K1", fields: { title: "x" } }]);
    assert.equal(fallbackWrites, 0);
    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.failed, [{ itemKey: "K1", error: `HTTP ${status}` }]);
  }
});

test("bulk delete uses library versions in 50-item chunks and advances from 204 headers", async () => {
  const backend = new ZoteroWebApiBackend({ userId: "u", apiKey: "k" });
  const deletes = [];
  backend._request = async (method, path, body, options) => {
    assert.equal(method, "DELETE");
    deletes.push({ path, version: options.ifUnmodifiedSinceVersion });
    return { data: null, lastModifiedVersion: deletes.length === 1 ? 20 : 30 };
  };
  const keys = Array.from({ length: 51 }, (_, index) => `K${index}`);
  const result = await backend.deleteItems(keys, { libraryVersion: 10 });
  assert.deepEqual(deletes.map((entry) => entry.version), [10, 20]);
  assert.deepEqual(deletes.map((entry) => entry.path.split("itemKey=")[1].split(",").length), [50, 1]);
  assert.deepEqual(result.deleted, keys);
  assert.equal(result.libraryVersion, 30);
});

test("collection membership sends complete arrays and does not count unchanged as modified", async () => {
  const backend = new ZoteroWebApiBackend({ userId: "u", apiKey: "k" });
  let patchBody = null;
  backend._request = async (method, path, body) => {
    if (method === "GET") {
      const key = path.split("/").at(-1);
      return { data: { key, version: key === "K1" ? 1 : 2, data: { collections: ["EXISTING"] } } };
    }
    patchBody = body;
    return { data: { successful: { 0: { key: "K1" } }, unchanged: { 1: "K2" }, failed: {} } };
  };
  const result = await backend.addItemsToCollection(["K1", "K2"], "TARGET", { verify: false });
  assert.deepEqual(patchBody.map((item) => item.collections), [["EXISTING", "TARGET"], ["EXISTING", "TARGET"]]);
  assert.deepEqual(patchBody.map((item) => item.version), [1, 2]);
  assert.deepEqual(result.added, ["K1"]);
  assert.deepEqual(result.unchanged, ["K2"]);
});

test("204 responses expose the new Last-Modified-Version", async () => {
  const backend = new ZoteroWebApiBackend({ userId: "u", apiKey: "k", retries: 1 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 204,
    headers: new Map([["Last-Modified-Version", "42"]]),
    text: async () => "",
  });
  try {
    const result = await backend._request("DELETE", "/items?itemKey=K1", null, { ifUnmodifiedSinceVersion: 41 });
    assert.equal(result.lastModifiedVersion, 42);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
