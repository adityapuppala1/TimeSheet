/**
 * Email intake: the loop guard, the confirmation, and replies.
 *
 * Every unseen message used to become a NEW ticket and earn a confirmation email, whoever or
 * whatever sent it. Two consequences, both pinned here:
 *
 *  1. A LOOP. Another helpdesk's acknowledgement, an out-of-office or a bounce, arriving from an
 *     auto-responding mailbox, became a ticket; our confirmation went back; their autoresponder
 *     answered it; that became a ticket… RFC 3834 says how to tell automated mail apart
 *     (Auto-Submitted, Precedence bulk/junk, the null return path, the daemon senders) and how to mark
 *     our own reply so the other side's guard can do the same (Auto-Submitted: auto-replied).
 *     Mailing-list markers (List-Id, Precedence: list) are NOT among them: support@ as a Google Group
 *     stamps both on every customer message, and dropping on them discarded real mail.
 *  2. NO THREADING. A customer's "Re: …" to their own confirmation opened a second ticket. A reply
 *     that answers our confirmation (In-Reply-To / References) or names its ticket in the subject as
 *     `[WEB-12]` is now added to that ticket as a comment instead.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/ai.service.js", () => ({
  EXTERNAL_INTAKE_CONFIDENCE_CEILING: 0.85,
  classifyTicket: vi.fn().mockResolvedValue({ type: "BUG", priority: "MEDIUM", moduleId: null, confidence: 0.9, reasoning: "ok" }),
  getGlobalAISettings: vi.fn().mockResolvedValue({ confidenceThreshold: 0.5 })
}));
const auditSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/audit.service.js", () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));
const notifySpy = vi.fn().mockResolvedValue(undefined);
const transactionalSpy = vi.fn().mockResolvedValue({ ok: true });
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: (...a: unknown[]) => notifySpy(...a),
  dispatchTransactional: (...a: unknown[]) => transactionalSpy(...a),
  templates: new Proxy({}, { get: () => () => "<html>body</html>" })
}));
vi.mock("../../src/services/virus-scan.service.js", () => ({ assertUploadIsClean: vi.fn().mockResolvedValue({ clean: true }) }));
const transitionSpy = vi.fn().mockResolvedValue({});
vi.mock("../../src/services/ticket-transition.service.js", () => ({ transitionTicketStatus: (...a: unknown[]) => transitionSpy(...a) }));

const { automatedDropSummary, processInboundEmail, ticketConfirmationMessageId } = await import("../../src/services/email-intake.service.js");
const { classifyTicket } = await import("../../src/services/ai.service.js");

const SYSTEM_USER = { id: "intake-system-user", email: "email-intake@system.local", name: "Email Intake" };
const EXISTING = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  key: "WEB-12",
  title: "Login broken",
  type: "BUG",
  projectId: "proj-1",
  source: "EMAIL",
  externalReporterEmail: "customer@example.com",
  reporterId: SYSTEM_USER.id,
  assigneeId: "assignee-1",
  status: "IN_PROGRESS",
  deletedAt: null,
  watchers: [],
  collaborators: []
};

let client: PrismaClient;
let ticketCreate: ReturnType<typeof vi.fn>;
let commentCreate: ReturnType<typeof vi.fn>;
let linkCreate: ReturnType<typeof vi.fn>;
/** Per-test changes to the existing ticket a reply threads onto — its status, who is on it. */
let ticketOverrides: Record<string, unknown> = {};

function buildClient(): PrismaClient {
  ticketCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-ticket", ...data }));
  commentCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "comment-1", createdAt: new Date(), ...data }));
  linkCreate = vi.fn().mockResolvedValue({});
  const self: Record<string, unknown> = {
    emailRoutingRule: { findMany: vi.fn().mockResolvedValue([]) },
    emailIntakeSettings: {
      upsert: vi.fn().mockResolvedValue({ id: "global", fallbackProjectId: "proj-1", imapUser: "support@acme.test" }),
      findUnique: vi.fn().mockResolvedValue(null)
    },
    project: { findUnique: vi.fn().mockResolvedValue({ id: "proj-1", code: "WEB", modules: [] }), update: vi.fn().mockResolvedValue({ code: "WEB", ticketSeq: 13 }) },
    ticketType: { findMany: vi.fn().mockResolvedValue([{ name: "BUG" }]) },
    user: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, string> }) => (where.email === SYSTEM_USER.email || where.id === SYSTEM_USER.id ? SYSTEM_USER : null)),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null)
    },
    globalTicketSettings: { upsert: vi.fn().mockResolvedValue({ slaLowHours: 1, slaMediumHours: 1, slaHighHours: 1, slaCriticalHours: 1 }) },
    ticket: {
      create: ticketCreate,
      update: vi.fn().mockResolvedValue({}),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        (where.key === EXISTING.key || where.id === EXISTING.id) ? { ...EXISTING, ...ticketOverrides } : null
      )
    },
    ticketComment: { create: commentCreate },
    ticketLink: { create: linkCreate },
    ticketAttachment: { create: vi.fn().mockResolvedValue({}) },
    moduleAssigneeRule: { findUnique: vi.fn().mockResolvedValue(null) },
    userProjectAssignment: { findFirst: vi.fn().mockResolvedValue(null) }
  };
  self.$transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(self));
  return self as unknown as PrismaClient;
}

