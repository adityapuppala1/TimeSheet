# Security & DevOps Integrations

How to connect GitHub, GitLab, Jenkins, Bitbucket, or any internal/self-hosted git+CI setup to
TimeSphere's security-assessment ingestion pipeline — see
[docs/ROADMAP.md § Security assessment suite](ROADMAP.md#3-security-assessment-suite--vapt--dast--sast--ssat--ssct)
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

- `type` — one of `SAST` / `DAST` / `SSAT` (secrets scanning) / `SSCT` (supply-chain). VAPT is
  not sent here — see [§4](#4-vapt-is-different-on-purpose).
- `severity` — `LOW` / `MEDIUM` / `HIGH` / `CRITICAL`.
- `ticketKey` — optional. If present and it matches a real ticket (e.g. `WEB-123`), the finding
  attaches to that ticket's **Security** tab and factors into its risk verdict / PDF report /
  ticket-close digest. Omit it for a repo-wide scan not tied to one ticket yet.
- Every other field is optional except `type`, `tool`, `severity`, `title`.
- Up to 500 findings per request.

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
