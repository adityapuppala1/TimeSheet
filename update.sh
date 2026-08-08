#!/usr/bin/env bash
# One-command updater for a TimeSphere installed by install.sh (the Docker Compose shape).
#
#   ./update.sh              # update to the newest released tag (vX.Y.Z)
#   ./update.sh --to v1.2.3  # update to a specific release
#
# WHAT IT GUARANTEES, in order:
#   1. A database backup exists BEFORE anything changes (mysqldump of both schemas, kept in
#      ./backups/ either way — the safety net that makes every later step survivable).
#   2. The previous code ref is recorded, so "go back" is a checkout, not an archaeology dig.
#   3. After the rebuild, the SAME verification suite install.sh uses must pass — health, the
#      server reporting the TARGET version, both schemas fully migrated, login round-trip.
#   4. If verification fails, it AUTOMATICALLY rolls the code back to the previous ref, rebuilds,
#      and re-verifies — the deployment ends the run working on the old version rather than
#      broken on the new one.
#
# WHY ROLLBACK IS CODE-ONLY (the DB backup is kept but not auto-restored): this project's
# migration policy is additive-only — new columns and tables, never drops (see docs/DATABASE.md).
# Old code runs correctly against a newer schema, so rolling back the code is sufficient and
# instant. Auto-restoring a dump over a live database is the one step that can DESTROY data if
# anything about the failure was misdiagnosed, so that decision is left with the human, dump in
# hand. K8s deployments don't use this script at all — `helm upgrade` + `helm rollback` already
# do this dance natively (see docs/DEPLOYMENT.md).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m[error]\033[0m %s\n' "$1" >&2; exit 1; }

# ── Preconditions ─────────────────────────────────────────────────────────────────────────────
[ -f .env ] || fail "No .env here — this doesn't look like an installed deployment. Run ./install.sh first."
command -v git >/dev/null 2>&1 || fail "git is required to update (the deployment updates by checking out release tags)."
git rev-parse --git-dir >/dev/null 2>&1 || fail "This directory isn't a git clone. Updates need one: git clone the repo, copy your .env in, and run ./install.sh once — after that ./update.sh works."
docker compose version >/dev/null 2>&1 || fail "Docker Compose isn't available — is the Docker daemon running?"

# Same detection install.sh uses: MYSQL_ROOT_PASSWORD only ever exists for the bundled-MySQL path.
if grep -qE "^MYSQL_ROOT_PASSWORD=" .env; then COMPOSE_FILE="docker-compose.yml"; else COMPOSE_FILE="docker-compose.external-db.yml"; fi
log "Deployment shape: $COMPOSE_FILE"

if [ -n "$(git status --porcelain)" ]; then
  fail "This checkout has local modifications. Updating would checkout over them — stash or commit first (git status)."
fi

# ── Proxy-attribution check ───────────────────────────────────────────────────────────────────
# TRUST_PROXY_HOPS has a default (0), so an .env written before it existed is not "broken" — it
# just quietly attributes every request to the proxy. That makes it invisible to every check in
# this script: health passes, migrations pass, login passes, and the login rate limiter is one
# shared bucket for the whole internet. An updater that says nothing here is the reason a
# deployment can sit misconfigured for a year.
#
# EVERY compose deployment is at least one hop: apps/web/nginx.conf proxies /api to the api
# container, so browser traffic never reaches the API directly. The extra signals below only
# sharpen the recommended NUMBER; they are not what triggers the warning.
TRUST_PROXY_LINE="$(grep -E '^TRUST_PROXY_HOPS=' .env | head -n1 | cut -d= -f2- | tr -d '[:space:]' || true)"
PROXY_WARNED=0
if [ -z "$TRUST_PROXY_LINE" ] || [ "$TRUST_PROXY_LINE" = "0" ]; then
  PROXY_WARNED=1
  SUGGESTED_HOPS=1
  # Caddy in front of the web container's nginx is a second hop. Either variable being present is
  # how docker-compose.https.yml is switched on, so either one is the signal.
  if grep -qE '^(HTTPS_DOMAIN|CADDYFILE)=.+' .env; then SUGGESTED_HOPS=2; fi
  warn "TRUST_PROXY_HOPS is ${TRUST_PROXY_LINE:-unset} — this deployment sits behind a proxy."
  warn "  The web container's nginx proxies /api to the api container, so req.ip is nginx's"
  warn "  address for EVERY caller: the 20/min login limiter and every other per-IP limit are"
  warn "  currently one shared global bucket, and nothing logs that they are."
  warn "  Fix: put TRUST_PROXY_HOPS=$SUGGESTED_HOPS in .env and re-run this script (or restart the api"
  warn "  container). Add one more hop for anything else in front, e.g. Cloudflare."
  warn "  Not a blocker — this update continues. See docs/DEPLOYMENT.md."
