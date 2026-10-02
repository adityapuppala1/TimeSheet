/**
 * The per-IP limiter on the two unauthenticated routes that send mail, through the same mounting
 * app.ts uses (`mountMailRouteLimiters`). Security audit #5.
 *
 * WHY THEY NEEDED THEIR OWN: both shared the login limiter, which is configured with
 * `skipSuccessfulRequests` — only failures count, the right rule for a password guesser. But both
 * of these routes ALWAYS answer 202, and express-rate-limit counts anything under 400 as a success,
 * so no request to either was ever counted: only the global 900/min/IP ceiling applied. Here every
 * request counts. (The per-ADDRESS cap is separate, held in the database — auth-mail-routes.test.ts.)
 */
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { MAIL_ROUTE_LIMIT_PER_WINDOW, mountMailRouteLimiters } from "../../src/middleware/auth-limits.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  mountMailRouteLimiters(app);
  // Stand-ins that answer exactly what the real routes answer: a 202, every time.
  app.post("/api/auth/forgot-password", (_req, res) => void res.status(202).json({}));
  app.post("/api/auth/workspaces/start", (_req, res) => void res.status(202).json({ token: "t" }));
  return app;
}

describe("mail-sending auth routes", () => {
  it("count every request — a stream of 202s still runs out", async () => {
    const app = buildApp();
    for (let i = 0; i < MAIL_ROUTE_LIMIT_PER_WINDOW; i += 1) {
      expect((await request(app).post("/api/auth/forgot-password").send({ email: `a${i}@x.io` })).status).toBe(202);
    }
    const refused = await request(app).post("/api/auth/forgot-password").send({ email: "b@x.io" });
    expect(refused.status).toBe(429);
    expect(refused.body.message).toMatch(/too many/i);
  });

  it("give the workspace finder the same treatment", async () => {
    const app = buildApp();
    for (let i = 0; i < MAIL_ROUTE_LIMIT_PER_WINDOW; i += 1) await request(app).post("/api/auth/workspaces/start").send({});
    expect((await request(app).post("/api/auth/workspaces/start").send({})).status).toBe(429);
  });

  it("keep the two budgets apart, so finding a workspace does not use up a password reset", async () => {
    const app = buildApp();
    for (let i = 0; i <= MAIL_ROUTE_LIMIT_PER_WINDOW; i += 1) await request(app).post("/api/auth/workspaces/start").send({});
    expect((await request(app).post("/api/auth/forgot-password").send({ email: "a@x.io" })).status).toBe(202);
  });
});
