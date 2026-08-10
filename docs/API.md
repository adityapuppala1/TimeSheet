# API Documentation

Base URL: `/api`

## Auth

- `POST /auth/login` `{ email, password, rememberMe }`
- `POST /auth/refresh` `{ refreshToken }`
- `POST /auth/logout`
- `POST /auth/forgot-password` `{ email }`
- `POST /auth/reset-password` `{ token, password }`
- `POST /auth/change-password` `{ currentPassword, nextPassword }`
- `GET /auth/me`
- `GET /auth/heartbeat` — deliberately tiny authenticated liveness beat the app shell polls
  every 15s. Its 401 is how a server-side session revocation (admin force-logout, another
  device's sign-out) reaches an open tab within seconds; it also keeps `Session.lastSeenAt`
  honest for idle-but-open tabs

While a maintenance window is active (see the Maintenance mode section below), every
authenticated route and every login method answers `503 { code: "MAINTENANCE" }` for
non-SUPER_ADMIN users — clients must treat that code as "show the maintenance page", not as an
outage or an auth failure.

## Maintenance mode

- `GET /maintenance/status` — **public** (tenant-resolved, rate-limited 30/min per IP). Returns
  `{ phase: "off"|"scheduled"|"active"|"ended", scheduledStartAt, scheduledEndAt, message }`;
  window and message are `null` whenever the mode is disabled. This is what the lockout page and
  the in-app countdown banner poll.
- `GET /maintenance/admin` — SUPER_ADMIN. Settings + phase + who's online now (unrevoked,
  unexpired sessions active in the last 15 minutes, deduped to people).
- `PATCH /maintenance/settings` `{ enabled, scheduledStartAt, scheduledEndAt, message }` —
  SUPER_ADMIN. Enabling requires a coherent window (start, end, end > start, end in the future);
  disabling never validates, so a stale schedule can always be cleared. Audited.
- `POST /maintenance/force-logout` — SUPER_ADMIN. Revokes every non-SUPER_ADMIN session
  server-side. Audited; returns `{ revokedSessions }`.
- `POST /maintenance/notify` — SUPER_ADMIN. In-app + email warning to online non-admins quoting
  the window; requires the window to be enabled and scheduled. Email leg gated by the
  `emailMaintenanceScheduled` notification toggle. Audited; returns `{ notified }`.
- `GET /maintenance/health` — SUPER_ADMIN. Live vitals of the API instance answering: CPU
  (two-sample usage %, cores, load averages where the OS provides them), memory (system +
  process RSS), disk (`fs.statfs` on the app's volume), network/latency (tenant + control-plane
  DB pings, event-loop lag, interface addresses), and a per-component checklist (API, both
  databases, mail transport). Never throws — a dead dependency reports `ok: false` on its
  component. Behind a load balancer this is one replica's view; `server.hostname`/`pid` say
  whose.

## Users

- `GET /users?search=&role=&status=&page=1` — each row also carries login visibility:
  `online` (live — an unrevoked session active in the last 15 minutes), `lastSeenAt`,
  `firstLoginAt` (stamped once on the very first login; null for accounts predating the column,
  deliberately not backfilled) and `lastLoginAt`
- `POST /users/:id/force-logout` — revokes every session that user has, server-side; their next
  request 401s and the refresh fails. Only a SUPER_ADMIN may target another SUPER_ADMIN.
  Audited; returns `{ revokedSessions }`
- `POST /users` — accepts an optional `designation` (free-text job title, display-only — separate
  from `role`, which governs permissions). A duplicate email answers a clear `409` — including
  when the collision is with a soft-deleted account, which is invisible in every list (this used
  to leak an unhandled 500)
- `POST /users/bulk` — CSV bulk-import, same optional `designation` column per row
- `PATCH /users/:id` — `designation` updatable independently of every other field
- `DELETE /users/:id`
- `POST /users/:id/reset-password` — also revokes every session the target has, the same as the
  emailed reset does; an admin reset is usually a response to a compromise, and a new hash alone
  evicts nobody

## Projects

- `GET /projects`
- `POST /projects`
- `PATCH /projects/:id`
- `POST /projects/:id/modules`
- `POST /modules/:id/submodules`

## Timesheets

- `GET /timesheets?from=&to=&userId=&projectId=&status=`
- `POST /timesheets/draft`
- `POST /timesheets/submit`
- `PATCH /timesheets/:id/approve`
- `PATCH /timesheets/:id/reject`
- `PATCH /timesheets/decide-bulk` — body `{ ids[] (1–100), decision: "approve"|"reject", reason?,
  faceVerificationId? }`; `reason` is required for reject. Decides each row **independently**
  through the same core the single routes use (one payroll path, so the two can never drift) and
  returns `{ done, failed[] }` with per-row refusal reasons — a batch is never all-or-nothing.
  When face verification gates approvals, ONE verification covers the whole batch: the check
  asserts the *approver's* presence, not anything per-row, and per-row captures would only teach
  people to avoid bulk. One audit entry records the batch; each row keeps its own provenance.
- `DELETE /timesheets/:id`

**`DELETE /timesheets/:id` accepts only `DRAFT` and `REJECTED`.** Anything else returns **422**,
and the distinction is load-bearing rather than conservative:

| Status | Deletable | Why |
|---|---|---|
| `DRAFT` | yes | Logged by mistake; nothing downstream depends on it yet. |
| `REJECTED` | yes | Already refused; the rejection reason is preserved in the audit log. |
| `SUBMITTED` | **no** | Someone is being asked to decide on it. Removing it mid-review erases the request. |
| `APPROVED` | **no** | It carries a frozen rate snapshot and feeds cost reports and Verified Work Attestations. Deleting it would let history be rewritten *after* a client had been shown it. Correct approved hours with a new entry. |

Authorship rules: an author may delete their own entries; `TIMESHEETS_APPROVE` (managers and up)
may delete anyone's, so an admin can tidy up after someone who has left. It is a **soft** delete —
the row keeps its audit trail, and because every read path (including the overlap check in
`POST /timesheets/draft`) filters `deletedAt: null`, the freed time slot is immediately reusable.

> This route did not exist until 2026-08. Its absence meant a mistaken entry could only be edited
> into something else, and it silently broke the e2e suite's cleanup, which had been calling it and
> treating Express's 404 as success. See `tests/e2e/helpers/admin-request.ts`.

## Face (identity) verification

Optional, off by default, and **Enterprise-plan gated** — see
[FACE_VERIFICATION.md](FACE_VERIFICATION.md) for the design, calibration, the challenge–response
anti-injection step, and the biometric-privacy obligations it carries. Without the plan
entitlement, enabling/enrolling/verifying return **403** (fail closed) while enforcement on
submissions silently stops (fail open — a lapsed payment must never lock a workforce out).

All routes require a normal authenticated session, and `/api/face/*` carries its own
60/min-per-IP rate limit (each verify is CPU-bound wasm inference). Captures are sent as
`multipart/form-data` under the `capture` field (PNG/JPEG, ≤4MB each): one file normally, TWO
(`[neutral, gesture]`) while the movement challenge is on.

- `GET /face/status` — what the caller needs to render the right UI: whether the policy covers
  them (`requiredForTimesheet` / `requiredForTicket` / `requiredForApproval`), the plan
  entitlement (`allowedByPlan`), whether the two-frame challenge applies (`challengeEnabled`),
  whether they've enrolled, the consent text to display, and the retention window. Only ever
  describes the caller.
- `POST /face/challenge` — `{ context }` → `{ challengeId, instruction, prompt,
  expiresInSeconds }`. Issues the single-use, 90-second liveness challenge (a random head
  movement) a verification must satisfy while `challengeEnabled` is on.
- `POST /face/enroll` — `capture` + `consent=true`. **Consent is a hard precondition**, not a
  logged checkbox: without it the request is rejected 422. The exact wording shown at the time
  is stored on the enrollment row, since an admin can edit the settings text later.
