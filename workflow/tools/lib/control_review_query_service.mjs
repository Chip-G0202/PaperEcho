import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildStage4StandaloneExportSource, buildProspectiveStage4ExportSource, buildFinalExportPayload, buildFinalReviewMembership } from '../stage4/finalize_exports_support.mjs';
import { buildRunSummary } from './run_summary.mjs';
import { feedbackIdentity } from './control_feedback_service.mjs';
import { loadSourceSelectionConfig } from './literature_config.mjs';
import { buildRuntimeConfig } from './runtime_config.mjs';
import { buildLocalStage4ExportSource } from '../stage4/export_source_step.mjs';
import { getWeeklyReviewEvidence } from '../stage4/spreadsheet_adapter.mjs';
import { readPendingPaperReview, matchPendingPaperRecord, manualDecisionForRecord } from './pending_paper_review.mjs';
import { isManualReviewEligible } from '../stage1/semantic_grade_synthesis.mjs';
import { isActiveRuleSuggestion } from './unified_pending_rule_suggestions.mjs';

const inside = (root, candidate) => { const rel = path.relative(root, candidate); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
const paperId = (runId, item, index, keys = []) => createHash('sha256').update(item._reviewScopeRunId ? `${runId}:scope:${item._reviewScopeRunId}:${keys[0] || ''}` : `${runId}:${index}:${keys[0] || ''}`).digest('hex');
const identityKeys = (item) => { try { return feedbackIdentity(item); } catch { return []; } };

// Current artifact evidence owns actionability; durable pending status alone
// never makes a historical record a current task. Canonical decisions win.
export function isActiveManualReview(item, current = []) {
  if (!isManualReviewEligible(item) || !identityKeys(item).length || item.pre_llm_zotero_existing_duplicate === true) return false;
  return !manualDecisionForRecord({ id: item.pending_review_id || '', keys: identityKeys(item) }, current);
}
export class ReviewQueryService {
  constructor({ root, context = buildRuntimeConfig({ cwd: root, env: {}, argv: [] }), reviewRoot = context.reviewRoot, feedback, rules }) {
    Object.assign(this, { root: path.resolve(root), reviewRoot, feedback, rules });
    this.researchRoot = path.resolve(context.researchRoot);
    this.localRepository = context.localRepository;
    this.runRoot = context.runRoot || path.join(reviewRoot, 'runs');
    this.allowedRoots = [reviewRoot, this.researchRoot, this.localRepository?.root].filter(Boolean).map((entry) => path.resolve(entry));
  }
  async read(file) {
    const allowed = this.allowedRoots.filter((root) => inside(root, path.resolve(file)));
    if (!allowed.length) throw new Error('ARTIFACT_PATH_BLOCKED');
    try {
      const real = await fs.realpath(file);
      const roots = await Promise.all(allowed.map((root) => fs.realpath(root).catch(() => null)));
      if (!roots.some((root) => root && inside(root, real))) throw new Error('ARTIFACT_PATH_BLOCKED');
      return JSON.parse(await fs.readFile(real, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async runs() {
    const runRoot = this.runRoot;
    let dirs;
    try { dirs = await fs.readdir(runRoot, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const runs = [];
    for (const dir of dirs.filter((entry) => entry.isDirectory())) {
      const manifest = await this.read(path.join(runRoot, dir.name, 'run_group.json'));
      if (manifest?.schemaVersion === 1 && manifest.runId === dir.name && Number.isFinite(Date.parse(manifest.startedAt))) runs.push(manifest);
    }
    return runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }
  pipeline(run) {
    const base = this.localRepository?.root || this.researchRoot;
    const artifact = run.artifacts?.find((entry) => entry.kind === 'pipeline' && entry.rootKey === (this.localRepository ? 'local' : 'research'));
    if (!artifact || typeof artifact.path !== 'string') return null;
    const file = path.resolve(base, artifact.path);
    return inside(base, file) ? file : null;
  }
  async latestWeeklyData() {
    for (const run of await this.runs()) {
      if (!run.artifacts?.some((artifact) => artifact.kind === 'weekly_export')) continue;
      if (this.localRepository) {
        if (run.pipelineMode !== 'local' || run.status !== 'completed') continue;
        const snapshot = await this.read(this.localRepository.papersPath);
        if (!snapshot) continue;
        if (snapshot.schema_version !== 1 || !Array.isArray(snapshot.papers)) throw new Error('LOCAL_PAPERS_SCHEMA_UNSUPPORTED');
        const pipeline = this.pipeline(run);
        const report = pipeline ? await this.read(path.join(pipeline, 'run_report.json')) : null;
        const source = buildLocalStage4ExportSource({ papers: snapshot.papers, runReport: report || {} });
        return { run, report: report || {}, writeback: null, items: source.finalPayload.triaged };
      }
      const pipeline = this.pipeline(run);
      if (!pipeline) continue;
      const report = await this.read(path.join(pipeline, 'run_report.json'));
      if (report?.steps?.med_weekly_synthesis?.completed !== true) continue;
      const source = await this.read(path.join(pipeline, 'desktop_daily_review_source.json'));
      const writeback = await this.read(path.join(pipeline, 'zotero_writeback_summary.json'));
      const filtered = buildStage4StandaloneExportSource({ desktopSource: source, writebackSummary: writeback });
      if (!['ok', 'no_new_writeback_items'].includes(filtered.filter.status)) continue;
      return { run, report, writeback, items: buildFinalExportPayload({ allAbcItems: filtered.allAbcItems, writebackSummary: writeback }).triaged };
    }
    return null;
  }
  async currentReviewScope(weekly) {
    const seen = new Set();
    const runs = await this.runs();
    if (!this.localRepository) for (const run of runs) {
      const pipeline = this.pipeline(run);
      if (!pipeline || !['desktop', 'web'].includes(run.pipelineMode)) continue;
      if (seen.has(pipeline)) continue;
      seen.add(pipeline);
      const report = await this.read(path.join(pipeline, 'run_report.json'));
      if (!report || report.profile === 'radar' || report.runtime_profile === 'radar') continue;
      // A date pipeline can be reused: do not attach a different run's output.
      if (report.skipped || (report.run_id && report.run_id !== run.runId)
        || (report.started_at && Date.parse(report.started_at) < Date.parse(run.startedAt))) continue;
      // A completed final source owns membership; never append Stage1-only holds.
      if (weekly?.run.runId === run.runId) return { run, type: 'weekly', items: buildFinalExportPayload({ allAbcItems: weekly.items, writebackSummary: weekly.writeback || {} }).triaged };
      if (report.steps?.stage4_export_audit?.stage4_export_status === 'success'
        || report.steps?.med_weekly_synthesis?.completed === true) {
        const desktopSource = await this.read(path.join(pipeline, 'desktop_daily_review_source.json'));
        const writebackSummary = await this.read(path.join(pipeline, 'zotero_writeback_summary.json'));
        const source = buildStage4StandaloneExportSource({ desktopSource, writebackSummary });
        return { run, type: 'stage4', items: buildFinalExportPayload({ allAbcItems: source.allAbcItems, writebackSummary: writebackSummary || {} }).triaged };
      }
      const items = await this.read(path.join(pipeline, 'triaged_items.json'));
      if (items === null) {
        continue;
      }
      if (!Array.isArray(items)) throw new Error('REVIEW_SCOPE_INVALID');
      return { run, type: 'prospective_stage4', items: buildProspectiveStage4ExportSource(items) };
    }
    return weekly && (this.localRepository || !runs.length) ? { run: weekly.run, type: 'weekly', items: weekly.items } : null;
  }
  async reviewData() {
    const weekly = await this.latestWeeklyData();
    const scope = await this.currentReviewScope(weekly);
    if (!scope && !weekly) return null;
    const current = await this.feedback.current();
    const state = this.localRepository ? { records: [] } : await readPendingPaperReview(this.reviewRoot);
    const seen = new Set();
    const scopeItems = [];
    for (const item of scope?.items || []) {
      const record = matchPendingPaperRecord(item, state.records);
      const scoped = { ...item, ...(record ? { pending_review_id: record.id } : {}), _reviewScopeRunId: scope.run.runId };
      const keys = identityKeys(scoped);
      if (!keys.length || keys.some((key) => seen.has(key))) continue;
      keys.forEach((key) => seen.add(key)); scopeItems.push(scoped);
    }
    const active = scopeItems.filter((item) => isActiveManualReview(item, current));
    const admittedKeys = new Set((weekly?.items || []).flatMap(identityKeys));
    const admittedReviews = new Set();
    const weeklyMembership = buildFinalReviewMembership(weekly?.items || []);
    const admittedMembership = new Set([...weeklyMembership.feedback, ...weeklyMembership.manual]);
    const weeklyItems = (weekly?.items || []).filter(item => admittedMembership.has(item)).map((item) => {
      const keys = identityKeys(item);
      const matches = active.filter((entry) => identityKeys(entry).some((key) => keys.includes(key)));
      if (matches.length > 1) throw new Error('FEEDBACK_IDENTITY_AMBIGUOUS');
      if (!matches.length || admittedReviews.has(matches[0])) return item;
      admittedReviews.add(matches[0]);
      return { ...item, _activeManualItem: matches[0] };
    });
    const held = active.filter((item) => !identityKeys(item).some((key) => admittedKeys.has(key))).map((item) => ({ ...item, _heldReview: scope.type === 'prospective_stage4', _activeManualItem: item }));
    return {
      ...(weekly || { run: scope.run, report: {}, writeback: null }),
      reviewScope: scope, scopeItems, items: [...weeklyItems, ...held],
    };
  }
  async weekly({ offset = 0, limit = 50 } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('PAGINATION_INVALID');
    const data = await this.reviewData();
    if (!data) return { runId: null, total: 0, items: [] };
    const current = await this.feedback.current();
    const items = data.items.slice(offset, offset + limit).map((item, index) => {
      let keys = [];
      try { keys = feedbackIdentity(item); } catch {}
      const id = paperId(data.run.runId, item, offset + index, keys);
      const evidence = getWeeklyReviewEvidence(item);
      const currentEntry = current.find((entry) => entry.keys.some((key) => keys.includes(key)));
      const pendingReview = item._heldReview === true;
      return {
        id, feedbackAllowed: keys.length > 0 && ['feedback', 'manual'].includes(evidence.reviewBucket), title: String(item.title || ''),
        translatedTitle: String(item.translatedTitle || item.translated_title || item.title_translation || item['标题翻译'] || item['中文标题'] || item.shortTitle || ''),
        authors: (Array.isArray(item.authors) ? item.authors : [item.authors || '']).map((author) => typeof author === 'string' ? author : [author?.firstName, author?.lastName].filter(Boolean).join(' ')), journal: String(item.journal || item.publicationTitle || ''), year: String(item.year || ''),
        doi: String(item.doi || item.DOI || ''), pmid: String(item.pmid || ''), source: String(item.source || item.source_type || ''),
        ...evidence,
        grade: evidence.finalGrade, zotero: pendingReview ? 'not_written' : this.localRepository ? 'not_used_local' : 'admitted',
        pendingReview, manualReviewPending: Boolean(item._activeManualItem && isActiveManualReview(item._activeManualItem, current)),
        abstract: typeof item.abstract === 'string' ? item.abstract : '',
        integrity: item.integrity_status || null,
        feedback: currentEntry?.value || null,
        manualGrade: currentEntry?.manual_grade || null,
      };
    });
    return { runId: data.run.runId, total: data.items.length, items };
  }
  async resolvePaper(runId, id) {
    const data = await this.reviewData();
    if (!data || data.run.runId !== runId) throw new Error('WEEKLY_CHANGED_RELOAD');
    const matches = (data?.items || []).filter((item, index) => {
      let keys = []; try { keys = feedbackIdentity(item); } catch {}
      return paperId(runId, item, index, keys) === id;
    });
    // Resolve this scope's just-decided items for retries/revisions, never all history.
    if (!matches.length) matches.push(...data.scopeItems.filter((item) => isActiveManualReview(item) && paperId(runId, item, 0, identityKeys(item)) === id));
    if (matches.length !== 1) throw new Error('PAPER_NOT_FOUND');
    feedbackIdentity(matches[0]);
    return matches[0];
  }
  async pendingSummary() {
    let offset = 0; let total = 0; const items = [];
    do {
      const page = await this.weekly({ offset, limit: 200 });
      total = page.total; items.push(...page.items); offset += page.items.length;
      if (!page.items.length) break;
    } while (offset < total);
    return {
      normal: items.filter((item) => item.reviewBucket === 'feedback' && !item.pendingReview && item.feedbackAllowed && !item.feedback).length,
      manual: items.filter((item) => item.manualReviewPending && item.feedbackAllowed && !item.manualGrade).length,
      rules: (await this.rules.list()).filter(isActiveRuleSuggestion).length,
    };
  }
  async status() {
    const runs = await this.runs();
    const weekly = await this.latestWeeklyData();
    const summary = weekly ? buildRunSummary({ runId: weekly.run.runId, pipelineMode: weekly.run.pipelineMode, status: weekly.run.status, runReport: weekly.report, writebackSummary: weekly.writeback }) : null;
    let radar = null;
    for (const run of runs) {
      const pipeline = this.pipeline(run);
      if (!pipeline) continue;
      const report = await this.read(path.join(pipeline, 'run_report.json'));
      if (report?.profile === 'radar' || report?.runtime_profile === 'radar') { radar = run; break; }
    }
    return { lastWeekly: weekly?.run.startedAt || null, lastRadar: radar?.startedAt || null,
      lastRun: runs[0] ? { at: runs[0].startedAt, status: runs[0].status } : null,
      nextScheduledRun: null, zotero: weekly ? 'last_writeback_available_not_live_probe' : 'unknown',
      sources: loadSourceSelectionConfig({ root: this.root }).enabled_sources,
      counts: summary?.counts || null, integrity: summary?.integrity || null,
      needsReview: (await this.pendingSummary()).manual,
      pendingSuggestions: (await this.rules.list()).filter(isActiveRuleSuggestion).length,
    };
  }
}
