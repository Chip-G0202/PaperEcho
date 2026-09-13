import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildStage4StandaloneExportSource } from '../stage4/finalize_exports_support.mjs';
import { buildRunSummary } from './run_summary.mjs';
import { feedbackIdentity } from './control_feedback_service.mjs';
import { loadSourceSelectionConfig } from './literature_config.mjs';
import { buildRuntimeConfig } from './runtime_config.mjs';
import { buildLocalStage4ExportSource } from '../stage4/export_source_step.mjs';
import { getWeeklyReviewEvidence } from '../stage4/spreadsheet_adapter.mjs';

const inside = (root, candidate) => { const rel = path.relative(root, candidate); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
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
      return { run, report, writeback, items: filtered.allAbcItems };
    }
    return null;
  }
  async weekly({ offset = 0, limit = 50 } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('PAGINATION_INVALID');
    const data = await this.latestWeeklyData();
    if (!data) return { runId: null, total: 0, items: [] };
    const current = await this.feedback.current();
    const items = data.items.slice(offset, offset + limit).map((item, index) => {
      let keys = [];
      try { keys = feedbackIdentity(item); } catch {}
      const id = createHash('sha256').update(`${data.run.runId}:${offset + index}:${keys[0] || ''}`).digest('hex');
      const evidence = getWeeklyReviewEvidence(item);
      return {
        id, feedbackAllowed: keys.length > 0, title: String(item.title || ''),
        translatedTitle: String(item.translatedTitle || item.translated_title || item.title_translation || item['标题翻译'] || item['中文标题'] || item.shortTitle || ''),
        authors: (Array.isArray(item.authors) ? item.authors : [item.authors || '']).map((author) => typeof author === 'string' ? author : [author?.firstName, author?.lastName].filter(Boolean).join(' ')), journal: String(item.journal || item.publicationTitle || ''), year: String(item.year || ''),
        doi: String(item.doi || item.DOI || ''), pmid: String(item.pmid || ''), source: String(item.source || item.source_type || ''),
        ...evidence,
        grade: evidence.finalGrade, zotero: this.localRepository ? 'not_used_local' : 'admitted',
        abstract: typeof item.abstract === 'string' ? item.abstract : '',
        integrity: item.integrity_status || null,
        feedback: current.find((entry) => entry.keys.some((key) => keys.includes(key)))?.value || null,
      };
    });
    return { runId: data.run.runId, total: data.items.length, items };
  }
  async resolvePaper(runId, id) {
    const data = await this.latestWeeklyData();
    if (!data || data.run.runId !== runId) throw new Error('WEEKLY_CHANGED_RELOAD');
    const matches = data.items.filter((item, index) => {
      let keys = []; try { keys = feedbackIdentity(item); } catch {}
      return createHash('sha256').update(`${runId}:${index}:${keys[0] || ''}`).digest('hex') === id;
    });
    if (matches.length !== 1) throw new Error('PAPER_NOT_FOUND');
    feedbackIdentity(matches[0]);
    return matches[0];
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
      needsReview: weekly?.items.filter((item) => getWeeklyReviewEvidence(item).needsReview).length ?? null,
      pendingSuggestions: (await this.rules.list()).filter((entry) => ['pending', 'candidate'].includes(entry.status)).length,
    };
  }
}
