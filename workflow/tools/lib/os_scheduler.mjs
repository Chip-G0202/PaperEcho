import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveRuntimePaths, prepareRuntimePaths, resolveApplicationRuntimeContext } from './runtime_config.mjs';
import { parseRunnerArgs } from '../runner/args.mjs';
import { resolveRunnerConfiguration, validateRunnerConfigObject } from '../runner/config_loader.mjs';
import { createControlServices } from './control_application_services.mjs';
import { SecretService } from './control_credentials_service.mjs';
import { loadDotEnv } from './env_file_bootstrap.mjs';
import { copyEnvironment } from './credential_registry.mjs';
import { selectScheduledDailyRun } from '../runner/scheduled_daily.mjs';

const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const safePath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f\u007f"%]/.test(value);
const fail = code => { throw new Error(code); };

// Windows native argv quoting (CreateProcess, never cmd/PowerShell). Always quote,
// including trailing backslashes; shell metacharacters remain ordinary argv bytes.
export function windowsArgument(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) fail('SCHEDULER_ARGUMENT_INVALID');
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

export function scheduleSpec({ paths, config, platform = process.platform, existingTaskIds = [] }) {
  validateRunnerConfigObject(config);
  if (!config?.scheduler || config.scheduler.schemaVersion !== 1 || typeof config.scheduler.enabled !== 'boolean'
    || config.scheduler.time !== '15:00' || config.scheduler.timezone !== 'Asia/Shanghai') fail('SCHEDULER_CONFIG_REQUIRED');
  if (!['desktop', 'web'].includes(config.mode) || !['standard', 'complete'].includes(config.profile || 'standard')) fail('SCHEDULER_MODE_UNSUPPORTED');
  if (!['portable', 'installed'].includes(paths.layout)) fail('SCHEDULER_PACKAGED_LAYOUT_REQUIRED');
  if (!['win32', 'darwin'].includes(platform)) fail('SCHEDULER_PLATFORM_UNSUPPORTED');
  const pathApi = platform === 'darwin' ? path.posix : path;
  if (![paths.applicationRoot, paths.userDataRoot, paths.cacheRoot].every(value => safePath(value) && (platform !== 'darwin' || path.posix.isAbsolute(value) && !value.includes('\\')))) fail('SCHEDULER_PATH_INVALID');
  if (platform === 'win32' && [paths.applicationRoot, paths.userDataRoot, paths.cacheRoot].some(value => !/^[A-Za-z]:[\\/]/.test(value))) fail('SCHEDULER_LOCAL_DRIVE_REQUIRED');
  const taskId = 'PaperEcho-' + createHash('sha256').update(platform === 'win32' ? paths.userDataRoot.toLowerCase() : paths.userDataRoot).digest('hex').slice(0, 24);
  if (existingTaskIds.includes(taskId)) fail('SCHEDULER_DUPLICATE_TASK');
  const executable = pathApi.join(paths.applicationRoot, platform === 'win32' ? 'PaperEcho.exe' : 'PaperEcho.app/Contents/MacOS/PaperEcho');
  const args = ['--headless', '--runtime-layout', paths.layout, '--user-data-root', paths.userDataRoot, '--cache-root', paths.cacheRoot,
    '--run', '--scheduled-daily', '--mode', config.mode, '--profile', config.profile || 'standard', '--fixed-mode'];
  parseRunnerArgs(args.slice(7), { allowUnresolvedMode: true });
  return { schemaVersion: 1, taskId, enabled: config.scheduler.enabled, platform, layout: paths.layout,
    time: '15:00', timezone: 'Asia/Shanghai', utcTime: '07:00', dst: 'fixed-zone-no-dst',
    missedRun: 'one-current-day-slot-only', duplicateTask: 'reject-no-overwrite', concurrentRun: 'ignore-new-and-runner-lease',
    identity: 'current-user-interactive-least-privilege', executable, args, workingDirectory: paths.applicationRoot,
    userDataRoot: paths.userDataRoot, cacheRoot: paths.cacheRoot };
}

export function scheduleDefinition(spec) {
  if (spec.platform === 'win32') return { format: 'task-scheduler-xml', registration: 'not-performed', content: `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><URI>\\PaperEcho\\${xml(spec.taskId)}</URI></RegistrationInfo>
<Triggers><CalendarTrigger><StartBoundary>2026-01-01T07:00:00Z</StartBoundary><Enabled>${spec.enabled}</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
<Principals><Principal id="CurrentUser"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><Enabled>${spec.enabled}</Enabled><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
<Actions Context="CurrentUser"><Exec><Command>${xml(spec.executable)}</Command><Arguments>${xml(spec.args.map(windowsArgument).join(' '))}</Arguments><WorkingDirectory>${xml(spec.workingDirectory)}</WorkingDirectory></Exec></Actions></Task>` };
  if (spec.platform !== 'darwin') fail('SCHEDULER_PLATFORM_UNSUPPORTED');
  // launchd calendar matching follows host timezone. Preflight requires Shanghai;
  // this is a LaunchAgent contract, never a system daemon or a loaded plist.
  return { format: 'launchagent-plist', registration: 'not-performed', content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${xml(spec.taskId)}</string><key>ProgramArguments</key><array>${[spec.executable, ...spec.args].map(x => `<string>${xml(x)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(spec.workingDirectory)}</string><key>Disabled</key><${spec.enabled ? 'false' : 'true'}/><key>StartCalendarInterval</key><dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>0</integer></dict><key>RunAtLoad</key><false/><key>KeepAlive</key><false/></dict></plist>` };
}

async function trustedFile(file, fsApi = fs) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (!(await fsApi.lstat(dir)).isDirectory()) fail('SCHEDULER_APPLICATION_UNSAFE');
    if (path.dirname(dir) === dir) break;
  }
  const stat = await fsApi.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('SCHEDULER_APPLICATION_UNSAFE');
  await fsApi.access(file);
}

