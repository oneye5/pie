#Requires -Version 5.1
<#
.SYNOPSIS
  Bootstraps the pie portable coding-agent configuration on a new machine.

.DESCRIPTION
  1. Sets PI_CODING_AGENT_DIR as a user-level environment variable pointing to this repo.
  2. Migrates auth.json from the old default location (~/.pi/agent/) if it exists and
     no auth.json is already present in this repo.
  3. Migrates or merges legacy session history from the old default location
     (~/.pi/agent/sessions/) into this checkout's local git-ignored data/outcomes/sessions store,
     preserving conflicting copies in backup files when the source and destination differ.
  4. Validates Node.js and npm, then restores PI packages when the `pi` CLI is available.
  5. Runs `pi update` to reinstall any packages listed in settings.json.
  6. Builds and installs the pie VSCode extension from extension/.

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

function Assert-Command($name, $installHint) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "$name is required but was not found on PATH. $installHint"
  }

  return $cmd
}

function Write-Utf8NoBomFile($path, $content) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
}

function Test-DirectoryHasJsonlFiles($path, $recurse = $true) {
  if (-not (Test-Path $path -PathType Container)) {
    return $false
  }

  $files = if ($recurse) {
    Get-ChildItem -LiteralPath $path -Filter '*.jsonl' -File -Recurse -ErrorAction SilentlyContinue
  } else {
    Get-ChildItem -LiteralPath $path -Filter '*.jsonl' -File -ErrorAction SilentlyContinue
  }

  return $null -ne ($files | Select-Object -First 1)
}

function Resolve-ConfiguredSessionDir($value) {
  if (-not $value) {
    return $null
  }

  if ($value -eq '~') {
    return [Environment]::GetFolderPath('UserProfile')
  }

  if ($value.StartsWith('~/') -or $value.StartsWith('~\\')) {
    return Join-Path ([Environment]::GetFolderPath('UserProfile')) $value.Substring(2)
  }

  if ([System.IO.Path]::IsPathRooted($value)) {
    return $value
  }

  return $null
}

function Get-DefaultSessionBucketName($cwd) {
  $trimmed = $cwd -replace '^[\\/]+', ''
  $safePath = $trimmed -replace '[/\\:]', '-'
  return "--$safePath--"
}

function Get-SessionHeaderCwd($path) {
  foreach ($line in Get-Content -LiteralPath $path -ErrorAction SilentlyContinue) {
    $trimmed = $line.Trim()
    if (-not $trimmed) {
      continue
    }

    try {
      $entry = $trimmed | ConvertFrom-Json -ErrorAction Stop
      if ($entry.type -eq 'session' -and $entry.cwd) {
        return [string]$entry.cwd
      }
    } catch {
      return $null
    }
  }

  return $null
}

function Get-SessionContentTimestamp($path) {
  $lastTimestamp = $null

  Get-Content -LiteralPath $path -ErrorAction SilentlyContinue |
    ForEach-Object {
      $line = $_.Trim()
      if ($line) {
        try {
          $entry = $line | ConvertFrom-Json -ErrorAction Stop
          if ($entry.timestamp) {
            $entryTimestamp = [DateTime]$entry.timestamp
            if (-not $lastTimestamp -or $entryTimestamp -gt $lastTimestamp) {
              $lastTimestamp = $entryTimestamp
            }
          }
        } catch {
        }
      }
    }

  if ($lastTimestamp) {
    return $lastTimestamp.ToUniversalTime()
  }

  return (Get-Item -LiteralPath $path).LastWriteTimeUtc
}

function Merge-LegacySessionFiles($sourceDir, $destinationDir, $recurse = $true) {
  $copied = 0
  $updated = 0
  $identical = 0
  $backedUpConflicts = 0

  $sourceFiles = if ($recurse) {
    Get-ChildItem -LiteralPath $sourceDir -Filter '*.jsonl' -File -Recurse -ErrorAction SilentlyContinue
  } else {
    Get-ChildItem -LiteralPath $sourceDir -Filter '*.jsonl' -File -ErrorAction SilentlyContinue
  }

  $sourceFiles |
    ForEach-Object {
      $sourcePath = $_.FullName
      $sessionCwd = Get-SessionHeaderCwd $sourcePath
      $bucketPath = if ($sessionCwd) {
        Get-DefaultSessionBucketName $sessionCwd
      } else {
        '--unknown--'
      }
      $destinationPath = Join-Path (Join-Path $destinationDir $bucketPath) (Split-Path -Leaf $sourcePath)
      $destinationParent = Split-Path -Parent $destinationPath
      if ($destinationParent) {
        New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
      }

      if (-not (Test-Path $destinationPath)) {
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
        $copied++
      } else {
        $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
        $destinationHash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash
        if ($sourceHash -eq $destinationHash) {
          $identical++
        } else {
          $sourceTimestamp = Get-SessionContentTimestamp $sourcePath
          $destinationTimestamp = Get-SessionContentTimestamp $destinationPath
          if ($sourceTimestamp -gt $destinationTimestamp) {
            $backupPath = "$destinationPath.conflict.$([guid]::NewGuid().ToString('N')).bak"
            Copy-Item -LiteralPath $destinationPath -Destination $backupPath
            Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
            $updated++
            $backedUpConflicts++
          } else {
            $backupPath = "$destinationPath.conflict.$([guid]::NewGuid().ToString('N')).incoming.bak"
            Copy-Item -LiteralPath $sourcePath -Destination $backupPath
            $backedUpConflicts++
          }
        }
      }
    }

  return @{
    copied = $copied
    updated = $updated
    identical = $identical
    backedUpConflicts = $backedUpConflicts
  }
}

