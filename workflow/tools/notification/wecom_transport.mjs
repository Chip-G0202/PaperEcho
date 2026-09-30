import { postNotificationJson, providerOutcome } from './http_transport.mjs';
export const validWecomWebhook = value => typeof value === 'string' && /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[A-Za-z0-9_-]{1,128}$/.test(value);
export function createWecomTransport({ webhookUrl }, options = {}) {
  return async payload => {
    const out = (accepted, category, code) => providerOutcome(accepted, category, code, 'wecom');
    if (!validWecomWebhook(webhookUrl)) return out(false, 'provider_configuration_invalid');
    const content = payload?.text?.content;
    if (payload?.msgtype !== 'text' || typeof content !== 'string' || !content.trim() || /\p{Surrogate}/u.test(content) || Buffer.byteLength(content) > 1800) return out(false, 'provider_payload_invalid');
    // No mentions, links, files, or arbitrary caller fields are forwarded.
    const { status, data } = await postNotificationJson(webhookUrl, { msgtype: 'text', text: { content } }, options);
    if (status === 200 && Number.isInteger(data?.errcode)) return out(data.errcode === 0, data.errcode === 0 ? 'accepted' : 'provider_rejected', status);
    if ([400,401,403,429].includes(status)) return out(false, status === 429 ? 'provider_rate_limited' : 'provider_rejected', status);
    return out(undefined, status === null ? 'provider_network' : 'provider_response_ambiguous', status);
  };
}
