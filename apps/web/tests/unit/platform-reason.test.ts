/**
 * Which console requests the operator is asked "why?" for.
 *
 * Two things are checked, and the second is the one that will catch a real bug.
 *
 * 1. The table classifies the tricky paths correctly. `/backups/:id` and `/backups/:id/download`
 *    are snapshots; `/backups/destinations/:id`, `/backups/policy/:orgId` and `/backups/run/:orgId`
 *    live under the same prefix and are not. Get that wrong in one direction and saving a
 *    destination pops a justification dialog for no reason; get it wrong in the other and deleting
 *    a customer's last snapshot goes unexplained.
 *
 * 2. IT STILL AGREES WITH THE SERVER. The API is the authority — `requirePlatformReason` is what
 *    actually refuses a request — and this table is a hand-written copy of that decision. A
 *    hand-written copy of a list is exactly the drift this repo keeps getting bitten by, and the
 *    failure is unpleasant: the server answers 400 and the operator sees a raw error instead of a
 *    prompt. So the test reads the two controllers' source and checks every route that mounts the
 *    middleware is one this table would ask about.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reasonRequirementFor } from "../../src/services/platform-reason";

/* Same lazy `read` helper the sibling settings-tabs guard uses, and for the same Windows/Linux
   reason written up there: never a string edit on the href. */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the paths that are easy to get wrong", () => {
  it("treats snapshot routes as needing a reason", () => {
    expect(reasonRequirementFor("GET", "/backups/snap-1/download")).toMatch(/entire copy/i);
    expect(reasonRequirementFor("POST", "/backups/snap-1/restore")).toMatch(/restore/i);
    expect(reasonRequirementFor("DELETE", "/backups/snap-1")).toMatch(/snapshot/i);
  });

  it("does NOT mistake backup configuration for a snapshot", () => {
    expect(reasonRequirementFor("DELETE", "/backups/destinations/d-1")).toBeNull();
    expect(reasonRequirementFor("PATCH", "/backups/destinations/d-1")).toBeNull();
    expect(reasonRequirementFor("PUT", "/backups/policy/org-1")).toBeNull();
    expect(reasonRequirementFor("GET", "/backups/overview")).toBeNull();
    expect(reasonRequirementFor("GET", "/backups")).toBeNull();
  });

  it("asks for the two backup actions that touch a live workspace", () => {
    expect(reasonRequirementFor("POST", "/backups/run/org-1")).toBeTruthy();
    expect(reasonRequirementFor("POST", "/backups/sweep/org-1")).toBeTruthy();
  });

  it("leaves ordinary reads alone — a prompt on every page load teaches people to dismiss it", () => {
    expect(reasonRequirementFor("GET", "/overview")).toBeNull();
    expect(reasonRequirementFor("GET", "/organizations")).toBeNull();
    expect(reasonRequirementFor("GET", "/organizations/org-1")).toBeNull();
    expect(reasonRequirementFor("GET", "/audit?page=2")).toBeNull();
    expect(reasonRequirementFor("GET", "/admins")).toBeNull();
  });

  it("matches on the METHOD too, not only the path", () => {
    expect(reasonRequirementFor("GET", "/organizations/org-1")).toBeNull();
    expect(reasonRequirementFor("PATCH", "/organizations/org-1")).toBeTruthy();
  });

  it("ignores a query string and a trailing slash", () => {
    expect(reasonRequirementFor("GET", "/backups/snap-1/download?x=1")).toBeTruthy();
    expect(reasonRequirementFor("DELETE", "/backups/snap-1/")).toBeTruthy();
  });
});

/* --------------------------- drift guard against the real API ---------------------------- */

const SOURCES = ["platform-admin.controller.ts", "platform-admin-console.controller.ts"].map((f) => read(`../../../api/src/controllers/${f}`));

/**
 * Every route registration that mounts `requirePlatformReason`, as `[METHOD, express path]`.
 *
 * Split on the router calls rather than doing a full TypeScript parse — a parser would be a heavier
 * dependency than the drift it guards against.
 *
 * EACH CHUNK RUNS TO THE NEXT REGISTRATION, not to a fixed window, and that detail is not
 * cosmetic: the first version of this read a generous 600 characters and reported `GET
 * /email-log/:id` and `PUT /retention/settings` as needing reasons — because the NEXT route in each
 * case (`POST /email-log/:id/resend`, `POST /retention/run`) does, and the window ran into it. A
 * drift guard that invents routes is worse than none, because the first thing anybody does with it
 * is add the phantom to the client's table.
 */
function routesRequiringReason(source: string): [string, string][] {
  const re = /platformAdmin(?:Console)?Router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  const matches = [...source.matchAll(re)];
  return matches
    .map((match, i) => {
      const end = matches[i + 1]?.index ?? source.length;
      const chunk = source.slice(match.index, end);
      return chunk.includes("requirePlatformReason") ? ([match[1].toUpperCase(), match[2]] as [string, string]) : null;
    })
    .filter((row): row is [string, string] => row !== null);
}

/** `/organizations/:id/domains` → `/organizations/x/domains`, so the client's regexes can match. */
const concrete = (path: string) => path.replace(/:[A-Za-z0-9_]+/g, "x1");

describe("the client's table still agrees with the server's middleware", () => {
  const serverRoutes = SOURCES.flatMap(routesRequiringReason);

  it("finds the routes at all — a regex that matches nothing would pass every assertion below", () => {
    // If this number moves, that is fine and expected; a ZERO means the parse broke and this whole
    // drift guard silently stopped guarding anything.
    expect(serverRoutes.length).toBeGreaterThan(10);
  });

  it("asks for a reason on every route the API demands one for", () => {
    const missed = serverRoutes.filter(([method, path]) => reasonRequirementFor(method, concrete(path)) === null);
    expect(
      missed,
      `These API routes mount requirePlatformReason but services/platform-reason.ts would not prompt for one, so the operator will see a raw 400: ${JSON.stringify(missed)}`
    ).toEqual([]);
  });
});
