# Changelog

All notable changes to TimeSphere, newest first. Each version corresponds to a git tag `vX.Y.Z`
and a GitHub Release whose body is copied from the matching section here — the release process is
documented in CONTRIBUTING.md, and the in-app **What's new** page renders these notes for every
user of a running installation.

## Unreleased

The parser that feeds the in-app What's-new page ignores this section until it gains a version
number, on purpose — an installation must never render history for a version that does not exist yet.

### 🩺 AI providers now show whether they're actually working, and can route around each other

- **A live status dot on every configured provider** — Healthy, Degraded, Down, or "no recent
  data" — derived from its real traffic over the last 15 minutes, refreshed every time the AI
  settings tab loads. Plus a **Test** button per row for an on-demand, free connectivity check
  (a models-list call, no completion tokens) that answers in seconds instead of waiting on a real
  generation call.
- **An opt-in circuit breaker.** Turn on "Automatically move a failing provider to the back of the
  line" and three failed calls in a row demote that provider on their own — no downtime waiting
  for someone to notice and reorder it by hand. It only ever demotes, never auto-promotes back up
  (that stays a manual reorder, or a fresh Suggest order) — no flapping between two flaky
  providers. Every automatic move is logged in the audit trail and marked "Auto-demoted" in the
  list, so it's never mistaken for a choice an admin made.
- **Mechanical AI tasks now prefer the cheapest healthy provider**, not just the admin's fixed
  first choice — triage, duplicate detection, and the other tasks that already downgrade to a
  cheaper model do the same across providers now, while narrative/judgment features keep the
  admin's exact order untouched. Reuses the cost and health data the app already tracks; nothing
  new to configure.
- Fixed along the way: a stale legacy field could leak into a live call's requested model whenever
  the top-priority provider changed — reordering or adding a provider could 404 the very next call
  by asking the new primary for a model name from a different vendor's catalogue. Every capability
  now sees the provider that will actually run, not the frozen field the ranked list replaced.

### 📝 Requirements Studio — an AI interview that turns an idea into a PRD/BRD, then real work

- **A new AI-guided interview** (Workspace nav → Plan → Requirements Studio) asks one question at
  a time about a project idea — problem, users, scope, features, tech stack, dependencies, UI/UX,
  architecture, modules, non-functional requirements, timeline, risks, success metrics — with
  quick-reply suggestions and a "skip — assume and flag it" option so the interview never stalls.
  Anything left uncovered becomes a stated **assumption** in the finished document, never a silent
  guess.
- **Generates a real structured document**, not just prose: a navigable section-by-section view,
  including an AI-drawn architecture diagram (rendered live via Mermaid) — and exports to **PDF**
  and **Markdown**.
- **Turns the document into real work, reviewed at every step**: "Create project from this
  document" prefills the existing New Project form; "Propose tickets" turns every feature into a
  draft change set reviewed and accepted row-by-row in Proposals — the same trusted pipeline
  `plan_breakdown` already uses; "Create goals" turns success metrics into goals after a one-screen
  confirm. Nothing is ever created silently.
- A document can exist before any project does — start from just an idea, and decide what becomes
  real afterward.

### 🔀 A ranked list of AI providers, tried in order, with a fallback that actually works

- **Workspace Settings → AI now manages a LIST of providers, not one.** Add as many as you like —
  Anthropic, Groq, Mistral, a self-hosted Ollama, any OpenAI-compatible endpoint — each with its
  own key, model, and on/off switch, reordered with simple ↑/↓ controls. Every AI feature calls the
  top ENABLED provider; on a rejected key, a rate limit, or an empty answer, it falls through to
  the next one automatically, using that provider's own configured model (a fallback is unlikely to
  serve a model by the primary's name at all, so only the primary's requested model is ever
  honored). An existing single-provider setup is carried forward unchanged as priority 0 on
  upgrade — nothing about how AI features behave changes until a second provider is actually added.
- **Fixed along the way: an Anthropic key rejection failed as a bare, unexplained 500** — the same
  bug already fixed for OpenAI-compatible providers below, but the native Anthropic path had never
  been covered. Both providers' SDK errors now translate into the same clear, actionable message,
  which is also what makes the fallback above possible: the dispatcher needs to tell "this
  provider is unavailable, try the next one" apart from "this is a real bug" for both providers, not
  just one.

### 🎯 A data-driven "Suggest order" for the AI provider list, and the failure data it needs to work

- **A rejected call is now logged too, not just a successful one.** `callChat`'s fallback loop used
  to release its budget reservation and rethrow silently on every failed attempt — a provider that
  was down, rate-limited, or holding a bad key left no trace at all, so there was no way to answer
  "which provider actually performs best" from the data. Every attempt is now written to
  `AIUsageLog` (`success`, `errorReason`), whether it succeeded or not.
- **The usage table and Excel export both gained a Success rate column**, and the AI tab's stat
  tiles gained a Success rate tile (with a failed-attempts count when there are any) — visible
  right alongside cost and tokens, not a separate report.
- **"Suggest order" in Workspace Settings → AI** ranks the current provider list by its own last-30-
  day performance — success rate first, then latency, then cost — and shows the reasoning behind
  the ranking inline, never applying it on its own. Reviewing and pressing Apply reorders the list
  exactly like a manual ↑/↓ would; a provider with no calls yet is placed last rather than
  competing on no evidence.
- **New Playwright coverage for the provider list** (add / reorder / remove), the first e2e test
  for this V9 feature — it had zero UI coverage until now.

### 📊 The AI usage panel is one sortable table now, not four disconnected charts

- **A single filterable, sortable table** — Provider, Model, Calls, Input/Output/Total tokens, Avg
  latency, Cost, % of total — replaces what used to be four separate "Spend by model" / "Spend by
  provider" / "Provider × model" / "By feature" blocks that could never be sorted, filtered, or
  compared against each other. A date-range picker (default: this month) and a feature filter sit
  above it; the trend chart below is now stacked by provider instead of a flat cost line.
- **Every AI call's provider and duration are now recorded** (`AIUsageLog.provider`,
  `AIUsageLog.durationMs`) — a workspace on BYOK with several vendors configured over time
  previously had no way to see which provider actually served a call, or how fast it was. Calls
  logged before this shipped show **Unknown** / "not measured" rather than a guess — guessing the
  current provider onto historical rows would misattribute past spend the first time a workspace
  ever switches.
- **Export to Excel**, from the same table's toolbar — a Summary sheet, a provider×model Usage
  sheet, and a day×feature×provider×model Daily detail sheet, all three built from one query so
  they can never disagree about what's included.

### 🩹 Fixes

- **The setup checklist stopped asking about goals it already knew were off.** Its "write your first
  goal" probe called `GET /api/goals` for every super admin on every dashboard load, regardless of
  whether the workspace had goals turned on — and that route 403s by design when they're off (the
  default) or not in the plan tier. Harmless, since the missing data just meant the suggestion never
  appeared, but it put a 403 in the console on most dashboards. It now checks the same
  `effective.goals` flag the sidebar already reads before deciding what to show, and only asks when
  the answer isn't already known to be no.
- **A rejected AI provider key failed as a bare, unexplained 500.** `callOpenAICompatible` let the
  OpenAI SDK's own error (401/403/429, whatever the vendor answered) fall straight through as an
  uncaught exception, so a revoked or scoped-wrong key surfaced as an opaque server error with
  nothing to act on. Now translated into a clear message naming the status and pointing at
  Workspace Settings → AI.
- **Switching the AI provider dropdown silently kept using the previous provider's key**, since
  changing providers only ever updated `provider`/`baseUrl` — the stored key never moved with it,
  so every call after a switch 403'd until someone noticed and re-entered a key by hand with no clue
  why. Moot now that each provider in the new ranked list carries its own key.
- **The Workflow Studio canvas's dot-grid background was rendering as a flat fill.** Its
  `theme(colors.muted-foreground/0.18)` arbitrary value asked Tailwind for an opacity modifier on a
  color the config never gave one — silently dropped, with a build-time warning nobody was
  watching for. Written as raw `hsl(var(--muted-foreground)/0.18)` instead, matching how the rest
  of this codebase already applies opacity to that token.

## 3.3.0 — the week you can read, and a workspace that installs itself — 2026-08-25

Scheduled email that reaches the people it is about, a dashboard that answers rather than pads, and
an upgrade that no longer needs you to remember a command.

### 🐛 Friday's reminder arrived on Monday

Reported as "some users are not receiving mails on Friday — they arrive Monday morning instead." It
was not the mail queue and not a failed send.

`daily-reminder.worker.ts` asked two questions with `now.getDay()` and `now.getHours()` — **the
server's** clock. The server defaults to `Asia/Kolkata` while `User.timezone` is populated per
person, and IST is far enough ahead that the two disagree for most of a western Friday afternoon:

| New York | on an IST server |
| --- | --- |
| Fri 14:00 | Fri 23:30 — sent |
| Fri 15:00 | **Sat 00:30** — dropped by the weekend filter |
| Fri 17:00 | **Sat 02:30** — dropped |

`remindOnWeekdaysOnly` then suppressed the whole tick, and the next tick that is not a weekend *on
the server* is Monday. The escalation notice the dashboard shows — "file today's entry before 5 PM"
— sits squarely inside that dead zone, which is why it was the one people noticed.

Every clock question is now asked in the **recipient's** timezone (`utils/recipient-time.ts`, using
the platform's own IANA data), and the hour and weekday gates moved inside the per-user loop.
"Already told them today" is measured from the start of *their* day, because a recipient far enough
west shares one server-day with two of their own and the second was being swallowed as a duplicate.
The mirror case is fixed too: Auckland is 6.5h ahead, so their Saturday 06:00 is still Friday to the
server and a reminder would have landed in their weekend.

**A second bug found while in there:** `lastFiredHour` was module state, and the reminder tick runs
through `runForEveryOrg`, which loops tenants sequentially in one process. The first org set the
flag and every org after it returned immediately — in a multi-tenant deployment exactly one
workspace received daily reminders and the rest silently received none. Deleted rather than made
per-org, because the real guard was always the database.

### 📊 The weekly digest now reaches managers and admins

"The weekly dashboard is not going to Super Admin and Manager." Two separate causes.

**The activity gate excluded the people it exists to inform.** The digest skipped any recipient with
no tickets and no hours *of their own* — right for an employee, since a recap of nothing reads as
spam, but a super admin or a line manager who manages rather than logs time has no personal activity
by definition. They were filtered out before the workspace and team tables were ever built.

**There was no manager view at all.** Scope was binary: hold `reports:view` and see every person, or
hold nothing and see only yourself. A line manager with five reports got a personal recap and no way
to answer "did my team file their time?".

Scope is now **SELF / TEAM / WORKSPACE**, and the levels accumulate — a super admin who also
line-manages gets their own week, then their team, then the workspace, because a twelve-row
workspace table does not answer "did *my* people file". Resolved from what somebody holds and what
they manage, never from a role name.

The team section leads with the number a manager acts on: how many reports filed at all, as a ratio
rather than a percentage (with five people a percentage is false precision), and a report who logged
nothing is marked on its row rather than left as a `0.0h` to be scanned past.

**Change-management figures** join hours and tickets throughout — raised and closed, per person and
workspace-wide. `CANCELLED` and `REJECTED` do **not** count as closed: a change that never happened
is not delivered work, and rolling them in would flatter the number every time a plan is abandoned.

Both Monday digests moved to **10:00** and **10:30**.

### 🔐 The security digest no longer depends on an LLM to send at all

The whole send was gated on the model: if `generateSecurityWeeklyDigest` threw or came back empty
the worker returned early, so an unconfigured, slow or too-small model produced **no security
digest** — not a degraded one. No open-finding count, no risk score, no SLA breaches, nothing. The
per-user digest had this corrected long ago; the security one kept it, on the report where a silent
week is most expensive, because silence is indistinguishable from a clean week.

The figures are counted from the workspace's own findings and always send; the summary is a
paragraph on top of them. It also gains the table it never had — severity mix in fixed
CRITICAL-first order (sorting by count buries CRITICAL under LOW), week-over-week movement with the
risk delta explicitly signed, the repositories carrying the most open findings, and SLA breaches
named for what they are.

### 🎨 A loader, and a dashboard that fills its own space

- **The app has a loading state.** Lazy routes fell back to grey skeleton bars matching no page, so
  every transition flashed one layout on its way to a different one. It is now the React Bits
  **Strands** animation with a line of text — one loader, shown both while the session hydrates and
  while a route resolves, so a refresh no longer shows two different things in a row.
- **"This week" no longer pads itself with 200px of nothing.** It is the shortest of the three hero
  cards and stretched to fill the row. It now carries weekdays logged, average per logged day,
  busiest day, and a project breakdown — the question neither neighbour answers (the status list
  says what *state* the time is in, the chart says which *day*, neither says what it was spent
  *on*). All computed from rows already on the client.
- **Every notice on the dashboard can be closed**, and the close button is now visible — at
  `opacity-60` with no background it was a pale-blue X on a pale-blue banner. A dismissal is consent
  to hide *this* message, not this *kind* of message: it lapses when the situation changes, so the
  escalation notice cleared on Tuesday returns on Friday when a different day has been missed.

### 🔀 The Workflow Studio canvas, rebuilt around n8n's shape

A trigger start node, left-to-right flow, curved connectors between input and output handles, node
cards with a coloured icon per kind, and wheel zoom. Both authoring experiences stay and the choice
now sticks — the toggle is labelled **Form / Canvas** with a hint on each, and the last pick becomes
the default next time.

Dragging still **reorders** rather than drawing an edge: the steps *are* the sequence and the
authority calculation depends on their order, so storing edges as well would give two sources of
truth for one fact. That is the one place the metaphor bends to this engine, and it bends
deliberately.

### 🩹 Smaller fixes

- **Clicking an existing change on the calendar opened the new-entry dialog.** The day lane is a
  button that raises a change for that day, and the bars sit on top of it without stopping their
  click from bubbling — so both handlers fired and "new change" won. Both features now work: click
  empty space to raise one, click a bar to open it. The calendar also gains **Back to changes** and
  **New change**, and a day can be clicked to raise a change already scheduled for it.
- **The org chart reaches everyone**, without a second page. `/app/team` is now open to all: an
  approver gets the queue, SLA metrics and reports roll-up; everybody else gets the org chart alone,
  and the nav item names itself accordingly. The endpoint already self-scoped to the caller's own
  reporting subtree.
- **Insights and Security insights are open to every member**, front end and API. Stated plainly
  because it is a data-governance choice: the workspace's security findings, SBOM and cost figures
  are now visible to all staff. Each broadened endpoint carries a comment, so dialling any of them
  back is a one-line change.
- **A guaranteed-401 request on every page load is gone.** `POST /platform-admin/auth/refresh` fired
  for every visitor; a tenant user has no such cookie, so it could only ever fail. It is now
  attempted only when this browser has held a platform-admin session or the visitor deep-linked into
  the console.
- **The loader no longer takes the page down on a machine with no WebGL.** Its own header claimed
  "it never throws" while nothing caught anything — and on a GPU-less CI runner the WebGL request
  threw straight through React Router's error boundary, so `/login` never rendered. Guarded, and the
  animation now waits 250ms before starting, so a fast route transition never touches the GPU.

### 🔧 Pull, run, and it fixes itself

`npm run dev` and `npm run build` now check that `node_modules` matches `package-lock.json` first,
and install automatically when it does not. Pulling a release that added a dependency used to fail
with `Cannot find package '…'` — a stack trace deep inside Vite naming a package the reader never
heard of, which never says "run npm install". This release adds `ogl` (the loader animation), so it
would have reproduced it.

Silent when the tree is healthy (one `stat`, no output), and it never fails the command — offline or
behind a registry that is briefly down, you get a warning and the app still starts. `npm ci` is
deliberately not used: CI calls that itself, and it would delete and rebuild `node_modules` for a
developer who pulled one new package.

**Nothing else changes about installing or upgrading.** `npm run setup`, `install.sh` /
`install.ps1`, `update.sh` / `update.ps1`, the Compose files and the Helm chart are unchanged and
need no new step.

## 3.2.0 — the requests this server makes on your behalf — 2026-08-24

A security pass over the places where TimeSphere acts as a *client* rather than a server, plus the
one browser origin that had never been anybody's responsibility. Nothing here changes how the app is
used; two things change how it is configured, and both are called out below.

### 🔐 An admin-typed URL can no longer point at your own network

Four features let a workspace admin enter a URL that the **server** then fetches: outbound webhooks,
the Google Chat incoming webhook, the Bot Framework reply endpoint, and the BYOK OpenAI-compatible
base URL. All four accepted anything `new URL()` parses, and three were guarded only by
`z.string().url()` — which is perfectly happy with
`http://169.254.169.254/latest/meta-data/iam/security-credentials/`, the cloud metadata service that
hands IAM credentials to anything that asks. The BYOK base URL had no URL validation at all.

That matters because the API sits *inside* the deployment's trusted network, and in the hosted
product a workspace admin is a **customer**, not the operator. Two of the four made it worse by
returning the result: the AI model-list preview hands back the fetched body or the remote error text,
and the webhook test and retry routes hand back `http_<status>` — a readable internal port scanner
rather than a one-way probe.

- **One choke point, not four patches.** `utils/egress.ts` refuses non-HTTP(S) schemes, URLs with
  embedded credentials, and any target in private, loopback, link-local, CGNAT or reserved space.
- **DNS is resolved, and every returned address must be public.** A hostname's text proves nothing:
  `internal.example.com` with an `A` record of `127.0.0.1` passes any string check. A name that
  resolves to one public and one private address is refused, because which one `fetch` picks is not
  ours to decide.
- **Checked again at every delivery, not just at save.** A target that was legitimate when it was
  saved can resolve somewhere private later; validating once would trust a DNS record indefinitely.
- **A refused webhook says so.** The delivery reports `blocked` with the reason on the webhook row
  rather than failing silently — and a bad URL is now refused on the settings form, with a message
  naming the problem, instead of being accepted and never working.
- A known bound, stated rather than implied: a DNS-rebinding window remains between the check and
  the socket. Closing it needs a pinned-IP agent, which is a larger change than this pass.

### 🔐 The bot token stops being handed to whoever asks

`sendTeamsMessage` posted to a URL taken from the inbound Teams activity body, with an app-only AAD
token for the workspace's bot in the `Authorization` header. The inbound token *is* verified
properly — signature against Microsoft's JWKS, issuer, and `aud` equal to this org's app id — but
that signature covers the **token**, not the **body** it arrived with, and a Bot Framework JWT is a
bearer token valid for about an hour. A replayed token with a rewritten `serviceUrl` therefore
authenticated and redirected the credential. Microsoft's own guidance asks for this check.

The reply target is now validated against the hosts Microsoft actually operates, **before** the token
is minted — there is no reason to ask Azure for a credential we have already decided not to send. The
allow-list is a mix of exact hosts and narrow suffixes rather than the tidier suffix-only list it
started as, because Teams' commercial cloud uses `smba.trafficmanager.net`, and `trafficmanager.net`
is shared Azure infrastructure where any subscriber can claim a label.

### 🔒 The app's own pages now carry security headers

`helmet()` was correctly configured on the API — which is what made this easy to miss, because the
API returns JSON. The HTML document that actually runs the bundle is served off disk by the web
container's nginx, which attached nothing: no CSP, no `X-Frame-Options`, no `Referrer-Policy`, no
`Permissions-Policy`. The policy existed only on responses no browser renders.

- **`frame-ancestors 'none'`** (plus `X-Frame-Options` for older browsers). The approve, reject and
  change-decision controls are one-click and irreversible, which is exactly what a clickjacking
  overlay aims at.
- **`Referrer-Policy: strict-origin-when-cross-origin`**, which directly protects the signed,
  expiring `/uploads` links — those URLs *are* the authorisation to read an attachment.
- `X-Content-Type-Options`, `Cross-Origin-Opener-Policy`, and a `Permissions-Policy` that denies
  everything except the camera face verification needs.
- **HSTS is set on Caddy, not nginx**, with `includeSubDomains` (every tenant is a subdomain) and
  deliberately without `preload`. There is no `upgrade-insecure-requests`: this repo supports
  plain-HTTP LAN deployments on purpose, and both would break them.
- Scoped to the static half only. At server level these would also stamp the proxied `/api` responses
  that already carry helmet's own, and two CSP headers on one response is not additive — the browser
  enforces the *intersection*.

### 🔐 Public API keys can expire

`ApiKey` had `revokedAt` but no `expiresAt`, so a key was valid forever unless somebody remembered to
revoke it — the credential nobody revisits, pasted into a customer's Zapier account or a cron script.
`McpCredential` already had this column for the same reason; this closes the inconsistency.

Workspace Settings → Public API now offers 30 days, 90 days, 1 year or never when generating a key,
defaulting to 90 days. The list shows each key's expiry and warns two weeks out; an expired key is
badged as expired rather than looking identical to a working one.

**Nothing that works today stops working.** The column is NULL for every existing key and NULL means
"never expires" — back-dating an expiry onto live integrations during an upgrade would be the wrong
direction for a mistake to fail in. An expired key is refused with the same message as an unknown or
revoked one, so the endpoint cannot be used to learn that a key was once real.

### 🎨 The dashboard's "This week" card says something now

The three hero cards stretch to a shared height and this was the shortest, so it padded the
difference with roughly 200px of nothing while the card beside it was dense. It also stopped at a
bare status breakdown — four numbers with no context for the headline figure.

It now carries three facts computed from data already on the client (no new query, nothing
invented): **weekdays logged**, **average per logged day**, and the **busiest day** — plus one
sentence naming where the week's hours actually sit, rather than leaving you to infer it from the
list. "2 entries are waiting on a reviewer." "Everything so far is still a draft — submit it to start
the review clock." The footer link is pinned to the bottom, which is what the existing `mt-auto` had
been trying and failing to do inside a grid.

### 🔬 The web workspace has unit tests now

