/**
 * THE WHOLE POINT OF THE FIX: a super admin can now actually switch the weekly practice update on.
 *
 * Before this, `practiceUpdateEnabled` was the one GlobalAISettings flag with no way in. The column
 * existed, `assertAIFeatureEnabled` refused every call because of it, the page told people to flip
 * a switch — and no route on this server would accept a write to it, because the `.strict()` AI
 * settings schema did not list the key. The only fix available to a customer was to edit MySQL.
 *
 * A registry entry alone would NOT have fixed that. The capabilities card saves through
 * `PATCH /settings/ai`, so the write path has to be walked, not assumed: this test drives the real
 * router with supertest and then reads the flag back through the real gate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "sa-1", name: "Root", email: "sa@x.io", role: "SUPER_ADMIN", permissions: [] as string[] };

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] };
      next();
    }
  };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { settingsRouter } = await import("../../src/controllers/settings.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { assertAIFeatureEnabled } = await import("../../src/services/ai.service.js");

let client: PrismaClient;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/settings", settingsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  client = createFakeTenantClient();
  // The row the upsert returns. Written by the handler, echoed back to the card.
  vi.mocked(client.globalAISettings.upsert).mockImplementation((async (args: {
    update: Record<string, unknown>;
  }) => ({ id: "global", aiEnabled: true, practiceUpdateEnabled: false, ...args.update })) as never);
});

describe("PATCH /settings/ai — practiceUpdateEnabled", () => {
  it("accepts the key and writes the column", async () => {
    const res = await request(buildApp()).patch("/api/settings/ai").send({ practiceUpdateEnabled: true });

    // A 400 here is the original bug: `.strict()` rejecting a key the UI sends, which an admin
    // reads as "Unrecognized key(s)" with nothing naming the cause.
    expect(res.status).toBe(200);
    expect(res.body.practiceUpdateEnabled).toBe(true);

    const call = vi.mocked(client.globalAISettings.upsert).mock.calls[0][0] as { update: Record<string, unknown> };
    expect(call.update.practiceUpdateEnabled).toBe(true);
  });

  it("can switch it back off again", async () => {
    const res = await request(buildApp()).patch("/api/settings/ai").send({ practiceUpdateEnabled: false });
    expect(res.status).toBe(200);
    const call = vi.mocked(client.globalAISettings.upsert).mock.calls[0][0] as { update: Record<string, unknown> };
    expect(call.update.practiceUpdateEnabled).toBe(false);
  });

  it("opens the gate that was refusing the feature", async () => {
    // The other end of the same wire. This is the check whose 403 the customer was stuck behind.
    await runInTenant(client, async () => {
      vi.mocked(client.globalAISettings.upsert).mockResolvedValue({
        id: "global",
        aiEnabled: true,
        practiceUpdateEnabled: false
      } as never);
      await expect(assertAIFeatureEnabled("practiceUpdateEnabled")).rejects.toThrow(/disabled for this workspace/);

      vi.mocked(client.globalAISettings.upsert).mockResolvedValue({
        id: "global",
        aiEnabled: true,
        practiceUpdateEnabled: true
      } as never);
      await expect(assertAIFeatureEnabled("practiceUpdateEnabled")).resolves.toBeTruthy();
    }, "org-1");
  });
});
