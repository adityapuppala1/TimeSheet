/**
 * The Ask AI chat's boundaries.
 *
 * The loop can consult tools and the tools run as the asking person — so the one property that
 * keeps the whole feature safe to point at a workspace is that EVERY tool is a read. An action
 * taken from a chat transcript has no review step, no proposal row and no undo; the design is that
 * the chat looks and never touches, and this file is what makes that a test failure instead of a
 * code-review hope.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/prisma.js", () => ({ prisma: {} }));

const { AI_CHAT_TOOLS } = await import("../../src/services/ai-chat-tools.js");

describe("the Ask AI tool registry", () => {
  it("is exactly the nine read tools", () => {
    // Pinned as a set: adding a tool is a decision about what a model may see, not a convenience
    // edit — and REMOVING one silently degrades answers into guesses.
    expect(AI_CHAT_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        "change_metrics",
        "get_ticket",
        "list_agents",
        "list_changes",
        "list_workflows",
        "my_timesheets",
        "search_tickets",
        "ticket_metrics",
        "timesheet_report"
      ].sort()
    );
  });

  it("contains no write, ever — greps the source for every Prisma write verb", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/services/ai-chat-tools.js", import.meta.url).href.replace("/ai-chat-tools.js", "/ai-chat-tools.ts").replace("file:///", ""), "utf8")
    );
    // The verbs, not the intent: a "create" hiding inside a helper would still need one of these to
    // reach the database from this file.
    for (const verb of [".create(", ".createMany(", ".update(", ".updateMany(", ".upsert(", ".delete(", ".deleteMany(", "$executeRaw", "$queryRaw"]) {
      expect(source.includes(verb), `ai-chat-tools.ts must not contain "${verb}" — the chat reads, it never writes`).toBe(false);
    }
  });

  it("scopes ticket and change reads through ticketProjectScope", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../../src/services/ai-chat-tools.js", import.meta.url).href.replace("/ai-chat-tools.js", "/ai-chat-tools.ts").replace("file:///", ""), "utf8")
    );
    // The same scope every page uses. A tool that forgot it would answer questions about projects
    // the asker cannot open.
    expect(source).toContain("ticketProjectScope");
    // And the personal timesheet tool is pinned to the asker, not a parameter.
    expect(source).toContain("userId: ctx.req.user.id");
  });

  it("gives every tool a description and an args hint the model can read", () => {
    for (const tool of AI_CHAT_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(10);
      expect(tool.args.length, tool.name).toBeGreaterThan(1);
    }
  });
});
