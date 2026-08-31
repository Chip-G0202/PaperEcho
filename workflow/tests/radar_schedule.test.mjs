import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claimScheduleDayDecision,
  plannedSlotCalendarDateKey,
  resolvePlannedSlotAt,
} from "../tools/lib/schedule_support.mjs";
import { canonicalQueryHash, sourceStatePath } from "../tools/stage1/source_state.mjs";

test("Radar planned slot remains the existing daily 15:00 scheduler slot", () => {
  assert.equal(resolvePlannedSlotAt(new Date("2026-08-31T02:00:00Z")).toISOString(), "2026-08-31T07:00:00.000Z");
});

test("weekend dates remain eligible for a Radar decision", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-weekend-"));
  const result = await claimScheduleDayDecision({ stateRoot: root, now: new Date("2026-09-06T07:00:00Z"), weeklyDue: false, runId: "radar-weekend" });
  assert.equal(result.dateKey, "2026-09-06");
  assert.equal(result.decision, "radar");
});

test("calendar holidays have no skip branch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-holiday-"));
  const result = await claimScheduleDayDecision({ stateRoot: root, now: new Date("2026-10-01T07:00:00Z"), weeklyDue: false, runId: "radar-holiday" });
  assert.equal(result.decision, "radar");
});

test("schedule date key is derived from the existing planned-slot timezone semantics", () => {
  assert.equal(plannedSlotCalendarDateKey(new Date("2026-08-30T23:30:00Z")), "2026-08-31");
});

test("DST boundary instants still map to one monotonic decision key per scheduler day", () => {
  const keys = ["2026-03-07T07:00:00Z", "2026-03-08T07:00:00Z", "2026-03-09T07:00:00Z"].map((value) => plannedSlotCalendarDateKey(new Date(value)));
  assert.deepEqual(keys, ["2026-03-07", "2026-03-08", "2026-03-09"]);
  assert.equal(new Set(keys).size, 3);
});

test("weekly due date creates immutable weekly takeover", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-takeover-"));
  const result = await claimScheduleDayDecision({ stateRoot: root, now: new Date("2026-09-07T07:00:00Z"), weeklyDue: true, requestedProfile: "radar", runId: "radar-trigger" });
  assert.equal(result.decision, "weekly_takeover");
  assert.equal(result.businessRunId, "");
});

test("weekly failure cannot turn the same day into Radar", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-failure-takeover-"));
  const now = new Date("2026-09-07T07:00:00Z");
  await claimScheduleDayDecision({ stateRoot: root, now, weeklyDue: true, requestedProfile: "weekly", runId: "weekly-failed" });
  const second = await claimScheduleDayDecision({ stateRoot: root, now, weeklyDue: false, requestedProfile: "radar", runId: "radar-later" });
  assert.equal(second.decision, "weekly_takeover");
  assert.equal(second.businessRunId, "weekly-failed");
});

test("duplicate scheduler trigger returns the original business run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-duplicate-trigger-"));
  const now = new Date("2026-09-08T07:00:00Z");
  const first = await claimScheduleDayDecision({ stateRoot: root, now, weeklyDue: false, runId: "radar-first" });
  const second = await claimScheduleDayDecision({ stateRoot: root, now, weeklyDue: false, runId: "radar-second" });
  assert.equal(first.businessRunId, "radar-first");
  assert.equal(second.businessRunId, "radar-first");
  assert.equal(second.duplicateTrigger, true);
});

test("Radar and Weekly watermarks use isolated namespaces", () => {
  const root = path.join("state", "source");
  const hash = canonicalQueryHash({ q: "cancer" });
  assert.notEqual(sourceStatePath({ stateRoot: root, profile: "radar", source: "pubmed", queryHash: hash }), sourceStatePath({ stateRoot: root, profile: "weekly", source: "pubmed", queryHash: hash }));
});
