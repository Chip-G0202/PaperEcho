import fs from 'node:fs/promises';
import { writeAtomicJson, writeAtomicText, withAtomicJsonLock } from './atomic_json.mjs';
import { ruleSuggestionsLogPath, screeningStandardsPath } from './screening_standards_paths.mjs';
import { syncSuggestionsToScreeningStandardsMd } from './screening_standards_rule_suggestions.mjs';
import { suggestionContentIssue } from './unified_pending_rule_suggestions.mjs';

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
  async list() { return (await this.readLog()).suggestions.map((item) => ({ ...item, content_issue: suggestionContentIssue(item.rule_text || item.suggested_rule) })); }
  async decideWithReceipt(input) {
    try { return await this.decide(input); }
    catch (error) {
      if (!['NO_FORMAL_RULE_APPLY', 'FORMAL_MUTATION_OWNER_UNVERIFIED'].includes(error.message)) throw error;
      const item = (await this.list()).find((entry) => (entry.suggestion_id || entry.id) === input.id);
      const receipt = { id: input.id, status: item.status, requested_decision: input.decision,
        application_status: 'requires_manual_action', formal_rules_modified: false,
        target: item.target || 'screening_standards.md', risk: item.risk_level || 'unknown', reason: error.message,
        explanation: error.message === 'NO_FORMAL_RULE_APPLY' ? '当前策略禁止正式规则写入，建议未应用。' : '该目标、变更类型或风险级别没有已验证的自动应用入口，建议未应用。',
        next_action: '确需应用时，使用现有规则或检索配置维护流程，人工核对范围、验证并备份。' };
      await withAtomicJsonLock(ruleSuggestionsLogPath(this.reviewRoot), async () => {
        const log = await this.readLog();
        const current = log.suggestions.find((entry) => (entry.suggestion_id || entry.id) === input.id);
        if (!current || !['pending', 'candidate'].includes(current.status)) throw new Error('SUGGESTION_NOT_PENDING');
        if (current.decision_receipt?.requested_decision === input.decision && (current.deferred_revised_rule || '') === (input.revisedRule || '')) return;
        current.decision_receipt = receipt;
        current.deferred_revised_rule = input.revisedRule || '';
        current.decision_history = [...(current.decision_history || []), { decision: input.decision, at: new Date().toISOString(), human_approval: true, applied: false }];
        await writeAtomicJson(ruleSuggestionsLogPath(this.reviewRoot), log, this.atomicOptions);
      });
      return receipt;
    }
  }
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
      let before;
      let changed = false;
      const mdPath = screeningStandardsPath(this.reviewRoot);
      if (decision !== 'rejected') {
        if (suggestionContentIssue(rule)) throw new Error('SUGGESTION_CONTENT_INVALID');
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
      delete suggestion.decision_receipt;
      delete suggestion.deferred_revised_rule;
      suggestion.processed_at = new Date().toISOString();
      if (decision === 'revised') suggestion.revised_rule = rule;
      suggestion.decision_history = [...(suggestion.decision_history || []), { decision, at: suggestion.processed_at, human_approval: true }];
      try { await writeAtomicJson(logPath, log, this.atomicOptions); }
      catch (error) { if (changed) await writeAtomicText(mdPath, before); throw error; }
      return { id, status: decision, formal_rules_modified: changed };
    });
  }
}
