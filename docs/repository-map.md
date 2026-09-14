# Repository map

从问题找 owner，不按文件数量拆目录。精确执行边界见 [AGENTS.md](../AGENTS.md)，详细调用面见 [脚本清单](script-inventory.md)。

| 类别 | 位置 | 职责与边界 |
|---|---|---|
| A 用户入口 | 根 `PaperEcho.exe` / `PaperEcho.app`、README | 普通用户双击；`.cmd` / `.command` 仅用于诊断 |
| B 核心 workflow | `workflow/tools/runner/`、`stage0/`–`stage5/`、`local/` | 固定路径、预检、编排及各 Stage owner；不是 Web UI |
| B 跨阶段能力 | `workflow/tools/lib/`、`integrity/`、`notification/` | 共享 primitive 与明确领域 owner；`lib` 不是任意 helper 收纳处 |
| C 应用/Web | `lib/control_*`、`workflow/tools/web/` | Application Services 管理业务；HTTP/static 只调用 services |
| D 兼容 | `lib/review_workbook_reader.mjs`、`lib/control_legacy_feedback_adapter.mjs`、Stage1 DOCX adapters | XLSX 单向导入、DOCX 文本/决策解析；继续调用当前 owner |
| E 配置 | `config/`、根 `.env.example` | [Config map](../config/README.md)；secret 不进入 JSON |
| F 测试 | `workflow/tests/`、`tests/` | 前者为正式 test gate；后者含被导入的 UI/launcher 测试及独立 benchmark/helpers |
| G 文档 | `docs/` | [Current / Compatibility / Historical 索引](README.md) |
| H 构建/支持 | `workflow/tools/web/launcher-windows/`、`workflow/tools/maintenance/` | EXE 源码/构建脚本与维护工具；不自动运行或安装依赖 |
| I Skills | `skills/` | workflow 开发指引、Desktop/Web/Local 固定入口、update 边界 |

根目录保留启动入口、package metadata 和仓库级配置；不存放新的开发临时脚本。运行数据不是源码目录，测试写入只用隔离 fixture/temp，禁止拿真实 output/runtime 做试验。

## 问题定位与测试

以下 source 均相对 `workflow/tools/`，test 均相对 `workflow/tests/`（显式标出的根 `tests/` 除外）。

| 问题 | 先看 owner | 定向测试 |
|---|---|---|
| runtime/config 路径 | `runner/config_loader.mjs`、`lib/runtime_config.mjs` | `runner_config.test.mjs`、`control_runtime_roots.test.mjs` |
| 论文反馈/配置保存/凭据 | `lib/control_application_services.mjs` 组合的 services | `control_services.test.mjs`、`control_credentials.test.mjs` |
| 偏好学习/自然语言评价 | `lib/preference_learning_support.mjs`、`stage1/manual_standard_evaluation.mjs` | `preference_refinement.test.mjs`、`control_services.test.mjs` |
| pending 决策 | `lib/control_rule_suggestion_service.mjs`、`lib/unified_pending_rule_suggestions.mjs` | `unified_pending_rule_suggestions.test.mjs`、`control_http.test.mjs` |
| XLSX/DOCX 兼容 | workbook reader、legacy feedback adapter、`stage1/screening_standards_docx.mjs` | `control_services.test.mjs`、`screening_standards_parser.test.mjs` |
| 页面/HTTP | `web/static/`、`web/server.mjs` | `control_ui.test.mjs`、`control_http.test.mjs` |
| 双击启动 | `web/launcher.mjs`；平台包装不持有实例/ready 逻辑 | 根 `tests/control_launcher.test.mjs` |
| 检索/来源 | `stage1/retrieval_step.mjs`、`retrieval_sources.mjs`、`source_selection_step.mjs` | `retrieval_orchestration.test.mjs`、`source_selection_openalex.test.mjs` |
| Zotero 写回 | `stage2/writeback_execution.mjs`、`lib/zotero_backend_client.mjs` | `writeback_to_zotero.test.mjs`、`zotero_backend_contract.test.mjs` |
| Integrity | `integrity/`、`stage2/integrity_mutation_step.mjs` | `integrity_monitoring.test.mjs`、`integrity_mutation_recovery.test.mjs` |
| Stage5 邮件/幂等 | `stage5/`、`notification/delivery.mjs` | `stage5_integration.test.mjs`、`notification_receipt.test.mjs` |

`control_http.test.mjs` 导入根 `tests/control_launcher.test.mjs`；`control_ui.test.mjs` 导入根 `tests/control_review_workspace.test.mjs`，两者都在正式 gate 内。Benchmark 不等同于普通单元测试，不应因为整理目录而自动执行。

定向示例：`node --test workflow/tests/control_ui.test.mjs workflow/tests/control_http.test.mjs`。语法检查为 `npm run check`；完整回归为 `npm test`（或 `npm run verify`）。纯文档调整检查本地链接与语法 gate 即可，不必重复全量回归。
