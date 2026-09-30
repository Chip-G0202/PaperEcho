// Official QQ OpenAPI only. Authentication and HTTP live here; policy, content,
// rendering, retries and receipts remain with their existing application owners.
// https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html
// https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html
// https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html
import { QQ_TEXT_BUDGET_BYTES } from './qq_renderer.mjs';
const API_ROOT = 'https://api.bot.qq.com';
const AUTH_CODES = new Set([100007, 100016, 10004, 11241, 11243, 11251, 11261, 11275]);
const PERMISSION_CODES = new Set([11253, 11254, 11264, 11265, 11274, 40034105, 40054002, 40054013]);
const DESTINATION_CODES = new Set([40034101, 40054003, 40054004]);
const RATE_CODES = new Set([100001, 40034100, 20028]);
const PAYLOAD_CODES = new Set([12002, 22006, 304061, 40034006, 40054007, 40054010, 40054018]);
const REJECTED_PROVIDER_CODES = new Set([50055001, 50055002]);

function category(code, status) {
  if (AUTH_CODES.has(code) || status === 401) return 'qq_authentication';
  if (PERMISSION_CODES.has(code) || status === 403) return 'qq_authorization';
  if (DESTINATION_CODES.has(code)) return 'qq_invalid_destination';
  if (RATE_CODES.has(code) || status === 429) return 'qq_rate_limited';
  if (PAYLOAD_CODES.has(code)) return 'qq_invalid_payload';
  if (REJECTED_PROVIDER_CODES.has(code) || status >= 500) return 'qq_provider_unavailable';
  return 'qq_unknown';
}
function outcome(accepted, error, status = null) {
  return { ...(accepted === undefined ? {} : { accepted }), acceptedCount: accepted ? 1 : 0, rejectedCount: accepted === false ? 1 : 0,
    category: error, responseCode: status };
}
function errorCode(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return NaN;
  for (const key of ['code', 'err_code']) {
    if (data[key] === undefined) continue;
    if (!/^[0-9]+$/.test(String(data[key])) || !Number.isSafeInteger(Number(data[key]))) return NaN;
    if (Number(data[key]) !== 0) return Number(data[key]);
  }
  return 0;
}

// Cache is instance-local and memory-only; replacing credentials creates a new
// transport. One failed acquisition is not cached. No background refresh/daemon.
export function createQqTransport({ appId, clientSecret, targetType, targetId }, {
  fetchImpl = globalThis.fetch, clock = () => Date.now(), timeoutMs = 15000,
} = {}) {
  let token = null;
  let acquisition = null;
  async function request(endpoint, body, accessToken) {
    try {
      const response = await fetchImpl(API_ROOT + endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...(accessToken ? { Authorization: `QQBot ${accessToken}` } : {}) }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => null);
      return { status: response.status, data };
    } catch { return { status: null, data: null }; }
  }
  async function access() {
    if (token && token.expiresAt - clock() > Math.min(60000, token.lifetime / 3)) return token.value;
    if (!acquisition) acquisition = (async () => {
      const result = await request('/app/getAppAccessToken', { appId, clientSecret });
      const code = errorCode(result.data);
      const expiresIn = result.data?.expires_in;
      const lifetime = (typeof expiresIn === 'number' || typeof expiresIn === 'string' && expiresIn.trim() ? Number(expiresIn) : NaN) * 1000;
      if (result.status !== 200 || code !== 0 || typeof result.data?.access_token !== 'string' || !result.data.access_token.trim()
        || /[\u0000-\u0020\u007f]/.test(result.data.access_token) || !Number.isFinite(lifetime) || lifetime <= 0) {
        return outcome(false, result.status == null ? 'qq_network' : category(code, result.status), result.status);
      }
      token = { value: result.data.access_token, lifetime, expiresAt: clock() + lifetime };
      return token.value;
    })().finally(() => { acquisition = null; });
    return acquisition;
  }
  return async (payload) => {
    if (typeof appId !== 'string' || !appId.trim() || typeof clientSecret !== 'string' || !clientSecret
      || !['user', 'group'].includes(targetType) || typeof targetId !== 'string' || !targetId.trim() || /[\u0000-\u001f]/.test(targetId)) return outcome(false, 'qq_configuration_invalid');
    if (!payload || payload.msg_type !== 0 || typeof payload.content !== 'string' || !payload.content.trim() || /\p{Surrogate}/u.test(payload.content) || Buffer.byteLength(payload.content, 'utf8') > QQ_TEXT_BUDGET_BYTES
      || Object.keys(payload).some((key) => !['msg_type', 'content', 'to', 'messageId'].includes(key))) return outcome(false, 'qq_invalid_payload');
    const accessToken = await access();
    if (typeof accessToken !== 'string') return accessToken;
    // Outbound-only active message: no msg_id/event_id or interaction recall.
    const { status, data } = await request(`/v2/${targetType === 'user' ? 'users' : 'groups'}/${encodeURIComponent(targetId)}/messages`, { msg_type: 0, content: payload.content }, accessToken);
    const code = errorCode(data);
    if (Number.isFinite(code) && code !== 0 || [401, 403, 429].includes(status)) {
      const error = category(code, status);
      if (error === 'qq_authentication') token = null;
      return outcome(['qq_unknown', 'qq_provider_unavailable'].includes(error) ? undefined : false, error, status);
    }
    if (status === 200 && code === 0 && typeof data?.id === 'string' && data.id.trim() && typeof data?.timestamp === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(data.timestamp) && Number.isFinite(Date.parse(data.timestamp))) return outcome(true, 'accepted', status);
    // Lost/invalid/ambiguous send response cannot safely authorize another send.
    return outcome(undefined, status == null ? 'qq_network' : status >= 500 ? 'qq_provider_unavailable' : 'qq_response_ambiguous', status);
  };
}
