' Starts the spanish-vocab server with no console window. Used by the Startup shortcut.
Set sh = CreateObject("WScript.Shell")
root = "D:\agent\spanish-vocab"
sh.CurrentDirectory = root
sh.Run "cmd /c """"C:\Program Files\nodejs\node.exe"" ""server.js"" >> ""server.log"" 2>&1""", 0, False
