# Self-serve signup and company domains — plan

> **Audience:** the product owner and engineers building signup · **Type:** plan + design record ·
> [Documentation index](README.md)

**Status (2026-10-01):** Phase 0 is **built** on branch `V13-signup-domains` (not merged). Phase 1
is **specified and approved** — the product owner answered §8's questions the same day (recorded in
§2) — and its build plan is [SIGNUP_PHASE1_BUILD_PLAN.md](SIGNUP_PHASE1_BUILD_PLAN.md). Phases 2 and 3
are outlines.

## 1. The problem

Measured against the code on 2026-10-01 (`signup.controller.ts`, `workspace-directory.service.ts`,
`free-mail-domains.ts`, `sso.service.ts`):

| Question | What the product did |
|---|---|
| Only work email addresses? | Mostly. A fixed list of 20 personal-mail domains was refused. `rediffmail.com`, `yahoo.co.in`, `ymail.com` and every throwaway-inbox service got through. |
| A new database per signup? | Yes. Every completed signup created an organization, a physical MySQL database, a first super admin, and a 15-day Team trial. |
| Two people from the same company? | Nothing connected them. The second got a second workspace, a second database and a second free trial — only the web address had to differ (`acme-2`). Colleagues ended up split, and one company could collect trial after trial. |
| Could an operator turn signup off? | No. `/api/signup` was mounted on every deployment, and `.env.example` ships `TENANT_DB_PROVISION_BASE_URL` set, so a manual install from the template accepted signups. |
| Single-org install? | Signup built a workspace nobody could reach: with `ROOT_DOMAIN` unset, the link handed back pointed at the *default* workspace, where the new account does not exist. |
| Did operators hear about signups? | No email, no audit row. A self-serve workspace appeared only as one more row in the Organizations list; a failed one was deleted and appeared nowhere. |
| Were the codes reliable? | Not past one API process: they lived in memory, so behind a load balancer a correct code was refused at random. |

## 2. Decisions taken with the product owner (2026-10-01)

1. **One workspace per company domain.** A second signup from a domain that already has a workspace
   becomes a **request to join** that workspace — never a new database.
2. **Auto-join waits.** "Anyone with @acme.com may join" is a Phase 2 feature: admin opt-in, off by
   default, and only for a domain the company has proven it owns by DNS.
3. **Approved joiners start as Employee.** The approving admin may choose a higher role.
4. **Platform admins are told about every signup**, and see signup status and analytics in the
   console.
5. Separately decided the same day: a super admin may approve a change request they raised
   themselves (`change.service.ts#canDecideChange`); nobody else can.
6. **Operators get a daily summary**, not an email per signup. Per-signup emails and "off" stay
   available as console options; a day with nothing to report sends nothing.
7. **Join requests expire after 14 days** — a business setting, so it is editable in the console
   (default 14), not a constant.
8. **Only an ACTIVE workspace accepts join requests.** A workspace in its payment grace period or
   suspended has a database already, so no new workspace is created for its domain either — the
   person is told the workspace is not available and to contact its administrator. Requests resume
   when a platform admin reactivates the workspace or it pays.
9. **A sub-domain address belongs to its company's domain**: `eng.acme.com` is `acme.com`. Rolled up
   to the registrable domain with the Public Suffix List (`acme.co.uk` stays `acme.co.uk`, never
   `co.uk`) — with one exception, below.

## 3. What the industry does, and the one distinction it rests on

Slack, Notion, Atlassian, Figma and Microsoft 365 all steer colleagues to the existing workspace
rather than letting duplicates pile up, and all of them separate two kinds of proof:

- **An emailed code** proves *one person* has a mailbox at acme.com. Enough to **ask to join**.
- **A DNS record** proves *the company* controls acme.com. Required before a workspace may **own**
  the domain exclusively, admit people automatically, or override another workspace's claim.

