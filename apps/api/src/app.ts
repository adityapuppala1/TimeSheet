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
import zlib from "node:zlib";
import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { appVersion } from "./config/version.js";
import { resolveStoredFile } from "./services/attachment-storage.service.js";
import { getUpdateStatus } from "./services/update-check.service.js";
import { aiRouter } from "./controllers/ai.controller.js";
import { auditRouter } from "./controllers/audit.controller.js";
import { authRouter } from "./controllers/auth.controller.js";
import { billingRouter, billingWebhookRouter } from "./controllers/billing.controller.js";
import { chatIntegrationsRouter } from "./controllers/chat-integrations.controller.js";
import { chatWebhookRouter } from "./controllers/chat-webhook.controller.js";
import { devopsWebhookRouter } from "./controllers/devops-webhook.controller.js";
import { gitConnectionRouter } from "./controllers/git-connection.controller.js";
import { gitWebhookRouter } from "./controllers/git-webhook.controller.js";
import { publicApiRouter } from "./controllers/public-api.controller.js";
import { scimRouter } from "./controllers/scim.controller.js";
import { emailIntakeRouter } from "./controllers/email-intake.controller.js";
import { faceRouter } from "./controllers/face.controller.js";
import { emailTemplatesRouter } from "./controllers/email-templates.controller.js";
import { labelRouter } from "./controllers/label.controller.js";
import { notificationRouter } from "./controllers/notification.controller.js";
import { planRouter } from "./controllers/plan.controller.js";
import { planningRouter } from "./controllers/planning.controller.js";
import { platformAdminRouter } from "./controllers/platform-admin.controller.js";
import { aiProposalRouter } from "./controllers/ai-proposal.controller.js";
import { approvalPublicRouter, approvalRouter } from "./controllers/approval.controller.js";
import { blueprintRouter } from "./controllers/blueprint.controller.js";
import { dashboardRouter } from "./controllers/dashboard.controller.js";
import { portfolioRouter } from "./controllers/portfolio.controller.js";
import { proofRouter } from "./controllers/proof.controller.js";
import { requestFormPublicRouter } from "./controllers/request-form-public.controller.js";
import { requestFormRouter } from "./controllers/request-form.controller.js";
import { resourceRouter } from "./controllers/resource.controller.js";
import { projectRouter } from "./controllers/project.controller.js";
import { reportRouter } from "./controllers/report.controller.js";
import { attestationRouter } from "./controllers/attestation.controller.js";
import { attestationPublicRouter } from "./controllers/attestation-public.controller.js";
import { settingsRouter } from "./controllers/settings.controller.js";
import { maintenanceRouter } from "./controllers/maintenance.controller.js";
import { ssoRouter } from "./controllers/sso.controller.js";
import { teamRouter } from "./controllers/team.controller.js";
import { ticketRouter } from "./controllers/ticket.controller.js";
import { ticketTypeRouter } from "./controllers/ticket-type.controller.js";
import { timesheetRouter } from "./controllers/timesheet.controller.js";
import { userRouter } from "./controllers/user.controller.js";
import { AppError, errorHandler, notFound } from "./middleware/error.js";
import { recordApiRequest } from "./middleware/request-telemetry.js";
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
// These handlers always respond directly (never call next()), so they never reach the
// blanket 300/min limiter mounted below — without this, they'd be the only routes in the
// app with no rate limit at all, despite doing a DB lookup + secret decryption per request.
// Per-IP (not per-org: :orgSlug is a route param inside chatWebhookRouter, not yet parsed at
// this mount point) — 120/min is generous enough for legitimate high-frequency bot traffic
// from a single chat platform's egress IPs while still bounding abuse.
const chatWebhookLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true });
app.use("/api/chat", chatWebhookLimiter, chatWebhookRouter);

// GitHub repo push/PR webhooks — also needs express.raw() (see git-webhook.controller.ts's own
// route-level middleware) so it must be mounted before the global express.json() below, same
// reasoning as chatWebhookRouter immediately above.
const gitWebhookLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true });
app.use("/api/git", gitWebhookLimiter, gitWebhookRouter);

