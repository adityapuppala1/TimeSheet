/**
 * A malformed request body is a CLIENT mistake, not a server fault. Before this was handled,
 * express.json()'s SyntaxError fell through errorHandler's generic branch and became a 500 whose
 * body echoed the parser's internal message ("Expected property name … at position 1") — a status
 * lie plus a small information leak, and a stack trace in the log on every hit. These tests pin
 * that body-parser failures map to their own 4xx with a stable, non-leaky message.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../src/middleware/error.js";

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  app.post("/echo", (req, res) => res.json(req.body));
  app.use(errorHandler);
  return app;
}

describe("errorHandler translates body-parser failures", () => {
  it("returns 400, not 500, for malformed JSON and does not echo the parser message", async () => {
    const res = await request(buildApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send("{bad json");

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Malformed JSON in request body.");
    // The raw parser message must not leak through.
    expect(JSON.stringify(res.body)).not.toMatch(/position|Expected property/i);
  });

  it("returns 413 for an oversized body", async () => {
    const res = await request(buildApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ big: "x".repeat(4096) }));

    expect(res.status).toBe(413);
    expect(res.body.message).toBe("Request body is too large.");
  });
});
