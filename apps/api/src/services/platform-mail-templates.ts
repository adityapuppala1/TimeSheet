/**
 * WHAT: every email the PLATFORM sends — as opposed to a workspace — with its variables, a sample
 * value for each, and the shipped default body. The trial retention programme lives here
 * (`retention.*`), plus the signup code, the sales pair the public contact form sends
 * (`sales.*` — one to us, one back to the prospect) and the "is mail working" test.
 *
 * WHY DEFAULTS ARE STRINGS WITH `{{placeholders}}` RATHER THAN FUNCTIONS. The tenant registry in
 * `mail-templates.ts` compiles its bodies in code and keeps a second, placeholder-based copy for
 * the editor. Here the placeholder body IS the one that is sent: the worker and the console
 * preview run the same string through the same `applyVars`, so what the operator sees in the
 * editor is what the customer receives, override or not. Values are HTML-escaped at substitution
 * (see `platform-mail.service.ts#renderPlatformTemplate`), which is what makes it safe to put a
 * workspace name a stranger typed into a heading.
 *
 * THE TONE IS DELIBERATE. Every retention message says three things in this order: your data is
 * intact, here is the one click that brings it back, and here is where to tell us why you left.
 * The deletion date is stated as a date, never as "soon" — a customer can only act on a date.
 */
import { emailShell } from "./mail-templates.js";

const { shell, heading, paragraph, button, ACCENT } = emailShell;

export interface PlatformTemplateDef {
  key: string;
  group: "Trial retention" | "Signup" | "Sales" | "Operator";
  description: string;
  /** Which `{{vars}}` the body may use, in the order the editor lists them. */
  variables: string[];
  /** Realistic sample values for the preview and the test send. */
  sample: Record<string, string>;
  subject: string;
  html: string;
}

const RETENTION_VARS = [
  "name",
  "workspace",
  "workspaceUrl",
  "reactivateUrl",
  "feedbackUrl",
  "billingUrl",
  "deleteDate",
  "daysUntilDeletion",
  "daysSinceTrial",
  "retentionDays",
  "appUrl"
];

const RETENTION_SAMPLE: Record<string, string> = {
  name: "Priya",
  workspace: "Acme Corp",
  workspaceUrl: "https://acme.timesphere.app",
  reactivateUrl: "https://timesphere.app/reactivate/demo-token",
  feedbackUrl: "https://timesphere.app/feedback/demo-token",
  billingUrl: "https://acme.timesphere.app/app/settings?tab=billing",
  deleteDate: "27 November 2026",
  daysUntilDeletion: "60",
  daysSinceTrial: "30",
  retentionDays: "90",
  appUrl: "https://timesphere.app"
};

/**
 * What the sales notification is allowed to say. Ordered the way the email reads: who, what they
 * are asking for, what they wrote, and where the enquiry came from.
 *
 * `freeMailNote` is a whole sentence rather than a boolean because every value is substituted as
 * escaped TEXT — a template cannot branch, so the branch happens where the row is written and the
 * result arrives as a line to print or an empty string. Same for `campaign`: the three UTM fields
 * are joined into one readable string rather than three variables that are usually blank.
 */
const SALES_LEAD_VARS = [
  "name",
  "email",
  "company",
  "role",
  "teamSize",
  "deployment",
  "timeline",
  "interests",
  "message",
  "country",
  "phone",
  "sourcePage",
  "referrer",
  "campaign",
  "freeMailNote",
  "consoleUrl",
  "appUrl"
];

/** The small print every retention email ends with — the policy, in one sentence, every time. */
const policyLine = () =>
  paragraph(
    `<span style="font-size:12px;color:#64748B;">As a policy, a workspace whose trial ended is kept for {{retentionDays}} days and then deleted permanently unless it moves to a paid Team or Enterprise plan. Yours is scheduled for <strong>{{deleteDate}}</strong>.</span>`
  );

const feedbackLine = () =>
  paragraph(
    `Could you spare two minutes to tell us what worked and what did not? <a href="{{feedbackUrl}}" style="color:${ACCENT};font-weight:600;">Share your feedback</a> — it goes straight to the people building TimeSphere.`
  );

/** One list of alerts, in a box that keeps its line breaks. `white-space:pre-wrap` rather than
 *  `<br>`s because every substituted value is HTML-escaped, so markup built into a variable arrives
 *  as visible angle brackets — preserving the newlines the sender wrote is the only thing that
 *  survives that. Monospaced so a column of `[CRITICAL]` prefixes lines up. */