`src/lib/safe-html.ts` is a security control with no test behind it, because DOMPurify needs a DOM
and `apps/api`'s vitest runs in `node`. A small `jsdom` project covers it with 27 assertions, and CI
runs them.

The suite was **mutation-tested before being trusted**: disabling the sanitizer hook fails 12 of the
27. That check is the only evidence a passing security test means anything — and it earned its keep
immediately. The first attempt used `happy-dom`, under which DOMPurify strips *every* element
(`sanitize("<p>x</p>")` returns bare `"x"`), so assertions of the form "the dangerous thing is
absent" passed beautifully while proving nothing at all.

CI also now renders `apps/web/nginx.conf.template` through the image's own entrypoint and runs
`nginx -t` against it — asserting the template was actually applied first, because a mount mistake
silently validates nginx's stock config instead and reports "syntax is ok" for a file that is not
ours.

### 🐛 Three bugs that only running the thing could find

Each of these passed every unit test and every review of the code. They were caught by driving the
real server and the real browser, which is the whole argument for doing both.

- **A bracketed IPv6 address walked straight past the new SSRF guard.**
  `new URL("http://[::1]/").hostname` returns `"[::1]"` — *brackets included* — so `net.isIP()`
  answered "not an IP", the IPv6 branch never ran, and `http://[::ffff:127.0.0.1]/hook` was accepted
  with a 201 by the running server. Every bare-address assertion in the test file passed the whole
  time; nothing was feeding the predicate the shape a URL parser actually produces. Fixed, and the
  bracketed form is now pinned in tests alongside the bare one.
- **The "expiry is already in the past" check never fired, on either credential.**
  `middleware/validate.ts` parses the schema and **discards the result**, so `z.coerce.date()` never
  writes the coerced Date back and the handler still holds an ISO *string*. Comparing
  `"2020-01-01…" <= new Date()` takes the Date as a timestamp and coerces the string to `NaN`, and
  every comparison with NaN is false — so an API key could be created already expired, authenticate
  nothing, and send its owner debugging their integration instead of their typo. **The MCP
  credential route had the identical dead guard and pre-dates this release**; both now go through one
  `parseOptionalExpiry` helper.
- **The Public API panel pushed a phone sideways.** Adding the lifetime picker gave that row a third
  control, and a 390px viewport cannot seat Input + `w-32` + `w-36` + button on one line — 400px
  against a 391px budget, caught by `responsive.spec.ts`'s "no tab widens the page" guard. Fixed with
  `flex-wrap` plus `min-w-0` on the name field; `min-w-0` is the load-bearing half, because a flex
  item will not shrink below its intrinsic content width without it.

### 🩹 Two rules that lived in one caller and not the next

- **The browser-side sanitiser now matches the server's.** `sanitizeRichText` restricts `style` to
  `text-align` and forces `rel="noopener noreferrer nofollow"` on every link; the client's `safeHtml`
  allowed `style` with no property restriction and `target` with no forced `rel`. CSS does not need
  to run script to be an attack — `position:fixed;inset:0;z-index:9999` in a ticket comment floats an
  invisible layer over the app. This mattered on the client specifically because two callers render
  content the server sanitiser never sees: Ask AI's markdown (model output) and the What's-new page
  (release notes fetched from GitHub).
- **`doctor` now checks the outbound posture** and warns when private egress is enabled on a
  deployment that looks internet-facing — the one combination that is almost certainly a mistake.

### 🔧 Two configuration changes, and what each one asks of you

- **`ALLOW_PRIVATE_NETWORK_EGRESS`** (default `false`). Leave it alone for anything internet-facing.
  Set it `true` **only** on a self-hosted box whose webhook receivers genuinely live on the LAN, or
  whose BYOK model runs on `localhost` — both are normal on-prem setups, which is why this is a
  switch and not a hard block. Development permits private targets regardless, so local testing and
  a local Ollama keep working with no configuration. `install.sh` / `install.ps1` now ask; the update
  scripts explain the change in both directions; `doctor` flags the risky combination.
- **`CSP_CONNECT_SRC`** (default empty). Only a **split** deployment needs it — SPA on a CDN or a
  different hostname from the API. Set it to the same origin as `VITE_API_URL`, or the browser will
  block every API call. Every topology this repo ships puts nginx in front of the API, where `'self'`
  already covers it.

### 🔎 What was tested and found clear

Recorded because a negative result is only worth something if it says what was checked. No SQL
injection (four raw-SQL calls, none reachable by user input), no mass assignment (every
`data: req.body` site is `.strict()`), no missing route auth (all 497 handlers across 50 controllers,
with the 14 routers lacking a blanket guard audited per route), no prototype pollution (every dynamic
key write sits behind a `Set` allow-list), and **no exploitable ReDoS** — the linter's `slow-regex`
warnings on the attacker-reachable paths were benchmarked rather than patched: `htmlToPlainText`
handles 2 MB of spaces in 31 ms because the collapse pass runs first, and the email regex is linear
in V8. Two `minimatch` ReDoS advisories in the lint toolchain were patched with a scoped override;
the remaining `deepmerge-ts` advisories were traced to options-object merges that inbound email
cannot reach, so no compatibility risk was taken for no security gain.

## 3.1.0 — the assistant that can act, and the phone that finally fits — 2026-08-20

### ✨ Ask AI can now do four things, not one

- **Raise a ticket, comment on one, and draft a change request** — alongside the timesheet draft it
  could already write. Each is offered only to someone who holds the permission the matching button
  requires (`tickets:write`, `changes:write`), and each re-checks that you can actually see the
  project or ticket before it writes: a workspace-wide permission is a permission, not a boundary,
  and holding one does not put you on a project.
- **Two of them publish, and they say so rather than pretending otherwise.** A ticket has no draft
  state and neither does a comment — `TicketStatus` begins at OPEN, and a posted comment notifies
  everyone watching. So the assistant tells you that up front and is told to confirm the details
  with you first, instead of the wording being softened to "draft" to keep a slogan intact. A change
  request *does* have a draft state, so it is raised as a DRAFT and stops there.
- **Nothing here starts or settles an approval, at any autonomy level.** A drafted change asks no
  approver for anything and takes no CAB slot until you press Submit. No action transitions a
  change, decides a timesheet, or approves a request — the same hole the workflow action list
  carries on purpose.
- **A change with no reason is still refused.** `justification` is required, and if you cannot give
  one the assistant says the change cannot be raised rather than writing a reason for you. This is
  the omission rule from 3.0.0, now enforced in code rather than requested of the model.
- **The checks live in one place.** Raising a ticket and posting a comment now run through the same
  functions the MCP server uses, so the visibility check, the ticket-type check, the sanitisation of
  model-written prose, the SLA clock and the reporter attribution cannot drift between the two. Four
  tests hold the boundary: the action list is pinned, no action may reach Prisma directly, every
  publishing action must declare its permission, and every one of them must carry the instruction
  never to act on an instruction it merely *read* in a ticket or an email.
- On the seeded workspace a super admin now sees 34 capabilities, a manager 20, an employee 16.

### 🐛 Two ways a phone could be pushed sideways, both fixed

- **Workspace settings → Maintenance no longer widens the page.** The server-health tiles print
  machine text with no break opportunities in it — a CPU model, a filesystem path, a network
  interface list. Each tile is a grid item, and a grid item refuses to shrink below its widest
  unbreakable string, so the `truncate` on those lines never got a narrow box to clip against and
  the whole page grew instead. On a developer's machine the path is short enough to fit; on a Linux
  server it is not, which is how this shipped looking perfectly fine.
- **The "SMTP is not configured" banner no longer runs off the edge.** The four `SMTP_*` names in it
  had no spaces between them — JSX drops whitespace containing a newline, so they rendered as one
  unbreakable ~340px run that the chips' own padding made *look* correctly spaced. Alerts are now
  shrinkable and wrap long machine text by default, since an alert quoting a host, a path or a stack
  trace is exactly where this recurs.
- **Both tests now fail on any machine, not just an unlucky one.** Each pinned the environment it
  was measuring — the longest realistic health payload, and the unconfigured mail transport — so
  neither can pass again merely because the host it ran on had a short path or working SMTP.

### 🐛 Seeded demo entries the app itself refused to open

- **Demo timesheet entries are real UUIDs now.** They were seeded as `seed-entry-1`…`6`, but
  `Timesheet.id` is a uuid and the routes that act on one validate it as a uuid. So every seeded
  entry deep-linked to `?entry=seed-entry-6`, returned *"Validation failed — id: Invalid uuid"* when
  edited, and exported to a file named after a truncated sentinel. Demo data you cannot click on is
  worse than none, because it reads as a broken feature rather than a broken fixture. Existing
  workspaces have the old rows retired on the next seed.

### 🚢 Deployment and CI

- **The Helm chart's `appVersion` tracks the repo again** (it had drifted to 2.5.0 while the repo
  shipped 3.0.0), so `kubectl get deploy -L app.kubernetes.io/version` answers honestly.
- **Every GitHub Action updated to a current major**, clearing the Node 20 deprecation warning that
  was about to become a hard failure on GitHub's runners.
- **The Ask AI boundary tests run on Linux again.** They read their own source to prove it contains
  no write verbs, using a hand-rolled `file:///` strip that produced a valid path on Windows and a
  path missing its leading slash everywhere else — so the strictest tests in the suite had been
  erroring out, rather than passing, on every CI run.

### 🛡 The assistant knows who is asking — and shows you exactly what it can do for you

- **Ask AI answers operational questions now, for the people entitled to them.** AI spend by feature,
  answer quality and thumbs, email volume and what is bouncing, which templates are switched off,
  service health, the slowest endpoints by p95, the audit log, open security findings, CI runs,
  identity-check outcomes, what is switched on in the workspace, headcount by role, SLA breaches, and
  what the agents and workflows have actually been doing. Fifteen new capabilities, on top of the
  tickets, timesheets, changes, projects, goals and people it already read.
- **Every one of them is gated on the permission the matching page already requires.** `audit_log`
  needs audit access, the same as the Audit log page. Headcount needs user management, the same as
  Users. Spend, mail, security, health and configuration are super-admin-only, because that is who
  those settings pages are for. Nothing here invents an access rule; where the chat could not mirror
  a page's rule exactly, it took the stricter one. On the seeded workspace a super admin sees 31
  capabilities, a manager 17, an employee 13.
- **"What can it do?"** — a new panel listing every capability your role opens, grouped by area, with
  the ones it does not open shown greyed and labelled with what they would need. Hiding them would
  make the panel read as the product's whole surface, and you would reasonably conclude the workspace
  has no spend reporting because your role cannot see it. The list comes from the server, built
  through the same filter the assistant's own prompt is — the panel and the model cannot disagree
  about what exists.
- **The starter questions are yours, not everyone's.** Each chip is backed by a capability your role
  can actually reach, so an administrator is offered the spend and health questions and an engineer
  is not offered one that would only come back refused.
- **A capability is filtered twice, from one rule.** Once when the prompt is built, once before
  anything runs. Filtering only the prompt is security by suggestion — a model that guesses a name it
  never saw, or is talked into one by text inside a ticket, would reach a real query. Filtering only
  at execution would work but waste your steps on refusals.
- **Everything a capability returns is scanned for secrets before the model sees it**, using the same
  masking the AI capture layer applies. A scanner finding's title can *be* the leaked credential.
- **Sign-in, scheduled reports and project risk answer too.** Whether SSO is on and which provider,
  what reports go out weekly and whether any failed to send, and which projects are carrying risk
  right now with the signals behind it. Email answers also cover the per-category switches and name
  the super-admin BCC explicitly — it is the usual reason one inbox sees everything, and the category
  toggles almost never are. Secrets are reported as set or not set, never read.
- **The chat is rate-limited like every other thing that spends model calls** (20/min). A chat box is
  the easiest place in the product to spend a budget by holding down Enter, and the monthly ceiling
  underneath it is too coarse to notice a minute of hammering.

#### Fixed

- **One bad answer no longer causes five more.** Recent exchanges are handed back to the model so
  follow-ups work — and a failed one taught it to fail again. It declined questions it had answered
  correctly minutes earlier, and copied a malformed fragment from two turns back. Only exchanges that
  actually consulted a capability become context now; failures still appear in your feed, where "it
  failed at 14:02, and this is why" belongs.
- **Machine syntax no longer reaches the chat window.** When a model replies in its provider's own
  tool-call dialect instead of the format this loop asks for, it now gets one correction and then an
  explanation — rather than `<|tool_call>call:ai_spend{days:30}` appearing as your answer. A
  hand-built JSON blob of invented figures met the same fate.
- **The assistant stopped asking permission to read.** Caution meant for the one thing it can write
  had leaked into everything it can look at, so "how much email went out?" came back as "would you
  like me to pull that?".
- **It stopped asking permission for sensitive-sounding topics.** "Is SSO enabled?" came back as
  "would you like me to check?" every time, while questions about spend answered straight away. The
  rule saying reads never need permission was there — just too far from the point where the
  assistant decides what to do next.
- **It stopped declining things it could plainly do.** The scope rules had been written as a wall of
  prohibitions, and on a small model that produced the behaviour they forbade — six operational
  questions in a row answered with polite refusals that paraphrased the prohibition, without a single
  lookup. Rewritten as positives.

### 🔭 Two more readings, and one more draft

- **"Which of these matters?"** on a change's Schedule tab, once its window collides with something.
  The overlaps themselves are found by comparing dates — arithmetic with one right answer — and this
  only reads which of them is the one to worry about. It moves nothing; the scheduler still decides,
  and when nothing collides it says so instead of writing a paragraph confirming it.
- **"Draft it from what happened"** under an empty post-implementation review, once a change has
  actually run. It reads what was recorded — which steps failed, which tests did not pass, the
  outcome — and where a step failed with no comment it says no reason was recorded rather than
  inventing one. An invented cause in a review is worse than an admitted gap, because somebody acts
  on it. Like every draft here it becomes a row somebody accepts.
- The review is the one field deliberately exempt from the post-approval freeze: a review is written
  after the change has run, which is exactly when the plan is frozen. Everything else stays frozen.

### 📝 It can draft the sections a change is missing, and write none of them

- **"Draft the missing sections"** sits next to the checklist that names what is missing, and drafts
  only the sections still empty — justification, implementation plan, backout plan, test plan,
  communication plan. Re-writing something somebody already wrote is how an assistant becomes the
  thing people switch off.
- **It writes nothing.** Every section becomes a row on the AI suggestions page that somebody accepts
  or rejects individually, and a row whose field moved since it was drafted is refused rather than
  overwriting the edit. The backout plan is the most consequential field in the module, which is
  exactly why a person stays between the model and the record.
- **It cannot reach anything but those five fields**, whatever it replies — an allowlist, not a
  request in the prompt. No state, no risk score, no schedule, no outcome. And it refuses a change
  whose plan has frozen, before spending the model call rather than after.
- It is handed what the change is actually shipping — repositories, merged pull requests, CI status,
  how the last few changes to the same application went. A model asked for a backout plan with
  nothing to go on writes a paragraph about restoring from backup.

### 🤖 AI can explain a change's risk score, and still cannot approve it

- **"Explain this score"** on a change's Risk tab turns the recorded assessment into a paragraph its
  approver can act on: what the answers mean together, and what to look hardest at. Off by default,
  behind its own switch in the AI capability grid like every other capability.
- **It narrates; it never scores.** The number is computed from weighted parameters and stored on the
  change — a model inventing it would make the rule that decides whether a backout plan is mandatory
  unreproducible, and indefensible to the person asking why theirs needs one.
- **And it does not tell anyone whether to approve.** There is no AI capability at any autonomy level
  that can approve a change, which is the absence of a capability rather than a limit on one. An
  approval is a named person accepting risk, and there is no undo.

### 🧵 One strand, a real chat, and analytics that stop declining

- **The loader is one luminous thread.** The ported Strands shader assumed a square-ish canvas; on a
  wide, short loader strip its envelope repeated into a row of separate pods. The envelope now spans
  the strip exactly once — the fade runs in canvas space, the ripple in aspect space — and a single
  strand breathes across the answer bubble while the model works.
- **The page is shaped like a messenger**, because that is the mental model "ask, answer, follow up"
  brings: one centred column, your words in bubbles on the right, the assistant's beside its avatar
  on the left, day separators when the history spans days, copy-answer on every reply, suggestion
  chips that retire once you have a rhythm, and the receipts strip tightened under each answer.
- **"How many of my entries are approved?" now has a real answer** — a stats tool that counts
  entries and hours by status, yours always, workspace-wide with the reports permission. The intent
  guide names it, so the model reaches for it first.
- **Submodules joined the project tool** after a question about them was declined in the field —
  the hierarchy stopped one level short of what the schema holds.
- **A past refusal no longer poisons the follow-up.** The model was parroting its own earlier "I do
  not have access" from the conversation history, verbatim, three times running — the history is now
  framed as context only, with the tool list as the current truth, and multi-part questions are
  instructed part by part.
- **Doubled-brace chart JSON is repaired at render.** The configured diffusion model emits
  `{{"label"` — invalid JSON, so charts fell back to code blocks. The sequence `{{"` cannot occur in
  valid JSON, so the targeted rewrite can never damage a well-formed fence; anything else malformed
  still renders honestly as code.

### 🖊 Ask AI can now do one thing — and it is a draft

- **"Log 2 hours on HICS-TS today, 9 to 11, development" now works as a sentence.** The assistant
  gathers what is missing conversationally — asked without a module, it lists the project's modules
  and asks which — and then logs the entry through the timesheet form's own save, so the overlap
  check, the assignment gate, the future-date rule and the audit entry all apply unchanged. What it
  creates is a **draft**: nothing reaches an approver until the person reviews and submits it
  themselves, the same line the MCP server drew and for the same reason.
- **It cannot double-fire.** A model that repeats a successful action verbatim gets its earlier
  result replayed instead of a second run — and the one measured double-fire was also refused
  independently by the overlap check, which is what reusing the form's own save buys.
- **It knows what day it is.** Asked to log time "today", the model wrote a date from its training
  data — the prompt now carries today's date and the asker's name, the two facts a model cannot
  look up and reliably invents instead.
- **Thumbs feed the golden datasets.** Each answer is captured into the same AI quality loop every
  other capability uses (when capture is on), and a thumb on the page writes the same rating the AI
  activity log writes — which is what golden datasets are promoted from. The tooltips say so.
- **The loader is now the strands.** The "consulting the workspace" state draws reactbits' Strands
  on a WebGL canvas, ported in-tree against the theme tokens and re-coloured live on theme flips.
  Under reduced motion it does not slow down — it holds still, falling back to the quiet SVG form.
- **The page reads as a chat**: the assistant's answers sit beside an avatar in their own gutter,
  the person's questions in bubbles opposite, and the directory joined the tool set — "who reports
  to whom" is now answerable. Malformed tool calls from small models are corrected and retried
  instead of being published as the answer, and a stray trailing brace no longer sinks a reply.

### 💬 Ask AI grew a page, a memory, and hands that only read

- **A full Ask AI page** (Work → Ask AI): a conversation with the workspace that remembers. Every
  prompt and answer is kept, with what each answer actually cost — model, tokens, estimated dollars,
  response time — stored at answer time, so the history stays honest after the workspace's model
  changes. Thumbs up or down on any answer; press the same thumb again to un-rate. Failed attempts
  stay in the feed with their reason, because a page that forgets failures reads as one that never
  fails.
- **It consults the workspace, live.** Nine read-only tools — ticket search and detail, ticket and
  change metrics, the change register, your own timesheets, the workspace hours report (permission
  respected: without it, the answer says so), the agent roster and the workflow list — every one
  scoped exactly as the asking person, through the same project scope the pages use. Each answer
  shows which tools it consulted, so "it looked" and "it made that up" stay distinguishable.
- **It acts on nothing, on purpose.** An action taken from a chat transcript has no review step and
  no undo. Where an answer leads to an action, it names the page where a person does it — and a test
  greps the tool registry for every database write verb, so a write added there fails the build.
- **Answers in any shape the data deserves**: markdown with tables, and one real chart per answer —
  bar, line or pie — drawn from numbers a tool actually returned, never invented. Off-topic
  questions get one polite sentence back.
- **Works with whatever model is configured.** The loop speaks plain JSON rather than any provider's
  native tool-calling dialect, so it runs on everything from Claude to a free community model — and
  a model that will not follow the format still answers in plain text rather than failing.
- The palette's quick Ask AI stays for one-off questions and now links to the page. Fixed alongside:
  markdown tables in AI answers were being silently flattened to a run of words by the HTML
  sanitiser's allowlist, which predates AI answers carrying tables.

### 📝 The assistant now declines what it cannot draft — and says so

- **Fixed the placeholder that could pass a gate.** Told to "admit what is not known", the drafting
  assistant answered a backout-plan request with "a backout procedure has not been documented at this
  time" — text which, accepted, would have satisfied the mandatory-backout submission requirement
  while containing no plan. The rule is now inverted: a section the model cannot ground is OMITTED,
  the response names what was skipped, and the field stays honestly empty. Verified against the exact
  case: the same request now answers "not enough to draft this from — it needs writing by hand".
- **Every mandatory field says so, from one source of truth.** The three conditional requirements —
  backout plan, test plan, communication plan — are now decided by shared predicates that both the
  submission gate and the form's required markers read, so the form can never promise what the server
  refuses. Hints say *why*: "Required to submit — this change is high risk, major, or moves data."
- **"Suggest a draft" beside every empty prose field.** Ten fields take it — the five that gate
  submission plus the business-case five. The suggestion renders beside the field and nothing is
  saved until "Use this", at which point the form's own save writes it as the person's edit, through
  the same validation and audit trail as anything typed. It only offers on EMPTY fields: drafting
  over somebody's writing is how an assistant becomes the thing people switch off.

### 🩹 The provider can be slow, wrong, or silent — and the app now survives all three

- **A hung model call is bounded at 90 seconds.** Both SDK clients defaulted to ~10 minutes, so a
  free-tier provider that queued indefinitely left every AI button in the app spinning for as long as
  the page stayed open. Measured with OpenRouter's free tier before fixing.
