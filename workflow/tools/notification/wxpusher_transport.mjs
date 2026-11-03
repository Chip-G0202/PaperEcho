import { postNotificationJson, providerOutcome } from './http_transport.mjs';
import { WECHAT_PART_BYTES } from './wechat_renderer.mjs';
export const validWxUid = value => typeof value === 'string' && /^UID_[A-Za-z0-9]{1,128}$/.test(value);
export function createWxpusherTransport({ appToken, uid }, options = {}) {
  return async payload => {
    const out = (accepted, category, code) => providerOutcome(accepted, category, code, 'wxpusher');
    if (typeof appToken !== 'string' || !/^AT_[A-Za-z0-9]{1,200}$/.test(appToken) || !validWxUid(uid)) return out(false, 'provider_configuration_invalid');
    if (!payload || ![1, 2].includes(payload.contentType) || typeof payload.content !== 'string' || !payload.content.trim() || /\p{Surrogate}/u.test(payload.content) || Buffer.byteLength(payload.content) > WECHAT_PART_BYTES || typeof payload.summary !== 'string' || Array.from(payload.summary).length > 100) return out(false, 'provider_payload_invalid');
    const { status, data } = await postNotificationJson('https://wxpusher.zjiecode.com/api/send/message', { appToken, content: payload.content, contentType: payload.contentType, summary: payload.summary, uids: [uid], verifyPayType: 0 }, options);
    if (status === 200 && Number.isInteger(data?.code) && data.code !== 1000) return out(false, 'provider_rejected', status);
    if (status === 200 && data?.code === 1000 && data.success === true && Array.isArray(data.data) && data.data.length === 1) {
      const record = data.data[0];
      if (record.uid === uid && record.code === 1000 && Number.isSafeInteger(record.sendRecordId) && record.sendRecordId > 0) return { ...out(true, 'accepted', status), sendRecordIds: [record.sendRecordId] };
      if (record.uid === uid && Number.isInteger(record.code) && record.code !== 1000) return out(false, 'provider_rejected', status);
    }
    if ([400,401,403,429].includes(status)) return out(false, status === 429 ? 'provider_rate_limited' : 'provider_rejected', status);
    return out(undefined, status === null ? 'provider_network' : 'provider_response_ambiguous', status);
  };
}
