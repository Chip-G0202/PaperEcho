import { createHmac } from 'node:crypto';
import { postNotificationJson, providerOutcome } from './http_transport.mjs';
// Exact official v2 URL; reject credentials, port, query, fragments and normalization tricks.
export const validFeishuWebhook = value => typeof value === 'string' && /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
export const validFeishuSigningSecret = value => typeof value === 'string' && value.length <= 512 && !/[\s\p{Surrogate}]/u.test(value);
export function createFeishuTransport({ webhookUrl, signingSecret = '' }, options = {}) {
  return async payload => {
    const out = (accepted, category, code) => providerOutcome(accepted, category, code, 'feishu');
    if (!validFeishuWebhook(webhookUrl) || !validFeishuSigningSecret(signingSecret)) return out(false, 'provider_configuration_invalid');
    const post = payload?.content?.post?.zh_cn;
    if (payload?.msg_type !== 'post' || typeof post?.title !== 'string' || !Array.isArray(post.content) || !post.content.length || !post.content.every(row => Array.isArray(row) && row.length && row.every(node => node?.tag === 'text' && typeof node.text === 'string' && !/\p{Surrogate}/u.test(node.text)))) return out(false, 'provider_payload_invalid');
    const body = { msg_type: 'post', content: { post: { zh_cn: { title: post.title, content: post.content.map(row => row.map(node => ({ tag: 'text', text: node.text }))) } } } };
    if (signingSecret) {
      body.timestamp = String(Math.floor((options.clock?.() || new Date()).getTime() / 1000));
      body.sign = createHmac('sha256', `${body.timestamp}\n${signingSecret}`).update('').digest('base64');
    }
    if (Buffer.byteLength(JSON.stringify(body)) > 16384) return out(false, 'provider_payload_invalid');
    const { status, data } = await postNotificationJson(webhookUrl, body, options);
    if (status === 200 && Number.isInteger(data?.code)) return out(data.code === 0, data.code === 0 ? 'accepted' : 'provider_rejected', status);
    if ([400,401,403,429].includes(status)) return out(false, status === 429 ? 'provider_rate_limited' : 'provider_rejected', status);
    return out(undefined, status === null ? 'provider_network' : 'provider_response_ambiguous', status);
  };
}
