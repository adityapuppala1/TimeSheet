<#
.SYNOPSIS
  One-click installer for TimeSphere's on-prem/single-org Docker Compose shape (see
  docs/DEPLOYMENT.md's "Shape 1"). Native PowerShell - no Node required just to bootstrap.

.DESCRIPTION
  Checks Docker/Compose are present, generates a root .env (the file docker-compose.yml reads
  its variables from) with strong random secrets if one doesn't already exist, brings the stack
  up, waits for the API's health check, then runs the one-time seed.

  Deliberately does NOT install Docker Desktop itself, touch anything outside this repo, or
  overwrite an existing .env -re-running this script against an already-configured deployment
  just brings the stack up again.

  No new required .env keys have been added by recent feature work (Kanban swimlanes, org-chart,
  manual ticket-to-branch/PR linking, VAPT report upload, mobile card-view fallbacks) - every one
  of those reads from the same DATABASE_URL this script already provisions, via the migrations
  that run automatically on container boot. Nothing in this script needs to change to pick them
  up.
#>

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $RootDir

function Write-Step($Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Warn($Message) { Write-Host "[warn] $Message" -ForegroundColor Yellow }
function Write-Fail($Message) { Write-Host "[error] $Message" -ForegroundColor Red; exit 1 }

# Non-interactive mode: $env:TS_AUTO = "1" answers every prompt with its default (bundled Docker
# MySQL, localhost URLs, no SMTP). Mirrors install.sh's TS_AUTO — exists for CI and fleet scripts.
$Auto = ($env:TS_AUTO -eq "1")
function Ask($Prompt, $Default) {
  if ($Auto) { return $Default }
  $reply = Read-Host $Prompt
  if ([string]::IsNullOrWhiteSpace($reply)) { return $Default } else { return $reply }
}

Write-Step "Checking for Docker..."
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCmd) {
  Write-Warn "Docker isn't installed. Suggested: winget install --id Docker.DockerDesktop -e"
  $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
  if ($wingetCmd) {
    $autoInstall = Ask "Attempt to auto-install Docker Desktop now via winget? [y/N]" "N"
    if ($autoInstall -match '^[Yy]$') {
      Write-Step "Running: winget install --id Docker.DockerDesktop -e"
      winget install --id Docker.DockerDesktop -e
      Write-Warn "Docker Desktop was installed — it needs to finish first-run setup (and usually a reboot) before 'docker' works from a terminal. Re-run this script after that."
      exit 0
    }
  }
  Write-Fail "Install Docker Desktop (https://docs.docker.com/desktop/install/windows-install/), then re-run this script."
}
try { docker compose version | Out-Null } catch {
  Write-Fail "Couldn't run 'docker compose'. Most likely cause: Docker Desktop is installed but not running yet — start it from the Start menu and wait for it to say `"Docker Desktop is running`" before re-running this script. If it IS running, your Docker Desktop version may be old enough to lack the Compose plugin — update it."
}
Write-Host "Docker with Compose plugin found."

# Self-heal check: an existing .env from an older version of this script, or one hand-edited
# and accidentally missing a line, gets diagnosed here instead of failing opaquely inside
# Compose (docker-compose.yml's `api` service uses ${VAR:?error} syntax for these - no default).
$RequiredKeys = @("DATABASE_URL", "CONTROL_DATABASE_URL", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "PLATFORM_ADMIN_JWT_SECRET", "ENCRYPTION_KEY", "WEB_ORIGIN", "APP_BASE_URL")

function New-RandomBase64([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToBase64String($buffer)
}

function New-RandomHex32() {
  $buffer = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return ($buffer | ForEach-Object { $_.ToString("x2") }) -join ""
}

function UrlEncode([string]$Value) { [System.Uri]::EscapeDataString($Value) }

$EnvFile = Join-Path $RootDir ".env"
if (Test-Path $EnvFile) {
  Write-Step ".env already exists - checking it has every required key (self-heal check, values are never modified)..."
  $envText = Get-Content $EnvFile -Raw
  $missingKeys = $RequiredKeys | Where-Object { $envText -notmatch "(?m)^$_=" }
  if ($missingKeys.Count -gt 0) {
    Write-Warn ".env is missing: $($missingKeys -join ', ')"
    Write-Warn "This usually means an old .env predates a key this version of docker-compose.yml now requires."
    Write-Warn "Fix: either add the missing key(s) yourself (see .env.example), or delete .env and re-run this script to regenerate it fresh."
    Write-Fail "Refusing to start the stack with an incomplete .env - see the missing keys above."
  }
  Write-Step ".env has every required key - leaving it as-is. Delete it first if you want fresh generated secrets."
  # MYSQL_ROOT_PASSWORD only ever gets written when a previous run chose the bundled-Docker-MySQL
  # path (see the else branch below) - its absence is exactly how a re-run recognizes "this
  # deployment uses its own external MySQL server" without asking again.
  $ComposeFile = if ($envText -match "(?m)^MYSQL_ROOT_PASSWORD=") { "docker-compose.yml" } else { "docker-compose.external-db.yml" }
  $webOriginMatch = [regex]::Match($envText, "(?m)^WEB_ORIGIN=(.*)$")
  $WebOrigin = if ($webOriginMatch.Success) { $webOriginMatch.Groups[1].Value.Trim() } else { "http://localhost:5173" }
} else {
  Write-Step "Generating .env with strong random secrets..."

  Write-Host "This installer targets a local/trial deployment by default."
  $WebOriginInput = Ask "Public URL for the web app [http://localhost:5173]" ""
  $WebOrigin = if ([string]::IsNullOrWhiteSpace($WebOriginInput)) { "http://localhost:5173" } else { $WebOriginInput }
  $AppBaseUrlInput = Ask "Public URL for the API (used as the SSO callback base) [$WebOrigin]" ""
  $AppBaseUrl = if ([string]::IsNullOrWhiteSpace($AppBaseUrlInput)) { $WebOrigin } else { $AppBaseUrlInput }

  Write-Host ""
  Write-Host "Where should the database live?"
  Write-Host "  [1] Set one up for me in Docker (default - fastest for a trial, nothing else to configure)"
  Write-Host "  [2] I already have a MySQL server I want to use (a real on-prem box, RDS, Cloud SQL, etc.)"
  $DbChoiceInput = Ask "Choice [1]" "1"
  $UseExternalDb = ($DbChoiceInput.Trim() -eq "2")

  if ($UseExternalDb) {
    Write-Host ""
    Write-Host "Your MySQL server needs to already exist and be reachable from wherever this container runs."
    Write-Host "This installer will try to create the two databases below on it (CREATE DATABASE IF NOT EXISTS) -"
    Write-Host "the account you give it needs privileges for that, or you can pre-create them yourself."
    $ExtHost = Read-Host "MySQL host"
    while ([string]::IsNullOrWhiteSpace($ExtHost)) { $ExtHost = Read-Host "MySQL host (required)" }
    $ExtPortInput = Read-Host "MySQL port [3306]"
    $ExtPort = if ([string]::IsNullOrWhiteSpace($ExtPortInput)) { "3306" } else { $ExtPortInput }
    $ExtUser = Read-Host "MySQL username"
    while ([string]::IsNullOrWhiteSpace($ExtUser)) { $ExtUser = Read-Host "MySQL username (required)" }
    $ExtPasswordSecure = Read-Host "MySQL password (input hidden)" -AsSecureString
    $ExtPassword = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ExtPasswordSecure))
    $ExtDbNameInput = Read-Host "Tenant database name [timesheet_portal]"
    $ExtDbName = if ([string]::IsNullOrWhiteSpace($ExtDbNameInput)) { "timesheet_portal" } else { $ExtDbNameInput }
    $ExtControlDbNameInput = Read-Host "Control-plane database name [timesphere_control]"
    $ExtControlDbName = if ([string]::IsNullOrWhiteSpace($ExtControlDbNameInput)) { "timesphere_control" } else { $ExtControlDbNameInput }

    # URL-encode user/password - either can legitimately contain characters (@, :, /, #, %) that
    # would otherwise corrupt the mysql:// DSN's own structure (e.g. a literal '@' in a password
    # reads as "end of credentials, start of host" to any URL parser, Prisma's included).
    $ExtUserEnc = UrlEncode $ExtUser
    $ExtPasswordEnc = UrlEncode $ExtPassword
    $DatabaseUrl = "mysql://${ExtUserEnc}:${ExtPasswordEnc}@${ExtHost}:${ExtPort}/${ExtDbName}"
    $ControlDatabaseUrl = "mysql://${ExtUserEnc}:${ExtPasswordEnc}@${ExtHost}:${ExtPort}/${ExtControlDbName}"
    $DbEnvLines = "DATABASE_URL=$DatabaseUrl`nCONTROL_DATABASE_URL=$ControlDatabaseUrl"
    $ComposeFile = "docker-compose.external-db.yml"

    # PREFLIGHT - prove the credentials work and the databases can exist BEFORE any container
    # starts. Without this, a restricted account (typical on RDS/Cloud SQL) fails minutes later
    # as an opaque P1003 deep in 'docker compose logs api'. Runs the mysql client from the
    # official image so the host needs no mysql client installed - Docker is already required.
    Write-Step "Preflight: verifying MySQL connectivity and creating databases if needed..."
    $preflightSql = "CREATE DATABASE IF NOT EXISTS ``$ExtDbName``; CREATE DATABASE IF NOT EXISTS ``$ExtControlDbName``;"
    docker run --rm mysql:8.4 mysql -h"$ExtHost" -P"$ExtPort" -u"$ExtUser" -p"$ExtPassword" -e $preflightSql
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "Could not connect or create the databases (see the mysql error above)."
      Write-Warn "If the account is deliberately restricted, pre-create them and grant access:"
      Write-Warn "  CREATE DATABASE ``$ExtDbName``; CREATE DATABASE ``$ExtControlDbName``;"
      Write-Warn "  GRANT ALL PRIVILEGES ON ``$ExtDbName``.* TO '$ExtUser'@'%';"
      Write-Warn "  GRANT ALL PRIVILEGES ON ``$ExtControlDbName``.* TO '$ExtUser'@'%';"
      Write-Fail "Fix the database access above, then re-run this script. Nothing has been started."
    }
    Write-Host "Preflight passed: both databases exist and the account can reach them."
  } else {
    # Hex, not base64: this value gets embedded unencoded in a mysql:// DSN below, and base64's
    # alphabet includes '/' and '+' - either would corrupt the URL (a literal '/' reads as a path
    # separator). Hex is alphanumeric-only, so it's always URL-safe regardless of what it rolls.
    $MysqlRootPassword = New-RandomHex32
    $DbEnvLines = "MYSQL_ROOT_PASSWORD=$MysqlRootPassword`nMYSQL_DATABASE=timesheet_portal`nDATABASE_URL=mysql://root:$MysqlRootPassword@mysql:3306/timesheet_portal`nCONTROL_DATABASE_URL=mysql://root:$MysqlRootPassword@mysql:3306/timesphere_control"
    $ComposeFile = "docker-compose.yml"
  }
  $GeneratedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

  # Optional, human-in-the-loop: SMTP can also be configured later from Workspace Settings ->
  # Mail server (apps/api/src/services/mail.service.ts prefers that DB-stored config, falling
  # back to these env vars) -- so skipping here is always safe, never a dead end.
  $SmtpHost = ""
  $SmtpPort = "587"
  $SmtpUser = ""
  $SmtpPass = ""
  $SmtpSecure = "false"
  $MailFrom = "TimeSphere <no-reply@timesheet.local>"
  Write-Host ""
  Write-Host "Optional: configure outbound email now (or skip and set it later in Workspace Settings -> Mail server)."
  $ConfigureSmtp = Ask "Configure SMTP now? [y/N]" "N"
  if ($ConfigureSmtp -match '^[Yy]$') {
    $SmtpHost = Read-Host "SMTP host (e.g. smtp.gmail.com)"
    $SmtpPortInput = Read-Host "SMTP port [587]"
    $SmtpPort = if ([string]::IsNullOrWhiteSpace($SmtpPortInput)) { "587" } else { $SmtpPortInput }
    $SmtpUser = Read-Host "SMTP username"
    $SmtpPassSecure = Read-Host "SMTP password (input hidden)" -AsSecureString
    $SmtpPass = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto([System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SmtpPassSecure))
    $SmtpSecureInput = Read-Host "Use implicit TLS (port 465)? [y/N]"
    if ($SmtpSecureInput -match '^[Yy]$') { $SmtpSecure = "true" }
    $defaultFrom = "TimeSphere <$(if ($SmtpUser) { $SmtpUser } else { 'no-reply@timesheet.local' })>"
    $MailFromInput = Read-Host "From address [$defaultFrom]"
    $MailFrom = if ([string]::IsNullOrWhiteSpace($MailFromInput)) { $defaultFrom } else { $MailFromInput }
  }

  $envContent = @"