# Migrate auth.json from the old default location if needed
$oldAuth = Join-Path $env:USERPROFILE '.pi\agent\auth.json'
$newAuth = Join-Path $repoRoot 'auth.json'
if ((Test-Path $oldAuth) -and -not (Test-Path $newAuth)) {
  Write-Host "==> Migrating auth.json from '$oldAuth'"
  Copy-Item $oldAuth $newAuth
} elseif (Test-Path $newAuth) {
  Write-Host "==> auth.json already present in repo - skipping migration"
} else {
  Write-Host "==> No existing auth.json found - you will need to authenticate PI on first run"
}

# Migrate local session history from legacy locations if needed
$outcomesRoot = Join-Path $repoRoot 'data\outcomes'
$newSessions = Join-Path $outcomesRoot 'sessions'
$legacySessionImports = @()
$desiredSessionDir = 'data/outcomes/sessions'
$defaultLegacySessions = Join-Path $env:USERPROFILE '.pi\agent\sessions'
$legacyRepoLocalSessions = Join-Path $repoRoot 'data\sessions'
if (Test-DirectoryHasJsonlFiles $defaultLegacySessions) {
  $legacySessionImports += @{ source = $defaultLegacySessions; recurse = $true }
}
if (Test-DirectoryHasJsonlFiles $legacyRepoLocalSessions) {
  $legacySessionImports += @{ source = $legacyRepoLocalSessions; recurse = $true }
}

$settingsPath = Join-Path $repoRoot 'settings.json'
if (Test-Path $settingsPath) {
  try {
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -ErrorAction Stop
    $sessionDirProperty = $settings.PSObject.Properties['sessionDir']
    if ($sessionDirProperty) {
      $configuredSessionDir = [string]$sessionDirProperty.Value
      $resolvedConfiguredSessionDir = Resolve-ConfiguredSessionDir $configuredSessionDir
      $configuredSessionDirExists = $resolvedConfiguredSessionDir -and (Test-Path $resolvedConfiguredSessionDir -PathType Container)
      if ($configuredSessionDir -ne $desiredSessionDir) {
        $settingsBackupPath = "$settingsPath.session-dir.$([guid]::NewGuid().ToString('N')).bak"
        Copy-Item -LiteralPath $settingsPath -Destination $settingsBackupPath
        $settings.sessionDir = $desiredSessionDir
        Write-Utf8NoBomFile $settingsPath ($settings | ConvertTo-Json -Depth 100)
        Write-Host "==> Updated sessionDir in settings.json to '$desiredSessionDir'"
        Write-Host "==> Backed up the previous settings.json to '$settingsBackupPath'"
        if ($configuredSessionDirExists -and $resolvedConfiguredSessionDir -ne $newSessions) {
          $legacySessionImports += @{ source = $resolvedConfiguredSessionDir; recurse = $false }
          Write-Host "==> Will import legacy session history from configured sessionDir '$resolvedConfiguredSessionDir'"
        } elseif ($resolvedConfiguredSessionDir -and $resolvedConfiguredSessionDir -eq $newSessions) {
          Write-Host "==> sessionDir already points at '$desiredSessionDir'"
        } elseif (-not $resolvedConfiguredSessionDir) {
          Write-Warning "The previous sessionDir value '$configuredSessionDir' could not be resolved safely, so it was replaced with '$desiredSessionDir'."
        } else {
          Write-Host "==> configured sessionDir '$resolvedConfiguredSessionDir' has no session files to import"
        }
      }
    } else {
      $settingsBackupPath = "$settingsPath.session-dir.$([guid]::NewGuid().ToString('N')).bak"
      Copy-Item -LiteralPath $settingsPath -Destination $settingsBackupPath
      $settings | Add-Member -NotePropertyName 'sessionDir' -NotePropertyValue $desiredSessionDir
      Write-Utf8NoBomFile $settingsPath ($settings | ConvertTo-Json -Depth 100)
      Write-Host "==> Added sessionDir to settings.json so PI uses '$desiredSessionDir'"
      Write-Host "==> Backed up the previous settings.json to '$settingsBackupPath'"
    }
  } catch {
    Write-Warning "Failed to inspect settings.json for sessionDir overrides: $_"
  }
}

