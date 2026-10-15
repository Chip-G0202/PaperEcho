import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Windows DACLs, not POSIX mode bits, protect credentials on NTFS. Unknown
// principals fail closed rather than removing an existing legitimate user's access.
const aclScript = `
$ErrorActionPreference = 'Stop'
try {
  if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'runtime' }
  $file = $env:PAPERECHO_CREDENTIAL_FILE
  $source = $env:PAPERECHO_CREDENTIAL_ACL_SOURCE
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = Get-Acl -LiteralPath $(if ($source) { $source } else { $file })
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  $trusted = @($identity.Value, $owner.Value, 'S-1-5-18', 'S-1-5-32-544')
  $broad = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-546', 'S-1-5-32-547', 'S-1-5-2', 'S-1-5-4', 'S-1-5-14')
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CredentialAccountType {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool LookupAccountSid(string system, byte[] sid, StringBuilder name, ref uint nameSize, StringBuilder domain, ref uint domainSize, out int type);
  public static bool IsUser(System.Security.Principal.SecurityIdentifier sid) {
    var bytes = new byte[sid.BinaryLength]; sid.GetBinaryForm(bytes, 0);
    uint n = 512, d = 512; int type;
    return LookupAccountSid(null, bytes, new StringBuilder(512), ref n, new StringBuilder(512), ref d, out type) && type == 1;
  }
}
'@
  foreach ($rule in $rules) {
    if ([CredentialAccountType]::IsUser($rule.IdentityReference)) { $trusted += $rule.IdentityReference.Value }
  }
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted -and $rule.IdentityReference.Value -notin $broad -and ($source -or -not $rule.IsInherited)) { throw 'unsupported principal' }
  }
  if ($env:PAPERECHO_CREDENTIAL_ACL_ACTION -eq 'secure') {
    $next = [System.Security.AccessControl.FileSecurity]::new()
    $next.SetOwner($owner)
    $next.SetAccessRuleProtection($true, $false)
    foreach ($rule in $rules) {
      if ($rule.IdentityReference.Value -in $trusted -or $rule.AccessControlType -eq 'Deny') {
        $next.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($rule.IdentityReference, $rule.FileSystemRights, $rule.AccessControlType))
      }
    }
    $next.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow'))
    Set-Acl -LiteralPath $file -AclObject $next
  }
  $final = Get-Acl -LiteralPath $file
  if (-not $final.AreAccessRulesProtected) { throw 'inherited permissions' }
  foreach ($rule in $final.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) { throw 'broad permissions' }
  }
  [Console]::Out.Write('secure')
} catch { [Console]::Error.Write('CREDENTIAL_ACL_UNSAFE'); exit 1 }
`;
export async function secureCredentialFile(file, { source = '', checkOnly = false } = {}) {
  if (process.platform !== 'win32') {
    if (!checkOnly) await fs.chmod(file, 0o600);
    if ((await fs.stat(file)).mode & 0o077) throw new Error('CREDENTIAL_ACL_UNSAFE');
    return;
  }
  const env = {};
  for (const name of ['SystemRoot', 'PATH', 'TEMP', 'TMP', 'USERPROFILE']) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, { PAPERECHO_CREDENTIAL_FILE: file, PAPERECHO_CREDENTIAL_ACL_SOURCE: source, PAPERECHO_CREDENTIAL_ACL_ACTION: checkOnly ? 'check' : 'secure' });
  try {
    const result = await promisify(execFile)(process.env.PWSH_PATH || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(aclScript, 'utf16le').toString('base64')], { env, windowsHide: true, timeout: 15000, maxBuffer: 1024 });
    if (result.stdout !== 'secure') throw new Error();
  } catch { throw new Error('CREDENTIAL_ACL_UNSAFE'); }
}
