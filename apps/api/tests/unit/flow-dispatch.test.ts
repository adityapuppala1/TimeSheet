/**
 * Dispatch: the point where a composed flow stops being a description and starts changing things.
 *
 * `flow-authority.test.ts` pins what a flow is ALLOWED to do; this pins that the dispatcher obeys it,
 * and that the two ways a run can be doubled — the same event twice, and two subjects through one flow
 * — are told apart. Specifically:
 *
 *   - The idempotency key carries the SUBJECT, so a doubled event is one run and a second ticket is a
 *     second run. Getting this wrong makes the first ticket the only ticket a flow ever touches.
 *   - A failing condition STOPS the flow, and everything after it is recorded as not-reached rather
 *     than left absent — an absent step reads as "nothing was there".
 *   - A gate stops the run in WAITING and asks the person the step named.
 *   - A proposal-only flow proposes what the review queue can hold, and HOLDS what it cannot. It never
 *     applies either.
 *   - A capability step queues an ordinary agent run carrying the flow id, which is what puts the
 *     spend in AI usage analytics under the flow's name.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiAutonomyLevel } from "@prisma/client";

const flowRunFindUnique = vi.fn().mockResolvedValue(null);
const flowRunCreate = vi.fn();
const flowRunUpdate = vi.fn().mockResolvedValue({});
const flowRunCount = vi.fn().mockResolvedValue(1);
const stepCreate = vi.fn().mockResolvedValue({});
const stepDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
const ticketFindUnique = vi.fn();
const ticketUpdate = vi.fn().mockResolvedValue({});
const ticketLabelFindFirst = vi.fn().mockResolvedValue(null);
const ticketLabelCreate = vi.fn().mockResolvedValue({});

const getFlow = vi.fn();
const queueAgentRun = vi.fn().mockResolvedValue({ runId: "run-1", created: true });
const createProposal = vi.fn().mockResolvedValue({ id: "prop-1234abcd" });
const dispatchNotification = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    automationFlowRun: {
      findUnique: (...a: unknown[]) => flowRunFindUnique(...a),
      create: (...a: unknown[]) => flowRunCreate(...a),
      update: (...a: unknown[]) => flowRunUpdate(...a),
      count: (...a: unknown[]) => flowRunCount(...a)
    },
    automationFlowRunStep: { create: (...a: unknown[]) => stepCreate(...a), deleteMany: (...a: unknown[]) => stepDeleteMany(...a) },
    ticket: { findUnique: (...a: unknown[]) => ticketFindUnique(...a), update: (...a: unknown[]) => ticketUpdate(...a) },
    ticketLabel: { findFirst: (...a: unknown[]) => ticketLabelFindFirst(...a), create: (...a: unknown[]) => ticketLabelCreate(...a) },
    agentProfile: { findUnique: vi.fn().mockResolvedValue(null) },
    automationFlow: { findMany: vi.fn().mockResolvedValue([]) }
  }
}));
vi.mock("../../src/services/automation-flow.service.js", () => ({ getFlow: (...a: unknown[]) => getFlow(...a) }));
vi.mock("../../src/services/agent-run.service.js", () => ({ queueAgentRun: (...a: unknown[]) => queueAgentRun(...a) }));
vi.mock("../../src/services/ai-proposal.service.js", () => ({ createProposal: (...a: unknown[]) => createProposal(...a) }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: (...a: unknown[]) => dispatchNotification(...a) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { startFlowRun } = await import("../../src/services/automation-dispatch.service.js");
const { cronMatches } = await import("../../src/workers/flow-schedule.worker.js");

type Step = { id: string; order: number; kind: string; capability: string | null; title: string | null; summary: string | null; config: Record<string, unknown> };

/** A decorated flow, as `getFlow` returns one. `proposalOnly` is passed explicitly because it is the
 *  single fact the dispatcher branches on. */
const flow = (steps: Array<Partial<Step>>, over: { proposalOnly?: boolean } = {}) => ({
  id: "flow-1",
  name: "Triage inbound",
  emoji: "X",
  enabled: true,
  activatable: true,
  agentProfile: null,
  createdBy: { id: "author-1", name: "Avery", email: "a@x.io" },
  steps: steps.map((s, i) => ({
    id: `s-${i}`,
    order: i + 1,
    kind: "ACTION",
    capability: null,
    title: null,
    summary: null,
    config: {},
    ...s
  })),
  authority: {
    effectiveLevel: "AUTO_APPLY" as AiAutonomyLevel,
    limitedBy: null,
    taintedFrom: null,
    proposalOnly: over.proposalOnly ?? false,
    gatedBeforeWrites: false,
    steps: []
  },
  issues: []
});

