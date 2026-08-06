/**
 * WHAT: the app's single error-handling module — `AppError` (a status-code-carrying error class
 * every controller/service throws instead of a plain `Error`), `notFound` (catch-all 404), and
 * `errorHandler` (the Express error middleware that turns any thrown error into a JSON response).
 * WHY: without one shared error type, every route would need its own try/catch + status-code
 * logic, and a raw unhandled exception would leak a stack trace to the client. Throwing
 * `AppError(404, "...")` anywhere in the call stack is enough — Express's error-handling
 * middleware chain carries it here automatically.
 * HOW: `ZodError` (validation failures from middleware/validate.ts) maps to 422 with the
 * flattened issue list; `AppError` maps to its own status code; anything else is an unexpected
 * 500, logged server-side (never with request details) so real bugs aren't lost.
 * WHO calls this: registered once in app.ts as the last middleware in the chain — every
 * controller/service in the app relies on it implicitly by throwing `AppError` freely.
 */
import { Prisma } from "@prisma/client";
import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export class AppError extends Error {
  /** Optional machine-readable code for clients that must BRANCH on the error kind rather than
   *  parse prose — e.g. "MAINTENANCE", where the right reaction (show the maintenance page)
   *  differs from every other 503 (show the outage banner). Human text stays the main channel. */
  public code?: string;

  constructor(public statusCode: number, message: string, options?: { code?: string }) {
    super(message);
    this.code = options?.code;
  }
}

export const notFound = () => {
  throw new AppError(404, "Route not found");
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof ZodError) {
    // The message NAMES the fields. The bare "Validation failed" this used to send made every
    // form's error toast useless — a 501-character project description produced a rejection
    // that never mentioned "description" anywhere a person would look (flatten() even collapses
    // the path to "body"). Machines still get the full issue list; humans get the first three
    // problems in words.
    const detail = error.issues
      .slice(0, 3)
      .map((issue) => {
        // Drop the validate-middleware wrapper segment (body/query/params) — nobody typed into
        // a field called "body".
        const path = issue.path.filter((p) => !["body", "query", "params"].includes(String(p))).join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    return res.status(422).json({
      message: detail ? `Validation failed — ${detail}` : "Validation failed",
      issues: error.flatten()
    });
  }

  // Prisma's known errors are CLIENT mistakes wearing a stack trace. Without this translation,
  // any unique-constraint hit anywhere in the app leaked the raw `Invalid prisma.x.create()
  // invocation …` dump to the browser as a 500 — which is how "that project code is taken"
  // reached a user as a wall of ORM internals. Routes with context still pre-check and throw
  // their own precise AppError; this is the floor, not the ceiling.
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      const target = error.meta?.target;
      const fields = Array.isArray(target) ? target.join(", ") : typeof target === "string" ? target : null;
      return res.status(409).json({
        message: fields
          ? `That value is already in use — ${fields} must be unique. Pick a different value.`
          : "That value is already in use — it must be unique. Pick a different value."
      });
    }
    if (error.code === "P2025") {
      return res.status(404).json({ message: "The record this action targets no longer exists — it may have just been deleted." });
    }
  }

  const statusCode = error instanceof AppError ? error.statusCode : 500;
  // The maintenance lockout is a 503 by protocol but a DELIBERATE state, not a fault — during a
  // real window every locked-out user's polling would otherwise flood the log with identical
  // stack traces and bury any actual 500 that happens mid-maintenance (the worst possible time
  // to lose one).
  const deliberateLockout = error instanceof AppError && error.code === "MAINTENANCE";
  if (statusCode >= 500 && !deliberateLockout) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, error);
  }
  return res.status(statusCode).json({
    message: error.message || "Unexpected server error",
    // Only present when an AppError carries one — absent otherwise, so no client is tempted to
    // treat "no code" as a code.
    ...(error instanceof AppError && error.code ? { code: error.code } : {})
  });
};

