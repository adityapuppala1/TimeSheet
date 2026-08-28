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

## Sessions and device identity

`GET /auth/sessions` lists the caller's own live sessions; `DELETE /auth/sessions/:id` ends one.

**One browser is one row.** `establishSession` used to INSERT on every sign-in, and nothing ever
collapsed or reaped the result — so a person signing in from one machine accumulated one "active
device" per sign-in. Measured on a development workspace before the fix: **7,486 live sessions for
a single user**, 6,952 carrying the identical Chrome-on-Windows user-agent string. Both surfaces
that read this table exist to answer *"is there a session here that shouldn't be?"*, and that
question is unanswerable in a list of seven thousand identical rows.

Two mechanisms, doing different jobs:

| Mechanism | Covers | Behaviour |
|---|---|---|
| `Session.deviceId` | Browsers | An opaque id in a long-lived httpOnly cookie. A repeat sign-in **replaces** that device's row — new secret, new expiry, same row. |
| `MAX_ACTIVE_SESSIONS_PER_USER` (10) | Everything else | Cookie-less clients (curl, MCP, native apps), rows predating the column, and genuinely-many-devices users. Evicts **least recently used** — and **only sessions idle for 15+ minutes**. |

> **`deviceId` is not an authenticator and must never be treated as one.** It carries no claim
> about who the holder is — it only groups rows. The lookup is `(userId, deviceId)` **and** a
> matching `userAgent`, and it only ever runs *after* credentials have been verified, so forging,
> copying or clearing the cookie buys an attacker nothing they did not already have. A bad value
> simply fails to match, which degrades to the old behaviour (a new row) rather than to a shared
> one. That is also why it is unsigned: a signature would imply the value is trusted for
> something, and it is not.
>
> Reuse **clears the rotation grace window** (`previousRefreshHash`, `refreshRotatedAt`). Signing
> in is a fresh credential, not a rotation, so the pre-login secret must die immediately — a token
> that survives a re-authentication is exactly what `refresh`'s reuse detection exists to catch.

> **An active session is never evicted, however far over the cap.** The cap is a *target*, not a
> hard ceiling. A blunt cap is not merely imprecise here — it is a way for one client to sign
> another out: a script or integration polling `/auth/login` would push a person's real browser
> session past the rank cutoff and revoke it, and the victim would see a 401 on a token minted
> minutes earlier. (This is not hypothetical; the e2e suite reproduced it before the rule changed.)
> Idleness is therefore the eviction condition, and 15 minutes is the same window
> `maintenance.service.ts` already uses for "using the app right now" — one idea, one number. Ten
> genuinely-active sessions all survive; they are swept as they go quiet.

**The response is decoded, not raw.** Each row carries `device` ("Chrome on Windows 10/11"),
`browser`, `os`, `formFactor`, `lastSeenAt`, and `privateNetwork` — and deliberately **not** the
raw `userAgent`, which is a fingerprinting surface with no remaining purpose once the label exists.
Rows are ordered by **last activity**, because "which of these is stale?" is the question being
asked and creation time answers a different one. The same `parseUserAgent` already backed the
admin who's-online panel; this route simply stopped being the exception.

## Workspace branding

The workspace's own logo and display name — what makes the product read as the customer's.

- `GET /branding` — **public** (tenant-resolved by host, exactly like `/auth/sso-methods`).
  Returns `{ displayName, hasLogo, logoVersion }`. `logoVersion` is a stamp that changes on every
  upload; the client appends it to the image URL so a new logo is a new URL rather than a stale
  cache.
- `GET /branding/logo` — **public**. Streams the image, or 404s when none is set (the client then
  renders the product mark). Cached for a day, which is safe precisely because the URL carries
  `?v=<logoVersion>`.
- `POST /branding/logo` — SUPER_ADMIN, `multipart/form-data` field `logo`. Reuses the avatar
  uploader (PNG/JPG/JPEG/GIF, 5 MB) and re-encodes through sharp: metadata stripped, polyglots
  broken. Scaled to **fit** 512×160 and written as PNG — a logo is a designed mark, so it is never
  cropped square (an avatar is), and PNG keeps the transparency that a JPEG would paint black on a
  dark theme. Audited; the previous file is unlinked best-effort.
- `DELETE /branding/logo` — SUPER_ADMIN. Clears the row and unlinks the file. Audited.
- `PATCH /branding` `{ displayName }` — SUPER_ADMIN; `null`/empty restores the product name.

**Why the read half is unauthenticated, and why the bytes are not under `/uploads`:** the logo has
to render on the login page, where nobody is signed in and no signed file grant can be minted — and
a company's mark on their own sign-in screen is public by construction. Rather than carve an
exception into the `/uploads` grant gate, branding gets its own storage subtree that
`isInsideNonPublicSubtree` refuses outright, with these routes as its only reader. A test pins both
halves of that (`tests/unit/branding-storage.test.ts`).

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

### Activity types

The catalog behind the timesheet form's **Activity** field. Administered on the Projects screen,
because it is the same kind of thing as a module — a dimension you slice logged work by — under
the same `projects:manage` right.

- `GET /activity-types` — readable by **any** signed-in user: everyone who logs a timesheet needs
  it, and an `EMPLOYEE` holds none of the manage rights. `?all=true` additionally returns disabled
  rows and needs `projects:manage`; offering a retired activity in the logging picker is the thing
  disabling it was meant to stop.
- `POST /activity-types` — `{ name }`. A duplicate returns **409**, and a duplicate of a *disabled*
  row says so, pointing at re-enabling rather than creating a second one.
- `PATCH /activity-types/:id` — `{ name?, isActive? }`.
- `DELETE /activity-types/:id` — **only when nothing was ever logged under it.** Otherwise
  **409** with the entry count and the advice to disable instead.

> **`Timesheet.activityType` stays a string, not a foreign key** — the same reasoning
> `ticket-type.controller.ts` records for `Ticket.type`. An entry is a record of work that
> happened; a manager renaming or retiring an activity a year later must not rewrite, or orphan,
> the history logged under it. The name is copied onto the row at write time, and this catalog
> governs what the **picker** offers, not what the past says.
>
> The `ActivityType` table had been seeded since the first migration and **nothing ever read it** —
> both apps imported a frozen twelve-item array from `@timesheet/shared` instead, so a workspace
> whose work did not fit those twelve words had no way to say so short of a redeploy. When the
> table is empty the list route falls back to those defaults (marked `seeded: true`, with a
> `seed:` id) so a workspace whose seed never ran still gets a usable form.

## Timesheets

- `GET /timesheets?from=&to=&userId=&projectId=&status=`
- `GET /timesheets/:id` — **one entry in full**: project/module/submodule, the linked ticket, the
  author, the reviewer, every attachment (with a signed download URL) and the identity badge. Your
  own entries always; anyone's with `reports:view` or `timesheets:approve`. A 404 — never a 403 —
  for anything else, because "this entry exists but isn't yours" is itself information about a
  colleague's work. Exists as a route rather than a lookup in the list because the list is capped
  at 100 rows, so an older entry reached by deep link is simply not in it.
- `PATCH /timesheets/:id` — **correct an entry after the fact**. Accepts any subset of
  `projectId`, `moduleId`, `submoduleId`, `ticketId`, `activityType`, `taskDescription`,
  `workDate`, `startTime`, `endTime`, `notes`. Deliberately NOT `status` or `billable` — those are
  decisions with their own routes, notifications and rate-freezing behaviour, not descriptions of
  work. The supplied fields are merged onto the stored row and the **result** is validated, so
  changing the project cannot leave a module belonging to the old one.
- `POST /timesheets/:id/submit` — **move an existing `DRAFT` into the approval queue.** Until this
  existed, "Save draft" was a one-way door: `saveTimesheet` only ever CREATES a row, so a draft
  could be edited forever and never actually submitted, and the only ways out were to delete it and
  re-type the whole entry or to leave it in History as permanently unsubmitted work. It runs
  *everything* a fresh submit runs, because it is the same event — the identity gate, `submittedAt`,
  the SLA `approvalDeadline` from the project's own setting, both notifications, and the
  `timesheet.submitted` domain event the SLA sweeps and digests read. `DRAFT` only: a `SUBMITTED`
  entry is already queued, and re-submitting a decided one would quietly reopen something a reviewer
  already closed. The author, or `TIMESHEETS_APPROVE` on their behalf.
- `POST /timesheets/:id/attachments` (multipart, field `attachments`) and
  `DELETE /timesheets/:id/attachments/:attachmentId` — add or remove evidence on an existing
  entry, through the same processing pipeline (WebP re-encode, gzip, structured filename) the
  create path uses.
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

**The author may delete a `DRAFT`, and nothing else.** Anything else returns **422**, and the
distinction is load-bearing rather than conservative:

