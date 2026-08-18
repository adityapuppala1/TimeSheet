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
# Feature work (the V6 planning layer, face verification, reports, multi-provider git
# webhooks, HTTPS tooling, and 2.3.0's MCP server + AI refine) has added NO new required .env keys
# - everything reads from the same DATABASE_URL this script already provisions, via the migrations
# that run on every boot. The MCP server in particular is configured entirely from the database
# (GlobalMcpSettings/McpCredential, Workspace Settings -> MCP server) and ships switched off, so
# there is nothing for this script to ask about and nothing it could turn on by accident.
#
# The one setting this script asks about beyond URLs and the database is TRUST_PROXY_HOPS: it has
# a default, so it is not "required", but the default is wrong for this stack and its wrongness is
# invisible (see the prompt below). Relocatable storage (STORAGE_*) and file logging (LOG_*) are
# forwarded by docker-compose.yml and inert when unset - configure them afterwards, not here.
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

# Non-interactive mode: TS_AUTO=1 answers every prompt with its default (bundled Docker MySQL,
# localhost URLs, no SMTP). Exists for CI — which executes this script end-to-end on every PR so
# installer rot is caught here rather than by a customer — and for anyone scripting a fleet.
AUTO="${TS_AUTO:-0}"
ask() { # ask <prompt> <default-var-name>  — honours TS_AUTO by echoing the default
  local prompt="$1" default="$2" reply
  if [ "$AUTO" = "1" ]; then printf '%s' "$default"; return; fi
  read -r -p "$prompt" reply
  printf '%s' "${reply:-$default}"
}

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

# ── Environment detection: Kubernetes first, then Docker ─────────────────────────────────────
# A reachable cluster plus helm means this machine is probably an operator's workstation, and the
# right deployment is the Helm chart, not a local compose stack. OFFERED, never assumed: kubectl
# on a laptop often points at a production cluster, and "install.sh quietly deployed to prod"
# is not a story anyone wants to be in. TS_AUTO always takes the compose path for the same reason.
if [ "$AUTO" != "1" ] && command -v kubectl >/dev/null 2>&1 && command -v helm >/dev/null 2>&1; then
  if kubectl cluster-info >/dev/null 2>&1; then
    K8S_CTX="$(kubectl config current-context 2>/dev/null || echo unknown)"
    printf '
A reachable Kubernetes cluster was detected (context: %s).
' "$K8S_CTX"
    printf '  [1] Install locally with Docker Compose (default — best for a trial or single box)
'
    printf '  [2] Deploy to the Kubernetes cluster above with the bundled Helm chart
'
    DEPLOY_CHOICE="$(ask "Choice [1]: " "1")"
    if [ "$DEPLOY_CHOICE" = "2" ]; then
      log "Kubernetes path: the chart lives in deploy/helm/timesphere."
      if [ ! -f deploy/helm/timesphere/secrets.generated.yaml ]; then
        log "Generating deploy/helm/timesphere/secrets.generated.yaml with strong random secrets..."
        if command -v openssl >/dev/null 2>&1; then RB() { openssl rand -base64 48 | tr -d '
'; }; RH() { openssl rand -hex 32 | tr -d '
'; }
        else RB() { head -c 48 /dev/urandom | base64 | tr -d '
'; }; RH() { head -c 32 /dev/urandom | xxd -p | tr -d '
'; }; fi
        sed -e "s|CHANGE_ME_ACCESS|$(RB)|" -e "s|CHANGE_ME_REFRESH|$(RB)|"             -e "s|CHANGE_ME_PLATFORM|$(RB)|" -e "s|CHANGE_ME_ENCRYPTION|$(RH)|"             deploy/helm/timesphere/secrets.example.yaml > deploy/helm/timesphere/secrets.generated.yaml
        warn "Review deploy/helm/timesphere/secrets.generated.yaml — you must still set your database DSNs and domain in values."
      fi
      printf '
Review values, then deploy with:
'
      printf '  helm upgrade --install timesphere deploy/helm/timesphere \
'
      printf '    -f deploy/helm/timesphere/values.yaml -f deploy/helm/timesphere/secrets.generated.yaml

'
      CONFIRM_HELM="$(ask "Run that helm command against context '$K8S_CTX' NOW? [y/N]: " "N")"
      if [[ "$CONFIRM_HELM" =~ ^[Yy]$ ]]; then
        helm upgrade --install timesphere deploy/helm/timesphere           -f deploy/helm/timesphere/values.yaml -f deploy/helm/timesphere/secrets.generated.yaml           || fail "helm upgrade failed — the output above is from helm itself."
        log "Deployed. Watch rollout: kubectl rollout status deploy/timesphere-api"
      else
        log "Not deploying automatically. Run the command above when your values are ready."
      fi
      exit 0
    fi
  fi
fi

log "Checking for Docker..."
if ! command -v docker >/dev/null 2>&1; then
  HINT="$(docker_install_hint)"
  warn "Docker isn't installed. Suggested install command for your OS:"
  warn "  $HINT"
  # Auto-install is opt-in per run (never silent/unattended) — only offered for the
  # apt/dnf/brew one-liners above, which are safe to pipe straight into a shell; Windows still
  # gets a manual link since winget/choco need an elevated shell this script may not have.
  if [[ "$OS_ID" == linux-* || "$OS_ID" == "macos" ]] && [[ "$HINT" != Install\ Docker* ]]; then
    AUTO_INSTALL_DOCKER="$(ask "Attempt to auto-install Docker now with the command above? [y/N]: " "N")"
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
  fail "Couldn't run 'docker compose'. Most likely cause: the Docker daemon isn't running yet (start Docker Desktop, or 'sudo systemctl start docker' on Linux) — wait for it to be ready and re-run this script. If it IS running, the Compose plugin may genuinely be missing/outdated: https://docs.docker.com/compose/install/"
fi
log "Docker $(docker --version | sed 's/Docker version //') with Compose plugin found."

check_port_free() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1 && return 1 || return 0
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$port )" 2>/dev/null | grep -q ":$port" && return 1 || return 0
  fi
  return 0 # can't check on this system — don't block install over it
}

