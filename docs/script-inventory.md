# PaperEcho script inventory

本清单描述当前生产调用面。强制规则和 Canonical Architecture 以根 `AGENTS.md` 为准；路径 Skill 负责意图路由，launcher 固定 mode，共享 Runner 负责 preflight、单次 production invocation 和 current-run validation。

## Default execution chain

`Path Skill -> Path Launcher -> workflow/tools/runner/main.mjs -> Preflight -> Production Entry -> Current-run Validation`

| Path | Skill | Launcher | Fixed mode | Production entry |
|---|---|---|---|---|
| Desktop | `skills/paperecho-zotero-desktop/SKILL.md` | `skills/paperecho-zotero-desktop/scripts/run.mjs` | `desktop` | `workflow/tools/stage0/main.mjs` |
| Web | `skills/paperecho-zotero-web/SKILL.md` | `skills/paperecho-zotero-web/scripts/run.mjs` | `web` | `workflow/tools/stage0/main.mjs` |
| Local | `skills/paperecho-local/SKILL.md` | `skills/paperecho-local/scripts/run.mjs` | `local` | `workflow/tools/local/main.mjs` |

主开发/审计入口是 `skills/paperecho-workflow/SKILL.md`，不直接执行生产流程。Codex 和普通交互式运行必须使用路径 Skill 或对应 launcher，不得默认直调 Stage0/Local main，也不得手工串联 Stage scripts。

## Runner and launchers

`node workflow/tools/web/server.mjs` 启动本地 Control Center（默认 `127.0.0.1:8765`）。它是可选交互入口，不是 production launcher，不启动 Stage1–Stage5、不操作调度器；业务请求只调用 `lib/control_*_service.mjs` application services。停止服务不影响上述固定运行链路。

| Path | Role | Direct user run | Production entry | Called by Skill/Runner | Side effects | Scheduled automation |
|---|---|---|---:|---|---|---|
| `workflow/tools/runner/main.mjs` | shared config, preflight, production invocation, current-run validation | advanced use only; explicit `--mode` required | no | launchers call it | `--check` read-only; `--run` inherits selected entry effects | only through an owned wrapper |
| `workflow/tools/runner/config_loader.mjs` | schema v1 config resolver | no | no | Runner only | local config reads | no |
| `workflow/tools/runner/preflight.mjs` | zero-write path-specific preflight | no | no | Runner only | local reads/checks only | no |
| `workflow/tools/runner/result_validation.mjs` | validates the emitted run ID and exact `run_group.json` | no | no | Runner only | current-run reads only | no |
| `skills/paperecho-zotero-desktop/scripts/run.mjs` | fixed Desktop launcher | yes, recommended for Desktop | interactive launcher | Desktop Skill -> Runner | inherits Runner action | yes, when scheduler owns launcher config |
| `skills/paperecho-zotero-web/scripts/run.mjs` | fixed Web launcher | yes, recommended for Web | interactive launcher | Web Skill -> Runner | inherits Runner action | yes, when scheduler owns launcher config |
| `skills/paperecho-local/scripts/run.mjs` | fixed Local launcher | yes, recommended for Local | interactive launcher | Local Skill -> Runner | inherits Runner action; never Zotero | yes, when scheduler owns launcher config |

## Production entries

| Path | Role | Direct user run | Production entry | Side effects | Scheduled automation |
|---|---|---|---:|---|---|
| `workflow/tools/stage0/main.mjs` | Desktop/Web orchestration | only maintenance/test or callers owning preflight and validation | yes, Desktop/Web | retrieval/network, local artifacts, Stage2/3 Zotero writes, Stage5 SMTP when requested | yes; direct Stage0 is retained for known schedulers |
| `workflow/tools/local/main.mjs` | Local orchestration | only controlled maintenance/test/integration; launcher preferred | yes, Local | Local state/artifacts, translation/LLM when configured, Stage5 SMTP when requested; no Zotero | yes, only for an owned Local integration |

Desktop/Web backend startup/readiness failure skips Stage2, Stage3, and Stage4; it does not continue to a normal final XLSX. Local never constructs a Zotero backend and never calls Stage2/Stage3.

## Stage owners