- `POST /face/verify` — `capture` frame(s) + `context=TIMESHEET|TICKET|APPROVAL`, plus
  `challengeId` (required while the challenge is on), an optional `deviceLabel` (the
  camera's self-reported name — recorded as a virtual-camera review signal, never trusted), and
  optional `neutralCapturedAt`/`gestureCapturedAt` (client clock, epoch ms, at each frame capture
  — the provenance evidence described below).
  On success returns `{ outcome: "PASSED", verificationId, expiresInSeconds }`. **The
  `verificationId` is single-use and short-lived** — pass it as `faceVerificationId` on the
  subsequent protected request. A failure returns HTTP 422 with a structured body (`outcome`,
  `message`, `attemptId`, `flagged`) rather than an opaque error, so the UI can explain *why* —
  `NO_FACE`, `MULTIPLE_FACES`, `NO_MATCH`, `SPOOF_SUSPECTED`, `CHALLENGE_FAILED`, `LOW_QUALITY`,
  `NOT_ENROLLED`. `LOW_QUALITY` means "we couldn't see you", not "we don't believe you" — it's
  never counted toward the failure streak that leads to a review flag.
  - **Capture provenance (injection-attack signal).** When a challenge was redeemed, the server
    compares `neutralCapturedAt`/`gestureCapturedAt` against when it actually issued that
    challenge (`assessProvenance` in `face.service.ts`). A capture timestamped more than 2 minutes
    before its own challenge existed — beyond any plausible clock skew — is the strongest replay
    indicator available and sets `provenanceSuspect: true` on the persisted attempt, with a
    `provenanceNote` explaining why. Like the virtual-camera signal, **this is a review signal,
    never a block**: client clocks are self-reported and untrustworthy by design, so it can only
    ever flag, never fail, an otherwise-passing attempt.
- `DELETE /face/enrollment` — the caller deletes their own face data (template **and** images).
  The "withdraw consent" path biometric-privacy regimes require to be self-service. Sends the
  subject a confirmation notification (deletion evidence).
- `DELETE /face/enrollment/:userId` — same, performed by an ADMIN/SUPER_ADMIN (offboarding).
- `GET /face/export` — self-service data-subject export: enrollment metadata, the exact consent
  wording agreed to, and every attempt with scores/signals, as a JSON download. Never includes
  the embedding or filesystem paths.
- `GET /face/attempts?userId=&outcome=&flaggedOnly=&page=&pageSize=` — ADMIN/SUPER_ADMIN review
  log, **paginated server-side**: returns `{ rows, total, page, pageSize }`. Unlike the
  DataTable-backed surfaces (which fetch an array and page in the browser) this log grows without
  bound — one row per attempt, forever, per covered user — so client-side paging would show only
  the newest slice while looking like the whole log. `?take=` is still accepted as an alias for
  `pageSize` so older callers keep working.
  Rows carry the anti-injection signals (`deviceLabel`, `virtualCameraSuspected`,
  `unfamiliarNetwork`, `challengeInstruction`, `provenanceSuspect`, `provenanceNote`,
  `autoResolvedReason`) and `hasImage: boolean` — never the server filesystem path.
- `PATCH /face/attempts/:id/review` — ADMIN/SUPER_ADMIN clears a review flag, optional `note`.
- `PATCH /face/attempts/review-bulk` — ADMIN/SUPER_ADMIN; body is `ids[]` (1–200) **xor** a
  `filter` (`userId`/`outcome`/`context`/`search`) the server re-derives — same
  selection-vs-filter contract as the users bulk actions, so what gets cleared is what the server
  matches, never a stale client list. Always scoped to `flaggedForReview: true` (the returned
  `reviewed` count is flags actually cleared), optional `note` attaches to every row, one audit
  entry records mode + count.
- `POST /face/attempts/:id/ai-summary` — ADMIN/SUPER_ADMIN; AI-drafted review brief
  (`{ summary, risk, recommendation }`). Gated by `GlobalAISettings.faceReviewSummaryEnabled` +
  the AI budget; only attempt *metadata* enters the prompt.
- `GET /face/stats` — ADMIN/SUPER_ADMIN; last-90-days outcome totals, signal counts, and the
  similarity histogram (passed vs rejected per 0.05 bucket) the threshold should be tuned from.
- `GET /face/analytics?days=7|30|90` — ADMIN/SUPER_ADMIN; the operations counterpart to
  `/face/stats`. `days` is an **enum, not a range** (anything else is 422) and defaults to 30;
  above 30 the series buckets by week (`bucket: "day" | "week"`), because ninety daily bars are
  unreadable. Returns `since`, `days`, `bucket`, `total`, `outcomes[]` (`{ outcome, count }`,
  commonest first), `trend[]` (`bucketStart`, `total`, and `counts` per outcome — zero-filled
  across every bucket **and** every outcome seen in the window, since a hole in a stacked series
  reads as "no data" rather than "none of that outcome"), `review` (`flaggedTotal`,
  `pendingReview`, `humanReviewed`, `autoTriaged` — three mutually exclusive states, so "a human
  signed this off" stays countable apart from "the worker cleared it and nobody looked") and
  `enrollment` (`enforcementMode`, `covered`, `enrolled`, `notEnrolled`, `staleModel`,
  `multiPose`, `singlePose`). `covered` follows the enforcement mode — in `SELECTED` only
  individually-flagged users count, or the panel reports a coverage gap that does not exist.
  Every figure is a COUNT aggregated in the database; no per-attempt row is returned.

  Kept as a sibling of `/face/stats` rather than more fields on it: that endpoint answers a
  **calibration** question (where this workforce's similarity distribution sits relative to the
  threshold) over a fixed 90 days and pulls rows to compute percentiles. This one answers an
  **operations** question over a window the admin picks. Folding them together would make the
  calibration card pay for a window it never uses.
- `GET /face/policy-recommendation` — ADMIN/SUPER_ADMIN; the "policy copilot". Returns
  `{ currentThreshold, recommendedThreshold, currentRejectRatePct, projectedRejectRatePct,
  passedMedian, rejectedMedian, separation, sampleSize, summary, narrative }`. The recommendation
  is computed **arithmetically** from this workspace's own passed/rejected similarity
  distribution (widest gap between the two clusters) — never by an LLM, so it's fully useful with
  AI switched off. `narrative` is an optional LLM narration of those same numbers
  (`GlobalAISettings.facePolicyCopilotEnabled`); it explains the number, it never sets it, and is
  `null` when AI is off, over budget, or the response couldn't be parsed. Refuses to recommend
  (explains why instead) below 30 judged checks or when the passed/rejected clusters overlap —
  in the latter case no threshold separates them, and the real fix is re-enrollment, not tuning.
- `POST /face/auto-triage` — ADMIN/SUPER_ADMIN; manually runs the same routine the daily worker
  runs when `autoTriageHonestFailures` is on. Clears review flags only where the evidence says
  "honest failure": a `NO_FACE`/`MULTIPLE_FACES`/`LOW_QUALITY`/`CHALLENGE_FAILED` outcome with no
  virtual-camera or provenance suspicion, where the same user passed within the following hour.
  Returns `{ resolved }`; a no-op (`resolved: 0`) is not an error. Never touches an attempt
  carrying any injection signal.
- `GET /face/evidence/timesheet/:id` — ADMIN/SUPER_ADMIN; the dispute-ready identity evidence
  pack (see FACE_VERIFICATION.md's "Identity evidence pack" section). Bundles the timesheet, every
  identity check bound to it (submitter's and approver's, with scores/thresholds/provenance),
  the consent record(s) behind those checks, and the policy in effect at export time. Excludes
  the biometric template and filesystem paths, same rule as `/face/export`. 404s for an unknown
  or deleted timesheet.
- `GET /face/image/attempt/:id` and `GET /face/image/enrollment/:userId` — streams stored
  imagery. Served from the API (not the public `/uploads` mount, which has no auth at all) and
  readable only by the subject or an admin; `Cache-Control: private, no-store`.

Settings live under the usual settings surface:

- `GET /settings/face-verification` — auth-only (the client needs the consent text/retention);
  includes the computed `allowedByPlan`.
- `PATCH /settings/face-verification` — SUPER_ADMIN. Setting `enabled: true` requires the plan
  entitlement (403 otherwise); every other field stays editable so an org mid-upgrade can stage
  configuration. Thresholds are bounded server-side (`matchThreshold` 0.3–0.99) — a threshold
  of 0 would match anyone and 1 would match nobody. A PATCH that activates coverage also
  notifies covered-but-unenrolled users (deduped, 72h). `autoTriageHonestFailures` (default off)
  opts into the daily worker clearing honest-failure flags automatically — see `POST
  /face/auto-triage` above for exactly what qualifies.

**Enforcement.** When the policy covers a user, the protected requests require a valid
`faceVerificationId` and return **428 Precondition Required** without one (or with one that's
expired, already spent, for a different user, or for a different context):

| Request | Context consumed |
|---|---|
| `POST /timesheets/submit` (and `submit-with-files`) | `TIMESHEET` — drafts are never gated |
| `PATCH /timesheets/:id/approve` | `APPROVAL` — checks the **approver**; reject is ungated |
| `POST /tickets` | `TICKET` |
| `PATCH /tickets/:id/status` | `TICKET` — comments and field edits are never gated |

**Verified badges.** `GET /timesheets` rows carry `identityVerified` / `identityVerifiedAt` /
`identityVerificationApplies` (the policy covers this row's author — lets the UI mark
covered-but-unverified rows distinctly from not-covered ones), and `GET /tickets/:id` carries
`identityVerified` / `identityVerifiedAt` for the most recent check spent on the ticket.

## Reports

- `GET /reports/employee-summary`
- `GET /reports/admin-summary` — also returns a same-shaped `<metric>Yesterday`/`<metric>LastWeek`
  baseline field alongside every headline metric (e.g. `usersYesterday`, `approvedLastWeek`,
  `todayDailyRemindersSentYesterday`) so the frontend's `computeTrend()` (`lib/trend.ts`) can
  render a today-vs-yesterday or this-week-vs-last-week badge without a second request. A `null`
  trend (baseline was 0) means "no badge shown," not an error.
- `GET /reports/ticket-summary` — same pattern: `openSlaBreachesYesterday`, `resolvedLastWeek`,
  `avgResolutionHoursLastWeek` alongside the current-period fields.
- `GET /team/sla-summary` — same pattern, scoped to the calling manager's direct reports:
  `submittedYesterday`, `breachedYesterday`, `approvedLastWeek`, `openEscalationsYesterday`.
- `GET /team/reports/:userId/hours-trend` — authenticated, with **no separate role check because
  the lookup *is* the scope check**: the user is fetched with `managerId = <the caller>`, the same
  predicate `GET /team/reports` filters the roster by, so a `userId` on somebody else's team
  simply does not match and there is no window in which their rows could be aggregated. That miss
  answers **404, not 403**, so the route cannot be used to probe which user ids exist outside the
  caller's own team.

  Returns `{ user: { id, name }, currentMonth: { monthStart, weeks[] }, monthly[] }`. `weeks[]`
  carries `weekStart`/`weekEnd`/`hours`/`entries` for the ISO (Monday-start) weeks of the current
  month, **clipped to the month** — a bucket running into a neighbouring month would attribute
  hours that `monthly[]` counts elsewhere, which is exactly the comparison the dialog exists to
  support, so the first and last bucket may be short. `monthly[]` is `monthStart`/`hours`/
  `entries` for the trailing 12 calendar months, zero-filled. All dates are `YYYY-MM-DD`.

  Counts **all logged hours, not just approved ones**: the question is how much this person is
  working, and an entry still sitting in `DRAFT`/`SUBMITTED` is work that was done. The
  approved-only total already sits beside it in `GET /team/reports`'s `stats.approvedHours`.
  Summed in the database — raw timesheet rows never leave the server.
- `GET /reports/export.xlsx`
- `GET /reports/export.pdf`
- `GET /reports/cost-insights` — opt-in (`GlobalTicketSettings.enableCostAnalytics`). Covers
  **approved, billable** hours only, priced at the rate frozen onto each timesheet when it was
  approved (falling back to the person's current rate only for entries approved before rate
  snapshotting existed). Alongside `totalCostUsd`/`avgCostPerTicket`/`rows` it returns
  `unratedHours` (hours with no rate on record — reported, never priced as zero) and
  `excludedDraftHours`/`excludedRejectedHours`.

## Planning (V6)

Two routers, split by audience. `/planning/*` is configuration a SUPER_ADMIN sets once;
`/plan/*` and `/portfolios/*` are what everyone uses daily. **Every `/plan` and `/portfolios`
route 403s unless planning is switched on for the workspace AND the org's tier includes it** —
the two conditions produce deliberately different messages, because "turn it on in settings" and
"upgrade your plan" need different people to do different things.

Planning dates on the wire are always `YYYY-MM-DD`, never ISO instants. A planning date is a
calendar day: "starts on the 3rd" must mean the same thing in every timezone, and a time-of-day
makes the same stored value render as two different days across a boundary.

### Configuration

- `GET /planning/settings` — returns `{ settings, entitlements, effective }`. `effective` is the
  server-computed AND of the two; **clients gate on `effective` and never recompute it**, or the
  nav ends up offering a page the API refuses.
- `PATCH /planning/settings` — SUPER_ADMIN. Toggles, working days (`workingDays`, 0 = Sunday,
  at least one) and `defaultWeeklyCapacityHours`.
- `GET /planning/workflows`, `GET /planning/workflows/meta` — the status vocabulary the editor
  renders from, served rather than duplicated client-side.
- `POST|PUT|DELETE /planning/workflows[/:id]` — SUPER_ADMIN, Enterprise-gated. The system
  "Default" workflow cannot be edited or deleted; duplicate it instead. A status whose
  `legacyStatus` changes re-aligns every ticket sitting in it, in the same transaction.
- `GET|POST|PUT|DELETE /planning/custom-fields[/:id]` — SUPER_ADMIN to write. Deleting a field
  that has stored values **deactivates** it instead and returns `{ deleted: false }`; a hard
  delete would cascade the values away.

### The plan

- `GET /plan/timeline?projectIds=&from=&to=&includeClosed=` — the solved schedule in tree order
  (each item immediately followed by its own subtree). Every row carries both what a human
  entered (`startDate`/`endDate`, null when unscheduled) and what the solver resolved
  (`resolvedStart`/`resolvedEnd`, always present) plus `isInferred`, `durationDays`,
  `totalFloatDays`, `isCritical`, `effectiveProgressPct`, `slipDays` and any `violations`.
  Ordering, float and criticality are computed server-side so the timeline, the portfolio
  roll-up and later the risk score cannot disagree.
- `GET /plan/dependencies?projectIds=` — the scheduling edges, so the chart draws arrows without
  re-deriving them per item.
- `PATCH /plan/items/:id` — `plan:write`. Dates, `parentId`, `isMilestone`, `progressPct`,
  `sortOrder`, `estimatedHours`. An end before a start is **422, never silently swapped** — a
  swap guesses which of the two the author meant. A cross-project parent is refused, as is one
  that would make an item its own ancestor.
- `POST /plan/items/:id/baseline` `{ clear? }` and `POST /plan/projects/:projectId/baseline` —
  freeze or clear. Never automatic: slip is only meaningful because the baseline is frozen at a
  moment a human called "the agreed plan".
- `POST /plan/dependencies` `{ fromId, toId, type, lagDays? }` — `type` is one of `BLOCKS`
  (treated as finish-to-start), `FINISH_TO_START`, `START_TO_START`, `FINISH_TO_FINISH`,
  `START_TO_FINISH`. `lagDays` is in **working** days; negative is a lead. A cycle is refused
  **422 before the write**, naming the ring — discovering it later as a wrong-looking timeline
  gives nobody a way to tell which of forty links is at fault.
- `PATCH|DELETE /plan/dependencies/:id`.
- `GET /plan/calendar?from=&to=&projectIds=` — dated items in a window. Deliberately does **not**
  run the solver: a calendar shows what is scheduled, and an inferred date has no business
  appearing on a specific day as if someone committed to it. Items with only an SLA date are
  returned with `isScheduled: false` so the UI can mark them.
- `GET /plan/my-work` — the caller's own queue, bucketed `overdue`/`today`/`thisWeek`/`later`/
  `blocked`. No permission gate and no planning gate. A blocked item appears in **exactly one**
  bucket; listing it under "today" as well puts work at the top of someone's list that they
  cannot start.
- `GET|POST|PUT|DELETE /plan/views[/:id]` — saved filter/column/sort per view type. `SHARED`
  needs `dashboards:share`. A shared view is a saved FILTER, not a data grant: opening one still
  runs every normal project-scope check.

### Portfolios

- `GET|POST|PUT|DELETE /portfolios[/:id]` — `portfolios:manage` to write, quota-checked against
  the tier. Deleting one **ungroups** its projects rather than taking them with it.
- `POST /portfolios/:id/projects` `{ projectIds }` — sets membership wholesale.
- `GET /portfolios/rollup?portfolioId=` — schedule, progress, budget burn and forecast per
  project, plus portfolio totals. Everything is **derived**: the schedule from the same solver
  the timeline uses, the burn summed live from the `Timesheet.billedAmount` rate snapshots that
  a Verified Work Attestation also reads. `forecastAtCompletion` is `null` below 5% progress or
  with zero spend — the arithmetic there produces a confident number that is noise, and
  "forecast: 0" reads as "this will cost nothing".

### Resources & budget

Every `/resources` route needs `resources:manage` and both the workspace toggle and the tier
entitlement, except the budget panel which needs only `reports:view`.

- `GET /resources/workload?from=&to=&granularity=&projectId=` — the person × bucket grid. Each
  cell carries `capacityHours` (gross capacity **minus** time off, i.e. what is actually
  available), `bookedHours`, `loggedHours` and `allocationPct`. `allocationPct` is **null** when
  there is no capacity to divide by; `isOverAllocated` carries the meaning in that case. The
  threshold is 102%, not 100% — exactly-fully-booked is the intended state, and flagging it
  trains people to ignore the colour.
- `GET /resources/conflicts` — overlapping bookings whose combined daily rate exceeds the
  person's daily capacity. Informational: bookings are never refused for overlapping, because
  splitting someone across two projects is sometimes exactly the plan.
- `GET|POST|PUT|DELETE /resources/bookings[/:id]` — `hoursPerDay` is per **working** day, so a
  Mon–Sun booking at 8h/day is 40 hours, not 56. An inverted date range is a 422; an overlap is
  not. `isTimeOff` marks leave, which reduces available capacity rather than counting as load.
- `GET /resources/capacity`, `PATCH /resources/capacity/:userId` — `weeklyCapacityHours` and
  `plannedUtilizationPct`. Null on either clears the override and returns the person to the
  workspace default, which is a different fact from "their week happens to equal the default".
- `GET /resources/budget/:projectId` — budget, burn, forecast and estimate-vs-actual variance for
  one project. Progress comes from the same solver the timeline uses, so the percentage driving
  the forecast is the percentage shown on the Gantt. Variance covers **finished** work only: a
  half-done task is under its estimate by definition, and including it would make every project
  look like it beats its estimates. The headline figure is the **median**, because one task that
  took 12× its estimate drags a mean into uselessness.

### Intake, blueprints, approvals & proofing (V6 phase 4)

- `GET|POST|PUT|DELETE /request-forms[/:id]` — `forms:configure`. Deleting a form that has
  submissions **deactivates** it instead and returns `{ deleted: false }`; cascading the
  submissions away would destroy the record of what people asked for.
- `POST /request-forms/:id/publish` `{ publish }` — minting the public link is a **separate,
  deliberate step** from creating the form. Withdrawing CLEARS the token rather than setting a
  flag, so a revoked URL can never be resurrected; re-publishing mints a new one.
- `GET /request-forms/submissions`, `POST /request-forms/submissions/:id/accept|reject` —
  accepting clears the review flag; rejecting soft-deletes the ticket the submission created.
  There is no "create from submission" endpoint: a submission becomes a ticket at submit time,
  because holding real requests in a queue nobody watches is how intake systems lose work.
- `GET|POST /shared/request-forms/:token` — **unauthenticated**. See ARCHITECTURE §3.9 for the
  full posture. `POST /shared/request-forms/:token/visible` evaluates the conditional rules live,
  so a long form does not have to reimplement the rule engine to stay in step with what the
  server will accept.

- `GET|POST|PUT|DELETE /blueprints[/:id]` — `plan:write` to write.
- `POST /blueprints/:id/preview` `{ startDate }` — what instantiating WOULD create, from the same
  pure expander, writing nothing. Offsets are counted in **working** days.
- `POST /blueprints/:id/instantiate` `{ projectId, startDate, titlePrefix? }` — one transaction.
  A half-instantiated 40-item structure is worse than a clean failure, because there is no
  obvious way to tell what is missing or to safely retry.
- `POST /blueprints/derive` `{ projectId, name }` — learn a blueprint from a project that already
  ran. Offsets are measured from the earliest dated item, not the planned start, so a past
  overrun is not baked into every future instantiation.

- `GET /approvals/ticket/:ticketId`, `POST /approvals`, `DELETE /approvals/:id` —
  `approvals:manage` to create. Each step names **exactly one** approver, internal or guest,
  never both and never neither. Guest tokens are never returned to the panel.
- `POST /approvals/steps/:stepId/decide` — the decision belongs to the named approver and nobody
  else, not an admin and not the requester. Out-of-turn is **409**, already-decided is **409**.
- `POST /approvals/steps/:stepId/resend` — mints a fresh guest link and kills the previous one.
- `GET|POST /shared/approvals/:token` — **unauthenticated**, single-use, one decision on one step.

- `GET|POST /proofs/attachment/:attachmentId`, `PATCH /proofs/:id/resolve`, `DELETE /proofs/:id` —
  coordinates are normalised 0-1 so a pin lands on the same spot at any render size. Resolving is
  a toggle, not a delete: a resolved note is the record of a review round. Only the author (or a
  ticket manager) may delete — someone removing another reviewer's objection is exactly what a
  review record must not allow.

### AI planning copilot (V6 phase 5)

- `GET /ai-proposals/risk/:projectId?narrate=` — the computed risk score, band, all six signals
  with their points and detail, worst-first concerns, and the measured facts. **Works with AI
  switched off**; `narrate=true` additionally attempts a narrative and returns `narrative: null`
  rather than failing if the model is unavailable, over budget, or disabled.
- `GET /ai-proposals/risk` — the latest stored snapshot per project, for badges and the portfolio
  table. A project the nightly worker has not scored yet simply has no entry.
- `POST /ai-proposals/risk/:projectId/refresh` — recompute and store now. `plan:write`.
- `GET /ai-proposals?status=&projectId=` — proposals with their change rows.
- `POST /ai-proposals/plan-breakdown` `{ projectId, parentTicketId?, goal, context? }` — Enterprise
  + `planBreakdownEnabled`. Returns a **proposal**, never a write. Existing ticket titles are sent
  as context so the model does not propose work that already exists.
- `PATCH /ai-proposals/:id/decisions` `{ decisions }` — record per-row accept/reject without
  applying, so a long review can be done in sittings.
- `POST /ai-proposals/:id/apply` `{ decisions }` — applies only the accepted rows. There is
  deliberately **no apply-all shortcut**: that would recreate the rubber stamp the envelope exists
  to prevent. Returns `{ applied, skipped, failed[], status }`; a row refused for stale state is
  reported with its reason rather than silently dropped. Applying twice is a **409**.
- `POST /ai-proposals/:id/reject`.

### Dashboards & scheduled reports (V6 phase 6)

Needs `reports:view`; publishing a `SHARED` dashboard additionally needs `dashboards:share`.
Dashboards themselves are **not** behind the planning toggle — several widget types read only
tickets and hours, which every workspace already has.

- `GET /dashboards/catalogue` — the widget types the server will resolve, each with its `shape`
  (`STAT`, `SERIES`, `BREAKDOWN`, `TABLE`) and a description. The catalogue is **closed**: a
  client cannot invent a widget by inventing a `type`, and a widget cannot carry its own query.
  Both are on purpose. An open catalogue means "open items" gets defined once per dashboard and
  two tiles claiming the same label quietly disagree; it also means a widget definition becomes
  an injection surface reachable by anyone who can save a layout.
- `GET|POST|PUT|DELETE /dashboards[/:id]` — a dashboard is a name, a scope and an array of widget
  specs (`type`, optional title, `config`, grid position). Unknown widget types are refused
  **422 at save time**, not skipped at render time, so a layout that saved will draw.
- `GET /dashboards/:id/data` — layout **and** every resolved widget in one response. Eight tiles
  fetched separately would be eight round trips on every page load, and a grid that populates
  tile-by-tile reads as broken.

  Each widget resolves against **the caller's own project scope**, never the author's. This is
  what makes sharing safe to do casually: a shared dashboard stores a layout, so publishing one
  can never publish a project the viewer could not already open. Two people opening the same
  shared dashboard can legitimately see different numbers.

  A widget that cannot be computed comes back with `unavailable` and **no value**. A zero would
  be a claim — "no overdue work" and "I could not check" are opposite messages — and one bad
  tile never takes the page down with it.

- `GET|POST|DELETE /dashboards/subscriptions[/:id]` — email a dashboard on a `DAILY`, `WEEKLY` or
  `MONTHLY` cadence to any list of addresses, including people with no account. Recipients are
  plain strings, deliberately: the point is reaching a stakeholder who will never log in.

  The worker runs hourly and resolves the widgets **as the subscription's owner**, so a report
  can never show more than the person who set it up can see. If that person is deactivated or
  deleted the subscription deactivates itself rather than continuing to send with stale
  authority — the failure mode of a departed employee's report still mailing figures outward for
  months is the one worth designing against. `lastSentAt` is the cadence guard, so a restart or a
  double-fired cron re-sends nothing.

## Timesheet reporting and exports

All three share one filter set — `from`, `to`, `projectId`, `moduleId`, `userId`, `ticketId`,
`status`, `activityType`, `billable` — parsed and applied in one place
(`services/timesheet-report.service.ts`). That sharing is the point: a CSV and a PDF asked for the
same thing must not be able to disagree about what "the same thing" means, and the way that
failure presents is somebody exporting both for "March, Apollo", getting different totals, and
having no way to tell which is lying.

Unknown filter values are **dropped, not rejected**. A report URL gets bookmarked, hand-edited and
pasted around; refusing the whole request over one stale `status=CLOSED` from an older build is
worse than reporting on everything else. The grouped response echoes the filters it actually
applied.

- `GET /reports/timesheets?groupBy=` *(`reports:view`)* — the grouped report. Nine groupings:
  `user`, `project`, `module`, `activity`, `status`, `ticket`, `day`, `week`, `month`. Each group
  carries hours, billable hours, entries, distinct people, cost, and its real first/last date.

  **Every grouping of the same rows totals identically** — asserted in both the unit and e2e
  suites, because a report where "by user" and "by project" disagree is worse than no report:
  somebody acts on whichever they opened, with nothing on screen to say the other exists. Related:
  un-ticketed work is its own bucket rather than dropped. For most workspaces it is the majority of
  hours, and excluding it would make every total understate reality while looking complete.

  **`cost` is `null`, never `0`, when no row in the group carries a rate.** `billedAmount` is a
  snapshot frozen at approval, and rows approved before that existed have none — deliberately not
  backfilled, since inventing "the rate at the time" from today's rate would assert something
  untrue. Zero would read as "this work was free"; null reads as "we do not know". Where a group is
  partly rated, `cost` is the part we know and `unratedEntries` says how much we do not.

- `GET /reports/analytics?from=&to=&…` *(`reports:view`)* — utilisation, approval latency and
  activity mix. **The date range is required and the endpoint 422s without it**: utilisation is
  hours divided by capacity, and capacity only exists relative to a period. "Utilisation, all time"
  is not a question with an answer, and silently choosing a window would produce a confident
  percentage nobody asked for.

  - **Utilisation** reuses `capacityForBucket` from the workload service rather than
    reimplementing it, so a person cannot read as 80% booked on the workload board and 120%
    utilised on the report for the same fortnight. `capacityHours` and `utilisationPct` are
    **null** for anyone with no contracted hours on file and no workspace default — 0% would read
    as "this person did nothing" when the truth is "nobody told us their hours".
  - **Approval latency** needs `Timesheet.submittedAt`, which is NULL on every row submitted
    before that column existed and deliberately not backfilled. Those are counted as
    `unmeasurable` alongside `measured`, so a median over three of two hundred entries is never
    read as covering all two hundred. `breachRatePct` is unaffected and works from day one — it
    reads `approvalDeadline`/`slaBreachAt`, which have always been stored.
  - **Activity mix** shares are rounded by largest remainder so they sum to exactly 100. Rounding
    each independently yields sets totalling 100.1%, which on a labelled pie reads as an
    arithmetic error — and a report caught being wrong about something trivial is not trusted
    about anything else.

- `GET /reports/export.xlsx?groupBy=` *(`reports:view`)* — a real workbook: a **Summary** sheet
  carrying the grouped breakdown and an **Entries** sheet with every row, typed. CSV has no types,
  so every date and number arrives as text and gets re-typed by hand before anyone can pivot — or
  does not, and sorts `10.5` before `9.0`. Dates, hours, rates and amounts are real cells with
  number formats, the header row is frozen, and an autofilter is applied.

- `GET /reports/export.csv` *(`reports:view`)* — 22 columns including billing (`Billable`, `Rate`,
  `Amount`), review (`Reviewed by`, `Reviewed at`), SLA (`Approval deadline`, `SLA breached at`)
  and the ticket key. Emitted with a UTF-8 BOM so Excel does not mangle accented names.

- `GET /reports/timesheets/:id/export.csv` *(`reports:view`)* — **one entry**, with the same 22
  columns and the same UTF-8 BOM as the bulk export above, filenamed
  `timesheet-entry-<YYYY-MM-DD>-<id-prefix>.csv`. Sets `X-Report-Rows-Included: 1`; there is
  nothing here to truncate.

  A route rather than an `id=` filter on the shared filter set, because every filter that set
  accepts describes a **set** ("this project, this month") and a single-row escape hatch would
  blur what an export's scope line means. This is a different question — "give me the record
  behind this decision" — asked from the approvals queue, where an approver wants the row they are
  about to sign off on as a file they can attach to *why* they signed it. Gated on `reports:view`
  like the rest of the export family rather than `timesheets:approve`, since it returns somebody
  else's hours, rate and cost. Soft-deleted entries stay unreachable (**404**) for the same reason
  every other export excludes them: somebody retracted that work.

- `GET /reports/export.pdf` *(`reports:view`)* — the same set as a document, printing its own
  scope ("Scope: 2026-03-01 to 2026-03-31 · status APPROVED") so a filtered report cannot be
  mistaken for a complete one once printed or forwarded.

**Truncation is always stated, never silent.** Both exports return `X-Report-Rows-Included` and
`X-Report-Total-Matching`, plus `X-Report-Truncated: true` when they differ; the PDF additionally
prints the caveat in red in the header and repeats it in the footer, because a long report is often
read from the last page backwards.

This matters because of what it replaced. The PDF capped at 500 rows and then printed
`Entries: 500  Total hours: X` computed from those 500, with nothing anywhere saying it had been
cut — a document stating a confidently wrong number, in a file somebody might hand to a client or
an auditor. Same class of failure as colouring an unmonitored day green on a status page: not
missing information, but asserted-wrong information.

## Users — management listing and bulk actions

- `GET /users` — the flat array every assignee/manager/approver **picker** reads. Ordered by name,
  capped at 2000. It is not paginated on purpose: a picker wants everyone it could offer, and the
  old 50-row cap meant that in any org past fifty people those dropdowns silently omitted most of
  them.
- `GET /users/paged?search=&roleId=&designation=&status=&online=&sort=&dir=&page=&pageSize=` — the
  management table. `search` spans name, email, job title **and role name**; because `Role.name` is
  an enum there is no `contains` to reach for, so the server matches the known values and turns
  them into an `in`. Returns `{ items, total, page, pageSize, filteredOnPage, onlineFilterApplied,
  designations }`.

  `online` is applied **in memory, after the database filters**, because presence lives in
  `Session` under a 15-minute `lastSeenAt` rule rather than on `User`. Making it a WHERE clause
  would mean a join that slows every other filter for the one used least. `total` therefore counts
  the database filters and `filteredOnPage` counts what survived — both are returned rather than
  reporting one and implying it covers the other.

- `POST /users/bulk-action` `{ action, userIds? | filter?, password? }` — `DEACTIVATE`, `ACTIVATE`,
  `RESET_PASSWORD`, `RESEND_WELCOME`, `FORCE_LOGOUT`, `DELETE`.

  **Two ways to choose the targets, and the second is the point.** An explicit list of ids, or the
  current `filter` — "apply to everything matching" cannot be done by posting ten thousand ids from
  a browser, and re-deriving the set server-side from the same query the table used is the only way
  the operator's selection and the server's cannot disagree.

  **Refusals are per user.** Acting on a `SUPER_ADMIN` without being one, or on your own account,
  skips that row with a reason rather than aborting the batch. A bulk action that stops at the
  first protected user leaves a half-applied change and no indication of which half ran. Returns
  `{ applied, requested, skipped[] }`. `DEACTIVATE` and `DELETE` also revoke sessions — leaving
  them live means the person keeps working until their token expires.

## Notification settings

- `GET /settings/notifications` *(SUPER_ADMIN)* — the workspace notification singleton: all 27
  `email*` category booleans, the reminder schedule (`dailyReminderHour`,
  `escalationReminderHour`, `remindOnWeekdaysOnly`), `bccSuperAdminOnAllEmails`, `emailRoleMutes`,
  and read-only runtime meta (`serverTimezone`, `serverUtcOffset`, `serverNow`) so an hour picker
  can say which clock it is actually setting.
- `PATCH /settings/notifications` *(SUPER_ADMIN)* — every field optional; the body is strict, so an
  unknown key is **422** rather than a silently ignored setting.

### The `emailRoleMutes` map

A map of notification category → the roles that must **not** receive that category's email:

```json
{ "emailRoleMutes": { "emailDailyReminder": ["MANAGER", "SUPER_ADMIN"], "emailEscalation": ["EMPLOYEE"] } }
```

Keys are constrained to `notificationPreferenceKeys` and values to `roles` (`SUPER_ADMIN`,
`ADMIN`, `MANAGER`, `TEAM_LEAD`, `EMPLOYEE`), both from `@timesheet/shared`; an unrecognised key
or role is **422**. The underlying column is free-form JSON, so this schema is its **only**
integrity check — a typo would otherwise persist a mute that no UI could ever find and clear
again.

- **It stores the mutes, not the ticks.** A category whose list arrives empty is dropped
  server-side, so "absent" means "everyone receives" and the stored JSON stays proportional to
  what was actually suppressed rather than to the whole grid the UI draws.
- **The PATCH replaces the whole map; it does not merge per key.** The matrix UI always sends the
  complete map, and under a merge, un-ticking the last muted role for a category would be
  impossible to express.
- **It gates the EMAIL leg only.** The in-app bell notification is written first and always fires,
  so muting `MANAGER` on an escalation stops the inbox copy without hiding the escalation itself.
- It also applies to `bccSuperAdminOnAllEmails`: a SUPER_ADMIN who muted a category does not get
  the blanket audit BCC of it either, or the hidden copy would re-deliver exactly what they just
  muted.

Omitting `emailRoleMutes` from a PATCH leaves the stored map untouched. See
[DATABASE.md](DATABASE.md#per-role-email-mutes-globalnotificationsettingsemailrolemutes) for the
column and why NULL is the correct default forever.

## Email delivery analytics

The whole `/email-templates` router is `requireAuth` + `requireSuperAdmin`, these two included.

- `GET /email-templates/analytics` — aggregate read models over `EmailLog` for the Email templates
  screen. No parameters; the windows are fixed. Returns `generatedAt`, workspace `totals`
  (`total`, `sent`, `failed`, `queued`, `test`, `unmapped`), `today` and `yesterday`
  (`sent`/`failed`/`queued`/`total`), `perTemplate[]`, `unmapped[]`, and zero-filled `daily` (30
  days), `weekly` (12 Monday-start weeks) and `monthly` (12 months) series of
  `{ bucket, sent, failed, queued, total }`.

  **`EmailLog.template` is not a template key**, which is why the per-template rows are a
  reconciliation rather than a join: `dispatchNotification` writes the notification *category*
  into that column while `dispatchTransactional` writes the template key. Each `perTemplate` row
  therefore carries `sources[]` (the log values feeding it) plus `shared`/`sharedWith` — one
  category can feed two cards (`reminder.escalation` renders both the employee and the manager
  template), and a shared total must not be summed across rows. Anything reconciling to no card at
  all is reported in `unmapped[]` rather than dropped, so the per-template numbers can never
  quietly add up to less than the workspace total with nothing on screen saying where the rest
  went; `totals` is computed independently of the reconciliation for the same reason. Editor test
  sends (`<key>.test`) are counted into `test` so they can be told apart from real traffic.

- `GET /email-templates/analytics/failures?days=` *(1–365, default 30)* — `FAILED` rows grouped by
  **reason**. Returns `windowDays`, `since`, `totalFailures`, `sampledFailures` and `reasons[]`:
  `id`, the normalised `reason`, one verbatim `sample`, `count`, `firstSeen`/`lastSeen`,
  `templates[]` (`{ template, count }`), up to 50 `recipients[]` (`to`, `count`, `lastAt`,
  `lastMessage`) with `recipientsTruncated` when that cap bit, and `domains[]`
  (`{ domain, count }`, top 10 across the *whole* group, not just the recipient sample) — what
  lets the UI say "this is a gmail.com problem" without listing addresses.

  The grouping is the feature. Queue ids, message ids, IPs, UUIDs, timestamps and the rejected
  address all change on every attempt, so without normalising them away "550 mailbox unavailable"
  for 400 recipients reads as 400 distinct one-off failures and the actual pattern is invisible.
  Numeric SMTP codes (`550`, `5.7.1`) are left intact — those are the signal, not the noise.
  Compound session tokens are collapsed *including* their ordinal suffix (Gmail's
  `a1b2…-f6g7….2` vs `.6` used to split one throttling pattern into six "different" reasons).
  Normalisation happens in JS (SQL cannot strip a volatile id out of an SMTP string), so at most
  5,000 rows are inspected per request; `totalFailures` is counted separately from
  `sampledFailures` precisely so the UI can say when it is looking at a sample rather than at
  everything.

- `POST /email-templates/analytics/failures/analyze` — body `{ reasonId, days? }`. AI diagnosis of
  ONE failure group: returns `{ diagnosis, likelyCause, transient, actions[] }`. Gated on
  `GlobalAISettings.emailFailureTriageEnabled` (off by default, like every AI toggle) plus the
  usual master switch and monthly budget. The client sends only the group's opaque `id` — the
  reason text, counts and SMTP sample are **re-derived server-side** from `EmailLog`, so the
  model's input is always what the server measured, never a string a browser composed; it is given
  recipient *domains* only, never addresses, and the external-authored SMTP text is fenced as data
  in the prompt. 404s when the group no longer exists in the window (refresh and retry).

- `GET /email-templates/analytics/domains?from=&to=` *(ISO dates, both optional; defaults to the
  last 30 days)* — delivery split by **recipient domain**. Returns the resolved `from`/`to`,
  `totals`, up to 20 `domains[]` rows (`domain`, `total`, `sent`, `failed`, `queued`,
  `successRate`, `topFailures[]` — that domain's top 3 normalised failure reasons —, and
  `oldestQueuedAt`, the oldest still-in-flight send: in-flight mail normally settles within one
  worker tick, so an old timestamp means *stuck*, not busy), `truncated` plus an aggregate
  "(N other domains)" row when more domains existed, and a zero-filled `daily` series for the
  range. `successRate` is `sent / (sent + failed)` — in-flight mail is excluded because it has
  not been judged yet, and counting it either way would swing the rate on every worker tick.

## AI text refine

Both routes need the normal JWT session. They sit on the `/ai` router, which mounts
`requireAuth` for everything and `middleware/ai-rate-limit.ts` (20/min, keyed on the **user**, not
the IP) for everything that can reach a model.

- `GET /ai/text/refine/availability` — "can I offer the Refine button, and if not, what do I tell
  the user?" Returns `{ available, reason: "ok"|"disabled"|"budget"|"unavailable", message }`.

  **Registered above the AI rate limiter, deliberately.** It makes no model call and costs nothing,
  and every form carrying the affordance asks on mount — counting it against the 20/min AI budget
  would mean opening the timesheet form twenty times locks a user out of the actual refinements.
  It answers from the same `preflight` the refine call itself runs, so the button is disabled with
  the real reason rather than failing when clicked.

- `POST /ai/text/refine` — `{ text, field }`, where `field` is one of `ticket_title`,
  `ticket_description`, `ticket_comment`, `timesheet_description`, `timesheet_notes`
  (`text`: 1–20 000 chars). Returns:

  ```json
  { "refined": "…", "refinedHtml": "…or null", "format": "plain" | "html", "original": "…" }
  ```

  `original` is the caller's own text **as the model saw it** (rich text flattened to plain), so
  the compare view in the UI is like for like. `refinedHtml` is populated only for rich-text
  fields, already through the server's `sanitizeRichText` allow-list.

  **Permission depends on the field, not on the route.** The rest of this router is ticket work and
  can hang one `requirePermission(tickets:write)` off each route; refine also covers timesheet
  fields, and an EMPLOYEE filling in a timesheet has no reason to hold `tickets:write`. So the
  three `ticket_*` fields require `tickets:write` and the two `timesheet_*` fields require
  `timesheets:write` — "can you edit this text at all" and "can you have the AI tidy it" give the
  same answer. Validation runs first, so `field` is a known value before the permission is looked
  up; a mismatch is `403`.

  Gated by the AI master switch **and** the `writingAssistantEnabled` toggle, and charged against
  the same monthly budget as every other capability (logged to `AIUsageLog`/`AIInteraction` under
  its own `text_refine` feature). `422` when the field is empty or unrefinable, `402` when the
  budget is spent, `403` when AI or the writing assistant is off, `502` if the model returns
  nothing — returning the original unchanged would look like the model had considered it and
  chosen to leave it alone.

- `POST /ai/text/improve` — `{ text, context }` — the older whole-field rewrite, still mounted and
  still gated on `tickets:write`. No longer surfaced in the UI: it replaced what the author had
  typed, with no preview and no way back.

## AI usage

- `GET /settings/ai/usage-summary` — this month's spend, calls and tokens, by feature and by model.
- `GET /settings/ai/usage-trend?weeks=` — weekly spend.
- `GET /settings/ai/feature-usage?days=` *(max 90)* — per-feature consumption, cumulative **and**
  day by day. Returns `features[]` (input/output/total tokens, calls, average per call, share,
  models) and `daily[]`, one entry per day with a numeric key per feature.

  **Tokens lead, cost follows.** `costUsdEstimate` is computed from a price table at call time: it
  shifts when a provider changes prices and is wrong for anyone on BYOK with negotiated rates,
  which makes it a poor basis for comparing months. Tokens are what was consumed.

  The daily series is **pivoted and zero-filled server-side**. Pivoting in the browser means every
  consumer reimplements it, and the zero-filling is what gets forgotten — a feature with no calls
  on Tuesday must be `0` and not absent, or a stacked chart silently changes what each colour means
  from one day to the next. Days with no activity at all are included for the same reason.

## Service status page

- `GET /maintenance/status-page?days=` *(SUPER_ADMIN, max 365)* — per-feature current status, a
  day-by-day history, uptime percentages and the incident log.

  Distinct from `GET /maintenance/health`, which reports the **box** (CPU, memory, disk, event-loop
  lag) as measured right now. This reports the **features** over time, which is the question people
  actually arrive with: a server at 12% CPU with both databases answering is perfectly healthy
  right up until nobody can submit a timesheet.

  A day carries `status` (its **worst** sample, not its average — averaging is how a two-hour
  outage becomes a 96%-green day), `samples`, `downSamples`, `degradedSamples` and `uptimePct`. A
  day with no samples has `status: null`; reporting absence of monitoring as success is the one
  lie a status page must never tell, so `overall` is also null until something has been measured.

- `POST /maintenance/status-page/run` *(SUPER_ADMIN)* — probe everything now instead of waiting for
  the five-minute worker. Exists because the first thing anyone does with a status page is check
  whether it is telling the truth, and it makes the page usable immediately after an install rather
  than showing an empty strip until the first cron tick.

  Probes exercise each feature's real dependency — a bounded query, the mail transport's own
  verification state, the AI provider's configuration. Deliberately not HTTP self-calls (which
  prove only that the process can reach itself, and need a credential to clear auth) and never
  writes (a monitor that creates rows every five minutes to prove writes work has become a source
  of the load it measures). Three states, because "slow but answering" and "not answering" need
  different reactions, with a per-probe threshold — a ticket list must feel instant, a report is
  allowed to take a moment.

## API performance telemetry

The third question this router answers, after "is the box healthy" (`GET /maintenance/health`) and
"do the features work" (`GET /maintenance/status-page`): **why was it slow, when, and on which
server**. Both routes are SUPER_ADMIN. Neither is audited, same reasoning as `/health` — a polled
read-only dashboard would drown the audit log.

- `GET /maintenance/api-performance?hours=` *(default 24, clamped to 1–8760)* — returns `window`
  (`hours`, `since`, `bucketSeconds`), `collection`, `totals`, `series[]`, `endpoints[]`,
  `hosts[]` and `statusMix[]`.

  - `totals` — `total`, `clientErrors`, `serverErrors`, `errorRate`, `avgMs`, `p50Ms`, `p95Ms`,
    `p99Ms`, `maxMs`, `avgDbMs`, `distinctUsers`, `distinctHosts`.
  - `series[]` — per bucket: `bucketStart`, `total`, `clientErrors`, `serverErrors`, `avgMs`,
    `p50Ms`, `p95Ms`, `p99Ms`, `avgDbMs`. Bucket width is derived from the window (60s up to 6h)
    so the chart always carries roughly 50–150 points; a fixed width gives either a 10,000-point
    line for a 90-day window or six points for an hour.
  - `endpoints[]` — top 25 by p95: `apiName` (`GET /api/tickets/:id`), `method`, `apiPath`,
    `total`, `clientErrors`, `serverErrors`, `errorRate`, `avgMs`, `p50Ms`/`p95Ms`/`p99Ms`,
    `maxMs`, `avgDbMs` and `totalMs`. `totalMs` is the honest ranking of *work*: a 40ms endpoint
    called 100,000 times costs the server more than a four-second one called twice, and a table
    sorted by p95 alone would never show it.
  - `hosts[]` — up to 50 `hostname`/`podName`/`cluster` groups with `osType`, `total`,
    `serverErrors`, `avgMs`, `p95Ms`, `avgCpuPercent`/`avgMemPercent`/`avgDiskPercent` and
    `lastSeenAt`, so "one pod is the slow one" stays visible instead of averaging into the fleet.
  - `statusMix[]` — `{ statusClass: "2xx", total }`. Grouped into classes rather than exact codes
    because the decision an admin makes is the same for a 401 and a 403 ("clients are being
    refused") and different for a 502.
  - `collection` — `enabled`, `sampleRate`, `flushMs`, `retentionDays`, `maxBuffer`,
    `bufferedNow`, `droppedSinceBoot`, `failedSinceBoot`, `writtenSinceBoot`, `host`. Present so
    the panel can *explain* an empty chart ("recording is off") rather than leave an admin
    guessing: collection is **off by default** (`API_TELEMETRY_ENABLED`), because the middleware
    that feeds it sits in the hot path of every request. On a busy deployment turn the sample rate
    down rather than the feature off — percentiles from a 10% sample are still percentiles.

  **Percentiles, not averages.** An average latency is the one number that reliably hides the
  problem: a handful of eight-second responses vanish into a 120ms mean, and those responses are
  the entire reason somebody opened the page. p50 says what the typical user feels, p95/p99 say
  what the unlucky ones do, and the gap between them is the finding. Everything above is
  aggregated in SQL — nothing raw is shipped for charting.

- `GET /maintenance/api-performance/requests` — the drill-down, once the aggregates have pointed
  somewhere. Filters: `hours` (default 24, same clamp), `path` (substring match, truncated to 200
  chars), `method` (exact), `hostname` (exact), `minMs`, `statusClass` (1–5, so `4` means 4xx),
  `sort=slowest|recent` (default `slowest`) and `limit` (clamped 10–200, default 50). Unparseable
  values are dropped rather than rejected. Returns `{ since, rows[] }`, each row carrying the
  sample's own columns (`apiName`, `method`, `apiPath`, `statusCode`, `apiRequestAt`,
  `apiResponseAt`, `apiResponseTime`, `dbResponseTime`, `dbQueryCount`, host and machine fields)
  plus a resolved `user` — `null` for an unauthenticated request (a login, a public status poll),
  which is a real and meaningful answer rather than a lookup that failed, and a `"Deleted user"`
  placeholder where the id no longer resolves.

  Hard-capped on purpose: this is the "show me the actual slow calls" step, not a log export, and
  an uncapped version would be exactly the raw dump the aggregate endpoint exists to avoid. Names
  are joined in at read time rather than stored on the sample — see
  [DATABASE.md](DATABASE.md#api-request-telemetry-apirequestsample) for why the table itself holds
  no identity beyond a `userId`.

## Storage & log paths

Where uploaded files actually land, and whether rotating file logs are on. Both routes are
SUPER_ADMIN. Configuration lives in the environment, not the database — see
[DEPLOYMENT.md § Relocating file storage](DEPLOYMENT.md#relocating-file-storage) and
[§ Log files](DEPLOYMENT.md#log-files) for the variables themselves.

- `GET /settings/storage` *(SUPER_ADMIN)* — returns `storage` and `logging`.

  - `storage` — a probe of each resolved directory (`root`, `documents`, `avatars`, `face`),
    `documentFallbacks[]` (the previous roots a read still falls back to after a relocation, which
    is why moving storage never 404s an old attachment), and `configuredBy`: which variable set
    each path (`STORAGE_ROOT` or `UPLOAD_DIR` for the root, `STORAGE_DOCUMENTS_DIR`,
    `STORAGE_AVATARS_DIR`, `STORAGE_FACE_DIR`, or `null` where nothing did). "Configured" and
    "actually writable by this process" are reported separately, because they are different claims.
  - `logging` — `enabled`, `directory`, `rotateHours`, `retentionDays`, `compressOnRollover`,
    `currentFile`, `namingExample`, and `degraded`/`degradedReason` for the case where `LOG_DIR`
    was set but could not be written and the process fell back to console-only.

- `POST /settings/storage/validate-directory` *(SUPER_ADMIN)* — body `{ path }`, strict, 4096
  chars max. Returns `{ ok: true, path }` or `{ ok: false, message }`. It stats the candidate and
  then creates and deletes a uniquely-named probe file, because "the directory exists" and "this
  service account can write into it" are the two different failures worth telling apart before a
  restart. It never lists or returns directory contents. Audited as
  `settings.storage_path_validated`.

**There is deliberately no PATCH.** Three reasons, and each is sufficient on its own: the paths are
process-wide while SUPER_ADMIN is per-tenant (one Node process, database-per-org — so org A's admin
persisting a storage root would silently redirect org B's uploads); an arbitrary absolute path the
app then writes to is close enough to arbitrary file write, and the static mounts turn part of it
into arbitrary file read; and compromising one super-admin account must not also yield a filesystem
foothold. Applying a new path is one `.env` line and a restart.

## Verified work attestations

A client-facing record that approved hours map to real tickets, done by identity-verified people,
approved by a named manager, at a frozen rate. Scoped per project × date range. Every route 403s
until `GlobalTicketSettings.enableAttestations` is on. Access is `reports:view` **plus**
project-scoping; voiding is `SUPER_ADMIN`.

| Route | Notes |
|---|---|
| `POST /attestations/preview` | Builds without persisting, so a period can be checked before committing an immutable record. |
| `POST /attestations` | Issues (persists). Body: `{ projectId, periodStart, periodEnd }` as `YYYY-MM-DD`. Returns 422 if the period mixes currencies. |
| `GET /attestations?projectId=…` | Project-scoped list. `projectId` is required — there is no cross-project listing. |
| `GET /attestations/:id` | The frozen payload as a JSON download, plus `payloadHash` (SHA-256) for tamper checking. |
| `GET /attestations/:id.pdf` | Same content as a PDF. |
| `POST /attestations/:id/void` | `SUPER_ADMIN`. Requires a reason. **Never deletes** — a client may already hold a copy. |

The payload deliberately contains **no** face embeddings, image paths, similarity scores,
thresholds, or IP addresses — it carries the *conclusion* of an identity check, never the evidence
behind it. Admins who need the internals use `GET /face/evidence/timesheet/:id` instead.

### Public share links

Requires `enableAttestationSharing` (separate from `enableAttestations`, and also off by default).

| Route | Notes |
|---|---|
| `POST /attestations/:id/share` | `SUPER_ADMIN`. Body: `{ scope?: "SUMMARY" \| "FULL", expiresInDays?: 1–90 }`. Returns the plaintext token **exactly once**. |
| `GET /attestations/:id/shares` | Lists links — only a 12-char prefix, never the token. |
| `DELETE /attestations/:id/share/:linkId` | Revokes (retains the row). |
| `GET /shared/attestations/:token` | **Unauthenticated.** 30 req/min. `noindex`/`no-store`. |

Expired, revoked, voided, and unknown tokens all return an identical **404** so probing can't tell
them apart. `SUMMARY` (the default) exposes totals and per-ticket rollups only — never per-entry
rows, emails, user ids, or per-person rates.

## Public API

Everything above requires the normal JWT session (a logged-in browser). The routes below are
for **external integrations** — a script, Zapier/Make, or your own service — authenticated with
a long-lived bearer **API key** instead of a login session. Generate one from **Workspace
Settings → Public API**; it's shown once, in full, at creation time.

Base URL: `<your-workspace-url>/api/public/v1` (e.g. `https://acme.timesphere.app/api/public/v1`,
or `http://localhost:5173/api/public/v1` for a local/on-prem install — the web dev server proxies
`/api` through to the API, same as every other endpoint).

```
Authorization: Bearer tsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Every key is **org-wide** (not scoped to a subset of projects) and carries one of two scopes:

| Scope | Can do |
|---|---|
| `READ` | `GET` endpoints only |
| `WRITE` | Everything `READ` can, plus `POST /tickets`, `PATCH /tickets/:key/status`, `POST /tickets/:key/comments` |

A `READ`-scope key calling a write endpoint gets `403`, not a silent no-op.

### Endpoints

- `GET /tickets?status=&projectCode=&limit=50` — list tickets (newest first, capped at 200).
- `GET /tickets/:key` — a single ticket by its human-readable key (e.g. `WEB-123`).
- `POST /tickets` *(WRITE)* — create a ticket.
  ```json
  { "projectCode": "WEB", "type": "BUG", "title": "Checkout throws 500", "priority": "HIGH", "description": "optional" }
  ```
  Tickets created this way have `source: "API"` and are attributed (as reporter) to whichever
  admin generated the API key used to create them.
- `PATCH /tickets/:key/status` *(WRITE)* — change status. `{ "status": "IN_PROGRESS" }`. Enforces
  the exact same rules the UI does: illegal jumps (e.g. `OPEN` straight to `RESOLVED`) are
  rejected with `422`, and if this workspace has the CI gate on (Workspace Settings → Ticketing
  → "Block resolve on failing CI"), resolving a ticket whose latest ingested test run is failing
  is rejected the same way.
- `POST /tickets/:key/comments` *(WRITE)* — add a comment. `{ "body": "..." }` (HTML/rich text
  allowed, sanitized server-side same as the UI's editor). Attributed to whichever admin
  generated the API key.
- `GET /timesheets?status=&from=&to=&limit=50` — list timesheet entries.

Not yet supported: creating a timesheet entry via the public API (needs the same overlap/SLA
logic the authenticated endpoint owns — see [docs/ROADMAP.md](ROADMAP.md)).

Rate limit: 120 requests/minute per IP (separate from the UI's own rate limits).

### Outbound webhooks

Configured alongside API keys in **Workspace Settings → Public API**. Each webhook subscribes to
one or more events and receives a signed `POST` when they happen:

| Event | Fires when |
|---|---|
| `ticket.created` | A ticket is created (via the UI, email/chat intake, *or* this public API) |
| `ticket.status_changed` | A ticket's status changes (any transition) |
| `ticket.closed` | A ticket moves to `CLOSED` specifically (in addition to the status-changed event above) |
| `timesheet.submitted` | A timesheet entry is submitted for approval |
| `timesheet.approved` | A timesheet entry is approved |

Payload shape:

```json
{
  "event": "ticket.status_changed",
  "deliveredAt": "2026-07-15T00:08:52.267Z",
  "data": { "ticket": { "...": "full ticket object" }, "from": "OPEN", "to": "IN_PROGRESS" }
}
```

Every delivery carries two headers:

```
X-TimeSphere-Event: ticket.status_changed
X-TimeSphere-Signature: sha256=<hex-encoded HMAC-SHA256 of the raw request body>
```

Verify it the same way GitHub/Stripe webhooks are verified — recompute the HMAC over the **raw**
body bytes you received (not a re-serialized object) using the webhook's signing secret (shown
once, at creation time), and compare with a constant-time check:

```js
const crypto = require("crypto");
const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex");
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedSignatureHeader))) {
  throw new Error("Invalid signature");
}
```

Delivery is best-effort (5s timeout per attempt) — the underlying ticket/timesheet data is
committed regardless of whether your endpoint answers. The webhook's row in Workspace Settings
shows the outcome of its most recent attempt (`delivered`, `http_4xx`/`http_5xx`, or `failed`) so
you can tell at a glance whether your endpoint is currently reachable.

**A failed delivery is retried automatically**, not dropped: up to 4 retries with backoff (1m,
5m, 15m, 60m — roughly 80 minutes of coverage for a brief outage on your end), after which it's
marked `exhausted` rather than retried forever. `GET /settings/webhooks/:id/deliveries`
(SUPER_ADMIN) lists a webhook's still-pending or exhausted deliveries; `POST
/settings/webhooks/:id/deliveries/:deliveryId/retry` retries one immediately (resetting its
attempt count, since a human retrying implies they believe the endpoint is fixed now) — both also
surfaced in Workspace Settings → Public API under each webhook's "Failed deliveries."

## MCP server

`POST /api/mcp` is **not REST**. It is a [Model Context Protocol](https://modelcontextprotocol.io)
server speaking **JSON-RPC 2.0 over Streamable HTTP** — one URL, one method, and the operation is
named in the request body (`initialize`, `tools/list`, `tools/call`). Nothing here has a path per
resource, a status code per outcome, or a stable JSON shape you should parse by hand: point an MCP
client at it (Claude Desktop, Claude Code, a hosted agent) and let the client speak the protocol.
Design and threat model: [ARCHITECTURE.md §3.11](ARCHITECTURE.md#311-mcp-server--a-second-inbound-surface-that-acts-as-a-person).

Base URL: `<your-workspace-url>/api/mcp` (e.g. `https://acme.timesphere.app/api/mcp`). The URL
*is* the workspace — no tool takes an org parameter.

```
Authorization: Bearer tsm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
Accept: application/json, text/event-stream
```

**Auth is an `McpCredential`, not an `ApiKey`.** A public-API key authenticates to a *scope* with
no acting user; an MCP credential is bound to exactly **one user**, and every tool runs with that
person's role and permissions — the same `RequestUser` shape `requireAuth` builds. Issued by a
super admin from Workspace Settings → MCP server, shown once in full at creation.

| Response | Meaning |
|---|---|
| `401` | Missing, unknown, revoked, or bound to a deleted/deactivated account — **one identical message for all of them**, so the endpoint cannot be used to enumerate tokens or users. Also returned while a maintenance window is active, for the same reason `requireAuth` does. |
| `404` | This workspace's MCP server is switched off. Deliberately not `403`, and checked *after* authentication, so only a credential holder learns the difference between "off" and "no such URL". |
| `405` | `GET` and `DELETE`. Both are spec methods for a *stateful* server (server-initiated notifications, session teardown); this transport is stateless and sends nothing unprompted. Routed to the authenticated handler anyway so they don't fall through to the generic 404, which a client would misread as a wrong URL. |
| `406` | The `Accept` header does not list **both** `application/json` and `text/event-stream`. Required by the Streamable HTTP spec and enforced by the SDK's transport — a real MCP client always sends both; this is the one you hit hand-rolling a `curl`. |

Rate limit: 120 requests/minute per IP, the same cap the other webhook-style routes carry.

### Tools

Which tools a client sees is a function of the workspace's settings **and** the acting user's
permissions. `tools/list` and `tools/call` are backed by the same enablement predicate, so a tool
hidden from the list is not callable by a client that guessed its name.

| Tool | Permission required | Mutates | Default |
|---|---|---|---|
| `whoami` | — | no | on |
| `search_tickets` | `tickets:view` | no | on |
| `get_ticket` | `tickets:view` | no | on |
| `list_projects` | — | no | on |
| `list_my_timesheets` | — | no | on |
| `get_team_summary` | — | no | on |
| `get_timesheet_report` | `reports:view` | no | on |
| `log_timesheet_entry` | `timesheets:write` | yes | **off** |
| `create_ticket` | `tickets:write` | yes | **off** |
| `add_ticket_comment` | `tickets:write` | yes | **off** |
| `transition_ticket` | `tickets:write` | yes (**destructive**) | **off** |

- A dash under *Permission* means the tool's scope is the caller themselves (their own timesheets,
  their own direct reports), so there is nothing a permission would have protected.
- **Reads default on, writes default off.** A read tool added by a later release therefore works
  without re-visiting settings, and a *write* tool added by a later release arrives switched off in
  every existing workspace rather than turning itself on during an upgrade.
- No write tool is callable at all while the workspace's `allowWrites` latch is off, whatever the
  per-tool setting says.
- `log_timesheet_entry` creates a **DRAFT** and never submits: submitting starts an approval SLA
  clock and, where configured, requires an identity check.
- `transition_ticket` is flagged `destructiveHint`, because a status change is visible to everyone
  who can see the ticket, fires this workspace's outbound webhooks (`ticket.status_changed`, plus
  `ticket.closed` on close) and stops or restarts the SLA clock. It enforces the same three rules
  the UI does: transition legality from `ticketStatusTransitions`, the CI gate if this workspace
  has it on, and — because visibility is not permission to edit — the same
  reporter/assignee-or-privileged predicate the UI's status route applies on top of
  `tickets:write`.
- A refusal comes back as MCP `isError` content the model can read and explain, not as a transport
  fault. Refusals — including a `tools/call` naming a tool that was never registered — are written
  to the audit log as `mcp.tool_denied`; a successful call is `mcp.tool_called`.
- Any tool that can return ticket text (`search_tickets`, `get_ticket`) prefixes its result with an
  explicit untrusted-content warning and sets MCP's `openWorldHint`, because this workspace ingests
  tickets from inbound email and chat — that text was not necessarily written by anyone in it.

### MCP settings (`/api/settings/mcp*`)

The admin surface, on the normal JWT session. **SUPER_ADMIN only**, and every action audited.

- `GET /settings/mcp` — returns `{ enabled, allowWrites, updatedAt, tools[], credentials[] }`.
  `tools[]` is the full catalogue with, per tool, its `permission`, `mutating`, `destructive` and
  `untrustedContent` flags, the workspace's `override` (`true`/`false`/`null` for "never expressed
  an opinion"), its `defaultEnabled`, and `effectiveEnabled` — the answer the MCP endpoint itself
  would give, already accounting for the master switch and the write latch so the UI never
  re-derives the rule and gets it subtly wrong. `credentials[]` lists unrevoked credentials with
  `tokenPrefix`, `lastUsedAt`, `actingAs` (id, name, email, role) and `createdBy` — never a token.
- `PATCH /settings/mcp` — `{ enabled?, allowWrites?, toolOverrides? }`, where `toolOverrides` is
  `{ "<tool name>": true | false }`. A name the server does not publish is rejected with `422`
  rather than persisted: a typo silently stored as a key nobody reads looks exactly like a tool
  that refuses to turn on. Audited as `settings.mcp_updated`.
- `POST /settings/mcp/credentials` — `{ name, userId }`. The bound user must be an **active**,
  non-deleted account in this workspace (`422` otherwise) — the whole security model is that the
  credential's authority is that person's authority. Returns `201` with
  `{ id, name, token, actingAs }`; `token` is the **only** time the plaintext is ever visible, the
  same one-time-reveal convention as a public API key. Audited as
  `settings.mcp_credential_created`, recording who it acts as and with what role.
- `DELETE /settings/mcp/credentials/:id` — `204`. Revocation stamps `revokedAt` rather than
  deleting the row, so the audit entries referencing that credential id still resolve. Audited as
  `settings.mcp_credential_revoked`.

Operating guidance — what an operator is actually turning on, and how to connect a client — is in
[DEPLOYMENT.md](DEPLOYMENT.md#operating-the-mcp-server).

