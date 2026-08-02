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

## Users

- `GET /users?search=&role=&status=&page=1`
- `POST /users` — accepts an optional `designation` (free-text job title, display-only — separate
  from `role`, which governs permissions)
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

