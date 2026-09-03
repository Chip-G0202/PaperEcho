import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("zotero_backend_base", () => {
  it("exports ZoteroBackendBase class", async () => {
    const { ZoteroBackendBase } = await import("../tools/lib/zotero_backend_base.mjs");
    const base = new ZoteroBackendBase();
    assert.equal(base.backendType, "base");
  });

  it("all methods throw Not implemented", async () => {
    const { ZoteroBackendBase } = await import("../tools/lib/zotero_backend_base.mjs");
    const base = new ZoteroBackendBase();
    const methods = [
      "ping", "ensureReady", "getCollections", "getSubcollections", "getCollectionItems",
      "ensureCollectionPath", "createCollection", "ensureWritebackCollections", "deleteCollection",
      "addItemsToCollection", "addItemsToCollections", "removeItemsFromCollection", "verifyItemsInCollection",
      "moveItemsBetweenCollections", "getItemDetails", "searchLibrary",
      "createItem", "createItems", "deleteItems", "updateItem", "writeTag", "writeMetadata", "writeMetadataBatch",
    ];
    for (const method of methods) {
      await assert.rejects(() => base[method](), /Not implemented/);
    }
  });

  it("createVerifyResult returns correct shape", async () => {
    const { createVerifyResult } = await import("../tools/lib/zotero_backend_base.mjs");
    const result = createVerifyResult();
    assert.deepEqual(result, { success: true, present: [], missing: [] });
  });

  it("createWriteResult returns correct shape", async () => {
    const { createWriteResult } = await import("../tools/lib/zotero_backend_base.mjs");
    const result = createWriteResult();
    assert.deepEqual(result, { added: [], verified: [], removed: [], failed: [] });
  });
});

describe("zotero_adapter auto-detection", () => {
  it("recommends web_api when only API key is set", async () => {
    const origKey = process.env.ZOTERO_API_KEY;
    const origUser = process.env.ZOTERO_USER_ID;
    try {
      process.env.ZOTERO_API_KEY = "test_key";
      delete process.env.ZOTERO_USER_ID;
      const { getRecommendedBackend } = await import("../tools/lib/ensure_zotero_backend_ready.mjs");
      const rec = getRecommendedBackend();
      assert.equal(rec.backend, "web_api");
      assert.equal(rec.desktopRequired, false);
    } finally {
      if (origKey === undefined) delete process.env.ZOTERO_API_KEY;
      else process.env.ZOTERO_API_KEY = origKey;
      if (origUser === undefined) delete process.env.ZOTERO_USER_ID;
      else process.env.ZOTERO_USER_ID = origUser;
    }
  });

  it("recommends cli when env vars missing", async () => {
    const origKey = process.env.ZOTERO_API_KEY;
    const origUser = process.env.ZOTERO_USER_ID;
    try {
      delete process.env.ZOTERO_API_KEY;
      delete process.env.ZOTERO_USER_ID;
      const { getRecommendedBackend } = await import("../tools/lib/ensure_zotero_backend_ready.mjs");
      const rec = getRecommendedBackend();
      assert.equal(rec.backend, "cli");
      assert.equal(rec.desktopRequired, true);
    } finally {
      if (origKey === undefined) delete process.env.ZOTERO_API_KEY;
      else process.env.ZOTERO_API_KEY = origKey;
      if (origUser === undefined) delete process.env.ZOTERO_USER_ID;
      else process.env.ZOTERO_USER_ID = origUser;
    }
  });
});

