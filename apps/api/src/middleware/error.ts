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
    return res.status(422).json({ message: "Validation failed", issues: error.flatten() });
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

