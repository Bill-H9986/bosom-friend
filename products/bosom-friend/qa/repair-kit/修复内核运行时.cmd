@echo off
rem Bosom Friend field repair kit - double-click entry point.
rem Keep this file ASCII-only: cmd.exe reads it with the OEM codepage (936 on Chinese Windows),
rem so a Chinese path written in here would not resolve.
setlocal
set "HERE=%~dp0"
if not exist "%HERE%run-repair.ps1" (
  echo [FAIL] run-repair.ps1 is missing next to this file - copy the whole kit folder again.
  echo.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%run-repair.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
if "%CODE%"=="0" (echo [OK] Repair finished.) else (echo [FAIL] Repair did not finish, exit code %CODE%.)
echo Press any key to close this window.
pause >nul
exit /b %CODE%