| Path | Role | Direct user run | Production entry | Called by entry | Side effects |
|---|---|---|---:|---|---|
| `workflow/tools/stage1/main.mjs` | retrieval/import boundary, normalization, identity dedupe, feedback learning, grading | no | no | Stage0 or Local main | network/LLM according to config; feedback item actions may mutate Zotero only on Zotero paths |
| `workflow/tools/stage2/main.mjs` | guarded Zotero create, exact dedupe, collection routing, migration | no | no | Stage0 only | real Zotero item/collection writes |
| `workflow/tools/stage3/main.mjs` | translation consumption, Zotero metadata writeback/readback, bounded pool scan | no | no | Stage0 only | translation network and Zotero metadata writes |
| `workflow/tools/stage4/main.mjs` | current-run workbook/monthly export, export audit, Run Summary | no | no | Stage0; Local uses Stage4 export owner functions | local artifact writes only |
| `workflow/tools/stage4/spreadsheet_adapter.mjs` | writes mutually exclusive `每日反馈` and `需人工复核` sheets | no | no | Stage4 only | local XLSX writes |
| `workflow/tools/stage5/main.mjs` | current-run notification orchestration | no | no | Stage0 or Local main after Stage4 | SMTP only when recipient requested; run-scoped state writes |

## Stage5 components

| Path | Role | Direct user run | Called by | Side effects |
|---|---|---|---|---|
| `workflow/tools/stage5/report_summary.mjs` | formats the Run Summary | no | Stage4/Stage5 integration | none beyond caller-owned output |
| `workflow/tools/stage5/literature_overview.mjs` | builds current-run A/B/C title overview | no | Stage5 | LLM only when configured; deterministic fallback otherwise |
| `workflow/tools/stage5/email_sender.mjs` | validates explicit attachments and sends SMTP mail | no | Stage5 | SMTP send |
| `workflow/tools/stage5/email_receipt.mjs` | run-scoped idempotency receipt | no | Stage5 | local receipt read/write |

Stage5 never scans historical directories for attachments and never rolls back Stage1-Stage4. A notification failure produces `failed_stage5_notification` on Desktop/Web and preserves prior outputs.

## Run lifecycle and cleanup

| Path | Role | Direct user run | Called by | Side effects |
|---|---|---|---|---|
| `workflow/tools/lib/runtime_housekeeping.mjs` | creates/finishes schema v1 run groups and applies registered retention | no | Stage0/Local main | bounded local cleanup under allowed roots |
| `workflow/tools/lib/ephemeral_registry.mjs` | tracks explicitly registered temporary files | no | production entries/stages | deletes only eligible registered closed/consumed files |
| `workflow/tools/maintenance/cleanup_runs.mjs` | housekeeping preview/apply CLI | yes, maintenance | operator | local cleanup; preview first with `--dry-run --force` |

`run_group.json` uses `running`, `completed`, and `failed`. Runner validates only `<runRoot>/<runId>/run_group.json` for the run ID emitted by the current invocation. It must verify schema/mode, applicable Stage states, current XLSX registration, Stage5, housekeeping warnings, and ephemeral cleanup; exit code 0 alone is insufficient.

## Diagnostics

| Path | Role | Direct user run | Side effects |
|---|---|---|---|
| `workflow/tools/stage0/check_zotero_backend_ready.mjs` | selected Zotero backend readiness | yes | backend read/probe; may access network |
| `workflow/tools/stage0/start_workflow_dependencies.mjs` | controlled Desktop startup/readiness recovery | maintenance only | may start/restart Desktop and probe backend |
| `workflow/tools/diagnostics/check_med_query_learning_feedback.mjs` | current feedback-learning diagnostic | yes | read-only |
| `workflow/tools/diagnostics/check_previous_feedback_learning.mjs` | previous-cycle feedback diagnostic | yes | read-only unless an explicit local report path is requested |
| `workflow/tools/diagnostics/zotero_cli_probe.mjs` | Desktop CLI capability probe | yes | Zotero read/probe |

## Maintenance

| Path | Role | Default safety | Real side effects |
|---|---|---|---|
| `workflow/tools/maintenance/archive_history_by_feedback.mjs` | one-off local archive plan/materialization | dry-run | local archive writes only under explicit apply |
| `workflow/tools/maintenance/zotero_feedback_collection_corrections.mjs` | feedback-driven collection corrections | dry-run | Zotero collection writes under explicit apply |
| `workflow/tools/maintenance/fix_dirty_publication_titles.mjs` | publication title correction | dry-run | Zotero metadata writes under explicit apply |

维护脚本不是默认 workflow 的组成部分。运行前必须阅读各自参数和 guard，优先 dry-run，不得把维护结果当作当前 production run 成功证据。
