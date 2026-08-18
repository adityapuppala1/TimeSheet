# V8 — Agentic Work Management

Research and plan, written 2026-08-17 on branch V8. Nothing here is built yet. This document is the
argument for what to build and, more importantly, what **not** to rebuild: most of the hard
machinery this theme needs already exists and is listed below by name.

Companion documents: [ROADMAP.md](ROADMAP.md) (the dated audit trail — V6's planning-layer entry is
the direct predecessor of this one), [ARCHITECTURE.md](ARCHITECTURE.md), [API.md](API.md),
[DATABASE.md](DATABASE.md).

---

## 1. The thesis

Asana's 2026 positioning is "Agentic Work Management": a roster of ready-made **AI Teammates**, a
no-code **AI Studio** for composing automations, a personal **Dash** brief, all reading a **Work
Graph**, with human-input steps as the guardrail. Sources at the end of this document.

The market's framing is *agents that do work*. The question nobody in that market can answer is
**what the work cost and whether it was any good** — because Asana, Monday, Wrike and ClickUp hold
estimates, not measured effort. They can tell you an agent ran. They cannot tell you that it
consumed $4.10, displaced 3.2 hours of a senior engineer's time, and that the change it made was
still standing a week later.

TimeSphere can, and only TimeSphere can, because it already holds approved hours per person per
project per day with a rate snapshot captured at approval (`Timesheet.billedRate`,
`billedAmount`) — the same asset the V6 planning layer cashed in for measured workload and budget
burn. **The differentiator is not having agents. It is putting agent work on the same ledger as
human work.** That is section 4.

---

## 2. Where we already stand against Asana

