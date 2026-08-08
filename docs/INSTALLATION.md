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
| bash: `install.sh: Permission denied` | The file isn't marked executable — normal for a fresh checkout on some setups. | `chmod +x install.sh`, then `./install.sh` again. |
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
   - If `.env` doesn't exist yet, you're prompted for three values (web URL, API URL — both
     default to `localhost` for a trial run — and the **reverse-proxy hop count**, see below)
     and then, **optionally**, your outbound SMTP
     details (host/port/user/password/TLS) — type `N` to skip and configure email later from
     the UI. The password prompt hides your input as you type. Every other secret (DB
     password, JWT signing keys, encryption key) is generated for you with cryptographically
     strong randomness — you never have to think about them.
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
- Demo logins: `superadmin@timesheet.local` / `Admin@12345` (also `manager@...`, `employee@...`)
- Platform admin: `<web-url>/platform-admin/login` — `platform-admin@timesphere.local` /
  `PlatformAdmin@12345` (**change this immediately** — it has cross-org access)
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
- **Non-interactive mode**: `TS_AUTO=1 ./install.sh` (or `$env:TS_AUTO="1"` on Windows) accepts
  every default — bundled Docker MySQL, localhost URLs, no SMTP. CI executes exactly this on
  every PR, so installer rot is caught in review rather than by a customer.

Updating later is one command — see docs/DEPLOYMENT.md's "Updating a running deployment".

