/**
 * `ApiKey` had `revokedAt` but no `expiresAt`, so a public-API key was valid forever unless
 * somebody remembered to revoke it. That is the credential nobody revisits: a `tsk_…` bearer token
 * pasted into a customer's Zapier account or a cron script, where `lastUsedAt` is the only signal
 * it is still out there at all.
 *
 * It was also an inconsistency inside one product rather than an oversight in isolation — the other
 * standing bearer credential here, `McpCredential`, took `expiresAt` in
 * 20260808230000_mcp_credential_expiry and enforces it in services/mcp.service.ts. This closes the
 * gap for the one that did not.
 *
 * TWO PROPERTIES ARE PINNED, and the second is the one easy to regress:
 *
 *  1. An expired key stops authenticating — checked at the boundary in
 *     middleware/public-api-auth.ts, so every route under /api/public/v1 inherits it rather than
 *     each one remembering.
 *  2. `expiresAt === null` still works, forever. Every key issued before the column existed reads
 *     that way, and an upgrade that silently expired live integrations would be the wrong
 *     direction for a mistake to fail in. A test that only covered the expiry would pass just as
 *     happily against a version that broke this.
 *
 * The real middleware is driven through supertest rather than the predicate re-implemented — same
 * reasoning as ai-route-hardening.test.ts: a re-implementation passes against the version without
 * the fix.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const update = vi.fn().mockResolvedValue({});

vi.mock("../../src/config/prisma.js", () => ({
  prisma: { apiKey: { findUnique: (...a: unknown[]) => findUnique(...a), update: (...a: unknown[]) => update(...a) } }
}));

const { publicApiAuth } = await import("../../src/middleware/public-api-auth.js");
const { errorHandler } = await import("../../src/middleware/error.js");
/** The creation-side half of the same rule — see the "raw string a handler really sees" test. */
const { parseOptionalExpiry } = await import("../../src/controllers/settings.controller.js");

/** A live key, minus whatever the test overrides. */
const key = (overrides: Record<string, unknown> = {}) => ({
  id: "key-1",
  scope: "READ",
  revokedAt: null,
  expiresAt: null,
  ...overrides
});

function app() {
  const a = express();
  a.get("/api/public/v1/ping", publicApiAuth, (_req, res) => res.json({ ok: true }));
  a.use(errorHandler);
  return a;
}

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  findUnique.mockReset();
  update.mockClear();
});

describe("public API key expiry", () => {
  it("accepts a key with no expiry — the pre-existing behaviour, unchanged", async () => {
    findUnique.mockResolvedValue(key({ expiresAt: null }));
    const res = await request(app()).get("/api/public/v1/ping").set("Authorization", "Bearer tsk_live");
    expect(res.status).toBe(200);
  });

  it("accepts a key whose expiry is still in the future", async () => {
    findUnique.mockResolvedValue(key({ expiresAt: new Date(Date.now() + HOUR) }));
    const res = await request(app()).get("/api/public/v1/ping").set("Authorization", "Bearer tsk_live");
    expect(res.status).toBe(200);
  });

  it("refuses a key whose expiry has passed", async () => {
    findUnique.mockResolvedValue(key({ expiresAt: new Date(Date.now() - HOUR) }));
    const res = await request(app()).get("/api/public/v1/ping").set("Authorization", "Bearer tsk_expired");
    expect(res.status).toBe(401);
  });

  it("says nothing about WHY — expired, revoked and unknown are one message", async () => {
    // A distinct "your key expired" would confirm to an unauthenticated caller that the key they
    // hold was once real, which is the single most useful bit of information to a guesser.
    findUnique.mockResolvedValue(key({ expiresAt: new Date(Date.now() - HOUR) }));
    const expired = await request(app()).get("/api/public/v1/ping").set("Authorization", "Bearer tsk_a");

    findUnique.mockResolvedValue(key({ revokedAt: new Date(Date.now() - HOUR) }));
    const revoked = await request(app()).get("/api/public/v1/ping").set("Authorization", "Bearer tsk_b");

    findUnique.mockResolvedValue(null);
    const unknown = await request(app()).get("/api/public/v1/ping").set("Authorization", "Bearer tsk_c");

    expect(expired.status).toBe(401);
    expect(expired.body.message).toBe(revoked.body.message);
    expect(expired.body.message).toBe(unknown.body.message);
  });

  it("does not stamp lastUsedAt for an expired key", async () => {
    // `lastUsedAt` is the signal an admin reads to decide whether a key is still in use. Touching
    // it on a refused request would make a dead credential look live.
    findUnique.mockResolvedValue(key({ expiresAt: new Date(Date.now() - HOUR) }));
    await request(app()).get("/api/public/v1/ping").set("Authorization", "Bearer tsk_expired");
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses an already-past expiry at CREATION, given the raw string a handler really sees", async () => {
    // THE BUG THIS PINS, found by creating a key against the running server rather than by reading
    // the code: `middleware/validate.ts` parses the schema and DISCARDS the result, so
    // `z.coerce.date()` never writes a Date back and `req.body.expiresAt` is still an ISO STRING in
    // the handler. The original guard, `req.body.expiresAt <= new Date()`, therefore compared a
    // string to a Date — a relational operator takes the Date as a timestamp and coerces the string
    // to NaN, and every comparison with NaN is false. The guard always passed, and a key could be
    // created already expired.
    //
    // Asserted through `parseOptionalExpiry` with a STRING, because that is the type the route
    // actually receives; handing it a Date would pass against the broken version too.
    expect(() => parseOptionalExpiry("2020-01-01T00:00:00.000Z")).toThrow(/already in the past/);
    expect(() => parseOptionalExpiry(new Date(Date.now() - HOUR))).toThrow(/already in the past/);
  });

  it("accepts a future expiry and normalises it to a Date", () => {
    const future = new Date(Date.now() + HOUR).toISOString();
    const parsed = parseOptionalExpiry(future);
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed!.toISOString()).toBe(future);
  });

  it("treats an absent expiry as 'never', not as an error", () => {
    // Null is what both callers store to mean "never expires" — the shape every key issued before
    // the column existed already has.
    expect(parseOptionalExpiry(undefined)).toBeNull();
    expect(parseOptionalExpiry(null)).toBeNull();
    expect(parseOptionalExpiry("")).toBeNull();
  });

  it("refuses a value that is not a date at all", () => {
    expect(() => parseOptionalExpiry("not-a-date")).toThrow(/valid date/);
  });

  it("treats the expiry instant as elapsed rather than valid", async () => {
    // `<=`, not `<`. A key expiring "now" is expired; the boundary should not be a live moment.
    findUnique.mockResolvedValue(key({ expiresAt: new Date(Date.now() - 1) }));
    const res = await request(app()).get("/api/public/v1/ping").set("Authorization", "Bearer tsk_boundary");
    expect(res.status).toBe(401);
  });
});
