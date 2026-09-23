import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getLiteratureIdentityKeys } from './literature_identity.mjs';
import { readCanonicalFeedback, currentPaperFeedback } from './control_feedback_service.mjs';
import { withAtomicJsonLock, writeAtomicJson } from './atomic_json.mjs';

const STRONG = /^(doi|pmid|pmcid|arxiv|openalex|url):/;
const GRADES = new Set(['A', 'B', 'C', 'D']);
const PAPER_FIELDS = [
  'title', 'abstract', 'doi', 'pmid', 'pmcid', 'arxiv', 'openalex_id', 'url',
  'authors', 'journal', 'publicationTitle', 'publication_year', 'publication_date',
  'pubdate', 'source', 'source_channel', 'source_platform', 'item_type_hint',
  'rule_grade', 'llm_review_grade', 'final_grade', 'grade', 'grade_reason', 'semantic_reason',
];

export const pendingPaperReviewPath = (reviewRoot) => path.join(reviewRoot, 'pending_paper_review.json');

function paperSnapshot(item) {
  return Object.fromEntries(PAPER_FIELDS.filter((key) => item[key] != null).map((key) => [key, item[key]]));
}

export async function readPendingPaperReview(reviewRoot) {
  try {
    const state = JSON.parse(await fs.readFile(pendingPaperReviewPath(reviewRoot), 'utf8'));
    if (state.schemaVersion !== 1 || !Array.isArray(state.records)
      || state.records.some((record) => !/^[0-9a-f-]{36}$/i.test(record.id || '')
        || !Array.isArray(record.keys) || !record.keys.length
        || !record.paper || !['pending', 'auto_d'].includes(record.status))) {
      throw new Error('PENDING_PAPER_REVIEW_INVALID');
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, records: [] };
    throw error;
  }
}

function conflictingStrongKey(candidateKeys, recordKeys) {
  for (const type of ['doi', 'pmid', 'pmcid', 'arxiv', 'openalex', 'url']) {
    const candidate = candidateKeys.find((key) => key.startsWith(`${type}:`));
    const record = recordKeys.find((key) => key.startsWith(`${type}:`));
    if (candidate && record && candidate !== record) return true;
  }
  return false;
}

export function matchPendingPaperRecord(item, records = []) {
  const keys = getLiteratureIdentityKeys(item);
  const strong = keys.filter((key) => STRONG.test(key));
  let matches = records.filter((record) => strong.some((key) => record.keys.includes(key)));
  if (!matches.length) {
    const title = keys.find((key) => key.startsWith('title:') && key.length >= 26);
    if (title) {
      const sameTitle = records.filter((record) => record.keys.includes(title));
      if (sameTitle.some((record) => conflictingStrongKey(keys, record.keys))) {
        throw new Error('PENDING_PAPER_REVIEW_IDENTITY_CONFLICT');
      }
      matches = sameTitle;
    }
  }
  if (matches.length > 1) throw new Error('PENDING_PAPER_REVIEW_IDENTITY_AMBIGUOUS');
  return matches[0] || null;
}

export function manualDecisionForRecord(record, current = []) {
  const keys = new Set([`review:${record.id}`, ...record.keys.filter((key) => STRONG.test(key))]);
  const matches = current.filter((entry) => entry.kind === 'manual_grade'
    && entry.keys.some((key) => keys.has(key)));
  if (matches.length > 1 && new Set(matches.map((entry) => entry.identity)).size > 1) {
    throw new Error('PENDING_PAPER_REVIEW_DECISION_AMBIGUOUS');
  }
  const decision = matches.at(-1);
  return GRADES.has(decision?.manual_grade) ? decision.manual_grade : '';
}

