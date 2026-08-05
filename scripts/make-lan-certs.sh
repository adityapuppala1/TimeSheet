#!/usr/bin/env bash
# Generates a locally-trusted TLS certificate for every address this machine answers on, and
# installs it where both HTTPS entry points already look:
#
#   apps/web/certs/dev-key.pem + dev-cert.pem   -> `npm run dev` (vite.config.ts auto-detects)
#   deploy/caddy/certs/key.pem + cert.pem       -> docker-compose.https.yml (Caddyfile.local)
#
# WHY: browsers expose the camera (and clipboard) only on secure origins. localhost is exempt,
# so everything works on the dev machine and silently fails for every phone/laptop opening
# http://<lan-ip> — no application setting can change that. A certificate can.
#
# Replicating on another machine is exactly these three steps: install mkcert, run this script,
# trust the printed root CA on each device that will use the app. Run from the repo root:
#
#   bash scripts/make-lan-certs.sh
#
set -euo pipefail

if ! command -v mkcert > /dev/null 2>&1; then
  echo "mkcert is not installed. Install it with ONE of:"
  echo "  sudo apt install mkcert libnss3-tools     # Debian/Ubuntu"
  echo "  brew install mkcert nss                   # macOS"
  echo "then run this script again."
  exit 1
fi

mkcert -install

# Every non-loopback, non-link-local IPv4 this machine answers on.
if command -v hostname > /dev/null 2>&1 && hostname -I > /dev/null 2>&1; then
  IPS=$(hostname -I | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^169\.254\.' | grep -v '^127\.' | sort -u)
else
  IPS=$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127\.' | grep -v '^169\.254\.' | sort -u)
fi
HOSTS="localhost 127.0.0.1 ::1 $(echo "$IPS" | tr '\n' ' ')"
echo "Issuing a certificate for: $HOSTS"

mkdir -p apps/web/certs deploy/caddy/certs
# shellcheck disable=SC2086 — the hosts are deliberately word-split into separate args.
mkcert -key-file apps/web/certs/dev-key.pem -cert-file apps/web/certs/dev-cert.pem $HOSTS
cp apps/web/certs/dev-key.pem deploy/caddy/certs/key.pem
cp apps/web/certs/dev-cert.pem deploy/caddy/certs/cert.pem

CAROOT=$(mkcert -CAROOT)
PRIMARY_IP=$(echo "$IPS" | head -1)
cat <<EOF

Done. What happens now:
  - 'npm run dev' serves https://localhost:5173 and https://${PRIMARY_IP}:5173 (restart it once).
  - Docker: docker compose -f docker-compose.yml -f docker-compose.https.yml up -d  ->  https://${PRIMARY_IP}

For OTHER devices (each one, once): install and trust the root CA at
  ${CAROOT}/rootCA.pem
  - Android: copy the file over, Settings > Security > Install a certificate > CA certificate.
  - iOS: AirDrop/email the file, install the profile, then ALSO enable it under
         Settings > General > About > Certificate Trust Settings (the step everyone misses).
  - Linux/macOS/Windows: run 'mkcert -install' there, or import rootCA.pem into the trust store.

Then update apps/api/.env APP_BASE_URL to the https address (emailed links), e.g.:
  APP_BASE_URL="https://${PRIMARY_IP}:5173"

The certificate names the addresses of THIS machine on THIS network — if the machine's IP
changes (new network, DHCP), run this script again.
EOF
