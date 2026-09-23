import path from "node:path";

import { MODES, PROFILES } from "./constants.mjs";
import { validateRecoveryRunId } from "../recovery/operation_ledger.mjs";

const VALUE_ARGS = new Set(["mode", "profile", "email", "input", "output-root", "feedback", "llm-mode", "config", "resume"]);
const BOOLEAN_ARGS = new Set(["check", "run", "force-resend", "require-llm", "fixed-mode", "scheduled-daily"]);

export function parseRunnerArgs(argv = process.argv.slice(2), { cwd = process.cwd(), allowUnresolvedMode = false } = {}) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (!token.startsWith("--")) throw new Error(`RUNNER_ARGUMENT_UNEXPECTED:${token}`);
    const equalsAt = token.indexOf("=");
    const name = token.slice(2, equalsAt < 0 ? undefined : equalsAt);
    if (BOOLEAN_ARGS.has(name)) {
      if (equalsAt >= 0) throw new Error(`RUNNER_BOOLEAN_VALUE_FORBIDDEN:${name}`);
      flags.add(name);
      continue;
    }
    if (!VALUE_ARGS.has(name)) throw new Error(`RUNNER_ARGUMENT_UNKNOWN:${name}`);
    const value = equalsAt >= 0 ? token.slice(equalsAt + 1) : argv[++index];
    if (value === undefined || String(value).startsWith("--") || !String(value).trim()) throw new Error(`RUNNER_ARGUMENT_VALUE_REQUIRED:${name}`);
    if (name in values) throw new Error(`RUNNER_ARGUMENT_DUPLICATE:${name}`);
    values[name] = String(value).trim();
  }

  if (values.mode && !MODES.has(values.mode)) throw new Error(`RUNNER_MODE_INVALID:${values.mode}`);
  if (!values.mode && !allowUnresolvedMode && !values.config) throw new Error("RUNNER_MODE_INVALID:missing");
  if (flags.has("check") === flags.has("run")) throw new Error("RUNNER_ACTION_EXACTLY_ONE_REQUIRED");
  if (values.resume && flags.has("check")) throw new Error("RUNNER_RESUME_REQUIRES_RUN");
  if (values.resume && !flags.has("fixed-mode")) throw new Error("RUNNER_RESUME_FIXED_LAUNCHER_REQUIRED");
  if (flags.has("scheduled-daily") && (flags.has("check") || values.resume || flags.has("force-resend") || values.profile === "radar" || values.mode === "local")) throw new Error("RUNNER_SCHEDULED_DAILY_CONFLICT");
  const profile = values.profile || "standard";
  if (!PROFILES.has(profile)) throw new Error(`RUNNER_PROFILE_INVALID:${profile}`);
  if (values["llm-mode"] && !["disabled", "mock", "real"].includes(values["llm-mode"])) throw new Error("RUNNER_LLM_MODE_INVALID");
  if (flags.has("require-llm") && values["llm-mode"] && values["llm-mode"] !== "real") throw new Error("RUNNER_REAL_LLM_REQUIRED");
  if (values.mode && values.mode !== "local" && ["input", "output-root", "feedback"].some((name) => values[name])) {
    throw new Error("RUNNER_LOCAL_ARGUMENT_MODE_MISMATCH");
  }

  const resolveOptional = (name) => values[name]
    ? path.resolve(cwd, values[name])
    : "";
  return {
    mode: values.mode || "",
    action: flags.has("check") ? "check" : "run",
    profile,
    email: values.email || "",
    input: resolveOptional("input"),
    outputRoot: resolveOptional("output-root"),
    feedback: resolveOptional("feedback"),
    configPath: resolveOptional("config"),
    resume: values.resume ? validateRecoveryRunId(values.resume) : "",
    llmMode: flags.has("require-llm") ? "real" : (values["llm-mode"] || ""),
    forceResend: flags.has("force-resend"),
    requireLlm: flags.has("require-llm"),
    fixedMode: flags.has("fixed-mode"),
    scheduledDaily: flags.has("scheduled-daily"),
    provided: {
      profile: Boolean(values.profile),
      email: Boolean(values.email),
      input: Boolean(values.input),
      outputRoot: Boolean(values["output-root"]),
      feedback: Boolean(values.feedback),
      llmMode: Boolean(values["llm-mode"]),
      config: Boolean(values.config),
      resume: Boolean(values.resume),
    },
  };
}
