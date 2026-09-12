import fs from 'node:fs/promises';
import { writeAtomicJson, writeAtomicText, withAtomicJsonLock } from './atomic_json.mjs';
import { ruleSuggestionsLogPath, screeningStandardsPath } from './screening_standards_paths.mjs';
import { syncSuggestionsToScreeningStandardsMd } from './screening_standards_rule_suggestions.mjs';

// The unified pending schema remains authoritative. Unsupported mutation types
// are held pending; accepting a label is never evidence that a mutation applied.
export class RuleSuggestionService {
  constructor({ reviewRoot, noFormalRuleApply = false, atomicOptions } = {}) {
    Object.assign(this, { reviewRoot, noFormalRuleApply, atomicOptions });
  }
  async readLog() {
    try {
      const log = JSON.parse(await fs.readFile(ruleSuggestionsLogPath(this.reviewRoot), 'utf8'));
      if (!Array.isArray(log.suggestions)) throw new Error('SUGGESTION_LOG_INVALID');
      return log;
    } catch (error) { if (error.code === 'ENOENT') return { suggestions: [] }; throw error; }
  }
  async list() { return (await this.readLog()).suggestions; }
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
      let before;
      let changed = false;
      const mdPath = screeningStandardsPath(this.reviewRoot);
      if (decision !== 'rejected') {
        if (this.noFormalRuleApply) throw new Error('NO_FORMAL_RULE_APPLY');
        if ((suggestion.target || 'screening_standards.md') !== 'screening_standards.md'
          || !['add_rule', 'add_downgrade_signal'].includes(suggestion.change_type || 'add_rule')
          || suggestion.risk_level === 'high') throw new Error('FORMAL_MUTATION_OWNER_UNVERIFIED');
        if (typeof rule !== 'string' || !rule.trim() || rule.length > 4000 || /[\r\n\u0000]/.test(rule)) throw new Error('SUGGESTION_RULE_INVALID');
        before = await fs.readFile(mdPath, 'utf8');
        const plan = syncSuggestionsToScreeningStandardsMd(before, [{ rule, source: id, type: decision === 'revised' ? 'revise' : 'accept' }]);
        if (plan.content !== before) {
          await writeAtomicText(`${mdPath}.backup`, before);
          await writeAtomicText(mdPath, plan.content, this.atomicOptions);
          changed = true;
        }
      }
      suggestion.status = decision;
      suggestion.processed_at = new Date().toISOString();
      if (decision === 'revised') suggestion.revised_rule = rule;
      suggestion.decision_history = [...(suggestion.decision_history || []), { decision, at: suggestion.processed_at, human_approval: true }];
      try { await writeAtomicJson(logPath, log, this.atomicOptions); }
      catch (error) { if (changed) await writeAtomicText(mdPath, before); throw error; }
      return { id, status: decision, formal_rules_modified: changed };
    });
  }
}
