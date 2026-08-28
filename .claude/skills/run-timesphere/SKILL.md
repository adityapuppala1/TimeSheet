---
name: run-timesphere
description: Run, launch, start, drive, or screenshot the TimeSphere app (Express API + Vite SPA) to see a change working in the real UI — sign in, open a route, screenshot it, read the DOM, open the notification bell, smoke the API. Use when asked to run the app, verify a change in the browser rather than in tests, take a screenshot of a page, or check what a page actually renders.
---

# Running TimeSphere

Two dev servers, one product: an Express API (`apps/api`, tsx watch, port **4000**) and a Vite SPA
(`apps/web`, port **5173**) against MySQL on **3306**. The agent-facing handle is
`.claude/skills/run-timesphere/driver.mjs` — a Playwright driver that signs in with the seeded
superadmin and gives you screenshots, DOM text, arbitrary page evaluation, and the notification
bell. All paths below are relative to the repo root.

## Prerequisites

Already satisfied on this machine, no install needed: Node 24, the repo's `node_modules` (which
includes `@playwright/test` with browsers), and MySQL listening on 3306 (XAMPP). The driver needs
nothing beyond those.

## Is it already up?

Check before launching anything — a second stack collides on both ports, and a second API also
starts the cron workers (reminders, escalations, scheduled report mail).

```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 4000,5173,3306 } |
  Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table -AutoSize
```

```bash
curl -s -o /dev/null -w "health:%{http_code}\n" http://localhost:4000/health
```

`health:200` plus listeners on 4000/5173 means skip the launch step and go straight to the driver.

## Launch

```powershell
npm run dev
```

Root `dev` fans out through `concurrently` into `npm run dev -w apps/api` (tsx watch
`src/server.ts`) and `npm run dev -w apps/web` (`vite --host 0.0.0.0`). **Honesty note:** the
instance used to verify everything in this skill was already running and was confirmed to have been
started by exactly this command (read off the live `Win32_Process` command lines) — the launch line
itself was not re-executed, because a second stack would have fought for the ports and started a
second set of cron workers. Wait for `health:200` from the curl above before driving.

The API hot-reloads on save (tsx watch) and Vite HMRs the SPA, so a code edit needs no restart.

## Drive it (agent path)

```powershell
node .claude/skills/run-timesphere/driver.mjs health
node .claude/skills/run-timesphere/driver.mjs shot /app/whats-new whats-new
node .claude/skills/run-timesphere/driver.mjs text /login 260
node .claude/skills/run-timesphere/driver.mjs eval /app/whats-new "document.querySelectorAll('svg').length"
node .claude/skills/run-timesphere/driver.mjs bell
```

| Command | What it does |
|---|---|
| `health` | No browser. `GET /health`, `/api/system/version`, and `/api/system/updates` — prints the running version, build sha, and every release the What's-new page can show. |
| `shot <route> [name]` | Signs in, opens the route, writes a full-page PNG to `test-results/run-shots/<name>.png`. |
| `text <route> [chars]` | Prints the page's `innerText` — the fastest way to assert copy actually rendered. |
| `eval <route> <expr>` | Evaluates a JS expression in the page and prints the JSON result. |
| `bell` | Opens the notification bell and prints the panel's contents plus the rows the app's own API call returned. |

### Looking at a PDF

```powershell
node .claude/skills/run-timesphere/pdf-shot.mjs c:/tmp/report.pdf report 3
```

Renders pages of a PDF to `test-results/run-shots/report-p1.png`… so an export can be **looked at**
rather than assumed correct. There is no poppler/ghostscript/ImageMagick on this machine, and
`pdf-parse` cannot read PDFKit's own output here, so this is the way to check a layout change.

Two traps it already works around, both of which silently produce a wrong screenshot rather than an
error: bundled headless Chromium **downloads** a PDF instead of rendering it (the viewer is a plugin
headless does not load — it uses real Chrome via `channel: "chrome"`), and `PageDown` never reaches
the embedded viewer, so every page came out as page 1 until it switched to the `#page=N` fragment
with an `about:blank` between loads.

It signs in automatically for `/app/*` routes and skips sign-in for public ones (`/login`,
`/shared/*`). Every command ends with a list of failed requests, or states there were none.

Env overrides: `TS_WEB` (default `https://localhost:5173`), `TS_API` (default
`http://localhost:4000`), `TS_USER` / `TS_PASS`, `TS_OUT` (default `test-results/run-shots`).
Seeded logins, all with password `Admin@12345` (from `tests/e2e/auth.setup.ts`):
`superadmin@timesheet.local`, `manager@timesheet.local`, `employee@timesheet.local`. Role-gated UI
is worth checking as the employee:

```powershell
$env:TS_USER = "employee@timesheet.local"; node .claude/skills/run-timesphere/driver.mjs shot /app/whats-new employee-view; Remove-Item Env:\TS_USER
```

**Look at the PNG you took.** A blank frame or a `/login` screen means sign-in failed, not that the
feature is broken.

## Platform-admin console flows (agent path)

```powershell
node .claude/skills/run-timesphere/platform-admin-verify.mjs
```

