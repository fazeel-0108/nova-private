' Nova — auto-start at Windows login (laptop hands-free).
' Double-click install to add Nova to your Startup folder.
' What happens at every login:
'   1. Local server starts hidden (python serve.py)
'   2. Nova opens in Chrome app mode (--app = no address bar, feels native)
'   3. Hands-free auto-starts with the app (Settings toggle)
'
' To uninstall: delete Nova.lnk + nova-server.lnk from
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

novaDir = fso.GetParentFolderName(fso.GetAbsolutePathName("."))
startup = shell.SpecialFolders("Startup")

' 1) Hidden server launcher
batPath = novaDir & "\nova-server.bat"
Set bat = fso.CreateTextFile(batPath, True)
bat.WriteLine "@echo off"
bat.WriteLine "cd /d """ & novaDir & """"
bat.WriteLine "start """" /min python serve.py"
bat.Close

' Shortcut to the server bat in Startup
Set lnk = shell.CreateShortcut(startup & "\Nova Server.lnk")
lnk.TargetPath = "wscript.exe"
lnk.Arguments = """" & novaDir & "\nova-server-silent.vbs"""
lnk.WorkingDirectory = novaDir
lnk.Description = "Nova background server"
lnk.Save

' 2) Silent VBS wrapper for the server (no console window)
Set vbs = fso.CreateTextFile(novaDir & "\nova-server-silent.vbs", True)
vbs.WriteLine "Set sh = CreateObject(""WScript.Shell"")"
vbs.WriteLine "sh.Run ""cmd /c cd /d """ & novaDir & """ && start """" /min python serve.py""", 0, False"
vbs.Close

' 3) Chrome app-mode shortcut for Nova (also in Startup so it opens at login)
chromePaths = Array( _
  shell.ExpandEnvironmentStrings("%ProgramFiles%\Google\Chrome\Application\chrome.exe"), _
  shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"), _
  shell.ExpandEnvironmentStrings("%LocalAppData%\Google\Chrome\Application\chrome.exe"))
chrome = ""
For Each p In chromePaths
  If fso.FileExists(p) Then chrome = p : Exit For
Next

If chrome <> "" Then
  Set lnk2 = shell.CreateShortcut(startup & "\Nova.lnk")
  lnk2.TargetPath = chrome
  lnk2.Arguments = "--app=http://localhost:8080"
  lnk2.WorkingDirectory = novaDir
  lnk2.Description = "Nova Assistant"
  lnk2.Save
  MsgBox "Nova installed! At every login:" & vbCrLf & _
         "  • server starts hidden" & vbCrLf & _
         "  • Nova opens in app mode" & vbCrLf & _
         "  • hands-free wakes automatically" & vbCrLf & vbCrLf & _
         "Say ""Nova"" after login — that's it.", 64, "Nova"
Else
  MsgBox "Chrome not found — server shortcut installed; add Nova manually.", 48, "Nova"
End If
