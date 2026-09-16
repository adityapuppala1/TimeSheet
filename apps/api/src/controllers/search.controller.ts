/**
 * WHAT: `GET /api/search?q=` — the command palette's deterministic record search.
 * WHY ITS OWN ROUTER: it spans two record types under one scope rule, so it belongs to neither
 * the ticket nor the project controller; and keeping it tiny keeps the palette's one request
 * cheap to reason about. All logic is in services/search.service.ts.
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { quickSearch } from "../services/search.service.js";

export const searchRouter = Router();
searchRouter.use(requireAuth);

searchRouter.get("/", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  res.json(await quickSearch(req, q));
});