# Generated by install.ps1 on $GeneratedAt -see docs/DEPLOYMENT.md for what each of these does.
# $ComposeFile reads this file automatically.
$DbEnvLines
DEFAULT_ORG_SLUG=default
JWT_ACCESS_SECRET=$(New-RandomBase64 48)
JWT_REFRESH_SECRET=$(New-RandomBase64 48)
PLATFORM_ADMIN_JWT_SECRET=$(New-RandomBase64 48)
ENCRYPTION_KEY=$(New-RandomHex32)
WEB_ORIGIN=$WebOrigin
APP_BASE_URL=$AppBaseUrl
ANTHROPIC_API_KEY=
MAIL_FROM=$MailFrom
SMTP_HOST=$SmtpHost
SMTP_PORT=$SmtpPort
SMTP_USER=$SmtpUser
SMTP_PASS=$SmtpPass
SMTP_SECURE=$SmtpSecure
"@
  # UTF8 no-BOM -a BOM in this file would end up as literal bytes inside the first env var's
  # value once Compose parses it.
  [System.IO.File]::WriteAllText($EnvFile, $envContent, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ".env written to $EnvFile"
}

# Auto-heal: fail fast with a clear message if a port this compose file needs is already taken,
# rather than letting 'docker compose up' bind-fail deep in its own logs. Only checks 3307 (not
# MySQL's usual 3306, deliberately - docker-compose.yml maps its bundled MySQL container to host
# port 3307 so it never collides with a local/XAMPP MySQL on 3306) when actually using that
# bundled container - docker-compose.external-db.yml never binds a MySQL port on the host at all.
$PortsToCheck = if ($ComposeFile -eq "docker-compose.yml") { @(4000, 5173, 3307) } else { @(4000, 5173) }
foreach ($port in $PortsToCheck) {
  $inUse = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($inUse) {
    Write-Warn "Port $port looks already in use on this machine. If it's not an old TimeSphere stack (check: docker compose -f $ComposeFile ps), stop whatever's using it or edit the port mapping in $ComposeFile before continuing."
  }
}

