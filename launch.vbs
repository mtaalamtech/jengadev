' JengaDev.exe is a console-subsystem binary (inherited from the bundled
' Node runtime pkg compiles it from), so Windows always allocates a visible
' console window for it - and since that window IS the process's console
' host, closing it kills the whole daemon. Launch it through here instead:
' WScript.Shell.Run with window style 0 (hidden) starts the child process
' with no console window at all, and this script's own process (wscript.exe)
' exits immediately after spawning it, so nothing stays open.
Dim objShell, fso, scriptDir, args, i

Set objShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

args = ""
For i = 0 To WScript.Arguments.Count - 1
    args = args & " " & WScript.Arguments(i)
Next

objShell.Run """" & scriptDir & "\JengaDev.exe""" & args, 0, False
