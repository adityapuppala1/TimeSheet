# Installation Guide

A complete, step-by-step path from "nothing installed" to a running TimeSphere instance — the
one-click Docker install and the manual local install (no Docker); Kubernetes lives in
[docs/DEPLOYMENT.md § Kubernetes](DEPLOYMENT.md#kubernetes-deployment). This file is also the one
place for the prerequisites, the demo credentials, self-diagnosis (`npm run doctor`), handling
`ENCRYPTION_KEY` and the other secrets, configuring things after install without editing code
(including turning on AI), the FAQ, and troubleshooting.

For architecture/deployment-shape background (on-prem vs. multi-org SaaS), see
[docs/DEPLOYMENT.md](DEPLOYMENT.md). This guide is the "how do I actually get it running"
companion to that document.

## Choose your path

| You want... | Use |
|---|---|
| The fastest way to try it, nothing but Docker installed | [One-click install](#one-click-install-recommended) |
| Full control, no Docker, developing/debugging the app itself | [Manual local install](#manual-local-install-no-docker) |
| Production Kubernetes with autoscaling | [docs/DEPLOYMENT.md § Kubernetes](DEPLOYMENT.md#kubernetes-deployment) |
| Multi-org SaaS (more than one company on one deployment) | [docs/DEPLOYMENT.md § Shape 2](DEPLOYMENT.md#shape-2--saas-multi-org) after either path above |
| Something failed and you have an error message | [Troubleshooting](#troubleshooting) |

---

## One-click install (recommended)

### Prerequisites by OS

| OS | What you need first |
|---|---|
| **Windows** | [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/) (or `winget install Docker.DockerDesktop`), PowerShell 5.1+ (built in) |
| **macOS** | [Docker Desktop for Mac](https://docs.docker.com/desktop/install/mac-install/) (or `brew install --cask docker`), bash (built in) |
| **Linux (Debian/Ubuntu)** | `curl -fsSL https://get.docker.com \| sh`, then `sudo usermod -aG docker $USER` and log out/in |
| **Linux (Fedora/RHEL/CentOS)** | `sudo dnf install -y docker docker-compose-plugin` |

The installer **detects your OS** and, if Docker is missing, prints the exact install command for
your OS and **offers to run it for you** (`apt`/`dnf`/`brew` on Linux/macOS via `get.docker.com`
or your package manager, `winget` on Windows) — always behind an explicit `[y/N]` prompt, never
silently. Say no and it just prints the command instead, so you stay in control of what touches
your machine outside this repo either way.

### Run it

```bash
# macOS / Linux — from a normal terminal, in the repo root
chmod +x install.sh   # only needed once, if the file isn't already executable
./install.sh
```

```powershell
# Windows — from an ordinary PowerShell prompt (Start menu → "Windows PowerShell"), in the repo root
.\install.cmd
```

Either script is interactive (it'll prompt you for a couple of values — see step 3 below) and
takes a few minutes on first run while Docker pulls/builds images. Let it run to completion
rather than closing the terminal partway through.

### Common errors when running the installer

These are the actual failure modes you're likely to hit, in the order you'd hit them:

| Error | Cause | Fix |
|---|---|---|
| PowerShell: `install.ps1 cannot be loaded because running scripts is disabled on this system` | Windows' default script execution policy (`Restricted`) blocks any local `.ps1` file, signed or not — this is a Windows default, not something specific to this repo. | Run the shipped launcher instead: `.\install.cmd` / `.\update.cmd` — a batch file isn't subject to the policy and starts the script with a process-scoped bypass (nothing machine-wide changes). Alternatives: `powershell -ExecutionPolicy Bypass -File .\install.ps1` once, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` in an admin PowerShell. |
| PowerShell: `install.ps1 is not digitally signed` / a red "cannot be loaded" wall of text mentioning a security warning | Same execution-policy family of error as above, sometimes phrased differently depending on Windows version/policy. | Same fix as above. |
| PowerShell: `Missing closing '}' in statement block or type definition` / `The string is missing the terminator: "` when you've done nothing but run `.\install.ps1` | A real bug, fixed 2026-07-29: `install.ps1` contains non-ASCII characters (em-dashes) and previously had no UTF-8 byte-order mark. Windows PowerShell 5.1 — the OS-bundled `powershell.exe`, not PowerShell 7's `pwsh` — defaults to the system codepage instead of UTF-8 for a BOM-less script file, which corrupted string parsing. This is fixed at the file level (a UTF-8 BOM was added) and CI now validates `install.ps1` under both `pwsh` and Windows PowerShell 5.1 so this class of bug can't silently return. | `git pull` to get the fixed file. If you're still hitting this on a version after 2026-07-29, please report it — it means the fix regressed. |
| bash: `install.sh: line 2: $'\r': command not found`, or `bad interpreter: /bin/bash^M` | The file has Windows-style CRLF line endings instead of Unix LF — happens if you cloned with `git config core.autocrlf true` (Git for Windows' own suggested default) before this repo's `.gitattributes` (which forces `install.sh` to always check out as LF) existed in your local copy. | `git pull` to get the current `.gitattributes`, then re-checkout the file: `git rm --cached install.sh && git checkout install.sh`. Or, one-off: `sed -i 's/\r$//' install.sh` (Git Bash/WSL) before running it. |
| bash: `install.sh: Permission denied` | The executable bit is missing. It IS set in git (mode `100755`, since 2026-08-18 — before that a fresh clone hit this too), so a `git clone` is fine. A **ZIP download** from GitHub is not: the zip format GitHub serves does not carry Unix permissions, so every file arrives non-executable. | `chmod +x install.sh`, then `./install.sh` again. Or clone instead of downloading the zip. |
| `Couldn't run 'docker compose'` / `Cannot connect to the Docker daemon` | By far the most common one: **Docker Desktop is installed but not actually running.** Being installed and being started are different things. | Start Docker Desktop from the Start menu / Applications folder and wait until it says "Docker Desktop is running" (the whale icon stops animating), then re-run the installer. |
| Docker Desktop itself refuses to start, mentioning WSL 2 or virtualization | Docker Desktop's own prerequisites aren't met — WSL 2 not installed, or virtualization disabled in BIOS/UEFI. | Follow Docker Desktop's own on-screen fix link, or see [Docker's WSL 2 backend docs](https://docs.docker.com/desktop/wsl/). This is a Docker Desktop prerequisite, not something this installer can work around. |
| `Port 3307/4000/5173 looks already in use` | Something else on your machine is already bound to a port this stack needs. Note: this is **3307**, not MySQL's usual 3306 — docker-compose.yml deliberately uses 3307 on purpose specifically so it never collides with a local/XAMPP MySQL you might already have running on 3306, so seeing an XAMPP MySQL on 3306 is not itself a conflict. | Check what's actually on that port (`docker compose ps` first, in case it's an old TimeSphere stack you forgot about) — stop it, or edit the port mapping in `docker-compose.yml`. |
| API container never becomes healthy / installer says "Still not healthy" after the restart attempt | Usually either a slow first pull of the `mysql:8.4` image on a slow connection, or a real error in the API's boot sequence. | `docker compose logs api` shows the actual error. If you see nothing but a long pull progress bar, just wait — first run legitimately takes a few minutes. |
| Seeding fails all 3 attempts | Either a real problem (check `docker compose logs api`), or — if you're re-running the installer against an already-set-up deployment — this is often just "already seeded," which is expected and harmless (seeding is an upsert, not an insert). | Re-run manually to see the real error: `docker compose exec api npm run control:seed -w apps/api` then `docker compose exec api npm run seed -w apps/api`. |
| Windows: `npm install`/Docker build fails with `EPERM: operation not permitted` on a file inside `node_modules` | Windows Defender (or another antivirus) has a file open/locked mid-write — a real, if intermittent, Windows-specific flake, not a bug in this repo. | Re-run the failed command — it usually succeeds on retry once the AV scan finishes. If it keeps happening, add this repo's folder to your antivirus's exclusion list. |
| `npm run setup` fails at the doctor step with `nothing is listening on <garbage>@localhost:3306` — where `<garbage>` is part of your password | A real bug, fixed 2026-07-29: the doctor parsed the DSN by grabbing the **first** `@`, so a MySQL password containing `@` (e.g. `Hics@161233`) made it read the host as `161233@localhost`. Prisma itself always handled this correctly (it splits at the last `@`), so the `.env` was fine — only the pre-flight check was wrong, and it false-failed before the real connection was ever attempted. | `git pull` to get the fixed doctor. The parser now matches Prisma's own semantics and prints the host/port/database it resolved, so this can't be silently misread again. |
| `npm run setup` fails at the doctor step and you're not sure where MySQL actually is | Different machines put MySQL in different places — XAMPP on 3306, this repo's Docker Compose on 3307, a second local instance on 3308. | Just run `npm run doctor -w apps/api`. It scans 3306/3307/3308/3309, identifies each real MySQL by its handshake (with version), and tells you exactly which port to use — or, if nothing's running, what's installed on the machine and the command to start it. `npm run doctor:fix-env -w apps/api` applies the port correction to `.env` for you. |

### What happens, step by step

1. **Dependency check** — confirms Docker + the Compose plugin are present; offers to
   auto-install Docker for you (see above) if not, or prints the OS-specific command.
2. **Port check (auto-heal)** — warns if ports `4000`/`5173`/`3307` already look bound to
   something else on this machine, before Compose gets a chance to bind-fail on them deep in its
   own logs. 3307, not MySQL's usual 3306 — see the port-conflict row in the table above for why.
3. **`.env` handling** (human-in-the-loop, security-relevant): 
   - If `.env` doesn't exist yet, you're prompted for four values (web URL, API URL — both
     default to `localhost` for a trial run — the **workspace root domain**, and the
     **reverse-proxy hop count**, both below)
     and then, **optionally**, your outbound SMTP
     details (host/port/user/password/TLS) — type `N` to skip and configure email later from
     the UI. The password prompt hides your input as you type. Every other secret (DB
     password, JWT signing keys, encryption key) is generated for you with cryptographically
     strong randomness — you never have to think about them.
   - **The workspace root domain (`ROOT_DOMAIN`) is asked because the wrong answer returns 404
     for every request, including the login page.** The API works out which workspace a request is
     for from the `Host` header; with `ROOT_DOMAIN` empty it does that by reading the **first DNS
     label**. That is right for `acme.example.com` and fatal for `timesheet.company.com`, which
     looks for a workspace called `timesheet`, finds none, and refuses everything — with nothing in
     the log, because as far as the router is concerned it was asked for a workspace that does not
     exist. So this is not only the multi-customer switch: a **single**-workspace install on a
     three-label hostname needs it too. Leave it blank for `localhost`, a bare IP, or a two-label
     domain like `example.com`. The installer reads your API URL and offers the right value, and the
     API prints a startup `ERROR` naming it if the two disagree. Setting it also means workspace
     subdomains need a wildcard DNS record, a certificate covering the wildcard, and a proxy that
     passes `Host` through unchanged — see
     [DEPLOYMENT.md § The Host header has to survive every hop](DEPLOYMENT.md#the-host-header-has-to-survive-every-hop).
   - **The proxy hop count (`TRUST_PROXY_HOPS`) defaults to `1`, and that is deliberate.** The
     `web` container's nginx proxies `/api` to the `api` container, so every browser request
     already crosses one proxy. Left at `0`, the API records nginx's address as the client IP for
     *everyone* and the 20/min login limiter becomes one shared global bucket — silently, with no
     error and no log line. Answer `2` if you also run `docker-compose.https.yml` (Caddy in front
     of that nginx), and add one more for anything else in front such as Cloudflare. Full
     reasoning — including why it is a hop *count* rather than a boolean —
     is in [docs/DEPLOYMENT.md § Reverse proxies](DEPLOYMENT.md#reverse-proxies-and-client-ip-attribution-trust_proxy_hops).
   - If `.env` already exists, the installer runs a **self-heal check**: it verifies every
     required key is present (catches a stale `.env` from before a feature that added a new
     required variable) and fails with a clear list of exactly what's missing, rather than
     letting Docker Compose fail opaquely three steps later. It also warns — without failing —
     when `TRUST_PROXY_HOPS` is absent, since that one has a default and so would otherwise start
     up perfectly while attributing every request to the proxy. Existing values are never
     modified — re-running the installer against an already-configured deployment is always
     safe.
4. **Build + start** — `docker compose up -d --build`. First run pulls the MySQL 8.4 image and
   builds both app images; this is the slow step (a few minutes).
5. **Health check with auto-heal** — polls `http://localhost:4000/health` for up to 3 minutes.
   If it's still not healthy, the installer prints `docker compose ps`, then runs
   `docker compose restart api` and polls again for another 90 seconds — a container that
   crashed on a transient migration lock or a not-yet-ready MySQL container usually recovers on
   its own with a restart, so this catches the single most common first-run flake automatically.
6. **Seed with retry (auto-heal)** — creates roles/permissions, the control-plane plan tiers, the
   default org, and a platform-admin account. Retries up to 3 times with a 5s backoff — a fresh
   MySQL container can still be finishing init-file replay for a few seconds after `/health`
   reports ready (TCP-reachable isn't the same as fully migrated). Safe to re-run either way
   (upserts, not inserts).
7. **Prints URLs + default credentials** for the web app and the platform-admin console.

### After it's up

- Web app: the URL you entered (default `http://localhost:5173`)
- Sign in with the seeded accounts — all four are in [§ Demo credentials](#demo-credentials), and
  the installer prints the same ones. The platform-admin console is at
  `<web-url>/platform-admin/login`; change its password before anything else.
- **Configure real SMTP** (if you skipped it above) from **Workspace Settings → Mail server** —
  see [§ Configuring things after install](#configuring-things-after-install).
- **Nothing AI-facing is listening yet.** The MCP server (`POST /api/mcp`, new in 2.3.0) ships
  switched off, with its write tools off individually — a fresh install has no MCP endpoint at all
  until a super admin enables it in **Workspace Settings → MCP server** and issues a credential.
  What that decision actually grants is spelled out in
  [docs/DEPLOYMENT.md § Operating the MCP server](DEPLOYMENT.md#operating-the-mcp-server).

---

## What the installer detects and proves

The one-click scripts are environment-aware and end with evidence, not hope:

- **Kubernetes**: if `kubectl` reaches a cluster and `helm` is present, install.sh offers the
  Helm chart path (generating a secrets file from the template) instead of a local compose stack
  — offered, never assumed, because kubectl on a laptop often points at production.
- **Your own MySQL**: choosing an external server triggers a **preflight** before any container
  starts — connect, `CREATE DATABASE IF NOT EXISTS` both schemas, and on failure print the exact
  `GRANT` statements needed. A restricted RDS account fails in seconds with instructions, not
  minutes later as an opaque P1003 in container logs.
- **Verification suite**: after seeding, the installer proves the deployment layer by layer —
  API health, the server reporting exactly the checkout's `VERSION`, both schemas at the latest
  migration, the seeded platform-admin actually able to log in, and the SPA being served. Any
  failure prints `[FAIL]`, exits non-zero, and points at the logs. "Installed" means proven.
- **Self-healing** (`scripts/installer-heal.sh` / `.ps1`, shared by install and update): waits up
  to 2 minutes for the Docker engine (Docker Desktop answers `docker compose version` before it is
  ready), refuses below 2 GB free disk and warns below 5 GB, retries a failed build twice (the last
  time `--pull --no-cache`), and - when the checkout sits on an OLDER release tag with no local
  changes - offers the newest release and re-runs the new installer. A branch is never switched.
- **Update = upgrade or repair**: `./update.sh` installs the newest release with backup, verify and
  automatic rollback; when there is nothing newer it verifies the running install instead and
  repairs it (start containers, recover a stranded migration, restart the API).
- **Non-interactive mode**: `TS_AUTO=1 ./install.sh` (or `$env:TS_AUTO="1"` on Windows) accepts
  every default — bundled Docker MySQL, localhost URLs, no SMTP. CI executes exactly this on
  every PR, so installer rot is caught in review rather than by a customer.

Updating later is one command — see
[docs/DEPLOYMENT.md § Updating a running deployment](DEPLOYMENT.md#updating-a-running-deployment),
which also carries the version-specific upgrade notes (what each release's migrations and new
variables need).

## Manual local install (no Docker)

The path for developing or debugging the app itself, or for a machine that won't run Docker. You
provide what Docker Compose would have (MySQL, and the secrets in `.env`); everything else is one
command.

### Prerequisites

- **Node.js 20.19+ or 22.12+** — the floor Vite 8 sets. **Node 24 (the active LTS) is recommended**:
  CI and both Docker images run it since 2026-10-05, and local development has run on it since 2026-10.
- **A running MySQL 8 server reachable from your machine.** XAMPP's bundled server works fine (it
  is MariaDB under the hood): a default install listens on `localhost:3306` with user `root` and
  an **empty password**. Any other MySQL server works too — see
  [docs/DEPLOYMENT.md § Bringing your own MySQL server](DEPLOYMENT.md#bringing-your-own-mysql-server).
- *Optional, only if you want AI features live:* an API key for whichever provider you choose
  (Anthropic, OpenAI, Groq, etc.), a local Ollama/LM Studio install with no key at all, or nothing
  whatsoever — the native runtime downloads and runs a model on this server's own CPUs. See
  [§ Turning on AI features (BYOK)](#turning-on-ai-features-byok).
- *Optional, only if you want email-to-ticket intake live:* IMAP access to a mailbox (an app
  password works fine, same pattern as SMTP).
- *Optional, only if you want HTTPS on the LAN* (the camera on other devices needs it):
  [mkcert](https://github.com/FiloSottile/mkcert) — step 10 below.

### One command

**From a clean clone** — start MySQL first, then:

```bash
npm run setup
npm run dev
```

`setup` is `npm install && npm run bootstrap && npm run db:generate && npm run doctor:heal &&
npm run seed && npm run db:migrate:tenants`, which covers, in order: dependencies (`postinstall`
builds `packages/shared`); `apps/api/.env` created from `.env.example` if it doesn't exist, plus a
dev TLS certificate if this machine has none; Prisma clients generated for **both** schemas (tenant
and control-plane); `.env` validated, both databases created if missing, and every pending
migration applied to each; then roles/permissions/demo data and the control-plane plan tiers
seeded; and finally the **tenant fan-out**, which walks the control-plane org registry and brings
every organization's own database to the newest migration. **Every step is idempotent** —
re-running `setup` on an existing install regenerates nothing it would overwrite.

The fan-out is last because it needs the control-plane schema *and* its seeded org registry to
exist first. On a clean clone it finds exactly one organization, already migrated, and is a fast
no-op — which is precisely why it is safe to run unconditionally. It earns its place on a checkout
where you have since provisioned a second organization from `/platform-admin`: that org has its own
physical database, which `DATABASE_URL` never names, and running new code against its old schema is
the one drift the additive-only migration policy cannot excuse. `doctor:heal` attempts the same
fan-out (since 2026-08-26), but only as a warning — one unreachable tenant must not block healing
the database `npm run dev` needs — so this last step is the one that fails loudly when an
organization can't be brought current. Same command, same reasoning as `update.sh` on a deployed
stack — see
[docs/DEPLOYMENT.md § Keeping every tenant's schema current](DEPLOYMENT.md#keeping-every-tenants-schema-current).

Two things it deliberately does *not* do. It never overwrites an `apps/api/.env` you already have,
and it never regenerates a certificate you have already trusted on your devices — both would
destroy something you cannot get back. What it does instead, on an *upgrade*, is **list any
variable that has been added to `.env.example` since your `.env` was written**, so a new feature
looks unconfigured rather than broken. Append them (commented out) with `npm run bootstrap:sync`.

**On a clean clone the first `setup` stops at `doctor:heal`, by design.** `bootstrap` has just
copied `.env.example`, whose `ENCRYPTION_KEY` is a deliberately invalid placeholder (see
[§ Secrets](#secrets-encryption_key-and-per-environment-env-files)) — and if this machine's MySQL
isn't XAMPP's default, its `DATABASE_URL` is wrong too. The doctor names whichever it hit first
(see [§ Self-diagnosis](#self-diagnosis-npm-run-doctor) below). Fill in `apps/api/.env` as step 2
below describes and re-run `npm run setup`; it picks up where it left off.

### Step by step

The same thing one command at a time, in `setup`'s order — if you'd rather run each yourself or
see what's happening:

1. **Install dependencies.** `postinstall` also builds `packages/shared`, which both the API and
   the web app import at runtime.

   ```bash
   npm install
   ```

2. **Create and fill in `apps/api/.env`.** The API loads `.env` from its own working directory
   (`apps/api/`), not the repo root — a root `.env` belongs to the Docker Compose shape, and the
   manual install never reads it.

   ```bash
   npm run bootstrap   # .env.example → apps/api/.env (never overwrites one), plus dev certificates
   ```

   Then set at minimum the six variables that have no default (`apps/api/src/config/env.ts`):

   - `DATABASE_URL` — must match a MySQL server you actually control. For XAMPP's default MySQL:
     `mysql://root:@localhost:3306/timesheet_portal` (empty password). Percent-encode a `#` or `%`
     in the password (`%23`, `%25`).
   - `CONTROL_DATABASE_URL` — a second, much smaller database: the org registry, SSO config, plan
     tiers and platform-admin accounts (see
     [ARCHITECTURE.md § 3.1](ARCHITECTURE.md#31-database-per-tenant-multi-tenancy)). Required even
     for a single local org; a database on the same server works fine, e.g.
     `mysql://root:@localhost:3306/timesphere_control`.
   - `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `PLATFORM_ADMIN_JWT_SECRET` — three distinct long
     random strings. The template's placeholders pass the 16-character minimum, so a local install
     boots on them; production refuses them (see
     [§ Secrets](#secrets-encryption_key-and-per-environment-env-files)).
     `PLATFORM_ADMIN_JWT_SECRET` must differ from the other two — it signs the cross-org console's
     tokens, and a leaked tenant secret must not be able to mint one — and nothing checks that for
     you.
   - `ENCRYPTION_KEY` — 64 hex characters (32 bytes), the AES-256-GCM key for every secret the app
     stores. Generate one with `openssl rand -hex 32` (no `openssl` on this machine?
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` does the same).

   Two optional ones worth knowing now:

   - `SMTP_*` — leave `SMTP_HOST` empty to have emails logged to the console instead of actually
     sent; **Workspace Settings → Mail server** overrides these later.
   - `ANTHROPIC_API_KEY` — leave empty to keep the default (Anthropic-provider) AI path inert until
     either this or a key saved in Workspace Settings is available. AI also needs an admin to flip
     its master switch — it never turns itself on. See
     [§ Turning on AI features (BYOK)](#turning-on-ai-features-byok).

   **The template's database defaults match this path, not Docker's.** `.env.example` assumes
   XAMPP (port `3306`, user `root`, empty password). Docker Compose's MySQL container is a
   *different* server on a *different* port: host port `3307`, with the root password the
   installer generated into the root `.env`'s `MYSQL_ROOT_PASSWORD`. The template used to default
   to Compose's pair, so copying it verbatim for a local install produced an API that booted far
   enough to look alive, then failed confusingly the first time it touched the database. Getting the
   pairing backwards in either direction is still the #1 cause of
   `Authentication failed against database server` — and exactly what step 5 catches.

3. **Make sure MySQL is running** — start it from the XAMPP Control Panel if you're using XAMPP's
   MySQL.

4. **Generate the Prisma clients** (tenant schema + the separate control-plane schema):

   ```bash
   npm run db:generate
   ```

5. **Run the doctor before going any further** — the single highest-value step in this guide:

   ```bash
   npm run doctor -w apps/api        # diagnose only
   npm run doctor:heal -w apps/api   # + create both databases if missing, apply every pending migration
   ```

   It validates `.env` against the schema the server boots with, then opens a real connection to
   both databases, so a wrong host, port or password surfaces here as one specific message rather
   than as a Prisma error three steps later. What it checks and why it exists:
   [§ Self-diagnosis](#self-diagnosis-npm-run-doctor).

6. *(Optional — redundant after `doctor:heal`)* **Create the databases and apply migrations the
   Prisma way:**

   ```bash
   npm run db:migrate
   ```

   This is `prisma migrate dev` for both schemas: it creates `timesheet_portal` and
   `timesphere_control` if they don't exist and applies every migration. It is also Prisma's
   schema-*authoring* command, and on a database that has drifted from the migration history it
   offers to reset (drop) it — answer no. `doctor:heal` runs `migrate deploy`, which never does.

7. **Seed the tenant's demo data and the control plane:**

   ```bash
   npm run seed
   ```

   This runs the tenant seed, then `control:seed`. The tenant seed fills in roles/permissions,
   three demo users, a demo project, default ticket types (Bug/Task/Improvement), and every
   notification/ticketing/AI settings singleton at its safe default (AI **off** until you opt in).
   `control:seed` registers one `Organization` (slug from `DEFAULT_ORG_SLUG`, default `default`)
   pointing at `DATABASE_URL`, seeds the three plan tiers' default limits, and creates one
   `PlatformAdminUser`. Credentials for all four accounts: [§ Demo credentials](#demo-credentials).
   The MCP server needs no seed row at all — its settings singleton is created the first time an
   admin opens the page, and every column of it defaults to off.

8. **Fan the schema out to every organization's own database**, now that the org registry exists:

   ```bash
   npm run db:migrate:tenants
   ```

   A no-op with one organization; required the moment there are two (see the fan-out note above).

9. **Run the app:**

   ```bash
   npm run dev
   ```

   - Frontend: http://localhost:5173 (https once this machine has a certificate — step 10)
   - API: http://localhost:4000/api (health check at http://localhost:4000/health)
   - Platform-admin console: http://localhost:5173/platform-admin/login (see
     [ARCHITECTURE.md § 3.6](ARCHITECTURE.md#36-platform-admin-console))

   The web dev server proxies `/api` and `/uploads` to the API, so there's no separate URL/CORS
   config to manage in dev. Before it starts, `npm run dev` re-runs `npm install` if
   `package-lock.json` has moved, and `doctor:heal` if a migration has appeared since its last run
   (`scripts/ensure-deps.mjs`, `scripts/ensure-migrations.mjs`).

10. *(Optional)* **HTTPS on the LAN — required for the camera from other devices.** The TLS
    certificates are per-machine private keys, deliberately git-ignored, so a clone can never bring
    them along — `npm run setup` mints this machine's own pair when there isn't one (and never
    regenerates one you have already trusted on your devices). It needs
    [mkcert](https://github.com/FiloSottile/mkcert) (`winget install FiloSottile.mkcert`,
    `brew install mkcert nss`, or `sudo apt install mkcert libnss3-tools`); if that's missing,
    setup warns and carries on serving http, and you can generate the pair later with:

    ```bash
    npm run certs        # dispatches to scripts/make-lan-certs.{ps1,sh} for your OS
    ```

    Restart `npm run dev` and it serves `https://localhost:5173` + `https://<lan-ip>:5173`
    automatically — the presence of `apps/web/certs/` is the switch. The script prints the
    one-time root-CA trust step for phones. Details:
    [DEPLOYMENT.md § Serving over HTTPS](DEPLOYMENT.md#serving-over-https-required-for-the-camera-and-for-copy-buttons).

11. *(Optional)* **Point this checkout at UAT or production config** instead of local: copy
    `apps/api/.env.uat.example` → `apps/api/.env.uat`, then
    `APP_ENV=uat npm run dev -w apps/api` (PowerShell: `$env:APP_ENV = "uat"` first). Profiles
    layer over `.env` (the profile wins, `.env` fills gaps), real ones are git-ignored, and a
    missing profile refuses to boot rather than silently running local config. Full runbook:
    [DEPLOYMENT.md § Environment profiles](DEPLOYMENT.md#environment-profiles--local--uat--production).

### Demo credentials

Created by `npm run seed` here, and by the Docker installer's seed step:

| Account | Email | Password | Sign in at |
|---|---|---|---|
| Super Admin | `superadmin@timesheet.local` | `Admin@12345` | `/login` |
| Manager | `manager@timesheet.local` | `Admin@12345` | `/login` |
| Employee | `employee@timesheet.local` | `Admin@12345` | `/login` |
| Platform Admin | `platform-admin@timesphere.local` | printed once by `control:seed` (see below) | `/platform-admin/login` |

**There is no fixed platform-admin password.** `.env.example` ships `PLATFORM_ADMIN_BOOTSTRAP_PASSWORD`
empty, so `control:seed` generates one and prints it once; for predictable local sign-ins set your own
(12+ characters) in `apps/api/.env`, which the dev scripts and local e2e read. CI builds one per run.
The installers generate a strong one and print it once —
on a production install the account is held at **Change password** until it is rotated, and, with
`NODE_ENV=production`, at MFA enrolment after that. It has cross-org access; treat it accordingly.

### Secrets: ENCRYPTION_KEY and per-environment .env files

Two rules, for the same reason the doctor exists — a secret that is well-formed but wrong does more
damage than one that fails loudly:

- **`ENCRYPTION_KEY` has no working default, on purpose.** The schema requires an exact
  64-character hex string (`/^[0-9a-f]{64}$/i`) and the template ships an obviously invalid
  placeholder, so an unedited copy of `.env.example` fails loudly at boot instead of encrypting
  real secrets (SMTP and IMAP passwords, BYOK API keys, SSO client secrets, the security-ingestion
  token, chat and Git integration credentials, face templates, each tenant's database DSN) under a
  key nobody wrote down. Generate a fresh one per
  environment with `openssl rand -hex 32` and never reuse one across local/staging/production.
- **Never copy a live `.env` between environments.** Every secret in it
  (`JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`/`PLATFORM_ADMIN_JWT_SECRET`/`ENCRYPTION_KEY`) should
  be freshly generated per environment. Production additionally gets a boot-time check
  (`server.ts#assertProductionSafety`) that refuses to start when `JWT_ACCESS_SECRET`,
  `JWT_REFRESH_SECRET` or `ENCRYPTION_KEY` is under 32 characters, repetitive, low-entropy, or
  contains a placeholder word such as `replace-with` or `secret`. Since 2026-10 it checks
  `PLATFORM_ADMIN_JWT_SECRET` the same way, and refuses to start when it equals either JWT secret. See
  [.github/SECURITY.md](../.github/SECURITY.md).

**`Unsupported state or unable to authenticate data` means the wrong key, not a corrupted
database.** Every AES-256-GCM `decryptSecret()` call throws exactly that when the ciphertext was
encrypted under a different `ENCRYPTION_KEY` than the one now in `.env` — for example, a key rotated
without re-encrypting existing rows. The one row this matters for at boot is
`OrgDatabase.encryptedDsn` in the control-plane database: `server.ts` decrypts the default
organization's DSN to warm its Prisma client. If you rotate `ENCRYPTION_KEY` after tenant DSNs have
been provisioned, re-encrypt every `OrgDatabase.encryptedDsn` row under the new key:

- **The default organization:** re-run `npm run control:seed -w apps/api`. Its upsert rewrites that
  row from the current `DATABASE_URL` under the current key, and it never resets a password.
- **Every other organization:** read the old plaintext DSN out of your deploy records, or
  reconstruct it from `host` + `databaseName` on that same row, then `encryptSecret()` it again.
  There's no automated migration for this because the plaintext DSN is intentionally never stored
  anywhere to migrate from.

Other encrypted values (a saved SMTP password, a BYOK key) fail the same way the first time they're
used; saving them again in Workspace Settings re-encrypts them under the current key.

---

## Self-diagnosis: `npm run doctor`

```bash
npm run doctor -w apps/api          # diagnose only — never writes anything
npm run doctor:heal -w apps/api     # + create the databases and run migrations
npm run doctor:fix-env -w apps/api  # + also correct a wrong host:port in .env (see below)
```

**Why it exists.** Every first-run failure this project has actually hit traces back to one
pattern: a config value that's *well-formed* (right shape, passes validation) but *wrong* (points at
a server, port, or key that doesn't match what's actually running). The Zod schema catches the first
kind at boot; it cannot catch the second, and the API would boot far enough to look alive before
failing confusingly the first time it touched the database. The doctor closes that gap with real
connections instead of string checks.

Run this **before** `db:migrate`/`dev` on any fresh checkout or new environment (local, CI,
staging, a new production host), and **first** whenever something seems broken. It checks, in
order, and stops at the first failure with a specific fix:

1. Reports the OS/architecture/Node version it's running on, so a "works on my machine" report
   carries the environment with it.
2. `.env` exists and passes the same Zod schema the server boots with.
3. Parses `DATABASE_URL`/`CONTROL_DATABASE_URL` the same way Prisma does (userinfo splits at the
   **last** `@`), then prints the host/port/database it actually resolved — so a password
   containing `@` can't silently be misread as part of the hostname. It also flags a password
   containing `#` or `%`, which genuinely do need percent-encoding (`%23`, `%25`).
4. **Scans this machine for running MySQL servers** on ports 3306/3307/3308/3309, reading each
   one's handshake packet to confirm it's really MySQL/MariaDB and report its version — "port
   3306 is open" and "your database is there" are not the same claim.
5. `DATABASE_URL` and `CONTROL_DATABASE_URL` are actually reachable (real TCP connection, not
   just "is the string non-empty").
6. The credentials in `DATABASE_URL` are actually accepted (a real `SELECT 1`).
7. **Face-verification preflight** (advisory — warns, never fails): `APP_BASE_URL` is a secure
   context (browsers only grant camera access over HTTPS or `localhost`, and fail *silently*
   otherwise — the number-one "camera never appears" cause on LAN deployments), the face image
   directory is writable, and enough memory is free for the ~500MB the models hold per process.
   Add `--face` (`npm run doctor -w apps/api -- --face`) to also load the real ML models and
   time an inference on this hardware. If it warns about the secure context, the fix is a
   certificate rather than a setting in this product — see
   [DEPLOYMENT.md § Serving over HTTPS](DEPLOYMENT.md#serving-over-https-required-for-the-camera-and-for-copy-buttons),
   which covers a public domain, a LAN with no domain, and quick phone testing.

Because step 4 runs *before* the pass/fail decision, a failure can tell you the answer instead of
just the symptom. Configured for 3307 but MySQL is really on 3306? You get:

```
FAIL: DATABASE_URL — nothing is listening on localhost:3307.

But MySQL IS running on port 3306 (5.5.5-10.4.32-MariaDB). Your .env is pointed at the wrong port.
Fix it automatically:   npm run doctor:fix-env -w apps/api
```

And if nothing is running anywhere, it looks for what this machine actually has installed —
Windows services matching `mysql`/`mariadb`, a XAMPP/WAMP/MySQL install path, `brew services` on
macOS, `systemctl` units on Linux — and prints the specific command to start it.

The `:heal` variant runs four more steps once the checks above pass (and skips the advisory
face preflight, which is diagnostic rather than repair):

8. Creates the `DATABASE_URL`/`CONTROL_DATABASE_URL` databases if the server's reachable but they
   don't exist yet (`CREATE DATABASE IF NOT EXISTS`).
9. Runs `prisma migrate deploy` for both the tenant and control-plane schemas.
10. **Repairs a migration stranded mid-apply** — the one database failure that retrying can never
    fix, and the reason `doctor:heal` is now wired into the Docker installer, `update.sh`, and the
    Helm migration Job rather than being a dev-machine convenience.

    MySQL DDL is not transactional and Prisma does not roll back. A migration that fails *part way*
    therefore leaves its `ALTER`/`CREATE INDEX` applied while `_prisma_migrations` records the
    migration **FAILED**, and every later `migrate deploy` refuses with **P3009** — including the
    deploy carrying the *fixed* version of that same migration. The doctor detects that, names the
    stranded migration, and runs `prisma migrate resolve --rolled-back <name>` followed by
    `migrate deploy` to replay it.

    **It only auto-repairs a migration whose SQL carries the `@rerunnable` marker**, meaning the
    migration guards its own DDL with `information_schema` checks and is safe to replay over a
    partial application. Anything unmarked is reported with instructions instead, because replaying
    arbitrary half-applied DDL is how data gets lost. It **never** runs `prisma migrate reset` —
    Prisma's own P3009 error text suggests it, and it drops the database.

    Inside a Docker deployment, where the API container is the thing that failed to start:

    ```bash
    docker compose run --rm --no-deps --entrypoint sh api -c 'npm run doctor:heal -w apps/api'
    # diagnose only:
    docker compose run --rm --no-deps --entrypoint sh api -c 'npm run doctor -w apps/api'
    ```

11. **Fans the migrations out to every other registered organization's database** (since
    2026-08-26) — the same walk as `npm run db:migrate:tenants`. Advisory: a tenant that can't be
    reached or migrated is a warning, not a failure, because it must not block healing the one
    database `npm run dev` needs. `npm run migrate:tenants -w apps/api` by hand shows which one.

`doctor` and `doctor:heal` never modify `.env` — only DB-side state. **`doctor:fix-env` is the one
mode that edits it**, deliberately opt-in and deliberately narrow: it rewrites *only* the
`host:port` inside `DATABASE_URL`/`CONTROL_DATABASE_URL`, and only when discovery has proven MySQL
is listening elsewhere. Credentials, database names, comments, quoting style, and line endings
(including CRLF on Windows) are all preserved byte-for-byte. Every step is idempotent, so all
three are safe to run repeatedly (a CI step, a cron job, or just habit).

The installer's own self-heal check (missing `.env` keys) and `doctor`'s checks are
complementary: the installer catches "this `.env` is incomplete," `doctor` catches "this `.env`
is complete but wrong" (bad host, bad port, bad password), and `doctor:heal`/`doctor:fix-env` go
one step further and fix what can be fixed automatically.

---

## Configuring things after install

Everything below is a UI action, not a code change or redeploy — this is the actual value of
the admin-configurable settings surfaces this app has:

| What | Where | Notes |
|---|---|---|
| Outbound email (SMTP) | Workspace Settings → **Mail server** | Overrides `.env`'s `SMTP_*` vars; leave blank to keep using `.env`. Live "Test connection" button. |
| Email templates (subject/body per event) | **Email templates** page (sidebar) | Edit any built-in template, preview with sample data, send a single test, or "Send all templates as test" to smoke-test every one at once. Also shows per-template send volume, the success/failure split, and a grouped failure breakdown read from `EmailLog`. |
| Which roles get which emails | Workspace Settings → **Email channels** | A category × role grid: every gateable email category is a row, grouped into Timesheets / Tickets / Changes / Digests / Identity / Workspace. Unticking a cell suppresses only the **email** leg for that role — the in-app bell notification always fires, so muting Manager on an escalation removes the inbox copy without hiding the escalation. `welcome`, `reset`, and the email-intake auto-reply are listed as **Always sent** and deliberately have no row: they go to one person as a direct result of an action, and a role filter over a password reset is an account lockout waiting to happen. |
| AI provider/model/budget | Workspace Settings → **AI** | BYOK — a ranked list of Anthropic and/or OpenAI-compatible endpoints, each with its own key/model, a live status dot, a Test button, and an opt-in auto-failover circuit breaker. Walkthrough: [§ Turning on AI features (BYOK)](#turning-on-ai-features-byok). |
| Email-to-ticket intake | Workspace Settings → **Email intake** | IMAP mailbox + routing rules. |
| Chat-to-ticket (Slack/Teams/Google Chat/Telegram) | Workspace Settings → **Chat integrations** | Per-platform bot tokens + routing rules. |
| Security/CI findings ingestion (SAST/DAST/SSAT/SSCT) | Workspace Settings → **Security & DevOps** | Generate a bearer token, paste the webhook URL into your CI — see [docs/SECURITY_DEVOPS_INTEGRATIONS.md](SECURITY_DEVOPS_INTEGRATIONS.md) for GitHub Actions/GitLab CI/Jenkins/Bitbucket examples. |
| VAPT (pentest) report upload | Workspace Settings → **Security & DevOps → VAPT report upload** | Structured JSON only (not arbitrary PDF parsing) — paste/upload assessor + findings, optionally attach to a ticket by key. Lands in the same per-ticket Security tab as CI-ingested findings. |
| Repo/branch/PR reference on a ticket | Ticket detail sheet → **Dev** tab | Manual entry (repository, branch, PR URL, PR status) — not a live GitHub/GitLab OAuth sync; see [docs/ROADMAP.md](ROADMAP.md) for why that's a separate, larger scope of work. |
| Kanban grouped by manager / org-chart | Tickets → Kanban view ("Group by manager") · Team page | Reads the existing `User.managerId` reporting-line relation — no extra configuration needed. |
| Block resolve while CI is failing | Workspace Settings → **Ticketing** | Off by default; needs CI actually POSTing test runs to the Security & DevOps webhook to have any effect. |
| Public API keys & outbound webhooks | Workspace Settings → **Public API** | Generate a bearer key (READ or WRITE scope) or register a webhook URL — see [docs/API.md](API.md#public-api) for the endpoint/signature reference. |
| MCP server (connect an AI assistant to this workspace) | Workspace Settings → **MCP server** | **Off by default, and off after an upgrade** — new in 2.3.0. Turn on the server, then issue a credential **bound to one user**: every tool runs with exactly that person's permissions, and the token is shown once. Write tools need the workspace write latch *and* their own per-tool switch, both off initially. Read [docs/DEPLOYMENT.md § Operating the MCP server](DEPLOYMENT.md#operating-the-mcp-server) before enabling — this is an authenticated endpoint that lets an external LLM client read (and, if you allow writes, act on) this workspace as that user. Endpoint reference: [docs/API.md](API.md#mcp-server). |
| Weekly AI/ML Practice Update (leadership digest) | **Practice update** page (sidebar, super admin only) | **Two switches and a list, and all three must be set.** Turn the email on under Workspace Settings → Email channels → Digests (`emailPracticeUpdate`), turn the AI narrative on under Workspace Settings → AI (off means the update still sends, rendering every section from the counted figures instead of prose), and add at least one recipient on the Practice update page itself — **only a super admin can change that list**. Addresses are plain email, no account needed: the people who most need this often have none. An optional Monday 07:30 send is off by default; the Generate → review → send button is the primary path. The template is editable like any other under Email templates (`digest.practice_update`). See [docs/API.md](API.md#weekly-aiml-practice-update). |
| AI refine ("tidy this up" beside a field) | Workspace Settings → **AI** | Nothing of its own to configure — it rides the existing AI master switch, the **writing assistant** toggle and the same monthly budget. Off wherever AI is off, and the button says which. |
| Live GitHub connection | Workspace Settings → **Security & DevOps → Git provider** | Bring your own GitHub OAuth App (client ID/secret) — set its callback URL to `<your-url>/api/git/callback`, then Connect. Once connected, generate a webhook secret from the same card and add a webhook (URL + secret shown there) to each repo you want auto-synced, for push/PR-driven `TicketBranch` updates and (opt-in) AI PR-review summaries. |
| Face (identity) verification | Workspace Settings → **Face verification** | Off by default. Master switch, per-action scope, match/liveness thresholds, retention window, consent wording, plus the review log of every attempt. Per-user opt-in lives on Users → edit → *Require face verification*. Employees enroll from their own Profile. Needs **HTTPS** (browsers only expose a camera on a secure origin). Collects biometric data — read [docs/FACE_VERIFICATION.md](FACE_VERIFICATION.md) first. |
| Change management | Workspace Settings → **Change management** | **Off by default, and off after an upgrade.** Turn on the workspace switch; the org's plan tier must also include it (Team and up), and the two conditions produce deliberately different messages because "turn it on" and "upgrade" need different people. Categories, sources, applications, maintenance windows, blackout periods, the weighted risk parameters and the per-stage SLA budgets are all admin-editable from the same page — a **deactivated** risk parameter leaves both the required set and the maths, and a deactivated SLA stage has no clock rather than a zero-hour one. Approval routes to the requester's manager, so make sure `managerId` is set on your users; with none, it falls back to every active super admin. See [docs/API.md](API.md#change-management-v8). |
| SSO (Google/Microsoft/SAML/LDAP) | Workspace Settings → **Single sign-on** | Independent per-provider toggles. |
| Ticket types, labels, SLA hours | Workspace Settings → **Ticketing** | |
| Plan tiers, seat limits, AI budget ceilings | `/platform-admin` console | Cross-org, platform-admin-only. |
| User designation (job title) | Users page → create/edit form, or bulk-upload CSV's `designation` column | Free text, display-only — shown on the Users table and org chart. Has no effect on RBAC (that's the separate `role` field). |
| API request telemetry (latency percentiles, slowest endpoints, per-host/pod split) | Workspace Settings → **Maintenance → API performance** | **Not a UI toggle** — the panel reads and reports, but collection is switched on in the environment. Off by default. |
| Where uploaded files live, and rotating log files | Workspace Settings → **Storage & logs** | **Read-only by design** — shows the resolved documents/avatars/face directories, which variable set each one, and whether each is really writable; validates a candidate path before you commit it. Changing a path is a `.env` edit plus a restart, never a save button — see [docs/DEPLOYMENT.md § Relocating file storage](DEPLOYMENT.md#relocating-file-storage) and [§ Log files](DEPLOYMENT.md#log-files). |

Every row above except the last two reads live from the database on the next request — no server
restart. API telemetry sits in the hot path of every request, so an operator has to ask for that
cost in the environment rather than an admin flipping it from a settings page; the storage and log
paths are process-wide while a super admin is per-tenant, and an arbitrary absolute path the app
then writes to is close enough to arbitrary file write that it is not something one compromised
admin account should be able to set.

### Turning on AI features (BYOK)

AI is off by default — the master switch and every per-feature toggle ship off, and none of them
turns itself on — and the underlying model provider is admin-chosen per workspace: bring your own
key for whichever vendor you already have an account with. To try it:

1. Sign in as Super Admin ([demo credentials](#demo-credentials)) → **Workspace Settings → AI**.
2. Pick a **Provider**: Anthropic (native), any OpenAI-compatible vendor — OpenAI, Groq, Mistral,
   DeepSeek, OpenRouter, Gemini, Qwen, Kimi, Nvidia NIM, a local Ollama/LM Studio install (no key
   needed), or **Custom endpoint** for anything else that speaks the same protocol — or
   **Native (llama.cpp)**: a model this server downloads and runs itself on the CPUs it already
   has, with no key, no GPU and no account anywhere (**Run a model on this server**, on the same
   page). Sizing, the model directory and why Kubernetes runs it as a sidecar are in
   [docs/DEPLOYMENT.md § Running a model on your own server](DEPLOYMENT.md#running-a-model-on-your-own-server).
   Picking a preset fills in its base URL; you can still override it.
3. Paste an **API key** and click Save (skip this for a local Ollama/LM Studio install or the
   native runtime). The key is encrypted at rest (AES-256-GCM, under `ENCRYPTION_KEY`) and never
   sent back to the browser once saved — only an "is a key saved" flag is. Anthropic alone also
   honors `ANTHROPIC_API_KEY` in `apps/api/.env` as a fallback, so existing deployments keep
   working unconfigured.
4. Set the **Model** — a dropdown of Claude models for the Anthropic provider, or a free-text field
   for OpenAI-compatible providers (model names vary per vendor, e.g. `gpt-4o-mini`, `llama3.1`,
   `mixtral-8x7b`).
5. Flip the master switch, then whichever per-feature toggles you want (auto-triage, duplicate
   detection, writing assistant, comment summary, "Ask AI", email intake, weekly digest, email
   failure diagnosis, and more), and optionally set a monthly budget cap. AI refine has no toggle of
   its own — see its row in the table above.
6. For email-to-ticket intake specifically, also fill in the mailbox connection under
   **Workspace Settings → Email intake** and add at least one routing rule (or a fallback project)
   so inbound mail has somewhere to land.

Not every OpenAI-compatible endpoint supports the same structured-output request shape (local
runtimes like Ollama/LM Studio in particular often don't) — triage and duplicate-detection ask for
JSON via the prompt itself when needed and validate the response locally either way, so a provider
that lacks native structured output degrades gracefully instead of hard-failing.

### Environment variables for storage and logs

All optional, all inert when unset, all forwarded by both compose files and the Helm chart:

- `STORAGE_ROOT` — absolute directory that becomes the parent of the documents/avatars/face
  subtrees. Empty keeps today's layout under `UPLOAD_DIR` exactly.
- `STORAGE_DOCUMENTS_DIR` / `STORAGE_AVATARS_DIR` / `STORAGE_FACE_DIR` — pin one subtree somewhere
  else entirely (face imagery on an encrypted volume, documents on a NAS).
- `LOG_DIR` — absolute directory for rotating file logs. **Empty means off**, which is the
  default; stdout is never taken away either way.
- `LOG_ROTATE_HOURS` (default `4`), `LOG_RETENTION_DAYS` (default `30`),
  `LOG_COMPRESS_ON_ROLLOVER` (default `true`).

Every one of these must be an **absolute** path with no `..` segments, and the directory must
already exist and be writable — a relative path resolves against whatever directory the service
started in, which is different for `npm run dev`, a systemd unit and a container. Inside a
container the path must also sit inside a mounted volume or it dies with the pod.

### Environment variables for API telemetry

Add these to `apps/api/.env` (manual install), or to the root `.env` on the Compose shape, and
restart the API. Both compose files and the chart's ConfigMap already forward this set, so no file
needs editing to switch it on — but note that Compose passes an *explicit list* of variables to
the container rather than the whole `.env`, so anything **not** named in `api.environment` does not
exist inside it. See
[docs/DEPLOYMENT.md § Operating API request telemetry](DEPLOYMENT.md#operating-api-request-telemetry)
for the full operational picture (row volume, retention, sampling, and what the CPU/RAM columns
can and cannot tell you).

- `API_TELEMETRY_ENABLED` — master switch, default `false`. Read at boot, so a change needs a restart.
- `API_TELEMETRY_SAMPLE_RATE` — fraction of requests recorded, `0`–`1` (default `1`). On a busy
  deployment turn this down (e.g. `0.1`) rather than turning the feature off — percentiles from a
  sample are still percentiles.
- `API_TELEMETRY_FLUSH_MS` — how often the in-memory buffer drains to the database (default `5000`).
- `API_TELEMETRY_MAX_BUFFER` — buffered rows past which new samples are dropped and counted rather
  than queued (default `5000`).
- `API_TELEMETRY_RETENTION_DAYS` — rows older than this are pruned nightly at 04:10 (default `14`).
- `POD_NAME` / `POD_NAMESPACE` / `CLUSTER_NAME` — host identity stamped on each row, named for the
  Kubernetes downward API. Leave unset off-cluster; those columns are written `NULL` rather than
  guessed, and the hostname still comes from `os.hostname()`.

The root `.env.example` carries the same list with the reasoning inline.

---

## FAQ

**Do I need Docker?** No — see [Manual local install](#manual-local-install-no-docker). Docker
is the fastest path, not the only one.

**Can I use MySQL I already have running, instead of the one in Docker Compose?** Yes, on both
paths — no manual editing needed. For the manual install path, just point `DATABASE_URL`/
`CONTROL_DATABASE_URL` at it (any real MySQL server works, not just XAMPP — see
[docs/DEPLOYMENT.md § Bringing your own MySQL server](DEPLOYMENT.md#bringing-your-own-mysql-server)).
For the Docker one-click installer, when it asks "Where should the database live?", choose
**"I already have a MySQL server I want to use"** and give it your host/port/username/password —
it'll skip provisioning the bundled `mysql` container entirely and use
`docker-compose.external-db.yml` instead. Re-running the installer later against that same `.env`
remembers your choice automatically (no re-prompting).

**Can I skip SMTP entirely?** Yes. With no SMTP configured (neither `.env` nor the Mail server
settings page), emails are logged to the console and recorded as `FAILED` in `EmailLog` instead
of crashing anything — every feature that sends email still works, it just doesn't deliver.

**What if I already ran the installer once and want to change my SMTP credentials?** Don't
re-run the installer for this — it won't touch an existing `.env`. Instead use **Workspace
Settings → Mail server**, which takes effect immediately with no restart, or edit `apps/api/.env`
directly and restart the API.

**Is it safe to re-run `install.sh`/`install.ps1`?** Yes — it never overwrites an existing
`.env`, and re-seeding is an upsert (safe to run again; it won't create duplicate demo data).

**I have a specific error message.** See [§ Troubleshooting](#troubleshooting), which is keyed by
the error text — including `Authentication failed against database server`,
`ENCRYPTION_KEY must be a 64-character hex string`, and AI's "No API key configured".

**Can setup auto-create the databases and run migrations for me, instead of me running each
command by hand?** Yes — `npm run setup` (fresh checkout) or `npm run doctor:heal -w apps/api`
(already have `.env` set up) do exactly that: create `timesheet_portal`/`timesphere_control` if
they don't exist, and run `prisma migrate deploy` for both schemas. Neither one ever touches
`.env` or an existing database's data — they only create what's missing and apply pending
migrations, so they're safe to run repeatedly.

**The Docker installer's health check timed out / the API container crashed on first boot.**
`install.sh`/`install.ps1` now auto-heal this: if `/health` doesn't respond within 3 minutes, the
installer prints `docker compose ps`, restarts the `api` container, and polls again — this fixes
the most common cause (a transient migration lock, or `api` starting before `mysql` finished its
first-boot init). If it's still not healthy after that, check `docker compose logs api` for the
actual error — a slow first pull of the `mysql:8.4` image on a slow connection is the next most
common cause and just needs more time.

**How do I add a new SAST/DAST tool that isn't in the examples doc?** You don't need TimeSphere
to know about your specific tool — translate its native output into the generic findings JSON
shape yourself (a `jq` one-liner in most cases) and `curl` it to the ingestion webhook. See
[docs/SECURITY_DEVOPS_INTEGRATIONS.md § 3](SECURITY_DEVOPS_INTEGRATIONS.md#3-per-ci-system-examples).

**How do I change the platform-admin password?** Signed in: **Change password** in the console
sidebar (current password re-verified, 12+ characters, every other console session signed out).
While the account is still on its seeded password (see [§ Demo credentials](#demo-credentials)),
an amber banner across every console page reminds you. **Forgotten it entirely?** There is
deliberately no emailed reset for the highest-privilege account in the system — update the
`PlatformAdminUser` row in the control-plane database with a freshly bcrypt-hashed password, or
re-run
`npm run control:seed -w apps/api` against a fresh control database if you haven't put real orgs
on it yet.

**Where do I report a bug or request a feature?** See [docs/ROADMAP.md](ROADMAP.md) for what's
already planned — check there before filing something that's already tracked.

---

## Troubleshooting

**First step for any of these: run `npm run doctor -w apps/api`** (or `doctor:heal` to also create
missing databases and apply pending migrations — see
[§ Self-diagnosis](#self-diagnosis-npm-run-doctor)). It catches the most common root cause — a
wrong DB host/port/password in `.env`, usually Docker Compose's values used against a local server
or vice versa — with one specific message instead of you working backward from one of the errors
below. Installer failures (execution policy, CRLF line endings, Docker not running, ports
3307/4000/5173 taken) have their own table:
[§ Common errors when running the installer](#common-errors-when-running-the-installer).

- **`Error: Cannot find package '...packages/shared/dist/index.js'`** — `packages/shared` hasn't
  been built. Run `npm install` (which builds it via `postinstall`) or, directly,
  `npm run build -w packages/shared`. A `Cannot find package` naming some *other* package right
  after a `git pull` is a dependency the release added: `npm run dev` and `npm run build`
  re-install on their own when `package-lock.json` has moved; for anything else, run
  `npm install`.
- **`Environment variable not found: DATABASE_URL` / Zod "Required" errors on boot** — your `.env`
  is in the wrong place. The manual install reads `apps/api/.env`, not the repo root.
- **`Authentication failed against database server, the provided database credentials for 'root' are not valid.`**
  — the password in `DATABASE_URL` doesn't match the MySQL server it actually reached. For a stock
  XAMPP install it is empty; for the Docker Compose container (host port 3307) it is the generated
  `MYSQL_ROOT_PASSWORD` in the root `.env`. `npm run doctor -w apps/api` says exactly this and
  prints the XAMPP default; if the port is what's wrong, `npm run doctor:fix-env -w apps/api`
  corrects it.
- **`ENCRYPTION_KEY must be a 64-character hex string` on boot** — generate one with
  `openssl rand -hex 32` and set it in `apps/api/.env`. This key encrypts every stored secret at
  rest, so there is no safe default for it, on purpose — see
  [§ Secrets](#secrets-encryption_key-and-per-environment-env-files).
- **`Unsupported state or unable to authenticate data`** — something was encrypted under a
  different `ENCRYPTION_KEY` than the one now in `.env`; the database isn't corrupted. Recovery,
  including the one row that blocks boot:
  [§ Secrets](#secrets-encryption_key-and-per-environment-env-files).
- **Port already in use (4000 or 5173)** — both ports are strict on purpose, so a second
  `npm run dev` stops instead of drifting to another port; often the other process is an earlier
  TimeSphere stack you forgot was running. Stop it, or move a port: `API_PORT` in `apps/api/.env`
  (then point the web proxy at it with `API_PROXY_TARGET=http://localhost:<port>`), or
  `npm run dev -w apps/web -- --port <port>` for the web app (its port is set in
  `apps/web/vite.config.ts`).
- **AI features show "No API key configured"** — two separate things must both be true. A key: for
  the Anthropic provider, set `ANTHROPIC_API_KEY` in `apps/api/.env` or save a key in
  **Workspace Settings → AI**; for any other provider, save a key there directly (or leave it blank
  for a keyless local provider like Ollama/LM Studio). And the master AI switch on that same page,
  which is a separate toggle from having a key. See
  [§ Turning on AI features (BYOK)](#turning-on-ai-features-byok).
- **Email intake isn't picking anything up** — check three things: the master AI switch **and** the
  "Email-to-ticket intake" toggle are both on, the mailbox connection test in **Workspace Settings →
  Email intake** succeeds, and at least one routing rule or a fallback project is configured
  (otherwise matched-but-unrouted mail is intentionally dropped, logged as a warning).
- **Logged in but immediately bounced back to `/login` after a refresh** — the refresh token is an
  httpOnly cookie scoped to `/api/auth`; if you're serving the API and web app from different
  origins in a custom setup, confirm the API's CORS config allows your origin with
  `credentials: true` and that the cookie's `Secure` flag (production-only) matches your protocol
  (HTTPS in production).

Covered elsewhere:
- [docs/DEPLOYMENT.md](DEPLOYMENT.md) — Docker Compose / Kubernetes-specific issues.
- [docs/SECURITY_DEVOPS_INTEGRATIONS.md § 7](SECURITY_DEVOPS_INTEGRATIONS.md#7-troubleshooting) — ingestion webhook 401/404/429s.

If none of those cover it, the fastest next step is almost always `npm run doctor -w apps/api`
(manual install) or checking `docker compose logs api` (Docker install) — both surface the
actual underlying error rather than a symptom two layers removed from the cause.
