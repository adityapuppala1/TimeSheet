/**
 * WHAT: every email the PLATFORM sends — as opposed to a workspace — with its variables, a sample
 * value for each, and the shipped default body. The trial retention programme lives here
 * (`retention.*`), plus the signup code and the "is mail working" test.
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
  group: "Trial retention" | "Signup" | "Operator";
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

/** The small print every retention email ends with — the policy, in one sentence, every time. */
const policyLine = () =>
  paragraph(
    `<span style="font-size:12px;color:#64748B;">As a policy, a workspace whose trial ended is kept for {{retentionDays}} days and then deleted permanently unless it moves to a paid Team or Enterprise plan. Yours is scheduled for <strong>{{deleteDate}}</strong>.</span>`
  );

const feedbackLine = () =>
  paragraph(
    `Could you spare two minutes to tell us what worked and what did not? <a href="{{feedbackUrl}}" style="color:${ACCENT};font-weight:600;">Share your feedback</a> — it goes straight to the people building TimeSphere.`
  );

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