| Status | Author may delete | Why |
|---|---|---|
| `DRAFT` | yes | Logged by mistake; nothing downstream depends on it yet. |
| `SUBMITTED` | **no** | Someone is being asked to decide on it. Removing it mid-review erases the request. |
| `APPROVED` | **no** | It carries a frozen rate snapshot and feeds cost reports and Verified Work Attestations. Deleting it would let history be rewritten *after* a client had been shown it. |
| `REJECTED` | **no** | It is the record of a decision, with the reviewer's stated reason attached. Erasing it erases that. |

`TIMESHEETS_APPROVE` (managers and up) additionally reaches `REJECTED` — the tidy-up case, so an
admin can clear up after someone who has left.

> **The exclusion that keeps this from being a trap.** `REJECTED` entries are omitted from the
> overlap check in both the create and the edit paths. They used not to be — and since the author
> can no longer edit *or* delete a rejected entry, a rejected row that still held its time slot
> would refuse the correcting entry they are told to log, leaving them with hours they actually
> worked and no way to record them. A refusal is the reviewer saying "this should not stand"; it
> does not reserve the clock. Every other status still counts, so genuine double-booking is still
> caught.
>
> The same principle holds wherever refused hours would otherwise cost the author something: the
> logging form's 12-hour daily cap already ignores them, and History's **Logged hours** total
> excludes them too — work 8h, get refused, re-log the same 8h, and a total that counted both would
> read 16h. The refused hours stay visible as their own figure; they are simply not counted as work
> that stands.

It is a **soft** delete —
the row keeps its audit trail, and because every read path (including the overlap check in
`POST /timesheets/draft`) filters `deletedAt: null`, the freed time slot is immediately reusable.

> This route did not exist until 2026-08. Its absence meant a mistaken entry could only be edited
> into something else, and it silently broke the e2e suite's cleanup, which had been calling it and
> treating Express's 404 as success. See `tests/e2e/helpers/admin-request.ts`.

### Who may edit an entry — and why editing is wider than deleting

`PATCH /timesheets/:id` has **two** rules, matching who bears the consequence:

| Caller | May edit | Why |
|---|---|---|
| the **author** | their own **undecided** entries — `DRAFT` and `SUBMITTED` | It is their account of their own work, and nobody has ruled on it yet. |
| `TIMESHEETS_APPROVE` | **anyone's** undecided entries | They correct the module name on something they are about to decide on, without a rejection round-trip for a typo. |

**A decided entry is immutable for everyone, the reviewer included.** `TIMESHEETS_APPROVE`
originally reached any status, on the argument that whoever decides whether hours are payable can
also correct them. That exemption is gone: it undoes precisely what the decision is *for* — an
`APPROVED` entry carries a frozen rate and may already sit behind a client-facing attestation, and
it would change under the same audit entry a routine typo fix produces. A correction to a decided
entry is a **new entry**, which is the answer the delete rule has always given, and which leaves
the original record intact instead of quietly replacing it. One helper, `assertUndecided`, is
called by `PATCH` and by both attachment routes, so no route can grow its own idea of "decided".

**The author's window deliberately extends past `SUBMITTED`, unlike `DELETE`'s.** Deleting a
submitted entry erases a request somebody is being asked to decide on; fixing a typo in it does
not. The narrower rule sent the author to their approver to change one word — and an approver's
only "send it back" tool is a **rejection**, so a spelling mistake cost a rejection, a
notification and a re-submission. Editing a `SUBMITTED` entry **notifies the approver** precisely
because they may have read it already, so they re-read rather than deciding on what they saw
before.

`APPROVED` hours carry a frozen rate and feed cost reports and Verified Work Attestations — a
record a client may already have been shown. A `REJECTED` entry carries the reviewer's stated
reason, and rewriting the text that reason refers to leaves it attached to something it was never
about; the path forward from a rejection is a **fresh entry**, not a rewrite of the refused one.

The reason the edit and delete rules differ at all is that **erasure and correction are different
acts**. Deleting an approved entry would remove that record; correcting one leaves it in place and
says what changed:

