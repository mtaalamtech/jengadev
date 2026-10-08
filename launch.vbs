' JengaDev.exe is a console-subsystem binary (inherited from the bundled
' Node runtime pkg compiles it from), so Windows always allocates a visible
' console window for it - and since that window IS the process's console
' host, closing it kills the whole daemon.
'
' This used to spawn it via WScript.Shell.Run, which goes through
' ShellExecute - measured ~2-3 seconds slower to actually start responding
' than a direct process launch, consistently, even with no mark-of-the-web
' on the exe. WMI's Win32_Process.Create calls CreateProcess directly,
' bypassing that shell-level overhead entirely, while still honoring a
' hidden window style via Win32_ProcessStartup.
Dim fso, scriptDir, args, i, strCommand
Dim objWMIService, objStartup, objProcess, intProcessID, intReturn

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

args = ""
For i = 0 To WScript.Arguments.Count - 1
    args = args & " " & WScript.Arguments(i)
Next

strCommand = """" & scriptDir & "\JengaDev.exe""" & args

Set objWMIService = GetObject("winmgmts:\\.\root\cimv2")
Set objStartup = objWMIService.Get("Win32_ProcessStartup").SpawnInstance_
objStartup.ShowWindow = 0 ' SW_HIDE

Set objProcess = objWMIService.Get("Win32_Process")
intReturn = objProcess.Create(strCommand, scriptDir, objStartup, intProcessID)
