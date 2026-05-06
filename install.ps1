#Requires -Version 5.1
<#
.SYNOPSIS
  Bootstraps the pi-config portable coding-agent configuration on a new machine.

.DESCRIPTION
  1. Sets PI_CODING_AGENT_DIR as a user-level environment variable pointing to this repo.
  2. Migrates auth.json from the old default location (~/.pi/agent/) if it exists and
     no auth.json is already present in this repo.
  3. Installs @khimaros/pi-webui globally via npm (provides the drag-and-drop web UI).
  4. Runs `pi update` to reinstall any packages listed in settings.json.

.NOTES
  Run once after cloning the repo on a new machine:
    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
    .\install.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot

Write-Host "==> Setting PI_CODING_AGENT_DIR to '$repoRoot'"
[System.Environment]::SetEnvironmentVariable(
  'PI_CODING_AGENT_DIR',
  $repoRoot,
  [System.EnvironmentVariableTarget]::User
)
# Apply immediately for the current process too
$env:PI_CODING_AGENT_DIR = $repoRoot

# Migrate auth.json from the old default location if needed
$oldAuth = Join-Path $env:USERPROFILE '.pi\agent\auth.json'
$newAuth = Join-Path $repoRoot 'auth.json'
if ((Test-Path $oldAuth) -and -not (Test-Path $newAuth)) {
  Write-Host "==> Migrating auth.json from '$oldAuth'"
  Copy-Item $oldAuth $newAuth
} elseif (Test-Path $newAuth) {
  Write-Host "==> auth.json already present in repo — skipping migration"
} else {
  Write-Host "==> No existing auth.json found — you will need to authenticate PI on first run"
}

# Install pi-webui globally
Write-Host "==> Installing @khimaros/pi-webui via npm"
npm install -g @khimaros/pi-webui
if ($LASTEXITCODE -ne 0) {
  Write-Warning "npm install failed for @khimaros/pi-webui — install manually: npm install -g @khimaros/pi-webui"
}

# Reinstall any packages listed in settings.json
$piCmd = Get-Command pi -ErrorAction SilentlyContinue
if ($piCmd) {
  Write-Host "==> Running 'pi update' to restore packages from settings.json"
  pi update
} else {
  Write-Warning "'pi' command not found on PATH — install @mariozechner/pi-coding-agent globally first: npm install -g @mariozechner/pi-coding-agent"
}

Write-Host ""
Write-Host "Done. Open a new terminal so PI_CODING_AGENT_DIR takes effect, then run: pi"
