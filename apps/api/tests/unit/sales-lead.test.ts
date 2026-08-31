/**
 * The public contact form, tested where it decides something.
 *
 * This endpoint is unusual for this codebase: it is an unauthenticated POST that writes a row and
 * sends two emails, and almost everything interesting about it is a JUDGEMENT rather than a
 * calculation — who gets refused, who gets accepted-and-flagged, who gets silently dropped, and who
 * a reply goes to. Each of those is a decision somebody could plausibly "simplify" later, so each
 * one is pinned here, and each was verified by breaking the control in the source and watching the
 * matching test go red (see the falsification list at the bottom of this comment).
 *
 * THE REAL ROUTER IS DRIVEN THROUGH SUPERTEST rather than the handler being re-implemented — the
 * same reasoning as ai-route-hardening.test.ts: a re-implementation passes just as happily against
 * a version without the fix. The mocks stop at the control-plane client and the mail transport, so
 * the schema, the honeypot, the time floor, the free-mail flag, the recipient resolution and the
 * reply-to threading are all the production code paths.
 *
 * THE ONE RULE THIS FILE EXISTS FOR: a Gmail address is a valid sales lead. `signup.controller.ts`
 * refuses one — correctly, because a trial provisions a database — and reusing that rule here is
 * the obvious-looking mistake that would quietly discard real customers, including anyone writing
 * to a deployment whose own sales inbox is a Gmail address.
 *
 * Falsification, run against this suite: removing the honeypot check, removing the time floor,
 * making free-mail rejected, dropping the per-message replyTo, and hard-coding the sales recipient
 * each turned a different test in here red.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createLead = vi.fn();
const findMailSettings = vi.fn();
const createAudit = vi.fn();
const sendPlatformTemplate = vi.fn();

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    salesLead: { create: (...a: unknown[]) => createLead(...a) },
    platformMailSettings: { findUnique: (...a: unknown[]) => findMailSettings(...a) },
    platformAuditLog: { create: (...a: unknown[]) => createAudit(...a) }
  }
}));

vi.mock("../../src/services/platform-mail.service.js", () => ({
  sendPlatformTemplate: (...a: unknown[]) => sendPlatformTemplate(...a)
}));

const { salesLeadRouter } = await import("../../src/controllers/sales-lead.controller.js");
const { DEFAULT_SALES_INBOX } = await import("../../src/services/sales-lead.service.js");
const { PLATFORM_TEMPLATES, PLATFORM_TEMPLATE_KEYS, platformTemplateDef } = await import("../../src/services/platform-mail-templates.js");
const { errorHandler } = await import("../../src/middleware/error.js");

/** Mirrors app.ts's mount, minus the limiter — the limiter belongs to app.ts, and five requests per
 *  hour would make the sixth assertion in this file fail for the wrong reason. */
function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/contact", salesLeadRouter);
  a.use(errorHandler);
  return a;
}

/** A complete, plausible enquiry. Overrides are what each test is actually about. */
const enquiry = (overrides: Record<string, unknown> = {}) => ({
  name: "Priya Raman",
  email: "priya@northwind.co.uk",
  company: "Northwind Logistics",
  role: "Head of Operations",
  country: "United Kingdom",
  teamSize: "201-500",
  deploymentInterest: "PRIVATE_CLOUD",
  timeline: "THIS_QUARTER",
  interests: ["TIMESHEETS", "SSO_SCIM"],
  message: "We run about 300 field engineers and reconcile hours in one system and tickets in another.",
  sourcePage: "/contact",
  website: "",
  // Comfortably over the floor: a real person takes far longer than this to fill nine fields.
  elapsedMs: 45_000,
  ...overrides
});

const post = (body: Record<string, unknown>) => request(app()).post("/api/contact").send(body);

/** The `vars` the notification email was rendered with, for the tests that care about them. */
const notificationCall = () => sendPlatformTemplate.mock.calls.find((call) => call[0] === "sales.lead")?.[1] as
  | { to: string; replyTo?: string; vars: Record<string, unknown> }
  | undefined;

beforeEach(() => {
  // `restoreMocks` in vitest.config.ts restores spies on real objects; these are standalone
  // `vi.fn()`s, whose call history survives it. Almost every assertion here counts calls, so the
  // history has to be reset explicitly or the second test in a file inherits the first one's.
  vi.clearAllMocks();
  createLead.mockResolvedValue({ id: "lead-1" });
  findMailSettings.mockResolvedValue(null);
  createAudit.mockResolvedValue({ id: "audit-1" });
  sendPlatformTemplate.mockResolvedValue({ ok: true, status: "SENT", emailLogId: "log-1", subject: "x" });
});