Write-Step "Building and starting the stack (this can take a few minutes on first run)..."
Write-Host "Using $ComposeFile$(if ($ComposeFile -eq 'docker-compose.external-db.yml') { ' (your own MySQL server, no bundled mysql container)' })"
docker compose -f $ComposeFile up -d --build

Write-Step "Waiting for the API to become healthy..."
$apiReady = $false
for ($i = 0; $i -lt 60; $i++) {
  try {
    $response = Invoke-WebRequest -Uri "http://localhost:4000/health" -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -eq 200) { $apiReady = $true; break }
  } catch {}
  Start-Sleep -Seconds 3
}

if (-not $apiReady) {
  Write-Warn "API didn't report healthy within 3 minutes - checking container status and attempting a self-heal restart..."
  docker compose -f $ComposeFile ps
  # Auto-heal: a container that crashed on boot (transient migration lock, or mysql not yet
  # ready when api first connected) usually recovers with a restart - reuses built images, fast.
  docker compose -f $ComposeFile restart api
  $apiReady = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $response = Invoke-WebRequest -Uri "http://localhost:4000/health" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) { $apiReady = $true; break }
    } catch {}
    Start-Sleep -Seconds 3
  }
  if ($apiReady) {
    Write-Host "API recovered after restart."
  } else {
    Write-Warn "Still not healthy - check 'docker compose -f $ComposeFile logs api' for the actual error."
    if ($ComposeFile -eq "docker-compose.yml") {
      Write-Warn "Migrations run automatically on boot; a slow first-pull of the mysql:8.4 image is the usual cause on a fresh install."
    } else {
      Write-Warn "Migrations run automatically on boot; double-check your external MySQL server is actually reachable from this machine/container (host, port, firewall, and that the account you gave it can log in)."
    }
  }
} else {
  Write-Host "API is healthy."
}

