import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runStage5Notification } from "../tools/stage5/main.mjs";
import { receiptPathFor, recipientHash, writeReceipt } from "../tools/stage5/email_receipt.mjs";
import { overviewArtifactPath } from "../tools/stage5/literature_overview.mjs";

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperflow-stage5-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outputRoot = path.join(root, "exports");
  const stateRoot = path.join(root, "runs", "run-1");
  await fs.mkdir(outputRoot, { recursive: true });
  const attachment = path.join(outputRoot, "weekly.xlsx");
  await fs.writeFile(attachment, "fake workbook");
  const runSummary = {
    runId: "run-1", pipelineMode: "local", status: "success", startedAt: "2030-01-01T00:00:00Z", finishedAt: "2030-01-01T00:01:00Z",
    counts: { created: 1, grades: { A: 1, B: 0, C: 0, D: 0 } }, warnings: [], outputRoot,
    artifacts: [{ kind: "weekly_xlsx", path: attachment, displayName: "周报.xlsx" }],
  };
  return { root, outputRoot, stateRoot, attachment, runSummary };
}

const disabledLlm = { llmRuntime: { mode: "disabled" } };

test("receipt and overview are written to the run-scoped state root", async (t) => {
  const ctx = await setup(t);
  const result = await runStage5Notification({
    runSummary: ctx.runSummary,
    literatureItems: [{ title: "Fictional paper", grade: "A" }],
    recipient: "reader@example.test",
    transport: async (message) => ({ messageId: message.messageId, accepted: true, acceptedCount: 1 }),
    config: { ...disabledLlm, runStateRoot: ctx.stateRoot },
  });
  assert.equal(result.status, "sent");
  assert.equal(result.receiptPath, receiptPathFor(ctx.stateRoot));
  assert.equal((await fs.stat(overviewArtifactPath(ctx.stateRoot))).isFile(), true);
  await assert.rejects(fs.stat(receiptPathFor(ctx.outputRoot)), { code: "ENOENT" });
});

test("legacy shared receipt remains readable but new sends write run-scoped state", async (t) => {
  const ctx = await setup(t);
  await writeReceipt(receiptPathFor(ctx.outputRoot), {
    schemaVersion: 1, runId: "run-1", status: "sent", sentAt: "2030-01-01T00:02:00Z",
    recipientHash: recipientHash("reader@example.test"), messageId: "legacy", attachmentNames: ["周报.xlsx"], errorCategory: null,
  });
  const skipped = await runStage5Notification({ runSummary: ctx.runSummary, recipient: "reader@example.test", transport: async () => { throw new Error("must not send"); }, config: { ...disabledLlm, runStateRoot: ctx.stateRoot } });
  assert.equal(skipped.reason, "already_sent");
  const resent = await runStage5Notification({ runSummary: ctx.runSummary, recipient: "reader@example.test", forceResend: true, transport: async (message) => ({ messageId: message.messageId, accepted: true, acceptedCount: 1 }), config: { ...disabledLlm, runStateRoot: ctx.stateRoot } });
  assert.equal(resent.status, "sent");
  assert.equal(JSON.parse(await fs.readFile(receiptPathFor(ctx.stateRoot), "utf8")).messageId, resent.messageId);
});

test("forced resend does not require the old weekly workbook", async (t) => {
  const ctx = await setup(t);
  await fs.unlink(ctx.attachment);
  let attachmentCount = -1;
  const result = await runStage5Notification({ runSummary: ctx.runSummary, recipient: "reader@example.test", forceResend: true, transport: async (message) => { attachmentCount = message.attachments.length; return { messageId: message.messageId, accepted: true, acceptedCount: 1 }; }, config: { ...disabledLlm, runStateRoot: ctx.stateRoot } });
  assert.equal(result.status, "sent");
  assert.equal(attachmentCount, 0);
});
