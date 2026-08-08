/**
 * The event seam.
 *
 * Two things worth pinning, and neither is "does the emitter emit".
 *
 *   1. THE ticket.closed RULE LIVES IN ONE PLACE. It used to be written out three times — the
 *      app's own controller, the public REST API, and the MCP tool layer — because those are three
 *      write paths for the same act. Three copies of a rule is a rule that becomes four copies,
 *      one of which is wrong. A structural test below asserts no call site writes it again.
 *
 *   2. A SUBSCRIBER CANNOT BREAK THE CALLER. A ticket save must never fail because something
 *      listening to it misbehaved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dispatchSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/webhook-dispatch.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/webhook-dispatch.service.js")>()),
  dispatchOutboundWebhooks: dispatchSpy
}));

const { emitDomainEvent, emitTicketStatusChanged, registerDomainSubscriber, DOMAIN_EVENTS } = await import(
  "../../src/services/domain-events.js"
);
const { WEBHOOK_EVENTS } = await import("../../src/services/webhook-dispatch.service.js");

/** The fan-out is detached, so a test has to let the microtask queue drain before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => dispatchSpy.mockClear());

describe("the ticket.closed rule, now written once", () => {
  it("fires status_changed and closed together on a close", async () => {
    emitTicketStatusChanged({ id: "t1" }, "OPEN", "CLOSED");
    await settle();

    const events = dispatchSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("ticket.status_changed");
    expect(events).toContain("ticket.closed");
  });

  it("fires only status_changed on an ordinary transition", async () => {
    emitTicketStatusChanged({ id: "t1" }, "OPEN", "IN_PROGRESS");
    await settle();

    expect(dispatchSpy.mock.calls.map((c) => c[0])).toEqual(["ticket.status_changed"]);
  });

  it("recognises a reopen, which no call site ever did", async () => {
    // Internal-only: `ticket.reopened` is not in WEBHOOK_EVENTS, so it reaches in-process
    // subscribers without becoming a customer-visible webhook event.
    const seen: string[] = [];
    registerDomainSubscriber({
      name: "test-reopen",
      events: ["ticket.reopened"],
      handle: async (event) => void seen.push(event)
    });

    emitTicketStatusChanged({ id: "t1" }, "CLOSED", "OPEN");
    await settle();

    expect(seen).toEqual(["ticket.reopened"]);
    // ...and the public webhook fan-out never saw it.
    expect(dispatchSpy.mock.calls.map((c) => c[0])).not.toContain("ticket.reopened");
  });
});

describe("the internal vocabulary is a superset of the public one", () => {
  it("carries every public event, so nothing subscribable stopped being emitted", () => {
    for (const event of WEBHOOK_EVENTS) expect(DOMAIN_EVENTS).toContain(event);
  });

  it("never sends an internal-only event to the webhook subscriber", async () => {
    emitDomainEvent("agent.run_finished", { runId: "r1" });
    await settle();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe("a broken subscriber cannot reach the caller", () => {
  it("swallows a throwing subscriber and still runs the others", async () => {
    const good = vi.fn().mockResolvedValue(undefined);
    registerDomainSubscriber({
      name: "throws",
      events: ["proposal.applied"],
      handle: async () => {
        throw new Error("boom");
      }
    });
    registerDomainSubscriber({ name: "fine", events: ["proposal.applied"], handle: good });

    // Synchronous and non-throwing at the call site is the property: a controller emits and moves on.
    expect(() => emitDomainEvent("proposal.applied", { id: "p1" })).not.toThrow();
    await settle();

    expect(good).toHaveBeenCalled();
  });
});

/**
 * STRUCTURAL. The point of the seam is that the "and also fire ticket.closed" rule stopped being
 * copied per write path. A new controller that reaches for `dispatchOutboundWebhooks` directly
 * would silently reintroduce exactly that, and no behavioural test can see it — the code would
 * work, it would just be the fourth copy.
 */
describe("nothing bypasses the seam", () => {
  const SRC = join(process.cwd(), "src");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return name.endsWith(".ts") ? [full] : [];
    });
  }

  it("only domain-events.ts calls dispatchOutboundWebhooks", () => {
    const offenders = sourceFiles(SRC).filter((file) => {
      const base = file.replace(/\\/g, "/");
      if (base.endsWith("/webhook-dispatch.service.ts") || base.endsWith("/domain-events.ts")) return false;
      return readFileSync(file, "utf8").includes("dispatchOutboundWebhooks(");
    });

    expect(offenders.map((f) => f.replace(process.cwd(), ""))).toEqual([]);
  });
});