function email(overrides: Record<string, unknown> = {}) {
  return {
    from: { address: "customer@example.com", name: "Casey Customer" },
    to: ["support@acme.test"],
    subject: "Login broken",
    text: "I cannot sign in since this morning.",
    attachments: [],
    ...overrides
  };
}

const run = (overrides: Record<string, unknown> = {}) => runInTenant(client, () => processInboundEmail(email(overrides) as any), "org-1", "acme");

beforeEach(() => {
  vi.clearAllMocks();
  ticketOverrides = {};
  client = buildClient();
});

describe("automated mail is dropped before it can start a loop", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["Auto-Submitted: auto-replied", { headers: { autoSubmitted: "auto-replied" } }, "Auto-Submitted: auto-replied"],
    ["Auto-Submitted: auto-generated", { headers: { autoSubmitted: "auto-generated" } }, "Auto-Submitted: auto-generated"],
    ["Precedence: bulk", { headers: { precedence: "bulk" } }, "Precedence: bulk"],
    ["Precedence: junk", { headers: { precedence: "junk" } }, "Precedence: junk"],
    ["a mailer-daemon sender", { from: { address: "MAILER-DAEMON@mx.example.com" } }, "a mailer-daemon sender"],
    ["a postmaster sender", { from: { address: "postmaster@example.com" } }, "a postmaster sender"],
    ["a null return path", { headers: { returnPath: "<>" } }, "a null return path"]
  ];

  for (const [label, overrides, reason] of cases) {
    it(`${label}: no ticket, no confirmation, and the drop is recorded with its reason`, async () => {
      const result = await run(overrides);
      expect(result).toMatchObject({ created: false, reason: "AUTOMATED_SENDER" });
      expect(ticketCreate).not.toHaveBeenCalled();
      expect(transactionalSpy).not.toHaveBeenCalled();
      // The drop used to leave nothing but a console line. It is now on the record the intake
      // settings read their "dropped N automated messages" status from.
      expect(auditSpy).toHaveBeenCalledWith(
        undefined,
        "email_intake.automated_dropped",
        "EmailIntakeSettings",
        "global",
        expect.objectContaining({ reason }),
        expect.objectContaining({ actorType: "INTEGRATION", actorLabel: "email-intake" })
      );
    });
  }

  it("Auto-Submitted: no is a person, and is processed", async () => {
    const result = await run({ headers: { autoSubmitted: "no", returnPath: "<customer@example.com>" } });
    expect(result.created).toBe(true);
  });
});

describe("mail delivered through a mailing list is a person's mail", () => {
  // support@ as a Google Group with the polled mailbox as a member is a common setup, and every
  // customer message then carries List-Id and Precedence: list. Dropping on those discarded all of it.
  it("Precedence: list becomes a ticket", async () => {
    const result = await run({ headers: { precedence: "list" } });
    expect(result.created).toBe(true);
  });

  it("a List-Id header becomes a ticket", async () => {
    const result = await run({ headers: { listId: "support.acme.test" } });
    expect(result.created).toBe(true);
  });

  it("a Google-Groups-shaped message, parsed from its raw source, becomes a ticket and is confirmed", async () => {
    const { simpleParser } = await import("mailparser");
    const { toParsedInboundEmail } = await import("../../src/workers/inbound-email.worker.js");
    const raw = [
      "Return-Path: <support+bncBXYZ@acme.test>",
      "From: Jane Customer <jane@customer.example>",
      "To: support@acme.test",
      "Subject: Printer is on fire",
      "Message-ID: <abc@customer.example>",
      "Mailing-list: list support@acme.test; contact support+owners@acme.test",
      "List-ID: <support.acme.test>",
      "List-Post: <mailto:support@acme.test>",
      "Precedence: list",
      "Content-Type: text/plain",
      "",
      "Hello, my printer is on fire."
    ].join("\r\n");
    const parsed = toParsedInboundEmail(await simpleParser(raw));
    const result = await runInTenant(client, () => processInboundEmail(parsed), "org-1", "acme");
    expect(result.created).toBe(true);
    expect(ticketCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ title: "Printer is on fire", externalReporterEmail: "jane@customer.example" }) }));
    expect(transactionalSpy).toHaveBeenCalledWith(expect.objectContaining({ to: "jane@customer.example" }));
  });
});

