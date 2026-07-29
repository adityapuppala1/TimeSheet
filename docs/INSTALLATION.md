# Installation Guide

A complete, step-by-step path from "nothing installed" to a running TimeSphere instance, for
every supported path — one-click Docker install, manual local (no Docker), and Kubernetes. Also
covers the FAQ, self-diagnosis, and how to configure things after install without editing code.

For architecture/deployment-shape background (on-prem vs. multi-org SaaS), see
[docs/DEPLOYMENT.md](DEPLOYMENT.md). This guide is the "how do I actually get it running"
companion to that document.

## Choose your path

| You want... | Use |
|---|---|
| The fastest way to try it, nothing but Docker installed | [One-click install](#one-click-install-recommended) |
| Full control, no Docker, developing/debugging the app itself | [Manual local install](#manual-local-install-no-docker) |
| Production Kubernetes with autoscaling | [docs/DEPLOYMENT.md § Kubernetes](DEPLOYMENT.md#kubernetes-deployment) |
| Multi-org SaaS (more than one company on one deployment) | [docs/DEPLOYMENT.md § Shape 2](DEPLOYMENT.md) after either path above |

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
.\install.ps1
```

Either script is interactive (it'll prompt you for a couple of values — see step 3 below) and
takes a few minutes on first run while Docker pulls/builds images. Let it run to completion
rather than closing the terminal partway through.

### Common errors when running the installer

These are the actual failure modes you're likely to hit, in the order you'd hit them:

| Error | Cause | Fix |
|---|---|---|
| PowerShell: `install.ps1 cannot be loaded because running scripts is disabled on this system` | Windows' default script execution policy (`Restricted`) blocks any local `.ps1` file, signed or not — this is a Windows default, not something specific to this repo. | Either run `powershell -ExecutionPolicy Bypass -File .\install.ps1` once, or (if you'll run PowerShell scripts regularly) `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` in an admin PowerShell, then re-run normally. |
| PowerShell: `install.ps1 is not digitally signed` / a red "cannot be loaded" wall of text mentioning a security warning | Same execution-policy family of error as above, sometimes phrased differently depending on Windows version/policy. | Same fix as above. |
| PowerShell: `Missing closing '}' in statement block or type definition` / `The string is missing the terminator: "` when you've done nothing but run `.\install.ps1` | A real bug, fixed 2026-07-29: `install.ps1` contains non-ASCII characters (em-dashes) and previously had no UTF-8 byte-order mark. Windows PowerShell 5.1 — the OS-bundled `powershell.exe`, not PowerShell 7's `pwsh` — defaults to the system codepage instead of UTF-8 for a BOM-less script file, which corrupted string parsing. This is fixed at the file level (a UTF-8 BOM was added) and CI now validates `install.ps1` under both `pwsh` and Windows PowerShell 5.1 so this class of bug can't silently return. | `git pull` to get the fixed file. If you're still hitting this on a version after 2026-07-29, please report it — it means the fix regressed. |
| bash: `install.sh: line 2: $'\r': command not found`, or `bad interpreter: /bin/bash^M` | The file has Windows-style CRLF line endings instead of Unix LF — happens if you cloned with `git config core.autocrlf true` (Git for Windows' own suggested default) before this repo's `.gitattributes` (which forces `install.sh` to always check out as LF) existed in your local copy. | `git pull` to get the current `.gitattributes`, then re-checkout the file: `git rm --cached install.sh && git checkout install.sh`. Or, one-off: `sed -i 's/\r$//' install.sh` (Git Bash/WSL) before running it. |
| bash: `install.sh: Permission denied` | The file isn't marked executable — normal for a fresh checkout on some setups. | `chmod +x install.sh`, then `./install.sh` again. |
| `Couldn't run 'docker compose'` / `Cannot connect to the Docker daemon` | By far the most common one: **Docker Desktop is installed but not actually running.** Being installed and being started are different things. | Start Docker Desktop from the Start menu / Applications folder and wait until it says "Docker Desktop is running" (the whale icon stops animating), then re-run the installer. |
| Docker Desktop itself refuses to start, mentioning WSL 2 or virtualization | Docker Desktop's own prerequisites aren't met — WSL 2 not installed, or virtualization disabled in BIOS/UEFI. | Follow Docker Desktop's own on-screen fix link, or see [Docker's WSL 2 backend docs](https://docs.docker.com/desktop/wsl/). This is a Docker Desktop prerequisite, not something this installer can work around. |
| `Port 3307/4000/5173 looks already in use` | Something else on your machine is already bound to a port this stack needs. Note: this is **3307**, not MySQL's usual 3306 — docker-compose.yml deliberately uses 3307 on purpose specifically so it never collides with a local/XAMPP MySQL you might already have running on 3306, so seeing an XAMPP MySQL on 3306 is not itself a conflict. | Check what's actually on that port (`docker compose ps` first, in case it's an old TimeSphere stack you forgot about) — stop it, or edit the port mapping in `docker-compose.yml`. |
| API container never becomes healthy / installer says "Still not healthy" after the restart attempt | Usually either a slow first pull of the `mysql:8.4` image on a slow connection, or a real error in the API's boot sequence. | `docker compose logs api` shows the actual error. If you see nothing but a long pull progress bar, just wait — first run legitimately takes a few minutes. |
| Seeding fails all 3 attempts | Either a real problem (check `docker compose logs api`), or — if you're re-running the installer against an already-set-up deployment — this is often just "already seeded," which is expected and harmless (seeding is an upsert, not an insert). | Re-run manually to see the real error: `docker compose exec api npm run control:seed -w apps/api` then `docker compose exec api npm run seed -w apps/api`. |
| Windows: `npm install`/Docker build fails with `EPERM: operation not permitted` on a file inside `node_modules` | Windows Defender (or another antivirus) has a file open/locked mid-write — a real, if intermittent, Windows-specific flake, not a bug in this repo. | Re-run the failed command — it usually succeeds on retry once the AV scan finishes. If it keeps happening, add this repo's folder to your antivirus's exclusion list. |

### What happens, step by step

1. **Dependency check** — confirms Docker + the Compose plugin are present; offers to
   auto-install Docker for you (see above) if not, or prints the OS-specific command.
2. **Port check (auto-heal)** — warns if ports `4000`/`5173`/`3307` already look bound to
   something else on this machine, before Compose gets a chance to bind-fail on them deep in its
   own logs. 3307, not MySQL's usual 3306 — see the port-conflict row in the table above for why.
3. **`.env` handling** (human-in-the-loop, security-relevant): 
   - If `.env` doesn't exist yet, you're prompted for exactly two values (web URL, API URL —
     both default to `localhost` for a trial run) and then, **optionally**, your outbound SMTP
     details (host/port/user/password/TLS) — type `N` to skip and configure email later from
     the UI. The password prompt hides your input as you type. Every other secret (DB
     password, JWT signing keys, encryption key) is generated for you with cryptographically
     strong randomness — you never have to think about them.
   - If `.env` already exists, the installer runs a **self-heal check**: it verifies every
     required key is present (catches a stale `.env` from before a feature that added a new
     required variable) and fails with a clear list of exactly what's missing, rather than
     letting Docker Compose fail opaquely three steps later. Existing values are never
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
- Demo logins: `superadmin@timesheet.local` / `Admin@12345` (also `manager@...`, `employee@...`)
- Platform admin: `<web-url>/platform-admin/login` — `platform-admin@timesphere.local` /
  `PlatformAdmin@12345` (**change this immediately** — it has cross-org access)
- **Configure real SMTP** (if you skipped it above) from **Workspace Settings → Mail server** —
  see [§ Configuring things after install](#configuring-things-after-install).

---

## Manual local install (no Docker)

Full walkthrough already lives in [README.md § Installation](../README.md#installation-local-no-docker)
— summarized here with the decision points called out:

**One-liner, once `.env` is filled in** (step 2 below is the only manual one — everything after
it is automated and self-healing):

```bash
npm run setup
```

Equivalent step-by-step, if you'd rather run each yourself or see what's happening:

1. `npm install` (builds `packages/shared` automatically via `postinstall`).
2. `cp .env.example apps/api/.env`, then fill in `DATABASE_URL`/`CONTROL_DATABASE_URL` (XAMPP
   default: `mysql://root:@localhost:3306/...`, empty password), three JWT secrets, and
   `ENCRYPTION_KEY` (`openssl rand -hex 32`).
3. Start MySQL (XAMPP Control Panel, or your own install).
4. **Run `npm run doctor:heal -w apps/api` before anything else.** This is the single
   highest-value step — validates `.env`, auto-creates both databases if they don't exist, and
   applies every pending migration. See [§ Self-diagnosis](#self-diagnosis-npm-run-doctor) below.
5. `npm run db:generate`
6. `npm run db:migrate` (redundant if you ran `doctor:heal` above — safe to run either way)
7. `npm run seed`
8. `npm run dev`

---

## Self-diagnosis: `npm run doctor`

```bash
npm run doctor -w apps/api
# or, to also auto-fix what it finds:
npm run doctor:heal -w apps/api
```

Run this **before** `db:migrate`/`dev` on any fresh checkout, and **first** whenever something
seems broken. It checks, in order, and stops at the first failure with a specific fix:

1. `.env` exists and passes the same Zod schema the server boots with.
2. `DATABASE_URL` and `CONTROL_DATABASE_URL` are actually reachable (real TCP connection, not
   just "is the string non-empty") — the #1 real-world failure is Docker Compose's MySQL port
   (`3307`) and a local/XAMPP MySQL port (`3306`) getting swapped.
3. The credentials in `DATABASE_URL` are actually accepted (a real `SELECT 1`).

The `:heal` variant runs two more steps instead of just stopping once the checks above pass:

4. Creates the `DATABASE_URL`/`CONTROL_DATABASE_URL` databases if the server's reachable but they
   don't exist yet (`CREATE DATABASE IF NOT EXISTS`).
5. Runs `prisma migrate deploy` for both the tenant and control-plane schemas.

It never modifies `.env` or connection settings — only DB-side state — and every step is
idempotent, so it's safe to run repeatedly (a CI step, a cron job, or just habit).

The installer's own self-heal check (missing `.env` keys) and `doctor`'s checks are
complementary: the installer catches "this `.env` is incomplete," `doctor` catches "this `.env`
is complete but wrong" (bad host, bad port, bad password), and `doctor:heal` goes one step
further and fixes the DB-side half of that automatically.

---

## Configuring things after install

Everything below is a UI action, not a code change or redeploy — this is the actual value of
the admin-configurable settings surfaces this app has:

| What | Where | Notes |
|---|---|---|
| Outbound email (SMTP) | Workspace Settings → **Mail server** | Overrides `.env`'s `SMTP_*` vars; leave blank to keep using `.env`. Live "Test connection" button. |
| Email templates (subject/body per event) | **Email templates** page (sidebar) | Edit any of the 20 built-in templates, preview with sample data, send a single test, or "Send all templates as test" to smoke-test every one at once. |
| AI provider/model/budget | Workspace Settings → **AI** | BYOK — Anthropic or any OpenAI-compatible endpoint. |
| Email-to-ticket intake | Workspace Settings → **Email intake** | IMAP mailbox + routing rules. |
| Chat-to-ticket (Slack/Teams/Google Chat/Telegram) | Workspace Settings → **Chat integrations** | Per-platform bot tokens + routing rules. |
| Security/CI findings ingestion (SAST/DAST/SSAT/SSCT) | Workspace Settings → **Security & DevOps** | Generate a bearer token, paste the webhook URL into your CI — see [docs/SECURITY_DEVOPS_INTEGRATIONS.md](SECURITY_DEVOPS_INTEGRATIONS.md) for GitHub Actions/GitLab CI/Jenkins/Bitbucket examples. |
| VAPT (pentest) report upload | Workspace Settings → **Security & DevOps → VAPT report upload** | Structured JSON only (not arbitrary PDF parsing) — paste/upload assessor + findings, optionally attach to a ticket by key. Lands in the same per-ticket Security tab as CI-ingested findings. |
| Repo/branch/PR reference on a ticket | Ticket detail sheet → **Dev** tab | Manual entry (repository, branch, PR URL, PR status) — not a live GitHub/GitLab OAuth sync; see [docs/ROADMAP.md](ROADMAP.md) for why that's a separate, larger scope of work. |
| Kanban grouped by manager / org-chart | Tickets → Kanban view ("Group by manager") · Team page | Reads the existing `User.managerId` reporting-line relation — no extra configuration needed. |
| Block resolve while CI is failing | Workspace Settings → **Ticketing** | Off by default; needs CI actually POSTing test runs to the Security & DevOps webhook to have any effect. |
| Public API keys & outbound webhooks | Workspace Settings → **Public API** | Generate a bearer key (READ or WRITE scope) or register a webhook URL — see [docs/API.md](API.md#public-api) for the endpoint/signature reference. |
| Live GitHub connection | Workspace Settings → **Security & DevOps → Git provider** | Bring your own GitHub OAuth App (client ID/secret) — set its callback URL to `<your-url>/api/git/callback`, then Connect. Once connected, generate a webhook secret from the same card and add a webhook (URL + secret shown there) to each repo you want auto-synced, for push/PR-driven `TicketBranch` updates and (opt-in) AI PR-review summaries. |
| SSO (Google/Microsoft/SAML/LDAP) | Workspace Settings → **Single sign-on** | Independent per-provider toggles. |
| Ticket types, labels, SLA hours | Workspace Settings → **Ticketing** | |
| Plan tiers, seat limits, AI budget ceilings | `/platform-admin` console | Cross-org, platform-admin-only. |
| User designation (job title) | Users page → create/edit form, or bulk-upload CSV's `designation` column | Free text, display-only — shown on the Users table and org chart. Has no effect on RBAC (that's the separate `role` field). |

None of these require a server restart — every one reads live from the database on the next
request.

---

## FAQ

**Do I need Docker?** No — see [Manual local install](#manual-local-install-no-docker). Docker
is the fastest path, not the only one.

**Can I use MySQL I already have running, instead of the one in Docker Compose?** Yes for the
manual install path — just point `DATABASE_URL`/`CONTROL_DATABASE_URL` at it. For the Docker
Compose path, either edit `docker-compose.yml` to remove the `mysql` service and point at your
external server, or use the manual install path instead.

**Can I skip SMTP entirely?** Yes. With no SMTP configured (neither `.env` nor the Mail server
settings page), emails are logged to the console and recorded as `FAILED` in `EmailLog` instead
of crashing anything — every feature that sends email still works, it just doesn't deliver.

**What if I already ran the installer once and want to change my SMTP credentials?** Don't
re-run the installer for this — it won't touch an existing `.env`. Instead use **Workspace
Settings → Mail server**, which takes effect immediately with no restart, or edit `apps/api/.env`
directly and restart the API.

**Is it safe to re-run `install.sh`/`install.ps1`?** Yes — it never overwrites an existing
`.env`, and re-seeding is an upsert (safe to run again; it won't create duplicate demo data).

**I get "Authentication failed against database server."** Your `DATABASE_URL` password doesn't
match your MySQL server's actual root password. Run `npm run doctor -w apps/api` — it will say
exactly this and tell you the XAMPP default (empty password).

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

**I get `ENCRYPTION_KEY must be a 64-character hex string`.** Generate one with
`openssl rand -hex 32` and set it in `apps/api/.env`. This key encrypts every stored secret
(SMTP password, IMAP password, BYOK AI keys, security-ingestion token) — there's no safe default
for it, on purpose.

**AI features show "No API key configured" even though I set one.** The master AI switch in
Workspace Settings → AI is a separate toggle from having a key — both need to be on/set.

**How do I add a new SAST/DAST tool that isn't in the examples doc?** You don't need TimeSphere
to know about your specific tool — translate its native output into the generic findings JSON
shape yourself (a `jq` one-liner in most cases) and `curl` it to the ingestion webhook. See
[docs/SECURITY_DEVOPS_INTEGRATIONS.md § 3](SECURITY_DEVOPS_INTEGRATIONS.md#3-per-ci-system-examples).

**How do I reset the platform-admin password?** There's no self-serve reset for that account
yet (by design — it's the highest-privilege account in the system). Update it directly in the
control-plane database (`PlatformAdminUser` table) with a freshly bcrypt-hashed password, or
re-run `npm run control:seed -w apps/api` against a fresh control database if you haven't put
real orgs on it yet.

**Where do I report a bug or request a feature?** See [docs/ROADMAP.md](ROADMAP.md) for what's
already planned — check there before filing something that's already tracked.

---

## Troubleshooting index

For symptom-specific fixes not covered above, see:
- [README.md § Troubleshooting](../README.md#troubleshooting) — build/env/port/login issues.
- [docs/DEPLOYMENT.md](DEPLOYMENT.md) — Docker Compose / Kubernetes-specific issues.
- [docs/SECURITY_DEVOPS_INTEGRATIONS.md § 6](SECURITY_DEVOPS_INTEGRATIONS.md#6-troubleshooting) — ingestion webhook 401/404/429s.

If none of those cover it, the fastest next step is almost always `npm run doctor -w apps/api`
(manual install) or checking `docker compose logs api` (Docker install) — both surface the
actual underlying error rather than a symptom two layers removed from the cause.
