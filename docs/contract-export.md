# Export Contract

本文档定义 Stage 4 导出契约。

## 导出入口

`workflow/tools/stage4/main.mjs` — 负责周报/月报导出、运行报告汇总和导出审计。

## 导出方法回退链

固定顺序，每步可审计：

1. `codex_spreadsheet` / Codex spreadsheet capability (artifact tool-backed)
2. `node_fallback`（仅当 `exceljs` 可用时启用）
3. `python_spawn_legacy`（兼容旧环境）
4. `manual_required`

- `codex_spreadsheet` 是优先路径，实际由 Codex spreadsheet capability 提供；当前上下文如果看不到该 capability，会记录为“插件在当前执行上下文不可见”。
- 在本地直接用 Node 运行时，缺少 `@oai/artifact-tool` 是正常情况，不应被解释为业务流程失败。
- `node_fallback` 依赖 `exceljs`；当前仓库已提交 `package.json` 和 `package-lock.json`，新环境应先运行 `npm install`。
- `python_spawn_legacy` 仅保留兼容路径，不应作为默认或首选导出方式。
- `manual_required` 是所有自动导出器都不可用时的明确失败状态，不是静默失败。
- 每次导出必须在 `run_report.json` 中记录 `export_method`、`export_skill`、`output_path`、`input_files`、`generated_at`、`fallback_chain`。
- Codex spreadsheet capability 仅负责 workbook 生成，不执行 triage、Zotero writeback、metadata backfill、semantic learning/search、preference updates、star migration 或 candidate ranking。

### manual_required audit

进入 `manual_required` 时，必须尽量保留可人工处理的审计信息，包括：

- 数据源过滤状态和 warning
- `candidateCount`
- `writebackItemCount`
- `keptCount`
- `unmatchedCandidateCount`
- `unmatchedWritebackCount`
- `ambiguousCandidateKeyCount`
- `ambiguousWritebackKeyCount`
- 每个导出器不可用的原因，例如 `Spreadsheets` 插件在当前执行上下文不可见、`@oai/artifact-tool` 缺失，或 `exceljs` 缺失

缺少导出器不得掩盖数据源过滤问题；即使最终不能生成 workbook，也应能从 audit 判断本次导出输入是否正确。

## 周报.xlsx

### 数据源

- 仅包含当天 Stage2 实际写入 Zotero 的条目（来自 `zotero_writeback_summary.writeback_items`；旧 `mcp_writeback_summary` 只作 legacy fallback）
- 不包含文献池去重跳过的重复条目
- Stage 4 在导出前必须先基于 `zotero_writeback_summary.writeback_items` 过滤 `desktop_daily_review_source` / `allAbcItems`，无论是 orchestrator 调用还是 standalone 调用。
- 不管使用 `codex_spreadsheet`、`node_fallback` 还是进入 `manual_required`，导出输入都不得回退为 Stage 1 全量 ABC 候选。
- `writeback_items` 为空时，导出源应为空或标记 `no_new_writeback_items`，不得回退为全量 ABC。
- `zotero_writeback_summary.json` 缺失或 `writeback_items` 缺失时，应降级并记录 warning，不得把 Stage 1 全量 ABC 伪装成已写回日报。
- 匹配必须使用确定性 correlation key（title + source_channel + grade）；不得使用 title fuzzy match。
- candidate 或 writeback 侧存在 ambiguous correlation key 时，不得自动匹配。

### 两个 Sheet

- **需人工复核**：仅已写回且 `needs_human_review=true` 的条目；语义建议 D 的候选留在 Stage1 审计，不自动写回
- **每日反馈**：当天写入的剩余 ABC 条目（排除已进入复核的）
- 两个 sheet 合计 = 当天实际写入 Zotero 的全部 ABC 条目
- `D无关` 条目不包含在周报中

### 列规范

- 等级列：规则等级、语义等级、最终等级 — 只输出等级字母（A/B/C/D），不输出解释文本
- 反馈列：`反馈`（原 `feedback`）和 `评价`（原 `comment`）
- 已移除列：来源等级、已处理时间、处理状态、备注
- `期刊/来源` 列应清理为纯期刊名（移除 RSS/feed/平台后缀）

### 格式

- 每日反馈 sheet 使用三个等级列：规则等级、语义等级、最终等级
- 规则等级：规则系统初始等级
- 语义等级：语义复审建议等级
- 最终等级：系统采用的最终等级
- 自动采用的调整（B→A、C→B、B→C）在每日反馈中可见，不进入人工复核
- 用户填写 `人工确认等级` 列；规则/语义等级为只读证据

## 月报

- 间隔：当月最后一次到期运行
- 输出：`月报-*.docx`
- 导出根目录：`<项目根目录>/review_results/文献评价`
- 月报应验证趋势质量；如历史运行记录不足，报告应注明"记录不足"而非编造数据

## 导出根目录

- `review_results/文献评价` 下的用户面向文件：`周报.xlsx`、`月报-*.docx`、`screening_standards.md`、`screening_preferences.xlsx` 等
- Pipeline artifacts 在 `review_results/pipeline/<yy.M.d>`

## Stage 4 边界

- Stage 4 修复/导出不得重新运行 Stage 1-3，不得触发任何 Zotero 写操作。

详见 `workflow/tools/stage4/spreadsheet_adapter.mjs`（导出适配器）和 `workflow/tools/stage4/finalize_exports_support.mjs`（导出支持）。