If ownership came from the emailed code alone, the first person from a company to sign up — a
contractor, a leaver whose mailbox still works, an unofficial project — would own the company's
domain, and colleagues would be steered into their workspace. Microsoft's answer to exactly this is
"admin takeover": a real IT administrator proves DNS ownership and takes the domain back. Phase 1
uses an **unverified** claim to stop duplicates; Phase 2 adds the **verified** one.

## 4. Phase 0 — built (branch `V13-signup-domains`)

| Change | Where | Verified by |
|---|---|---|
| A console switch for self-serve signup, **off by default**; signup is also refused whenever `ROOT_DOMAIN` is unset; the policy **fails closed** | `PlatformSignupSettings` (control plane), `services/platform-signup.service.ts`, Platform admin → Settings → Signup | `tests/unit/platform-signup.test.ts` |
| `GET /api/signup/status`, mounted before signup's 5-an-hour limiter; the landing page, signup, contact and reactivate pages show a "closed" state instead of a form that fails | `app.ts`, `hooks/use-signup-status.ts` | typecheck, unit tests |
| Personal-mail list 20 → 97 domains (India included) plus 22 throwaway services; operators add more in the console without a release; the **proven** address is re-checked on step two | `utils/free-mail-domains.ts` | `platform-signup.test.ts` |
| Verification codes moved to the control plane (`EmailVerificationCode`), hashed at rest, with the five-guess cap spent atomically, and **bound to their flow** — a "Find your workspace" code can no longer complete a signup | `workspace-directory.service.ts` | `workspace-directory.test.ts`, falsified twice |
| Every created **and every failed** signup writes a platform audit row and emails the console's alert recipients; the public page no longer shows the raw provisioning error | `signup.controller.ts`, templates `platform.signup_created` / `platform.signup_failed` | `platform-signup.test.ts` |
| Trial length from one constant (the pricing card promised 14 days against the route's 15); the code email said 15 minutes against a 10-minute code | `SELF_SERVE_TRIAL_DAYS` in `@timesheet/shared` | typecheck |
| SSO: Google sign-in requires `email_verified: true`; Microsoft with no tenant ID is **proven** to accept accounts from any directory (and personal ones), matched by email — warned in Workspace Settings and logged, not yet blocked | `sso.service.ts`, `SsoSettingsCard.tsx` | `tests/unit/sso-oidc-claims.test.ts` |

**Upgrade action:** a multi-org deployment that sells through signup must switch it on after
upgrading (Platform admin → Settings → Signup). Everything else is automatic; one additive
control-plane migration (`20261001120000_signup_settings_and_verification_codes`).

## 5. Phase 1 — one workspace per company (approved 2026-10-01)

### 5.1 The decision, after the code is verified

The code must be checked **before** the server can say "your company already has a workspace", so
step two splits: `POST /api/signup/verify { token, code }` checks the code and answers with what
happens next plus a short-lived **continuation token** (signed, 15 minutes, single-use, bound to the
proven address). Nothing about any workspace is revealed before that — the same verify-first rule
"Find your workspace" already follows.

| Situation (checked in this order) | Answer | What the person sees |
|---|---|---|
| Signup closed | `403 SIGNUP_CLOSED` (Phase 0) | "Signups are closed" — talk to us, find your workspace, sign in |
| Personal / temporary / operator-blocked domain | `422` (Phase 0) | "Use your work email" |
| The address is already a member of a workspace | `{ next: "member", workspaces }` | "You already have a workspace" — sign-in links. No new database |
| The domain is claimed by an **ACTIVE** workspace | `{ next: "join", workspace: { name } }` | "Acme already uses TimeSphere" — **Request to join** (name, optional message). Also: "Need a separate workspace?" |
| The domain is claimed by a workspace in grace, suspended or still provisioning | `{ next: "unavailable", workspace: { name } }` | "Acme's workspace isn't available right now — contact its administrator." No request, no new workspace. |
| The domain is unclaimed | `{ next: "create" }` | Today's form: name, address, first admin |

"Need a separate workspace?" (a subsidiary, a separate legal entity) opens a sales-lead form with
the context attached. A platform admin decides and provisions by hand; it is never self-serve.

### 5.2 Which domain an address belongs to

`companyDomainOf(email)`: lower-case, IDN to ASCII, then the **registrable domain** from the Public
Suffix List (`tldts`, private suffixes on). `eng.acme.com` → `acme.com`; `mail.acme.co.uk` →
`acme.co.uk`; `team.example.github.io` → `example.github.io`.

**The exception that matters:** hosts that issue one sub-domain per customer but are NOT on the
Public Suffix List. `onmicrosoft.com` is the one that bites — every Microsoft 365 tenant gets
`<name>.onmicrosoft.com`, and rolled up, two unrelated companies on their default addresses would be
one company, and the second would be told to request access to the first's workspace. For those
hosts (`SHARED_EMAIL_HOSTS`), the company domain stops one label below: `contoso.onmicrosoft.com`
stays itself. Measured 2026-10-01 against tldts 7.4.11: `getDomain("contoso.onmicrosoft.com")` is
`onmicrosoft.com` with private suffixes on and off.

An address with no registrable domain (an IP literal, `localhost`, a bare suffix) is refused at
signup, like a personal address.

### 5.2b Data

All additive. Control plane:

- **`OrgEmailDomain`** — `domain` (**unique**), `organizationId`, `status` (`UNVERIFIED` / `VERIFIED`),
  `source` (`SIGNUP` / `BACKFILL` / `ADMIN`), `verifiedAt`, `createdAt`. The unique index is the
  rule: two simultaneous signups from a new domain cannot both create a workspace — the loser's
  insert fails and it becomes a join request.
- **`SignupAttempt`** — one row per stage reached: `domain`, `emailHash` (keyed, never the address),
  `stage` (`CODE_SENT`, `VERIFIED`, `CREATED`, `JOIN_REQUESTED`, `REFUSED_PERSONAL`, `REFUSED_CLOSED`,
  `FAILED`), `organizationId?`, `error?`, `createdAt`. Feeds the funnel in 5.5. Created workspaces
  already keep `ownerEmail`; abandoned attempts keep no address at all.
- **`Organization.createdVia`** — `SELF_SERVE` / `CONSOLE`, nullable, backfilled
  (`trialStartedAt` set → `SELF_SERVE`). The Overview's signup count stops mixing the two.

Tenant (each workspace's own database):

- **`JoinRequest`** — `email`, `name`, `message?`, `status` (`PENDING` / `APPROVED` / `DECLINED` /
  `EXPIRED`), `decidedById`, `decidedAt`, `decisionNote`, `roleGranted`, `createdUserId`,
  `expiresAt` (the console's setting at the time of the request, default 14 days), `createdAt`. One
  pending request per address, enforced in the service (MySQL has no partial unique index).

### 5.3 Join requests

1. Written into the target workspace's own database (`withOrgTenant`), so the request lives with the
   people who decide it and never in a cross-tenant table.
2. The workspace's super admins get a bell notification and an email (a new tenant template,
   `workspace.join_request`, editable like every other).
3. **Users → Requests**: approve (role defaults to Employee) or decline with an optional note.
   Approval checks the seat limit of the plan or trial (`getEffectiveSeatLimit`); a full workspace is
   told "upgrade or free a seat" and the request waits.
4. Approval creates the user with **no password**, then sends a single-use, expiring "set your
   password" link — or, when the workspace requires SSO, a "sign in with your company account" link.
   No password is ever collected before approval.
5. Limits: one pending request per address per workspace; a cap per domain per day; requests expire
   after 14 days; every step is audited in the tenant and counted in the control plane.

### 5.4 Domain claims

- Created at signup for the signer's domain (`UNVERIFIED`, `SIGNUP`).
- **Backfill** for existing workspaces from `Organization.ownerEmail`, skipping personal domains.
  Where two existing workspaces share a domain, **neither** is given the claim automatically; both
  are listed for the operator as a conflict. A script, run as a dry run first.
- A suspended or grace workspace keeps its claim, and **refuses** join requests until it is active
  again (decision 8). A workspace deleted under the retention policy releases it.
- **Console → Domains**: every claim with its workspace, status and source; reassign, release, and
  the conflict list. Every change audited.
- **Workspace Settings → Company domains** (super admin): see the claim; verification is Phase 2.

### 5.5 Signup visibility for platform admins

Phase 0 already sends an email per created or failed signup and writes the audit rows. Phase 1 adds:

- **Console → Signups** (new page):
  - the funnel for a chosen period — codes sent → verified → created / joined / refused / failed;
  - signups per day and week, self-serve separated from console-provisioned;
  - recent self-serve workspaces with their **status**: provisioning, trial with days left,
    converted to paid, grace, suspended, deleted — plus owner, domain and seats in use (from the
    nightly usage snapshot, so the page never opens a tenant database);
  - failed signups with the error and a contact action;
  - top signup domains, and join-request counts per workspace (aggregates only).
- **Overview:** the signup tile split into self-serve and console, with the 30-day funnel.
- **Notification choice:** a **daily summary (the default, decision 6)**, per signup, or off. The
  summary is the last 24 hours — workspaces created, signups that failed (with their errors), join
  requests made, addresses refused — and is skipped when there is nothing in it. Sent once per day
  even with several API replicas: a control-plane claim row decides which replica sends it.
- **When provisioning is failing:** the second failed signup within an hour sends one immediate
  email to the alert recipients — whatever the notification mode except off — so a broken provisioning
  server is noticed after the second failed customer, not in tomorrow's summary. (Not a fleet alert:
  fleet alerts belong to a workspace, and a failed signup has none.)

### 5.6 Security properties

- Verify-first: no workspace's existence is revealed before the code is returned.
- The continuation token is signed, short-lived, single-use, and bound to the proven address — the
  join or create request cannot name a different one.
- The join screen shows only the workspace's display name — not its admins, size or address.
- No password before approval; set-password links are single-use and expire.
- One company domain, one workspace — enforced by a database constraint, not by application logic.

### 5.7 Testing and rollout

Unit tests for every branch of the decision table, the race (two simultaneous signups from one new
domain), seat-limit refusal on approval, expiry, and the cross-tenant boundary (a request for one
workspace never readable from another). The backfill runs as a dry run, reports conflicts, and only
then writes. All migrations additive; the join flow sits behind the Phase 0 switch, so nothing
changes for a deployment with signup closed.

## 6. Phase 2 — proven domains (outline)

- DNS TXT verification for **email** domains, reusing the custom-hostname verification in
  `org-domain.service.ts`. A verified claim outranks an unverified one; the operator confirms the
  handover, as in Microsoft's admin takeover.
- **Auto-join** on a verified domain: admin opt-in, off by default, joiners as Employee, still bounded
  by seats.
- **SSO just-in-time provisioning limited to the workspace's verified domains.**
- **Microsoft identity by directory, not by email:** store the token's `tid` + `oid` on first sign-in
  (a `UserIdentity` table) and match on those afterwards. This closes the account-takeover path that
  Phase 0 could only warn about for workspaces left on Microsoft's `common` authority.

## 7. Phase 3 — enterprise (outline)

"Everyone at @acme.com must sign in through our identity provider", and claiming existing accounts
under a verified domain.

## 8. Questions answered (2026-10-01)

| Question | Answer | Recorded as |
|---|---|---|
| Per-signup email or a daily summary? | Daily summary | Decision 6 |
| Join requests expire after 14 days? | Yes — a business decision | Decision 7 (a console setting, default 14) |
| Should a suspended workspace collect join requests? | No — it already has a database; nothing until it is reactivated or pays | Decision 8 (grace included) |
| Is `eng.acme.com` part of `acme.com`? | Yes | Decision 9, with the shared-host exception in §5.2 |
