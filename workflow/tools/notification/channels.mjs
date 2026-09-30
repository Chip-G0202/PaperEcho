import { renderQqNotification } from './qq_renderer.mjs';
import { createQqTransport } from './qq_transport.mjs';
import { renderWechatNotification } from './wechat_renderer.mjs';
import { createWxpusherTransport } from './wxpusher_transport.mjs';
export const CHANNEL_IDS = Object.freeze(['email', 'qq', 'wechat']);
export const CHANNEL_CREDENTIALS = Object.freeze({ qq: ['QQ_BOT_APP_SECRET'], wechat: ['WXPUSHER_APP_TOKEN'] });
export function channelConfiguration(channel, { config, env = {} } = {}) {
  if (config) return config.common?.notifications?.channels?.[channel] || { enabled: false };
  try { return JSON.parse(env[`PAPERECHO_${channel.toUpperCase()}_CHANNEL`] || '{"enabled":false}'); } catch { return { enabled: false }; }
}
export function channelRecipient(channel, value) { return channel === 'qq' ? `${value.targetType || ''}:${value.targetId || ''}` : value.uid || ''; }
export function renderChannelNotification(channel, content) {
  if (channel === 'qq') return renderQqNotification(content);
  if (channel === 'wechat') return renderWechatNotification(content);
  throw new Error('NOTIFICATION_CHANNEL_INVALID');
}
export function createChannelTransport(channel, value, env) {
  if (channel === 'qq') return createQqTransport({ ...value, clientSecret: env.QQ_BOT_APP_SECRET || '' });
  if (channel === 'wechat') return createWxpusherTransport({ ...value, appToken: env.WXPUSHER_APP_TOKEN || '' });
  throw new Error('NOTIFICATION_CHANNEL_INVALID');
}
