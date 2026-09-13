# 内部模块归属与 CLI Wrapper 收敛记录

本文档记录 v1.3 能力归属审计结果、唯一 owner 指定、CLI wrapper 收敛原则，以及后续删除/归档候选。

## 生成时间

- 日期：2026-05-31
- 范围：10 项核心能力的审计与收敛

---

## 1. 能力归属表

Control Center application boundary：

- `workflow/tools/lib/control_application_services.mjs`：组合 services；纯文本评价调用 `stage1/manual_standard_evaluation.mjs` 的共享核心，propose 默认不变。
- `control_feedback_service.mjs`：canonical paper feedback history/current、幂等提交和批量原子写入；`control_legacy_feedback_adapter.mjs`：单向 XLSX import。
- `control_config_service.mjs`：固定字段 registry，映射现有 domain JSON；Runner 对象校验仍由 `runner/config_loader.mjs` 持有。
- `control_rule_suggestion_service.mjs`：人工决策及安全 apply 编排；schema/dedup 仍归 `unified_pending_rule_suggestions.mjs`，正文插入逻辑复用 `screening_standards_rule_suggestions.mjs`。DOCX adapter 调同一 service。
- `control_review_query_service.mjs`：registered run manifest/Stage4 artifact 只读查询，复用 verified-write filter。
- `control_credentials_service.mjs`：SecretService 的配置状态和输出脱敏，无独立 credential store。
- `workflow/tools/web/server.mjs` 与 `web/static/`：loopback HTTP 和 UI，不持有 retrieval、ranking、Zotero、learning 或配置文件写入逻辑。

| 能力 | 当前 Owner | CLI Wrapper | 当前状态 |
|------|-----------------|-------------|---------|
| Zotero backend readiness | `workflow/tools/lib/ensure_zotero_backend_ready.mjs` | `workflow/tools/stage0/check_zotero_backend_ready.mjs` | ✅ 已收敛为 thin wrapper |
| LLM grade review | `workflow/tools/stage1/llm_grade_reviewer.mjs` | `workflow/tools/stage1/llm_grade_review_step.mjs` | ✅ 当前正式路径 |
| workbook reader | `workflow/tools/lib/review_workbook_reader.mjs` | 无 | 独立 lib 模块 |
| writeback / dedupe | `workflow/tools/stage2/writeback_execution.mjs` + `workflow/tools/lib/writeback_support.mjs` | `workflow/tools/stage2/main.mjs` | Stage2 主流程已拆分，metadata guard 仍由 lib 提供 |
| title translation | `workflow/tools/lib/title_translation_support.mjs` | 无 | 独立 lib 模块 |
| translation backfill | `workflow/tools/stage3/translation_backfill_support.mjs` | `workflow/tools/stage3/main.mjs` | Stage3-local owner |
| export / spreadsheet | `workflow/tools/stage4/spreadsheet_adapter.mjs` | `workflow/tools/stage4/main.mjs` | Stage4-local owner |
| preference learning | `workflow/tools/lib/preference_learning_support.mjs` | 无 | 独立 lib 模块 |
| feedback learning | `workflow/tools/lib/feedback_learning_support.mjs` | 无 | 独立 lib 模块 |
| runtime config | `workflow/tools/lib/runtime_config.mjs` | 无 | 独立 lib 模块 |
| schedule / interval gate | `workflow/tools/lib/schedule_support.mjs` | 无 | 独立 lib 模块 |
| triage policy | `workflow/tools/stage1/rule_classifier.mjs` | `workflow/tools/stage1/main.mjs` | Stage1-local rule classifier；旧 `workflow_classifier.mjs` / `triage_policy.mjs` 兼容入口已删除 |

---

## 2. CLI Wrapper 原则

### 稳定约定

- **CLI wrapper 调明确 owner**：CLI 脚本应只做入口编排；Stage 专属逻辑放在对应 `workflow/tools/stage*/`，跨 Stage primitive 才放入 `workflow/tools/lib/`。
- **thin wrapper 标准**：CLI 不重复定义 lib 中已有的业务逻辑（如 probe、retry、格式化）。
- **参数兼容性**：CLI 的命令行参数和输出 JSON 格式在收敛过程中保持不变。

### 已完成的收敛

#### `workflow/tools/stage0/check_zotero_backend_ready.mjs` → thin wrapper

**变更前**：CLI 自定义了 `mcpProbe` 函数（约 12 行），与 lib 中的 probe 逻辑重复。

