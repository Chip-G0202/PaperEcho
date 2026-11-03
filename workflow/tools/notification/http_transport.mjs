// Provider owners supply validated/fixed URLs. Never exposes response bodies/errors.
export async function postNotificationJson(url, body, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  try {
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json().catch(() => null) };
  } catch { return { status: null, data: null }; }
}
export function providerOutcome(accepted, category, responseCode = null, provider) {
  return { ...(accepted === undefined ? {} : { accepted }), category, responseCode, ...(provider ? { provider } : {}) };
}
