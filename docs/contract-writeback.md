# Writeback Contract

本文档定义 Stage 2 Zotero 写回契约。

## 写回入口

`workflow/tools/stage2/main.mjs` — 通过 Zotero backend 执行条目创建、集合挂接、签名标签清理和星标迁移。

## Zotero 集合结构

- 根集合：`文献池`
- 每日日期集合：`YYYY-MM-DD`（创建于根集合 `文献池` 下）
- 日期集合下创建：`RSS订阅`、`数据库检索`
- 日期集合下创建：`A课题相关`、`B专题相关`、`C领域相关`
- 新入库条目必须先加入根 `文献池`，再加入每日来源/等级集合
- 条目不得只停留在根 `文献池`
- 条目不得直接放在日期集合本身

## Zotero backend mutation guard

- 允许写操作的集合范围仅限：
  - 唯一顶层 `文献池` 及其所有子集合
  - 唯一顶层 `值得精读`
- 缺失时自动创建：
  - 顶层 `文献池`
  - `文献池/待删除`
  - 顶层 `值得精读`
- `待删除` 只允许位于 `文献池/待删除`；顶层 `待删除` 不属于允许范围。
- `值得精读` 只允许作为顶层集合；`文献池/值得精读` 不属于允许范围。
- `add_items_to_collection`、`remove_items_from_collection`、`create_collection`、`delete_collection`、`write_metadata` 必须在进入 Zotero backend 前经过统一 guard。
- 目标或来源集合不在允许范围时，跳过对应操作并记录 `collection_scope_blocked`。
- 必需集合存在同名歧义或位置错误时 fail closed。
- 报告字段必须包含 `collection_scope_guard_enabled`、`collection_scope_blocked_count`、`collection_scope_blocked_samples`。

## 去重策略

写回前执行去重检查：

1. 读取/构建 `文献池`、`文献池/待删除`、`值得精读` 的重复索引
2. 精确规范化匹配优先级：`DOI > PMID > PMCID > arXiv > OpenAlex > URL > 精确规范化标题`；缓存命中需经实时读取核实，读取失败不得视为不存在
3. 标题规范化覆盖：Unicode/标点/间距变体（NFKC/NFKD、引号/破折号统一、全角映射、组合标记移除、控制/零宽清理）
4. 重复匹配处理：
   - 在 `文献池` 中重复：跳过创建，跳过所有 add-to-collection 操作
   - 在 `文献池/待删除` 中重复：同上
   - 在 `值得精读` 中重复：同上
   - 不重复：创建后仅添加到每日来源/等级集合，不强行添加到根 pool
5. 记录 `skipped_duplicate_in_pool`、`skipped_duplicate_in_trash`、`skipped_duplicate_in_worthy` 和 created/add 计数器

## 星标迁移（Star Migration）

- 默认启用；由 `ZOTERO_STAR_MIGRATION_MODE` 控制（`expand` / `legacy` / `disabled`）
- 扫描窗口：`ZOTERO_STAR_MIGRATION_WINDOW_DAYS`（默认 `7`）
- 星标阈值：`ZOTERO_STAR_MIGRATION_MIN_STARS`（默认 `4`）
- `expand` 模式扫描 A + B + C 等级集合；`legacy` 模式仅扫描 A + B
- 迁移目标集合：`值得精读`（顶层，`文献池` 的同级）

### 迁移流程

对每个符合条件的条目：
1. 添加条目到 `值得精读`
2. 从日期子集合中移除条目（来源集合 + 等级集合）
3. 从根 `文献池` 中移除条目 — **必须执行**，保持根和日期子集合同步

如果任何移除步骤失败，记录错误并继续下一个条目；不中止迁移。

## 翻译补翻（Pool Scan）

- 执行频率：`ZOTERO_TRANSLATION_POOL_SCAN_INTERVAL_DAYS`（默认 `14`），即每两次 7-day 自动化执行一次
- 扫描窗口：`ZOTERO_TRANSLATION_POOL_SCAN_WINDOW_DAYS`（默认 `14`）
- 仅检查最近日期子集合中缺少 shortTitle 的条目
- 扫描限制：`ZOTERO_TRANSLATION_POOL_SCAN_LIMIT`（默认 `50`）
- 补翻只静默补翻译，不混入周报数据源
- `write_metadata` 只允许作用于 Stage 2 `writeback_items` 或 allowed pool scan 得到的条目。

## 历史集合修改

- Stage 1 默认执行 feedback item actions；设置 `APPLY_FEEDBACK_ITEM_ACTIONS=false` 时只生成计划。
- 显式修正命令：`node workflow/tools/maintenance/zotero_feedback_collection_corrections.mjs`
- 修正必须仅使用 Zotero backend，不访问 `zotero.sqlite`、不移动 PDF、不删除附件
- `drop` 修正目标是 `文献池/待删除`
- `upgrade` / `downgrade` 只允许在 `文献池` subtree 内移动到对应日期等级集合。
- `keep` 为 no-op。
- 历史归档清理集合不属于默认 feedback item actions；普通 pipeline 不删除 `历史反馈归档`。

## 禁止直接修改

- 永远不要直接编辑 `zotero.sqlite`
- PDF 获取不在自动化范围内

详见 `workflow/tools/lib/writeback_support.mjs`（写回支持库）。
