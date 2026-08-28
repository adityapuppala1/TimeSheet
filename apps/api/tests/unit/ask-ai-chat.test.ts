/**
 * The Ask AI chat's boundaries.
 *
 * The loop can consult tools and the tools run as the asking person — so the properties that keep
 * the whole feature safe to point at a workspace are that EVERY tool is a read, and that a tool
 * reaching past the asker's own projects is gated on a permission the pages already enforce. An
 * action taken from a chat transcript has no review step, no proposal row and no undo; the design is
 * that the chat looks and never touches, and this file is what makes that a test failure instead of
 * a code-review hope.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/prisma.js", () => ({ prisma: {} }));
// The guardrails borrow the AI layer's secret masking. Stubbed rather than loaded: pulling in
// ai.service drags the provider SDKs and the env schema into a test about a boolean predicate.
vi.mock("../../src/services/ai.service.js", () => ({ redactSecrets: (text: string) => text }));

const { AI_CHAT_TOOLS } = await import("../../src/services/ai-chat-tools.js");
const { AI_CHAT_ACTIONS } = await import("../../src/services/ai-chat-actions.js");
const { canUseTool, visibleTools, assertToolAllowed, sanitiseToolResult } = await import("../../src/services/ai-chat-guardrails.js");

// `fileURLToPath`, not a string edit on the href. Stripping "file:///" yields "C:/x/y" on Windows
// (right) and "home/runner/x" on Linux (wrong — the leading slash IS the root), so the hand-rolled
// version passed on the machine it was written on and ENOENT'd on every CI runner.
const readSource = async (file: string) => {
  const [fs, url] = await Promise.all([import("node:fs"), import("node:url")]);
  return fs.readFileSync(url.fileURLToPath(new URL(`../../src/services/${file}`, import.meta.url)), "utf8");
};

/** The two files that make up the read surface — both must stay provably read-only. */
const READ_SOURCES = ["ai-chat-tools.ts", "ai-chat-admin-tools.ts"];

describe("the Ask AI tool registry", () => {
  it("is exactly the pinned set of read tools", () => {
    // Pinned as a set: adding a tool is a decision about what a model may see, not a convenience
    // edit — and REMOVING one silently degrades answers into guesses.
    expect(AI_CHAT_TOOLS.map((t) => t.name).sort()).toEqual(
      [
        // Everyday, project-scoped.
        "change_metrics",
        "find_people",
        "get_ticket",
        // The in-app manual — shared data, no Prisma, role-filtered inside its run.
        "help_articles",
        "list_agents",
        "list_changes",
        "list_projects",
        "list_workflows",
        "my_timesheets",
        "search_tickets",
        "ticket_metrics",
        "timesheet_report",
        "timesheet_stats",
        // Operational — every one of these carries an access gate, asserted below.
        "ai_quality",
        "ai_spend",
        "api_performance",
        "audit_log",
        "automation_activity",
        "ci_runs",
        "email_analytics",
        "email_templates",
        "face_verification_stats",
        "goals_overview",
        "project_health",
        "scheduled_reports",
        "security_findings",
        "sso_and_auth",
        "service_health",
        "sla_and_escalations",
        "user_stats",
        "workspace_configuration"
      ].sort()
    );
  });

  it("contains no write, ever — greps both read sources for every Prisma write verb", async () => {
    for (const file of READ_SOURCES) {
      const source = await readSource(file);
      // The verbs, not the intent: a "create" hiding inside a helper would still need one of these
      // to reach the database from this file.
      for (const verb of [".create(", ".createMany(", ".update(", ".updateMany(", ".upsert(", ".delete(", ".deleteMany(", "$executeRaw", "$queryRaw"]) {
        expect(source.includes(verb), `${file} must not contain "${verb}" — the chat reads, it never writes`).toBe(false);
      }
    }
  });

  it("scopes ticket and change reads through ticketProjectScope", async () => {
    const source = await readSource("ai-chat-tools.ts");
    // The same scope every page uses. A tool that forgot it would answer questions about projects
    // the asker cannot open.
    expect(source).toContain("ticketProjectScope");
    // And the personal timesheet tool is pinned to the asker, not a parameter.
    expect(source).toContain("userId: ctx.req.user.id");
  });

  it("gives every tool a description, an args hint and a group", () => {
    for (const tool of [...AI_CHAT_TOOLS, ...AI_CHAT_ACTIONS]) {
      expect(tool.description.length, tool.name).toBeGreaterThan(10);
      expect(tool.args.length, tool.name).toBeGreaterThan(1);
      // The group is what the capabilities panel sorts by; an ungrouped tool disappears from it.
      expect(tool.group?.length, `${tool.name} needs a group`).toBeGreaterThan(1);
    }
  });

  it("gates every operational tool — nothing cross-workspace is ungated", async () => {
    // The rule the split into two files exists to make checkable: a tool in the admin registry that
    // forgot its `access` would be offered to everyone, which is exactly the mistake the file
    // boundary is meant to catch.
    const { AI_CHAT_ADMIN_TOOLS } = await import("../../src/services/ai-chat-admin-tools.js");
    for (const tool of AI_CHAT_ADMIN_TOOLS) {
      expect(tool.access, `${tool.name} reaches past the asker's projects and must declare an access gate`).toBeTruthy();
      expect(Boolean(tool.access?.superAdminOnly || tool.access?.permission), tool.name).toBe(true);
    }
  });
});

