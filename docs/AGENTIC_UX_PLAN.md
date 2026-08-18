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

### 3.1 The n8n-style canvas — **shipped**

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
- **What was built:** `components/FlowCanvas.tsx` — hand-built SVG with pan/zoom, draggable node cards,
  elbow connectors with arrowheads (bezier curves become a tangle past a handful of edges — the timeline
  made this call already), a per-kind card treatment, and a config panel below the surface for whichever
  node is selected. Dropping a card past another reorders the sequence, exactly as decided above.
  **Still open:** a branch node that renders two visible lanes — today a `BRANCH` reads as a condition in
  the sequence rather than as a fork, which is honest about what the runtime does but less legible than
  the reference.
- **The authority banner stays pinned above the canvas.** On a canvas it is easy to lose the one fact
  that matters most; the banner is not a panel somebody has to open.
- **Below `lg` the canvas is not offered at all** — it degrades to the list, the same decision the Gantt
  made rather than shipping a squashed chart.

### 3.2 Flow dispatch, and per-flow AI attribution — **shipped**

**Decision taken: dispatch is opt-in per flow and observable before it is trusted.** Nothing fires
until an administrator activates a flow, and every run is a row anybody with `tickets:view` can read.

- `EVENT` triggers are wired to `domain-events.ts` (one subscriber, filtered by what flows exist rather
  than by what the file was compiled knowing about), `SCHEDULE` to a per-minute `runForEveryOrg` sweep,
  and `MANUAL` to a **Run now** button on the flow's card. **`FORM_SUBMISSION` is still not wired** —
  the trigger validates and simulates, and no dispatcher listens for it yet.
- **`triggerKey` carries the subject id** (`flow:<id>:ticket:<id>`). A doubled event is one run; a second
  ticket is a second run. Without the subject in the key the first ticket through a flow would be the
  only one it ever touched.
- **`AgentRun.flowId`** (nullable, `SET NULL` on retire) is the join behind per-workflow spend in
  Workspace Settings → AI. It is read from `AgentRun`, not `AIUsageLog`, because the usage log records
  what was asked of a model and not who composed the question — the panel says so on its face.
- **A first-run summary** goes to whoever authored the flow, once. A notification per run is the thing
  people mute, and muting it costs them the one that mattered.
- **A gate stops the run and resumes from its own row**, so an approval can take days and survive a
  restart. Only the person the step named may clear it, enforced server-side.
- **Known limit, deliberate:** a proposal-only flow routes an assignment into `AiProposal` but can only
  **hold** a label — the review queue's change vocabulary has no LABEL target. The step reports that in
  words rather than applying it anyway or skipping it quietly. Giving proposals a LABEL target is the
  fix, and it is a change to the proposal engine, not to the Studio.

### 3.3 Per-step configuration in the builder — **shipped**

`GET /flows/catalogue` now returns the people, labels and projects the pickers need alongside the
capability catalogue, and `validateStepConfig` in `flow-authority.service.ts` refuses an unconfigured
step as an activation error. The flow list shows a server-resolved summary per step ("Assigns it to
Sam"), so the review surface never renders a uuid — and never has to fetch the entitlement-gated
catalogue to be legible.

**Decision taken: the condition vocabulary is the rules engine's existing one** (`TicketRule`'s fields),
not a new expression language. A second condition grammar is a second thing to secure and a second thing
to explain. Shipped as `priority`, `source`, `projectId` and `senderDomain`, each with `is` / `is not`.

**Agent identities are excluded from every people picker.** Assigning work to a teammate is a real idea,
but "who approves this gate" and "who is notified" are questions about a person, and an identity with no
mailbox can answer neither.

### 3.4 Run visibility, and the missing links between surfaces — **shipped**

**A correction to this plan, found while building it:** the item read "`AgentRunStep` already stores it;
nothing renders it". That was wrong — a full run trace with steps, cost, level and the taint warning has
existed all along in **Workspace Settings → AI → Agent runs**. What was actually missing was the rest of
the chain, so the work became extending that panel rather than building a second one. No new
`/agents/runs` endpoint: the existing `/agent-runs` routes gained the filters and the chain.

- **The chain is navigable end to end.** A run's trace now shows the proposal it produced, that
  proposal's status, and each change with whether it was applied — plus a link that opens it in the
  review queue. `/app/proposals?focus=<id>` highlights and scrolls to one, and widens the status filter
  to *All*, because somebody following such a link is usually asking what became of a suggestion that is
  no longer pending. A flow run's step links the same way: `see the suggestion`, `see the run`.
- **`AutomationFlowRunStep.proposalId`** (one nullable column) is what made the first arrow followable.
  The capability steps never needed it — `AgentRun.proposalId` already carried it — but a deterministic
  action that the flow itself routed into the review queue has no agent run to carry anything.
- **A run also shows its ledger row**: what it cost, and how much human work it stands in for, or that
  the displacement is not measurable. Absent is normal and says so rather than showing a zero.
