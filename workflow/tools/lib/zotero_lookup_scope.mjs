import { AsyncLocalStorage } from "node:async_hooks";

// Request-local cancellation; never changes the shared adapter's configuration.
const scope = new AsyncLocalStorage();
export const withZoteroLookupSignal = (signal, operation) => scope.run(signal, operation);
export const zoteroLookupSignal = () => scope.getStore();

export function enrichmentAbort(status = "interrupted") {
  return Object.assign(new Error(`feedback_title_enrichment_${status}`), { code: "FEEDBACK_ENRICHMENT_INCOMPLETE", status });
}
