import path from 'node:path';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { scheduleSpec, scheduleDefinition, windowsArgument } from './os_scheduler.mjs';

export const taskOperations = Object.freeze(['register', 'query', 'enable', 'disable', 'update', 'run', 'delete']);
const fail = code => { throw new Error(code); };

// The native boundary accepts only the existing canonical schedule, never XML or
// an executable/argv supplied independently of that contract.
export function validateWindowsScheduleSpec(spec) {
  if (!spec || spec.platform !== 'win32') fail('SCHEDULER_WINDOWS_REQUIRED');
  const expected = scheduleSpec({ paths: { applicationRoot: spec.workingDirectory, userDataRoot: spec.userDataRoot,
    cacheRoot: spec.cacheRoot, layout: spec.layout }, platform: 'win32',
    config: { schemaVersion: 6, mode: spec.args?.[10], profile: spec.args?.[12],
      scheduler: { schemaVersion: 1, enabled: spec.enabled, time: '15:00', timezone: 'Asia/Shanghai' } } });
  if (!isDeepStrictEqual(spec, expected)) fail('SCHEDULER_SPEC_INVALID');
  return expected;
}

// Static PowerShell 7 code; request data arrives on stdin, never as shell code.
// Create and update are separate native flags, preventing accidental adoption.
const script = String.raw`
$ErrorActionPreference = 'Stop'
function Fail([string]$code) { throw $code }
function Missing($errorRecord) { return $errorRecord.Exception.GetBaseException().HResult -eq -2147024894 }
function Matches-Definition($task, $request) {
    $d = $task.Definition; $a = $d.Actions
    $trigger = if ($d.Triggers.Count -eq 1) { $d.Triggers.Item(1) } else { $null }
    $boundary = if ($trigger -and $trigger.Type -eq 2) { ([DateTimeOffset]::Parse($trigger.StartBoundary)).UtcDateTime } else { $null }
    $matches = $a.Count -eq 1 -and $a.Item(1).Type -eq 0 -and $a.Item(1).Path -ieq $request.executable -and $a.Item(1).Arguments -ceq $request.arguments -and $a.Item(1).WorkingDirectory -ieq $request.workingDirectory
    $matches = $matches -and $null -ne $boundary -and $boundary -eq ([DateTimeOffset]::Parse('2026-01-01T07:00:00Z')).UtcDateTime -and $trigger.DaysInterval -eq 1 -and $trigger.Enabled -eq $request.triggerEnabled
    $matches = $matches -and $d.Settings.MultipleInstances -eq 2 -and $d.Settings.StartWhenAvailable -and -not $d.Settings.WakeToRun -and -not $d.Settings.RunOnlyIfNetworkAvailable
    $matches = $matches -and -not $d.Settings.DisallowStartIfOnBatteries -and -not $d.Settings.StopIfGoingOnBatteries -and $d.Settings.ExecutionTimeLimit -eq 'PT0S'
    return [bool]$matches
}

try {
  if ($PSVersionTable.PSVersion.Major -lt 7) { Fail 'SCHEDULER_POWERSHELL_7_REQUIRED' }
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.schemaVersion -ne 1 -or $request.operation -notin @('register','query','enable','disable','update','run','delete')) { Fail 'SCHEDULER_ARGUMENT_INVALID' }
  if ($request.sandboxOnly) {
    if ($env:USERNAME -ine 'WDAGUtilityAccount' -or $env:USERPROFILE -ine 'C:\Users\WDAGUtilityAccount') { Fail 'SCHEDULER_SANDBOX_REQUIRED' }
    $computer = Get-CimInstance Win32_ComputerSystem
    if ($computer.Manufacturer -ine 'Microsoft Corporation' -or $computer.Model -ine 'Virtual Machine' -or (Get-Service CExecSvc).Status -ne 'Running') { Fail 'SCHEDULER_SANDBOX_REQUIRED' }
  }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($sid -eq 'S-1-5-18') { Fail 'SCHEDULER_SYSTEM_FORBIDDEN' }
  $name = $request.name
  if ($name -notmatch '^PaperEcho-(?:Sandbox-Test-)?[a-f0-9]{24}$') { Fail 'SCHEDULER_TASK_ID_INVALID' }
  $marker = 'PaperEcho scheduler v1 ' + $request.taskId
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  $folder = $null; $task = $null
  try { $folder = $service.GetFolder('\PaperEcho') } catch { if (-not (Missing $_)) { throw } }
  if (-not $folder -and $request.operation -eq 'register') {
    try { $folder = $service.GetFolder('\').CreateFolder('PaperEcho', $null) }
    catch { $folder = $service.GetFolder('\PaperEcho') }
  }
  if ($folder) {
    try { $task = $folder.GetTask($name) } catch { if (-not (Missing $_)) { throw } }
  }
  if ($task) {
    $principal = $task.Definition.Principal
    $actualSid = if ($principal.UserId -match '^S-1-') { $principal.UserId } else { ([Security.Principal.NTAccount]::new($principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($actualSid -ne $sid -or $principal.LogonType -ne 3 -or $principal.RunLevel -ne 0 -or $task.Definition.RegistrationInfo.Description -cne $marker) { Fail 'SCHEDULER_TASK_OWNERSHIP_MISMATCH' }
  }
  if ($task -and $request.operation -in @('run','enable') -and -not (Matches-Definition $task $request)) { Fail 'SCHEDULER_TASK_DEFINITION_MISMATCH' }
  if ($request.operation -eq 'register' -and $task) { Fail 'SCHEDULER_DUPLICATE_TASK' }
  if ($request.operation -notin @('register','query','delete') -and -not $task) { Fail 'SCHEDULER_TASK_NOT_FOUND' }
  if ($request.operation -in @('register','update')) {
    if ($task -and $task.GetInstances(0).Count -gt 0) { Fail 'SCHEDULER_TASK_RUNNING' }
    $definition = $service.NewTask(0)
    $definition.XmlText = $request.definition
    $definition.RegistrationInfo.Description = $marker
    $definition.RegistrationInfo.URI = '\PaperEcho\' + $name
    $definition.Principal.UserId = $sid
    $definition.Principal.LogonType = 3
    $definition.Principal.RunLevel = 0
    $flags = if ($request.operation -eq 'register') { 2 } else { 4 }
    $task = $folder.RegisterTaskDefinition($name, $definition, $flags, $sid, $null, 3, $null)
  } elseif ($request.operation -eq 'enable') { $task.Enabled = $true
  } elseif ($request.operation -eq 'disable') { $task.Enabled = $false
  } elseif ($request.operation -eq 'run') {
    if (-not $task.Enabled) { Fail 'SCHEDULER_TASK_DISABLED' }
    $null = $task.Run($null)
  } elseif ($request.operation -eq 'delete' -and $task) {
    if ($task.GetInstances(0).Count -gt 0) { Fail 'SCHEDULER_TASK_RUNNING' }
    $folder.DeleteTask($name, 0)
    try { $null = $folder.GetTask($name); Fail 'SCHEDULER_DELETE_UNCONFIRMED' } catch { if (-not (Missing $_)) { throw } }
    $task = $null
  }
  $report = @{schemaVersion=1;status='PASS';exists=($null -ne $task);operation=$request.operation;taskId=$request.taskId;osMutation=($request.operation -ne 'query')}
  if ($task) {
    $d = $task.Definition
    $report.definitionMatches = Matches-Definition $task $request
    $report.currentUser = $true; $report.leastPrivilege = $d.Principal.RunLevel -eq 0; $report.interactiveToken = $d.Principal.LogonType -eq 3
    $report.enabled = [bool]$task.Enabled; $report.state = [int]$task.State
    $report.runningInstances = [int]$task.GetInstances(0).Count
    $report.lastTaskResult = [long]$task.LastTaskResult
    $report.lastRunAt = $task.LastRunTime.ToUniversalTime().ToString('o')
    $report.missedRuns = [int]$task.NumberOfMissedRuns
  }
  [Console]::Out.Write(($report | ConvertTo-Json -Depth 4 -Compress))
} catch {
  $code = if ($_.Exception.Message -match '^SCHEDULER_[A-Z_]+$') { $_.Exception.Message } else { 'SCHEDULER_OS_OPERATION_FAILED' }
  [Console]::Out.Write((@{schemaVersion=1;status='FAIL';code=$code;hresult=$_.Exception.GetBaseException().HResult} | ConvertTo-Json -Compress))
  exit 1
}
`;

