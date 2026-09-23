import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRuntimeConfig } from "../lib/runtime_config.mjs";
import { decideScheduledDaily, plannedSlotCalendarDateKey, readScheduledRuntimeState, resolvePlannedSlotAt, scheduleDayDecisionPath } from "../lib/schedule_support.mjs";
import { OperationLedgerStore } from "../recovery/operation_ledger.mjs";
import { withRunnerProfile } from "./config_loader.mjs";

const enabled = (value) => /^(1|true|yes|on)$/i.test(String(value || "").trim());
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function existingClaim({ stateRoot, now, fsApi }) {
  const dateKey = plannedSlotCalendarDateKey(now);
  const filePath = scheduleDayDecisionPath(stateRoot, dateKey);
  let claim;
  try { claim = JSON.parse(await fsApi.readFile(filePath, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("SCHEDULE_DAY_DECISION_UNREADABLE");
  }
  if (claim?.schemaVersion !== 1 || claim.dateKey !== dateKey
    || claim.plannedSlotAt !== resolvePlannedSlotAt(now).toISOString()
    || !["weekly_takeover", "radar"].includes(claim.decision)
    || typeof claim.businessRunId !== "string"
    || (claim.businessRunId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(claim.businessRunId))
    || (!claim.businessRunId && claim.decision !== "weekly_takeover")) {
    throw new Error("SCHEDULE_DAY_DECISION_INVALID");
  }
  return claim;
}

export async function selectScheduledDailyRun(resolved, {
  now = new Date(),
  repoRoot = REPO_ROOT,
  fsApi = fs,
  loadLedger = (args) => OperationLedgerStore.load(args, { fsApi }),
} = {}) {
  const { options, env } = resolved;
  if (!["desktop", "web"].includes(options.mode)) throw new Error("SCHEDULE_MODE_UNSUPPORTED");
  if (!["standard", "complete"].includes(options.profile)) throw new Error("SCHEDULE_WEEKLY_MODE_INVALID");
  if (options.resume || options.forceResend || enabled(env.FORCE_review_results_RUN) || enabled(env.review_results_FORCE_RUN)
    || env.review_results_OVERRIDE_DATE
    || [env.review_results_ORCHESTRATOR_TRIGGER, env.ZOTERO_ORCHESTRATOR_TRIGGER].some((value) => value && value !== "scheduled")) {
    throw new Error("SCHEDULE_FORCE_CONFLICT");
  }
  const runtime = buildRuntimeConfig({ cwd: repoRoot, env, now });
  const plannedSlot = resolvePlannedSlotAt(now).toISOString();
  const claim = await existingClaim({ stateRoot: path.join(runtime.researchRoot, "schedule_decisions"), now, fsApi });
  if (claim) {
    if (new Date(now) < new Date(plannedSlot)) throw new Error("SCHEDULE_DAY_DECISION_BEFORE_SLOT");
    if (!claim.businessRunId) {
      const state = await readScheduledRuntimeState(path.join(runtime.researchRoot, "runtime_state.json"), fsApi);
      const decision = decideScheduledDaily({ now, ...state, weeklyMode: options.profile,
        radarEnabled: resolved.config?.common?.radar?.enabled === true,
        intervalDays: Number(env.review_results_RUN_INTERVAL_DAYS || 7) });
      if (!decision.allowed || decision.selectedFlow !== "weekly") throw new Error("SCHEDULE_DAY_DECISION_CONFLICT");
      return { status: "ready", decision, resolved: withRunnerProfile(resolved, options.profile) };
    }
    const claimedFlow = claim.decision === "radar" ? "radar" : "weekly";
    const decision = { allowed: false, plannedSlot, selectedFlow: claimedFlow, weeklyMode: claimedFlow === "weekly" ? options.profile : null, reason: "already_claimed" };
    let ledger;
    try { ledger = (await loadLedger({ runRoot: path.join(runtime.reviewRoot, "runs"), runId: claim.businessRunId })).ledger; }
    catch { return { status: "recovery_required", decision, runId: claim.businessRunId, reason: "ledger_unavailable" }; }
    if (ledger.status === "completed") return { status: "already_completed", decision, runId: claim.businessRunId };
    if (!["failed", "incomplete", "interrupted", "timed_out"].includes(ledger.status)) return { status: "recovery_required", decision, runId: claim.businessRunId, reason: "run_status_uncertain" };
    if (ledger.artifact?.hash === "pending" || !/^[a-f0-9]{64}$/.test(String(ledger.artifact?.hash || ""))) {
      return { status: "recovery_required", decision, runId: claim.businessRunId, reason: "artifact_not_bound" };
    }
    const profile = claimedFlow === "radar" ? "radar" : options.profile;
    const selected = withRunnerProfile(resolved, profile);
    if (ledger.mode !== options.mode || ledger.profile !== profile || ledger.configHash !== selected.options.recoveryConfigHash) {
      return { status: "recovery_required", decision, runId: claim.businessRunId, reason: "ledger_context_mismatch" };
    }
    return { status: "resume", decision, resolved: { ...selected, options: { ...selected.options, resume: claim.businessRunId } }, runId: claim.businessRunId };
  }
  const statePath = path.join(runtime.researchRoot, "runtime_state.json");
  const state = await readScheduledRuntimeState(statePath, fsApi);
  const decision = decideScheduledDaily({
    now, ...state, weeklyMode: options.profile,
    radarEnabled: resolved.config?.common?.radar?.enabled === true,
    intervalDays: Number(env.review_results_RUN_INTERVAL_DAYS || 7),
  });
  if (!decision.allowed) return { status: decision.reason, decision };
  const profile = decision.selectedFlow === "radar" ? "radar" : options.profile;
  return { status: "ready", decision, resolved: withRunnerProfile(resolved, profile) };
}
