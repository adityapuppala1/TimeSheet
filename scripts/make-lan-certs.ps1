# Generates a locally-trusted TLS certificate for every address this machine answers on, and
# installs it where both HTTPS entry points already look:
#
#   apps/web/certs/dev-key.pem + dev-cert.pem   -> `npm run dev` (vite.config.ts auto-detects)
#   deploy/caddy/certs/key.pem + cert.pem       -> docker-compose.https.yml (Caddyfile.local)
#
# WHY: browsers expose the camera (and clipboard) only on secure origins. localhost is exempt,
# so everything works on the dev machine and silently fails for every phone/laptop opening
# http://<lan-ip> - no application setting can change that. A certificate can.
#
# Replicating on another machine is exactly these three steps: install mkcert, run this script,
# trust the printed root CA on each device that will use the app. Run from the repo root:
#
#   powershell -ExecutionPolicy Bypass -File scripts\make-lan-certs.ps1
#
$ErrorActionPreference = "Stop"

# 1. mkcert present?
$mkcert = Get-Command mkcert -ErrorAction SilentlyContinue
if (-not $mkcert) {
  Write-Host "mkcert is not installed. Install it with ONE of:" -ForegroundColor Yellow
  Write-Host "  winget install FiloSottile.mkcert"
  Write-Host "  choco install mkcert"
  Write-Host "then re-open the terminal and run this script again."
  exit 1
}

# 2. Local CA (idempotent - safe to run again).
mkcert -install

# 3. Every name/address a browser might type. IPv4 only, skipping link-local/loopback ranges
#    (mkcert handles localhost/127.0.0.1 as explicit entries below).
$ips = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -ne "127.0.0.1" } |
  Select-Object -ExpandProperty IPAddress -Unique
$hosts = @("localhost", "127.0.0.1", "::1") + $ips
Write-Host "Issuing a certificate for: $($hosts -join ', ')"

# 4. Generate once, copy to both consumers.
New-Item -ItemType Directory -Force -Path "apps\web\certs" | Out-Null
New-Item -ItemType Directory -Force -Path "deploy\caddy\certs" | Out-Null
mkcert -key-file "apps\web\certs\dev-key.pem" -cert-file "apps\web\certs\dev-cert.pem" @hosts
Copy-Item "apps\web\certs\dev-key.pem" "deploy\caddy\certs\key.pem" -Force
Copy-Item "apps\web\certs\dev-cert.pem" "deploy\caddy\certs\cert.pem" -Force

$caroot = (mkcert -CAROOT).Trim()
$primaryIp = $ips | Select-Object -First 1
Write-Host ""
Write-Host "Done. What happens now:" -ForegroundColor Green
Write-Host "  - 'npm run dev' serves https://localhost:5173 and https://${primaryIp}:5173 (restart it once)."
Write-Host "  - Docker: docker compose -f docker-compose.yml -f docker-compose.https.yml up -d  ->  https://${primaryIp}"
Write-Host ""
Write-Host "For OTHER devices (each one, once): install and trust the root CA at" -ForegroundColor Yellow
Write-Host "  $caroot\rootCA.pem"
Write-Host "  - Android: copy the file over, Settings > Security > Install a certificate > CA certificate."
Write-Host "  - iOS: AirDrop/email the file, install the profile, then ALSO enable it under"
Write-Host "         Settings > General > About > Certificate Trust Settings (the step everyone misses)."
Write-Host "  - Windows/macOS: run 'mkcert -install' there, or import rootCA.pem into the system trust store."
Write-Host ""
Write-Host "Then update apps/api/.env APP_BASE_URL to the https address (emailed links), e.g.:"
Write-Host "  APP_BASE_URL=`"https://${primaryIp}:5173`""
Write-Host ""
Write-Host "The certificate names the addresses of THIS machine on THIS network - if the machine's IP"
Write-Host "changes (new network, DHCP), run this script again."
