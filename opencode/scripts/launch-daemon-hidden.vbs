' launch-daemon-hidden.vbs
' Launches the agent-browser minimizer daemon fully hidden (window style 0).
' wscript.exe is a GUI application, so it never creates a console window.
' The daemon is WMI-created via ensure-via-cim.ps1, so it lives outside bun's
' job object and survives the parent process.
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Users\Administrator\.config\opencode\scripts\minimize-agent-browser.ps1""", 0, False
