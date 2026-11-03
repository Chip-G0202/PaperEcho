import { CHANNEL_IDS, channelConfiguration } from './channels.mjs';
import { normalizeNotificationPreferences } from '../lib/application_config.mjs';
export function emailDeliveryPolicy(event, options = {}) {
  return channelDeliveryPolicy('email', event, options);
}

export function qqChannelConfiguration({ config, env = {} } = {}) {
  return channelConfiguration('qq', { config, env });
}
// One business preference resolver. Existing preflight/transport owners retain
// provider readiness and fail-closed checks; explicit Test bypasses this policy.
export function channelDeliveryPolicy(channel, event, { config, env = {} } = {}) {
  config = normalizeNotificationPreferences(config);
  const selected = channel === 'email' ? config?.common?.email?.enabled ?? (env.PAPERECHO_EMAIL_ENABLED !== 'false')
    : CHANNEL_IDS.includes(channel) && channelConfiguration(channel, { config, env }).enabled === true;
  if (!selected) return { required: false, reason: 'channel_disabled' };
  const flag = { radar: 'PAPERECHO_NOTIFY_RADAR', weekly: 'PAPERECHO_NOTIFY_WEEKLY' }[event];
  const enabled = config?.common?.notifications?.[event]?.enabled ?? (flag ? env[flag] !== 'false' : true);
  return enabled ? { required: true, reason: 'delivery_required' } : { required: false, reason: 'notification_policy_disabled' };
}
