#!/usr/bin/env bash
# One-click installer for TimeSphere's on-prem/single-org Docker Compose shape (see
# docs/DEPLOYMENT.md's "Shape 1"). Native bash — no Node required just to bootstrap, since
# everything the app itself needs runs inside the containers Docker builds.
#
# What this does: checks Docker/Compose are present, generates a root .env (the file
# docker-compose.yml reads its variables from) with strong random secrets if one doesn't already
# exist, brings the stack up, waits for the API's health check, then runs the one-time seed.
#
# What this deliberately does NOT do: install Docker itself, touch anything outside this repo,
# or silently overwrite an existing .env — re-running this script against an already-configured
# deployment just brings the stack up again.
#
# No new required .env keys have been added by recent feature work (Kanban swimlanes, org-chart,
# manual ticket→branch/PR linking, VAPT report upload, mobile card-view fallbacks) — every one of
# those reads from the same DATABASE_URL this script already provisions, via the migrations that
# run automatically on container boot. Nothing below needs to change to pick them up.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m[error]\033[0m %s\n' "$1" >&2; exit 1; }

# OS detection — used only to print the right install command when a dependency is missing.
# Deliberately does NOT run any package-manager command itself (apt/brew/choco with elevated
# privileges is exactly the kind of unattended system change that can break an unrelated part of
# a user's machine) — it prints the command for the human to review and run themselves, keeping
# a human in the loop for anything that touches state outside this repo.
detect_os() {
  case "$(uname -s)" in
    Linux*)
      if [ -f /etc/os-release ]; then . /etc/os-release; echo "linux-${ID:-unknown}"; else echo "linux-unknown"; fi
      ;;
    Darwin*) echo "macos" ;;
    CYGWIN*|MINGW*|MSYS*) echo "windows-bash" ;;
    *) echo "unknown" ;;
  esac
}
OS_ID="$(detect_os)"

docker_install_hint() {
  case "$OS_ID" in
    linux-ubuntu|linux-debian) echo "curl -fsSL https://get.docker.com | sh   (then: sudo usermod -aG docker \$USER, log out/in)" ;;
    linux-fedora|linux-rhel|linux-centos) echo "sudo dnf install -y docker docker-compose-plugin  (or see https://docs.docker.com/engine/install/fedora/)" ;;
    macos) echo "brew install --cask docker   (or download Docker Desktop: https://docs.docker.com/desktop/install/mac-install/)" ;;
    windows-bash) echo "Install Docker Desktop for Windows: https://docs.docker.com/desktop/install/windows-install/" ;;
    *) echo "See https://docs.docker.com/get-docker/ for your OS." ;;
  esac
}

log "Detected OS: $OS_ID"
log "Checking for Docker..."
if ! command -v docker >/dev/null 2>&1; then
  HINT="$(docker_install_hint)"
  warn "Docker isn't installed. Suggested install command for your OS:"
  warn "  $HINT"
  # Auto-install is opt-in per run (never silent/unattended) — only offered for the
  # apt/dnf/brew one-liners above, which are safe to pipe straight into a shell; Windows still
  # gets a manual link since winget/choco need an elevated shell this script may not have.
  if [[ "$OS_ID" == linux-* || "$OS_ID" == "macos" ]] && [[ "$HINT" != Install\ Docker* ]]; then
    read -r -p "Attempt to auto-install Docker now with the command above? [y/N]: " AUTO_INSTALL_DOCKER
    if [[ "$AUTO_INSTALL_DOCKER" =~ ^[Yy]$ ]]; then
      log "Running: $HINT"
      eval "$HINT" || fail "Auto-install failed — install Docker manually and re-run this script."
      if [[ "$OS_ID" == linux-* ]]; then
        warn "If this was a fresh install, log out/in (or run 'newgrp docker') so your shell picks up docker-group membership, then re-run this script."
        exit 0
      fi
    else
      fail "Install Docker, then re-run this script."
    fi
  else
    fail "Install Docker, then re-run this script."
  fi
