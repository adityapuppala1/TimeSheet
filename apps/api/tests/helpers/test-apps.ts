import express from "express";
import { errorHandler } from "../../src/middleware/error.js";
import { billingWebhookRouter } from "../../src/controllers/billing.controller.js";
import { scimRouter } from "../../src/controllers/scim.controller.js";

/**
 * Minimal Express apps for supertest, rather than importing the full `src/app.ts` (which eagerly
 * pulls in ~20 controllers, helmet/CORS/rate-limiters, etc.) — each mirrors exactly how app.ts
 * mounts the router under test, reusing the real `errorHandler` so status codes match production.
 */

/** Mirrors app.ts: billingWebhookRouter supplies its own `express.raw()` at the route level
 *  (needed for Stripe's raw-body signature check), so nothing extra is applied here. */
export function buildBillingWebhookApp() {
  const app = express();
  app.use("/billing", billingWebhookRouter);
  app.use(errorHandler);
  return app;
}

/** Mirrors app.ts: scimRouter is mounted at /api/scim before the global express.json(), but it
 *  parses JSON bodies fine on its own since Express only needs body-parser middleware ahead of
 *  routes that read req.body — applying express.json() here reproduces that. */
export function buildScimApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/scim", scimRouter);
  app.use(errorHandler);
  return app;
}
