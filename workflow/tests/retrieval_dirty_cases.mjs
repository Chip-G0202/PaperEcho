const many = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(3, "0")}`);

export const RETRIEVAL_DIRTY_CASES = [
  { id: 1, family: "simple", label: "one keyword", domain: "general", query: "graphene", sentinelSet: "graphene" },
  { id: 2, family: "simple", label: "two-word concept", domain: "general", query: "machine learning" },
  { id: 3, family: "simple", label: "exact phrase", domain: "general", query: '"perovskite solar cells"', sentinelSet: "perovskite" },
  { id: 4, family: "boolean", label: "A AND B", domain: "general", query: "graphene AND transistor" },
  { id: 5, family: "boolean", label: "A OR B", domain: "general", query: "graphene OR silicene" },
  { id: 6, family: "boolean", label: "(A OR B) AND C", domain: "general", query: "(graphene OR silicene) AND transistor" },
  { id: 7, family: "boolean", label: "three synonym groups", domain: "general", keywordGroups: { required: [["graph neural network", "graph convolutional network"], ["molecular property", "drug property"], ["prediction", "screening"]] }, sentinelSet: "graph_neural_networks" },
  { id: 8, family: "boolean", label: "nested parentheses", domain: "general", query: "((graphene OR silicene) AND (sensor OR transistor)) NOT review" },
  { id: 9, family: "boolean", label: "NOT", domain: "general", query: "battery NOT lead-acid" },
  { id: 10, family: "biomedical", label: "gene symbol", domain: "biomedical", query: "TP53 cancer", sentinelSet: "tp53_cancer" },
  { id: 11, family: "biomedical", label: "disease and treatment", domain: "biomedical", query: "melanoma AND immunotherapy", sentinelSet: "checkpoint_immunotherapy" },
  { id: 12, family: "biomedical", label: "MeSH-like phrase", domain: "biomedical", query: '"Neoplasms" AND "Immune Checkpoint Inhibitors"' },
  { id: 13, family: "biomedical", label: "acronym and full name", domain: "biomedical", query: '(CAR-T OR "chimeric antigen receptor T cell") AND leukemia', sentinelSet: "car_t" },
  { id: 14, family: "biomedical", label: "drug hyphen", domain: "biomedical", query: "5-fluorouracil colorectal cancer" },
  { id: 15, family: "biomedical", label: "T-cell", domain: "biomedical", query: "T-cell exhaustion cancer" },
  { id: 16, family: "biomedical", label: "single-cell", domain: "biomedical", query: '(single-cell OR "single cell") AND cancer', sentinelSet: "single_cell_cancer" },
  { id: 17, family: "biomedical", label: "Greek and Unicode", domain: "biomedical", query: "β-catenin AND cancer" },
  { id: 18, family: "technical", label: "machine-learning", domain: "general", query: "machine-learning climate prediction", sentinelSet: "deep_learning" },
  { id: 19, family: "technical", label: "graph neural network", domain: "general", query: '"graph neural network" molecule', sentinelSet: "graph_neural_networks" },
  { id: 20, family: "technical", label: "climate and energy", domain: "general", query: '(climate OR decarbonization) AND "energy storage"' },
  { id: 21, family: "technical", label: "social science phrase", domain: "general", query: '"false news" AND social media', sentinelSet: "misinformation" },
  { id: 22, family: "technical", label: "interdisciplinary", domain: "general", query: '(deep learning OR artificial intelligence) AND protein structure', sentinelSet: "alphafold" },
  { id: 23, family: "pathological", label: "30+ synonyms", domain: "general", keywordGroups: { required: [many("sensor-synonym-", 36), ["environmental monitoring", "pollution sensing"]] } },
  { id: 24, family: "pathological", label: "100+ OR terms", domain: "general", keywordGroups: { required: [many("material-term-", 110)] } },
  { id: 25, family: "pathological", label: "near URL length", domain: "general", keywordGroups: { required: [many("electrochemical-sensing-variant-", 70), ["water quality"]] } },
  { id: 26, family: "pathological", label: "over URL length", domain: "general", keywordGroups: { required: [many("long-engineered-material-synonym-", 180), many("application-context-", 20)] }, expectChunking: true },
  { id: 27, family: "pathological", label: "deeply nested groups", domain: "general", query: "((((graphene OR silicene) AND sensor) OR ((nanotube OR nanowire) AND detector)) AND water) NOT review" },
  { id: 28, family: "pathological", label: "punctuation", domain: "general", query: "CO2-capture, membrane; selectivity" },
  { id: 29, family: "pathological", label: "quotes inside terms", domain: "general", query: '"teachers\\" beliefs" AND assessment' },
  { id: 30, family: "pathological", label: "slash", domain: "general", query: "water/energy nexus" },
  { id: 31, family: "pathological", label: "colon", domain: "general", query: "climate:adaptation policy" },
  { id: 32, family: "pathological", label: "parentheses in chemical or gene name", domain: "biomedical", query: "BRCA1(c.68_69delAG) breast cancer" },
  { id: 33, family: "pathological", label: "Unicode", domain: "general", query: "钙钛矿 solar cell" },
  { id: 34, family: "pathological", label: "stop words", domain: "general", query: "the role of AI in the future of education" },
  { id: 35, family: "pathological", label: "wildcard", domain: "general", query: "electrocatal* AND hydrogen" },
  { id: 36, family: "pathological", label: "malformed wildcard", domain: "general", query: "electro*cat* AND hydrogen", expectCompilerError: true },
  { id: 37, family: "pathological", label: "contradictory NOT", domain: "general", query: "graphene AND NOT graphene", expectDegraded: "contradictory_exclusion" },
  { id: 38, family: "overconstraint", label: "individual concepts nonzero full AND zero", domain: "general", keywordGroups: { required: [["graphene"], ["medieval liturgy"], ["quantum chromodynamics"]] }, scenario: "overconstrained" },
  { id: 39, family: "overconstraint", label: "exact phrase zero relaxed phrase nonzero", domain: "general", query: '"graphene medieval liturgy detector"', scenario: "relaxed_phrase" },
  { id: 40, family: "rescue", label: "OpenAlex zero S2 positive", domain: "general", query: '"graph representation learning for molecules"', scenario: "openalex_zero_s2_positive" },
  { id: 41, family: "rescue", label: "OpenAlex zero Crossref positive", domain: "general", query: '"ultranarrow bibliographic anchor example"', scenario: "openalex_zero_crossref_positive" },
  { id: 42, family: "rescue", label: "PubMed zero Europe PMC positive", domain: "biomedical", query: '"life science preprint sentinel"', scenario: "pubmed_zero_europe_pmc_positive" },
  { id: 43, family: "failure", label: "source timeout", domain: "general", query: "graphene sensor", scenario: "timeout" },
  { id: 44, family: "failure", label: "429", domain: "general", query: "graph neural network", scenario: "rate_limit" },
  { id: 45, family: "failure", label: "partial pagination failure", domain: "general", query: "machine learning", scenario: "partial_pagination" },
];

export const KNOWN_HIT_SENTINEL_SETS = [
  { id: "graphene", domain: "general", query: "graphene electronic properties", identifiers: ["doi:10.1126/science.1102896", "doi:10.1038/nmat1849", "doi:10.1103/physrevlett.97.216803"] },
  { id: "perovskite", domain: "general", query: "perovskite solar cells", identifiers: ["doi:10.1021/ja809598r", "doi:10.1126/science.1228604", "doi:10.1038/nphoton.2013.80"] },
  { id: "graph_neural_networks", domain: "general", query: "graph neural networks", identifiers: ["doi:10.1109/tnnls.2020.2978386", "doi:10.1016/j.neunet.2018.12.012", "doi:10.48550/arxiv.1609.02907"] },
  { id: "deep_learning", domain: "general", query: "deep learning", identifiers: ["doi:10.1038/nature14539", "doi:10.48550/arxiv.1207.0580", "doi:10.48550/arxiv.1512.03385"] },
  { id: "misinformation", domain: "general", query: "false news social media", identifiers: ["doi:10.1126/science.aap9559", "doi:10.1126/science.aau2706", "doi:10.1126/science.aao2998"] },
  { id: "tp53_cancer", domain: "biomedical", query: "TP53 cancer", identifiers: ["pmid:39450536", "pmid:21331359", "pmid:30224644"] },
  { id: "checkpoint_immunotherapy", domain: "biomedical", query: "melanoma immune checkpoint therapy", identifiers: ["pmid:36600653", "pmid:27079802", "pmid:36477031"] },
  { id: "car_t", domain: "biomedical", query: '"chimeric antigen receptor" AND (leukemia OR lymphoma)', identifiers: ["pmid:23527958", "pmid:29385370", "pmid:29226797"] },
  { id: "single_cell_cancer", domain: "biomedical", query: "single cell RNA sequencing cancer", identifiers: ["pmid:40552583", "pmid:37607536", "pmid:39406187"] },
  { id: "covid_vaccines", domain: "biomedical", query: "COVID-19 vaccine phase 3", identifiers: ["pmid:33301246", "pmid:33469205", "pmid:38141632"] },
  { id: "alphafold", domain: "interdisciplinary", query: "AlphaFold protein structure prediction", identifiers: ["doi:10.1038/s41586-021-03819-2", "doi:10.1038/s41586-021-03828-1", "doi:10.1038/s41592-022-01488-1"] },
  { id: "ai_medical_imaging", domain: "interdisciplinary", query: "deep learning medical imaging diagnosis", identifiers: ["doi:10.1038/nature21056", "doi:10.1038/s41591-018-0107-6", "doi:10.1016/s2589-7500(20)30086-8"] },
  { id: "digital_health", domain: "interdisciplinary", query: "wearable sensors digital health", identifiers: ["doi:10.3390/s23239498", "doi:10.1038/nature16521", "doi:10.3390/s17010130"] },
];

export const TIER_1_CASE_IDS = [1, 3, 6, 8, 10, 11, 13, 16, 17, 19, 22, 26, 36, 40, 43];

export function buildMutationCases(count = 120) {
  const bases = [
    ["single-cell", "single cell", "scRNA-seq", "single-cell RNA sequencing"],
    ["machine-learning", "machine learning", "ML", "artificial intelligence"],
    ["T-cell", "T cell", "T lymphocyte", "T-cell lymphocyte"],
    ["graph neural network", "graph-neural-network", "GNN", "graph representation learning"],
  ];
  return Array.from({ length: Math.max(0, count) }, (_, index) => {
    const group = bases[index % bases.length];
    const rotated = group.map((_, offset) => group[(offset + index) % group.length]);
    const quoted = index % 2 === 0;
    return {
      id: `mutation-${index + 1}`,
      family: "mutation",
      label: `deterministic mutation ${index + 1}`,
      domain: index % 3 === 0 ? "biomedical" : "general",
      keywordGroups: { required: [rotated.map((term) => quoted ? `"${term}"` : term), [index % 3 === 0 ? "cancer" : "prediction"]] },
    };
  });
}