// Stripe webhook — same "signature computed over raw bytes, must precede express.json()"
// reasoning as gitWebhookRouter above. Control-plane only (Organization.planTier), never
// touches a tenant database, so it needs no tenant resolution at all.
const billingWebhookLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true });
app.use("/api/billing", billingWebhookLimiter, billingWebhookRouter);

/**
 * Login brute-force defence. `skipSuccessfulRequests` is the load-bearing option: only FAILED
 * attempts count toward the 20/min budget, which is precisely the brute-force surface — a
 * password guesser only ever produces failures, so its budget is unchanged, while people who
 * type their password correctly are never punished.
 *
 * WHY it matters beyond tidiness: this limiter is per IP, and an office behind one NAT is a
 * single IP. Counting successes meant ~20 colleagues signing in at 9am could lock out the 21st
 * — and it silently broke this app's own Playwright suite, which logs in per test across five
 * viewport projects (~75 successful logins). Late-suite specs then 429'd on login and failed as
 * "element not visible", which is exactly the long-standing "hamburger drawer flake" that
 * passed in isolation and failed under full-suite load. The real anti-brute-force control is
 * the per-ACCOUNT lockout in auth.service.ts (5 failures → 5-minute lock); this is the coarse
 * per-IP backstop under it.
 */
const authLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, skipSuccessfulRequests: true });
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);
app.use("/api/auth/reset-password", authLimiter);
// Platform-admin login is the single highest-privilege account type in the system (cross-org
// CRUD, plan-tier edits) — it must never be less protected than a regular tenant login, but
// it's mounted after the blanket limiter below so it needs its own explicit guard here too.
app.use("/api/platform-admin/auth/login", authLimiter);

// This ceiling has been raised twice on EVIDENCE, so mind the reasoning before lowering it:
// 120/min (2 req/s) tripped on a single admin's tabs; 300/min still tripped on legitimate
// traffic because the limit is PER IP, not per user — one office NAT is one IP, a single page
// load fans out ~10 React Query fetches, and the dashboard re-polls summaries every 30s. The
// observable failure mode is nasty: random requests 429 mid-session and features appear to
// "randomly break" (this app's own full Playwright suite reproduced it — late-suite specs got
// 429s on ticket fetches and looked like flaky UI bugs). 900/min ≈ 15 req/s per IP still
// bounds abuse hard, while the strict limiters below (auth 20/min, face 60/min, webhooks)
// keep guarding the actually-sensitive/expensive paths.
app.use(rateLimit({ windowMs: 60_000, limit: 900, standardHeaders: true }));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
// Avatars are re-encoded through sharp on upload (see middleware/upload.ts) and are always
// real images, so they stay inline-renderable for <img> tags. Registered before the general
// /uploads handler below so this more specific prefix wins.
app.use("/uploads/avatars", express.static(path.join(env.UPLOAD_DIR, "avatars"), { maxAge: "1d", etag: true }));

