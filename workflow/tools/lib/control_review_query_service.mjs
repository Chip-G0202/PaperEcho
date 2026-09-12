import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildStage4StandaloneExportSource } from '../stage4/finalize_exports_support.mjs';
import { buildRunSummary } from './run_summary.mjs';
import { feedbackIdentity } from './control_feedback_service.mjs';
import { loadSourceSelectionConfig } from './literature_config.mjs';

const inside = (root, candidate) => { const rel = path.relative(root, candidate); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
export class ReviewQueryService {
  constructor({ root, reviewRoot = path.join(root, 'review_results', '文献评价'), feedback, rules }) {
    Object.assign(this, { root: path.resolve(root), reviewRoot, feedback, rules });
    this.researchRoot = path.join(this.root, 'review_results');
  }
  async read(file) {
    if (!inside(this.root, path.resolve(file))) throw new Error('ARTIFACT_PATH_BLOCKED');
    try {
      const real = await fs.realpath(file);
      if (!inside(await fs.realpath(this.root), real)) throw new Error('ARTIFACT_PATH_BLOCKED');
      return JSON.parse(await fs.readFile(real, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async runs() {
    const runRoot = path.join(this.reviewRoot, 'runs');
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
    const artifact = run.artifacts?.find((entry) => entry.kind === 'pipeline' && entry.rootKey === 'research');
    if (!artifact || typeof artifact.path !== 'string') return null;
    const file = path.resolve(this.researchRoot, artifact.path);
    return inside(this.researchRoot, file) ? file : null;
  }
  async latestWeeklyData() {
    for (const run of await this.runs()) {
      if (!run.artifacts?.some((artifact) => artifact.kind === 'weekly_export')) continue;
      const pipeline = this.pipeline(run);
      if (!pipeline) continue;
      const report = await this.read(path.join(pipeline, 'run_report.json'));
      if (report?.steps?.med_weekly_synthesis?.status !== 'completed') continue;
      const source = await this.read(path.join(pipeline, 'desktop_daily_review_source.json'));
      const writeback = await this.read(path.join(pipeline, 'zotero_writeback_summary.json'));
      const filtered = buildStage4StandaloneExportSource({ desktopSource: source, writebackSummary: writeback });
      if (filtered.filter.status !== 'ok') continue;
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
      return {
        id, feedbackAllowed: keys.length > 0, title: String(item.title || ''),
        translatedTitle: String(item.translated_title || item.title_translation || item.shortTitle || ''),
        authors: (Array.isArray(item.authors) ? item.authors : [item.authors || '']).map((author) => typeof author === 'string' ? author : [author?.firstName, author?.lastName].filter(Boolean).join(' ')), journal: String(item.journal || item.publicationTitle || ''), year: String(item.year || ''),
        doi: String(item.doi || item.DOI || ''), pmid: String(item.pmid || ''), source: String(item.source || item.source_type || ''),
        grade: item.final_grade || item.grade || '', zotero: 'admitted',
        integrity: item.integrity_status || null, needsReview: item.needs_human_review === true,
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
      needsReview: weekly?.items.filter((item) => item.needs_human_review === true).length ?? null,
      pendingSuggestions: (await this.rules.list()).filter((entry) => ['pending', 'candidate'].includes(entry.status)).length,
    };
  }
}