const subject = { type: "ticket" as const, id: "t-1", label: "TCK-9 - the printer" };

const outcomes = () => stepCreate.mock.calls.map((c) => [c[0].data.order, c[0].data.outcome]);

beforeEach(() => {
  vi.clearAllMocks();
  flowRunFindUnique.mockResolvedValue(null);
  flowRunCreate.mockResolvedValue({ id: "fr-1" });
  flowRunUpdate.mockResolvedValue({});
  // The first-run announcement asks how many OTHER runs exist; a non-zero answer keeps most tests
  // from also asserting on a notification they are not about.
  flowRunCount.mockResolvedValue(1);
  queueAgentRun.mockResolvedValue({ runId: "run-1", created: true });
  ticketFindUnique.mockResolvedValue({ assigneeId: "old-1", key: "TCK-9", projectId: "p-1", priority: "HIGH", source: "EMAIL", externalReporterEmail: "sam@acme.io", reporter: { email: "intake@ours.io" } });
});

describe("one occurrence, one run", () => {
  it("returns the existing run instead of starting a second for the same key", async () => {
    flowRunFindUnique.mockResolvedValue({ id: "fr-existing" });
    getFlow.mockResolvedValue(flow([{ kind: "ACTION", config: { action: "notify", notifyUserId: "u-1" } }]));

    const result = await startFlowRun({ flowId: "flow-1", trigger: "event:ticket.created", subject, triggerKey: "flow:flow-1:ticket:t-1" });

    expect(result).toEqual({ runId: "fr-existing", created: false });
    expect(flowRunCreate).not.toHaveBeenCalled();
  });

  it("still runs for a different subject, because the key carries the subject id", async () => {
    getFlow.mockResolvedValue(flow([{ kind: "ACTION", config: { action: "notify", notifyUserId: "u-1" } }]));
    await startFlowRun({ flowId: "flow-1", trigger: "event:ticket.created", subject, triggerKey: "flow:flow-1:ticket:t-1" });
    await startFlowRun({
      flowId: "flow-1",
      trigger: "event:ticket.created",
      subject: { ...subject, id: "t-2" },
      triggerKey: "flow:flow-1:ticket:t-2"
    });
    expect(flowRunCreate).toHaveBeenCalledTimes(2);
  });
});

describe("a condition that does not match stops the flow", () => {
  it("marks the branch skipped and everything after it not-reached", async () => {
    getFlow.mockResolvedValue(
      flow([
        { kind: "BRANCH", config: { field: "priority", op: "is", value: "CRITICAL" } },
        { kind: "ACTION", config: { action: "assign", assigneeId: "u-9" } }
      ])
    );

    await startFlowRun({ flowId: "flow-1", trigger: "manual", subject, triggerKey: "k1" });

    expect(outcomes()).toEqual([
      [1, "skipped"],
      [2, "not-reached"]
    ]);
    expect(ticketUpdate).not.toHaveBeenCalled();
    expect(flowRunUpdate.mock.calls.at(-1)?.[0].data.status).toBe("STOPPED");
  });

  it("runs on through a condition that matches", async () => {
    getFlow.mockResolvedValue(
      flow([
        { kind: "BRANCH", config: { field: "priority", op: "is", value: "HIGH" } },
        { kind: "ACTION", config: { action: "assign", assigneeId: "u-9" } }
      ])
    );
    await startFlowRun({ flowId: "flow-1", trigger: "manual", subject, triggerKey: "k2" });
    expect(ticketUpdate).toHaveBeenCalledWith({ where: { id: "t-1" }, data: { assigneeId: "u-9" } });
  });

  it("reads the real sender for a senderDomain condition, not the intake system user", async () => {
    getFlow.mockResolvedValue(
      flow([{ kind: "BRANCH", config: { field: "senderDomain", op: "is", value: "acme.io" } }, { kind: "ACTION", config: { action: "notify", notifyUserId: "u-1" } }])
    );
    await startFlowRun({ flowId: "flow-1", trigger: "manual", subject, triggerKey: "k3" });
    expect(outcomes()[0]).toEqual([1, "ran"]);
  });

  it("fails rather than guessing when the condition cannot be evaluated", async () => {
    getFlow.mockResolvedValue(
      flow([{ kind: "BRANCH", config: { field: "priority", op: "is", value: "HIGH" } }, { kind: "ACTION", config: { action: "notify", notifyUserId: "u-1" } }])
    );
    await startFlowRun({
      flowId: "flow-1",
      trigger: "cron",
      subject: { type: "workspace", id: null, label: "the schedule" },
      triggerKey: "k4"
    });
    expect(outcomes()[0]).toEqual([1, "failed"]);
    expect(flowRunUpdate.mock.calls.at(-1)?.[0].data.status).toBe("FAILED");
  });
});

