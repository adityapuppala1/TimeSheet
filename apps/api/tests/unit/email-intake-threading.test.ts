/**
 * Email intake: the loop guard, the confirmation, and replies.
 *
 * Every unseen message used to become a NEW ticket and earn a confirmation email, whoever or
 * whatever sent it. Two consequences, both pinned here:
 *
 *  1. A LOOP. Another helpdesk's acknowledgement, an out-of-office or a bounce, arriving from an
 *     auto-responding mailbox, became a ticket; our confirmation went back; their autoresponder
 *     answered it; that became a ticket… RFC 3834 says how to tell automated mail apart
 *     (Auto-Submitted, Precedence, List-Id, the null return path, the daemon senders) and how to mark
 *     our own reply so the other side's guard can do the same (Auto-Submitted: auto-replied).
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

const { processInboundEmail, ticketConfirmationMessageId } = await import("../../src/services/email-intake.service.js");
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
  deletedAt: null,
  watchers: [],
  collaborators: []
};

let client: PrismaClient;
let ticketCreate: ReturnType<typeof vi.fn>;
let commentCreate: ReturnType<typeof vi.fn>;

function buildClient(): PrismaClient {
  ticketCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-ticket", ...data }));
  commentCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "comment-1", createdAt: new Date(), ...data }));
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
        (where.key === EXISTING.key || where.id === EXISTING.id) ? { ...EXISTING } : null
      )
    },
    ticketComment: { create: commentCreate },
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
  client = buildClient();
});

describe("automated mail is dropped before it can start a loop", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["Auto-Submitted: auto-replied", { headers: { autoSubmitted: "auto-replied" } }],
    ["Auto-Submitted: auto-generated", { headers: { autoSubmitted: "auto-generated" } }],
    ["Precedence: bulk", { headers: { precedence: "bulk" } }],
    ["Precedence: junk", { headers: { precedence: "junk" } }],
    ["Precedence: list", { headers: { precedence: "list" } }],
    ["a List-Id header", { headers: { listId: "<announce.lists.example.com>" } }],
    ["a mailer-daemon sender", { from: { address: "MAILER-DAEMON@mx.example.com" } }],
    ["a postmaster sender", { from: { address: "postmaster@example.com" } }],
    ["a null return path", { headers: { returnPath: "<>" } }]
  ];

  for (const [label, overrides] of cases) {
    it(`${label}: no ticket, no confirmation`, async () => {
      const result = await run(overrides);
      expect(result).toMatchObject({ created: false, reason: "AUTOMATED_SENDER" });
      expect(ticketCreate).not.toHaveBeenCalled();
      expect(transactionalSpy).not.toHaveBeenCalled();
    });
  }

  it("Auto-Submitted: no is a person, and is processed", async () => {
    const result = await run({ headers: { autoSubmitted: "no", returnPath: "<customer@example.com>" } });
    expect(result.created).toBe(true);
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
