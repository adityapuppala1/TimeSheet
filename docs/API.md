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
- `POST /users/:id/reset-password`

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
- `POST /face/attempts/:id/ai-summary` — ADMIN/SUPER_ADMIN; AI-drafted review brief
  (`{ summary, risk, recommendation }`). Gated by `GlobalAISettings.faceReviewSummaryEnabled` +
  the AI budget; only attempt *metadata* enters the prompt.
- `GET /face/stats` — ADMIN/SUPER_ADMIN; last-90-days outcome totals, signal counts, and the
  similarity histogram (passed vs rejected per 0.05 bucket) the threshold should be tuned from.
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

