/**
 * Two things every public webhook receiver has to survive from an unauthenticated caller: a body
 * that isn't what the route's parser expected, and a request that tries to get an answer out of
 * the endpoint before proving anything.
 *
 * - Slack's `url_verification` handshake was answered FIRST, above the tenant lookup and above
 *   the signature check, so the route echoed attacker-chosen text to anyone who asked, naming any
 *   workspace or none. Slack signs that handshake like every other delivery, so there was never a
 *   reason to answer it early.
 * - `(req.body as Buffer).toString()` assumed `express.raw()` had run. It only runs for a
 *   MATCHING content-type, so a `text/plain` POST turned into a 500 for the price of one edited
 *   header.
 */
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const SECRET = "slack-signing-secret";
const GIT_SECRET = "git-webhook-secret";

const { mockResolveActiveOrgBySlug, mockProcessInboundChatMessage } = vi.hoisted(() => ({
  mockResolveActiveOrgBySlug: vi.fn(),
  mockProcessInboundChatMessage: vi.fn()
}));

vi.mock("../../src/middleware/tenant.js", () => ({ resolveActiveOrgBySlug: mockResolveActiveOrgBySlug }));
vi.mock("../../src/utils/encryption.js", () => ({ decryptSecret: vi.fn((value: string) => (value === "git-cipher" ? GIT_SECRET : SECRET)) }));
vi.mock("../../src/services/chat-intake.service.js", () => ({ processInboundChatMessage: mockProcessInboundChatMessage }));
vi.mock("../../src/services/ai.service.js", () => ({
  summarizePullRequest: vi.fn(),
  reviewPullRequestDiff: vi.fn()
}));
vi.mock("../../src/services/git-provider.service.js", () => ({
  GIT_INTEGRATION_SYSTEM_EMAIL: "git@system.local",
  fetchGitHubPullRequestFiles: vi.fn(),
  postGitHubPullRequestReview: vi.fn()
}));

let client: PrismaClient;
vi.mock("../../src/config/prisma.js", async () => {
  const { tenantContext } = await import("../../src/config/tenant-context.js");
  return {
    getTenantClient: vi.fn(async () => client),
    prisma: new Proxy({} as never, { get: (_t, prop) => (tenantContext.getStore()!.client as never)[prop] })
  };
});

const { chatWebhookRouter } = await import("../../src/controllers/chat-webhook.controller.js");
const { gitWebhookRouter } = await import("../../src/controllers/git-webhook.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { AppError } = await import("../../src/middleware/error.js");
const { resetWebhookReplayStore } = await import("../../src/services/webhook-replay.js");

/** Mirrors app.ts: both routers are mounted before the global JSON parser and bring their own. */
function buildApp() {
  const app = express();
  app.use("/api/chat", chatWebhookRouter);
  app.use("/api/git", gitWebhookRouter);
  app.use(errorHandler);
  return app;
}

const slackSignature = (timestamp: string, body: string) =>
  `v0=${crypto.createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;

const CHALLENGE = "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P";
const HANDSHAKE = JSON.stringify({ type: "url_verification", challenge: CHALLENGE });

beforeEach(() => {
  resetWebhookReplayStore();
  mockProcessInboundChatMessage.mockReset();
  mockResolveActiveOrgBySlug.mockReset().mockImplementation(async (slug: string) => {
    if (slug !== "acme") throw new AppError(404, "Unknown workspace.");
    return { id: "org-1", slug, status: "ACTIVE", database: { encryptedDsn: "cipher" } };
  });
  client = {
    chatIntegration: {
      findUnique: vi.fn().mockResolvedValue({ platform: "SLACK", isEnabled: true, encryptedSigningSecret: "cipher" })
    },
    gitConnection: { findUnique: vi.fn().mockResolvedValue({ id: "global", encryptedWebhookSecret: "git-cipher" }) },
    user: { findUnique: vi.fn().mockResolvedValue({ id: "sys-1" }) },
    ticket: { findFirst: vi.fn().mockResolvedValue(null) },
    ticketBranch: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }
  } as unknown as PrismaClient;
});

describe("Slack's url_verification handshake is answered only after the signature checks out", () => {
  it("does not echo the challenge to an unsigned caller", async () => {
    const res = await request(buildApp())
      .post("/api/chat/slack/events/acme")
      .set("content-type", "application/json")
      .send(HANDSHAKE);

    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(CHALLENGE);
  });

  it("does not echo the challenge for a workspace that does not exist", async () => {
    const res = await request(buildApp())
      .post("/api/chat/slack/events/no-such-workspace")
      .set("content-type", "application/json")
      .send(HANDSHAKE);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(CHALLENGE);
  });

  it("does not echo the challenge before Slack has been configured for the workspace", async () => {
    vi.mocked(client.chatIntegration.findUnique).mockResolvedValue(null);
    const res = await request(buildApp())
      .post("/api/chat/slack/events/acme")
      .set("content-type", "application/json")
      .send(HANDSHAKE);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(CHALLENGE);
  });

  it("still completes the handshake for a properly signed one — Slack signs it like anything else", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await request(buildApp())
      .post("/api/chat/slack/events/acme")
      .set("content-type", "application/json")
      .set("x-slack-request-timestamp", timestamp)
      .set("x-slack-signature", slackSignature(timestamp, HANDSHAKE))
      .send(HANDSHAKE);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: CHALLENGE });
  });

  it("still delivers a signed message event, so moving the handshake broke nothing after it", async () => {
    const body = JSON.stringify({
      event_id: "Ev-1",
      event: { type: "message", user: "U1", channel: "C1", text: "hello" }
    });
    const timestamp = String(Math.floor(Date.now() / 1000));

    const res = await request(buildApp())
      .post("/api/chat/slack/events/acme")
      .set("content-type", "application/json")
      .set("x-slack-request-timestamp", timestamp)
      .set("x-slack-signature", slackSignature(timestamp, body))
      .send(body);

    expect(res.status).toBe(200);
    expect(mockProcessInboundChatMessage).toHaveBeenCalledTimes(1);
  });
});

describe("a body the route's parser never touched is a client error, not a 500", () => {
  it("Slack: text/plain gets a refusal, not a crash", async () => {
    const res = await request(buildApp()).post("/api/chat/slack/events/acme").set("content-type", "text/plain").send("hello");
    expect(res.status).toBe(401);
  });

  it("Slack: a bodyless POST likewise", async () => {
    const res = await request(buildApp()).post("/api/chat/slack/events/acme");
    expect(res.status).toBe(401);
  });

  it("GitHub: text/plain gets a refusal, not a crash", async () => {
    const res = await request(buildApp()).post("/api/git/webhook/acme").set("content-type", "text/plain").send("hello");
    expect(res.status).toBe(401);
  });

  it("the multi-provider route too", async () => {
    const res = await request(buildApp())
      .post("/api/git/webhook/acme/gitlab")
      .set("content-type", "text/plain")
      .send("hello");
    expect(res.status).toBe(401);
  });

  it("a body that claims application/json and isn't gets a 400, not a 500", async () => {
    const res = await request(buildApp())
      .post("/api/git/webhook/acme")
      .set("content-type", "application/json")
      .set("x-github-event", "push")
      .send("{not json");
    expect(res.status).toBe(400);
  });
});
