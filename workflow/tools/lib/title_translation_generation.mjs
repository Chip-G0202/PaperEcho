import { DEFAULT_CACHE_PATH, translateTitlesBatch } from "./title_translation_support.mjs";

function normalizedTranslationText(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function isMeaningfulChineseTranslation(candidate, sourceTitle = "") {
  const translated = normalizedTranslationText(candidate);
  const source = normalizedTranslationText(sourceTitle);
  return Boolean(translated && /\p{Script=Han}/u.test(translated) && translated.toLocaleLowerCase() !== source.toLocaleLowerCase());
}

export function existingTranslatedTitle(item = {}) {
  const candidate = item.translatedTitle || item["标题翻译"] || item["中文标题"] || item.shortTitle || "";
  return isMeaningfulChineseTranslation(candidate, item.title) ? normalizedTranslationText(candidate) : "";
}

export async function generateLiteratureTitleTranslations(items = [], {
  cachePath = DEFAULT_CACHE_PATH,
  translateTitlesBatchImpl = translateTitlesBatch,
} = {}) {
  const source = Array.isArray(items) ? items : [];
  const missingTitles = source
    .filter((item) => !existingTranslatedTitle(item))
    .map((item) => String(item?.title || "").trim())
    .filter(Boolean);
  const translated = missingTitles.length
    ? await translateTitlesBatchImpl(missingTitles, undefined, { cachePath })
    : { map: new Map(), usage: { total_items: 0, cache_hits: 0, cache_misses: 0, api_calls: 0 } };
  const failures = [];
  let generatedCount = 0;
  const enriched = source.map((item) => {
    const existing = existingTranslatedTitle(item);
    if (existing) return { ...item, translatedTitle: existing, hasTranslation: true };
    const title = String(item?.title || "").trim();
    const result = translated?.map?.get(title);
    const value = result?.ok && isMeaningfulChineseTranslation(result.zh, title)
      ? normalizedTranslationText(result.zh)
      : "";
    if (!value) {
      if (title) failures.push({ title, reason: result?.reason || (result?.ok ? "translation_not_meaningful" : "translation_failed") });
      return { ...item, translatedTitle: "", "标题翻译": "", "中文标题": "", hasTranslation: false };
    }
    generatedCount += 1;
    return { ...item, translatedTitle: value, "标题翻译": value, "中文标题": value, hasTranslation: true };
  });
  return { items: enriched, usage: translated?.usage || null, generated_count: generatedCount, failures };
}