fi
if ! docker compose version >/dev/null 2>&1; then
  fail "The 'docker compose' plugin isn't available. Install it: https://docs.docker.com/compose/install/"
fi
log "Docker $(docker --version | sed 's/Docker version //') with Compose plugin found."

# Auto-heal: refuse to fight for ports the host is already using for something else — better to
# fail fast here with a clear message than have `docker compose up` silently bind-fail deep in
# its own logs. WEB_ORIGIN/APP_BASE_URL are user-editable above and don't have to be localhost,
# but the ports docker-compose.yml publishes (4000/5173/3306) are fixed, so check those.
check_port_free() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1 && return 1 || return 0
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$port )" 2>/dev/null | grep -q ":$port" && return 1 || return 0
  fi
  return 0 # can't check on this system — don't block install over it
}
for PORT in 4000 5173 3306; do
  if ! check_port_free "$PORT"; then
    warn "Port $PORT looks already in use on this machine. If it's not an old TimeSphere stack (check: docker compose ps), stop whatever's using it or edit the port mapping in docker-compose.yml before continuing."
  fi
done

# Required keys docker-compose.yml has NO default for (see docker-compose.yml's `api` service —
# these use ${VAR:?error} syntax, so a missing one fails the whole stack at `docker compose up`,
# not with a clear "which key" message). Self-heal check: an existing .env from an older version
# of this script, or one hand-edited and accidentally missing a line, gets diagnosed here instead
# of failing opaquely three steps later inside Compose.
REQUIRED_KEYS=(DATABASE_URL CONTROL_DATABASE_URL JWT_ACCESS_SECRET JWT_REFRESH_SECRET PLATFORM_ADMIN_JWT_SECRET ENCRYPTION_KEY WEB_ORIGIN APP_BASE_URL)

ENV_FILE="$ROOT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  log ".env already exists — checking it has every required key (self-heal check, values are never modified)..."
  MISSING_KEYS=()
  for key in "${REQUIRED_KEYS[@]}"; do
    if ! grep -qE "^${key}=" "$ENV_FILE"; then
      MISSING_KEYS+=("$key")
    fi
  done
  if [ "${#MISSING_KEYS[@]}" -gt 0 ]; then
    warn ".env is missing: ${MISSING_KEYS[*]}"
    warn "This usually means an old .env predates a key this version of docker-compose.yml now requires."
    warn "Fix: either add the missing key(s) yourself (see .env.example), or delete .env and re-run this script to regenerate it fresh."
    fail "Refusing to start the stack with an incomplete .env — see the missing keys above."
  fi
  log ".env has every required key — leaving it as-is. Delete it first if you want fresh generated secrets."
