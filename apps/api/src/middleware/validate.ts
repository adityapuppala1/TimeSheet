/**
 * WHAT: `validate(schema)` — a tiny Express middleware factory that parses
 * `{ body, params, query }` against a Zod schema and throws (caught by middleware/error.ts's
 * `ZodError` branch, → 422) on failure.
 * WHY: every route that accepts input needs the exact same "validate before the handler runs"
 * shape — this is the one place that shape is written, instead of every controller hand-rolling
 * its own `schema.parse(req.body)` call and error handling.
 * WHO calls this: nearly every POST/PATCH route across every controller, e.g.
 * `validate(createTicketSchema)` as route middleware before the handler.
 */
import type { RequestHandler } from "express";
import type { ZodSchema } from "zod";

export const validate =
  (schema: ZodSchema): RequestHandler =>
  (req, _res, next) => {
    schema.parse({ body: req.body, params: req.params, query: req.query });
    next();
  };

