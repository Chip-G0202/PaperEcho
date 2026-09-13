# PaperEcho Control Center — v2.4 使用与兼容说明

## 启动与使用

在已有 PaperEcho 项目根目录运行：

```sh
node workflow/tools/web/server.mjs
```

打开 <http://127.0.0.1:8765>；终端 Ctrl+C 停止服务。无需安装新依赖、构建前端或启动数据库。服务不会启动 workflow，不会修改调度器，也不会进行 Zotero readiness probe。原 Desktop/Web/Local launcher 完全独立运行。

1. **概览**：最近可用 Weekly、可识别的 Radar、最近运行结果、来源与审核数量。无可靠证据的状态显示未知；Zotero 只反映最近写入记录，不表示实时连接正常。
2. **Weekly 文献**：每页 50 篇，基于 registered run manifest 找到成功 Stage4，再经过现有 verified-write filter，绝不直接展示 Stage1 全候选池。中文、长标题和缺 DOI 均支持；只要存在其他可靠 canonical identity 即可反馈。
3. **研究反馈**：自然语言直接调用共享 evaluation 核心，先保存收据再尝试处理。需要原有 LLM 配置。失败保留输入，显示 blocker；重试相同请求不会重复生成已完成建议。网页不显示 prompt 或 raw LLM response。
4. **待确认建议**：支持 Accept / Reject / Revise then accept。接受会再次询问人工确认；安全校验通过后才修改正式正文。拒绝不会写正式规则。
5. **Settings**：按 General、Models、Sources、Search、RSS、Ranking / Review、Radar、Weekly、Integrity、Zotero、Notifications、Credentials、Advanced 分组。原配置文件仍由原 owner 持有；修改不会导致文件物理合并。

## 反馈语义与存储

| UI 值 | 原 workflow 值 | 意义 |
|---|---|---|
| Highly Relevant | upgrade | 强正向反馈 |
| Relevant | keep | 弱正向 / 保留 |
| Maybe | downgrade | 降低优先级 |
| Irrelevant | drop | 强负向反馈 |
| Do not recommend similar | drop | 强负向反馈，保留独立 UI 值，不直接创建永久排除规则 |

`review_results/文献评价/paper_feedback.json` 是 schemaVersion 1 的 canonical paper feedback state。每次有效提交追加 revision，保留 requestId、canonical identity aliases、时间与反馈上下文；当前有效反馈由最后一个 revision 推导。相同 requestId/内容幂等，改变内容应使用新 requestId。Title 仅作为上下文，不能单独用于 identity。

Stage1 在存在 canonical feedback 时从该 state 读取当前值；无 state/无反馈时仍使用原 XLSX adapter。原有 Local 显式 JSONL 输入优先级保留。论文动作使用稳定 DOI/PMID/PMCID 匹配；无法匹配时保留人工处理，不回退到猜标题。下一次 workflow 通过既有 collection guard 执行动作，网页提交不会直接操作 Zotero。

研究评价收据位于 `review_results/文献评价/research_evaluations/`；pending schema、去重与状态仍使用 `standards_rule_suggestions_log.json`。这些存储边界不合并。

## Legacy compatibility 与单向 import

- Weekly XLSX 仍由原 Stage4 生成，历史 feedback reader 保留。
- `screening_standards.docx` 仍可解析、导出。DOCX evaluation 与纯文本入口走同一核心；DOCX decision adapter 与网页走同一 RuleSuggestionService。
- 不存在 Web → XLSX、Web → DOCX feedback 的双向同步。网页评价不会替换或清空 DOCX 评价区。
- 不自动扫描、迁移全部历史文献。可由维护调用者使用 `importLegacyWorkbook(file, feedbackService)` 做显式单向导入；原文件不变，导入返回 receipt。没有可靠 DOI/PMID 的行会阻止该次导入，不猜测 title identity。
- 批量导入一次原子提交；requestId 由源文件内容 hash 和 row 派生，重复导入同一文件幂等。
- 不需要启动 Control Center 才能读取 canonical state；正常 workflow 仍按原有 launcher 运行。

## 当前能力边界

