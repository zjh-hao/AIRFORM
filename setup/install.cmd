@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo AIRFORM setup failed. Review the error above and run setup again.
  pause
  exit /b 1
)
echo AIRFORM Astra Python is ready. Open AIRFORM.html.
