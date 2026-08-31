import { hashText } from "../lib/llm_json_support.mjs";
import { getLiteratureIdentityKeys } from "../lib/literature_identity.mjs";

function cleanText(s) {
  return String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normTitle(t) {
  return cleanText(t)
    .normalize("NFKC")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeKeysForItem(item = {}) {
  return getLiteratureIdentityKeys(item).map((key) => ({ type: key.slice(0, key.indexOf(":")), key }));
}

export function dedupWithDiagnostics(items = []) {
  const seen = new Map();
  const out = [];
  const duplicateGroups = [];
  const skippedByKeyType = {};
  for (const [sourceIndex, item] of items.entries()) {
    const keys = dedupeKeysForItem(item);
    const matched = keys.find((entry) => seen.has(entry.key));
    if (matched) {
      const keptIndex = seen.get(matched.key);
      skippedByKeyType[matched.type] = (skippedByKeyType[matched.type] || 0) + 1;
      duplicateGroups.push({
        kept_index: keptIndex,
        duplicate_index: sourceIndex,
        key_type: matched.type,
        key_hash: hashText(matched.key).slice(0, 16),
        duplicate_title_preview: cleanText(item.title).slice(0, 120),
      });
      const kept = out[keptIndex];
      if (kept) {
        kept.dedupe_duplicate_count = Number(kept.dedupe_duplicate_count || 0) + 1;
        const sources = new Set([kept.source, item.source].filter(Boolean).map(String));
        if (sources.size) kept.dedupe_merged_sources = [...sources];
      }
      continue;
    }
    const keptIndex = out.length;
    for (const entry of keys) seen.set(entry.key, keptIndex);
    out.push(item);
  }
  return {
    items: out,
    diagnostics: {
      fetched_count: items.length,
      deduped_count: out.length,
      duplicate_removed_count: Math.max(0, items.length - out.length),
      skipped_by_key_type: skippedByKeyType,
      duplicate_groups: duplicateGroups.slice(0, 50),
      duplicate_groups_truncated: duplicateGroups.length > 50,
    },
  };
}

export function countPotentialDuplicateTitles(items = []) {
  const counts = new Map();
  for (const item of items) {
    const title = normTitle(item.title);
    if (!title) continue;
    counts.set(title, (counts.get(title) || 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).length;
}