- **Every edit is audited field-by-field** (`timesheet.updated`, with `{ from, to }` per changed
  field and `onBehalfOf` when a reviewer edited somebody else's row). That audit trail is what
  makes editing an approved entry defensible rather than alarming.
- **The submitter is notified** when someone else edits their entry. Silent edits by a reviewer are
  how an approval queue loses the submitter's trust.
- **An approved entry's frozen rate is never re-resolved.** If the hours change, `billedAmount` is
  recomputed from the *already-frozen* `billedRate` in Decimal — so the stored total can never
  disagree with its own hours, and last quarter's work is never silently repriced at today's rate.
- Overlap is re-checked against the **entry's own author**, not the editor: a manager fixing
  somebody else's row must not be able to push it on top of another of that person's entries.
- **`lastEditedById` / `lastEditedAt` are stamped on every edit**, including the author's own, and
  both `GET /timesheets` and `GET /timesheets/:id` return them resolved to `lastEditedBy
  { id, name, email }` — alongside `reviewedBy`, which the list route had never carried either.
  Both are bare id columns with no foreign key (matching `reviewedById`, and for the same reason:
  `Timesheet` already relates to `User` through `userId`, and a second Prisma relation would force
  both to be named), so the display names are resolved for a whole page in **one** batched query
  rather than a join or an N+1. `null` means nobody has edited the entry since the column existed —
  which is what the UI should say, rather than attributing it to whoever created it.

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

### The `from` / `to` date window

Four endpoints accept an inclusive `from`/`to` pair as `YYYY-MM-DD`, which is what the home page's
single date filter drives. **All four default to exactly the window they used before the filter
existed**, so every other caller is unaffected by passing nothing:

| Endpoint | With no window | With one |
|---|---|---|
| `GET /timesheets` | newest-first page, capped at 100 rows | filters `workDate`, and raises the cap to 2 000 |
| `GET /reports/admin-summary` | today / yesterday / 7d / year-to-date, hardcoded | the window, compared against the equal-length window before it |
| `GET /reports/daily-status` | today | the window, and returns `from`/`to`/`days` so the card can label itself |
| `GET /dashboards/my-month` | the current calendar month | the window |

**Why the timesheet filter is server-side and not a client concern.** That route returns newest
first and truncates, so filtering a range in the browser silently under-reports any period that
falls outside the newest page — correct-looking in development, where nobody has that many entries,
and wrong in production. A bounded range is self-limiting in a way "everything" is not, which is
why it can afford the higher cap.

**Unparseable dates are DROPPED, not rejected.** These query strings get bookmarked, hand-edited and
pasted between people; refusing a whole dashboard over one stale parameter is worse than answering
the rest of it, and it degrades to the endpoint's original window. The shared implementation is
`apps/api/src/utils/date-window.ts` (`parseDayWindow`, `workDateFilter`, `resolveTimestampWindow`,
`windowDays`) — one definition, because three of these endpoints had grown their own copy of the
same eight-line date parser and the off-by-one in an inclusive range (an exclusive end must sit at
midnight on the day *after* `to`, or the window quietly drops its own last day) is exactly the kind
of thing that should exist once.

**"vs yesterday" becomes "vs the previous equal-length period"** on `admin-summary` once a window is
given — it is the only thing a delta can honestly mean for an arbitrary span, since comparing a
fortnight against a single day reads as a collapse every time. The project/status/activity
breakdowns gain the filter too; they were previously **all-time**, which meant a "project
utilization" card on a page showing one week was silently answering for the entire history.

`GET /timesheets` additionally accepts `scope=team`, which resolves the three tiers the reporting
line already encodes rather than the binary `reports:view` check: `users:manage` sees everyone,
anyone else sees themselves plus their direct reports (`User.managerId`), and somebody who manages
nobody sees only themselves — that last case is not a separate branch, it is the manager branch
with an empty team. It is **opt-in**: History, the timesheet page and the approvals queue pass no
scope and keep the visibility they have, because narrowing those would change who can approve what.


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

### Agent runs and the ledger

- `GET /agent-runs?limit=&capability=&flowId=` · `GET /agent-runs/:id` — SUPER_ADMIN. The detail route
  returns the run's full step trace **and the rest of the chain**: the proposal it produced, that
  proposal's status, each change with whether it was applied, and the ledger row the run wrote. Three
  tables, one question — answering it in the browser would mean three round trips and a reader who
  gives up.
- `GET /agents/ledger/history?days=` — the ledger over time: every entry in the window and the same
  data bucketed per day, zero-filled, with `measuredDays` beside it. A day with no MEASUREMENT is not a
  day of zero displacement, and a chart whose spacing changes meaning halfway across is worse than none.
- `GET /ai/overview` — SUPER_ADMIN. One response describing all four AI surfaces: capability counts and
  how many resolve above SUGGEST, teammates on and off, flows live and waiting, proposals pending, spend
  split three ways, the ledger, and one suggested next step. Every figure is a COUNT that can be checked
  against the screen it came from — deliberately no health score, because a score needs a rule for what
  healthy is and that depends on what the workspace wants.

## Workflow Studio (V8 phase 4)

Same entitlement as the roster (`aiPmCopilotEnabled`) — a flow composes that capability family, and a
second switch for one commercial decision is a switch somebody forgets. Reading needs `tickets:view`,
because what automation touches your work is your business; every write is SUPER_ADMIN.

- `GET /flows` — every flow with its **computed authority** and validation issues.
- `GET /flows/catalogue` — capabilities with ceilings, the real domain-event list, and the
  deterministic actions, in one call.
- `GET /flows/:id` · `POST /flows` · `PATCH /flows/:id` · `DELETE /flows/:id` (soft, and switches it
  off in the same write — a retired flow must not keep firing).
- `GET /flows/:id/simulate?limit=` — the replay. **A GET on purpose**: it writes nothing, so it must be
  safe to re-run and refresh, and a POST would imply otherwise.
- `POST /flows/:id/enabled` `{ enabled }` — activation, refused with 422 on any validation error and
  quoting it. **Deactivation is always allowed**, even for a flow that would now fail validation —
  otherwise a flow invalidated by a retired teammate or a deleted form could not be switched off, the
  same deadlock the roster's disable-escape avoids.

Steps are replaced wholesale and `order` is assigned from array position, so a reordered builder
cannot produce gaps or collisions. A flow is **created off**, whatever the request says.

`GET /flows/catalogue` also returns the **people, labels and projects** the builder's per-step pickers
render from, plus which config key each action fills. One call rather than four: a dialog that paints
before its options arrive is a dialog where somebody picks nothing and wonders why the step will not
validate. Agent identities are excluded from every people list — assigning work to a teammate is a real
idea, but "who approves this gate" is a question about a person, and an identity with no mailbox cannot
answer it.

### Dispatch and runs (V8 phases 6–7)

A flow fires from one of three places: `EVENT` off the internal domain bus, `SCHEDULE` off a per-minute
sweep, `FORM_SUBMISSION` off the public intake, and `MANUAL` off the route below. Execution always goes
through `queueAgentRun`, so idempotency, the abort flag, the step cap, both cost ceilings, the taint
clamp and the audit trail are the existing ones — the Studio adds no new write path.

- `GET /flows/runs?flowId=&limit=` — what the flows have actually DONE: each run with its subject,
  status, one-line summary and every step's outcome. `tickets:view`, like the flow list.
- `POST /flows/runs/:runId/decision` `{ approved }` — clear a gate. **Not SUPER_ADMIN**: the step named
  a person, and that person is who may clear it. Enforced server-side, so the route is the door and not
  the lock. `409` if the run is not waiting, `403` if somebody else was asked.
- `POST /flows/:id/run` — a manual run. SUPER_ADMIN. `202` with the run id; the trigger key carries the
  actor and the minute, so a double-clicked button is one run.

**The idempotency key carries the SUBJECT** (`flow:<id>:ticket:<id>`). A doubled event, a retried
delivery and a restart mid-dispatch all collapse to one run — while a *second ticket* through the same
flow is properly a second run. Getting that half wrong makes the first ticket the only ticket a flow
ever touches.

**A capability step is refused at activation if no agent run can execute it.** Most of the registry is
invoked inline by the feature that owns it and has no tools for a run loop to use; the builder offers
only the runnable ones, and `validateFlow` refuses the rest — a flow that activates and then fails
reads as the product being broken rather than as the step being impossible. The same applies to a
capability that needs a project scope in a flow whose trigger can never supply one.

### The three rules, and where they live

All of them are computed in `flow-authority.service.ts`, which touches no database so the whole
guarantee can be read — and tested exhaustively — in one place. Every failure available here is
arithmetic that renders plausibly and is wrong, which is why that file has 25 tests of its own.

1. **Authority is the MINIMUM of the capability steps'.** Composing two `AUTO_APPLY` steps must never
   produce authority neither had. `limitedBy` names the step that set the floor, so a builder can point
   at it.
2. **Taint propagates FORWARD.** Once a step reads externally-authored text, every *later writing* step
   is clamped to `SUGGEST` — generalising `AgentRun.taintedAt` from one run to a composition. This makes
   **order load-bearing**: triage-then-assign proposes, assign-then-triage applies. The word "later"
   does real work: a flow whose *only* step reads outside text is not clamped, because composing one
   step must not be stricter than running that capability alone (a bug caught by a test).
3. **Anything above `SUGGEST` writes through `AiProposal`.** The Studio adds no write path at all —
   composition decides what runs and at what authority, and execution goes through `queueAgentRun`, so
   idempotency, the abort flag, the step cap, the cost cap and the audit trail are the existing ones.

`gatedBeforeWrites` reports whether a `HUMAN_GATE` precedes every writing step, because that is the
cheapest way to make an ambitious flow acceptable. Activation records the authority **as computed at
that moment** in the audit row, since "what was this allowed to do when somebody switched it on" must
not depend on what the policies say weeks later.

### What the simulation is, and is not

Exact about structure: which steps are reached, where a gate stops the run, and whether each writing
step would apply or propose. Explicit about the rest — it **calls no model, writes nothing, and assumes
branch conditions pass**, all three stated in the response's own `disclaimer` so nobody reads a replay
as an execution. Zero samples is a finding with a reason ("no tickets in this workspace yet"), not an
empty list.

A flow bound to a teammate may only use capabilities that teammate **owns**, which is what stops the
Studio becoming a way around "one capability, one owner".

## The agent roster (V8 phase 3)

Gated on the tier's `aiPmCopilotEnabled` — the roster is a bundle of the AI capability family, which
already has an entitlement, and a second switch for one commercial decision is one switch somebody
forgets. Reading needs `tickets:view`; every write is SUPER_ADMIN, because creating an agent mints a
service identity whose actions appear in the audit trail under its own name.

**A profile grants nothing.** `AiCapabilitySpec.maxLevel` is the product ceiling, an administrator
may only lower it through `AiCapabilityPolicy`, and `AgentRun.level` stays the record of what a run
was actually permitted. A profile adds a name, a scope that can only NARROW, and a daily spend
ceiling that sits under every existing one. If it could raise a level it would be a second
permission system, and the first thing a second permission system does is disagree with the first.

- `GET /agents` — the roster, each entry carrying its capabilities with **resolved** autonomy
  (clamps applied), today's spend, and its five most recent runs.
- `GET /agents/catalogue` — the built-in gallery plus the full capability catalogue with ceilings, in
  one call because the "add a teammate" dialog needs both and two round trips is two chances to
  render half a dialog.
- `POST /agents/install` `{ templateKey }` — instantiates a gallery template. Separate from the
  generic create so the bundle comes from the catalogue rather than the request body; otherwise
  "this is the stock triage teammate, unmodified" is a claim a client can assert about anything.
  409 on a second copy of the same template.
- `POST /agents` — a custom profile. An unknown capability id is **refused**, not dropped: a bundle
  naming one would appear to do something and do nothing.
- `PATCH /agents/:id` — including `enabled`. Enabling is audited as its own action (`agent.enabled`)
  rather than as a field list, because "who switched this on, and when" is what an incident review
  asks.
- `DELETE /agents/:id` — retires it. Soft delete, and the identity is **deactivated rather than
  removed**: audit rows, comments and past runs point at it, and hard-deleting would either cascade
  them away or leave them naming nobody.

**Every profile is created switched off**, whatever the caller asks. An administrator reads the
resolved autonomy of the bundle first — the same reasoning as the MCP server's three closed
defaults, where a write tool added by a future release arrives disabled rather than turning itself on
during an upgrade.

### One capability, one owner

A defect the roster introduced, fixed in the same release. There is exactly one
`AiCapabilityPolicy` per capability, so two ENABLED profiles containing `triage` would both describe
the same behaviour: neither would be the reason it happened, and switching one off would change
nothing. The roster would be a list of names with no relationship to what the workspace does.

- A capability may be claimed by **at most one enabled profile**. Drafts may overlap freely — that is
  what makes it possible to build a replacement teammate before retiring the one it replaces.
- **Enabling is where the claim is staked**, so that is where a conflict is refused: 409, naming the
  owner and the overlapping capabilities ("📰 Reporter already covers weekly_digest, status_report").
  The same check catches the other route to the same collision — widening an already-enabled bundle.
- A profile can always be switched **off**, even while it overlaps. Without that exception two
  profiles that overlapped by any other route could each refuse to be disabled — a deadlock.
- `GET /agents` reports `claimedByOther` per capability on a draft, so somebody can see *why* enabling
  would be refused before trying, and `readiness.enabledButInert` when a profile is on but every
  capability in it has its AI feature switched off — the state a green "On" badge would lie about.
- `GET /settings/ai/autonomy` carries `claimedBy` per capability, so the settings screen names the
  teammate that depends on a level before somebody lowers it. **Display only** — `AiCapabilityPolicy`
  remains the single lever, and the roster deliberately does not duplicate the control.

### The identity, and its three fences

An `AgentProfile` acts as a real `User` row with `isAgent = true`. That is what lets assignment,
workload, comments, `AuditLog.actorId` and attestations work unchanged instead of threading a second
actor type through dozens of queries. Three invariants fence it, each at a choke point rather than at
call sites, and each with its own test because each fails in a different direction:

| Fence | Where | Why it is enforced there |
|---|---|---|
| **No seat** | `seat-count.service.ts#countActiveSeats` | The predicate was copied into five call sites; a sixth copy is how the next exclusion gets missed, and the miss is a customer charged for robots. A test asserts no bare copy remains anywhere in `src`. |
| **No login** | `auth.service.ts#establishSession` | The documented funnel every login method terminates in — password, Google, Microsoft, SAML, LDAP. A guard in `login()` alone would leave SSO open, which is the exact class of bug that comment was written about. 403, not 401: the credential is not the problem. |
| **No mailbox** | `mail.service.ts#sendMail` | Agents are picked up by every "all active users" recipient query. Addresses live on `@agents.invalid` — the domain RFC 2606 reserves so it can never resolve — so the choke point recognises one with a string comparison and no join. `SKIPPED`, not an error: nothing was wrong, there was simply nobody to write to. |

## Inbox and the daily brief (V8 phase 2)

No permission and no entitlement: this is the caller's own queue over notifications they already
receive, and selling "your own inbox" as an upsell would be the wrong shape (the same reasoning that
leaves `/plan/my-work` ungated).

**Ownership IS the authorisation.** Every write is an `updateMany` filtered on `{ id, userId }`, so a
guessed id belonging to somebody else updates zero rows and answers 404 — there is deliberately no
id-based lookup that could be pointed at another person's inbox, and no admin view of one.

- `GET /inbox?filter=unhandled|snoozed|handled|all` — the queue plus `counts`. An unknown filter
  falls back to `unhandled` rather than erroring. Returns at most 200 rows; the page reveals 25 at a
  time.
- `GET /inbox/brief` — today's brief (below).
- `PATCH /inbox/:id` `{ handled?, read?, snoozeUntil? }` — three independent statements about one
  row. **`handledAt` is not `readAt`**: opening the bell marks things read, which is about attention,
  not about work; collapsing them would mean every glance empties the queue. Snoozing also marks the
  row read, because the bell must stop insisting about work somebody has explicitly deferred, and a
  `snoozeUntil` beyond a year is clamped — a five-year snooze is a delete wearing a friendlier label.
  Returns fresh counts so tab badges cannot drift.
- `POST /inbox/handle-all` — clears the visible queue by marking handled. **Never deletes**: the row
  is the record that somebody was told, and a support question a month later is answered by it.

A snoozed row is hidden from `unhandled` until its time passes and then **reappears on its own**,
with nobody re-filing it. That is the only behaviour that makes snoozing safe to use.

### The brief is arithmetic, not a prompt

Every figure comes from a definition that already exists elsewhere in the API, called rather than
restated — a model asked to summarise the workspace would produce a fluent paragraph whose numbers
nobody can reconcile with the pages they came from, and the first time the brief and the dashboard
disagree both stop being read. A narration layer can sit on top later (the plan reserves the
`daily_brief` capability at ceiling `AUTONOMOUS`, explaining figures it cannot change, exactly as
`project_risk_narrative` does), but the numbers are true on their own first.

| Section | Source |
|---|---|
| Past their date · Due today · Blocked | `my-work.service.ts#computeMyWork` — the same buckets `/plan/my-work` renders. The blocked row names the actual blocker, because "you are blocked" is not actionable and "WEB-9 waits on API-2" is. |
| No time logged today | The caller's own `Timesheet` rows at UTC-midnight `workDate`, matching `/reports/daily-status`. |
| Timesheets awaiting review | `SUBMITTED` rows other than the caller's — **only present with `timesheets:approve`**, and not even queried without it. |
| Sign-offs waiting on you | `ApprovalStep` rows with `decision = PENDING` for the caller. |
| Projects reading red | Latest `ProjectRiskSnapshot` per project, RED band — **only with `reports:view`**. A project that was red in March is not red now, hence `distinct` on the descending query. |
| Unread notifications | `readAt IS NULL`. |

`allClear` is true only when nothing carries the `attention` tone. Work merely *due today* and
unread notifications are deliberately `ok`: if informational rows could raise the alarm, nobody would
ever see an all-clear and the signal would be worthless. A zero section carries a `null` link, so a
reassuring row is never a dead click.

## Goals / OKRs (V8 phase 1)

Gated on `enableGoals` (workspace) **AND** the tier's `goalsEnabled` — ANDed server-side in
`planning.service.ts#assertGoalsEnabled`, which returns two deliberately different 403 messages:
"a super admin can turn it on" points at a setting, "not included in this plan" points at a
commercial conversation. Deliberately **not** behind `enablePlanning`: goals align work whether or
not the Gantt is in use, and gating an alignment tool on a scheduling one would be arbitrary.

- `GET /goals` — the whole tree with every measurement resolved. **No permission required**: a goal
  nobody can see aligns nobody.
- `GET /goals/:id` — one goal, its children, and its full override history.
- `POST|PATCH /goals[/:id]` — `goals:manage` (SUPER_ADMIN, ADMIN, MANAGER, TEAM_LEAD by default).
  Creation is quota-checked against `maxGoals`, counting **ACTIVE goals only** — closed goals are
  history, and counting them would push people to delete the record of what they were aiming at.
- `POST /goals/:id/override` `{ progressPct, note }` — `goals:manage`. Append-only, and there is
  no PATCH or DELETE by design: an override records who said what, when, **and what the
  measurement said at that moment**, so a correction is another row rather than an edit. Refused on
  a MANUAL goal, which has nothing to disagree with.
- `DELETE /goals/:id` — soft delete, and refused while the objective still has key results.

**Progress is never stored.** Every number is derived on read by `goal-progress.service.ts`, from
the same tables the portfolio roll-up and the client-facing attestation read, so a goals page and a
signed document cannot disagree. The source catalogue is **closed** for the two reasons the
dashboard widget catalogue is closed: a metric two goals define differently will be defined
differently, and a user-supplied metric is a query surface.

| `progressSource` | Direction | Measures |
|---|---|---|
| `MANUAL` | at least | A stated percentage. Health is still judged against the period. |
| `APPROVED_HOURS` | at least | `SUM(Timesheet.totalHours)` where `status = APPROVED` in the period. |
| `BUDGET_SPEND` | at most | `SUM(Timesheet.billedAmount)` — the rate snapshots taken at approval. |
| `TICKETS_CLOSED` | at least | Tickets whose `closedAt` falls in the period. |
| `ON_TIME_RATE` | at least | Share of closed tickets that met `endDate`, falling back to the SLA-derived `dueAt`. Tickets with neither date are excluded from the denominator rather than counted as punctual. |
| `SLA_BREACHES` | at most | `TicketEscalation` rows created in the period. |
| `RISK_SCORE` | at most | Latest `ProjectRiskSnapshot` per linked project, averaged. |

**`unavailable` is a first-class result, never `0`.** No period, no target, or no data in scope
returns `{ unavailable: true, unavailableReason }` and the UI prints the reason — "no data" and
"nothing achieved" are opposite messages that look identical as a zero. An `AT_MOST` source returns
`progressPct: null` on purpose: "62% of the way to your spending ceiling" reads as an achievement.

**Scope** comes from `GoalLink` rows (`PROJECT`, `PORTFOLIO`, `TICKET`); no links means the whole
workspace. A `PORTFOLIO` link expands to its member projects **at read time**, so a portfolio that
gains a project next week widens every goal linked to it without anyone touching those goals.

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

## Change management (V8)

**A change request IS a ticket** plus a `ChangeRequest` extension row. That is the whole design
decision, and everything below follows from it: comments, attachments, watchers, cross-links, the
audit trail, search and project-scoped visibility all hang off the ticket half and needed no new
code. What this module adds is the governance a ticket cannot express — a risk assessment, an
approval with a name against it, a scheduled window, a runbook, and a recorded outcome.

Every route 403s unless change management is switched on for the workspace **and** the org's tier
includes it, with deliberately different messages for the two cases — "turn it on in settings" and
"upgrade your plan" need different people to do different things. Same pattern as planning.

**Every state write also writes `Ticket.status`.** `CHANGE_STATE_TO_TICKET_STATUS` is the same
compatibility hinge `WorkflowStatus.legacyStatus` provides for custom ticket statuses: the ~40 places
already reading `Ticket.status` keep working precisely because the pair is never written apart.

### Identity

Change keys are `PROJECTCODE-YYYYMMDD-NNNN` — e.g. `HICS-TS-20260819-0001` — issued by
`change-key.service.ts` with a count-and-retry against the unique index. The date part is the day it
was raised, so the key stays meaningful when it is read a year later in an audit response.

### The four change types, and why there are four

`STANDARD`, `NORMAL` and `EMERGENCY` are ITIL's vocabulary: pre-approved routine work, planned work
that earns a decision, and work that cannot wait for one.

**`MAJOR` is not a fourth peer — it is `NORMAL` escalated**, and it exists because two obligations
cannot be derived from the risk score:

| | |
|---|---|
| `requiresBackoutPlan` | A MAJOR change needs one **even when impact × likelihood bands it LOW**. A platform migration can score low on every parameter and still be the thing you must be able to undo. The matrix scores *probability of harm*; it has no way to say "structurally significant". |
| `requiresReview` | A MAJOR change owes a post-implementation review **even when its outcome was `SUCCESSFUL`**. Everything else owes one only when it went wrong. |

Removing MAJOR would therefore delete both rules with nothing to replace them, which is why
`change-rules.test.ts` pins the enum as well as the two behaviours — a vocabulary tidy-up would
otherwise compile, lint and pass. It means "significant regardless of what the matrix scored", **not**
"riskier than HIGH"; risk is a separate axis and stays one.

Both pickers state the consequence in the dropdown rather than letting somebody discover it as a 422
at submission time (`CHANGE_KIND_MEANING`).

### The lifecycle

`DRAFT → AWAITING_APPROVAL → APPROVED → SCHEDULED → IMPLEMENTING → VALIDATION → PIR → CLOSED`, with
`REJECTED` and `CANCELLED` as terminal branches.

Two things are deliberately **not** in that list. `FAILED` and `ROLLED_BACK` are **outcomes**, not
states: a change that failed still has to be validated, reviewed and closed, and modelling failure as
a state would strand it outside the process that exists to learn from it. And the lifecycle is its
own state machine rather than a `Workflow` — custom workflows collapse to the system workflow when
the feature is off, which would have made the whole module Enterprise-only.

- `GET /changes` — the register, project-scoped. Filters: `state`, `riskLevel`, `changeKind`,
  `environment`, `projectId`, `search`.
- `GET /changes/:id` — one change with everything on it, plus four server-computed answers the
  browser cannot work out for itself: `canEdit`, `canDecide`, `blockingForSubmit` (what the change
  still owes before it could be submitted), `blockingDependencies`, and `sla`.
- `POST /changes` — raise one. `justification` is required at creation; a change with no stated
  reason is the thing this module exists to stop.
- `PATCH /changes/:id` — fill in any section. The plan **freezes** at `APPROVED` for non-privileged
  editors: scope, risk and schedule are what got approved, so changing them afterwards means raising
  a new change. Outcome fields stay writable, because recording what happened is post-approval work.
- `POST /changes/:id/transition` — move it. Refuses illegal edges, answers a no-op rather than
  performing it (a double-click was otherwise enough to open a second approval round and re-mail the
  approver), and refuses `IMPLEMENTING` while a dependency is open.
- `POST /changes/:id/decision` — approve or reject. `CHANGES_APPROVE`.

### What submission requires, and why it is not advisory

`missingForSubmit` demands a **complete** risk assessment, a justification, an implementation plan, a
planned window, a test plan above LOW risk, and a backout plan wherever the risk band calls for one.

The completeness rule is not fussiness. The risk score normalises across every active parameter, so
an unanswered one contributes zero — correct in itself (a blank is not "low"), but it means a
half-filled assessment **under-reports**. Measured: high business impact plus high data risk, with
the other nine parameters left blank, scored 27 and banded LOW — and the band is exactly what decides
whether a backout plan is mandatory. Leaving fields empty was a way to skip the module's central
rule. A draft can still be saved with any subset.

### Approval routing

`resolveChangeApprovers` returns **the requester's manager**, or every active super admin if they
have none. There is no multi-level chain: one named approver, or the people who can always act.

A requester can never approve their own change, and submitting with no manager and no active super
admin is refused at submission time with an actionable message rather than creating a change nobody
can decide. Rejection opens a **new round** rather than overwriting the first, so the objection stays
on the record when the change is reworked and resubmitted.

### The runbook

Three child tables — implementation steps, test cases, dependencies — read off `GET /changes/:id`,
so these are writes only:

- `POST|PATCH|DELETE /changes/:id/steps[/:stepId]`
- `POST|PATCH|DELETE /changes/:id/tests[/:testId]`
- `POST|PATCH|DELETE /changes/:id/dependencies[/:dependencyId]`

These deliberately **do not** apply the post-approval freeze. Recording that step 4 failed, or that a
regression test passed, is precisely the work that happens after approval — see
`loadChangeForRunbook`, which checks visibility and authorship but not state.

A `PREDECESSOR` or `BLOCKS` dependency left `OPEN` refuses the move to `IMPLEMENTING` with a 409 that
names it. `SUCCESSOR` and `RELATED` do not block — successors follow this change and related work is
context, so blocking on either would make the field unusable for what it is for. `WAIVED` clears the
gate the same way `COMPLETED` does, and the row keeps saying which it was.

### SLA

`ChangeSlaConfig` holds a budget and a warning fraction per stage (`APPROVAL`, `IMPLEMENTATION`,
`VALIDATION`, `PIR`, `CLOSURE`). `judgeSla` returns `ON_TRACK` / `WARNING` / `BREACHED` for a running
clock and `MET` / `BREACHED` for one that has stopped.

A finished stage is judged on **how long it actually took**, never against the current time. A stage
that ran 60 hours against a 48-hour budget and then closed is a breach that already happened;
reporting it as fine the moment it closes is how an SLA dashboard comes to say everything is green
while the register is full of overruns. A stage with no configured budget has no clock at all rather
than a zero-hour one, which would breach everything on sight.

### Tagging

- `GET /changes/:id/linkable-tickets` — **only closed work is offered.** A change is a record of
  shipping something finished; letting somebody attach an in-progress ticket would turn the manifest
  into a promise.
- `POST|DELETE /changes/:id/tickets[/:ticketId]`, `POST|DELETE /changes/:id/collaborators[/:userId]`.

### Calendar and conflicts

- `GET /changes/calendar?from=&to=` — scheduled work **and** the blackout periods it has to dodge, in
  one call. A calendar that fetches its bars and its no-go zones separately renders them a frame
  apart.
- `GET /changes/:id/conflicts` — overlapping changes on the same application, and any blackout the
  planned window collides with. Reported, never auto-corrected.

### Derived context

`GET /changes/:id/context` — what this change is actually shipping, assembled from the tickets it
links rather than typed: repositories, branches, pull requests and merge states (from `TicketBranch`,
kept live by the git webhook), the latest ingested CI run per branch, open security findings, the
people who did the work and their **approved** hours, and how the last five changes to the same
application went.

Two rules it follows. Hours are approved-only — draft time is time somebody typed, not time anybody
signed off. And a repository with no ingested CI run reports **null**, rendered as "not reported",
never as passing: nobody having told us and everything being green are different facts, and only one
is a reason to approve.

Its own route rather than part of `GET /:id` because it reads across five tables — worth paying for
when the Context tab is opened, not on every load of a form somebody came to edit one field on.

### AI over changes

Four capabilities, each off by default, each with a `GlobalAISettings` toggle and a stated ceiling in
`ai-capability.registry.ts`. They appear in the AI capability grid on their own — that screen renders
from the registry.

| Route | Capability | Ceiling | Writes |
|---|---|---|---|
| `POST /changes/:id/risk-narrative` | `change_risk_narrative` | `AUTONOMOUS` | Nothing |
| `POST /changes/:id/conflict-brief` | `change_conflict_brief` | `AUTONOMOUS` | Nothing |
| `POST /changes/:id/draft-assist` | `change_draft_assist` | `SUGGEST` | A `CHANGE_DRAFT` proposal, one row per section |
| `POST /changes/:id/pir-assist` | `change_pir_assist` | `SUGGEST` | A `CHANGE_DRAFT` proposal for the review |
| `POST /changes/:id/draft-field` | `change_draft_assist` | `SUGGEST` | Nothing — returns text the person accepts into the form themselves |

`draft-field` drafts ONE section inline, for the assist button beside each empty prose field. It does
not use the proposal envelope, and that is a decision, not an omission: the envelope keeps a human
between the model and the record when writing happens in the background, and here the human IS the
foreground — the suggestion renders beside the field, and nothing reaches the change until they press
"Use this", at which point the form's own save writes it as THEIR edit through the same PATCH,
validation and audit trail as anything typed. The same trust model AiRefine established. The
draftable set is `CHANGE_DRAFTABLE_FIELDS` — ten prose fields, validated at the route and pinned by
`change-field-requirements.test.ts`; the five that gate submission plus five business-case fields.

**The omission rule.** The drafter LEAVES OUT a section it cannot ground rather than padding it, and
both routes report what was skipped. This rule exists because its opposite shipped: told to "admit
what is not known", the model answered a backout-plan request with "a backout procedure has not been
documented at this time" — text which, if accepted, would satisfy the mandatory-backout submission
gate while containing no plan. The gate checks that the field has words; only a human can check that
the words are a plan.

POST rather than GET throughout: each spends a model call, and a GET should be safe to re-run.

**Nothing here scores, schedules or decides.** The risk score and the schedule conflicts are computed
by `computeRiskScore` and `findScheduleConflicts` — arithmetic with one right answer — and the
capabilities only read them. A score a model produced would be unreproducible, and the score is what
decides whether a backout plan is mandatory.

**The two that write go through the proposal envelope.** `ChangeTarget` gained `CHANGE`, and
`CHANGE_WRITABLE` admits exactly six fields: the five blocking prose sections plus `pirNotes`. No
state, risk, schedule or outcome is reachable however a model replies — an allowlist, not a request
in the prompt. Each row is accepted individually on the AI suggestions page, and one whose underlying
field moved since it was drafted is refused rather than overwriting the edit.

**The plan freeze applies, with one exemption.** A drafted section cannot be applied to a change past
`APPROVED` — that would rewrite what was agreed. `pirNotes` is exempt, because a review is written
after the change has run, which is exactly when the plan is frozen.

**No capability approves a change**, at any level. That is the absence of a capability rather than a
ceiling on one, and `change-draft-proposal.test.ts` asserts it against the whole registry.

### Automation

Change events are already in `DOMAIN_EVENTS` and already exposed by `GET /flows/catalogue`, so
Workflow Studio can trigger a flow on `change.approved`, `change.closed` and the rest. A change
resolves to its own **ticket** as the flow subject — a change *is* a ticket — so every existing
action and branch field works on it.

Three change-shaped actions: `change_transition`, `change_comment`, `change_collaborator`. Each
re-enters `assertLegalChangeTransition`, `assertReadyFor` and `assertDependenciesClear`, the same
three functions the transition route calls; an automation that reimplemented four of the five checks
is exactly how one ends up able to do what the API refuses.

**A workflow cannot approve or reject.** Neither state is reachable from an undecided one through
the transition table, `changeStates` in the catalogue omits both, and the dispatcher refuses them by
name — three layers, because this is the rule the module exists for.

### Metrics

`GET /changes/metrics` returns the state/risk/kind/environment tallies, `awaitingMyDecision`,
`inFlight`, a twelve-week `trend` of raised-against-closed bucketed by real timestamps, the busiest
eight projects, the running-clock SLA rollup, and three delivery-health rates.

`changeFailureRate`, `emergencyRate` and `avgApprovalHours` are **null, never 0**, when there is
nothing to divide by. "No change has closed yet" and "every change succeeded" are different facts,
and a 0% failure rate over an empty set is exactly the number that ends up quoted in a review. The UI
renders null as an em dash.

### Exports

`GET /changes/export.csv`, `.xlsx`, `.pdf` — one query feeds all three, so no two formats can
disagree about which changes matched.

All three are fetched as **authenticated blobs**, never linked. The access token lives in memory
only, so an `<a href>` reaches these routes with no `Authorization` header and gets a 401 — that is
not hypothetical, it shipped that way. Same pattern as `reportApi.download`.

Every format states its own limits: `X-Export-Rows-Included` and `X-Export-Truncated` come back on
all three (with `Access-Control-Expose-Headers` so the browser can read them), the PDF prints the cap
in its header *and* footer, and the workbook's summary sheet is built from the same capped row set as
its detail sheet — so a truncated export can never ship a summary that does not add up.

### Email

Two templates, `changeSubmitted` and `changeDecided`, editable in **Workspace Settings → Email
templates** like every other outbound mail, with the same delivery analytics and failure triage.

The submission mail carries project, title, type, risk, activity window, description, requester and
approver; the decision mail adds who decided it and their comments. Both go **to** the requester,
implementer, approvers and collaborators, with every super admin in **BCC** via `alwaysBcc` — one
merged, deduplicated recipient set, so somebody already on the To line does not also get a blind
copy. Mail is best-effort: a slow SMTP server cannot lose a transition that already happened.

## Ask AI (the page)

`/ai-chat/*` — the full-page Ask AI: a conversation with a memory, distinct from the palette's
one-shot `POST /ai/ask`. Same toggle (`workspaceSearchEnabled`), same capability (`ask_ai`).

- `POST /ai-chat/ask` `{ prompt }` — answers through a tool loop and PERSISTS the exchange: prompt,
  answer, which tools were consulted, model, provider, tokens, estimated cost and duration, all
  stored at answer time so the history keeps saying what each answer actually cost after the
  workspace's model changes. A failed attempt is stored too, with its error — "it failed at 14:02"
  is part of the history.
- `GET /ai-chat/history?limit=` — the asker's OWN exchanges, oldest first. There is no cross-user
  read and no admin view: what somebody asks an assistant is closer to a search history than to a
  work record.
- `POST /ai-chat/:id/feedback` `{ feedback: 1 | -1 | 0 }` — thumbs on one answer; 0 clears, so
  "unrated" stays expressible. Own rows only.
- `DELETE /ai-chat/history` — the clear-my-history gesture. Own rows only.
- `GET /ai-chat/capabilities` — every capability the assistant has, judged for THIS caller: name,
  description, group, whether it writes, whether they may use it, and the gate it needs. Built
  through the same filter the prompt is, so the page's "What can it do?" panel and the model can
  never disagree about what exists. Refused capabilities are returned too, marked `allowed: false` —
  hiding them would make the panel read as the product's whole surface, and somebody would
  reasonably conclude the workspace has no spend reporting because their role cannot see it.

  This endpoint now backs TWO surfaces: the "What can it do?" panel and the `/` menu in the
  composer. **The slash menu is entirely client-side** — there is no `/tool_name` syntax on the
  server and no new endpoint. Picking an entry writes plain English into the box; the loop still
  chooses its own tools, so a pick steers the question rather than bypassing the tool selection.
  That matters for the guardrails: a slash pick cannot reach a capability `visibleTools` would not
  already have shown the model.

**Answers are stripped of this loop's own protocol before they are returned or persisted.** A small
model will sometimes narrate the envelope it is speaking in — publishing fenced blocks containing
`{"action": "tool" …}` or `{"action": "refuse"}` as if they were content, above an otherwise
correct table and chart. `stripProtocolEcho` removes a fenced block or standalone line whose body
carries our own `action` key, and the announcement line that introduced it. It matches the escaped
form too (`{ \"action\": \"answer\" …}`), which is how it actually arrived. A `json` fence
holding real workspace data does not match and is left alone.

`POST /ai-chat/ask` carries `aiRateLimit` (20/min per user) like every other model-spending route:
a chat box is the easiest place in the product to spend a budget by holding down Enter, and the
monthly AI ceiling underneath it is too coarse to stop a minute of hammering before it lands.

**How the loop works, and why it is not native tool-calling.** The model is asked for exactly one
JSON object per step — a tool request or a markdown answer — through the same `callChat` +
`parseJsonResponse` every capability uses. This is a bring-your-own-key product: native tool calling
is a per-provider dialect many configured models do not speak, and "reply with one JSON object"
works on anything that follows instructions. A model that ignores the format degrades gracefully —
its raw text becomes the answer. Five tool steps maximum, then a forced final answer from whatever
was gathered.

**Reads and actions are two registries with two contracts.** The read surface is split across two
files, and the split is the access boundary made structural. `ai-chat-tools.ts` holds the everyday,
PROJECT-SCOPED tools — tickets, changes, timesheets, metrics, projects, goals, the people directory,
the agent roster and the workflow list — each scoped through the same `ticketProjectScope` the pages
use, each running as the asking person, none reaching past what that person could already open.
`ai-chat-admin-tools.ts` holds the OPERATIONAL ones — AI spend and answer quality, email volume and
failure reasons, email templates, service health, API latency percentiles, the audit log, security
findings, CI runs, identity-check outcomes, workspace configuration, SSO and auth methods, scheduled
report subscriptions, project risk, headcount, SLA breaches and automation activity — and every entry
there carries an access gate. `sso_and_auth` is the one tool that reads the CONTROL plane rather than
the tenant database, scoped to the caller's own org exactly as `GET /settings/sso` is, and it reports
every secret as SET or NOT SET rather than reading it. Both files are held provably
read-only by a test that greps them for every Prisma write verb, and a second test asserts that no
tool in the admin registry is ungated.

**Every gate mirrors a page.** `audit_log` needs `audit:view`, the same as the Audit log page;
`user_stats` needs `users:manage`, the same as Users; `timesheet_report` and `sla_and_escalations`
need `reports:view`. Spend, mail, security, health, API telemetry and configuration are
super-admin-only, because that is who those settings pages are for. Nothing invents an access rule;
where the chat cannot mirror a page's rule exactly it takes the stricter one.

**A tool is filtered twice, from one predicate.** `ai-chat-guardrails.ts` holds `canUseTool`;
`visibleTools` decides what the prompt may even mention, and `assertToolAllowed` decides what may
actually run. Filtering only the prompt would be security by suggestion — a model that hallucinates
a name it never saw, or is talked into one by injected text, would reach a real query. Filtering
only at execution would be correct but wasteful: the model would keep proposing tools it is refused
and burn steps on them. Everything a tool returns then passes through `sanitiseToolResult`, which
applies the AI layer's own secret masking (a scanner finding's title can BE the leaked credential)
and one shared 2,400-character cap.