- **Ledger history**: 30 days of cost and displaced minutes on the roster page, zero-filled server-side
  with `measuredDays` reported beside it, over a list of the recent entries and each one's basis. The
  card hides itself when the ledger is empty. Verified by unit test and by the endpoint's own response;
  **not yet seen rendered with data**, because this workspace has no completed agent runs to draw (no AI
  provider key is configured in development).
- **One "AI in this workspace" landing** at `/app/ai`, super-admin: the four surfaces as a numbered
  sequence — what the AI may do, who does it, when it happens, what you accept — each with real counts
  and a link, over one honest next step. Every figure is a COUNT rather than a score: a score needs a
  rule for what healthy is, and the honest answer depends on what the workspace wants.

### 3.5 The workload and budget merge — **shipped**

**A bug found while building it, and the reason this could not simply be "add a second series":** an AI
teammate is an ACTIVE `User` row, and the workload board's people query said only "active and not
deleted". Every teammate was therefore already on the board as a colleague with the workspace's default
capacity and nothing booked — a permanently idle person nobody hired. Fixed with the same `isAgent:
false` that `seat-count.service.ts` uses, and pinned by a test, because it is invisible in a workspace
with no agents and obvious in one with six.

- **Agent work is its own section below the board, not extra rows in it.** Every column of a
  `WorkloadRow` is about capacity, and an agent has none — there is no weekly hours figure, no leave,
  and so no allocation percentage that means anything. A board where some rows' percentages meant a
  different thing from others' would be worse than two sections. The agent section shows cost and
  wall-clock time per week, and says "not measurable here" rather than 0 where no baseline exists.
- **Agent spend appears beside a project's burn and never inside it.** Three reasons, each sufficient:
  none of it is billable, so folding it in would invoice a client for a model call; it is always in US
  dollars while a budget may be in any currency and this code holds no exchange rate; and a budget is an
  agreement about labour, while model spend is a cost of running the workspace. The panel says so, and
  hides the line entirely when no teammate has worked on that project — a $0.00 row invites addition.
- Read from the **ledger**, not from `AgentRun`, in both places: the ledger is where this product already
  decided agent work is recorded against a project, and a second definition of "what an agent did" is a
  number nobody can reconcile.

### 3.6 Mobile ergonomics — **shipped**

Verified by measurement rather than by eye: a script walks every button, link, summary, tab and combobox
on the four agentic screens at 390px, scrolls each into view, and **hit-tests** the points a thumb would
land on. All four now report zero targets under 44px.

- **The minimums are in pixels, not rem.** This app's root font is 14px, so every rem-based size utility
  lands at 14/16 of its nominal value — `h-11` is 38.5px, not 44. That was measured, not assumed, and it
  is why the first attempt looked correct and was not.
- **Hit area, not visual size, where a control is shared.** The roster's switch (39×21) and the dialog's
  close glyph (14×14) belong to every form in the product, so their hit areas are grown with a
  pseudo-element and nothing on screen moves. A first attempt wrapped the switch in a `<label>` — which
  does *not* forward a click to a Radix switch, because that renders a button rather than an input. It
  would have looked right and done nothing.
- **Density is untouched above `sm`.** These screens are for a super admin at a desk; the mobile
  minimums are behind a breakpoint so the desktop stays as dense as it was.
- **Deliberately not changed:** the shared `Input`/`Select`/`Button` default heights (35px at this root
  size). Raising those is a product-wide design decision touching every form in the app, not a mobile
  fix for the agentic screens — and at full width a 35px target is a very different proposition from a
  21px one.

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

1. ~~**Per-step configuration** (§3.3)~~ — shipped.
2. ~~**The canvas** (§3.1)~~ — shipped, less the two-lane branch node.
3. ~~**Dispatch and per-flow attribution** (§3.2)~~ — shipped, less the `FORM_SUBMISSION` trigger.
4. ~~**Run visibility and the cross-surface links** (§3.4)~~ — shipped.
5. ~~**Workload/budget merge** (§3.5) and **mobile ergonomics** (§3.6)~~ — shipped.

**This plan is complete, and so are the three gaps it carried forward** — all closed in phase 10
(2026-08-18), recorded in [ROADMAP.md](ROADMAP.md):

- The `FORM_SUBMISSION` trigger has its own dispatcher, hooked into the public intake rather than the
  event bus, because a flow on this trigger matches on a FORM and a `ticket.created` payload has no
  form in it.
- A `BRANCH` draws a dashed second arm to a "does not match — flow stops" terminus. Not two columns of
  steps: the runtime stops the run, and a second column would draw a path this engine cannot take.
- The review queue has a `TICKET_LABEL` change target, so a proposal-only flow proposes a label rather
  than reporting it held. This one mattered most: a triage flow that reads inbound email is
  proposal-only *by construction*, so the commonest useful flow was the one that could do nothing.

What remains against this product's agentic ambition is **not** in this plan and is not pending work:
TimeSphere as an MCP *client* (phase 6 of the mechanism doc, "scoped, not committed") and calendar
sync. Both are new scope with their own security surface, and both need a decision rather than a
sprint.

Written in this order because each step makes the next honest: a canvas over unconfigurable steps, or
dispatch of flows nobody can inspect afterwards, would both be features that demo well and disappoint.
