# Shared self-healing steps for install.ps1 and update.ps1 - the PowerShell twin of
# scripts/installer-heal.sh. Dot-sourced, never run: both scripts define Write-Step/Write-Warn/
# Write-Fail and Ask before sourcing this. Windows PowerShell 5.1 syntax only (install.cmd runs 5.1).
#
# Every function is NON-FATAL unless it says otherwise: a check that cannot run here (no network, not
# a git clone) lets the install continue, because an installer that dies on a missing helper is worse
# than one that skips the helper.

# `docker compose version` answers before Docker Desktop's engine is up - it is the client alone.
# `docker info` needs the engine. Wait for it instead of failing on a machine still starting Docker.
function Wait-DockerEngine {
  docker info *> $null
  if ($LASTEXITCODE -eq 0) { return }
  Write-Step "Docker is installed but its engine isn't answering yet - waiting up to 2 minutes for Docker Desktop to start..."
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 3
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { Write-Step "Docker engine is up."; return }
  }
  Write-Fail "The Docker engine never became ready. Start Docker Desktop, wait until it says it is running, and re-run."
}

# An image build needs a few GB and a backup needs room for the dump; running out half way leaves a
# half-built image or a truncated backup. FATAL below 2 GB free.
function Test-DiskSpace([string]$Purpose) {
  try {
    $drive = (Get-Item -LiteralPath (Get-Location).Path).PSDrive
    $freeGb = [math]::Floor($drive.Free / 1GB)
  } catch { return }
  if ($null -eq $drive.Free) { return }
  if ($drive.Free -lt 2GB) {
    Write-Fail "Only $freeGb GB free on $($drive.Name): - not enough for $Purpose. Free some space ('docker system prune -f' reclaims old images) and re-run."
  } elseif ($drive.Free -lt 5GB) {
    Write-Warn "Only $freeGb GB free on $($drive.Name): - $Purpose may run short. 'docker system prune -f' reclaims unused images."
  }
}

# A failed build is most often the network or a stale layer cache; both clear on a retry. Attempt 3
# rebuilds from scratch with fresh base images. FATAL after 3 attempts.
function Invoke-ComposeUpWithRetry([string]$File) {
  docker compose -f $File up -d --build
  if ($LASTEXITCODE -eq 0) { return }
  Write-Warn "Build/start failed (attempt 1/3) - usually a network hiccup. Retrying in 15s..."
  Start-Sleep -Seconds 15
  docker compose -f $File up -d --build
  if ($LASTEXITCODE -eq 0) { return }
  Write-Warn "Build/start failed again (attempt 2/3) - rebuilding from scratch with fresh base images (slower)..."
  docker compose -f $File build --pull --no-cache
  if ($LASTEXITCODE -eq 0) {
    docker compose -f $File up -d
    if ($LASTEXITCODE -eq 0) { return }
  }
  Write-Fail "The stack would not build after 3 attempts. The error is above; 'docker compose -f $File build' shows it again."
}

# Offer the newest release BEFORE installing, when this checkout sits exactly on an OLDER release tag
# and has no local changes. A branch is a deliberate choice and is left alone. Returns $true when it
# switched - the caller then re-runs the NEW installer and exits with its code.
function Invoke-NewestReleaseOffer {
  if ($env:TS_RELEASE_CHECKED -eq "1") { return $false }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return $false }
  git rev-parse --git-dir *> $null
  if ($LASTEXITCODE -ne 0) { return $false }
  $fetch = Start-Process git -ArgumentList "fetch", "--tags", "--quiet", "origin" -NoNewWindow -PassThru
  if (-not $fetch.WaitForExit(20000) -or $fetch.ExitCode -ne 0) {
    if (-not $fetch.HasExited) { $fetch.Kill() }
    Write-Warn "Couldn't reach the repository to check for a newer release - installing this checkout as it is."
    return $false
  }
  $tags = @(git tag --list "v[0-9]*.[0-9]*.[0-9]*" | Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } |
    Sort-Object { [version]($_.Substring(1)) })
  if ($tags.Count -eq 0) { return $false }
  $newest = $tags[-1]
  $current = (git describe --tags --exact-match HEAD 2> $null)
  if (-not $current) {
    Write-Step "Installing from $(git rev-parse --abbrev-ref HEAD) (not a release tag). The newest release is $newest."
    return $false
  }
  if ($current -eq $newest) { Write-Step "This checkout is the newest release ($newest)."; return $false }
  if ($current -notmatch '^v\d+\.\d+\.\d+$' -or [version]($current.Substring(1)) -gt [version]($newest.Substring(1))) { return $false }
  if (git status --porcelain --untracked-files=no) {
    Write-Warn "A newer release ($newest) exists, but this checkout has local changes - installing $current as it is."
    return $false
  }
  $answer = Ask "This checkout is $current; the newest release is $newest. Install $newest instead? [Y/n]" "Y"
  if ($answer -match '^[nN]') { Write-Step "Installing $current as asked."; return $false }
  git checkout --quiet $newest
  if ($LASTEXITCODE -ne 0) { Write-Warn "Couldn't switch to $newest - installing $current."; return $false }
  Write-Step "Switched to $newest - restarting the installer from the new version."
  $env:TS_RELEASE_CHECKED = "1"
  return $true
}