Measured effect on the seeded workspace: a super admin sees 34 capabilities, a manager 20, an
employee 16.

The action registry (`ai-chat-actions.ts`) holds what the assistant may DO. There are four:
`log_timesheet_draft`, `raise_ticket`, `comment_on_ticket` and `draft_change_request`.

**The rule is that nothing starts or settles an approval.** Where the record has a draft state the
action uses it and stops — a timesheet is saved DRAFT, a change is raised DRAFT — because submitting
either starts an approval SLA clock and, where the workspace requires it, an identity check, and an
assistant must not trigger those from a sentence. Where there is no draft state the action says so
plainly rather than borrowing the word: `TicketStatus` begins at OPEN and `TicketComment` has no
unpublished state, so raising a ticket and posting a comment genuinely publish, and their
descriptions tell the model to confirm the details with the person first. No action transitions a
change, decides a timesheet or approves anything, at any autonomy level.

**Two gates, not one.** Every action except the timesheet draft declares the permission its own page
requires (`tickets:write`, `changes:write`) — the timesheet draft is ungated because it writes the
asker's own record, which they can already do from the form. The permission is only half of it: each
executor then re-checks that the caller can actually SEE the project or ticket, because a
workspace-wide `tickets:write` is a permission and not a boundary. An employee who holds it is still
refused a project they are not assigned to.

