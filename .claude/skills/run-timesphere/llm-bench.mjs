/**
 * Benchmarks local Ollama models on the EXACT discipline Ask AI needs, not on trivia.
 *
 * The failures this session actually saw, which are the test:
 *   1. ROUTE   — pick the right tool, as one clean JSON envelope, first try.
 *   2. REFUSE  — classify an off-topic question as {"action":"refuse"}, nothing else.
 *   3. COMPOSE — given a real tool result, produce ONE envelope whose markdown carries a table and
 *                a ```chart fence that parses — with no protocol echo, no unterminated JSON.
 *
 * The prompt below is a condensed but faithful copy of askWorkspaceChat's instruction shape —
 * same envelope contract, same chart-fence example — because a benchmark on a different prompt
 * measures a different product.
 *
 * Scoring is STRICT parse first (the whole reply is one JSON object, which is what the loop asks
 * for), with a lenient brace-walk fallback noted separately — the loop survives lenient, but every
 * lenient answer costs recovery machinery.
 */
import http from "node:http";

const MODELS = process.argv.slice(2);
if (!MODELS.length) {
  console.error("usage: node llm-bench.mjs <model> [model...]");
  process.exit(1);
}

/*
 * The first version of this benchmark scored llama3.1:8b a perfect 1.00 across the board — a model
 * this session has watched narrate its own protocol, echo unterminated envelopes and refuse
 * "timesheet count and status". A benchmark that cannot reproduce the failures it exists to rank
 * is measuring the wrong thing, so this one carries what production carries: the full-size tool
 * list, a chunk of prior conversation to copy badly from, and a multi-part question — the exact
 * conditions the screenshots came from.
 */
const HISTORY = [
  "RECENT CONVERSATION (context only — decide from the TOOLS list, never from what a past answer",
  "claimed you could or could not do):",
  "Q: how many change managements records are there and give summary of it",
  "A: According to the list_changes tool, there are 50 change management records.",
  "---",
  "Q: timesheet count and status",
  'A: { "action": "answer", "markdown": "Based on the timesheet_stats tool, here is the count' ,
  "---",
  "Q: what can you do",
  "A: I can look up tickets, timesheets, changes, projects and people in this workspace.",
  ""
].join("\n");

const CONTRACT = [
  "You are TimeSphere's workspace assistant. Answer questions about THIS workspace using the tools.",
  "READ TOOLS:",
  "- my_timesheets: the asking person's OWN recent timesheet entries. Dates are YYYY-MM-DD.",
  "- timesheet_stats: counts and hours BY STATUS — approved, pending, draft, rejected.",
  "- timesheet_report: workspace-wide approved-hours totals by project over a range.",
  "- ticket_metrics: ticket counts by status and priority.",
  "- search_tickets: tickets matching filters (status, priority, assignee, project, text).",
  "- get_ticket: one ticket in full by key.",
  "- list_changes: change-management records. change_metrics: change counts and risk spread.",
  "- list_projects: projects with codes, modules and submodules.",
  "- find_people: who someone is, who reports to whom. user_stats: headcount, inactive people.",
  "- goals_overview: OKRs and how they are tracking. project_health: which projects are at risk.",
  "- sla_and_escalations: breaches and escalations. workspace_configuration: what is switched on.",
  "- email_analytics, email_templates, ai_spend, ai_quality, audit_log, security_findings,",
  "  ci_runs, service_health, api_performance, scheduled_reports, automation_activity.",
  "",
  'Reply with EXACTLY ONE JSON object and nothing else — no prose before or after, no code fences around it:',
  '  { "action": "tool", "tool": "<name>", "args": { ... } }   — to consult a tool',
  '  { "action": "answer", "markdown": "..." }                 — when you can answer',
  '  { "action": "refuse" }                                    — the question is not about this product',
  "",
  "Markdown is carried inside the JSON string: every newline written as \\n, every quote as \\\".",
  "When numbers would read better drawn, include ONE chart as a REAL fenced block, exactly:",
  '  "markdown": "Hours:\\n\\n```chart\\n{\\"type\\": \\"bar\\", \\"title\\": \\"T\\", \\"data\\": [{\\"label\\": \\"A\\", \\"value\\": 1}]}\\n```\\n"'
].join("\n");

const TOOL_RESULT = [
  "What the tools have returned so far:",
  "--- ticket_metrics ---",
  "<tool_result>",
  JSON.stringify({
    total: 319,
    byStatus: { OPEN: 306, IN_PROGRESS: 12, IN_REVIEW: 1, RESOLVED: 1, CLOSED: 4 },
    byPriority: { LOW: 27, MEDIUM: 293, HIGH: 2, CRITICAL: 2 }
  }),
  "</tool_result>",
  "",
  "Answer now if you can; use another tool only if something is still missing."
].join("\n");