const alertBlock = (body: string) =>
  `<pre style="margin:0 0 14px;padding:12px 14px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:19px;color:#0F172A;white-space:pre-wrap;word-break:break-word;">${body}</pre>`;

export const PLATFORM_TEMPLATES: PlatformTemplateDef[] = [
  {
    key: "retention.feedback10",
    group: "Trial retention",
    description: "Day 10 of the trial: a friendly check-in with the feedback form, while the experience is fresh.",
    variables: ["name", "workspace", "workspaceUrl", "feedbackUrl", "billingUrl", "daysLeft", "appUrl"],
    sample: { ...RETENTION_SAMPLE, daysLeft: "5" },
    subject: "How is {{workspace}} going so far?",
    html: shell(
      { title: "How is it going?", preheader: "Ten days in — tell us what you think.", accentColor: ACCENT },
      heading("Hi {{name}}, how is {{workspace}} going?") +
        paragraph("You are ten days into your TimeSphere trial, with <strong>{{daysLeft}} days</strong> left on the Team plan. This is the moment your first impressions are worth the most to us.") +
        paragraph(button("Tell us how it's going", "{{feedbackUrl}}", ACCENT)) +
        paragraph("Two minutes, five questions — what you liked, what got in the way, what would make you stay.") +
        paragraph(`Ready to keep going? <a href="{{billingUrl}}" style="color:${ACCENT};font-weight:600;">Choose a plan</a> any time and nothing changes: same workspace, same data, same people.`)
    )
  },
  {
    key: "retention.trial_ended",
    group: "Trial retention",
    description: "The day the trial ends: the workspace is paused, the data is safe, and the 90-day policy is stated plainly.",
    variables: RETENTION_VARS,
    sample: { ...RETENTION_SAMPLE, daysSinceTrial: "0", daysUntilDeletion: "90" },
    subject: "Your TimeSphere trial has ended — your data is safe for {{retentionDays}} days",
    html: shell(
      { title: "Your trial has ended", preheader: "Nothing is deleted. Here is what happens next.", accentColor: ACCENT },
      heading("Your trial has ended, {{name}}") +
        paragraph("The free trial for <strong>{{workspace}}</strong> has come to an end. Your workspace is paused — every timesheet, ticket, change and report is exactly where you left it.") +
        paragraph("Whenever you are ready, one click brings it all back: choose a Team or Enterprise plan and you carry on where you stopped.") +
        paragraph(button("Restore my workspace", "{{reactivateUrl}}", ACCENT)) +
        feedbackLine() +
        policyLine()
    )
  },
  {
    key: "retention.day30",
    group: "Trial retention",
    description: "30 days after the trial ended: we miss you, the data is still here.",
    variables: RETENTION_VARS,
    sample: { ...RETENTION_SAMPLE, daysSinceTrial: "30", daysUntilDeletion: "60" },
    subject: "We miss you at {{workspace}} — everything is still here",
    html: shell(
      { title: "We miss you", preheader: "Your workspace is waiting, untouched.", accentColor: ACCENT },
      heading("We miss you, {{name}}") +
        paragraph("It has been a month since the <strong>{{workspace}}</strong> trial ended, and your workspace is still here, untouched — the people, the projects, the history.") +
        paragraph("If the timing was wrong, that is fine. If something was missing, we would genuinely like to know what.") +
        paragraph(button("Come back to {{workspace}}", "{{reactivateUrl}}", ACCENT)) +
        feedbackLine() +
        policyLine()
    )
  },
  {
    key: "retention.day60",
    group: "Trial retention",
    description: "60 days after the trial ended: still here for you, one month before deletion.",
    variables: RETENTION_VARS,
    sample: { ...RETENTION_SAMPLE, daysSinceTrial: "60", daysUntilDeletion: "30" },
    subject: "{{workspace}} is kept for {{daysUntilDeletion}} more days",
    html: shell(
      { title: "Still here for you", preheader: "A month left before your workspace is removed.", accentColor: ACCENT },
      heading("Still here for you, {{name}}") +
        paragraph("Two months on, your <strong>{{workspace}}</strong> workspace is still intact — and it stays that way for another <strong>{{daysUntilDeletion}} days</strong>.") +
        paragraph("If you would like to pick things up again, a Team or Enterprise plan restores everything instantly. If not, we would still love to hear what we could have done better.") +
        paragraph(button("Restore my workspace", "{{reactivateUrl}}", ACCENT)) +
        feedbackLine() +
        policyLine()
    )
  },
  {
    key: "retention.day80",
    group: "Trial retention",
    description: "80 days after the trial ended: ten days' notice before the workspace is deleted.",
    variables: RETENTION_VARS,
    sample: { ...RETENTION_SAMPLE, daysSinceTrial: "80", daysUntilDeletion: "10" },
    subject: "{{daysUntilDeletion}} days until {{workspace}} is deleted",
    html: shell(
      { title: "Ten days' notice", preheader: "Your workspace is deleted on {{deleteDate}} unless you restore it.", accentColor: ACCENT },
      heading("{{daysUntilDeletion}} days left, {{name}}") +
        paragraph("This is the notice we promised: the <strong>{{workspace}}</strong> workspace and all of its data will be permanently deleted on <strong>{{deleteDate}}</strong>.") +
        paragraph("Restoring it takes one click and a plan choice. After the date there is nothing to restore — deletion is permanent, and we cannot recover it for you afterwards.") +
        paragraph(button("Restore before {{deleteDate}}", "{{reactivateUrl}}", ACCENT)) +
        feedbackLine() +
        policyLine()
    )
  },
  {
    key: "retention.day90",
    group: "Trial retention",
    description: "Day 90: the final notice. The deletion runs on the next daily tick after this is sent.",
    variables: RETENTION_VARS,
    sample: { ...RETENTION_SAMPLE, daysSinceTrial: "90", daysUntilDeletion: "1" },
    subject: "Final notice: {{workspace}} is deleted tomorrow",
    html: shell(
      { title: "Final notice", preheader: "Your workspace is removed tomorrow.", accentColor: "#DC2626" },
      heading("Final notice, {{name}}") +
        paragraph("Tomorrow the <strong>{{workspace}}</strong> workspace is permanently deleted under the {{retentionDays}}-day policy. This is the last message about it.") +
        paragraph("If you want to keep it, restore it today. If you have already decided to move on, thank you for trying TimeSphere — and a last word on why would still help us.") +
        paragraph(button("Restore my workspace today", "{{reactivateUrl}}", "#DC2626")) +
        feedbackLine()
    )
  },
  {
    key: "retention.deleted",
    group: "Trial retention",
    description: "Sent once the workspace has been deleted: a plain confirmation, and the door left open.",
    variables: ["name", "workspace", "signupUrl", "feedbackUrl", "appUrl"],
    sample: { name: "Priya", workspace: "Acme Corp", signupUrl: "https://timesphere.app/signup", feedbackUrl: "https://timesphere.app/feedback/demo-token", appUrl: "https://timesphere.app" },
    subject: "{{workspace}} has been deleted",
    html: shell(
      { title: "Workspace deleted", preheader: "Your data has been removed, as promised." },
      heading("{{workspace}} has been deleted") +
        paragraph("As we said we would, the <strong>{{workspace}}</strong> workspace and all of its data have now been permanently deleted. Nothing about it remains on our servers.") +
        paragraph("Thank you for trying TimeSphere, {{name}}. If circumstances change, you are always welcome to start again — a new workspace takes about a minute.") +
        paragraph(button("Start a new workspace", "{{signupUrl}}")) +
        feedbackLine()
    )
  },
  {
    key: "signup.verify",
    group: "Signup",
    description: "The six-digit code that proves an address before a trial workspace is created.",
    variables: ["code", "appUrl"],
    sample: { code: "418902", appUrl: "https://timesphere.app" },
    subject: "Your TimeSphere verification code",
    html: shell(
      { title: "Your verification code", preheader: "Enter this code to continue." },
      heading("Your verification code") +
        paragraph(`<span style="display:inline-block;padding:14px 22px;border-radius:10px;background:#F1F5F9;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:28px;letter-spacing:.3em;font-weight:700;color:#0F172A;">{{code}}</span>`) +
        paragraph("It expires in 15 minutes. If you did not ask for it, you can ignore this message — nothing is created without the code.")
    )
  },
  {
    key: "sales.lead",
    group: "Sales",
    description: "The internal notification when somebody fills in the public contact form. Sent to the sales inbox, with Reply-To set to the prospect.",
    variables: SALES_LEAD_VARS,
    sample: {
      name: "Priya Raman",
      email: "priya@northwind.co.uk",
      company: "Northwind Logistics",
      role: "Head of Operations",
      teamSize: "201–500",
      deployment: "Our own cloud",
      timeline: "This quarter",
      interests: "Timesheets & approvals, SSO / SCIM, Backups & retention",
      message: "We run about 300 field engineers across three countries and currently reconcile hours in one system and tickets in another.\n\nWhat would a migration look like?",
      country: "United Kingdom",
      phone: "+44 20 7946 0123",
      sourcePage: "/contact",
      referrer: "https://www.google.com/",
      campaign: "google / cpc / q3-enterprise",
      freeMailNote: "",
      consoleUrl: "https://timesphere.app/platform-admin/sales-leads",
      appUrl: "https://timesphere.app"
    },
    // SUBJECT CARRIES THE QUALIFICATION, because a sales inbox is read as a list of subject lines
    // and "New enquiry" in forty rows tells you nothing about which one to open first.
    subject: "Lead: {{company}} — {{teamSize}}, {{deployment}}, {{timeline}}",
    html: shell(
      { title: "New sales lead", preheader: "{{company}} · {{teamSize}} · {{deployment}} · {{timeline}}", accentColor: ACCENT },
      heading("{{company}}") +
        // The header line repeats the subject on purpose: whoever forwards this to a colleague
        // forwards the body, and the four facts that decide who picks it up must survive that.
        paragraph(
          `<span style="display:inline-block;padding:8px 12px;border-radius:8px;background:#FEF3C7;font-size:13px;font-weight:700;color:#78350F;">{{teamSize}} &middot; {{deployment}} &middot; {{timeline}}</span>`
        ) +
        // Every optional field is printed with an em-dash placeholder rather than omitted. A fixed
        // block is scannable at a glance; a block whose lines move depending on what was filled in
        // has to be read. (A "{{roleSuffix}}"-style variable carrying its own <br> cannot work here
        // — substitution escapes markup, so the tag would arrive as visible text.)
        paragraph(
          `<strong>{{name}}</strong> &middot; {{role}}<br /><a href="mailto:{{email}}" style="color:${ACCENT};font-weight:600;">{{email}}</a><br /><span style="font-size:13px;color:#64748B;">{{country}} &middot; {{phone}}</span>`
        ) +
        paragraph(`<span style="font-size:12px;color:#64748B;">Evaluating: {{interests}}</span>`) +
        paragraph(`<span style="font-size:12px;color:#64748B;">{{freeMailNote}}</span>`) +
        // `white-space:pre-wrap` rather than turning newlines into <br>: every value is HTML-escaped
        // at substitution (that is what makes a stranger's words safe here), so markup injected
        // into the message would arrive as visible text. CSS keeps their paragraphs instead.
        paragraph(
          `<span style="display:block;padding:14px 16px;border-radius:10px;background:#F8FAFC;border:1px solid #E2E8F0;white-space:pre-wrap;font-size:14px;line-height:22px;color:#0F172A;">{{message}}</span>`
        ) +
        paragraph(button("Open in the console", "{{consoleUrl}}", ACCENT)) +
        paragraph(
          `<span style="font-size:12px;color:#64748B;">Reply to this message and it goes straight to {{email}}. Arrived from {{sourcePage}} &middot; referrer {{referrer}} &middot; campaign {{campaign}}.</span>`
        )
    )
  },
  {
    key: "sales.ack",
    group: "Sales",
    description: "The confirmation the prospect gets back. Says when a human will reply, and gives them something to do in the meantime.",
    variables: ["name", "company", "responseWindow", "trialUrl", "faqUrl", "appUrl"],
    sample: {
      name: "Priya",
      company: "Northwind Logistics",
      responseWindow: "one working day",
      trialUrl: "https://timesphere.app/signup",
      faqUrl: "https://timesphere.app/#faq",
      appUrl: "https://timesphere.app"
    },
    subject: "Thanks — we have your message",
    html: shell(
      { title: "We have your message", preheader: "A person will reply within {{responseWindow}}." },
      heading("Thanks, {{name}}") +
        paragraph("We have your enquiry about TimeSphere for <strong>{{company}}</strong>. A person — not a sequence — will read it and reply within <strong>{{responseWindow}}</strong>.") +
        // NO MARKETING PADDING, and that is a promise this email has to keep itself: the only two
        // links are the ones somebody waiting for a reply might actually want.
        paragraph(
          `If you would rather not wait, the trial is open and needs no card: <a href="{{trialUrl}}" style="color:${ACCENT};font-weight:600;">start a workspace</a>. The questions we get asked most — where the data sits, whether AI can be switched off, whether it runs on your own infrastructure — are <a href="{{faqUrl}}" style="color:${ACCENT};font-weight:600;">answered here</a>.`
        ) +
        paragraph("You will not be added to anything. Reply to this message any time and it reaches the same person.")
    )
  },
  {
    key: "maintenance.scheduled",
    group: "Operator",
    description: "Sent to a workspace's super admins when the platform schedules maintenance across the fleet.",
    variables: ["workspace", "slug", "workspaceUrl", "startsAt", "endsAt", "note", "appUrl"],
    sample: {
      workspace: "Acme Corp",
      slug: "acme",
      workspaceUrl: "https://acme.timesphere.app",
      startsAt: "Sat, 06 Sep 2026 22:00:00 GMT",
      endsAt: "Sat, 06 Sep 2026 23:30:00 GMT",
      note: "Database maintenance. Timesheets already submitted are unaffected.",
      appUrl: "https://timesphere.app"
    },
    subject: "Scheduled maintenance for {{workspace}}",
    html: shell(
      { title: "Scheduled maintenance", preheader: "{{startsAt}} — what happens and what to do.", accentColor: ACCENT },
      heading("Scheduled maintenance for {{workspace}}") +
        paragraph("We will be carrying out maintenance on your workspace <strong>{{workspace}}</strong>.") +
        paragraph("<strong>From:</strong> {{startsAt}}<br /><strong>Until:</strong> {{endsAt}}") +
        paragraph("{{note}}") +
        paragraph(
          "While the window is open, everyone below super administrator is signed out and sees a maintenance page; open tabs are redirected within a few seconds. Nothing is deleted, and work already saved is unaffected."
        ) +
        paragraph(button("Open {{slug}}", "{{workspaceUrl}}", ACCENT)) +
        paragraph(
          `<span style="font-size:12px;color:#64748B;">Sent by the TimeSphere platform rather than from your own workspace — your workspace may be unreachable during the window.</span>`
        )
    )
  },
  {
    key: "maintenance.cleared",
    group: "Operator",
    description: "Sent when a platform-wide maintenance window is lifted — the all-clear.",
    variables: ["workspace", "slug", "workspaceUrl", "note", "appUrl"],
    sample: { workspace: "Acme Corp", slug: "acme", workspaceUrl: "https://acme.timesphere.app", note: "", appUrl: "https://timesphere.app" },
    subject: "{{workspace}} is back — maintenance is finished",
    html: shell(
      { title: "Maintenance finished", preheader: "Your workspace is open again." },
      heading("{{workspace}} is back") +
        paragraph("The maintenance window has been lifted and your workspace is open to everyone again. No action is needed.") +
        paragraph("{{note}}") +
        paragraph(button("Open {{slug}}", "{{workspaceUrl}}"))
    )
  },
  {
    key: "backup.alert",
    group: "Operator",
    description: "Sent when a managed backup succeeds or fails, to the addresses on that workspace's backup policy.",
    variables: ["workspace", "slug", "outcome", "destination", "detail", "appUrl"],
    sample: { workspace: "Acme Corp", slug: "acme", outcome: "FAILED", destination: "Primary S3 bucket", detail: "AccessDenied: the key is not permitted to PutObject on acme-timesphere-backups", appUrl: "https://timesphere.app" },
    subject: "Backup {{outcome}} — {{workspace}}",
    html: shell(
      { title: "Backup {{outcome}}", preheader: "{{workspace}} — {{destination}}", accentColor: ACCENT },
      heading("Backup {{outcome}} for {{workspace}}") +
        paragraph("Workspace <strong>{{workspace}}</strong> (<code>{{slug}}</code>), destination <strong>{{destination}}</strong>.") +
        paragraph("{{detail}}") +
        paragraph("<span style=\"font-size:12px;color:#64748B;\">Sent by the platform rather than by the workspace — the workspace's own mail server may be the thing that is not working.</span>")
    )
  },
  {
    key: "platform.alert_digest",
    group: "Operator",
    description:
      "The fleet alert digest (5.0.0). Sent only when something has CHANGED — a new alert, one that escalated, or one that cleared. A standing alert is never re-sent, which is what stops this becoming a message people filter.",
    variables: [
      "criticalCount",
      "warningCount",
      "newCount",
      "escalatedCount",
      "clearedCount",
      "newAlerts",
      "escalatedAlerts",
      "clearedAlerts",
      "consoleUrl",
      "appUrl"
    ],
    sample: {
      criticalCount: "2",
      warningCount: "5",
      newCount: "1",
      escalatedCount: "1",
      clearedCount: "2",
      newAlerts: "[CRITICAL] Acme Corp (acme) — Auto-increment 94% consumed. TimeEntry — against a signed INT key. Threshold: 70%.",
      escalatedAlerts: "[WARNING → CRITICAL] Northwind (northwind) — Database connections at 91%. 182 of 200 on db-2.internal. Threshold: 80%.",
      clearedAlerts: "2 service down — Email delivery, AI features",
      consoleUrl: "https://timesphere.app/platform-admin/alerts",
      appUrl: "https://timesphere.app"
    },
    subject: "Fleet alerts: {{newCount}} new, {{escalatedCount}} escalated, {{clearedCount}} cleared",
    html: shell(
      { title: "Fleet alerts", preheader: "{{criticalCount}} critical, {{warningCount}} warning across the fleet.", accentColor: ACCENT },
      heading("What changed on the fleet") +
        paragraph(
          "This message is sent only when something has <strong>changed</strong>. A standing alert is recorded and not repeated, so an email arriving here always means there is something new to look at."
        ) +
        paragraph(
          `Across the whole fleet right now: <strong>{{criticalCount}} critical</strong> and <strong>{{warningCount}} warning</strong>.`
        ) +
        paragraph(`<strong>New ({{newCount}})</strong>`) +
        /* `<pre>` and not `<p>`, because every value is HTML-ESCAPED at substitution — see
           platform-mail.service.ts#applyPlatformVars — so a `<br>` built into the variable would
           arrive as visible angle brackets. Preserving the newlines the sender already put there is
           the only way a multi-line list survives that escaping intact. */
        alertBlock("{{newAlerts}}") +
        paragraph(`<strong>Escalated ({{escalatedCount}})</strong>`) +
        alertBlock("{{escalatedAlerts}}") +
        paragraph(`<strong>Cleared ({{clearedCount}})</strong>`) +
        alertBlock("{{clearedAlerts}}") +
        paragraph(button("Open the console", "{{consoleUrl}}", ACCENT)) +
        paragraph(
          `<span style="font-size:12px;color:#64748B;">Sent by the platform rather than by any workspace — the workspace whose alert this is may be the thing that is not working. Change what reaches you, or add a Slack or PagerDuty webhook, on the console's Alerts page.</span>`
        )
    )
  },
  {
    key: "platform.smtp_test",
    group: "Operator",
    description: "What the “Send test” button on Platform mail settings sends. Proves the relay, the From address and the reply-to.",
    variables: ["sentAt", "host", "appUrl"],
    sample: { sentAt: "28 Aug 2026, 09:30", host: "smtp.example.com", appUrl: "https://timesphere.app" },
    subject: "TimeSphere platform mail is working",
    html: shell(
      { title: "Platform mail test", preheader: "If you can read this, the relay works." },
      heading("Platform mail is working") +
        paragraph("This message was sent at <strong>{{sentAt}}</strong> through <strong>{{host}}</strong> from the TimeSphere platform-admin console. Reply to it to confirm the reply-to address routes somewhere a person reads.")
    )
  }
];

export const PLATFORM_TEMPLATE_KEYS = PLATFORM_TEMPLATES.map((t) => t.key);

export function platformTemplateDef(key: string): PlatformTemplateDef | null {
  return PLATFORM_TEMPLATES.find((t) => t.key === key) ?? null;
}

/** The retention day markers, and the template each one sends. `feedback10` is measured from the
 *  trial START; every other marker from the trial END. The order is the order they are due. */
export const RETENTION_MARKER_TEMPLATE: Record<string, string> = {
  feedback10: "retention.feedback10",
  ended: "retention.trial_ended",
  "30": "retention.day30",
  "60": "retention.day60",
  "80": "retention.day80",
  "90": "retention.day90"
};
