# Security Policy

## Reporting a vulnerability

**Please don't open a public issue for a security problem.** Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (Security → Report a vulnerability), which keeps the report private until
there's a fix.

Useful things to include: what an attacker gains, the smallest reproduction you have, and which
deployment shape you tested (single-org on-prem vs. multi-org SaaS — the isolation properties
differ). A proof-of-concept is welcome but not required.

## What this app already does

It has been through an internal VAPT (vulnerability assessment and penetration test) pass — SAST by
full source review, DAST by live scripted HTTP probes, and dependency scanning with `npm audit`. The
report gives each finding's severity, how it was found, the evidence, and its remediation status:
**[VAPT Assessment Report — TimeSphere Portal](https://claude.ai/code/artifact/068d1cbf-1b5a-4e16-ae9c-c3ca2a1647e1)**.

The headline controls:

- **Session handling** — httpOnly/`SameSite=Lax` refresh cookie, rotation with reuse detection
  (a reused secret revokes the session, but the immediately-previous one is accepted for a short
  grace window — `REFRESH_GRACE_PERIOD_MS` in `auth.service.ts` — so two tabs refreshing at once
  isn't mistaken for token theft), per-session and "sign out everywhere" revocation, per-account
  login lockout, JWTs pinned to `HS256` with issuer/audience checks.
- **Multi-tenancy** — each organization's data lives in a **physically separate database**, not a
  shared table filtered by a tenant column. Tokens carry an `org` claim cross-checked against the
  resolved tenant as defense-in-depth, but the separate databases are the actual boundary.
- **Secrets at rest** — AES-256-GCM for IMAP/SMTP passwords, BYOK AI keys, OIDC client secrets,
  tenant DSNs, and face-verification templates. A boot-time entropy/charset check refuses to start in
  production with a weak or placeholder `JWT_*`/`ENCRYPTION_KEY`.
- **Uploads** — extension/MIME allow-lists, `.html`/`.svg`/`.js` blocked outright, avatars
  re-encoded through `sharp` (strips EXIF, breaks polyglot files), and every `/uploads` response
  forced to download (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`) as
  defense-in-depth even for the allowed types.
- **Untrusted content reaching an LLM** — inbound email/chat/CI text is explicitly delimited and
  framed as data-not-instructions, and a model's self-reported confidence is capped before it can
  suppress the human-review gate.

## Two things worth knowing before you deploy

These are deliberate design points, not oversights — but they are exactly the kind of thing worth
understanding up front rather than discovering later.

1. **`/uploads` is served with no authentication.** Anyone who knows or guesses a filename can
   fetch an avatar or attachment, across tenants. That's an accepted trade for ordinary
   attachments. It is why face-verification imagery is deliberately *not* stored there — it's
   served only through an authenticated API route that checks session, tenant, and
   subject-or-admin.
2. **Face verification stores biometric data.** It's off by default. If you enable it, you take on
   real regulatory obligations (GDPR Art.9, Illinois BIPA, Texas CUBI, India's DPDP Act). The
   feature provides the mechanics to comply — consent-gated enrollment with the wording stored
   verbatim, encrypted templates, a configurable and enforced retention/purge schedule, and
   self-service deletion — but **it does not make you compliant on its own**. Read
   [docs/FACE_VERIFICATION.md](../docs/FACE_VERIFICATION.md) before switching it on for real
   staff.

## Dependencies

"Clean" decays on its own: advisories get published against already-pinned versions without a
single line of code changing. So the check runs on every CI push rather than only at release —
`scripts/audit-gate.mjs` fails the build on any high or critical advisory in a production
dependency unless it has been reviewed and accepted with its reasoning written down, and an
accepted entry that no longer matches anything fails the gate too, so an exception can't outlive
its problem. Dev-only advisories aren't gated; `node scripts/audit-gate.mjs --dev` sweeps them
locally.

For the state of individual advisories — where each comes from, whether untrusted input can reach
it, and what was done — see the latest triage in
[docs/ROADMAP.md § Dependency advisories, triaged 2026-09-17](../docs/ROADMAP.md#dependency-advisories-triaged-2026-09-17).
