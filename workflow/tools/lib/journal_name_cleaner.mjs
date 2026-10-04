/**
 * Shared journal/source name cleaner for RSS feed noise.
 *
 * RSS feeds often prefix or suffix the journal title with platform names,
 * feed labels, or generic navigation text. This module strips those so that
 * the publicationTitle written into Zotero and the "期刊/来源" column in
 * exports contain only the actual journal name.
 */

/** Strings that are pure noise and should map to empty. */
const NOISE_VALUES = new Set([
  "latest results",
  "table of contents",
  "recent articles",
  "current issue",
  "latest articles",
  "rss",
  "rss feed",
  "wiley",
  "wiley online library",
  "sciencedirect",
  "acs publications",
  "example journal current issue",
]);

/** URL DOI-prefix → journal name mapping for inferring journal from URL. */
export const DOI_PREFIX_JOURNAL_MAP = [
  { prefix: "10.0000/example.036", journal: "Example Journal A" },
  { prefix: "10.0000/example.035", journal: "Example Journal B" },
];

/** URL path segment → journal name mapping. */
const URL_PATH_JOURNAL_MAP = [
  { host: "example.com", pathPrefix: "/journal/", journal: "Example Journal C" },
];

/**
 * Runtime cache: Springer journal ID → journal name.
 * Avoids repeated network calls for the same journal within a process lifetime.
 */
const SPRINGER_JOURNAL_CACHE = new Map();

/**
 * Extract Springer journal ID from a DOI prefix in a URL.
 * Example: ".../10.0000/example.036-026-03897-x" → 12974
 * Also matches facet-journal-id from RSS feed URLs.
 */
function extractSpringerJournalId(url) {
  const s = String(url || "");
  const doiMatch = s.match(/\/s(\d{4,6})[\-\/]/);
  if (doiMatch) {
    const id = Number(doiMatch[1]);
    if (Number.isFinite(id)) return id;
  }
  const facetMatch = s.match(/facet-journal-id=(\d+)/);
  if (facetMatch) {
    const id = Number(facetMatch[1]);
    if (Number.isFinite(id)) return id;
  }
  return null;
}

/**
 * Fetch the journal name from a Springer journal page by journal ID.
 * Extracts the <title> tag and strips " - Springer" suffix.
 */
async function fetchSpringerJournalName(journalId) {
  if (!journalId) return "";
  if (SPRINGER_JOURNAL_CACHE.has(journalId)) return SPRINGER_JOURNAL_CACHE.get(journalId);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://link.springer.com/journal/${journalId}`, {
      signal: controller.signal,
      headers: { "User-Agent": "ResearchOS/1.0" },
    });
    clearTimeout(timer);
    if (!res.ok) { SPRINGER_JOURNAL_CACHE.set(journalId, ""); return ""; }
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      let name = titleMatch[1].trim();
      name = name.replace(/\s*[-–—]\s*(Springer|SpringerLink)\s*$/i, "").trim();
      // Also strip " | Springer Nature Link" suffix
      name = name.replace(/\s*\|\s*Springer\s*(Nature\s*)?(Link)?\s*$/i, "").trim();
      // Strip leading "Home | " prefix from Springer journal pages
      name = name.replace(/^Home\s*\|\s*/i, "").trim();
      if (name && name.toLowerCase() !== "springer" && name.length > 2) {
        SPRINGER_JOURNAL_CACHE.set(journalId, name);
        return name;
      }
    }
  } catch { /* network error — don't cache, allow retry */ }
  SPRINGER_JOURNAL_CACHE.set(journalId, "");
  return "";
}

/**
 * Decode common HTML entities in a string.
 */
function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Infer journal name from a URL when publicationTitle is empty.
 * Uses DOI prefix and URL path patterns.
 *
 * @param {string} url
 * @returns {string} inferred journal name, or "" if unresolvable
 */
export function inferJournalFromUrlSync(url) {
  const u = String(url || "").trim();
  if (!u) return "";

  // DOI prefix matching
  for (const { prefix, journal } of DOI_PREFIX_JOURNAL_MAP) {
    if (u.includes(prefix)) return journal;
  }

  // URL path matching
  try {
    const parsed = new URL(u);
    for (const { host, pathPrefix, journal } of URL_PATH_JOURNAL_MAP) {
      if (parsed.hostname === host && parsed.pathname.includes(pathPrefix)) return journal;
    }
  } catch {}

  return "";
}

/**
 * Infer journal name from a URL when publicationTitle is empty.
 * Async version: tries sync static maps first, then dynamically resolves
 * unknown Springer journal IDs by fetching the journal page title.
 *
 * @param {string} url - article URL
 * @param {string} [feedUrl] - optional RSS feed URL (may contain facet-journal-id)
 * @returns {Promise<string>} inferred journal name, or "" if unresolvable
 */
export async function inferJournalFromUrl(url, feedUrl) {
  const sync = inferJournalFromUrlSync(url);
  if (sync) return sync;
  const jid = extractSpringerJournalId(url) || extractSpringerJournalId(feedUrl);
  if (jid) {
    const name = await fetchSpringerJournalName(jid);
    if (name) return name;
  }
  return "";
}

/**
 * Clean a raw journal/source string by removing common RSS feed prefixes
 * and suffixes, returning only the journal name.
 *
 * @param {string} raw
 * @returns {string} cleaned journal name, or "" if input is pure noise
 */
export function cleanJournalName(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";

  // Decode HTML entities first (RSS feeds may encode & as &amp;)
  s = decodeHtmlEntities(s);

  // Strip platform prefixes
  s = s
    .replace(/^ScienceDirect Publication:\s*/i, "")
    .replace(/^AAAS:\s*/i, "")
    .replace(/^Wiley:\s*/i, "");

  // Strip feed/navigation suffixes
  s = s
    .replace(/:\s*Latest Articles\s*\(.*?\)\s*$/i, "")
    .replace(/:\s*Latest Articles\s*$/i, "")
    .replace(/:\s*Table of Contents\s*$/i, "")
    .replace(/\s*[:–—-]\s*(?:Recent Articles|Current Issue|Latest Results)\s*$/i, "")
    .replace(/\s*[-–—]\s*Wiley Online Library\s*$/i, "")
    .replace(/\s*[-–—]\s*Wiley\s*$/i, "");

  s = s.trim();

  // After stripping, check if remainder is pure noise
  if (NOISE_VALUES.has(s.toLowerCase())) return "";

  return s;
}

export function getPublicationVenue(item = {}) {
  const rss = String(item.source_channel || item.source_platform || item.source || '').toLowerCase() === 'rss';
  for (const value of [item.publicationTitle, item.publicationName, item.journal, item.venue]) {
    if (typeof value !== 'string' || !value.trim() || /^https?:\/\//i.test(value)) continue;
    const venue = rss ? cleanJournalName(value) : value.trim();
    if (venue) return venue;
  }
  return '';
}
