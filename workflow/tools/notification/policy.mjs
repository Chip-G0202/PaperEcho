import { CHANNEL_IDS, channelConfiguration } from './channels.mjs';
// Business notification preferences are independent of Email connection settings.
export function emailDeliveryPolicy(event, { config, env = {} } = {}) {
  const channelEnabled = config?.common?.email?.enabled ?? (env.PAPERECHO_EMAIL_ENABLED !== 'false');
  if (!channelEnabled) return { required: false, reason: 'channel_disabled' };
  const flag = { radar: 'PAPERECHO_NOTIFY_RADAR', weekly: 'PAPERECHO_NOTIFY_WEEKLY' }[event];
  const enabled = config?.common?.notifications?.[event]?.enabled ?? (flag ? env[flag] !== 'false' : true);
  return enabled ? { required: true, reason: 'delivery_required' } : { required: false, reason: 'notification_policy_disabled' };
}

export function qqChannelConfiguration({ config, env = {} } = {}) {
  return channelConfiguration('qq', { config, env });
}
export function channelDeliveryPolicy(channel, event, options = {}) {
  if (channel === 'email') return emailDeliveryPolicy(event, options);
  if (!CHANNEL_IDS.includes(channel) || channelConfiguration(channel, options).enabled !== true) return { required: false, reason: 'channel_disabled' };
  const flag = { radar: 'PAPERECHO_NOTIFY_RADAR', weekly: 'PAPERECHO_NOTIFY_WEEKLY' }[event];
  const enabled = options.config?.common?.notifications?.[event]?.enabled ?? (flag ? options.env?.[flag] !== 'false' : true);
  return enabled ? { required: true, reason: 'delivery_required' } : { required: false, reason: 'notification_policy_disabled' };
}