describe("the dropped-mail status", () => {
  it("counts every recorded drop and names the most recent one's reason", async () => {
    const lastAt = new Date("2026-10-02T09:00:00Z");
    (client as any).auditLog = {
      count: vi.fn().mockResolvedValue(3),
      findFirst: vi.fn().mockResolvedValue({ createdAt: lastAt, metadata: { reason: "Auto-Submitted: auto-replied", from: "ooo@vendor.test" } })
    };
    const summary = await runInTenant(client, () => automatedDropSummary());
    expect(summary).toEqual({ count: 3, lastReason: "Auto-Submitted: auto-replied", lastFrom: "ooo@vendor.test", lastAt });
    expect((client as any).auditLog.count).toHaveBeenCalledWith({ where: expect.objectContaining({ action: "email_intake.automated_dropped" }) });
  });

  it("is zero, with no last reason, before anything was dropped", async () => {
    (client as any).auditLog = { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) };
    const summary = await runInTenant(client, () => automatedDropSummary());
    expect(summary).toEqual({ count: 0, lastReason: null, lastFrom: null, lastAt: null });
  });
});

describe("the confirmation", () => {
  it("is stamped Auto-Submitted: auto-replied so the far side's guard ignores it", async () => {
    await run();
    expect(transactionalSpy).toHaveBeenCalledWith(expect.objectContaining({ headers: expect.objectContaining({ "Auto-Submitted": "auto-replied" }) }));
  });

  it("carries the ticket key in brackets in its subject, so a reply threads by subject too", async () => {
    await run();
    const call = transactionalSpy.mock.calls[0][0] as { fallback: { subject: string } };
    expect(call.fallback.subject).toContain("[WEB-13]");
  });

  it("carries a Message-ID a reply's In-Reply-To can be matched against", async () => {
    await run();
    const call = transactionalSpy.mock.calls[0][0] as { messageId: string };
    // The ticket id in the local part is what a reply is matched on; the host is the workspace's.
    expect(call.messageId).toMatch(/^<ticket-new-ticket\.confirmation@[^>]+>$/);
  });
});

describe("the needs-review email", () => {
  it("links the reviewer to the ticket itself, by id", async () => {
    vi.mocked(classifyTicket).mockResolvedValueOnce({ type: "BUG", priority: "MEDIUM", moduleId: null, confidence: 0.2, reasoning: "unsure" } as never);
    vi.mocked(client.user.findMany).mockResolvedValueOnce([{ id: "lead-1", name: "Lena Lead" }] as never);
    await run();
    const review = notifySpy.mock.calls.map((c) => c[0] as { category: string; email: { vars: Record<string, unknown> } }).find((n) => n.category === "ticket.needs_review");
    expect(review?.email.vars.ticketId).toBe("new-ticket");
  });
});

describe("a reply is added to its ticket instead of opening another", () => {
  it("by the [KEY] in its subject, from the original sender", async () => {
    const result = await run({ subject: "Re: [WEB-12] We received your report", text: "Also broken on mobile." });
    expect(result).toMatchObject({ created: false, appendedTo: "WEB-12" });
    expect(ticketCreate).not.toHaveBeenCalled();
    expect(commentCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ ticketId: EXISTING.id, authorId: SYSTEM_USER.id }) }));
    expect(String(commentCreate.mock.calls[0][0].data.body)).toContain("Also broken on mobile.");
    // A reply is not a new report: no second confirmation, which is also what keeps two
    // autoresponders from talking to each other through us.
    expect(transactionalSpy).not.toHaveBeenCalled();
  });

  it("by In-Reply-To matching the confirmation's Message-ID", async () => {
    const result = await run({
      subject: "Re: something the client rewrote",
      headers: { inReplyTo: ticketConfirmationMessageId(EXISTING.id, "mail.example.net") }
    });
    expect(result).toMatchObject({ created: false, appendedTo: "WEB-12" });
    expect(ticketCreate).not.toHaveBeenCalled();
  });

  it("by References, when In-Reply-To names a later message in the thread", async () => {
    const result = await run({
      subject: "Re: Re: Login broken",
      headers: { inReplyTo: "<some-other@mail.example.com>", references: ["<x@y>", ticketConfirmationMessageId(EXISTING.id, "mail.example.net")] }
    });
    expect(result).toMatchObject({ created: false, appendedTo: "WEB-12" });
  });

  it("NOT by a subject key from a different sender, who opens a ticket of their own", async () => {
    const result = await run({ from: { address: "stranger@elsewhere.test" }, subject: "[WEB-12] please delete my account" });
    expect(result.created).toBe(true);
    expect(commentCreate).not.toHaveBeenCalled();
  });

  it("NOT by a key that names no ticket", async () => {
    const result = await run({ subject: "Re: [WEB-999] hello" });
    expect(result.created).toBe(true);
  });
});

