# Shared self-healing steps for install.sh and update.sh. Sourced, never run: both scripts define
# log/warn/fail and AUTO/ask before sourcing this, and everything here leans on those.
#
# Every function is NON-FATAL unless it says otherwise: a check that cannot run on this machine (no
# df, no network, not a git clone) returns 0 and lets the install continue, because a one-click
# installer that dies on a missing helper is worse than one that skips the helper.

# Docker Desktop answers `docker compose version` before its engine is up — that command is the
# client alone. `docker info` needs the daemon. Wait for it instead of failing the whole install on a
# machine that was simply still starting Docker.
heal_wait_for_docker() { # FATAL after ~2 minutes
  docker info >/dev/null 2>&1 && return 0
  log "Docker is installed but its engine isn't answering yet — waiting up to 2 minutes for it to start..."
  for _ in $(seq 1 40); do
    sleep 3
    docker info >/dev/null 2>&1 && { log "Docker engine is up."; return 0; }
  done
  fail "The Docker engine never became ready. Start Docker Desktop (or 'sudo systemctl start docker'), wait until it says it is running, and re-run."
}

# An image build needs a few GB, and a backup needs room for the dump. Running out half way leaves a
# half-built image or a truncated backup — both worse than refusing up front.
heal_check_disk() { # heal_check_disk <purpose>  — FATAL below 2 GB free
  command -v df >/dev/null 2>&1 || return 0
  local free_kb
  free_kb="$(df -Pk . 2>/dev/null | awk 'NR==2 {print $4}')"
  [ -n "$free_kb" ] || return 0
  local free_gb=$(( free_kb / 1024 / 1024 ))
  if [ "$free_kb" -lt $(( 2 * 1024 * 1024 )) ]; then
    fail "Only ${free_gb} GB free here — not enough for $1. Free some space (docker system prune -f reclaims old images) and re-run."
  elif [ "$free_kb" -lt $(( 5 * 1024 * 1024 )) ]; then
    warn "Only ${free_gb} GB free — $1 may run short. 'docker system prune -f' reclaims unused images."
  fi
  return 0
}

# A build that fails is most often the network (a registry or npm timeout) or a stale layer cache,
# and both clear on a retry. Attempt 3 rebuilds from scratch with fresh base images — the cure for a
# poisoned cache, and slow enough that it is the last resort, not the first.
heal_compose_up() { # heal_compose_up <compose-file>  — FATAL after 3 attempts
  local file="$1"
  for attempt in 1 2 3; do
    case "$attempt" in
      1) docker compose -f "$file" up -d --build && return 0 ;;
      2) warn "Build/start failed (attempt 1/3) — usually a network hiccup. Retrying in 15s..."
         sleep 15
         docker compose -f "$file" up -d --build && return 0 ;;
      3) warn "Build/start failed again (attempt 2/3) — rebuilding from scratch with fresh base images (slower)..."
         docker compose -f "$file" build --pull --no-cache && docker compose -f "$file" up -d && return 0 ;;
    esac
  done
  fail "The stack would not build after 3 attempts. The error is above; 'docker compose -f $file build' shows it again."
}

# The checkout an installer runs from can be an old release — a clone made months ago, or an
# archived tag. Offer the newest release BEFORE installing, so the install is not immediately
# followed by an update. Only a checkout sitting exactly on an older release tag is switched: a
# branch is somebody's deliberate choice, and local edits are never thrown away. Re-execs the NEW
# installer afterwards, because bash reads a script as it runs and the file just changed under it.
heal_offer_newest_release() { # heal_offer_newest_release <script> <args...>
  [ "${TS_RELEASE_CHECKED:-0}" = "1" ] && return 0
  command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1 || return 0
  local limit=""
  command -v timeout >/dev/null 2>&1 && limit="timeout 20" # absent on stock macOS
  $limit git fetch --tags --quiet origin 2>/dev/null || { warn "Couldn't reach the repository to check for a newer release — installing this checkout as it is."; return 0; }
  local newest current_tag
  newest="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' | sort -V | tail -n1)"
  current_tag="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
  [ -n "$newest" ] || return 0
  if [ -z "$current_tag" ]; then
    log "Installing from $(git rev-parse --abbrev-ref HEAD) (not a release tag). The newest release is $newest."
    return 0
  fi
  [ "$current_tag" = "$newest" ] && { log "This checkout is the newest release ($newest)."; return 0; }
  # sort -V: is the current tag actually OLDER, not merely different?
  [ "$(printf '%s\n%s\n' "$current_tag" "$newest" | sort -V | tail -n1)" = "$newest" ] || return 0
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    warn "A newer release ($newest) exists, but this checkout has local changes — installing $current_tag as it is."
    return 0
  fi
  local answer
  answer="$(ask "This checkout is $current_tag; the newest release is $newest. Install $newest instead? [Y/n]: " "Y")"
  case "$answer" in [nN]*) log "Installing $current_tag as asked."; return 0 ;; esac
  git checkout --quiet "$newest" || { warn "Couldn't switch to $newest — installing $current_tag."; return 0; }
  log "Switched to $newest — restarting the installer from the new version."
  export TS_RELEASE_CHECKED=1
  exec bash "$@"
}