// No OS mutation interface exists in Phase 5A. The only outputs are data.
export async function inspectOsSchedule({ env = process.env, applicationRoot, platform = process.platform, existingTaskIds = [], clock = () => new Date() } = {}) {
  const checks = []; let spec; let definition;
  const add = (id, status) => checks.push({ checkId: id, status });
  try {
    const paths = prepareRuntimePaths(resolveRuntimePaths({ applicationRoot, env }), { readOnly: true });
    env = copyEnvironment(env);
    await new SecretService({ root: paths.applicationRoot, env }).health();
    loadDotEnv({ env });
    const options = parseRunnerArgs(['--check', '--config', paths.configPath], { cwd: paths.userDataRoot, allowUnresolvedMode: true });
    const resolved = await resolveRunnerConfiguration(options, { cwd: paths.applicationRoot, env, readOnly: true });
    spec = scheduleSpec({ paths, config: { ...resolved.config, mode: resolved.options.mode, profile: resolved.options.profile }, platform, existingTaskIds });
    add('scheduler.contract', 'PASS');
    if (path.resolve(paths.resourceRoot) !== path.join(paths.applicationRoot, 'resources/core')) fail('SCHEDULER_RESOURCE_ROOT_UNTRUSTED');
    // Bind executable and required resources to the current Application Root.
    // Electron's patched fs presents app.asar as a virtual directory. Check the
    // physical archive and its link count, without changing global noAsar state.
    const physicalFs = process.versions.electron ? (await import('original-fs')).default.promises : fs;
    for (const file of [spec.executable, path.join(paths.applicationRoot, 'resources/app.asar'),
      path.join(paths.resourceRoot, 'desktop/electron-poc/headless.mjs'), path.join(paths.resourceRoot, 'workflow/tools/runner/main.mjs')]) await trustedFile(file, physicalFs);
    if (platform === 'win32') {
      const handle = await fs.open(spec.executable, 'r');
      try { const header = Buffer.alloc(2); await handle.read(header, 0, 2, 0); if (header.toString('ascii') !== 'MZ') fail('SCHEDULER_EXECUTABLE_INVALID'); }
      finally { await handle.close(); }
    }
    add('scheduler.application', 'PASS');
    const context = await resolveApplicationRuntimeContext({ cwd: paths.applicationRoot, env, readOnly: true });
    const services = createControlServices({ root: paths.applicationRoot, env, context });
    const doctor = await services.doctor.status();
    for (const check of doctor.checks.filter(c => c.blocking)) add(check.checkId, check.status === 'WARN' ? 'UNKNOWN' : check.status);
    const secrets = await services.secrets.health();
    add('scheduler.secretSource', secrets.credentials.some(c => c.configured && ['external-managed', 'unknown'].includes(c.storageClass)) ? 'UNKNOWN' : 'PASS');
    const state = await services.review.health();
    add('scheduler.lease', state.claim === 'absent' ? 'PASS' : state.claim === 'running' ? 'FAIL' : 'UNKNOWN');
    add('scheduler.recovery', state.recoveryPending || state.conflicts || ['failed', 'incomplete', 'interrupted', 'timed_out', 'running', 'unknown'].includes(state.lastRun) ? 'FAIL' : 'PASS');
    services.schedule.clock = clock;
    const schedule = await services.schedule.status();
    add('scheduler.claim', schedule.status === 'invalid' ? 'UNKNOWN' : schedule.status === 'recovery_required' || schedule.currentRun?.state === 'running' ? 'FAIL' : 'PASS');
    const scheduledOptions = parseRunnerArgs(spec.args.slice(7), { cwd: paths.userDataRoot });
    if (spec.enabled) {
      const selection = await selectScheduledDailyRun({ ...resolved, options: { ...resolved.options, ...scheduledOptions } }, { repoRoot: paths.resourceRoot, now: clock() });
      add('scheduler.runnerDecision', ['recovery_required', 'resume'].includes(selection.status) ? 'FAIL' : 'PASS');
    }
    if (platform === 'darwin') add('scheduler.platform', 'UNKNOWN');
    if (platform === 'darwin' && Intl.DateTimeFormat().resolvedOptions().timeZone !== spec.timezone) add('scheduler.hostTimezone', 'FAIL');
    // clock is only for deterministic report timestamps, never a workflow trigger.
    definition = scheduleDefinition(spec);
    return { schemaVersion: 1, status: checks.some(c => c.status === 'FAIL') ? 'FAIL' : checks.some(c => c.status === 'UNKNOWN') ? 'UNKNOWN' : 'PASS',
      checks, spec, definition, inspectedAt: clock().toISOString(), osMutation: false, registration: 'not-tested' };
  } catch (error) {
    const code = /^SCHEDULER_[A-Z_]+$/.test(error.message) ? error.message : 'SCHEDULER_INSPECTION_FAILED';
    return { schemaVersion: 1, status: 'FAIL', checks: [...checks, { checkId: code, status: 'FAIL' }], osMutation: false, registration: 'not-tested' };
  }
}
