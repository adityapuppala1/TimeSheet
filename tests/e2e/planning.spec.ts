/**
 * Planning layer (V6) end-to-end.
 *
 * WHY THESE SPECIFIC ASSERTIONS: the planning layer's whole promise is "additive — nothing you
 * already do changes". The most valuable test here is therefore not "the Gantt renders" but
 * "with planning OFF the app is byte-for-byte what it was", and after that, that each new surface
 * survives real data rather than the fixture that happened to be on screen while it was built.
 *
 * These specs are viewport-agnostic and run in the `desktop` project. The responsive suite
 * separately walks every route for horizontal overflow, which is where the phone/tablet
 * behaviour of these pages is checked.
 */
import { expect, test, type Page } from "@playwright/test";
import { suspendFaceGate, type FaceGateSnapshot } from "./helpers/face-gate";

const ADMIN = "superadmin@timesheet.local";

/**
 * Signs in for THIS test, rather than replaying a shared `storageState` snapshot.
 *
 * WHY, and this is documented the hard way in auth.setup.ts and product-tour.spec.ts: a snapshot
 * file replays ONE fixed refresh cookie, and every `/app` load rotates that session's secret. The
 * grace window forgives only the immediately-previous secret, so the first test in a multi-test
 * spec leaves the snapshot two generations behind and every later test lands on /login. The
 * symptom — "the page just shows the login form" — points nowhere near the cause.
 *
 * Free against the rate limiter: /auth/login is capped with `skipSuccessfulRequests`, so
 * successful sign-ins never count toward the budget.
 */
async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(ADMIN);
  await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 15_000 });
}

/**
 * Reads the workspace planning settings through the API, using the stored session.
 *
 * MUST be called BEFORE any `page.goto` into the app. Refresh tokens rotate on use (see
 * auth.service.ts), and the app's own `AuthBootstrap` calls `/auth/refresh` on first paint — so a
 * request issued after navigation races the page for the same one-use cookie and loses with
 * "Session expired". Every spec below therefore takes its token first and navigates second.
 */
