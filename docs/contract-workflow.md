# Workflow Contract

本文档说明 PaperEcho 当前执行契约。根 `AGENTS.md` 的 Canonical Architecture 优先级高于本文件。

## Interactive entry

默认生产链固定为：

`Path Skill -> Path Launcher -> Shared Runner -> Preflight -> Production Entry -> Current-run Validation`

| Path | Launcher | Production entry |
|---|---|---|
| Desktop | `node skills/paperecho-zotero-desktop/scripts/run.mjs --run` | `workflow/tools/stage0/main.mjs` with Desktop backend |
| Web | `node skills/paperecho-zotero-web/scripts/run.mjs --run` | `workflow/tools/stage0/main.mjs` with Web API backend |
| Local | `node skills/paperecho-local/scripts/run.mjs --run` | `workflow/tools/local/main.mjs` |

Stage0 是 Desktop/Web 的底层 production entry，不是 Codex/普通交互式运行的默认入口。只有 scheduled automation、维护/测试或明确自行承担配置、preflight、错误处理和结果验证的调用者可以直接运行。内部 Stage scripts 不作为完整入口。

## Stage order

Desktop/Web：

`Preflight -> Stage1 -> backend readiness -> Stage2 -> Stage3 -> Stage4 -> Stage5 -> run summary -> run-group manifest -> housekeeping -> ephemeral cleanup -> current-run validation`

Local：

`Preflight -> Stage1 -> shared title translation generation -> Local state persistence -> Stage4 -> Stage5 -> run summary -> run-group manifest -> housekeeping -> ephemeral cleanup -> current-run validation`

- Local 不执行 Stage2/Stage3，不构造或探测 Zotero backend。
- Desktop/Web startup/configuration 失败时跳过全部 business stages。
- Stage1 后 backend readiness 未通过时跳过 Stage2、Stage3 和 Stage4，不得声称生成最终 XLSX。
- Stage5 仅在 Stage4 成功后执行；通知失败保留 Stage1-Stage4 产物。

## Interval gate

- Default interval: 7 days (`review_results_RUN_INTERVAL_DAYS=7`).
- Force override: `FORCE_review_results_RUN=true` or `review_results_FORCE_RUN=true`.
- If the interval is not reached, business stages are skipped and the report records `skipped` plus interval diagnostics such as `skipped_due_to_interval` and `next_eligible_run_at`.
- The gate uses the `Asia/Shanghai` 15:00 planned slot, not actual start/end/Stage4 timestamps.

## Workbook contract

- `desktop_daily_review_source.json` contains only items actually admitted by Stage2 from `zotero_writeback_summary.writeback_items`.
- Stage1 ABC is the candidate pool, not the final workbook source.
- `周报.xlsx` and the Control Center share `stage1/semantic_grade_synthesis.mjs#classifyLiterature` and `stage4/finalize_exports_support.mjs#buildFinalReviewMembership` within the existing final eligibility boundary. `每日反馈` and `需人工复核` are mutually exclusive projections; display fields never decide membership.
- If Stage2/readiness fails, Stage4 does not run and no final workbook success may be claimed.

## Status and result validation

Exact Desktop/Web workflow status names are defined by `workflow/tools/lib/orchestrator_status.mjs` plus Stage0 terminal handling: `completed`, `completed_with_warnings`, `completed_stage1_only`, `degraded_due_to_zotero_backend_unavailable`, `skipped`, `skipped_due_to_interval`, `failed_stage1`, `failed_stage2_writeback`, `failed_stage3_translation`, `failed_stage4_export`, `failed_due_to_config_or_dependency`, `failed_stage5_notification`, and `failed_unhandled`.

Run-group manifests use only `running`, `completed`, and `failed`. Runner must extract the current invocation's run ID and read exactly `<runRoot>/<runId>/run_group.json`; it must validate schema, mode, manifest status, applicable stages, current XLSX registration, Stage5, housekeeping, and ephemeral cleanup. It must not scan history, guess by mtime, reuse old Stage5 state, or accept exit code 0 without manifest validation.

See `workflow/tools/README.md` for the current tool surface and `docs/script-inventory.md` for script roles and side effects.