$sessionDirOverride = [System.Environment]::GetEnvironmentVariable('PI_CODING_AGENT_SESSION_DIR', [System.EnvironmentVariableTarget]::User)
if (-not $sessionDirOverride) {
  $sessionDirOverride = $env:PI_CODING_AGENT_SESSION_DIR
}
if ($sessionDirOverride) {
  Write-Warning "PI_CODING_AGENT_SESSION_DIR is set to '$sessionDirOverride'. Clear it if you want PI to keep using the local sessions directory at '$newSessions'."
}

$hasRepoSessions = Test-DirectoryHasJsonlFiles $newSessions
$resolvedNewSessions = if (Test-Path $newSessions -PathType Container) {
  (Resolve-Path $newSessions).Path
} else {
  [System.IO.Path]::GetFullPath($newSessions)
}
$normalizedLegacyImports = @()
$seenLegacyImports = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($legacyImport in $legacySessionImports) {
  $sourcePath = $legacyImport['source']
  $recurse = [bool]$legacyImport['recurse']
  if (-not (Test-Path $sourcePath -PathType Container)) {
    continue
  }

  $resolvedSourcePath = (Resolve-Path $sourcePath).Path
  $key = "$resolvedSourcePath|$recurse"
  if ($seenLegacyImports.Add($key)) {
    $normalizedLegacyImports += @{ source = $resolvedSourcePath; recurse = $recurse }
  }
}

if ($normalizedLegacyImports.Count -gt 0) {
  New-Item -ItemType Directory -Path $outcomesRoot -Force | Out-Null
  foreach ($legacyImport in $normalizedLegacyImports) {
    $legacySource = $legacyImport['source']
    $legacyRecurse = [bool]$legacyImport['recurse']
    if ($legacySource -eq $resolvedNewSessions) {
      Write-Host "==> session history already points at '$newSessions' - skipping migration"
      continue
    }

    $migrationVerb = if ($hasRepoSessions) { 'Merging' } else { 'Migrating' }
    Write-Host "==> $migrationVerb session history from '$legacySource' into '$newSessions'"
    New-Item -ItemType Directory -Path $newSessions -Force | Out-Null
    $importResult = Merge-LegacySessionFiles $legacySource $newSessions $legacyRecurse
    Write-Host (
      "==> Imported $($importResult.copied) new session file(s); refreshed $($importResult.updated) newer file(s); " +
      "preserved $($importResult.backedUpConflicts) conflicting backup file(s); skipped $($importResult.identical) identical file(s)"
    )
    $hasRepoSessions = Test-DirectoryHasJsonlFiles $newSessions
  }
} elseif ($hasRepoSessions) {
  Write-Host "==> session history already present in the local data/outcomes/sessions directory - no legacy migration needed"
} else {
  Write-Host "==> No existing session history found to migrate"
}

Write-Host "==> Validating prerequisites"
Assert-Command 'node' 'Install a standalone Node.js runtime first: https://nodejs.org/' | Out-Null
Assert-Command 'npm' 'Install npm together with Node.js: https://nodejs.org/' | Out-Null
$piCmd = Get-Command 'pi' -ErrorAction SilentlyContinue

# ── Relocate auth.json out of the working tree ─────────────────────────────────
# See docs/internal/SECRET_AND_STORAGE_RELOCATION_PLAN.md Phase 2.
$authDirEnv = [System.Environment]::GetEnvironmentVariable('PI_CODING_AGENT_AUTH_DIR', [System.EnvironmentVariableTarget]::User)
if (-not $authDirEnv) {
  $authDirEnv = $env:PI_CODING_AGENT_AUTH_DIR
}

$inTreeAuth = Join-Path $repoRoot 'auth.json'
$targetAuthDir = Join-Path $env:LOCALAPPDATA 'pie'
$targetAuth = Join-Path $targetAuthDir 'auth.json'

