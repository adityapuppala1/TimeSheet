# Changelog

All notable changes to TimeSphere, newest first. Each version corresponds to a git tag `vX.Y.Z`
and a GitHub Release whose body is copied from the matching section here — the release process is
documented in CONTRIBUTING.md, and the in-app **What's new** page renders these notes for every
user of a running installation.

## Unreleased

Everything below ships in the next tag. The parser that feeds the in-app What's-new page ignores
this section until it gains a version number, on purpose — an installation must never render
history for a version that does not exist yet.

**One upgrade note that matters: fresh installs on Linux MySQL (Docker Compose and Kubernetes
alike) were broken from 2.3.0's migrations onward** — 37 table names generated in the
case-insensitive Windows dialect died on case-sensitive Linux servers mid-migration. Fixed by
rewriting them to the canonical casing, which is correct on both. Existing installations are
unaffected; their migration checksums were reconciled in place.

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

### 🐞 Fixed

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