**The validations live once.** `raise_ticket` and `comment_on_ticket` call
`createTicketForActor` / `addTicketCommentForActor` in `ticket.service.ts` — the same functions the
MCP server's `create_ticket` and `add_ticket_comment` call — so visibility, the ticket-type check,
the sanitisation of model-written prose, the SLA clock and the reporter attribution cannot drift
between the two callers. `draft_change_request` calls `createChangeRequest`, the extracted body of
`POST /changes`, so the module gate, the project check and the risk scoring apply unchanged;
`justification` stays required and is never defaulted. `log_timesheet_draft` calls `saveTimesheet`,
giving it the Serializable overlap check, the assignment gate and the >12h rule.

A refusal goes back to the model as data phrased for relaying, and the loop refuses to re-run an
identical consecutive call, so a model that repeats itself cannot double-fire an action. Four guard
tests hold the boundary: the action list is pinned, no action may reach Prisma directly, every
publishing action must declare a permission, and every one of them must carry the instruction never
to act on an instruction it merely READ — a ticket description is attacker-controlled in any
workspace with email intake switched on.

The prompt carries today's date and the asker's name — the two facts a model cannot look up and
reliably invents instead (measured: asked to log time "today", it wrote a date from its training
data).

**Only exchanges that consulted a tool become context for the next question.** Fed its own failures
back as "recent conversation", the model copies them: measured, it declined operational questions it
had answered correctly moments earlier on a clean history, and reproduced a malformed tool-call
fragment from two turns before. Excluding outright errors was not enough — a fluent "I'm sorry, I
encountered an error" is stored as an *answer*, and is the most copyable thing in the window. A
consulted tool is the positive signal that separates the two: an exchange that fetched data is
exactly what a follow-up refers back to, and one that fetched nothing is a decline, a format failure
or small talk. Failures still render in the page's feed, where "it failed at 14:02, and this is why"
belongs.