describe("a gate stops the run and asks the person it named", () => {
  it("waits, records what is behind it, and notifies the approver", async () => {
    getFlow.mockResolvedValue(
      flow([
        { kind: "HUMAN_GATE", config: { approverId: "boss-1" } },
        { kind: "ACTION", config: { action: "assign", assigneeId: "u-9" } }
      ])
    );

    await startFlowRun({ flowId: "flow-1", trigger: "manual", subject, triggerKey: "k5" });

    expect(outcomes()).toEqual([
      [1, "waiting"],
      [2, "not-reached"]
    ]);
    expect(ticketUpdate).not.toHaveBeenCalled();
    const update = flowRunUpdate.mock.calls.at(-1)?.[0].data;
    expect(update).toMatchObject({ status: "WAITING", awaitingOrder: 1, awaitingUserId: "boss-1" });
    expect(dispatchNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: "boss-1" }));
  });
});

describe("a proposal-only flow proposes, and never applies", () => {
  it("routes an assignment into the review queue instead of writing it", async () => {
    getFlow.mockResolvedValue(flow([{ kind: "ACTION", config: { action: "assign", assigneeId: "u-9" } }], { proposalOnly: true }));

    await startFlowRun({ flowId: "flow-1", trigger: "manual", subject, triggerKey: "k6" });

    expect(ticketUpdate).not.toHaveBeenCalled();
    expect(outcomes()[0]).toEqual([1, "proposed"]);
    // The state it was computed against travels with it, or application cannot check for staleness.
    expect(createProposal.mock.calls[0][0].changes[0]).toMatchObject({ before: { assigneeId: "old-1" }, after: { assigneeId: "u-9" } });
  });

  it("HOLDS a label rather than applying one the review queue cannot express", async () => {
    getFlow.mockResolvedValue(flow([{ kind: "ACTION", config: { action: "label", labelId: "l-1" } }], { proposalOnly: true }));

    await startFlowRun({ flowId: "flow-1", trigger: "manual", subject, triggerKey: "k7" });

    expect(ticketLabelCreate).not.toHaveBeenCalled();
    expect(createProposal).not.toHaveBeenCalled();
    expect(outcomes()[0]).toEqual([1, "held"]);
    expect(stepCreate.mock.calls[0][0].data.detail).toMatch(/may only propose/i);
  });

  it("still notifies, because telling somebody something changes nothing", async () => {
    getFlow.mockResolvedValue(flow([{ kind: "ACTION", config: { action: "notify", notifyUserId: "u-3" } }], { proposalOnly: true }));
    await startFlowRun({ flowId: "flow-1", trigger: "manual", subject, triggerKey: "k8" });
    expect(outcomes()[0]).toEqual([1, "ran"]);
    expect(dispatchNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-3" }));
  });
});

describe("a capability step queues an ordinary agent run", () => {
  it("carries the flow id, which is what attributes the spend to this flow", async () => {
    getFlow.mockResolvedValue(flow([{ kind: "CAPABILITY", capability: "triage" }]));

    await startFlowRun({ flowId: "flow-1", trigger: "manual", subject, triggerKey: "k9" });

    expect(queueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "triage", flowId: "flow-1", onBehalfOfId: "author-1", triggerKey: "flowrun:fr-1:step:1" })
    );
    expect(outcomes()[0]).toEqual([1, "queued"]);
  });

  it("records a refused run as a failed step rather than losing it", async () => {
    const { AppError } = await import("../../src/middleware/error.js");
    queueAgentRun.mockRejectedValue(new AppError(429, "has already run 5 time(s) in the last 24 hours"));
    getFlow.mockResolvedValue(flow([{ kind: "CAPABILITY", capability: "triage" }]));

    await startFlowRun({ flowId: "flow-1", trigger: "manual", subject, triggerKey: "k10" });

    expect(outcomes()[0]).toEqual([1, "failed"]);
    expect(stepCreate.mock.calls[0][0].data.detail).toMatch(/24 hours/);
  });
});