Write-Step "Running the one-time seed (roles, permissions, control-plane plan tiers, platform-admin account)..."
# Auto-heal: retry a few times with backoff - a fresh mysql container can still be finishing
# init-file replay for a few seconds after /health reports ready (TCP-reachable != fully migrated).
$seedOk = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
  docker compose -f $ComposeFile exec -T api npm run control:seed -w apps/api
  if ($LASTEXITCODE -eq 0) {
    docker compose -f $ComposeFile exec -T api npm run seed -w apps/api
    if ($LASTEXITCODE -eq 0) { $seedOk = $true; break }
  }
  Write-Warn "Seed attempt $attempt/3 failed - this is often `"already seeded`" (safe to ignore) or a DB-not-ready race. Retrying in 5s..."
  Start-Sleep -Seconds 5
}
if ($seedOk) {
  Write-Host "Seed complete."
} else {
  Write-Warn "Seeding didn't succeed after 3 attempts - if this is a fresh install, check 'docker compose -f $ComposeFile logs api' and re-run manually:"
  Write-Warn "  docker compose -f $ComposeFile exec api npm run control:seed -w apps/api; docker compose -f $ComposeFile exec api npm run seed -w apps/api"
  Write-Warn "If it's an already-seeded re-run, this is expected and safe to ignore."
}

# -- VERIFICATION SUITE -----------------------------------------------------------------------
# "Installed" below means PROVEN, not presumed - each check exercises a different layer. Mirrors
# install.sh's suite; see that file for the reasoning per layer.
Write-Step "Verifying the installation..."
$verifyFailed = $false
function Verify($Label, [scriptblock]$Check) {
  $ok = $false
  try { $ok = (& $Check) } catch { $ok = $false }
  if ($ok) { Write-Host "  [pass] $Label" -ForegroundColor Green }
  else { Write-Host "  [FAIL] $Label" -ForegroundColor Red; $script:verifyFailed = $true }
}

$expectedVersion = (Get-Content "$PSScriptRoot\VERSION" -ErrorAction SilentlyContinue | Select-Object -First 1).Trim()

Verify "API health endpoint responds" {
  (Invoke-WebRequest -Uri "http://localhost:4000/health" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200
}
Verify "server reports version $expectedVersion" {
  (Invoke-WebRequest -Uri "http://localhost:4000/api/system/version" -UseBasicParsing -TimeoutSec 5).Content -match "`"version`":`"$expectedVersion`""
}
Verify "tenant schema at latest migration" {
  docker compose -f $ComposeFile exec -T api npx prisma migrate status --schema=apps/api/prisma/schema.prisma | Out-Null
  $LASTEXITCODE -eq 0
}
Verify "control-plane schema at latest migration" {
  docker compose -f $ComposeFile exec -T api npx prisma migrate status --schema=apps/api/prisma/control/schema.prisma | Out-Null
  $LASTEXITCODE -eq 0
}
Verify "platform-admin login returns a token" {
  $body = '{"email":"platform-admin@timesphere.local","password":"PlatformAdmin@12345"}'
  (Invoke-WebRequest -Uri "http://localhost:4000/api/platform-admin/auth/login" -Method Post -ContentType "application/json" -Body $body -UseBasicParsing -TimeoutSec 5).Content -match "accessToken"
}
Verify "web app serves the SPA" {
  (Invoke-WebRequest -Uri "http://localhost:5173" -UseBasicParsing -TimeoutSec 5).Content -match 'id="root"'
}

