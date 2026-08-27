/**
 * The one email in the product that is sent by the DEPLOYMENT rather than by a workspace.
 *
 * WHY IT HAS TO EXIST. Every other outbound mail goes through `mail.service.ts`, which resolves a
 * transport per tenant and writes an `EmailLog` row through the tenant-scoped Prisma proxy — both
 * of which require a tenant context. Signup verification runs BEFORE the workspace exists; that is
 * the entire point of it. Calling the normal path there throws "No tenant context is active", which
 * is exactly what the first version of the signup route did.
 *
 * WHAT IT GIVES UP, deliberately: no delivery analytics, no retry queue, no per-workspace SMTP
 * settings, no EmailLog row. All four are properties of a workspace, and there isn't one. A failure
 * here surfaces as the signup step failing, which is the correct place for it — the person is
 * looking at the screen.
 *
 * NOT A GENERAL-PURPOSE BACK DOOR. Anything that has a tenant must use `dispatchTransactional`
 * instead, so that it is logged, retried and configurable like every other mail this product sends.
 * The only legitimate callers are routes that run before a tenant exists.
 */
import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { AppError } from "../middleware/error.js";

export async function sendPlatformMail(args: { to: string; subject: string; html: string }): Promise<void> {
  if (!env.SMTP_HOST) {
    // A 503 rather than a silent success: a signup that says "check your email" when no mail can
    // be sent leaves somebody waiting for a code that will never arrive.
    throw new AppError(503, "This deployment can't send email yet, so signup isn't available. Contact the administrator.");
  }

  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    // BOUNDED, because a person is watching. This send happens INSIDE the signup request, so
    // nodemailer's defaults (a two-minute socket timeout) mean a typo'd domain leaves the button
    // reading "Sending…" for two minutes before anything happens. Ten seconds is longer than any
    // healthy relay needs and short enough that a failure still reads as a failure.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000
  });

  try {
    await transporter.sendMail({ from: env.MAIL_FROM, to: args.to, subject: args.subject, html: args.html });
  } finally {
    // Not pooled, unlike the tenant transports: this sends at most a handful of messages an hour
    // (the signup limiter sees to that), so a held-open pool would be a connection sitting idle
    // for the sake of a message that is not coming.
    transporter.close();
  }
}