describe("a reply to a ticket that is already finished", () => {
  // "Still broken" threaded onto a RESOLVED or CLOSED ticket used to sit there as a comment: the
  // ticket stayed done, with no SLA clock and no place in anybody's queue.
  const reply = { subject: "Re: [WEB-12] We received your report", text: "Still broken after your fix." };

  it("RESOLVED: reopens it through the one ticket transition, as an automatic reopen, then adds the reply", async () => {
    ticketOverrides = { status: "RESOLVED" };
    const result = await run(reply);
    expect(result).toMatchObject({ created: false, appendedTo: "WEB-12" });
    expect(transitionSpy).toHaveBeenCalledWith(
      EXISTING.id,
      "REOPENED",
      expect.objectContaining({ via: "auto_reopen", label: "email-intake", reason: expect.stringContaining("reply by email") })
    );
    expect(commentCreate).toHaveBeenCalledTimes(1);
    // Reopened FIRST, so the comment lands on a live ticket and its notification follows the reopen.
    expect(transitionSpy.mock.invocationCallOrder[0]).toBeLessThan(commentCreate.mock.invocationCallOrder[0]);
    expect(ticketCreate).not.toHaveBeenCalled();
  });

  it("an open ticket is not moved — the reply is only added", async () => {
    await run(reply);
    expect(transitionSpy).not.toHaveBeenCalled();
    expect(commentCreate).toHaveBeenCalledTimes(1);
  });

  it("CLOSED: opens a NEW ticket that names the old one, relates the two, and confirms it like a first email", async () => {
    ticketOverrides = { status: "CLOSED" };
    const result = await run(reply);
    expect(result).toMatchObject({ created: true, ticketKey: "WEB-13", followUpTo: "WEB-12" });
    expect(commentCreate).not.toHaveBeenCalled();
    expect(transitionSpy).not.toHaveBeenCalled();
    const created = ticketCreate.mock.calls[0][0].data as Record<string, unknown>;
    expect(String(created.description)).toContain("Follow-up to WEB-12");
    expect(String(created.description)).toContain("Still broken after your fix.");
    expect(created).toMatchObject({ projectId: "proj-1", source: "EMAIL", externalReporterEmail: "customer@example.com" });
    expect(linkCreate).toHaveBeenCalledWith({ data: { sourceTicketId: "new-ticket", targetTicketId: EXISTING.id, type: "RELATES" } });
    expect(transactionalSpy).toHaveBeenCalledWith(expect.objectContaining({ to: "customer@example.com" }));
  });
});

describe("a reply that nobody on the ticket would hear about", () => {
  const reply = { subject: "Re: [WEB-12] We received your report", text: "Any news?" };

  it("reaches the project's triagers — the people the needs-review notice goes to", async () => {
    ticketOverrides = { assigneeId: null, watchers: [], collaborators: [] };
    vi.mocked(client.user.findMany).mockResolvedValueOnce([{ id: "lead-1", name: "Lena Lead" }] as never);
    await run(reply);
    const where = vi.mocked(client.user.findMany).mock.calls[0][0]!.where as Record<string, unknown>;
    expect(JSON.stringify(where)).toContain("proj-1");
    const told = notifySpy.mock.calls.map((c) => c[0] as { userId: string; category: string; link: string });
    expect(told).toEqual([expect.objectContaining({ userId: "lead-1", category: "ticket.commented", link: `/app/tickets?open=${EXISTING.id}` })]);
  });

  it("a watcher other than the intake account is somebody, so the triagers are not paged", async () => {
    ticketOverrides = { assigneeId: null, watchers: [{ userId: "watcher-1" }], collaborators: [] };
    await run(reply);
    expect(client.user.findMany).not.toHaveBeenCalled();
    expect(notifySpy.mock.calls.map((c) => (c[0] as { userId: string }).userId)).toEqual(["watcher-1"]);
  });

  it("the intake account watching its own ticket does not count as somebody", async () => {
    ticketOverrides = { assigneeId: null, watchers: [{ userId: SYSTEM_USER.id }], collaborators: [] };
    vi.mocked(client.user.findMany).mockResolvedValueOnce([{ id: "lead-1", name: "Lena Lead" }] as never);
    await run(reply);
    expect(notifySpy.mock.calls.map((c) => (c[0] as { userId: string }).userId)).toContain("lead-1");
  });
});