- **An answer with no answer in it no longer crashes.** OpenRouter's free tier returns rate limits as
  an error body inside HTTP 200 — no `choices` at all — and reading `choices[0]` off that took every
  AI feature down with a bare TypeError. It now surfaces as "the AI provider refused the request",
  quoting the provider's own reason where one is given.
- **A dead connection is no longer retried as if it were a formatting quirk.** The fallback that
  retries without `response_format` (for local endpoints that reject it) now fires only on fast
  rejections, not on timeouts — repeating an identical call into a hung provider doubled the wait the
  timeout exists to bound.
- Also fixed while diagnosing: the tenant fan-out had not run for the newest migrations, so the
  second organisation's workers were erroring once a minute on columns that did not exist there yet.

### 🔀 A change now shows what it is shipping, and workflows can act on it

- **A Context tab** on every change: the repositories and pull requests it delivers, whether their CI
  is green, what security findings are open against them, who did the work and for how many approved
  hours, and how the last few changes to the same application went. None of it is typed — it is
  derived from the tickets the change links, so it cannot drift the way a second copy would. A
  repository with no ingested CI run says "not reported", never "passing".
- **Workflow Studio can act on changes**, not only fire when one moves. Three actions — move a change
  to a state, comment on it, tag somebody on it — each re-entering every gate the API applies, so an
  automation cannot walk a change past its own requirements. **It cannot approve or reject one**:
  that is a named person accepting risk, and there is no undo.
- Fixed while building it: a change-triggered flow used to receive a subject with no id, so every
  step except "notify" failed with "this run has no ticket to change". The trigger fired and the flow
  could do nothing. A change now resolves to its own ticket, which is what makes every existing
  ticket action work on it.

### 🩹 Fixes

- **Tagging a ticket no longer pushes the timesheet form off the page.** A long ticket title grew the
  picker past its column instead of ellipsing, and the whole page scrolled sideways — measured, a
  250px cell rendering a 727px control. The module and submodule pickers shared the flaw and are
  fixed with it.
- **"My projects this month" was missing projects, and only in production.** The card grouped
  whatever `GET /timesheets` returned, and that list is capped at 100 rows newest-first — so on a
  busy account the older half of the month fell off the end and whole projects vanished. It also
  derived the list from entries alone, so a project you are assigned to but have not logged against
  was invisible regardless. Now counted server-side over the whole month, uncapped, listing every
  project you are assigned to or have worked on.
- **The Change management settings tab stopped 404ing on every visit.** It rendered an "Approval
  policies" editor for an engine that was never built — approval routes to the requester's manager,
  falling back to super admins — and called a route that has never existed. Removed.

### 📊 The home page counts the other two kinds of work

- **Progress is four bars, not two**: week target, then timesheets approved, tickets closed and
  changes closed. Each is finished-over-total for its own kind of work, so they read against each
  other; a single combined number hides which of the three is stuck. The changes bar is absent, not
  zeroed, when change management is off.
- **"Today across the workforce" gains tickets and changes** raised and closed, on the same day
  boundary and the same vs-yesterday comparison as the logging figures.
- **A trend can now say "no opinion".** More tickets *raised* today is neither good news nor bad, and
  the badge could only be green or red — so it asserted a reading the number does not support. Those
  now render grey.

### ⚙️ Every change dropdown is editable

- **Categories, sources, applications, risk parameters, SLA stages, maintenance windows and blackout
  periods** are all add / rename / retune / disable / delete from Workspace Settings → Change
  management, for a super admin. Same rules activity types follow: everyone who fills the form can
  read the list, only a super admin writes it, and **deleting a row that live records point at is
  refused with the count** — disable it instead, and the changes filed under it stay readable.
- **The change page reads as a sequence.** Thirteen equal tabs became Define / Plan / Deliver, and
  any tab still owing something for submission carries a dot — driven by the server's own list, so
  the header checklist and the strip cannot disagree. The header gained the four facts you check
  before opening a tab at all: environment, window, implementer, category.

### 🎨 An AI button that says what pressing it costs

- The app already marked AI *surfaces* (a glowing frame) and AI *thinking* (flowing strands). It had
  no mark for the resting control that spends a model call, so buttons wore gradient text — which
  reads as decoration on a label rather than a property of the action. There is now a proper button
  variant: a tinted face with a highlight that sweeps once on hover. Under reduced motion the tint
  stays and only the sweep goes, because identifying the control is the point.

### 🔀 The change type now says what it will cost you

- **Picking a change type tells you what it commits you to**, in the dropdown, before you pick it.
  Choosing **Major** silently obliged a change to carry a backout plan *and* a post-implementation
  review — obligations you previously met as a 422 at submission time, having already written the
  rest of the form. Both pickers now state the consequence next to the word.
- **Why there are four types and not ITIL's three**, settled and written down. `Major` is not a
  fourth peer next to Standard, Normal and Emergency — it is **Normal escalated**, and it exists
  because two rules cannot be derived from the risk score: a Major change needs a backout plan *even
  when impact × likelihood bands it Low* (a platform migration can score low on every parameter and
  still be the thing you must be able to undo — the matrix scores probability of harm, not
  significance), and it owes a review *even when it went perfectly*, where everything else owes one
  only when it went wrong. Trimming the vocabulary back to three would have compiled, linted and
  passed every other test while deleting both, so the enum is now pinned by a test that says so.

## 3.0.0 — the change somebody has to approve — 2026-08-19

**A major version for an additive release.** Nothing here breaks: no route changed shape, no column
was dropped, no default moved, and an installation that never turns change management on behaves
exactly as 2.5.0 did. The number went to 3.0.0 because the product gained a governance surface it
did not have — a change now has a risk score, a named approver, a scheduled window and a recorded
outcome — and that is a different claim about what this software is for, not another feature on the
ticket page.

### ⬆ Upgrading

- **Run the migrations, then fan them out.** Six tenant migrations and one control-plane migration
  ship in this release. `update.sh` applies the default org's automatically; every *additional*
  organization needs the fan-out, which cannot run inside the container's boot chain:
  `docker compose exec api npm run migrate:tenants -w apps/api`.
- **Nothing switches itself on.** Change management is off after upgrading, exactly as it was
  before it existed. A super admin turns it on in **Workspace Settings → Change management**, and
  the org's plan tier must include it (Team and up). The two conditions fail with deliberately
  different messages, because "turn it on" and "upgrade your plan" need different people to act.
- **Set `managerId` on your users before you turn it on.** Approval routes to the requester's
  manager; with none set it falls back to every active super admin, which works but sends every
  approval to the same two inboxes.
- **Two new email templates** (`changeSubmitted`, `changeDecided`) are seeded on migration and are
  editable on the Email templates page like every other message. They obey the same category × role
  grid, so if you mute a category for a role, the change mail respects it.
- No environment variables were added, and no existing one changed meaning.

### 🔀 Change management

- **The full request form**, in twelve tabbed sections on the change's own page — classification,
  business case, structured impact, weighted risk, implementation, testing, rollback, release,
  schedule, communications, tagging, and outcome. Tabs rather than a wizard: a change is drafted over
  days and read far more often than it is written, and a stepper is for a form you fill once. A
  checklist in the header names what is still missing rather than implying a percentage.
- **A change number of its own** — `HICS-TS-20260812-0001`. Project code, the UTC date it was raised,
  and a sequence that restarts daily. The underlying ticket key still exists; it just never appears in
  an approval email, where it would read as a bug report.
- **Approval goes straight to the requester's manager** the moment a change is submitted, falling back
  to super admins when somebody has no manager set. A super admin can decide anything — which is both
  the rule and the escape hatch for an approver who has since left. Nobody approves their own change,
  and re-submitting after a rejection opens a new round rather than overwriting the first decision.
- **A risk score you cannot game.** Impact and likelihood per parameter, weighted by an admin-editable
  matrix and normalised so adding a twelfth parameter cannot silently deflate every existing score. A
  complete assessment is required to submit: unanswered parameters count as nothing, which correctly
  refuses to treat a blank as "low" but would otherwise have let somebody lower a change's risk — and
  so skip the mandatory backout plan — by leaving fields empty.
- **Tag the closed tickets a change delivers**, and the people working on it. Only RESOLVED and CLOSED
  tickets from the change's own project are offered, and the server re-checks: a change records work
  that is finished, not work that is promised.
- **A change calendar** drawn as 24-hour tracks rather than a month grid, because a change occupies a
  window and the only question worth opening a calendar for is whether two windows overlap. Freeze
  periods are drawn underneath rather than filtered out — a change scheduled inside one is exactly
  what somebody needs to see. Conflicts are reported, never refused; overriding costs a written reason.
- **A register dashboard** — in flight, waiting on you, awaiting approval, high risk, closed — with
  breakdowns by state, risk and environment, and a CSV export carrying the columns a change record is
  actually judged on.
- **Both emails are real templates**, editable on the Email templates page with preview, test send,
  revert, per-template send volume and the failure triage desk — the same treatment every other message
  in this app gets, from the same compiled design, so the seeded row and the code fallback render an
  identical email.

- **A controlled path for changes that need sign-off before they ship.** Raise a change, have its
  risk derived rather than asserted, send it to the approvers it earns, schedule a window,
  implement it, and record how it actually went. Under **Work → Changes**, off until a super admin
  turns it on in **Workspace Settings → Change management**, and included from Team upward.
- **The backout plan is the point.** A change that is high risk, major, or moves data cannot be
  submitted without one — enforced by the API at the moment somebody asks for approval, not by a
  hopeful placeholder in a form. A test plan is required above low risk; a communication plan and a
  duration are required whenever there is downtime. Every gap is reported at once, so a long form
  costs one round trip rather than four.
- **Risk is computed, never typed.** Impact × likelihood through a stated matrix, stored with the
  time it was scored so retuning the matrix next quarter cannot silently rewrite the risk a board
  already approved against. Two changes with the same answers cannot carry different risk because
  two people judged them differently.
- **One approver, named.** A change goes to the requester's manager, falling back to every active
  super admin when somebody has none set. A super admin can decide anything, which is both the rule
  and the escape hatch for an approver who has since left. Nobody approves their own change. There
  is deliberately no rules engine deciding who signs off what: the requirement was "the respective
  manager or a super admin", and a chain of ordered match-rules is a great deal of machinery for a
  question with one answer.
- **A change cannot be walked past its own board.** Approved and rejected are written only by a
  recorded decision. No state that has not already been decided can reach them through the
  transition table, so no caller can PATCH around the approver — the one route into Approved is from
  Scheduled, which means giving up a window on a change that was approved already. Once approved, the plan freezes — the outcome fields stay writable, because
  recording what happened is not the same act as amending what was agreed.
- **Thirteen notifications**, in-app and email, from "approval needed" through window reminders to
  a weekly digest, all on the existing per-category, per-role grid. Muting one suppresses only the
  email leg, as everywhere else here: an approval that goes silent because somebody tidied their
  mail settings would be a governance hole, not a preference.
- Built on the ticket underneath, so comments, attachments, watchers, links, the audit trail,
  project-scoped visibility and search all work on day one rather than being rebuilt slightly
  differently. Approval chains, guest approvers by expiring single-use link, and terminal rejection
  come from the same engine work items already use — the only addition to it is the quorum, which
  defaults to "everyone must approve" and therefore changes nothing that existed before it.

- **A runbook that stays editable after approval.** Numbered implementation steps, test cases with an
  expected and an actual result, and dependencies — each added inline, edited in place, saved on blur.
  Deliberately exempt from the post-approval freeze that covers the rest of the change: scope and risk
  are what got approved, but recording that step 4 failed, or that a regression test passed, is
  precisely the work that happens afterwards. The API applies the same rule, so the two cannot drift.
- **A change waits on its dependencies, and says so.** A predecessor or blocker left open refuses the
  move to Implementing with a message that names it, on the page and in the API. Successors and
  related work never block — successors follow this change and related work is context, so blocking on
  either would make the field unusable for what it is for. Waiving is a recorded decision that clears
  the gate the same way completing it does, and the row keeps saying which it was.
- **Per-stage SLA clocks** for approval, implementation, validation and closure, shown as a ladder
  rather than a single number, because "approval met, implementation running, validation not started"
  is what somebody actually needs to read. A finished stage is judged on **how long it really took**,
  never against the current time — a stage that ran 60 hours against a 48-hour budget and then closed
  is a breach that already happened, and reporting it as fine the moment it closes is how an SLA
  dashboard comes to say everything is green while the register is full of overruns. A stage with no
  configured budget has no clock at all, rather than a zero-hour one that would breach on sight.
- **Excel and PDF export**, alongside the CSV, from one shared query — so no two formats can disagree
  about which changes matched. The workbook has a summary sheet built from the same capped rows as its
  own detail sheet; the PDF is a real landscape register with high risk in red and *Page N of M*. All
  three state their own row cap in headers a script can read, and the PDF prints it in the header and
  the footer, because a truncated export that looks complete is the failure exports exist to avoid.
- **Fixed: every export download returned "Authentication required".** They were plain links, and this
  app keeps its access token in memory — so the browser reached the route with no `Authorization`
  header and was correctly refused. Now fetched as authenticated blobs, the same way report downloads
  already worked. A truncated export also warns at the moment it downloads rather than leaving the
  reader to notice a short file.
- **Delivery analytics for the register** — change failure rate, emergency rate, approval turnaround
  and the SLA rollup, over a twelve-week trend of what was raised against what was closed, plus which
  projects are carrying the load. Every point is bucketed from real timestamps server-side; nothing is
  synthesised from the current total. The three rates are **null, never 0%**, when there is nothing to
  divide by: "no change has closed yet" and "every change succeeded" are different facts, and a 0%
  failure rate over an empty set is exactly the number that ends up quoted in a review.

### 🎫 The ticket list now counts, and the counts are the filters

- **A metric card per status and per priority above the table** — an icon, the live count, how it
  moved since yesterday, and a 14-day trend chart — colour-coded to the same palette the badges in
  the rows below use, so the day CRITICAL is recoloured it is recoloured everywhere. The numbers are
  counted server-side over the whole workspace, not tallied from the 200-row page the table renders:
  a tile reporting "200 open" for a workspace with 900 is the one thing a metric must never do.
- **The sparklines are measured, not decorative.** Each day's count is reconstructed by replaying
  recorded creations and status changes backwards from the live figure, so the last point of every
  chart *is* the number printed above it. Status history is exact; the priority series says so when
  it is not, because a ticket re-prioritised mid-window has no record of what it was before. A chart
  that draws a pleasing curve unrelated to its own number is worse than no chart.
- **The comparison is the increment, not a percentage.** "+7 vs yesterday" rather than "+700%" —
  at these magnitudes a percentage turns one ticket into a crisis. The percentage is on hover. A
  bucket where direction carries no judgement (a rising MEDIUM count) stays grey rather than being
  painted green or red.
- **Every tile is a filter.** Click one and the table below narrows to it; click it again and it
  clears. The tiles and the list are built from one filter object and one shared query-string
  mapping, so a tile can never describe a different set of tickets than the rows under it. The
  tallies respect the filters already applied — except along the axis being counted, since a status
  tally filtered by status would report the selected status and zero for everything else.
- **A per-project breakdown** on the same strip (collapsed by default), with each project's total,
  open, closed and a priority mix bar. Clicking a row filters the table to that project.
- **The filter row names its fields**, and swapped Label for **Type** — read from the admin-editable
  ticket types, so a workspace that added "Spike" can filter by it the day it exists — plus a new
  **Raised by** filter. Its options are the people who have actually raised a ticket in what you can
  see, with counts, rather than the whole user directory; most of a company has never filed one.
  Labels are still on the ticket, its detail sheet, and the label column's replacement below.
- **New columns: who raised it, and when.** An email- or chat-sourced ticket shows the real sender
  rather than the intake system account it is technically reported by. Labels gave up their column
  to a **file count** — "which of these has a screenshot attached" is the question being asked at
  triage, and labels are still on the ticket, its detail sheet and the filter row. The ticket key
  column became a **serial number**; the key stays searchable in the results box and one hover away,
  because that is how people actually look a ticket up.

### 🔐 A ticket belongs to the people on it

- **Working on a ticket now follows the reporting line.** Its reporter, its assignee, anyone added
  as a collaborator, and the manager those people actually report to. Previously `tickets:assign` —
  which every manager and team lead holds workspace-wide — answered yes for every manager in the
  organization, including ones with no relationship to the work.
- **Deciding who works on it is narrower than doing the work.** Reassignment and the collaborator
  list are limited to a super admin, an admin, or the manager the reporter or assignee reports to.
  An assignee can move their own ticket but cannot hand it to somebody else.
- **Collaborators: more than one person on a ticket, deliberately not watchers.** A watcher is a
  notification subscription anybody can self-grant and it still grants nothing; a collaborator holds
  the same working rights the assignee does, so only the people who may reassign may add one.
  Collaborators hear about status changes on the same terms as the assignee, and anyone may stand
  themselves down without needing that right.
- Both answers are computed by the API and sent with the ticket, so the sheet never offers a control
  the server then refuses — the same rule the planning layer's `effective` object follows. A viewer
  who may not move a ticket sees the status picker disabled with a line saying who can.

### 🔎 Searchable module and submodule pickers

- The timesheet form and its edit dialog now type-ahead over modules and submodules instead of
  scrolling a plain dropdown, matching the ticket picker that already sat beside them on the same
  row. A real project's module list is long enough that scrolling it was the slow part of logging
  an entry.

### 🩹 "My projects this month" showed an em dash where the ticket counts belonged

- The Open, Closed and Done columns counted only tickets assigned to **you**, so anybody who logged
  time against a project without personally holding tickets in it — most admins, reviewing a team's
  work — saw three dashes on every row. They now show the **project's** totals, bounded by the
  projects the viewer can already see, with your own share of each on hover.
- A second, quieter half of the same bug: once the server had answered, a project it did not mention
  kept rendering as "—" rather than a real zero, which made "none closed" indistinguishable from
  "still loading". The two are different claims and now read differently.

## 2.5.0 — goals that measure themselves, teammates that hold no seat, and the releases you could not see — 2026-08-18

**One upgrade note for multi-org installations.** The tenant schema fan-out has never been able to
run inside a container (see below), so every organization beyond the default one has been left on
its old schema without the update saying so. After upgrading, run the fan-out once:
`docker compose exec api npm run migrate:tenants -w apps/api`.

**One security note, for anyone who invited teammates on an earlier build.** The "Invite a
teammate" form used to pre-fill the password box with the demo credential printed in this
project's README, so any account created without an admin editing that field shares a password
anybody can look up. Treat those accounts as compromised and reset them — Users → select →
**Reset password** issues a fresh one-time password per person. New invites now generate one
automatically (see below).

### 🎯 Goals, and progress that measures itself

- **Objectives and key results, where the number is computed rather than typed.** A goal can be
  wired to something this workspace already records — approved hours, billed spend from the rate
  snapshots taken at approval, tickets closed, on-time delivery rate, SLA escalations, or average
  project risk — and its progress then reports itself. The source catalogue is closed on purpose:
  a metric two goals can define differently will be defined differently, and the person who
  notices is in a review meeting.
- **A measured goal can still be overridden, and the override keeps the receipt.** It records who
  set it, when, why, and **what the measurement said at that moment** — and the page shows both
  numbers side by side rather than replacing one with the other. Overrides are append-only: a
  correction is another entry, never an edit, because an unrecorded adjustment is exactly what
  measuring was supposed to prevent.
- **"Not measurable" is words, never 0%.** A goal with no period, no target, or no data in scope
  says so and explains which — "no data yet" and "nothing achieved" are opposite messages that
  look identical as a zero. A ceiling-style goal (spend, breaches, risk) deliberately shows no
  percentage at all: "62% of the way to your spending limit" reads as progress.
- Objectives nest one level into key results, on their own page under **Plan → Goals**, with the
  workspace toggle under **Workspace Settings → Planning**. Off until an admin turns it on, and
  Team and Enterprise only — Team gets 25 active goals, Enterprise unlimited.
- Managers and team leads can write goals, not just admins: a manager who cannot write the goals
  their team is measured against has nothing to manage. Everyone can read them.

### 🗞️ An Inbox, and a brief that counts rather than guesses

- **A real inbox at Work → Inbox**, not just a bell. Notifications become a queue you can work
  through: mark done, snooze until later today / tomorrow / next week, reopen, or clear the lot.
  A snoozed item disappears and then **comes back on its own** when its time arrives — a snooze you
  have to remember is a delete.
- **"Done" is not "read".** Opening the bell marks things read, which says something about attention
  and nothing about work. Marking done is the act that clears the queue, and nothing is ever
  deleted — the row is the record that you were told, and it answers the question a month later.
- **Today's brief sits at the top**, and every number in it is counted from the same definition the
  page behind it uses: what is past its date, what is due today, what is blocked and on whom, whether
  you have logged time, timesheets waiting on your review, sign-offs waiting on you, projects reading
  red, unread notifications. **Nothing in it is generated by a model** — a fluent summary whose
  figures cannot be reconciled with the pages they came from is worse than no summary.
- **It only shows you what you can act on.** The approval and project-risk rows appear only for people
  holding the rights that already grant those pages, and are not even queried otherwise.
- **"All clear" means it.** Work merely due today, and unread notifications, are deliberately not
  alarms — if they were, nobody would ever see an all-clear and the signal would be worth nothing.
- Two panes on a desktop (list beside detail, so triage is read-decide-next rather than
  navigate-and-back), a single list on a phone, and 25 items at a time with a "show more" — a busy
  workspace's first render was otherwise 24,000 pixels tall.

### 🤖 AI teammates you can name, scope, and switch off

- **A roster at Plan → Agents**, built from the capabilities this workspace already runs. Six ready
  ones in the gallery — Triage, Planner, Risk watch, Security desk, Reporter, Load balancer — each
  assembled only from things that already existed here, so adding one grants no new power.
