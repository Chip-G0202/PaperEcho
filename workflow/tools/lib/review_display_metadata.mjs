import { getPublicationVenue } from './journal_name_cleaner.mjs';
import { existingTranslatedTitle } from './title_translation_generation.mjs';
import { resolveCachedTranslation } from './title_translation_support.mjs';

// Feed provenance is not a publication venue. Both review queues use this projection.
export function getReviewDisplayMetadata(item = {}, { translationCache = null } = {}) {
  const rawSource = String(item.source_platform || item.source_channel || item.source_type || item.source || '').trim();
  const source = ({ rss:'RSS', pubmed:'PubMed', pmc:'PMC', pubmed_pmc:'PubMed/PMC', openalex:'OpenAlex', semantic_scholar:'Semantic Scholar', crossref:'Crossref', europe_pmc:'Europe PMC', zotero:'Zotero', local_import:'Local' })[rawSource.toLowerCase()] || rawSource;
  const translatedTitle = existingTranslatedTitle(item) || existingTranslatedTitle({ title:item.title, translatedTitle:resolveCachedTranslation(translationCache,item.title) });
  const date = String(item.publication_date || item.pubdate || item.date || '').trim();
  const dateYear = date ? new Date(date).getUTCFullYear() : NaN;
  return {
    title:String(item.title || ''), translatedTitle, journal:getPublicationVenue(item), source,
    year:String(item.year || item.publication_year || (Number.isFinite(dateYear) ? dateYear : '')), date,
    rawSourceLabel:String(item.feed_title || item.feed_name || (source === 'RSS' ? item.journal : '') || ''),
  };
}
