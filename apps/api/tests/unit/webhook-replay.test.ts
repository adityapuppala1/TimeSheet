/**
 * The replay store itself (services/webhook-replay.ts) and the git webhook route that leans on
 * it. An HMAC proves WHO sent a body, never WHEN — so before this, one captured
 * `pull_request:opened` delivery could be resent forever, each time re-running the AI summary and
 * posting another review to GitHub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";

const SECRET = "shared-webhook-secret";

vi.mock("../../src/middleware/tenant.js", () => ({
  resolveActiveOrgBySlug: vi.fn(async (slug: string) => ({
    id: "org-1",
    slug,
    database: { encryptedDsn: "cipher" }
  }))
}));
vi.mock("../../src/utils/encryption.js", () => ({ decryptSecret: vi.fn(() => SECRET) }));
vi.mock("../../src/services/ai.service.js", () => ({
  summarizePullRequest: vi.fn(async () => ({ summary: "s", reviewFocus: "f", riskLevel: "LOW" })),
  reviewPullRequestDiff: vi.fn(async () => null)
}));
vi.mock("../../src/services/git-provider.service.js", () => ({
  GIT_INTEGRATION_SYSTEM_EMAIL: "git@system.local",
  fetchGitHubPullRequestFiles: vi.fn(async () => []),
  postGitHubPullRequestReview: vi.fn(async () => undefined)
}));

let client: PrismaClient;
vi.mock("../../src/config/prisma.js", async () => {
  const { tenantContext } = await import("../../src/config/tenant-context.js");
  return {
    getTenantClient: vi.fn(async () => client),
    prisma: new Proxy({} as any, { get: (_t, prop) => (tenantContext.getStore()!.client as any)[prop] })
  };
});

const { gitWebhookRouter } = await import("../../src/controllers/git-webhook.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { isReplayedDelivery, resetWebhookReplayStore } = await import("../../src/services/webhook-replay.js");
const ai = await import("../../src/services/ai.service.js");

function buildApp() {
  const app = express();
  app.use("/api/git", gitWebhookRouter);
  app.use(errorHandler);
  return app;
}

const PR_BODY = JSON.stringify({
  action: "opened",
  repository: { full_name: "acme/app" },
  pull_request: {
    number: 3,
    title: "WEB-12 fix",
    body: null,
    html_url: "https://github.com/acme/app/pull/3",
    merged: false,
    state: "open",
    head: { ref: "feature/WEB-12-fix" }
  }
});

const sign = (body: string) => `sha256=${crypto.createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex")}`;

const deliver = (body: string, deliveryId: string | null) => {
  const req = request(buildApp())
    .post("/api/git/webhook/acme")
    .set("content-type", "application/json")
    .set("x-hub-signature-256", sign(body))
    .set("x-github-event", "pull_request");
  if (deliveryId) req.set("x-github-delivery", deliveryId);
  return req.send(body);
};

beforeEach(() => {
  vi.clearAllMocks();
  resetWebhookReplayStore();
  client = {
    gitConnection: {
      findUnique: vi.fn().mockResolvedValue({ id: "global", encryptedWebhookSecret: "cipher", encryptedAccessToken: "cipher" })
    },
    user: { findUnique: vi.fn().mockResolvedValue({ id: "sys-1", email: "git@system.local" }) },
    ticket: { findFirst: vi.fn().mockResolvedValue({ id: "ticket-1", key: "WEB-12" }) },
    ticketBranch: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() },
    ticketComment: { create: vi.fn() }
  } as unknown as PrismaClient;
});

afterEach(() => {
  vi.useRealTimers();
  resetWebhookReplayStore();
});

describe("the seen-delivery store", () => {
  it("accepts an id once and refuses it after", () => {
    expect(isReplayedDelivery("github:acme", "d-1")).toBe(false);
    expect(isReplayedDelivery("github:acme", "d-1")).toBe(true);
  });

  it("keeps tenants apart — one process serves every org, so the namespace is load-bearing", () => {
    expect(isReplayedDelivery("github:acme", "d-1")).toBe(false);
    expect(isReplayedDelivery("github:globex", "d-1")).toBe(false);
  });

  it("forgets an id once its TTL has passed", () => {
    vi.useFakeTimers();
    expect(isReplayedDelivery("github:acme", "d-1")).toBe(false);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1000);
    expect(isReplayedDelivery("github:acme", "d-1")).toBe(false);
  });

  it("stays bounded rather than growing without limit", () => {
    for (let i = 0; i < 10_050; i += 1) isReplayedDelivery("github:acme", `d-${i}`);
    // The earliest ids have been evicted by the cap, which is the documented trade-off.
    expect(isReplayedDelivery("github:acme", "d-0")).toBe(false);
    expect(isReplayedDelivery("github:acme", "d-10049")).toBe(true);
  });
});

describe("per-provider delivery ids", () => {
  it("reads each provider's own header, and Azure DevOps' body field", async () => {
    const { gitWebhookDeliveryId, GIT_PROVIDERS_WITH_GUARANTEED_DELIVERY_ID } = await import(
      "../../src/services/git-webhook-providers.js"
    );

    expect(gitWebhookDeliveryId({ provider: "gitlab", headers: { "x-gitlab-event-uuid": "g-1" }, body: {} })).toBe("g-1");
    expect(gitWebhookDeliveryId({ provider: "gitea", headers: { "x-gitea-delivery": "t-1" }, body: {} })).toBe("t-1");
    expect(gitWebhookDeliveryId({ provider: "forgejo", headers: { "x-forgejo-delivery": "f-1" }, body: {} })).toBe("f-1");
    expect(gitWebhookDeliveryId({ provider: "bitbucket", headers: { "x-request-uuid": "b-1" }, body: {} })).toBe("b-1");
    expect(gitWebhookDeliveryId({ provider: "azure-devops", headers: {}, body: { id: "a-1" } })).toBe("a-1");
    expect(gitWebhookDeliveryId({ provider: "azure-devops", headers: {}, body: {} })).toBeNull();

    // The providers whose secret does NOT transit with the request are the ones where a missing
    // id has to be fatal — see services/webhook-replay.ts.
    expect([...GIT_PROVIDERS_WITH_GUARANTEED_DELIVERY_ID].sort()).toEqual(["bitbucket", "forgejo", "gitea"]);
  });
});

describe("POST /git/webhook/:orgSlug", () => {
  it("acts on a delivery once", async () => {
    const response = await deliver(PR_BODY, "11111111-1111-1111-1111-111111111111");
    expect(response.status).toBe(200);
    expect(client.ticketBranch.create).toHaveBeenCalledTimes(1);
    expect(ai.summarizePullRequest).toHaveBeenCalledTimes(1);
  });

  it("refuses the same signed delivery replayed, and runs no AI or GitHub write for it", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    await deliver(PR_BODY, id);
    vi.clearAllMocks();

    const replay = await deliver(PR_BODY, id);
    expect(replay.status).toBe(409);
    expect(client.ticketBranch.create).not.toHaveBeenCalled();
    expect(ai.summarizePullRequest).not.toHaveBeenCalled();
  });

  it("rejects a delivery with the id header stripped — otherwise the guard is bypassed by deleting a header", async () => {
    const response = await deliver(PR_BODY, null);
    expect(response.status).toBe(401);
    expect(ai.summarizePullRequest).not.toHaveBeenCalled();
  });

  it("does not let an UNSIGNED request write into the store and evict a genuine id", async () => {
    const id = "33333333-3333-3333-3333-333333333333";
    const forged = await request(buildApp())
      .post("/api/git/webhook/acme")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", "sha256=deadbeef")
      .set("x-github-event", "pull_request")
      .set("x-github-delivery", id)
      .send(PR_BODY);
    expect(forged.status).toBe(401);

    // The real delivery with that id still goes through, so the forgery did not consume it.
    expect((await deliver(PR_BODY, id)).status).toBe(200);
  });

  it("treats a genuinely different delivery of the same event as new", async () => {
    await deliver(PR_BODY, "44444444-4444-4444-4444-444444444444");
    const second = await deliver(PR_BODY, "55555555-5555-5555-5555-555555555555");
    expect(second.status).toBe(200);
  });
});