Feature-by-feature against [asana.com/features](https://asana.com/features). This table exists so
that no phase below re-implements something that shipped in V6.

| Asana capability | TimeSphere today | Verdict |
|---|---|---|
| Tasks, Projects | `Ticket` (with `parentId`, dates, `isMilestone`, `progressPct`, baselines), `Project` / `ProjectModule` / `ProjectSubmodule` | **Have** |
| Project views: list, board, timeline/Gantt, calendar | View switcher on the existing Tickets page; hand-built SVG Gantt with 4 dependency types, lag, critical path, float, baseline slip | **Have** |
| Custom fields | `CustomField` / `CustomFieldValue` as rows (not JSON), one validation choke point | **Have** |
| Status updates | AI-drafted status reports (`ai.service.ts#generateStatusReport`), `ReportSubscription` scheduled delivery | **Have** |
| Time tracking | The core of the product | **Have, stronger** |
| My tasks | `/app/my-work`, bucketed server-side so one definition of "overdue" is shared with the dashboard and reminder emails | **Have** |
| Inbox | `Notification` rows and a bell. No triage surface, no "what needs me today" assembly | **Partial** → phase 2 |
| Home | Dashboard (role-aware command centre) | **Have** |
| **Goals** | Nothing. No `Goal`, `Objective` or `KeyResult` model exists | **Missing** → phase 1 |
| Portfolios | `Portfolio`, deriving schedule from the same solver and burn from rate snapshots | **Have** |
| Reporting dashboards | `Dashboard` over a deliberately **closed** widget catalogue, 4 widget shapes | **Have** |
| Forms | `RequestForm` with conditional questions, public URL, no account needed | **Have** |
| Rules | `TicketRule` (condition → assign/label/notify) at the ticket-creation choke point | **Have, narrow** → phase 4 |
| Bundles / Templates | `Blueprint` (relative day offsets, backward-only references) | **Have** |
| Capacity planning, Workload | `ResourceBooking` + `workload.service.ts` — planned, actual and capacity on one axis, per working day | **Have, stronger** |
| Timesheets and budgets | `budget.service.ts`, one definition of money shared by portfolio roll-up and client-facing attestation | **Have, stronger** |
| Admin console, permissions, audit, guests | Roles/permissions, `AuditLog`, platform-admin console, single-use guest approval links | **Have** |
| Integrations | 6 git providers, Slack/Teams chat, SSO (SAML/OIDC/LDAP), SCIM, public REST API, outbound webhooks, MCP server | **Have** (no Salesforce/Tableau/PowerBI; no calendar sync — a known open item) |
| **AI Teammates** (named agent roster) | 16+ registered capabilities with autonomy levels, but no persona, roster or identity concept | **Missing packaging** → phase 3 |
| **AI Studio** (no-code AI workflow builder) | `TicketRule` is deterministic and ticket-creation-only; no multi-step flows, no human-input step | **Missing** → phase 4 |
| **Dash** (personal AI chief of staff) | Nothing assembled per person | **Missing** → phase 2 |
| Work Graph + MCP | `POST /api/mcp`, 11 tools bounded by one user's permissions, per-tool gating, off by default | **Have** |

**Read the table honestly: parity is mostly done.** The gaps are Goals, an Inbox/brief, and the
*packaging and composition* of an agentic layer whose dangerous parts are already built.

## 3. What already exists that phases 3–5 must reuse, not reinvent

This is the reason this theme is tractable in weeks rather than quarters.

- **`AgentRun` / `AgentRunStep`** — bounded, abortable, traced runs. Already carries: `triggerKey`
  as a unique idempotency key (a doubled cron tick, a retried webhook and a restart mid-tick all
  collapse to one row, enforced by the database rather than an in-memory set); `level` **copied at
  queue time**, so editing a policy cannot escalate a run already in flight; `maxSteps` /
  `maxCostUsd`; `abortRequestedAt` polled between steps so an abort survives a restart; and
  `PARTIAL` / `BLOCKED` as first-class outcomes rather than failures.
- **`taintedAt`** — the moment a tool returns externally-authored text, the run's effective autonomy
  is clamped to `SUGGEST` for the rest of its life. This is a prompt-injection **authority**
  downgrade, and it is the single most important thing to preserve when flows can be composed:
  a builder that lets a user route stranger-authored text into a writing step must inherit this.
- **`AiCapabilityPolicy`** — per-capability `level`, `maxChangesPerRun`, `maxRunsPerDay`,
  `maxCostUsdPerRun`, `undoWindowHours`, `scopeProjectIds`. Plus the rule that matters:
  `AiCapabilitySpec.maxLevel` in `ai-capability.registry.ts` is a ceiling **the code sets and an
  administrator may only lower**. Floor is `SUGGEST`.
- **`AiProposal` / `AiProposalChange`** — the human-in-the-loop envelope, with per-row before→after
  diffs, a writable-field allowlist, and **stale-state detection**: a row refuses to apply if the
  current value has moved since it was computed, so applying can never silently revert a person.
  Rows apply independently. There is deliberately no apply-all button.
- **`AIUsageLog` / `AiSpendMonth`** — every model call priced, with budget ceilings enforced at the
  `preflight`/`callChat` choke point. This is what makes phase 5 possible at all.
- **`AIPromptTemplate` / `AIPromptVersion`** — versioned prompts behind an allowlist that is a
  security boundary; `AIDataset` / `AIEvalRun` / `AIEvalResult` — the quality loop.
- **`McpCredential` / `McpToolInvocation` / `GlobalMcpSettings`** — per-credential identity, per-tool
  enablement, writes off individually.
- **`Notification`**, `TicketRule`, `RequestForm`, `runForEveryOrg`, `domain-events.ts`.

**The registered capabilities today** (from `ai-capability.registry.ts`, with their code ceilings):
`weekly_digest`, `security_weekly_digest`, `bug_pattern_digest`, `project_risk_narrative` —
`AUTONOMOUS`, because they send mail and change no records. `status_report`,
`schedule_adjustment`, `blueprint_instantiate`, `assignment_rebalance`, `plan_breakdown`,
`duplicate_detection`, `assignee_suggestion_explanation`, `triage`, `ci_failure_triage`,
`security_finding_triage`, `pr_review_summary` — `AUTO_APPLY`. `risk_mitigation` — `SUGGEST`.

A "teammate" is therefore not new behaviour. It is a **name, a scope, an identity and a budget**
wrapped around capabilities that already run.

---

## 4. The differentiator: agent work on the same ledger

Every competitor's agent story ends at "it ran". Ours can end at "here is what it cost, what it
displaced, and whether it held up" — and can put that on a client-facing document, because
attestations already read the same rate snapshots.

The mechanism, `AgentWorkEntry`, deliberately mirrors `Timesheet` rather than inventing a parallel
reporting path:

- **Attributed** — `projectId`, `activityTypeId`, the `AgentRun` that produced it, the human it
  acted on behalf of.
- **Measured, not estimated** — wall-clock duration of the run, and `costUsd` summed from
  `AIUsageLog` for that run. Both are recorded facts, not guesses.
- **Displacement is stated, never invented** — `displacedMinutes` is populated only where the
  action has a measured human baseline the product already holds (e.g. median minutes historically
  logged against triage on this workspace's own timesheets). Where there is no baseline it is
  `NULL` and the UI says *not measurable* — the same posture as a dashboard widget answering
  `unavailable` rather than `0`, and as `budget.service.ts` refusing a forecast below 5% progress.
- **Never billable by default.** Agent cost is real cost, but invoicing a client for machine minutes
  is a commercial decision no default should make for an operator. It surfaces as its own line,
  outside `billedAmount`, unless an admin opts in per project.

What that unlocks, all from surfaces that already exist:

1. **Workload** shows human load and agent load on one axis — a team at 70% human capacity with 30%
   of its throughput agent-produced is a different organisation from one at 100% human.
2. **Budget burn** separates human cost from agent cost, so "AI saved us money" stops being a claim.
3. **Attestations** can state "240 approved hours, of which 12 were agent-assisted, itemised" —
   provable, because every agent write already has an `AuditLog` row and a proposal diff.
4. **Estimate accuracy** (already computed, finished-work-only, reported as a median) gains a
   second series: how good the agents' estimates were versus the humans'.

---

## 5. The plan

**The constraint on the whole programme, inherited verbatim from V6 and non-negotiable:** an
organisation that upgrades and touches nothing must behave exactly as it did on V7. Every table
new, every added column nullable or defaulted, every capability inert until an admin opts in, and
the full Playwright suite passing **unedited** at each phase boundary. Entitlements fail closed
with no fail-open counterpart (unlike face verification, whose reasons for a fail-open path do not
apply here).

### Phase 1 — Goals, and progress that is measured

The one genuine feature gap, and the one that is sellable on its own. No AI.

- `Goal` — hierarchy via `parentId`, `ownerId`, period (`startDate`/`endDate`), `targetValue`,
  `unit`, `status`, and a `progressSource` discriminator.
- **`progressSource` is the whole design.** `MANUAL` behaves like every competitor. The other values
  wire a goal to a metric the product already computes — on-time delivery from the schedule solver,
  budget burn from `budget.service.ts`, approved hours by activity from `Timesheet`, SLA breach
  count, open-findings risk score. A goal wired this way **cannot be talked up in a status meeting**,
  which is the entire point of an OKR and the thing spreadsheet OKRs always lose.
- `GoalLink` — many-to-many to `Project`, `Portfolio`, `Ticket`. Roll-up is effort-weighted, reusing
  the same shape as the existing progress roll-up rather than a second definition.
- A manual override on a measured goal is allowed but **records who overrode it and what the
  measurement said** — otherwise the first inconvenient number ends the feature's credibility.
- Surfaces: `/app/goals` (tree + status), a Goals column in Portfolio, a goal chip on Project.
  Entitlement: `goalsEnabled` + a `maxGoals` quota on `PlanTierLimit`.

### Phase 2 — Work Inbox and the daily brief

Asana's Inbox and Dash, built deterministically first.

- `/app/inbox` — a triage surface over existing `Notification` rows: group, snooze, mark handled,
  jump to source. No new data model beyond `handledAt` / `snoozedUntil`.
- **The brief is assembled by arithmetic, not by a model**: what is overdue, what awaits your
  approval, what is blocked on you, whose time is unlogged, which of your projects moved into risk.
  Every one of those numbers already has exactly one server-side definition — reuse it, do not
  restate it.
- The optional model call **narrates a brief it cannot change**, exactly as
  `project_risk_narrative` explains a score it cannot set. New capability `daily_brief`, ceiling
  `AUTONOMOUS` (it sends nothing and writes nothing).
- Delivery reuses `ReportSubscription`'s cadence machinery and the email role matrix. No new
  always-on email category — the bell is the default surface.

### Phase 3 — The agent roster ("teammates" that are accountable)

Packaging, not new authority. Cheap because section 3 is already built.

- `AgentProfile` — `name`, `avatar`, `description`, a bundle of capability ids, `scopeProjectIds`,
  a budget (`maxCostUsdPerDay`), and an **identity**.
- **Identity is the one real decision** (see section 7): a dedicated non-login `AGENT` user makes
  every existing audit, notification, assignment and attestation surface work unchanged — an agent
  can be an assignee, appear in workload, and own a comment. It must be flagged so it never
  consumes a paid seat and can never authenticate.
- A profile can never exceed the capability ceilings its bundle already has. `AgentRun.level` stays
  the authority record; `AgentProfile` is a convenience over `AiCapabilityPolicy`, never a bypass.
- Ship a prebuilt roster — a triage teammate, a planning teammate, a security-findings teammate, a
  reporting teammate — **all disabled**, assembled only from capabilities that exist today.
- `/app/agents`: roster, per-agent run history (`AgentRun` already stores everything needed), spend
  against budget, and one abort button that writes `abortRequestedAt`.

### Phase 4 — Workflow Studio

The composition surface, and the phase with the real risk.

- `AutomationFlow` / `AutomationStep` — trigger (domain event via `domain-events.ts`, schedule,
  form submission, intake) → ordered steps → outcome. Step kinds: `ACTION` (deterministic, the
  existing `TicketRule` actions), `CAPABILITY` (an AI capability from the registry), `HUMAN_GATE`
  (an approval that blocks), `BRANCH` (condition on fields the rules engine already evaluates).
- **Three inviolable rules**, each inherited rather than invented:
  1. A flow's effective authority is the **minimum** of its steps' capability ceilings. Composing
     two `AUTO_APPLY` steps must never produce autonomy neither had.
  2. `taintedAt` propagates through a flow. If any step ingests externally-authored text, every
     later writing step is clamped to `SUGGEST` — i.e. it produces a proposal a human accepts.
  3. Anything that writes above `SUGGEST` writes **through `AiProposal`**, keeping the diff, the
     allowlist and the stale-state refusal. The Studio adds no new write path.
- Execution is an `AgentRun`, so idempotency, abort, step cap, cost cap and tracing come free.
  A flow that produces something its level cannot apply lands in `BLOCKED` — an outcome, not an error.
- Builder UI: a vertical step list before a canvas. A canvas is what demos well; a list is what
  people can read in review, and every flow here is short by design.
- **Simulation before activation** — run a flow against the last N real triggers and show what it
  *would* have done, without writing. This is the feature that makes an operator willing to switch
  it on, and it is nearly free because proposals already model "what would change".

### Phase 5 — The agent ledger

Section 4, implemented. `AgentWorkEntry`, written by the `AgentRun` completion path; workload and
budget gain an agent series; attestation gains an itemised agent-assist section; `displacedMinutes`
computed only where a measured baseline exists.

This phase is deliberately **last**: it is only honest once phases 3 and 4 are producing real agent
work to account for.

### Phase 6 — reach beyond the workspace (scoped, not committed)

Asana bought StackAI to orchestrate across CRMs and ERPs. The equivalent here is TimeSphere as an
MCP **client** (it is already a server), letting a flow step call an external tool the admin has
registered. This is a large security surface — outbound credentials, per-tool allowlisting, tainted
input by definition — and is written down here so it is not smuggled into phase 4.

---

## 6. Explicitly out of scope

- Rebuilding anything in the section 2 "Have" column.
- A canvas-style flow editor with arbitrary graphs. Short, readable, linear-with-branches flows only.
- Agent-to-agent delegation. One run, one authority record, one abort button.
- Fully autonomous writing on stranger-authored input. The `taintedAt` clamp is not negotiable.
- Charging clients for agent minutes by default.

## 7. Decisions taken (2026-08-17)

All four confirmed by the product owner before any code was written. They are recorded here rather
than in a conversation because each one constrains a later phase, and phase 4 in particular must be
reviewable against them.

1. **Phase order: Goals first.** It closes the only real parity gap, is sellable on its own, carries
   no AI risk, and phase 5's ledger cannot be honest until phases 3–4 are producing agent work.
2. **Agent identity: a dedicated non-login `AGENT` user.** Every existing surface — assignment,
   workload, comments, audit, attestation — then works unchanged. It carries a hard `isAgent` flag
   that **excludes it from seat counts and from every authentication path**; both exclusions are
   security/billing invariants and each needs its own test, not a shared one.
3. **Agent time: never client-billable by default, opt-in per project.** Agent cost stays outside
   `billedAmount` so `budget.service.ts` keeps its single definition of money, and is always itemised
   internally. Turning it on is a per-project admin action, never a global default.
4. **Goal progress: measured, with a recorded manual override.** The override stores who made it,
   when, and what the measurement said at that moment. Measured-only does not survive its first
   quarter-end; an unrecorded override ends the feature's credibility the first time somebody
   notices the number moved.

### What phase 1 therefore builds first

`Goal`, `GoalLink`, and the `progressSource` discriminator with `MANUAL` plus the measured sources
listed in phase 1; the `GoalProgressOverride` trail implied by decision 4; `goalsEnabled` +
`maxGoals` on `PlanTierLimit` failing closed; the admin surface and `/app/goals`. Per the V6
constraint, the schema and entitlement land and are verified **on their own** before any UI beyond a
settings tab — that is the phase-1 discipline that made the V6 migration safe on live multi-tenant
data, and the migration here touches `Project`, `Portfolio` and `Ticket` only through new join rows,
never with a column on those tables.

## Sources

- [Asana — Features](https://asana.com/features)
- [Asana — AI & Agentic Work Management](https://asana.com/product/ai)
- [Asana Unveils Operating System for Human-Agent Teams (investor release)](https://investors.asana.com/news-releases/news-release-details/asana-unveils-operating-system-human-agent-teams)
- [Asana Unveils Operating System for Human-Agent Teams (BusinessWire)](https://www.businesswire.com/news/home/20260604472500/en/Asana-Unveils-Operating-System-for-Human-Agent-Teams)
- [Asana Goes Beyond Tasks: A Work Graph–Powered AI Offensive (SoftwareReviews)](https://www.softwarereviews.com/vendor-technology-notes/asana-goes-beyond-tasks-a-work-graph-powered-ai-offensive)
- [Asana March 2026 Updates: AI Teammates & AI Studio](https://ido-clarity.com/blog/asana-march-2026-updates/)
- [Asana AI and Agentic Work Management: What Changed at Work Innovation Summit London](https://ido-clarity.com/blog/agentic-work-management-asana/)