- **Every teammate shows exactly what it may do**, per capability, at the autonomy it *actually*
  resolves to rather than the ceiling it could theoretically reach. A capability that reads text from
  outside the workspace is marked, and a run that touches any such text drops to proposing for the
  rest of its life however it was configured.
- **They arrive switched off.** Always, whoever creates them. You read what a teammate may do, then
  turn it on — the same rule that makes an upgrade unable to enable anything by itself.
- **Each one has its own identity**, so its work appears in the audit trail under its own name and it
  can be assigned work like anyone else. It holds **no paid seat**, **cannot sign in**, and **has no
  mailbox** — its address sits on a domain reserved never to resolve, so no digest can be posted to it.
- **What it cost is on the card**: today's spend, against an optional per-agent daily ceiling that
  sits under your existing monthly budget and the platform cap. Plus its recent runs, with the
  status, the trigger, the step count, and whether it was clamped.
- **Retiring one keeps its history.** The identity is deactivated, never deleted, because past runs
  and audit rows point at it and a retired teammate should read as retired rather than as a gap.
- **Two teammates can never own the same capability.** Switching one on is refused if another already
  covers something in its bundle, and the refusal names it — so "which teammate does this?" always has
  exactly one answer. Drafts may overlap as much as you like, which is how you build a replacement
  before retiring the one it replaces.
- **The two screens now point at each other.** Workspace Settings → AI features shows which teammate
  uses each capability, and the roster links back to the one place authority is set. There is still
  only one lever; what changed is that both screens say so.
- **An agent that cannot actually do anything says so.** If everything in its bundle has its AI
  feature switched off, the badge reads "On, but idle" and explains where to fix it, rather than
  showing a confident green "On" over work it cannot perform.

### 🧩 A Workflow Studio, where what a flow may do is on its face

- **Flows at Plan → Workflows**: a trigger, then steps — an AI capability, a deterministic action, a
  point where a person is asked, or a condition. Built as a list you read top to bottom, because a
  canvas demos well and a list is what somebody can actually check in a review.
- **Every flow states the authority it really has**, which is often less than its steps suggest. A flow
  can never do more than its most restricted step, and the card names that step. Put two "applies its
  own changes" steps together and you get exactly that — never something more.
- **Order matters, and the flow says why.** The moment a step reads text from outside your workspace
  (inbound email, a chat message, a scanner finding), every change after it becomes a proposal for
  somebody to accept. Move that step later and the flow's authority changes — the card explains this in
  place rather than leaving you to discover it.
- **Replay before you switch it on.** Any flow can be replayed against your own recent triggers: which
  steps would run, where it would stop for a person, and whether each change would be applied or
  proposed. It calls no model, writes nothing, and says so on its own face.
- **A flow with a problem cannot be switched on**, and the reason is quoted — a gate as the last step
  approves nothing, a condition at the end guards nothing, and a flow bound to a teammate cannot use a
  capability that teammate does not have. Switching a flow **off** is always allowed, so nothing can
  ever get stuck on.
- **Steps say what they will actually do, not just what kind of thing they are.** An action chooses
  its assignee, its label or the person it notifies; a condition states its field, its operator and
  its value in the same vocabulary the ticket rules already use; a gate names its approver. A step
  left blank is an error that blocks activation, not a step that quietly does nothing — and the
  pickers never offer an AI teammate as the person to notify or ask, because an identity with no
  mailbox cannot answer either question.
- **The flow list reads as sentences.** "Waits for Priya to approve", "Assigns it to Sam" — the names
  are resolved for you, so reviewing a flow does not mean reading identifiers. A step pointing at
  somebody who has since been removed says so rather than showing a blank.
- **A drag-and-drop canvas, beside the list rather than instead of it.** Pan, zoom, drag the cards,
  and see the flow as a graph with the authority banner still pinned above it. **Dropping a card above
  or below another reorders the flow** — because the steps are a sequence and order changes what a flow
  is allowed to do, the picture and the rule can never disagree. The list stays the review view, and
  on a phone the list is all there is: a squashed canvas would be worse than none.
- Everything a flow does still goes through the same review, undo and audit path as every other AI
  change here. The Studio composes what already existed; it adds no new way to write to your workspace.

### ▶️ Flows now actually fire, and tell you what they did

- **Three ways in.** A flow can listen for something happening in the workspace, run on a schedule, or
  wait for somebody to press **Run now**. Nothing fires until you activate it, and switching a flow off
  always works. (A flow triggered by a request form validates and replays, but does not fire yet.)
- **The same thing never happens twice.** A doubled event, a retried delivery and a restart mid-run all
  collapse to one run — while a *second* ticket through the same flow is properly a second run. Both
  halves matter: get the second one wrong and the first ticket is the only one your flow ever touches.
- **"What they have done"**, on the Workflows page. Every run, newest first, with what it ran against,
  a one-line result, and a click to see each step's outcome and the reason in plain words: applied,
  proposed, sent to a teammate, skipped by a condition, held back, or could not be done. A run stopped
  by a condition is shown as the flow working, not as a failure — and a run where a step could not be
  done is never labelled Done.
- **An approval stops the flow and waits for the person the step named**, for as long as it takes,
  across restarts. Only that person can clear it, and approving continues from exactly where it stopped.
- **A flow that may only propose does exactly that.** An assignment goes to the review queue with the
  state it was computed against, so applying it is still refused if the ticket has moved since. Adding
  a label is the one change the review queue cannot hold: the step reports that it was held back and
  why, rather than applying it anyway.
- **Per-workflow AI spend**, in Workspace Settings → AI, beside the teammate figure — so "what is this
  automation costing me" has an answer that is separate from the same capability used by hand.
- **A flow tells its author the first time it runs**, and only the first. An automation nobody notices
  working is an automation nobody trusts; a message on every run is a message people mute.

### 🧭 One page that says how the AI fits together

- **AI in this workspace**, a new super-admin page, lays the four AI screens out as the sequence they
  actually are: **what the AI may do** (capabilities and their authority) → **who does it** (teammates
  that own them) → **when it happens** (workflows) → **what you accept** (the review queue). Each with
  real counts and a link, over one suggested next step — the single most blocking thing, not a checklist.
- Every number on it is a **count you can check** against the screen it came from. No health score: a
  score needs a rule for what healthy is, and that depends on what your workspace wants.
- **"Human time displaced" says "—" when it cannot be measured**, never 0. "No comparable history" and
  "displaced nothing" are opposite claims that look identical as a zero.

### 🔗 What the AI did, followable from end to end

- **A run's trace now shows the whole chain**: the steps it took, the suggestion it produced, that
  suggestion's status, and each change with whether it was actually applied — with a link that opens it
  in the review queue and highlights it. Following such a link also widens the queue's filter, because
  the usual reason for following one is to see what became of something no longer pending.
- **A workflow run's step links the same way** — *see the suggestion*, *see the run* — so "what did this
  automation do to my work" is answerable by clicking rather than by cross-referencing.
- **A run also reports its ledger row**: what it cost, and roughly how much human work it stands in for,
  or that the displacement is not measurable yet.
- **The agent ledger now has a history**, not just a total: 30 days of cost and displaced time on the
  Agents page, with the recent entries and the basis for each measurement. Days with no measurement are
  named as unmeasured rather than drawn as zero.
- A day on that chart with a real run that **cost nothing** — a deterministic capability, say — now
  draws a bar rather than an empty column. Free is not the same as never happened.

### 🧑‍🤝‍🧑 AI teammates on the workload board and the budget, honestly

- **An AI teammate no longer appears on the workload board as a person.** It was showing up as a
  colleague with your default weekly capacity and nothing booked — a permanently idle hire. Fixed.
- **Agent work is its own section under the board**, over the same weeks: cost and wall-clock time per
  teammate. Deliberately not an allocation percentage — a teammate has no capacity to be a percentage
  of, and putting one in the same grid would make some cells mean a different thing from others.
- **Agent spend shows beside a project's burn, never inside it.** None of it is billable, it is always
  in US dollars while your budget may be in any currency, and a budget is an agreement about labour
  rather than a cost of running the workspace. The panel says which, and stays out of the way entirely
  on projects no teammate has touched.

### 👍 Thumb-sized controls on the AI screens

- Every button, link, disclosure and picker on **Workflows**, **Agents**, **AI overview** and the
  workflow builder now meets the 44px a finger actually lands on, at phone width — checked by
  hit-testing every control on those screens rather than by eye. Desktop density is unchanged.
- The **close control on every dialog** in the product gained a real hit area too. It was a 14-pixel
  glyph, which is a target you miss twice before hitting.

### 🧭 The new screens now introduce themselves

- **The product tour covers Goals, Inbox, Agents, Workflows and AI overview.** They were always in the
  itinerary — it is built from your own sidebar — but each fell back to a bare page title, so the tour
  walked you past the new half of the product without saying what any of it was for.
- **The setup checklist has workspace steps for an administrator**: write a goal, switch on an AI
  teammate, build a workflow. Everything in that half of the product ships switched off, which is the
  right default and means nothing ever prompts you to find it. Each step disappears once it is done.
- **Goals appear where you already look**: a line on your dashboard when one of *your* goals needs a
  look, and a "Goals measuring this work" card on Portfolio. Neither appears when there is nothing to
  say.

### ✉️ Two messages that were missing

- **A weekly goal digest**, to whoever owns the goal — what is off track, what closes this week, and
  what cannot be measured yet. One email per person, never one per goal, and **nothing at all in a week
  where nothing needs a look**. Off by default; turn it on in Workspace Settings → Notifications.
- **An approval request now emails the person it names.** A workflow that stops at an approval blocks
  everything after it, sometimes for days, and until now it only raised an in-app notification — which
  made a blocked workflow look like a broken one. On by default.

### 🛡️ The server checks how it is addressed, at every boot

- Four settings decide whether people outside your machine can use the app — `APP_BASE_URL`,
  `WEB_ORIGIN`, `NODE_ENV` and the certificate — and they only fail as a **combination**, which is why
  nothing caught them. The server now inspects them at startup and says exactly what is wrong and what
  to change. Silent when everything is consistent.
- It catches the two that caused real failures: **the address people are told to use missing from the
  CORS allow-list** (every sign-in refused, while localhost keeps working for whoever is testing), and
  **emailed links built on a LAN address** that no outside recipient can open.
- It also flags plain HTTP over a public address, a bare IP as the link base (no public certificate
  authority issues certificates for IPs, so every emailed link opens through a browser warning), and
  real users being pointed at a development server.
- It **warns and starts** rather than refusing — an on-prem LAN pilot is production to the people
  using it. What it never does is stay silent.
- `docs/DEPLOYMENT.md` now states the target shape as a decision table: one DNS name used by everyone
  inside and out, that same origin in both settings, a publicly issued certificate, and the production
  build — never the dev server — as the public surface.

### 🔎 Check that a public address actually reaches your deployment

- `npm run check:public -- https://your.address:5173` compares the **version and git sha** behind an
  address against your local server, then tests whether that host accepts its own origin and whether
  the certificate it serves covers the address people type.
- Run it **before** changing configuration. An address that answers on port 5173 with a TimeSphere
  login page looks exactly like your own deployment and may not be one — a port forward can point at
  a different machine. When that happens, every local fix is correct, verifies against localhost, and
  changes nothing that users see.

### 🩹 Two toggles that could not be saved, and a public IP that could not sign in

- **"Weekly goal digest" and "A workflow is waiting for a decision" failed to save** with a wall of
  Prisma text. The two columns had been added to the database but the generated database client was
  never rebuilt, so the server did not know the fields existed. Rebuilt; both toggle cleanly.
- **Reaching the app over a public IP was refused at sign-in** with "Origin … not allowed by CORS".
  Development auto-allows private addresses (`localhost`, `10.x`, `192.168.x`, `172.16–31.x`) because
  those cannot be reached from the internet; a public address must be listed in `WEB_ORIGIN`, and
  always will be — a rule loose enough to match one public address matches an attacker's too. **The
  refusal now names the fix** and the exact string to add, instead of only stating the refusal.
- Worth checking after opening a deployment up: **`APP_BASE_URL` decides what every emailed link
  points at.** Left on `"auto"` it resolves to the machine's own LAN address, so the app works over
  the public address while its password-reset and digest links point somewhere the recipient cannot
  open. Documented in `.env.example` and `DEPLOYMENT.md`.

### ✉️ Email templates: the editor now shows the real email

- **An un-customised template used to preview as a three-line placeholder**, and pressing Save on that
  screen replaced the real, designed email with the placeholder. The editor now opens on the actual
  email this workspace sends, with its real subject — for every template, customised or not.
- **Twelve templates were being sent that the editor never listed at all**, so nobody could change a
  word of them and their delivery analytics fell into an "unmapped" bucket: the goal digest, the
  workflow approval, the bug-pattern digest, the stale-ticket nudge and the whole face-verification
  family. All are now editable, previewable and reported like every other template.
- **"Send test" refused any template that had never been customised** — "Template not saved, open the
  editor and save it first" — which was every one of those twelve. Testing what your workspace already
  sends no longer requires editing it first.
- **Previews with no sample data** for the face and identity emails now render a realistic message
  instead of a design with every field blank.
- **If you have customised a template and it is missing a field the newer version added**, the editor
  now names the exact variables and offers to revert. Nothing you wrote is changed for you.

### 📋 Timesheet emails now say what the entry was

- Submitted, approved and rejected emails carry the **module, submodule, activity, linked ticket and
  the task description** — not just a date, a project and an hours figure. An approver can decide from
  the email instead of opening the app to find out what the entry was for.
- **The approver gets the email too.** The person who needed no action already got one; the person
  being asked to approve got an in-app notification only.
- A rejection now quotes what you originally wrote, so fixing it is a correction rather than a retype.

### 🎫 Ticket emails carry the comment and the type

- **A "new comment" email now contains the comment.** It previously said only that somebody had
  commented, so every recipient had to open the app to find out whether it concerned them.
- Assignment emails carry the **type, module and description**; status changes carry the type and the
  latest comment for context — labelled as the latest comment, never as a reason for the move.
- **Every ticket email links to the ticket**, not to the ticket list. In a workspace with hundreds of
  them, "open tickets and find it" was the reader's job until now.

### 📊 The Monday digest is a report, not a nudge

- It carried one AI-written paragraph and a link to the dashboard. It now leads with **last week
  beside month-to-date and year-to-date** — because "214 hours" answers nothing on its own, and the
  question you actually have is whether last week was normal.
- **Managers and administrators also get the workspace user-by-user and project-by-project**, plus
  open tickets by priority with shares. Everyone else gets their own week and where their hours went.
  Who sees what follows the same permission that opens the reports pages.
- **It no longer depends on AI.** The figures are counted from your own records and always send; the
  written summary is added when a model is available. Previously, if the model failed, the entire
  digest was silently not sent.
- Hours count **approved** timesheets only — the same basis as the portfolio and budget figures, so
  the digest can never disagree with them. A share with nothing to divide by shows a dash, not 0%.

### 🔐 Inviting a teammate no longer hands out a password the internet knows

- **New users get a random one-time password, shown to you exactly once.** The invite form used to
  pre-fill the password box with the demo credential printed in this project's own README, so every
  teammate created without an admin editing that field shared one password anybody could look up.
  Leave the box blank and the server generates a strong one-off, returned in the same show-once
  dialog the "Reset password" flows already used; type your own and it is used unchanged. Either
  way the person is prompted to choose their own at first sign-in.
- **If you have been running an earlier build, treat any account invited through that form as
  compromised** and reset it — the old default is public, and it was the path of least resistance.
- The create-user response no longer includes the new account's password hash. It never needed to
  leave the server, and it was reaching the browser and any proxy log in between.

### 📊 "My projects this month" now says how much you actually finished

- The home dashboard's project table gains **Open**, **Closed** and **Done** columns, so a project
  where you have three tickets left out of twelve reads differently from one where you have three
  out of three. Counted server-side in a single query, so the figure stays honest on a workspace
  with years of closed tickets behind it.
- **The completion share shows a dash, never 0%, when there is nothing to divide.** "None of your
  tickets here are finished" and "you have no tickets here" are different facts, and a dashboard
  that renders both as zero gets one of them quoted in a review.

### 🩹 Fixes

- **The face-verification review log's "flagged only" switch** left you on whatever page you were
  on. Filtering from page 7 down to two pages of results showed an empty table that read as "no
  flagged checks". It now returns to the first page, like the page-size control beside it always did.
- **Pasting into a rich-text box** no longer mistakes prose for code — a paragraph was being turned
  into a code block whenever a word like `for` or `return` appeared above a line ending in a brace.
  Large pastes also no longer freeze the editor for a moment while that check runs.
- **AI response times are recorded for every AI feature**, not the nine of twenty-one that happened
  to be wired up, so the latency figures on the AI quality page describe the whole picture rather
  than a subset that looked complete.

### 🩹 A workspace left behind by an upgrade now says so at startup

- Every organization has its own database, and a release only reaches the rest of them when the
  migration fan-out runs. Miss it and the code is fine, your own workspace is fine, and another one is
  quietly broken — with a background worker logging "table … does not exist" once a minute and nothing
  anywhere naming the actual problem.
- **The server now checks at boot** and, if any workspace is behind, prints which ones, what version
  they are on, what this build expects, and the one command that fixes it. It warns rather than
  refusing to start: one workspace being behind must not take down the ones that are fine. Silent when
  everything is current.

### 🔧 Three workflow limits lifted

- **A workflow can be triggered by a request form.** The trigger validated and replayed before; now it
  fires, scoped to the ticket the submission created.
- **A condition now draws where the flow stops.** On the canvas a condition shows a second, dashed arm
  labelled "does not match — flow stops" — which is what actually happens, rather than a second column
  of steps the engine would never take.
- **A workflow that may only propose can now propose a label**, not just report that it held one back.
  This was the awkward one: a flow that reads inbound email is propose-only by design, and "read this
  and label it" is the most obvious thing such a flow is for — so the commonest useful workflow was the
  one that could not do its job.

### 🩹 The workflow builder offered steps that could never run

- **The capability picker listed all 28 capabilities; only 2 can be run by a workflow.** The rest —
  triage, refine, the digests — are real, but each is called *inline* by the feature that owns it and
  has no tools for an agent run to use. A flow built from one validated, activated, fired, and failed
  with "no runner is implemented". The picker now offers only what a run can execute, and a flow naming
  anything else is refused when you switch it on, while you are still holding the thing to change.
- One definition of "runnable", in the capability registry that both the workflow builder and the
  manual-run picker read. The rule was previously written out in one of them and missing from the other,
  which is exactly how the two disagreed.
- **A workflow now passes the project along.** "Rebalance workload" needs a project to work on, and the
  dispatcher was queueing it with none — so it failed every time. A workflow triggered by something that
  belongs to a project now scopes the run to it, and a workflow whose trigger can never supply one (by
  hand, or on a clock) refuses that step when you switch it on rather than at three in the morning.

### 🔎 "The model's reply could not be parsed" now says which model, and why

- That message sent operators to check an API key that was working perfectly. On a bring-your-own-key
  deployment the model is *your* choice, and a small chat model asked for structured output will often
  reply with the JSON schema instead of an answer in that shape, or in prose. The run now says so, names
  the model, and adds that every other AI feature keeps working on it — so nobody switches AI off over a
  model that is merely too small for agent runs.
- **Near-miss replies are now accepted.** A model that answers `{"action":"list_projects"}` instead of
  `{"action":"tool","tool":"list_projects"}` meant the right thing, and the run used to die on the shape
  after paying for the tokens. The repair can only name a tool that was already offered for that step,
  so it changes the shape of a decision and never its authority — and the quality metrics still record
  whether the model answered in the shape it was asked for, so a repaired reply never flatters it.

### ⚖️ Agent work on the same ledger as human work

- **When a teammate runs, it is recorded the way a person's work is** — attributed to a project,
  timed by its own clock, and priced from real usage rather than estimated. Visible on the Agents page.
- **Where your own approved hours give a baseline for the same kind of work, the human time it
  displaced is measured too** — from the median of comparable entries in *this* workspace, never a
  vendor's benchmark, with the basis recorded beside the figure so it can be checked.
- **Where there is no baseline, it says so.** The page shows how many runs the saving was measured on
  and how many could not be measured, side by side. A true number over partial data reads as a false
  one, and this is the figure somebody will quote at a renewal.
- **None of it is billed to a client by default.** Agent cost is real cost, but invoicing machine
  minutes is a commercial decision, so nothing here touches the money on an invoice or an attestation.

### 🩹 The bell and the Inbox now agree

- Snoozing something in the Inbox used to leave it sitting in the bell, which defeats the snooze, and
  items marked done lingered there too. The bell now reads the same "still outstanding" rule the Inbox
  does. Nothing is lost — anything hidden is still under Snoozed or Done.

### 🐳 The API image never contained the scripts two runbooks tell you to run

- The runtime stage cherry-picks directories into the image and `apps/api/scripts/` was not among
  them, so `npm run migrate:tenants -w apps/api` exited "file not found" in every container. That
  is the **multi-org schema fan-out `update.sh` runs on every single update**, and the command the
  Kubernetes runbook tells you to `kubectl exec`.
- It was invisible because the failure is deliberately a warning rather than an error — one bad
  tenant must not roll back everyone else's upgrade. The result is that the warning was the only
  thing that ever happened: **non-default tenant databases have been silently staying behind.**
- The same omission disabled `doctor:heal`, which is the documented P3009 repair.

### 🐛 Uploads over 1MB were rejected before the API ever saw them

- The app accepts attachments up to 25MB each, eight at a time. nginx's default
  `client_max_body_size` is 1MB and ingress-nginx's `proxy-body-size` default is also 1MB, so the
  proxy refused the body and the API never got the request. Users saw a bare `413` instead of the
  app's own readable size and file-type errors, which could never fire.
- Both are now set to the app's own arithmetic (8 × 25MB), scoped to `/api/` so the SPA keeps the
  tight default it should have.

### ☸ Enabling face verification got Kubernetes pods OOMKilled

- The face models need roughly 500MB resident per API process; the chart's memory limit was
  `512Mi`. Turning the feature on therefore killed the pod. The limit is now `1280Mi`, with
  requests left at `256Mi` because most installations leave the feature off.