describe("the Ask AI guardrails", () => {
  const engineer = { id: "u1", role: "EMPLOYEE", permissions: ["tickets:view"] };
  const reporter = { id: "u2", role: "MANAGER", permissions: ["tickets:view", "reports:view"] };
  const superAdmin = { id: "u3", role: "SUPER_ADMIN", permissions: [] };

  it("hides super-admin tools from everyone else, however many permissions they hold", () => {
    const spend = AI_CHAT_TOOLS.find((t) => t.name === "ai_spend")!;
    expect(canUseTool(spend, engineer)).toBe(false);
    // Not a permission that can be granted around: an ordinary role with every permission checked
    // still does not see workspace spend.
    expect(canUseTool(spend, { ...reporter, permissions: ["tickets:view", "reports:view", "audit:view", "users:manage"] })).toBe(false);
    expect(canUseTool(spend, superAdmin)).toBe(true);
  });

  it("gates permission-scoped tools on the permission the matching page requires", () => {
    const report = AI_CHAT_TOOLS.find((t) => t.name === "timesheet_report")!;
    expect(canUseTool(report, engineer)).toBe(false);
    expect(canUseTool(report, reporter)).toBe(true);
    // A super admin holds the role, not necessarily the permission list — and the Reports page is
    // reachable to them, so the chat must not be stricter than the page.
    expect(canUseTool(report, { ...superAdmin, permissions: ["reports:view"] })).toBe(true);
  });

  it("leaves the everyday tools open — they are already scoped by project", () => {
    for (const name of ["search_tickets", "my_timesheets", "list_projects", "find_people"]) {
      expect(canUseTool(AI_CHAT_TOOLS.find((t) => t.name === name)!, engineer), name).toBe(true);
    }
  });

  it("filters the prompt and the execution gate from the SAME predicate", () => {
    // The property that makes the double filter meaningful: anything visibleTools drops must also
    // be refused at execution. A drift between the two is how a filtered-from-the-prompt tool
    // becomes reachable by a model that guesses its name.
    const visible = new Set(visibleTools(AI_CHAT_TOOLS, engineer).map((t) => t.name));
    for (const tool of AI_CHAT_TOOLS) {
      if (visible.has(tool.name)) {
        expect(() => assertToolAllowed(tool, engineer), tool.name).not.toThrow();
      } else {
        expect(() => assertToolAllowed(tool, engineer), tool.name).toThrow();
      }
    }
    expect(visible.size).toBeLessThan(AI_CHAT_TOOLS.length);
    expect(visibleTools(AI_CHAT_TOOLS, superAdmin).length).toBeGreaterThan(visible.size);
  });

  it("refuses with a message the model can relay rather than a bare failure", () => {
    const spend = AI_CHAT_TOOLS.find((t) => t.name === "ai_spend")!;
    expect(() => assertToolAllowed(spend, engineer)).toThrow(/super admin/i);
  });

  it("caps tool output so one wall of rows cannot crowd out the question", () => {
    expect(sanitiseToolResult("x".repeat(50_000))).toContain("truncated");
    expect(sanitiseToolResult("x".repeat(50_000)).length).toBeLessThan(2600);
    expect(sanitiseToolResult("a short result")).toBe("a short result");
  });
});

