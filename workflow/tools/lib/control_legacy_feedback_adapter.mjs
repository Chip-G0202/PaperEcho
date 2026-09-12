import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readXlsxSheets } from './review_workbook_reader.mjs';
import { feedbackIdentity } from './control_feedback_service.mjs';

// Explicit one-way import. A title is context, never an identity resolver.
export async function importLegacyWorkbook(file, service) {
  const hash = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const rows = readXlsxSheets(file).get('每日反馈');
  if (!rows?.length) throw new Error('LEGACY_FEEDBACK_SHEET_MISSING');
  const headers = rows[0].map((value) => String(value).trim());
  const cell = (row, aliases) => row[headers.findIndex((header) => aliases.includes(header))] || '';
  const prepared = [];
  const blocked = [];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    const raw = cell(row, ['feedback', 'Feedback', '反馈', '用户反馈']).toLowerCase().trim();
    if (!raw) continue;
    const value = { upgrade: 'highly_relevant', keep: 'relevant', downgrade: 'maybe', drop: 'irrelevant' }[raw];
    const paper = {
      doi: cell(row, ['DOI', 'doi']), pmid: cell(row, ['PMID', 'pmid']),
      title: cell(row, ['英文标题', 'title', 'Title', 'English Title']),
    };
    try { feedbackIdentity(paper); if (!value) throw new Error('LEGACY_FEEDBACK_INVALID'); }
    catch (error) { blocked.push({ row: index + 1, code: error.message }); continue; }
    prepared.push({ kind: 'paper_feedback', paper, value, comment: cell(row, ['评价', 'comment', 'Comment', '备注']), requestId: `xlsx:${hash}:${index + 1}`, source: 'legacy_xlsx', sourceRow: index + 1 });
  }
  // Identity uncertainty leaves the canonical state unchanged for this import.
  if (blocked.length) return { imported: 0, duplicate: 0, blocked };
  const receipts = await service.submitPaperBatch(prepared);
  return { imported: receipts.filter((entry) => !entry.duplicate).length, duplicate: receipts.filter((entry) => entry.duplicate).length, blocked: [], receipts };
}
