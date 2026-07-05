/**
 * WHAT: builds and configures the Express `app` — security middleware stack (helmet, CORS
 * allow-list, rate limiting, cookies, compression, static uploads), then mounts every
 * controller router in a specific, load-bearing order.
 * WHY the order matters: three groups of routes (`/api/chat/*` webhooks, `/api/auth/sso/*`,
 * `/api/platform-admin/*`) are mounted BEFORE the blanket `app.use("/api", resolveTenant)` —
 * each has its own reason (see the inline comment above each mount point), but the common
 * thread is that none of them can rely on the normal Host-header subdomain tenant resolution
 * every other route depends on. Getting this order wrong either breaks tenant isolation or
 * silently swallows a route (see `controllers/sso.controller.ts`'s header comment for a past
 * real bug of exactly this kind).
 * HOW: see docs/ARCHITECTURE.md §5 for the full table of specially-mounted routes and why each
 * one is special.
 * WHO calls this: `server.ts` (`app.listen(...)`), and the Playwright suite's `webServer` config.
 */
import path from "node:path";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { aiRouter } from "./controllers/ai.controller.js";
import { auditRouter } from "./controllers/audit.controller.js";
import { authRouter } from "./controllers/auth.controller.js";
import { chatIntegrationsRouter } from "./controllers/chat-integrations.controller.js";
import { chatWebhookRouter } from "./controllers/chat-webhook.controller.js";
import { emailIntakeRouter } from "./controllers/email-intake.controller.js";
import { emailTemplatesRouter } from "./controllers/email-templates.controller.js";
import { labelRouter } from "./controllers/label.controller.js";
import { notificationRouter } from "./controllers/notification.controller.js";
import { platformAdminRouter } from "./controllers/platform-admin.controller.js";
import { projectRouter } from "./controllers/project.controller.js";
import { reportRouter } from "./controllers/report.controller.js";
import { settingsRouter } from "./controllers/settings.controller.js";
import { ssoRouter } from "./controllers/sso.controller.js";
import { teamRouter } from "./controllers/team.controller.js";
import { ticketRouter } from "./controllers/ticket.controller.js";
import { ticketTypeRouter } from "./controllers/ticket-type.controller.js";
import { timesheetRouter } from "./controllers/timesheet.controller.js";
import { userRouter } from "./controllers/user.controller.js";
import { AppError, errorHandler, notFound } from "./middleware/error.js";
import { resolveTenant } from "./middleware/tenant.js";

export const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

/**
 * CORS allow-list.
 *
 * `WEB_ORIGIN` may be a comma-separated list (e.g. `http://localhost:5173,http://192.168.1.10:5173`).
 * In development we also accept any private LAN IP so testing from a phone / second machine
 * on the same Wi-Fi doesn't require constantly editing .env.
 *
 * In production set `NODE_ENV=production` and pin `WEB_ORIGIN` to your real domain(s) only.
 */
const allowedOrigins = env.WEB_ORIGIN.split(",").map((value) => value.trim()).filter(Boolean);

const PRIVATE_LAN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/i;

const isDev = env.NODE_ENV !== "production";

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header (curl, server-to-server, same-origin POSTs without fetch)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (isDev && PRIVATE_LAN_RE.test(origin)) return callback(null, true);
      // A plain Error here falls through errorHandler.ts's generic 500 branch (logged as a
      // server error) even though this is an expected, correctly-enforced rejection, not a
      // bug — AppError gives disallowed-origin attempts their own clean 403 instead of noise
      // in the error log that could mask real 500s.
      callback(new AppError(403, `Origin ${origin} not allowed by CORS`));
    },
    credentials: true
  })
);

// Inbound chat webhook receivers (Slack/Teams/Google Chat) mounted BEFORE express.json()
// below — Slack's Events API posts as application/json, and Express body parsers only read
// the request stream once, so if the global json() parser ran first it would already have
// consumed the body before this router's own express.raw() (needed to verify Slack's HMAC
// signature against the exact raw bytes) ever saw it. Also mounted before tenant resolution
// for the same reason SSO/platform-admin are below: these routes resolve their own org from
// the URL path, not a subdomain — see controllers/chat-webhook.controller.ts's header comment.
app.use("/api/chat", chatWebhookRouter);

// Lower-rate limiter for auth endpoints (login bruteforce defence).
const authLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true });
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);
app.use("/api/auth/reset-password", authLimiter);

// 120/min (2 req/s) proved too tight for real usage: a single page load fans out several
// React Query fetches (projects, tickets, labels, notifications, ...), so a normal admin
// with a few tabs open — or this app's own Playwright suite — can trip it on legitimate
// traffic. 300/min keeps abuse protection without false-positiving on real sessions.
app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true }));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
// Avatars are re-encoded through sharp on upload (see middleware/upload.ts) and are always
// real images, so they stay inline-renderable for <img> tags. Registered before the general
// /uploads handler below so this more specific prefix wins.
app.use("/uploads/avatars", express.static(path.join(env.UPLOAD_DIR, "avatars"), { maxAge: "1d", etag: true }));

// Ticket/timesheet attachments are user-uploaded and, even after the extension allow-list in
// upload.ts, are forced to download (Content-Disposition: attachment) rather than render
// inline — defense-in-depth so an allowed-but-unexpected file type can never execute as a
// script in the API's origin just by someone opening its /uploads URL directly in a browser.
app.use(
  "/uploads",
  express.static(env.UPLOAD_DIR, {
    maxAge: "1d",
    etag: true,
    setHeaders: (res) => {
      res.setHeader("Content-Disposition", "attachment");
      res.setHeader("X-Content-Type-Options", "nosniff");
    }
  })
);
app.use(morgan("tiny"));

app.get("/health", (_req, res) => res.json({ ok: true }));

// SSO start/callback deliberately mounted BEFORE the blanket tenant-resolution middleware —
// see controllers/sso.controller.ts's header comment for why these two routes resolve their
// own org (from the Host header for /start, from the signed `state` param for /callback)
// instead of going through the normal subdomain-based middleware below.
app.use("/api/auth/sso", ssoRouter);

// Platform-admin console routes — also cross-tenant by nature (org CRUD, plan tiers,
// cross-org analytics), so mounted before tenant resolution for the same reason as SSO above.
// Its own auth entirely (middleware/platform-admin-auth.ts), never the tenant requireAuth.
app.use("/api/platform-admin", platformAdminRouter);

// Every other /api/* route needs to know which tenant it's serving before it can touch
// `prisma` — mounted after /health, /uploads, and the SSO routes (none of which need the
// normal resolved-tenant path) and before every controller router below (all of which do).
app.use("/api", resolveTenant);

app.use("/api/auth", authRouter);
app.use("/api/users", userRouter);
app.use("/api/projects", projectRouter);
app.use("/api/timesheets", timesheetRouter);
app.use("/api/tickets", ticketRouter);
app.use("/api/ticket-types", ticketTypeRouter);
app.use("/api/ai", aiRouter);
app.use("/api/email-intake", emailIntakeRouter);
app.use("/api/chat-integrations", chatIntegrationsRouter);
app.use("/api/labels", labelRouter);
app.use("/api/reports", reportRouter);
app.use("/api/notifications", notificationRouter);
app.use("/api/audit", auditRouter);
app.use("/api/team", teamRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/email-templates", emailTemplatesRouter);

app.use(notFound);
app.use(errorHandler);
