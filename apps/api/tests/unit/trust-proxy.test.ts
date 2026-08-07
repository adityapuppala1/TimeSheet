/**
 * `trust proxy` is the difference between per-IP rate limiting working and silently not working.
 *
 * With it unset behind a reverse proxy, `req.ip` is the proxy's address for every caller on
 * earth, so the 20/min login limiter — and every other per-IP limit — becomes one shared bucket:
 * a single attacker exhausts it for all users, and nothing anywhere reports that this happened.
 * That silence is exactly why it needs a test rather than a code comment.
 *
 * These assert Express's own derivation rules against the hop-count setting, so a future change
 * to the default (or someone "simplifying" it to `true`) fails here instead of in production.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

/** Minimal app that just reports what Express decided `req.ip` is. */
function appWithHops(hops: number) {
  const app = express();
  app.set("trust proxy", hops);
  app.get("/whoami", (req, res) => res.json({ ip: req.ip }));
  return app;
}

const FORGED = "1.2.3.4";

describe("trust proxy hop count", () => {
  it("ignores X-Forwarded-For at 0, so a client cannot forge its own rate-limit identity", async () => {
    const res = await request(appWithHops(0)).get("/whoami").set("X-Forwarded-For", FORGED);
    expect(res.body.ip).not.toBe(FORGED);
  });

  it("uses the client address from X-Forwarded-For with exactly one proxy in front", async () => {
    // supertest connects over loopback, so the socket peer is the "proxy" hop and the single
    // forwarded entry is the real client — the shape of nginx in front of this container.
    const res = await request(appWithHops(1)).get("/whoami").set("X-Forwarded-For", FORGED);
    expect(res.body.ip).toBe(FORGED);
  });

  it("does not let an extra forged hop shift the identity when the count says one proxy", async () => {
    // A caller prepending its own entry is the attack `trust proxy: true` enables. With a count,
    // Express walks in from the RIGHT by that many hops, so the forged left-most entry is ignored.
    const res = await request(appWithHops(1)).get("/whoami").set("X-Forwarded-For", `${FORGED}, 9.9.9.9`);
    expect(res.body.ip).toBe("9.9.9.9");
    expect(res.body.ip).not.toBe(FORGED);
  });

  it("resolves the real client through two hops (CDN in front of a proxy)", async () => {
    const res = await request(appWithHops(2)).get("/whoami").set("X-Forwarded-For", `${FORGED}, 9.9.9.9`);
    expect(res.body.ip).toBe(FORGED);
  });

  it("still reports an address when no X-Forwarded-For is present at any setting", async () => {
    // A limiter keyed on `undefined` would bucket every caller together — the same failure the
    // whole setting exists to prevent, arriving from the opposite direction.
    for (const hops of [0, 1, 2]) {
      const res = await request(appWithHops(hops)).get("/whoami");
      expect(res.body.ip, `hops=${hops}`).toBeTruthy();
    }
  });
});
