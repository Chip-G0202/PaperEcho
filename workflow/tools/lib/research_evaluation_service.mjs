import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeAtomicJson, withAtomicJsonLock } from './atomic_json.mjs';
import { processResearchEvaluation } from '../stage1/manual_standard_evaluation.mjs';
import { getPreferenceLearningConfig } from './preference_learning_support.mjs';
import { consolidateResearchSuggestions, writeUnifiedPendingRuleSuggestions, suggestionContentIssue } from './unified_pending_rule_suggestions.mjs';
import { readDomainConfig } from './application_config.mjs';
import { ruleSuggestionsLogPath } from './screening_standards_paths.mjs';
import { validateRecoveryRunId } from '../recovery/operation_ledger.mjs';

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const contentHash = text => digest(text.normalize('NFKC').replace(/\s+/g, ' ').trim());
const eventId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const read = async file => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

export function researchBusinessVerified(ledger) {
  const stages = ledger.stages || {};
  return ledger.profile === 'radar'
    ? stages.stage1?.status === 'verified' && ['stage2_writeback', 'stage3_translation', 'stage4_exports'].every(name => stages[name]?.status === 'skipped')
    : ['stage1', 'stage2_writeback', 'stage3_translation'].every(name => stages[name]?.status === 'verified')
      && (stages.stage4_exports?.status === 'verified' || ledger.operations?.some(operation => operation.type === 'export' && operation.target?.id === 'stage4_weekly_export' && operation.status === 'verified' && operation.target.outputHash));
}