describe("zotero_cli_executor", () => {
  it("executeCli returns structured result on success", async () => {
    const { executeCli } = await import("../tools/lib/zotero_cli_executor.mjs");
    const result = await executeCli("node", ["-e", "console.log(42)"], { json: false, timeoutMs: 5000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "42");
    assert.equal(result.data, null);
  });

  it("executeCli parses JSON output", async () => {
    const { executeCli } = await import("../tools/lib/zotero_cli_executor.mjs");
    const result = await executeCli("node", ["-e", "console.log(JSON.stringify({ok:true}))"], { json: true, timeoutMs: 5000 });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.data, { ok: true });
  });

  it("executeCli preserves arguments with spaces without shell parsing", async () => {
    const { executeCli } = await import("../tools/lib/zotero_cli_executor.mjs");
    const result = await executeCli("node", ["-e", "process.stdout.write(process.argv[1])", "title with spaces"], { json: false, timeoutMs: 5000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "title with spaces");
  });

  it("executeCli handles non-zero exit code", async () => {
    const { executeCli } = await import("../tools/lib/zotero_cli_executor.mjs");
    const result = await executeCli("node", ["-e", "console.error('failed output'); process.exit(1)"], { json: false, timeoutMs: 5000 });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stderr, "failed output");
  });

  it("executeCli handles invalid JSON gracefully", async () => {
    const { executeCli } = await import("../tools/lib/zotero_cli_executor.mjs");
    // Use a command that outputs non-JSON text
    const result = await executeCli("node", ["-e", "console.log(42)"], { json: true, timeoutMs: 5000 });
    // 42 is valid JSON, so data should be parsed
    assert.equal(result.exitCode, 0);
    assert.equal(result.data, 42);
  });

  it("executeCli handles truly invalid JSON gracefully", async () => {
    const { executeCli } = await import("../tools/lib/zotero_cli_executor.mjs");
    // Write a temp file with non-JSON content and read it
    const fs = await import("node:fs");
    const tmpFile = "workflow/tests/_tmp_test_output.txt";
    fs.writeFileSync(tmpFile, "not json at all");
    try {
      const result = await executeCli("node", ["-e", `console.log(require('fs').readFileSync('${tmpFile}','utf8'))`], { json: true, timeoutMs: 5000 });
      assert.equal(result.exitCode, 0);
      assert.equal(result.data, null); // JSON parse failed
      assert.equal(result.stdout, "not json at all");
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("checkCliAvailable returns true for node", async () => {
    const { checkCliAvailable } = await import("../tools/lib/zotero_cli_executor.mjs");
    const available = await checkCliAvailable("node");
    assert.equal(available, true);
  });

  it("checkCliAvailable returns false for nonexistent command", async () => {
    const { checkCliAvailable } = await import("../tools/lib/zotero_cli_executor.mjs");
    const available = await checkCliAvailable("nonexistent_command_xyz_12345");
    assert.equal(available, false);
  });

  it("resolveCliSpawnSpec uses direct spawn by default", async () => {
    const { resolveCliSpawnSpec } = await import("../tools/lib/zotero_cli_executor.mjs");
    assert.deepEqual(resolveCliSpawnSpec("zot", ["search", "title with spaces"], { platform: "linux" }), {
      command: "zot",
      args: ["search", "title with spaces"],
      windowsVerbatimArguments: false,
    });
  });

  it("resolveCliSpawnSpec wraps Windows cmd and bat shims explicitly", async () => {
    const { resolveCliSpawnSpec } = await import("../tools/lib/zotero_cli_executor.mjs");
    const spec = resolveCliSpawnSpec("C:\\Program Files\\Zotero CLI\\zotero-cli.cmd", ["item", "find", "中文 title"], {
      platform: "win32",
      comspec: "C:\\Windows\\System32\\cmd.exe",
    });
    assert.equal(spec.command, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
    assert.match(spec.args[3], /^"C:\\Program Files\\Zotero CLI\\zotero-cli\.cmd" item find "中文 title"$/);
    assert.equal(spec.windowsVerbatimArguments, false);
  });

  it("getDefaultCliTool separates web and desktop defaults", async () => {
    const { getDefaultCliTool } = await import("../tools/lib/zotero_cli_executor.mjs");
    const origLegacy = process.env.ZOTERO_CLI_TOOL;
    const origWeb = process.env.ZOTERO_WEB_CLI_TOOL;
    const origDesktop = process.env.ZOTERO_DESKTOP_CLI_TOOL;
    try {
      delete process.env.ZOTERO_CLI_TOOL;
      delete process.env.ZOTERO_WEB_CLI_TOOL;
      delete process.env.ZOTERO_DESKTOP_CLI_TOOL;
      assert.equal(getDefaultCliTool("web"), "zot");
      assert.equal(getDefaultCliTool("desktop"), "zotero-cli");
      process.env.ZOTERO_WEB_CLI_TOOL = "my-zot";
      process.env.ZOTERO_DESKTOP_CLI_TOOL = "my-desktop-cli";
      assert.equal(getDefaultCliTool("web"), "my-zot");
      assert.equal(getDefaultCliTool("desktop"), "my-desktop-cli");
      process.env.ZOTERO_CLI_TOOL = "my-cli";
      delete process.env.ZOTERO_WEB_CLI_TOOL;
      delete process.env.ZOTERO_DESKTOP_CLI_TOOL;
      assert.equal(getDefaultCliTool("web"), "my-cli");
      assert.equal(getDefaultCliTool("desktop"), "my-cli");
    } finally {
      if (origLegacy === undefined) delete process.env.ZOTERO_CLI_TOOL;
      else process.env.ZOTERO_CLI_TOOL = origLegacy;
      if (origWeb === undefined) delete process.env.ZOTERO_WEB_CLI_TOOL;
      else process.env.ZOTERO_WEB_CLI_TOOL = origWeb;
      if (origDesktop === undefined) delete process.env.ZOTERO_DESKTOP_CLI_TOOL;
      else process.env.ZOTERO_DESKTOP_CLI_TOOL = origDesktop;
    }
  });
});

describe("zotero_cli_backend readiness", () => {
  it("requires connector_available=true from app ping", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const backend = new ZoteroCliBackend({
      executeCli: async () => ({ exitCode: 0, stdout: "", stderr: "", data: { connector_available: false } }),
      checkCliAvailable: async () => true,
    });

    assert.equal(await backend.ping(), false);
  });

  it("accepts app ping only when connector_available=true", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const backend = new ZoteroCliBackend({
      executeCli: async () => ({ exitCode: 0, stdout: "", stderr: "", data: { connector_available: true } }),
      checkCliAvailable: async () => true,
    });

    assert.equal(await backend.ping(), true);
  });

  it("starts Zotero desktop before polling CLI connector readiness", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const events = [];
    const backend = new ZoteroCliBackend({
      launcher: async () => {
        events.push("launch");
        return { ok: true, started_now: true, was_running: false };
      },
      executeCli: async (_tool, args) => {
        if (args[0] === "app" && args[1] === "ping") {
          events.push("ping");
          return { exitCode: 0, stdout: "", stderr: "", data: { connector_available: true } };
        }
        if (args[0] === "session") {
          events.push("session");
          return { exitCode: 0, stdout: "", stderr: "", data: {} };
        }
        throw new Error(`unexpected CLI call: ${args.join(" ")}`);
      },
      checkCliAvailable: async () => true,
      desktopPostStartDelayMs: 0,
    });

    const result = await backend.ensureReady({ retries: 2, intervalMs: 1, log: () => {} });

    assert.equal(result.ok, true);
    assert.equal(result.started_now, true);
    assert.deepEqual(events, ["launch", "ping", "session"]);
  });

  it("does not poll CLI connector when desktop launch fails", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    let pingCalls = 0;
    const backend = new ZoteroCliBackend({
      launcher: async () => ({ ok: false, error: "launch failed" }),
      executeCli: async (_tool, args) => {
        if (args[0] === "app" && args[1] === "ping") pingCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "", data: { connector_available: true } };
      },
      checkCliAvailable: async () => true,
      desktopPostStartDelayMs: 0,
    });

    const result = await backend.ensureReady({ retries: 2, intervalMs: 1, log: () => {} });

    assert.equal(result.ok, false);
    assert.equal(pingCalls, 0);
    assert.match(result.diagnostics.error, /launch failed/);
  });

  it("continues to CLI ping when post-launch process detection misses Zotero", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const { launchZoteroDesktop } = await import("../tools/lib/zotero_desktop_launcher.mjs");
    const events = [];
    const backend = new ZoteroCliBackend({
      launcher: (opts) => launchZoteroDesktop({
        ...opts,
        postStartDelayMs: 0,
        dependencies: {
          detectDesktopProcess: () => ({ running: false, method: "mock", exitCode: 0 }),
          spawn: () => ({
            once: (event, cb) => {
              if (event === "spawn") setTimeout(cb, 0);
            },
            unref: () => {},
          }),
          wait: async () => {},
        },
      }),
      executeCli: async (_tool, args) => {
        if (args[0] === "app" && args[1] === "ping") {
          events.push("ping");
          return { exitCode: 0, stdout: "", stderr: "", data: { connector_available: true } };
        }
        if (args[0] === "session") return { exitCode: 0, stdout: "", stderr: "", data: {} };
        throw new Error(`unexpected CLI call: ${args.join(" ")}`);
      },
      checkCliAvailable: async () => true,
    });

    const result = await backend.ensureReady({ retries: 1, intervalMs: 1, log: () => {} });

    assert.equal(result.ok, true);
    assert.equal(result.started_now, true);
    assert.deepEqual(events, ["ping"]);
    assert.equal(result.diagnostics.launch.diagnostics.processDetectionAfterLaunchUnreliable, true);
  });

  it("forced CLI readiness ignores configured API key", async () => {
    const origKey = process.env.ZOTERO_API_KEY;
    const { ensureZoteroBackendReady } = await import("../tools/lib/ensure_zotero_backend_ready.mjs");
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const { ZoteroWebApiBackend } = await import("../tools/lib/zotero_web_api_backend.mjs");
    const originalCliEnsureReady = ZoteroCliBackend.prototype.ensureReady;
    const originalCliPing = ZoteroCliBackend.prototype.ping;
    const originalWebEnsureReady = ZoteroWebApiBackend.prototype.ensureReady;
    let webCalls = 0;
    try {
      process.env.ZOTERO_API_KEY = "test_key";
      ZoteroCliBackend.prototype.ensureReady = async () => ({ ok: true, diagnostics: { backend: "cli" } });
      ZoteroCliBackend.prototype.ping = async () => true;
      ZoteroWebApiBackend.prototype.ensureReady = async () => {
        webCalls += 1;
        throw new Error("web_api should not be attempted");
      };

      const result = await ensureZoteroBackendReady({
        preferredBackend: "cli",
        retries: 1,
        intervalMs: 1,
        postStartDelayMs: 0,
        log: () => {},
      });

      assert.equal(result.ok, true);
      assert.equal(result.backend, "cli");
      assert.equal(webCalls, 0);
    } finally {
      if (origKey === undefined) delete process.env.ZOTERO_API_KEY;
      else process.env.ZOTERO_API_KEY = origKey;
      ZoteroCliBackend.prototype.ensureReady = originalCliEnsureReady;
      ZoteroCliBackend.prototype.ping = originalCliPing;
      ZoteroWebApiBackend.prototype.ensureReady = originalWebEnsureReady;
    }
  });

  it("passes explicit CLI launch authorization without affecting Web readiness", async () => {
    const { ensureZoteroBackendReady } = await import("../tools/lib/ensure_zotero_backend_ready.mjs");
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const originalEnsureReady = ZoteroCliBackend.prototype.ensureReady;
    const originalPing = ZoteroCliBackend.prototype.ping;
    const launchSettings = [];
    try {
      ZoteroCliBackend.prototype.ensureReady = async function () {
        launchSettings.push(this.launchDesktop);
        return { ok: true, diagnostics: { backend: "cli" } };
      };
      ZoteroCliBackend.prototype.ping = async () => true;
      await ensureZoteroBackendReady({ preferredBackend: "cli", launchDesktop: false, log: () => {} });
      await ensureZoteroBackendReady({ preferredBackend: "cli", launchDesktop: true, log: () => {} });
      assert.deepEqual(launchSettings, [false, true]);
    } finally {
      ZoteroCliBackend.prototype.ensureReady = originalEnsureReady;
      ZoteroCliBackend.prototype.ping = originalPing;
    }
  });

  it("does not invoke the launcher when CLI launch authorization is disabled", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    let launcherCalls = 0;
    const backend = new ZoteroCliBackend({
      launchDesktop: false,
      launcher: async () => { launcherCalls += 1; return { ok: true }; },
      checkCliAvailable: async () => true,
      executeCli: async () => ({ exitCode: 1, data: {} }),
    });

    const result = await backend.ensureReady({ retries: 1, intervalMs: 1, log: () => {} });
    assert.equal(result.ok, false);
    assert.equal(launcherCalls, 0);
  });
});

