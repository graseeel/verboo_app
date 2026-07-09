#!/usr/bin/env pwsh
# Windows x64 preflight checks for Verboo Code packaging.
# Runs on Windows to verify the build environment is ready.

$ErrorActionPreference = 'Stop'

Write-Host 'Verboo Code — Windows x64 preflight'

# 1. Verify Node.js is available
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Node.js is not installed or not on PATH. Install from https://nodejs.org/'
  exit 1
}

$nodeVersion = (node --version)
Write-Host "  Node.js: $nodeVersion"

# 2. Verify npm is available
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error 'npm is not installed or not on PATH.'
  exit 1
}

$npmVersion = (npm --version)
Write-Host "  npm: $npmVersion"

# 3. Verify git is available (Tauri build uses it for version detection)
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Warning 'git is not installed or not on PATH. Some build features may not work.'
} else {
  $gitVersion = (git --version)
  Write-Host "  git: $gitVersion"
}

# 4. Verify Windows version (Windows 10 1809+ required for ConPTY)
$osVersion = [System.Environment]::OSVersion.Version
if ($osVersion.Major -lt 10 -or ($osVersion.Major -eq 10 -and $osVersion.Build -lt 17763)) {
  Write-Error 'Windows 10 1809 (build 17763) or later is required for ConPTY support.'
  exit 1
}
Write-Host "  Windows build: $($osVersion.Build)"

# 5. Verify no Verboo Code processes are running (would block installer)
$verbooProcesses = Get-Process -Name 'Verboo Code*' -ErrorAction SilentlyContinue
if ($verbooProcesses) {
  Write-Error 'Verboo Code is still running. Close it before packaging.'
  $verbooProcesses | Format-Table Id, ProcessName
  exit 1
}

Write-Host 'Windows preflight passed.'