- 查询覆盖默认 review root 下注册的 Desktop/Web Weekly runs。未注册的历史输出、外部自定义 outputRoot、Local repository review 查询不会自动扫描或迁移；继续使用原报告。
- 下一次调度只有在可可靠读取时才应显示；当前显示未知。Weekly 间隔只读，不重写正式 scheduler state。
- 等级复审和 literature overview 使用现有 preference learning 模型配置，不增加第二套模型 owner。
- 缺少 owner JSON 时设置只显示未初始化；按原配置指南初始化后再使用网页。
- ConfigService 不提供 arbitrary JSON/path API。PubMed keyword groups 更新由现有 query builder 生成检索式；已有 keyword groups 时直接 query 编辑被拒绝。
- 安全 apply 当前仅支持正文追加及修订后追加。高风险、删除、已有规则替换、搜索关键词 suggestion、其他 target mutation 保持 pending；Control Center 返回 `application_status: requires_manual_action`、target、risk、未应用原因和人工处理说明。这是预期安全行为，不表示按钮失效或正式规则已应用。可以拒绝建议，或通过现有规则/检索配置维护流程人工核对范围、验证和备份；网页确认不能解除 guard。
- Credentials 支持 configured/not configured、Replace、Clear；覆盖 TITLE_TRANSLATION_API_KEY、PREFERENCE_LEARNING_API_KEY、EASYSCHOLAR_SECRET_KEY、SMTP_PASS、ZOTERO_API_KEY。Configured 不等于连接有效。没有可复用的安全连接测试 owner，因此 Test 未开放。不提供 raw secret GET，不创建 credential vault。
- 低风险规则正文变更先保存固定 `.backup`，再原子替换正文；日志写入失败时恢复正文。进程在正文提交后中断、决策日志提交前中断时，pending 保留，重试经已有 duplicate guard 不重复追加。

上述边界是实际未覆盖能力，不能视为完整 v2.4 验收全部完成。没有 tag、release 或自动更新切换。

## 凭据安全写入约定

`control_credentials_service.mjs` 中的 SecretService 是唯一网页凭据写入 owner；持久存储仍为项目 `.env`。只接受 allowlist key 和最多 4096 字符的单行值，不接受控制字符或同时包含两种引号的值。格式检查复用既有 loader 的解析结果，并仅支持无重复 key 的单行赋值、空行及注释；多行、export、含糊引号等格式拒绝写入，请通过原环境配置入口维护。未知 entries 保持原样。

写入使用既有原子文件 owner 和锁，临时文件 POSIX mode 为 0600（Windows 继承目录 ACL），不生成含 secret 的备份；`.env`、临时文件和锁均被 gitignore 排除。写入失败不更新当前环境，错误仅返回固定代码。旧值在当前服务进程内继续用于脱敏，清除不会使旧值重新出现在响应中。

当前进程中的外部环境值与本地文件不一致时该项只读，需在原注入入口维护后重启。本地修改对当前 Control Center 和下一次 workflow 生效，已运行的其他进程需重启。Clear 将目标值置空，不修改其他 key；例如 preference learning 仍可能按既有规则回退使用 title translation key。

## 安全与验证

默认只绑定 `127.0.0.1`，程序调用只允许 `127.0.0.1`/`::1`；Host allowlist、防跨站 Origin 检查、HttpOnly SameSite session cookie 和 CSRF header 共同保护 mutation。请求体限制 64 KiB，静态资源固定 allowlist，CORS 默认不开放。UI 使用 textContent，安全外链限制 http/https，并设置 CSP、防嵌入和 no-referrer。

```sh
node --test workflow/tests/control_services.test.mjs workflow/tests/control_http.test.mjs
node --test workflow/tests/control_credentials.test.mjs
npm run check
npm test
```

新增测试只写项目内临时 fixture，HTTP 使用临时 loopback port，LLM 为注入 mock；不连接真实 Zotero、LLM、SMTP，不访问 Production。运行全量旧 tests 时，将 TEMP/TMP 与 npm_config_cache 指向工作区临时目录，以保持输出隔离。不得为 Control Center 的验收更改正式 scheduler、配置、ledger、索引或用户反馈。