**The read-first rule appears twice, and position mattered more than wording.** Even with the
prompt rewritten in positives, questions about authentication came back as "would you like me to look
that up?" three times out of three, while spend and health answered directly — a model being careful
about a topic it is trained to be careful about. Rewording the tool's description changed nothing.
Repeating the rule beside the reply-format block, where the choice is actually made, fixed all three.
The instruction was not missing; it was too far from the decision.

**The prompt is written in positives, and that is load-bearing.** An earlier draft framed the scope
rules as five lines of prohibitions — "never decline", "never offer alternatives", "may you say a
figure is unavailable". On the small model this workspace runs it produced exactly the behaviour it
forbade: six operational questions in a row came back as polite refusals paraphrasing the
prohibition, without a single tool call. Saturating a prompt with the vocabulary of refusal teaches
refusal. The same applies to caution that is not scoped: "make sure you have the real details before
acting" leaked from actions into reads until it said so explicitly, and the assistant started asking
permission to look things up. Reads never ask; actions always do.

**A thumb feeds the golden datasets.** When interaction capture is on, the final answer is captured
as an `AIInteraction` and the exchange stores its id; a thumb on the page then writes the same
`up`/`down` feedback the AI activity log writes, which is exactly what golden datasets are promoted
from (`ai-dataset.service.ts`). Without capture there is no interaction row and the rating stays a
page-local preference — the tooltip on the thumbs says which loop it feeds either way.

