<#
One-command updater for a TimeSphere installed by install.ps1 (the Docker Compose shape).

  .\update.cmd                 # update to the newest released tag (vX.Y.Z)
  .\update.cmd -To v1.2.3      # update to a specific release  (the .cmd launcher runs this file with a process-scoped execution-policy bypass)

Faithful port of update.sh — see that file for the full reasoning. The short version of the
guarantees, in order:
  1. A database backup exists BEFORE anything changes (kept in .\backups\ either way).
  2. The previous code ref is recorded, so "go back" is a checkout.
  3. After the rebuild, the same verification suite install.ps1 uses must pass.
  4. If verification fails, the script AUTOMATICALLY rolls the code back to the previous ref,
     rebuilds, and re-verifies — the run ends working on the old version, not broken on the new.

Rollback is CODE-ONLY on purpose: this project's migrations are additive-only (docs/DATABASE.md),
so old code runs correctly on a newer schema. The dump is never auto-restored — restoring over a
live database is the one step that can destroy data on a misdiagnosis, so it stays a human call.
#>
param(
  [string]$To = ""
)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Write-Step($Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Warn($Message) { Write-Host "[warn] $Message" -ForegroundColor Yellow }
function Write-Fail($Message) { Write-Host "[error] $Message" -ForegroundColor Red; exit 1 }

# -- Preconditions -----------------------------------------------------------------------------
if (-not (Test-Path ".env")) { Write-Fail "No .env here - this doesn't look like an installed deployment. Run .\install.cmd first." }
try { git rev-parse --git-dir | Out-Null } catch { Write-Fail "This directory isn't a git clone. Updates need one: git clone the repo, copy your .env in, run .\install.ps1 once - after that .\update.ps1 works." }
try { docker compose version | Out-Null } catch { Write-Fail "Docker Compose isn't available - is Docker Desktop running?" }

$ComposeFile = if (Select-String -Path ".env" -Pattern "^MYSQL_ROOT_PASSWORD=" -Quiet) { "docker-compose.yml" } else { "docker-compose.external-db.yml" }
Write-Step "Deployment shape: $ComposeFile"

if ((git status --porcelain | Measure-Object).Count -gt 0) {
  Write-Fail "This checkout has local modifications. Updating would checkout over them - stash or commit first (git status)."
}

# -- Proxy-attribution check --------------------------------------------------------------------
# TRUST_PROXY_HOPS has a default (0), so an .env written before it existed is not "broken" - it
# just quietly attributes every request to the proxy, which passes every check this script runs
# (health, migrations, login) while the login rate limiter is one shared bucket for the whole
# internet. EVERY compose deployment is at least one hop: apps/web/nginx.conf.template proxies /api to the
# api container. The HTTPS_DOMAIN/CADDYFILE signal only sharpens the recommended NUMBER.
$trustProxyMatch = [regex]::Match((Get-Content ".env" -Raw), "(?m)^TRUST_PROXY_HOPS=(.*)$")
$trustProxyValue = if ($trustProxyMatch.Success) { $trustProxyMatch.Groups[1].Value.Trim() } else { "" }
$ProxyWarned = ($trustProxyValue -eq "" -or $trustProxyValue -eq "0")
if ($ProxyWarned) {
  $suggestedHops = if (Select-String -Path ".env" -Pattern "^(HTTPS_DOMAIN|CADDYFILE)=.+" -Quiet) { 2 } else { 1 }
  $shown = if ($trustProxyValue -eq "") { "unset" } else { $trustProxyValue }
  Write-Warn "TRUST_PROXY_HOPS is $shown - this deployment sits behind a proxy."
  Write-Warn "  The web container's nginx proxies /api to the api container, so req.ip is nginx's"
  Write-Warn "  address for EVERY caller: the 20/min login limiter and every other per-IP limit are"
  Write-Warn "  currently one shared global bucket, and nothing logs that they are."
  Write-Warn "  Fix: put TRUST_PROXY_HOPS=$suggestedHops in .env and re-run this script (or restart the api"
  Write-Warn "  container). Add one more hop for anything else in front, e.g. Cloudflare."
  Write-Warn "  Not a blocker - this update continues. See docs/DEPLOYMENT.md."
}

# -- Resolve the target release ----------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($To)) {
  Write-Step "Fetching release tags..."
  git fetch --tags --quiet origin
  # Sort-Object with [version] orders 1.9 < 1.10 correctly, which string sorting does not.
  $tags = git tag --list "v*.*.*" | Where-Object { $_ -match "^v\d+\.\d+\.\d+$" }
  if (-not $tags) { Write-Fail "No release tags (vX.Y.Z) exist yet - nothing to update to." }
  $To = $tags | Sort-Object { [version]($_ -replace "^v", "") } | Select-Object -Last 1
}
git rev-parse -q --verify "refs/tags/$To" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Fail "Tag $To doesn't exist." }

