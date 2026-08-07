/**
 * SMTP settings are a TENANT setting (`GlobalMailSettings` lives in each org's own database) but
 * one Node process serves every org, so mail.service.ts's transport cache is a cross-tenant
 * boundary. These tests pin that boundary.
 *
 * The shape they were written against had five single-slot module variables. Two leaks fell out
 * of that, and both are asserted below:
 *   - `lastResolvedConfig` was written inside getTransport() and read back by sendMail AFTER
 *     awaiting it. Resolving the config is a DB round-trip, so a concurrent request from another
 *     org routinely won that window — org A's mail went out with org B's From address.
 *   - `transportVerified`/`transportVerifyError` were global, so org A's admin "Mail server"
 *     banner reported whichever org last built a transport, naming its host and SMTP user.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const hoisted = vi.hoisted(() => ({
  sent: [] as Array<{ host: string; from: string }>,
  /** How many transports were built per host — a single-slot cache thrashes, rebuilding (and
   *  re-verifying, and re-opening a connection pool) every time two orgs alternate. */
  builds: [] as string[],
  /** Per-host verify outcome, so a "bad" org's SMTP failure can be told apart from a good one's. */
  verifyFailures: new Map<string, string>()
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: (opts: { host: string }) => ({
      __built: hoisted.builds.push(opts.host),
      verify: () => {
        const failure = hoisted.verifyFailures.get(opts.host);
        return failure ? Promise.reject(new Error(failure)) : Promise.resolve(true);
      },
      sendMail: (msg: { from: string }) => {
        hoisted.sent.push({ host: opts.host, from: msg.from });
        return Promise.resolve({ messageId: "m-1", response: "250 OK" });
      },
      close: () => undefined
    })
  }
}));

const { sendMail, getTransportStatus, invalidateMailTransportCache } = await import("../../src/services/mail.service.js");

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function mailRow(host: string, from: string) {
  return { id: "global", host, port: 587, secure: false, user: `postmaster@${host}`, password: null, fromAddress: from };
}

/** Only the models mail.service.ts touches. `globalMailSettings.findUnique` is the one whose
 *  timing matters — it's the await the old code raced against. */
function fakeClient(settings: unknown | Promise<unknown>): PrismaClient {
  return {
    globalMailSettings: { findUnique: vi.fn(() => Promise.resolve(settings)) },
    globalNotificationSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    emailLog: { create: vi.fn().mockResolvedValue({ id: "log-1" }), update: vi.fn().mockResolvedValue({}) },
    user: { findMany: vi.fn().mockResolvedValue([]) }
  } as unknown as PrismaClient;
}

let orgSeq = 0;
/** Fresh org ids per test: the transport cache is module state that survives the whole file. */
const orgs = () => [`org-a-${++orgSeq}`, `org-b-${orgSeq}`] as const;

const message = { to: "someone@example.com", subject: "Hi", html: "<p>Hi</p>", template: "t", skipBcc: true };

beforeEach(() => {
  hoisted.sent.length = 0;
  hoisted.builds.length = 0;
  hoisted.verifyFailures.clear();
});

describe("transport cache is per-org", () => {
  it("each org's status reports its OWN SMTP host, not whichever org resolved last", async () => {
    const a = fakeClient(mailRow("smtp.alpha.test", "no-reply@alpha.test"));
    const b = fakeClient(mailRow("smtp.beta.test", "no-reply@beta.test"));
    const [orgA, orgB] = orgs();

    expect((await runInTenant(a, () => getTransportStatus(), orgA)).host).toBe("smtp.alpha.test");
    expect((await runInTenant(b, () => getTransportStatus(), orgB)).host).toBe("smtp.beta.test");
    // The re-read is the point: a single-slot cache now holds org B's config.
    const again = await runInTenant(a, () => getTransportStatus(), orgA);
    expect(again.host).toBe("smtp.alpha.test");
    expect(again.user).toBe("postmaster@smtp.alpha.test");
    expect(again.from).toBe("no-reply@alpha.test");
    // Each org built its transport exactly once. A single shared slot would have torn down and
    // rebuilt alpha's pool (and re-run verify) when the read alternated back to it.
    expect(hoisted.builds).toEqual(["smtp.alpha.test", "smtp.beta.test"]);
  });

  it("one org's SMTP verification failure never surfaces in another org's banner", async () => {
    hoisted.verifyFailures.set("smtp.beta.test", "535 5.7.8 Authentication failed for beta");
    const a = fakeClient(mailRow("smtp.alpha.test", "no-reply@alpha.test"));
    const b = fakeClient(mailRow("smtp.beta.test", "no-reply@beta.test"));
    const [orgA, orgB] = orgs();

    await runInTenant(a, () => getTransportStatus(), orgA);
    await runInTenant(b, () => getTransportStatus(), orgB);
    // verify() settles on a microtask; let both land before reading either banner.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const statusA = await runInTenant(a, () => getTransportStatus(), orgA);
    expect(statusA.verified).toBe(true);
    expect(statusA.verifyError).toBeNull();

    const statusB = await runInTenant(b, () => getTransportStatus(), orgB);
    expect(statusB.verified).toBe(false);
    expect(statusB.verifyError).toContain("beta");
  });

  it("saving one org's mail settings does not invalidate another org's cached transport", async () => {
    const a = fakeClient(mailRow("smtp.alpha.test", "no-reply@alpha.test"));
    const b = fakeClient(mailRow("smtp.beta.test", "no-reply@beta.test"));
    const [orgA, orgB] = orgs();
    await runInTenant(a, () => getTransportStatus(), orgA);
    const readsBefore = vi.mocked(a.globalMailSettings.findUnique).mock.calls.length;

    await runInTenant(b, () => invalidateMailTransportCache(), orgB);

    const statusA = await runInTenant(a, () => getTransportStatus(), orgA);
    expect(statusA.host).toBe("smtp.alpha.test");
    // Config is always re-read (it's how a save is picked up)…
    expect(vi.mocked(a.globalMailSettings.findUnique).mock.calls.length).toBeGreaterThan(readsBefore);
    // …but org A's live connection pool must survive org B saving its own settings.
    expect(hoisted.builds).toEqual(["smtp.alpha.test"]);
  });
});

describe("a concurrent send from another tenant cannot restamp the From address", () => {
  it("org A's mail keeps org A's From even when org B's config resolves in the middle", async () => {
    const slowA = deferred<unknown>();
    const slowB = deferred<unknown>();
    const a = fakeClient(slowA.promise);
    const b = fakeClient(slowB.promise);
    const [orgA, orgB] = orgs();

    // Both sends are parked on their own settings read…
    const pendingA = runInTenant(a, () => sendMail(message), orgA);
    const pendingB = runInTenant(b, () => sendMail(message), orgB);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // …then released in the same tick, A first. Their continuations interleave one microtask
    // apart, so B's config resolution lands between A resolving its own config and A reading it
    // back — precisely the window the old module-level `lastResolvedConfig` lost.
    slowA.resolve(mailRow("smtp.alpha.test", "no-reply@alpha.test"));
    slowB.resolve(mailRow("smtp.beta.test", "no-reply@beta.test"));
    await Promise.all([pendingA, pendingB]);

    // Each message went out over its own org's SMTP host AND with its own org's From address.
    expect(hoisted.sent).toContainEqual({ host: "smtp.alpha.test", from: "no-reply@alpha.test" });
    expect(hoisted.sent).toContainEqual({ host: "smtp.beta.test", from: "no-reply@beta.test" });
    expect(hoisted.sent).toHaveLength(2);
  });
});