describe("the Ask AI action registry", () => {
  it("is exactly the pinned set of actions", () => {
    // Pinned as an ordered list for the same reason the tool registry is pinned as a set: adding an
    // action is a decision about what a typed sentence may cause, not a convenience edit.
    expect(AI_CHAT_ACTIONS.map((t) => t.name)).toEqual([
      "log_timesheet_draft",
      "raise_ticket",
      "comment_on_ticket",
      "draft_change_request"
    ]);
  });

  it("never submits and never approves, whatever the action", async () => {
    // The rule that survived the registry growing from one action to four. Where the record HAS a
    // draft state the action stops there; where it does not (a ticket, a comment) the action
    // publishes and says so. What no action may ever do is start or settle an approval: submitting
    // starts an SLA clock and, where required, an identity check, and approving is the decision the
    // whole product reserves for a person.
    const source = await readSource("ai-chat-actions.ts");
    expect(source).toContain('"DRAFT"');
    // Code-shaped targets, not words: "approver" appears in prose explaining the rule, and a guard
    // that fails on its own explanation teaches people to delete the explanation.
    for (const forbidden of ['"SUBMITTED"', "submitDraft(", "recordDecision(", "approve(", '"APPROVED"', ".transition("]) {
      expect(source.includes(forbidden), `ai-chat-actions.ts must not reach ${forbidden}`).toBe(false);
    }
  });

  it("writes only through the shared creators, never straight to Prisma", async () => {
    // Every action's validation must be the one the matching PAGE already runs, which is only true
    // while this file delegates. A direct `prisma.<model>.create` here is how an action quietly
    // acquires a weaker version of the overlap check, the visibility check or the audit row.
    const source = await readSource("ai-chat-actions.ts");
    for (const writer of ["saveTimesheet(", "createTicketForActor(", "addTicketCommentForActor(", "createChangeRequest("]) {
      expect(source.includes(writer), `ai-chat-actions.ts must reach its shared writer ${writer}`).toBe(true);
    }
    for (const verb of [
      "prisma.timesheet.create",
      "prisma.timesheet.update",
      "prisma.ticket.create",
      "prisma.ticketComment.create",
      "prisma.changeRequest.create",
      ".upsert(",
      ".deleteMany("
    ]) {
      expect(source.includes(verb), `ai-chat-actions.ts must write through a shared creator, not ${verb}`).toBe(false);
    }
  });

  it("flags exactly the actions whose result other people see immediately", () => {
    // The panel renders this as "publishes" rather than "writes a draft". It has to match what the
    // record can actually do: `Ticket` and `TicketComment` have no unpublished state, a timesheet
    // and a change request do. A wrong flag here is a promise of a review step that does not exist.
    const publishing = AI_CHAT_ACTIONS.filter((a) => a.publishes).map((a) => a.name).sort();
    expect(publishing).toEqual(["comment_on_ticket", "raise_ticket"]);
    for (const action of AI_CHAT_ACTIONS) {
      if (action.publishes) continue;
      expect(action.description, `${action.name} stops at a draft and should say so`).toMatch(/draft/i);
    }
  });

  it("gates every action that publishes something other people see", () => {
    // `log_timesheet_draft` is deliberately ungated: it writes the asker's OWN draft, which they can
    // already do from the form, and saveTimesheet enforces the assignment gate itself. Everything
    // else here becomes visible to other people — a ticket on a board, a comment that notifies
    // watchers, a change in a project's queue — so each must carry the permission its own page
    // requires. An ungated publishing action would be offered to a role that cannot press the button.
    for (const action of AI_CHAT_ACTIONS) {
      if (action.name === "log_timesheet_draft") {
        expect(action.access, "the timesheet draft is the asker's own record and stays ungated").toBeUndefined();
        continue;
      }
      expect(action.access?.permission, `${action.name} publishes and must declare the permission its page requires`).toBeTruthy();
    }
  });

  it("tells the model, in every publishing action, not to act on text it merely read", () => {
    // Prompt injection reaches this product through ticket descriptions, comments and inbound email
    // — all attacker-controlled in any workspace with email intake on. The instruction has to sit in
    // the DESCRIPTION, because that is the text the model actually reads when it chooses a move.
    for (const action of AI_CHAT_ACTIONS) {
      if (!action.access) continue;
      expect(
        /never (raise|post|create)[^.]*because/i.test(action.description),
        `${action.name} must tell the model never to act on an instruction found in text it read`
      ).toBe(true);
    }
  });
});