if ($verifyFailed) {
  Write-Warn "One or more verification checks FAILED - the stack is up but not proven healthy."
  Write-Warn "Diagnose with: docker compose -f $ComposeFile logs api"
  exit 1
}
Write-Step "All verification checks passed."

Write-Host ""
Write-Host "TimeSphere is up." -ForegroundColor Green
Write-Host ""
Write-Host "  Web app:              $WebOrigin"
Write-Host "  Platform admin:       $WebOrigin/platform-admin/login"
Write-Host "  Platform admin login: platform-admin@timesphere.local / PlatformAdmin@12345 (change this)"
Write-Host ""
Write-Host "Included out of the box - no extra setup required:" -ForegroundColor DarkGray
Write-Host "  - Timesheets, Jira-style ticketing (Kanban board incl. `"Group by manager`" swimlanes)" -ForegroundColor DarkGray
Write-Host "  - Live trend analytics (today vs. yesterday / this week vs. last week) on every KPI" -ForegroundColor DarkGray
Write-Host "    card across Dashboard, History, My team, and Reports - auto-refreshes, no setup" -ForegroundColor DarkGray
Write-Host "  - Ticket detail sheet's Dev tab - manually link a repo/branch/PR to a ticket" -ForegroundColor DarkGray
Write-Host "  - Team page org-chart (interactive, pan/zoom, centered, role color-coded, shows" -ForegroundColor DarkGray
Write-Host "    designation)" -ForegroundColor DarkGray
Write-Host "  - Per-user designation (job title) - set on create/edit/bulk-upload, shown on the" -ForegroundColor DarkGray
Write-Host "    Users table and org chart" -ForegroundColor DarkGray
Write-Host "  - Tickets/Team tables fall back to a mobile card view below the sm breakpoint" -ForegroundColor DarkGray
Write-Host "  - Security & DevOps findings ingestion (SAST/DAST/SSAT/SSCT via CI webhook, VAPT via" -ForegroundColor DarkGray
Write-Host "    JSON upload) - configure the webhook token from Workspace Settings -> Security & DevOps" -ForegroundColor DarkGray
Write-Host "  - BYOK AI (off by default), SSO, chat-to-ticket connectors - all opt-in from Workspace Settings" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Next steps are in docs/DEPLOYMENT.md -first org admin login, SMTP setup, backups, and" -ForegroundColor DarkGray
Write-Host "(if you outgrow one company) the SaaS multi-org shape. Full feature walkthrough:" -ForegroundColor DarkGray
Write-Host "docs/INSTALLATION.md's `"Configuring things after install`" table." -ForegroundColor DarkGray
