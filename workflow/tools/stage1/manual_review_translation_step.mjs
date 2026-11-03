import { generateLiteratureTitleTranslations } from '../lib/title_translation_generation.mjs';
import { getTranslationConfig } from '../lib/title_translation_support.mjs';
import { isManualReviewReachable } from '../stage4/finalize_exports_support.mjs';

export async function enrichManualReviewTitles(items = [], {
  enabled = getTranslationConfig().enabled, context = {}, ...translationOptions
} = {}) {
  const targets = items.filter(item => String(item.title || '').trim() && isManualReviewReachable(item,context));
  if (!enabled || !targets.length) return { items, target_count:targets.length, generated_count:0, failures:[], skipped_reason:enabled ? 'no_manual_items' : 'disabled_by_config' };
  try {
    const generated = await generateLiteratureTitleTranslations(targets,{...translationOptions,enabled});
    const enriched = new Map(targets.map((item,index) => [item,generated.items[index]]));
    return { ...generated, target_count:targets.length, items:items.map(item => enriched.get(item) || item) };
  } catch {
    return { items, target_count:targets.length, generated_count:0, failures:targets.map(() => ({reason:'title_translation_failed'})) };
  }
}
