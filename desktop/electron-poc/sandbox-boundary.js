// Windows Script Host JScript: read-only guest identity probe, not product code.
// No PowerShell 5.1, installers, registry writes, task changes or system cleanup.
var fso = new ActiveXObject('Scripting.FileSystemObject');
var shell = new ActiveXObject('WScript.Shell');
var env = shell.Environment('PROCESS');
var input = 'C:\\PaperEchoLab\\Input', output = 'C:\\PaperEchoLab\\Output';
var checks = { guestUser: false, guestProfile: false, microsoftVirtualMachine: false,
  containerService: false, scriptLocation: false, mappedFolders: false };
var runId = '';
try {
  var stream = fso.OpenTextFile(input + '\\challenge.txt', 1, false);
  runId = stream.ReadAll(); stream.Close();
  if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('CHALLENGE_INVALID');
  checks.guestUser = String(env('USERNAME')).toLowerCase() === 'wdagutilityaccount';
  checks.guestProfile = String(env('USERPROFILE')).toLowerCase() === 'c:\\users\\wdagutilityaccount';
  checks.scriptLocation = String(WScript.ScriptFullName).toLowerCase() === (input + '\\boundary.js').toLowerCase();
  checks.mappedFolders = fso.FolderExists(input) && fso.FolderExists(output);
  var wmi = GetObject('winmgmts:\\\\.\\root\\cimv2');
  var computers = new Enumerator(wmi.ExecQuery('SELECT Manufacturer, Model FROM Win32_ComputerSystem'));
  for (; !computers.atEnd(); computers.moveNext()) {
    var computer = computers.item();
    checks.microsoftVirtualMachine = String(computer.Manufacturer).toLowerCase() === 'microsoft corporation'
      && String(computer.Model).toLowerCase() === 'virtual machine';
  }
  var services = new Enumerator(wmi.ExecQuery("SELECT State FROM Win32_Service WHERE Name='CExecSvc'"));
  for (; !services.atEnd(); services.moveNext()) checks.containerService = String(services.item().State).toLowerCase() === 'running';
} catch (e) { /* Incomplete identity stays BLOCKED; no raw WMI errors are exported. */ }
var ready = true, pairs = [];
for (var key in checks) { if (!checks[key]) ready = false; pairs.push('"' + key + '":' + (checks[key] ? 'true' : 'false')); }
// Only this fixed report is written to the deliberately writable output mapping.
// No guest code is ever read or executed from that mapping.
if (/^[a-f0-9-]{36}$/.test(runId) && checks.scriptLocation && fso.FolderExists(output)) {
  var report = fso.CreateTextFile(output + '\\boundary-result.json', false, false);
  report.Write('{"schemaVersion":1,"runId":"' + runId + '","stage":"SANDBOX_BOUNDARY","status":"'
    + (ready ? 'READY_FOR_TEST' : 'BLOCKED') + '","osModifications":0,"checks":{' + pairs.join(',') + '}}');
  report.Close();
}
WScript.Quit(ready ? 0 : 2);
