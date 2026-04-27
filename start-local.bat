@echo off
setlocal
set "ROOT=%~dp0"
set "URL=http://localhost:3000"
set "PORT=3000"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js and make sure node is on PATH.
  pause
  exit /b 1
)

set "PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  set "PID=%%P"
  goto :port_checked
)
:port_checked

if defined PID (
  echo Local server is already running at %URL%.
  start "" "%URL%"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$root = (Resolve-Path '%ROOT%').Path; $pidFile = Join-Path $root '.twspk-local.pid'; $serverPath = Join-Path $root 'server.js'; $server = Start-Process node -ArgumentList @($serverPath) -WorkingDirectory $root -WindowStyle Hidden -PassThru; Set-Content -LiteralPath $pidFile -Value $server.Id -Encoding ASCII; Start-Sleep -Seconds 2; Start-Process '%URL%'"
if errorlevel 1 (
  echo Failed to start the local server.
  pause
  exit /b 1
)

echo TWSPK server is starting at %URL%.
echo Run stop-local.bat to stop it.
exit /b 0
