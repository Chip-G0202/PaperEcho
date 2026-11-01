import { resolveRuntimePaths, prepareRuntimePaths } from './runtime_config.mjs';
import { scheduleSpec, inspectOsSchedule } from './os_scheduler.mjs';
import { manageOsSchedule } from './os_scheduler_management.mjs';
import { WindowsTaskScheduler } from './windows_task_scheduler.mjs';
import { automationSetting, automationEnabled } from './automation_schedule_policy.mjs';

const queues = new Map();
const safeCode = error => /^SCHEDULER_[A-Z_]+$/.test(error?.message || '') ? error.message : 'SCHEDULER_SYNC_FAILED';
export class ControlAutomationService {
  constructor({ config, context, env, platform = process.platform, adapter, inspect = inspectOsSchedule, paths, timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
    Object.assign(this, { config, context, env, platform, adapter, inspect, paths, timezone });
  }
  async desired() {
    const record = await this.config.readOwnerOrTemplate('paperecho.config.json');
    const enabled = record.present && automationEnabled(record.value) && record.value.scheduler?.enabled !== false;
    const paths = this.paths || resolveRuntimePaths({ env: this.env, applicationRoot: this.env.PAPERECHO_APPLICATION_ROOT, platform: this.platform });
    if (!record.present || paths.layout === 'dev' || !['darwin', 'win32'].includes(this.platform)) return { enabled, unavailable: true };
    if (!this.paths) prepareRuntimePaths(paths, { readOnly: true });
    // A disabled/local workspace may still have a stale task. The probe can only
    // query/delete its own stable workspace identity, never register this fallback.
    const owner = record.value;
    const spec = scheduleSpec({ paths, platform: this.platform, config: { ...owner, schemaVersion: 6,
      mode: ['desktop', 'web'].includes(owner.mode) ? owner.mode : 'desktop',
      scheduler: { schemaVersion: 1, enabled, time: '15:00', timezone: 'Asia/Shanghai' } } });
    return { enabled, spec };
  }
  async native() {
    if (this.adapter) return this.adapter;
    if (this.platform === 'darwin') {
      const { MacLaunchAgent } = await import('./macos_launchagent.mjs');
      return new MacLaunchAgent();
    }
    return new WindowsTaskScheduler({ env: this.env });
  }
  project(query, desired) {
    if (this.platform === 'darwin' && !['loaded', 'installed-not-loaded', 'not-installed'].includes(query?.status)) throw new Error('SCHEDULER_QUERY_FAILED');
    const exists = this.platform === 'darwin' ? ['loaded', 'installed-not-loaded'].includes(query.status) : query.exists;
    const registered = exists && query.definitionMatches === true && (this.platform === 'darwin' ? query.status === 'loaded' : query.enabled === true);
    return { enabled: desired.enabled, state: desired.enabled ? registered ? 'registered' : 'unknown' : !exists ? 'disabled' : 'unknown',
      ...(exists ? { taskPresent: true } : { taskPresent: false }) };
  }
  async status() {
    try {
      const desired = await this.desired();
      if (desired.unavailable) return { enabled: desired.enabled, state: 'unknown', code: 'SCHEDULER_PACKAGED_LAYOUT_REQUIRED' };
      if (desired.enabled && this.platform === 'darwin' && this.timezone() !== 'Asia/Shanghai') return { enabled: true, state: 'failed', code: 'SCHEDULER_HOST_TIMEZONE_REQUIRED' };
      const result = this.project(await (await this.native()).execute('query', desired.spec), desired);
      if (result.state === 'unknown' && this.lastError) return { ...result, state: 'failed', code: this.lastError };
      return result;
    } catch (error) { return { state: 'unknown', code: safeCode(error) }; }
  }
  async changed(updates) {
    return (updates.some(({ id }) => automationSetting(id)) || this.lastError) ? this.reconcile() : undefined;
  }
  reconcile() {
    const key = this.config.configPath || this.config.root;
    const run = (queues.get(key) || Promise.resolve()).then(() => this.sync());
    queues.set(key, run);
    void run.finally(() => { if (queues.get(key) === run) queues.delete(key); });
    return run;
  }
  async sync() {
    try {
      let desired = await this.desired();
      if (desired.unavailable) return { enabled: desired.enabled, state: 'unknown', code: 'SCHEDULER_PACKAGED_LAYOUT_REQUIRED' };
      if (desired.enabled) {
        await this.config.ensureAutomationSchedule();
        desired = await this.desired();
      }
      const adapter = await this.native();
      const current = await adapter.execute('query', desired.spec);
      const state = this.project(current, desired);
      if (desired.enabled && this.platform === 'darwin' && this.timezone() !== 'Asia/Shanghai') {
        if (state.taskPresent) await adapter.execute('delete', desired.spec);
        throw new Error('SCHEDULER_HOST_TIMEZONE_REQUIRED');
      }
      if (!desired.enabled) {
        if (state.taskPresent) await adapter.execute('delete', desired.spec);
      } else if (state.state !== 'registered') {
        // Reuse all existing readiness, credential, lease and recovery guards.
        const report = await this.inspect({ env: this.env, applicationRoot: this.env.PAPERECHO_APPLICATION_ROOT });
        if (report.checks?.some(check => check.checkId === 'scheduler.hostTimezone' && check.status === 'FAIL')) throw new Error('SCHEDULER_HOST_TIMEZONE_REQUIRED');
        await manageOsSchedule(state.taskPresent ? 'update' : 'register', {
          env: this.env, applicationRoot: this.env.PAPERECHO_APPLICATION_ROOT,
          adapter, inspect: async () => report,
        });
      }
      const confirmed = this.project(await adapter.execute('query', desired.spec), desired);
      if (!['registered', 'disabled'].includes(confirmed.state)) throw new Error('SCHEDULER_REGISTRATION_UNCONFIRMED');
      this.lastError = null;
      return confirmed;
    } catch (error) {
      this.lastError = safeCode(error);
      return { state: 'failed', code: this.lastError };
    }
  }
}
