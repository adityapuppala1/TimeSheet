# Face (identity) verification

Confirms the person submitting a timesheet, creating or progressing a ticket, or **approving** a
timesheet is actually the account holder — closing the "buddy punching" gap where one employee
acts on a colleague's behalf using a borrowed or shared session.

Off by default, and **Enterprise-plan only**: the `PlanTierLimit.faceVerificationEnabled` flag
(seeded `true` only for ENTERPRISE) gates it per tier, adjustable in the platform-admin console
under Plan tiers. Nothing in this document happens until the org is on an entitled tier AND a
SUPER_ADMIN turns it on.

The entitlement fails in two deliberate directions:

- **Fail closed** — enabling the feature, enrolling, and verifying all 403 without the
  entitlement. No new biometric data can be collected on a plan that doesn't include the feature.
- **Fail open** — *enforcement* on submissions stops the moment the entitlement disappears
  (downgrade, lapsed payment). A billing event must never lock a workforce out of logging their
  own time. See "When the plan changes" below for what happens to stored data.

---

## ⚠️ Read this before enabling it for real staff

This feature collects and stores **biometric data**, which is regulated far more strictly than
ordinary personal data:

| Regime | What it requires (in short) |
|---|---|
| **GDPR Art. 9** | Biometric data used to identify a person is a *special category*. Needs an explicit lawful basis (usually explicit consent) and normally a DPIA. |
| **Illinois BIPA** | Informed **written** consent before collection, a published retention schedule, and no profiting from the data. Enforced by a private right of action with statutory damages per violation — this is the one that has produced nine-figure settlements. |
| **Texas CUBI / Washington HB 1493** | Consent before capture; deletion within a set period after the purpose ends. |
| **India DPDP Act 2023** | Biometric data is sensitive personal data; notice + consent + purpose limitation. |

The implementation gives you the mechanics to comply — explicit consent capture, stored consent
wording, a retention schedule that is actually enforced, and self-service deletion. **It does not
make you compliant on its own.** Confirm your own obligations (and whether employee consent is
freely given in your jurisdiction — some regulators are sceptical of consent in an
employer/employee relationship) before switching this on.

---

## How it works

```
Browser                          Server
───────                          ──────
                 ──POST /api/face/challenge─►  pick a RANDOM head movement
                 ◄── challengeId+instruction   (single-use, 90s)
capture neutral frame,
show instruction, countdown,
capture gesture frame
                 ──POST /api/face/verify────►  redeem the challenge
(2 frames + challengeId;                       measure the head-pose delta
 no ML in the browser)                         detect face, anti-spoof + liveness (both frames)
                                               compare to enrolled template
                                               record the attempt (pass or fail)
                 ◄── verificationId ─────────  (single-use, expires in ~5 min)

submit timesheet ──POST /api/timesheets/submit──►  consumeVerification()
  + verificationId                                 (must be PASSED, unused,
                                                    fresh, same user+context)
```

**Every decision is made server-side, deliberately.** The browser is a dumb camera: it uploads
JPEGs and nothing else. If the client decided the outcome, any employee could open devtools and
POST `{"verified": true}` — the feature would be theatre. This is why there is no face-matching
JavaScript in the web bundle.

### What each gate covers

| Action | Toggle | Notes |
|---|---|---|
| Timesheet **submit** | `requireForTimesheet` (default on) | Never drafts — a draft is private working state. |
| Timesheet **approval** | `requireForApproval` (default off) | Checks the **approver**. Approval is where hours become payable. Rejection is deliberately ungated — it moves no money, and demanding a webcam capture to *decline* something only discourages review. |
| Ticket **create** + **status change** | `requireForTicket` (default off) | Status transitions are the workflow-authoritative actions ("who actually resolved this?"). Comments and field edits are never gated — they're collaborative, and a webcam prompt per inline edit would be hostile without adding assurance. |

### The challenge–response step (anti-injection)

The attack the plain check can't stop: a **virtual camera** (OBS et al.) replaying a recorded
video of the right person. Every frame is a genuine live-looking face — anti-spoof honestly
passes, because it judges the *frame*, not the *moment*.

What a replay cannot do is perform a head movement the server only chose **after** the recording
existed. With `challengeEnabled` (default on):

1. `POST /api/face/challenge` issues a random instruction — turn your head / tilt up — with a
   90-second, single-use lifetime.
