/**
 * D02's other half, and B05's last one: the matrix the plan asked for — light and dark, every
 * accent, keyboard, reduced motion, touch — asked as one set of questions rather than piecemeal.
 *
 * WHY THIS IS NOT COVERED BY `npm run check:contrast`: that script reads the palettes and
 * index.css and does the colour arithmetic on the TOKENS. It is the right gate and it is fast, but
 * a token that never reaches a pixel passes it. Every accent here is driven through the app's own
 * boot path and then measured on the RENDERED element, so a broken wiring between "the preference
 * is saved" and "the button is that colour" fails here and nowhere else.
 *
 * WHY THE ACCENT IS SEEDED IN localStorage RATHER THAN CLICKED: `theme.ts` reads the stored accent
 * at boot and paints `--primary` / `--primary-foreground` / `--ring` as inline variables. Setting
 * `data-accent` by hand would prove nothing, because that attribute is a MIRROR of the paint, not
 * its cause. Seeding the key the app itself reads exercises the real path and leaves the database
 * alone. It has to be an account with no SAVED appearance, or the profile adopted at sign-in
 * overwrites it — `manager` is such an account, `superadmin` deliberately is not.
 *
 * These set their own viewport, so they cost one run inside whichever project executes this file
 * rather than more projects in the CI matrix (see the budget note at the top of ci.yml).
 */
import { expect, test, type Page } from "@playwright/test";

const ACCENTS = ["teal", "indigo", "violet", "rose", "amber", "emerald", "sky"] as const;

