Option Explicit
Dim shell, files, root, code, message
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count <> 0 Then
  MsgBox "Double-click PaperEcho.vbs without arguments.", 48, "PaperEcho"
  WScript.Quit 1
End If
shell.CurrentDirectory = root
On Error Resume Next
code = shell.Run("node.exe " & Chr(34) & root & "\workflow\tools\web\launcher.mjs" & Chr(34), 0, True)
If Err.Number <> 0 Then
  MsgBox "PaperEcho cannot start. Node.js was not found. Install/configure Node.js 18 or later, then try again. No runtime is downloaded automatically.", 16, "PaperEcho"
  WScript.Quit 2
End If
On Error GoTo 0
Select Case code
  Case 0: WScript.Quit 0
  Case 2: message = "Node.js 18 or later is required. Please install/configure Node.js."
  Case 3: message = "Port 8765 is occupied by another program or PaperEcho workspace. Close that instance first. No process was killed."
  Case 4: message = "Control Center did not become ready in time. Use PaperEcho.cmd for diagnostics."
  Case 6: message = "Control Center is ready, but the default browser could not open. Visit http://127.0.0.1:8765 manually."
  Case Else: message = "PaperEcho cannot start. Check Node.js 18+, project dependencies and configuration. Use PaperEcho.cmd for diagnostics."
End Select
MsgBox message, 16, "PaperEcho"
WScript.Quit code
