/**
 * Guest approval links and public request-form links were stored verbatim, so any read of the
 * database — a backup, a dump, one injected SELECT — handed over live, usable capabilities.
 * They now follow attestation-public.controller.ts: SHA-256 lookup, uniform 404.
 *
 * Two things this file also pins down, because both are ways the fix could quietly go wrong:
 * - the plaintext fallback still resolves links minted before the change (a migration that
 *   invalidates every outstanding guest approval is a production incident, not a security fix);
 * - `POST /approvals/steps/:stepId/resend`, which MINTS a guest link and returns it, is scoped to
 *   projects the caller can see rather than to any step id in the tenant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "user-1", name: "Mgr", email: "m@x.io", role: "MANAGER", permissions: ["approvals:manage"] };
const STEP_ID = "33333333-3333-4333-8333-333333333333";
const HIDDEN_PROJECT = "44444444-4444-4444-4444-444444444444";

let ticketVisible: boolean;

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] };
      next();
    }
  };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchNotification: vi.fn().mockResolvedValue(undefined),
  dispatchTransactional: vi.fn().mockResolvedValue({ ok: true })
}));
vi.mock("../../src/services/planning.service.js", () => ({ assertPlanningCapability: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/ticket.service.js", async () => {
  const { AppError } = await import("../../src/middleware/error.js");
  return {
    assertTicketVisible: vi.fn(async () => {
      if (!ticketVisible) throw new AppError(404, "Ticket not found");
    }),
    computeTicketDueDate: vi.fn(),
    getGlobalTicketSettings: vi.fn(async () => ({})),
    issueTicketKey: vi.fn()
  };
});

const { approvalRouter, approvalPublicRouter } = await import("../../src/controllers/approval.controller.js");
const { requestFormPublicRouter } = await import("../../src/controllers/request-form-public.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { hashGuestToken, issueGuestToken } = await import("../../src/services/approval.service.js");
const { hashPublicFormToken } = await import("../../src/services/request-form.service.js");

let client: PrismaClient;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/approvals", approvalRouter);
  app.use("/api/shared/approvals", approvalPublicRouter);
  app.use("/api/request", requestFormPublicRouter);
  app.use(errorHandler);
  return app;
}

const APPROVAL_STEP = {
  id: STEP_ID,
  guestEmail: "reviewer@client.example",
  decision: "PENDING",
  guestTokenExpiresAt: null as Date | null,
  request: {
    id: "req-1",
    title: "Sign off the mock-up",
    description: null,
    dueAt: null,
    isSequential: true,
    steps: [],
    ticket: { id: "t-1", key: "WEB-1", title: "T", description: "D", attachments: [], projectId: HIDDEN_PROJECT }
  }
};

const FORM = {
  id: "form-1",
  name: "Support request",
  description: null,
  isPublic: true,
  isActive: true,
  schema: { fields: [{ key: "q", label: "Q", type: "TEXT" }] },
  project: { id: "p-1", name: "Ops" }
};

/** The fake matches only what the handler's own WHERE clause asks for, so a handler that stopped
 *  hashing (or started matching on something else) fails rather than silently passing. */
const matches = (where: any, row: { hash: string | null; plain: string | null }) =>
  (where.OR ?? []).some(
    (arm: any) =>
      (arm.guestTokenHash && arm.guestTokenHash === row.hash) ||
      (arm.guestToken && arm.guestToken === row.plain) ||
      (arm.publicTokenHash && arm.publicTokenHash === row.hash) ||
      (arm.publicToken && arm.publicToken === row.plain)
  );

beforeEach(() => {
  ticketVisible = true;
  client = {
    approvalStep: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn().mockResolvedValue({ id: STEP_ID }) },
    requestForm: { findFirst: vi.fn() }
  } as unknown as PrismaClient;
});

