@echo off
REM Runs the receiver in a visible console (use this the first time, so you can
REM see the phone URL and the access token). For silent autostart use start-hidden.vbs.
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" server\server.js
echo.
echo Server stopped.
pause
