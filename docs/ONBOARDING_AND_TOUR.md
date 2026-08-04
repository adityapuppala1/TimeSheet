# First-run gate and the product tour

Two separate features that both fire when someone new arrives, and are easy to confuse.

| | First-run gate | Product tour |
|---|---|---|
| Component | `components/OnboardingGate.tsx` | `components/ProductTour.tsx` |
| Blocks the app? | **Yes**, until requirements are met | No — dismissible at any point |
| Scope | Per user, permanently (server-recorded) | Per browser session |
| Decided by | The server (`services/onboarding.service.ts`) | The browser (`sessionStorage`) |

---

## The first-run gate

A new account is held until it has the profile fields the workspace needs and, when the policy
covers them, a face enrolment. `/app/profile` stays reachable — a gate that blocks the page where
its own requirements are satisfied is a locked door with the key inside.

### Why `onboardingCompletedAt` is stored, not derived

This is the decision the whole feature rests on.

Deriving "are they set up?" from whether the profile happens to be filled in would lock out **every
existing user** the moment an admin adds a requirement — punishing people for a configuration
change they had no part in. That is the stated reason `SetupChecklistCard` was originally built
*not* to block, and the objection is still valid.

The migration that adds the column **backfills every existing user as already-onboarded**, so the
gate only ever applies to accounts created after it shipped. `tests/e2e/onboarding-gate.spec.ts`
asserts that no existing user is blocked — the negative test, and the important one. Adding a
blocking gate can lock out a whole workforce, and it looks fine locally because the developer's own
account is already set up.

Both components stay. The gate fires once; the checklist handles everything after it.

### Why the decision is server-side

A gate the browser decides for itself is a gate anyone can open with devtools. It also depends on
workspace face-verification policy, which the client only holds a cached copy of. The endpoint
**self-closes**: the moment requirements are met it writes the timestamp, so the overlay lifts
without the client needing to call a "done" endpoint it might skip.

---

## The product tour

Walks someone through the parts of the app **their role can reach**, navigating to each page,
scrolling the target into view, spotlighting it and blurring everything else.

Auto-starts once per browser session; available any time from **profile menu → Take the tour**.
Session-scoped rather than persisted on purpose: someone who skipped it by accident on day one
still gets another chance, where a permanent flag would mean never.

### Role-awareness is the property that matters

Steps are **derived** from the same `nav` array and `isVisible` rule `Sidebar.tsx` renders from
(both exported for this). A hand-maintained list would eventually offer an EMPLOYEE a walkthrough
of Workspace settings — and because the tour drives the router, that doesn't just look wrong, it
navigates them into a 403 and strands the tour there.

Adding a nav item therefore adds a tour stop automatically, correctly gated, with no second place
to remember. Per-destination copy lives in `DESTINATION_COPY`; a destination with no entry still
gets a stop using its nav label, because a dull step beats a broken tour.

**Role is not the only gate any more.** Since the planning layer, `isVisible` also takes the
workspace's *effective* feature flags — the AND of "an admin switched it on" and "the plan
includes it" — and `buildTourSteps` is passed the same set the sidebar already fetched. Without
that argument every feature-gated destination is treated as hidden, which is right for a workspace
that has none of them on and wrong for one that does. The failure it prevents is specific: a tour
that confidently walks somebody to a Gantt chart their workspace has never enabled, then strands
them on a page telling them the feature is off.

### Why it's hand-built rather than driver.js/shepherd/joyride

The tooltip is the easy part. Every step has to drive the router, wait for a page that fetches
before it renders, optionally switch a tab, and be filtered by permissions. Bending a library's
step model around all four is more code than the ~200 lines here — and it would leave the role
filtering, the part that must not be wrong, somewhere nobody thinks to check.

### Implementation notes worth keeping

**The spotlight is four panels, not one overlay with a hole.** `clip-path` can cut a hole but
cannot blur, and the requirement is that everything *except* the target is blurred. Four
`backdrop-blur` panels around the target rect leave it untouched and readable.

**Targets are resolved with a retry window.** Pages fetch their data before rendering, so a step's
element routinely doesn't exist at the moment the route changes. Each step has a `fallbackSelector`
and, failing that, the card centres — a missing target must degrade, never stick.

**Zero-size rects are treated as absent.** An element hidden at the current breakpoint (the sidebar
on a phone) reports `0×0`, and pointing a spotlight at nothing looks broken. Related: the
notifications anchor uses `inline-flex`, not `display: contents`, because an element with
`contents` generates no box and `getBoundingClientRect()` returns zeros.

**Card placement is viewport-aware**, flipping and clamping so it never hangs off the edge — the
same step runs on a 390px phone and a 4K display.

---

## Testing these, and one trap that cost real time

`tests/e2e/product-tour.spec.ts` **signs in per test rather than using a shared `storageState`**,
and that is not a style choice.

A snapshot file replays one fixed refresh cookie. Every `/app` load runs `AuthBootstrap`'s
`/auth/refresh`, which *rotates* that session's secret, and the grace window forgives only the
immediately-previous secret. So in a multi-test spec the first test leaves the snapshot two
generations behind and every later test lands on `/login`. The symptom is "the tour never
appeared" — which points nowhere near the cause, and survived two wrong diagnoses before a
screenshot of the login page gave it away.

Giving the spec its own snapshot does **not** help; the exhaustion happens within the spec. Signing
in per test is free against the rate limiter, because `/auth/login` is configured with
`skipSuccessfulRequests`.

See also: [ARCHITECTURE.md](ARCHITECTURE.md), [FACE_VERIFICATION.md](FACE_VERIFICATION.md).
