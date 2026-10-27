import { FuseVersion, FuseV1Options as F } from '@electron/fuses';

export const appVersion = '2.6.0';
export const fuseConfig = Object.freeze({ version: FuseVersion.V1, strictlyRequireAllFuses: true,
  [F.RunAsNode]: true, [F.EnableCookieEncryption]: true,
  [F.EnableNodeOptionsEnvironmentVariable]: false, [F.EnableNodeCliInspectArguments]: false,
  [F.EnableEmbeddedAsarIntegrityValidation]: true, [F.OnlyLoadAppFromAsar]: true,
  [F.LoadBrowserProcessSpecificV8Snapshot]: false, [F.GrantFileProtocolExtraPrivileges]: false, [F.WasmTrapHandlers]: true });
// Only maintained defaults/templates; new config files require explicit packaging review.
const configs = new Set(['openalex_search.json', 'paperecho.config.example.json', 'preference_learning.config.json',
  'prompt-preference-learning.md', 'prompt-title-translation.md', 'pubmed_pmc_search.json',
  'review-workflow-rules.json', 'rss_sources.json', 'source_selection.json', 'title_translation.config.json']);
export function sourceAllowed(file) {
  return /^workflow\/tools\/.*\.(mjs|py)$/.test(file)
    || /^workflow\/tools\/web\/static\/(index\.html|app\.js|styles\.css|paperecho-mark\.svg)$/.test(file)
    || /^skills\/paperecho-(local|zotero-desktop|zotero-web)\/scripts\/run\.mjs$/.test(file)
    || file.startsWith('config/') && configs.has(file.slice(7))
    || ['desktop/electron-poc/preload.cjs', 'desktop/electron-poc/runtime.mjs', 'desktop/electron-poc/headless.mjs', 'desktop/electron-poc/main.mjs', 'desktop/electron-poc/shell.mjs', 'tests/helpers/electron_smoke.mjs', 'tests/helpers/first_run_smoke.mjs', 'tests/helpers/packaged_probe.mjs'].includes(file);
}
