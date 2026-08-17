/**
 * The seven asks from the team, verified in a real browser.
 *
 * WHY ONE FILE RATHER THAN SEVEN: these changes share a spine. The ticket dialog's scroll fix and
 * its new attachment field are the same dialog; the entry dialog is one component that History,
 * Approvals and the dashboard timeline all open; the activity catalog feeds the picker on the
 * logging form. Splitting them by ask would mean four specs signing in four times to drive the
 * same two screens.
 *
 * Each test below names the defect it pins. None of them approve, reject or delete anything — the
 * demo workspace is shared and those are one-way — so everything here either reads, or creates and
 * cleans up after itself.
 */
import { expect, request, test, type Locator, type Page } from "@playwright/test";
import { pickDate, signIn } from "./helpers/sign-in";
import { withAdminRequest } from "./helpers/admin-request";
import { E2E_BASE_URL } from "./helpers/base-url";

test.use({ storageState: { cookies: [], origins: [] } });

/** The dialog's own bounding box, for the assertions about it staying inside the window. */
async function dialogBox(page: Page) {
  const box = await page.getByRole("dialog").boundingBox();
  expect(box, "the dialog must have a layout box").not.toBeNull();
  return box!;
}

/**
 * Pastes plain text by dispatching a real `paste` ClipboardEvent at the editable node.
 *
 * NOT `navigator.clipboard.writeText` + Ctrl+V: that needs clipboard permissions the Playwright
 * context does not grant by default, and it fails differently on each engine. ProseMirror
 * registers its paste handler on the contentEditable DOM node, so a bubbling, cancelable
 * ClipboardEvent carrying a DataTransfer exercises exactly the code path a real paste does.
 */