describe("zotero_cli_backend collection batching", () => {
  it("reads complete item details through the supported JS detail bridge without --full", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const calls = [];
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "", data: { items: [{ key: "ITEM1", data: { key: "ITEM1", title: "Anonymous title", tags: [], collections: [] } }] } };
      },
      checkCliAvailable: async () => true,
    });

    const details = await backend.getItemDetails("ITEM1", "complete");

    assert.equal(details.key, "ITEM1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "js");
    assert.equal(calls[0].includes("--full"), false);
  });

  it("resolves recursive subcollections from one collection tree scan", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const calls = [];
    const tree = [
      {
        key: "ROOT",
        name: "文献池",
        children: [
          {
            key: "MONTH",
            name: "26.07",
            children: [
              { key: "DAY", name: "07.08", children: [{ key: "RSS", name: "RSS订阅" }] },
            ],
          },
        ],
      },
    ];
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args) => {
        calls.push(args);
        return { exitCode: 0, stdout: "", stderr: "", data: tree };
      },
      checkCliAvailable: async () => true,
    });

    const descendants = await backend.getSubcollections("ROOT", true);

    assert.deepEqual(descendants.map((entry) => entry.key), ["MONTH", "DAY", "RSS"]);
    assert.equal(calls.filter((args) => args[0] === "collection" && args[1] === "tree").length, 1);
  });

  it("adds multiple items to a collection with one JS bridge call", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const calls = [];
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args) => {
        calls.push(args);
        assert.equal(args[0], "js");
        return { exitCode: 0, stdout: "", stderr: "", data: { added: ["K1", "K2"], failed: [] } };
      },
      checkCliAvailable: async () => true,
    });

    const result = await backend.addItemsToCollection(["K1", "K2"], "COLL");

    assert.deepEqual(result.added, ["K1", "K2"]);
    assert.deepEqual(result.failed, []);
    assert.equal(calls.length, 1);
    assert.match(calls[0][1], /K1/);
    assert.match(calls[0][1], /COLL/);
  });

  it("treats already-present JS bridge results as successful collection add", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const calls = [];
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args) => {
        calls.push(args);
        if (args[0] === "js") {
          return { exitCode: 0, stdout: "", stderr: "", data: { already: ["K1", "K2"], failed: [] } };
        }
        return { exitCode: 0, stdout: "{}", stderr: "", data: {} };
      },
      checkCliAvailable: async () => true,
    });

    const result = await backend.addItemsToCollection(["K1", "K2"], "COLL");

    assert.deepEqual(result.added, ["K1", "K2"]);
    assert.deepEqual(result.failed, []);
    assert.equal(calls.filter((args) => args[0] === "item" && args[1] === "add-to-collection").length, 0);
  });

  it("adds multiple items to multiple collections with one JS bridge call", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const calls = [];
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args) => {
        calls.push(args);
        assert.equal(args[0], "js");
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          data: { added: [{ itemKey: "K1", collectionKey: "SRC" }, { itemKey: "K1", collectionKey: "GRADE" }], already: [], failed: [] },
        };
      },
      checkCliAvailable: async () => true,
    });

    const result = await backend.addItemsToCollections([
      { collectionKey: "SRC", itemKeys: ["K1", "K2"] },
      { collectionKey: "GRADE", itemKeys: ["K1"] },
    ]);

    assert.equal(result.added.length, 2);
    assert.deepEqual(result.failed, []);
    assert.equal(calls.length, 1);
    assert.match(calls[0][1], /addToCollection/);
    assert.match(calls[0][1], /GRADE/);
  });

  it("updates shortTitle metadata for multiple items with one JS bridge call", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const calls = [];
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args, options) => {
        calls.push(args);
        assert.match(args[0], /zotero_cli_stdin_runner\.py$/);
        assert.equal(args.some((arg) => String(arg).includes("shortTitle")), false);
        assert.match(options.stdin, /setField/);
        assert.match(options.stdin, /shortTitle/);
        return { exitCode: 0, stdout: "", stderr: "", data: { updated: ["K1", "K2"], failed: [] } };
      },
      checkCliAvailable: async () => true,
    });

    const result = await backend.writeMetadataBatch([
      { itemKey: "K1", fields: { shortTitle: "标题1" } },
      { itemKey: "K2", fields: { shortTitle: "标题2" } },
    ]);

    assert.deepEqual(result.updated, ["K1", "K2"]);
    assert.deepEqual(result.failed, []);
    assert.equal(calls.length, 1);
  });

  it("getItemsDetails accepts JS bridge object-wrapped items", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args) => {
        assert.equal(args[0], "js");
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          data: { items: [{ key: "K1", itemKey: "K1", data: { title: "Wrapped" } }] },
        };
      },
      checkCliAvailable: async () => true,
    });

    const details = await backend.getItemsDetails(["K1"]);

    assert.equal(details.length, 1);
    assert.equal(details[0].itemKey, "K1");
  });

  it("createItems uses one JS bridge call and preserves input index mapping", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const calls = [];
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args, options) => {
        calls.push(args);
        assert.match(args[0], /zotero_cli_stdin_runner\.py$/);
        assert.equal(args.some((arg) => String(arg).includes('"inputIndex"')), false);
        assert.match(options.stdin, /return \{ created, failed \}/);
        assert.match(options.stdin, /inputIndex/);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          data: {
            created: [
              { inputIndex: 10, key: "K10", itemKey: "K10" },
              { inputIndex: 11, key: "K11", itemKey: "K11" },
            ],
            failed: [],
          },
        };
      },
      checkCliAvailable: async () => true,
    });

    const result = await backend.createItems([
      { inputIndex: 10, itemType: "journalArticle", title: "One" },
      { inputIndex: 11, itemType: "journalArticle", title: "Two" },
    ]);

    assert.deepEqual(result.created.map((item) => item.itemKey), ["K10", "K11"]);
    assert.deepEqual(result.failed, []);
    assert.equal(calls.length, 1);
  });

  it("deleteItems uses one JS bridge call", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const calls = [];
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args) => {
        calls.push(args);
        assert.equal(args[0], "js");
        assert.match(args[1], /eraseTx/);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          data: { deleted: ["K1", "K2"], failed: [] },
        };
      },
      checkCliAvailable: async () => true,
    });

    const result = await backend.deleteItems(["K1", "K2", "K1"]);

    assert.deepEqual(result.deleted, ["K1", "K2"]);
    assert.deepEqual(result.failed, []);
    assert.equal(calls.length, 1);
  });

  it("ensureWritebackCollections uses one JS bridge call for the Stage2 collection subtree", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const calls = [];
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args) => {
        calls.push(args);
        assert.equal(args[0], "js");
        assert.match(args[1], /new Zotero\.Collection/);
        assert.match(args[1], /getByParent/);
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          data: {
            month: { key: "MONTH", name: "26.07", parentCollection: "POOL" },
            date: { key: "DAY", name: "07.08", parentCollection: "MONTH" },
            sources: {
              "RSS订阅": { key: "RSS", name: "RSS订阅", parentCollection: "DAY" },
            },
            grades: {
              "A课题相关": { key: "A", name: "A课题相关", parentCollection: "DAY" },
            },
            created: [],
            existing: [],
          },
        };
      },
      checkCliAvailable: async () => true,
    });

    const result = await backend.ensureWritebackCollections({
      rootKey: "POOL",
      monthName: "26.07",
      dayName: "07.08",
      sourceNames: ["RSS订阅"],
      gradeNames: ["A课题相关"],
    });

    assert.equal(result.month.key, "MONTH");
    assert.equal(result.sources["RSS订阅"].key, "RSS");
    assert.equal(result.grades["A课题相关"].key, "A");
    assert.equal(calls.length, 1);
  });

  it("createItems sends oversized JS bridge payloads through one stdin process", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const calls = [];
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args, options) => {
        calls.push(args);
        assert.match(args[0], /zotero_cli_stdin_runner\.py$/);
        const matches = [...options.stdin.matchAll(/"inputIndex":(\d+)/g)].map((match) => Number(match[1]));
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          data: {
            created: matches.map((inputIndex) => ({ inputIndex, key: `K${inputIndex}`, itemKey: `K${inputIndex}` })),
            failed: [],
          },
        };
      },
      checkCliAvailable: async () => true,
    });

    const originalMax = process.env.ZOTERO_CLI_BATCH_CREATE_MAX_JS_ARG_CHARS;
    try {
      process.env.ZOTERO_CLI_BATCH_CREATE_MAX_JS_ARG_CHARS = "5000";
      const result = await backend.createItems([
        { inputIndex: 1, itemType: "journalArticle", title: "One", abstractNote: "x".repeat(6000) },
        { inputIndex: 2, itemType: "journalArticle", title: "Two", abstractNote: "y".repeat(6000) },
      ]);

      assert.deepEqual(result.created.map((item) => item.itemKey), ["K1", "K2"]);
      assert.equal(calls.length, 1);
      assert.equal(calls.some((args) => args[0] === "item"), false);
    } finally {
      if (originalMax === undefined) delete process.env.ZOTERO_CLI_BATCH_CREATE_MAX_JS_ARG_CHARS;
      else process.env.ZOTERO_CLI_BATCH_CREATE_MAX_JS_ARG_CHARS = originalMax;
    }
  });

  it("falls back to per-item add when the JS bridge batch call fails", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const calls = [];
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args) => {
        calls.push(args);
        if (args[0] === "js") {
          return { exitCode: 1, stdout: "", stderr: "js failed", data: null };
        }
        return { exitCode: 0, stdout: "{}", stderr: "", data: {} };
      },
      checkCliAvailable: async () => true,
    });

    const result = await backend.addItemsToCollection(["K1", "K2"], "COLL");

    assert.deepEqual(result.added, ["K1", "K2"]);
    assert.equal(calls.filter((args) => args[0] === "js").length, 1);
    assert.deepEqual(
      calls.filter((args) => args[0] === "item").map((args) => args.slice(0, 4)),
      [
        ["item", "add-to-collection", "K1", "COLL"],
        ["item", "add-to-collection", "K2", "COLL"],
      ],
    );
  });

  it("createItem uses one JS bridge call and skips import temp-file path", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const calls = [];
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args) => {
        calls.push(args);
        assert.equal(args[0], "js");
        return { exitCode: 0, stdout: "", stderr: "", data: { key: "ITEM1", itemKey: "ITEM1", createMode: "js_bridge" } };
      },
      checkCliAvailable: async () => true,
    });

    const created = await backend.createItem({
      itemType: "journalArticle",
      title: "Imported title",
      collections: [
        { key: "POOL", name: "文献池" },
        { key: "RSS", name: "RSS订阅" },
        { key: "GRADE", name: "A课题相关" },
      ],
    });

    assert.equal(created.key, "ITEM1");
    assert.equal(created.createMode, "js_bridge");
    assert.equal(calls.length, 1);
    assert.equal(calls.some((args) => args[0] === "import"), false);
    assert.equal(calls.some((args) => args[0] === "item" && args[1] === "add-to-collection"), false);
  });

  it("createItem uses import fallback only with the explicit legacy compatibility flag", async () => {
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const calls = [];
    let importTag = "";
    const backend = new ZoteroCliBackend({
      executeCli: async (_tool, args) => {
        calls.push(args);
        if (args[0] === "js") {
          return { exitCode: 1, stdout: "", stderr: "js create failed", data: null };
        }
        if (args[0] === "import") {
          importTag = args[args.indexOf("--tag") + 1];
          return { exitCode: 0, stdout: "{}", stderr: "", data: {} };
        }
        if (args[0] === "collection" && args[1] === "items") {
          return {
            exitCode: 0,
            stdout: "",
            stderr: "",
            data: [{ key: "ITEM1", title: "Imported title", tags: [{ tag: importTag }] }],
          };
        }
        return { exitCode: 0, stdout: "{}", stderr: "", data: {} };
      },
      checkCliAvailable: async () => true,
    });

    const previous = process.env.ZOTERO_LEGACY_CREATE_FALLBACK;
    process.env.ZOTERO_LEGACY_CREATE_FALLBACK = "1";
    let created;
    try {
      created = await backend.createItem({
        itemType: "journalArticle",
        title: "Imported title",
        collections: [{ key: "GRADE", name: "A课题相关" }],
      });
    } finally {
      if (previous === undefined) delete process.env.ZOTERO_LEGACY_CREATE_FALLBACK;
      else process.env.ZOTERO_LEGACY_CREATE_FALLBACK = previous;
    }

    assert.equal(created.key, "ITEM1");
    assert.equal(created.createMode, "import_json");
    assert.equal(calls.filter((args) => args[0] === "js").length, 1);
    assert.equal(calls.filter((args) => args[0] === "import").length, 1);
  });
});

