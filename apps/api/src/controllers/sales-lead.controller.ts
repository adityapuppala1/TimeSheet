/**
 * The public contact form's endpoint — the one route in the product an anonymous stranger can use
 * to start a conversation with a human.
 *
 * WHY ITS OWN ROUTER AND ITS OWN MOUNT, rather than another path on `platformPublicRouter`. That
 * router is documented as "the two doors a retention email opens": every route on it is addressed
 * by a signed token, which IS the credential, and its 30-per-minute limiter is sized for somebody
 * clicking a link they were sent. This has no token, no prior relationship, and a completely
 * different budget — five an hour, in the spirit of `/api/signup`'s limiter. Sharing a mount would
 * mean the two limiters could only ever be widened together, and the next person to relax the
 * retention doors would silently relax the open write endpoint too. Mounted next to signup, before
 * `resolveTenant`, for the same reason signup is: there is no tenant, and there never will be one
 * for most of these rows.
 *
 * SECURITY POSTURE:
 * - No auth, by design. A signed-in user may legitimately want to talk to sales, and requiring a
 *   session would exclude exactly the people this form exists for.
 * - Rate-limited at the mount (app.ts), because this is an unauthenticated route that writes rows
 *   and sends two emails.
 * - `.strict()` schema with hard length caps on every field, so the row cannot be used as storage
 *   and the notification email cannot be used as a delivery vehicle for a wall of text.
 * - Every value is HTML-escaped where it is rendered (platform-mail.service.ts#applyPlatformVars)
 *   and shown as plain text in the console. A stranger's words are never markup here.
 * - NO THIRD-PARTY CAPTCHA. The landing page's own FAQ promises that nothing calls home; embedding
 *   a captcha would make that sentence false on the page that says it. The three controls below
 *   cost a bot more than they cost a person, and none of them contacts anybody.
 *
 * THE TWO KINDS OF REJECTION, and the distinction is deliberate:
 *  - A HUMAN-FIXABLE PROBLEM (a missing field, a malformed address) is a 422 with a message that
 *    says what to fix. Hiding it behind a fake success would leave a real customer believing they
 *    had sent something they had not, which is a far worse outcome than a spammer learning that
 *    this endpoint validates its input — which they could learn from any field anyway.
 *  - A BOT SIGNAL (the honeypot filled, or a submission faster than a person can type) is answered
 *    with the ordinary success response and nothing is written. A bot that is told it was refused
 *    tunes and returns; one that is told it succeeded has no reason to. There is nothing here for a
 *    person to fix, so there is nothing to tell them.
 */
import { Router } from "express";
import { z } from "zod";
import { DEPLOYMENT_INTERESTS, SALES_INTERESTS, SALES_TIMELINES, TEAM_SIZE_BANDS } from "@timesheet/shared";
import { validate } from "../middleware/validate.js";
import { createSalesLead, SALES_RESPONSE_WINDOW } from "../services/sales-lead.service.js";

export const salesLeadRouter = Router();

/**
 * The floor on how fast a person can fill this form in.
 *
 * Four seconds is far below a real submission (nine fields, three of them selects, one a message)
 * and far above a script's, which posts in one round trip. It is a speed bump, not a boundary — the
 * limiter and the schema are what actually bound the damage — so it is set where it cannot plausibly
 * catch a human rather than where it catches the most bots.
 */
const MIN_FILL_MS = 4_000;

/**
 * WHY A DURATION AND NOT A TIMESTAMP. The obvious design is "the client sends when the form was
 * rendered and the server subtracts". That makes the check depend on the visitor's system clock
 * agreeing with ours, and a laptop five minutes fast would be refused for filling the form in
 * negative time. The client measures the interval against its own monotonic clock instead
 * (`performance.now()`, which no clock change moves) and sends the elapsed milliseconds. A bot can
 * lie about either form equally, so nothing is given up — and no real person is caught by a clock.
 */
const contactSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2, "Tell us your name").max(120),
      email: z.string().trim().email("Enter a valid email address").max(255),
      company: z.string().trim().min(2, "Tell us where you work").max(200),
      role: z.string().trim().max(120).optional(),
      country: z.string().trim().max(120).optional(),
      phone: z.string().trim().max(40).optional(),
      teamSize: z.enum(TEAM_SIZE_BANDS),
      deploymentInterest: z.enum(DEPLOYMENT_INTERESTS),
      timeline: z.enum(SALES_TIMELINES),
      interests: z.array(z.enum(SALES_INTERESTS)).max(SALES_INTERESTS.length).optional(),
      message: z.string().trim().min(10, "A sentence or two about what you need").max(4000),

      // Captured context. Optional throughout: an ad blocker, a privacy setting or a direct visit
      // all legitimately produce nothing here, and none of that is a reason to refuse a lead.
      sourcePage: z.string().trim().max(255).optional(),
      referrer: z.string().trim().max(500).optional(),
      utmSource: z.string().trim().max(120).optional(),
      utmMedium: z.string().trim().max(120).optional(),
      utmCampaign: z.string().trim().max(120).optional(),

      // The honeypot. Named for something an autofilling bot wants to complete and hidden from
      // people (and from screen readers) on the page. A person cannot fill it in; anything that
      // does is not one.
      website: z.string().max(200).optional(),
      /** Milliseconds between the form rendering and this submission, measured on the client. */
      elapsedMs: z.number().int().nonnegative().optional()
    })
    .strict()
});

salesLeadRouter.post("/", validate(contactSchema), async (req, res) => {
  const body = req.body as z.infer<typeof contactSchema>["body"];

  // Both silent drops, answered exactly like a success. A missing `elapsedMs` counts as too fast:
  // the real form always sends one, so its absence means something else posted this.
  const looksAutomated = Boolean(body.website?.trim()) || (body.elapsedMs ?? 0) < MIN_FILL_MS;
  if (looksAutomated) {
    res.status(201).json({ received: true, responseWindow: SALES_RESPONSE_WINDOW });
    return;
  }

  // Named field by field rather than spread-minus-the-two-anti-spam-fields. Both are only ever
  // evidence about the SENDER, never about the enquiry, so neither belongs on the row — and an
  // allowlist keeps it that way when somebody adds a third control to the schema above.
  await createSalesLead({
    name: body.name,
    email: body.email,
    company: body.company,
    role: body.role,
    country: body.country,
    phone: body.phone,
    teamSize: body.teamSize,
    deploymentInterest: body.deploymentInterest,
    timeline: body.timeline,
    interests: body.interests ?? [],
    message: body.message,
    sourcePage: body.sourcePage,
    referrer: body.referrer,
    utmSource: body.utmSource,
    utmMedium: body.utmMedium,
    utmCampaign: body.utmCampaign
  });

  // The id is NOT returned. It is of no use to the sender, and the one caller that would find it
  // useful is the one being told nothing on purpose two branches above.
  res.status(201).json({ received: true, responseWindow: SALES_RESPONSE_WINDOW });
});
