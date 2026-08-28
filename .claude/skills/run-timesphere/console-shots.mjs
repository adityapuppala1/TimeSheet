/**
 * Screenshots every page of the platform-admin console, in both themes, against a running stack.
 *
 * It seeds three THROWAWAY control-plane organizations first (no tenant databases) so the retention
 * queue, the feedback list and the overview have something to draw — a screenshot of an empty table
 * proves nothing — and deletes them, and every row they produced, in the `finally`.
 *
 *   node .claude/skills/run-timesphere/console-shots.mjs
 *
 * Output: test-results/run-shots/console-<page>-<theme>.png
 */
import { chromium } from "@playwright/test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const require = createRequire(import.meta.url);

const WEB = process.env.TS_WEB ?? "https://localhost:5173";
const OUT = path.resolve(root, process.env.TS_OUT ?? "test-results/run-shots");
const DAY = 24 * 60 * 60 * 1000;
const PREFIX = "shotdemo-";

for (const line of readFileSync(path.join(root, "apps/api/.env"), "utf8").split(/\r?\n/)) {
  const m = /^([A-Z_]+)=("?)(.*)\2$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[3];
}
const { PrismaClient } = await import(pathToFileURL(path.join(root, "apps/api/src/generated/control-client/index.js")).href);
const control = new PrismaClient();

const DEMOS = [
  { slug: `${PREFIX}northwind`, name: "Northwind Labs", status: "ACTIVE", endsInDays: 5, notices: {}, owner: "ops@northwind.example" },
  { slug: `${PREFIX}kestrel`, name: "Kestrel Health", status: "GRACE", endsInDays: -34, notices: { ended: new Date(Date.now() - 34 * DAY).toISOString(), "30": new Date(Date.now() - 4 * DAY).toISOString() }, owner: "finance@kestrel.example" },
  { slug: `${PREFIX}orbit`, name: "Orbit Freight", status: "SUSPENDED", endsInDays: -84, notices: { ended: "superseded", "30": new Date(Date.now() - 54 * DAY).toISOString(), "60": new Date(Date.now() - 24 * DAY).toISOString(), "80": new Date(Date.now() - 4 * DAY).toISOString() }, owner: "it@orbitfreight.example" }
];

const PAGES = [
  ["", "overview"],
  ["/organizations", "organizations"],
  ["/retention", "retention"],
  ["/emails", "emails"],
  ["/feedback", "feedback"],
  ["/plan-tiers", "plan-tiers"],
  ["/analytics", "analytics"],
  ["/settings", "settings"]
];

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
        planTier: "STARTER",
        trialTier: "TEAM",
        ownerEmail: d.owner,
        trialStartedAt: new Date(ends.getTime() - 15 * DAY),
        trialEndsAt: ends,
        graceStartedAt: d.endsInDays < 0 ? ends : null,
        retentionNoticesSent: d.notices
      }
    });
    created.push(org.id);
  }
  await control.trialFeedback.createMany({
    data: [
      { organizationId: created[1], stage: "30", rating: 4, liked: "Approvals were much simpler than our spreadsheet.", missing: "We needed Jira sync before we could switch the whole team.", wouldReturn: "maybe" },
      { organizationId: created[2], stage: "60", rating: 2, liked: "Reporting looked good.", missing: "Rolling it out to 200 people needed SCIM, which our tier did not include.", wouldReturn: "no" },
      { organizationId: created[0], stage: "feedback10", rating: 5, liked: "Set up in an afternoon. The AI ticket triage is genuinely useful.", wouldReturn: "yes" }
    ]
  });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  try {
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
        } catch {
          /* private mode */
        }
      }, theme);
      for (const [route, name] of PAGES) {
        await page.goto(`${WEB}/platform-admin${route}`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(600);
        const file = path.join(OUT, `console-${name}-${theme}.png`);
        await page.screenshot({ path: file, fullPage: false });
        console.log(`  ${theme.padEnd(5)} ${name.padEnd(14)} → ${path.relative(root, file)}`);
      }
    }

    // The customer-facing halves, signed out.
    const anon = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 900 } });
    const pub = await anon.newPage();
    const logRow = await control.platformEmailLog.findFirst({ where: { organizationId: created[1] }, orderBy: { createdAt: "desc" } });
    const token = logRow ? /\/feedback\/([A-Za-z0-9_.-]+)/.exec(logRow.payload?.html ?? "")?.[1] : null;
    if (token) {
      await pub.goto(`${WEB}/feedback/${token}`);
      await pub.waitForLoadState("networkidle");
      await pub.screenshot({ path: path.join(OUT, "console-public-feedback.png") });
      console.log("  public feedback form      → console-public-feedback.png");
    } else {
      console.log("  (no logged retention email to lift a feedback token from — run retention-verify.mjs first for that shot)");
    }
    await anon.close();
  } finally {
    await browser.close();
    await control.trialFeedback.deleteMany({ where: { organizationId: { in: created } } });
    await control.platformEmailLog.deleteMany({ where: { organizationId: { in: created } } });
    await control.platformAuditLog.deleteMany({ where: { entityId: { in: created } } });
    await control.organization.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await control.$disconnect();
    console.log("\ndemo organizations removed");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
