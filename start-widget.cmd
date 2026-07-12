@echo off
rem Start the Claude Usage Dashboard widget (hidden, no console window).
rem Double-click this file, or point a shortcut at it.
rem Run "npm install" once in this folder first.
cd /d "%~dp0"
if not exist "node_modules\.bin\electron.cmd" (
  echo Dependencies not installed. Running npm install ...
  call npm install
)
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath '%~dp0node_modules\.bin\electron.cmd' -ArgumentList '.' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
