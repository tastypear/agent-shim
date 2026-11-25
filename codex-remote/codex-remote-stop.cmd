@echo off
setlocal
set "CFG=%CODEX_REMOTE_CONFIG%"
if "%CFG%"=="" set "CFG=%~dp0..\.agent-shim-codex-wsl-ssh.json"
python "%~dp0rc_stop.py" --config "%CFG%" %*
endlocal