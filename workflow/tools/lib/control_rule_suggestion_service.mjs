import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomicJson, writeAtomicText, withAtomicJsonLock } from './atomic_json.mjs';
import { ruleSuggestionsLogPath, screeningStandardsPath } from './screening_standards_paths.mjs';
import { normalizeRuleForDedup, syncSuggestionsToScreeningStandardsMd } from './screening_standards_rule_suggestions.mjs';
import { suggestionContentIssue } from './unified_pending_rule_suggestions.mjs';
import { applyKeywordModifications, buildPubMedQueryFromKeywordGroups, loadPubMedKeywordGroupsFromConfig } from './literature_config.mjs';

const targetOf = (item) => item.target || 'screening_standards.md';
const typeOf = (item) => item.change_type || 'add_rule';
const applicable = (item) => (targetOf(item) === 'screening_standards.md' && ['add_rule', 'add_downgrade_signal', 'delete_rule', 'revise_rule'].includes(typeOf(item)))
  || (targetOf(item) === 'pubmed_pmc_search.json' && ['add_keyword', 'remove_keyword'].includes(typeOf(item)));

function exactRuleLine(content, needle) {
  const lines = content.split('\n');
  const indices = lines.flatMap((line, index) => {
    const match = /^\s*[*-]\s+(.+?)\s*\r?$/.exec(line);
    return match && normalizeRuleForDedup(match[1]) === normalizeRuleForDedup(needle) ? [index] : [];
  });
  if (indices.length !== 1) throw new Error('FORMAL_RULE_EXACT_MATCH_REQUIRED');
  return { lines, index: indices[0] };
}

function planMarkdown(content, item, rule, decision) {
  const change = typeOf(item);
  if (['add_rule', 'add_downgrade_signal'].includes(change)) {
    const planned = syncSuggestionsToScreeningStandardsMd(content, [{ rule, source: item.id, type: decision }]).content;
    try { exactRuleLine(planned, rule); } catch { throw new Error('FORMAL_RULE_APPLY_FAILED'); }
    return planned;
  }
  if (change === 'delete_rule') {
    const { lines, index } = exactRuleLine(content, rule);
    lines.splice(index, 1);
    return lines.join('\n');
  }
  const original = /^将“([^”]+)”修改为“([^”]+)”$/.exec(String(item.rule_text || item.suggested_rule || '').trim());
  if (!original) throw new Error('FORMAL_RULE_REVISION_UNCLEAR');
  let replacement = original[2];
  if (decision === 'revised' && rule !== item.rule_text && rule !== item.suggested_rule) {
    const revisedInstruction = /^将“([^”]+)”修改为“([^”]+)”$/.exec(rule);
    if (revisedInstruction && normalizeRuleForDedup(revisedInstruction[1]) !== normalizeRuleForDedup(original[1])) throw new Error('FORMAL_RULE_REVISION_UNCLEAR');
    replacement = revisedInstruction ? revisedInstruction[2] : rule;
  }
  if (suggestionContentIssue(replacement) || /[\r\n\u0000]/.test(replacement)) throw new Error('SUGGESTION_CONTENT_INVALID');
  const { lines, index } = exactRuleLine(content, original[1]);
  const suffix = lines[index].endsWith('\r') ? '\r' : '';
  lines[index] = lines[index].replace(/^(\s*[*-]\s+).*/, (_, prefix) => `${prefix}${replacement}${suffix}`);
  return lines.join('\n');
}

