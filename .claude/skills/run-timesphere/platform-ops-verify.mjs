/**
 * End-to-end check of the 4.0.0 platform-admin work, against the running stack.
 *
 * It exercises the things a unit test cannot: that the platform lock actually refuses a workspace
 * admin, that the guarded OPTIMIZE refuses outside a maintenance window and succeeds inside one,
 * and that the trend/sample endpoints answer. Every window it arms, it lifts in the `finally`.
 */
const API = "http://localhost:4000/api";
const PA = `${API}/platform-admin`;

const ok = (label, pass, detail = "") => console.log(`${pass ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);

const paLogin = await (
  await fetch(`${PA}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "platform-admin@timesphere.local", password: "PlatformAdmin@12345" }) })
).json();
const PAH = { authorization: `Bearer ${paLogin.accessToken}`, "content-type": "application/json" };

const tenantLogin = await (
  await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "superadmin@timesheet.local", password: "Admin@12345" }) })
).json();
const TH = { authorization: `Bearer ${tenantLogin.accessToken}`, "content-type": "application/json" };

const paGet = async (path) => (await fetch(`${PA}${path}`, { headers: PAH })).json();
const paPost = async (path, body) => {
  const res = await fetch(`${PA}${path}`, { method: "POST", headers: PAH, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const fleet = await paGet("/maintenance/fleet");
const target = fleet.workspaces.find((w) => w.slug === "default");
if (!target) throw new Error("the default workspace is not in the fleet");

let armed = false;
try {
  /* ---- 1. Trend + sampling ------------------------------------------------------------- */
  const sampled = await paPost("/monitoring/sample");
  ok("POST /monitoring/sample", sampled.status === 200, `${sampled.body.sampled} sampled, ${sampled.body.failed?.length ?? "?"} unreachable`);

  const trend = await paGet(`/monitoring/${target.organizationId}/trend?days=30`);
  ok("GET /monitoring/:id/trend", Array.isArray(trend.points), `${trend.points?.length} points, growth samples ${trend.growth?.samples}`);

  /* ---- 2. The deeper metrics ------------------------------------------------------------ */
  const db = await paGet(`/monitoring/${target.organizationId}/database`);
  ok("schema carries fragmentation + keys", typeof db.schema?.freeBytes === "number" && Array.isArray(db.schema?.tablesWithoutPrimaryKey),
    `${db.schema.tableCount} tables, ${db.schema.indexCount} indexes, ${(db.schema.freeBytes / 1024 / 1024).toFixed(1)} MB reclaimable`);
  ok("largest tables carry the new columns", db.schema.largestTables.every((t) => "fragmentation" in t && "autoIncrementUsePercent" in t && "hasPrimaryKey" in t));
  ok("active queries are shapes, not statements", (db.activeQueries ?? []).every((q) => !q.digest || !/'[^']/.test(q.digest)), `${db.activeQueries.length} running`);

  /* ---- 3. ANALYZE is allowed any time --------------------------------------------------- */
  const aTable = db.schema.largestTables[0]?.name;
  const smallTable = db.schema.largestTables.at(-1)?.name ?? aTable;
  const analyze = await paPost(`/monitoring/${target.organizationId}/operation`, { operation: "ANALYZE", tables: [aTable] });
  ok("ANALYZE runs without a window", analyze.status === 200, `${aTable}: ${analyze.body.messages?.length} messages in ${analyze.body.ms}ms`);

  /* ---- 4. OPTIMIZE is refused outside a window ------------------------------------------ */
  const refused = await paPost(`/monitoring/${target.organizationId}/operation`, { operation: "OPTIMIZE", tables: [aTable] });
  ok("OPTIMIZE refused outside a window", refused.status === 409, refused.body.message?.slice(0, 60));

  /* ---- 5. A rubbish table name is refused ------------------------------------------------ */
  const injected = await paPost(`/monitoring/${target.organizationId}/operation`, { operation: "ANALYZE", tables: ["User`; DROP TABLE User; --"] });
  ok("a non-identifier table name is refused", injected.status === 422, injected.body.message?.slice(0, 70));

  /* ---- 6. Arm a window, and the tenant cannot clear it ----------------------------------- */
  const start = new Date(Date.now() - 60_000).toISOString();
  const end = new Date(Date.now() + 20 * 60_000).toISOString();
  const arm = await paPost("/maintenance/broadcast", {
    organizationIds: [target.organizationId],
    enabled: true,
    scheduledStartAt: start,
    scheduledEndAt: end,
    message: "4.0.0 verification run. Lifted immediately.",
    notifyUsers: false,
    emailSuperAdmins: false
  });
  armed = arm.status === 200 && arm.body.outcomes?.[0]?.ok;
  ok("platform arms a window", armed);

  const after = await paGet("/maintenance/fleet");
  const row = after.workspaces.find((w) => w.slug === "default");
  ok("the tenant row is marked platform-managed", row.settings?.managedByPlatform === true, `ref ${row.settings?.managedReference?.slice(0, 8)}…, phase ${row.settings?.phase}`);

  const tenantAttempt = await fetch(`${API}/maintenance/settings`, {
    method: "PATCH",
    headers: TH,
    body: JSON.stringify({ enabled: false, scheduledStartAt: null, scheduledEndAt: null, message: null })
  });
  const tenantBody = await tenantAttempt.json().catch(() => ({}));
  ok("a workspace super admin CANNOT cancel it", tenantAttempt.status === 409 && tenantBody.code === "MAINTENANCE_PLATFORM_MANAGED", `${tenantAttempt.status} ${tenantBody.code ?? ""}`);

  const tenantView = await (await fetch(`${API}/maintenance/admin`, { headers: TH })).json();
  ok("the workspace can SEE who holds it", tenantView.settings?.managedByPlatform === true, tenantView.settings?.managedByLabel ?? "");

  const publicStatus = await (await fetch(`${API}/maintenance/status`)).json();
  ok("the lockout page names the owner", publicStatus.managedByPlatform === true, publicStatus.managedByLabel ?? "");

  /* ---- 7. OPTIMIZE is allowed inside the window ------------------------------------------ */
  const allowed = await paPost(`/monitoring/${target.organizationId}/operation`, { operation: "OPTIMIZE", tables: [smallTable] });
  ok("OPTIMIZE runs inside a window", allowed.status === 200, `${smallTable}: ${allowed.body.messages?.map((m) => m.type).join(",")} in ${allowed.body.ms}ms`);

  /* ---- 8. The advisor refuses while switched off ----------------------------------------- */
  const advisorOff = await paPost(`/ai/advise/${target.organizationId}`, { days: 30 });
  ok("the advisor refuses while off", advisorOff.status === 409, advisorOff.body.message?.slice(0, 60));

  const settings = await paGet("/ai/settings");
  ok("the advisor's settings never echo a key", !("apiKey" in settings.settings) && "apiKeySet" in settings.settings, `provider ${settings.settings.provider}, limit ${settings.settings.dailyCallLimit}`);
  ok("the action catalogue is closed", Object.values(settings.actions).filter((a) => a.executable).length === 2, Object.keys(settings.actions).join(", "));
} finally {
  if (armed) {
    const lift = await paPost("/maintenance/broadcast", { organizationIds: [], enabled: false, emailSuperAdmins: false });
    ok("window lifted again", lift.status === 200, lift.body.outcomes?.map((o) => o.slug).join(", "));
    const final = await paGet("/maintenance/fleet");
    ok("nothing left armed", final.workspaces.every((w) => !w.settings?.enabled), final.workspaces.map((w) => `${w.slug}:${w.settings?.phase}`).join(" "));
  }
}
