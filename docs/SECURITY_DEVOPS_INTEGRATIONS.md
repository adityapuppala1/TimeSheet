# Security & DevOps Integrations

How to connect GitHub, GitLab, Jenkins, Bitbucket, or any internal/self-hosted git+CI setup to
TimeSphere's security-assessment ingestion pipeline — see
[docs/ROADMAP.md § Security assessment suite](ROADMAP.md)
for the product rationale (ingest-only, tool-agnostic, why VAPT is handled differently).

## How it works, in one sentence

Your CI pipeline runs whatever scanner/test runner it already runs, converts that tool's native
output into a small JSON array TimeSphere understands, and `curl`s it to a webhook URL —
TimeSphere never reaches into your repo, your CI system, or your infrastructure to do this
itself.

## 1. Enable ingestion and get your token

1. Log in as a `SUPER_ADMIN` → **Workspace Settings → Security & DevOps**.
2. Click **Generate token**. Copy it immediately — it's shown exactly once (the same
   write-once convention as every other secret in this app).
3. Copy the two webhook URLs shown (findings + test-runs). They look like:
   ```
   https://<your-timesphere-host>/api/devops/<org-slug>/findings
   https://<your-timesphere-host>/api/devops/<org-slug>/test-runs
   ```
4. Store the token as a CI secret (`TIMESPHERE_INGEST_TOKEN` — never commit it to a repo file).

## 2. The payload shape

**Findings** — `POST /api/devops/<org-slug>/findings`, header `Authorization: Bearer <token>`:

```json
{
  "findings": [
    {
      "type": "SAST",
      "tool": "semgrep",
      "severity": "CRITICAL",
      "title": "SQL injection in login handler",
      "description": "User input reaches a raw query without parameterization.",
      "cwe": "CWE-89",
      "filePath": "src/auth.ts",
      "lineNumber": 42,
      "repository": "acme/backend",
      "branch": "feature/login-rework",
      "prUrl": "https://github.com/acme/backend/pull/128",
      "ticketKey": "WEB-123"
    }
  ]
}
```

