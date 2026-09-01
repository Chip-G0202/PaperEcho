const SEARCH_INTENT_SCHEMA_VERSION = 1;

function uniqueStrings(values = []) {
  return [...new Set(values.map((value) => String(value || "").normalize("NFKC").trim()).filter(Boolean))];
}

function stripOuterParentheses(value) {
  let text = String(value || "").trim();
  while (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0;
    let quoted = false;
    let wrapsWhole = true;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '"' && text[index - 1] !== "\\") quoted = !quoted;
      if (quoted) continue;
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (depth === 0 && index < text.length - 1) {
        wrapsWhole = false;
        break;
      }
    }
    if (!wrapsWhole || depth !== 0 || quoted) break;
    text = text.slice(1, -1).trim();
  }
  return text;
}

export function tokenizeSearchQuery(query = "") {
  const text = String(query || "").normalize("NFKC").trim();
  const tokens = [];
  let buffer = "";
  const flush = () => {
    const value = buffer.trim();
    buffer = "";
    if (!value) return;
    const upper = value.toUpperCase();
    tokens.push(["AND", "OR", "NOT"].includes(upper) ? { type: upper } : { type: "TERM", value, exact: false });
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      flush();
      let phrase = "";
      let closed = false;
      for (index += 1; index < text.length; index += 1) {
        const current = text[index];
        if (current === '"' && text[index - 1] !== "\\") {
          closed = true;
          break;
        }
        phrase += current;
      }
      tokens.push({ type: "TERM", value: phrase.replace(/\\"/g, '"').trim(), exact: true, malformedQuote: !closed });
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (char === "(" && !buffer) {
      tokens.push({ type: "LPAREN" });
      continue;
    }
    if (char === ")" && !buffer) {
      tokens.push({ type: "RPAREN" });
      continue;
    }
    if (char === "(" && buffer) {
      let nested = char;
      let depth = 1;
      while (index + 1 < text.length && depth > 0) {
        index += 1;
        const current = text[index];
        nested += current;
        if (current === "(") depth += 1;
        if (current === ")") depth -= 1;
      }
      buffer += nested;
      continue;
    }
    if (char === ")") {
      flush();
      tokens.push({ type: "RPAREN" });
      continue;
    }
    buffer += char;
  }
  flush();
  return tokens.filter((token) => token.type !== "TERM" || token.value);
}

function withImplicitAnd(tokens) {
  const out = [];
  for (const token of tokens) {
    const previous = out.at(-1);
    const previousEndsExpression = previous && ["TERM", "RPAREN"].includes(previous.type);
    const nextStartsExpression = ["TERM", "LPAREN", "NOT"].includes(token.type);
    if (previousEndsExpression && nextStartsExpression) out.push({ type: "AND", implicit: true });
    out.push(token);
  }
  return out;
}

export function parseSearchExpression(query = "") {
  const tokens = withImplicitAnd(tokenizeSearchQuery(query));
  let cursor = 0;
  const errors = [];
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];

  const primary = () => {
    const token = take();
    if (!token) {
      errors.push("missing_operand");
      return null;
    }
    if (token.type === "TERM") {
      if (token.malformedQuote) errors.push("unclosed_quote");
      return { type: "term", value: token.value, exact: token.exact === true };
    }
    if (token.type === "LPAREN") {
      const expression = orExpression();
      if (peek()?.type === "RPAREN") take();
      else errors.push("unclosed_parenthesis");
      return expression;
    }
    errors.push(`unexpected_${token.type.toLowerCase()}`);
    return null;
  };
  const unary = () => peek()?.type === "NOT" ? (take(), { type: "not", child: unary() }) : primary();
  const andExpression = () => {
    let left = unary();
    while (peek()?.type === "AND") {
      take();
      const right = unary();
      left = left && right ? { type: "and", children: [left, right] } : left || right;
    }
    return left;
  };
  const orExpression = () => {
    let left = andExpression();
    while (peek()?.type === "OR") {
      take();
      const right = andExpression();
      left = left && right ? { type: "or", children: [left, right] } : left || right;
    }
    return left;
  };
  const expression = tokens.length ? orExpression() : null;
  if (cursor < tokens.length) errors.push(...tokens.slice(cursor).map((token) => `unexpected_${token.type.toLowerCase()}`));
  return { expression, errors: uniqueStrings(errors), tokens };
}

function termNode(value, exact = false) {
  return { type: "term", value: String(value || "").trim(), exact };
}

function orNode(values = []) {
  const children = values.filter(Boolean);
  if (!children.length) return null;
  return children.length === 1 ? children[0] : { type: "or", children };
}

function andNode(values = []) {
  const children = values.filter(Boolean);
  if (!children.length) return null;
  return children.length === 1 ? children[0] : { type: "and", children };
}

function keywordGroupsExpression(keywordGroups = {}) {
  const required = Array.isArray(keywordGroups.required) ? keywordGroups.required : [];
  const normalizedRequired = required.every((entry) => typeof entry === "string")
    ? (required.length ? [required] : [])
    : required.map((entry) => Array.isArray(entry) ? entry : [entry]);
  const positives = normalizedRequired.map((group) => orNode(uniqueStrings(group).map((value) => termNode(stripOuterParentheses(value), /^".*"$/.test(value)))));
  const negative = uniqueStrings(keywordGroups.negative || []).map((value) => ({ type: "not", child: termNode(stripOuterParentheses(value), /^".*"$/.test(value)) }));
  return andNode([...positives, ...negative]);
}

function flatten(node, type) {
  if (!node) return [];
  if (node.type !== type) return [node];
  return (node.children || []).flatMap((child) => flatten(child, type));
}

function positiveGroups(expression) {
  if (!expression) return [];
  const required = flatten(expression, "and").filter((node) => node.type !== "not");
  return required.map((node) => flatten(node, "or").filter((entry) => entry.type === "term").map((entry) => ({ value: entry.value, exact: entry.exact === true }))).filter((group) => group.length);
}

function negativeTerms(expression) {
  if (!expression) return [];
  const out = [];
  const visit = (node) => {
    if (!node) return;
    if (node.type === "not" && node.child?.type === "term") out.push({ value: node.child.value, exact: node.child.exact === true });
    for (const child of node.children || []) visit(child);
    if (node.type !== "not") visit(node.child);
  };
  visit(expression);
  return out;
}

export function buildSearchIntent({ query = "", keywordGroups = null, dateRange = {}, publicationTypes = [], domainHints = [], sourceHints = [] } = {}) {
  const structured = keywordGroups && typeof keywordGroups === "object";
  const parsed = structured ? { expression: keywordGroupsExpression(keywordGroups), errors: [] } : parseSearchExpression(query);
  const optionalTerms = uniqueStrings(keywordGroups?.optional || []).map((value) => ({ value, exact: /^".*"$/.test(value) }));
  const requiredGroups = positiveGroups(parsed.expression);
  const excludes = negativeTerms(parsed.expression);
  const positiveValues = new Set(requiredGroups.flat().map((term) => term.value.normalize("NFKC").toLowerCase()));
  const contradictoryExclusion = excludes.some((term) => positiveValues.has(term.value.normalize("NFKC").toLowerCase()));
  const exactPhrases = uniqueStrings([...requiredGroups.flat(), ...optionalTerms, ...excludes].filter((term) => term.exact).map((term) => term.value.replace(/^"|"$/g, "")));
  return {
    schemaVersion: SEARCH_INTENT_SCHEMA_VERSION,
    source: structured ? "keyword_groups" : "query",
    originalQuery: String(query || "").trim(),
    expression: parsed.expression,
    conceptGroups: requiredGroups.map((terms, index) => ({ id: `group_${index + 1}`, required: true, terms })),
    optionalTerms,
    excludeTerms: excludes,
    exactPhrases,
    dateRange: { from: String(dateRange?.from || ""), to: String(dateRange?.to || "") },
    publicationTypes: uniqueStrings(publicationTypes),
    domainHints: uniqueStrings(domainHints),
    sourceHints: uniqueStrings(sourceHints),
    parseErrors: parsed.errors,
    intentWarnings: contradictoryExclusion ? ["contradictory_exclusion"] : [],
  };
}

function wildcardInfo(value) {
  const stars = [...String(value || "")].filter((char) => char === "*").length;
  return { hasWildcard: stars > 0, malformed: stars > 1 || (stars === 1 && !String(value).endsWith("*")) };
}

function escapePhrase(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderTerm(term, source, diagnostics) {
  let value = String(term?.value || "").trim();
  const wildcard = wildcardInfo(value);
  if (wildcard.malformed) diagnostics.errors.push("malformed_wildcard");
  if (!value) return "";
  if (source === "semantic_scholar" && /[\p{L}\p{N}]-[\p{L}\p{N}]/u.test(value)) {
    const spaced = value.replace(/-/g, " ");
    diagnostics.hyphenExpansions += 1;
    return `(${term.exact ? `"${escapePhrase(value)}"` : value} | "${escapePhrase(spaced)}")`;
  }
  return term.exact ? `"${escapePhrase(value.replace(/^"|"$/g, ""))}"` : value;
}

function renderExpression(node, source, diagnostics, parent = "") {
  if (!node) return "";
  if (node.type === "term") return renderTerm(node, source, diagnostics);
  if (node.type === "not") {
    const child = renderExpression(node.child, source, diagnostics, "not");
    if (!child) return "";
    return source === "semantic_scholar" ? `-${child}` : `NOT ${child}`;
  }
  const operator = node.type === "and" ? (source === "semantic_scholar" ? " + " : " AND ") : (source === "semantic_scholar" ? " | " : " OR ");
  const children = (node.children || []).map((child) => renderExpression(child, source, diagnostics, node.type)).filter(Boolean);
  const joined = children.join(operator);
  return children.length > 1 && parent && parent !== node.type ? `(${joined})` : joined;
}

function compilerDiagnostics(intent) {
  return { errors: [...(intent.parseErrors || [])], degradedReasons: [...(intent.intentWarnings || [])], hyphenExpansions: 0 };
}

export function compileSearchIntent(intent, source) {
  const supported = new Set(["openalex", "semantic_scholar", "pubmed", "europe_pmc"]);
  if (!supported.has(source)) throw new Error(`UNSUPPORTED_SEARCH_COMPILER:${source}`);
  const diagnostics = compilerDiagnostics(intent);
  const query = renderExpression(intent.expression, source, diagnostics);
  return {
    source,
    query,
    errors: uniqueStrings(diagnostics.errors),
    queryDegraded: diagnostics.degradedReasons.length > 0 || diagnostics.errors.length > 0,
    degradedReasons: uniqueStrings(diagnostics.degradedReasons),
    hyphenExpansions: diagnostics.hyphenExpansions,
  };
}

function renderGroup(group, source, diagnostics) {
  return renderExpression(orNode(group.map((term) => termNode(term.value, term.exact))), source, diagnostics);
}

function buildChunkedQueryPlan(intent, source, { maxEncodedUrlLength, maxQueryCharacters, baseUrlLength, requestBudget, degradedPrefix }) {
  const primary = compileSearchIntent(intent, source);
  const encodedLength = baseUrlLength + encodeURIComponent(primary.query).length;
  const fits = (query) => query.length <= maxQueryCharacters && baseUrlLength + encodeURIComponent(query).length <= maxEncodedUrlLength;
  if (fits(primary.query)) return { variants: [{ kind: "primary", query: primary.query }], encodedLength, queryCharacters: primary.query.length, queryDegraded: primary.queryDegraded, degradedReasons: primary.degradedReasons, errors: primary.errors };
  const groups = (intent.conceptGroups || []).map((group) => group.terms || []).filter((group) => group.length);
  if (!groups.length) return { variants: [], encodedLength, queryCharacters: primary.query.length, queryDegraded: true, degradedReasons: [`${degradedPrefix}_query_too_long_unstructured`], errors: primary.errors };
  const largestIndex = groups.reduce((best, group, index) => group.length > groups[best].length ? index : best, 0);
  const fixedDiagnostics = compilerDiagnostics(intent);
  const queryFor = (terms) => {
    const renderedGroups = groups.map((group, index) => renderGroup(index === largestIndex ? terms : group, source, fixedDiagnostics));
    const negatives = (intent.excludeTerms || []).map((term) => {
      const rendered = renderTerm(term, source, fixedDiagnostics);
      return source === "semantic_scholar" ? `-${rendered}` : `NOT ${rendered}`;
    }).filter(Boolean);
    const operator = source === "semantic_scholar" ? " + " : " AND ";
    return [...renderedGroups.filter(Boolean).map((value) => `(${value})`), ...negatives].join(operator);
  };
  const chunks = [];
  let chunk = [];
  for (const term of groups[largestIndex]) {
    const candidate = [...chunk, term];
    if (chunk.length && !fits(queryFor(candidate))) {
      chunks.push(chunk);
      chunk = [term];
    } else chunk = candidate;
  }
  if (chunk.length) chunks.push(chunk);
  const allVariants = chunks.map((terms) => ({ kind: "chunk", query: queryFor(terms) })).filter((variant) => fits(variant.query));
  const variants = allVariants.slice(0, Math.max(1, requestBudget));
  const unrepresentableChunk = allVariants.length !== chunks.length;
  return {
    variants,
    encodedLength,
    queryCharacters: primary.query.length,
    queryDegraded: primary.queryDegraded || chunks.length > requestBudget || unrepresentableChunk,
    degradedReasons: uniqueStrings([`${degradedPrefix}_query_chunked`, ...(chunks.length > requestBudget ? [`${degradedPrefix}_request_budget_truncated`] : []), ...(unrepresentableChunk ? [`${degradedPrefix}_chunk_unrepresentable`] : []), ...primary.degradedReasons]),
    errors: uniqueStrings([...(primary.errors || []), ...(unrepresentableChunk ? [`${degradedPrefix}_chunk_unrepresentable`] : [])]),
  };
}

export function buildOpenAlexQueryPlan(intent, { maxEncodedUrlLength = 3800, maxQueryCharacters = 1400, baseUrlLength = 500, requestBudget = 8 } = {}) {
  const plan = buildChunkedQueryPlan(intent, "openalex", { maxEncodedUrlLength, maxQueryCharacters, baseUrlLength, requestBudget, degradedPrefix: "openalex" });
  return { ...plan, searchParameter: openAlexSearchParameterForQuery(plan.variants.map((variant) => variant.query).join(" ")) };
}

export function buildSemanticScholarQueryPlan(intent, { maxEncodedUrlLength = 3800, maxQueryCharacters = 3500, baseUrlLength = 350, requestBudget = 4 } = {}) {
  return buildChunkedQueryPlan(intent, "semantic_scholar", { maxEncodedUrlLength, maxQueryCharacters, baseUrlLength, requestBudget, degradedPrefix: "semantic_scholar" });
}

export function openAlexSearchParameterForQuery(query = "") {
  return /[*?]/.test(String(query)) ? "search.exact" : "search";
}

export function buildQueryHealthProbes(intent, { requestBudget = 6 } = {}) {
  const groups = intent.conceptGroups || [];
  const probes = [];
  for (const group of groups) {
    const expression = orNode((group.terms || []).map((term) => termNode(term.value, term.exact)));
    const query = compileSearchIntent({ ...intent, expression, parseErrors: [] }, "openalex").query;
    if (query) probes.push({ kind: "required_group", groupIds: [group.id], query });
  }
  if ((intent.exactPhrases || []).length) {
    const relax = (node) => !node ? node : node.type === "term"
      ? { ...node, exact: false }
      : node.type === "not"
        ? { ...node, child: relax(node.child) }
        : { ...node, children: (node.children || []).map(relax) };
    const query = compileSearchIntent({ ...intent, expression: relax(intent.expression), parseErrors: [] }, "openalex").query;
    if (query) probes.push({ kind: "relaxed_exact", groupIds: [], query });
  }
  for (let left = 0; left < groups.length; left += 1) {
    for (let right = left + 1; right < groups.length; right += 1) {
      const expression = andNode([groups[left], groups[right]].map((group) => orNode((group.terms || []).map((term) => termNode(term.value, term.exact)))));
      const query = compileSearchIntent({ ...intent, expression, parseErrors: [] }, "openalex").query;
      if (query) probes.push({ kind: "required_pair", groupIds: [groups[left].id, groups[right].id], query });
    }
  }
  return probes.slice(0, Math.max(0, requestBudget));
}

const ANCHOR_STOP_WORDS = new Set(["and", "or", "not", "the", "a", "an", "of", "in", "for", "to", "with"]);

function anchorScore(term) {
  const words = String(term.value || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word && !ANCHOR_STOP_WORDS.has(word));
  return words.length * 100 + words.join("").length;
}

export function compileCrossrefRescueQueries(intent, { requestBudget = 3 } = {}) {
  const groups = (intent.conceptGroups || []).map((group) => [...(group.terms || [])].sort((a, b) => anchorScore(b) - anchorScore(a))).filter((group) => group.length);
  if (!groups.length) return [];
  const primary = groups[0][0]?.value || "";
  const variants = [];
  for (let index = 1; index < groups.length; index += 1) {
    const anchor = groups[index][0]?.value || "";
    if (primary && anchor) variants.push(`${primary} ${anchor}`);
  }
  if (!variants.length && primary) variants.push(primary);
  return uniqueStrings(variants).slice(0, Math.max(0, requestBudget));
}

export function buildSemanticRescueText(intent, { maxChars = 2000 } = {}) {
  const groups = (intent.conceptGroups || []).map((group) => (group.terms || []).map((term) => term.value).join(" or ")).filter(Boolean);
  const excludes = (intent.excludeTerms || []).map((term) => term.value).filter(Boolean);
  const text = [groups.length ? `Research about ${groups.join("; combined with ")}.` : intent.originalQuery, excludes.length ? `Exclude ${excludes.join(", ")}.` : ""].filter(Boolean).join(" ");
  return text.slice(0, Math.max(1, maxChars)).trim();
}

export const SEARCH_INTENT_VERSION = SEARCH_INTENT_SCHEMA_VERSION;
