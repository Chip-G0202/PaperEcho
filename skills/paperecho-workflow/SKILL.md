---
name: paperecho-workflow
description: use when implementing, modifying, auditing, or debugging PaperEcho shared or cross-path behavior across Desktop, Web, and Local, including deterministic execution contracts, Stage1-Stage5, shared literature identity/index, Local state, title translation, Stage5 email, housekeeping/retention, and cross-path regression validation.
---

# PaperEcho Workflow

Treat PaperEcho as one shared domain workflow with three boundary adapters. Preserve correctness, idempotency, recovery, user data, and existing work before optimizing or adding code. Treat existing `PAPERFLOW_*` environment variables and internal lowercase `paperflow` identifiers as compatibility interfaces, not as the current product brand.

## Start Here

1. Read the repository root `AGENTS.md` before acting.
2. Run `git status --short`; separate the requested scope from existing `.planning/**`, runtime data, caches, and user edits.
3. Locate the owner with targeted `rg` searches. Read the owner, direct callers, and nearest tests only.
4. Classify the change before editing:
   - Shared semantics belong in the shared Stage or library owner.
   - Desktop CLI/JS bridge behavior belongs in the Desktop adapter.
   - Web API HTTP, version, batching, and rate-limit behavior belongs in the Web adapter.
   - Local import, snapshots, feedback, timings, and output layout belong in the Local adapter.
5. Reuse the existing owner and test pattern. Do not add a second index, formatter, sender, cache, or path-specific Stage copy.

## Progressive Loading

- Architecture or cross-path work: read [architecture.md](references/architecture.md).
- Stage responsibility, inputs, outputs, or gates: read [stage-contracts.md](references/stage-contracts.md).
- Dedupe, identity, state, cache, or migration work: read [identity-and-storage.md](references/identity-and-storage.md).
- Email, overview, attachments, receipt, or resend work: read [stage5-email.md](references/stage5-email.md).
- Retention, run groups, path safety, or ephemeral cleanup work: read [housekeeping.md](references/housekeeping.md).
- Before validation or commit: read [validation.md](references/validation.md).
- Production execution, preflight, continue, result validation, or exit codes: read [execution.md](references/execution.md).

Read only the references needed for the task. All references are one level below this file.

## Execution Boundary

This skill owns the shared execution contract, not a second pipeline invocation. When a path Skill handles an explicit production request, it must invoke its own deterministic launcher exactly once; that launcher delegates to the shared Runner, which invokes the real Stage0 or Local entry exactly once after preflight. Do not invoke this main skill as an additional command, auto-switch paths, or rerun the production entry outside the Runner.

## Unified Configuration

Doctor uses the shared read-only `--doctor` service, not a production invocation or `--check` replacement. It never prepares data directories, repairs permissions, releases claims, replays operations or calls external services. UNKNOWN evidence must remain visible; see [configuration](../../docs/configuration.md#doctor--system-health).

First-run setup is GUI-only and derives readiness from existing config/preflight. It must reuse ConfigService and write-only SecretService, preserve partial/legacy configuration, and never gate Headless on a UI completion flag or invoke real providers. See [configuration](../../docs/configuration.md).

Windows packaged runtime uses the same root owner with a pinned read-only Resource Root. Headless delegates to Shared Runner using the embedded runtime; see [configuration](../../docs/configuration.md) for verified build/test commands, required fuses and platform limits.

Deployment layout is resolved only by `runtime_config.mjs`; reuse its Portable/Installed/Dev roots before config or Secret loading. Do not add adapter root resolvers, infer layout from cwd, or migrate real data implicitly. See [configuration](../../docs/configuration.md) for bootstrap inputs and compatibility boundaries.

Windows packaged startup reads the protected first-run location through the shared bootstrap before any owner initialization. Explicit bootstrap overrides retain priority; unknown/nonempty data prevents first-run selection. Validate with `workflow/tests/startup_location.test.mjs` and existing runtime/setup tests; never hot-switch services.

- Use the single schema v1 resolver in `workflow/tools/runner/config_loader.mjs`. The user template is `config/paperecho.config.example.json`; the real `config/paperecho.config.json` stays local and gitignored.
- Keep settings partitioned as `common`, `desktop`, `web`, and `local`. A path Skill reads only `common` plus its own section and fixes its own mode.
- Precedence is CLI -> unified config -> environment/`.env` -> existing domain config/defaults. Never infer mode from secret/backend residue.
- Store only secret environment-variable names in JSON and report presence, never values. Do not duplicate full field tables here; use the [configuration guide](../../docs/configuration.md).

## Implementation Loop

1. State the current owner, intended minimum change, likely files, and path-specific risks.
2. Trace every caller of a shared function before changing it; fix the shared cause once.
3. Keep adapter details outside shared stages and keep Local outside all Zotero boundaries.
4. Preserve schema compatibility, atomic writes, locks, idempotency, and failure degradation.
5. Add or adjust the smallest test that would fail if the requested behavior regressed.
6. Run the closest targeted validation first. Never use a real Zotero, SMTP, LLM, or external write unless the user explicitly authorizes it.
7. If validation fails, use the first key error for one minimum repair and rerun the same check. If it still fails, stop and do not commit.

## Commit Gate

Commit only when the requested outcome and required targeted checks pass. Stage explicit files or hunks; never use `git add .`. Do not stage `.planning/**`, `review_results/**`, secrets, receipts, caches, previews, workbooks, benchmark output, or unrelated edits.
