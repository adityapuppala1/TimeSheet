/**
 * Duplicate-key handling, both layers:
 *  1. The project-create route's own pre-check — a 409 that NAMES the colliding project,
 *    because "Project_code_key violated" can't tell an admin which (possibly archived) project
 *    holds the code.
 *  2. The error middleware's Prisma-translation floor — a route WITHOUT a pre-check (module
 *    creation, unique [projectId, name]) must yield a generic-but-human 409, never the raw
 *    `Invalid prisma.x.create() invocation` dump a user pasted from production as a 500.
 */
import { expect, test } from "@playwright/test";
import { withAdminRequest } from "./helpers/admin-request";

test.describe("duplicate keys answer like a product, not an ORM", () => {
  test("duplicate project code → named 409; duplicate module name → translated 409", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const projects = await (await ctx.get("/api/projects", { headers })).json();
      const existing = (Array.isArray(projects) ? projects : projects.items)[0];
      expect(existing?.code, "the workspace needs at least one project").toBeTruthy();

      // Layer 1: the pre-check names the collision.
      const dupProject = await ctx.post("/api/projects", {
        headers,
        data: { code: existing.code, name: "Duplicate Probe" }
      });
      expect(dupProject.status()).toBe(409);
      const projectBody = await dupProject.json();
      expect(projectBody.message).toContain(existing.code);
      expect(projectBody.message).toContain("already used by");
      expect(projectBody.message).not.toContain("prisma");

      // Layer 2: no pre-check on modules — the middleware floor must still translate P2002.
      const moduleName = `E2E Dup Module ${Date.now()}`;
      const first = await ctx.post(`/api/projects/${existing.id}/modules`, { headers, data: { name: moduleName } });
      expect(first.status(), await first.text()).toBeLessThan(300);
      const createdModule = await first.json();
      try {
        const second = await ctx.post(`/api/projects/${existing.id}/modules`, { headers, data: { name: moduleName } });
        expect(second.status(), "a duplicate module name must be a 409, not a raw 500").toBe(409);
        const moduleBody = await second.json();
        expect(moduleBody.message).toMatch(/already in use|unique/i);
        expect(moduleBody.message).not.toContain("prisma");
        // Renames: modules and submodules were create-only, so a typo at creation was
        // permanent. PATCH must rename and return the new name.
        const renamed = await ctx.patch(`/api/projects/modules/${createdModule.id}`, {
          headers,
          data: { name: `${moduleName} (renamed)` }
        });
        expect(renamed.status(), await renamed.text()).toBe(200);
        expect((await renamed.json()).name).toBe(`${moduleName} (renamed)`);

        // Project rename round-trips too, and is restored to leave the workspace as found.
        const renamedProject = await ctx.patch(`/api/projects/${existing.id}`, {
          headers,
          data: { name: `${existing.name} *` }
        });
        expect(renamedProject.status(), await renamedProject.text()).toBe(200);
        const restoreName = await ctx.patch(`/api/projects/${existing.id}`, { headers, data: { name: existing.name } });
        expect(restoreName.ok(), "failed to restore the project name").toBe(true);
      } finally {
        // Modules may not expose a delete route — cleanup is best-effort, and one extra module
        // named "E2E Dup Module <ts>" in a demo workspace is visible, not corrupting.
        await ctx.delete(`/api/projects/modules/${createdModule.id}`, { headers }).catch(() => {});
      }
    });
  });
});

test.describe("maintenance window sanity", () => {
  test("a NEW start in the past is refused; nothing gets armed by the refusal", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const res = await ctx.patch("/api/maintenance/settings", {
        headers,
        data: { enabled: true, scheduledStartAt: yesterday, scheduledEndAt: tomorrow, message: null }
      });
      expect(res.status(), await res.text()).toBe(422);
      expect((await res.json()).message).toContain("past");

      // The refusal must not have armed anything.
      const view = await (await ctx.get("/api/maintenance/admin", { headers })).json();
      expect(view.settings.enabled, "a 422 must leave maintenance mode untouched").toBe(false);
    });
  });
});
