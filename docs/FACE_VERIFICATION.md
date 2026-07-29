# Face (identity) verification

Confirms the person submitting a timesheet or creating a ticket is actually the account holder —
closing the "buddy punching" gap where one employee submits on a colleague's behalf using a
borrowed or shared session.

Off by default. Nothing in this document happens until a SUPER_ADMIN turns it on.

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
capture a still  ──POST /api/face/verify──►  detect face
(no ML in the browser)                       anti-spoof + liveness check
                                             compare to enrolled template
                                             record the attempt (pass or fail)
                 ◄── verificationId ───────  (single-use, expires in ~5 min)

submit timesheet ──POST /api/timesheets/submit──►  consumeVerification()
  + verificationId                                 (must be PASSED, unused,
                                                    fresh, same user+context)
```

**Every decision is made server-side, deliberately.** The browser is a dumb camera: it uploads a
JPEG and nothing else. If the client decided the outcome, any employee could open devtools and
POST `{"verified": true}` — the feature would be theatre. This is why there is no face-matching
JavaScript in the web bundle.

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
| Enable face verification | off | Master switch; everything else is inert while off. |
| Require on timesheet submit | on | Only applies to `SUBMITTED`, never drafts. |
| Require on ticket create | off | |
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

---

## Calibrating the match threshold

The default of **0.75** was measured against these exact models, not guessed:

| Comparison | Typical score |
|---|---|
| Two different people | **0.23 – 0.67** |
| Same person, different capture | **~0.83** |
| Identical image | **1.00** |

0.75 sits in the gap. Every attempt records its own similarity score, so after a week of real use
you can open **Workspace Settings → Face verification → Verification log** and see the actual
distribution for your own workforce, then tune.

- Genuine users failing? **Lower** it (0.70).
- Worried about lookalikes/siblings? **Raise** it (0.80) and expect more retries.

---

## What gets stored, and for how long

| Data | Where | Retention |
|---|---|---|
| Face template (1024-float embedding) | `FaceEnrollment.encryptedEmbedding`, **AES-256-GCM encrypted** | Until the user or an admin deletes it |
| Reference photo | `UPLOAD_DIR/face/<userId>/`, **not** under the public `/uploads` mount | Until deleted |
| Each attempt's outcome + scores | `FaceVerificationAttempt` | Kept (audit trail — contains no biometric data once images are purged) |
| Each attempt's captured image | `UPLOAD_DIR/face/<userId>/` | Auto-deleted after `imageRetentionDays` |

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

## Deleting biometric data

- **Employee:** Profile → Face verification → *Delete my face data*
- **Admin:** `DELETE /api/face/enrollment/:userId`

Both delete the template **and** every stored image from disk, and clear image references on
past attempts. The attempt history (who/when/outcome) survives, since it's the audit record and
holds no biometric data once images are gone.

---

## When a check fails

Blocks the submission, lets the user retry, and after `maxAttempts` consecutive failures flags
the attempt for admin review — it does **not** hard-lock someone out of logging their own work.
Real matching fails on bad lighting, new glasses, or a dirty webcam, so the copy never accuses
the user.

Outcomes recorded: `PASSED`, `NO_FACE`, `MULTIPLE_FACES`, `NO_MATCH`, `SPOOF_SUSPECTED`,
`NOT_ENROLLED`, `ERROR`.

---

## Operational notes

- **HTTPS is required.** `getUserMedia` doesn't exist on insecure origins (except `localhost`).
  Without TLS the camera simply won't start; the UI says so explicitly.
- **Performance:** ~130ms per verification once models are warm (~350ms including the one-time
  model load). Not on any hot path — it runs once per submission.
- **No native dependencies.** Uses Human's `node-wasm` build with pure-JS TensorFlow.js, so
  there's no compile step and the Alpine Docker image builds unchanged.
- **A verification can't be replayed.** Single-use and short-lived; a concurrent double-submit is
  arbitrated by a conditional update, so exactly one wins.
- **Model upgrades force re-enrollment.** Embeddings aren't comparable across model versions, so
  `FaceEnrollment.modelVersion` is checked and the UI prompts rather than silently failing.

---

## Verifying it works

```bash
# ML layer against the real models (embeddings, liveness, encryption round-trip)
npm run verify:face -w apps/api

# Full HTTP flow against a running API: gate blocks, enroll, verify, replay rejection,
# wrong-face rejection, permissions, retention, deletion
npm run verify:face:e2e -w apps/api
```

Unit tests for the enforcement logic (who's required, single-use/expiry rules) live in
`apps/api/tests/unit/face.service.test.ts` and run with `npm run test -w apps/api`.