describe("GET /shared/approvals/:token", () => {
  it("looks the step up by digest, so the stored row is not itself a working link", async () => {
    const token = issueGuestToken();
    const stored = { hash: hashGuestToken(token), plain: null };
    vi.mocked(client.approvalStep.findFirst).mockImplementation(async (args: any) =>
      matches(args.where, stored) ? (APPROVAL_STEP as any) : null
    );

    const response = await request(buildApp()).get(`/api/shared/approvals/${token}`);
    expect(response.status).toBe(200);
    expect(response.body.title).toBe("Sign off the mock-up");

    // The digest, not the token, is what reached the database.
    const where = vi.mocked(client.approvalStep.findFirst).mock.calls[0]![0]!.where as any;
    expect(JSON.stringify(where)).toContain(hashGuestToken(token));
  });

  it("still resolves a link minted before hashing — the migration must not kill outstanding approvals", async () => {
    const legacy = issueGuestToken();
    const stored = { hash: null, plain: legacy };
    vi.mocked(client.approvalStep.findFirst).mockImplementation(async (args: any) =>
      matches(args.where, stored) ? (APPROVAL_STEP as any) : null
    );

    expect((await request(buildApp()).get(`/api/shared/approvals/${legacy}`)).status).toBe(200);
  });

  it("gives an expired link the same generic 404 as a bad one", async () => {
    const token = issueGuestToken();
    vi.mocked(client.approvalStep.findFirst).mockResolvedValue({
      ...APPROVAL_STEP,
      guestTokenExpiresAt: new Date(Date.now() - 1000)
    } as any);

    const expired = await request(buildApp()).get(`/api/shared/approvals/${token}`);
    vi.mocked(client.approvalStep.findFirst).mockResolvedValue(null);
    const bogus = await request(buildApp()).get(`/api/shared/approvals/${issueGuestToken()}`);

    expect(expired.status).toBe(404);
    expect(expired.body).toEqual(bogus.body);
  });
});

describe("POST /approvals/steps/:stepId/resend", () => {
  beforeEach(() => {
    vi.mocked(client.approvalStep.findUnique).mockResolvedValue({
      id: STEP_ID,
      guestEmail: "reviewer@client.example",
      decision: "PENDING",
      request: { ticket: { projectId: HIDDEN_PROJECT } }
    } as any);
  });

  it("refuses to mint a link into a project the caller cannot see", async () => {
    ticketVisible = false;
    const response = await request(buildApp()).post(`/api/approvals/steps/${STEP_ID}/resend`);
    expect(response.status).toBe(404);
    expect(response.body.message ?? response.body.error).not.toContain("shared/approval");
    expect(client.approvalStep.update).not.toHaveBeenCalled();
  });

  it("mints one for a step on a project the caller can see", async () => {
    const response = await request(buildApp()).post(`/api/approvals/steps/${STEP_ID}/resend`);
    expect(response.status).toBe(200);
    expect(response.body.url).toContain("/shared/approval/");
  });

  it("persists only the digest of the token it just handed out", async () => {
    const response = await request(buildApp()).post(`/api/approvals/steps/${STEP_ID}/resend`);
    const token = String(response.body.url).split("/shared/approval/")[1];
    const data = vi.mocked(client.approvalStep.update).mock.calls[0]![0]!.data as any;

    expect(data.guestTokenHash).toBe(hashGuestToken(token));
    expect(JSON.stringify(data)).not.toContain(token);
    // A row that still carried a legacy plaintext must not keep it alive alongside the new hash.
    expect(data.guestToken).toBeNull();
    expect(data.guestTokenExpiresAt).toBeInstanceOf(Date);
  });
});

describe("GET /request/:token — the public form", () => {
  it("looks the form up by digest", async () => {
    const token = crypto.randomBytes(32).toString("base64url");
    const stored = { hash: hashPublicFormToken(token), plain: null };
    vi.mocked(client.requestForm.findFirst).mockImplementation(async (args: any) =>
      matches(args.where, stored) ? (FORM as any) : null
    );

    const response = await request(buildApp()).get(`/api/request/${token}`);
    expect(response.status).toBe(200);
    expect(response.body.name).toBe("Support request");
    expect(JSON.stringify(vi.mocked(client.requestForm.findFirst).mock.calls[0]![0]!.where)).toContain(
      hashPublicFormToken(token)
    );
  });

  it("still resolves a form published before hashing", async () => {
    const legacy = crypto.randomBytes(32).toString("base64url");
    vi.mocked(client.requestForm.findFirst).mockImplementation(async (args: any) =>
      matches(args.where, { hash: null, plain: legacy }) ? (FORM as any) : null
    );
    expect((await request(buildApp()).get(`/api/request/${legacy}`)).status).toBe(200);
  });

  it("keeps the published/unpublished/bad-token answers indistinguishable", async () => {
    vi.mocked(client.requestForm.findFirst).mockResolvedValue(null);
    const response = await request(buildApp()).get(`/api/request/${crypto.randomBytes(32).toString("base64url")}`);
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).toContain("isn't available");
  });
});