describe("a real enquiry", () => {
  it("writes the row, records it, and sends BOTH emails", async () => {
    const response = await post(enquiry());

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ received: true });

    expect(createLead).toHaveBeenCalledTimes(1);
    const written = createLead.mock.calls[0][0].data;
    expect(written).toMatchObject({
      name: "Priya Raman",
      email: "priya@northwind.co.uk",
      company: "Northwind Logistics",
      teamSize: "201-500",
      deploymentInterest: "PRIVATE_CLOUD",
      timeline: "THIS_QUARTER",
      isFreeMailDomain: false,
      sourcePage: "/contact"
    });
    expect(written.interests).toEqual(["TIMESHEETS", "SSO_SCIM"]);

    // The audit row goes through the real `platformAudit`, so this also pins the actor type: a
    // lead is submitted by a CUSTOMER, not by the system and not by an operator.
    expect(createAudit).toHaveBeenCalledTimes(1);
    expect(createAudit.mock.calls[0][0].data).toMatchObject({
      actorType: "CUSTOMER",
      actorLabel: "priya@northwind.co.uk",
      action: "sales_lead.created",
      entity: "SalesLead",
      entityId: "lead-1"
    });

    const keys = sendPlatformTemplate.mock.calls.map((call) => call[0]);
    expect(keys).toEqual(["sales.lead", "sales.ack"]);
  });

  it("addresses the notification to us and the acknowledgement to them", async () => {
    await post(enquiry());
    const ack = sendPlatformTemplate.mock.calls.find((call) => call[0] === "sales.ack")?.[1] as { to: string };
    expect(notificationCall()?.to).toBe(DEFAULT_SALES_INBOX);
    expect(ack.to).toBe("priya@northwind.co.uk");
  });

  it("lower-cases the address it stores and replies to", async () => {
    await post(enquiry({ email: "Priya@Northwind.co.uk" }));
    expect(createLead.mock.calls[0][0].data.email).toBe("priya@northwind.co.uk");
    expect(notificationCall()?.replyTo).toBe("priya@northwind.co.uk");
  });
});

describe("hitting Reply answers the customer", () => {
  /**
   * The entire point of the notification. It is addressed to the sales inbox, so without a
   * per-message `replyTo` the deployment-wide one applies and Reply answers ourselves — an email
   * that looks completely fine and silently loses every conversation it was supposed to start.
   */
  it("sets replyTo on sales.lead to the prospect's address", async () => {
    await post(enquiry());
    expect(notificationCall()?.replyTo).toBe("priya@northwind.co.uk");
  });

  it("does not set one on the acknowledgement, which is already addressed to them", async () => {
    await post(enquiry());
    const ack = sendPlatformTemplate.mock.calls.find((call) => call[0] === "sales.ack")?.[1] as { replyTo?: string };
    expect(ack.replyTo).toBeUndefined();
  });
});

describe("where the notification is delivered", () => {
  it("falls back to the shipped default when no sales inbox is configured", async () => {
    findMailSettings.mockResolvedValue({ id: "global", salesInboxAddress: null });
    await post(enquiry());
    expect(notificationCall()?.to).toBe(DEFAULT_SALES_INBOX);
  });

  it("uses the configured inbox when there is one", async () => {
    findMailSettings.mockResolvedValue({ id: "global", salesInboxAddress: "sales@northwind-partners.example" });
    await post(enquiry());
    expect(notificationCall()?.to).toBe("sales@northwind-partners.example");
  });

  it("still delivers when the settings row cannot be read at all", async () => {
    // A control-plane read that fails must not be the reason a lead notification is skipped: the
    // fallback address is perfectly good, and the alternative is losing the lead to protect nothing.
    findMailSettings.mockRejectedValue(new Error("control plane unreachable"));
    const response = await post(enquiry());
    expect(response.status).toBe(201);
    expect(notificationCall()?.to).toBe(DEFAULT_SALES_INBOX);
  });
});

describe("a free-mail address is a lead, not a problem", () => {
  /**
   * THE REGRESSION TEST. Signup refuses gmail.com; this surface must not. A founder evaluating the
   * product from a personal address is a real enquiry, there is no infrastructure behind a contact
   * form to protect, and this deployment's own sales inbox is itself a Gmail address.
   */
  it("accepts a Gmail address and flags the row", async () => {
    const response = await post(enquiry({ email: "founder@gmail.com" }));

    expect(response.status).toBe(201);
    expect(createLead).toHaveBeenCalledTimes(1);
    expect(createLead.mock.calls[0][0].data).toMatchObject({ email: "founder@gmail.com", isFreeMailDomain: true });
  });

  it("says so in the notification rather than hiding it", async () => {
    await post(enquiry({ email: "founder@gmail.com" }));
    expect(String(notificationCall()?.vars.freeMailNote)).toContain("Personal email domain");
  });

  it("leaves the flag off for a company address", async () => {
    await post(enquiry());
    expect(createLead.mock.calls[0][0].data.isFreeMailDomain).toBe(false);
    expect(notificationCall()?.vars.freeMailNote).toBe("");
  });
});