# Portable, pure-bash percent-encoding (no jq/python dependency) — used for a MySQL username/
# password given for an external database (see below), either of which can legitimately contain
# characters (@, :, /, #, %) that would otherwise corrupt the mysql:// DSN's own structure.
urlencode() {
  local string="$1" strlen encoded pos c o
  strlen=${#string}
  encoded=""
  for (( pos=0; pos<strlen; pos++ )); do
    c="${string:$pos:1}"
    case "$c" in
      [-_.~a-zA-Z0-9]) o="$c" ;;
      *) printf -v o '%%%02X' "'$c" ;;
    esac
    encoded+="$o"
  done
  printf '%s' "$encoded"
}

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
  # TRUST_PROXY_HOPS is deliberately NOT in REQUIRED_KEYS: it has a default, so a missing one
  # starts fine — which is exactly the problem. At 0 behind a proxy every per-IP rate limit shares
  # one bucket and nothing anywhere says so, so an .env that predates this key gets told here.
  if ! grep -qE "^TRUST_PROXY_HOPS=" "$ENV_FILE"; then
    warn "TRUST_PROXY_HOPS is not set in .env (it defaults to 0)."
    warn "  The web container's nginx proxies /api to the api container, so every browser request"
    warn "  already arrives through one hop. At 0 the API records nginx's address as the client IP"
    warn "  for EVERYONE, and the 20/min login limiter becomes one shared global bucket."
    warn "  Add to .env and re-run:  TRUST_PROXY_HOPS=1   (2 with docker-compose.https.yml's Caddy;"
    warn "  add one more for anything else in front, e.g. Cloudflare). See docs/DEPLOYMENT.md."
  fi
  # MYSQL_ROOT_PASSWORD only ever gets written when a previous run chose the bundled-Docker-MySQL
  # path (see the else branch below) — its absence is exactly how a re-run recognizes "this
  # deployment uses its own external MySQL server" without asking again.
  if grep -qE "^MYSQL_ROOT_PASSWORD=" "$ENV_FILE"; then
    COMPOSE_FILE="docker-compose.yml"
  else
    COMPOSE_FILE="docker-compose.external-db.yml"
  fi
  WEB_ORIGIN_VALUE="$(grep -E '^WEB_ORIGIN=' "$ENV_FILE" | head -n1 | cut -d= -f2-)"
  WEB_ORIGIN_VALUE="${WEB_ORIGIN_VALUE:-http://localhost:5173}"
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
  # `ask`, not a bare `read`. These two were the only prompts on the unconditional path that called
  # `read` directly, and under `set -euo pipefail` a `read` with no stdin returns non-zero at EOF and
  # takes the whole script with it — so `TS_AUTO=1 ./install.sh`, the documented non-interactive mode
  # (docs/INSTALLATION.md) and the exact command CI's install-e2e job runs, died here every time
  # having printed the line above and nothing else. Every other prompt in this file either goes
  # through `ask` or sits inside a branch whose condition does, which is why only these two failed.
  WEB_ORIGIN_VALUE="$(ask "Public URL for the web app [http://localhost:5173]: " "http://localhost:5173")"
  APP_BASE_URL_VALUE="$(ask "Public URL for the API (used as the SSO callback base) [${WEB_ORIGIN_VALUE}]: " "$WEB_ORIGIN_VALUE")"

  # Asked, not assumed, and asked HERE rather than buried in docs: this is the one setting whose
  # wrong value is completely silent. Every per-IP rate limit in the app reads req.ip, and Express
  # only derives that from X-Forwarded-For when this is set — so at 0 behind a proxy the login
  # limiter degrades from "20/min per attacker" to "20/min for the entire internet", with no error
  # and no log line. The default offered is 1 because it is correct for this stack as shipped: the
  # web container's nginx proxies /api to the api container (apps/web/nginx.conf.template), so a browser
  # request already crosses one proxy before it arrives.
  #
  # A COUNT and not a boolean because `trust proxy: true` believes the left-most X-Forwarded-For
  # entry, which the caller supplies — anyone could then forge req.ip and walk past every limiter.
  printf '\nHow many reverse proxies sit in front of the API?\n'
  printf '  1 — this stack as shipped (the web container'"'"'s nginx proxies /api to the api container)\n'
  printf '  2 — plus docker-compose.https.yml'"'"'s Caddy in front of that\n'
  printf '  +1 more for anything else in front (Cloudflare, a corporate load balancer)\n'
  printf '  0 — only if you expose port 4000 directly with nothing in between\n'
  TRUST_PROXY_HOPS_VALUE="$(ask "Proxy hop count [1]: " "1")"
  # Non-numeric input would fail Zod at boot with a message about a variable the operator never
  # typed a number into — cheaper to catch the typo while they are still looking at the prompt.
  if ! [[ "$TRUST_PROXY_HOPS_VALUE" =~ ^[0-9]+$ ]]; then
    warn "'$TRUST_PROXY_HOPS_VALUE' isn't a number — using 1 (this stack's shipped topology)."
    TRUST_PROXY_HOPS_VALUE=1
  fi

  printf '\nWhere should the database live?\n'
  printf '  [1] Set one up for me in Docker (default — fastest for a trial, nothing else to configure)\n'
  printf '  [2] I already have a MySQL server I want to use (a real on-prem box, RDS, Cloud SQL, etc.)\n'
  DB_CHOICE="$(ask "Choice [1]: " "1")"

  if [ "$DB_CHOICE" = "2" ]; then
    printf '\nYour MySQL server needs to already exist and be reachable from wherever this container runs.\n'
    printf 'This installer will try to create the two databases below on it (CREATE DATABASE IF NOT EXISTS) —\n'
    printf 'the account you give it needs privileges for that, or you can pre-create them yourself.\n'
    read -r -p "MySQL host: " EXT_HOST
    while [ -z "$EXT_HOST" ]; do read -r -p "MySQL host (required): " EXT_HOST; done
    read -r -p "MySQL port [3306]: " EXT_PORT_INPUT
    EXT_PORT="${EXT_PORT_INPUT:-3306}"
    read -r -p "MySQL username: " EXT_USER
    while [ -z "$EXT_USER" ]; do read -r -p "MySQL username (required): " EXT_USER; done
    read -r -s -p "MySQL password (input hidden): " EXT_PASSWORD
    printf '\n'
    read -r -p "Tenant database name [timesheet_portal]: " EXT_DB_NAME_INPUT
    EXT_DB_NAME="${EXT_DB_NAME_INPUT:-timesheet_portal}"
    read -r -p "Control-plane database name [timesphere_control]: " EXT_CONTROL_DB_NAME_INPUT
    EXT_CONTROL_DB_NAME="${EXT_CONTROL_DB_NAME_INPUT:-timesphere_control}"

    EXT_USER_ENC="$(urlencode "$EXT_USER")"
    EXT_PASSWORD_ENC="$(urlencode "$EXT_PASSWORD")"
    DATABASE_URL_VALUE="mysql://${EXT_USER_ENC}:${EXT_PASSWORD_ENC}@${EXT_HOST}:${EXT_PORT}/${EXT_DB_NAME}"
    CONTROL_DATABASE_URL_VALUE="mysql://${EXT_USER_ENC}:${EXT_PASSWORD_ENC}@${EXT_HOST}:${EXT_PORT}/${EXT_CONTROL_DB_NAME}"
    DB_ENV_LINES="DATABASE_URL=${DATABASE_URL_VALUE}
CONTROL_DATABASE_URL=${CONTROL_DATABASE_URL_VALUE}"
    COMPOSE_FILE="docker-compose.external-db.yml"

    # PREFLIGHT — prove the credentials work and the databases can exist BEFORE any container
    # starts. Without this, a restricted account (typical on RDS/Cloud SQL, where nobody hands
    # out CREATE) fails three minutes later as an opaque P1003 deep in `docker compose logs api`.
    # Prisma's migrate deploy does create a missing database when the account has the privilege —
    # verified against MySQL directly — so creating them here also covers accounts that can
    # CREATE; the failure case this exists for is the account that can't.
    #
    # Runs the mysql client from the official image so the HOST needs no mysql client installed —
    # Docker is already a hard requirement by this point.
    log "Preflight: verifying MySQL connectivity and creating databases if needed..."
    if docker run --rm mysql:8.4 mysql         -h"$EXT_HOST" -P"$EXT_PORT" -u"$EXT_USER" -p"$EXT_PASSWORD"         -e "CREATE DATABASE IF NOT EXISTS \`$EXT_DB_NAME\`; CREATE DATABASE IF NOT EXISTS \`$EXT_CONTROL_DB_NAME\`;" 2>/tmp/ts-db-preflight.err; then
      log "Preflight passed: both databases exist and the account can reach them."
    else
      warn "Could not connect or create the databases. The server said:"
      sed 's/^/    /' /tmp/ts-db-preflight.err >&2 || true
      warn "If the account is deliberately restricted, pre-create the databases and grant access:"
      warn "  CREATE DATABASE \`$EXT_DB_NAME\`; CREATE DATABASE \`$EXT_CONTROL_DB_NAME\`;"
      warn "  GRANT ALL PRIVILEGES ON \`$EXT_DB_NAME\`.* TO '$EXT_USER'@'%';"
      warn "  GRANT ALL PRIVILEGES ON \`$EXT_CONTROL_DB_NAME\`.* TO '$EXT_USER'@'%';"
      fail "Fix the database access above, then re-run this script. Nothing has been started."
    fi
  else
    # Hex, not base64: this value gets embedded unencoded in a mysql:// DSN below, and base64's
    # alphabet includes '/' and '+' — either would corrupt the URL (a literal '/' reads as a path
    # separator). Hex is alphanumeric-only, so it's always URL-safe regardless of what it rolls.
    MYSQL_ROOT_PASSWORD_VALUE="$(rand_hex32)"
    DB_ENV_LINES="MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD_VALUE}
MYSQL_DATABASE=timesheet_portal
DATABASE_URL=mysql://root:${MYSQL_ROOT_PASSWORD_VALUE}@mysql:3306/timesheet_portal
CONTROL_DATABASE_URL=mysql://root:${MYSQL_ROOT_PASSWORD_VALUE}@mysql:3306/timesphere_control"
    COMPOSE_FILE="docker-compose.yml"
  fi

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
  CONFIGURE_SMTP="$(ask "Configure SMTP now? [y/N]: " "N")"
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
# each of these does. ${COMPOSE_FILE} reads this file automatically.
${DB_ENV_LINES}
DEFAULT_ORG_SLUG=default
JWT_ACCESS_SECRET=$(rand_b64)
JWT_REFRESH_SECRET=$(rand_b64)
PLATFORM_ADMIN_JWT_SECRET=$(rand_b64)
ENCRYPTION_KEY=$(rand_hex32)
WEB_ORIGIN=${WEB_ORIGIN_VALUE}
APP_BASE_URL=${APP_BASE_URL_VALUE}
# Reverse-proxy hops in front of the API. Every per-IP rate limit reads req.ip, which Express
# derives from X-Forwarded-For only when this is set. See docs/DEPLOYMENT.md.
TRUST_PROXY_HOPS=${TRUST_PROXY_HOPS_VALUE}
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

# Auto-heal: refuse to fight for ports the host is already using for something else — better to
# fail fast here with a clear message than have `docker compose up` silently bind-fail deep in
# its own logs. Only checks 3307 (not MySQL's usual 3306, deliberately — docker-compose.yml maps
# its bundled MySQL container to host port 3307 so it never collides with a local/XAMPP MySQL on
# 3306) when actually using that bundled container — docker-compose.external-db.yml never binds
# a MySQL port on the host at all.
if [ "$COMPOSE_FILE" = "docker-compose.yml" ]; then
  PORTS_TO_CHECK=(4000 5173 3307)
else
  PORTS_TO_CHECK=(4000 5173)
fi
for PORT in "${PORTS_TO_CHECK[@]}"; do
  if ! check_port_free "$PORT"; then
    warn "Port $PORT looks already in use on this machine. If it's not an old TimeSphere stack (check: docker compose -f $COMPOSE_FILE ps), stop whatever's using it or edit the port mapping in $COMPOSE_FILE before continuing."
  fi
done

log "Building and starting the stack (this can take a few minutes on first run)..."
if [ "$COMPOSE_FILE" = "docker-compose.external-db.yml" ]; then
  log "Using $COMPOSE_FILE (your own MySQL server, no bundled mysql container)"
fi
docker compose -f "$COMPOSE_FILE" up -d --build

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
  docker compose -f "$COMPOSE_FILE" ps
  # Auto-heal: a container that crashed on boot (e.g. a transient migration lock, or the mysql
  # container not yet ready when api first tried to connect) usually recovers with a restart —
  # `docker compose restart` reuses the already-built images, so this is fast, not a full rebuild.
  docker compose -f "$COMPOSE_FILE" restart api || true
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
    # A restart cannot fix ONE failure, and it is the failure most likely to be sitting here:
    # a migration that died part way. MySQL DDL is not transactional and Prisma does not roll back,
    # so the half-applied migration stays applied while `_prisma_migrations` records it FAILED, and
    # every subsequent `migrate deploy` refuses with P3009. The restart loop above then re-hits that
    # same P3009 on every attempt — the container will never come up, no matter how many restarts.
    # This is not hypothetical: it is what a fresh install hit on MySQL 8.0.46 (see the
    # session-device migration and its @rerunnable guards).
    #
    # `doctor:heal` clears it — it names the stranded migration, then runs `migrate resolve
    # --rolled-back` and `migrate deploy` again, but only for a migration marked @rerunnable, i.e.
    # one that guards its own DDL and is safe to replay over a partial application. It never runs
    # `prisma migrate reset` (which drops the database). `run --rm --no-deps` because the api
    # container is exactly what is not running, and mysql is healthy and should be left alone.
    API_LOGS="$(docker compose -f "$COMPOSE_FILE" logs --tail=200 api 2>/dev/null || true)"
    case "$API_LOGS" in
      *P3009*|*"migrate found failed migrations"*)
        warn "A migration is recorded as FAILED in _prisma_migrations (Prisma P3009) — restarting can never clear that."
        log "Attempting doctor-led recovery (only auto-repairs a migration marked @rerunnable)..."
        if docker compose -f "$COMPOSE_FILE" run --rm --no-deps --entrypoint sh api \
             -c 'npm run doctor:heal -w apps/api'; then
          docker compose -f "$COMPOSE_FILE" up -d api
          for _ in $(seq 1 30); do
            if curl -fsS http://localhost:4000/health >/dev/null 2>&1; then API_READY=true; break; fi
            sleep 3
          done
          [ "$API_READY" = true ] && log "API recovered after clearing the stranded migration."
        else
          warn "Automatic recovery did not succeed. Run this — it names the migration and the exact commands:"
          warn "  docker compose -f $COMPOSE_FILE run --rm --no-deps --entrypoint sh api -c 'npm run doctor -w apps/api'"
          warn "Do NOT run 'prisma migrate reset' — Prisma's own error text suggests it, and it drops the database."
        fi
        ;;
    esac
  fi
  if [ "$API_READY" != true ]; then
    warn "Still not healthy — check 'docker compose -f $COMPOSE_FILE logs api' for the actual error."
    if [ "$COMPOSE_FILE" = "docker-compose.yml" ]; then
      warn "Migrations run automatically on boot; a slow first-pull of the mysql:8.4 image is the usual cause on a fresh install."
    else
      warn "Migrations run automatically on boot; double-check your external MySQL server is actually reachable from this machine/container (host, port, firewall, and that the account you gave it can log in)."
    fi
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
  if docker compose -f "$COMPOSE_FILE" exec -T api npm run control:seed -w apps/api && docker compose -f "$COMPOSE_FILE" exec -T api npm run seed -w apps/api; then
    SEED_OK=true
    break
  fi
  warn "Seed attempt $attempt/3 failed — this is often \"already seeded\" (safe to ignore) or a DB-not-ready race. Retrying in 5s..."
  sleep 5
