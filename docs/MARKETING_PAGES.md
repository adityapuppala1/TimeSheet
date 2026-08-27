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

### The V8 claims, and what each one is careful about

The agentic features are the easiest thing in this product to overpromise, because the industry's
vocabulary for them ("autonomous", "self-driving", "AI employee") describes something nobody has
shipped. Four entries were added to `Landing.tsx`, and the wording of each is load-bearing:

- **Goals** — "progress reports itself" is true of the six wired sources and nothing else, so the
  entry names them. It also states the failure mode out loud ("not measurable yet" rather than 0%),
  because that honesty is the differentiator against a tool that shows a confident zero.
- **AI teammates** — the three fences (no seat, no login, no mailbox) are in the copy because they are
  what makes "teammate" a safe word. A reader who assumes an AI teammate consumes a licence, or can be
  phished, has been misled by the noun.
- **Workflows** — "can never do more than its most restricted step" and the taint clamp are stated as
  limits, not as features. They are the reason to trust the thing, and a page that led with capability
  and hid the constraint would sell the wrong product.
- **The ledger** — "measured … and where they do not, it says so" rather than a savings claim. Every
  competitor in this space quotes hours saved; this one can only quote them where its own approved
  timesheets support the comparison, and says which.

None of the four claims a benchmark, a percentage saved, or an outcome. Where a number would be
persuasive is exactly where this product cannot produce one honestly.

### The V10 claims

Three entries were added for the weekly practice update, the home page's date filter and the shared
document house style, plus tour tabs for the practice update, Requirements Studio and change
management. What each is careful about:

- **The weekly practice update** — the copy says the status colour "is arithmetic, never a model's
  opinion", because that is the only reason a red survives the meeting where somebody asks why. It
  also states that with AI off every section still renders from the counted figures, so nobody
  reads the feature as depending on a model being configured. It carries a tier badge derived from
  `PLAN_TIER_LIMITS.practiceUpdateEnabled` like every other gated entry — the gate is about what
  one document *aggregates* (every project, everyone's hours, every open finding, mailed to people
  with no account), not about what it costs to run.
- **The date filter** — "filtered server-side rather than in the browser" is in the copy because it
  is the part that makes the feature correct: the entry list truncates, so a client-side range
  under-reports anything older than the newest page. It also names the comparison window, since
  "vs yesterday" over a fortnight reads as a collapse every time.
- **Documents** — the claim is about one *house style* across four exports, and it lists what that
  concretely means (repeating table headers, measured row heights, markdown rendering as headings
  and tables rather than printing its own syntax). No claim is made about a document type that does
  not go through `pdf-kit.ts`.

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
   request across every major screen it walks. It excludes exactly one path, `/platform-admin/auth/`: the
   platform-admin session probe that `App.tsx` fires on every page and which always `401`s for a
   tenant user. (`marketing.spec.ts` excludes two — that page is unauthenticated, so the *tenant*
   session probe legitimately `401`s there as well.)

Each capture also emits **WebP variants at 480/800/1280px**, which `ScreenshotFrame` serves through
a `<picture>` with the PNG as fallback. Before that, a 390px phone downloaded and decoded the full
1920px capture to paint it ~350px wide: 896KB of PNG versus 56KB at the 480px tier. Screenshots are
exactly the content class where WebP wins big.

Two capture options exist for screens a plain `goto` cannot photograph usefully. `tab` clicks into
a settings tab first. `press` clicks a button and waits for it to leave its busy state — needed for
the weekly practice update, which holds no saved draft, so an unpressed capture was an empty form
with two date inputs. `press` only works on a button that relabels while it works (the app's
convention for every long-running action), and it waits for the label to change *and then change
back*: asserting "enabled" straight after the click passes on the frame before React re-renders,
which is how the first capture came out mid-generation with the spinner still in shot.

**The anonymise map covers form values as well as text nodes.** `tests/e2e/.screenshot-anonymise.json`
is gitignored — committing a list of real names to anonymise would publish the thing it exists to
hide — and maps text that must never appear in a public image to fictional replacements. It applies
to a `TreeWalker` over text nodes *and* to every `input`/`textarea` `value` and `placeholder`. The
second half is not theoretical: a `TreeWalker` sees only a textarea's **default** text, because
React sets the live one as a property, so the first capture of the practice update anonymised a
real company name in a table and published it verbatim in the AI-drafted paragraph directly below
it.

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

**`AuroraBackdrop.tsx` uses `ogl`, for the same reason and the same budget.** three.js was asked
for by name for the landing hero and was not used: the whole fragment shader is under 2KB, `ogl` is
already a dependency (`strands.tsx`), and the visual — domain-warped noise that folds rather than
slides, leaning toward the pointer — is what the request actually described. It reads `--primary`
and `--info` at mount and again on a theme flip, so it follows dark mode and any future re-brand
without a hex in the file; it stops rendering when scrolled out of view; it calls
`WEBGL_lose_context` on unmount, because browsers cap live contexts and `/` is a route a visitor
re-enters; and under reduced motion it does not mount at all. Every failure path — no WebGL, a
blocked context, a headless browser — leaves the hero exactly as readable as it was.

**A backdrop layer's section needs `isolate`, and this cost two invisible orbs.** The hero's two
`blur-3xl` orbs sit in a `-z-10` layer and had never once been visible on a rendered page. A
negative `z-index` paints inside its nearest ancestor **stacking context**; the section was not
one, so the browser resolved it against `<html>` — and CSS paints negative-z descendants of the
root *before* the backgrounds of in-flow blocks, so `<div class="min-h-screen bg-background">`
covered the entire layer. `isolate` on the section scopes it. The first render after the fix also
retired the amber orb: `bg-accent/20` over a near-white page is khaki, which put a visible smudge
on the right of the hero. Both orbs now sit on the two stops below.

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

**The trust strip and the stat band carry product facts, not traction.** Both devices normally hold
the thing the rule above forbids — customer logos on one, seat and uptime figures on the other.
`ConnectorMarquee.tsx` carries the systems that actually connect instead, every one with a
controller and a settings surface behind it, and `StatBand.tsx` carries figures that are *derived*
from the arrays the page already renders (`FEATURES.length`, `CONNECTOR_COUNT`) plus two
architecture facts. A capability added to `FEATURES` moves the number on its own, which is the same
reasoning the Features heading already uses for its own count.

**`spotlight.ts` has exactly one copy on purpose.** The pointer-following highlight is a handler on
the *grid* — one listener per section rather than one per card, and it survives the landing page's
filter re-keying its children. It writes `--spot-x` / `--spot-y`, which `.spotlight-card::before`
in `index.css` reads; a second copy that drifted one variable name would fail silently, with the
highlight simply ceasing to move.

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
