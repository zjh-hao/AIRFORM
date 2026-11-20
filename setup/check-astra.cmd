@echo off
setlocal
pushd "%~dp0.."
".venv\Scripts\python.exe" -m backend.astra.server --probe --frames 30 %*
set "result=%errorlevel%"
popd
exit /b %result%