export class WindowsTaskScheduler {
  constructor({ env = process.env, sandboxOnly = false, transport } = {}) {
    this.env = env; this.sandboxOnly = sandboxOnly; this.transport = transport;
  }
  async execute(operation, input) {
    if (!taskOperations.includes(operation)) fail('SCHEDULER_ARGUMENT_INVALID');
    const spec = validateWindowsScheduleSpec(input);
    const name = (this.sandboxOnly ? 'PaperEcho-Sandbox-Test-' : 'PaperEcho-') + spec.taskId.slice('PaperEcho-'.length);
    // COM XmlText receives a UTF-16 BSTR; the downloadable UTF-8 template stays unchanged.
    const request = { schemaVersion: 1, operation, sandboxOnly: this.sandboxOnly, name, taskId: spec.taskId,
      triggerEnabled: spec.enabled, executable: spec.executable, arguments: spec.args.map(windowsArgument).join(' '), workingDirectory: spec.workingDirectory,
      ...(['register', 'update'].includes(operation) ? { definition: scheduleDefinition(spec).content.replace('encoding="UTF-8"', 'encoding="UTF-16"') } : {}) };
    let report;
    if (this.transport) report = await this.transport(request);
    else {
      if (process.platform !== 'win32') fail('SCHEDULER_WINDOWS_REQUIRED');
      const executable = this.env.PWSH_PATH;
      if (!executable || !path.isAbsolute(executable)) fail('SCHEDULER_POWERSHELL_PATH_REQUIRED');
      const env = { PATH: '' };
      for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'USERNAME', 'LOCALAPPDATA']) if (this.env[key]) env[key] = this.env[key];
      report = await new Promise((resolve, reject) => {
        const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64')], { env, windowsHide: true, timeout: 30000, maxBuffer: 16384 },
        (error, stdout) => {
          try {
            const value = JSON.parse(stdout);
            if (value.status !== 'PASS') throw Object.assign(new Error(/^SCHEDULER_[A-Z_]+$/.test(value.code) ? value.code : 'SCHEDULER_OS_OPERATION_FAILED'), { hresult: value.hresult });
            if (error) fail('SCHEDULER_OS_OPERATION_FAILED');
            resolve(value);
          } catch (cause) { reject(/^SCHEDULER_[A-Z_]+$/.test(cause.message) ? cause : new Error('SCHEDULER_OS_OPERATION_FAILED')); }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(request));
      });
    }
    if (report?.schemaVersion !== 1 || report.status !== 'PASS' || typeof report.exists !== 'boolean') fail('SCHEDULER_OS_RESPONSE_INVALID');
    if (report.exists && (!report.currentUser || !report.leastPrivilege || !report.interactiveToken)) fail('SCHEDULER_TASK_OWNERSHIP_MISMATCH');
    if (['register', 'update'].includes(operation) && (!report.exists || !report.definitionMatches || report.enabled !== spec.enabled)) fail('SCHEDULER_REGISTRATION_UNCONFIRMED');
    if (operation === 'delete' && report.exists) fail('SCHEDULER_DELETE_UNCONFIRMED');
    // Explicit projection; native XML, account names and paths never leave the adapter.
    const safe = { schemaVersion: 1, status: 'PASS', operation, taskId: spec.taskId, osMutation: operation !== 'query', exists: report.exists };
    for (const key of ['definitionMatches', 'currentUser', 'leastPrivilege', 'interactiveToken', 'enabled']) if (typeof report[key] === 'boolean') safe[key] = report[key];
    for (const key of ['state', 'runningInstances', 'lastTaskResult', 'missedRuns']) if (Number.isSafeInteger(report[key])) safe[key] = report[key];
    if (typeof report.lastRunAt === 'string' && Number.isFinite(Date.parse(report.lastRunAt))) safe.lastRunAt = report.lastRunAt;
    return safe;
  }
}