$CurrentRef = (git rev-parse --short=12 HEAD).Trim()
$CurrentVersion = (Get-Content "VERSION" -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()
$TargetVersion = $To -replace "^v", ""

if ($CurrentVersion -eq $TargetVersion) { Write-Step "Already on $CurrentVersion - nothing to do."; exit 0 }
Write-Step "Updating: v$CurrentVersion ($CurrentRef) -> $To"

# -- 1. Backup FIRST ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force "backups" | Out-Null
$Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
$BackupFile = "backups\pre-update-$CurrentVersion-to-$TargetVersion-$Stamp.sql.gz"
if ($ComposeFile -eq "docker-compose.yml") {
  Write-Step "Backing up both databases to $BackupFile ..."
  # Credentials come from the container's own env - never parsed out of .env, so a hand-edited
  # quoting style can't corrupt the command.
  #
  # WHY THE DUMP IS WRITTEN INSIDE THE CONTAINER AND COPIED OUT, instead of piped into a file here
  # (a real restore hazard - do not "simplify" this back into a pipe): PowerShell decodes a native
  # command's stdout into .NET strings using the console encoding and re-emits it with its own line
  # endings, so `mysqldump | Out-File` REWROTE the dump rather than copying it - CRLFs, a possible
  # BOM, and any byte the active codepage could not round-trip replaced. Nothing complains until
  # restore day, which is the worst possible time to find out. `docker compose cp` writes the file
  # itself, so the bytes are never PowerShell's to touch. Gzipped and named .sql.gz to match
  # update.sh, so the same restore command works whichever script took the backup.
  $ContainerDump = "/tmp/timesphere-pre-update.sql.gz"
  $DumpCmd = 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --all-databases --single-transaction --no-tablespaces | gzip -c > ' + $ContainerDump
  docker compose -f $ComposeFile exec -T mysql sh -c $DumpCmd
  if ($LASTEXITCODE -ne 0) { Write-Fail "Backup failed - refusing to update without one. Is the mysql container running (docker compose ps)?" }
  docker compose -f $ComposeFile cp ("mysql:" + $ContainerDump) $BackupFile
  if ($LASTEXITCODE -ne 0) { Write-Fail "The dump was written inside the container but could not be copied to $BackupFile - refusing to update without a backup on disk." }
  docker compose -f $ComposeFile exec -T mysql rm -f $ContainerDump 2>&1 | Out-Null
  # The exit status above belongs to gzip, the last command in the container-side pipe, so a
  # mysqldump that died mid-write can still report success (update.sh has the same shape). A gzip
  # of nothing is a few dozen bytes, so a size floor catches exactly that case.
  $DumpSize = (Get-Item $BackupFile -ErrorAction SilentlyContinue).Length
  if (-not $DumpSize -or $DumpSize -lt 1024) { Write-Fail "Backup file $BackupFile is $DumpSize bytes - that is not a dump of both schemas. Refusing to update." }
} else {
  Write-Warn "External-database deployment: this script cannot reach into your MySQL server to back it up."
  Write-Warn "Take your own backup/snapshot NOW (RDS snapshot, mysqldump from a host that can reach it)."
  $confirm = Read-Host "Type 'backed-up' to confirm you have one"
  if ($confirm -ne "backed-up") { Write-Fail "Not updating without a backup. Nothing has changed." }
  $BackupFile = "(external - operator-managed)"
}
Write-Step "Backup ready: $BackupFile"

# -- 2-3. Checkout, rebuild, verify ------------------------------------------------------------
function Invoke-Verification([string]$Expected) {
  # Wait-ApiHealth is defined below; PowerShell resolves the call at invocation time, and every
  # caller of this function runs after both definitions.
  if (-not (Wait-ApiHealth)) { return $false }
  try {
    $v = (Invoke-WebRequest -Uri "http://localhost:4000/api/system/version" -UseBasicParsing -TimeoutSec 5).Content
    if ($v -notmatch "`"version`":`"$Expected`"") { return $false }
  } catch { return $false }
  docker compose -f $ComposeFile exec -T api npx prisma migrate status --schema=apps/api/prisma/schema.prisma | Out-Null
  if ($LASTEXITCODE -ne 0) { return $false }
  docker compose -f $ComposeFile exec -T api npx prisma migrate status --schema=apps/api/prisma/control/schema.prisma | Out-Null
  if ($LASTEXITCODE -ne 0) { return $false }
  # Advisory, matching install.ps1: missing face-detection models mean no camera guidance, but
  # they must never roll back an otherwise good update.
  try {
    Invoke-WebRequest -Uri "http://localhost:5173/human-models/blazeface.json" -UseBasicParsing -TimeoutSec 5 | Out-Null
  } catch {
    Write-Warn "Face-detection models are missing from the web image - camera guidance will be unavailable until it is rebuilt."
  }
  return $true
}

function Invoke-DeployRef([string]$Ref) {
  git checkout --quiet $Ref
  if ($LASTEXITCODE -ne 0) { Write-Fail "git checkout $Ref failed." }
  docker compose -f $ComposeFile up -d --build
}

function Wait-ApiHealth {
  for ($i = 0; $i -lt 60; $i++) {
    try { if ((Invoke-WebRequest -Uri "http://localhost:4000/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { return $true } } catch {}
    Start-Sleep -Seconds 3
  }
  return $false
}

# The one migration failure that rolling back cannot fix — see update.sh's function of the same
# name for the full reasoning. Short version: MySQL DDL is not transactional and Prisma does not
# roll back, so a migration that dies part way leaves its DDL applied while _prisma_migrations
# records it FAILED. Every later migrate deploy then refuses with P3009, including the one carrying
# the fix. Rolling the code back does not help — the OLD code's boot migration hits the same wall,
# so the deployment ends up stuck in a state neither a re-run nor a rollback can leave.
#
# doctor:heal clears it (migrate resolve --rolled-back, then migrate deploy) but only for a
# migration whose SQL is marked @rerunnable, i.e. one that guards its own DDL and is safe to replay
# over a partial application. It never runs 'prisma migrate reset', which drops the database.
#
# 'run --rm --no-deps' rather than 'exec': the api container is exactly what is NOT running, since
# its migrate-then-start chain never reached the server. --no-deps leaves the healthy mysql alone.
function Invoke-HealStrandedMigration {
  $logs = (docker compose -f $ComposeFile logs --tail=200 api 2>$null | Out-String)
  if ($logs -notmatch 'P3009' -and $logs -notmatch 'migrate found failed migrations') { return $false }
  Write-Warn "A migration is recorded as FAILED in _prisma_migrations (Prisma P3009) - no later migration can apply until that is cleared."
  Write-Step "Attempting doctor-led recovery (safe + re-runnable; only auto-repairs a migration marked @rerunnable)..."
  # `| Out-Host` rather than bare, and rather than `| Out-Null`: a native command's stdout inside a
  # function joins that function's OUTPUT STREAM, so leaving it bare would make this function return
  # docker's log lines followed by the boolean — and `if (Invoke-HealStrandedMigration)` would then
  # be true on a non-empty array even when the recovery failed. Out-Host shows the doctor's report
  # (which names the stranded migration, the reason to run it at all) while keeping it out of the
  # return value. Invoke-Verification above uses Out-Null for the same reason where output is noise.
  docker compose -f $ComposeFile run --rm --no-deps --entrypoint sh api -c 'npm run doctor:heal -w apps/api' | Out-Host
  if ($LASTEXITCODE -eq 0) {
    Write-Step "Recovery succeeded - restarting the api container."
    docker compose -f $ComposeFile up -d api | Out-Host
    return $true
  }
  Write-Warn "Automatic recovery did not succeed. The stranded migration is not marked @rerunnable, or the failure was something else."
  Write-Warn "Run this and read what it says - it names the migration and the exact commands:"
  Write-Warn "  docker compose -f $ComposeFile run --rm --no-deps --entrypoint sh api -c 'npm run doctor -w apps/api'"
  Write-Warn "Do NOT run 'prisma migrate reset' - Prisma's own error text suggests it, and it drops the database."
  return $false
}

Write-Step "Deploying $To (build + migrate + restart)..."
Invoke-DeployRef $To

# Container boot migrates the default org's database. Additional organizations provisioned after
# install each have their OWN database that boot never touches — migrate-all-tenants.ts walks the
# control-plane registry and brings every one to the latest migration. Fast no-op when there are
# none; skipping it would run new code against an old schema for any extra org. See update.sh.
#
# No per-release edit is ever needed here: the target is whatever getLatestMigrationName() reads
# off the CHECKED-OUT prisma/migrations directory, so 2.3.0's 20260808120000_mcp_server reaches
# every tenant through this same call without a line of this script changing.
# If the API never comes up, check for a stranded migration BEFORE going any further: a P3009
# caught here can usually be healed in place, turning a failed-and-rolled-back update into one that
# simply completes. The rollback further down is still the fallback if that does not work.
if (-not (Wait-ApiHealth)) {
  Write-Warn "The api container did not become healthy within 3 minutes."
  if (Invoke-HealStrandedMigration) {
    if (-not (Wait-ApiHealth)) { Write-Warn "Still not healthy after recovery - the rollback below will take over." }
  }
}
Write-Step "Migrating any additional tenant databases..."
docker compose -f $ComposeFile exec -T api npm run migrate:tenants -w apps/api
if ($LASTEXITCODE -ne 0) { Write-Warn "migrate:tenants reported a problem - check which org failed above; the default org is unaffected." }

Write-Step "Verifying the new version..."
if (Invoke-Verification $TargetVersion) {
  Write-Host "Updated to $To." -ForegroundColor Green
  Write-Step "Everyone with the app open will be offered a refresh automatically (the version rides on the health poll)."
  Write-Step "Database backup kept at: $BackupFile"
  # Repeated deliberately: the same warning was printed before a multi-minute docker build, which
  # is exactly how a warning stops being read. This is the last thing on screen instead.
  if ($ProxyWarned) { Write-Warn "Still to do: set TRUST_PROXY_HOPS in .env (see the warning near the start of this run)." }
  exit 0
}

# -- 4. Auto-rollback --------------------------------------------------------------------------
Write-Warn "Verification FAILED on $To - rolling back to $CurrentRef ..."
docker compose -f $ComposeFile logs --tail=80 api
Invoke-DeployRef $CurrentRef

if (Invoke-Verification $CurrentVersion) {
  Write-Warn "Rolled back: the deployment is running v$CurrentVersion again, unchanged."
  Write-Warn "The failed update's logs are above; the pre-update backup is at: $BackupFile"
  Write-Warn "Migrations are additive-only, so the newer schema under the old code is safe by policy."
  exit 1
}

# Both versions failed to verify. A stranded migration blocks the old code exactly as it blocked the
# new one, so name that check explicitly rather than leaving "manual attention needed" as the last word.
Write-Warn "Both versions failed to verify. The most common cause is a migration stranded mid-apply, which blocks the old code too:"
Write-Warn "  docker compose -f $ComposeFile run --rm --no-deps --entrypoint sh api -c 'npm run doctor -w apps/api'"
Write-Warn "That prints exactly which migration is stranded and how to clear it. Do NOT run 'prisma migrate reset'."
Write-Fail "Rollback verification ALSO failed - manual attention needed. Backup: $BackupFile ; logs: docker compose -f $ComposeFile logs api"
