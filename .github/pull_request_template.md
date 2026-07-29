<!--
Keep this short. The goal is that a reviewer (or you, in six months) can tell WHY this change
exists without re-deriving it from the diff.
-->

## What and why

<!-- One or two sentences. What changes, and what problem it solves. Link the issue if there is one. -->

## How it was verified

<!-- Tick what you actually ran, not what you intend to. "It typechecks" is not verification. -->

- [ ] `npm run lint` (typecheck, api + web)
- [ ] `npm run build`
- [ ] `npm run test -w apps/api` (unit)
- [ ] `npm run test:integration -w apps/api` (real MySQL — only if you touched DB behaviour)
- [ ] `npm run test:e2e` (Playwright — only if you touched a user-facing flow)
- [ ] Manually exercised in a browser

<!-- If something is unverified, say so explicitly. An honest "I couldn't test the Docker path,
     no Docker on this machine" is far more useful than silence. -->

## Docs updated

<!--
`docs/ARCHITECTURE.md` is treated as a bug when out of date. If this PR adds a
service/controller/worker, changes what a module depends on, or adds a data flow, it belongs in
the same PR — not a follow-up.
-->

- [ ] `docs/ARCHITECTURE.md` (new/changed module, dependency, or data flow)
- [ ] `docs/API.md` (new/changed endpoint)
- [ ] `docs/DATABASE.md` (schema change)
- [ ] `README.md` (user-visible capability)
- [ ] `docs/ROADMAP.md` (resolved a tracked item, or found something worth tracking)
- [ ] Not needed — this changes no behaviour, interface, or schema

## Anything a reviewer should look at closely

<!--
Optional but valuable: a decision you're unsure about, a trade-off you made deliberately, a
place you'd welcome a second opinion. Silence here means "nothing surprising in the diff."
-->
