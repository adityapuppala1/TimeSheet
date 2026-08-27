/**
 * SMTP smoke test.
 *
 *   npm run send-test                                       # one welcome to the default address
 *   npm run send-test -- you@example.com                    # one welcome to a custom address
 *   npm run send-test -- --template=timesheet.approved      # one named template
 *   npm run send-test -- --template=approved                # substring match, if it is unambiguous
 *   npm run send-test -- --list                             # print every template key and stop
 *   npm run send-test -- --all you@example.com              # every template, in one run
 *
 * Prints the SMTP config and MAIL_FROM health-check before sending so deliverability problems are
 * obvious without having to read logs.
 *
 * ── WHY THIS DERIVES ITS SAMPLES RATHER THAN CARRYING ITS OWN ──────────────────────────────────
 * It used to hold a hand-written `SAMPLES` map and assert `satisfies Record<keyof typeof templates,
 * …>` over it. That assertion had been unmet for a long time: 8 fixtures against 32 templates, so
 * `--all` sent a quarter of them while saying "every template". Nothing caught it, because
 * `apps/api/tsconfig.json` covers only `src` and the seed, and `tsx` transpiles scripts without
 * typechecking them.
 *
 * The registry that feeds the in-app Email templates editor already holds a sample-variable set for
 * every key (`sampleVariables`) and the shipped default body (`templateDefault`) — the same pair
 * `POST /email-templates/:key/test` renders. Reading from it means this script cannot drift again:
 * a template added to `TEMPLATE_VARIABLES` is in `--all` the moment it is registered, with no
 * second list to remember.
 *
 * Keys are the DOTTED ones (`digest.weekly`), not the camelCase names in `mail-templates.ts` —
 * those are what `EmailLog.template` records and what the editor shows, so a smoke test that used
 * different names would be one more thing to translate.
 */
import { env } from "../src/config/env.js";
import { sendMail, getTransportStatus } from "../src/services/mail.service.js";
import { requireTenantContext } from "../src/config/tenant-context.js";
import { runForEveryOrg } from "../src/workers/run-for-every-org.js";
import { TEMPLATE_KEYS, applyVars, sampleVariables, templateDefault } from "../src/services/template-store.service.js";

interface Args {
  to: string;
  templateName: string;
  all: boolean;
  list: boolean;
}

function parseArgs(): Args {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const flags = Object.fromEntries(
    process.argv.slice(2)
      .filter((arg) => arg.startsWith("--"))
      .map((arg) => {
        const [k, v] = arg.replace(/^--/, "").split("=");
        return [k, v ?? "true"];
      })
  );
  const to = positional[0] || flags.to || "aditya.puppala@hics.com.sg";
  const templateName = flags.template || "welcome";
  const all = flags.all === "true";
  const list = flags.list === "true";
  return { to, templateName, all, list };
}

/**
 * Resolves what the user typed to a real key: an exact match first, then an unambiguous
 * case-insensitive substring. An ambiguous or unknown name prints the candidates rather than
 * silently sending the wrong template or a bare "not found".
 */