if ((Test-Path $inTreeAuth) -and -not $authDirEnv) {
  Write-Host ""
  Write-Host "==> SECURITY: auth.json is inside the working tree."
  Write-Host "    Target location: $targetAuth"
  $moveChoice = Read-Host "    Move auth.json to the secure OS user-data directory? [Y/n]"
  if ($moveChoice -eq '' -or $moveChoice -match '^[Yy]') {
    New-Item -ItemType Directory -Path $targetAuthDir -Force | Out-Null
    Copy-Item -LiteralPath $inTreeAuth -Destination $targetAuth -Force

    # Verify the copy
    $sourceHash = (Get-FileHash -LiteralPath $inTreeAuth -Algorithm SHA256).Hash
    $destHash = (Get-FileHash -LiteralPath $targetAuth -Algorithm SHA256).Hash
    if ($sourceHash -ne $destHash) {
      Remove-Item -LiteralPath $targetAuth -Force -ErrorAction SilentlyContinue
      Write-Warning "Hash verification failed after copy. auth.json was NOT moved."
    } else {
      # Restrict ACLs on the target file
      $acl = Get-Acl -LiteralPath $targetAuth
      $acl.SetAccessRuleProtection($true, $false)
      $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) } | Out-Null
      $userRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
        'FullControl',
        'Allow'
      )
      $acl.AddAccessRule($userRule)
      Set-Acl -LiteralPath $targetAuth -AclObject $acl

      # Set the environment variable persistently
      [System.Environment]::SetEnvironmentVariable(
        'PI_CODING_AGENT_AUTH_DIR',
        $targetAuthDir,
        [System.EnvironmentVariableTarget]::User
      )
      $env:PI_CODING_AGENT_AUTH_DIR = $targetAuthDir

      # Remove the in-tree file and leave a breadcrumb
      Remove-Item -LiteralPath $inTreeAuth -Force
      Write-Utf8NoBomFile (Join-Path $repoRoot 'auth.json.removed') "Relocated to: $targetAuth`nSee: docs/internal/SECRET_AND_STORAGE_RELOCATION_PLAN.md"
      Write-Host "==> auth.json moved to '$targetAuth' and PI_CODING_AGENT_AUTH_DIR set."
    }
  } else {
    Write-Warning "auth.json remains in the working tree. See SECURITY.md for recommended hardening."
  }
} elseif ((Test-Path $inTreeAuth) -and $authDirEnv) {
  Write-Warning "auth.json exists in the working tree AND PI_CODING_AGENT_AUTH_DIR is set to '$authDirEnv'. Consider removing the in-tree copy."
}

# Reinstall any packages listed in settings.json
if ($piCmd) {
  Write-Host "==> Running 'pi update' to restore packages from settings.json"
  pi update
} else {
  Write-Warning "'pi' command not found on PATH - install @mariozechner/pi-coding-agent globally first: npm install -g @mariozechner/pi-coding-agent"
}

Write-Host ""
Write-Host "Done. Open a new terminal so PI_CODING_AGENT_DIR takes effect, then run: pi"
if ($sessionDirOverride) {
  Write-Warning "PI_CODING_AGENT_SESSION_DIR is still overriding the local sessions directory at '$newSessions'. Clear it if you want history stored there by default."
} else {
  Write-Host "Session history is stored in local '$newSessions' (git-ignored)."
}

# Final summary of resolved paths
Write-Host ""
Write-Host "==> Resolved storage paths:"
$resolvedAuthDir = if ($env:PI_CODING_AGENT_AUTH_DIR) { $env:PI_CODING_AGENT_AUTH_DIR } else { $repoRoot }
Write-Host "    Auth:     $(Join-Path $resolvedAuthDir 'auth.json')"
Write-Host "    Sessions: $resolvedNewSessions"
Write-Host "Session JSONL contains raw transcripts, so treat it as sensitive local data rather than something to sync/commit by default."

# Build and install the pie VSCode extension
Write-Host ""
Write-Host "==> Building pie VSCode extension"
$extensionDir = Join-Path $repoRoot 'extension'

Push-Location $extensionDir
try {
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed in extension/" }

  npm run build
  if ($LASTEXITCODE -ne 0) { throw "build failed in extension/" }

  npm run package
  if ($LASTEXITCODE -ne 0) { throw "vsce package failed in extension/" }

  $packageManifest = Get-Content (Join-Path $extensionDir 'package.json') -Raw | ConvertFrom-Json
  $vsixPattern = "$($packageManifest.name)-*.vsix"
  $vsix = Get-ChildItem -Filter $vsixPattern | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($vsix) {
    # Use code.cmd (the CLI wrapper) rather than Code.exe (the GUI) for --install-extension
    $codeCli = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'
    if (-not (Test-Path $codeCli)) { $codeCli = 'code' }
    $legacyExtensionId = 'pi-config.pi-assistant'
    & $codeCli --uninstall-extension $legacyExtensionId *> $null
    Write-Host "==> Installing $($vsix.Name) into VSCode"
    & $codeCli --install-extension $vsix.FullName
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "code CLI failed - install manually: code --install-extension $($vsix.FullName)"
    }
  } else {
    Write-Warning "No .vsix found after packaging - check vsce output above"
  }
} catch {
  Write-Warning "Extension build failed: $_"
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "All done. Reload VSCode to activate the pie panel."