// Transparent decompression for attachments stored gzipped by
// services/attachment-storage.service.ts. Runs BEFORE the static handler and only claims a
// request when a `<name>.gz` twin exists, so every legacy file — everything uploaded before that
// pipeline — falls straight through to `express.static` and behaves exactly as it always has.
//
// Decompressed server-side rather than served with `Content-Encoding: gzip` because the
// `compression()` middleware above would otherwise have to be taught not to re-encode an
// already-encoded body, and getting that subtly wrong corrupts downloads. The CPU cost is
// negligible: only text and source files are ever gzipped.
app.use("/uploads", async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  try {
    const resolved = await resolveStoredFile(req.path.replace(/^\//, ""));
    if (!resolved?.gunzip || !resolved.stream) return next();

    res.setHeader("Content-Disposition", "attachment");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // No Content-Length: the decompressed size isn't known without reading the whole file, and a
    // wrong one truncates the download.
    resolved.stream.on("error", next).pipe(zlib.createGunzip()).on("error", next).pipe(res);
  } catch (error) {
    next(error);
  }
});

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

/**
 * Liveness probes. Both mounted here, BEFORE `app.use("/api", resolveTenant)` and before every
 * authed router, so they answer with no session, no tenant subdomain and no database round-trip —
 * a health check that needs the database can't tell you the process is up when the database is
 * the thing that's down.
 *
 * WHY two paths for one handler:
 *  - `/health` is the infra/k8s/load-balancer probe (unchanged, do not remove).
 *  - `/api/health` is for the BROWSER (see apps/web/src/hooks/use-backend-health.ts). The web app
 *    talks to the API on the relative `/api` prefix, and in dev the Vite proxy forwards ONLY
 *    `/api` and `/uploads` (apps/web/vite.config.ts). A browser probe to bare `/health` would be
 *    served by Vite itself and return 200 with the SPA's index.html — i.e. it would report
 *    "healthy" while the API was completely down, which is worse than having no check at all.
 */
// `version` rides on the health probe the web app ALREADY polls every 15 seconds
// (hooks/use-backend-health.ts): when the served version stops matching the version baked into
// the running bundle, the client knows the server was upgraded underneath it and can offer a
// refresh. Piggybacking costs zero additional requests, which is the whole reason it lives here
// rather than on its own polled endpoint.
const healthHandler = (_req: express.Request, res: express.Response) =>
  res.json({ ok: true, version: appVersion.version });
app.get("/health", healthHandler);
app.get("/api/health", healthHandler);

/**
 * Full identity — version, git SHA, build date. Public on purpose: it's on every /health response
 * anyway, the /app/whats-new page reads it before login state resolves, and update.sh curls it to
 * verify an upgrade actually landed. Nothing here is a secret; pretending otherwise would only
 * complicate three legitimate readers.
 */
app.get("/api/system/version", (_req, res) => res.json(appVersion));

/**
 * Update availability + release-note history for the What's-new page. Public like /version:
 * everything in the response is already public (this repo's GitHub releases) or already exposed
 * (the current version, on every /health). The URL it fetches is FIXED — no parameter reaches the
 * outbound request — and the hourly single-flight cache means hammering this endpoint cannot make
 * the server hammer GitHub. Never errors: disabled or offline degrades to "no information".
 */
app.get("/api/system/updates", async (_req, res) => res.json(await getUpdateStatus()));

// SSO start/callback deliberately mounted BEFORE the blanket tenant-resolution middleware —
// see controllers/sso.controller.ts's header comment for why these two routes resolve their
// own org (from the Host header for /start, from the signed `state` param for /callback)
// instead of going through the normal subdomain-based middleware below.
app.use("/api/auth/sso", ssoRouter);

// Platform-admin console routes — also cross-tenant by nature (org CRUD, plan tiers,
// cross-org analytics), so mounted before tenant resolution for the same reason as SSO above.
// Its own auth entirely (middleware/platform-admin-auth.ts), never the tenant requireAuth.
app.use("/api/platform-admin", platformAdminRouter);

// Ingest-only security/CI webhook receiver (SAST/DAST/SSAT/SSCT findings, test runs) — see
// controllers/devops-webhook.controller.ts's header comment. Same "external caller has no
// Host-header subdomain" reasoning as chatWebhookRouter above, and the same per-IP rate-limit
// rationale (a public POST endpoint doing DB writes needs a limiter even though it's mounted
// before the blanket one below).
const devopsWebhookLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true });
app.use("/api/devops", devopsWebhookLimiter, devopsWebhookRouter);

// Inbound SCIM 2.0 provisioning — see controllers/scim.controller.ts's header comment. Same
// "external caller (the IdP) has no Host-header subdomain" reasoning as the receivers above.
const scimLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true });
app.use("/api/scim", scimLimiter, scimRouter);

// GitHub OAuth callback — see controllers/git-connection.controller.ts's header comment for
// why this needs the same pre-tenant-resolution mounting as SSO above (one fixed callback URL,
// org identity carried in the signed `state` param instead of the Host header).
app.use("/api/git", gitConnectionRouter);

// Every other /api/* route needs to know which tenant it's serving before it can touch
// `prisma` — mounted after /health, /uploads, and the SSO routes (none of which need the
// normal resolved-tenant path) and before every controller router below (all of which do).
app.use("/api", resolveTenant);

// Request telemetry, mounted here for two reasons that both point at this exact line: the row it
// writes goes to the TENANT's database (so it must be after resolveTenant), and it has to wrap the
// whole of every handler below to time it (so it must be before all of them). Off by default and a
// single boolean check when off — see middleware/request-telemetry.ts's hot-path contract.
app.use("/api", recordApiRequest);