function planKeywordConfig(content, item, rule) {
  const adding = typeOf(item) === 'add_keyword';
  const match = adding ? /^添加(必含|可选|排除)检索词：(.+)$/.exec(rule) : /^移除检索词：(.+)$/.exec(rule);
  if (!match) throw new Error('SEARCH_MUTATION_UNCLEAR');
  const term = (adding ? match[2] : match[1]).trim();
  if (!term || term.length > 200 || /[\r\n\u0000-\u001f()"']/u.test(term)) throw new Error('SEARCH_TERM_INVALID');
  let config;
  try { config = JSON.parse(content); } catch { throw new Error('SEARCH_CONFIG_INVALID'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('SEARCH_CONFIG_INVALID');
  const groups = loadPubMedKeywordGroupsFromConfig(config);
  if (!groups.required.length) throw new Error('SEARCH_CONFIG_UNVERIFIED');
  const currentQuery = buildPubMedQueryFromKeywordGroups(groups);
  if (config.query && config.query.trim() !== currentQuery) throw new Error('SEARCH_QUERY_CUSTOM_UNVERIFIED');
  const occurrences = [...groups.required.flat(), ...groups.optional, ...groups.negative].filter((value) => value.toLowerCase() === term.toLowerCase()).length;
  if (adding && occurrences) throw new Error('SEARCH_TERM_ALREADY_PRESENT');
  if (!adding && occurrences !== 1) throw new Error('SEARCH_TERM_EXACT_MATCH_REQUIRED');
  const group = adding && { 必含: 'required', 可选: 'optional', 排除: 'negative' }[match[1]];
  const changes = adding ? { keywords_added: { [group]: [term] } } : { keywords_removed: [term] };
  const next = applyKeywordModifications(groups, changes);
  if (!next.required.length) throw new Error('SEARCH_REQUIRED_TERMS_EMPTY');
  return JSON.stringify({ ...config, keyword_groups: next, query: buildPubMedQueryFromKeywordGroups(next) }, null, 2) + '\n';
}

// A successful accept means the formal owner was changed and verified.
// Unsupported mutation types remain pending and return an explicit error.
export class RuleSuggestionService {
  constructor({ reviewRoot, root, pubmedConfigPath, noFormalRuleApply = false, atomicOptions } = {}) {
    Object.assign(this, { reviewRoot, root, pubmedConfigPath, noFormalRuleApply, atomicOptions });
  }
  async readLog() {
    try {
      const log = JSON.parse(await fs.readFile(ruleSuggestionsLogPath(this.reviewRoot), 'utf8'));
      if (!Array.isArray(log.suggestions)) throw new Error('SUGGESTION_LOG_INVALID');
      return log;
    } catch (error) { if (error.code === 'ENOENT') return { suggestions: [] }; throw error; }
  }
  async list() { return (await this.readLog()).suggestions.map((item) => ({ ...item, content_issue: suggestionContentIssue(item.rule_text || item.suggested_rule), can_apply: applicable(item) && !this.noFormalRuleApply })); }
  async decideWithReceipt(input) { return this.decide(input); }
  async decide({ id, decision, revisedRule = '', humanApproval = false }) {
    if (!['accepted', 'rejected', 'revised'].includes(decision)) throw new Error('SUGGESTION_DECISION_INVALID');
    if (humanApproval !== true) throw new Error('HUMAN_APPROVAL_REQUIRED');
    const logPath = ruleSuggestionsLogPath(this.reviewRoot);
    return withAtomicJsonLock(logPath, async () => {
      const log = await this.readLog();
      const matches = log.suggestions.filter((entry) => (entry.suggestion_id || entry.id) === id);
      if (matches.length !== 1) throw new Error('SUGGESTION_ID_INVALID');
      const suggestion = matches[0];
      if (suggestion.status === decision && (decision !== 'revised' || suggestion.revised_rule === revisedRule)) return { id, status: decision, duplicate: true };
      if (!['pending', 'candidate'].includes(suggestion.status)) throw new Error('SUGGESTION_NOT_PENDING');
      const rule = decision === 'revised' ? revisedRule : suggestion.rule_text || suggestion.suggested_rule;
      if (decision === 'revised' && (typeof revisedRule !== 'string' || !revisedRule.trim() || revisedRule.length > 4000 || /[\r\n\u0000]/.test(revisedRule))) throw new Error('SUGGESTION_RULE_INVALID');
      if (decision !== 'rejected') {
        if (suggestionContentIssue(rule)) throw new Error('SUGGESTION_CONTENT_INVALID');
        if (this.noFormalRuleApply) throw new Error('NO_FORMAL_RULE_APPLY');
        if (!applicable(suggestion)) throw new Error('FORMAL_MUTATION_OWNER_UNVERIFIED');
        if (typeof rule !== 'string' || !rule.trim() || rule.length > 4000 || /[\r\n\u0000]/.test(rule)) throw new Error('SUGGESTION_RULE_INVALID');
      }
      const formalPath = decision === 'rejected' ? null : targetOf(suggestion) === 'screening_standards.md'
        ? screeningStandardsPath(this.reviewRoot)
        : this.pubmedConfigPath || (this.root ? path.join(this.root, 'config', 'pubmed_pmc_search.json') : null);
      if (decision !== 'rejected' && !formalPath) throw new Error('FORMAL_MUTATION_OWNER_UNVERIFIED');
      const apply = async () => {
        let before;
        let changed = false;
        if (formalPath) {
          before = await fs.readFile(formalPath, 'utf8');
          const plan = targetOf(suggestion) === 'screening_standards.md'
            ? planMarkdown(before, suggestion, rule, decision)
            : planKeywordConfig(before, suggestion, rule);
          if (plan !== before) {
            await writeAtomicText(`${formalPath}.backup`, before);
            await writeAtomicText(formalPath, plan, this.atomicOptions);
            try { if (await fs.readFile(formalPath, 'utf8') !== plan) throw new Error('FORMAL_MUTATION_VERIFY_FAILED'); }
            catch (error) { await writeAtomicText(formalPath, before); throw error; }
            changed = true;
          }
        }
        suggestion.status = decision;
        delete suggestion.decision_receipt;
        delete suggestion.deferred_revised_rule;
        suggestion.processed_at = new Date().toISOString();
        if (decision === 'revised') suggestion.revised_rule = rule;
        suggestion.decision_history = [...(suggestion.decision_history || []), { decision, at: suggestion.processed_at, human_approval: true, applied: decision !== 'rejected' }];
        try { await writeAtomicJson(logPath, log, this.atomicOptions); }
        catch (error) { if (changed) await writeAtomicText(formalPath, before); throw error; }
        return { id, status: decision, formal_rules_modified: changed, application_status: decision === 'rejected' ? 'rejected' : 'applied' };
      };
      return formalPath ? withAtomicJsonLock(formalPath, apply) : apply();
    });
  }
}