describe("the bot controls, which say nothing to a bot", () => {
  it("drops a submission with the honeypot filled, and answers like a success", async () => {
    const response = await post(enquiry({ website: "https://buy-cheap-things.example" }));

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ received: true });
    // Nothing written, nothing sent, nothing recorded. A bot that is told it was refused tunes and
    // returns; one that is told it succeeded has no reason to.
    expect(createLead).not.toHaveBeenCalled();
    expect(sendPlatformTemplate).not.toHaveBeenCalled();
  });

  it("drops a submission that arrived faster than a person can type", async () => {
    const response = await post(enquiry({ elapsedMs: 900 }));

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ received: true });
    expect(createLead).not.toHaveBeenCalled();
  });

  it("treats a missing timing entirely as too fast — the real form always sends one", async () => {
    const body = enquiry();
    delete (body as Record<string, unknown>).elapsedMs;
    const response = await post(body);

    expect(response.status).toBe(201);
    expect(createLead).not.toHaveBeenCalled();
  });

  it("lets a slow, deliberate submission through", async () => {
    await post(enquiry({ elapsedMs: 4_000 }));
    expect(createLead).toHaveBeenCalledTimes(1);
  });
});

describe("a human-fixable problem is said out loud", () => {
  /**
   * The other half of the honeypot decision. A missing field is answered with a 422 and a real
   * message, NOT with the silent 201 a bot gets — hiding it would leave a customer believing they
   * had sent something they had not, which is a far worse outcome than a spammer learning that this
   * endpoint validates its input.
   */
  it("refuses a missing company with a 422", async () => {
    const body = enquiry();
    delete (body as Record<string, unknown>).company;
    const response = await post(body);

    expect(response.status).toBe(422);
    expect(createLead).not.toHaveBeenCalled();
  });

  it("refuses a malformed address with a 422", async () => {
    const response = await post(enquiry({ email: "not-an-address" }));
    expect(response.status).toBe(422);
    expect(createLead).not.toHaveBeenCalled();
  });

  it("refuses a one-word message rather than emailing somebody a lead with nothing in it", async () => {
    const response = await post(enquiry({ message: "hi" }));
    expect(response.status).toBe(422);
    expect(createLead).not.toHaveBeenCalled();
  });

  it("refuses a value that is not in the vocabulary", async () => {
    expect((await post(enquiry({ teamSize: "several" }))).status).toBe(422);
    expect((await post(enquiry({ deploymentInterest: "MAINFRAME" }))).status).toBe(422);
    expect((await post(enquiry({ interests: ["CRYSTAL_BALL"] }))).status).toBe(422);
    expect(createLead).not.toHaveBeenCalled();
  });

  it("refuses an unknown field instead of quietly ignoring it", async () => {
    // `.strict()`: the row is not free-form storage, and a field nobody declared is either a bug in
    // our own form or somebody probing for one.
    const response = await post(enquiry({ discountCode: "FREE" }));
    expect(response.status).toBe(422);
    expect(createLead).not.toHaveBeenCalled();
  });
});

describe("mail is a convenience; the row is the product", () => {
  it("still succeeds, and still keeps the lead, when the relay is down", async () => {
    sendPlatformTemplate.mockRejectedValue(new Error("ECONNREFUSED"));

    const response = await post(enquiry());

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ received: true });
    expect(createLead).toHaveBeenCalledTimes(1);
    // Both were still ATTEMPTED — the failure is recorded by the mail service's own log, which is
    // how an operator finds out. What must not happen is the enquiry being lost as well.
    expect(sendPlatformTemplate).toHaveBeenCalledTimes(2);
  });

  it("tries the acknowledgement even when the notification failed", async () => {
    sendPlatformTemplate.mockRejectedValueOnce(new Error("relay refused"));
    await post(enquiry());
    expect(sendPlatformTemplate.mock.calls.map((call) => call[0])).toEqual(["sales.lead", "sales.ack"]);
  });
});

describe("the templates are registered like every other platform email", () => {
  /** Registration is what gives them the console editor, the preview, the test send and the log. A
   *  template dispatched from code but missing from the registry is an email nobody can change. */
  it("registers both sales keys", () => {
    expect(PLATFORM_TEMPLATE_KEYS).toContain("sales.lead");
    expect(PLATFORM_TEMPLATE_KEYS).toContain("sales.ack");
  });

  it("files them under a Sales group with a description and a sample", () => {
    for (const key of ["sales.lead", "sales.ack"]) {
      const def = platformTemplateDef(key);
      expect(def?.group).toBe("Sales");
      expect(def?.description.length).toBeGreaterThan(20);
      expect(Object.keys(def?.sample ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("declares every variable its body and subject actually use", () => {
    // An undeclared `{{var}}` renders as an empty string in a real send and is invisible in review
    // — the preview fills it from `sample` only if the editor knows it exists.
    for (const def of PLATFORM_TEMPLATES.filter((t) => t.group === "Sales")) {
      const used = [...`${def.subject} ${def.html}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]);
      expect([...new Set(used)].filter((name) => !def.variables.includes(name))).toEqual([]);
      expect([...new Set(used)].filter((name) => !(name in def.sample))).toEqual([]);
    }
  });
});
