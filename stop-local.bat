@echo off
setlocal
set "ROOT=%~dp0"
set "PORT=3000"
set "PID_FILE=%ROOT%.twspk-local.pid"

if not exist "%PID_FILE%" (
  echo No TWSPK pid file was found.
  echo Start the server with start-local.bat, then stop it with this script.
  exit /b 0
)

set /p TARGET_PID=<"%PID_FILE%"
if not defined TARGET_PID (
  del "%PID_FILE%" >nul 2>nul
  echo TWSPK pid file was empty and has been removed.
  exit /b 0
)

set "LISTENING="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  if "%%P"=="%TARGET_PID%" set "LISTENING=1"
)

if not defined LISTENING (
  del "%PID_FILE%" >nul 2>nul
  echo Saved TWSPK process is not listening on port %PORT%.
  echo Removed stale pid file.
  exit /b 0
)

tasklist /FI "PID eq %TARGET_PID%" /FI "IMAGENAME eq node.exe" | findstr /I "node.exe" >nul 2>nul
if errorlevel 1 (
  echo Saved process is not node.exe. It was not stopped.
  exit /b 1
)

taskkill /PID %TARGET_PID% /T /F >nul 2>nul
if errorlevel 1 (
  echo Failed to stop TWSPK server process %TARGET_PID%.
  exit /b 1
)

del "%PID_FILE%" >nul 2>nul
echo Stopped TWSPK server process: %TARGET_PID%
exit /b 0
