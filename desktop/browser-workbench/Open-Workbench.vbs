Option Explicit
Dim fso, shell, folder, command, result, suffix, pwsh, app, bundled
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
suffix = ""
If LCase(fso.GetFileName(WScript.ScriptFullName)) = "stop-workbench.vbs" Then suffix = " -Stop"
pwsh = "pwsh.exe"
app = shell.ExpandEnvironmentStrings("%PAPERECHO_DESKTOP_APP%")
If app = "%PAPERECHO_DESKTOP_APP%" Then app = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\PaperEcho"
If LCase(fso.GetFileName(app)) = "paperecho.exe" Then app = fso.GetParentFolderName(app)
bundled = fso.BuildPath(app, "resources\powershell\pwsh.exe")
If fso.FileExists(bundled) Then pwsh = bundled
command = Chr(34) & pwsh & Chr(34) & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File " & Chr(34) & fso.BuildPath(folder, "Start-Workbench-Quiet.ps1") & Chr(34) & suffix
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  shell.Popup "PaperEcho requires PowerShell 7. No console window was opened.", 10, "PaperEcho Browser Workbench", 16
ElseIf result <> 0 Then
  shell.Popup "PaperEcho did not start or stop successfully. Check PowerShell 7 and the installed PaperEcho runtime.", 10, "PaperEcho Browser Workbench", 16
End If