export async function preparePendingPaperReview({ reviewRoot, candidates = [] }) {
  const state = await readPendingPaperReview(reviewRoot);
  const current = currentPaperFeedback(await readCanonicalFeedback(reviewRoot));
  const input = [...candidates];
  const injected = [];
  for (const item of input) matchPendingPaperRecord(item, state.records);
  for (const record of state.records) {
    const manualGrade = manualDecisionForRecord(record, current);
    if (!['A', 'B', 'C'].includes(manualGrade)) continue;
    if (input.some((item) => matchPendingPaperRecord(item, [record]))) continue;
    injected.push({ ...record.paper, pending_review_id: record.id, pending_review_state: record.status });
  }
  input.push(...injected);
  return { input, state, current, injectedCount: injected.length };
}

export function attachPendingPaperReview(items, { state, current }) {
  for (const item of items) {
    const record = matchPendingPaperRecord(item, state.records);
    if (!record) continue;
    item.pending_review_id = record.id;
    item.pending_review_state = record.status;
    item.manual_confirmed_grade = manualDecisionForRecord(record, current);
  }
  return items;
}

export async function finalizePendingPaperReview({ reviewRoot, items, now = new Date() }) {
  const current = currentPaperFeedback(await readCanonicalFeedback(reviewRoot));
  const candidates = [];
  for (const item of items) {
    item.review_consensus_required = true;
    const rule = String(item.rule_grade || item.grade || '').slice(0, 1).toUpperCase();
    const semantic = String(item.llm_review_grade || '').slice(0, 1).toUpperCase();
    const confirmed = item.pending_review_id
      ? manualDecisionForRecord({ id: item.pending_review_id, keys: getLiteratureIdentityKeys(item) }, current)
      : '';
    if (confirmed) {
      item.manual_confirmed_grade = confirmed;
      item.final_grade = confirmed;
      item.grade = confirmed;
      item.needs_human_review = false;
      item.manual_review_state = confirmed === 'D' ? 'manual_d' : 'manual_abc';
      if (confirmed === 'D') item.pre_llm_skip_writeback = true;
      continue;
    }
    const bothD = rule === 'D' && semantic === 'D';
    const pending = !bothD && (!semantic || rule !== semantic || item.pending_review_state === 'pending');
    if (!bothD && !pending) continue;
    if (item.pre_llm_zotero_existing_duplicate === true) continue;
    item.needs_human_review = pending;
    item.manual_review_state = pending ? 'pending' : 'auto_d';
    item.pre_llm_skip_writeback = true;
    candidates.push(item);
  }
  if (!candidates.length) return { pending: 0, autoD: 0, updated: 0 };
  const file = pendingPaperReviewPath(reviewRoot);
  return withAtomicJsonLock(file, async () => {
    const state = await readPendingPaperReview(reviewRoot);
    const timestamp = new Date(now).toISOString();
    let pending = 0; let autoD = 0;
    for (const item of candidates) {
      const keys = getLiteratureIdentityKeys(item);
      if (!keys.length) throw new Error('PENDING_PAPER_REVIEW_IDENTITY_REQUIRED');
      const record = item.pending_review_id
        ? state.records.find((entry) => entry.id === item.pending_review_id)
        : matchPendingPaperRecord(item, state.records);
      if (item.pending_review_id && !record) throw new Error('PENDING_PAPER_REVIEW_RECORD_MISSING');
      const status = item.manual_review_state;
      if (status === 'pending') pending++; else autoD++;
      if (record) {
        record.keys = [...new Set([...record.keys, ...keys])];
        record.paper = paperSnapshot(item);
        record.status = status;
        record.lastSeenAt = timestamp;
        item.pending_review_id = record.id;
      } else {
        const id = randomUUID();
        state.records.push({ id, keys, paper: paperSnapshot(item), status, firstSeenAt: timestamp, lastSeenAt: timestamp });
        item.pending_review_id = id;
      }
    }
    await writeAtomicJson(file, state);
    return { pending, autoD, updated: candidates.length };
  });
}

export async function listPendingPaperReview({ reviewRoot, current }) {
  const state = await readPendingPaperReview(reviewRoot);
  return state.records.filter((record) => record.status === 'pending' && !manualDecisionForRecord(record, current)).map((record) => ({
    ...record.paper,
    pending_review_id: record.id,
    needs_human_review: true,
    manual_confirmed_grade: manualDecisionForRecord(record, current),
  }));
}
