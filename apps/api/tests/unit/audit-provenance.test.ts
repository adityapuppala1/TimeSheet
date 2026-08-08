/**
 * Audit provenance — who acted, when `actorId` alone cannot say.
 *
 * Every automated actor in this product used to write `actorId: NULL`, so email intake, chat
 * intake, the SLA sweeps, the security ingest and a guest holding an approval link were all the
 * same row shape and could only be told apart by string-matching `action`. That was survivable
 * while every write ultimately traced back to a person. It stops being survivable the moment
 * anything acts on its own — which is what the rest of this work is building.
 *
 * Two kinds of test here, deliberately:
 *  - BEHAVIOURAL, that the writer does what it claims;
 *  - STRUCTURAL, that no call site has silently gone back to an unattributed NULL. The second kind
 *    reads the source, because the failure it guards against is a NEW call site written next
 *    year, and no behavioural test of today's eight sites can see that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";
import type { PrismaClient } from "@prisma/client";

const { audit } = await import("../../src/services/audit.service.js");
const { loadRequestUser } = await import("../../src/services/principal.service.js");

let client: PrismaClient;
beforeEach(() => {
  client = createFakeTenantClient();
});

/** The `data` object that reached Prisma. */
function written() {
  const calls = vi.mocked(client.auditLog.create).mock.calls;
  expect(calls.length).toBe(1);
  return (calls[0][0] as { data: Record<string, unknown> }).data;
}

describe("audit() keeps its old five-argument meaning", () => {
  it("writes actorType USER when called the way all ~181 existing sites call it", async () => {
    // The whole reason the parameter was appended rather than folded into an options object.
    await runInTenant(client, () => audit("user-1", "user.profile_updated", "User", "user-1", { field: "bio" }));

    const data = written();
    expect(data.actorId).toBe("user-1");
    expect(data.action).toBe("user.profile_updated");
    expect(data.metadata).toEqual({ field: "bio" });
    expect(data.actorType).toBeUndefined(); // left to the column default, not overwritten
  });

  it("adds nothing at all when provenance is omitted", async () => {
    await runInTenant(client, () => audit("user-1", "a", "User", "u"));
    expect(Object.keys(written()).sort()).toEqual(["action", "actorId", "entity", "entityId", "metadata"]);
  });
});

describe("audit() records provenance when given it", () => {
  it("carries actor type, label, before/after and the AI/agent ids", async () => {
    await runInTenant(client, () =>
      audit("user-1", "ticket.updated", "Ticket", "t-1", { via: "agent" }, {
        actorType: "AGENT",
        actorLabel: "agent:schedule_adjustment",
        before: { priority: "LOW" },
        after: { priority: "HIGH" },
        aiInteractionId: "int-9",
        agentRunId: "run-3",
        ipAddress: "10.0.0.4"
      })
    );

    const data = written();
    // The delegating human stays the actor — that is whose permissions were checked. actorType is
    // what says they did not press anything. Neither is derivable from the other.
    expect(data.actorId).toBe("user-1");
    expect(data.actorType).toBe("AGENT");
    expect(data.actorLabel).toBe("agent:schedule_adjustment");
    expect(data.before).toEqual({ priority: "LOW" });
    expect(data.after).toEqual({ priority: "HIGH" });
    expect(data.aiInteractionId).toBe("int-9");
    expect(data.agentRunId).toBe("run-3");
    expect(data.ipAddress).toBe("10.0.0.4");
  });
});

/**
 * STRUCTURAL. An `audit(undefined, ...)` with no provenance is an unattributable row, and it is
 * the exact shape this change exists to eliminate — so a new one should fail here rather than be
 * discovered by whoever is reading the log during an incident.
 */
describe("no call site writes an unattributed audit row", () => {
  const SRC = join(process.cwd(), "src");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return name.endsWith(".ts") ? [full] : [];
    });
  }

  it("every audit(undefined, …) names an actorType", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      let from = 0;
      for (;;) {
        const at = text.indexOf("audit(undefined", from);
        if (at === -1) break;
        from = at + 1;
        // The call spans several lines; the provenance object is the last argument, so look ahead
        // far enough to clear the largest existing metadata block.
        const window = text.slice(at, at + 1400);
        if (!window.includes("actorType:")) {
          offenders.push(`${file.replace(process.cwd(), "")}:${text.slice(0, at).split("\n").length}`);
        }
      }
    }

    expect(offenders, `unattributed audit() calls:\n${offenders.join("\n")}`).toEqual([]);
  });
});

/**
 * STRUCTURAL. `SYSTEM_ACCOUNT_EMAILS` in team.controller.ts filters reporter-of-record accounts out
 * of the org chart and user lists. It is a hand-kept list, and it had already drifted:
 * `GIT_INTEGRATION_SYSTEM_EMAIL` was missing, so that account showed up as a person with no manager
 * and no reports — indistinguishable from a real employee, which is why nobody noticed.
 */
describe("every system account is filtered out of the org chart", () => {
  it("SYSTEM_ACCOUNT_EMAILS names every *_SYSTEM_EMAIL constant in the codebase", () => {
    const controller = readFileSync(join(process.cwd(), "src/controllers/team.controller.ts"), "utf8");
    const listed = new Set(
      (controller.match(/const SYSTEM_ACCOUNT_EMAILS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );

    // Every exported constant whose name ends _SYSTEM_EMAIL is, by that naming, one of these.
    const declared = new Set<string>();
    const services = join(process.cwd(), "src/services");
    for (const name of readdirSync(services)) {
      if (!name.endsWith(".ts")) continue;
      for (const m of readFileSync(join(services, name), "utf8").matchAll(/export const (\w+_SYSTEM_EMAIL)\b/g)) {
        declared.add(m[1]);
      }
    }

    expect(declared.size).toBeGreaterThan(0);
    expect([...declared].filter((c) => !listed.has(c))).toEqual([]);
  });
});

describe("loadRequestUser is the one definition of an acting identity", () => {
  const row = {
    id: "u-1",
    name: "Dana",
    email: "dana@x.io",
    deletedAt: null,
    status: "ACTIVE",
    role: { name: "MANAGER", permissions: [{ permission: { key: "tickets:view" } }, { permission: { key: "plan:write" } }] }
  };

  it("produces exactly the req.user shape requireAuth produces", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue(row as never);
    const user = await runInTenant(client, () => loadRequestUser("u-1"));

    // Shape equality matters more than any individual field: every authorization helper in the
    // codebase reads this object, so a surface that builds it differently has different authority.
    expect(user).toEqual({
      id: "u-1",
      name: "Dana",
      email: "dana@x.io",
      role: "MANAGER",
      permissions: ["tickets:view", "plan:write"]
    });
  });

  it("refuses a soft-deleted account", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue({ ...row, deletedAt: new Date() } as never);
    expect(await runInTenant(client, () => loadRequestUser("u-1"))).toBeNull();
  });

  it("refuses a deactivated account — this is what makes offboarding take effect", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue({ ...row, status: "INACTIVE" } as never);
    expect(await runInTenant(client, () => loadRequestUser("u-1"))).toBeNull();
  });

  it("refuses an unknown id", async () => {
    vi.mocked(client.user.findUnique).mockResolvedValue(null as never);
    expect(await runInTenant(client, () => loadRequestUser("nope"))).toBeNull();
  });
});