**变更后**：
- `ensure_zotero_backend_ready.mjs` 新增 `defaultMcpProbe(mcpUrl)` 函数，提供默认的 MCP JSON-RPC probe
- `ensureZoteroBackendReady()` 不传 `mcpProbe` 时自动使用默认实现
- `workflow/tools/stage0/check_zotero_backend_ready.mjs` 不再定义自己的 `mcpProbe`，直接调用 `ensureZoteroBackendReady()`

**影响范围**：
- `workflow/tools/stage0/check_zotero_backend_ready.mjs`：移除约 12 行重复代码
- `ensure_zotero_backend_ready.mjs`：新增约 16 行默认 probe 实现
- 行为不变：输出格式、CLI 参数、错误码均保持兼容

---

## 3. 暂不处理的高风险重复点

以下重复点在本轮审计中识别，但因涉及高风险模块（writeback、export、translation），暂不处理：

### 3.1 日期格式化函数重复

**涉及文件**：
- `workflow/tools/lib/runtime_config.mjs`：`yyMd`、`isoWeek`
- `workflow/tools/stage2/main.mjs`：`fmtDate`、`yyMd`、`isoWeek`
- `workflow/tools/stage3/main.mjs`：`fmtDate`、`yyMd`、`isoWeek`
- `workflow/tools/stage4/main.mjs`：`fmtDate`、`yyMd`、`isoWeek`、`weekNumber`、`weekLabel`
- `workflow/tools/lib/writeback_pool_dry_run_support.mjs`：`yyMd`、`isoWeek`、`weekLabel`
- `workflow/tools/lib/review_workbook_reader.mjs`：`weekNumber`、`isoWeek`、`yyMd`、`desktopWeekLabel`、`fmtDateRfc`

**建议**：统一使用 `runtime_config.mjs` 中的导出函数。需要修改 5+ 个文件，风险中等。

### 3.2 MCP 工具函数重复

**涉及文件**：
- `workflow/tools/stage2/main.mjs`：`mcpToolCall`、`wait`、`ensureMcpReady`
- `workflow/tools/stage3/main.mjs`：`mcpToolCall`、`wait`、`ensureMcpReady`

**建议**：已收敛到 `workflow/tools/lib/zotero_backend_client.mjs`；Stage2/Stage3 应继续通过 Zotero backend client 访问后端，不再新增 `mcp_client` 入口。

### 3.3 `cleanJournalSource` 函数重复

**当前状态**：历史 `review_results_exports.mjs` 路径已不存在；当前导出 owner 是 `workflow/tools/stage4/spreadsheet_adapter.mjs`。

**建议**：后续新增导出逻辑时继续复用 Stage4 adapter，不再恢复 Python 导出路径。

### 3.4 `parseDateNameToDate` 函数重复

**涉及文件**：
- `workflow/tools/stage2/main.mjs`
- `workflow/tools/stage3/main.mjs`

**建议**：提取到 `workflow/tools/lib/date_utils.mjs` 或 `runtime_config.mjs`。风险低，但涉及 Stage2/Stage3。

---

## 4. 后续删除/归档候选

| 文件 | 当前状态 | 删除条件 |
|------|---------|---------|
| `workflow/tools/diagnostics/check_med_query_learning_feedback.mjs` | 诊断脚本 | 确认功能已被 `feedback_learning_support.mjs` 覆盖 |
| `workflow/tools/diagnostics/check_previous_feedback_learning.mjs` | 诊断脚本 | 确认功能已被 `feedback_learning_support.mjs` 覆盖 |

---

## 5. 下一轮建议

### 低风险（可立即执行）

1. **统一日期格式化函数**：将 `fmtDate`、`yyMd`、`isoWeek`、`weekNumber`、`weekLabel` 统一到 `runtime_config.mjs`，其他文件改为 import
2. **提取 `parseDateNameToDate`**：提取到 `runtime_config.mjs` 或新模块

### 中风险（需谨慎评估）

3. **统一 Zotero backend 工具函数**：通过 `workflow/tools/lib/zotero_backend_client.mjs` 复用后端调用与 `wait`
4. **统一 `cleanJournalSource`**：JavaScript 版本作为唯一实现

### 高风险（建议分阶段执行）

5. **Stage2/Stage3 thin wrapper 收敛**：当前入口为 `workflow/tools/stage2/main.mjs` 和 `workflow/tools/stage3/main.mjs`
6. **Stage4 export 收敛**：当前入口为 `workflow/tools/stage4/main.mjs`

---
