@echo off
setlocal
cd /d "%~dp0"
rem Find PowerShell by full path first: some PCs have a PATH without System32.
set "PS="
if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not defined PS for %%P in (pwsh.exe powershell.exe) do if not defined PS if not "%%~$PATH:P"=="" set "PS=%%~$PATH:P"
if not defined PS goto nopowershell
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch.ps1" %*
if errorlevel 1 pause
exit /b

:nopowershell
rem Fallback without PowerShell: start the local server with Node directly.
set "NODE="
for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "NODE=%%~$PATH:N"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE (
  echo Node.js was not found. Install Node.js 20.16 or newer from https://nodejs.org and run START.cmd again.
  pause
  exit /b 1
)
echo PowerShell was not found. Starting the server directly with Node.
echo Keep the minimized "SKCT server" window open while you practice. Close it to stop the server.
start "SKCT server" /min "%NODE%" "%~dp0server.mjs"
"%SystemRoot%\System32\ping.exe" -n 3 127.0.0.1 >nul 2>nul
start "" "http://127.0.0.1:8787/"
exit /b