**Upgrading to 2.3.0 specifically** is an ordinary `./update.sh` (Windows: `.\update.cmd`). It
carries **one** migration, `20260808120000_mcp_server`, which only creates the two new MCP tables —
additive, no backfill, nothing dropped or narrowed, so the updater's code-only auto-rollback still
holds. It introduces **no new environment variable** in any deployment shape, so there is nothing
to add to `.env`, either compose file, or the Helm chart. And because the updater's fan-out step
runs `npm run migrate:tenants` unconditionally, that migration reaches every organization's
database, not just the default one. Details:
[docs/DEPLOYMENT.md § What 2.3.0 adds to that dance](DEPLOYMENT.md#what-230-adds-to-that-dance-the-mcp-server).

## Manual local install (no Docker)

Full walkthrough already lives in [README.md § Installation](../README.md#installation-local-no-docker)
— summarized here with the decision points called out:

**One command, from a clean clone** — start MySQL first, then:

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
physical database that `doctor:heal` never touches, and running new code against its old schema is
the one drift the additive-only migration policy cannot excuse. Same command, same reasoning as
`update.sh` on a deployed stack — see
[docs/DEPLOYMENT.md § Keeping every tenant's schema current](DEPLOYMENT.md#keeping-every-tenants-schema-current).

Two things it deliberately does *not* do. It never overwrites an `apps/api/.env` you already have,
and it never regenerates a certificate you have already trusted on your devices — both would
destroy something you cannot get back. What it does instead, on an *upgrade*, is **list any
variable that has been added to `.env.example` since your `.env` was written**, so a new feature
looks unconfigured rather than broken. Append them (commented out) with `npm run bootstrap:sync`.

If the placeholder `DATABASE_URL` doesn't match this machine, `setup` stops at the `doctor:heal`
step and names the problem — see [§ Self-diagnosis](#self-diagnosis-npm-run-doctor) below. Fix
`apps/api/.env` and re-run `npm run setup`; it picks up where it left off.

Equivalent step-by-step, if you'd rather run each yourself or see what's happening:

1. `npm install` (builds `packages/shared` automatically via `postinstall`).
2. `npm run bootstrap` (copies `.env.example` → `apps/api/.env` and mints dev certificates), then
   fill in `DATABASE_URL`/`CONTROL_DATABASE_URL` (XAMPP default: `mysql://root:@localhost:3306/...`,
   empty password), three JWT secrets, and `ENCRYPTION_KEY` (`openssl rand -hex 32`).
3. Start MySQL (XAMPP Control Panel, or your own install).
4. **Run `npm run doctor:heal -w apps/api` before anything else.** This is the single
   highest-value step — validates `.env`, auto-creates both databases if they don't exist, and
   applies every pending migration. See [§ Self-diagnosis](#self-diagnosis-npm-run-doctor) below.
5. `npm run db:generate`
6. `npm run db:migrate` (redundant if you ran `doctor:heal` above — safe to run either way)
7. `npm run seed`
8. `npm run db:migrate:tenants` (a no-op unless you have provisioned a second organization — see
   above)
9. `npm run dev`

---

## Self-diagnosis: `npm run doctor`

```bash
npm run doctor -w apps/api          # diagnose only — never writes anything
npm run doctor:heal -w apps/api     # + create the databases and run migrations
npm run doctor:fix-env -w apps/api  # + also correct a wrong host:port in .env (see below)
```

Run this **before** `db:migrate`/`dev` on any fresh checkout, and **first** whenever something
seems broken. It checks, in order, and stops at the first failure with a specific fix:

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
   certificate rather than a setting in this product — see **Serving over HTTPS** in
   [DEPLOYMENT.md](DEPLOYMENT.md), which covers a public domain, a LAN with no domain, and quick
   phone testing.

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

The `:heal` variant runs two more steps once the checks above pass:

7. Creates the `DATABASE_URL`/`CONTROL_DATABASE_URL` databases if the server's reachable but they
   don't exist yet (`CREATE DATABASE IF NOT EXISTS`).
8. Runs `prisma migrate deploy` for both the tenant and control-plane schemas.

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
| Email templates (subject/body per event) | **Email templates** page (sidebar) | Edit any of the 20 built-in templates, preview with sample data, send a single test, or "Send all templates as test" to smoke-test every one at once. Also shows per-template send volume, the success/failure split, and a grouped failure breakdown read from `EmailLog`. |
| Which roles get which emails | Workspace Settings → **Email channels** | A category × role grid: every gateable email category is a row, grouped into Timesheets / Tickets / Digests / Identity / Workspace. Unticking a cell suppresses only the **email** leg for that role — the in-app bell notification always fires, so muting Manager on an escalation removes the inbox copy without hiding the escalation. `welcome`, `reset`, and the email-intake auto-reply are listed as **Always sent** and deliberately have no row: they go to one person as a direct result of an action, and a role filter over a password reset is an account lockout waiting to happen. |
| AI provider/model/budget | Workspace Settings → **AI** | BYOK — Anthropic or any OpenAI-compatible endpoint. |
| Email-to-ticket intake | Workspace Settings → **Email intake** | IMAP mailbox + routing rules. |
| Chat-to-ticket (Slack/Teams/Google Chat/Telegram) | Workspace Settings → **Chat integrations** | Per-platform bot tokens + routing rules. |
| Security/CI findings ingestion (SAST/DAST/SSAT/SSCT) | Workspace Settings → **Security & DevOps** | Generate a bearer token, paste the webhook URL into your CI — see [docs/SECURITY_DEVOPS_INTEGRATIONS.md](SECURITY_DEVOPS_INTEGRATIONS.md) for GitHub Actions/GitLab CI/Jenkins/Bitbucket examples. |
| VAPT (pentest) report upload | Workspace Settings → **Security & DevOps → VAPT report upload** | Structured JSON only (not arbitrary PDF parsing) — paste/upload assessor + findings, optionally attach to a ticket by key. Lands in the same per-ticket Security tab as CI-ingested findings. |
| Repo/branch/PR reference on a ticket | Ticket detail sheet → **Dev** tab | Manual entry (repository, branch, PR URL, PR status) — not a live GitHub/GitLab OAuth sync; see [docs/ROADMAP.md](ROADMAP.md) for why that's a separate, larger scope of work. |
| Kanban grouped by manager / org-chart | Tickets → Kanban view ("Group by manager") · Team page | Reads the existing `User.managerId` reporting-line relation — no extra configuration needed. |
| Block resolve while CI is failing | Workspace Settings → **Ticketing** | Off by default; needs CI actually POSTing test runs to the Security & DevOps webhook to have any effect. |
| Public API keys & outbound webhooks | Workspace Settings → **Public API** | Generate a bearer key (READ or WRITE scope) or register a webhook URL — see [docs/API.md](API.md#public-api) for the endpoint/signature reference. |
| MCP server (connect an AI assistant to this workspace) | Workspace Settings → **MCP server** | **Off by default, and off after an upgrade** — new in 2.3.0. Turn on the server, then issue a credential **bound to one user**: every tool runs with exactly that person's permissions, and the token is shown once. Write tools need the workspace write latch *and* their own per-tool switch, both off initially. Read [docs/DEPLOYMENT.md § Operating the MCP server](DEPLOYMENT.md#operating-the-mcp-server) before enabling — this is an authenticated endpoint that lets an external LLM client read (and, if you allow writes, act on) this workspace as that user. Endpoint reference: [docs/API.md](API.md#mcp-server). |
| AI refine ("tidy this up" beside a field) | Workspace Settings → **AI** | Nothing of its own to configure — it rides the existing AI master switch, the **writing assistant** toggle and the same monthly budget. Off wherever AI is off, and the button says which. |
| Live GitHub connection | Workspace Settings → **Security & DevOps → Git provider** | Bring your own GitHub OAuth App (client ID/secret) — set its callback URL to `<your-url>/api/git/callback`, then Connect. Once connected, generate a webhook secret from the same card and add a webhook (URL + secret shown there) to each repo you want auto-synced, for push/PR-driven `TicketBranch` updates and (opt-in) AI PR-review summaries. |
| Face (identity) verification | Workspace Settings → **Face verification** | Off by default. Master switch, per-action scope, match/liveness thresholds, retention window, consent wording, plus the review log of every attempt. Per-user opt-in lives on Users → edit → *Require face verification*. Employees enroll from their own Profile. Needs **HTTPS** (browsers only expose a camera on a secure origin). Collects biometric data — read [docs/FACE_VERIFICATION.md](FACE_VERIFICATION.md) first. |
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
- [docs/SECURITY_DEVOPS_INTEGRATIONS.md § 7](SECURITY_DEVOPS_INTEGRATIONS.md#7-troubleshooting) — ingestion webhook 401/404/429s.

If none of those cover it, the fastest next step is almost always `npm run doctor -w apps/api`
(manual install) or checking `docker compose logs api` (Docker install) — both surface the
actual underlying error rather than a symptom two layers removed from the cause.