Drives the console end to end against the running stack: creates a throwaway platform admin on
the seeded password, proves the amber banner (and that it survives a reload), rotates the
password (seeded value refused, other sessions revoked), runs **Rescue admin** on the default
workspace, signs in on the tenant side with the one-time password, restores the owner's original
password through the real change-password route, and deletes the throwaway. Nine numbered steps,
`ok`/`FAIL` per assertion, screenshots `pa-*.png` under `test-results/run-shots/`.

**It targets the default workspace by slug, deliberately.** Every ACTIVE org row has the Rescue
button and the list is newest-first; a `.first()` here once reset a fixture super admin in
`acme_corp` instead, which had to be repaired by SQL. If the script dies mid-way it prints the two
recovery lines first.

## Human path

`npm run dev`, then open `https://localhost:5173` and accept the self-signed certificate warning.
Same servers the driver talks to.

## Checks

```powershell
npm run lint
```
Runs `tsc --noEmit` for `apps/api`, `tsc -b --noEmit` for `apps/web`, then `eslint` with the
SonarJS rule set over both plus `packages/shared`. **Exit 0 with ~400 warnings is success** — the
structural style rules are warnings on purpose (see `eslint.config.mjs`); only errors fail. Do not
"fix" the warning count.

```powershell
cd apps\api; npx vitest run
```
85 files / 999 tests in about 13 seconds. This is the fast unit gate — it stubs Prisma and never
touches the running app.

The heavier `tests/e2e` Playwright suite exists and is configured `workers: 1` /
`fullyParallel: false`, because every spec shares the one seeded MySQL database. It was not run
while writing this skill, so treat its runtime and pass rate as unknown.

Editing `install.ps1` / `update.ps1`? Parse them without executing, and confirm the UTF-8 BOM
survived — these files are BOM-prefixed and PowerShell cares:

```powershell
$errs = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path update.ps1).Path, [ref]$null, [ref]$errs) | Out-Null
if ($errs) { $errs | ForEach-Object { $_.Message } } else { "parses clean" }
(( [System.IO.File]::ReadAllBytes((Resolve-Path update.ps1).Path)[0..2] | ForEach-Object { $_.ToString('x2') }) -join ' ')
```
Expect `parses clean` and `ef bb bf`.

## Gotchas

- **The dev server is HTTPS, not HTTP.** Certificates in `apps/web/certs/` flip Vite to HTTPS-only,
  so `http://localhost:5173` answers `ERR_EMPTY_RESPONSE`. Use `https://` and accept the
  self-signed cert (the driver passes `ignoreHTTPSErrors`). The API on 4000 stays plain HTTP.
- **A driver script must live inside the repo.** Node resolves `@playwright/test` by walking up
  from the *script's* directory, not the cwd, so the same file in `%TEMP%` dies with
  `ERR_MODULE_NOT_FOUND`. That is why this driver sits in the skill directory.
- **`/api/notifications` answers 401 even from a signed-in page.** The SPA keeps its access token in
  memory and sends it as a header — Playwright's `page.request` carries cookies only. Read the bell
  through the UI, or listen for the response the app itself makes. If you listen, attach the
  handler **before** the first navigation: React Query fetches notifications during the initial
  `/app` load and serves the panel from cache afterwards, so a later listener sees nothing.
- **`401 POST /api/auth/refresh` and `401 POST /api/platform-admin/auth/refresh` fire on every cold
  load.** They are the pre-sign-in bootstrap attempts and are not failures; the driver filters them
  out and reports everything else.
- **`/app/dashboard` is not a route.** The dashboard is where `/app` lands after sign-in. Navigating
  to the invented path renders a page with no top bar, which is why the `bell` command deliberately
  stays wherever sign-in dropped it.
- **Do not reuse `tests/e2e/.auth/*.json` storage state.** Every `/app` load rotates the session
  secret and the grace window forgives only the immediately-previous one, so a stored snapshot goes
  stale and lands you on `/login` (the reasoning is written out at the top of
  `tests/e2e/auth.setup.ts`). The driver signs in fresh each run; successful logins are skipped by
  the rate limiter, so this is free.
- **Screenshots belong under `test-results/`.** It is gitignored (`.gitignore`), so driver output
  never shows up in `git status`.
- **A hook blocks `Grep` until you query the knowledge graph.** This repo carries
  `graphify-out/graph.json` and a `PreToolUse` hook that requires
  `python -m graphify query "<question>"` first. The `graphify` console script is not on PATH on
  this machine — always `python -m graphify`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `page.goto: net::ERR_EMPTY_RESPONSE` at `http://localhost:5173` | Use `https://localhost:5173`. The dev server is HTTPS-only. |
| `ERR_MODULE_NOT_FOUND: Cannot find package '@playwright/test'` | The script is outside the repo. Run it from `.claude/skills/run-timesphere/`, or any path under the repo root. |
| `locator.click: Timeout` waiting for the bell button | You navigated to a route without the `/app` shell top bar. Sign in and stay on the landing page. |
| `bell rows from the API response: 0` | The response listener was attached after the initial fetch; the panel text is still accurate. |
| Driver lands on `/login` and the screenshot shows the sign-in form | Wrong `TS_USER`/`TS_PASS`, or the API is down — run `driver.mjs health` first. |
| `health:000` / connection refused on 4000 | The API is not running. `npm run dev` and wait for `health:200`. |
