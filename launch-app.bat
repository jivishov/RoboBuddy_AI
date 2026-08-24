@echo off
setlocal

cd /d "%~dp0"

where py >nul 2>nul
if not errorlevel 1 (
  set "PYTHON_CMD=py -3"
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python 3 is required to launch RoboBuddy AI Lab.
    echo Install Python, then run this file again.
    pause
    exit /b 1
  )
  set "PYTHON_CMD=python"
)

set "PORT="
for /f %%P in ('powershell -NoProfile -Command "$used = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object LocalPort); 8080..8099 | Where-Object { $_ -notin $used } | Select-Object -First 1"') do set "PORT=%%P"

if not defined PORT (
  echo No available local port was found between 8080 and 8099.
  pause
  exit /b 1
)

set "APP_URL=http://127.0.0.1:%PORT%/lab-workbench.html?robot=openarm_v2_bimanual&task=openarm-01-weighing-handoff"

echo Launching the RoboBuddy AI Lab OpenArm workbench on local port %PORT%...
echo.
echo Keep this window open while using the app.
echo Press Ctrl+C to stop the local server.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Milliseconds 900; Start-Process '%APP_URL%'"
%PYTHON_CMD% -m http.server %PORT% --bind 127.0.0.1

endlocal
