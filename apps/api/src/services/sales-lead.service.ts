/**
 * WHAT: what happens to a sales enquiry after the public contact form has been validated — the row,
 * the audit entry, and the two emails (one to us, one back to the person).
 *
 * WHY IT IS A SERVICE AND NOT THE CONTROLLER. The controller's job is the shape of the request:
 * the schema, the honeypot, the time floor, the limiter. This file's job is what a lead IS. Keeping
 * them apart is also what makes the anti-spam controls testable — a test drives the real router
 * through supertest and asserts that `createSalesLead` was never reached, which is a stronger claim
 * than "the handler returned 201".
 *
 * TWO THINGS HERE ARE DELIBERATE AND EASY TO GET WRONG LATER:
 *
 *  1. A FREE-MAIL ADDRESS IS FLAGGED, NEVER REFUSED. `signup.controller.ts` refuses one, and the
 *     temptation is to reuse that rule here because the code is already written. It is the wrong
 *     rule for this surface: signup provisions a database, so "one trial per address anybody can
 *     make in ten seconds" is a real cost; a contact form provisions nothing, and a founder
 *     evaluating the product from a personal address is one of the better leads this form will
 *     ever take. (This deployment's own sales inbox is a Gmail address — refusing Gmail here would
 *     mean refusing to talk to people at the address we ask them to write to.) The list itself is
 *     shared, from utils/free-mail-domains.ts, so the two surfaces cannot drift apart on WHICH
 *     domains they mean while continuing to disagree about what to do about them.
 *
 *  2. MAIL FAILURE NEVER FAILS THE REQUEST. The row is the product of this endpoint; the emails are
 *     a convenience over the top of it. A relay outage that turned a captured lead into a 502 and a
 *     "something went wrong" page would lose the customer to protect nothing — the lead is already
 *     safe in the console. Every send is awaited (so the log row is written and an operator can see
 *     the failure) and every outcome is reported back to the caller, never thrown.
 */
import { DEPLOYMENT_LABEL, INTEREST_LABEL, salesLabel, TEAM_SIZE_LABEL, TIMELINE_LABEL } from "@timesheet/shared";
import { controlPrisma } from "../config/control-prisma.js";
import { env } from "../config/env.js";
import { isFreeMailAddress } from "../utils/free-mail-domains.js";
import { platformAudit } from "./platform-audit.service.js";
import { sendPlatformTemplate } from "./platform-mail.service.js";

/**
 * Where enquiries go when the deployment has not said otherwise.
 *
 * A DEFAULT, NOT A HARDCODED RECIPIENT. `PlatformMailSettings.salesInboxAddress` overrides it, so
 * an operator can move the inbox from the console without a redeploy — but a fresh install still
 * has a working contact form on the first day, which a null-with-no-default would not.
 */
export const DEFAULT_SALES_INBOX = "adhirocks2@gmail.com";

/** What the acknowledgement promises. Stated once, so the email and the page cannot disagree. */
export const SALES_RESPONSE_WINDOW = "one working day";

/* The vocabulary — team-size bands, deployment interest, timeline, interests and the pipeline
 * statuses — lives in `@timesheet/shared`, because the form that offers it, the schema that
 * validates it and the console that displays it are three different surfaces and a copied list is
 * how the three stop agreeing. Re-exported here only where a caller in this app already imports
 * from the service; nothing is redefined. */
export { SALES_LEAD_STATUSES, type SalesLeadStatus } from "@timesheet/shared";

/* ------------------------------------------------------------------ *
 * Recipient resolution
 * ------------------------------------------------------------------ */

/**
 * The configured sales inbox, else the shipped default. Never throws: a control-plane read that
 * fails must not be the reason a lead notification is not attempted, because the fallback is a
 * perfectly good address.
 */
export async function resolveSalesInbox(): Promise<string> {
  const row = await controlPrisma.platformMailSettings.findUnique({ where: { id: "global" } }).catch(() => null);
  return row?.salesInboxAddress?.trim() || DEFAULT_SALES_INBOX;
}

/* ------------------------------------------------------------------ *
 * Writing one
 * ------------------------------------------------------------------ */

export interface SalesLeadInput {
  name: string;
  email: string;
  company: string;
  role?: string;
  country?: string;
  phone?: string;
  teamSize: string;
  deploymentInterest: string;
  timeline: string;
  interests: string[];
  message: string;
  sourcePage?: string;
  referrer?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
}

