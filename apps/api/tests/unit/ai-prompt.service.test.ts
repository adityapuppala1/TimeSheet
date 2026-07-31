/**
 * Tests for prompt versioning.
 *
 * Two things are pinned here, and both are load-bearing:
 *
 * 1. THE DEFAULT TEMPLATES ARE BYTE-IDENTICAL to the prompts they replaced. Extracting hardcoded
 *    prompts into templates is exactly the kind of refactor where a lost newline silently changes
 *    every future AI response, and nothing would fail — the output would just quietly get worse.
 *    The expected strings below are rebuilt using the ORIGINAL array-join construction, so a typo
 *    in a template fails here rather than in production.
 *
 * 2. THE RUNTIME NEVER THROWS. Every failure mode returns the code default. If that guarantee ever
 *    breaks, one bad prompt edit takes a capability down.
 *
 * Plus the allowlist itself, asserted as a security control rather than a config list.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { getPromptSpec, listPromptSpecs, renderTemplate, resolvePrompt, validateTemplate } = await import(
  "../../src/services/ai-prompt.service.js"
);

let client: ReturnType<typeof createFakeTenantClient>;

beforeEach(() => {
  client = createFakeTenantClient();
});

/** Renders a spec's built-in template the way the runtime would. */
function renderDefault(feature: string, values: Record<string, string>): string {
  return renderTemplate(getPromptSpec(feature)!.defaultTemplate, values);
}

describe("built-in templates reproduce the original hardcoded prompts", () => {
  it("weekly_digest", () => {
    const ticketLines = "- [WEB-12] Login fails on Safari (RESOLVED)";
    // Verbatim reconstruction of the pre-extraction code in ai.service.ts#generateWeeklyDigest.
    const original =
      [
        "Write a short, friendly Monday-morning recap (3-5 sentences, plain prose, no headings/bullets in the output) for Ana covering the week of 21 July.",
        "",
        "Tickets created: 4",
        "Tickets resolved: 6",
        "Currently open & assigned to them: 3",
        "Hours logged: 31.5",
        "Notable tickets:",
        ticketLines,
        "",
        "Keep it encouraging but factual — don't invent numbers beyond what's given. If everything is at zero, say the week was quiet rather than padding it out."
      ].join("\n") + "\n\nRespond with ONLY the recap paragraph — no preamble, no subject line.";

    expect(
      renderDefault("weekly_digest", {
        userName: "Ana",
        weekLabel: "21 July",
        ticketsCreated: "4",
        ticketsResolved: "6",
        openAssigned: "3",
        hoursLogged: "31.5",
        notableTickets: ticketLines
      })
    ).toBe(original);
  });

  it("comment_summary", () => {
    const thread = "Ana (2026-07-30 09:12): Reproduced on 17.4.";
    const original = `Summarize this comment thread on ticket "Login fails" in 2-4 sentences — focus on current status, decisions made, and any open questions.\n\n${thread}`;

    expect(renderDefault("comment_summary", { ticketTitle: "Login fails", thread })).toBe(original);
  });

  it("ask_ai, including the analytics block that brings its own leading newlines", () => {
    const tickets = "[WEB-12] (OPEN, HIGH) Login fails";
    const snapshot = "\n\nWorkspace analytics snapshot (use this for trend/aggregate questions — velocity, SLA, workload, cost):\nSLA compliance: 92%";
    const original = `You're answering a question about a team's ticket backlog and workspace analytics. Use only the tickets and analytics listed below — cite ticket keys like [WEB-12] when referencing a specific ticket, and cite numbers directly when referencing analytics. If the answer isn't in the provided data, say so plainly.\n\nTickets:\n${tickets}${snapshot}\n\nQuestion: Why?`;

    expect(renderDefault("ask_ai", { tickets, analyticsSnapshot: snapshot, question: "Why?" })).toBe(original);
    // And with no snapshot the block collapses to nothing, leaving exactly one blank line.
    expect(renderDefault("ask_ai", { tickets, analyticsSnapshot: "", question: "Why?" })).toContain(`${tickets}\n\nQuestion: Why?`);
  });

  it("stale_ticket_nudge", () => {
    const original = [
      'A HIGH-priority BUG ticket titled "Login fails" is 18.5 hours past its resolution SLA.',
      "It has 2 comment(s) and no linked branch/PR.",
      "",
      "In ONE short sentence, suggest the single most useful next action for whoever owns this",
      '(e.g. "post a status update so the reporter isn\'t left wondering", "link a branch if work has',
      'already started", "flag it as blocked if it\'s stuck on someone else"). Be concrete, not generic',
      'advice like "look into it" or "prioritize this". Never invent facts about the ticket beyond',
      "what's given. Respond with ONLY that one sentence — no preamble."
    ].join("\n");

    expect(
      renderDefault("stale_ticket_nudge", {
        priority: "HIGH",
        ticketType: "BUG",
        ticketTitle: "Login fails",
        hoursOverdue: "18.5",
        commentCount: "2",
        linkedBranchPhrase: "no"
      })
    ).toBe(original);
  });

  it("assignee_suggestion_explanation — the one with no trailing instruction appended", () => {
    const candidates = "1. Ana — 3 open now, 11 resolved here before";
    const original = [
      'A ticket titled "Login fails" needs an assignee. Ranked candidates (already scored, do NOT re-rank):',
      candidates,
      "",
      "In ONE sentence, explain why the top candidate is the reasonable pick, in plain language a",
      'manager would use (e.g. "already familiar with this area and has room on their plate").',
      "Never invent skills or history beyond the open/resolved counts given. Respond with ONLY that",
      "one sentence — no preamble, no candidate list repeated back."
    ].join("\n");

    expect(renderDefault("assignee_suggestion_explanation", { ticketTitle: "Login fails", candidates })).toBe(original);
  });

  it("every built-in template is valid against its own spec", () => {
    // Catches a template that references a placeholder the spec forgot to declare — which would
    // otherwise render as an empty string and lose data silently.
    for (const spec of listPromptSpecs()) {
      expect({ feature: spec.feature, problems: validateTemplate(spec, spec.defaultTemplate) }).toEqual({
        feature: spec.feature,
        problems: []
      });
    }
  });
});

