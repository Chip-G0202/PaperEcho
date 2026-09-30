import { renderQqNotification } from './qq_renderer.mjs';
import { createQqTransport } from './qq_transport.mjs';
import { renderWechatNotification } from './wechat_renderer.mjs';
import { createWxpusherTransport } from './wxpusher_transport.mjs';
import { createHash } from 'node:crypto';
import { renderFeishuNotification } from './feishu_renderer.mjs';
import { createFeishuTransport } from './feishu_transport.mjs';
export const CHANNEL_IDS = Object.freeze(['email', 'qq', 'wechat', 'feishu']);
export const CHANNEL_CREDENTIALS = Object.freeze({ qq: ['QQ_BOT_APP_SECRET'], wechat: ['WXPUSHER_APP_TOKEN'], feishu: ['FEISHU_WEBHOOK_URL', 'FEISHU_SIGNING_SECRET'] });
export function channelConfiguration(channel, { config, env = {} } = {}) {
  if (config) return config.common?.notifications?.channels?.[channel] || { enabled: false };
  try { return JSON.parse(env[`PAPERECHO_${channel.toUpperCase()}_CHANNEL`] || '{"enabled":false}'); } catch { return { enabled: false }; }
}
export function channelRecipient(channel, value, env = {}) {
  if (channel === 'qq') return `${value.targetType || ''}:${value.targetId || ''}`;
  if (channel === 'wechat') return value.uid || '';
  const url = env[CHANNEL_CREDENTIALS[channel]?.[0]];
  return url ? createHash('sha256').update(url).digest('hex') : '';
}
export function renderChannelNotification(channel, content) {
  if (channel === 'qq') return renderQqNotification(content);
  if (channel === 'wechat') return renderWechatNotification(content);
  if (channel === 'feishu') return renderFeishuNotification(content);
  throw new Error('NOTIFICATION_CHANNEL_INVALID');
}
export function createChannelTransport(channel, value, env) {
  if (channel === 'qq') return createQqTransport({ ...value, clientSecret: env.QQ_BOT_APP_SECRET || '' });
  if (channel === 'wechat') return createWxpusherTransport({ ...value, appToken: env.WXPUSHER_APP_TOKEN || '' });
  if (channel === 'feishu') return createFeishuTransport({ webhookUrl: env.FEISHU_WEBHOOK_URL || '', signingSecret: env.FEISHU_SIGNING_SECRET || '' });
  throw new Error('NOTIFICATION_CHANNEL_INVALID');
}