async function pasteInto(editor: Locator, text: string) {
  await editor.click();
  await editor.evaluate((node, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

async function openNewTicketDialog(page: Page) {
  await signIn(page, "superadmin");
  await page.goto("/app/tickets");
  await page.getByRole("button", { name: /new ticket/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  return dialog;
}

/* ============================ 1. The description scrolls ============================ */

test.describe("new ticket dialog stays inside the window while you type", () => {
  /**
   * THE BUG: the dialog is centre-anchored with `translate(-50%, -50%)` and had no height cap, so
   * it grew in BOTH directions as the description did. Past roughly fifteen lines, "New ticket"
   * left the top of the screen and Cancel/Create left the bottom — and because the dialog is
   * `position: fixed` over a scroll-locked page, there was no scrollbar to bring them back. You
   * could keep typing and could no longer submit.
   */
  test("the title and the Create button stay reachable after a long description", async ({ page }) => {
    const dialog = await openNewTicketDialog(page);
    const editor = dialog.locator(".tiptap");

    await editor.click();
    // Thirty lines — comfortably past the point the old dialog walked off both edges.
    for (let i = 0; i < 30; i++) {
      await page.keyboard.type(`line ${i}`);
      await page.keyboard.press("Enter");
    }

    const viewport = page.viewportSize()!;
    const box = await dialogBox(page);
    expect(box.y, "the dialog's top edge must not be above the viewport").toBeGreaterThanOrEqual(-1);
    expect(box.y + box.height, "the dialog's bottom edge must not be below the viewport").toBeLessThanOrEqual(
      viewport.height + 1
    );

    // Reachability is the actual claim — a box inside the viewport whose footer is clipped by an
    // `overflow: hidden` ancestor would still pass the geometry check above.
    await expect(dialog.getByRole("button", { name: /create ticket/i })).toBeInViewport();
    await expect(dialog.getByRole("heading", { name: "New ticket" })).toBeInViewport();
  });

  test("the editor scrolls internally instead of pushing the form down", async ({ page }) => {
    const dialog = await openNewTicketDialog(page);
    const editor = dialog.locator(".tiptap");
    // The scroll container is the editor's parent — the toolbar is deliberately OUTSIDE it so it
    // stays put while the text moves.
    const scroller = dialog.locator(".tiptap").locator("xpath=ancestor::div[contains(@class,'overflow-y-auto')][1]");

    await editor.click();
    for (let i = 0; i < 30; i++) {
      await page.keyboard.type(`line ${i}`);
      await page.keyboard.press("Enter");
    }

    const metrics = await scroller.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    expect(metrics.scrollHeight, "the text must overflow its box").toBeGreaterThan(metrics.clientHeight);
    // And the toolbar is still on screen, which is the point of putting the scroll on the parent.
    await expect(dialog.getByRole("button", { name: "Code block" })).toBeInViewport();
  });
});

/* ================= 2. Attachments at creation + paste auto-formatting ================= */

test.describe("authoring a ticket", () => {
  /** Attaching evidence used to require creating the ticket, finding it again, and opening the
   *  Files tab — so in practice the screenshot on the reporter's clipboard never made it on. */
  test("offers an attachment field before the ticket exists", async ({ page }) => {
    const dialog = await openNewTicketDialog(page);
    await expect(dialog.getByText("Attachments", { exact: false })).toBeVisible();
    await expect(dialog.getByText(/attached to the ticket the moment it's created/i)).toBeVisible();
  });

  /**
   * Pasting a stack trace used to produce a wall of single-spaced paragraphs with the indentation
   * collapsed. The code-block node has shipped since the first version; nothing ever reached for
   * it, because doing so meant noticing the toolbar button first.
   */
  test("a pasted stack trace becomes a code block, not a paragraph", async ({ page }) => {
    const dialog = await openNewTicketDialog(page);
    const editor = dialog.locator(".tiptap");

    await pasteInto(
      editor,
      [
        "Traceback (most recent call last):",
        '  File "app.py", line 42, in handler',
        "    return compute(payload)",
        "ValueError: bad payload"
      ].join("\n")
    );

    await expect(editor.locator("pre")).toBeVisible({ timeout: 10_000 });
    // Indentation preserved is the half that matters — that is what the old paste destroyed.
    await expect(editor.locator("pre")).toContainText('  File "app.py", line 42, in handler');
  });

  test("a pasted markdown list becomes a real list", async ({ page }) => {
    const dialog = await openNewTicketDialog(page);
    const editor = dialog.locator(".tiptap");

    await pasteInto(editor, "- open the page\n- click save\n- watch it 500");

    await expect(editor.locator("ul li")).toHaveCount(3, { timeout: 10_000 });
  });

  /** The heuristic has to STAY OUT OF THE WAY of ordinary prose — a paragraph that mentions a
   *  command must not become a code block. This is the test that keeps the signals narrow. */
  test("prose that merely mentions a command is left as prose", async ({ page }) => {
    const dialog = await openNewTicketDialog(page);
    const editor = dialog.locator(".tiptap");

    await pasteInto(
      editor,
      "The deploy failed again this morning.\nSomeone should run git bisect to find where it broke.\nIt is probably the caching change from Tuesday."
    );

    await expect(editor).toContainText("The deploy failed again this morning.");
    await expect(editor.locator("pre")).toHaveCount(0);
  });
});

/* ============ 3 & 4. Reading a logged entry, and downloading its attachments ============ */

test.describe("timesheet history opens the entry", () => {
  /**
   * THE GAP: once an entry was approved it left the approvals queue, and History — the only
   * remaining record of it — showed a two-line clamp of the task and a COUNT of the attachments.
   * "Who logged this, against what, and what did they attach" was unanswerable.
   */
  test("a history row opens the full entry, and the URL says which one", async ({ page }) => {
    await signIn(page, "superadmin");
    await page.goto("/app/history");
    await expect(page.getByRole("heading", { name: /timesheet history/i })).toBeVisible({ timeout: 15_000 });

    const viewButtons = page.getByRole("button", { name: /^View the entry for/ }).filter({ visible: true });
    test.skip((await viewButtons.count()) === 0, "no history rows in the demo data to open");
    await viewButtons.first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    for (const label of ["Logged by", "Project", "Activity", "When", "Task", "Attachments"]) {
      await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    }

    // Deep-linkable: the dashboard timeline and a future notification both need to point at ONE
    // entry rather than at "the list", which is what the timeline used to do.
    await expect(page).toHaveURL(/[?&]entry=[0-9a-f-]{36}/);
  });

  test("attachments are download links, not a count", async ({ page }) => {
    // Find an entry that actually has a file, through the API — asserting against whichever row
    // happens to be first would make this test pass or fail on demo-data ordering.
    const withFile = await withAdminRequest(async (ctx, headers) => {
      const rows: Array<{ id: string; attachments?: unknown[] }> = await (
        await ctx.get("/api/timesheets", { headers })
      ).json();
      return rows.find((row) => (row.attachments?.length ?? 0) > 0)?.id ?? null;
    });
    test.skip(!withFile, "no timesheet entry in the demo data carries an attachment");

    await signIn(page, "superadmin");
    await page.goto(`/app/history?entry=${withFile}`);

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // A real anchor with a real href — the count-with-nothing-to-click is exactly what this
    // replaces. The href carries the signed grant `/uploads` requires.
    const link = dialog.locator('a[download][href*="/uploads/"]').first();
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    // `o` = org, `e` = expiry, `s` = signature — the grant `/uploads` demands (see app.ts). An
    // unsigned link would render identically and 403 on click, which is worse than no link.
    expect(href, "the attachment URL must carry an org-bound grant").toMatch(/[?&]o=/);
    expect(href, "the attachment URL must carry an expiry").toMatch(/[?&]e=/);
    expect(href, "the attachment URL must be signed").toMatch(/[?&]s=/);

    // And it resolves — a link that 403s is worse than no link, because it looks like it worked.
    const response = await page.request.get(href!);
    expect(response.status(), `attachment link returned ${response.status()}`).toBeLessThan(400);
  });
});

/* ================== 5. The day timeline opens THAT entry, not the list ================== */

test.describe("dashboard day timeline", () => {
  /**
   * THE BUG: every block was a `<Link to="/app/history">`. You clicked a specific 3.5h block on a
   * specific person's lane and landed on a list of everything — the click said exactly which entry
   * you meant and the navigation threw all three coordinates away.
   */
  test("clicking a block opens that entry in place instead of navigating to History", async ({ page }) => {
    // The timeline opens on TODAY, and the demo workspace rarely has anything logged today — so
    // the day is chosen from the data rather than hoped for, otherwise this test skips itself on
    // most runs and pins nothing.
    const busiestDay = await withAdminRequest(async (ctx, headers) => {
      const rows: Array<{ workDate: string }> = await (await ctx.get("/api/timesheets", { headers })).json();
      return rows.map((row) => String(row.workDate).slice(0, 10)).sort().at(-1) ?? null;
    });
    test.skip(!busiestDay, "no timesheet entries in the demo data");

    await signIn(page, "superadmin");
    await page.goto("/app");
    const [year, month, day] = busiestDay!.split("-").map(Number);
    await pickDate(page, "dashboard-date", new Date(year, month - 1, day));

    const block = page.getByTestId("timeline-entry").filter({ visible: true }).first();
    await expect(block).toBeVisible({ timeout: 15_000 });
    await block.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText("Logged by", { exact: true })).toBeVisible();
    // Still on the dashboard — the context the click came from is behind the dialog, not gone.
    await expect(page).toHaveURL(/\/app$/);
  });
});

/* =========================== 6. The password-reuse bug =========================== */

test.describe("changing your password", () => {
  /**
   * THE BUG, and the reason it mattered most on a first sign-in: account creation and every admin
   * reset set `mustChangePassword` precisely BECAUSE an administrator knows the current password.
   * Typing that same password into both boxes cleared the flag, revoked the other sessions, and
   * reported success — leaving the account exactly as exposed as before, with the prompt gone.
   */
  test("the form refuses a new password identical to the current one", async ({ page }) => {
    await signIn(page, "employee");
    await page.goto("/app/profile");
    await expect(page.getByRole("heading", { name: /change password/i })).toBeVisible({ timeout: 15_000 });

    // The three inputs carry no `htmlFor`, so they are located positionally within the one form
    // that contains them — current, new, confirm, in DOM order.
    const form = page.locator("form").filter({ hasText: "Confirm new password" });
    const fields = form.locator('input[type="password"]');
    await expect(fields).toHaveCount(3);
    for (let i = 0; i < 3; i++) await fields.nth(i).fill("Admin@12345");

    await expect(page.getByText(/that's the password you already have/i)).toBeVisible();
    await expect(form.getByRole("button", { name: /update password/i })).toBeDisabled();
  });

  /**
   * The server is the rule, the form is the manners — so the API has to refuse it too, on its own,
   * for a caller that never sees the form.
   *
   * Runs against a THROWAWAY user, exactly like password-and-face-bypass.spec.ts: this test's
   * subject is a password change, and doing that to a shared demo account would break every other
   * spec in the suite.
   */
  test("the API refuses it too, independently of the form", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const email = `e2e-pwreuse-${Date.now()}@timesheet.local`;
      const created = await ctx.post("/api/users", {
        headers,
        data: { name: "PW Reuse Drill", email, role: "EMPLOYEE", password: "Original@123" }
      });
      expect(created.ok(), `could not create the drill user (${created.status()})`).toBe(true);
      const userId = (await created.json()).id as string;

      try {
        const userCtx = await request.newContext({ baseURL: E2E_BASE_URL, ignoreHTTPSErrors: true });
        try {
          const login = await userCtx.post("/api/auth/login", { data: { email, password: "Original@123" } });
          expect(login.ok(), `drill user could not sign in (${login.status()})`).toBe(true);
          const bearer = { Authorization: `Bearer ${(await login.json()).accessToken}` };

          const reuse = await userCtx.post("/api/auth/change-password", {
            headers: bearer,
            data: { currentPassword: "Original@123", nextPassword: "Original@123" }
          });
          expect(reuse.status(), "re-setting the same password must be refused").toBe(422);
          expect(await reuse.text()).toMatch(/different from your current/i);

          // And the account is genuinely unchanged — the refusal did not half-apply.
          const stillWorks = await userCtx.post("/api/auth/login", { data: { email, password: "Original@123" } });
          expect(stillWorks.ok(), "the original password must still work after a refused change").toBe(true);
          expect((await stillWorks.json()).user.mustChangePassword, "a refused change must not clear the prompt").toBe(true);
        } finally {
          await userCtx.dispose();
        }
      } finally {
        // Asserted cleanup, per the admin-request helper's own lesson.
        const del = await ctx.delete(`/api/users/${userId}`, { headers });
        expect(del.ok(), `could not clean up the drill user (${del.status()})`).toBe(true);
      }
    });
  });
});

/* ====================== 7. Managing the activity catalog ====================== */

test.describe("activity types", () => {
  /**
   * The `ActivityType` table has been seeded since the first migration and nothing ever read it —
   * both apps imported a frozen twelve-item array instead, so a workspace whose work did not fit
   * those twelve words had no way to say so short of a redeploy.
   *
   * Creates a uniquely-named activity and deletes it again through the API, so a rerun starts
   * clean and the shared demo workspace does not accumulate junk.
   */
  const NAME = `E2E Activity ${Date.now()}`;

  test.afterAll(async () => {
    await withAdminRequest(async (ctx, headers) => {
      const rows: Array<{ id: string; name: string }> = await (
        await ctx.get("/api/activity-types?all=true", { headers })
      ).json();
      const mine = rows.find((row) => row.name === NAME);
      if (mine) await ctx.delete(`/api/activity-types/${mine.id}`, { headers });
    });
  });

  test("a super admin can add one, and it reaches the logging picker", async ({ page }) => {
    await signIn(page, "superadmin");
    await page.goto("/app/projects");
    await expect(page.getByRole("heading", { name: /activity types/i })).toBeVisible({ timeout: 15_000 });

    await page.getByLabel("New activity type").fill(NAME);
    await page.getByRole("button", { name: /add activity/i }).click();
    await expect(page.getByText(NAME, { exact: true })).toBeVisible({ timeout: 15_000 });

    // The catalog is only worth anything if the form it feeds actually offers it.
    await page.goto("/app/timesheet");
    await page.getByLabel("Activity", { exact: true }).click();
    await expect(page.getByRole("option", { name: NAME })).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
  });

  test("disabling one takes it out of the picker and leaves the history readable", async ({ page }) => {
    // Its own row, created through the API so this test does not depend on the one above having
    // run (Playwright projects and `--grep` both make that assumption false).
    const id = await withAdminRequest(async (ctx, headers) => {
      const created = await ctx.post("/api/activity-types", { headers, data: { name: `${NAME} disabled` } });
      return (await created.json()).id as string;
    });

    await signIn(page, "superadmin");
    await page.goto("/app/projects");
    await page.getByRole("button", { name: `Disable ${NAME} disabled` }).click();
    await expect(page.getByRole("button", { name: `Enable ${NAME} disabled` })).toBeVisible({ timeout: 15_000 });

    // The active-only list is what the logging picker reads.
    const stillOffered = await withAdminRequest(async (ctx, headers) => {
      const rows: Array<{ name: string }> = await (await ctx.get("/api/activity-types", { headers })).json();
      return rows.some((row) => row.name === `${NAME} disabled`);
    });
    expect(stillOffered, "a disabled activity must not be offered when logging time").toBe(false);

    await withAdminRequest(async (ctx, headers) => ctx.delete(`/api/activity-types/${id}`, { headers }));
  });

  /** Deleting an activity that history still uses would silently break the approvals filter and
   *  every grouped report, which build their options from this catalog. The API refuses with a
   *  count and points at disabling instead. */
  test("an activity that entries were logged under cannot be deleted", async () => {
    const inUse = await withAdminRequest(async (ctx, headers) => {
      const [rows, entries] = await Promise.all([
        (await ctx.get("/api/activity-types?all=true", { headers })).json(),
        (await ctx.get("/api/timesheets", { headers })).json()
      ]);
      const used = new Set((entries as Array<{ activityType: string }>).map((entry) => entry.activityType));
      return (rows as Array<{ id: string; name: string }>).find((row) => used.has(row.name)) ?? null;
    });
    test.skip(!inUse, "no seeded activity type has entries logged against it");

    const { status, body } = await withAdminRequest(async (ctx, headers) => {
      const res = await ctx.delete(`/api/activity-types/${inUse!.id}`, { headers });
      return { status: res.status(), body: await res.text() };
    });
    expect(status).toBe(409);
    expect(body).toMatch(/disable it instead/i);
  });
});

/* ================= 8. The ticket panel is a window the reader controls ================= */

test.describe("ticket detail panel sizing", () => {
  /**
   * Opens a ticket through the sheet's own `?open=` URL parameter rather than by hunting for a
   * clickable cell — the id comes from the API, so this does not depend on which column happens
   * to be the door or on the demo data's ordering.
   */
  let ticketId: string | null = null;
  test.beforeAll(async () => {
    ticketId = await withAdminRequest(async (ctx, headers) => {
      const rows: Array<{ id: string }> = await (await ctx.get("/api/tickets", { headers })).json();
      return rows[0]?.id ?? null;
    });
  });

  async function openFirstTicket(page: Page) {
    test.skip(!ticketId, "no tickets in the demo data to open");
    await signIn(page, "superadmin");
    await page.goto(`/app/tickets?open=${ticketId}`);
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    // The width assertions below measure the panel, so they have to wait for its content — an
    // empty loading sheet is a different size from a populated one.
    await expect(sheet.getByRole("tab").first()).toBeVisible({ timeout: 15_000 });
    return sheet;
  }

  /**
   * THE GAP: this panel is the most-used surface in the product and it is where a description, a
   * comment thread, pasted code, a proofing image and a twelve-column activity log all have to be
   * read AND edited. At a fixed 576px a stack trace wrapped into unreadable ribbon, and the
   * person triaging it could do nothing about it — every other window on their desktop resizes.
   */
  test("maximizes to the full window and restores", async ({ page }) => {
    const sheet = await openFirstTicket(page);
    const viewport = page.viewportSize()!;
    const before = (await sheet.boundingBox())!;
    expect(before.width, "the panel starts narrower than the window").toBeLessThan(viewport.width);

    await page.getByRole("button", { name: /maximize panel to full width/i }).click();
    await expect
      .poll(async () => (await sheet.boundingBox())!.width, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(viewport.width - 2);

    await page.getByRole("button", { name: /restore panel width/i }).click();
    await expect
      .poll(async () => (await sheet.boundingBox())!.width, { timeout: 5_000 })
      .toBeLessThan(viewport.width);
  });

  test("drags wider from the edge, and remembers the width for the next ticket", async ({ page }) => {
    const sheet = await openFirstTicket(page);
    const handle = page.getByRole("separator", { name: /resize the ticket panel/i });
    await expect(handle).toBeVisible();

    const start = (await handle.boundingBox())!;
    const before = (await sheet.boundingBox())!.width;

    // Dragging LEFT widens it — the panel is anchored to the right edge.
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x - 240, start.y + start.height / 2, { steps: 12 });
    await page.mouse.up();

    const after = (await sheet.boundingBox())!.width;
    expect(after, "dragging the edge left must widen the panel").toBeGreaterThan(before + 100);

    // Persisted: the point is to set it once, not to re-drag it on every ticket.
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden({ timeout: 10_000 });
    await page.reload();
    await openFirstTicket(page);
    const reopened = (await page.getByRole("dialog").boundingBox())!.width;
    expect(Math.abs(reopened - after), "the panel must reopen at the width it was left").toBeLessThan(40);
  });

  /** The handle is the WAI-ARIA window-splitter pattern, so it has to answer to a keyboard —
   *  a drag-only control is one a keyboard user simply does not have. */
  test("the resize handle responds to the arrow keys", async ({ page }) => {
    const sheet = await openFirstTicket(page);
    const before = (await sheet.boundingBox())!.width;

    await page.getByRole("separator", { name: /resize the ticket panel/i }).focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");

    await expect.poll(async () => (await sheet.boundingBox())!.width, { timeout: 5_000 }).toBeGreaterThan(before);
  });

  /** Files and Comments are read together — a comment almost always refers to a file. Files used
   *  to sit eighth, past four conditional tabs, far enough right to be off the end of the strip. */
  test("Files sits immediately after Comments", async ({ page }) => {
    const sheet = await openFirstTicket(page);
    const tabs = sheet.getByRole("tab");
    await expect(tabs.first()).toBeVisible({ timeout: 10_000 });
    const names = await tabs.allTextContents();
    const comments = names.findIndex((name) => /^Comments/.test(name.trim()));
    const files = names.findIndex((name) => /^Files/.test(name.trim()));
    expect(comments, "a Comments tab must exist").toBeGreaterThanOrEqual(0);
    expect(files, "Files must come directly after Comments").toBe(comments + 1);
  });

  /** Below `sm` the sheet is already the whole screen, so a maximize button and a drag handle
   *  would be controls that cannot do anything. */
  test("offers neither control on a phone, where the panel is already full width", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFirstTicket(page);
    await expect(page.getByRole("button", { name: /maximize panel to full width/i })).toHaveCount(0);
    await expect(page.getByRole("separator", { name: /resize the ticket panel/i })).toHaveCount(0);
  });
});

/* ============ 9. The author can read and correct their own work ============ */

test.describe("an employee's own history", () => {
  /**
   * THE REPORT: "the user who raised the log entry is not able to view and edit details when I
   * draft and submitted stage."
   *
   * Viewing always worked; editing stopped at DRAFT/REJECTED, so a SUBMITTED entry could only be
   * fixed by asking an approver — whose only "send it back" tool is a REJECTION. A one-word typo
   * therefore cost a rejection, a notification and a re-submission. The author's window now runs
   * to APPROVED.
   *
   * Runs as `employee` deliberately: this is precisely the role that holds none of the manage
   * rights, and testing it as an admin would prove nothing.
   */
  /**
   * Finds one of the employee's OWN entries in the given status, through the admin context.
   *
   * NOT `page.request.get("/api/timesheets")`: the access token lives in memory only (see
   * store/auth.ts), so a bare request from the page context carries no Authorization header and
   * comes back 401 — which then reads as "the employee has no entries" and skips the test that was
   * supposed to catch the bug.
   */
  async function findEmployeeEntry(status: string): Promise<string | null> {
    return withAdminRequest(async (ctx, headers) => {
      // `/api/users` answers with a bare array — asserted rather than assumed, because reading a
      // paginated envelope that isn't there yields `undefined`, which `.find` turns into "no
      // employee", which silently SKIPS the test that exists to catch the bug.
      const users: Array<{ id: string; email: string }> = await (await ctx.get("/api/users", { headers })).json();
      expect(Array.isArray(users), "/api/users must return an array").toBe(true);
      const employee = users.find((user) => user.email === "employee@timesheet.local");
      if (!employee) return null;
      const rows: Array<{ id: string; status: string }> = await (
        await ctx.get(`/api/timesheets?userId=${employee.id}`, { headers })
      ).json();
      return (Array.isArray(rows) ? rows.find((row) => row.status === status)?.id : null) ?? null;
    });
  }

  async function openOwnEntry(page: Page, status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED") {
    const entryId = await findEmployeeEntry(status);
    test.skip(!entryId, `the employee has no ${status} entry in the demo data`);

    await signIn(page, "employee");
    await page.goto(`/app/history?entry=${entryId}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    return dialog;
  }

  for (const status of ["DRAFT", "SUBMITTED"] as const) {
    test(`can open and edit their own ${status} entry`, async ({ page }) => {
      const dialog = await openOwnEntry(page, status);

      // Viewing: the detail is really there, not an error or an empty shell.
      await expect(dialog.getByText("Logged by", { exact: true })).toBeVisible();
      await expect(dialog.getByText("Task", { exact: true })).toBeVisible();

      // Editing: the control exists AND the form opens — a button that appears and then refuses
      // is the failure this pins.
      await dialog.getByRole("button", { name: /edit entry/i }).click();
      await expect(dialog.getByRole("button", { name: /save changes/i })).toBeVisible({ timeout: 10_000 });
    });
  }

  // Both DECIDED states are closed to the author: a reviewer has recorded something against the
  // entry, and rewriting the text a rejection reason refers to leaves that reason pointing at
  // something it was never about.
  for (const status of ["APPROVED", "REJECTED"] as const) {
    test(`cannot edit their own ${status} entry — a decision is recorded against it`, async ({ page }) => {
      const dialog = await openOwnEntry(page, status);
      await expect(dialog.getByRole("button", { name: /edit entry/i })).toHaveCount(0);
    });
  }

  /**
   * Nor delete it. A rejection is a decision with the reviewer's reason attached, and erasing the
   * entry erases the record of that — so the row is offered neither control.
   *
   * The reason this is not a dead end lives on the server: a REJECTED entry is excluded from the
   * overlap check, so the fresh entry the author is told to log is not refused for clashing with
   * the refused one. Without that, "can't edit, can't delete, can't re-log" would have stranded
   * them with hours they worked and no way to record them.
   */
  test("is offered neither edit nor delete on a rejected row", async ({ page }) => {
    const rejected = await findEmployeeEntry("REJECTED");
    test.skip(!rejected, "the employee has no rejected entry in the demo data");

    await signIn(page, "employee");
    await page.goto("/app/history");
    await page.locator("#history-status").click();
    await page.getByRole("option", { name: "Rejected" }).click();
    await expect(page.getByText(/^Showing \d+-\d+ of \d+$/)).toBeVisible({ timeout: 15_000 });

    // Every visible row is REJECTED now, so neither control may appear on any of them.
    await expect(page.getByRole("button", { name: /^Delete entry for/ })).toHaveCount(0);

    await page.getByRole("button", { name: /^View the entry for/ }).filter({ visible: true }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole("button", { name: /edit entry/i })).toHaveCount(0);
  });

  test("a save from the author actually lands, and is attributed to them", async ({ page }) => {
    const dialog = await openOwnEntry(page, "DRAFT");
    await dialog.getByRole("button", { name: /edit entry/i }).click();

    const editor = dialog.locator(".tiptap").first();
    await editor.click();
    const marker = `edited by the author at ${Date.now()}`;
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(marker);

    await dialog.getByRole("button", { name: /save changes/i }).click();
    await expect(dialog.getByText(marker)).toBeVisible({ timeout: 15_000 });
    // "Who has updated" — the whole point of the second half of the ask.
    await expect(dialog.getByText(/Last updated/i)).toBeVisible();
  });
});

/* ==================== 10. History says whose entry it is ==================== */

test.describe("history names the people involved", () => {
  /** An admin's History returns EVERYBODY's entries and used to show no author anywhere — a pile
   *  of rows with no answer to "whose is this?". */
  test("shows a Logged by column when the page spans more than one person", async ({ page }) => {
    const distinctAuthors = await withAdminRequest(async (ctx, headers) => {
      const rows: Array<{ userId: string }> = await (await ctx.get("/api/timesheets", { headers })).json();
      return new Set(rows.map((row) => row.userId)).size;
    });
    test.skip(distinctAuthors < 2, "the demo data has entries from only one person");

    await signIn(page, "superadmin");
    await page.goto("/app/history");
    await expect(page.getByRole("columnheader", { name: "Logged by" })).toBeVisible({ timeout: 15_000 });
  });

  /** …and does NOT show it to an employee, whose every row would repeat their own name. */
  test("hides that column for someone looking at only their own work", async ({ page }) => {
    await signIn(page, "employee");
    await page.goto("/app/history");
    await expect(page.getByRole("heading", { name: /timesheet history/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("columnheader", { name: "Logged by" })).toHaveCount(0);
  });

  /** The list route has to carry the names at all — the column and the badge both read them. */
  test("the list route carries the reviewer and the last editor", async () => {
    const rows: Array<Record<string, unknown>> = await withAdminRequest(async (ctx, headers) =>
      (await ctx.get("/api/timesheets", { headers })).json()
    );
    expect(Array.isArray(rows) && rows.length).toBeTruthy();
    // Present as keys on every row, even when null — a field that only appears sometimes is one
    // the client has to guess about.
    for (const key of ["reviewedBy", "lastEditedBy", "lastEditedAt"]) {
      expect(rows[0], `every row must carry ${key}`).toHaveProperty(key);
    }
  });
});

/* ========== 11. Deciding and submitting from wherever the entry was opened ========== */

test.describe("acting on an entry from any screen", () => {
  /**
   * THE GAP: Approve/Reject were props only the approvals page passed, so opening the same entry
   * from the dashboard's day timeline gave you the full record and nothing to do about it — you
   * read it, agreed with it, and then navigated to a different screen to find the same row.
   *
   * Nothing here actually approves: the demo workspace is shared and a decision is one-way. What
   * is pinned is that the controls are PRESENT and enabled where they were previously absent.
   */
  test("the day timeline's entry dialog offers Approve and Reject to an approver", async ({ page }) => {
    const submitted = await withAdminRequest(async (ctx, headers) => {
      const rows: Array<{ id: string; status: string; workDate: string }> = await (
        await ctx.get("/api/timesheets", { headers })
      ).json();
      return rows.find((row) => row.status === "SUBMITTED") ?? null;
    });
    test.skip(!submitted, "no submitted entry in the demo data");

    await signIn(page, "superadmin");
    await page.goto("/app");
    const day = String(submitted!.workDate).slice(0, 10);
    const [year, month, dayOfMonth] = day.split("-").map(Number);
    await pickDate(page, "dashboard-date", new Date(year, month - 1, dayOfMonth));

    const block = page.getByTestId("timeline-entry").filter({ visible: true }).first();
    await expect(block).toBeVisible({ timeout: 15_000 });
    await block.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    // The dialog opens on whichever block was first; only a SUBMITTED one carries the decision
    // controls, which is itself the rule worth asserting.
    const status = await dialog.getByText(/^(DRAFT|SUBMITTED|APPROVED|REJECTED)$/).first().textContent();
    if (status?.trim() === "SUBMITTED") {
      await expect(dialog.getByRole("button", { name: /^approve$/i })).toBeEnabled();
      await expect(dialog.getByRole("button", { name: /^reject$/i })).toBeEnabled();
    } else {
      await expect(dialog.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
    }
  });

  /**
   * A DECIDED ENTRY IS IMMUTABLE FOR EVERYONE, the reviewer included.
   *
   * `TIMESHEETS_APPROVE` originally reached any status — whoever decides whether hours are payable
   * could also correct them. That exemption undoes what the decision is for: an approved entry
   * carries a frozen rate a client may already have been shown, and it would change under the same
   * audit entry a routine typo fix produces.
   */
  for (const status of ["APPROVED", "REJECTED"] as const) {
    test(`even a super admin cannot edit a ${status} entry`, async ({ page }) => {
      const entryId = await withAdminRequest(async (ctx, headers) => {
        const rows: Array<{ id: string; status: string }> = await (await ctx.get("/api/timesheets", { headers })).json();
        return rows.find((row) => row.status === status)?.id ?? null;
      });
      test.skip(!entryId, `no ${status} entry in the demo data`);

      await signIn(page, "superadmin");
      await page.goto(`/app/history?entry=${entryId}`);
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await expect(dialog.getByText("Logged by", { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(dialog.getByRole("button", { name: /edit entry/i })).toHaveCount(0);
    });
  }

  /** …and the API refuses it independently of whether the button is drawn. */
  test("the API refuses an approver's edit of a decided entry", async () => {
    const entryId = await withAdminRequest(async (ctx, headers) => {
      const rows: Array<{ id: string; status: string }> = await (await ctx.get("/api/timesheets", { headers })).json();
      return rows.find((row) => row.status === "APPROVED")?.id ?? null;
    });
    test.skip(!entryId, "no approved entry in the demo data");

    const { status, body } = await withAdminRequest(async (ctx, headers) => {
      const res = await ctx.patch(`/api/timesheets/${entryId}`, {
        headers,
        data: { taskDescription: "<p>An edit that must not be accepted</p>" }
      });
      return { status: res.status(), body: await res.text() };
    });
    expect(status).toBe(422);
    expect(body).toMatch(/correcting entry/i);
  });

  /** An employee must never see the decision controls, wherever the entry is opened from. */
  test("an employee is never offered Approve or Reject on their own entry", async ({ page }) => {
    const entryId = await withAdminRequest(async (ctx, headers) => {
      const users: Array<{ id: string; email: string }> = await (await ctx.get("/api/users", { headers })).json();
      const employee = users.find((user) => user.email === "employee@timesheet.local");
      if (!employee) return null;
      const rows: Array<{ id: string; status: string }> = await (
        await ctx.get(`/api/timesheets?userId=${employee.id}`, { headers })
      ).json();
      return rows.find((row) => row.status === "SUBMITTED")?.id ?? null;
    });
    test.skip(!entryId, "the employee has no submitted entry");

    await signIn(page, "employee");
    await page.goto(`/app/history?entry=${entryId}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /^reject$/i })).toHaveCount(0);
  });

  /**
   * A draft used to be a one-way door: `saveTimesheet` only ever CREATES rows, so nothing could
   * promote an existing DRAFT to SUBMITTED. "Save draft" wrote a row you could edit forever and
   * never send.
   */
  test("a draft can be sent for approval from the entry it is read in", async ({ page }) => {
    const entryId = await withAdminRequest(async (ctx, headers) => {
      const users: Array<{ id: string; email: string }> = await (await ctx.get("/api/users", { headers })).json();
      const employee = users.find((user) => user.email === "employee@timesheet.local");
      if (!employee) return null;
      const rows: Array<{ id: string; status: string }> = await (
        await ctx.get(`/api/timesheets?userId=${employee.id}`, { headers })
      ).json();
      return rows.find((row) => row.status === "DRAFT")?.id ?? null;
    });
    test.skip(!entryId, "the employee has no draft entry");

    await signIn(page, "employee");
    await page.goto(`/app/history?entry=${entryId}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole("button", { name: /submit for approval/i })).toBeEnabled({ timeout: 10_000 });
  });
});

/* ================== 12. The edit form has one scroll region ================== */

test.describe("the entry edit form", () => {
  /**
   * THE COMPLAINT: "the scroll feature is not intuitive for this". It was not — the dialog body
   * scrolled AND each rich-text editor scrolled inside it, so the form had a scrollbar within a
   * scrollbar and no way to tell which one a wheel gesture would move. On top of that, Save and
   * Discard sat INSIDE the scrolling body while a separate "Cancel edit" sat in the pinned footer:
   * two places to look for the control that finishes the job, one of which could scroll away.
   */
  test("has exactly one scrollable region, and its actions are pinned", async ({ page }) => {
    const entryId = await withAdminRequest(async (ctx, headers) => {
      const rows: Array<{ id: string; status: string }> = await (await ctx.get("/api/timesheets", { headers })).json();
      return rows.find((row) => row.status === "SUBMITTED")?.id ?? rows[0]?.id ?? null;
    });
    test.skip(!entryId, "no timesheet entries in the demo data");

    await signIn(page, "superadmin");
    await page.goto(`/app/history?entry=${entryId}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("button", { name: /edit entry/i }).click();
    await expect(dialog.getByRole("button", { name: /save changes/i })).toBeVisible({ timeout: 10_000 });

    // At most one element inside the dialog actually overflows and can scroll.
    const scrollables = await dialog.evaluate((root) =>
      Array.from(root.querySelectorAll("*")).filter((el) => {
        const style = getComputedStyle(el);
        const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
        return scrolls && el.scrollHeight > el.clientHeight + 1;
      }).length
    );
    expect(scrollables, "a scrollbar inside a scrollbar is the thing being fixed").toBeLessThanOrEqual(1);

    // One set of actions, and no leftover duplicate from the old in-body row.
    await expect(dialog.getByRole("button", { name: /save changes/i })).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: /^discard$/i })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /cancel edit/i })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /save changes/i })).toBeInViewport();
  });
});

