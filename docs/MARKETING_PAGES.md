# Public marketing pages

The three pages an unauthenticated visitor can reach, plus the rule that governs all of them.

| Route | File | Purpose |
|---|---|---|
| `/` | `apps/web/src/pages/Landing.tsx` | Sells the features. Hero, product tour, feature grid, AI-trust section, platform guarantees, pricing, FAQ. |
| `/pitch` | `apps/web/src/pages/PitchDeck.tsx` | Sells the thesis. Numbered slides: problem, audience, product, moat, AI position, revenue model, what's next. |
| `/login` | `apps/web/src/pages/Login.tsx` | Two-panel sign-in — form plus `AuthBrandPanel`. |

Supporting components live in `apps/web/src/components/marketing/`.

---

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
   request across all six major screens. The two auth-bootstrap `401`s are excluded by name — they
   are the documented "not signed in" path, not a fault.

If you rename or add an image, update `PRODUCT_IMAGES` in `tests/e2e/marketing.spec.ts`, which
fetches each path directly and asserts a 200. A broken `src` renders an empty box with no console
error, so nothing else would catch it.

---

## Layout constraints worth knowing

**`Login.tsx` panel order is deliberate.** The brand panel is *later* in the DOM and moved into
place with CSS `order`. A keyboard or screen-reader user therefore reaches the email field first
instead of tabbing through decoration, with no skip-link needed. It's also `hidden` below `lg`, so
the canvas animation costs a phone nothing.

**`AuthBrandPanel.tsx` uses a 2D canvas, not three.js.** three.js is ~600KB for what is
decoratively a drifting constellation, on a page whose entire job is to accept two fields quickly.
The effect honours `prefers-reduced-motion` (the loop never starts), tears down its `requestAnimationFrame`
on unmount, and is `aria-hidden`.

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
- no horizontal overflow on any of the three at 390px.

See also: [ARCHITECTURE.md](ARCHITECTURE.md) for the router, [ROADMAP.md](ROADMAP.md) for what is
built versus intended.
