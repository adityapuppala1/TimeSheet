# Public marketing pages

The three pages an unauthenticated visitor can reach, plus the rule that governs all of them.

| Route | File | Purpose |
|---|---|---|
| `/` | `apps/web/src/pages/Landing.tsx` | Sells the features. Hero, product tour, feature grid, AI-trust section, platform guarantees, pricing, FAQ. |
| `/pitch` | `apps/web/src/pages/PitchDeck.tsx` | Sells the thesis. Numbered slides: problem, audience, product, moat, AI position, revenue model, what's next. |
| `/login` | `apps/web/src/pages/Login.tsx` | Two-panel sign-in — form plus `AuthBrandPanel`. |

Supporting components live in `apps/web/src/components/marketing/`.

---

## Tier-gated claims are generated, not written

Anything in `PricingDialog.tsx` that differs by plan — seats, the AI spend ceiling, SSO providers,
chat platforms, face verification — is rendered from `PLAN_TIER_LIMITS` in `@timesheet/shared`. The
control-plane seed (`apps/api/prisma/control/seed.ts`) writes the same constant into
`PlanTierLimit`, so a table cell and the limit the platform enforces cannot disagree.

This exists because they did disagree. The table advertised **face verification on Team** while the
seed grants it to Enterprise only — and that feature *fails closed*, so a Team customer's admin
would have been refused when they tried to enable it. A second row claimed a **dedicated database
was Enterprise-only** when every organization gets one regardless of plan, contradicting two other
statements on the same page.

`apps/api/tests/unit/plan-tier-claims.test.ts` pins the values and asserts entitlements only ever
widen as the tier goes up. A failure there is not a bug — it means someone changed what a plan
includes, and the pricing page, the docs and any signed contracts need to agree.

## The one rule: every claim maps to shipped code

This is not a style preference. These pages have overpromised before — the Enterprise tier once
advertised "SCIM provisioning" and "per-department AI limits" that were never built. A landing page
that overpromises loses a trial; a pitch deck that overpromises loses a deal at diligence.

When editing any of these files, or `PricingDialog.tsx`:

- **Check the claim against the code**, not against what sounds right for a SaaS page.
- **Label intent as intent.** `PitchDeck.tsx`'s "What's next" slide carries an explicit status badge
  on every item precisely so nobody reads a roadmap entry as a feature.
- **Claim no traction.** There are no customer counts, revenue figures or logos on these pages,
  because there are none to cite. Inventing social proof is the fastest way to lose a deal you were
  otherwise winning.

`PricingDialog.tsx` is the highest-risk file here: a comparison table makes ~25 discrete promises at
once, and a single wrong row is a support ticket at best and a refund at worst.

---

## Screenshots are generated, never pasted

`apps/web/public/product/*.png` are produced by `tests/e2e/screenshots.spec.ts` from the running
application. To refresh them:

```bash
CAPTURE_SCREENSHOTS=1 npx playwright test screenshots --project=desktop
```

The spec is skipped in normal runs — it writes files into `public/` and adds ~30s, neither of which
belongs in CI. Two properties make it worth having:

1. **Images can't silently rot.** A hand-taken PNG of a screen that has since been redesigned keeps
   selling a product that no longer exists, and nobody notices until a prospect does.
2. **It doubles as a smoke test.** The capture fails on any uncaught page error or unexpected failed
   request across all six major screens. It excludes exactly one path, `/platform-admin/auth/`: the
   platform-admin session probe that `App.tsx` fires on every page and which always `401`s for a
   tenant user. (`marketing.spec.ts` excludes two — that page is unauthenticated, so the *tenant*
   session probe legitimately `401`s there as well.)

Each capture also emits **WebP variants at 480/800/1280px**, which `ScreenshotFrame` serves through
a `<picture>` with the PNG as fallback. Before that, a 390px phone downloaded and decoded the full
1920px capture to paint it ~350px wide: 896KB of PNG versus 56KB at the 480px tier. Screenshots are
exactly the content class where WebP wins big.

If you rename or add an image, update `PRODUCT_IMAGES` in `tests/e2e/marketing.spec.ts`, which
fetches each path — PNG *and* every variant — and asserts a 200. A broken `src` renders an empty
box with no console error, and a missing `.webp` is completely invisible because `<picture>`
silently falls back to the PNG, so the responsive path could rot with every page still looking
correct and only the bytes getting worse.

---

## Layout constraints worth knowing

**`Login.tsx` panel order is deliberate.** The form is *first* in the DOM and moved into the second
column with `lg:order-2`; the brand panel renders visually on the left. A keyboard or screen-reader
user therefore reaches the email field before any decoration, with no skip-link needed.

**`AuthBrandPanel.tsx` uses a 2D canvas, not three.js.** three.js is ~600KB for what is
decoratively a drifting constellation, on a page whose entire job is to accept two fields quickly.
The effect honours `prefers-reduced-motion`, tears down its `requestAnimationFrame` on unmount, and
is `aria-hidden`.

**It gates on `matchMedia`, not on the `hidden lg:block` class** — and that distinction is a bug
that shipped once. Tailwind's `hidden` is CSS; React mounts the component regardless, so the first
version ran the full loop at 60fps against a 0×0 canvas on every phone, painting nothing, while
three separate comments claimed it "costs a phone nothing". Both media queries are *watched* rather
than sampled at mount, because a laptop meeting an external monitor crosses the breakpoint without
remounting. Layout is cached from the resize handler instead of measured per frame, nodes are
rescaled rather than reseeded on resize, and `devicePixelRatio` is read inside `resize` so browser
zoom doesn't leave the canvas blurry.

**Gradient text uses a two-stop ramp.** `from-primary to-info`, never through `accent`. A three-stop
ramp that includes the amber accent means a wrapped headline ends its second line in gold, which
reads as a warning state rather than emphasis.

**Anchor targets carry `scroll-mt-20`** so a `#features` link doesn't land with the heading hidden
under the sticky nav.

---

## Tests

`tests/e2e/marketing.spec.ts` runs unauthenticated — no `storageState` — because that's the visitor
these pages are for, and it also proves they don't quietly depend on a session. It covers:

- the landing hero renders and its image actually decoded (`naturalWidth > 0`, which catches a 404
  that visibility checks would miss),
- every product image is served,
- the tour swaps screenshots,
- the pricing modal opens, renders the full table, and closes by both the footer button and `Escape`,
- the pitch deck renders through to its closing slide,
- cross-links between `/`, `/pitch` and `/login`,
- the brand panel appears at desktop width and disappears at phone width,
- no element overflows the viewport at 390px.

That last one is measured **per element**, and the obvious alternative is a trap worth naming:
`documentElement.scrollWidth - clientWidth` **cannot fail in this app**. `index.css` sets
`overflow-x: clip` on `html` and `body`, so the document has no horizontal scroll area and the
delta is always zero however far a child overflows — a section that blew past 390px would be
silently clipped and unreachable while the check stayed green. The per-element version walks
ancestors and skips anything already clipped by an `overflow` container, so the hero's decorative
blur orbs (deliberately at `-left-32` inside an `overflow-hidden` section) don't register as false
positives.

See also: [ARCHITECTURE.md](ARCHITECTURE.md) for the router, [ROADMAP.md](ROADMAP.md) for what is
built versus intended.