else
  log "Generating .env with strong random secrets..."

  if command -v openssl >/dev/null 2>&1; then
    rand_b64() { openssl rand -base64 48 | tr -d '\n'; }
    rand_hex32() { openssl rand -hex 32 | tr -d '\n'; }
  else
    warn "openssl not found — falling back to /dev/urandom (still cryptographically strong)."
    rand_b64() { head -c 48 /dev/urandom | base64 | tr -d '\n'; }
    rand_hex32() { head -c 32 /dev/urandom | xxd -p | tr -d '\n'; }
  fi

  printf 'This installer targets a local/trial deployment by default.\n'
  read -r -p "Public URL for the web app [http://localhost:5173]: " WEB_ORIGIN_INPUT
  WEB_ORIGIN_VALUE="${WEB_ORIGIN_INPUT:-http://localhost:5173}"
  read -r -p "Public URL for the API (used as the SSO callback base) [${WEB_ORIGIN_VALUE}]: " APP_BASE_URL_INPUT
  APP_BASE_URL_VALUE="${APP_BASE_URL_INPUT:-$WEB_ORIGIN_VALUE}"

  # Hex, not base64: this value gets embedded unencoded in a mysql:// DSN below, and base64's
  # alphabet includes '/' and '+' — either would corrupt the URL (a literal '/' reads as a path
  # separator). Hex is alphanumeric-only, so it's always URL-safe regardless of what it rolls.
  MYSQL_ROOT_PASSWORD_VALUE="$(rand_hex32)"

  # Optional, human-in-the-loop: SMTP can also be configured later from Workspace Settings →
  # Mail server (apps/api/src/services/mail.service.ts prefers that DB-stored config, falling
  # back to these env vars) — so skipping here is always safe, never a dead end.
  SMTP_HOST_VALUE=""
  SMTP_PORT_VALUE="587"
  SMTP_USER_VALUE=""
  SMTP_PASS_VALUE=""
  SMTP_SECURE_VALUE="false"
  MAIL_FROM_VALUE="TimeSphere <no-reply@timesheet.local>"
  printf '\nOptional: configure outbound email now (or skip and set it later in Workspace Settings -> Mail server).\n'
  read -r -p "Configure SMTP now? [y/N]: " CONFIGURE_SMTP
  if [[ "$CONFIGURE_SMTP" =~ ^[Yy]$ ]]; then
    read -r -p "SMTP host (e.g. smtp.gmail.com): " SMTP_HOST_VALUE
    read -r -p "SMTP port [587]: " SMTP_PORT_INPUT
    SMTP_PORT_VALUE="${SMTP_PORT_INPUT:-587}"
    read -r -p "SMTP username: " SMTP_USER_VALUE
    # -s suppresses echo — the password is never printed to the terminal or shell history.
    read -r -s -p "SMTP password (input hidden): " SMTP_PASS_VALUE
    printf '\n'
    read -r -p "Use implicit TLS (port 465)? [y/N]: " SMTP_SECURE_INPUT
    [[ "$SMTP_SECURE_INPUT" =~ ^[Yy]$ ]] && SMTP_SECURE_VALUE="true"
    read -r -p "From address [TimeSphere <${SMTP_USER_VALUE:-no-reply@timesheet.local}>]: " MAIL_FROM_INPUT
    MAIL_FROM_VALUE="${MAIL_FROM_INPUT:-TimeSphere <${SMTP_USER_VALUE:-no-reply@timesheet.local}>}"
  fi

  cat > "$ENV_FILE" <<EOF
# Generated by install.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ") — see docs/DEPLOYMENT.md for what
# each of these does. docker-compose.yml reads this file automatically.
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD_VALUE}
MYSQL_DATABASE=timesheet_portal
DATABASE_URL=mysql://root:${MYSQL_ROOT_PASSWORD_VALUE}@mysql:3306/timesheet_portal
CONTROL_DATABASE_URL=mysql://root:${MYSQL_ROOT_PASSWORD_VALUE}@mysql:3306/timesphere_control
DEFAULT_ORG_SLUG=default
JWT_ACCESS_SECRET=$(rand_b64)
JWT_REFRESH_SECRET=$(rand_b64)
PLATFORM_ADMIN_JWT_SECRET=$(rand_b64)
ENCRYPTION_KEY=$(rand_hex32)
WEB_ORIGIN=${WEB_ORIGIN_VALUE}
APP_BASE_URL=${APP_BASE_URL_VALUE}
ANTHROPIC_API_KEY=
MAIL_FROM=${MAIL_FROM_VALUE}
SMTP_HOST=${SMTP_HOST_VALUE}
SMTP_PORT=${SMTP_PORT_VALUE}
SMTP_USER=${SMTP_USER_VALUE}
SMTP_PASS=${SMTP_PASS_VALUE}
SMTP_SECURE=${SMTP_SECURE_VALUE}
EOF
  log ".env written to $ENV_FILE"
fi

log "Building and starting the stack (this can take a few minutes on first run)..."
docker compose up -d --build