- `type` — one of `SAST` / `DAST` / `SSAT` (secrets scanning) / `SSCT` (supply-chain) /
  `QUALITY` (bugs and code smells) / `LINT`. VAPT is not sent here — see
  [§4](#4-vapt-is-different-on-purpose). `QUALITY` and `LINT` are the **code-quality discipline**:
  they are stored, deduplicated, routed and verified exactly like a security finding, and they are
  excluded from every security figure — the risk score, the by-severity chart, the weekly security
  digest and a ticket's risk verdict. See [§5b](#5b-code-quality-sonarqube-and-eslint).
- `severity` — `LOW` / `MEDIUM` / `HIGH` / `CRITICAL`.
- `ticketKey` — optional. If present and it matches a real ticket (e.g. `WEB-123`), the finding
  attaches to that ticket's **Security** tab and factors into its risk verdict / PDF report /
  ticket-close digest. Omit it for a repo-wide scan not tied to one ticket yet.
- `ruleId` — optional, the scanner's own name for the rule that fired. Not stored; it is used only
  to identify the finding (see "Repeat scans" below) for tools that report no CWE. The SARIF route
  fills it in automatically.
- `commitSha` — optional, alongside `findings` rather than inside one, because it describes the
  scan rather than any single result. Recorded on the scan run.
- Every other field is optional except `type`, `tool`, `severity`, `title`.
- Up to 500 findings per request.

### Repeat scans do not create duplicates

A nightly scan reporting the same 200 issues used to insert 200 new rows every night, which
inflated the risk score, the insights trend and the weekly digest, and opened a fresh ticket for
the same line of code every morning.

Each finding now gets a fingerprint derived from its **tool**, its **rule identity** (the `cwe`, or
`ruleId` when there is no CWE), its **file path**, and a **window of ~50 lines** around
`lineNumber` — a window rather than the exact line so that editing the code above a vulnerability
does not make it look like a new one. A finding matching one already recorded on the same
repository and branch updates that row's "last seen" time and occurrence count instead of adding a
second one. It does **not** change the finding's status, and it does **not** re-open or re-ticket
anything.

Two consequences worth knowing when wiring up a pipeline:

- **Send `filePath` and either `cwe` or `ruleId`.** A finding with no file path or no rule identity
  cannot be fingerprinted and is ingested every time, exactly as before — nothing is dropped, but
  nothing is deduplicated either.
- **Send a stable `filePath`.** Repository-relative paths (what every example in this document
  produces) deduplicate cleanly. Absolute CI paths like `/home/runner/work/repo/repo/src/a.ts`
  work, but only for as long as your runner's directory layout does.

The response reports both halves:

```json
{ "ingested": 200, "created": 3, "updated": 197 }
```

`created` is the number that did not exist before — on a healthy repository it trends to zero, and
that is the point.

**Test runs** — `POST /api/devops/<org-slug>/test-runs`, same auth header:

```json
{
  "provider": "github-actions",
  "status": "FAILED",
  "passCount": 118,
  "failCount": 2,
  "durationMs": 94210,
  "logUrl": "https://github.com/acme/backend/actions/runs/123456",
  "branch": "feature/login-rework",
  "ticketKey": "WEB-123"
}
```

`status` is `PASSED` / `FAILED` / `RUNNING`. A ticket can't move to `RESOLVED` while its latest
linked test run is `FAILED` (configurable — see the roadmap doc's theme #2).

**A `FAILED` run with no `ticketKey` at all** can auto-create one, instead of the failure just
sitting in the log with nothing tracking it — opt-in via
`IngestionSettings.autoCreateTicketOnCiFailureEnabled` (Workspace Settings → Security & DevOps),
off by default, and requires a fallback project to be configured the same way findings-sourced
tickets do. Guarded against flaky-test spam: a repeat failure on the same `provider`+`branch`
within 24h gets a comment on the ticket that was already created instead of a duplicate, and (with
AI CI-failure triage on and a `failureText` excerpt supplied) a failure already flagged as likely
flaky skips ticket creation entirely on its first sighting.

## 3. Per-CI-system examples

Each example assumes your scanner already ran and wrote its native output to a file
(`semgrep.json`, `gitleaks.json`, etc.) — the `jq` line is the "translate to our shape" step.
Adjust the `jq` filter to your tool's actual field names; these are illustrative, not exact for
every scanner version.

### GitHub Actions

```yaml
# .github/workflows/security-scan.yml
name: Security scan
on: [pull_request]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Semgrep
        run: semgrep --config auto --json --output semgrep.json .
      - name: Report findings to TimeSphere
        env:
          TOKEN: ${{ secrets.TIMESPHERE_INGEST_TOKEN }}
        run: |
          jq '{findings: [.results[] | {
            type: "SAST", tool: "semgrep", severity: (.extra.severity // "MEDIUM"),
            title: .check_id, description: .extra.message,
            filePath: .path, lineNumber: .start.line,
            repository: "${{ github.repository }}", branch: "${{ github.head_ref }}",
            prUrl: "${{ github.event.pull_request.html_url }}"
          }]}' semgrep.json > payload.json
          curl -sf -X POST "https://your-timesphere-host/api/devops/acme/findings" \
            -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
            --data @payload.json
      - name: Report test results
        if: always()
        env:
          TOKEN: ${{ secrets.TIMESPHERE_INGEST_TOKEN }}
        run: |
          curl -sf -X POST "https://your-timesphere-host/api/devops/acme/test-runs" \
            -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
            -d "{\"provider\":\"github-actions\",\"status\":\"${{ job.status == 'success' && 'PASSED' || 'FAILED' }}\",\"branch\":\"${{ github.head_ref }}\",\"logUrl\":\"${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}\"}"
```

**This isn't just an illustration** — this repo's own `.github/workflows/ci.yml` runs the real
thing (`security-scan-dogfood` job): CodeQL and Semgrep via SARIF, `npm audit` via a small mapper
(`scripts/ci/npm-audit-to-findings.mjs`), and a CycloneDX SBOM, all posted through these exact
endpoints. It's off by default (gated on `TIMESPHERE_INGEST_TOKEN` being set) so it never runs on
a fork or before an admin opts in — read it directly for a working, maintained reference.

### GitLab CI

```yaml
# .gitlab-ci.yml
security-scan:
  stage: test
  script:
    - semgrep --config auto --json --output semgrep.json .
    - >
      jq '{findings: [.results[] | {
        type: "SAST", tool: "semgrep", severity: (.extra.severity // "MEDIUM"),
        title: .check_id, filePath: .path, lineNumber: .start.line,
        repository: "'"$CI_PROJECT_PATH"'", branch: "'"$CI_COMMIT_REF_NAME"'",
        prUrl: "'"$CI_MERGE_REQUEST_PROJECT_URL"'/-/merge_requests/'"$CI_MERGE_REQUEST_IID"'"
      }]}' semgrep.json > payload.json
    - >
      curl -sf -X POST "https://your-timesphere-host/api/devops/acme/findings"
      -H "Authorization: Bearer $TIMESPHERE_INGEST_TOKEN" -H "Content-Type: application/json"
      --data @payload.json
  variables:
    TIMESPHERE_INGEST_TOKEN: $TIMESPHERE_INGEST_TOKEN # set as a masked CI/CD variable
```

### Jenkins (declarative pipeline)

```groovy
pipeline {
  agent any
  stages {
    stage('Security scan') {
      steps {
        sh 'semgrep --config auto --json --output semgrep.json .'
        withCredentials([string(credentialsId: 'timesphere-ingest-token', variable: 'TOKEN')]) {
          sh '''
            jq '{findings: [.results[] | {
              type: "SAST", tool: "semgrep", severity: (.extra.severity // "MEDIUM"),
              title: .check_id, filePath: .path, lineNumber: .start.line,
              repository: "'"$JOB_NAME"'", branch: "'"$GIT_BRANCH"'"
            }]}' semgrep.json > payload.json
            curl -sf -X POST "https://your-timesphere-host/api/devops/acme/findings" \
              -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
              --data @payload.json
          '''
        }
      }
    }
  }
}
```

### Bitbucket Pipelines

```yaml
# bitbucket-pipelines.yml
pipelines:
  pull-requests:
    '**':
      - step:
          name: Security scan
          script:
            - semgrep --config auto --json --output semgrep.json .
            - >
              jq '{findings: [.results[] | {type:"SAST", tool:"semgrep", severity:(.extra.severity // "MEDIUM"), title:.check_id, filePath:.path, lineNumber:.start.line, repository:"'"$BITBUCKET_REPO_SLUG"'", branch:"'"$BITBUCKET_BRANCH"'"}]}' semgrep.json > payload.json
            - curl -sf -X POST "https://your-timesphere-host/api/devops/acme/findings" -H "Authorization:Bearer $TIMESPHERE_INGEST_TOKEN" -H "Content-Type:application/json" --data @payload.json
```

### Any internal/self-hosted git server (Gitea, self-hosted GitLab, Gerrit, a bare `git push`
### hook, a cron job on a build server, ...)

There's no special integration needed — the webhook doesn't care where your git server is
hosted or whether it's reachable from the public internet at all, since **your CI runner**
(wherever it runs) is the one making the outbound `curl` call, not TimeSphere reaching in. Any
system that can run a shell script after a build/scan step works:

```bash
#!/usr/bin/env bash
# run-security-scan.sh — plug into a post-receive hook, a cron job, or any custom CI runner.
set -euo pipefail
TOKEN="$TIMESPHERE_INGEST_TOKEN"
HOST="https://your-timesphere-host"
ORG_SLUG="acme"

semgrep --config auto --json --output /tmp/semgrep.json .
gitleaks detect --source . --report-format json --report-path /tmp/gitleaks.json || true

jq -n --slurpfile sast /tmp/semgrep.json --slurpfile secrets /tmp/gitleaks.json '{
  findings: (
    [$sast[0].results[] | {type:"SAST", tool:"semgrep", severity:(.extra.severity // "MEDIUM"), title:.check_id, filePath:.path, lineNumber:.start.line}] +
    [$secrets[0][]? | {type:"SSAT", tool:"gitleaks", severity:"HIGH", title:.Description, filePath:.File, lineNumber:.StartLine}]
  )
}' > /tmp/payload.json

curl -sf -X POST "$HOST/api/devops/$ORG_SLUG/findings" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @/tmp/payload.json
```

## 4. VAPT is different, on purpose

VAPT (Vulnerability Assessment & Penetration Testing) is a periodic, human-led assessment — not
something a CI job produces on every push. It isn't ingested through this webhook. Phase 2 of
this feature (tracked in `docs/ROADMAP.md`) adds a structured report upload for VAPT that parses
into the same `SecurityFinding` table; until then, track VAPT findings the same way this app's
own VAPT report is published (see [README § Security](../README.md#security)) — as a standalone
report, optionally logged as manual tickets for anything actionable.

## 5. Supported scanner categories (bring your own tool)

TimeSphere doesn't bundle or endorse a specific scanner — any tool whose output you can
translate into the payload shape above works. Common choices per category:

| Type | Example tools |
|---|---|
| SAST | Semgrep, CodeQL, SonarQube, Bandit (Python), ESLint security plugins |
| DAST | OWASP ZAP, Burp Suite (CI-integrated), Nuclei |
| SSAT (secrets) | Gitleaks, TruffleHog, detect-secrets |
| SSCT (supply chain) | Syft + Grype, Socket, `npm audit --json`, Dependabot's alert API, Trivy |
| QUALITY / LINT | SonarQube, ESLint, and anything else reporting maintainability rather than exposure |

## 5b. Code quality: SonarQube and ESLint

Both are accepted **verbatim** — no `jq`, no translation step. A translation step written by hand
is a translation step that rots the first time either tool changes a field.

### SonarQube issues — `POST /api/devops/<org-slug>/findings/sonar`

POST the response of Sonar's own `/api/issues/search` API, unmodified:

```bash
curl -sS "$SONAR_URL/api/issues/search?componentKeys=$SONAR_PROJECT&resolved=false&ps=500" \
     -u "$SONAR_TOKEN:" \
  | curl -sS -X POST "$TIMESPHERE/api/devops/acme/findings/sonar?repository=acme/backend&branch=$CI_BRANCH&commitSha=$CI_COMMIT" \
         -H "Authorization: Bearer $TIMESPHERE_TOKEN" -H 'Content-Type: application/json' -d @-
```

**Sonar's own taxonomy decides the discipline**, so nothing has to be configured:

| Sonar `type` | Becomes | Counts towards security? |
|---|---|---|
| `VULNERABILITY` | `SAST` | **Yes** — it is static analysis finding a vulnerability |
| `BUG` | `QUALITY` | No |
| `CODE_SMELL` | `QUALITY` | No |

Severity maps `BLOCKER`/`CRITICAL` → `CRITICAL`, `MAJOR` → `HIGH`, `MINOR` → `MEDIUM`,
`INFO` → `LOW`. The `component` field (`projectKey:path/to/file`) is split on the **last** colon,
because a Maven-style project key contains colons of its own. The identity used for deduplication
is Sonar's `rule`, never its `key` (which changes when Sonar re-keys an issue) and never the
message (which interpolates the offending symbol).

### ESLint — `POST /api/devops/<org-slug>/findings/eslint`

POST `eslint --format json` output as-is. It is a bare JSON array, and that is accepted directly:

```bash
npx eslint . --format json > eslint.json || true
curl -sS -X POST "$TIMESPHERE/api/devops/acme/findings/eslint?repository=acme/backend&branch=$CI_BRANCH&rootPath=$PWD" \
     -H "Authorization: Bearer $TIMESPHERE_TOKEN" -H 'Content-Type: application/json' -d @eslint.json
```

- ESLint severity `2` (error) → `MEDIUM`, `1` (warn) → `LOW`. Deliberately below `HIGH`: that is
  the bar that auto-creates tickets and spends AI triage budget, and one lint run on a legacy
  repository would do both a thousand times.
- **Send `rootPath`.** ESLint reports absolute paths from whichever machine ran it. Without the
  workspace directory to strip, two runners report the same file under two paths, which means two
  fingerprints, which means no deduplication and a verification ladder that waits forever for a
  scan that already arrived under another name.
- To attach repository/branch/ticket context in the body instead of the query string, send
  `{ "results": [...], "repository": "...", "branch": "...", "rootPath": "...", "ticketKey": "..." }`.

### SonarQube quality gate — `POST /api/devops/<org-slug>/quality-gate`

This one is not a `curl` step; it is Sonar's own webhook. In SonarQube go to
**Administration → Configuration → Webhooks**, add the URL, and set
`Authorization: Bearer <token>` as a header. Sonar's payload is stored exactly as it arrives —
project, branch, `revision`, the gate verdict and every condition behind it.

A quality gate is deliberately **not** stored as a scan run: a scan run is a container for
findings, and an empty one is evidence that everything previously reported has been fixed. A gate
reports no findings at all, so recording it as an empty run would silently mark that branch's whole
backlog verified-fixed.

Turn on **Workspace Settings → Ticketing → Block resolve on failing quality gate** to make a failing
gate stop a ticket moving to Resolved — the sibling of the failing-tests gate, off by default.
A gate is matched to a ticket by the **branch names linked on the ticket** (Ticket → Dev), and
only the most recent gate on that branch counts. A ticket with no linked branch is never blocked,
and neither is one whose latest Sonar *analysis* failed — a crashed analysis is not a failed gate.

## 5c. Verified remediation — a resolved ticket is a claim, not a conclusion

Off by default: **Workspace Settings → Security & DevOps → Verified remediation → "Require a scan to
confirm a fix"**.

With it on, resolving or closing a ticket that carries findings does not mark those findings fixed.
It moves them to `PENDING_VERIFICATION` with `verificationState = AWAITING_PROOF`, and they keep
counting as unresolved — in the risk score, on the charts, in the digest — until a scan settles it.
The person closing the ticket is asserting something about the world; a scanner is the only thing
here that can check it.

`verificationState` is a **separate column from `status`**, deliberately. Status records a decision a
person made. `verificationState` records what a scanner observed. Collapsing them means either a
machine overwriting a human's decision or a human's decision hiding a machine's observation, and
neither reads correctly a month later.

### What counts as proof: the same-tool rule

A scan run settles an awaiting-proof finding only when it matches on **all four** of:

| | Why it is in the predicate |
|---|---|
| the same **tool** (compared case-insensitively, trimmed) | A different scanner not reporting a finding proves nothing — it may simply not look for that class of bug. Silence from a tool that was never asked the question is not evidence. |
| the same **repository** | Obvious, and still worth stating: the same rule firing in a different repo is a different fact. |
| the same **branch** | A fix proven on `main` says nothing about the release branch it has not been merged into. |
| the same finding **type** | A SAST run has no opinion on whether a `LINT` finding is gone. There is a test named for exactly this: *does not let one tool's SAST run speak for its own QUALITY findings*. |

Then, for each qualifying finding:

- **Fingerprint absent from the run → proven fixed.** `status: FIXED`,
  `verificationState: VERIFIED_FIXED`, and the run and `commitSha` that proved it are stamped onto
  the row. This is why a **zero-finding scan is still recorded as a `ScanRun`** — an empty run is the
  single most valuable row in that table, because it is the one that proves an absence.
- **Fingerprint still present → the fix did not hold.** `status` returns to `OPEN`,
  `verificationState: REFUTED_BY_SCAN`, and — if auto-reopen is on — the ticket reopens, its SLA due
  date is recomputed, and a system comment records which scan, which commit and which findings
  survived.
- **No qualifying scan inside the grace window → unverified.** The nightly sweep
  (`verification-sweep.worker.ts`, `50 4 * * *`) sets `verificationState: UNVERIFIED`, leaves
  `status` alone so it still counts as unresolved, and nudges the assignee in their bell. **It never
  reopens anything.** Absence of proof is not proof of failure: a repository whose scan job broke
  last Tuesday should produce a question, not a wave of reopened tickets attributed to engineers who
  did nothing wrong. The window is `IngestionSettings.verificationWindowDays` — 7, 14, 30 or 60,
  default 14.

### The ladder: verification without auto-reopen

The two toggles are independent, and *verification on, auto-reopen off* is a **supported
configuration, not a half-installed feature** — the schema says so, and there is a test named for it.
You are told the fix did not hold, the finding is marked, the digest is sent, and the ticket stays
exactly where its owner left it. "Tell me, don't move my tickets" is a real answer for a team whose
board is a commitment rather than a queue.

### The reopen digest

`ticket.reopened_digest` — on by default, and it can only fire when verification is on. It goes to:

- **whoever closed the ticket**, recovered from the audit log's `ticket.status_changed` rows, because
  nothing else in the schema records who made that call;
- the **current assignee**, who may not be the same person;
- **everyone who logged time against the ticket** — the entry nobody would think to add, and the one
  that matters, because they are the people who know what the fix was supposed to do;
- cc: the **closer's manager** and the **routed module's owner**.

Everyone is filtered to active, non-deleted accounts. The message names which scan, which commit,
which findings survived and how long they have been open. Mute it under **Workspace Settings → Email
channels → "A fix did not hold"**; the in-app bell still fires, and muting the mail does not switch
off the verification.

## 5d. Routing a finding to a project, module and submodule

A finding names a **file**, not a module. Until 5.0.0 auto-created security tickets papered over that
by reusing email intake's routing badly: they looked for the first module on the fallback project
that happened to have a `ModuleAssigneeRule` and used that. A vulnerability in the billing code was
assigned to whoever owned whichever module was created first. **That fallback is removed** — see the
5.0.0 upgrade note.

Two ordered rule tables, configured in **Workspace Settings → Security & DevOps**:

- **Route findings by repository** — a repository pattern to a project. The ticket then takes *that*
  project's own key prefix. No match falls back to the ingestion card's fallback project.
- **Route findings by file path** — a path glob to a module and optional submodule, considered only
  within the project the repository step resolved, so `src/api/**` can mean different things in two
  products.

Both are evaluated by `order` then `createdAt`, and the **first match wins** — the same semantics
`TicketRule` already uses. Assignment then runs in one order: the routed module's own
`ModuleAssigneeRule` (Workspace Settings → Email intake → Module auto-assignment), then
CODEOWNERS / last committer where that is enabled, then unassigned. Unassigned is deliberate: a
ticket sitting in the queue of somebody with no idea why is worse than one in a triage list, because
the first looks handled.

**Pattern dialect**: `*` matches within one path segment, `**` matches across segments, a trailing
`/` means that directory and everything below it, and a pattern with no wildcard is a plain prefix.
Maximum 500 characters and 20 wildcards; case-sensitive; an unusable pattern is refused with a 422
when you save it rather than becoming a rule that silently never matches.

**The matcher never compiles to a RegExp.** A glob translated into a regex is a user-supplied pattern
handed to a backtracking engine, and every mitigation for that is a guess about input. It is
simulated instead as an automaton over a boolean array of reachable positions — one linear pass per
token, work bounded by pattern length × subject length, and nothing that can backtrack.

Use **"Test a path"** below the two rule lists before a scanner exercises them: type a repository and
a file path, and it runs the same resolver ingestion does — showing the project, module and submodule
it would pick and which rule decided it. It writes nothing.

## 6. Error-tracking (Sentry / Rollbar / raw) — auto-reopen by crash fingerprint

`POST /api/devops/<org-slug>/error-events`, same bearer token:

```json
{
  "source": "SENTRY",
  "fingerprint": "a1b2c3d4-issue-grouping-hash",
  "message": "TypeError: Cannot read properties of undefined (reading 'id')",
  "stackTrace": "at handleLogin (src/auth.ts:42:18)\n...",
  "level": "error",
  "ticketKey": "WEB-123"
}
```

- `fingerprint` is Sentry's issue-grouping hash, Rollbar's item `fingerprint`, or (for a raw/
  manual post) any stable string you consider "the same failure" — a hash of the top stack frame
  works well.
- `ticketKey` is optional. If you omit it and a RESOLVED/CLOSED ticket was previously linked to
  the *same* `fingerprint` (from an earlier event that did carry a `ticketKey`, or from this
  ticket being created from a findings/test-run event), the ticket **auto-reopens** — "the same
  crash came back" is detected without anyone re-linking it by hand. Requires
  `IngestionSettings.autoReopenEnabled` (Workspace Settings → Security & DevOps), same toggle
  every other regression trigger in this app uses.
- `stackTrace`, if supplied, gets the same AI root-cause/severity triage comment CI test-run
  failures get (`GlobalAISettings.ciFailureTriageEnabled`) — one classifier reused for both, since
  "summarize this failure text" is the same task either way.

## 7. Troubleshooting

- **401 Invalid ingestion token** — the token was rotated since your CI secret was set, or it
  was never generated. Re-check Workspace Settings → Security & DevOps.
- **404 Security/CI ingestion isn't enabled for this workspace** — no token has ever been
  generated for this org; generate one first.
- **Findings arrive but don't show on a ticket** — `ticketKey` didn't match a real, non-deleted
  ticket in this org (case-sensitive, must be the full key like `WEB-123`, not just the number).
  Findings without a match are still stored — check the raw ingestion response for `created`
  count vs. what you expected.
- **429 Too Many Requests** — the ingestion endpoint is rate-limited (120 req/min per IP,
  shared across all your CI runners hitting from the same egress IP) — batch findings into
  fewer, larger requests rather than one request per finding.

## 8. Git webhooks — branch/PR auto-sync from any of six providers

Separate from findings ingestion above: pushing a branch named with a ticket key (e.g.
`WEB-123-fix-login`) or opening/merging a PR on it auto-syncs the ticket's **Dev tab**. GitHub
was first; the same receiver now speaks five more dialects, all verified against the **one**
workspace webhook secret (Workspace Settings → Security & DevOps → generate/rotate):

| Provider | Webhook URL (shown in Workspace Settings) | Where the secret goes |
|---|---|---|
| GitHub | `/api/git/webhook/<org>` | Webhook "Secret" (HMAC `X-Hub-Signature-256`) |
| GitLab | `/api/git/webhook/<org>/gitlab` | "Secret token" (sent as `X-Gitlab-Token`) |
| Bitbucket Cloud | `/api/git/webhook/<org>/bitbucket` | Webhook "Secret" (HMAC `X-Hub-Signature`) |
| Gitea | `/api/git/webhook/<org>/gitea` | Webhook "Secret" (HMAC) |
| Forgejo | `/api/git/webhook/<org>/forgejo` | Webhook "Secret" (HMAC) |
| Azure DevOps | `/api/git/webhook/<org>/azure-devops` | Service-hook **basic-auth password**, or append `?token=<secret>` |

Subscribe each repo to **push** and **pull/merge request** events, content type JSON. A branch
with no ticket-key-shaped token is acknowledged and ignored (200) — providers disable webhooks
that keep erroring, so "not ours" is never an error.

Honesty notes: Azure DevOps service hooks sign nothing, so its verification is
secret-in-transit rather than proof-of-possession — serve the app over https and treat the
secret as rotatable. The AI PR-review summary remains GitHub-only (it needs the provider's API
to read the diff; only the GitHub OAuth connection holds a token). **AWS CodeCommit** is not
supported: AWS closed it to new customers in July 2024 and is steering existing ones off it.
**SourceForge** exposes no usable webhook for this purpose. For both, the Dev tab's manual
branch/PR links work exactly as before — as they do for any provider you simply don't wire up.
