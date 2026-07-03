import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { auditRouter } from "./controllers/audit.controller.js";
import { authRouter } from "./controllers/auth.controller.js";
import { emailTemplatesRouter } from "./controllers/email-templates.controller.js";
import { notificationRouter } from "./controllers/notification.controller.js";
import { projectRouter } from "./controllers/project.controller.js";
import { reportRouter } from "./controllers/report.controller.js";
import { settingsRouter } from "./controllers/settings.controller.js";
import { teamRouter } from "./controllers/team.controller.js";
import { timesheetRouter } from "./controllers/timesheet.controller.js";
import { userRouter } from "./controllers/user.controller.js";
import { errorHandler, notFound } from "./middleware/error.js";

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
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true
  })
);

// Lower-rate limiter for auth endpoints (login bruteforce defence).
const authLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true });
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);
app.use("/api/auth/reset-password", authLimiter);

app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true }));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(env.UPLOAD_DIR, { maxAge: "1d", etag: true }));
app.use(morgan("tiny"));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);
app.use("/api/users", userRouter);
app.use("/api/projects", projectRouter);
app.use("/api/timesheets", timesheetRouter);
app.use("/api/reports", reportRouter);
app.use("/api/notifications", notificationRouter);
app.use("/api/audit", auditRouter);
app.use("/api/team", teamRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/email-templates", emailTemplatesRouter);

app.use(notFound);
app.use(errorHandler);
