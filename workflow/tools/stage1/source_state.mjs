import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeAtomicJson } from "../lib/atomic_json.mjs";

export { writeAtomicJson } from "../lib/atomic_json.mjs";

export const SOURCE_STATE_SCHEMA_VERSION = 1;
export const RETRIEVAL_AUDIT_SCHEMA_VERSION = 1;

const SECRET_KEY = /(^key$|api[-_]?key|token|password|secret|smtp|authorization|credential)/i;

function normalizedString(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !SECRET_KEY.test(key))
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  if (typeof value === "string") return normalizedString(value);
  return value;
}

export function canonicalSerialize(value) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalQueryHash(value) {
  return createHash("sha256").update(canonicalSerialize(value)).digest("hex");
}

export function sanitizeSourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function sourceStatePath({ stateRoot, profile, source, queryHash }) {
  if (!stateRoot) return "";
  if (!new Set(["weekly", "radar"]).has(profile)) throw new Error(`SOURCE_STATE_PROFILE_UNSUPPORTED_${profile}`);
  const safeSource = String(source || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "");
  if (!safeSource || !/^[a-f0-9]{64}$/.test(String(queryHash || ""))) throw new Error("SOURCE_STATE_NAMESPACE_INVALID");
  return path.join(stateRoot, `v${SOURCE_STATE_SCHEMA_VERSION}`, profile, safeSource, `${queryHash}.json`);
}

export async function loadSourceState(filePath, { fsApi = fs } = {}) {
  if (!filePath) return null;
  let raw;
  try {
    raw = await fsApi.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const state = JSON.parse(raw);
  if (state?.schemaVersion !== SOURCE_STATE_SCHEMA_VERSION) {
    throw new Error(`SOURCE_STATE_SCHEMA_UNSUPPORTED_${state?.schemaVersion ?? "missing"}`);
  }
  return state;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function safeFailure(value) {
  return normalizedString(value || "unknown_error")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .slice(0, 160);
}

export function buildSourceState({ previous = null, profile, source, queryHash, adapterVersion, proposal, checkedAt }) {
  const previousYield = Array.isArray(previous?.health?.yield?.successfulSamples)
    ? previous.health.yield.successfulSamples.filter(Number.isFinite).slice(-8)
    : [];
  const complete = proposal?.complete === true;
  const notModified = proposal?.notModified === true;
  const nextSamples = complete && !notModified
    ? [...previousYield, Number(proposal.itemCount || 0)].slice(-8)
    : previousYield;
  const referenceMedian = median(previousYield);
  const yieldAnomaly = complete && !notModified && previousYield.length >= 3 && referenceMedian >= 3
    ? Number(proposal.itemCount || 0) < referenceMedian * 0.25
    : false;
  return {
    schemaVersion: SOURCE_STATE_SCHEMA_VERSION,
    profile,
    source,
    queryHash,
    adapterVersion,
    committed: complete ? (proposal.committed ?? previous?.committed ?? null) : (previous?.committed ?? null),
    validators: complete ? (proposal.validators ?? previous?.validators ?? {}) : (previous?.validators ?? {}),
    health: {
      availability: complete
        ? { status: "available", checkedAt, stage: "complete" }
        : { status: "unavailable", checkedAt, stage: String(proposal?.failureStage || "unknown"), error: safeFailure(proposal?.error) },
      yield: {
        successfulSamples: nextSamples,
        median: median(nextSamples),
        anomaly: yieldAnomaly,
        sampleCount: nextSamples.length,
        notModified,
      },
    },
    updatedAt: checkedAt,
  };
}

export function sourceHealthObservations(stateUpdates = []) {
  return stateUpdates.flatMap((update) => {
    const state = update?.state;
    if (!state?.source || !state?.profile || !/^[a-f0-9]{64}$/.test(String(state?.queryHash || ""))) return [];
    const subject = { source: state.source, profile: state.profile, queryHash: state.queryHash };
    return [
      { kind: "source_availability", healthKey: `source:${state.profile}:${state.source}:${state.queryHash}:availability`, degraded: state.health?.availability?.status === "unavailable", subject },
      { kind: "source_yield", healthKey: `source:${state.profile}:${state.source}:${state.queryHash}:yield`, degraded: state.health?.yield?.anomaly === true, subject },
    ];
  });
}

export async function commitRetrievalTransaction({ artifactPath, artifact, stateUpdates = [], atomicWriter = writeAtomicJson } = {}) {
  if (artifact?.schemaVersion !== RETRIEVAL_AUDIT_SCHEMA_VERSION) throw new Error("RETRIEVAL_AUDIT_SCHEMA_INVALID");
  await atomicWriter(artifactPath, artifact);
  for (const update of stateUpdates) {
    await atomicWriter(update.path, update.state);
  }
  return { artifactPath, committedStateCount: stateUpdates.length };
}