async function signIn(page: Page, who: "manager" | "superadmin") {
  await page.goto("/login");
  await page.getByLabel("Email", { exact: true }).fill(`${who}@timesheet.local`);
  await page.getByLabel("Password", { exact: true }).fill("Admin@12345");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

/**
 * Switch appearance the way the app itself does, WITHOUT signing in again.
 *
 * Signing in per combination does not work and the reason is worth writing down: once there is a
 * session, `/login` redirects straight to `/app`, so the second visit finds no form and the test
 * hangs waiting for an email field that will never come. A reload is also what actually exercises
 * the path under test — `theme.ts` reads these keys at BOOT.
 */
async function wearAppearance(page: Page, theme: "light" | "dark", accent?: string) {
  await page.evaluate(
    ([t, a]) => {
      try {
        localStorage.setItem("timesheet:theme", t);
        if (a) localStorage.setItem("timesheet:accent", a);
      } catch {
        /* blocked storage leaves the default, which the assertions below would catch */
      }
    },
    [theme, accent ?? ""] as [string, string]
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
}

test.describe("every accent reaches the pixels, in both themes", () => {
  test("a primary button is painted by the chosen accent and its label stays legible", async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 1366, height: 768 });
    const seen = new Map<string, string>();
    await signIn(page, "manager");

    for (const theme of ["light", "dark"] as const) {
      for (const accent of ACCENTS) {
        await wearAppearance(page, theme, accent);

        const painted = await page.evaluate(() => {
          const root = document.documentElement;
          const cs = getComputedStyle(root);
          return {
            accentAttr: root.dataset.accent ?? null,
            dark: root.classList.contains("dark"),
            primary: cs.getPropertyValue("--primary").trim(),
            foreground: cs.getPropertyValue("--primary-foreground").trim(),
            ring: cs.getPropertyValue("--ring").trim()
          };
        });

        expect(painted.accentAttr, `${theme}/${accent}: the accent the app says it is`).toBe(accent);
        expect(painted.dark, `${theme}/${accent}: the theme the app says it is`).toBe(theme === "dark");
        // The paint is what this test exists for: --primary must be SET, and --ring must follow it.
        expect(painted.primary, `${theme}/${accent}: --primary was never painted`).not.toBe("");
        expect(painted.ring, `${theme}/${accent}: --ring did not follow the accent`).toBe(painted.primary);
        expect(painted.foreground, `${theme}/${accent}: --primary-foreground was never painted`).not.toBe("");

        // ...and every accent must paint something DIFFERENT, or a broken switch would pass all
        // seven by leaving the default in place.
        const key = `${theme}:${painted.primary}`;
        expect(seen.has(key), `${theme}/${accent} painted the same --primary as ${seen.get(key)}`).toBe(false);
        seen.set(key, `${theme}/${accent}`);
      }
    }
    // Fourteen distinct paints, or the loop silently did nothing.
    expect(seen.size).toBe(ACCENTS.length * 2);
  });

  test("a real primary button clears AA against its own label, in both themes", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await signIn(page, "manager");
    await page.goto("/app/timesheet");
    for (const theme of ["light", "dark"] as const) {
      await wearAppearance(page, theme);
      await page.waitForLoadState("networkidle");

      const worst = await page.evaluate(() => {
        // WCAG relative luminance, on the colours the browser actually painted.
        const rgb = (value: string): number[] | null => {
          const m = String(value).match(/[\d.]+/g);
          return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : null;
        };
        const lum = (c: number[]) => {
          const f = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
          return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
        };
        const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
        let found = 0;
        let lowest = { ratio: 99, label: "" };
        for (const el of document.querySelectorAll("button, [role='button'], a")) {
          const cs = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          if (box.width < 40 || box.height < 16 || cs.visibility === "hidden" || cs.display === "none") continue;
          const bg = rgb(cs.backgroundColor);
          const fg = rgb(cs.color);
          // Only solid controls: a transparent background inherits the surface and is measured by
          // the token gate instead. This test is about controls the accent actually fills.
          if (!bg || !fg || cs.backgroundColor.includes("rgba(0, 0, 0, 0)")) continue;
          const alpha = Number(String(cs.backgroundColor).match(/[\d.]+/g)?.[3] ?? "1");
          if (alpha < 0.95) continue;
          found += 1;
          const r = ratio(bg, fg);
          if (r < lowest.ratio) lowest = { ratio: Number(r.toFixed(2)), label: `${el.tagName.toLowerCase()} "${(el.textContent || "").trim().slice(0, 40)}" bg ${cs.backgroundColor} fg ${cs.color}` };
        }
        return { found, lowest };
      });

      // A test that measured nothing is not a passing test.
      expect(worst.found, `${theme}: no solid controls were measured`).toBeGreaterThan(2);
      expect(worst.lowest.ratio, `${theme}: lowest-contrast control — ${worst.lowest.label}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("nothing is still animating once the page has settled", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await signIn(page, "manager");
    for (const path of ["/app", "/app/tickets", "/app/timesheet"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1200);
      const running = await page.evaluate(() =>
        document
          .getAnimations()
          .filter((a) => a.playState === "running")
          .map((a) => {
            const target = (a as unknown as { effect?: { target?: Element } }).effect?.target;
            const cls = target ? String(target.className).split(/\s+/).slice(0, 3).join(".") : "?";
            return `${(a as unknown as { animationName?: string }).animationName ?? a.constructor.name} on ${target?.tagName.toLowerCase() ?? "?"}.${cls}`;
          })
      );
      expect(running, `${path} is still animating under prefers-reduced-motion`).toEqual([]);
    }
  });
});

test.describe("touch", () => {
  /**
   * The bottom navigation, at a phone's width, with the 44px minimum applied to the thing a phone
   * user touches more than anything else.
   *
   * DELIBERATELY NOT A BLANKET SWEEP. Measured across four pages at 390px, the controls under 44px
   * are: this bar (41px, which is the bug this test exists for — the V12 touch pass raised the
   * primitives and never reached it), the rich-text toolbar's 32px icon buttons and the compact
   * table controls, both of which that pass recorded as deliberate, and a couple of 1px native
   * `select`/`input` elements that sit hidden behind custom controls and are not touch targets at
   * all. Asserting 44px over all of them would fail for reasons already decided against, and a
   * test whose failures are expected gets ignored. This one asks about the bar.
   */
  test("the phone navigation bar meets the 44px minimum", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, "manager");
    await page.goto("/app/tickets");
    await page.waitForLoadState("networkidle");

    const measured = await page.evaluate(() => {
      const bar = document.querySelector("nav.fixed.inset-x-0.bottom-0");
      if (!bar) return null;
      return [...bar.querySelectorAll("a")].map((a) => {
        const b = a.getBoundingClientRect();
        return { label: (a.textContent || "").trim().slice(0, 20), w: Math.round(b.width), h: Math.round(b.height) };
      });
    });

    expect(measured, "the phone navigation bar was not found at 390px").not.toBeNull();
    expect(measured!.length, "the navigation bar had no destinations in it").toBeGreaterThan(2);
    for (const item of measured!) {
      expect(item.h, `"${item.label}" is ${item.h}px tall`).toBeGreaterThanOrEqual(44);
      expect(item.w, `"${item.label}" is ${item.w}px wide`).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("keyboard", () => {
  test("the settings board opens a folded section without a pointer, and every stop shows focus", async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 1366, height: 768 });
    await signIn(page, "superadmin");
    await page.goto("/app/settings");
    await page.waitForLoadState("networkidle");

    /**
     * Record how every control looks while NOTHING is focused, before a single Tab is pressed.
     *
     * THREE earlier versions of this check were worthless, and each looked reasonable:
     *   1. "does the focused element have an outline or a box-shadow" — passes with the ring
     *      deleted from index.css, because half these controls carry a resting shadow anyway.
     *   2. before/after around a programmatic `el.focus()` — passes too, because programmatic focus
     *      does not reliably match `:focus-visible`, so the browser's OWN default ring appears and
     *      masks the missing one.
     *   3. real keyboard focus, but asking only whether the computed style CHANGED — passes as
     *      well, because a control whose ring has been removed still computes
     *      `outline: 2px solid transparent`. Different from resting, and invisible.
     * So the question has to be whether what appears can actually be SEEN: an outline that is
     * drawn and not transparent, or a box-shadow that was not there at rest. Each version above
     * was caught by deleting the ring from `.focus-ring` and re-running; only this one goes red.
     */
    await page.evaluate(() => {
      const w = window as unknown as { __resting: Record<string, string> };
      w.__resting = {};
      let i = 0;
      for (const el of document.querySelectorAll<HTMLElement>("a, button, input, select, textarea, [tabindex]")) {
        const key = String((i += 1));
        el.setAttribute("data-focus-probe", key);
        const cs = getComputedStyle(el);
        w.__resting[key] = `${cs.outlineWidth}|${cs.outlineStyle}|${cs.outlineColor}|${cs.boxShadow}`;
      }
    });

    const invisible: string[] = [];
    let stops = 0;
    let compared = 0;
    let toggleFound = false;
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const key = el.getAttribute("data-focus-probe");
        const cs = getComputedStyle(el);
        const resting = key ? (window as unknown as { __resting: Record<string, string> }).__resting[key] : undefined;
        const invisibleColour = (c: string) => c === "transparent" || /rgba\([^)]*,\s*0\s*\)$/.test(c);
        const drawnOutline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 && !invisibleColour(cs.outlineColor);
        const newShadow = cs.boxShadow !== "none" && cs.boxShadow !== (resting ?? "").split("|")[3];
        return {
          label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 36),
          tag: el.tagName.toLowerCase(),
          expanded: el.getAttribute("aria-expanded"),
          offScreen: el.getBoundingClientRect().width === 0,
          // undefined means the control appeared after the baseline was taken (a section we opened);
          // it is skipped rather than guessed about.
          looksDifferent: resting === undefined ? null : drawnOutline || newShadow
        };
      });
      if (!stop) continue;
      stops += 1;
      if (stop.looksDifferent !== null && !stop.offScreen) {
        compared += 1;
        if (!stop.looksDifferent) invisible.push(`${stop.tag} "${stop.label}"`);
      }
      if (stop.expanded === "false" && !toggleFound) {
        // A folded settings section. Enter must open it — B05's nested-control check.
        await page.keyboard.press("Enter");
        await page.waitForTimeout(400);
        const nowOpen = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute("aria-expanded"));
        expect(nowOpen, `pressing Enter on "${stop.label}" did not open it`).toBe("true");
        toggleFound = true;
      }
    }

    expect(stops, "Tab reached nothing at all on the settings page").toBeGreaterThan(10);
    expect(toggleFound, "no folded section was reachable by Tab").toBe(true);
    expect(compared, "no focus stop was compared against its resting appearance").toBeGreaterThan(10);
    expect([...new Set(invisible)], "controls that take keyboard focus without looking any different").toEqual([]);
  });

  test("the settings tabs are a real tablist: arrows move, and the panel follows", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await signIn(page, "superadmin");
    await page.goto("/app/settings");
    await page.waitForLoadState("networkidle");

    const first = page.getByRole("tab").first();
    await first.focus();
    const before = await first.textContent();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return { text: (el?.textContent || "").trim(), role: el?.getAttribute("role"), selected: el?.getAttribute("aria-selected") };
    });
    expect(after.role, "ArrowRight left the tablist").toBe("tab");
    expect(after.text, "ArrowRight did not move to another tab").not.toBe((before || "").trim());
    // Radix tabs activate on focus by default; whichever it is, the selected tab must be the one
    // the keyboard is on after Enter.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    await expect(page.getByRole("tab", { selected: true })).toHaveText(after.text);
  });
});