describe("ensure_zotero_backend_ready probe", () => {
  it("uses app ping instead of collection tree for CLI readiness probe", async () => {
    const { ensureZoteroBackendReady } = await import("../tools/lib/ensure_zotero_backend_ready.mjs");
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const originalEnsureReady = ZoteroCliBackend.prototype.ensureReady;
    const originalPing = ZoteroCliBackend.prototype.ping;
    const originalGetCollections = ZoteroCliBackend.prototype.getCollections;
    let pingCalls = 0;
    try {
      ZoteroCliBackend.prototype.ensureReady = async () => ({
        ok: true,
        diagnostics: { backend: "cli", attempts: 1 },
      });
      ZoteroCliBackend.prototype.ping = async () => {
        pingCalls += 1;
        return true;
      };
      ZoteroCliBackend.prototype.getCollections = async () => {
        throw new Error("collection tree should not be used for CLI readiness");
      };

      const result = await ensureZoteroBackendReady({
        preferredBackend: "cli",
        retries: 1,
        intervalMs: 1,
        postStartDelayMs: 0,
        log: () => {},
      });

      assert.equal(result.ok, true);
      assert.equal(result.backend, "cli");
      assert.equal(pingCalls, 1);
    } finally {
      ZoteroCliBackend.prototype.ensureReady = originalEnsureReady;
      ZoteroCliBackend.prototype.ping = originalPing;
      ZoteroCliBackend.prototype.getCollections = originalGetCollections;
    }
  });

  it("fails closed when the backend probe fails", async () => {
    const origKey = process.env.ZOTERO_API_KEY;
    const origUser = process.env.ZOTERO_USER_ID;
    const origFetch = globalThis.fetch;
    try {
      process.env.ZOTERO_API_KEY = "test_key";
      process.env.ZOTERO_USER_ID = "12345";
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        headers: new Map([["Content-Type", "application/json"]]),
        json: async () => [],
        text: async () => "",
      });
      const { ensureZoteroBackendReady } = await import("../tools/lib/ensure_zotero_backend_ready.mjs");
      const result = await ensureZoteroBackendReady({
        preferredBackend: "web_api",
        throwOnFailure: false,
        retries: 1,
        intervalMs: 1,
        postStartDelayMs: 0,
        log: () => {},
        backendProbe: async () => { throw new Error("probe_failed_mock"); },
      });

      assert.equal(result.ok, false);
      assert.match(result.results?.[0]?.diagnostics?.error || "", /probe_failed_mock/);
    } finally {
      if (origKey === undefined) delete process.env.ZOTERO_API_KEY;
      else process.env.ZOTERO_API_KEY = origKey;
      if (origUser === undefined) delete process.env.ZOTERO_USER_ID;
      else process.env.ZOTERO_USER_ID = origUser;
      globalThis.fetch = origFetch;
    }
  });

  it("Stage3 backfill uses the shared default readiness probe", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile("workflow/tools/stage3/main.mjs", "utf8");
    const match = source.match(/async function ensureZoteroBackendReadyForBackfill\(\) \{([\s\S]*?)\n\}/);
    assert.ok(match, "ensureZoteroBackendReadyForBackfill function should exist");
    assert.match(match[1], /ensureZoteroBackendReady\(\)/);
    assert.doesNotMatch(match[1], /backendProbe|get_collections/);
  });
});