fi

# ── Resolve the target release ────────────────────────────────────────────────────────────────
TARGET_TAG="${2:-}"
if [ "${1:-}" = "--to" ] && [ -n "$TARGET_TAG" ]; then
  :
else
  log "Fetching release tags..."
  git fetch --tags --quiet origin
  # Newest semver tag. `sort -V` orders 1.9 < 1.10 correctly, which lexical sort does not.
  TARGET_TAG="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -n1)"
  [ -n "$TARGET_TAG" ] || fail "No release tags (vX.Y.Z) exist yet — nothing to update to."
fi
git rev-parse -q --verify "refs/tags/$TARGET_TAG" >/dev/null || { git fetch --tags --quiet origin; git rev-parse -q --verify "refs/tags/$TARGET_TAG" >/dev/null || fail "Tag $TARGET_TAG doesn't exist."; }

CURRENT_REF="$(git rev-parse --short=12 HEAD)"
CURRENT_VERSION="$(tr -d '[:space:]' < VERSION 2>/dev/null || echo unknown)"
TARGET_VERSION="${TARGET_TAG#v}"

if [ "$CURRENT_VERSION" = "$TARGET_VERSION" ]; then
  log "Already on $CURRENT_VERSION — nothing to do."
  exit 0
fi
log "Updating: v$CURRENT_VERSION ($CURRENT_REF) -> $TARGET_TAG"

# ── 1. Backup FIRST ───────────────────────────────────────────────────────────────────────────
mkdir -p backups
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_FILE="backups/pre-update-${CURRENT_VERSION}-to-${TARGET_VERSION}-${STAMP}.sql.gz"
log "Backing up both databases to $BACKUP_FILE ..."
if [ "$COMPOSE_FILE" = "docker-compose.yml" ]; then
  # Bundled MySQL: dump from inside its own container, credentials from the container's env —
  # never parsed out of .env, so a hand-edited quoting style can't corrupt the command.
  # --all-databases rather than naming the two defaults: a platform admin can provision MORE
  # organizations, each with its own database on this same container, and a backup that silently
  # misses them isn't a backup — it's a surprise scheduled for restore day.
  docker compose -f "$COMPOSE_FILE" exec -T mysql sh -c \
    'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --all-databases --single-transaction --no-tablespaces' \
    | gzip > "$BACKUP_FILE" \
    || fail "Backup failed — refusing to update without one. Is the mysql container running (docker compose ps)?"
else
  warn "External-database deployment: this script cannot reach into your MySQL server to back it up."
  warn "Take your own backup/snapshot NOW (RDS snapshot, mysqldump from a host that can reach it)."
  read -r -p "Type 'backed-up' to confirm you have one: " CONFIRM
  [ "$CONFIRM" = "backed-up" ] || fail "Not updating without a backup. Nothing has changed."
  BACKUP_FILE="(external — operator-managed)"
fi
log "Backup ready: $BACKUP_FILE"

