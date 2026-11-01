// Integrity runs inside Weekly, not as a separate daily job.
export const automationSetting = id => /^(radar\.enabled|weekly\.interval|integrity\.enabled|runtime\.mode|general\.profile)$/.test(id);
export const weeklyAutomationEnabled = owner => owner.profile !== 'radar' && owner.weekly?.enabled !== false;
export const automationEnabled = owner => ['desktop', 'web'].includes(owner.mode)
  && (weeklyAutomationEnabled(owner) || owner.common?.radar?.enabled === true);
export const schedulerConfig = enabled => ({ schemaVersion: 1, enabled, time: '15:00', timezone: 'Asia/Shanghai' });
