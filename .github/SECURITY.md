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

Documented in full in [README § Security](../README.md#security), which links the VAPT report.
Briefly:

- **Session handling** — httpOnly/`SameSite=Lax` refresh cookie, rotation with reuse detection,
  per-session and "sign out everywhere" revocation, per-account login lockout, JWTs pinned to
  `HS256` with issuer/audience checks.
- **Multi-tenancy** — each organization's data lives in a **physically separate database**, not a
  shared table filtered by a tenant column. Tokens carry an `org` claim cross-checked against the
  resolved tenant as defense-in-depth, but the separate databases are the actual boundary.
- **Secrets at rest** — AES-256-GCM for IMAP/SMTP passwords, BYOK AI keys, OIDC client secrets,
  tenant DSNs, and face-verification templates. A boot-time entropy check refuses to start in
  production with a weak or placeholder `JWT_*`/`ENCRYPTION_KEY`.
- **Uploads** — extension/MIME allow-lists, `.html`/`.svg`/`.js` blocked outright, avatars
  re-encoded through `sharp` (strips EXIF, breaks polyglot files), and everything under
  `/uploads` forced to download with `X-Content-Type-Options: nosniff`.
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
   verbatim, encrypted templates, an enforced retention/purge schedule, and self-service deletion
   — but **it does not make you compliant on its own**. Read
   [docs/FACE_VERIFICATION.md](../docs/FACE_VERIFICATION.md) before switching it on for real
   staff.

## Dependencies

`npm audit` is expected to be clean. It's checked periodically rather than only at release,
because advisories get published against already-pinned versions — "clean" decays on its own
without a single line of code changing.
