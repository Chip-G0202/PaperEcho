import { CHANNEL_IDS, channelConfiguration } from './channels.mjs';
function selectedForEvent(channel, event, { config, env = {} }) {
  try {
    const selected = config ? config.common?.notifications?.[event]?.channels : JSON.parse(env[`PAPERECHO_NOTIFY_${event.toUpperCase()}_CHANNELS`] || 'null');
    return selected == null || Array.isArray(selected) && selected.every(id => CHANNEL_IDS.includes(id)) && selected.includes(channel);
  } catch { return false; }
}
// Business notification preferences are independent of Email connection settings.
export function emailDeliveryPolicy(event, { config, env = {} } = {}) {
  const channelEnabled = config?.common?.email?.enabled ?? (env.PAPERECHO_EMAIL_ENABLED !== 'false');
  if (!channelEnabled) return { required: false, reason: 'channel_disabled' };
  if (!selectedForEvent('email', event, { config, env })) return { required: false, reason: 'notification_policy_disabled' };
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
  if (!selectedForEvent(channel, event, options)) return { required: false, reason: 'notification_policy_disabled' };
  const flag = { radar: 'PAPERECHO_NOTIFY_RADAR', weekly: 'PAPERECHO_NOTIFY_WEEKLY' }[event];
  const enabled = options.config?.common?.notifications?.[event]?.enabled ?? (flag ? options.env?.[flag] !== 'false' : true);
  return enabled ? { required: true, reason: 'delivery_required' } : { required: false, reason: 'notification_policy_disabled' };
}
