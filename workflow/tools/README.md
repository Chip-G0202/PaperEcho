# PaperEcho tools

日常反馈与配置入口：[Control Center](../../docs/control-center.md)。从项目根目录运行 `node workflow/tools/web/server.mjs`。这不会启动文献 workflow；正式生产执行仍使用下方固定 launcher。

本目录包含 PaperEcho 的 shared Runner、底层 production entries、Stage owners、诊断和维护工具。强制规则以根 `AGENTS.md` 为准；本文件只说明当前调用面。

## 推荐交互式运行

Codex 和普通交互式生产执行固定使用：Path Skill -> Path Launcher -> Shared Runner -> Preflight -> Production Entry -> Current-run Validation。

| Path | Skill | Launcher | Runner mode | Production entry |
|---|---|---|---|---|
| Desktop | `$paperecho-zotero-desktop` | `node skills/paperecho-zotero-desktop/scripts/run.mjs --run` | `desktop` | `workflow/tools/stage0/main.mjs` |
| Web | `$paperecho-zotero-web` | `node skills/paperecho-zotero-web/scripts/run.mjs --run` | `web` | `workflow/tools/stage0/main.mjs` |
| Local | `$paperecho-local` | `node skills/paperecho-local/scripts/run.mjs --run` | `local` | `workflow/tools/local/main.mjs` |

三个 launcher 都调用 `workflow/tools/runner/main.mjs`。`--check` 只执行零写入 preflight；`--run` 才调用 production entry，并从本次输出提取 run ID、精确验证对应 `run_group.json`。不得扫描历史目录或按 mtime 猜测结果，不得自动切换 mode。

## 底层直接入口

- `workflow/tools/stage0/main.mjs` 是 Desktop/Web 的底层 production entry。仅 scheduled automation、已知外部调度器、维护/测试场景或明确自行承担配置、preflight、错误处理和本次结果验证的调用者可直接运行。
- `workflow/tools/local/main.mjs` 是 Local 的底层 production entry。普通交互式运行仍必须通过 Local launcher/Runner；直接调用只用于维护、测试或受控集成。
- 禁止由 Agent 手工串联 `stage1` 至 `stage5`。

## 当前流程

Desktop/Web：

`Preflight -> Stage1 -> backend readiness -> Stage2 -> Stage3 -> Stage4 -> Stage5 -> run summary -> run-group manifest -> housekeeping -> ephemeral cleanup -> current-run validation`

Local：

`Preflight -> Stage1 -> shared title translation generation -> Local state persistence -> Stage4 -> Stage5 -> run summary -> run-group manifest -> housekeeping -> ephemeral cleanup -> current-run validation`

Local 不执行 Stage2/Stage3，不构造或探测 Zotero backend。Desktop/Web backend startup/readiness 未通过时，Stage2、Stage3、Stage4 均跳过，不得声称生成最终 XLSX。Stage5 仅在 Stage4 成功后执行；通知失败不回滚 Stage1-Stage4 产物。

## Stage owners

- `stage1/main.mjs`：检索或注入导入、归一化、共享 identity 去重、反馈学习和分级。
- `stage2/main.mjs`：Zotero 写回、精确去重、集合路由、恢复和索引刷新。
- `stage3/main.mjs`：共享翻译消费、Zotero `shortTitle` 写回/读回和受限 pool scan。
- `stage4/main.mjs`：本次周报/月报导出、export audit 和 Run Summary。
- `stage5/main.mjs`：本次 Run Summary 格式化、标题概览、附件验证、SMTP 发送和 receipt。

周报固定包含互不重叠的 `每日反馈` 与 `需人工复核` 两张 sheet；详细字段和筛选条件以 `stage4/spreadsheet_adapter.mjs` 及对应测试为准。

Stage5 使用本次 run 的显式附件，不扫描历史目录。无收件人时正常 `skipped`；发送失败保留 Stage1-Stage4 结果。SMTP/LLM 测试必须使用 mock，不得真实连接外部服务。

## Runner and lifecycle

- `runner/main.mjs`：配置解析、preflight、单次 production invocation 和 current-run validation。
- `lib/runtime_housekeeping.mjs`：schema v1 `run_group.json`、注册 artifact 的保留期清理和保护边界。
- `lib/ephemeral_registry.mjs`：只清理显式注册且已关闭/消费的临时文件。
- `maintenance/cleanup_runs.mjs`：housekeeping dry-run/apply CLI；默认先用 `--dry-run --force` 预览。

run-group manifest 只使用 `running`、`completed`、`failed`。housekeeping 失败记录 warning，不改变业务结果；长期 state、shared index、translation cache、feedback、monthly reports 和 screening standards 不按运行年龄删除。

## Diagnostics and maintenance

- `stage0/check_zotero_backend_ready.mjs`：所选 Zotero backend readiness 诊断。
- `diagnostics/check_med_query_learning_feedback.mjs`：反馈学习诊断。
- `diagnostics/check_previous_feedback_learning.mjs`：前一周期反馈学习诊断。
- `diagnostics/zotero_cli_probe.mjs`：Desktop CLI 探针。
- `maintenance/archive_history_by_feedback.mjs`：历史反馈归档，默认 dry-run。
- `maintenance/zotero_feedback_collection_corrections.mjs`：集合级反馈修正，写入需显式 apply。
- `maintenance/fix_dirty_publication_titles.mjs`：publication title 修正，写入需显式 apply。

完整脚本角色和副作用边界见 `../../docs/script-inventory.md`。
