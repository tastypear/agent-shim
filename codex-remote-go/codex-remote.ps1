param(
  [string]$Config = $env:CODEX_REMOTE_CONFIG,
  [Parameter(ValueFromRemainingArguments = $true)] [string[]]$Rest
)

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $Config) { $Config = Join-Path (Split-Path -Parent $Here) ".agent-shim-codex-wsl-ssh.json" }

& (Join-Path $Here "codex-remote.exe") launch --config $Config -- @Rest
exit $LASTEXITCODE
