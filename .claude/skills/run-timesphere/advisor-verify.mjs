/**
 * Drives the advisor end to end against a STUB OpenAI-compatible endpoint.
 *
 * There is no model available on this machine, so the one thing this cannot prove is that a real
 * model writes good advice. Everything else on the path is real and is exercised here: the settings
 * write and its key encryption, the enabled gate, the fact sheet actually assembled from the live
 * workspace, the HTTP call the provider client makes, the sanitiser against a deliberately hostile
 * response, persistence, and the human decision that closes the loop.
 *
 * The stub answers with a payload designed to break things: an action that does not exist, a table
 * that does not exist, a wall of prose, and forty findings.
 */
import { createServer } from "node:http";

const API = "http://localhost:4000/api/platform-admin";
const PORT = 4599;

const ok = (label, pass, detail = "") => console.log(`${pass ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);

let seenPrompt = "";
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      seenPrompt = JSON.parse(body).messages?.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n") ?? "";
    } catch {
      seenPrompt = body;
    }
    const findings = [
      { severity: "critical", title: "Drop the audit table", rationale: "It is large and old.", action: "DROP_TABLE", tables: ["auditlog"], confidence: "high" },
      { severity: "warning", title: "Refresh statistics on the busiest table", rationale: "Row counts have moved a long way since the last ANALYZE, so the planner is costing from stale numbers.", action: "ANALYZE_TABLES", tables: ["session", "not_a_real_table"], confidence: "high" },
      { severity: "info", title: "Watch the growth rate", rationale: "y".repeat(2000), action: "MONITOR", tables: [], confidence: "low" },
      ...Array.from({ length: 30 }, (_, i) => ({ severity: "info", title: `Filler ${i}`, rationale: "padding", action: "MONITOR", tables: [], confidence: "low" }))
    ];
    const payload = { summary: "z".repeat(4000), findings };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "stub",
        choices: [{ message: { role: "assistant", content: "Here is my analysis:\n```json\n" + JSON.stringify(payload) + "\n```" } }],
        usage: { prompt_tokens: 1234, completion_tokens: 567 }
      })
    );
  });
});
await new Promise((resolve) => stub.listen(PORT, "127.0.0.1", resolve));

const login = await (
  await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "platform-admin@timesphere.local", password: "PlatformAdmin@12345" }) })
).json();
const H = { authorization: `Bearer ${login.accessToken}`, "content-type": "application/json" };
const get = async (path) => (await fetch(`${API}${path}`, { headers: H })).json();
const send = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, { method, headers: H, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const before = await get("/ai/settings");
const fleet = await get("/maintenance/fleet");
const org = fleet.workspaces.find((w) => w.slug === "default");

try {
  const saved = await send("PUT", "/ai/settings", {
    enabled: true,
    provider: "OPENAI_COMPATIBLE",
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
    model: "stub-model",
    apiKey: "stub-key-not-a-real-one",
    dailyCallLimit: 50
  });
  ok("settings saved", saved.status === 200, `provider ${saved.body.provider}, keySet ${saved.body.apiKeySet}`);
  ok("the key is never echoed back", !("apiKey" in saved.body) && !("encryptedApiKey" in saved.body) && saved.body.apiKeySet === true);

  const advice = await send("POST", `/ai/advise/${org.organizationId}`, { days: 30 });
  ok("a generation completes", advice.status === 200, `${advice.body.findings?.length} findings kept`);

  /* --- what the model was actually shown ---------------------------------------------------- */
  ok("the prompt carried real facts from this workspace", seenPrompt.includes("timesheet_portal") || seenPrompt.includes('"slug": "default"') || seenPrompt.includes('"slug":"default"'), `${seenPrompt.length} chars`);
  ok("the prompt carries the action allowlist", seenPrompt.includes("ANALYZE_TABLES") && seenPrompt.includes("OPTIMIZE_TABLES"));
  ok("the prompt contains no quoted SQL literals", !/= '[^']+'/.test(seenPrompt));
  ok("the prompt names the server-wide caveat", /server, which other workspaces may share/i.test(seenPrompt));

  /* --- what survived the sanitiser ---------------------------------------------------------- */
  const kept = advice.body.findings ?? [];
  ok("the invented action was dropped", !kept.some((f) => f.action === "DROP_TABLE"), kept.map((f) => f.action).join(", "));
  ok("the invented table was dropped", !kept.some((f) => f.tables?.includes("not_a_real_table")), JSON.stringify(kept.find((f) => f.action === "ANALYZE_TABLES")?.tables ?? []));
  ok("forty findings were clamped to eight", kept.length <= 8, String(kept.length));
  ok("the wall of prose was clamped", (advice.body.summary ?? "").length <= 900, `summary ${advice.body.summary?.length} chars`);
  ok("severity ordering survived", kept[0]?.severity !== "info" || kept.every((f) => f.severity === "info"), kept.map((f) => f.severity).join(","));

  /* --- persistence and the human decision --------------------------------------------------- */
  const listed = await get(`/ai/advice/${org.organizationId}`);
  const row = listed.advice?.[0];
  ok("the advisory was stored PENDING", row?.status === "PENDING", `${row?.inputTokens} in / ${row?.outputTokens} out, model ${row?.model}`);

  const noNote = await send("POST", `/ai/advice/${row.id}/decision`, { status: "DISMISSED", note: "" });
  ok("a dismissal without a reason is refused", noNote.status === 422, noNote.body.message?.slice(0, 70));

  const decided = await send("POST", `/ai/advice/${row.id}/decision`, { status: "DISMISSED", note: "Stub run during 4.0.0 verification — not real advice." });
  ok("a dismissal with a reason is recorded", decided.status === 200 && decided.body.status === "DISMISSED", decided.body.decidedBy ?? "");

  /* --- the ceiling -------------------------------------------------------------------------- */
  await send("PUT", "/ai/settings", { enabled: true, provider: "OPENAI_COMPATIBLE", baseUrl: `http://127.0.0.1:${PORT}/v1`, model: "stub-model", dailyCallLimit: 1 });
  const overLimit = await send("POST", `/ai/advise/${org.organizationId}`, { days: 30 });
  ok("the daily ceiling refuses", overLimit.status === 429, overLimit.body.message?.slice(0, 70));
} finally {
  // Put the advisor back exactly as it was — off, with no stub endpoint and no stub key.
  await send("PUT", "/ai/settings", {
    enabled: before.settings.enabled,
    provider: before.settings.provider,
    baseUrl: before.settings.baseUrl,
    model: before.settings.model,
    apiKey: "",
    dailyCallLimit: before.settings.dailyCallLimit
  });
  const after = await get("/ai/settings");
  ok("advisor restored to its previous state", after.settings.enabled === before.settings.enabled && after.settings.apiKeySet === false, `enabled ${after.settings.enabled}, keySet ${after.settings.apiKeySet}`);
  stub.close();
}
