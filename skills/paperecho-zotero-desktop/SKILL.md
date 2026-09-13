---
name: paperecho-zotero-desktop
description: use when running or changing the PaperEcho Zotero Desktop path, including its deterministic production launcher, Desktop transport, CLI/JS bridge, Stage2/Stage3 readiness, batching, recovery, collection routing, metadata writeback, validation, or performance.
---

# PaperEcho - Zotero Desktop

Use this skill for the repository's desktop-only Zotero literature review path. Keep work narrow: prefer Stage2-only benchmark and targeted tests, and run a full workflow only for final end-to-end acceptance.

## Execution Intent Routing

Daily feedback/settings may use the optional [Control Center](../../docs/control-center.md). It does not launch this path or probe/write Zotero. Canonical paper feedback is consumed by Stage1; absent canonical state retains XLSX compatibility. This does not change the launcher chain below.

- Production intent such as “运行”, “跑一次”, “完整流程”, “文献追踪”, “检查配置并启动”, or “配置完成，继续” must use only `node skills/paperecho-zotero-desktop/scripts/run.mjs`. Pass `--config config/paperecho.config.json` when using unified configuration. With sufficient parameters, invoke `--run`; when only safe configuration inspection is possible, invoke `--check`.
- Development intent such as modifying, fixing, refactoring, auditing code, or updating tests must not invoke the production launcher. Use mocks and targeted validation.
- Explanation intent must only explain or invoke `--check`; never invoke `--run`.
- A reply of “继续” reruns the same launcher with the same `--config`, reloads the file, and performs a fresh preflight. Inspect only `common` plus `desktop`; do not reuse readiness, wait in the background, switch to Web/Local, or ask the user to paste secrets into chat.
- Loading this Skill alone causes no production side effect. A production run modifies runtime data but must not modify code or create a Git commit.

Read the shared [execution contract](../paperecho-workflow/references/execution.md) before invoking the launcher. It defines profiles, preflight, blocked recovery, current-run validation, exit codes, and secret handling; this Skill fixes the mode to Desktop and must not choose another launcher.

The launcher-fixed Desktop mode must agree with an explicit config mode or unique enabled section; a Web/Local selection is a blocking conflict. Missing output is grouped into `common` and `desktop` only. Use the shared [configuration guide](../../docs/configuration.md) rather than maintaining a second field table here.

## Architecture Boundary

- The workflow remains shared Stage0-Stage5 orchestration; Desktop differs only at the Zotero backend/strategy boundary.
- For Desktop changes, inspect first: `workflow/tools/lib/zotero_cli_backend.mjs`, `workflow/tools/lib/zotero_cli_executor.mjs`, `workflow/tools/lib/zotero_desktop_launcher.mjs`, Desktop benchmark/tests, and this skill.
- Only inspect shared Stage2/Stage3 or shared validation when changing business semantics such as source/grade routing, root `文献池`, shortTitle, run marker, cleanup, or local/live index.
- Do not add Desktop-specific `stage0-4` copies. Do not add Web API rate-limit or HTTP behavior to Desktop code.
- For Web API work use `paperecho-zotero-web`; for standalone filesystem work use `paperecho-local`.
- For shared or cross-path behavior, first use [paperecho-workflow](../paperecho-workflow/SKILL.md) and load its relevant reference.

## Core Rules

1. Force the desktop path with `ZOTERO_BACKEND=cli` and `ZOTERO_API_KEY=''` or an unavailable API key.
2. Start readiness in order: discover/launch Zotero Desktop, run `zotero-cli app ping`, then verify JS bridge readiness.
3. Keep new items out of root `文献池`; each new item goes to exactly one source collection and one grade collection.
4. Use local/live index for dedupe. Do not rely on root `文献池` membership for new-item dedupe.
5. Send Stage2 batch payloads as UTF-8 stdin through `zotero_cli_stdin_runner.py`; do not embed the complete JSON/JS payload in Windows command arguments.
6. Use `ZOTERO_CLI_WRITEBACK_BATCH_SIZE` default `50`, clamped to `1–50`. One backend batch maps to one CLI process; do not use per-item fallback.
7. Initialize recovery before the first side effect, persist every successful batch's exact keys before the next batch, and clean only manifest-owned exact keys. First and second cleanup must both leave Zotero/local-index residual and unknown counts at `0`.
8. Never commit `review_results`, runtime caches, benchmark output, logs, backups, `.env`, keys, or real workflow artifacts.

## References

- Read the shared [execution contract](../paperecho-workflow/references/execution.md) for production intent routing and Runner behavior.
- Read [desktop-workflow.md](references/desktop-workflow.md) when changing startup, Stage2 writeback, collection routing, or cleanup behavior.
- Read [validation.md](references/validation.md) before running checks or designing a validation plan.
- Read [performance.md](references/performance.md) when analyzing Stage2, journal quality cache, LLM cache, or final performance wrap-up.

## Working Pattern

1. Run `git status --short` and separate code/docs changes from `.planning` and `review_results` artifacts.
2. Locate the smallest relevant module with `rg`; do not scan generated folders or large artifacts.
3. Make the minimum local change that preserves source/grade/root/shortTitle/run marker/local index semantics.
4. Run targeted checks first. Use Stage2-only benchmark before a full workflow for writeback changes.
5. For a real writeback validation, verify created count, source/grade routing, root `文献池` count `0`, shortTitle, run marker, local/live index, recovery completion, idempotent cleanup, and restored local-state hashes.
6. Commit only after validation passes and staged files contain only source, tests, skill docs, or other intentional docs.

## Prompt Template

```text
Use $paperecho-zotero-desktop. Work only on the desktop CLI path with ZOTERO_BACKEND=cli and ZOTERO_API_KEY=''. First inspect git status and targeted files, then make the smallest change, run targeted tests or Stage2-only benchmark as appropriate, clean any real run by run_id, and commit only validated source/test/doc changes.
```
