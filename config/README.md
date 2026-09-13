# 用户可编辑配置

日常配置推荐使用 [PaperEcho Control Center](../docs/control-center.md) 的 Settings。逻辑 registry 位于 `workflow/tools/lib/control_config_service.mjs`，配置仍保存在下列既有文件中，不新增 mega-config。Web 只提供 allowlist 字段；保存前进行类型、范围及相应 owner 校验，失败保留旧值，下次运行读取新值。

Credentials 继续由环境/项目 `.env` 管理，网页支持 allowlist 本地凭据的状态、Replace、Clear，绝不回显原值；外部环境覆盖时只读。SecretService 保留其他 entries，严格检查可支持的单行格式后原子写入；不支持的格式保持原文件。Test 尚无可复用的安全 owner，未开放。缺少既有配置文件时页面显示“尚未初始化”，不会创建一个可能改变 mode 选择的新配置文件。Weekly 调度间隔只读；PubMed keyword groups 由现有 owner 生成 query，不能通过 raw query 绕开它。

这里集中放置用户可直接修改的配置、规则和参数。

- `.env` 只放本机密钥和少数真正需要环境注入的本机覆盖；已经在本目录 JSON 中声明的非密钥参数不要再复制到 `.env`。
- `rss_sources.json`: RSS 订阅源列表。
- `pubmed_pmc_search.json`: PubMed/PMC 检索条件，默认 `days_back` 为 10。
- `review-workflow-rules.json`: 分级标签、关键词、权重、阈值、期刊白名单和 feedback 语义搜索规则说明。
- `title_translation.config.json`: 标题翻译的非密钥参数。
- `preference_learning.config.json`: `screening_standards.docx` 中文评价理解的非密钥参数；密钥优先读 `PREFERENCE_LEARNING_API_KEY`，缺省回退到 `TITLE_TRANSLATION_API_KEY`。

长期筛选标准正文位于 `review_results/文献评价/screening_standards.md`。`screening_standards.docx` 是人工入口，包含偏好规则、检索关键词和评价三部分。
## review-workflow-rules.json 顶层 section

- 	riage：分级/筛选规则（标签、研究重点、优先级规则、分级规则、期刊质量筛选）
- llm_review：LLM 复审配置（启用/批大小/缓存等）
- manual_standard_evaluation：人工标准评价配置
- eedback_learning：反馈学习配置

## source_selection.json

研究领域驱动的检索源选择配置。根据 research_domain 字段决定运行时启用哪些检索源，而不是默认所有源一起跑。

**字段说明：**
- research_domain: 研究领域，可选值：
  - biomedical: 生物医学/临床医学/药学/公共卫生/生物学 -> 默认 PubMed/PMC + RSS
  - non_biomedical_stem: 传统理工/计算机/工程/材料/化学/物理/数学 -> 默认 OpenAlex + RSS
  - education_social_science: 教育/社科/管理/人文/经济/心理 -> 默认 OpenAlex + RSS
  - mixed_biomedical_technical: 混合领域 (medical AI / bioinformatics / health education) -> 显式启用 PubMed/PMC + OpenAlex + RSS
  - unknown: 未知/信息不足 -> 仅 RSS，需人工确认
- domain_options: 各领域的默认配置
- override_enabled_sources: 覆盖启用的源列表（数组），设置后优先级高于领域默认配置
- require_manual_confirmation: 是否需要人工确认（boolean）

**使用方式：**
1. 根据研究方向修改 research_domain
2. 非医学方向切换到 non_biomedical_stem 或 education_social_science
3. 混合领域必须显式设置为 mixed_biomedical_technical
4. 如需完全自定义检索源，使用 override_enabled_sources 字段

## openalex_search.json

OpenAlex works 检索配置。OpenAlex 不要求 API key，可通过 mailto 参数获得更高速率限制。

**字段说明：**
- enabled: 是否启用 OpenAlex 检索（boolean）
- query: 检索词（string）
- days_back: 检索近 N 天的文献（默认 10）
- per_page: 每页返回数量（默认 50，最大 200）
- mailto: 可选邮箱地址，用于获得更高速率限制
- filters: 过滤条件
  - type: 文献类型（默认 "article"）
  - is_oa: 是否仅开放获取（null/true/false）
  - from_publication_date: 起始日期
  - to_publication_date: 结束日期
  - concepts: 概念 ID 列表
- sort: 排序方式（默认 "relevance_score:desc"）
- select: 返回字段

**使用方式：**
1. 设置 enabled: true 启用 OpenAlex
2. 填写 query 检索词
3. 可选填写 mailto 获得更高速率限制
4. 确保 source_selection.json 中 enabled_sources 包含 "openalex"

**注意：**
- disabled 或空 query 时安全返回空结果，不影响其他源
- 不要填写真实邮箱地址
