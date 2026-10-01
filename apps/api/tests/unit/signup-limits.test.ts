/**
 * The signup rate limits, through the same mounting app.ts uses (`mountSignupRoutes`).
 *
 * Phase 1 made signup a 3-to-6-request flow (start → verify → complete or join, plus a corrected
 * address or a "verify again"), and the join path is, by design, several colleagues behind ONE office
 * network. A single 5-an-hour budget across every step turned that into a 429 mid-flow, blamed on
 * "this network". Pinned:
 *  - the step that SENDS MAIL (`/start`) keeps the tight budget;
 *  - the later steps have their own, looser one — each needs a code or continuation that `/start`
 *    already paid for, so they cannot be used to mint work on their own;
 *  - spending the code budget does not lock someone out of finishing a signup already started;
 *  - `/status` is never counted against either.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { SIGNUP_CODE_LIMIT_PER_HOUR, SIGNUP_STEP_LIMIT_PER_HOUR, mountSignupRoutes } from "../../src/middleware/signup-limits.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  for (const step of ["start", "verify", "complete", "join"]) router.post(`/${step}`, (_req, res) => res.json({ step }));
  mountSignupRoutes(app, { router, statusHandler: (_req, res) => void res.json({ open: true }) });
  return app;
}

describe("signup rate limits", () => {
  it("allows the code budget of /start, then answers 429 with a message the page can show", async () => {
    const app = buildApp();
    for (let i = 0; i < SIGNUP_CODE_LIMIT_PER_HOUR; i += 1) expect((await request(app).post("/api/signup/start").send({})).status).toBe(200);
    const refused = await request(app).post("/api/signup/start").send({});
    expect(refused.status).toBe(429);
    expect(refused.body.message).toMatch(/verification codes/i);
  });

  it("lets a signup already started finish after the code budget is spent", async () => {
    const app = buildApp();
    for (let i = 0; i <= SIGNUP_CODE_LIMIT_PER_HOUR; i += 1) await request(app).post("/api/signup/start").send({});
    expect((await request(app).post("/api/signup/verify").send({})).status).toBe(200);
    expect((await request(app).post("/api/signup/join").send({})).status).toBe(200);
  });

  it("gives the whole office room: the longest designed path, twice over, stays inside the step budget", async () => {
    const app = buildApp();
    // start → verify → complete (taken address) → complete → [domain claimed] start → verify → join
    const path = ["start", "verify", "complete", "complete", "start", "verify", "join"];
    for (const person of [1, 2]) {
      for (const step of path) expect((await request(app).post(`/api/signup/${step}`).send({ person })).status).toBe(200);
    }
    expect(SIGNUP_STEP_LIMIT_PER_HOUR).toBeGreaterThanOrEqual(path.length * 3);
  });

  it("still caps the later steps", async () => {
    const app = buildApp();
    for (let i = 0; i < SIGNUP_STEP_LIMIT_PER_HOUR; i += 1) await request(app).post("/api/signup/verify").send({});
    expect((await request(app).post("/api/signup/verify").send({})).status).toBe(429);
  });

  it("never counts /status against either budget", async () => {
    const app = buildApp();
    for (let i = 0; i < SIGNUP_STEP_LIMIT_PER_HOUR + 5; i += 1) await request(app).get("/api/signup/status");
    expect((await request(app).post("/api/signup/start").send({})).status).toBe(200);
  });
});
