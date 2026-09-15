import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getLiteratureIdentityKeys } from './literature_identity.mjs';
import { writeAtomicJson, withAtomicJsonLock } from './atomic_json.mjs';

export const PAPER_FEEDBACK = Object.freeze({
  highly_relevant: 'upgrade', relevant: 'keep', maybe: 'downgrade',
  irrelevant: 'drop', do_not_recommend_similar: 'drop',
});
export const FEEDBACK_REASONS = new Set(['topic_mismatch', 'exposure_mismatch', 'population_mismatch', 'model_mismatch', 'method_mismatch', 'publication_type_mismatch', 'too_broad', 'too_peripheral', 'other']);
const GRADE_ORDER = ['A', 'B', 'C', 'D'];
export function manualGradeFeedback(originalGrade, manualGrade) {
  const original = String(originalGrade || '').trim().toUpperCase();
  const manual = String(manualGrade || '').trim().toUpperCase();
  if (!GRADE_ORDER.includes(original) || !GRADE_ORDER.includes(manual)) throw new Error('MANUAL_GRADE_INVALID');
  if (manual === 'D') return 'drop';
  if (manual === original) return 'keep';
  return GRADE_ORDER.indexOf(manual) < GRADE_ORDER.indexOf(original) ? 'upgrade' : 'downgrade';
}
const feedbackValue = (feedback) => ({ upgrade: 'highly_relevant', keep: 'relevant', downgrade: 'maybe', drop: 'irrelevant' }[feedback]);
export const canonicalFeedbackPath = (reviewRoot) => path.join(reviewRoot, 'paper_feedback.json');
export function feedbackIdentity(item) {
  const keys = getLiteratureIdentityKeys(item).filter((key) => !key.startsWith('title:'));
  const valid = keys.filter((key) => /^(doi:10\.\d{4,9}\/\S+|pmid:\d+|pmcid:pmc\d+|arxiv:\d{4}\.\d{4,5}(v\d+)?|openalex:w\d+|url:https?:\/\/[^\s]+)$/i.test(key));
  if (!valid.length) throw new Error('FEEDBACK_IDENTITY_REQUIRED');
  return valid;
}
export async function readCanonicalFeedback(reviewRoot) {
  try {
    const state = JSON.parse(await fs.readFile(canonicalFeedbackPath(reviewRoot), 'utf8'));
    if (state.schemaVersion !== 1 || !Array.isArray(state.history)) throw new Error('FEEDBACK_STATE_INVALID');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, history: [] };
    throw error;
  }
}
export function currentPaperFeedback(state) {
  const current = new Map();
  for (const entry of state.history) current.set(entry.identity, entry);
  return [...current.values()];
}
export function canonicalFeedbackActionRows(state, reviewRoot) {
  return currentPaperFeedback(state).map((entry) => {
    const value = (kind) => entry.keys.find((key) => key.startsWith(`${kind}:`))?.slice(kind.length + 1) || '';
    return {
      feedback_source: canonicalFeedbackPath(reviewRoot), row_number: entry.revision,
      date: entry.created_at.slice(0, 10), feedback: entry.feedback,
      doi: value('doi'), pmid: value('pmid'), pmcid: value('pmcid'),
      // Deliberately omit title match keys. An unresolved canonical identifier
      // must stay unresolved rather than becoming a legacy title search.
      title: '', english_title: '', translated_title: '',
      title_key: '', english_title_key: '', translated_title_key: '',
      comment: entry.comment, canonical_identity: entry.identity,
    };
  });
}
export class FeedbackService {
  constructor({ reviewRoot, researchEvaluation, ruleDecision, atomicOptions } = {}) {
    Object.assign(this, { reviewRoot, researchEvaluation, ruleDecision, atomicOptions });
  }
  async submit(input) {
    if (input.kind === 'research_evaluation') {
      if (!this.researchEvaluation) throw new Error('RESEARCH_EVALUATION_UNAVAILABLE');
      return this.researchEvaluation(input);
    }
    if (input.kind === 'rule_decision') {
      if (!this.ruleDecision) throw new Error('RULE_DECISION_UNAVAILABLE');
      return this.ruleDecision(input);
    }
    return (await this.submitPaperBatch([input]))[0];
  }
  async submitPaperBatch(inputs) {
    if (!Array.isArray(inputs) || inputs.length > 10000) throw new Error('FEEDBACK_BATCH_INVALID');
    return withAtomicJsonLock(canonicalFeedbackPath(this.reviewRoot), async () => {
      const state = await readCanonicalFeedback(this.reviewRoot);
      const receipts = [];
      for (const input of inputs) {
    if (!['paper_feedback', 'manual_grade'].includes(input.kind)) throw new Error('FEEDBACK_KIND_INVALID');
    const keys = feedbackIdentity(input.paper);
    const originalFinalGrade = String(input.paper?.final_grade || input.paper?.finalGrade || input.paper?.grade || '').trim().charAt(0).toUpperCase();
    const manualGrade = input.kind === 'manual_grade' ? String(input.manualGrade || '').trim().toUpperCase() : '';
    const derivedFeedback = input.kind === 'manual_grade' ? manualGradeFeedback(originalFinalGrade, manualGrade) : PAPER_FEEDBACK[input.value];
    const value = input.kind === 'manual_grade' ? feedbackValue(derivedFeedback) : input.value;
    if (!Object.hasOwn(PAPER_FEEDBACK, value)) throw new Error('FEEDBACK_VALUE_INVALID');
    if (input.reason && !FEEDBACK_REASONS.has(input.reason)) throw new Error('FEEDBACK_REASON_INVALID');
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(input.requestId)) throw new Error('FEEDBACK_REQUEST_ID_REQUIRED');
    const payload = { keys, value, reason: input.reason || '', comment: String(input.comment || '').slice(0, 4000) };
    if (manualGrade) Object.assign(payload, { manual_grade: manualGrade, original_final_grade: originalFinalGrade });
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const duplicate = state.history.find((entry) => entry.requestId === input.requestId);
      if (duplicate) {
        if (duplicate.digest !== digest) throw new Error('FEEDBACK_REQUEST_CONFLICT');
        receipts.push({ revision: duplicate.revision, duplicate: true });
        continue;
      }
      const matches = new Set(state.history.filter((entry) => entry.keys.some((key) => keys.includes(key))).map((entry) => entry.identity));
      if (matches.size > 1) throw new Error('FEEDBACK_IDENTITY_AMBIGUOUS');
      const entry = {
        ...payload, identity: [...matches][0] || keys[0], requestId: input.requestId, digest,
        revision: state.history.length + 1, created_at: new Date().toISOString(),
        kind: input.kind, feedback: derivedFeedback, title: String(input.paper.title || ''),
        doi: String(input.paper.doi || input.paper.DOI || ''), pmid: String(input.paper.pmid || ''), pmcid: String(input.paper.pmcid || ''),
        source: input.source === 'legacy_xlsx' ? 'legacy_xlsx' : 'control_center',
        source_row: input.sourceRow || null,
      };
      state.history.push(entry);
      receipts.push({ revision: entry.revision, duplicate: false });
      }
      if (receipts.some((receipt) => !receipt.duplicate)) await writeAtomicJson(canonicalFeedbackPath(this.reviewRoot), state, this.atomicOptions);
      return receipts;
    });
  }
  async current() { return currentPaperFeedback(await readCanonicalFeedback(this.reviewRoot)); }
}