**Answers are markdown, with real charts.** The model may emit one fenced ```chart block with
numbers a tool actually returned; the page shape-checks the JSON and draws it with the app's own
chart components. Everything textual passes through the same `marked` + DOMPurify pipe the
What's-new page renders the changelog with.

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

- `GET /settings/notifications` *(SUPER_ADMIN)* — the workspace notification singleton: all 44
  `email*` category booleans (the authoritative list is `notificationPreferenceKeys` in
  `packages/shared`, not this sentence), the reminder schedule (`dailyReminderHour`,
  `escalationReminderHour`, `remindOnWeekdaysOnly`), `bccSuperAdminOnAllEmails`, `emailRoleMutes`,
  the practice-update distribution list (`practiceUpdateRecipients`, `practiceUpdateWeekly`),
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

## Outbound email: pacing and the send queue

Every outbound email goes through `services/mail.service.ts#sendMail`. Two mechanisms keep it from
tripping the provider's rate limit, and they solve different halves of the problem.

**1. The transport is pooled and rate-limited.** It was not: each send built its own SMTP
connection and fired immediately, and `dispatchNotification` deliberately detaches the send (a real
SMTP round trip costs 1–3s *per recipient*, and awaiting them made a face-verify notify four
reviewers in 8.7s instead of 200ms). So a bulk approval of twenty timesheets, or the daily reminder
sweep across a fifty-person workspace, opened that many **simultaneous** connections in one tick.
Office 365 permits three. The rate limits were self-inflicted from there.

The pool is configured per workspace on **Workspace Settings → Mail server**, stored on
`GlobalMailSettings`, and clamped server-side regardless of what is stored:

| Setting | Default | Bounds | Maps to |
|---|---|---|---|
| `maxConnections` | 3 | 1–20 | nodemailer `maxConnections` |
| `maxMessagesPerWindow` | 25 | 1–5000 | nodemailer `rateLimit` |
| `rateWindowMs` | 60000 | 1s–1h | nodemailer `rateDelta` |

The defaults are the conservative intersection of the common providers (Office 365: 30 messages per
minute and 3 concurrent connections; Gmail SMTP: ~20 concurrent; SES: a per-account send rate), with
headroom for the audit BCC. Anything over the limit **waits its turn inside the pool** rather than
being rejected.

**2. What the provider still refuses is retried.** `EmailLog` has carried a `QUEUED` status since
the first migration and nothing ever re-drove a row out of it — `sendMail` wrote QUEUED, hit the
server in the same breath, and wrote SENT or FAILED. A `451 too many messages, slow down` therefore
lost that email permanently, and the only evidence was a FAILED row nobody reads.

`EmailLog` is now the queue itself: `attempts`, `nextAttemptAt`, `lastAttemptAt` and `payload` (the
rendered body, kept **only** while the row is still deliverable and cleared the moment it is sent or
given up on, so this stays an audit log rather than a copy of every email ever sent).
`workers/mail-queue.worker.ts` drains `status = QUEUED AND nextAttemptAt <= now()` every minute,
oldest first, serially — concurrency here would hand the whole batch to the pool at once and defeat
the pacing.

- **Retryable vs permanent** is decided by `classifyFailure`. A 4xx SMTP reply is transient by
  RFC 5321 — which is exactly what a rate limit is. A 5xx is permanent, *unless* its text says
  otherwise (several providers answer `550` for "sending quota exceeded"). Socket-level errors
  (`ETIMEDOUT`, `ECONNRESET`, `EAI_AGAIN`, …) are transient: a dropped connection says nothing
  about whether the message was acceptable. Anything unrecognised defaults to **retryable** — the
  attempt cap bounds the cost of being wrong at four extra tries, while the opposite default
  silently drops mail.
- **Backoff** is 1m / 5m / 15m / 30m with up to 20% jitter, so a burst rejected together does not
  come back in lockstep and get rejected together again.
- **`MAX_SEND_ATTEMPTS = 5`**, after which the row goes `FAILED` and stays there. That is the
  dead-letter, and it is what `/email-templates/analytics/failures` below reports on.
- A row written but never attempted (the process died mid-send) is picked up as an **orphan** after
  five minutes. That is why the log row is written *before* the send rather than after.

