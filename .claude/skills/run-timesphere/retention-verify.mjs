/**
 * End-to-end check of the trial retention programme against a RUNNING stack, using a throwaway
 * control-plane organization that has NO tenant database — so nothing real is ever dropped.
 *
 *   1. a lapsed trial appears in the queue with the right stage and deletion date
 *   2. the dry run says what it would send; a simulated date moves the schedule
 *   3. sending a stage records the marker, writes a log row, and never sends it twice
 *   4. the email body carries working /feedback and /reactivate links
 *   5. the feedback form saves, and shows up in the console's feedback API
 *   6. reactivation moves the workspace back to GRACE and sets the hold
 *   7. deletion refuses a paying customer, refuses a wrong slug, and works with the right one
 *   8. the confirmation email and the audit rows are written
 *
 * The throwaway org and everything hanging off it are deleted at the end, in the `finally`.
 * Recipient is `@example.invalid`, which no relay will deliver — the point is the pipeline and the
 * log, not the mail.
 *
 *   node .claude/skills/run-timesphere/retention-verify.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const require = createRequire(import.meta.url);

const API = process.env.TS_API ?? "http://localhost:4000";
const SLUG = "retention-probe";
const OWNER = "retention-probe@example.invalid";
const DAY = 24 * 60 * 60 * 1000;

for (const line of readFileSync(path.join(root, "apps/api/.env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=("?)(.*)\2$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
}
const { PrismaClient } = await import(pathToFileURL(path.join(root, "apps/api/src/generated/control-client/index.js")).href);
const control = new PrismaClient();

console.log(`recovery if this dies mid-way:\n  DELETE FROM Organization WHERE slug='${SLUG}';\n`);

let pass = 0;
let fail = 0;
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const ok = (msg) => {
  pass++;
  console.log(`    ok  ${msg}`);
};
const bad = (msg) => {
  fail++;
  console.log(`    FAIL ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

async function api(method, url, token, body) {
  const res = await fetch(`${API}/api${url}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body: json };
}

async function main() {
  const login = await api("POST", "/platform-admin/auth/login", null, { email: "platform-admin@timesphere.local", password: "PlatformAdmin@12345" });
  if (login.status !== 200) throw new Error(`platform-admin login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const token = login.body.accessToken;

  await control.organization.deleteMany({ where: { slug: SLUG } });
  const trialEndsAt = new Date(Date.now() - 31 * DAY);
  const org = await control.organization.create({
    data: {
      name: "Retention Probe",
      slug: SLUG,
      status: "GRACE",
      planTier: "STARTER",
      trialTier: "TEAM",
      ownerEmail: OWNER,
      trialStartedAt: new Date(trialEndsAt.getTime() - 15 * DAY),
      trialEndsAt,
      graceStartedAt: trialEndsAt
    }
  });

  try {
    step(1, "the queue places it correctly");
    const q1 = await api("GET", "/platform-admin/retention", token);
    const row = q1.body.queue.find((r) => r.slug === SLUG);
    check(Boolean(row), "appears in the queue");
    check(row?.plan.stage === "lapsed", `stage is lapsed (got ${row?.plan.stage})`);
    check(row?.plan.daysSinceTrialEnd === 31, `31 days since the trial ended (got ${row?.plan.daysSinceTrialEnd})`);
    check(row?.plan.due?.includes("30"), `the day-30 reminder is due (due: ${JSON.stringify(row?.plan.due)})`);
    check(row?.plan.superseded?.includes("ended"), "the trial-ended message is superseded, not replayed");
    check(row?.plan.deletionBlockedBy === "not-yet", `deletion blocked: not-yet (got ${row?.plan.deletionBlockedBy})`);
    const deleteAt = new Date(row.plan.deleteAt);
    check(Math.abs(deleteAt.getTime() - (trialEndsAt.getTime() + 90 * DAY)) < 60_000, `deletion dated 90 days after the trial (${deleteAt.toDateString()})`);

    step(2, "the dry run says what it would do, and a simulated date moves it");
    const dry = await api("POST", "/platform-admin/retention/run", token, { dryRun: true });
    check(dry.body.wouldSend.some((x) => x.org === SLUG && x.marker === "30"), "dry run would send the day-30 reminder");
    check(dry.body.deleted.length === 0 && dry.body.sent.length === 0, "dry run sent and deleted nothing");
    const future = new Date(trialEndsAt.getTime() + 95 * DAY).toISOString();
    const sim = await api("POST", "/platform-admin/retention/run", token, { simulateNow: future });
    check(sim.body.dryRun === true, "a simulated date is forced to be a dry run");
    check(sim.body.wouldSend.some((x) => x.org === SLUG && x.marker === "90"), "at +95 days the final notice is what is due");
    check(!sim.body.wouldDelete.some((x) => x.org === SLUG), "it would NOT delete on the same pass as the final notice");

    step(3, "sending a stage records it once");
    const send = await api("POST", `/platform-admin/retention/${org.id}/send/30`, token);
    check([200, 502].includes(send.status), `send answered ${send.status} (502 is fine — no relay for @example.invalid)`);
    const after = await control.organization.findUnique({ where: { id: org.id }, select: { retentionNoticesSent: true } });
    check(Boolean(after.retentionNoticesSent?.["30"]), "the day-30 marker is recorded even when the relay refused it");
    const q2 = await api("GET", "/platform-admin/retention", token);
    const row2 = q2.body.queue.find((r) => r.slug === SLUG);
    check(!row2.plan.due.includes("30"), "it is no longer due — a second pass will not resend it");
    check(row2.plan.nextMarker?.marker === "60", `next up is the day-60 reminder (got ${row2.plan.nextMarker?.marker})`);

    step(4, "the message body carries working links");
    const logRow = await control.platformEmailLog.findFirst({ where: { organizationId: org.id }, orderBy: { createdAt: "desc" } });
    check(Boolean(logRow), "a platform email log row was written");
    check(logRow?.dayMarker === "30", `the row is filed under the day-30 stage (got ${logRow?.dayMarker})`);
    const html = logRow?.payload?.html ?? "";
    const feedbackToken = /\/feedback\/([A-Za-z0-9_.-]+)/.exec(html)?.[1];
    const reactivateToken = /\/reactivate\/([A-Za-z0-9_.-]+)/.exec(html)?.[1];
    check(Boolean(feedbackToken), "the body contains a feedback link");
    check(Boolean(reactivateToken), "the body contains a restore link");
    check(html.includes("90"), "the body states the retention policy");

    step(5, "the feedback form works, and reaches the console");
    const info = await api("GET", `/public/trial-feedback/${feedbackToken}`);
    check(info.status === 200 && info.body.workspace === "Retention Probe", `the form knows the workspace (${info.body?.workspace})`);
    const wrongPurpose = await api("GET", `/public/reactivate/${feedbackToken}`);
    check(wrongPurpose.status === 404, `a feedback token cannot be replayed as a restore token (${wrongPurpose.status})`);
    const submit = await api("POST", `/public/trial-feedback/${feedbackToken}`, null, { rating: 4, liked: "Timesheets were quick", missing: "Wanted Jira sync", wouldReturn: "maybe" });
    check(submit.status === 201, `the answer saved (${submit.status})`);
    const fb = await api("GET", "/platform-admin/feedback", token);
    check(fb.body.rows.some((r) => r.organization.slug === SLUG && r.rating === 4), "it shows in the console's feedback list");

    step(6, "restoring puts the workspace back and holds the deletion");
    const rInfo = await api("GET", `/public/reactivate/${reactivateToken}`);
    check(rInfo.status === 200 && rInfo.body.eligible === true, "the restore page says it is eligible");
    const restored = await api("POST", `/public/reactivate/${reactivateToken}`);
    check(restored.status === 200 && restored.body.restored === true, "restore succeeded");
    const held = await control.organization.findUnique({ where: { id: org.id }, select: { status: true, retentionHold: true } });
    check(held.status === "GRACE" && held.retentionHold === true, `back to GRACE with the deletion held (status ${held.status}, hold ${held.retentionHold})`);
    const q3 = await api("GET", "/platform-admin/retention", token);
    check(q3.body.queue.find((r) => r.slug === SLUG).plan.deletionBlockedBy === "not-yet", "the queue reflects it");

    step(7, "deletion refuses what it should");
    await control.organization.update({ where: { id: org.id }, data: { retentionHold: false } });
    const wrongSlug = await api("POST", `/platform-admin/retention/${org.id}/delete`, token, { confirmSlug: "not-the-slug" });
    check(wrongSlug.status === 422, `a mistyped slug is refused (${wrongSlug.status})`);
    await control.organization.update({ where: { id: org.id }, data: { planTier: "TEAM" } });
    const paying = await api("POST", `/platform-admin/retention/${org.id}/delete`, token, { confirmSlug: SLUG });
    check(paying.status === 409 && /paying customer/i.test(paying.body.message ?? ""), `a paying customer is never deleted (${paying.status})`);
    await control.organization.update({ where: { id: org.id }, data: { planTier: "STARTER" } });
    await control.organization.update({ where: { id: org.id }, data: { status: "ACTIVE" } });
    const notLapsed = await api("POST", `/platform-admin/retention/${org.id}/delete`, token, { confirmSlug: SLUG });
    check(notLapsed.status === 409, `an active workspace is not deleted under the policy (${notLapsed.status})`);
    await control.organization.update({ where: { id: org.id }, data: { status: "GRACE" } });

    step(8, "deletion, for real (this org has no tenant database, so nothing is dropped)");
    const del = await api("POST", `/platform-admin/retention/${org.id}/delete`, token, { confirmSlug: SLUG });
    check(del.status === 200 && del.body.deleted === true, `deleted (${del.status})`);
    const gone = await control.organization.findUnique({ where: { id: org.id }, select: { status: true, retentionDeletedAt: true } });
    check(gone.status === "ARCHIVED" && Boolean(gone.retentionDeletedAt), `archived and stamped (${gone.status})`);
    const confirmation = await control.platformEmailLog.findFirst({ where: { organizationId: org.id, dayMarker: "deleted" } });
    check(Boolean(confirmation), "the deletion confirmation email was attempted and logged");
    const audit = await api("GET", "/platform-admin/audit", token, undefined);
    check(audit.body.some((a) => a.action === "retention.workspace_deleted" && a.metadata?.slug === SLUG), "the deletion is in the control-plane audit trail");
    check(audit.body.some((a) => a.action === "retention.workspace_restored"), "so is the customer's restore");
    check(audit.body.some((a) => a.action === "retention.feedback_received"), "so is the feedback");

    step(9, "the overview counts it");
    const overview = await api("GET", "/platform-admin/overview", token);
    check(overview.status === 200 && overview.body.orgs.deletedUnderPolicy >= 1, `overview reports ${overview.body?.orgs?.deletedUnderPolicy} deleted under policy`);
  } finally {
    await control.trialFeedback.deleteMany({ where: { organizationId: org.id } });
    await control.platformEmailLog.deleteMany({ where: { organizationId: org.id } });
    await control.platformAuditLog.deleteMany({ where: { entityId: org.id } });
    await control.organization.deleteMany({ where: { id: org.id } });
    await control.$disconnect();
    console.log(`\nthrowaway org "${SLUG}" and its rows removed`);
    console.log(`${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
