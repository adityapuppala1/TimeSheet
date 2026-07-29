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

Write-Step "Checking for Docker..."
$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCmd) {
  Write-Warn "Docker isn't installed. Suggested: winget install --id Docker.DockerDesktop -e"
  $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
  if ($wingetCmd) {
    $autoInstall = Read-Host "Attempt to auto-install Docker Desktop now via winget? [y/N]"
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

# Auto-heal: fail fast with a clear message if a port docker-compose.yml needs is already taken,
# rather than letting 'docker compose up' bind-fail deep in its own logs. 3307, not MySQL's
# usual 3306 — docker-compose.yml deliberately maps its MySQL container to host port 3307 so it
# never collides with a local/XAMPP MySQL a developer already has running on the default 3306.
foreach ($port in @(4000, 5173, 3307)) {
  $inUse = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($inUse) {
    Write-Warn "Port $port looks already in use on this machine. If it's not an old TimeSphere stack (check: docker compose ps), stop whatever's using it or edit the port mapping in docker-compose.yml before continuing."
  }
}

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
  $WebOrigin = "http://localhost:5173"
} else {
  Write-Step "Generating .env with strong random secrets..."

  Write-Host "This installer targets a local/trial deployment by default."
  $WebOriginInput = Read-Host "Public URL for the web app [http://localhost:5173]"
  $WebOrigin = if ([string]::IsNullOrWhiteSpace($WebOriginInput)) { "http://localhost:5173" } else { $WebOriginInput }
  $AppBaseUrlInput = Read-Host "Public URL for the API (used as the SSO callback base) [$WebOrigin]"
  $AppBaseUrl = if ([string]::IsNullOrWhiteSpace($AppBaseUrlInput)) { $WebOrigin } else { $AppBaseUrlInput }

  # Hex, not base64: this value gets embedded unencoded in a mysql:// DSN below, and base64's
  # alphabet includes '/' and '+' - either would corrupt the URL (a literal '/' reads as a path
  # separator). Hex is alphanumeric-only, so it's always URL-safe regardless of what it rolls.
  $MysqlRootPassword = New-RandomHex32
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
  $ConfigureSmtp = Read-Host "Configure SMTP now? [y/N]"
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
# docker-compose.yml reads this file automatically.
MYSQL_ROOT_PASSWORD=$MysqlRootPassword
MYSQL_DATABASE=timesheet_portal
DATABASE_URL=mysql://root:$MysqlRootPassword@mysql:3306/timesheet_portal
CONTROL_DATABASE_URL=mysql://root:$MysqlRootPassword@mysql:3306/timesphere_control
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

Write-Step "Building and starting the stack (this can take a few minutes on first run)..."
docker compose up -d --build

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
  docker compose ps
  # Auto-heal: a container that crashed on boot (transient migration lock, or mysql not yet
  # ready when api first connected) usually recovers with a restart - reuses built images, fast.
  docker compose restart api
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
    Write-Warn "Still not healthy - check 'docker compose logs api' for the actual error."
    Write-Warn "Migrations run automatically on boot; a slow first-pull of the mysql:8.4 image is the usual cause on a fresh install."
  }
} else {
  Write-Host "API is healthy."
}

Write-Step "Running the one-time seed (roles, permissions, control-plane plan tiers, platform-admin account)..."
# Auto-heal: retry a few times with backoff - a fresh mysql container can still be finishing
# init-file replay for a few seconds after /health reports ready (TCP-reachable != fully migrated).
$seedOk = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
  docker compose exec -T api npm run control:seed -w apps/api
  if ($LASTEXITCODE -eq 0) {
    docker compose exec -T api npm run seed -w apps/api
    if ($LASTEXITCODE -eq 0) { $seedOk = $true; break }
  }
  Write-Warn "Seed attempt $attempt/3 failed - this is often `"already seeded`" (safe to ignore) or a DB-not-ready race. Retrying in 5s..."
  Start-Sleep -Seconds 5
}
if ($seedOk) {
  Write-Host "Seed complete."
} else {
  Write-Warn "Seeding didn't succeed after 3 attempts - if this is a fresh install, check 'docker compose logs api' and re-run manually:"
  Write-Warn "  docker compose exec api npm run control:seed -w apps/api; docker compose exec api npm run seed -w apps/api"
  Write-Warn "If it's an already-seeded re-run, this is expected and safe to ignore."
}

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