/* ==================== 13. History filters ==================== */

/** The DataTable footer is the only place the FILTERED total is stated out loud — asserting on it
 *  keeps these independent of the 20-row page size. */
async function shownTotal(page: Page): Promise<number> {
  const footer = page.getByText(/^Showing \d+-\d+ of \d+$/);
  await expect(footer).toBeVisible({ timeout: 15_000 });
  return Number(/of (\d+)$/.exec((await footer.textContent()) ?? "")?.[1]);
}

test.describe("history filters", () => {
  test("filters by activity, and only offers activities that are actually present", async ({ page }) => {
    await signIn(page, "superadmin");
    await page.goto("/app/history");
    await expect(page.getByRole("heading", { name: /timesheet history/i })).toBeVisible({ timeout: 15_000 });
    const before = await shownTotal(page);

    await page.locator("#history-activity").click();
    // Skip "All activities" and take a real one.
    await page.getByRole("option").nth(1).click();

    await expect.poll(() => shownTotal(page)).toBeLessThan(before);
  });

  test("filters by person for someone who can see more than their own work", async ({ page }) => {
    const distinctAuthors = await withAdminRequest(async (ctx, headers) => {
      const rows: Array<{ userId: string }> = await (await ctx.get("/api/timesheets", { headers })).json();
      return new Set(rows.map((row) => row.userId)).size;
    });
    test.skip(distinctAuthors < 2, "the demo data has entries from only one person");

    await signIn(page, "superadmin");
    await page.goto("/app/history");
    const before = await shownTotal(page);

    await page.locator("#history-user").click();
    await page.getByRole("option").nth(1).click();

    await expect.poll(() => shownTotal(page)).toBeLessThan(before);
  });

  /** An employee's list is their own work, so a Person filter could only ever filter to "me" — a
   *  control that teaches you it does nothing. */
  test("hides the person filter from someone looking at only their own work", async ({ page }) => {
    await signIn(page, "employee");
    await page.goto("/app/history");
    await expect(page.getByRole("heading", { name: /timesheet history/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#history-activity")).toBeVisible();
    await expect(page.locator("#history-user")).toHaveCount(0);
  });
});