log "Waiting for the API to become healthy..."
API_READY=false
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:4000/health >/dev/null 2>&1; then
    API_READY=true
    break
  fi
  sleep 3
done

if [ "$API_READY" != true ]; then
  warn "API didn't report healthy within 3 minutes — checking container status and attempting a self-heal restart..."
  docker compose ps
  # Auto-heal: a container that crashed on boot (e.g. a transient migration lock, or the mysql
  # container not yet ready when api first tried to connect) usually recovers with a restart —
  # `docker compose restart` reuses the already-built images, so this is fast, not a full rebuild.
  docker compose restart api || true
  for _ in $(seq 1 30); do
    if curl -fsS http://localhost:4000/health >/dev/null 2>&1; then
      API_READY=true
      break
    fi
    sleep 3
  done
  if [ "$API_READY" = true ]; then
    log "API recovered after restart."
  else
    warn "Still not healthy — check 'docker compose logs api' for the actual error."
    warn "Migrations run automatically on boot; a slow first-pull of the mysql:8.4 image is the usual cause on a fresh install."
  fi
else
  log "API is healthy."
fi

log "Running the one-time seed (roles, permissions, control-plane plan tiers, platform-admin account)..."
# Auto-heal: on a fresh install the mysql container can still be finishing init-file replay for a
# few seconds after the API's /health reports ready (health checks TCP connectivity, not "schema
# fully migrated") — retry a few times with backoff instead of failing on the very first race.
SEED_OK=false
for attempt in 1 2 3; do
  if docker compose exec -T api npm run control:seed -w apps/api && docker compose exec -T api npm run seed -w apps/api; then
    SEED_OK=true
    break
  fi
  warn "Seed attempt $attempt/3 failed — this is often \"already seeded\" (safe to ignore) or a DB-not-ready race. Retrying in 5s..."
  sleep 5
done
if [ "$SEED_OK" = true ]; then
  log "Seed complete."
else
  warn "Seeding didn't succeed after 3 attempts — if this is a fresh install, check 'docker compose logs api' and re-run manually:"
  warn "  docker compose exec api npm run control:seed -w apps/api && docker compose exec api npm run seed -w apps/api"
  warn "If it's an already-seeded re-run, this is expected and safe to ignore."
fi

cat <<EOF

$(printf '\033[1;32m✓ TimeSphere is up.\033[0m')

  Web app:            ${WEB_ORIGIN_VALUE:-http://localhost:5173}
  Platform admin:     ${WEB_ORIGIN_VALUE:-http://localhost:5173}/platform-admin/login
  Platform admin login: platform-admin@timesphere.local / PlatformAdmin@12345 (change this)

Included out of the box — no extra setup required:
  - Timesheets, Jira-style ticketing (Kanban board incl. "Group by manager" swimlanes)
  - Live trend analytics (today vs. yesterday / this week vs. last week) on every KPI card across
    Dashboard, History, My team, and Reports — auto-refreshes, no setup
  - Ticket detail sheet's Dev tab — manually link a repo/branch/PR to a ticket
  - Team page org-chart (interactive, pan/zoom, centered, role color-coded, shows designation)
  - Per-user designation (job title) — set on create/edit/bulk-upload, shown on the Users table
    and org chart
  - Tickets/Team tables fall back to a mobile card view below the sm breakpoint
  - Security & DevOps findings ingestion (SAST/DAST/SSAT/SSCT via CI webhook, VAPT via JSON
    upload) — configure the webhook token from Workspace Settings -> Security & DevOps
  - BYOK AI (off by default), SSO, chat-to-ticket connectors — all opt-in from Workspace Settings

Next steps are in docs/DEPLOYMENT.md — first org admin login, SMTP setup, backups, and (if you
outgrow one company) the SaaS multi-org shape. Full feature walkthrough: docs/INSTALLATION.md's
"Configuring things after install" table.
EOF