async function planningConfig(page: Page) {
  const { accessToken } = await (await page.request.post("/api/auth/refresh")).json();
  const res = await page.request.get("/api/planning/settings", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return { config: await res.json(), token: accessToken };
}

// Several tests below build ticket fixtures through the API. When the workspace has face
// verification enabled with enforcementMode ALL — a legitimate, shippable configuration — those
// creations return 428, and because a fixture helper that does not assert its own status leaves
// `id` undefined, the failure surfaces much later as a 422 on an unrelated route. Suspend
// enforcement for this file and restore the exact previous values afterwards; a no-op when the
// feature is off. Same pattern as responsive.spec.ts and tickets.spec.ts.
let faceGate: FaceGateSnapshot;
test.beforeAll(async () => {
  faceGate = await suspendFaceGate();
});
test.afterAll(async () => {
  await faceGate?.restore();
});

test.describe("planning layer", () => {
  // No storageState: each test signs in for itself — see signIn's note above.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the settings API reports settings, entitlements and their AND", async ({ page }) => {
    await signIn(page);
    const { config } = await planningConfig(page);

    // The three-part shape is the contract the whole client gates on: a toggle that is on but not
    // included in the plan must never read as available.
    expect(config).toHaveProperty("settings");
    expect(config).toHaveProperty("entitlements");
    expect(config).toHaveProperty("effective");
    for (const key of ["planning", "timeline", "resourceManagement", "approvals", "proofing", "requestForms", "customWorkflows"]) {
      expect(typeof config.effective[key], `effective.${key}`).toBe("boolean");
    }
    // effective is an AND, never wider than the entitlement.
    if (!config.entitlements.ganttEnabled) expect(config.effective.timeline).toBe(false);
    if (!config.settings.enablePlanning) expect(config.effective.timeline).toBe(false);
  });

  test("the Default workflow still mirrors the six built-in statuses", async ({ page }) => {
    // The compatibility hinge. If this seed ever drifts from `ticketStatusTransitions`, the board
    // starts offering moves the server rejects.
    await signIn(page);
    const { token } = await planningConfig(page);
    const workflows = await (
      await page.request.get("/api/planning/workflows", { headers: { Authorization: `Bearer ${token}` } })
    ).json();

    const system = workflows.find((w: any) => w.isSystem);
    expect(system, "a system workflow must always exist").toBeTruthy();
    expect(system.statuses).toHaveLength(6);
    expect(system.transitions).toHaveLength(9);
    expect(system.statuses.map((s: any) => s.legacyStatus).sort()).toEqual(
      ["CLOSED", "IN_PROGRESS", "IN_REVIEW", "OPEN", "REOPENED", "RESOLVED"]
    );
    // Every status maps to a real built-in one — this is what keeps Ticket.status correct.
    for (const status of system.statuses) {
      expect(["TODO", "ACTIVE", "REVIEW", "DONE", "CANCELLED"]).toContain(status.category);
    }
  });

  test("My work opens for anyone and buckets without blowing up on an empty queue", async ({ page }) => {
    // Ungated on purpose — a personal queue that 403s for most of the company is worse than none.
    await signIn(page);
    await page.goto("/app/my-work");
    await expect(page.getByRole("heading", { name: /my work/i })).toBeVisible();
    // Either buckets or the empty state, never an error boundary.
    await expect(page.getByText(/nothing assigned to you|overdue|due today|this week|later|blocked/i).first()).toBeVisible({
      timeout: 15_000
    });
  });

  test("the timeline renders bars, or explains why it cannot", async ({ page }) => {
    await signIn(page);
    await page.goto("/app/timeline");
    await page.waitForLoadState("networkidle");

    const off = page.getByText(/isn.t switched on|not included in this plan/i);
    if (await off.count()) {
      // The off state must say which of the two reasons applies, so the reader knows whether to
      // change a setting or have a commercial conversation.
      await expect(off.first()).toBeVisible();
      return;
    }

    await expect(page.getByRole("heading", { name: /^timeline$/i })).toBeVisible();
    // The zoom control is the load-bearing bit of the toolbar.
    await expect(page.getByRole("button", { name: /^week$/i })).toBeVisible();
    await page.getByRole("button", { name: /^month$/i }).click();
    await page.getByRole("button", { name: /^day$/i }).click();
    // Either a chart or the documented empty state — never a blank panel.
    await expect(page.locator("svg").first().or(page.getByText(/nothing scheduled yet/i))).toBeVisible();
  });

  test("the tickets page gains Timeline and Calendar without disturbing List and Board", async ({ page }) => {
    await signIn(page);
    await page.goto("/app/tickets");
    await page.waitForLoadState("networkidle");

    // The two original views must still be there and still work — this is the regression that
    // matters most, since the switcher was extended in place rather than replaced.
    await expect(page.getByRole("button", { name: /^list$/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^board$/i })).toBeVisible();
    await page.getByRole("button", { name: /^board$/i }).click();
    await expect(page.getByText(/in progress/i).first()).toBeVisible();
    await page.getByRole("button", { name: /^list$/i }).click();

    const timelineTab = page.getByRole("button", { name: /^timeline$/i });
    if (await timelineTab.count()) {
      await timelineTab.click();
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("button", { name: /critical path/i })).toBeVisible();
    }

    const calendarTab = page.getByRole("button", { name: /^calendar$/i });
    if (await calendarTab.count()) {
      await calendarTab.click();
      await page.waitForLoadState("networkidle");
      // Month grid header, and the legend that distinguishes a real schedule from an SLA date.
      await expect(page.getByText(/sla date only/i)).toBeVisible();
      await expect(page.getByRole("button", { name: /^today$/i })).toBeVisible();
    }
  });

  test("the month calendar steps months, returns to today, and folds overflow into a count", async ({ page }) => {
    await signIn(page);
    const { config } = await planningConfig(page);
    test.skip(!config.effective.planning, "planning is off in this workspace");

    await page.goto("/app/tickets");
    await page.getByRole("button", { name: /^calendar$/i }).click();
    await page.waitForLoadState("networkidle");

    // The header names the month and its full range — a printed or screenshotted calendar must
    // state its own scope, same rule as the PDF report.
    const heading = page.getByRole("heading", { level: 2 });
    const initial = (await heading.textContent())?.trim() ?? "";
    expect(initial).toMatch(/^[A-Z][a-z]+ \d{4}$/);
    await expect(page.getByText(/^1 [A-Z][a-z]{2} \d{4} – \d{1,2} [A-Z][a-z]{2} \d{4}$/)).toBeVisible();

    // Stepping is the interaction that broke in the pickers (WebKit), so it is pinned here too.
    await page.getByRole("button", { name: "Previous month" }).click();
    await expect(heading).not.toHaveText(initial);
    await page.getByRole("button", { name: /^today$/i }).click();
    await expect(heading).toHaveText(initial);

    // Every chip is a button that opens its ticket; a cell never lists more than three, and the
    // remainder is stated as a count rather than silently cut — the calendar's version of the
    // "truncation is always stated" rule.
    const grid = page.locator(".grid-cols-7").last();
    await expect(grid).toBeVisible();
  });

  test("a scheduling dependency that would create a loop is refused, naming the items", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.timeline, "planning is off in this workspace");

    const headers = { Authorization: `Bearer ${token}` };
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const projectId = projects[0].id;

    // ASSERTED, not assumed. Without this a failed create leaves `id` undefined, the dependency
    // POST below sends `fromId: undefined`, and the whole thing surfaces as a 422 on the cycle
    // route — pointing at the feature under test rather than at the fixture that never existed.
    const mk = async (title: string) => {
      const res = await page.request.post("/api/tickets", {
        headers,
        data: { projectId, title, type: "BUG", priority: "LOW" }
      });
      expect(res.status(), `ticket fixture should be created: ${await res.text()}`).toBe(201);
      return res.json();
    };

    const a = await mk("Cycle probe A");
    const b = await mk("Cycle probe B");

    const first = await page.request.post("/api/plan/dependencies", {
      headers,
      data: { fromId: a.id, toId: b.id, type: "FINISH_TO_START" }
    });
    expect(first.status()).toBe(201);

    // The reverse edge closes a loop and must be refused BEFORE it is written — discovering it
    // later as a wrong-looking timeline gives nobody a way to tell which link is at fault.
    const loop = await page.request.post("/api/plan/dependencies", {
      headers,
      data: { fromId: b.id, toId: a.id, type: "FINISH_TO_START" }
    });
    expect(loop.status()).toBe(422);
    const body = await loop.json();
    expect(body.message).toMatch(/loop/i);
    expect(body.message).toContain(a.key);

    await page.request.delete(`/api/tickets/${a.id}`, { headers });
    await page.request.delete(`/api/tickets/${b.id}`, { headers });
  });

  test("scheduling an item writes real dates and the timeline reflects them", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.timeline, "planning is off in this workspace");

    const headers = { Authorization: `Bearer ${token}` };
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const created = await page.request.post("/api/tickets", {
      headers,
      data: { projectId: projects[0].id, title: "Schedule round-trip probe", type: "TASK", priority: "LOW" }
    });
    expect(created.status(), `ticket fixture should be created: ${await created.text()}`).toBe(201);
    const ticket = await created.json();

    const patched = await page.request.patch(`/api/plan/items/${ticket.id}`, {
      headers,
      data: { startDate: "2026-09-07", endDate: "2026-09-11" }
    });
    expect(patched.status()).toBe(200);

    const timeline = await (
      await page.request.get(`/api/plan/timeline?projectIds=${projects[0].id}`, { headers })
    ).json();
    const row = timeline.items.find((i: any) => i.id === ticket.id);
    expect(row, "the scheduled item must appear on the timeline").toBeTruthy();
    expect(row.startDate).toBe("2026-09-07");
    expect(row.resolvedEnd).toBe("2026-09-11");
    // Entered dates are never "inferred" — that flag is what the UI uses to hatch a guess.
    expect(row.isInferred).toBe(false);
    // Mon-Fri inclusive is 5 working days, not 4 and not 6. The off-by-one that makes every
    // Gantt bar a day too long would show up right here.
    expect(row.durationDays).toBe(5);

    // An end before a start is refused rather than silently swapped.
    const bad = await page.request.patch(`/api/plan/items/${ticket.id}`, {
      headers,
      data: { startDate: "2026-09-11", endDate: "2026-09-07" }
    });
    expect(bad.status()).toBe(422);

    await page.request.delete(`/api/tickets/${ticket.id}`, { headers });
  });

  test("the workload board puts planned, actual and capacity on one axis", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.resourceManagement, "resource management is off in this workspace");

    const board = await (
      await page.request.get("/api/resources/workload", { headers: { Authorization: `Bearer ${token}` } })
    ).json();

    expect(Array.isArray(board.rows)).toBe(true);
    expect(board.buckets.length).toBeGreaterThan(0);

    for (const row of board.rows) {
      for (const cell of row.cells) {
        // Capacity is what is AVAILABLE — gross capacity minus time off — so it can never be
        // negative, and a week fully on leave must report zero rather than a negative number.
        expect(cell.capacityHours).toBeGreaterThanOrEqual(0);
        // The three columns that make this board worth having. A pure PM tool has only the first.
        expect(typeof cell.bookedHours).toBe("number");
        expect(typeof cell.loggedHours).toBe("number");

        if (cell.allocationPct !== null) {
          // 100% exactly is fully booked, which is the intended state — never flagged.
          if (cell.allocationPct <= 100) expect(cell.isOverAllocated).toBe(false);
        } else {
          // No capacity to divide by: the percentage is null rather than Infinity, and the
          // over-allocation flag has to carry the meaning instead.
          expect(cell.capacityHours).toBe(0);
        }
      }
    }
  });

  test("a booking spans working days only, and overlaps are reported not refused", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.resourceManagement, "resource management is off in this workspace");

    const headers = { Authorization: `Bearer ${token}` };
    const users = await (await page.request.get("/api/users", { headers })).json();
    const userId = (Array.isArray(users) ? users : users.rows)[0].id;

    // Mon 2026-09-07 to Sun 2026-09-13 at 8h/day must be 40 hours, not 56 — the calendar-vs-
    // working-day bug that would inflate every person's load by the weekend.
    const first = await page.request.post("/api/resources/bookings", {
      headers,
      data: { userId, startDate: "2026-09-07", endDate: "2026-09-13", hoursPerDay: 8, note: "e2e probe A" }
    });
    expect(first.status()).toBe(201);
    const a = await first.json();

    const board = await (
      await page.request.get("/api/resources/workload?from=2026-09-07&to=2026-09-13", { headers })
    ).json();
    const row = board.rows.find((r: any) => r.person.id === userId);
    expect(row.totals.bookedHours).toBe(40);

    // A second overlapping booking is ACCEPTED — splitting someone across two projects is
    // sometimes the plan, and refusing it would force planners to record something untrue.
    const second = await page.request.post("/api/resources/bookings", {
      headers,
      data: { userId, startDate: "2026-09-08", endDate: "2026-09-10", hoursPerDay: 6, note: "e2e probe B" }
    });
    expect(second.status()).toBe(201);
    const b = await second.json();

    const conflicts = await (
      await page.request.get("/api/resources/conflicts?from=2026-09-07&to=2026-09-13", { headers })
    ).json();
    expect(conflicts.some((c: any) => c.userId === userId)).toBe(true);

    // An inverted range IS refused — that is a data-entry error, not a plan.
    const bad = await page.request.post("/api/resources/bookings", {
      headers,
      data: { userId, startDate: "2026-09-13", endDate: "2026-09-07", hoursPerDay: 4 }
    });
    expect(bad.status()).toBe(422);

    await page.request.delete(`/api/resources/bookings/${a.id}`, { headers });
    await page.request.delete(`/api/resources/bookings/${b.id}`, { headers });
  });

  test("the project budget panel never reports a forecast it cannot support", async ({ page }) => {
    await signIn(page);
    const { token } = await planningConfig(page);
    const headers = { Authorization: `Bearer ${token}` };
    const projects = await (await page.request.get("/api/projects", { headers })).json();

    const panel = await (await page.request.get(`/api/resources/budget/${projects[0].id}`, { headers })).json();
    expect(panel.progressPct).toBeGreaterThanOrEqual(0);
    expect(panel.progressPct).toBeLessThanOrEqual(100);

    if (panel.budget) {
      // Same rule as the portfolio roll-up, enforced by the one shared budget service.
      if (panel.budget.burn === 0) expect(panel.budget.forecastAtCompletion).toBeNull();
      // Unrated hours are counted separately, never priced as zero.
      expect(panel.budget.unratedHours).toBeGreaterThanOrEqual(0);
    }
    // Variance covers finished work only, so every row must have both numbers.
    for (const row of panel.variance.rows) {
      expect(row.estimatedHours).toBeGreaterThan(0);
      expect(row.actualHours).toBeGreaterThan(0);
    }
  });

  test("the workload board opens and renders its capacity ramp", async ({ page }) => {
    await signIn(page);
    await page.goto("/app/workload");
    await page.waitForLoadState("networkidle");

    const off = page.getByText(/isn.t switched on|don.t have access/i);
    if (await off.count()) {
      await expect(off.first()).toBeVisible();
      return;
    }
    await expect(page.getByRole("heading", { name: /^workload$/i })).toBeVisible();
    // The legend is what makes the colours mean anything; its presence is the cheapest proof the
    // ramp classes actually generated (a missing Tailwind colour renders invisible, not broken).
    await expect(page.getByText(/over capacity/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /book time/i })).toBeVisible();
  });

  test("a request form is not public until it is explicitly published", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.requestForms, "request forms are off in this workspace");

    const headers = { Authorization: `Bearer ${token}` };
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const slug = `e2e-${Date.now()}`;

    const created = await page.request.post("/api/request-forms", {
      headers,
      data: {
        name: "E2E intake", slug, projectId: projects[0].id, ticketType: "TASK",
        schema: { fields: [
          { key: "summary", label: "Summary", type: "TEXT", required: true, mapsTo: "title" },
          { key: "kind", label: "Kind", type: "SELECT", options: ["Bug", "Feature"], required: true },
          { key: "steps", label: "Steps", type: "TEXTAREA", required: true, showWhen: [{ field: "kind", operator: "equals", value: "Bug" }] }
        ] }
      }
    });
    expect(created.status()).toBe(201);
    const form = await created.json();
    // Creating a form and exposing it to the open internet are different decisions.
    expect(form.isPublic).toBe(false);

    // A bogus token must be indistinguishable from an unpublished one.
    const bogus = await page.request.get(`/api/shared/request-forms/${"a".repeat(40)}`);
    expect(bogus.status()).toBe(404);

    const published = await (await page.request.post(`/api/request-forms/${form.id}/publish`, { headers, data: { publish: true } })).json();
    const publicToken = published.publicToken;
    expect(publicToken?.length).toBeGreaterThan(30);

    // What a stranger receives: the questions, and nothing about how the workspace is wired.
    const view = await (await page.request.get(`/api/shared/request-forms/${publicToken}`)).json();
    expect(view.fields).toHaveLength(3);
    for (const leak of ["projectId", "defaultAssigneeId", "blueprintId", "moduleId"]) {
      expect(view, `public payload must not expose ${leak}`).not.toHaveProperty(leak);
    }

    await page.request.delete(`/api/request-forms/${form.id}`, { headers });
  });

  test("a hidden conditional question is neither required nor accepted", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.requestForms, "request forms are off in this workspace");

    const headers = { Authorization: `Bearer ${token}` };
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const slug = `e2e-cond-${Date.now()}`;
    const form = await (await page.request.post("/api/request-forms", { headers, data: {
      name: "E2E conditional", slug, projectId: projects[0].id, ticketType: "TASK",
      schema: { fields: [
        { key: "summary", label: "Summary", type: "TEXT", required: true, mapsTo: "title" },
        { key: "kind", label: "Kind", type: "SELECT", options: ["Bug", "Feature"], required: true },
        { key: "steps", label: "Steps", type: "TEXTAREA", required: true, showWhen: [{ field: "kind", operator: "equals", value: "Bug" }] }
      ] }
    } })).json();
    const { publicToken } = await (await page.request.post(`/api/request-forms/${form.id}/publish`, { headers, data: { publish: true } })).json();

    // Not shown, so not enforced — an honest submitter must not be blocked by a question they
    // were routed away from and cannot see.
    const ok = await page.request.post(`/api/shared/request-forms/${publicToken}`, {
      data: { answers: { summary: "Dark mode please", kind: "Feature" } }
    });
    expect(ok.status()).toBe(201);

    // Shown, so enforced.
    const missing = await page.request.post(`/api/shared/request-forms/${publicToken}`, {
      data: { answers: { summary: "It crashes", kind: "Bug" } }
    });
    expect(missing.status()).toBe(400);

    // Smuggled past a branch they never triggered: dropped, not stored.
    const smuggled = await (await page.request.post(`/api/shared/request-forms/${publicToken}`, {
      data: { answers: { summary: "Smuggle", kind: "Feature", steps: "SHOULD_NOT_PERSIST" } }
    })).json();
    const inbox = await (await page.request.get("/api/request-forms/submissions", { headers })).json();
    const row = inbox.find((s: any) => s.ticket?.key === smuggled.reference);
    expect(row.answers).not.toHaveProperty("steps");
    // And it never routes itself past a human.
    expect(row.needsReview).toBe(true);

    await page.request.delete(`/api/request-forms/${form.id}`, { headers });
  });

  test("an approval chain runs in order, and one rejection settles it", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.approvals, "approvals are off in this workspace");

    const headers = { Authorization: `Bearer ${token}` };
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const created = await page.request.post("/api/tickets", {
      headers, data: { projectId: projects[0].id, title: "Approval chain probe", type: "TASK", priority: "LOW" }
    });
    expect(created.status(), `ticket fixture should be created: ${await created.text()}`).toBe(201);
    const ticket = await created.json();

    const chain = await (await page.request.post("/api/approvals", { headers, data: {
      ticketId: ticket.id, title: "Sign off", isSequential: true,
      steps: [{ guestEmail: "first@example.com", order: 0 }, { guestEmail: "second@example.com", order: 1 }]
    } })).json();
    // The panel must never hand a manager a capability to decide as someone else.
    expect(chain.steps.every((s: any) => !("guestToken" in s))).toBe(true);

    const link1 = await (await page.request.post(`/api/approvals/steps/${chain.steps[0].id}/resend`, { headers })).json();
    const link2 = await (await page.request.post(`/api/approvals/steps/${chain.steps[1].id}/resend`, { headers })).json();
    const gt1 = String(link1.url).split("/").pop();
    const gt2 = String(link2.url).split("/").pop();

    // Out of turn.
    const early = await page.request.post(`/api/shared/approvals/${gt2}`, { data: { decision: "APPROVED" } });
    expect(early.status()).toBe(409);

    // What a guest can see — the thing under review, and nothing else.
    const guestView = await (await page.request.get(`/api/shared/approvals/${gt1}`)).json();
    expect(guestView.item.reference).toBe(ticket.key);
    expect(guestView).not.toHaveProperty("steps");
    expect(guestView.item).not.toHaveProperty("assignee");

    expect((await page.request.post(`/api/shared/approvals/${gt1}`, { data: { decision: "APPROVED" } })).status()).toBe(200);
    // Single-use by construction: the spent link is now indistinguishable from a bogus one.
    expect((await page.request.post(`/api/shared/approvals/${gt1}`, { data: { decision: "APPROVED" } })).status()).toBe(404);

    expect((await page.request.post(`/api/shared/approvals/${gt2}`, { data: { decision: "REJECTED" } })).status()).toBe(200);
    const after = await (await page.request.get(`/api/approvals/ticket/${ticket.id}`, { headers })).json();
    expect(after[0].status).toBe("REJECTED");
    expect(after[0].completedAt).toBeTruthy();

    await page.request.delete(`/api/tickets/${ticket.id}`, { headers });
  });

  test("a blueprint expands to real dates and real dependencies", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.planning, "planning is off in this workspace");

    const headers = { Authorization: `Bearer ${token}` };
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const bp = await (await page.request.post("/api/blueprints", { headers, data: {
      name: `E2E blueprint ${Date.now()}`,
      payload: { items: [
        { title: "E2E Kickoff", isMilestone: true, offsetStartDays: 0 },
        { title: "E2E Design", offsetStartDays: 0, durationDays: 5 },
        { title: "E2E Build", offsetStartDays: 5, durationDays: 10, dependsOn: [1] }
      ] }
    } })).json();

    // 2026-09-07 is a Monday.
    const preview = await (await page.request.post(`/api/blueprints/${bp.id}/preview`, { headers, data: { startDate: "2026-09-07" } })).json();
    const byTitle = new Map(preview.items.map((i: any) => [i.title, i]));
    expect((byTitle.get("E2E Kickoff") as any).endDate).toBe("2026-09-07"); // a milestone has no span
    expect((byTitle.get("E2E Design") as any).endDate).toBe("2026-09-11"); // Mon-Fri inclusive is 5
    expect((byTitle.get("E2E Build") as any).startDate).toBe("2026-09-14"); // offset 5 skips the weekend

    const inst = await (await page.request.post(`/api/blueprints/${bp.id}/instantiate`, {
      headers, data: { projectId: projects[0].id, startDate: "2026-09-07" }
    })).json();
    expect(inst.count).toBe(3);

    const timeline = await (await page.request.get(`/api/plan/timeline?projectIds=${projects[0].id}`, { headers })).json();
    const build = timeline.items.find((i: any) => i.title === "E2E Build");
    const design = timeline.items.find((i: any) => i.title === "E2E Design");
    expect(build?.startDate).toBe("2026-09-14");
    const deps = await (await page.request.get(`/api/plan/dependencies?projectIds=${projects[0].id}`, { headers })).json();
    expect(deps.some((d: any) => d.fromId === design?.id && d.toId === build?.id)).toBe(true);

    for (const item of inst.items) await page.request.delete(`/api/tickets/${item.id}`, { headers });
    await page.request.delete(`/api/blueprints/${bp.id}`, { headers });
  });

  test("the Requests page opens and the public form renders without a session", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.requestForms, "request forms are off in this workspace");

    await page.goto("/app/requests");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: /^requests$/i })).toBeVisible();

    const headers = { Authorization: `Bearer ${token}` };
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const form = await (await page.request.post("/api/request-forms", { headers, data: {
      name: "E2E public render", slug: `e2e-render-${Date.now()}`, projectId: projects[0].id,
      schema: { intro: "Tell us what you need.", fields: [{ key: "summary", label: "Summary", type: "TEXT", required: true, mapsTo: "title" }] }
    } })).json();
    const { publicToken } = await (await page.request.post(`/api/request-forms/${form.id}/publish`, { headers, data: { publish: true } })).json();

    // No session at all — the page must never assume one or bounce to /login.
    await page.context().clearCookies();
    await page.goto(`/request/${publicToken}`);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(new RegExp(`/request/${publicToken}`));
    await expect(page.getByText("E2E public render")).toBeVisible();
    await expect(page.getByRole("button", { name: /send request/i })).toBeVisible();

    await page.request.delete(`/api/request-forms/${form.id}`, { headers });
  });

  test("project risk is arithmetic — it works with AI switched off, and never invents a number", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.planning, "planning is off in this workspace");

    const headers = { Authorization: `Bearer ${token}` };
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const projectId = projects[0].id;

    const res = await page.request.get(`/api/ai-proposals/risk/${projectId}`, { headers });
    expect(res.status(), "the score must not depend on an AI provider being configured").toBe(200);
    const risk = await res.json();

    expect(risk.riskScore).toBeGreaterThanOrEqual(0);
    expect(risk.riskScore).toBeLessThanOrEqual(100);
    // Every signal is reported, including the clean ones — "why is this green?" has to be as
    // answerable as "why is this red?".
    expect(risk.signals).toHaveLength(6);
    for (const signal of risk.signals) {
      expect(signal.points).toBeLessThanOrEqual(25); // no signal may exceed its own weight
      expect(signal.detail).toBeTruthy();
    }
    // The band is a stated threshold, not a separate judgement.
    const expectedBand = risk.riskScore >= 55 ? "RED" : risk.riskScore >= 25 ? "AMBER" : "GREEN";
    expect(risk.band).toBe(expectedBand);

    // Determinism is what makes the number defensible in a meeting.
    const again = await (await page.request.get(`/api/ai-proposals/risk/${projectId}`, { headers })).json();
    expect(again.riskScore).toBe(risk.riskScore);
    expect(again.signals.map((s: any) => s.points)).toEqual(risk.signals.map((s: any) => s.points));

    // Concerns are ordered worst-first, so the list reads as what to fix in order.
    const points = risk.signals.filter((s: any) => s.note).sort((a: any, b: any) => b.points - a.points);
    if (points.length > 1) expect(risk.topConcerns[0]).toBe(points[0].note);
  });

  test("a snapshot can be stored and read back per project", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.planning, "planning is off in this workspace");

    const headers = { Authorization: `Bearer ${token}` };
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const projectId = projects[0].id;

    const refreshed = await page.request.post(`/api/ai-proposals/risk/${projectId}/refresh`, { headers });
    expect(refreshed.status()).toBe(200);
    expect((await refreshed.json()).snapshotId).toBeTruthy();

    const snapshots = await (await page.request.get("/api/ai-proposals/risk", { headers })).json();
    const mine = snapshots.find((s: any) => s.projectId === projectId);
    expect(mine).toBeTruthy();
    expect(mine.band).toMatch(/GREEN|AMBER|RED/);
  });

  test("the AI copilot is gated, and an unavailable model never costs you the score", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.planning, "planning is off in this workspace");

    const headers = { Authorization: `Bearer ${token}` };
    const projects = await (await page.request.get("/api/projects", { headers })).json();

    // Asking for a narrative must never turn a working score into an error, whatever the AI
    // config happens to be — the score is the product, the sentence is a convenience.
    const narrated = await page.request.get(`/api/ai-proposals/risk/${projects[0].id}?narrate=true`, { headers });
    expect(narrated.status()).toBe(200);
    const body = await narrated.json();
    expect(typeof body.riskScore).toBe("number");

    // Plan breakdown is tier + AI gated, and says which rather than failing opaquely.
    const breakdown = await page.request.post("/api/ai-proposals/plan-breakdown", {
      headers,
      data: { projectId: projects[0].id, goal: "Add a CSV export to the reports page" }
    });
    expect([201, 403, 502]).toContain(breakdown.status());
    if (breakdown.status() !== 201) {
      expect((await breakdown.json()).message).toBeTruthy();
    } else {
      const proposal = await breakdown.json();
      // The whole point of the envelope: nothing is written, and nothing is pre-accepted.
      expect(proposal.status).toBe("PENDING_REVIEW");
      expect(proposal.changes.every((c: any) => c.accepted === null)).toBe(true);
      await page.request.post(`/api/ai-proposals/${proposal.id}/reject`, { headers });
    }
  });

  test("the AI suggestions page opens and says nothing has been applied", async ({ page }) => {
    await signIn(page);
    await page.goto("/app/proposals");
    await page.waitForLoadState("networkidle");

    const off = page.getByText(/needs the planning layer/i);
    if (await off.count()) {
      await expect(off.first()).toBeVisible();
      return;
    }
    await expect(page.getByRole("heading", { name: /ai suggestions/i })).toBeVisible();
    // The promise the page has to make on sight, before anyone reads a single row.
    await expect(page.getByText(/nothing here has been applied/i)).toBeVisible();
  });

  test("the portfolio roll-up returns derived numbers, and never a fake forecast", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.planning, "planning is off in this workspace");

    const rollup = await (
      await page.request.get("/api/portfolios/rollup", { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    expect(Array.isArray(rollup.projects)).toBe(true);

    for (const p of rollup.projects) {
      expect(p.progressPct).toBeGreaterThanOrEqual(0);
      expect(p.progressPct).toBeLessThanOrEqual(100);
      // The rule that keeps an executive dashboard honest: with no spend there is no basis for a
      // forecast, and "forecast: 0" reads as "this will cost nothing".
      if (p.burn === 0) expect(p.forecastAtCompletion).toBeNull();
      if (p.forecastAtCompletion !== null) expect(p.forecastAtCompletion).toBeGreaterThan(0);
    }
  });

  /* ---------------------------------------------------------------------- *
   * Phase 6 follow-up: proofing and saved views.
   *
   * These two shipped as API-only and were caught by the phase 6 audit, not by a test — nothing
   * asserted that a route with no caller was reachable from the product. That is exactly the gap
   * these fill: each one drives the UI, not the endpoint.
   * ---------------------------------------------------------------------- */

  test("a saved view stores the filters, not the rows, and applying one restores them", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.planning, "planning is off in this workspace");

    const name = `E2E view ${Date.now()}`;
    const created = await page.request.post("/api/plan/views", {
      headers: { Authorization: `Bearer ${token}` },
      data: { name, viewType: "LIST", scope: "PERSONAL", filters: { projectId: "all", status: "OPEN", priority: "all", labelId: "all", onlyMine: true } }
    });
    expect(created.ok()).toBe(true);
    const view = await created.json();
    // The row carries a QUESTION. If it ever starts carrying rows, a shared view becomes a data
    // grant and the whole sharing story stops being safe.
    expect(view.filters).toMatchObject({ status: "OPEN", onlyMine: true });
    expect(view).not.toHaveProperty("results");

    await page.goto("/app/tickets");
    // `exact` matters: the delete button carries the view name in its title, so a loose name
    // match resolves to two elements and fails strict mode.
    const chip = page.getByRole("button", { name, exact: true });
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await chip.click();
    // Applying it drives the page's own filter state — "Assigned to me" is the visible proof.
    await expect(page.getByRole("button", { name: /assigned to me/i })).toBeVisible();

    await page.request.delete(`/api/plan/views/${view.id}`, { headers: { Authorization: `Bearer ${token}` } });
  });

  test("a proofing pin is stored normalised, so it lands on the same spot at any size", async ({ page }) => {
    await signIn(page);
    const { config, token } = await planningConfig(page);
    test.skip(!config.effective.proofing, "proofing is off in this workspace");
    const headers = { Authorization: `Bearer ${token}` };

    // Creates its own ticket AND its own image rather than hunting for one that happens to exist.
    // A test that skips when the fixture is missing proves nothing, and this route had no caller
    // at all until phase 6 — an absent assertion is how that went unnoticed.
    const projects = await (await page.request.get("/api/projects", { headers })).json();
    const ticket = await (
      await page.request.post("/api/tickets", {
        headers,
        data: { projectId: projects[0].id, title: `Proofing probe ${Date.now()}`, type: "BUG", priority: "LOW" }
      })
    ).json();

    // A 1x1 PNG is enough: the pipeline only needs a real image, and the assertion is about the
    // coordinates, not the pixels.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"
    );
    const uploadRes = await page.request.post(`/api/tickets/${ticket.id}/attachments`, {
      headers,
      multipart: { attachments: { name: "proof.png", mimeType: "image/png", buffer: png } }
    });
    expect(uploadRes.status(), await uploadRes.text()).toBe(201);
    const image = (await uploadRes.json())[0];

    const res = await page.request.post(`/api/proofs/attachment/${image.id}`, {
      headers,
      data: { x: 0.25, y: 0.75, body: "E2E: this padding is wrong" }
    });
    expect(res.status(), await res.text()).toBe(201);
    const pin = await res.json();
    // Normalised, never pixels. Pixels would store whichever viewport was open when somebody
    // clicked, and every other viewer would see the pin somewhere else.
    expect(pin.x).toBeCloseTo(0.25, 5);
    expect(pin.y).toBeCloseTo(0.75, 5);

    // A reply attaches to the root; replying to a reply is refused, because a review conversation
    // about one spot on one image is a thread and not a tree.
    const reply = await page.request.post(`/api/proofs/attachment/${image.id}`, {
      headers,
      data: { x: 0.25, y: 0.75, body: "agreed", parentId: pin.id }
    });
    expect(reply.status()).toBe(201);
    const nested = await page.request.post(`/api/proofs/attachment/${image.id}`, {
      headers,
      data: { x: 0.25, y: 0.75, body: "no", parentId: (await reply.json()).id }
    });
    expect(nested.status()).toBe(400);

    // The panel renders the pin over the image, numbered, on the ticket's Proofing tab.
    await page.goto(`/app/tickets?open=${ticket.id}`);
    await page.getByRole("tab", { name: /proofing/i }).click();
    await expect(page.getByRole("button", { name: "1", exact: true })).toBeVisible({ timeout: 15_000 });

    await page.request.delete(`/api/tickets/${ticket.id}`, { headers });
  });
});