done
if [ "$SEED_OK" = true ]; then
  log "Seed complete."
else
  warn "Seeding didn't succeed after 3 attempts — if this is a fresh install, check 'docker compose -f $COMPOSE_FILE logs api' and re-run manually:"
  warn "  docker compose -f $COMPOSE_FILE exec api npm run control:seed -w apps/api && docker compose -f $COMPOSE_FILE exec api npm run seed -w apps/api"
  warn "If it's an already-seeded re-run, this is expected and safe to ignore."
fi

# ── VERIFICATION SUITE ────────────────────────────────────────────────────────────────────────
# "Installed" below means PROVEN, not presumed: each check exercises a different layer, so a pass
# here is evidence the stack genuinely works — not just that a port answered. A failed install
# that says so loudly is worth far more than a green banner over a broken stack.
log "Verifying the installation..."
VERIFY_FAILED=0
verify() { # verify <label> <command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  [1;32m[pass][0m %s
' "$label"
  else
    printf '  [1;31m[FAIL][0m %s
' "$label"
    VERIFY_FAILED=1
  fi
}

# Layer 1: the process answers.
verify "API health endpoint responds" curl -fsS http://localhost:4000/health

# Layer 2: the running server identifies as the version this checkout says it should be —
# catches "an old image from a previous attempt is still running", which health alone never can.
EXPECTED_VERSION="$(cat "$ROOT_DIR/VERSION" 2>/dev/null | tr -d '[:space:]')"
check_reported_version() { curl -fsS http://localhost:4000/api/system/version | grep -q "\"version\":\"$EXPECTED_VERSION\""; }
verify "server reports version ${EXPECTED_VERSION:-unknown}" check_reported_version

# Layer 3: both schemas are fully migrated — TCP health checks connectivity, not schema state,
# and a half-migrated database is precisely the failure that surfaces days later as a 500.
verify "tenant schema at latest migration"   docker compose -f "$COMPOSE_FILE" exec -T api npx prisma migrate status --schema=apps/api/prisma/schema.prisma
verify "control-plane schema at latest migration"   docker compose -f "$COMPOSE_FILE" exec -T api npx prisma migrate status --schema=apps/api/prisma/control/schema.prisma

# Layer 4: authentication round-trips — the seeded platform-admin can actually log in, which
# proves seeding, password hashing, JWT signing and the DB read path in one request.
check_admin_login() {
  curl -fsS -X POST http://localhost:4000/api/platform-admin/auth/login     -H 'Content-Type: application/json'     --data '{"email":"platform-admin@timesphere.local","password":"PlatformAdmin@12345"}'     | grep -q accessToken
}
verify "platform-admin login returns a token" check_admin_login

# Layer 5: the web container serves the SPA shell.
check_spa() { curl -fsS http://localhost:5173 | grep -qi "id=.root."; }
verify "web app serves the SPA" check_spa

# Layer 6: the face-detection models are actually in the image.
#
# These are copied out of node_modules by apps/web/scripts/copy-face-models.mjs during the web
# build, so a build that skipped that step produces an image that looks perfectly healthy and has
# no camera guidance in it. The failure is silent and it surfaces days later as "the face check
# doesn't help me aim any more", which is a miserable thing to diagnose from a bug report. One
# curl proves the asset shipped. Not fatal on its own — face verification is optional and the
# camera still works with a manual shutter — so this warns rather than failing the install.
check_face_models() { curl -fsS -o /dev/null http://localhost:5173/human-models/blazeface.json; }
if check_face_models; then
  printf '  [1;32m✓[0m %s
' "face-detection models are served"
else
  warn "Face-detection models are missing from the web image — the camera will still work, but without live guidance."
  warn "Rebuild with: docker compose -f $COMPOSE_FILE build --no-cache web"
fi

if [ "$VERIFY_FAILED" = "1" ]; then
  warn "One or more verification checks FAILED — the stack is up but not proven healthy."
  warn "Diagnose with: docker compose -f $COMPOSE_FILE logs api"
  exit 1
fi
log "All verification checks passed."


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
  - MCP server at POST /api/mcp so an AI assistant can read/act on this workspace — ships DISABLED
    with its write tools off individually; a super admin enables it and issues a per-user
    credential from Workspace Settings -> MCP server. See docs/DEPLOYMENT.md.

Next steps are in docs/DEPLOYMENT.md — first org admin login, SMTP setup, backups, and (if you
outgrow one company) the SaaS multi-org shape. Full feature walkthrough: docs/INSTALLATION.md's
"Configuring things after install" table.
EOF