// Original events remain in research_evaluations; hidden preparation is a run artifact,
// never a second active suggestion queue. The workflow lease owns execution authority.
export class ResearchEvaluationService {
  constructor({ root, reviewRoot, env = process.env, llmClient = null, clock = () => new Date(), redact = text => text, hook = async () => {} } = {}) {
    Object.assign(this, { root, reviewRoot, env, llmClient, clock, redact, hook });
    this.directory = path.join(reviewRoot, 'research_evaluations');
    this.lock = path.join(this.directory, 'events');
  }
  eventPath(id) {
    if (!eventId(id)) throw new Error('EVALUATION_REQUEST_ID_REQUIRED');
    return path.join(this.directory, `${id}.json`);
  }
  batchPath(runId) { return path.join(this.reviewRoot, 'runs', validateRecoveryRunId(runId), 'research_evaluation_batch.json'); }
  claim(store) {
    if (!store || !['desktop', 'web'].includes(store.ledger?.mode) || !['standard', 'complete', 'radar'].includes(store.ledger?.profile)
      || path.resolve(path.dirname(store.filePath)) !== path.dirname(this.batchPath(store.ledger.runId))) throw new Error('RESEARCH_WORKFLOW_CLAIM_REQUIRED');
    return store.ledger.runId;
  }
  async submit({ text, requestId }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('EVALUATION_TEXT_INVALID');
    const file = this.eventPath(requestId);
    return withAtomicJsonLock(this.lock, async () => {
      let event = await read(file);
      if (event && event.digest !== digest(text)) throw new Error('EVALUATION_REQUEST_CONFLICT');
      const duplicate = Boolean(event);
      if (!event) {
        event = { requestId, digest: digest(text), text: this.redact(text), status: 'pending', receivedAt: this.clock().toISOString() };
        await writeAtomicJson(file, event);
      }
      return { requestId, status: event.status, saved: true, duplicate, suggestions: 0, warnings: [] };
    });
  }
  async snapshotEvents() {
    const names = await fs.readdir(this.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const events = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || !eventId(name.slice(0, -5))) continue;
      const event = await read(path.join(this.directory, name));
      if (!event || event.requestId !== name.slice(0, -5) || typeof event.text !== 'string' || typeof event.digest !== 'string') throw new Error('RESEARCH_EVENT_INVALID');
      if (!['processed', 'consumed'].includes(event.status)) events.push(event);
    }
    return events;
  }
  async prepare({ store }) {
    const runId = this.claim(store); const file = this.batchPath(runId);
    const batch = await withAtomicJsonLock(this.lock, async () => {
      const existing = await read(file);
      if (existing) return existing;
      const events = await this.snapshotEvents();
      const frozen = []; const fresh = []; const origins = new Set(); const texts = new Set(); let length = 0;
      for (const event of events) {
        if (event.batchRunId && ['preparing', 'prepared'].includes(event.status)) {
          origins.add(validateRecoveryRunId(event.batchRunId)); frozen.push(event); continue;
        }
        const hash = contentHash(event.text); const extra = texts.has(hash) ? 0 : event.text.length + (texts.size ? 2 : 0);
        if (length + extra > 20000) continue; // bounded LLM input; untouched events remain pending.
        texts.add(hash); length += extra; fresh.push(event); frozen.push(event);
      }
      if (!frozen.length) return null;
      if (fresh.length) origins.add(runId);
      const snapshot = frozen.map(event => ({ requestId: event.requestId, digest: event.digest, contentHash: contentHash(event.text) }));
      const standards = await fs.readFile(path.join(this.reviewRoot, 'screening_standards.md'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      const contextHash = digest({ standards, search: readDomainConfig(path.join(this.root, 'config', 'pubmed_pmc_search.json'), { root: this.root, env: this.env }).value });
      const next = { schemaVersion: 1, runId, contextHash, inputHash: digest({ version: 1, contextHash, events: snapshot }), events: snapshot, originRunIds: [...origins].sort(), generationEventIds: fresh.map(event => event.requestId), status: fresh.length ? 'frozen' : 'reused', preparedAt: null };
      await writeAtomicJson(file, next);
      for (const event of fresh) await writeAtomicJson(this.eventPath(event.requestId), { ...event, status: 'preparing', batchRunId: runId });
      return next;
    });
    if (!batch) return { status: 'empty', eventCount: 0 };
    const owned = await withAtomicJsonLock(this.lock, async () => {
      const current = await read(file);
      if (current.status !== 'frozen') return false;
      current.status = 'preparing'; await writeAtomicJson(file, current); return true;
    });
    if (owned) {
      const events = [];
      for (const id of batch.generationEventIds) {
        const event = await read(this.eventPath(id));
        const frozen = batch.events.find(entry => entry.requestId === id);
        if (!event || event.batchRunId !== runId || event.digest !== frozen.digest || contentHash(event.text) !== frozen.contentHash) throw new Error('RESEARCH_INPUT_CHANGED');
        events.push(event);
      }
      const unique = [...new Map(events.map(event => [contentHash(event.text), event.text])).values()];
      const runtime = { ...getPreferenceLearningConfig({ env: this.env }), max_retries: 0 };
      let result;
      try { result = await processResearchEvaluation(unique.join('\n\n'), { reviewRoot: this.reviewRoot, pubmedConfigPath: path.join(this.root, 'config', 'pubmed_pmc_search.json'), configEnv: this.env, llmClient: this.llmClient, llmRuntime: runtime, prepareOnly: true }); }
      catch { result = { evaluation_processed: false }; }
      let candidates;
      if (result.evaluation_processed) {
        try {
          candidates = consolidateResearchSuggestions(result.proposed_changes).map(candidate => ({ ...candidate, feedback_event_ids: events.map(event => event.requestId), feedback_content_hashes: [...new Set(events.map(event => contentHash(event.text)))], publication_batch_ids: [batch.inputHash], evidence_text_excerpt: '' }));
          if (candidates.some(candidate => suggestionContentIssue(candidate.rule_text))) throw new Error('RESEARCH_CANDIDATE_INVALID');
        } catch { result = { evaluation_processed: false }; }
      }
      await withAtomicJsonLock(this.lock, async () => {
        const current = await read(file);
        current.status = result.evaluation_processed ? 'prepared' : 'failed';
        if (result.evaluation_processed) {
          current.candidates = candidates;
          current.resultHash = digest(current.candidates); current.preparedAt = this.clock().toISOString();
        } else current.blocker = 'research_generation_failed';
        await writeAtomicJson(file, current);
        for (const event of events) await writeAtomicJson(this.eventPath(event.requestId), { ...event, status: result.evaluation_processed ? 'prepared' : 'pending', batchRunId: runId });
      });
    }
    const current = await read(file);
    return { status: current.status, eventCount: current.events.length, ...(current.status === 'preparing' && !owned ? { reason: 'generation_outcome_unknown' } : {}) };
  }
  async publish({ store }) {
    const runId = this.claim(store);
    if (!researchBusinessVerified(store.ledger)) return { status: 'held', publishedBatches: 0 };
    return withAtomicJsonLock(this.lock, async () => {
      const manifest = await read(this.batchPath(runId));
      if (!manifest) return { status: 'empty', publishedBatches: 0 };
      let publishedBatches = 0; let pendingBatches = 0;
      for (const origin of manifest.originRunIds) {
        const file = this.batchPath(origin); const batch = await read(file);
        if (!batch || !['prepared', 'published'].includes(batch.status)) { pendingBatches++; continue; }
        if (batch.inputHash !== digest({ version: 1, contextHash: batch.contextHash, events: batch.events })) throw new Error('RESEARCH_BATCH_CHANGED');
        if (digest(batch.candidates) !== batch.resultHash) throw new Error('RESEARCH_PREPARED_RESULT_CHANGED');
        for (const id of batch.generationEventIds) {
          const event = await read(this.eventPath(id)); const frozen = batch.events.find(entry => entry.requestId === id);
          if (!event || event.batchRunId !== origin || event.digest !== frozen?.digest || contentHash(event.text) !== frozen.contentHash) throw new Error('RESEARCH_INPUT_CHANGED');
        }
        // Replaying after log commit reuses structural identity and merges evidence only.
        await writeUnifiedPendingRuleSuggestions(ruleSuggestionsLogPath(this.reviewRoot), { suggestions: batch.candidates });
        await this.hook('after_publish', batch);
        batch.status = 'published'; batch.publishedAt ||= this.clock().toISOString(); batch.publishedByRunId ||= runId;
        await writeAtomicJson(file, batch);
        for (const id of batch.generationEventIds) {
          const event = await read(this.eventPath(id));
          if (event?.batchRunId !== origin) throw new Error('RESEARCH_EVENT_CLAIM_CHANGED');
          await this.hook('before_consume', event);
          await writeAtomicJson(this.eventPath(id), { ...event, status: 'consumed', consumedAt: batch.publishedAt });
        }
        publishedBatches++;
      }
      return { status: pendingBatches ? 'pending' : 'published', publishedBatches, pendingBatches };
    });
  }
  async safely(method, store) {
    try { return await this[method]({ store }); }
    catch { return { status: 'pending', reason: `research_${method}_failed` }; }
  }
}
