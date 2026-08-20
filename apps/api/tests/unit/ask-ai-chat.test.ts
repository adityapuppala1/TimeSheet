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

const readSource = (file: string) =>
  import("node:fs").then((fs) =>
    fs.readFileSync(new URL(`../../src/services/${file}`, import.meta.url).href.replace("file:///", ""), "utf8")
  );

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
        "security_findings",
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
  it("is exactly one action, and it is the timesheet draft", () => {
    expect(AI_CHAT_ACTIONS.map((t) => t.name)).toEqual(["log_timesheet_draft"]);
  });

  it("only ever saves a DRAFT — never a submission, never an approval", async () => {
    // The rule the MCP server settled first, held here by grep rather than by hope: submitting
    // starts an approval SLA clock and, where required, an identity check. An assistant must not
    // trigger either from a sentence.
    const source = await readSource("ai-chat-actions.ts");
    expect(source).toContain('"DRAFT"');
    // Code-shaped targets, not words: "approver" appears in prose explaining the rule, and a guard
    // that fails on its own explanation teaches people to delete the explanation.
    for (const forbidden of ['"SUBMITTED"', "submitDraft(", "recordDecision(", "approve(", '"APPROVED"', ".transition("]) {
      expect(source.includes(forbidden), `ai-chat-actions.ts must not reach ${forbidden}`).toBe(false);
    }
    // And its ONLY write path is the form's own save — the validations live there, once.
    expect(source).toContain("saveTimesheet(");
    for (const verb of ["prisma.timesheet.create", "prisma.timesheet.update", ".upsert(", ".deleteMany("]) {
      expect(source.includes(verb), `ai-chat-actions.ts must write through saveTimesheet, not ${verb}`).toBe(false);
    }
  });
});