function resolveTemplateKey(input: string): string | { error: string } {
  if (TEMPLATE_KEYS.includes(input)) return input;
  const needle = input.toLowerCase();
  const matches = TEMPLATE_KEYS.filter((key) => key.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return { error: `No template matches "${input}". Run with --list to see all ${TEMPLATE_KEYS.length}.` };
  return { error: `"${input}" is ambiguous — it matches: ${matches.join(", ")}` };
}

/** The shipped default body with its sample variables filled in — exactly what the in-app
 *  "send test" button renders, so the two cannot disagree about what a template looks like. */
function renderSample(key: string): { subject: string; html: string } | null {
  const shipped = templateDefault(key);
  if (!shipped) return null;
  const vars = sampleVariables(key);
  return { subject: applyVars(shipped.subject, vars), html: applyVars(shipped.html, vars) };
}

function maskedUser(user: string | null) {
  if (!user) return "(none)";
  if (user.length <= 4) return "***";
  return `${user.slice(0, 2)}***${user.slice(-2)}`;
}

async function printConfig(to: string) {
  // AWAITED. It was not, so `status` was a Promise and `status.fromIssues` was always undefined —
  // the MAIL_FROM deliverability warning this function exists to print could never fire.
  const status = await getTransportStatus();
  console.log("\n========================================");
  console.log("  TimeSphere SMTP smoke test");
  console.log("========================================");
  console.log(`  NODE_ENV     : ${env.NODE_ENV}`);
  console.log(`  MAIL_FROM    : ${env.MAIL_FROM}`);
  console.log(`  SMTP_HOST    : ${env.SMTP_HOST || "(empty — emails WILL NOT be delivered)"}`);
  console.log(`  SMTP_PORT    : ${env.SMTP_PORT}`);
  console.log(`  SMTP_SECURE  : ${env.SMTP_SECURE}`);
  console.log(`  SMTP_USER    : ${maskedUser(env.SMTP_USER)}`);
  console.log(`  SMTP_PASS    : ${env.SMTP_PASS ? "***set***" : "(empty)"}`);
  console.log(`  Recipient    : ${to}`);
  console.log("----------------------------------------");

  if (status.fromIssues.length > 0) {
    console.warn("\n  ⚠️  Deliverability warnings on MAIL_FROM:");
    for (const issue of status.fromIssues) {
      console.warn(`     • ${issue}`);
    }
    console.log("");
  }
}

async function sendOne(templateName: string, to: string) {
  const sample = renderSample(templateName);
  if (!sample) throw new Error(`"${templateName}" has no shipped default to render.`);
  const { subject, html } = sample;
  const result = await sendMail({
    to, subject, html,
    template: "smoke-test",
    metadata: { source: "scripts/send-test-email.ts", templateName },
    // Test/smoke runs bypass the workspace BCC list — only the recipient gets it.
    skipBcc: true
  });
  return { templateName, ...result };
}


/** Sends the resolved set to one address, inside whatever tenant context the caller established. */
async function sendAll(to: string, targets: string[]): Promise<void> {
  await printConfig(to);

  if (!env.SMTP_HOST) {
    console.error("❌  SMTP_HOST is empty. Set SMTP_HOST/PORT/USER/PASS in apps/api/.env and re-run.\n");
    process.exitCode = 1;
    return;
  }

  console.log(`📧  Sending ${targets.length} ${targets.length === 1 ? "template" : "templates"} to ${to}\n`);

  const results: Array<{ templateName: string; ok: boolean; errorMessage?: string; messageId?: string }> = [];
  for (const name of targets) {
    process.stdout.write(`   ${name.padEnd(30)} ... `);
    try {
      const result = await sendOne(name, to);
      results.push(result);
      console.log(result.ok ? `✅ SENT (messageId=${result.messageId ?? "—"})` : `❌ FAILED — ${result.errorMessage}`);
    } catch (err) {
      console.log(`❌ CRASHED — ${(err as Error).message}`);
      results.push({ templateName: name, ok: false, errorMessage: (err as Error).message });
    }
    // A courtesy gap between sends. The workspace's own SMTP throttle still applies underneath —
    // this only stops a 32-template run opening the connection as fast as the loop can iterate.
    if (targets.length > 1) await new Promise((r) => setTimeout(r, 200));
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;
  console.log(`\n----------------------------------------`);
  console.log(`  Summary: ${sent} sent, ${failed} failed`);
  console.log(`----------------------------------------\n`);
  if (failed > 0) process.exitCode = 1;

  if (sent > 0) {
    console.log("Next steps:");
    console.log(`  1. Check ${to}'s inbox (and SPAM folder)`);
    console.log("  2. If 'SENT' status but no email arrives, your SMTP provider accepted the message but delivery downstream failed.");
    console.log("     - Most common cause: MAIL_FROM uses a reserved/unverified domain (see banner in Email Templates page)");
    console.log("     - Check your SMTP provider's outbound logs using the messageIds above");
    console.log("  3. Open Email Templates → any template → Recent sends to see EmailLog rows in the UI\n");
  }
}

/**
 * Runs the send inside a TENANT CONTEXT.
 *
 * `sendMail` writes an `EmailLog` row through the tenant-scoped `prisma` proxy, so without one this
 * script threw "No tenant context is active" — on every run, because the `prisma.$disconnect()` in
 * its old `finally` touched the same proxy even when nothing was sent. It was not a script with one
 * stale type assertion; it could not complete at all.
 *
 * `runForEveryOrg` is the helper the cron workers already use, so a multi-org install smoke-tests
 * each org's own SMTP configuration rather than only the first one found — which is the useful
 * behaviour here anyway, since mail settings are per workspace.
 */
async function main(): Promise<void> {
  const { to, templateName, all, list } = parseArgs();

  if (list) {
    console.log(`\n${TEMPLATE_KEYS.length} templates:\n`);
    for (const key of [...TEMPLATE_KEYS].sort()) console.log(`  ${key}`);
    console.log("");
    return;
  }

  let targets: string[];
  if (all) {
    targets = [...TEMPLATE_KEYS].sort();
  } else {
    const resolved = resolveTemplateKey(templateName);
    if (typeof resolved !== "string") {
      console.error(`\n❌  ${resolved.error}\n`);
      process.exitCode = 1;
      return;
    }
    targets = [resolved];
  }

  await runForEveryOrg("send-test-email", async () => {
    console.log(`\n[${requireTenantContext().orgSlug}]`);
    await sendAll(to, targets);
  });
}

main().catch((error) => {
  console.error("\n❌  Smoke test crashed:", error);
  process.exitCode = 1;
});