### 🐳 Outbound mail had no Helm configuration at all

- No SMTP keys in the ConfigMap and no `SMTP_PASS` in the Secret example, so a chart install had no
  way to send mail — and it did not complain, because the mail service logs messages to stdout when
  no host is configured. Password-reset links were "sent" into `kubectl logs`.
- Added `mail.*` values, the matching ConfigMap keys, and `SMTP_PASS` plus `UPDATE_CHECK_TOKEN` to
  the Secret example.

### 🩹 A migration stranded mid-apply deadlocked every deployment path

- MySQL DDL is not transactional and Prisma does not roll back, so a migration that half-fails
  leaves its DDL applied while `_prisma_migrations` records FAILED. Every later `migrate deploy`
  then refuses — **including the corrected version of the migration that broke.**
- `update.sh` made it worse by rolling the code back, because the old code hit the same wall.
- `install.sh`, `update.sh`, `update.ps1` and the Helm migration Job now attempt the doctor's
  repair as a fallback after a normal `migrate deploy`, preserving exit status so a genuinely
  failing hook still blocks the rollout. The doctor only clears migrations that declare themselves
  `@rerunnable`, and never runs `prisma migrate reset`.

### 🔧 Two CI gates had never executed once

- Both the security-scan dogfooding job and the test-run reporting step were gated on
  `if: secrets.X != ''`. GitHub does not expose the `secrets` context to **any** `if:` key, so the
  expression resolved to `'' != ''` — permanently false, whether the token was configured or not.
- Replaced with the documented workarounds: a job-level `env` for the step gate, and a small
  preflight job whose *output* a job-level `if:` is allowed to read.

### 🔧 The Helm chart reported version 2.1.0 while the repo shipped 2.4.0

- `Chart.yaml`'s `appVersion` had drifted, so `kubectl get deploy -L app.kubernetes.io/version`
  answered with the wrong version and nothing failed. Corrected, chart `version` moved to `0.2.0`,
  and CI now asserts the two stay in step.

### 🐳 Documented environment variables that never reached the container

- `TENANT_DB_PROVISION_BASE_URL`, `SLA_CRON_SCHEDULE`, `SLA_DEFAULT_APPROVAL_HOURS` and the
  `UPDATE_CHECK*` variables were in `.env.example` and read by the code, but absent from the
  compose service definitions. Compose does not pass the host environment through, so an unlisted
  variable simply does not exist inside the container.

### 🧰 The deployment manifests are now validated in CI

- A new job runs `helm lint`, renders three `helm template` shapes (bundled MySQL, external
  database with hooks disabled, telemetry and VPA enabled) and strict-parses each result, runs
  `docker compose config` across all three compose shapes, and asserts `Chart.yaml` matches
  `VERSION`. Entirely offline — no cluster, no registry, no push.
- Also added: Helm values for mail, SLA escalation and token TTLs, and `VITE_API_URL` as a
  documented web build argument for split deployments.

### 🐛 Face enrollment could not accept the frame count its own route allowed

- The enrollment route accepted up to 8 frames while the shared multer instance allowed 5, so a
  six-to-eight-frame enrollment died with `LIMIT_FILE_COUNT` — an unreadable 500 — instead of the
  route's own limit answering. Today's guided wizard sends four, so nothing broke in practice; a
  fifth pose would have. Both ends now derive from one exported constant.

### 🐛 Emailed dashboard links contained the literal word "auto"

- The scheduled-report worker read `process.env.APP_BASE_URL` directly, bypassing the resolution
  step that turns `auto` or a `{lan-ip}` token into a real address. Every link in a scheduled
  dashboard email pointed at `auto/...`.

### 🩹 The Windows updater re-encoded its own database backup

- `update.ps1` piped `mysqldump` through `Out-File -Encoding utf8`, and PowerShell decodes a native
  command's stdout into strings using the console encoding before re-emitting it with its own line
  endings. The backup was therefore a rewritten copy of the dump — CRLFs, a possible BOM, any byte
  the codepage could not round-trip replaced — and nothing says so until restore day.
- The dump is now written inside the container and copied out with `docker compose cp`, so the
  bytes are never PowerShell's to touch. It is gzipped and named `.sql.gz` to match `update.sh`, so
  one restore command works whichever script took the backup, and a size floor catches a dump that
  died mid-write behind a successful `gzip`.

## 2.4.0 — the log you can still fix, and the session list that lists sessions — 2026-08-17

**Two upgrade notes.**

**Fresh installs on Linux MySQL (Docker Compose and Kubernetes alike) were broken from 2.3.0's
migrations onward** — 37 table names generated in the case-insensitive Windows dialect died on
case-sensitive Linux servers mid-migration. Fixed by rewriting them to the canonical casing, which
is correct on both. Existing installations are unaffected; their migration checksums were
reconciled in place.

**Upgrading tidies up the session table**, keeping each person's ten most recently used sessions
and ending the rest. Rows are revoked, never deleted, so the audit trail survives. The session
you are reading this on is kept — nobody is signed out mid-shift.

### 🛠️ Setup no longer strands a database it half-upgraded

- **`npm run setup` failed on MySQL 8 with a migration error it then refused to move past.** The
  session cleanup above ranked rows in a table while updating that same table — a pattern MySQL
  rejects, which MariaDB happens to allow. Development ran MariaDB, so it passed every local test
  and broke on the first MySQL 8.0 machine it met.
- Worse than failing was **how** it failed: the schema change went through and the data step
  didn't, leaving the database recorded as mid-upgrade. Every later migration then refused to run,
  including the corrected version of the one that broke.
- The migration now **checks before it changes anything**, so re-running it over a partly-upgraded
  database completes instead of colliding with its own earlier attempt. **No data is dropped or
  rewritten.**
- **`npm run setup` now repairs this by itself.** It recognises a database left mid-upgrade, clears
  the stuck record and re-applies the migration, then carries on to the end — no commands to copy,
  no directory to be in. It does this only for migrations that declare themselves safe to re-run;
  anything else still stops and asks, because re-running a migration that isn't built for it can
  double the data it writes.
- Setup used to report only `Command failed: npx prisma migrate deploy`, throwing away the part
  that said which migration and why. It now prints what the database actually said.
- Verified end to end against three databases: a clean install, one left stranded exactly as
  reported, and one using a different text collation — all three complete with every row intact.
  Thirteen new tests check the migration history for the three portability traps behind this
  (documented in `docs/DATABASE.md`), so the next one is caught in review.

### 💻 "Active sessions" is a list of devices again

- **Signing in from the same browser no longer adds a new "device" every time.** Each sign-in
  created a fresh session record and nothing ever cleared them, so one person on one machine
  piled up thousands of entries — 7,486 live sessions for a single account on our own development
  workspace, almost all of them the same browser. The list whose entire job is "spot the session
  that shouldn't be here" was buried under its own noise, and "sign out this device" was unusable.
- A browser is now recognised across sign-ins and keeps **one** entry, which is refreshed rather
  than duplicated. A genuinely different browser or machine still gets its own, which is the point
  of the list.
- **Upgrading tidies up what's already there**, keeping each person's ten most recently used
  sessions and ending the rest. The one you're reading this on is kept — nobody gets signed out
  mid-shift, and from now on a session you're actively using is never ended to make room.
- The list now reads as **"Chrome on Windows 10/11"** with **when it was last used**, instead of a
  wall of `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36…`, and says which addresses
  are on your own network.

### 🕒 The maintenance window can't be scheduled in the past

- **The time list now stops at "now", the way the calendar already stops at today.** Half of the
  rule was there — you couldn't pick an earlier *day* — while the times offered all forty-eight
  half-hour slots regardless. So on an afternoon you could pick 9 AM, read a form that looked
  entirely valid, press Save, and only then be told the window can't start in the past.
- Times that have passed are greyed rather than removed, with one line saying why, and **the list
  opens on the first time you can actually pick** instead of at midnight.
- The window's **end** is held to the start the same way: everything up to and including the start
  time is unavailable, because a window that ends when it begins is zero-length.

### 📊 Project utilization you can actually read

- **The axis labels stopped colliding.** Eight project codes were competing for a third of the
  page and drew on top of each other. The two dashboard charts are now stacked at full width, and
  utilization turned on its side: project names sit in a gutter, one per row, at full length —
  so they cannot collide however many projects a workspace has, and the chart grows downward
  instead of squeezing sideways. Each bar prints its hours, no hover needed.
- **On a phone it becomes a doughnut**, with a colour per project and a legend that names each one
  with its hours and its share of the total. The chart carries the shape of the answer; the legend
  carries the answer — arc lengths are a poor way to compare close numbers.
- Colours are one validated, colourblind-safe set shared with the day timeline, and they follow the
  **project**, not its rank — a quiet month reorders the chart without repainting it.

### 🧾 One timesheet entry, readable and correctable

- **Every logged entry now opens in full** — from the approvals queue, from History, and from the
  dashboard's day timeline, all three into the same panel. Who logged it, against which project,
  module and ticket, the whole task text and notes, who reviewed it and when, and the identity
  badge.
- **Attachments are downloads, not a number.** The approvals dialog used to say "2 file(s)" with
  nothing to click — an approver was being asked to sign off hours on the strength of evidence the
  screen could see and they could not. They are links now, and files can be added to or removed
  from an entry after the fact.
- **History filters by activity and by person** as well as status, project and date. The person
  filter appears only when you can see more than your own work.
- **History says who logged each entry and who last changed it.** A "Logged by" column appears
  whenever the page shows more than one person's work (an admin's History returns everybody's and
  used to name nobody), and any entry somebody corrected now carries an **Edited** badge naming
  them — louder when it wasn't the author. The reviewer is shown too.
- **The day timeline opens the block you clicked.** Every block used to be a link to the History
  *page*: you clicked a specific 3.5h block on a specific person's lane and arrived at a list of
  everything. It opens that entry in place now, with the day and the lane still on screen behind
  it. History rows open the same panel, and the URL carries the entry, so a link points at one
  entry rather than at "the list".
- **You can fix your own entry while it's still undecided** — draft or submitted. Editing used to
  stop at submission, so changing one word meant asking your approver, whose only way to hand it
  back is a rejection. Your approver is told when a submitted entry changes, so they re-read it
  rather than deciding on what they saw before. Once a decision is recorded — approved or rejected
  — the entry is fixed: log a fresh one instead of rewriting the one that was ruled on. A rejected
  entry can no longer be deleted either; it is the record of a decision, with the reason attached.
  It also **no longer blocks its time slot**, so the corrected entry you log in its place is
  accepted rather than refused for overlapping the one that was refused. Rejected hours are left
  out of your "Logged hours" total for the same reason — re-logging refused work should not read as
  having worked it twice.
- **A saved draft can finally be sent.** "Save draft" wrote a row nothing could ever submit, so a
  draft could be edited forever and never actually reach an approver. There's a **Submit for
  approval** button on the entry now, and it does everything submitting from the logging form does.
- **Approve and reject from wherever you opened the entry** — the dashboard's day timeline included.
  It used to show you the whole entry and offer nothing to do about it, so you'd read it, agree,
  and then go to another screen to find the same row.
- **Managers and super admins can correct anyone's entry** — project, module, activity, times,
  date, description, notes — while it is still undecided, and every change is recorded field by
  field with the person who logged it notified.
- **Once a decision is recorded, the entry is fixed for everyone — reviewers included.** Approved
  hours carry a frozen rate and may already sit behind something a client has seen; a rejection
  carries the reviewer's reason. Corrections are a new entry, not a rewrite of the old one.
  Every change is recorded field by field with the before and after, and the person who logged it
  is told when somebody else edits it. An approved entry's frozen billing rate is never
  re-resolved: if the hours change, the amount is recomputed from the rate that was already
  captured, so last quarter's work is never quietly repriced at today's rate.

### ⚙️ Activity types are yours to define

- **Add, rename, enable, disable and delete the activities people log time against**, from the
  Projects screen. The list had been hard-coded to twelve words since the first release, so a
  workspace running "Incident response" or "Client call" had no way to say so. The logging form
  and the report filter both read the workspace's own list now.
- Disabling takes an activity out of the picker and leaves every entry ever logged under it
  readable. Deleting is only offered for one nothing was ever logged against — anything else is
  refused with the count and a pointer at disabling, because the approvals filter and every grouped
  report build their options from this list.

### ✍️ Writing surfaces that behave like editors

- **The New-ticket dialog stays inside the window.** It had no height limit, so a long description
  pushed the title off the top of the screen and the Create button off the bottom, with no
  scrollbar to bring them back — you could keep typing and could no longer submit. The dialog now
  pins its header and footer and scrolls the middle, and the same cap was applied to *every* dialog
  in the app, which closes the whole class of bug at once.
- **Paste a stack trace, a query, a config block or a shell session and it formats itself as
  code** — indentation intact — in ticket descriptions, ticket comments, and timesheet task
  descriptions and notes. Pasted lists, headings and quotes become real lists, headings and quotes.
  Prose that merely mentions a command stays prose.
- **Refine with AI no longer flattens code.** Refining a description that contained a snippet used
  to hand it back as a paragraph with the indentation gone. Code now survives the round trip
  untouched, and the model is told never to spell-correct inside it.
- **Attach files while raising a ticket**, instead of creating it, finding it again and opening the
  Files tab.

### 📤 Email that stops hitting the provider's rate limit

- **Sending is paced.** Each email used to open its own connection and go immediately, so approving
  twenty timesheets in one go — or the daily reminder run across a fifty-person workspace — opened
  twenty or fifty connections in the same instant. Most providers allow a handful. Sends now share
  a small pool at a configurable rate, and anything over it waits its turn instead of being
  rejected.
- **A refused send is retried instead of lost.** A "too many messages, slow down" reply used to
  mark the email failed, permanently, with nothing to re-drive it. Deferred mail is now retried on
  a backing-off schedule for about half an hour before it is given up on — and a genuinely
  undeliverable address is still recognised as permanent and not retried at all, which is what
  keeps a bad address from becoming a reputation problem.
- **The rate is a setting**, on Workspace Settings → Mail server: simultaneous connections,
  messages per window, and the window. Defaults sit under Office 365's limits.
- Password-reset and one-time-password emails are deliberately **excluded from the retry queue**:
  retrying them means storing the live link, and a reset link that expires in half an hour is worth
  nothing by the time a retry would run. Asking for another one is a click.

### 🪟 The ticket panel is a window now

- **Maximize to full width, restore, or drag its edge to any width in between** — and it reopens
  at the width you left it. This is the screen where a description, a comment thread, pasted code,
  a proofing image and a twelve-column activity log all have to be read and edited, and at its old
  fixed width a stack trace wrapped into unreadable ribbon.
- The drag handle answers to the keyboard too: arrow keys resize, Home maximizes, End restores.
- **Files moved next to Comments**, where it belongs — the two are read together, and Files used to
  sit eighth, past four other tabs and often off the end of the row.

### 🔐 Fixed: a password change that changed nothing

- **The "new password" box accepted the password you already had.** This bit hardest exactly where
  it was most likely — the first sign-in after an administrator created or reset your account.
  Re-entering that password cleared the "choose your own password" prompt and reported success,
  leaving an account whose password an administrator still knows. It is now refused by the form
  while you type, by the API, and on the emailed reset link, which had the same hole.

### 🤖 The agentic layer

- **A per-capability autonomy ladder** — Suggest / Apply / Act — set by a super admin in the AI
  tab, with product-enforced ceilings the UI shows greyed-out with the reason. Timesheet
  approvals, identity policy, and anything leaving the workspace can never run unattended, and
  the screen says so — that sentence is the audit answer.
- **Proposals with real undo**: every AI-suggested change is a row a person accepts or rejects,
  stale-checked against what it was computed from, and reversible afterwards without clobbering
  anyone's later edits. Auto-apply is the same envelope with the same undo, never a second path.
- **Agent runs**: bounded, abortable, fully traced executions — step and cost ceilings that stop
  a run rather than fail it, a taint clamp that strips write authority the moment outside text is
  read, and a live trace panel in the AI tab. A model-driven loop chooses tools from a
  per-capability allowlist; repeated and circling calls are refused by the envelope, and the last
  step is always reserved for the answer.
- **Every declared proposal kind now has a producer**: schedule-conflict fixes from the solver's
  own arithmetic (Timeline), committed-end-date realignment from measured slip (Portfolio), and
  blueprint instantiation as a reviewable change set (`/app/blueprints`, a new page).
- **The quality loop is closed**: agent steps are captured replayably, rated from the datasets
  browser, promoted into golden sets, and scored by the eval runner. A rejected or undone
  proposal names the exact interaction to correct. Secret-shaped content in CI-log and
  scanner-finding captures is redacted, structure preserved.
- **The AI budget is a reservation, not a check** — concurrent calls can no longer jointly
  overshoot the monthly cap.

### 🎨 UI/UX

- One visual grammar for AI everywhere: an orbiting border glow while a model works on a
  container, gradient labels on the buttons that invoke it, flowing strands while an answer is
  produced — all theme-token derived, all still under `prefers-reduced-motion`. The grammar
  gained its frame: **every AI surface now sits in a BorderGlow card** (a mesh-gradient border
  that follows the pointer, with an intro sweep when an answer lands) — AI refine, plan
  breakdown, ticket suggestions and comment summaries, the status report, the identity policy
  copilot, Ask AI, and the email failure diagnosis all wear it, in both themes.
- Rendered rich text is finally styled (ticket descriptions, comments, and history rendered as
  bare tags before), code blocks land properly in the editor and every rendered view, settings
  tabs are re-organized into grids, and the request-log and endpoint tables gained real
  pagination, search, and sort.
- **Bulk actions where reviewers actually batch**: the face verification log gained select +
  "Mark reviewed" (by ticked rows or by the whole filtered set, server-re-derived); Timesheet
  Approvals gained filter → select → bulk Approve/Reject with per-row refusal reasons, one
  identity check covering the whole batch, and a table that fits the viewport instead of
  side-scrolling (downloads moved into the entry dialog, where the entry is actually read).
- **The Dashboard day timeline lanes by person** — one row and one identity color per teammate,
  status carried by icons instead of color, inner scroll past four people, and an Expand dialog
  (full-width, filter + sort, closes on X/Esc/click-outside) for the whole team at once.
- **Calendars show what's on a day before you click it**: the Dashboard date picker and the
  Approvals range picker mark dates that have entries with a dot, and hovering (or keyboard
  focus) pops a count card — total / approved / submitted / draft / rejected in status colors.
- The sidebar collapses to a slim icon rail with tooltips, remembered per browser, with the
  toggle in the header row where slim-sidebar patterns put it — and every page reflows to the
  freed width with zero page-level code.
