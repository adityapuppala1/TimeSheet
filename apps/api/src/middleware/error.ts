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

