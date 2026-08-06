# Deployment Guide

TimeSphere runs as **one codebase, two deployment shapes**:

1. **On-prem / single-org** — one company, one database, no subdomain routing to think about.
   This is `docker-compose.yml` as-is.
2. **SaaS multi-org** — many organizations on one platform, each with its own physically
   separate database, its own SSO configuration, and its own plan tier — administered from a
   separate `/platform-admin` console.

Both shapes share every controller, service, and UI page in `apps/api`/`apps/web`. What differs
is the **control plane** (a small second database — org registry, per-org database connections,
SSO config, plan tiers, platform-admin accounts — see `apps/api/prisma/control/schema.prisma`)
and whether more than one `Organization` row exists in it. Pick the section below that matches
what you're deploying.

Once the platform itself is deployed, see
[docs/NEW_ORGANIZATION_SETUP.md](NEW_ORGANIZATION_SETUP.md) for the production-hardening
checklist and the repeatable runbook for bringing a real organization online.

---

## Shape 1 — On-prem / single-org

The simplest possible deployment: one company, one MySQL database, `DEFAULT_ORG_SLUG` as the
only organization there will ever be. No subdomain routing, no platform-admin console, no
SSO-per-org configuration needed (though SSO still works if you want it — it's just one org's
worth of it).

### One-click install (fastest path — Docker required)

`install.sh` (Linux/macOS) / `install.ps1` (Windows) automate everything below: they check for
Docker + the Compose plugin, generate a root `.env` with strong random secrets (never
overwriting one that already exists), run `docker compose up -d --build`, wait for the API's
health check, then run the one-time seed.

```bash
./install.sh          # Linux/macOS — chmod +x install.sh first if needed
```

```powershell
.\install.cmd          # Windows — the .cmd launcher runs install.ps1 with a process-scoped
                       # execution-policy bypass, so the default Restricted policy can't block it
```

Both scripts are read-only about anything outside this repo — they never install Docker itself,
just tell you where to get it if it's missing. Re-running either script against an
already-configured deployment just brings the stack up again; it won't regenerate secrets or
touch an existing `.env`. Falls back to the manual steps below if you'd rather control each step
(a real production rollout, a non-Docker deploy target, etc.).

### Bringing your own MySQL server

If you don't want the bundled `mysql` container — you already run a real MySQL server (an
on-prem box, RDS, Cloud SQL, PlanetScale, etc.) and want the app containers to use it instead —
both installers ask about this up front:

```
Where should the database live?
  [1] Set one up for me in Docker (default — fastest for a trial, nothing else to configure)
  [2] I already have a MySQL server I want to use (a real on-prem box, RDS, Cloud SQL, etc.)
```

Choosing **[2]** prompts for host, port, username, password, and the two database names (tenant +
control-plane), then:

- Writes `DATABASE_URL`/`CONTROL_DATABASE_URL` in `.env` pointing at your server instead of the
  bundled container — the username/password are URL-encoded automatically, so a password
  containing `@`, `:`, `/`, `#`, or `%` won't corrupt the connection string.
