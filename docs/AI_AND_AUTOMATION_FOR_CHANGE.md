# AI, agents and workflows for Tickets and Change Management — a plan

Status: **steps 1, 2 and 3 are built; 4 and 5 are still a proposal.** Written against the seams that already
exist, so every item below says which of them it extends and what it would cost. Read
[ARCHITECTURE.md §3.12](ARCHITECTURE.md) and [API.md](API.md#change-management-v8) first.

---

## 0. The one distinction the rest of this depends on

A great deal of what looks like "let AI fill this in" is **not a model problem**. This app already
holds the facts:

| Field somebody wants filled | Where the answer already is | Should it be AI? |
|---|---|---|
| Affected repository / branch | `TicketBranch` on the change's linked tickets | **No — derive it** |
| Pull request, merge status | `TicketBranch.prUrl` / `prState`, kept live by `git-webhook.controller.ts` | **No — derive it** |
| Release / version | The tag or branch name on those same rows | **No — derive it** |
| CI status at the moment of raising | The latest ingested test run for that branch | **No — derive it** |
| Affected applications | `ChangeApplication` joined through the linked tickets' projects | **No — derive it** |
| Who implemented the work | `Ticket.assignee` across the linked tickets | **No — derive it** |
| Effort actually spent | Approved timesheets against those tickets | **No — derive it** |
| *Justification, impact narrative, backout plan, test plan* | Nowhere. Somebody has to think. | **Yes** |

**A derived value is auditable and free; a generated one has to be checked and costs a model call.**
Deriving first also makes the AI better: a model asked to write a backout plan does markedly worse
with no context than one told "this change ships PR #412 to the payments service, whose last three
deploys each needed a schema rollback".

So the plan is two layers, and **the first is worth building even if you never turn AI on**.

---

## Part 1 — Change management (item 6)

### 1.1 Layer one: the change context pack (no AI) — **BUILT**

A new service assembles, for any change, everything derivable from its linked tickets:

```
GET /changes/:id/context
  → repositories, branches, pull requests and their states
    CI runs and pass/fail at the time of asking
    security findings open against those repos
    applications and projects touched
    people who worked the tickets, and the hours they logged
    the last N changes against the same application, and how they went
```

Nothing here calls a model. It powers three things immediately:

- **Autofill on raise.** "Environment", "Application", "Implementer" and the affected-systems lists
  are proposed from the linked tickets the moment tickets are tagged — as *prefilled values a human
  confirms*, never silently written.
- **A Context tab** on the change, showing what is actually shipping. This is the tab an approver
  wants and does not currently have.
- **The prompt context** for everything in §1.2.

**Cost:** one service, one route, one tab. No schema change — every table it reads exists.

### 1.2 Layer two: four AI capabilities

Each follows the existing contract exactly: a `GlobalAISettings` boolean, an entry in
`ai-capability.registry.ts` with a **ceiling**, a versioned prompt in `AIPromptTemplate`, and a row
in `AIUsageLog` keyed on the capability id so usage and policy join.

| Capability | What it does | Ceiling | Why that ceiling |
|---|---|---|---|
| `change_draft_assist` | Drafts justification, impact narrative, test plan and **backout plan** from the context pack | `SUGGEST` | It is writing the thing an approver relies on. A draft nobody wrote is worse than a blank field, because a blank field is honest. |
| `change_risk_narrative` — **BUILT** | Explains the **already-computed** score in prose — which parameters drove it | `AUTONOMOUS` | Narrates, never scores; writes nothing at all, and reads only the change's own recorded assessment. Shipped at the same ceiling as `project_risk_narrative` for the same reason. The top rung is not a licence to approve — no capability can, at any level. |
| `change_conflict_brief` | Reads the calendar and says what else is booked on this application in this window | `PROPOSE` | It reports; it does not move anything. |
| `change_pir_assist` | Drafts the post-implementation review from what actually happened — steps that failed, tests that did not pass, the outcome | `SUGGEST` | The PIR is the record of a failure. Its author should be the person accountable for it. |

**`change_draft_assist` must produce an `AiProposal`, not field writes.** `AiProposalKind` gains
`CHANGE_DRAFT`; each field becomes an `AiProposalChange` a human accepts or rejects individually,
and a row whose underlying value changed since is refused rather than quietly reverting somebody's
edit. That machinery exists and is used by `PLAN_BREAKDOWN` today.

### 1.3 The one thing that must never be automated

**Approving a change.** Not at any autonomy level, not behind any toggle. An approval is a
statement that a named person accepts the risk; there is no undo, and the entire module exists to
make that statement real. `ai-capability.registry.ts` already carries this reasoning verbatim for
payroll-adjacent actions — the same paragraph covers this.

What AI *may* do for an approver is prepare the decision: summarise what is shipping, name the
conflicts, and say which of this change's parameters are unusual against the last twenty like it.
The button still says Approve, and a person still presses it.

### 1.4 Where the controls live

Workspace Settings → **AI**, in the existing capability grid, alongside every other capability. Not
a second panel on the Change management tab: `aiAutonomyEnabled` is already the master latch and
`AiCapabilityPolicy` already the per-capability row, and a second surface for the same question is
a second surface to forget. The Change management tab links across to it.

**Analytics** come free: `AIUsageLog` is already keyed on `feature`, so change capabilities appear
in the existing AI usage panel — spend, call count, and the accept/reject rate on their proposals —
without new plumbing. The one addition worth making is **acceptance rate per capability**, which is
the only honest measure of whether a drafting assistant is any good.

---

## Part 2 — Agents and workflows (item 9)

### 2.1 What already works today, unchanged

**Workflow Studio can already trigger on change events.** `DOMAIN_EVENTS` contains
`change.submitted`, `change.awaiting_approval`, `change.approved`, `change.rejected`,
`change.scheduled`, `change.implementing`, `change.pir`, `change.closed` and `change.cancelled`;
`GET /flows/catalogue` returns that list raw, and `automation-dispatch.service.ts` subscribes to all
of it. A super admin can build these **now**, with no code:

- On `change.approved` → notify the implementer and the release channel.
- On `change.scheduled` → a `HUMAN_GATE` on the platform owner 24h before the window.
- On `change.closed` with outcome FAILED → open a follow-up ticket, assign it, label it.
- On a cron → a digest of everything scheduled for the coming week.

This is worth saying plainly because it changes what needs building: **the trigger side is done.**

**One correction to that, found while building §2.2.** The trigger fired, but `subjectOf` read
`payload.ticket` and a change event emits `{ change }` — so every change-triggered flow received a
`workspace` subject with a null id, and every step except `notify` failed with "this run has no
ticket to change". A change resolves to its own ticket now, which is the module's founding decision
applied here: every action and branch field that works on a ticket works on a change for free.

### 2.2 The action side — **BUILT**

`AutomationStepKind.ACTION` performs the deterministic things `TicketRule` does — assign, label,
notify. None of them touch a change. The gap is a small set of change-shaped actions:

| Action | Notes |
|---|---|
| `CHANGE_TRANSITION` | Move a change to a named state. Must re-enter the same `assertReadyFor` / dependency gates the API uses — an automation that walks a change past its own requirements is the one thing this must not become. |
| `CHANGE_COMMENT` | Post to the underlying ticket. Trivial; the ticket half already supports it. |
| `CHANGE_TAG_COLLABORATOR` | Add a named person. |

`CHANGE_LINK_TICKET` was dropped rather than built. A flow triggered by a change event has no second
ticket to link, and one triggered by a ticket event would have to guess which open change the ticket
belongs to — a guess with no right answer. Tagging stays a human act on the Tickets & team tab.

Deliberately **not** on that list: approve, reject, and edit-the-plan-after-approval. Same reason as
§1.3. Every one re-enters `assertLegalChangeTransition`, `assertReadyFor` and
`assertDependenciesClear` — the same three functions the API route calls, which is why that gate
moved out of the controller and into the service. `change-automation-actions.test.ts` pins that a
second caller cannot walk a change past them.

**A precision worth recording**, because an earlier version of these notes and the 3.0.0 changelog
both got it slightly wrong: `APPROVED` is *not* absent from the transition table. `SCHEDULED →
APPROVED` is legal and means "unschedule it" — the approval already happened and only the window is
being given up. What is impossible is reaching `APPROVED` from a state that has not been decided,
and `REJECTED` is unreachable from everywhere. A workflow is refused even the unschedule.

### 2.3 Agents on tickets and changes

`AgentProfile` teammates hold capabilities and act as a named identity with a real permission set.
Three roles fit this module, in ascending order of how much they can get wrong:

1. **A change scribe** (`SUGGEST`) — owns `change_draft_assist` and `change_pir_assist`. Drafts, and
   the drafts sit in the proposal queue.
2. **A release coordinator** (`PROPOSE`) — owns `change_conflict_brief`. Watches the calendar and
   raises a flag when two changes collide, or when one is scheduled into a blackout.
3. **A ticket triager** (already exists as `triage`) — extended so a ticket closed under a change
   gets linked automatically rather than by hand.

The existing rule holds throughout: **one capability, one owner.** A flow's capability steps must
belong to the profile the flow runs as, which is what stops the Studio becoming a way around it.

### 2.4 The clamp that matters

`actsOnUntrustedInput` caps a capability below `AUTONOMOUS` when its input is authored outside the
workspace. A change's linked PR bodies, CI logs and scanner findings are all outside content — so
every capability in §1.2 that reads the context pack **inherits that cap**, and the agent runtime
clamps a run that has touched such content. That is existing behaviour and it is the correct one
here; it should be marked on each new capability rather than argued about later.

---

## Suggested order

1. ~~**The context pack** (§1.1).~~ **Built.** `GET /changes/:id/context` and the Context tab.
2. ~~**The change actions** (§2.2).~~ **Built** — three of the four; see why the fourth was dropped.
3. ~~**`change_risk_narrative`** (§1.2).~~ **Built.** `POST /changes/:id/risk-narrative`, an
   "Explain this score" button on the Risk tab, and a `changeRiskNarrativeEnabled` toggle that
   appears in the AI capability grid on its own — the registry drives that screen, so no settings UI
   changed, which was the point of routing it through the existing contract.
4. **`change_draft_assist`** as a proposal (§1.2). The largest win and the largest blast radius; do
   it once the proposal queue has been exercised by the three above.
5. **`change_conflict_brief`** and **`change_pir_assist`**.

Nothing in steps 1–2 needs AI switched on at all, which is the point: a workspace that never enables
a model still gets the autofill, the Context tab, and change-aware automation.
