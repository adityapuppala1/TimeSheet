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
show instruction + live meter,
capture at the PEAK of the turn
                 ──POST /api/face/verify────►  redeem the challenge
(2 frames + challengeId;                       measure the head-pose delta ITSELF
 browser tracks pose only)                     detect face, anti-spoof + liveness (both frames)
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
   anticipated), and shows it with a **live meter that fills as you turn**. The gesture frame is
   taken automatically at the *peak* of the rotation.

   This replaced a fixed 3-second countdown, and the reason is worth recording because it was the
   single largest source of failed checks in the product.

   **Read the 107 CHALLENGE_FAILED rows carefully before drawing conclusions from them** — an
   earlier revision of this page quoted the raw total, and most of it is not user behaviour.
   Splitting by `userAgent`:

   | Class | Rows | What it actually is |
   | --- | ---: | --- |
   | `userAgent = node`, `frameSimilarity = 1.000`, both deltas `0.000` | 49 | A scripted load posting one image as both frames. Identical embeddings, so zero delta by construction. |
   | `userAgent = node`, `challengeInstruction = NULL` | 39 | The challenge id never redeemed — expired, reused or absent. The pose was never measured. |
   | Real browser | **19** | Actual people. |

   Among those 19, **every single one fell short on the demanded axis** — mean 0.09 rad against
   the 0.35 yaw floor, 0.12 against the 0.22 pitch floor, roughly a quarter of the way — and 8 of
   them additionally lost axis dominance (a tilt where a turn was asked for, or the reverse). Not
   one failed for moving far enough in an unacceptable way. Meanwhile attempts that *did* clear
   the gate recorded 0.37–0.74 rad of yaw and 0.21–0.40 of pitch, so **both thresholds are
   comfortably reachable and neither should be lowered.**

   Nobody was refusing to turn their head. The instruction was static text, the frame was grabbed
   at a moment the person could not anticipate, and there was no signal for "further" — so people
   turned a little, guessed, and were told afterwards that they had failed. The requirement never
   changed; it is now visible while you move, and the prompt now names the axis constraint
   ("keep it level") that the dominance rule enforces.

   The browser is told the threshold so the meter cannot promise something the server then
   refuses. That concedes nothing: the requirement was already discoverable by turning your head
   and reading the outcome, and the server re-measures the delta from the submitted frames
   regardless of anything the client claims.
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
- `provenanceSuspect` — the client-reported capture timestamps don't line up with when the
  challenge they answered was actually issued. The client sends `neutralCapturedAt` and
  `gestureCapturedAt` (its own clock, epoch ms) alongside the two frames; the server compares
  them against `challenge.issuedAt` and against each other (`assessProvenance` in
  `face.service.ts`). Flags, with a `provenanceNote` explaining which check tripped:
  - the gesture frame's timestamp is *before* the neutral frame's (frames can't be reordered by a
    live capture),
  - the two frames are implausibly close together (<500ms — faster than the ~3s the real UI
    waits before grabbing the gesture frame),
  - the capture claims to predate its own challenge by more than 2 minutes (well past ordinary
    clock skew) — the single strongest replay indicator available, since it means the footage
    existed before the server even chose what movement to demand, or
  - the client clock disagrees with the server by more than 10 minutes (not proof of anything,
    but it means every other timing signal on this attempt is untrustworthy, and saying so is
    more honest than silently trusting it).

  Client clocks are self-reported and trivially falsifiable, so — like the two signals above —
  this **never blocks** a verification on its own; it only ever adds a flag to the review queue,
  even on an attempt that otherwise passed.

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

## Prerequisite: the page must be served over HTTPS

**Browsers only expose the camera in a secure context.** `localhost` is exempt, which is why this
works on a laptop during setup and then does not work for a single member of staff on a phone
pointed at `http://192.168.1.20`. Nothing is misconfigured when that happens and no application
code can work around it — every browser refuses.