describe("the allowlist is a security boundary, not a config list", () => {
  const editable = new Set(listPromptSpecs().map((s) => s.feature));

  it("excludes every capability that must return parseable JSON", () => {
    // classifyTicket throws 502 on unparseable output and email/chat intake depend on it — a bad
    // prompt edit would stop tickets being created from email.
    for (const feature of [
      "triage",
      "chat_triage",
      "ci_failure_triage",
      "security_finding_triage",
      "duplicate_detection",
      "pr_review_summary",
      "pr_inline_review"
    ]) {
      expect(editable.has(feature)).toBe(false);
    }
  });

  it("excludes the face capabilities", () => {
    // These sit inside the biometric compliance regime, and their prompts are part of what it
    // promises. Same reasoning as their place on the content-capture denylist.
    expect(editable.has("face_review_summary")).toBe(false);
    expect(editable.has("face_policy_copilot")).toBe(false);
  });
});

describe("validateTemplate", () => {
  const spec = getPromptSpec("comment_summary")!;

  it("rejects a placeholder the capability doesn't provide", () => {
    // {{ticketName}} would otherwise render literally, and the model would answer about a ticket
    // called "{{ticketName}}" without anything looking wrong.
    const problems = validateTemplate(spec, "Summarize {{ticketName}}:\n{{thread}}");
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe("unknown_placeholder");
  });

  it("refuses to drop a required placeholder", () => {
    const problems = validateTemplate(spec, "Summarize the thread on {{ticketTitle}}.");
    expect(problems[0].kind).toBe("missing_required");
  });

  it("rejects an empty body", () => {
    expect(validateTemplate(spec, "   ")[0].kind).toBe("empty");
  });
});

describe("resolvePrompt never throws", () => {
  const values = { ticketTitle: "Login fails", thread: "Ana: reproduced." };

  it("uses the built-in prompt with no fallback reason when nothing is overridden", async () => {
    vi.mocked(client.aIPromptTemplate.findUnique).mockResolvedValue(null as never);
    const resolved = await runInTenant(client, () => resolvePrompt("comment_summary", values));

    expect(resolved.text).toBe(renderDefault("comment_summary", values));
    // No reason: the built-in prompt is the expected state, not a degradation. Reporting one here
    // would make the activity log look like something was broken on every single call.
    expect(resolved.fallbackReason).toBeUndefined();
    expect(resolved.promptVersionId).toBeUndefined();
  });

  it("uses the active version and stamps its id", async () => {
    vi.mocked(client.aIPromptTemplate.findUnique).mockResolvedValue({
      id: "tpl-1",
      feature: "comment_summary",
      activeVersionId: "v-2",
      versions: [{ id: "v-2", body: "Recap {{ticketTitle}}:\n{{thread}}" }]
    } as never);
    const resolved = await runInTenant(client, () => resolvePrompt("comment_summary", values));

    expect(resolved.text).toBe("Recap Login fails:\nAna: reproduced.");
    expect(resolved.promptVersionId).toBe("v-2");
    expect(resolved.fallbackReason).toBeUndefined();
  });

  it("falls back when the active version row is gone", async () => {
    vi.mocked(client.aIPromptTemplate.findUnique).mockResolvedValue({
      id: "tpl-1",
      activeVersionId: "v-9",
      versions: []
    } as never);
    const resolved = await runInTenant(client, () => resolvePrompt("comment_summary", values));

    expect(resolved.text).toBe(renderDefault("comment_summary", values));
    expect(resolved.fallbackReason).toBe("active_version_missing");
  });

  it("falls back when a saved version has since become invalid", async () => {
    // Reachable when a release changes a spec's placeholders under an already-saved version.
    vi.mocked(client.aIPromptTemplate.findUnique).mockResolvedValue({
      id: "tpl-1",
      activeVersionId: "v-3",
      versions: [{ id: "v-3", body: "Recap {{noSuchThing}}" }]
    } as never);
    const resolved = await runInTenant(client, () => resolvePrompt("comment_summary", values));

    expect(resolved.text).toBe(renderDefault("comment_summary", values));
    expect(resolved.fallbackReason).toBe("invalid_template:unknown_placeholder");
    expect(resolved.promptVersionId).toBeUndefined();
  });

  it("falls back when the body renders to nothing", async () => {
    vi.mocked(client.aIPromptTemplate.findUnique).mockResolvedValue({
      id: "tpl-1",
      activeVersionId: "v-4",
      versions: [{ id: "v-4", body: "  {{thread}}  " }]
    } as never);
    const resolved = await runInTenant(client, () => resolvePrompt("comment_summary", { ticketTitle: "x", thread: "" }));

    expect(resolved.fallbackReason).toBe("rendered_empty");
    expect(resolved.text).toContain("Summarize this comment thread");
  });

  it("falls back instead of throwing when the database is unreachable", async () => {
    vi.mocked(client.aIPromptTemplate.findUnique).mockRejectedValue(new Error("ECONNREFUSED") as never);
    const resolved = await runInTenant(client, () => resolvePrompt("comment_summary", values));

    // The whole safety argument for this feature: a database problem degrades the AI to exactly
    // today's behaviour rather than failing the call.
    expect(resolved.text).toBe(renderDefault("comment_summary", values));
    expect(resolved.fallbackReason).toBe("lookup_failed");
  });
});
