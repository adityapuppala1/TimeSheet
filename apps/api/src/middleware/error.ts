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
  constructor(public statusCode: number, message: string) {
    super(message);
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
  if (statusCode >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, error);
  }
  return res.status(statusCode).json({
    message: error.message || "Unexpected server error"
  });
};

