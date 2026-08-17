# V8 — the agentic surfaces, designed for the super admin

Plan written 2026-08-17, after the product owner answered the open questions. Companion to
[AGENTIC_WORK_MANAGEMENT.md](AGENTIC_WORK_MANAGEMENT.md), which covers the mechanism; this covers the
screens and the work still outstanding.

---

## 1. The answers this plan is built on

| Question | Answer | What it settles |
|---|---|---|
| Who are these screens for? | **The super admin configuring them.** | Density over hand-holding, every control on one screen, and no "simple mode". A team member's view of an agent is a read-only consequence, not a second design. |
| Which of the six problems matter? | **All of them.** | They are sequenced below rather than triaged away. |
| Builder shape? | **n8n-like: drag, drop, connect.** | The list view stays (it is what makes a flow reviewable); the canvas becomes the default editor, with a toggle. Asana ships exactly this pair — their own screenshot has a list/canvas switch in the left rail. |
| Agents' presentation? | **Asana's teammate gallery** — real identity marks, categories, skills. | Shipped in `00186ef`. |
| Who may configure? | **Super admin only, everywhere.** | Audited in §4. |
| AI tracking? | **Everything, in AI usage analytics.** | Agent-vs-human split shipped in `00186ef`; per-flow attribution in §3.2. |

## 2. What already shipped

- **Goals** with measured progress · **Inbox** and the arithmetic brief · **agent roster** with three
  identity fences · **capability ownership** so one capability has one owner · **Workflow Studio** with
  the three authority rules and a replay · **agent ledger** on the same books as human work.
- **The Asana-shaped gallery**: category filter, derived identity colours, plain-English skills,
  capability ids demoted behind a disclosure, and a *Create your own* card.
- **Agent-driven AI spend** as a share of the monthly total, in Workspace Settings → AI.

## 3. What is still outstanding, in build order

Each item states the decision that shapes it, so the next session does not re-litigate.

### 3.1 The n8n-style canvas (the big one)

**Decision: canvas and list are two views of one flow, and the list is not retired.** A canvas is how
somebody builds; a list is how somebody reviews, and the authority rules are text. The toggle lives in
a left rail, matching the reference.

- **Positions live in `AutomationStep.config` as `{ x, y }`** — no migration needed, because that column
  is already free-form per step kind. A step with no position is auto-laid-out on first open, so every
  existing flow opens as a sensible graph rather than a pile at the origin.
- **Connections are implied by `order`, not stored.** The steps are a sequence with branches; storing
  edges as well would give two sources of truth for the same fact, and the first disagreement between
  them is an unreadable flow. Dragging a connection therefore REORDERS — the canvas is a view of the
  sequence, and that is what keeps the authority calculation (which depends on order) honest.
- **What must be built:** an SVG canvas with pan/zoom, draggable node cards, elbow connectors (bezier
  curves become a tangle past a handful of edges — the timeline made this call already), a drop target
  per node for "insert step here", and a branch node that renders two lanes.
- **The authority banner stays pinned above the canvas.** On a canvas it is easy to lose the one fact
  that matters most; the banner is not a panel somebody has to open.
- **Below `lg` the canvas is not offered at all** — it degrades to the list, the same decision the Gantt
  made rather than shipping a squashed chart.

### 3.2 Flow dispatch, and per-flow AI attribution

**Decision: dispatch is opt-in per flow and observable before it is trusted.**

- Wire `EVENT` triggers to `domain-events.ts`, `SCHEDULE` to a `runForEveryOrg` sweep, and
  `FORM_SUBMISSION` to the intake hook. Execution stays `queueAgentRun`, so idempotency, abort, caps
  and audit are the existing ones.
- **`triggerKey` must include the subject id** (`flow:<id>:ticket:<id>`), or a doubled event fires twice
  and the idempotency guarantee the runtime already provides is wasted.
- **Attribute usage to the flow**, not only to the capability: `AIUsageLog.feature` currently carries the
  capability id, which is right, but a flow's spend cannot be separated from the same capability run by
  hand. The cheapest honest fix is a `flowId` column on `AgentRun` (nullable) and a join at read time —
  and it is the last piece needed for "every AI feature tracked", per the owner's requirement.
- **A first-run summary.** The first time a flow fires, its result goes to the Inbox of whoever
  activated it. An automation nobody notices working is an automation nobody trusts.

### 3.3 Per-step configuration in the builder

The schema holds `config` per step; the UI does not fill it yet. An `ACTION` step cannot choose its
assignee, and a `BRANCH` cannot state its condition — so today's flows are shapes, not rules.

**Decision: the condition vocabulary is the rules engine's existing one** (`TicketRule`'s fields), not a
new expression language. A second condition grammar is a second thing to secure and a second thing to
explain.

### 3.4 Run visibility, and the missing links between surfaces

- **A run drill-down**: steps, transcript, cost, the proposal it produced. `AgentRunStep` already stores
  it; nothing renders it.
- **Flow → proposal → applied change** as one navigable chain. A flow proposes, the proposal appears
  under AI suggestions, and nothing links them today — so the question "what did this flow actually do
  to my workspace" has no answer on screen.
- **Ledger history**: a per-run list and a trend, not only the aggregate strip.
- **One "AI in this workspace" landing** that explains the relationship between AI suggestions, Agents,
  Workflows and the AI settings. Four sibling surfaces with no map is the single biggest orientation
  problem a new admin meets.

### 3.5 The workload and budget merge (§4 of the mechanism doc)

Agent load beside human load on the workload board; agent cost beside human cost in budget burn.

**Decision: deferred deliberately, and not for lack of time.** Both touch surfaces people rely on daily,
and the ledger has to be producing real rows before a second series on those boards means anything.
Nothing is priced into `billedAmount`, so this is presentation, not accounting.

### 3.6 Mobile ergonomics

Everything stacks and nothing overflows at 390px — that was verified for *fit*, not for *touch*. The
roster's capability chips and the Studio's step list need thumb-sized targets and a considered order.

## 4. Super-admin-only: the audit

Confirmed at the time of writing:

| Surface | Read | Write |
|---|---|---|
| Agents roster | `tickets:view` | **SUPER_ADMIN** (create, install, patch, retire) |
| Workflow Studio | `tickets:view` | **SUPER_ADMIN** (create, patch, activate, retire) |
| AI capabilities / autonomy | SUPER_ADMIN | **SUPER_ADMIN** |
| Goals | any signed-in user | `goals:manage` (admins, managers, team leads) |
| Inbox | own rows only | own rows only |

**Reading stays open on the two agentic surfaces on purpose.** "What is that teammate, and what has it
been doing to my work" is a fair question for the person whose work it touches, and hiding it would make
the automation feel like something done *to* the team. Every button that changes anything is
super-admin, enforced server-side and reflected in the UI.

Goals are deliberately **not** super-admin-only: a manager who cannot write the goals their team is
measured against has nothing to manage. If that should change, it is one line in the migration's grant
list plus a seed change — say so and it is done.

## 5. Sequence

1. **Per-step configuration** (§3.3) — without it flows cannot express a real rule, and the canvas would
   be a prettier way to build the same incomplete thing.
2. **The canvas** (§3.1).
3. **Dispatch and per-flow attribution** (§3.2) — after the builder can express what should fire.
4. **Run visibility and the cross-surface links** (§3.4).
5. **Workload/budget merge** (§3.5) and **mobile ergonomics** (§3.6).

Written in this order because each step makes the next honest: a canvas over unconfigurable steps, or
dispatch of flows nobody can inspect afterwards, would both be features that demo well and disappoint.