describe("stage2 runtime options", () => {
  it("uses documented star migration defaults", async () => {
    const { parseStarMigrationConfig } = await import("../tools/stage2/runtime_options.mjs");
    const config = parseStarMigrationConfig({});
    assert.equal(config.enabled, true);
    assert.equal(config.mode, "expand");
    assert.equal(config.expandAllGrades, true);
    assert.equal(config.windowDays, 10);
    assert.equal(config.starThreshold, 4);
  });
});

describe("zotero_web_api_backend version protection", () => {
  it("resolves userID from API key when user id is omitted", async () => {
    const { ZoteroWebApiBackend } = await import("../tools/lib/zotero_web_api_backend.mjs");
    const backend = new ZoteroWebApiBackend({ apiKey: "test_key", apiBase: "https://api.example.test" });

    const urls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: new Map([["Content-Type", "application/json"]]),
        json: async () => ({ userID: 12345 }),
        text: async () => "",
      };
    };

    try {
      const userId = await backend.resolveUserId();
      assert.equal(userId, "12345");
      assert.equal(urls[0], "https://api.example.test/keys/test_key");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("createItem reads Zotero API successful object maps", async () => {
    const { ZoteroWebApiBackend } = await import("../tools/lib/zotero_web_api_backend.mjs");
    const backend = new ZoteroWebApiBackend({ userId: "test", apiKey: "test" });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map([["Content-Type", "application/json"]]),
      json: async () => ({ successful: { 0: { key: "ABC123" } } }),
      text: async () => "",
    });

    try {
      const created = await backend.createItem({ itemType: "journalArticle", title: "t" });
      assert.equal(created.key, "ABC123");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("_request passes If-Unmodified-Since-Version header", async () => {
    const { ZoteroWebApiBackend } = await import("../tools/lib/zotero_web_api_backend.mjs");
    const backend = new ZoteroWebApiBackend({ userId: "test", apiKey: "test" });

    let capturedHeaders = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        headers: new Map([["Content-Type", "application/json"]]),
        json: async () => ({}),
        text: async () => "",
      };
    };

    try {
      await backend._request("PATCH", "/items/ABC123", { title: "test" }, {
        retries: 1,
        ifUnmodifiedSinceVersion: 42,
      });
      assert.equal(capturedHeaders["If-Unmodified-Since-Version"], "42");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("_request omits header when version is 0", async () => {
    const { ZoteroWebApiBackend } = await import("../tools/lib/zotero_web_api_backend.mjs");
    const backend = new ZoteroWebApiBackend({ userId: "test", apiKey: "test" });

    let capturedHeaders = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        headers: new Map([["Content-Type", "application/json"]]),
        json: async () => ({}),
        text: async () => "",
      };
    };

    try {
      await backend._request("PATCH", "/items/ABC123", { title: "test" }, {
        retries: 1,
        ifUnmodifiedSinceVersion: 0,
      });
      assert.equal(capturedHeaders["If-Unmodified-Since-Version"], undefined);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("updateItem calls _getItemVersion when version not provided", async () => {
    const { ZoteroWebApiBackend } = await import("../tools/lib/zotero_web_api_backend.mjs");
    const backend = new ZoteroWebApiBackend({ userId: "test", apiKey: "test" });

    let capturedVersion = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedVersion = opts.headers?.["If-Unmodified-Since-Version"];
      return {
        ok: true,
        status: 200,
        headers: new Map([["Content-Type", "application/json"]]),
        json: async () => ({ version: 99 }),
        text: async () => "",
      };
    };

    try {
      await backend.updateItem("ABC123", { title: "new title" });
      assert.equal(capturedVersion, "99");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("zotero_adapter fallback chain", () => {
  it("getDiagnostics returns correct shape before init", async () => {
    const { ZoteroAdapter } = await import("../tools/lib/zotero_adapter.mjs");
    const adapter = new ZoteroAdapter();
    const diag = adapter.getDiagnostics();
    assert.equal(diag.initialized, false);
    assert.equal(diag.backend, "none");
    assert.equal(diag.fallbackUsed, false);
  });

  it("backendType returns none before init", async () => {
    const { ZoteroAdapter } = await import("../tools/lib/zotero_adapter.mjs");
    const adapter = new ZoteroAdapter();
    assert.equal(adapter.backendType, "none");
  });

  it("_ensureInitialized throws before init", async () => {
    const { ZoteroAdapter } = await import("../tools/lib/zotero_adapter.mjs");
    const adapter = new ZoteroAdapter();
    assert.throws(() => adapter._ensureInitialized(), /not initialized/i);
  });

  it("forced CLI mode does not try Web API even when an API key is configured", async () => {
    const origKey = process.env.ZOTERO_API_KEY;
    const { ZoteroAdapter } = await import("../tools/lib/zotero_adapter.mjs");
    const { ZoteroCliBackend } = await import("../tools/lib/zotero_cli_backend.mjs");
    const { ZoteroWebApiBackend } = await import("../tools/lib/zotero_web_api_backend.mjs");
    const originalCliEnsureReady = ZoteroCliBackend.prototype.ensureReady;
    const originalWebEnsureReady = ZoteroWebApiBackend.prototype.ensureReady;
    let webCalls = 0;
    try {
      process.env.ZOTERO_API_KEY = "test_key";
      ZoteroCliBackend.prototype.ensureReady = async () => ({ ok: true, diagnostics: { backend: "cli" } });
      ZoteroWebApiBackend.prototype.ensureReady = async () => {
        webCalls += 1;
        throw new Error("web_api should not be attempted in forced CLI mode");
      };

      const adapter = new ZoteroAdapter();
      const result = await adapter.initialize({ preferredMode: "cli", log: () => {} });

      assert.equal(result.mode, "cli");
      assert.equal(adapter.backendType, "cli");
      assert.equal(webCalls, 0);
    } finally {
      if (origKey === undefined) delete process.env.ZOTERO_API_KEY;
      else process.env.ZOTERO_API_KEY = origKey;
      ZoteroCliBackend.prototype.ensureReady = originalCliEnsureReady;
      ZoteroWebApiBackend.prototype.ensureReady = originalWebEnsureReady;
    }
  });
});

describe("zotero_backend_compat mapping", () => {
  it("exports expected functions", async () => {
    const mod = await import("../tools/lib/zotero_backend_compat.mjs");
    assert.equal(typeof mod.createCompatMcpToolCall, "function");
    assert.equal(typeof mod.createVerifiedMcpToolCall, "function");
  });
});