The symptom is explicit: *"Your browser only allows camera access over HTTPS, and this page was
opened on http://…"*. The fix is a certificate, not a setting in this product. See **Serving over
HTTPS** in [DEPLOYMENT.md](DEPLOYMENT.md) for a reverse proxy with automatic certificates, the
`mkcert` route for a LAN with no public domain (including the iOS trust step people miss), and why
the Chrome insecure-origin flag is a trap rather than a workaround.

**Test from a phone on the real address before rolling this out to staff.** It will always work on
your own machine, and that proves nothing about theirs.

### The escape hatch: "Allow skipping on plain-http connections" (off by default)

For a LAN pilot that cannot get certificates yet, Workspace Settings → Face verification carries a
super-admin toggle that lets a person whose browser cannot open the camera proceed **without** the
check. Understand exactly what it trades away before switching it on:

- The claim "my connection is insecure" comes from the client and **cannot be proven server-side**
  — anyone who can script a request can claim it. While the toggle is on, the face gate is
  effectively optional for anyone willing to lie. That is why it defaults off.
- The trade is made **visible, never silent**: every pass-through is stored as a
  `SKIPPED_INSECURE` row in the verification log (amber badge, its own filter) and an audit
  entry, so "which submissions went unchecked, whose, and when" stays answerable. A verified
  badge is never shown for a skipped check.
- The toggle is re-checked when the skip is **spent**, not just when it is minted — switching it
  off closes the hole immediately.

Use it to keep a pilot moving; treat every amber row as a reminder to finish the HTTPS setup, then
switch it off.

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
`CHALLENGE_FAILED`, `LOW_QUALITY`, `NOT_ENROLLED`, `ERROR`. `LOW_QUALITY` (an unjudgeable frame —
too dark, face too small or off-centre) is judged for *before* matching and deliberately excluded
from the failure streak: "we couldn't see you, please retake" is not an accusation, and counting
it toward `maxAttempts` would flag honest people for standing in bad light.

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
- **Auto-triage of honest failures** (opt-in, off by default: the *Auto-resolve honest failures*
  switch on this settings card) — clears a flag on its own only when the evidence says the
  failure was honest: outcome is `NO_FACE` / `MULTIPLE_FACES` / `LOW_QUALITY` / `CHALLENGE_FAILED`
  (never `NO_MATCH` or `SPOOF_SUSPECTED` — those are exactly the outcomes that might be real),
  carries no virtual-camera or provenance suspicion, and the same person **passed within the
  following hour**. Every auto-resolved row is stamped with `autoResolvedReason` so the audit
  trail always shows *why* it closed, distinct from a human's review note. Runs as stage 6 of the
  daily `face-retention` worker (03:15), or on demand via the *Auto-triage now* button
  (`POST /api/face/auto-triage`) for an admin who doesn't want to wait.

#### What "Mark reviewed" does — and what it does not

It clears `flaggedForReview`, records `reviewedById` / `reviewedAt`, and stores the optional note.
That is the whole of it.

It does **not** accept that face, add the capture as a new reference, re-enroll the person, or move
any threshold. **There is no adaptive re-enrollment anywhere in this product.** The only way a
person's stored reference changes is completing the guided enrollment again — which *replaces*
their templates rather than adding to them.

This is worth stating outright because the opposite is a reasonable thing to assume, and assuming
it leads somewhere expensive: reviewing the same person's failures week after week expecting
recognition to improve, when nothing in the review path can move it. If somebody fails repeatedly,
the levers are re-enrollment (ideally multi-pose), the workspace match threshold, and the capture
conditions — not the review queue.

