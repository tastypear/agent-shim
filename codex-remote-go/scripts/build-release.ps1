param(
  [string]$Version = "1.0.0",
  [string]$OutDir = "dist"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  $targets = @(
    @{ OS = "windows"; Arch = "amd64"; Ext = ".exe" },
    @{ OS = "windows"; Arch = "arm64"; Ext = ".exe" },
    @{ OS = "linux";   Arch = "amd64"; Ext = "" },
    @{ OS = "linux";   Arch = "arm64"; Ext = "" },
    @{ OS = "darwin";  Arch = "amd64"; Ext = "" },
    @{ OS = "darwin";  Arch = "arm64"; Ext = "" }
  )

  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $env:GOTOOLCHAIN = "local"
  $env:CGO_ENABLED = "0"

  foreach ($t in $targets) {
    $name = "codex-remote-$($t.OS)-$($t.Arch)$($t.Ext)"
    $env:GOOS = $t.OS
    $env:GOARCH = $t.Arch
    Write-Host "building $name"
    go build -trimpath -buildvcs=false `
      -ldflags "-s -w -X main.version=$Version" `
      -o (Join-Path $OutDir $name) ./cmd/codex-remote
    if ($LASTEXITCODE -ne 0) {
      throw "go build failed for $name"
    }
  }
} finally {
  Pop-Location
}