- Uses `docker-compose.external-db.yml` instead of `docker-compose.yml` — the same `api`/`web`
  services, minus the `mysql` service and its `depends_on` (there's nothing bundled to depend on).
  The installer tracks this choice and keeps using the right file on every subsequent step
  (health check, restart, seed) automatically.
- Re-running the installer later against that same `.env` recognizes the choice automatically
  (by checking whether `MYSQL_ROOT_PASSWORD` — only ever written by the bundled-MySQL path — is
  present) and keeps using `docker-compose.external-db.yml` without re-prompting.

Two things this doesn't do for you, on purpose: it doesn't create the databases on your server if
your account lacks `CREATE DATABASE` privileges (the app's own migration step tries
`CREATE DATABASE IF NOT EXISTS` and will fail clearly if it can't — pre-create the two databases
yourself in that case), and it doesn't touch your server's own backup/networking/firewall
configuration — that's on you, same as any other production database you already operate.

If you'd rather skip Docker for the app containers too, the [manual install](#manual-setup)
section below already works with any MySQL server by design — this installer prompt exists
specifically for "I want Docker for the app, but my own database."

### Manual setup

1. Provision one MySQL 8 server, reachable from wherever the API runs.
2. Copy `.env.example` to `apps/api/.env` and fill in:
   - `DATABASE_URL` — this org's one tenant database.
   - `CONTROL_DATABASE_URL` — yes, still required even for a single org (see "Why a control
     plane exists even here" below) — a second, much smaller database on the same server works fine.
   - `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `PLATFORM_ADMIN_JWT_SECRET` — three distinct
     long random strings. Production boot refuses weak/placeholder values for the first two;
     generate all three properly (`openssl rand -base64 48`).
   - `ENCRYPTION_KEY` — 64 hex chars (`openssl rand -hex 32`).
   - `WEB_ORIGIN` / `APP_BASE_URL` — your real domain.
   - Leave `TENANT_DB_PROVISION_BASE_URL` unset — this deployment shape never provisions a
     second organization, so in-app provisioning isn't relevant.
3. `npm ci && npm run build`.
4. Run migrations + seed the control plane and the one tenant:
   ```bash
   npm run db:generate -w apps/api
   npm run db:migrate -w apps/api        # or: prisma migrate deploy in production
   npm run control:generate -w apps/api
   npm run control:migrate -w apps/api
   npm run control:seed -w apps/api      # registers DEFAULT_ORG_SLUG pointing at DATABASE_URL
   npm run seed -w apps/api              # seeds roles/permissions/demo data into that one tenant DB
   ```
5. Deploy `apps/api/dist` behind HTTPS, `apps/web/dist` behind a static host/Nginx, or just run
   `docker compose up --build` — its `api` service already runs both schemas' `prisma migrate
   deploy` automatically on every boot (see `docker-compose.yml`'s `command:`), and it needs the
   same `CONTROL_DATABASE_URL`/`ENCRYPTION_KEY`/`PLATFORM_ADMIN_JWT_SECRET` env vars set as step 2
   above (Compose reads them from your shell or a `.env` file next to `docker-compose.yml`).
6. **Seed once, after first boot** — migrations run automatically every restart, but seeding
   (roles/permissions, the control-plane plan tiers + platform-admin account, this org's demo
   data) is a one-time bootstrap step, run from your own machine against the database directly
   rather than baked into the container's startup command (so it never re-runs against live
   data). `docker-compose.yml` exposes MySQL on host port `3307`, so point `DATABASE_URL`/
   `CONTROL_DATABASE_URL` at `localhost:3307` locally and run the same `control:seed`/`seed`
   commands from step 4.
7. Configure SMTP (`SMTP_*`) for real email delivery, enable MySQL backups, and point your log
   aggregator at the container/process output.
8. If you plan to enable **face verification**, note that it writes to `UPLOAD_DIR/face/` — the
   same volume as other uploads, so back it up (or deliberately don't, since it's biometric
   data with its own retention policy) and make sure the deployment is served over HTTPS, as
   browsers refuse camera access on an insecure origin. See
   [docs/FACE_VERIFICATION.md](FACE_VERIFICATION.md).

### Why a control plane exists even in this single-org shape

Every request still resolves "which organization" before touching `prisma` — see
`middleware/tenant.ts`. With no subdomain configured, it falls back to `DEFAULT_ORG_SLUG` every
time, which is a no-op in practice: one `Organization` row, one `OrgDatabase` row pointing at
`DATABASE_URL`, so this deployment behaves exactly like it always did pre-multi-tenancy. The
alternative — a special-cased "single-tenant mode" that skips resolution entirely — would mean
maintaining two different code paths through every controller instead of one, for a cost that's
already effectively zero (one extra `Organization`/`OrgDatabase` row lookup per request).

You never need the `/platform-admin` console for this shape — the `PlatformAdminUser` seeded by
`control:seed` exists, but there's only ever the one org to manage, and its plan tier defaults to
`ENTERPRISE` (unlimited seats, full AI budget, all three SSO providers) specifically so a
self-hosted deployment is never artificially capped by plan-tier logic meant for paying SaaS
customers.

---

## Environment profiles — local / UAT / production

One checkout can be pointed at different environments without ever editing `.env` back and
forth. `APP_ENV` selects which profile file configures the API:

| Profile | Command sets | File loaded | Falls back to |
|---|---|---|---|
| local (default) | *(nothing)* | `apps/api/.env` | — |
| UAT | `APP_ENV=uat` | `apps/api/.env.uat` | `.env` for unset keys |
| production | `APP_ENV=production` | `apps/api/.env.production` | `.env` for unset keys |

**Setup, once per profile:** copy the committed template and fill it in — the templates carry
per-environment guidance (why UAT gets its own databases and secrets, why production never uses
`APP_BASE_URL="auto"`):

```bash
cp apps/api/.env.uat.example        apps/api/.env.uat
cp apps/api/.env.production.example apps/api/.env.production
```

Real profile files are git-ignored by pattern (`.env.*` except `*.example`) — credentials can't
land in a commit. Only keys that DIFFER need to be in a profile; everything else falls back to
`.env`, and real shell environment variables still beat both.

**Running each profile:**

```bash
# Linux/macOS (dev server or built app)
npm run dev -w apps/api                      # local
APP_ENV=uat        npm run dev -w apps/api   # UAT
APP_ENV=production npm run dev -w apps/api   # production config, e.g. a config rehearsal
```

```powershell
# Windows PowerShell
npm run dev -w apps/api                                  # local
$env:APP_ENV = "uat";        npm run dev -w apps/api     # UAT
$env:APP_ENV = "production"; npm run dev -w apps/api     # production config
# ($env:APP_ENV lasts for the terminal session — Remove-Item Env:APP_ENV to go back to local)
```

A named profile whose file is missing is a **hard boot failure** naming the fix — an operator
who asked for UAT and silently got local database credentials would be debugging the wrong
universe. The boot log always states which profile loaded.

**Docker deployments are different on purpose:** a Compose stack installed via
`install.sh`/`install.cmd` reads the ROOT `.env` the installer generated on that machine —
each environment is its own machine (or its own checkout) with its own root `.env`, which is
already a complete environment profile. `APP_ENV` matters when running the API process directly
(manual/bare-metal deploys, or pointing a workstation at UAT to reproduce a bug). The web dev
server has its own equivalent if you ever need it: Vite's native modes (`vite --mode uat` loads
`apps/web/.env.uat`).

## Shape 2 — SaaS multi-org

One platform, many organizations, each with a fully separate physical database. New in this
shape: subdomain-based routing, the `/platform-admin` console, and (optionally) automated
provisioning of new organizations from that console.

### One-time platform setup

1. Provision the **control-plane database** (small — org metadata only, never ticket/timesheet
   content) and, if you want in-console provisioning automation, a MySQL server new tenant
   databases will be created on (this can be the same server or a pool of a few known servers —
   see `TENANT_DB_PROVISION_BASE_URL` below).
2. Set env vars (`apps/api/.env` for a single-process deployment, or your orchestrator's secret
   store):
   - `CONTROL_DATABASE_URL` — the control-plane database.
   - `DATABASE_URL` — still required by the Zod schema at boot, but functionally unused once
     more than one org exists; point it at any reachable database (e.g. the control-plane one).
   - `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — shared across every tenant today. Every
     access/refresh token carries an `org` claim cross-checked against the tenant the request
     actually resolved to (`middleware/auth.ts`), so a token minted under one org is rejected if
     replayed against another even though the signing secret is shared — defense-in-depth, not
     the primary isolation boundary (the separate physical databases are).
   - `PLATFORM_ADMIN_JWT_SECRET` — **must differ** from the two above; it signs
     `/platform-admin` tokens, which can administer every organization on the platform.
   - `ENCRYPTION_KEY` — encrypts every org's stored secrets (BYOK AI keys, IMAP passwords, OIDC
     client secrets) at rest, one workspace-wide key.
   - `TENANT_DB_PROVISION_BASE_URL` — a DSN with credentials but **no database name**
     (`mysql://root:***@db-host:3306`) pointing at the server new tenant databases get
     physically created on. Leave unset to provision tenant databases some other way and
     register them directly (see "Provisioning without the automation" below).
   - `APP_BASE_URL` — the ONE fixed callback URL every org's OIDC/SAML redirect uses. Org
     identity travels in a signed `state`/RelayState parameter instead of the callback URL
     itself (see `services/sso.service.ts`), which is what lets every org share one callback
     without registering a distinct redirect URI per org with Google/Microsoft/their SAML IdP.
     This must be a stable, real domain before configuring any org's SSO.
3. Run migrations + seed the control plane (no tenant seed yet — there's no tenant until an org
   is provisioned):
   ```bash
   npm run control:generate -w apps/api
   npm run control:migrate -w apps/api
   npm run control:seed -w apps/api   # seeds PlanTierLimit rows + one PlatformAdminUser
   ```
4. Configure DNS/your reverse proxy so `<any-slug>.yourdomain.com` reaches the same running API
   — `middleware/tenant.ts` resolves the org purely from the `Host` header's subdomain, so no
   per-org DNS entry beyond a wildcard (`*.yourdomain.com`) is needed.
5. Log into `https://yourdomain.com/platform-admin/login` with the seeded credentials printed by
   `control:seed` (`platform-admin@timesphere.local` / `PlatformAdmin@12345` in dev — **rotate
   this immediately in any real deployment**, there's no forced-change flow yet).

### Provisioning a new organization

From the `/platform-admin` console's Organizations page:

1. **New organization** — registers a control-plane row (`PROVISIONING` status) with a name,
   subdomain slug, and plan tier. No physical database yet.
2. **Provision** (shown on any `PROVISIONING` org, requires `TENANT_DB_PROVISION_BASE_URL` to be
   configured) — physically creates the tenant's MySQL database, runs every migration against
   it, seeds baseline roles/settings/ticket-types (no demo data), creates the one real admin
   account you specify, and flips the org `ACTIVE`. Every step here is safe to retry if
   something fails partway through (see `services/provisioning.service.ts`'s header comment).
3. The new org is immediately reachable at `<slug>.yourdomain.com` with the admin account you
   just created.

### Provisioning without the automation

If `TENANT_DB_PROVISION_BASE_URL` is unset (a deliberately supported choice — some deployments
provision tenant databases via a separate ops process, possibly on entirely different servers
per customer for data-residency reasons), provision manually:

1. Create the physical database however your infrastructure requires.
2. `DATABASE_URL=<new tenant dsn> npx prisma migrate deploy --schema=apps/api/prisma/schema.prisma`
3. Seed it: `import { seedTenant } from "./prisma/seed.js"` and call
   `seedTenant(client, { adminEmail, adminName, adminPassword, includeDemoData: false })` against
   a `PrismaClient` pointed at the new DSN (or adapt `scripts/migrate-all-tenants.ts`'s pattern
   into a one-off script).
4. Register it: create the `Organization` row (or use the console's "New organization" step
   above) plus an `OrgDatabase` row with the encrypted DSN
   (`utils/encryption.ts#encryptSecret`), then flip `Organization.status` to `ACTIVE`.

### Keeping every tenant's schema current

A new migration under `apps/api/prisma/migrations/` needs to reach every tenant database, not
just one. After merging a migration:

```bash
npm run migrate:tenants -w apps/api
```

Fans the migration out across every `ACTIVE`/`SUSPENDED` org's own database, skipping any
already on the latest version, isolating one org's failure from the rest (a bad connection or a
hand-edited schema drift on one tenant doesn't block everyone else), and recording the applied
version on `OrgDatabase.schemaVersion` per success. Run this as its own deploy step for the SaaS
shape — it's the multi-org replacement for `docker-compose.yml`'s single `prisma migrate deploy`
command, which only ever migrates one database and is correct only for Shape 1.

### Per-organization configuration

Everything below is already isolated per org by the database-per-tenant model — no extra setup
beyond what's documented elsewhere:

- **SSO** — each org's own admin configures Google/Microsoft/SAML/LDAP from that org's Workspace
  Settings → Single sign-on, independent of every other org. LDAP is a direct bind rather than a
  redirect (the org admin supplies a service-account bind DN/credential this app uses to look up
  and verify end users — see `services/sso.service.ts`'s LDAP section), so it renders as an
  inline username/password form on the login page instead of a "Continue with…" button. Which
  provider TYPES an org is even allowed to turn on is capped by its plan tier
  (`PlanTierLimit.allowedSsoProviders`), editable from `/platform-admin` → Plan tiers.
- **Chat-to-ticket connectors** — Slack, Microsoft Teams, Google Chat, and Telegram all turn
  inbound messages into AI-triaged tickets the same way inbound email does (Workspace Settings →
  Chat integrations), replying back into the originating chat once a ticket's created. Slack/
  Teams/Google Chat are push-only APIs, so each needs a webhook URL (shown in that settings tab)
  registered with the platform's own app/bot console; Telegram is polled instead, same
  no-public-endpoint-needed reasoning as the IMAP worker. Which platforms an org may connect is
  likewise capped by plan tier (`PlanTierLimit.allowedChatPlatforms`).
- **AI, email intake, feature toggles** — every `GlobalAISettings`/`EmailIntakeSettings`/etc. row
  lives in that org's own database, so nothing here needs multi-tenant-specific configuration at
  all — it already only ever affected one org.
- **Seat limits / AI budget ceilings** — enforced live on every user-creation and AI call against
  the org's plan tier (or its own override, settable from `/platform-admin` → Organizations →
  Manage) — see `services/plan-limits.service.ts`.

### Operational notes specific to this shape

- **Connection ceiling**: each tenant database connection pool is capped
  (`PER_TENANT_CONNECTION_LIMIT` in `config/prisma.ts`) and idle clients are evicted after 10
  minutes, with an LRU cap (`MAX_CACHED_CLIENTS`) on how many tenant clients stay warm at once.
  `MAX_CACHED_CLIENTS × PER_TENANT_CONNECTION_LIMIT` must stay comfortably under your MySQL
  server's `max_connections` — this is a known scaling ceiling of the database-per-tenant model,
  not something this phase solved; monitor it as organization count grows.
- **Backups**: back up the control-plane database (small, but losing it means losing the map of
  which tenant database is which) and every tenant database independently.
- **The platform-admin console never loops over tenant content**: the only file in this codebase
  allowed to connect to every tenant database for reporting is
  `services/platform-admin-analytics.service.ts`, and it's restricted by convention to
  aggregate/count queries — seat counts, ticket counts by status, AI spend totals — never
  row-level ticket/comment/timesheet content. That's the concrete, auditable point where this
  app's cross-tenant data-isolation guarantee either holds or doesn't.

---

## Browser and OS support

**Verified by running the suite, not by inspection.** Three engines cover every browser this
product gets asked about, because the browser is not the thing that varies — the engine is:

| Engine | Browsers | How it is covered |
|---|---|---|
| Chromium | Chrome, Edge, Opera, Brave, Vivaldi, Arc | `desktop` + 4 responsive viewport projects |
| Gecko | Firefox | `firefox` project |
| WebKit | Safari on macOS **and every browser on iOS** | `webkit` project |

The last row is the one people get wrong: on iOS, Chrome/Edge/Firefox are all Safari's WebKit
wearing a different icon, because the platform requires it. Testing "Chrome on iPhone" is testing
WebKit.

```bash
npx playwright install firefox webkit    # once
npx playwright test --project=firefox --project=webkit
```

The cross-browser projects run a functional subset (auth, tickets, timesheets, dashboard,
settings, user management) rather than everything. The responsive projects are a *width* question
and pinning them to one engine is what makes a layout difference attributable to the viewport; the
face specs need a camera and a secure context, which is a device question rather than an engine
one.

### Operating systems

The server runs in Docker (Linux) regardless of the host, so **macOS, Windows and Ubuntu differ
only in how you start it** — `install.sh` for macOS/Linux, `install.ps1` for Windows, and CI
builds and typechecks on both Linux and Windows. There is no OS-specific application code. The
client is a browser, so client-side support is the engine table above.

Two host-level notes that have actually bitten:

- **Windows + `prisma generate`** — the running API holds `query_engine-windows.dll.node` open, so
  a regenerate fails with `EPERM`. Stop the API first. Linux and macOS do not care.
- **Line endings** — the repo is authored with LF and git normalises on checkout. Windows editors
  that rewrite files to CRLF produce diffs that look enormous and are not.

### Known limits, stated rather than implied

- **The camera needs HTTPS** on every browser and every OS. See the section below; it is not
  something the application can work around.
- **Hands-free face capture needs WebGL.** Where it is unavailable — locked-down enterprise
  browsers, some VMs — the camera falls back to a manual shutter button and everything still
  works, just with one more click.
- **Copy buttons fall back to a legacy path** on insecure origins and older Safari, and report
  honestly when even that fails rather than claiming success. See `lib/clipboard.ts`.

## Serving over HTTPS (required for the camera, and for Copy buttons)

**The symptom:** the face-verification screen says *"Your browser only allows camera access over
HTTPS, and this page was opened on http://…"*, and Copy buttons do nothing. Almost always on a
phone.

**Why it happens, and why it is invisible in development.** Browsers only expose `getUserMedia`
(camera), `navigator.clipboard`, and service workers in a **secure context**. `localhost` is
exempt — so a laptop opening `http://localhost:5173` has a working camera, and the same build
opened from a phone at `http://192.168.1.20:5173` has no camera at all. Nothing is misconfigured
in the app; the browser is refusing, and every browser refuses. This is not something the
application can work around, and any product that claims to has simply not been tested off
localhost.

Affected features: face enrollment and verification, every **Copy** button (share links, API
tokens, webhook URLs). Everything else works fine over plain HTTP.

### The shipped runbook (do this; the sections after it are the reasoning)

The repo carries everything pre-wired, so standing HTTPS up — on this machine or any future one —
is the same short sequence every time.

**A. LAN / no public domain (dev machine or an on-prem box):**

```bash
# 1. Install mkcert, once per machine:
winget install FiloSottile.mkcert        # Windows (then reopen the terminal)
sudo apt install mkcert libnss3-tools    # Debian/Ubuntu
brew install mkcert nss                  # macOS

# 2. Generate + install the certificate for every address this machine answers on:
powershell -ExecutionPolicy Bypass -File scripts\make-lan-certs.ps1   # Windows
bash scripts/make-lan-certs.sh                                        # Linux/macOS
```

The script drops the pair where **both** entry points already look — `apps/web/certs/` (picked up
automatically by `npm run dev`, which then serves `https://<lan-ip>:5173`) and
`deploy/caddy/certs/` (used by the Docker overlay below). It prints the exact per-device trust
steps for the `rootCA.pem`, and reminds you to point `APP_BASE_URL` at the `https://` address so
emailed links match. Windows note: the first `mkcert -install` pops a security-warning dialog that
needs a human click. Re-run the script whenever the machine's IP changes — the certificate names
addresses, not the machine.

**B. Docker, LAN mode** (after step A on the host):

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
# → https://<lan-ip>   (Caddy serves the mkcert pair; plain http redirects to https)
```

**C. Docker, public domain** (no mkcert, no device trust — real certificates, automatic renewal):

```bash
# In the .env next to docker-compose.yml:
#   HTTPS_DOMAIN=timesphere.yourcompany.com
#   CADDYFILE=Caddyfile.domain
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d
# → https://timesphere.yourcompany.com  (Let's Encrypt; needs DNS → this box and ports 80/443 open)
```

In every mode, set `APP_BASE_URL` (and add the https origin to `WEB_ORIGIN` for production) to the
address people actually open. On an internet-exposed host, also restrict the base compose file's
plain-http ports (`5173`, `4000`) to localhost in an override so TLS is the only way in.

### Production, with a public domain — use a reverse proxy

The Compose stack does not terminate TLS itself, on purpose: certificate management belongs to
whatever already runs in front of it. Caddy is the least work because it obtains and renews
Let's Encrypt certificates with no extra configuration:

```caddy
# Caddyfile — put this in front of the Compose stack
timesheet.example.com {
    reverse_proxy localhost:5173     # the web container
    handle_path /api/* {
        reverse_proxy localhost:4000 # the API container
    }
}
```

nginx equivalent, if you already run one, terminating TLS with certbot-issued certs and proxying
the same two upstreams. **Whichever you use, forward `X-Forwarded-Proto`** — the API reads it to
build absolute URLs for share links and email, and without it those links come out as `http://`
and land users right back in the insecure context.

On Kubernetes there is nothing to add: set `ingress.host` and `ingress.tls` in the Helm chart and
let cert-manager or your cloud's managed certificate handle issuance (see *Kubernetes deployment*).

### On-prem with no public domain — a private CA

Let's Encrypt cannot issue for `192.168.x.x` or an internal hostname, so the options are a
self-signed certificate or an internal CA. Self-signed works, but **every phone that will use the
camera has to trust the certificate**, or the browser blocks the page before the camera question
even arises. `mkcert` makes this tolerable:

```bash
mkcert -install                          # creates a local CA
mkcert timesheet.internal 192.168.1.20   # cert for the name AND the IP people actually type
```

Point the reverse proxy at the generated pair, then install the `mkcert -CAROOT` root certificate
on each device (iOS additionally requires enabling it under *Settings → General → About →
Certificate Trust Settings*, which is the step people miss). If that is more device management
than you want, giving the server a real hostname and a real certificate is genuinely less work in
the long run.

### Just testing on a phone for ten minutes

A tunnel gives you a trusted HTTPS URL without touching any configuration:

```bash
cloudflared tunnel --url http://localhost:5173
# or: ngrok http 5173
```

Open the printed `https://…` address on the phone. Fine for a demo or for checking the camera
flow; not a deployment.

### What NOT to do

- **Do not use Chrome's `--unsafely-treat-insecure-origin-as-secure` flag for anything real.** It
  is per-device and per-browser, it disables a security boundary for that origin, and it silently
  stops working after a browser update or profile reset — at which point the camera "breaks" for
  one person with no explanation anybody can find.
- **Do not conclude the camera is broken because it works on your laptop.** It will always work on
  `localhost`. Test from a phone on the real address before deciding anything.

## CI/CD

`.github/workflows/ci.yml` runs on every push/PR: typecheck + build both packages, then (on
`ubuntu-latest`, since GitHub Actions' `services:` containers only run on Linux runners) spins up
a real MySQL service container, migrates + seeds both schemas, and runs the full Playwright
suite. A separate `windows-latest` job typechecks + builds only (no MySQL service available
there) — this codebase is developed on Windows day-to-day (see this doc's own history), so that
job exists to catch anything that happens to build on Linux but not Windows. Two more jobs
syntax-check `install.sh` (`bash -n`, on Linux) and `install.ps1` (the PowerShell parser, on
Windows) without executing either.

`.github/workflows/cd.yml` builds and pushes `apps/api`/`apps/web`'s Docker images to GHCR
(`ghcr.io/<owner>/<repo>-api` / `-web`) on every push to `main` and on version tags, using the
repo's own `GITHUB_TOKEN` — no external registry account needed to get started. Swap to another
registry (ECR/GCR/ACR/Docker Hub) by changing `cd.yml`'s `env.REGISTRY` and its login step's
credentials; nothing else in the workflow assumes GHCR specifically.

No repo secrets are required for either workflow as written — `cd.yml`'s GHCR push uses the
automatically-provided `GITHUB_TOKEN`, and `ci.yml`'s test secrets are fixed placeholder strings
scoped to the ephemeral CI database, never real credentials.

## Updating a running deployment

**Compose shape (installed via install.sh / install.ps1):** one command —

```bash
./update.sh              # newest release   (Windows: .\update.cmd)
./update.sh --to v1.2.3  # specific release (Windows: .\update.cmd -To v1.2.3)
```

What it does, in order: dumps both databases to `./backups/` (external-DB deployments are asked
to confirm their own snapshot instead — the script can't reach into your RDS), records the
current git ref, checks out the release tag, rebuilds and restarts (migrations run on container
boot as always), then runs the same verification suite the installer uses — health, the server
reporting the *target* version, both schemas fully migrated, a login round-trip. **If
verification fails it automatically rolls the code back to the previous ref and re-verifies**,
so a failed update ends with the old version running, not the new one broken. The database dump
is kept but never auto-restored: migrations are additive-only (docs/DATABASE.md), so old code on
a newer schema is safe by policy, and restoring a dump over a live database is a human decision.

Everyone with the app open when the server comes back is offered a refresh automatically — the
version rides on the health poll the client already makes, and the **What's new** page
(`/app/whats-new`) shows admins the release notes and this command whenever a newer GitHub
release exists (checked hourly; disable with `UPDATE_CHECK=off`).

**Kubernetes shape:** don't use update.sh — the platform already owns this dance:

```bash
helm upgrade timesphere deploy/helm/timesphere --reuse-values --set image.tag=v1.2.0
kubectl rollout status deploy/timesphere-api     # and `helm rollback timesphere` to go back
```

## Kubernetes deployment

`deploy/helm/timesphere/` is a Helm chart covering both deployment shapes — the same "one
codebase, two shapes" split as the rest of this doc, just expressed as chart values instead of
separate compose files:

- **Shape 1-equivalent**: `mysql.enabled: true` (the chart's own single-replica MySQL
  StatefulSet), one `ingress.host`, `env.defaultOrgSlug` doing the same fallback resolution it
  does everywhere else.
- **Shape 2-equivalent**: `mysql.enabled: false` pointing at a managed MySQL instance instead
  (strongly recommended for real multi-org SaaS — see the chart's `values.yaml` comment), plus
  `ingress.wildcardHost` for subdomain-per-org routing.

### Installing

1. Create the app's Secret yourself — **not** something `helm install` does, deliberately, so
   long-lived credentials never end up in a `helm history`/`helm get values` snapshot. Copy
   `deploy/helm/timesphere/secrets.example.yaml`, fill in real values (same generation commands
   as everywhere else in this doc — `openssl rand -base64 48` / `openssl rand -hex 32`), and
   `kubectl apply -f` it. A real production cluster should use an actual secret manager
   (sealed-secrets, External Secrets Operator, Vault) instead of a plain Secret, but the example
   file is the fastest path to a working first deployment.
2. `helm install my-release deploy/helm/timesphere -f my-values.yaml` (point `image.repository`
   at wherever `cd.yml` published your images, and set `ingress.host`/`ingress.tls` for your real
   domain).
3. A `pre-install,pre-upgrade` Helm hook Job runs `prisma migrate deploy` against both schemas
   before the API rolls out — the Kubernetes equivalent of `docker-compose.yml`'s inline
   migrate-then-start command, just as its own short-lived Job instead of baked into every
   container's startup. **One first-install caveat with `mysql.enabled: true`**: Helm runs
   pre-install hooks *before* creating the chart's own non-hook resources, so on a genuinely
   first install the MySQL pod this Job waits for doesn't exist yet and the Job will fail (see
   its own annotation for the full explanation) — run `helm upgrade` once MySQL's pod is `Ready`
   and its `pre-upgrade` hook will find a real database to migrate. Deployments against an
   already-running external MySQL (`mysql.enabled: false`) never hit this, since the database
   already exists before you ever run `helm install`.
4. Run the one-time seed the same way `install.sh`/`install.ps1` do for Compose (not something
   the chart runs automatically, for the same "not idempotent the way migrations are" reason):
   ```bash
   kubectl exec deploy/my-release-timesphere-api -- npm run control:seed -w apps/api
   kubectl exec deploy/my-release-timesphere-api -- npm run seed -w apps/api
   ```

### Autoscaling

This is the one place real autoscaling exists in this project — `docker-compose.yml` has no
orchestrator to react to load with (`docker compose up --scale api=N` is its one manual lever).
The chart's `api.autoscaling`/`web.autoscaling` values each drive a `HorizontalPodAutoscaler`
(on by default: CPU + memory utilization targets, configurable min/max replicas). A
`VerticalPodAutoscaler` is also templated (`api.verticalAutoscaling`) but off by default, since
it needs the VPA CRDs installed (`kubectl get crd verticalpodautoscalers.autoscaling.k8s.io`)
and not every cluster has them — and running HPA + VPA against the same CPU metric on one
workload can fight itself, so read the chart's comment before turning both on together.

### Verifying the chart without a live cluster

```bash
helm lint deploy/helm/timesphere
helm template my-release deploy/helm/timesphere            # default values
helm template my-release deploy/helm/timesphere --set mysql.enabled=false --set api.verticalAutoscaling.enabled=true
```

Both commands need no cluster access at all — useful for CI or a quick sanity check before an
actual `helm install`/`helm upgrade`.

## Cloud provider notes (AWS / GCP / on-prem)

Nothing in this codebase is cloud-specific — both the Docker Compose shape and the Helm chart
above are the actual deployment artifacts; "AWS" or "GCP" just means *where* those run and which
managed services back MySQL/ingress/secrets. There is no provider-specific code path to maintain.

| Concern | On-prem / bare metal | AWS | Google Cloud |
|---|---|---|---|
| Compute | `docker compose up` (Shape 1) directly on a VM, or your own Kubernetes | EKS + this Helm chart, or ECS Fargate with the same two container images | GKE + this Helm chart, or Cloud Run (one service per image; see caveat below) |
| Database | MySQL/MariaDB you already run (XAMPP for dev, a real MySQL server for prod) | RDS for MySQL / Aurora MySQL — set `mysql.enabled: false` in the chart, point `DATABASE_URL`/`CONTROL_DATABASE_URL` at the RDS endpoint | Cloud SQL for MySQL — same `mysql.enabled: false` pattern, point at the Cloud SQL connection string (via the Cloud SQL Auth Proxy sidecar, or a private IP) |
| Container registry | N/A (build locally) or a self-hosted registry | ECR — change `cd.yml`'s `env.REGISTRY` and login step to `aws-actions/amazon-ecr-login` | Artifact Registry — change `cd.yml`'s `env.REGISTRY` and login step to `google-github-actions/auth` + `docker login` against `*-docker.pkg.dev` |
| Secrets | `.env` file (Compose) / `secrets.example.yaml` → `kubectl apply` (K8s) | AWS Secrets Manager or SSM Parameter Store, synced into the cluster via External Secrets Operator, or injected as ECS task-definition secrets | Google Secret Manager, synced the same way via External Secrets Operator, or mounted directly in Cloud Run |
| Ingress/TLS | your own reverse proxy (nginx/Caddy) in front of Compose, or an ingress controller in K8s | ALB Ingress Controller (or the chart's own `ingress.*` values against any ingress controller you run on EKS) + ACM for TLS | GKE Ingress (or the same chart `ingress.*` values) + Google-managed certificates |
| Autoscaling | manual (`docker compose up --scale api=N`) | the chart's HPA (works identically on EKS — it's just Kubernetes) | same — HPA is portable, not GCP-specific |
| CI/CD | `.github/workflows/ci.yml` unchanged | same, `cd.yml` pushes to ECR instead of GHCR | same, `cd.yml` pushes to Artifact Registry instead of GHCR |

**Cloud Run caveat**: Cloud Run (and Fargate, similarly) works for the stateless `web` and `api`
images, but this app runs its own migration step (`prisma migrate deploy`) and one-time seed as
separate commands, not baked into request-serving startup — on Cloud Run/Fargate, run those as a
one-off Job/task (Cloud Run Jobs, or an ECS `RunTask` with the same image and `npm run` command)
before pointing traffic at a new revision, the same role the Helm chart's `pre-install` hook Job
plays on Kubernetes.

**Worker/background processing**: there is currently no separate worker process — scheduled jobs
(daily reminder emails, deadline reminders, SLA escalation sweeps, inbound-email polling,
Telegram polling, the AI weekly digest, the face lifecycle sweep — retention purge, downgrade
grace/purge, enrollment reminders, overdue-review nudges — and the weekly identity digest) run
as in-process `node-cron` schedules inside the `api`
container/pod itself (see `apps/api/src/workers/*.worker.ts`). This means **exactly one replica
of `api` should run the cron
schedules** in a horizontally-scaled deployment, or jobs fire once per replica — set
`api.replicaCount: 1` (Compose: don't `--scale api=N`) if you scale beyond one instance, or gate
the cron registration behind a leader-election/singleton lock if you need both HA and >1 replica
(not implemented today — see [docs/ROADMAP.md](ROADMAP.md) for the relevant epic if you need this
split into a dedicated worker process/pod).

## Sizing (measured, not guessed)

Baseline numbers, measured on a laptop-class CPU with the real face models over 40 consecutive
inferences: ~150ms median per verification frame, ~6/sec serial throughput per worker, models
holding ~350MB steady / ~650MB peak RSS once loaded. Cloud vCPUs are typically slower — budget
300–500ms per frame. Face demand is human-paced and bursty (one submission per user per day is
one check), so **CPU is essentially never the constraint; memory is**: the models load lazily
*per process* and stay resident, so every API process that ever serves a face request
permanently holds ~500MB. That is what drives the tiers below.

| Tier | Users | Shape | Notes |
|---|---|---|---|
| Pilot | < 25 | One VM, 2 vCPU / 4 GB — app + MySQL via Compose | Face verification is why 4 GB rather than 2. Single point of failure, accepted. |
| Small | ≤ 100 | App 2 vCPU / 8 GB + managed MySQL 2 vCPU / 4 GB | Splitting the DB off buys real backups/PITR and restarts that don't take the data with them. |
| Mid | ≤ 1,000 | 2× app (4 vCPU / 8 GB) behind an LB, managed MySQL 4 vCPU / 16 GB, **shared volume for `UPLOAD_DIR`**, Redis for sessions | The shared volume is not optional with >1 app node — an image written by node A is otherwise a 404 from node B. Remember the single-cron-replica rule above. |
| Large | 5,000+ | 4+ app nodes without face traffic + a separate 2-node pool serving `/api/face/*`, MySQL 8 vCPU / 32 GB + replica, S3-compatible object storage | Keeps the general API lean instead of every worker carrying 500MB of models, and a burst of captures can't starve ordinary requests. Not implemented as config today — it's an ingress-routing split. |

Face image storage is cheap enough to ignore: each stored capture is a ~50KB JPEG, so
`users × submissions/day × retentionDays × 50KB` — 200 users at 30-day retention is ~300MB.
Setting `imageRetentionDays: 0` stores templates only. **No GPU** — at these latencies against
human-paced demand it solves nothing, and it would reintroduce the native compiled dependency
the wasm build deliberately avoids.

## Environment variable reference

See `.env.example` for the full list with inline comments. The multi-tenancy-specific ones,
summarized:

| Variable | Required for | Purpose |
|---|---|---|
| `CONTROL_DATABASE_URL` | Both shapes | The control-plane database (org registry, SSO config, plan tiers, platform-admin accounts) |
| `DEFAULT_ORG_SLUG` | Both shapes | Which org a request with no real subdomain resolves to (default: `default`) |
| `PLATFORM_ADMIN_JWT_SECRET` | Both shapes | Signs `/platform-admin` tokens — must differ from `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` |
| `TENANT_DB_PROVISION_BASE_URL` | SaaS shape, only if using in-console provisioning | The MySQL server new tenant databases get created on |
| `APP_BASE_URL` | Both shapes | Also doubles as the one fixed OIDC/SAML callback URL for every org's SSO |

## Testing before you ship a change

```bash
npm run lint                # typecheck both packages
npm run build               # build both packages
npm run test:e2e            # full Playwright suite
```

The Playwright suite runs entirely against Shape 1 (one `DEFAULT_ORG_SLUG` org) — it doesn't
exercise subdomain routing or a second tenant. Multi-org-specific behavior (isolation, SSO
routing, provisioning) is verified via direct API checks against real second/third
organizations during development, not by the automated suite yet.
