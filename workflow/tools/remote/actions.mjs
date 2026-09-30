const COMMANDS = Object.freeze(['help', 'status', 'latest', 'radar', 'weekly']);
export function parseRemoteCommand(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 256 || /[\u0000-\u0008\u000b-\u001f\u007f]|\p{Surrogate}/u.test(text)) return { action: 'unsupported' };
  const command = text.trim();
  return COMMANDS.includes(command.slice(1)) && command.startsWith('/') ? { action: command.slice(1) } : { action: 'unsupported' };
}

// This owner has only read interfaces. No provider, workflow runner, mutation
// service, shell, path, URL or caller-controlled arguments enter dispatch.
export class RemoteActionService {
  constructor({ review, schedule }) { Object.assign(this, { review, schedule }); }
  async execute(action) {
    switch (action) {
      case 'help': return { kind: 'help' };
      case 'status': {
        const status = await this.review.status(); const schedule = await this.schedule.status();
        return { kind: 'status', lastRun: status.lastRun, lastRadar: status.lastRadar, lastWeekly: status.lastWeekly, pendingNotification: schedule.notification === 'pending' ? true : schedule.notification === 'completed' ? false : null, recoveryRequired: schedule.status === 'invalid' ? null : schedule.status === 'recovery_required' };
      }
      case 'latest': return { kind: 'latest', data: await this.review.latestLiteratureSummary() };
      case 'radar': return { kind: 'radar', data: await this.review.radarSummary() };
      case 'weekly': return { kind: 'weekly', data: await this.review.weeklySummary() };
      default: return { kind: 'unsupported' };
    }
  }
}

const clean = value => Array.from(String(value || '').replace(/\p{Surrogate}|[\u0000-\u001f\u007f]/gu, ' ').replace(/https?:\/\/\S+|[A-Za-z]:[\\/]\S+|\\\\\S+|(?:^|\s)\/\S+/g, ' [已隐藏]').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()).slice(0, 160).join('');
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value.slice(0, 10) : '暂无数据';
const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '暂无数据';
export function renderRemoteQqReply(result, redact = String) {
  let lines;
  if (result.kind === 'help') lines = ['PaperEcho 只读命令', '/help 帮助', '/status 状态', '/latest 最近文献', '/radar 最近速览', '/weekly 最近周报', '命令不接受参数；远程写操作未开放。'];
  else if (result.kind === 'status') lines = ['PaperEcho 状态', `最近任务：${date(result.lastRun?.at)} · ${({ completed: '完成', completed_with_warnings: '完成，有提醒', failed: '失败', running: '运行中', incomplete: '未完成' })[result.lastRun?.status] || '待确认'}`, `Radar：${date(result.lastRadar)}`, `周报：${date(result.lastWeekly)}`, `待恢复通知：${result.pendingNotification === true ? '有' : result.pendingNotification === false ? '无' : '待确认'}`, `任务恢复：${result.recoveryRequired === true ? '需本机检查' : result.recoveryRequired === false ? '未发现待恢复任务' : '待确认'}`];
  else if (['latest', 'radar', 'weekly'].includes(result.kind)) {
    const title = { latest: '最近文献', radar: '最近 Daily Radar', weekly: '最近周报' }[result.kind];
    lines = [`PaperEcho ${title}`];
    if (!result.data) lines.push('暂无数据');
    else if (result.kind === 'radar') lines.push(`日期：${date(result.data.at)}`, `候选：${count(result.data.candidateCount)}`, `重要推荐：${count(result.data.urgentCount)}`);
    else { if (result.data.at) lines.push(`日期：${date(result.data.at)}`); lines.push(`文献：${count(result.data.total)}`); for (const item of (result.data.items || []).slice(0, 3)) lines.push(clean(item.translatedTitle || item.translated_title || item.shortTitle || item.title) || '未提供标题'); }
  } else lines = [result.kind === 'failed' ? '暂时无法读取，请在本机检查。' : '仅支持 /help /status /latest /radar /weekly；请勿添加参数。'];
  // ponytail: immediate replies have a 1600-byte product budget; no splitting.
  let text = '';
  for (const char of Array.from(redact(lines.join('\n')))) { if (Buffer.byteLength(text + char, 'utf8') > 1600) break; text += char; }
  return text;
}

export class RemoteRateLimiter {
  constructor({ clock = () => Date.now(), windowMs = 60000, perUser = 6, global = 20 } = {}) { Object.assign(this, { clock, windowMs, perUser, global }); this.users = new Map(); this.startedAt = clock(); this.total = 0; }
  allow(user) {
    const now = this.clock();
    if (now - this.startedAt >= this.windowMs) { this.startedAt = now; this.total = 0; this.users.clear(); }
    if (this.total >= this.global || (this.users.get(user) || 0) >= this.perUser) return false;
    this.total++; this.users.set(user, (this.users.get(user) || 0) + 1); return true;
  }
}
