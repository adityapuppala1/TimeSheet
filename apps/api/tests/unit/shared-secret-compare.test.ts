/**
 * Three shared-secret checks — SCIM's bearer token, the security/CI ingestion token, and Google
 * Chat's verification token — used to read:
 *
 *     if (authBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(authBuf, expectedBuf))
 *
 * The length pre-check is there because `timingSafeEqual` throws on mismatched lengths. It is
 * also a side channel: it answers "is my guess the right LENGTH?" in one request, for free, and
 * with it the search space for a variable-length secret stops being what it looks like. Worse,
 * `timingSafeEqual` is then never reached at all for a wrong-length guess — so the constant-time
 * comparison this code appears to perform is exactly the case where it doesn't happen.
 *
 * The fix is the hash-then-compare helper git-webhook-providers.ts already used, now
 * utils/security.ts#constantTimeEqual: both sides become a 32-byte digest, so the comparison
 * always runs and its operands never carry the secret's length.
 *
 * These tests observe the actual `timingSafeEqual` calls, because that difference is invisible in
 * the response — both shapes answer 401 — and pinning it on wall-clock timing would be flaky.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const { comparisons } = vi.hoisted(() => ({ comparisons: [] as Array<{ a: number; b: number }> }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const timingSafeEqual = (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
    comparisons.push({ a: a.byteLength, b: b.byteLength });
    return actual.timingSafeEqual(a, b);
  };
  return { ...actual, timingSafeEqual, default: { ...actual, timingSafeEqual } };
});

const TOKEN = "ingestion-token-of-a-very-particular-length";

const { mockResolveActiveOrgBySlug } = vi.hoisted(() => ({ mockResolveActiveOrgBySlug: vi.fn() }));
vi.mock("../../src/middleware/tenant.js", () => ({ resolveActiveOrgBySlug: mockResolveActiveOrgBySlug }));
vi.mock("../../src/utils/encryption.js", () => ({ decryptSecret: vi.fn(() => TOKEN) }));

let client: PrismaClient;
vi.mock("../../src/config/prisma.js", async () => {
  const { tenantContext } = await import("../../src/config/tenant-context.js");
  return {
    getTenantClient: vi.fn(async () => client),
    prisma: new Proxy({} as never, { get: (_t, prop) => (tenantContext.getStore()!.client as never)[prop] })
  };
});

const { scimRouter } = await import("../../src/controllers/scim.controller.js");
const { devopsWebhookRouter } = await import("../../src/controllers/devops-webhook.controller.js");
const { chatWebhookRouter } = await import("../../src/controllers/chat-webhook.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { constantTimeEqual } = await import("../../src/utils/security.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/scim", scimRouter);
  app.use("/api/devops", devopsWebhookRouter);
  app.use("/api/chat", chatWebhookRouter);
  app.use(errorHandler);
  return app;
}

/** A guess shorter than the real token — the case the old length pre-check short-circuited. */
const SHORT_GUESS = "x";
/** A guess the same length as the real token, so length alone cannot separate the two cases. */
const SAME_LENGTH_GUESS = "y".repeat(TOKEN.length);

beforeEach(() => {
  comparisons.length = 0;
  mockResolveActiveOrgBySlug.mockReset().mockResolvedValue({
    id: "org-1",
    slug: "acme",
    status: "ACTIVE",
    database: { encryptedDsn: "cipher" }
  });
  client = {
    scimSettings: { findUnique: vi.fn().mockResolvedValue({ id: "global", isEnabled: true, encryptedToken: "cipher" }) },
    ingestionSettings: { findUnique: vi.fn().mockResolvedValue({ id: "global", encryptedToken: "cipher" }) },
    chatIntegration: {
      findUnique: vi.fn().mockResolvedValue({ platform: "GOOGLE_CHAT", isEnabled: true, encryptedSigningSecret: "cipher" })
    }
  } as unknown as PrismaClient;
});

const routes = [
  {
    name: "SCIM bearer token",
    send: (token: string) => request(buildApp()).get("/api/scim/acme/v2/Users").set("Authorization", `Bearer ${token}`)
  },
  {
    name: "security/CI ingestion token",
    send: (token: string) =>
      request(buildApp()).post("/api/devops/acme/findings").set("Authorization", `Bearer ${token}`).send({ findings: [] })
  },
  {
    name: "Google Chat verification token",
    send: (token: string) =>
      request(buildApp()).post("/api/chat/google/events/acme").set("Authorization", `Bearer ${token}`).send({ type: "MESSAGE" })
  }
];

describe.each(routes)("$name", ({ send }) => {
  it("rejects a wrong token", async () => {
    expect((await send(SHORT_GUESS)).status).toBe(401);
  });

  it("actually runs a constant-time comparison for a WRONG-LENGTH guess", async () => {
    await send(SHORT_GUESS);
    // The old shape returned before ever calling timingSafeEqual on this input.
    expect(comparisons.length).toBeGreaterThan(0);
  });

  it("never lets the secret's length reach the comparison", async () => {
    await send(SHORT_GUESS);
    await send(SAME_LENGTH_GUESS);

    // Every operand is a SHA-256 digest, whatever was supplied — so the operand widths carry no
    // information about the token, and a wrong-length guess is indistinguishable from a
    // right-length one.
    expect(comparisons.length).toBeGreaterThan(0);
    expect(comparisons.every(({ a, b }) => a === 32 && b === 32)).toBe(true);
  });
});

describe("the helper itself", () => {
  it("matches equal strings and separates different ones", () => {
    expect(constantTimeEqual("same-secret", "same-secret")).toBe(true);
    expect(constantTimeEqual("same-secret", "other-secret")).toBe(false);
  });

  it("returns false rather than throwing on mismatched lengths — the reason the pre-check existed", () => {
    expect(constantTimeEqual("", "a-secret")).toBe(false);
    expect(constantTimeEqual("a-much-much-longer-guess", "a-secret")).toBe(false);
  });

  it("compares by value, not by reference or by prefix", () => {
    expect(constantTimeEqual("a-secret", "a-secret-with-more")).toBe(false);
    expect(constantTimeEqual("a-secretX", "a-secretY")).toBe(false);
  });
});
