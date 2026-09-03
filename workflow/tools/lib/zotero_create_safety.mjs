export function isDefinitelyFailedWithoutSideEffect(error) {
  return error?.definitelyFailedWithoutSideEffect === true || error?.createOutcome === "definitely_failed";
}

export function legacyCreateFallbackEnabled(env = process.env) {
  return env?.ZOTERO_LEGACY_CREATE_FALLBACK === "1";
}

export function uncertainCreateError(cause, details = {}) {
  const error = new Error("ZOTERO_CREATE_OUTCOME_UNCERTAIN_RECONCILE_REQUIRED");
  error.code = "ZOTERO_CREATE_OUTCOME_UNCERTAIN_RECONCILE_REQUIRED";
  error.createOutcome = "unknown";
  error.reconcileRequired = true;
  error.details = details;
  error.cause = cause;
  return error;
}
