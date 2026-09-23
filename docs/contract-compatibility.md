# Compatibility Contract

本文档只定义当前跨平台边界和仍受支持的兼容读取。生产调用链、Stage 和状态以根 `AGENTS.md` 为准。

## 运行时要求

- **Node.js** >= 18.0.0
- **PowerShell 7 (pwsh)** >= 7.0.0

## 平台特定规则

不同操作系统使用不同命令，但产生相同的功能行为：

| 操作 | Windows | macOS | Linux |
|------|---------|-------|-------|
| 启动 Zotero | platform-aware local launch | `open -a Zotero` | configured executable spawn |
| 检测 Zotero 进程 | `tasklist` + `Get-Process` via pwsh | `ps -A -o comm=` | `ps -A -o comm=` |
| LLM review preflight | 无独立本地进程；正式路径使用 in-process LLM review | 同左 | 同左 |

所有其他操作（backend probe、RSS fetch、PubMed query、triage、dedup、writeback、translation、export、Stage5、run-group 和 cleanup）是平台无关的 Node.js 代码。

## 不能跨平台混用的命令

- Windows process commands仅在 win32 代码路径中调用
- macOS 必须使用 `open` / `ps` 等效命令
- Web 路径不得启动 Desktop；Local 路径不得探测或构造 Zotero backend

## Pwsh Gate

- 最低版本 `7.0.0`
- `7.0.0`、`7.4.x`、`7.6.2`、`7.7.x`、`8.x` 以及未来主版本 `>=7` 均可接受
- `5.1`、`6.x` 以及所有主版本 `<7` 不通过最低 gate
- 未知版本输出必须审计（`pwsh_version_unknown=true`，捕获原始输出），但不应自动视为硬失败

## Supported compatibility

- `PAPERFLOW_*` 环境变量继续按配置文档读取；不得用残留变量推断 path mode。
- 旧持久化 schema/path 只允许通过现有 tolerant reader 兼容读取；新写入必须使用当前 schema/path。
- 已知 scheduled automation 可直接调用 Desktop/Web Stage0 或 Local main，但必须自行承担配置、preflight、错误处理和 current-run validation；交互式 Codex 仍使用路径 launcher/Runner。

## LLM-only Review

- 正式 workflow 使用 in-process LLM review paths，不启动或探测独立本地语义服务
- 偏好学习正式路径：`runLlmPreferenceLearning`
- 标题级复审正式路径：`reviewGradesWithLlm`
- 规则上下文正式路径：`buildLlmRuleContextSummary`
- 兼容 report 字段如仍存在，必须保持 false/null 并标注 `removed_llm_workflow`；它们不定义 backend、readiness gate 或 fallback

## 语义复审资格

- 仅处理 **B** 和 **C** 条目
- **A** 条目不复审（已是最高等级）
- **D** 条目不复审（包括 `flags.uncertain=true` 的条目）
- C→D 语义降级**不自动采用**：`final_grade` 保持 C，`needs_human_review=true`；所有语义建议 D 的 ABC 候选保留在 Stage1 审计，不自动写入 Zotero
- 其他 1 级调整（C→B、B→A、B→C）自动采用
- 2+ 级差异保持 `rule_grade` 并标记 `needs_human_review=true`

## npm metadata

- 当前仓库已提交 `package.json` 和 `package-lock.json`
- 新环境应先运行 `npm install`
- 本地命令直接使用 Node 二进制运行
- 窄验证命令：`node --test workflow/tests/*.test.mjs`（如存在）
- 复现性依赖于文档化的运行时版本和 `.env.example`
