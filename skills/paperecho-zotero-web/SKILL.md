---
name: paperecho-zotero-web
description: use when running or changing the PaperEcho Zotero Web API path, including its deterministic production launcher, Web transport, API versions, rate limits, Stage2/Stage3 writeback, batching, recovery, collection routing, metadata writes, validation, or performance.
---

# PaperEcho - Zotero Web

No-desktop Zotero Web path for PaperEcho. Keep work narrow: prefer Stage2-only benchmark and targeted tests, and run the full workflow only for final end-to-end acceptance.

## Execution Intent Routing

The optional [Control Center](../../docs/control-center.md) is a localhost interaction UI, distinct from the Zotero Web API path. It does not launch this path or call Zotero. Stage1 consumes canonical feedback with legacy XLSX fallback; production still follows the launcher below.

- Production intent such as “运行”, “跑一次”, “完整流程”, “文献追踪”, “检查配置并启动”, or “配置完成，继续” must use only `node skills/paperecho-zotero-web/scripts/run.mjs`. Pass `--config config/paperecho.config.json` when using unified configuration. With sufficient parameters, invoke `--run`; when only safe configuration inspection is possible, invoke `--check`.
- Development intent such as modifying, fixing, refactoring, auditing code, or updating tests must not invoke the production launcher. Use mocks and targeted validation.
- Explanation intent must only explain or invoke `--check`; never invoke `--run`.
- A reply of “继续” reruns the same launcher with the same `--config`, reloads the file, and performs a fresh preflight. Inspect only `common` plus `web`; do not reuse readiness, wait in the background, start Desktop, or switch to Desktop/Local.
- Never ask the user to paste `ZOTERO_API_KEY` or another secret into chat. Loading this Skill alone causes no production side effect, and production execution must not modify code or create a Git commit.

Read the shared [execution contract](../paperecho-workflow/references/execution.md) before invoking the launcher. It defines profiles, preflight, blocked recovery, current-run validation, exit codes, and secret handling; this Skill fixes the mode to Web and must not choose another launcher.

The launcher-fixed Web mode must agree with an explicit config mode or unique enabled section; a Desktop/Local selection is a blocking conflict. Missing output is grouped into `common` and `web` only. Current configuration supports user libraries, not invented group/libraryType fields. Use the shared [configuration guide](../../docs/configuration.md).

## Architecture Boundary

- The workflow remains shared Stage0-Stage5 orchestration; Web differs only at the Zotero backend/strategy boundary.
- For Web changes, inspect first: `workflow/tools/lib/zotero_web_api_backend.mjs`, Web benchmark/tests, and this skill.
- Only inspect shared Stage2/Stage3 or shared validation when changing business semantics such as source/grade routing, root `文献池`, shortTitle, run marker, cleanup, or local/live index.
- Do not add Web-specific `stage0-4` copies. Do not add Zotero Desktop launch, JS bridge, or `zotero-cli` behavior to Web code.
- For shared or cross-path behavior, first use [paperecho-workflow](../paperecho-workflow/SKILL.md) and load its relevant reference.

## When to Use

- Planning, executing, reviewing, or fixing the PaperEcho Zotero Web / no-desktop path
- Web API v3 backend, cloud writeback, batch operations, rate limiting
- Stage2 API benchmark and performance optimization
- Collection routing, shortTitle metadata, cleanup, local/live index

## When NOT to Use

- Desktop / CLI / JS bridge path -> use `paperecho-zotero-desktop`
- Standalone Local path -> use `paperecho-local`
- Starting or managing Zotero Desktop → this path must NOT start Desktop

## Core Rules

1. **No Desktop**: API path must NOT start Zotero Desktop. If Desktop launches, it's a backend selection bug.
2. **API Key**: Only from `ZOTERO_API_KEY` env or gitignored `.env`. Never print, log, or commit.
3. **Backend Selection**: `ZOTERO_BACKEND=web_api` or `auto` with API key set.
4. **Collection Routing**: New items → source + grade collections only, NOT root `文献池`.
5. **shortTitle**: Multi-object Stage3 updates use `POST /items` in chunks of at most 50, with version protection and per-index `{ successful, unchanged, failed }` handling. Do not fall back to per-item or `PATCH /items` writes.
6. **Concurrency**: Web requests remain bounded at `4`; `429` respects `Retry-After`/`Backoff`, while `412`/`428` fail explicitly instead of unconditional retry.
7. **Cleanup**: Delete only exact manifest-owned keys. First and second cleanup must leave item, collection, local-index, cloud residual, and unknown counts at `0`.
8. **Commit Rule**: Only commit after validation passes; never commit runtime artifacts.

## Web API v3 Constraints

Reference: [Zotero Web API v3](https://www.zotero.org/support/dev/web_api/v3/basics), [Write Requests](https://www.zotero.org/support/dev/web_api/v3/write_requests)

| Constraint | Rule |
|-----------|------|
| Base URL | `https://api.zotero.org` (not localhost) |
| API Version | `Zotero-API-Version: 3` header required |
| Auth | `Zotero-API-Key` header (not query param) |
| Pagination | Max 100 items/read; handle `Total-Results` + offset |
| Batch create/update/delete | Max 50 per request |
| Rate limiting | Handle 429 + `Retry-After` + `Backoff`; ≤4 concurrent |
| Versioned writes | PUT/PATCH needs `version` or `If-Unmodified-Since-Version` |
| Response format | `{ successful, unchanged, failed }` keyed by input index |
| Collection membership | `collections` field is complete list; PATCH must not remove existing |

## Commands

### Stage2 Benchmark (preferred for writeback work)
```powershell
$env:ZOTERO_BACKEND='web_api'
$env:ZOTERO_WRITEBACK_OBSERVATION_MODE='0'
node workflow/tests/stage2_api_writeback_benchmark.mjs --real-run --limit=74 --run-id=<run_id>
```

### Full Workflow (final acceptance only)
```powershell
node tests/full_workflow_benchmark/run_dual_backend_benchmark.mjs
```

### Tests
```powershell
node --check workflow/tools/lib/zotero_web_api_backend.mjs
node --test workflow/tests/zotero_backend.test.mjs
node --test workflow/tests/writeback_to_zotero.test.mjs
```

## Working Pattern

1. Run `git status --short`; separate code/docs from `.planning`/`review_results`.
2. Locate the smallest relevant module with `rg`; do not scan generated folders.
3. Make the minimum local change.
4. Run Stage2-only benchmark before full workflow for writeback changes.
5. For real writeback, verify: created count, source/grade routing, root `文献池` count 0, shortTitle readback, run marker, cleanup residual 0.
6. Commit only after validation passes.

## Prompt Template

```text
Use $paperecho-zotero-web. Work only on the Web API path with ZOTERO_BACKEND=web_api. First inspect git status and targeted files, then make the smallest change, run Stage2 benchmark as appropriate, clean any real run by run_id, and commit only validated source/test/doc changes.
```

## References

- Read the shared [execution contract](../paperecho-workflow/references/execution.md) for production intent routing and Runner behavior.
- Read [web-workflow.md](references/web-workflow.md) for the Runner, Stage1-Stage5, run-group, collection-routing, and cleanup contract.
- Read [validation.md](references/validation.md) before running checks or designing a validation plan.
- Read [performance.md](references/performance.md) for baseline numbers, optimization history, and hotspots.
