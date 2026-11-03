Option Explicit
Dim message
message = "PaperEcho could not start. Check the installed runtime, PowerShell 7 and workspace configuration."
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "PORT_OCCUPIED" Then message = "The local port is occupied by an unverified program. Close the conflicting program and retry."
  If WScript.Arguments(0) = "WORKBENCH_NOT_OWNED" Then message = "No background started by this entry was found. The desktop application was not stopped."
End If
CreateObject("WScript.Shell").Popup message, 10, "PaperEcho Browser Workbench", 16
