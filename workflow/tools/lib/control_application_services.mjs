import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FeedbackService } from './control_feedback_service.mjs';
import { ConfigService } from './control_config_service.mjs';
import { RuleSuggestionService } from './control_rule_suggestion_service.mjs';
import { SecretService } from './control_credentials_service.mjs';
import { processResearchEvaluation } from '../stage1/manual_standard_evaluation.mjs';
import { getPreferenceLearningConfig } from './preference_learning_support.mjs';
import { writeAtomicJson, withAtomicJsonLock } from './atomic_json.mjs';
import { ReviewQueryService } from './control_review_query_service.mjs';

export function createControlServices({ root, reviewRoot = path.join(root, 'review_results', '文献评价'), env = process.env, llmClient = null } = {}) {
  const secrets = new SecretService({ env });
  const rules = new RuleSuggestionService({ reviewRoot });
  const config = new ConfigService({ root, env });
  const feedback = new FeedbackService({
    reviewRoot,
    ruleDecision: (input) => rules.decide(input),
    researchEvaluation: async ({ text, requestId }) => {
      if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('EVALUATION_TEXT_INVALID');
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId || '')) throw new Error('EVALUATION_REQUEST_ID_REQUIRED');
      const receiptPath = path.join(reviewRoot, 'research_evaluations', `${requestId}.json`);
      const digest = createHash('sha256').update(text).digest('hex');
      const publicReceipt = (receipt) => ({ requestId, status: receipt.status, suggestions: receipt.suggestions || 0, warnings: receipt.warnings || [] });
      return withAtomicJsonLock(receiptPath, async () => {
        let receipt;
        try { receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (receipt && receipt.digest !== digest) throw new Error('EVALUATION_REQUEST_CONFLICT');
        if (receipt?.status === 'processed') return publicReceipt(receipt);
        receipt = { requestId, digest, text: secrets.redact(text), status: 'accepted', receivedAt: new Date().toISOString() };
        await writeAtomicJson(receiptPath, receipt);
        const llmRuntime = getPreferenceLearningConfig({ env: { ...env, PREFERENCE_LEARNING_CONFIG_PATH: path.join(root, 'config', 'preference_learning.config.json') } });
        try {
          const result = await processResearchEvaluation(receipt.text, { reviewRoot, pubmedConfigPath: path.join(root, 'config', 'pubmed_pmc_search.json'), llmClient, llmRuntime });
          receipt.status = result.evaluation_processed ? 'processed' : 'blocked';
          receipt.suggestions = result.suggestions_appended || 0;
          // Only known short blocker codes cross the application boundary.
          receipt.warnings = (result.blockers || []).filter((code) => /^[a-z_]{1,100}$/.test(code));
        } catch { receipt.status = 'blocked'; receipt.warnings = ['evaluation_processing_failed']; }
        await writeAtomicJson(receiptPath, receipt);
        return publicReceipt(receipt);
      }, { staleMs: 600000, timeoutMs: 1000 });
    },
  });
  const review = new ReviewQueryService({ root, reviewRoot, feedback, rules });
  return { feedback, config, rules, secrets, review };
}