# ── 2-3. Checkout, rebuild, verify ────────────────────────────────────────────────────────────
run_verification() { # run_verification <expected-version>  — mirrors install.sh's suite
  local expected="$1" ok=0
  for _ in $(seq 1 60); do curl -fsS http://localhost:4000/health >/dev/null 2>&1 && { ok=1; break; }; sleep 3; done
  [ "$ok" = "1" ] || return 1
  curl -fsS http://localhost:4000/api/system/version | grep -q "\"version\":\"$expected\"" || return 1
  docker compose -f "$COMPOSE_FILE" exec -T api npx prisma migrate status --schema=apps/api/prisma/schema.prisma >/dev/null 2>&1 || return 1
  docker compose -f "$COMPOSE_FILE" exec -T api npx prisma migrate status --schema=apps/api/prisma/control/schema.prisma >/dev/null 2>&1 || return 1
  curl -fsS -X POST http://localhost:4000/api/platform-admin/auth/login \
    -H 'Content-Type: application/json' \
    --data '{"email":"platform-admin@timesphere.local","password":"PlatformAdmin@12345"}' \
    | grep -q accessToken || warn "Login check inconclusive (the seeded platform-admin password may have been changed — that's fine)."
  # Advisory, matching install.sh's layer 6: the face-detection models are produced by the web
  # build, so an image built without that step is healthy in every other respect and silently has
  # no camera guidance. Warn rather than fail — this must never roll back an otherwise good update.
  curl -fsS -o /dev/null http://localhost:5173/human-models/blazeface.json 2>/dev/null     || warn "Face-detection models are missing from the web image — camera guidance will be unavailable until it is rebuilt."
  return 0
}

deploy_ref() { # deploy_ref <git-ref>  — checkout + rebuild + up; migrations run on container boot
  git checkout --quiet "$1"
  docker compose -f "$COMPOSE_FILE" up -d --build
}

migrate_extra_tenants() {
  # Container boot migrates DATABASE_URL — the default org. But a platform admin can PROVISION
  # MORE organizations after install, each with its own database, and boot never touches those.
  # migrate-all-tenants.ts walks the control-plane registry and brings every tenant database to
  # the latest migration, with per-org failure isolation. In a plain single-org deployment it
  # finds only the default org (already migrated) and is a fast no-op — so this is safe to run
  # unconditionally, and skipping it would leave any extra org on the OLD schema while the NEW
  # code runs against it: precisely the drift the additive-only policy cannot excuse.
  #
  # NO PER-RELEASE EDIT IS EVER NEEDED HERE. The target is whatever `getLatestMigrationName()`
  # (services/provisioning.service.ts) reads off the CHECKED-OUT prisma/migrations directory, so
  # each release's new migration is picked up by name — 2.3.0's `20260808120000_mcp_server` is
  # applied to every tenant by this call without a line of this script changing.
  log "Migrating any additional tenant databases..."
  docker compose -f "$COMPOSE_FILE" exec -T api npm run migrate:tenants -w apps/api     || warn "migrate:tenants reported a problem — check which org failed above; the default org is unaffected."
}

log "Deploying $TARGET_TAG (build + migrate + restart)..."
deploy_ref "$TARGET_TAG"

# Wait for the API before tenant migration — the exec needs a running container.
for _ in $(seq 1 60); do curl -fsS http://localhost:4000/health >/dev/null 2>&1 && break; sleep 3; done
migrate_extra_tenants

log "Verifying the new version..."
if run_verification "$TARGET_VERSION"; then
  printf '\033[1;32m✓ Updated to %s.\033[0m\n' "$TARGET_TAG"
  log "Everyone with the app open will be offered a refresh automatically (the version rides on the health poll)."
  log "Database backup kept at: $BACKUP_FILE"
  # Repeated deliberately: the same warning was printed before a multi-minute docker build, which
  # is exactly how a warning stops being read. This is the last thing on screen instead.
  if [ "$PROXY_WARNED" = "1" ]; then
    warn "Still to do: set TRUST_PROXY_HOPS in .env (see the warning near the start of this run)."
  fi
  exit 0
fi

# ── 4. Auto-rollback ──────────────────────────────────────────────────────────────────────────
warn "Verification FAILED on $TARGET_TAG — rolling back to $CURRENT_REF ..."
docker compose -f "$COMPOSE_FILE" logs --tail=80 api || true
deploy_ref "$CURRENT_REF"

if run_verification "$CURRENT_VERSION"; then
  warn "Rolled back: the deployment is running v$CURRENT_VERSION again, unchanged."
  warn "The failed update's logs are above; the pre-update backup is at: $BACKUP_FILE"
  warn "Migrations are additive-only, so the newer schema under the old code is safe by policy."
  exit 1
fi

fail "Rollback verification ALSO failed — manual attention needed. Backup: $BACKUP_FILE ; logs: docker compose -f $COMPOSE_FILE logs api"
