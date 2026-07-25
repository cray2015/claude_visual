' Starts the receiver with no console window. Put a shortcut to this file in
' shell:startup so it comes up with Windows.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run """C:\Program Files\nodejs\node.exe"" server\server.js", 0, False