2. The dialog captures a neutral frame first, *then* fetches the instruction (so it can't be
   anticipated), shows it with a short countdown, and auto-captures the gesture frame.
3. The server measures the actual rotation delta between the two frames and requires the
   demanded axis to both clear a floor (~20° yaw / ~13° pitch) and dominate the other axis — a
   nod can't satisfy a turn. Both frames must also each contain exactly one live face.

The check is **axis-based rather than direction-based** ("turn to either side", not "turn left
specifically") on purpose: the model's sign convention hasn't been calibrated against real
cameras, and a wrong guess would fail every honest user. The measured deltas are persisted on
every attempt (`challengeYawDelta` / `challengePitchDelta`) so direction enforcement can be
tightened later from real evidence.

Failing outcome: `CHALLENGE_FAILED`. Turning `challengeEnabled` off reverts to the original
single-frame check.

### Review signals (recorded, never blocking)

Two heuristics ride along with every verification and appear in the review log — as **signals
for a human**, never as automated verdicts, because both are client-influenced and spoofable:

- `virtualCameraSuspected` — the camera's self-reported label matched a known virtual-camera
  product (OBS, ManyCam, …). An attempt through one is **flagged for review even when it
  passes** — a pass through an injection tool is precisely the pass worth a human look.
- `unfamiliarNetwork` — this attempt's IP matches none of the user's recent passed attempts
  (only meaningful once they have a baseline of 3+ passes; people do work from trains).

### The models

[`@vladmandic/human`](https://github.com/vladmandic/human) (MIT), running in Node:

| Model | Purpose |
|---|---|
| `blazeface` + `facemesh` | Find the face |
| `faceres` | 1024-float embedding used for matching |
| `antispoof` | Is this a real face or a printed photo / phone screen? |
| `liveness` | Was a live person in front of the lens? |

Models ship inside the npm package (~10MB for the ones enabled) and load lazily — nothing is paid
at boot unless the feature is actually used.

**Anti-spoofing matters as much as matching.** Without it, holding up a printed photo of a
colleague passes trivially, which defeats the entire point. Both floors must be cleared *before*
the similarity comparison even runs.

---

## Setup

### 1. Enable it — Workspace Settings → Face verification (SUPER_ADMIN)

| Setting | Default | Notes |
|---|---|---|
| Enable face verification | off | Master switch; everything else is inert while off. Enabling requires the Enterprise entitlement (config below stays editable without it, so an org mid-upgrade can stage everything). |
| Require on timesheet submit | on | Only applies to `SUBMITTED`, never drafts. |
| Require on ticket actions | off | Creation + status transitions. Comments/edits never gated. |
| Require on timesheet approval | off | Checks the approver. |
| Movement challenge (anti-replay) | on | The two-frame challenge–response step above. |
| Apply to everyone | off (SELECTED) | Off = only users you switch on individually. **Leave it off first** — turning it on for a whole company mid-week locks out anyone who hasn't enrolled. |
| Match threshold | 0.75 | See calibration below. |
| Anti-spoof floor | 0.5 | |
| Liveness floor | 0.6 | |
| Failures before flagging | 3 | Consecutive failures within 15 min before an attempt is flagged for review. |
| Check valid for | 300s | How long a passed check stays spendable. |
| Keep images (days) | 30 | `0` = never store captured images at all (embeddings only). |
| Consent wording | built-in default | Stored verbatim with each enrollment. |

### 2. Pick who it applies to

With **Apply to everyone** off, switch it on per person in **Users → edit → Require face
verification**. This is the recommended rollout: enable for a pilot group, confirm it works with
their hardware and lighting, then widen.

### 3. Employees enroll — Profile → Face verification

They must tick the consent box before the camera can even be turned on. Enrollment refuses a
capture with no face, more than one face, or one that fails the liveness check.

**Nobody finds out from a blocked submission.** The moment the policy starts covering someone
who hasn't enrolled — the workspace switch, the enforcement mode, or their individual flag —
they get an in-app notification and (per the workspace's toggles) an email pointing at their
profile, and the dashboard shows a first-run checklist with the enrollment step marked
*Required*. The daily worker re-nudges at most once per 72 hours. The alternative — a security
control whose first contact is a refused timesheet at 6pm on a Friday — converts the feature
into a support ticket every single time.

### Trust marks

A submission or approval that spent a passed check shows an **Identity verified** badge — on the
employee's own history rows, in the manager's approval queue, and on the ticket header. The
approval queue also distinguishes *covered-but-unverified* rows (they predate the policy or
slipped through a gap) from rows the policy simply doesn't apply to, so the absence of a badge is
never ambiguous. This is half the point of the feature: deterrence needs the mark to be
*visible*, and the employee deserves a durable receipt that their check was accepted.

---

## Calibrating the match threshold

The default of **0.75** was measured against these exact models, not guessed:

| Comparison | Typical score |
|---|---|
| Two different people | **0.23 – 0.67** |
| Same person, different capture | **~0.83** |
| Identical image | **1.00** |

0.75 sits in the gap. Every attempt records its own similarity score, and the settings page
renders a **match-score histogram** (last 90 days, passed vs rejected, bucketed) — what a
correctly calibrated threshold looks like is two well-separated clusters with the threshold in
the valley between them. If the colours overlap, the threshold is cutting into real people.

- Genuine users failing? **Lower** it (0.70).
- Worried about lookalikes/siblings? **Raise** it (0.80) and expect more retries.

---

## What gets stored, and for how long

| Data | Where | Retention |
|---|---|---|
| Face template (1024-float embedding) | `FaceEnrollment.encryptedEmbedding`, **AES-256-GCM encrypted** | Until the user or an admin deletes it |
| Reference photo | `UPLOAD_DIR/face/<orgId>/<userId>/`, **not** under the public `/uploads` mount | Until deleted |
| Each attempt's outcome + scores + signals | `FaceVerificationAttempt` | Kept (audit trail — contains no biometric data once images are purged) |
| Each attempt's captured image | `UPLOAD_DIR/face/<orgId>/<userId>/` | Auto-deleted after `imageRetentionDays` |
| Liveness challenges | `FaceChallenge` (instruction + expiry only — no biometrics) | Deleted a day after expiry |

The `<orgId>` level exists so one organization's biometric imagery can be located — and purged —
as a directory, not a database join (deletion still also removes the legacy pre-org-scoped
`face/<userId>/` location, so data written by older versions is honoured).

Two deliberate choices worth knowing:

**Face images are never served from `/uploads`.** That static mount has *no authentication* — any
filename that leaks is world-readable, cross-tenant. Face imagery is served only from
`GET /api/face/image/...`, which checks the session, the tenant, and that you're either the
subject or an admin.

**Embeddings are encrypted at rest.** An embedding is biometric data in its own right, so it gets
the same treatment as an API key. The accepted trade-off: matching decrypts in Node rather than
comparing in SQL — fine here, because a verification compares against exactly one row (that
user's), never a whole-table scan.

Retention is enforced by `workers/face-retention.worker.ts` (daily, 03:15). A retention policy
nothing enforces is just a document.

---

## Deleting and exporting biometric data

- **Employee:** Profile → Face verification → *Delete my face data*
- **Admin:** `DELETE /api/face/enrollment/:userId`

Both delete the template **and** every stored image from disk, and clear image references on
past attempts. The attempt history (who/when/outcome) survives, since it's the audit record and
holds no biometric data once images are gone. The subject receives a confirmation notification
either way — that record doubles as the deletion evidence biometric-privacy regimes want to see.

**Export (data-subject access):** Profile → Face verification → *Download my data*
(`GET /api/face/export`) — everything held about the caller's face verification as JSON:
enrollment metadata, the exact consent wording agreed to, and every attempt with its scores and
signals. Deliberately **excludes** the embedding (it's the credential — exporting it would hand
out the thing being protected) and filesystem paths; stored images are fetched individually
through the authenticated image routes.

## When the plan changes (downgrade / lapsed payment)

The moment the org's tier stops including face verification, enforcement stops (fail-open —
nobody is locked out). The daily worker then:

1. Stamps `entitlementLostAt` and notifies the org's admins: enforcement paused, purge scheduled.
2. Keeps stored templates and captures through a **30-day grace window** — long enough to
   re-subscribe without re-enrolling everyone.
3. After the window: purges every enrollment and image, and switches the feature off. Retaining
   biometric data for a feature the org can no longer use is exactly the "no longer necessary
   for the purpose it was collected for" case storage-limitation rules target.

Re-upgrading inside the window clears the clock and everything resumes untouched.

---

## When a check fails

Blocks the submission, lets the user retry, and after `maxAttempts` consecutive failures flags
the attempt for admin review — it does **not** hard-lock someone out of logging their own work.
Real matching fails on bad lighting, new glasses, or a dirty webcam, so the copy never accuses
the user.

Outcomes recorded: `PASSED`, `NO_FACE`, `MULTIPLE_FACES`, `NO_MATCH`, `SPOOF_SUSPECTED`,
`CHALLENGE_FAILED`, `NOT_ENROLLED`, `ERROR`.

### The review loop

A flag that nobody reads is not a control, so the review pipeline is push, not pull:

- **Flagged** (repeated failures, or any suspected-virtual-camera attempt, pass or fail) →
  in-app + email to the person's manager and the workspace admins. Never includes scores or
  images — email gets forwarded and archived; the log itself is behind authorization.
- **Sitting unreviewed 48h+** → daily overdue nudge to admins (once per 24h), the same
  breach-then-escalate ladder the SLA system uses.
- **Weekly identity digest** (Monday morning, off-by-default email toggle) → checks run,
  failures, repeat failers, signal counts. Deliberately deterministic — no AI writes emails
  about named employees' identity checks.
- **AI review summary** (optional, off by default: Workspace Settings → AI → *AI identity-review
  summaries*) — a one-click brief on any attempt: 30 days of history, device/network novelty,
  timing pattern, cross-referenced against the person's timesheet pattern, ending in a
  LOW/MEDIUM/HIGH read and one concrete next step. **Only attempt metadata enters the prompt**
  — captured images and embeddings never leave the server, and the human still decides.

---

## Operational notes

- **HTTPS is required.** `getUserMedia` doesn't exist on insecure origins (except `localhost`).
  Without TLS the camera simply won't start; the UI says so explicitly, and
  `npm run doctor -w apps/api` warns about it at setup time (add `--face` to also load the
  models and time an inference).
- **Performance:** ~150ms per verification frame once models are warm, measured on a laptop CPU;
  budget 300–500ms per frame on typical cloud vCPUs. The challenge flow analyses two frames.
  Not on any hot path — it runs once per submission. **Memory is the real budget**: the models
  hold ~500MB per API process once loaded (lazily, only in processes that serve a face request),
  so allow ~1GB of headroom per such process.
- **Rate-limited.** `/api/face/*` carries its own 60/min-per-IP limit — each verify is CPU-bound
  wasm inference, so unthrottled retries are a self-inflicted DoS as much as a brute-force
  surface.
- **No native dependencies.** Uses Human's `node-wasm` build with pure-JS TensorFlow.js, so
  there's no compile step and the Alpine Docker image builds unchanged.
- **A verification can't be replayed.** Single-use and short-lived; a concurrent double-submit is
  arbitrated by a conditional update, so exactly one wins. Challenges are equally single-use.
- **Model upgrades force re-enrollment.** Embeddings aren't comparable across model versions, so
  `FaceEnrollment.modelVersion` is checked and the UI prompts rather than silently failing.

### What this does and doesn't stop

Honest threat model, worth internalising before relying on it in a dispute:

| Attack | Stopped? |
|---|---|
| Printed photo / phone screen held to the camera | ✅ anti-spoof + liveness |
| Enrolling a photo of a colleague | ✅ liveness at enrollment |
| Replaying a verification or challenge id | ✅ single-use + TTL |
| Posting straight to the API, skipping the camera | ✅ server-side `consumeVerification`, 428 |
| Two people in frame | ✅ refused outright |
| Virtual camera replaying recorded video | ✅ challenge–response (when on); also surfaced as a review signal |
| Real-time face-swap performing the challenge live | ⚠️ raises effort dramatically; signals (device label, network novelty) flag it for review, but a sufficiently good live swap is beyond any single-camera check |
| Verify honestly, then hand over the keyboard | ❌ inherent — proves presence at capture, never authorship of the work |
| Identical twin | ❌ inherent to face biometrics at any tolerable threshold |

---

## Verifying it works

```bash
# ML layer against the real models (embeddings, liveness, encryption round-trip)
npm run verify:face -w apps/api

# Full HTTP flow against a running API: gate blocks, enroll, verify, challenge–response
# (no-challenge refusal, static-replay refusal, single-use), virtual-camera flagging,
# verified badge, approval gate, replay rejection, wrong-face rejection, permissions,
# stats, export, retention, deletion
npm run verify:face:e2e -w apps/api
```

Unit tests for the enforcement logic (who's required, entitlement fail-open, single-use/expiry
rules, challenge redemption and pose checks) live in `apps/api/tests/unit/face.service.test.ts`
and run with `npm run test -w apps/api`.
