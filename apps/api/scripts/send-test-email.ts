/**
 * SMTP smoke test.
 *
 *   npm run send-test                                    # one welcome to default
 *   npm run send-test -- aditya.puppala@hics.com.sg      # one welcome to custom
 *   npm run send-test -- --template=timesheetApproved    # different template
 *   npm run send-test -- --all aditya.puppala@hics.com.sg   # every template (welcome, reset, all daily/sla/timesheet variants)
 *
 * Prints the SMTP config and MAIL_FROM health-check before sending so deliverability
 * problems are obvious without having to read logs.
 */
import { env } from "../src/config/env.js";
import { prisma } from "../src/config/prisma.js";
import { sendMail, getTransportStatus } from "../src/services/mail.service.js";
import { templates } from "../src/services/mail-templates.js";

interface Args {
  to: string;
  templateName: keyof typeof templates;
  all: boolean;
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
  const templateName = (flags.template as keyof typeof templates) || "welcome";
  const all = flags.all === "true";
  return { to, templateName, all };
}

const SAMPLES = {
  welcome: () => ({ subject: "Welcome to TimeSphere", html: templates.welcome("Aditya") }),
  reset: () => ({
    subject: "Reset your TimeSphere password",
    html: templates.reset("https://timesphere.local/reset-password?token=smoke-test")
  }),
  timesheetSubmitted: () => ({
    subject: "Timesheet submitted — 7.50h",
    html: templates.timesheetSubmitted({
      name: "Aditya", hours: 7.5, date: new Date().toISOString().slice(0, 10),
      project: "HICS Operations Platform", managerName: "Mira Kapoor"
    })
  }),
  timesheetApproved: () => ({
    subject: "Approved: your 7.50h timesheet",
    html: templates.timesheetApproved({
      name: "Aditya", hours: 7.5, date: new Date().toISOString().slice(0, 10),
      reviewer: "Mira Kapoor", project: "HICS Operations Platform"
    })
  }),
  timesheetRejected: () => ({
    subject: "Action required: timesheet rejected",
    html: templates.timesheetRejected({
      name: "Aditya", date: new Date().toISOString().slice(0, 10),
      project: "HICS Operations Platform", reviewer: "Mira Kapoor",
      reason: "Activity should be 'Bug Fixing'."
    })
  }),
  slaBreach: () => ({
    subject: "[SLA breach] Approve Aditya's timesheet",
    html: templates.slaBreach({
      managerName: "Mira Kapoor", employeeName: "Aditya",
      date: new Date().toISOString().slice(0, 10),
      project: "HICS Operations Platform",
      deadline: new Date().toLocaleString(), hoursOverdue: 4.2
    })
  }),
  escalation: () => ({
    subject: "[Escalation] Approve Aditya's timesheet",
    html: templates.escalation({
      targetName: "Avery Stone", employeeName: "Aditya", managerName: "Mira Kapoor",
      date: new Date().toISOString().slice(0, 10), project: "HICS Operations Platform"
    })
  }),
  deadlineReminder: () => ({
    subject: "3 days left to submit timesheets",
    html: templates.deadlineReminder({ name: "Aditya", daysLeft: 3, deadlineDay: 5 })
  })
} satisfies Record<keyof typeof templates, () => { subject: string; html: string }>;

function maskedUser(user: string | null) {
  if (!user) return "(none)";
  if (user.length <= 4) return "***";
  return `${user.slice(0, 2)}***${user.slice(-2)}`;
}

function printConfig(to: string) {
  const status = getTransportStatus();
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

async function sendOne(templateName: keyof typeof templates, to: string) {
  const { subject, html } = SAMPLES[templateName]();
  const result = await sendMail({
    to, subject, html,
    template: "smoke-test",
    metadata: { source: "scripts/send-test-email.ts", templateName },
    // Test/smoke runs bypass the workspace BCC list — only the recipient gets it.
    skipBcc: true
  });
  return { templateName, ...result };
}

async function main() {
  const { to, templateName, all } = parseArgs();
  printConfig(to);

  if (!env.SMTP_HOST) {
    console.error("❌  SMTP_HOST is empty. Set SMTP_HOST/PORT/USER/PASS in apps/api/.env and re-run.\n");
    process.exitCode = 1;
    return;
  }

  const targets: Array<keyof typeof templates> = all
    ? (Object.keys(SAMPLES) as Array<keyof typeof templates>)
    : [templateName];

  console.log(`📧  Sending ${targets.length} ${targets.length === 1 ? "template" : "templates"} to ${to}\n`);

  const results: Array<{ templateName: string; ok: boolean; errorMessage?: string; emailLogId?: string; messageId?: string }> = [];
  for (const name of targets) {
    process.stdout.write(`   ${name.padEnd(28)} ... `);
    try {
      const result = await sendOne(name, to);
      results.push(result);
      if (result.ok) {
        console.log(`✅ SENT (messageId=${result.messageId ?? "—"})`);
      } else {
        console.log(`❌ FAILED — ${result.errorMessage}`);
      }
    } catch (err) {
      console.log(`❌ CRASHED — ${(err as Error).message}`);
      results.push({ templateName: name, ok: false, errorMessage: (err as Error).message });
    }
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

main()
  .catch((err) => {
    console.error("\n❌  Smoke test crashed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
