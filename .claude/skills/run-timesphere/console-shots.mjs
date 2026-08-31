/**
 * Screenshots every page of the platform-admin console, in both themes and at every breakpoint,
 * against a running stack.
 *
 * It seeds THROWAWAY control-plane organizations first (no tenant databases) so the retention
 * queue, the feedback list, the email log and the overview have something to draw — a screenshot of
 * an empty table proves nothing — and deletes them, and every row they produced, in the `finally`.
 *
 *   node .claude/skills/run-timesphere/console-shots.mjs              # 1440 desktop, both themes
 *   node .claude/skills/run-timesphere/console-shots.mjs --responsive # + 1280 / 1024 / 768 / 390
 *   node .claude/skills/run-timesphere/console-shots.mjs --page retention --width 1024
 *
 * Output: test-results/run-shots/console-<page>-<theme>[-<width>].png (full page)
 */
import { chromium } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

const WEB = process.env.TS_WEB ?? "https://localhost:5173";
const OUT = path.resolve(root, process.env.TS_OUT ?? "test-results/run-shots");
const DAY = 24 * 60 * 60 * 1000;
const PREFIX = "shotdemo-";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

for (const line of readFileSync(path.join(root, "apps/api/.env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=("?)(.*)\2$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
}
const { PrismaClient } = await import(pathToFileURL(path.join(root, "apps/api/src/generated/control-client/index.js")).href);
const control = new PrismaClient();

/** Enough rows, at enough different stages, that every table and chart has to lay out real content. */
const DEMOS = [
  { slug: `${PREFIX}northwind`, name: "Northwind Labs", status: "ACTIVE", tier: "STARTER", endsInDays: 5, notices: {}, owner: "ops@northwind.example" },
  { slug: `${PREFIX}brightpath`, name: "Brightpath Consulting Group", status: "ACTIVE", tier: "STARTER", endsInDays: 11, notices: { feedback10: new Date(Date.now() - DAY).toISOString() }, owner: "priya.raghavan@brightpath-consulting.example" },
  { slug: `${PREFIX}kestrel`, name: "Kestrel Health", status: "GRACE", tier: "STARTER", endsInDays: -34, notices: { ended: new Date(Date.now() - 34 * DAY).toISOString(), "30": new Date(Date.now() - 4 * DAY).toISOString() }, owner: "finance@kestrel.example" },
  { slug: `${PREFIX}orbit`, name: "Orbit Freight", status: "SUSPENDED", tier: "STARTER", endsInDays: -84, notices: { ended: "superseded", "30": new Date(Date.now() - 54 * DAY).toISOString(), "60": new Date(Date.now() - 24 * DAY).toISOString(), "80": new Date(Date.now() - 4 * DAY).toISOString() }, owner: "it@orbitfreight.example" },
  { slug: `${PREFIX}meridian`, name: "Meridian Industrial", status: "GRACE", tier: "STARTER", endsInDays: -61, hold: true, notices: { ended: new Date(Date.now() - 61 * DAY).toISOString(), "30": new Date(Date.now() - 31 * DAY).toISOString(), "60": new Date(Date.now() - DAY).toISOString() }, owner: "procurement@meridian-industrial.example" },
  { slug: `${PREFIX}vertex`, name: "Vertex Analytics", status: "ACTIVE", tier: "TEAM", endsInDays: -20, notices: { ended: new Date(Date.now() - 20 * DAY).toISOString() }, owner: "ops@vertex.example", converted: true }
];

/* Every page the console's own nav can reach. It is a hand-written list beside a nav that is
   itself a list, so it drifts: 5.0.0 added five pages and only `/revenue` reached this array,
   which meant a console screenshot pass reported success while never opening Access, Approvals,
   Alerts, Sales leads or an org profile. If you add a console route, add it here — a page nobody
   screenshots is a page whose dark theme nobody has ever seen. */
const PAGES = [
  ["", "overview"],
  ["/organizations", "organizations"],
  ["/retention", "retention"],
  ["/emails", "emails"],
  ["/feedback", "feedback"],
  ["/sales-leads", "sales-leads"],
  ["/plan-tiers", "plan-tiers"],
  ["/analytics", "analytics"],
  ["/revenue", "revenue"],
  ["/backups", "backups"],
  ["/monitoring", "monitoring"],
  ["/alerts", "alerts"],
  ["/maintenance", "maintenance"],
  ["/access", "access"],
  ["/approvals", "approvals"],
  ["/settings", "settings"]
];

const WIDTHS = flag("responsive") ? [1440, 1280, 1024, 768, 390] : [Number(value("width")) || 1440];
const ONLY = value("page");

async function main() {
  const created = [];
  for (const d of DEMOS) {
    await control.organization.deleteMany({ where: { slug: d.slug } });
    const ends = new Date(Date.now() + d.endsInDays * DAY);
    const org = await control.organization.create({
      data: {
        name: d.name,
        slug: d.slug,
        status: d.status,
        planTier: d.tier,
        trialTier: d.converted ? null : "TEAM",
        ownerEmail: d.owner,
        trialStartedAt: new Date(ends.getTime() - 15 * DAY),
        trialEndsAt: ends,
        graceStartedAt: d.endsInDays < 0 ? ends : null,
        retentionHold: Boolean(d.hold),
        retentionNoticesSent: d.notices
      }
    });
    created.push(org.id);
  }

  await control.trialFeedback.createMany({
    data: [
      { organizationId: created[2], stage: "30", rating: 4, liked: "Approvals were much simpler than the spreadsheet we replaced, and the mobile view actually worked on site.", missing: "We needed Jira sync before we could move the whole delivery team across.", wouldReturn: "maybe" },
      { organizationId: created[3], stage: "60", rating: 2, liked: "Reporting looked good.", missing: "Rolling it out to 200 people needed SCIM, which our tier did not include, and nobody told us until we tried.", wouldReturn: "no", comment: "We would look again if provisioning were on the Team plan." },
      { organizationId: created[0], stage: "feedback10", rating: 5, liked: "Set up in an afternoon. The AI ticket triage is genuinely useful.", wouldReturn: "yes" },
      { organizationId: created[1], stage: "feedback10", rating: 4, liked: "Timesheet entry is fast.", missing: "Wanted per-client rate cards.", wouldReturn: "yes" },
      { organizationId: created[4], stage: "60", rating: 3, liked: "Change management is close to what our auditors ask for.", missing: "Procurement stalled — we needed an invoice, not a card.", wouldReturn: "maybe" }
    ]
  });

  // A believable delivery log: sends, a couple of failures, one skipped, one test.
  const templates = ["retention.feedback10", "retention.trial_ended", "retention.day30", "retention.day60", "retention.day80", "signup.verify"];
  const logs = [];
  for (let i = 0; i < 26; i++) {
    const org = created[i % created.length];
    const templateKey = templates[i % templates.length];
    const status = i % 11 === 3 ? "FAILED" : i % 13 === 7 ? "SKIPPED" : "SENT";
    logs.push({
      organizationId: org,
      templateKey,
      to: DEMOS[i % DEMOS.length].owner,
      subject: "TimeSphere — your workspace",
      status,
      errorMessage: status === "FAILED" ? "550 5.1.1 The email account that you tried to reach does not exist" : status === "SKIPPED" ? "No relay configured" : null,
      dayMarker: templateKey.startsWith("retention.") ? templateKey.replace("retention.day", "").replace("retention.", "") : null,
      isTest: i === 25,
      payload: { html: "<p>Demo body for the screenshot fixture.</p>" },
      createdAt: new Date(Date.now() - i * 2.5 * DAY)
    });
  }
  await control.platformEmailLog.createMany({ data: logs });

  // A snapshot directory with plausible files, so the Backups page draws its real table rather than
  // its (correct, but uninformative) "no directory configured" state. Both the directory and the
  // settings row are put back exactly as they were in the `finally`.
  const snapshotDir = path.join(os.tmpdir(), "timesphere-shot-snapshots");
  const previousSettings = await control.platformRetentionSettings.findUnique({ where: { id: "global" } });
  mkdirSync(snapshotDir, { recursive: true });
  const dump = (rows) => `-- MySQL dump 10.13\n-- Screenshot fixture, not a real workspace.\n${"-- filler\n".repeat(rows)}`;
  writeFileSync(path.join(snapshotDir, `${PREFIX}orbit-2026-08-14T09-30-04-118Z.sql`), dump(9000));
  writeFileSync(path.join(snapshotDir, `${PREFIX}kestrel-2026-07-02T09-30-11-402Z.sql`), dump(240));
  writeFileSync(path.join(snapshotDir, "longgone-2026-05-19T09-30-02-771Z.sql"), dump(60));
  await control.platformRetentionSettings.upsert({
    where: { id: "global" },
    update: { snapshotDir },
    create: { id: "global", enabled: true, feedbackDay: 10, reminderDays: [30, 60, 80, 90], retentionDays: 90, autoDeleteEnabled: true, snapshotDir }
  });
  // Orbit is the restorable one: it exists in the control plane and has no database row.

  const browser = await chromium.launch();
  try {
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: width < 500 ? 844 : 950 } });
      const page = await ctx.newPage();
      await page.goto(`${WEB}/platform-admin/login`);
      await page.getByPlaceholder("platform-admin@timesphere.local").fill("platform-admin@timesphere.local");
      await page.getByPlaceholder("••••••••").fill("PlatformAdmin@12345");
      await page.getByRole("button", { name: /^sign in$/i }).click();
      await page.waitForURL(/\/platform-admin$/, { timeout: 20_000 });

      for (const theme of ["light", "dark"]) {
        await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
          document.documentElement.classList.toggle("dark", t === "dark");
          try {
            localStorage.setItem("timesheet:theme", t);
            // The release toast is a tenant-app affordance; it sits over the console's content in
            // every capture otherwise. Marking this build as seen is what a real operator's second
            // visit does anyway.
            localStorage.setItem("timesheet:seen-release", "9.9.9");
          } catch {
            /* private mode */
          }
        }, theme);

        for (const [route, name] of PAGES) {
          if (ONLY && name !== ONLY) continue;
          await page.goto(`${WEB}/platform-admin${route}`);
          await page.waitForLoadState("networkidle");
          // The "TimeSphere was updated" notice (BackendHealthGate) sits over the content whenever
          // the loaded bundle is older than the running API — which is every capture taken during a
          // dev session that has just bumped VERSION. Dismiss it, or it is in all 80 screenshots.
          const dismiss = page.getByRole("button", { name: "Dismiss update notice" });
          if (await dismiss.count()) await dismiss.first().click().catch(() => undefined);
          await page.waitForTimeout(700);
          const suffix = WIDTHS.length > 1 ? `-${width}` : "";
          const file = path.join(OUT, `console-${name}-${theme}${suffix}.png`);
          await page.screenshot({ path: file, fullPage: true });
          console.log(`  ${String(width).padEnd(5)} ${theme.padEnd(5)} ${name.padEnd(14)} → ${path.relative(root, file)}`);
        }
      }
      await ctx.close();
    }

    // The customer-facing halves, signed out, at desktop and phone.
    const logRow = await control.platformEmailLog.findFirst({ where: { organizationId: created[2] }, orderBy: { createdAt: "desc" } });
    void logRow;
    for (const [w, label] of [[1100, ""], [390, "-390"]]) {
      const anon = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: w, height: w < 500 ? 844 : 900 } });
      const pub = await anon.newPage();
      for (const theme of ["light", "dark"]) {
        await pub.goto(`${WEB}/login`);
        await pub.evaluate((t) => {
          document.documentElement.dataset.theme = t;
          document.documentElement.classList.toggle("dark", t === "dark");
          try {
            localStorage.setItem("timesheet:theme", t);
          } catch {
            /* ignore */
          }
        }, theme);
        await pub.goto(`${WEB}/platform-admin/login`);
        await pub.waitForLoadState("networkidle");
        await pub.screenshot({ path: path.join(OUT, `console-signin-${theme}${label}.png`), fullPage: true });
        console.log(`  ${String(w).padEnd(5)} ${theme.padEnd(5)} sign-in        → console-signin-${theme}${label}.png`);
      }
      await anon.close();
    }
  } finally {
    await browser.close();
    await control.trialFeedback.deleteMany({ where: { organizationId: { in: created } } });
    await control.platformEmailLog.deleteMany({ where: { organizationId: { in: created } } });
    await control.platformAuditLog.deleteMany({ where: { entityId: { in: created } } });
    await control.organization.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    // Put the retention policy back byte-for-byte, and remove the fixture directory.
    if (previousSettings) {
      await control.platformRetentionSettings.update({ where: { id: "global" }, data: { snapshotDir: previousSettings.snapshotDir } });
    } else {
      await control.platformRetentionSettings.deleteMany({ where: { id: "global" } });
    }
    rmSync(snapshotDir, { recursive: true, force: true });
    await control.$disconnect();
    console.log("\ndemo organizations removed");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
