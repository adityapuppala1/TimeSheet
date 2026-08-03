# Changelog

All notable changes to TimeSphere, newest first. Each version corresponds to a git tag `vX.Y.Z`
and a GitHub Release whose body is copied from the matching section here — the release process is
documented in CONTRIBUTING.md, and the in-app **What's new** page renders these notes for every
user of a running installation.

## Unreleased — the planning layer (V6)

Work in progress on the `V6` branch. Turns TimeSphere from an execution tracker into a
project-management platform. **Nothing here changes how an existing workspace behaves until an
admin turns it on** — every capability ships off by default.

### ✨ Phase 1 — foundation

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

### ✨ Phase 2 — planning & views

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

### ✨ Phase 3 — resource & budget

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
- The end-to-end suite's face-verification helper now reference-counts across worker processes.
  Two parallel workers used to suspend the gate and the first to finish restored it mid-run,
  producing an intermittent failure that always pointed at the wrong thing.

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