> **A credential-bearing body is never persisted, and therefore never retried.** `payload` exists
> so a deferred send has something to send — harmless for a rendered notification, and not harmless
> for a password-reset email, whose body carries the **live token**. `PasswordResetToken.tokenHash`
> is bcrypt precisely so that database access cannot yield a usable token; storing the rendered
> body would hand it straight back. `SendArgs.sensitive` suppresses the stored copy and makes any
> failure terminal (there is nothing to retry *with*, and a token that expires in thirty minutes is
> worthless by the time a retry would run — asking for another link is one click). Set explicitly
> on the reset flow, and backstopped by `looksSensitive()`, which re-checks the **rendered HTML**
> for token- and password-shaped content regardless of the flag — an admin can edit any template
> from the Email templates screen, so the template key is not a reliable statement about what the
> body contains.

`sendMail` still attempts the first delivery **inline**, so the common case keeps its latency and
the "Send test email" button still reports what actually happened. What changed is the failure path.
`SendResult.status` gained `QUEUED` for exactly that reason: a caller that reports "could not send"
for a message the queue is about to deliver is lying to the user.

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
  `ticket_description`, `ticket_comment`, `timesheet_description`, `timesheet_notes`,
  `practice_summary`, `practice_risk`, `practice_priority`, `practice_decision`
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
  three `ticket_*` fields require `tickets:write`, the two `timesheet_*` fields require
  `timesheets:write`, and the four `practice_*` fields require `users:manage` — the practice update
  is a super-admin surface end to end, and `users:manage` is the permission nobody below admin tier
  holds. "Can you edit this text at all" and "can you have the AI tidy it" give the same answer.
  Validation runs first, so `field` is a known value before the permission is looked up; a mismatch
  is `403`.

  **The allow-list has ONE source.** The validation enum is derived from `REFINE_FIELD_KEYS`
  (`Object.keys(REFINE_FIELDS)`) rather than re-typed. It used to be hand-maintained in three
  places — the record that dispatches on it, the enum, and the client's copy — and adding the four
  `practice_*` fields updated two of them, so every request for a new field was refused `422` by
  the third with a message that named nothing. If you add a field, add it to `REFINE_FIELDS` and to
  the client union in `apps/web/src/services/api.ts`; the enum follows on its own.

  Gated by the AI master switch **and** the `writingAssistantEnabled` toggle, and charged against
  the same monthly budget as every other capability (logged to `AIUsageLog`/`AIInteraction` under
  its own `text_refine` feature). `422` when the field is empty or unrefinable, `402` when the
  budget is spent, `403` when AI or the writing assistant is off, `502` if the model returns
  nothing — returning the original unchanged would look like the model had considered it and
  chosen to leave it alone.

- `POST /ai/text/improve` — `{ text, context }` — the older whole-field rewrite, still mounted and
  still gated on `tickets:write`. No longer surfaced in the UI: it replaced what the author had
  typed, with no preview and no way back.

## Weekly AI/ML Practice Update

The consolidated leadership digest — one weekly view of Products, POCs/Innovation, Bugs/Stability,
Security and Training, plus metrics, risks, next week's priorities and the decisions leadership is
being asked to make. Rendered by `services/practice-update-mail.service.ts` from figures counted by
`services/practice-update.service.ts`, with an optional AI-written narrative around them.

**Every route on this router is `requireAuth, requireSuperAdmin`.** The update aggregates every
project, everyone's hours and every open security finding into one document and then mails it to an
arbitrary address list — both halves of that are privileged, and "only a super admin decides who
this goes to" is cheapest to keep true if nobody else can reach any of it.

- `GET /practice-update/settings` — the distribution list and both gates:

  ```json
  {
    "recipients": ["ceo@example.com"],
    "configured": true,
    "weekly": false,
    "emailEnabled": true,
    "aiNarrativeEnabled": true,
    "maxRecipients": 50
  }
  ```

  The two gates are reported **separately and named** because "nothing happened when I pressed
  send" has two different causes and the page has to be able to say which. `emailEnabled` is
  `GlobalNotificationSettings.emailPracticeUpdate` (the same category switch every other digest
  has); `aiNarrativeEnabled` is `GlobalAISettings.practiceUpdateEnabled` and gates only the prose.
  `configured` distinguishes "nobody has been chosen yet" (`null` column) from "an empty list was
  saved deliberately" — the send refuses on both, only the UI tells them apart.

- `PUT /practice-update/settings` — `{ recipients: string[], weekly?: boolean }`. Addresses are
  lower-cased and de-duplicated, capped at 50 (a distribution list, not a mailshot), and validated
  one at a time so a bad address **names itself** rather than failing the save with a field path.
  Plain email addresses rather than user ids, on purpose: the people who most need this update — a
  CEO, a practice head — often have no account in the workspace it is about, the same call
  `ReportSubscription.recipients` already made. Audited as `practice_update.recipients_updated`.

- `POST /practice-update/draft` — `{ from?, to? }` as `YYYY-MM-DD`; with neither, the last complete
  Monday-to-Sunday week. Returns the counted `data`, the drafted `narrative`, an `aiFailed` reason,
  and a rendered `preview`:

  ```json
  {
    "data": { "period": {…}, "metrics": {…}, "previousMetrics": {…}, "initiatives": […], "releases": [], "isEmpty": false },
    "narrative": { "executiveSummary": "…", "risks": […], "nextWeekPriorities": […], "decisionsRequired": […], "nextSteps": [{ "id": "…", "text": "…" }] },
    "aiFailed": null,
    "preview": { "subject": "…", "headline": "…", "sectionsHtml": "…" }
  }
  ```

  **The narrative is best-effort and the figures are not.** `aiFailed` distinguishes three
  outcomes a caller would otherwise see as one silent `null`: the capability is switched off, the
  model was unreachable, or it answered in a shape the update could not use. Every section still
  renders from the facts it would have been written from, so a draft is always complete.

  `initiatives` are the workspace's active projects, each with `category` (`PRODUCT` | `POC` |
  `BUGS` | `SECURITY` | `TRAINING`), `owner`, `status` (`GREEN` | `AMBER` | `RED`), the period's
  counts and one-line `progress`/`risks` strings. Category and owner are **inferred** — from the
  project's name then from what its people logged against it, and from who logged the most hours
  falling back to the largest open-ticket holder. The status is **arithmetic**: `RED` on any SLA
  breach or when more than a third of open work is already late, `AMBER` on anything overdue,
  `GREEN` otherwise. A model never chooses it, because a red a model chose is not reproducible in
  the meeting where somebody asks why.

- `POST /practice-update/send` — `{ from?, to?, narrative? }`. Mails the **reviewed** update to the
  configured list as one send with everyone on it (a circulated update whose recipients are meant
  to see that they share it).

  **The figures are rebuilt server-side from the period rather than trusted from the request.** The
  client may edit the prose and only the prose; a caller who could post arbitrary numbers into a
  document that looks like it came from this workspace's records could make it say anything. The
  reviewed `narrative` IS taken from the body — regenerating it here would silently discard the
  edits and send a document nobody had read.

  `422` when the distribution list is empty or when `emailPracticeUpdate` is off, each with a
  message naming the exact setting to change. `502` when SMTP rejects it outright. Otherwise
  `{ status, recipients, subject, emailLogId }`, where `status` is the usual `SENT`/`QUEUED`.
  Audited as `practice_update.sent`.

**Cadence.** `workers/practice-update.worker.ts` sends the same update at 07:30 on Mondays when
`practiceUpdateWeekly` is on — off by default, because the button is the primary path and an
unreviewed digest reaching a CEO every week is not something to switch on for somebody. Three gates
must all be open (the cadence flag, the email category, a non-empty list) and the run is idempotent
by re-reading its own `EmailLog` rows rather than keeping state, so a restart cannot mail leadership
twice. A period in which nothing at all was recorded is skipped: an update full of zeroes trains
people to stop opening it.

**Email registration.** The template key is `digest.practice_update`, so it appears in
[Email templates](#email-templates) with preview, test send and revert, and in Email analytics with
per-template delivery figures — no special-casing. **No new environment variables.**

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

### Key lifetime

A key can carry an **expiry**, chosen when you generate it: 30 days, 90 days, 1 year, or never.
90 days is the default offered, and "never" is a deliberate choice rather than the path of least
resistance — a standing bearer token pasted into a Zapier account or a cron script is the
credential nobody revisits, and `lastUsedAt` is the only signal it is still out there.

Workspace Settings → Public API shows each key's expiry, warns two weeks out, and badges an expired
key as expired rather than letting it look identical to a working one.

Once past its expiry a key is refused with **401** and the *same* message an unknown or revoked key
gets — `Invalid or revoked API key.` That is deliberate: a distinct "your key expired" would confirm
to an unauthenticated caller that the key they hold was once real, which is the one thing a guesser
actually wants to learn. If an integration starts 401-ing, check the key's row in Workspace Settings
rather than inferring the reason from the response.

Keys created before this field existed have **no expiry and keep working** — nothing that works
today stops working because this was added. Revocation is unchanged and still immediate.

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

