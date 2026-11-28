@echo off
setlocal
set "CFG=%CODEX_REMOTE_CONFIG%"
if "%CFG%"=="" set "CFG=%~dp0..\.agent-shim-codex-wsl-ssh.json"
"%~dp0codex-remote.exe" launch --config "%CFG%" -- %*
exit /b %ERRORLEVEL%