app.use("/api/auth", authRouter);
app.use("/api/billing", billingRouter);
app.use("/api/users", userRouter);
app.use("/api/projects", projectRouter);
app.use("/api/timesheets", timesheetRouter);
app.use("/api/tickets", ticketRouter);
app.use("/api/ticket-types", ticketTypeRouter);
app.use("/api/ai", aiRouter);
app.use("/api/email-intake", emailIntakeRouter);
app.use("/api/chat-integrations", chatIntegrationsRouter);
app.use("/api/labels", labelRouter);
// Planning layer (V6) — workspace planning toggles, plan-tier entitlements, custom workflows and
// custom fields. An ordinary per-tenant router: nothing here needs to precede tenant resolution.
app.use("/api/planning", planningRouter);
// The planning FEATURES, split from the planning CONFIGURATION above: /planning is what a
// super admin sets once, /plan and /portfolios are what everyone uses daily. Different
// permissions (plan:write vs SUPER_ADMIN), different read volumes, different gates.
app.use("/api/plan", planRouter);
app.use("/api/portfolios", portfolioRouter);
app.use("/api/resources", resourceRouter);
app.use("/api/request-forms", requestFormRouter);
app.use("/api/blueprints", blueprintRouter);
app.use("/api/approvals", approvalRouter);
app.use("/api/proofs", proofRouter);
app.use("/api/ai-proposals", aiProposalRouter);
app.use("/api/dashboards", dashboardRouter);
app.use("/api/reports", reportRouter);
app.use("/api/attestations", attestationRouter);
// Unauthenticated attestation share links. Its own tighter limiter (30/min) because this is
// the only public read surface in the app — see the controller header for the full posture.
app.use("/api/shared/attestations", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true }), attestationPublicRouter);
// Unauthenticated request-form intake — the only endpoint in the app that lets a stranger WRITE.
// 20/min per IP is the coarse backstop; the real control is the per-FORM hourly cap the form's
// own author sets (see request-form-public.controller.ts), because per-IP alone is useless
// against a distributed flood and punishes a genuine office behind one NAT.
app.use("/api/shared/request-forms", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true }), requestFormPublicRouter);
// Unauthenticated guest approvals. Tighter still: a reviewer loads one page and clicks once, so
// anything beyond a handful a minute from one address is not a person reviewing a deliverable.
app.use("/api/shared/approvals", rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: true }), approvalPublicRouter);
app.use("/api/notifications", notificationRouter);
app.use("/api/audit", auditRouter);
app.use("/api/team", teamRouter);
app.use("/api/settings", settingsRouter);
// Carries an unauthenticated read surface (GET /status — the lockout page's poll), but unlike
// the attestation links its availability IS the feature: during a real window, every locked-out
// user in an office polls it every 20s through the SAME NAT egress IP. 30/min (the first cut)
// saturated at ~10 locked-out colleagues — and flaked the e2e suite the same way. 240/min
// supports ~80 concurrent locked-out users per office IP (3 req/min each) plus the admin tab's
// health (6/min) + admin-view (2/min) polls, while staying a real brake on abuse — the endpoint
// is a 10s-cached read costing no query per hit. Admin routes under it are auth-gated anyway.
app.use("/api/maintenance", rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true }), maintenanceRouter);
// Tighter than the global 300/min: every /verify costs ~150-400ms of CPU-bound wasm inference
// PER FRAME, which makes unthrottled retries a self-inflicted DoS as much as a brute-force
// surface. 60/min per IP comfortably covers honest use (status + challenge + two-frame verify
// is ~4 requests per attempt, retries included) while capping what one client can burn to
// well under a core.
app.use("/api/face", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true }), faceRouter);
app.use("/api/email-templates", emailTemplatesRouter);
// Bearer-API-key auth, not JWT — see middleware/public-api-auth.ts's header for why this is
// still mounted after resolveTenant (unlike the CI/chat webhook receivers above) rather than
// before it. Its own lighter rate limit reflects "external integration polling," not "human
// clicking a UI."
app.use("/api/public/v1", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true }), publicApiRouter);

app.use(notFound);
app.use(errorHandler);