export interface SalesLeadResult {
  id: string;
  /** Whether each email went. Reported, never thrown — see the file header. */
  notified: boolean;
  acknowledged: boolean;
}

/** The three UTM fields as one readable line, or a dash. See `SALES_LEAD_VARS`. */
function campaignLine(input: SalesLeadInput): string {
  const parts = [input.utmSource, input.utmMedium, input.utmCampaign].map((p) => p?.trim()).filter(Boolean);
  return parts.length ? parts.join(" / ") : "—";
}

export async function createSalesLead(input: SalesLeadInput): Promise<SalesLeadResult> {
  const email = input.email.trim().toLowerCase();
  const isFreeMailDomain = isFreeMailAddress(email);

  const lead = await controlPrisma.salesLead.create({
    data: {
      name: input.name.trim(),
      email,
      company: input.company.trim(),
      role: input.role?.trim() || null,
      country: input.country?.trim() || null,
      phone: input.phone?.trim() || null,
      teamSize: input.teamSize,
      deploymentInterest: input.deploymentInterest,
      timeline: input.timeline,
      interests: input.interests,
      message: input.message.trim(),
      isFreeMailDomain,
      sourcePage: input.sourcePage?.trim() || null,
      referrer: input.referrer?.trim() || null,
      utmSource: input.utmSource?.trim() || null,
      utmMedium: input.utmMedium?.trim() || null,
      utmCampaign: input.utmCampaign?.trim() || null
    },
    select: { id: true }
  });

  // "CUSTOMER", because that is who acted — the same actor type the retention feedback form uses.
  // The metadata is the qualification, never the message: an audit trail is read by people who are
  // not the sales team, and the words a stranger wrote to us belong in the one row that owns them.
  await platformAudit("CUSTOMER", email, "sales_lead.created", "SalesLead", lead.id, {
    company: input.company.trim(),
    teamSize: input.teamSize,
    deploymentInterest: input.deploymentInterest,
    timeline: input.timeline,
    interests: input.interests,
    isFreeMailDomain,
    sourcePage: input.sourcePage ?? null
  });

  const base = env.APP_BASE_URL.replace(/\/$/, "");
  const to = await resolveSalesInbox();

  const notification = await sendPlatformTemplate("sales.lead", {
    to,
    // THE POINT OF THE WHOLE FEATURE: the notification is addressed to us, so Reply must answer the
    // customer rather than ourselves. Without this the sales inbox replies to the sales inbox.
    replyTo: email,
    vars: {
      name: input.name.trim(),
      email,
      company: input.company.trim(),
      role: input.role?.trim() || "—",
      country: input.country?.trim() || "—",
      phone: input.phone?.trim() || "—",
      teamSize: salesLabel(TEAM_SIZE_LABEL, input.teamSize),
      deployment: salesLabel(DEPLOYMENT_LABEL, input.deploymentInterest),
      timeline: salesLabel(TIMELINE_LABEL, input.timeline),
      interests: input.interests.map((i) => salesLabel(INTEREST_LABEL, i)).join(", ") || "—",
      message: input.message.trim(),
      sourcePage: input.sourcePage?.trim() || "—",
      referrer: input.referrer?.trim() || "—",
      campaign: campaignLine(input),
      // A sentence, not a flag — see SALES_LEAD_VARS. It says what the address is and, explicitly,
      // that it changed nothing, so nobody reading the email infers a judgement that was not made.
      freeMailNote: isFreeMailDomain ? "Personal email domain — accepted and worth answering all the same." : "",
      consoleUrl: `${base}/platform-admin/sales-leads`
    },
    metadata: { salesLeadId: lead.id, isFreeMailDomain }
  }).catch(() => ({ ok: false }));

  const acknowledgement = await sendPlatformTemplate("sales.ack", {
    to: email,
    vars: {
      // First name only: the acknowledgement is a short human note, and "Thanks, Priya Raman" is
      // not how a person writes one.
      name: input.name.trim().split(/\s+/)[0] || input.name.trim(),
      company: input.company.trim(),
      responseWindow: SALES_RESPONSE_WINDOW,
      trialUrl: `${base}/signup`,
      // The public FAQ, which is the only documentation a prospect can read without an account —
      // the in-app Help manual is behind a workspace they do not have yet.
      faqUrl: `${base}/#faq`
    },
    metadata: { salesLeadId: lead.id }
  }).catch(() => ({ ok: false }));

  return { id: lead.id, notified: notification.ok, acknowledged: acknowledgement.ok };
}