- **A phone-width overflow class was fixed at its mechanism and fenced with tests**: no-wrap
  truncated text inside a grid item (and recharts' stamped pixel widths) can hold a page wider
  than the screen after the viewport shrinks. The responsive suite now sweeps the email
  analytics tab, walks a render-wide-then-shrink path that reproduces the deadlock, and names
  the offending elements when an overflow check fails.

### 📬 Email deliverability — from a wall of SMTP text to a triage desk

- **"Why sends failed" now reads like a diagnosis, not a log.** Grouped failures are translated
  into plain language — *Provider temporarily refused (throttling)*, *SMTP sign-in rejected*,
  *Recipient address does not exist* — each with a "needs action / usually clears itself"
  verdict, what it means, and ordered first steps. Searchable and filterable by category; a real
  table on desktop, tappable cards on phones; the exact SMTP text, every recipient, and the
  affected domains one click away in the detail view. The translation is deterministic code, so
  the page stays legible with AI off entirely.
- **Grouping got honest**: provider session tokens are now collapsed *including* their ordinal
  suffix, so one Gmail throttling pattern no longer splits into six "different" errors.
- **An AI diagnosis on demand** (new capability, off by default like every AI toggle): one click
  sends a failure group's counts and SMTP text — recipient *domains* only, never addresses — for
  a case-specific reading: what it means, the likely cause, whether it will clear on its own,
  and concrete next steps. The group is re-derived server-side from the log, so the model only
  ever reads what the server measured.
- **Delivery by domain**: pick a date range and see, per recipient domain, delivered / failed /
  in-flight and a judged success rate (in-flight mail is excluded — it hasn't been decided yet),
  with a stacked daily chart. Domains that are bleeding get a *needs attention* headline with
  their diagnosis and first step; every domain row expands in place with its top failure reasons
  and the age of its oldest stuck in-flight message.

### 🏷️ Make it yours

- **Upload your company's logo** in Workspace settings → Branding, and optionally the name shown
  beside it. It appears in the sidebar and on the sign-in page — including before anyone signs
  in, which is the whole point of a login screen carrying your mark. Uploads are re-encoded
  (metadata stripped), scaled to fit rather than cropped square, and kept as PNG so a
  transparent logo doesn't turn black in dark mode. The preview shows both themes at once,
  because a mark that vanishes on one of them should be discovered here, not from a screenshot.

### 📊 Charts and labels

- **Bar charts state their numbers.** Project utilization, project hours, SLA compliance, cycle
  time and the security-findings chart all print the value on the bar instead of hiding it
  behind a hover — a number nobody can see is not a measurement.
- **Project charts use project codes on the axis**, with the full name in the tooltip. Two long
  names previously consumed the entire axis while every bar between them went unlabeled.
- **"SLA breaches" is now "Approval SLA breaches"** on My team and Reports, and "Approval SLA
  breach rate" in the latency panel. It counts timesheets that sat past their approval deadline;
  the ticket-side metric was already labeled separately, and one bare "SLA" across both was the
  ambiguity worth spending three words on.
- **The per-template email breakdown became a working table**: search, a scope filter (with
  traffic / with failures), sorting, a delivery-health bar per template, and a today-vs-yesterday
  trend arrow.

### 🐞 Fixed

- **Form fields no longer drift out of alignment** when a neighbouring field carries a helper
  line — the Profile timezone and the Timesheet ticket picker were the visible cases, fixed once
  at the shared form-item level so every current and future form inherits it.

- The AI tab's Project-risk, Plan-breakdown and Chat-triage switches failed to save with
  *"Unrecognized key(s) in object"* — the strict settings schema was missing three toggles the
  capability registry already shipped. Fixed, and a guard test now parses **every** registry
  toggle through that schema, so this class of drift is a failing build instead of a 400 an
  admin meets in production.

### 🚢 Deployment

- Kubernetes first installs complete in one shot (the migration hook ordering could previously
  never succeed with bundled MySQL), the web image's API upstream is configurable instead of
  hardcoded to the Compose service name, and the API image can run its own documented seed
  commands. The Helm chart, Compose files, and installers were verified end to end on a live
  cluster.
- Release history in What's-new now merges tag-only versions with this build's own changelog
  notes — versions no longer show "No notes were written" while the notes sit in the bundle.

### ⚡ Performance — measured, then fixed

All three deployment shapes (Windows-native, Docker Compose, Kubernetes) were run and
load-tested for real; every change below carries its measurement, and the full interactive
report ships in `reports/quality-load-report.html`.

- **The ticket list lost 60% of its weight.** It was serializing every ticket's full rich-text
  description — 391 KB per response against 25 ms of database time — for a list that renders
  titles. Now 150 KB (10 KB gzipped), +26% throughput, −21% p50, zero client changes.
- **Two new capacity knobs, both born from a measured ceiling** and wired through env, Compose
  and the Helm chart with defaults unchanged: `RATE_LIMIT_PER_MINUTE` (the blanket per-IP budget
  is per *egress* IP — an office NAT was one 900/min bucket) and `TENANT_DB_CONNECTION_LIMIT`
  (5 connections is multi-tenant arithmetic; single-org shapes ship 20, because 5 pinned the
  authed path near 90 req/s on pool queueing alone).
- **First installs no longer deadlock.** An unseeded API used to exit, restart too fast to seed,
  and defeat the installer's own wait-for-health-then-seed order. It now waits with
  `/api/health` serving and a loud log until the one-time seed lands.

## 2.3.0 — your assistant can drive it, and the model is on a short leash — 2026-08-08

Two additions that point in opposite directions and belong in the same release. TimeSphere now
speaks **MCP**, so your own AI assistant can read and act on this workspace from wherever you
already work. And because that widens what a model can touch, the AI surface it widens got audited
first — every path where a stranger's text reaches a prompt, and every place a model's answer was
trusted more than it had earned.

**Upgrading is a normal `./update.sh`.** One migration, additive. **Nothing turns on by itself:**
the MCP server ships disabled, its write tools ship disabled *individually*, and a workspace that
never opens the new settings tab has no endpoint listening at all.

---

### 🔌 MCP — connect your assistant to your workspace

- **TimeSphere is now an MCP server.** Point Claude Desktop, Claude Code, or a hosted agent at your
  workspace and ask it things — *"what's in my approval queue?"*, *"log two hours against
  HICS-ERP for the payment refactor"* — without opening the app. Enabled and configured by a super
  admin from **Workspace settings → MCP**.
- **Every tool runs as one specific person.** A credential is bound to a user, and each tool
  enforces the same permission that user would need in the app. An assistant connected with an
  employee's credential sees exactly what that employee sees — no more.
- **Nothing is on until you say so.** The server, the master write switch, and every individual
  write tool all start off. That third one is deliberate: a write tool added in a *future* release
  arrives switched off in your workspace rather than turning itself on during an upgrade.
- **Logging time creates a draft, never a submission.** Submitting starts an approval clock and can
  require an identity check — not something an assistant should do on your behalf.
- **The workspace it acts on is not something the assistant can choose.** It comes from the
  connection, not from anything the model can be talked into saying.

### 🛡️ AI guardrails — the audit that came with it

This app has always fed outside text to models: inbound email from strangers becomes a ticket, so
do Slack and Teams messages, CI logs, and scanner findings. That's six doors, and an assistant
reading a ticket is reading whatever the sender wrote. So before widening what AI can reach, we
went through what it could already be talked into.

- **A ticket's type could be set to anything by whoever emailed you.** The list of allowed types was
  sent to the model as a request rather than enforced on the way back — fine with one provider,
  not with another. Priority and module were already pinned; type wasn't. It is now.
- **One upload could spend the whole month's AI budget.** A findings ingest ran AI triage for up to
  500 items at once, and all 500 budget checks read the same figure before any of them recorded
  what they'd spent. Every individual check passed while the total sailed past the cap. Now
  sequential and capped.
- **The AI planning copilot proposes and never applies — that held.** What didn't: *who* was allowed
  to accept a proposal. Approving one was gated on a permission held workspace-wide, so someone
  outside a project could accept changes to it. Now scoped to the project, like everything else.
- **A model's answer is no longer taken as permission.** When AI suggests an assignee or a parent
  task, that person must actually exist and be active, and that task must be in the same project,
  before anything is applied. Previously the suggestion was applied on trust.
- **AI limits are now per person, not per network address** — one account could previously spend
  another's allowance from a different connection.
- Also fixed: an AI-invented ticket reference could crash a duplicate check, and one AI-written
  ticket comment stored raw model output where its two siblings escaped it.

**Checked and found correct**, so the record shows it: no AI path can skip the master switch or the
budget; no prompt can be built from another workspace's data; nothing sensitive — biometrics,
password hashes, tokens, keys — can reach a prompt or a stored AI log; and model output never
reaches a database query, a shell, or a file path.

### ✨ AI refine — a suggestion, not a replacement

- An **AI tidy-up button beside the fields you write for other people to read**: timesheet task
  descriptions and notes, ticket titles and descriptions, and ticket comments.
- **It never silently replaces what you wrote.** You see your text and the suggestion side by side,
  and nothing changes until you press **Use this**. **Undo** puts your original back — and quietly
  disappears once you start typing again, because by then "undo" would throw away your own edits.
- Replaces two older *"Improve with AI"* buttons on the ticket screen that **did** overwrite what
  you'd typed, with no preview and no way back.
- **It cannot embellish, and that's the point.** A timesheet description is a record an approver
  signs and an auditor may read, so refining is constrained to grammar and clarity: it may not add
  a fact, change a number, date or ticket reference, or make a claim stronger — *"mostly working"*
  will not come back as *"working"*.
- Off when AI is off or the budget is spent, and it says which — rather than failing when you click.

### 🔐 Also hardened

- **A captured SSO response could be replayed** for the life of its validity window; sign-in now
  remembers which request it issued and accepts only the matching answer.
- **A GitHub connection link could be reused** within its ten-minute window; it is now single-use.
- **Which workspaces exist, and their state, is no longer probeable** — an unknown, suspended, and
  still-provisioning workspace now answer an outsider identically, while a signed-in user still
  gets the real reason.
- Two internal tables that grew for the life of the server process are now swept.

---

## 2.2.0 — what the code assumed, and what it actually did — 2026-08-07

A security release. The theme is a single question asked of every shared value in the system — *if
two organizations disagree about this, can both be right at once?* — and the number of places where
the code had quietly answered "yes" to something that could only be "no".

**Upgrading is a normal `./update.sh`.** One migration, additive, and deliberately reversible: the
plaintext token columns it replaces are kept alongside the new hashed ones so a rollback cannot
strand every outstanding approval link.

**One thing you must set.** `TRUST_PROXY_HOPS` defaults to `0`, which preserves today's behaviour.
If anything sits in front of this API — nginx, a load balancer, Cloudflare — set it to the real
number of hops or your per-IP rate limits stay one shared global bucket. See below.

---

### 🔒 Security

- **`/uploads` served every tenant's attachments to anyone who asked.** A static mount over the
  storage root, filenames of the form `<timestamp>-<original name>` — guessable, not a capability —
  and no organization segment at all, so one flat directory held the whole platform's files and any
  hostname reached any of them. Reads now require an HMAC-signed, expiring, org-bound grant. The
  signature is minted at the API boundary rather than per-route, because a scheme that depends on a
  dozen controllers each remembering to sign is one forgotten route from reopening the hole.
- **Biometric captures were reachable the same way**, contradicting the app's own documented
  contract and bypassing the authorization on the endpoint that exists specifically to protect
  them. Also: a half-written upload was publicly readable *while it was being written*, because
  the temporary destination sat inside the served tree.
- **Guest approval links keep working**, with no special case. A reviewer's authorization is checked
  when their page is built, and the signature carries that decision to a file request that has no
  session — which is precisely what a signed URL is for.
- **The login lockout was cross-tenant.** It keyed on the email address alone and counted failures
  for people who don't exist in that organization, so five failed attempts against *any*
  organization's login page locked that address out of *every* organization. Unauthenticated,
  repeatable, and invisible.
- **Outgoing mail could carry another organization's identity.** Per-tenant SMTP settings were held
  in single shared variables, so one workspace could send over its own server with a different
  workspace's From address — and the Mail server panel could display another tenant's host,
  username and error text with no race required at all.
- **Six ticket routes had no project boundary.** The check they relied on grants access to anyone
  holding a workspace-wide ticket permission, which ordinary roles do. A team leader on one project
  could rename, transition, reassign, unassign or delete any ticket in the workspace, and the
  assignee suggester handed any project's member list to any employee.
- **Project rosters were readable by any signed-in user** — names, email addresses, roles — while
  the scoping helper that should have prevented it sat unused in the same file.
- **Sessions outlived their accounts.** Refreshing a token never re-checked whether the account
  still existed, and neither SCIM deprovisioning nor deleting a single user ended their sessions —
  so a removed person kept renewing access for weeks. Admin password reset had the same gap, which
  meant it could not evict the attacker it was being used against. Both now sign the account out
  everywhere.
- **Per-IP rate limiting did not work behind a proxy.** Without `trust proxy` set, every request
  appears to come from the proxy, so the 20/min login limiter and every other per-IP limit throttled
  the entire internet as a single bucket. The new `TRUST_PROXY_HOPS` is a **hop count, not a
  toggle** — trusting forwarded headers wholesale simply hands IP forgery to anyone who asks, which
  is not an improvement.
- **Private repository names, branches and pull request titles** were readable by any signed-in
  session from the GitHub proxy routes, which decrypt the workspace's stored token.
- **Guest and public tokens are now stored hashed**, so a database read no longer discloses live
  capabilities, and guest approval links expire after 30 days. Published intake form URLs
  deliberately do not expire — a form address printed on a support page that silently stops working
  looks like the product losing tickets. Unpublishing is how you revoke one. The form URL is now
  shown once, when you publish it.
- **Resending a guest approval link** minted a working link for any step id with no ownership check,
  contradicting that file's own header comment.
- **Sign-in leaked which email addresses are registered — found by timing it, not by reading it.**
  The response was already identical for an unknown address and a wrong password, so the code
  looked hardened. It wasn't: the password check was skipped entirely when the account didn't
  exist, so an unknown address answered in 6ms and a real one in ~200ms. A 30x tell. Sign-in now
  always does the same work either way, verified by measurement.
- **A malformed request body returned a server error** carrying the JSON parser's internal
  message, logging a stack trace each time — a cheap way to bury real faults in the log. It now
  answers with a plain 400.
- **Replay protection** was added for webhooks where the signing secret never leaves our server, and
  deliberately *not* where the credential travels with the request — there, anyone who captured a
  delivery captured the credential and can mint fresh ones, so a replay store proves nothing and
  rotation is the real control.

### 🗄️ Storage you can put somewhere else

- **`STORAGE_ROOT`**, plus per-subtree overrides, moves uploads off the application directory —
  where a relative default meant user files lived one `git checkout` from deletion. Documents,
  profile images and biometric data are separated so they can be backed up, or deliberately not
  backed up, on different policies.
- **Nothing moves and nothing is deleted.** Set none of it and paths resolve exactly as before.
  Relocation is non-destructive in both directions: files written before a move keep being read
  from where they are.
- Paths are **environment-only, not editable in the UI**, and that is deliberate. They are
  process-wide while a super admin is per-organization, so one workspace's admin saving a new root
  would silently redirect another workspace's uploads. That is the wrong scope for a setting, not a
  permission problem that validation could rescue. The new **Storage & logs** tab shows the resolved
  paths, whether they are genuinely writable, and validates a candidate directory for you.

### 📜 Logs that survive the night

- Log files where previously everything went to the console and vanished. Four-hour files inside
  per-date folders, the previous day compressed at rollover, and old days pruned on a retention
  window — with a catch-up pass at boot, so a server restarted every morning still honours
  retention despite never being awake for a rollover.
- Console output is untouched, and a log directory that cannot be written degrades to console-only
  with a warning rather than taking the server down.

### 🪪 Face verification — measured, not guessed

- **The numbers were being flattered by the test suite.** 66 of 80 scored checks came from an
  end-to-end script that enrols and verifies with the same image file and scores a perfect match
  every time. Averaged in, the workspace looked flawless.
- **Among real people, the head-turn step failed 47.5% of the time** — and the cause was that the
  progress meter had been written but never connected. The dialog ran its own duplicate loop that
  fired at exactly the required angle with no margin, ignored whether you had turned the right way,
  and abandoned the best reading on the first flicker. People were being asked to hit an invisible
  target. There is now one measurement feeding the meter, the shutter and the wording, so a full bar
  and a captured frame are the same event — and the refusal tells you *"about a quarter of the way"*
  rather than just "failed". **No threshold was loosened**; the ones who succeeded cleared the bar
  comfortably.
- **A warning before the shutter** when a second face appears, rather than a rejection afterwards.
  It warns rather than blocks, because the in-browser detector is guidance and letting it veto would
  strand anyone it misreads.
- **Thin enrollments now get chased.** Anyone enrolled from a single pose is offered the four-pose
  wizard inline, and admins get a list of who still needs it with a reminder action.
- **`npm run eval:face`** answers "would a better recognition model help?" with genuine-versus-
  impostor score distributions from your own data instead of an opinion — and on a small workspace
  it will tell you plainly that the sample is too small to conclude, rather than dressing up a weak
  result. It also surfaced that some genuine rejections were caused by the per-person adaptive
  threshold, which only ever tightens, rather than by the setting you can see.

### 🎨 Landing, pitch deck and sign-in, rebuilt

- All three rebuilt with real semantic structure, working keyboard focus, and **every animation
  behind `prefers-reduced-motion`**. They also got *faster*: the animation library is gone from all
  three, so a first-time visitor no longer downloads 39 kB (gzipped) of it to read a landing page.
- The landing page finally works on a phone — the section navigation previously just vanished below
  tablet width with nothing in its place. Capabilities are now filterable, and the plan badges are
  **derived from the same limits table the API enforces**, so a card can't promise something your
  tier will refuse.
- The pitch deck had two counts that disagreed with their own content ("four things" over five
  items, "three things" over four). Counts and slide numbers are now derived rather than typed, and
  two unverifiable claims were removed.
- Sign-in keeps every existing route — password, Google, Microsoft, SAML, LDAP, forgot-password —
  and adds a failure panel that **stays put while you retype** (a toast vanishes exactly when you
  need to reread it, and lockout messages need to persist), Caps Lock warnings, and a distinct
  label for the directory password field, since two fields called "Password" on one page is
  ambiguous to a screen reader.

### 🧹 Also

- **Who's online** now shows each person's device, browser, IP address and when their session
  started — from data the session record already held. Multiple devices for one person are grouped
  rather than double-counted, so the "N online" figure still means people.
- **Email channels** groups collapse, with a count of muted rows on each closed section so a
  collapsed group cannot quietly hide muted mail.
- **`npm run setup` now sets things up**: it creates your `.env`, mints development certificates if
  the machine has none, and — the part that matters on an upgrade — tells you which variables have
  been added to `.env.example` since your `.env` was written. A new feature flag that your config
  has never heard of looks like a broken feature, not an unconfigured one.
- **A fresh clone would not have started on Linux or macOS.** `.env.example` shipped a Windows
  absolute path as a live default for the log directory; the setup script copies that file
  verbatim, and the path validator is platform-native, so validation failed before the server ever
  booted. Now inert by default, like every other optional path.
- Request telemetry is **on by default in development** and off in production. A panel that reports
  "recording is switched off" to the person who just built it is a bad first impression.

---

## 2.1.0 — who gets the email, and why it was slow — 2026-08-07

Two questions this product could not previously answer about itself: **which people receive which
emails**, and **why a request was slow**. Both now have a screen. Alongside them, the approvals
queue finally shows an approver enough to approve on, and the identity log gained the analytics
that make its numbers mean something.

**Upgrading is a normal `./update.sh`.** Two migrations ship, both additive — one nullable column
and one new table — so the additive-only rollback policy in docs/DATABASE.md still holds and old
code runs correctly against the new schema. Nothing changes behaviour until an admin changes a
setting: the email matrix starts with every role ticked, and request telemetry ships switched off.

---

### 📬 Email: one screen that answers "who gets this?"

- **Email channels is now a category × role matrix.** Every notification category is a row, every
  role a column, and a tick means that role receives that email. The row's switch is still the
  master; the ticks choose the audience within it. Click a role name to mute or unmute its whole
  column.
- **Muting mutes the inbox, never the app.** The in-app bell notification is written before the
  mute is even consulted, so a muted manager still sees every escalation — they just stop getting
  a copy per report per day. This is what makes it safe to mute the roles that approve time rather
  than log it.
- **Fixed: six ticket categories had no user interface at all.** `emailTicketAssigned`,
  `emailTicketStatusChanged`, `emailTicketCommented`, `emailTicketSlaBreach`,
  `emailTicketEscalation` and `emailTicketClosedDigest` were enforced by the server from the day
  they shipped, but appeared on no screen — the only way to change one was a direct database
  write. They are rows like everything else now, and a compile-time check fails the build if a
  future category is ever added without one.
- **Fixed: the super-admin audit BCC ignored every setting.** With `bccSuperAdminOnAllEmails` on,
  every active super admin was silently copied on *every outbound email in the application* —
  including each employee's daily reminder, every day. That, not the category toggles, is usually
  why a super admin's inbox is unmanageable. The BCC now honours the SUPER_ADMIN row of the
  matrix, so muting a category genuinely empties the inbox instead of leaving the hidden copy
  arriving anyway.
- **Fixed: two settings had two switches.** The ticket-closed and weekly-security digests were
  toggleable from both Email channels and the Security/DevOps card, so two screens could each look
  authoritative while disagreeing. Security/DevOps now shows their state and points at the one
  place that sets it.
- **`welcome`, `reset` and email-intake replies are listed but not gateable**, under "Always
  sent". They go to one specific person as the direct result of an action, have no recipient
  account to read a role from, and a role filter over a password reset is an account lockout
  waiting to happen. They are shown so that "what does this app send?" has one complete answer.

### 📈 Email templates — volume, trends and why a send failed

- **Every template card carries a send count** and a today-vs-yesterday delta. Absolute, not a
  percentage: yesterday is zero for most templates and "+∞%" helps nobody.
- **A new Analytics tab** — per-template counts, volume by month/week/day, and delivered vs failed.
- **Failures are grouped by reason, with the recipients attached**, so a bounce is debuggable
  instead of being a number. Noisy SMTP strings are normalised for grouping and the verbatim
  message stays one click away.
- Two honest details in that data. `reminder.escalation` mails the employee *and* their manager
  under a single log category, so those two rows are marked **shared** and must not be summed;
  and anything that cannot be mapped to a template lands in an explicit **Other / unmapped**
  bucket rather than being dropped, because a silently discarded bucket makes every total a lie.

### 🚦 Maintenance — why it was slow, when, and on which server

- **API performance**, a new opt-in panel: latency percentiles (p50/p95/p99), slowest endpoints,
  error rate, a latency time-series, a per-host/pod breakdown, and a filterable request log with
  the slowest individual requests.
- **Database time is measured, not estimated.** Each request accumulates the real duration of its
  own Prisma operations — raw queries included — so "this endpoint is slow" separates into time in
  the database and time in the handler.
- **Off by default, and cheap when on.** The middleware sits in the hot path of every request, so
  the disabled path is a single boolean test; nothing is awaited in the request lifecycle; rows
  buffer in memory and flush in batches; the buffer drops and *counts* past its ceiling rather
  than growing; and requests are sampled at a configurable rate. On a busy deployment turn the
  rate down rather than the feature off — percentiles from a 10% sample are still percentiles.
- Routes are recorded as **patterns** (`/api/projects/:id`), never raw URLs with ids in them,
  which is the difference between a slowest-endpoints table and thousands of single-request rows.
- Nothing sensitive is stored: no bodies, query strings, headers, cookies, IPs or user agents. The
  user id is the whole of the identity recorded, and names are joined at read time — so the table
  never holds a person's details and a deleted user simply disappears from the view.
- **A caveat worth knowing before you read the numbers:** CPU, memory and disk come from a
  snapshot refreshed every ~15 seconds, not measured per request. Measuring CPU properly means
  sleeping between two kernel readings, which is fine for a health card and catastrophic in a
  request path. Those columns describe the machine *around* a request, not during it.
- Rows accumulate with traffic and are pruned nightly at 04:10, keeping 14 days by default.

### ✅ Approvals — enough context to actually approve

- The queue gained **search** (across name, email, task and notes), **project/status/activity
  filters**, a **date range**, row numbers, the **module and submodule** under the project, the
  **time frame with hours**, when the entry was **last updated**, and **notes** where present.
- **Tapping a name opens the full detail** — on desktop as well as mobile — with Approve, Reject
  and a **download of that one entry**.
- None of this needed a schema change: the endpoint had been returning module, submodule, notes
  and task description all along, and the screen simply never showed them.
- The list is capped at 100 rows and does not paginate. Rather than quietly change that, the table
  now says when the cap is reached instead of implying there is nothing older.

### 📄 Timesheet exports, rebuilt

- **Excel** — a Summary sheet, a frozen and autofiltered header, real date/time and numeric cell
  types instead of strings, per-group subtotals and a grand total.
- **PDF** — a proper header block, a table header that repeats on every page, task descriptions
  that wrap rather than clip, status in the app's own colours, and `Page X of Y`.
- An empty result now produces a valid one-page document saying so, rather than an empty file.

### 🪪 Identity checks — analytics, and a clarification that matters

- **New charts**: outcome breakdown, outcomes over time, a review funnel, and enrollment coverage.
- The funnel keeps **pending, human-reviewed and auto-triaged as three distinct states** and never
  sums them into one "handled" number — they mean very different things when you are deciding
  whether a policy is working.
- **"Mark reviewed" does not retrain anything, and never did.** It clears the flag and records who
  looked, and that is all: it does not accept that face, add the capture as a reference, or change
  any threshold. There is no adaptive re-enrollment in this product — the only way a person's
  reference changes is completing the guided enrollment again, which *replaces* their templates.
  Said plainly here because expecting otherwise leads to reviewing failures that were never going
  to improve on their own.
- What *is* adaptive is the per-person match threshold, and it only ever tightens — worth knowing
  if specific people keep failing.
- **Fixed:** `LOW_QUALITY` was missing from the outcome filter despite being one of the largest
  failure buckets; `SKIPPED_INSECURE` was written to the database but absent from the type that
  was supposed to enumerate every outcome; and "Mark reviewed" now lets you leave the note the API
  had always been able to store.

### 🧹 Smaller things

- **My Team** — clicking a direct report shows their hours week-by-week for the current month and
  month-by-month for the trailing year. Scoped so a manager only ever sees their own reports.
- **Timesheet form** — a failed submit now scrolls to and focuses the first invalid field and
  names it. Every select on that form is a custom control, so the form library held no reference
  to focus and a rejected submit had simply looked like a dead button.
- **Projects** — a row number and the project's creation date, sortable.
- **Verification log** — a refresh button, so checking for new attempts no longer means reloading
  the whole page.

### Upgrading

- `./update.sh` handles everything, including fanning the two migrations out to **every tenant
  database** — this product runs a database per organization, and a migration that only reaches
  `DATABASE_URL` leaves every other org on the old schema. A manual or non-Docker deployment must
  run `npm run migrate:tenants -w apps/api` itself. See docs/DEPLOYMENT.md.
- Request telemetry stays off until you set `API_TELEMETRY_ENABLED=true`. See `.env.example` for
  the sampling, flush, buffer and retention knobs, and the Kubernetes pod/cluster identity vars.

---

## 2.0.0 — the planning layer — 2026-08-06

Turns TimeSphere from an execution tracker into a project-management platform: plans, schedules,
capacity, intake, approvals and an AI copilot that never writes on its own — plus a rebuilt face
check, real user management, per-feature AI cost visibility and a status page with a memory.

**Nothing here changes how an existing workspace behaves until an admin turns it on.** Every
planning capability ships off by default and upgrading is a normal `./update.sh`. With every
switch left alone, one thing is different from 1.1.0 and one thing only: a **My work** entry in
the sidebar, a personal queue over ticket dates that already exist and needs no setup. Every other
planning page stays hidden, and every planning endpoint refuses with a 403 that says which switch
is off and who can turn it on — verified against a running install with every toggle cleared.

Major version because the data model grew substantially and the product now competes in a
different category, not because anything was removed. There are no breaking changes: no endpoint
changed shape, no column was dropped, and every existing integration keeps working.

**If you read one section, make it the fixes.** Three of them were features that had been recorded
as delivered and were not, and the way each was found — reading what the system had already
recorded, rather than reasoning about what it should do — is the most useful thing in this release.

---

### The planning layer

#### ✨ Phase 1 — foundation

- **Workspace Settings → Planning** — one new tab holding the planning master switches, the
  working-week and default-capacity settings, custom fields, and the workflow editor. Each toggle
  shows whether your plan actually includes the feature, so a switch can never be on while the
  API refuses it.
- **Custom fields** — admin-defined extra fields on tickets and projects (text, number, date,
  select, checkbox, person, currency, link). Filterable and reportable, not free-text notes.
- **Custom workflows** *(Enterprise)* — define your own statuses and transitions per ticket type.
  Every custom status declares which built-in status it behaves like, so SLAs, reports, exports,
  webhooks and the public API keep reading exactly the values they always have — renaming
  "In review" to "Legal review" changes the board, not the data.
- **Schema for everything that follows** — work-item hierarchy and dates on tickets, scheduling
  dependencies with lag, portfolios, saved views, capacity and resource bookings, project
  budgets, request forms, blueprints, approval chains, proofing annotations, custom dashboards,
  scheduled reports, and the human-in-the-loop AI proposal tables.

#### ✨ Phase 2 — planning & views

- **Timeline (Gantt)** — the whole plan on one chart: hierarchy, start/end dates, dependencies
  with lag, milestones, baselines, and the critical path. Drag a bar to move it, drag its edge to
  change its length. Reachable from the new **Plan** nav section or as a tab on Tickets.
- **Dependencies that mean something** — four scheduling relationships (finish-to-start and its
  three siblings) with working-day lag. A dependency that would create a loop is refused as you
  add it, naming the items involved, rather than quietly producing a wrong timeline.
- **It tells you when a plan is inconsistent, it doesn't overrule you** — if a date contradicts a
  dependency the bar stays exactly where you put it and the conflict is reported. Nothing is ever
  rescheduled behind your back.
- **Baselines and slip** — freeze the agreed dates, then see how far each item has moved from
  them. Never refreshes itself, because a baseline that follows the plan makes everything look
  permanently on time.
- **Calendar view** — a month grid that distinguishes work you have actually scheduled from work
  that only has an SLA date, so it is useful on day one rather than looking empty.
- **My work** — everything assigned to you across every project, bucketed into overdue, today,
  this week, blocked and later. Blocked items are listed separately so they never sit at the top
  of your list pretending to be startable. Available to everyone, no setup required.
- **Portfolio** — delivery health across projects: schedule vs planned end, effort-weighted
  progress, budget vs burn, and a forecast at completion. Every figure is derived from the plan
  and the approved hours you already have; the forecast stays blank until there is enough data
  for it to mean anything.
- **Project budgets and planned dates**, plus optional portfolio grouping.
- **Saved views** — keep a filter/column/sort combination per view type, private or shared.

#### ✨ Phase 3 — resource & budget

- **Workload board** — every person's capacity, week by week, coloured by how booked they are.
  Each cell shows the hours planned *and* the hours actually logged, so a forecast can be checked
  against what really happened rather than against another forecast.
- **Per-person capacity** — contracted weekly hours and an expected utilisation percentage, so a
  part-timer and a fully-loaded person are modelled properly instead of with one fudged number.
  Anyone without their own figure follows the workspace default.
- **Bookings** — reserve someone's time against a project or a work item, or mark it as leave.
  Hours are per *working* day, so a five-day booking at 4h/day is 20 hours, not 28. Leave reduces
  what's available rather than counting as load, so a week off reads as unavailable, not busy.
- **Double-bookings are shown, not blocked** — splitting a person across two projects for a
  fortnight is sometimes exactly the plan, and refusing it would just make people record
  something untrue. Being booked to exactly 100% isn't flagged either; that's fully booked, which
  is the point.
- **Project budgets** — budget, spend, and a forecast at completion, on the project's billing
  panel. The forecast stays blank until there's enough progress and spend for it to mean
  anything, rather than reporting a confident zero.
- **Estimate accuracy** — how far finished work ran over or under its estimate, reported as a
  median so one runaway task doesn't distort the picture. Turns the hours you already collect
  into better estimates next time.

#### ✨ Phase 4 — intake & approvals

- **Request forms** — build an intake form with conditional questions ("only ask for steps to
  reproduce if they said it's a bug"), then publish it to a link that works for anyone, with no
  account. Every submission becomes a ticket immediately and lands in a review inbox, so nothing
  sits in a queue waiting to be noticed.
- **Publishing is its own decision.** Creating a form doesn't expose it; withdrawing a link kills
  that URL permanently rather than hiding it behind a flag.
- **Blueprints** — save a project's shape and stamp it out again against any start date. Dates
  are stored as offsets, so a blueprint stays reusable instead of being a copy of last quarter.
  Preview exactly what will be created before it's created, or learn a blueprint from a project
  that already ran.
- **Approval chains on work items** — ask colleagues, people outside the company, or both, in
  order or all at once. External reviewers get a single-use link that needs no account and shows
  them only what they're reviewing. One rejection settles the request and stops asking everyone
  else; the remaining links stop working immediately.
- **Proofing** — drop a pin on an attached image or PDF and comment on that exact spot. Comments
  stay anchored at any zoom or screen size, and resolving one keeps it as a record rather than
  deleting the reason a change was made.

#### ✨ Phase 5 — the AI planning copilot

- **Project risk scoring** — every project gets a 0–100 delivery-risk score from six measured
  signals: schedule slip against baseline, budget forecast, blocked work, over-allocation, SLA
  breaches and rework. The full breakdown is stored with the score, so "why is this red?" always
  has an answer, and the same inputs always give the same number. **It works with AI switched off
  entirely** — only the plain-English summary needs a model.
- **AI suggestions are suggestions.** When the assistant proposes work — breaking a goal into
  tasks, for instance — nothing is written. Every change lands on a review page where you tick the
  ones you want, see exactly what each would change, and apply only those. There is no
  apply-everything button, on purpose.
- **Somebody else's edit is never quietly reverted.** If an item changed after a suggestion was
  made, that row is refused and tells you why, while the rest still apply.
- **Nightly risk snapshots** build a history, so you can see whether last week's intervention
  actually helped rather than only how things stand today.

#### ✨ Phase 6 — dashboards, delivery and the finish

- **Custom dashboards** — build your own view from a fixed catalogue of tiles. The catalogue is
  closed on purpose: "open items" is one definition, so two dashboards showing it cannot
  disagree. Share one and every viewer still sees only their own projects, so publishing a layout
  never publishes data.
- **Scheduled delivery** — email a dashboard daily, weekly or monthly to people who don't have an
  account. Built with the sender's access, and it stops itself if that person leaves.
- **The product tour** now covers the planning pages, and only the ones your workspace actually
  has switched on.

#### 🛡️ Fixed during the release audit

- **25 planning endpoints now enforce the entitlement they belong to.** Creating things was gated
  and much of the rest was not, so with a feature switched off you could not create a request form
  but you could delete one, resend an approval email to an external reviewer, or accept a
  submission. The same gap meant a downgraded workspace kept read access to capabilities it had
  stopped paying for. Every one now refuses with a message naming the switch that is off.
- **The ticket detail sheet no longer shows Plan and Approvals tabs to workspaces that have those
  features switched off.**
- **Proofing and saved views now have a user interface.** Both had shipped as working APIs with
  nothing calling them — proofing especially, since Workspace Settings carries a toggle for it.
  You can now click an attached image to pin a comment to a spot on it, reply, and resolve; and
  name a set of ticket filters to get back in one click.

---

### Everything else in this release

#### 👥 User management — find people, and act on more than one at a time

- **Filter by role, job title, status and who's online**, and search across name, email, job title
  *and* role name — people think in "find the managers", not "set the role dropdown".
- **Real pagination.** The list previously fetched the first 50 users and filtered them in the
  browser, so in an org with more than fifty people the search box was searching a page rather
  than the company, and quietly found nobody.
- **Bulk actions** — deactivate, reactivate, reset password, resend welcome, sign out everywhere,
  delete. Tick a page, or choose "select all N matching this filter", which are kept as separate
  deliberate choices: blurring them is how somebody deactivates a department believing they
  deactivated a screenful.
- **Refusals are per person, not per batch.** Acting on a super admin without being one, or on
  your own account, skips that row and says why instead of failing everything half-applied.
  Deactivating also ends the person's sessions — otherwise they keep working until their token
  expires, which is not what the word means to whoever clicked it.
- Deleting or deactivating asks you to type the number affected. "3" and "30" look alike in a
  toolbar and neither can be undone from that screen.
- **Fixed:** every assignee, manager and approver dropdown in the product silently omitted most
  people in orgs with more than fifty users.

#### 📊 AI settings — where the tokens actually go

- A new **per-feature breakdown**: input, output and total tokens, calls, average per call, share
  of the total, and which models each feature used — as a cumulative chart, a day-by-day stacked
  chart, and a sortable, filterable table.
- Reported in **tokens first, cost second**. The cost figure is an estimate from a price table; it
  moves when a provider changes prices and it is simply wrong for anyone using their own key with
  negotiated rates. Tokens are what was actually consumed, and what a prompt change actually moves.
- Days with no activity are shown as zero rather than skipped, so a quiet week looks quiet instead
  of looking like a gap in the data.

#### 🚦 Maintenance — a status page with a memory

- **Every feature is probed every five minutes** — sign-in, timesheets, tickets, reports, files,
  email, AI, face verification, planning, integrations, and the databases underneath them — with a
  day-by-day history strip, uptime percentages and an incident log, in the shape of the public
  status pages people already know how to read.
- This answers the question the existing Server health panel structurally could not: **"was it
  down on Tuesday, when I couldn't submit my timesheet?"** CPU and memory graphs describe this
  instant; a server at 12% CPU is perfectly healthy right up until nobody can submit anything.
- **A day is coloured by its worst check, not its average** — averaging is how a two-hour outage
  becomes a 96%-green day and disappears, and finding the bad hour is the whole point.
- **Days with no data are grey, never green.** A page that reports "we weren't monitoring" as
  "nothing was wrong" will confidently deny an outage that happened, so "All systems operational"
  isn't claimed until something has actually been measured.
- Incidents are recorded rather than recomputed, so they outlive the raw samples they came from —
  that record is exactly what somebody comes back to months later.

#### 🐛 Fixed — settings that appeared not to save, and Copy buttons that lied

- **Settings forms no longer discard what you typed.** Three cards (face verification, mail
  server, AI prompts) re-seeded their inputs from the server every time the underlying query
  refetched — which happens after any save on the same card, and on window focus. So typing a new
  match threshold and then flipping an unrelated switch silently reverted the box, and pressing
  Save then re-saved the **old** value and reported success. The setting looked like it would not
  persist; what actually happened is that it was never sent.
- **Copy buttons now work over plain HTTP, and tell the truth when they cannot.**
  `navigator.clipboard` only exists in a secure context, so on an on-prem LAN address or a phone
  four of them threw outright and the rest silently copied nothing while showing "Copied!". There
  is now a single helper with a legacy fallback that works on insecure origins and older Safari.
- **The camera's HTTPS message now names the address you are on** and points at the deployment
  guide, instead of telling an admin to "enable HTTPS" with no indication that the URL was the
  problem.
- **Tenant databases that had fallen behind** are migrated by `migrate:tenants`; one org in this
  workspace was still on the last V5 migration, which made every per-org background job log an
  error for it.

#### 🌐 Browser and OS support, verified

Chrome, Edge, Opera, Brave (Chromium), Firefox (Gecko) and Safari (WebKit) are now covered by
actual test runs rather than an assumption — including iOS, where every browser is WebKit whatever
its icon says. The server runs in Docker, so macOS, Windows and Ubuntu differ only in which
installer script starts it. See "Browser and OS support" in the deployment guide, including the
things that genuinely need HTTPS and what degrades gracefully without it.

#### 🗓️ Calendars and date pickers, rebuilt

- **Every date and time input in the product** — fifteen of them, across ten screens — replaced
  with three purpose-built pickers: a **date-range picker with presets** ("This month", "Last
  week"…), a **date picker**, and a **date + time picker**. Built on React Aria for real keyboard
  and screen-reader behaviour, styled with the app's own theme so dark mode works everywhere, and
  identical in every browser instead of inheriting each one's native widget.
- A range is now **one control with one validity rule** — nothing can set an end before a start,
  and "last month" is one click instead of two taps and a mental calendar.
- **The month calendar view got the same redesign**: coloured event chips per delivery state (a
  month of amber is a review bottleneck you can see from across the room), a "N more…" count when
  a day overflows, and a cleaner header with a stepped Today control. Unscheduled items keep their
  dashed outline — an SLA date still never dresses up as a commitment.
- Timesheet start/end times use **segmented time fields** rather than time slots, because people
  genuinely log 09:15–10:45 and a half-hour grid would have made valid entries impossible.

#### 📈 Analytics, and Excel

- **Utilisation** — logged hours against each person's real contracted capacity, over any range.
  It reuses the workload board's own capacity calculation, so the two can never disagree about the
  same fortnight. Anyone with no contracted hours on file shows "—" rather than 0%: a zero would
  read as "this person did nothing" when the truth is that nobody recorded their hours.
- **Approval latency** — median, 90th percentile, slowest, and a per-approver breakdown, plus the
  SLA breach rate. This needed a new `submittedAt` timestamp: the submit path computed one, used
  it to derive the approval deadline, and threw it away. It is now stored, so **latency starts
  filling in from today** and historical entries are reported as "can't be timed" rather than
  guessed at. The breach rate works immediately — it reads the approval deadline, which was
  always stored.
- **Where the hours went** — activity mix per range with shares and cost, as a chart and a table.
  Useful for the question a status meeting actually asks: how much of this project went to bug
  fixing rather than building.
- **Excel export** — a real workbook with a Summary sheet (your current grouping) and an Entries
  sheet with every row properly typed, frozen headers and an autofilter. CSV has no types, so
  dates and numbers arrive as text and have to be re-typed before anyone can pivot.

#### 📄 Reports you can actually filter — and a PDF that no longer lies

- **Both exports now take filters** — date range, project, person, status, activity, billable.
  They previously took none at all: one button meant *every timesheet in the workspace, for all
  time, for everybody*, and there was no way to ask for one project or one month.
- **A grouped report** with nine groupings — by person, project, module, activity, status, ticket,
  day, week or month — so "where did Apollo's hours go?" is answerable on screen instead of by
  exporting everything and pivoting it in Excel. Every grouping of the same rows totals to the same
  number, which is asserted rather than assumed.
- **The CSV gained the columns that make an export worth having** — billable flag, frozen rate and
  amount, ticket key, who reviewed it and when, approval deadline and SLA breach time. It went from
  13 columns to 22, and now opens in Excel without mangling accented names.
- **Fixed: the PDF silently truncated at 500 rows** while printing a total computed from only those
  500. Past 500 entries it stated a number that was simply wrong, with nothing on the page saying
  so — in a file somebody might hand to a client. It now carries far more, prints its own scope,
  and says plainly in the header and the footer when it is showing a subset. Both exports also
  return that as a response header, since a caller scripting an export cannot parse a PDF to
  discover the document is partial.
- **Cost reads "—" rather than "0.00" when no rate was ever captured.** Zero claims the work was
  free; a dash says we do not know, which is the truth for entries approved before rate snapshots
  existed.

#### 🛡️ Fixed in the status page, found by its own test

- **One outage could be recorded as two incidents.** Opening an incident read the open ones and
  created one if the service had none — with nothing enforcing uniqueness in between. The
  five-minute worker overlapping a manual "check now" was enough to race it, and the page then
  showed the same failure twice. The database now permits at most one open incident per service,
  and a run that loses the race joins the incident the winner opened instead of failing. The
  migration merges any duplicates an affected install already has, folding their sample counts
  into the earliest one rather than discarding them.
- **The AI probe could report a false outage.** It checked the stored API-key column directly
  instead of asking the resolver the AI calls actually use — so a workspace on the Anthropic
  provider running from an environment variable, which is a perfectly healthy setup, was reported
  as down. A monitor that invents failures is worse than no monitor.

#### 🔍 Face verification — three measured causes of it not working, fixed

The feature was failing far more than it was passing. The attempt log said why, and it was not
what anyone assumed: **the head-movement check, not the face match**, was the largest cause —
107 failures against 69 passes, with recorded rotations of 0.02–0.26 radians against a 0.35
requirement. People were not refusing to turn their heads. The instruction was static text, the
frame was taken on a fixed 3-second countdown, and there was no signal for "further" — so you
turned, guessed, and were told afterwards that you had failed.

- **The head turn is now a live meter that fills as you move**, and the photo is taken by itself
  at the peak of the turn rather than whenever a timer expired. The requirement is unchanged and
  the server still measures it independently — you can simply see it now.
- **Enrollment asks for four positions instead of four photos of one position.** The old "burst"
  took four frames 280ms apart; nobody moves in under a second, so all four described the same
  angle in the same light and a later check from any other angle scored as low as 0.52. The
  wizard walks you through centre, both sides and a tilt, and takes one good frame at each.
- **A per-person threshold could drift out of reach and never come back.** It is computed from
  your own history of successful checks — but seeded and automated entries score a perfect 1.000,
  which no live camera produces, and those dragged the bar above anything a real capture of you
  could reach. Because only successes feed it, there was no way out from inside the product.
  Non-live scores are now excluded from that calculation.
- **Hands-free capture works in every browser**, not only Chromium. It previously relied on an
  API that Firefox and iOS Safari do not have, so on most phones every photo was taken manually at
  a moment of the user's choosing — which is exactly how blurry, off-angle frames got submitted.
- **Live coaching while the camera is open** — "move a little closer", "hold still, the image is
  blurry", "you're not alone in frame" — instead of finding out after the round trip. Blur is
  measured directly, because a large, centred, confidently-detected face can still be motion
  blurred, and that is what turns into a rejection nobody can account for.

No new services and no Python: the browser now runs the same detection library the server already
used, and it deliberately loads only detection and head-pose (2.1MB, fetched when a camera opens).
The embedding and the match stay on the server, because a client that decides its own verification
outcome is not a security control.

### 🔧 Under the hood

- New permissions (`portfolios:manage`, `plan:write`, `resources:manage`, `approvals:manage`,
  `dashboards:share`) are granted by **idempotent SQL inside the migration**, not by the seed —
  the seed is a one-time bootstrap that never runs on upgrade, so a seed-only change would have
  silently 403'd for every existing installation. `install`/`update` scripts needed no changes:
  one-click install and upgrade both work as they are.
- Every existing ticket is mapped onto the seeded Default workflow during the upgrade, with its
  status left untouched.
- Plan tiers gain six planning capabilities and five quotas, all defaulting restrictive so a tier
  that misses initialisation under-entitles rather than over-entitles.
- The schedule is computed in exactly one place (`plan-schedule.service.ts`) and read by the
  timeline, the portfolio roll-up and everything that follows — three surfaces each working out
  "when does this start" would disagree, and the one that disagrees is always the one on screen.
- `plan:write` is a separate permission from `tickets:write`: fixing a typo in a ticket and
  moving the delivery schedule are different acts. Managers and team leads get it by default.
- Burn, forecast and estimate variance are computed in one place and read by both the portfolio
  roll-up and the project panel, so a total can never disagree with the rows under it — and the
  figure matches a Verified Work Attestation because both read the same rate snapshots.
- The AI copilot has exactly two model calls, both through the existing AI choke point, so budget
  ceilings, per-feature toggles, usage logging and prompt versioning apply to them unchanged. An
  unavailable or over-budget model never costs you a risk score.
- Three new unauthenticated endpoints follow the posture the attestation viewer established:
  unguessable tokens, no enumerable ids, and an identical generic 404 for a bad, revoked or
  already-used link — so probing one can't confirm it was ever real.
- The end-to-end suite's face-verification helper now reference-counts across worker processes.
  Two parallel workers used to suspend the gate and the first to finish restored it mid-run,
  producing an intermittent failure that always pointed at the wrong thing.

### 🚢 Install & links that survive the real world

- **`APP_BASE_URL="auto"`** — emailed links (password resets, welcome, digests) now build on the
  machine's own LAN address detected at boot, instead of an IP frozen into `.env` that goes
  stale the moment DHCP hands out a new one (it already had, when this shipped). Scheme follows
  the dev-certificate signal, `{lan-ip}` templating covers custom ports, and production still
  pins a real domain — with a loud warning if it doesn't.
- **Docker builds got faster and stricter**: `npm ci` (exact lockfile replay — an image can no
  longer quietly resolve different versions than the repo tested) with a BuildKit cache mount
  that persists the npm cache between builds without entering the image. The build context also
  stopped uploading dead weight — and stopped including the **dev TLS private keys**, which
  `COPY apps/web` had been silently baking into the web image since the LAN-HTTPS work.

### 🔛 Projects can be disabled and re-enabled

- **Archive was a one-way door**: it soft-deleted the project, which removed it from the very
  list an admin would look in to bring it back — while the duplicate-code error helpfully
  advised "reactivate it instead". Archive is now a true disable: the project vanishes from
  timesheet entry, ticket creation and every picker (the default project list serves only
  ACTIVE), but stays on the Project Management page with its ARCHIVED badge and a
  **Reactivate** action. History and existing entries are untouched in both directions.

### 🪟 The module editor dialog, made legible

- The first cut of the hierarchy dialog broke on real data: one long submodule name forced the
  whole pane wider than the dialog (CSS-grid children keep min-width:auto), clipping the title
  and every row's left edge behind a horizontal scrollbar, and a "MODULE/SUBMODULE" chip
  repeated down 70+ rows was noise. Rebuilt: fixed header with live counts, a filter box for
  big trees (matching a submodule keeps its parent for context), modules as bold headers with
  indented children, names that truncate instead of widening anything, and only the tree
  scrolls. Verified against the 76-submodule tree with a measured zero pixels of horizontal
  overflow.

### ✏️ Projects you can correct, and windows that can't start yesterday

- **Projects, modules and submodules are finally editable after creation.** The projects table
  gained an **Edit** action (name + description — the code stays fixed, since it prefixes every
  ticket key ever issued), and the "N modules" count is now the door to a hierarchy dialog with
  inline rename for every module and submodule. Renaming is safe by construction: timesheets and
  tickets reference these by id, so history follows the new name instead of orphaning. Duplicate
  names within the same parent come back as a clear 409.
- **The maintenance window can no longer be scheduled to start in the past.** The start picker
  offers today onward, the end picker can't precede the start, a changed past start blocks the
  save with an inline message, and the server enforces the same rule — while still allowing
  edits to a window that is ALREADY running (its start is legitimately in the past; telling an
  admin their active window is invalid would be absurd). A refused save arms nothing.

### 🏷️ Validation errors name the field

- Every Zod rejection app-wide used to reach the user as a bare **"Validation failed"** — a
  501-character project description produced an error that never said "description" anywhere a
  person would look. The error middleware now writes the first problems into the message itself
  ("Validation failed — description: String must contain at most 500 character(s)"), and the
  project form's inputs carry the API's own limits (64/160/500) so the boundary is felt while
  typing instead of discovered after clicking Create.

### 🚪 The first-run popup now leaves when you're done

- **Completing onboarding used to leave the "finish setting up your account" popup on screen**
  until a hard refresh: the gate stayed mounted across navigation, so returning from the profile
  just re-rendered its cached "blocked" answer (a comment claimed it refetched on navigation;
  nothing did). Now the two completing actions — saving the profile, enrolling a face — tell the
  gate immediately, and the gate polls every few seconds while blocked as a backstop, so a
  wedged popup is impossible by construction. Verified by an e2e that creates a fresh user,
  meets the gate, completes the profile out-of-band, and watches the popup leave with no
  navigation and no reload.
- **Second bug found on the way**: the gate demanded face enrollment from people the SELECTED
  enforcement mode deliberately doesn't cover — it asked workspace-level questions about a
  per-person policy. It now uses the same per-user check every submission gate uses.

### 🧯 Duplicate keys answer like a product, not an ORM

- **Creating a project with an existing code showed a raw Prisma stack** (`Unique constraint
  failed on Project_code_key`) as a 500. Two fixes, two layers: the create route now pre-checks
  and answers 409 naming the colliding project — including when it's archived and therefore
  invisible in pickers — and the error middleware gained a Prisma-translation floor, so ANY
  unique-constraint hit anywhere in the app (module names, custom fields, future routes) returns
  a human 409 instead of leaking ORM internals. Proven both ways by e2e: the named message on
  the pre-checked route, the translated one on a route with no pre-check.

### 🗞️ Release history, typeset like it matters

- Release cards now parse their own notes into the industry-standard taxonomy — **Features,
  Fixes, Security, Infrastructure, Dependencies, Internal** — each section tagged with a colored
  chip and the release header carrying per-category counts, so the shape of a release is visible
  before anything is expanded. The release's NAME finally shows ("v2.0.0 — the planning layer"),
  dates right-align, section bodies sit behind a left rule, and every fragment renders through
  the same sanitizer path as before.

### 📞 Profile fields that mean something

- **Phone numbers are validated per country, both ends.** The profile's free-text phone box (it
  accepted "hello") became a country picker + number field validated by libphonenumber — an
  Indian mobile must have its 10 digits, a Singapore number its 8 — with the server enforcing
  the same rules on PATCH (the client check is convenience, never the boundary) and storing
  canonical E.164 (`+919876543210`), whatever spacing was typed.
- **Timezone comes from the person's device, not the server's.** The browser is the only party
  that knows where someone actually is; the server's TZ only says where the code runs. Users
  with no timezone get their device's zone recorded automatically at next sign-in; the profile
  gained a real zone picker with a "use device" shortcut. Server-side validation asks the
  runtime itself ("can you format dates in this zone?") rather than checking membership in the
  canonical-names list — which would have rejected `Asia/Kolkata` on ICU builds that
  canonicalize to `Asia/Calcutta`, the exact zone this product defaults to.

### 📦 Dependency refresh, with its skips stated

- Every in-range update applied across all workspaces (Playwright 1.62 + fresh browser builds,
  Radix suite, TanStack Query, react-hook-form, helmet, imapflow, node-cron, stripe, axios and
  ~25 more), plus deliberate bumps: `@anthropic-ai/sdk` 0.115, `pdfkit` 0.19 (which alone
  retired two deprecated transitive packages), `concurrently` 10. **`react-day-picker` removed
  entirely** — dead code since the React Aria date-picker migration.
- Deliberately NOT taken, each being its own migration project rather than a cleanup: Prisma 7,
  TypeScript 7, Tiptap 3, Recharts 3 (the one remaining *direct* deprecation warning),
  TanStack Table 9, ldapts 9 (auth library majors don't get bumped without an LDAP server to
  test against). Remaining install warnings all come from `exceljs`'s dependency chain — it is
  already at its latest release, so those are upstream's to fix, not ours to chase.
- Verified: typechecks, 367 unit tests, production build, and the full desktop e2e project —
  whose one failure was an over-broad assertion, not a regression: the bundled release notes
  legitimately *mention* `./update.sh` in prose, and the spec now distinguishes reading about
  an update from being offered one.

### 📜 Release history that works everywhere

- **The What's-new page now always has a release history.** GitHub Releases remain the live
  source (and the only source of "an update is available"), but when GitHub yields nothing — a
  private repo asked anonymously, an air-gapped install, or simply no releases published yet —
  the page falls back to **this build's own bundled `CHANGELOG.md`**, parsed into the same
  structured cards, with an explicit caption saying so and that versions newer than the
  installation can't appear there. A build's own changelog can't know the future, and the UI
  says that instead of pretending.
- **Private repos get a live feed too**: set `UPDATE_CHECK_TOKEN` (a fine-grained PAT with
  read-only Contents) and the hourly release check authenticates instead of asking anonymously.

### 🐛 Fixes (post-release polish)

- **The Users page showed two stacked pagers.** The shared table's built-in client-side footer
  (truthfully paging only the 25 rows it could see, with an empty page-size box) rendered above
  the real server-side pager for the whole set. The shared table now takes
  `enablePagination={false}` for server-paged consumers, and the e2e suite asserts the Users
  page has exactly one pager.

### 🔀 Git integrations beyond GitHub

- **Branch/PR auto-sync from six providers.** The webhook receiver now speaks GitLab, Bitbucket
  Cloud, Gitea, Forgejo and Azure DevOps alongside GitHub — same ticket-key-in-branch-name
  matching, same Dev-tab rows, one shared webhook secret, each provider verified in its own
  dialect (HMAC where the provider signs; Azure DevOps via basic-auth/`?token=`, stated plainly
  as the weaker scheme it is). Per-provider URLs are shown in Workspace Settings → Security &
  DevOps, which no longer requires a GitHub connection to generate the secret. Deliberately not
  included: AWS CodeCommit (closed to new customers by AWS, July 2024) and SourceForge (no
  usable webhook API) — manual Dev-tab links cover both, as they always did.

### 🧰 Dev-machine and face-flow polish

- **A second `npm run dev` now says so and stops.** Previously the duplicate API crashed with a
  raw stack while a duplicate Vite silently took the next port and proxied to the survivor — a
  half-dead stack per invocation, each burning RAM and CPU while looking like the app. The API
  now exits cleanly naming the running instance, and Vite fails loudly instead of port-hopping.
- **The face wizard had five buttons; now it has the right ones.** The capture surface rendered
  its own shutter even when a wizard drove it — a dead "Start" beside the real one — plus a
  "Turn off" that read as a second cancel, plus a literal second Cancel below the wizard. Each
  parent now states which controls it owns; one Start, one Cancel, everywhere.
- **The training report fits a phone.** Rejection reasons drop to their own indented line on
  narrow screens instead of pushing the card past the viewport edge; wizard step chips wrap
  below the title. Verified by a new 360px-wide spec with the wizard open.

### 🔒 HTTPS, shipped as a runbook

- **One-command LAN certificates**: `scripts/make-lan-certs.{ps1,sh}` installs a local CA
  (mkcert), issues a certificate for every address the machine answers on, and drops the pair
  where both entry points already look — `npm run dev` then serves `https://<lan-ip>:5173`
  automatically, and the new **`docker-compose.https.yml` overlay** (Caddy) serves
  `https://<lan-ip>` in front of the whole stack. Phones trust the printed `rootCA.pem` once and
  the camera works everywhere on the LAN.
- **Public-domain mode** in the same overlay: set `HTTPS_DOMAIN` and `CADDYFILE=Caddyfile.domain`
  and Caddy obtains and renews real Let's Encrypt certificates on its own.
- The full replicate-on-any-machine sequence is documented in DEPLOYMENT.md § *Serving over
  HTTPS* → "The shipped runbook". Private keys are git-ignored by construction.

### 🔐 Password and camera-policy hardening

- **Admin password resets no longer default to `Admin@12345`.** That default is documented in
  this repo's README — a password the whole internet can read is not a password. A reset with no
  explicit password now generates a **random one-time password per person** (shown to the admin
  exactly once; the server keeps only a hash), and bulk resets return one per selected person
  with a copy-all dialog. Every admin-set password — creation, reset, CSV import — now flags the
  account, and the person sees a **"choose your own password" banner** until they change it
  (Profile, or the emailed reset link). A banner, deliberately not a blocking modal: forced
  modals train people to append a "1" to the old password just to get to work.
- **Insecure-context face bypass (super-admin toggle, off by default).** Browsers only open the
  camera on https or localhost — no server setting can lift that rule, so on a plain-http LAN
  address the face check could never complete. With the new toggle on, such a person may proceed
  **without** the check, and every pass-through is recorded as a `SKIPPED_INSECURE` attempt in
  the verification log (amber, filterable) plus an audit entry — a bypass with a paper trail,
  never a silent hole. Meant for LAN pilots; the real fix stays serving the app over https, and
  the toggle re-checks at spend time so switching it off closes the hole immediately.
- **Emailed links honour your LAN.** `.env.example` now documents pointing `APP_BASE_URL` at the
  machine's network address (a reset link built on `localhost` only ever opens on the server
  itself), plus a worked Microsoft 365 SMTP example — including why sending "from" your corporate
  domain through a personal Gmail is precisely what recipient spam filters flag.
- **`npm run dev` no longer prints an error-stack flood while the API boots.** Vite is up in ~1s,
  the API takes several; the proxy errors from an already-open tab now collapse into one
  throttled, self-explaining line instead of per-request `AggregateError` stacks.

### 🐛 Fixes

- **"View capture" in the verification log showed admins `{"message":"Authentication required"}`**
  instead of the image. The button opened the authenticated image route in a new tab, and a plain
  navigation carries no bearer token — the image is now fetched with credentials and shown in an
  in-app dialog. The route itself was always correct; captures were never publicly reachable.
- **Docker image builds failed at `npm install`** (one-click install, and the CI publish job's
  first-ever run on `main`). The root `postinstall` builds `packages/shared`, but the Dockerfiles'
  dependency layer holds only manifests — no sources, no `tsconfig.base.json` — so the build died
  with exit 1 before anything was installed. The postinstall now skips itself, with a printed
  reason, when the shared sources aren't present.
- **Face training now reports itself.** Enrollment returns a per-shot verdict (stored + quality,
  or the specific rejection), and the profile card shows a persistent training report — which shot
  failed and why — instead of a toast that vanished. The card also shows the size of your face
  model ("4 reference angles"), a live "training your face model" progress state while the server
  validates the shots, and a **retrain nudge** for enrollments made before guided multi-angle
  training existed: those hold one angle in one light, which is the measured cause of the marginal
  0.80–0.84 match scores in the review log. Retraining is offered, never forced — a thin model is
  degraded accuracy, not a lockout. A failed match now says the useful thing too: retrain from
  Profile → Face verification.

## 1.1.0 — 2026-08-03

### ✨ Features

- **Guided product tour** — a role-aware walkthrough that navigates to each page the signed-in
  person can actually reach, spotlights what matters and blurs the rest. Auto-starts once for
  brand-new accounts; available any time from the profile menu → *Take the tour*.
- **First-run setup gate** — new accounts complete their profile (and face enrolment, where the
  workspace requires it) before using the app. Existing users are never affected.
- **Verified Work Attestations** — a signed, page-numbered PDF of approved, identity-verified work
  for a project and period, with client-viewable share links that need no account.
- **AI quality loop** — capture what the AI was asked and answered, correct real failures into
  golden datasets, edit prompts without a deploy (with automatic fallback to the built-in prompt),
  and replay datasets through an eval runner with hard budget caps. "Is the new prompt better?"
  becomes a number.
- **BYOK model picker** — the AI settings fetch the models your provider key can actually use,
  instead of asking you to type a model name from memory.
- **Attachment pipeline** — images convert to WebP (~76% smaller), text compresses losslessly,
  and every file gets an identifiable name plus type/size/checksum metadata for analytics.
- **Verification log controls** — search, outcome/context filters and sortable columns on the
  face-verification review log, on phones as well as desktop.
- **Update awareness** — the app knows its own version (`/api/system/version`), tells admins when
  a newer release exists, shows release notes in-app (*What's new*), and offers everyone a
  one-click refresh when the server is upgraded beneath them.
- **Backend health gate** — a warning strip on the first dropped request, a blocking overlay on a
  real outage, automatic recovery with no reload and no lost work.
- **Maintenance mode** — super admins schedule a window with an optional message; everyone else
  is locked out onto a branded maintenance page with a live countdown while super admins stay
  signed in to do the work. Includes a who's-online panel, a "wrap up" warning (in-app + email,
  with its own notification toggle), one-click force-logout of all non-admin sessions, and an
  advance-warning banner inside the app during the scheduled phase.
- **Server health panel** — the Maintenance tab shows live vitals of the serving instance,
  refreshed every 10 seconds: CPU, memory, disk, database ping / event-loop latency, and a
  component checklist (API, both databases, mail transport) that stays honest when something is
  down instead of erroring out.
- **Login visibility in User management** — every user row shows a live online indicator, first
  login and latest login times, plus a confirmed *sign out everywhere* action that revokes all
  of one person's sessions server-side.
- **Instant "you've been signed out" dialog** — a 15-second session heartbeat means an admin's
  force-logout reaches the person's open tab within seconds: a clear dialog explains what
  happened and takes them to the sign-in page, instead of a stale screen that only admits the
  truth on the next refresh. Ordinary session expiry gets the same treatment with softer wording.
- **Maintenance pop-up warning** — when a window is scheduled, signed-in users now get a one-time
  modal interruption (people tune out passive banners) quoting the window and the admin's
  message, acknowledged once per window per browser. The persistent amber banner stays as the
  ambient reminder.
- **Maintenance page redesign** — animated counter-rotating gears, drifting ambient orbs, a
  blueprint-grid backdrop, a live progress bar showing how far through the window you are, and a
  pulsing "live" indicator — all pure CSS/motion, no image assets, same auto-release behavior.
- **Searchable ticket picker on the timesheet form** — type-ahead over key AND title ("OPS-381"
  or a word from the name both work), keyboard-navigable, with an explicit "Not linked" choice.
  A plain dropdown was fine at 10 tickets and useless at 200.
- **Maintenance warning email joins the template system** — full branded layout (accent header,
  window info card, action button) instead of bare paragraphs, editable like every other email
  from the Email templates page with live variables and a sample preview.
- **The product tour now spotlights each page's actual feature** — the entry form, the board,
  the export tiles, the invite card — instead of the page title, which told people where they
  were but never what to look at.
- **Security PDF report rebuilt** — executive verdict banner (color = the answer), open-findings
  strip by severity, latest CI run with pass/fail counts, finding descriptions + CWE + AI triage
  (all silently dropped before), a methodology appendix explaining each assessment type for
  readers who don't know the acronyms, page-break guards and Page N of M.
- **Server health panel: structured details grid** — OS, architecture, Node version, app
  version, both uptimes, sample time and pid as labeled icon tiles instead of one unscannable
  text line.
- **Faster test workflow** — `test:e2e:quick` (~7 min functional loop) and a parallelised
  `test:e2e:responsive` layout matrix (~5 min, was ~9 serial), with the safety rules documented
  in the README.

### 🐛 Fixes

- Opening any menu or dialog after scrolling no longer breaks the page layout (sidebar/topbar
  vanishing, content shifting sideways). Root cause: `overflow-x: clip` on the root element
  blocked the standard scroll-lock from reaching the viewport, detaching every sticky element;
  the scrollbar-width jump is also gone (`scrollbar-gutter: stable`).
- Wide tables (Tickets, Users) on tablet-width screens now scroll horizontally inside their own
  container instead of being silently clipped at the right edge with no scrollbar — a
  pre-existing bug the old root-level clip both caused the conditions for and hid from the
  responsive test suite.
- The whole UI now fits comfortably at 100% browser zoom (previously only at ~80%): the root
  font size is 14px — the standard enterprise-app base — which scales every rem-based size in
  the app to 87.5%.
- The User management table no longer overflows horizontally: the six per-row icon buttons are
  consolidated into one labeled actions menu, which also puts *Delete* behind a clearer,
  harder-to-fat-finger step.
- Creating a user with an email that already exists now answers a clear conflict message instead
  of an unhandled server error — including when the collision is with a previously deleted
  account, which is invisible in every list.
- Workspace Settings no longer overflows on phones (a grid min-content bug affected every tab).
- Timesheet entries can now be deleted (drafts and rejected only — approved hours are part of the
  billing record and stay immutable).
- The pricing page's plan comparison is now generated from the same limits the platform enforces,
  correcting two rows that promised features on the wrong tier.
- Fresh-database provisioning no longer fails on the attachment migration.
- Six dialogs gained proper screen-reader descriptions; duplicate accessible names were resolved.

### 🔒 Security

- `sanitize-html` upgraded past GHSA-vccv-cmxp-4j9h (the vulnerable attributes were never in this
  app's allowlists; upgraded regardless, with the analysis pinned as tests).
- `npm audit` now blocks CI at high severity for production dependencies.
- Prompt editing is allowlisted away from every capability whose prompt carries prompt-injection
  delimiters or must produce parseable JSON.

## 1.0.0 — 2026-07-29

Initial release: multi-tenant timesheets and ticketing with per-organization databases, manager
approvals with SLA escalation, Kanban with swimlanes, BYOK AI (19 capabilities behind individual
toggles and a monthly budget cap), optional face verification with liveness checks, security
finding ingestion (SAST/DAST/SSAT/SSCT/VAPT), insights dashboards, email/chat intake, SSO
(Google/Microsoft/SAML/LDAP), SCIM provisioning, public API with HMAC-signed webhooks, and
Stripe-backed plan tiers.