const CASES = [
  {
    name: "route",
    prompt: `${CONTRACT}\n\nQUESTION: Where did my hours go over the last two weeks?`,
    score(parsed) {
      if (!parsed) return 0;
      if (parsed.action !== "tool") return 0;
      return ["my_timesheets", "timesheet_stats"].includes(parsed.tool) ? 1 : 0.4;
    }
  },
  {
    name: "refuse",
    prompt: `${CONTRACT}\n\nQUESTION: What is the capital of France?`,
    score(parsed) {
      if (!parsed) return 0;
      return parsed.action === "refuse" ? 1 : 0;
    }
  },
  {
    name: "multi",
    // The narrated-protocol screenshot came from exactly this shape: a data question that ALSO
    // asks about configuration, with history above it. Small models answer one half in prose,
    // then write the other half's envelope as text.
    prompt: `${CONTRACT}

${HISTORY}
QUESTION: which features are switched on for this workspace, and can u share the trend of tickets raised till now in bar chart format`,
    score(parsed) {
      if (!parsed) return 0;
      // Either half first is fine — what matters is ONE clean envelope, tool or answer.
      if (parsed.action === "tool") return ["workspace_configuration", "ticket_metrics", "search_tickets"].includes(parsed.tool) ? 1 : 0.4;
      return 0;
    }
  },
  {
    name: "compose",
    prompt: `${CONTRACT}\n\nQUESTION: Break my tickets down by status and priority, with a table and a chart.\n${TOOL_RESULT}`,
    score(parsed) {
      if (!parsed || parsed.action !== "answer" || typeof parsed.markdown !== "string") return 0;
      const md = parsed.markdown;
      let s = 0;
      if (/\|\s*-{2,}/.test(md)) s += 0.4; // a real table
      const chart = /```chart\s*\n([\s\S]*?)```/.exec(md);
      if (chart) {
        try {
          const spec = JSON.parse(chart[1].trim());
          if (spec.type && Array.isArray(spec.data) && spec.data.every((d) => d.label && typeof d.value === "number")) s += 0.4;
        } catch {
          /* fence present but unparseable */
        }
      }
      if (!/"action"|\\"action\\"/.test(md)) s += 0.2; // no protocol echo inside the answer
      return s;
    }
  }
];

function ollama(model, prompt) {
  const body = JSON.stringify({
    model,
    stream: false,
    options: { temperature: 0, num_predict: 900 },
    // NOTHINK=1 appends qwen3's no-think switch — its reasoning mode costs ~35s/call on this GPU
    // and the loop makes up to five calls per question, which is unusable interactively.
    messages: [{ role: "user", content: process.env.NOTHINK ? `${prompt}\n/no_think` : prompt }]
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: 11434, path: "/api/chat", method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data);
            resolve({ text: j.message?.content ?? "", ms: Math.round((j.total_duration ?? 0) / 1e6) });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    // Cold loads of a 9GB model take a while; a hung model should not hang the benchmark.
    req.setTimeout(240000, () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}

/** Reasoning models wrap output in <think> — the app strips it, so the benchmark does too. */
function stripThink(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function parseStrict(text) {
  try {
    return { parsed: JSON.parse(text.trim()), strict: true };
  } catch {
    /* fall through */
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return { parsed: JSON.parse(text.slice(start, end + 1)), strict: false };
    } catch {
      /* fall through */
    }
  }
  return { parsed: null, strict: false };
}

const REPS = 2;
console.log("model".padEnd(18), "route", "refuse", "multi", "compose", " strict", " avg_ms");
for (const model of MODELS) {
  const scores = { route: 0, refuse: 0, multi: 0, compose: 0 };
  let strictCount = 0;
  let calls = 0;
  let totalMs = 0;
  let failed = false;
  for (const c of CASES) {
    for (let r = 0; r < REPS; r++) {
      try {
        const { text, ms } = await ollama(model, c.prompt);
        const { parsed, strict } = parseStrict(stripThink(text));
        scores[c.name] += c.score(parsed) / REPS;
        if (strict) strictCount++;
        calls++;
        totalMs += ms;
      } catch (e) {
        failed = true;
        calls++;
      }
    }
  }
  const fmt = (v) => v.toFixed(2).padStart(5);
  console.log(
    model.padEnd(18),
    fmt(scores.route),
    fmt(scores.refuse),
    fmt(scores.multi),
    fmt(scores.compose),
    `${String(strictCount).padStart(3)}/${calls}`,
    String(Math.round(totalMs / Math.max(calls, 1))).padStart(7),
    failed ? " (some calls failed)" : ""
  );
}
