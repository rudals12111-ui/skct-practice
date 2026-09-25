@echo off
setlocal
cd /d "%~dp0"
set "PS="
if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not defined PS for %%P in (pwsh.exe powershell.exe) do if not defined PS if not "%%~$PATH:P"=="" set "PS=%%~$PATH:P"
if not defined PS (
  echo PowerShell was not found. Close the "SKCT server" window to stop the server.
  pause
  exit /b
)
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" -Stop
if errorlevel 1 pause