describe("the first run announces itself, and only the first", () => {
  it("tells the author what happened when nothing has run before", async () => {
    flowRunCount.mockResolvedValue(0);
    flowRunFindUnique.mockImplementation(async (args: { where: { triggerKey?: string; id?: string } }) =>
      args.where.id
        ? { id: "fr-1", flowId: "flow-1", summary: "1 applied", status: "COMPLETED", subjectLabel: "TCK-9", flow: { name: "Triage inbound", emoji: "X", createdById: "author-1" } }
        : null
    );
    getFlow.mockResolvedValue(flow([{ kind: "ACTION", config: { action: "assign", assigneeId: "u-9" } }]));

    await startFlowRun({ flowId: "flow-1", trigger: "manual", subject, triggerKey: "k11" });

    expect(dispatchNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: "author-1", title: expect.stringMatching(/first time/i) }));
  });
});

describe("the cron matcher", () => {
  const at = (iso: string) => new Date(iso);

  it("matches an exact minute and hour", () => {
    expect(cronMatches("30 9 * * *", at("2026-08-17T09:30:00"))).toBe(true);
    expect(cronMatches("30 9 * * *", at("2026-08-17T09:31:00"))).toBe(false);
  });

  it("handles steps, ranges and lists", () => {
    expect(cronMatches("*/15 * * * *", at("2026-08-17T09:45:00"))).toBe(true);
    expect(cronMatches("*/15 * * * *", at("2026-08-17T09:46:00"))).toBe(false);
    expect(cronMatches("0 9-17 * * *", at("2026-08-17T13:00:00"))).toBe(true);
    expect(cronMatches("0 9-17 * * *", at("2026-08-17T18:00:00"))).toBe(false);
    expect(cronMatches("0 9 * * 1,5", at("2026-08-17T09:00:00"))).toBe(true); // a Monday
    expect(cronMatches("0 9 * * 1,5", at("2026-08-19T09:00:00"))).toBe(false); // a Wednesday
  });

  it("ORs day-of-month against day-of-week when both are restricted, as every crontab does", () => {
    // The 1st, and every Monday. 2026-08-17 is a Monday and not the 1st.
    expect(cronMatches("0 9 1 * 1", at("2026-08-17T09:00:00"))).toBe(true);
    expect(cronMatches("0 9 1 * 1", at("2026-08-01T09:00:00"))).toBe(true);
    expect(cronMatches("0 9 1 * 1", at("2026-08-19T09:00:00"))).toBe(false);
  });

  it("refuses an expression it cannot parse rather than firing on every minute", () => {
    expect(cronMatches("not a cron", at("2026-08-17T09:00:00"))).toBe(false);
    expect(cronMatches("0 9 * *", at("2026-08-17T09:00:00"))).toBe(false);
    expect(cronMatches("", at("2026-08-17T09:00:00"))).toBe(false);
  });
});

describe("a run that could not do something does not call itself Done", () => {
  it("settles as FAILED and says so in the summary", async () => {
    getFlow.mockResolvedValue(
      flow([
        { kind: "ACTION", config: { action: "notify", notifyUserId: "u-1" } },
        // No ticket to change, which is what a manual run against the workspace means.
        { kind: "ACTION", config: { action: "assign", assigneeId: "u-9" } }
      ])
    );

    await startFlowRun({
      flowId: "flow-1",
      trigger: "manual",
      subject: { type: "workspace", id: null, label: "a manual run" },
      triggerKey: "k12"
    });

    const settled = flowRunUpdate.mock.calls.at(-1)?.[0].data;
    expect(settled.status).toBe("FAILED");
    expect(settled.summary).toMatch(/1 could not be done/);
  });
});
