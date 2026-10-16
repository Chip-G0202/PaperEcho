---
name: paperecho-local
description: use when running or changing the PaperEcho Standalone Local path, including its deterministic production launcher, LocalRepository, JSON/JSONL import, snapshots, feedback/state checkpoints, timings, exports, or poison-Zotero boundary validation.
---

# PaperEcho - Local

The packaged `PaperEcho-headless.cmd --check --mode local` entry reuses Shared Runner and the same Local core. See [configuration](../../docs/configuration.md) for data-root setup, embedded runtime/fuse requirements and Windows-only packaging acceptance.

Deployment paths reuse the shared `runtime_config.mjs` Portable/Installed/Dev contract; Local output/state stay under the selected data root in new layouts. See [configuration](../../docs/configuration.md). Do not infer layout from cwd or migrate data in this adapter.

Run the complete local-first literature workflow without representing Local as a Zotero backend. Reuse shared domain services and keep filesystem persistence in the Local adapter.

## Execution Intent Routing

- Production intent such as “运行”, “跑一次”, “完整流程”, “文献追踪”, “检查配置并启动”, or “配置完成，继续” must use only `node skills/paperecho-local/scripts/run.mjs`. Supply `input` and `outputRoot` through `--config config/paperecho.config.json` or explicit `--input`/`--output-root`; with sufficient parameters invoke `--run`, otherwise invoke only `--check`.
- Development intent such as modifying, fixing, refactoring, auditing code, or updating tests must not invoke the production launcher. Use temporary roots, mocks, and targeted validation.
- Explanation intent must only explain or invoke `--check`; never invoke `--run`.
- A reply of “继续” reruns the same launcher with the same `--config`, reloads the file, and performs a fresh preflight. Inspect only `common` plus `local`; do not reuse readiness, wait in the background, inspect Zotero configuration, or switch to Desktop/Web.
- Never ask the user to paste secrets into chat. Loading this Skill alone causes no production side effect, and production execution must not modify code or create a Git commit.

Read the shared [execution contract](../paperecho-workflow/references/execution.md) before invoking the launcher. It defines profiles, preflight, blocked recovery, current-run validation, exit codes, and secret handling; this Skill fixes the mode to Local and must not choose another launcher.

The launcher-fixed Local mode must agree with an explicit config mode or unique enabled section; a Desktop/Web selection is a blocking conflict. Missing output is grouped into `common` and `local` only. `state`, `runs`, `exports`, feedback, and checkpoints derive from `outputRoot`; do not add separate roots. Use the shared [configuration guide](../../docs/configuration.md).

## Architecture Boundary

- Entry: `workflow/tools/local/main.mjs::runLocalPipeline` and its CLI `main`.
- Shared: Stage1 classification/learning, literature identity normalization, shared literature index, title translation/cache, and Stage4 workbook mapping.
- Local adapter: import, papers snapshot, feedback JSONL, learning checkpoint, run timings, and export directories.
- Forbidden: Zotero readiness, backend factory, Desktop launcher, Stage2, Stage3, itemKey, collection, attachment, rating, or Zotero metadata writeback.
- Do not make Local implement `zotero_backend_contract.mjs` and do not call the complete Stage3 merely to generate translations.
- For shared or cross-path behavior, first use [paperecho-workflow](../paperecho-workflow/SKILL.md) and load its relevant reference.

## Core Rules

1. Require `--output-root`; accept JSON/JSONL input through `--input` or controlled fixtures through `--fixture-root`.
2. Use the shared identity priority: DOI, PMID, PMCID, arXiv, OpenAlex, canonical URL, normalized title.
3. Keep Local state under its output root, but read/write the shared identity index at `review_results/shared/current_literature_index.json` by default.
4. Keep `feedback/events.jsonl` append-only. Consume each stable `event_id` once and checkpoint only after preference learning succeeds.
5. Generate `translatedTitle` through the shared translation boundary before snapshot persistence and Stage4 export; use `review_results/translation_cache.json` and never write Zotero `shortTitle`.
6. Persist JSON with same-directory temp files and atomic rename; preserve the formal file and clean only the current temp after failure.
7. Keep Local papers free of Zotero-only fields. A shared record may contain `presence.zotero` and `presence.local`, but neither namespace may fabricate the other's locator.
8. Never commit Local state, feedback, runs, exports, timings, caches, XLSX files, or real literature data.

## References

- Read the shared [execution contract](../paperecho-workflow/references/execution.md) for production intent routing and Runner behavior.
- Read [local-workflow.md](references/local-workflow.md) before changing orchestration, persistence, feedback replay, dedupe, or translation behavior.
- Read [validation.md](references/validation.md) before running tests or accepting a Local change.

## Working Pattern

1. Run `git status --short`; preserve unrelated `.planning` and runtime changes.
2. Locate only Local entrypoints, shared services used by Local, and their targeted tests.
3. Make the smallest adapter or shared-core change; do not modify Zotero transports for a Local-only problem.
4. Run the Local test, then the closest shared identity/translation/Stage1/Stage4 tests.
5. For an end-to-end check, use a temporary output root and controlled translator boundary; assert the XLSX translation differs from the English title.
6. Verify poison Zotero readiness/backend/launcher/Stage2/Stage3 calls remain exactly zero.

## Prompt Template

```text
Use $paperecho-local. Work only on the standalone Local path, keep every Zotero boundary unused, preserve local feedback idempotency and atomic persistence, and run targeted Local/shared-core tests before committing source, tests, or skill documentation.
```