The one thing that *is* adaptive is the per-person match threshold, and it can only ever tighten,
never loosen (see [Calibrating the match threshold](#calibrating-the-match-threshold)). So a person
who has been scraping past the bar can drift toward a stricter one over time — which is a sensible
place to look first when someone who used to pass starts failing.

**Reading the numbers:** the analytics on this settings card keep *pending*, *human-reviewed* and
*auto-triaged* as three separate states and never total them into one "handled" figure. Auto-triage
sets `autoResolvedReason` and deliberately leaves `reviewedAt` null, so the two can never be
confused — a queue drained by auto-triage and a queue drained by people mean very different things
about whether the policy is working.

---

## Policy copilot: a grounded threshold recommendation

Manually reading a histogram to decide "should I move the threshold?" doesn't scale past a
handful of admins, so the settings card has a **Get recommendation** button
(`GET /api/face/policy-recommendation`) that does the same reasoning a careful admin would, on
this workspace's own judged attempts:

1. Take every `PASSED`/`NO_MATCH` attempt with a recorded similarity score (last 2000).
2. Refuse to say anything below 30 judged attempts (or 10 passes) — that's noise, not evidence.
3. Find the **widest gap** between the top of the rejected cluster (95th percentile of `NO_MATCH`
   scores) and the bottom of the genuine-pass cluster (5th percentile of `PASSED` scores).
4. If the clusters **overlap** (gap ≤ 0.01), refuse to recommend a number at all — no threshold
   choice can separate overlapping clusters, so moving it only trades false rejections for false
   accepts. The real fix in that case is re-enrolling the people who fail most, not tuning.
5. Otherwise recommend a value just inside the passing side of the gap, and project what the
   reject rate would become if adopted.

This is **deliberately arithmetic, not an LLM's opinion** — picking a threshold is a statistics
problem, and a model's guess about it would be less reliable, less reproducible, and less
auditable than the calculation. The endpoint is fully useful with AI switched off entirely. When
`GlobalAISettings.facePolicyCopilotEnabled` **is** on, an LLM narrates the same numbers in plain
language (`narrative` in the response) — it explains the finding, it never sets the number, and
it's given the computed values as fixed facts it's explicitly forbidden to alter.

---

## Identity evidence pack

The differentiating artefact this feature exists to produce: not "did a check happen" but
**"what proved it, for this specific piece of billable work."** Attendance-only products (clock
in/out, geofencing) can tell you someone was present; they structurally can't bind an identity
proof to a *work item* and its *approval*, because they were never designed to track work items
at all. Here, an identity check is already bound to the timesheet it verified — the evidence pack
is just that binding, exported.

`GET /api/face/evidence/timesheet/:id` (ADMIN/SUPER_ADMIN) bundles, as a downloadable JSON file:

- the timesheet itself (project, hours, dates, status),
- **every** identity check bound to it — the submitter's and, if approved, the approver's —
  each with its similarity score, the threshold it was judged against (which may be stricter than
  the workspace default for that person — see `effectiveMatchThreshold`), anti-spoof/liveness
  scores, challenge deltas, and every provenance/injection signal recorded,
- the consent record(s) behind those checks (exact wording agreed to, when, model version),
- the workspace's face-verification policy **as it stood at export time** (thresholds, retention,
  challenge on/off) — a policy that's since been retuned shouldn't silently rewrite what an old
  export claims it was judged against.

Deliberately **excludes** the biometric embeddings and server filesystem paths, the same rule
`/face/export` follows: the evidence is the reasoning behind the decision, never the credential
that produced it. This is what settles a client billing dispute ("prove this contractor actually
did the work they're invoicing for") or answers a data-protection challenge — and it's only
possible at all because identity proofs here are bound to work items, not to a clock-in moment.

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

### Accuracy: what actually determines whether checks pass

Three independent things get called "accuracy", and they have different fixes (the full reasoning
is in the Phase-A plan; this is what's implemented):

| Axis | What it is | Where it lives |
|---|---|---|
| **Matching** | Is this the enrolled person? | Multi-template enrollment + per-user threshold, below |
| **Presentation attack** | Real face, or a photo/screen? | Anti-spoof + liveness floors |
| **Injection attack** | Did the frame come from a real camera? | Challenge–response + review signals |

**Multi-POSE enrollment.** A guided wizard walks the person through four head positions — centre,
each side, and a tilt — and stores one good frame from each as a separate template; verification
compares against all of them and keeps the best score.

It used to capture a "burst": the pressed frame plus three more 280ms apart. That is the same pose
four times, because nobody moves meaningfully in under a second, so the stored set described one
angle in one light and a later check from any other angle scored as low as 0.52 against a 0.75
bar. More frames of one pose is not more information. Recognition accuracy is known to fall
roughly 10% from frontal to 60° yaw, so covering the range a person actually sits in front of a
webcam is worth far more than adding frames within a single pose.

The wizard never asks for "left". This model's yaw *sign* convention is not calibrated in this
codebase (see the challenge notes above), so it asks for one side and then the other and enforces
only that the two are opposite. Naming a direction we cannot verify would mean telling half the
users they did it wrong when they did it right. A missed pose is not fatal — three good templates
beat refusing to enrol somebody whose neck does not turn that far. This is the single biggest accuracy lever, because with one
stored template a single unlucky enrollment frame — harsh side light, no glasses that day —
permanently handicaps every future check, and the only apparent remedy is lowering the threshold,
which trades away real security to fix a problem that was never in the threshold. Matching against
more templates only ever helps a genuine user; the bar an impostor must clear is unchanged.
Re-enrolling replaces the whole set.

**The capture quality gate.** Before matching, a frame is scored for *judgeability* — face size,
exposure of the face region, framing — and an unusable one comes back `LOW_QUALITY` with the one
thing to change ("Move a little closer", "Too dark to see you clearly") instead of being scored as
a match failure. This matters more than it sounds: an unusable frame used to return `NO_MATCH`,
which tells an honest person *we don't believe you're you* when the truth is *we couldn't see you*.
`LOW_QUALITY` deliberately does **not** count toward the failure streak, the review flag, or the
lockout narrative — a retake is not a failed identity check.

Two design points found by testing, both worth preserving:
- **The gate is per-dimension floors, not a weighted score.** The dimensions are AND conditions;
  a weighted sum let good exposure and framing outvote a fatal one (a face filling 1.8% of the
  frame scored 0.51 and passed). The score is still computed, but only for ranking and telemetry.
- **Exposure is measured over the FACE BOX, not the frame,** and **framing is never
  disqualifying.** Whole-frame brightness calls a well-lit person in a dark room "too dark"; and
  since the model crops to the face box, an off-centre face produces an equally good embedding, so
  rejecting on position refuses usable captures. Centring is a live client nudge only.

**Per-user match threshold.** After 8+ *live* passes, a user is judged against a threshold derived
from their own passing distribution (3 sd below their mean), **clamped so it can never go below the
workspace setting**, and bounded to at most **0.1 above** whatever the admin chose. The direction
is the whole safety argument: an adaptive threshold allowed to loosen would admit a lookalike
precisely *because* the real user's captures have been inconsistent. Each attempt stores the
`effectiveThreshold` it was judged against, since a stored similarity is uninterpretable
afterwards without it.

> **This mechanism locked a real user out of the product, permanently, and the fix is worth
> understanding before you tune anything.** The bound used to be an absolute cap of 0.95. Their
> history was 30 passes at similarity exactly 1.000 — produced by seeded fixtures and automated
> scripts replaying the enrolled image, not by a camera. A live capture *never* reproduces a
> stored still exactly; genuine repeat captures of the same person land around 0.83. With zero
> variance, `mean − 3sd` was 1.0, so the cap became the effective bar, and real captures scoring
> 0.52–0.82 could not clear it. Because **only passing attempts feed the distribution**, no new
> sample could ever be recorded to bring it back down: a closed loop with no way out from inside
> the product.
>
> Two changes fix it, and both matter. The escalation is now bounded *relative* to the admin's
> setting, so the adaptive control can tighten but never substitute a policy nobody chose. And
> scores at or above 0.995 are discarded before the distribution is computed at all — a threshold
> derived from live captures should be derived from live captures only. The first change alone was
> not enough: it caught a history that was *entirely* synthetic (variance exactly zero) but not the
> realistic mixed one, where a pile of seeded 1.000s plus a couple of genuine 0.79s has healthy
> variance and a mean dragged to ~0.98 — which reads, arithmetically, as an unusually consistent
> user.

**Operational metrics** (Workspace Settings → Face verification, and `GET /face/stats`): retake
rate (target <15%), non-match rate (target <2%, a *proxy* — a genuine impostor rejection lands
there too, so read it as a trend), and client-perceived time-to-verify p50/p95 (targets <1s/<2s).
All are derived from rows already stored.

### How close is this to Windows Hello / Face ID?

The honest comparison, because it changes what you should expect from each layer:

| | Windows Hello / Face ID | This feature |
|---|---|---|
| Sensor | Infrared / structured-light **depth** camera — a photo or screen is flat and fails at the sensor | Ordinary RGB webcam — flatness is inferred by the anti-spoof model instead |
| Matching | On-device, inside a secure enclave / TPM | Server-side, against the org's own encrypted enrollment (deliberate: the *employer* must be able to trust the result, which on-device matching can't give them) |
| Liveness | Hardware depth + IR | Anti-spoof + liveness models, plus the random movement challenge |
| Feel | Zero-click, instant | Zero-click where supported (below); ~1–2s server round-trip |

A browser cannot reach IR emitters, depth streams, or the secure enclave — that's a platform
boundary, not an implementation gap. (WebAuthn/passkeys *can* delegate to Hello/Face ID, but
that proves "someone unlocked this enrolled device," not "this face matches the employee the
server enrolled" — a device credential, not an identity check, so it's a complement rather
than a substitute here.)

What IS reachable is the *experience*, and the app now ships it:

- **The camera comes to you** — the verification dialog requests the webcam the moment it
  opens (the browser's permission prompt still applies, once).
- **Hands-free shutter, in every browser** — the dialog scans the live preview and fires by
  itself once a single, centred, close-enough, *sharp* face holds still for ~1 second: the guide
  oval locks solid and pulses, exactly the phone-unlock cadence.

  This used to rely on `window.FaceDetector`, which only Chromium implements — so on Firefox and
  on **iOS Safari, meaning most phones**, hands-free capture silently never happened and every
  frame was taken manually at a moment of the user's choosing. That is precisely how blurry,
  off-angle frames reached the server and became unexplained rejections. It now runs the same
  detection library the server uses, in the browser, wherever WebGL is available.

  It also measures **blur**, which a bounding box cannot express: a large, centred,
  confidently-detected face can still be motion-blurred, and blur is what turns into a low
  similarity score and a refusal nobody can account for.

  Client detection still only decides *when to press the shutter* and what to say to the person.
  It computes no embedding and decides no outcome — every judgement that matters stays
  server-side, because a client that decides its own verification result is not a security
  control. No WebGL → the manual button, unchanged.

- **Live coaching while the camera is open** — "move a little closer", "hold still, the image is
  blurry", "make sure you're alone in frame" — instead of finding out after a round trip.
- **Auto-retry with a ceiling** — two hands-free attempts, then it falls back to the manual
  button, so a scanner pointed at the wrong face can't hammer the rate limit or flood the
  review log on its own.
- **No cold start** — the server pre-loads the ML models at boot *when the feature is enabled*
  (`warmFaceModelsIfEnabled`), so the first verification after a restart answers in the same
  few hundred milliseconds as every later one. Deployments with the feature off still load
  nothing.

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
# (no-challenge refusal, static-replay refusal, single-use), capture provenance (honest vs.
# pre-challenge timing), virtual-camera flagging, verified badge, approval gate, replay
# rejection, wrong-face rejection, permissions, stats, policy-recommendation, auto-triage,
# the identity evidence pack, export, retention, deletion
npm run verify:face:e2e -w apps/api

# PAD self-test: synthesises a screen-replay and a printed-photo presentation and asserts the
# anti-spoof/liveness stack rejects them while a genuine capture still passes. NOT an ISO
# 30107-3 conformance test — see the script's header for exactly what it can and can't claim.
npm run verify:face:pad -w apps/api
```

Unit tests for the enforcement logic (who's required, entitlement fail-open, single-use/expiry
rules, challenge redemption and pose checks, capture provenance, the policy-copilot
recommendation, and auto-triage eligibility) live in `apps/api/tests/unit/face.service.test.ts`
and run with `npm run test -w apps/api`.

`/api/face` is rate-limited to 60 requests/min per IP (see Operational notes below) — running
`verify:face:e2e` twice back-to-back within the same minute will trip it partway through on an
unrelated call; that's the limiter working as designed, not a test failure, and it clears within
the minute.
