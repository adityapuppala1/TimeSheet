# V12_UiUx_ClickUp — Living Plan & Handoff State
> Any agent: read §3 of SYSTEM_PROMPT_V12_UiUx_ClickUp.md, then this file before working.
> Branch: V12_UiUx_ClickUp — NEVER merge to main.

## Current Status
- Phase: 2 — theme lifecycle (done) → mode + accents (done) → shell: touch targets (done) → PageHeader + derived breadcrumb: ALL 17 in-app pages (done) → sidebar Project → Module tree (done this session) → density, responsive containment next.
- Last updated: 2026-09-16 by Claude Code (Fable 5.1), resumed from Codex per §3.
- Resumed baseline: lint PASS (701 warnings, zero errors, ratchet passes); API 3140/3140; web 191/191. Matched the previous handoff exactly.
- Post-change checks: per unit in the Session Log; slice 2's gates are appended there on completion.
- Starting commit this session: `ca22309`. Branch otherwise untouched; no push, no main change.
- Prior checkpoint: resolve current with `git log -1`.

## Next Actions (ordered; first unchecked = resume point)
- [x] Phase 0: inventory architecture, commands, existing modules and design foundation.
- [x] Reproduce baseline test timeout and isolate the unit test from developer SMTP configuration.
- [x] Phase 1: research official ClickUp sources and fill every required Feature Matrix area; inspect existing implementations before assigning parity status.
- [x] Phase 2 plan: repair theme lifecycle first; next extend existing tokens/preferences, then shell navigation. Preserve current defaults and existing styling system.
- [x] Phase 2 first unit: preserve implicit OS preference and synchronize existing theme controls, with regression tests.
- [x] Phase 2 next unit: explicit light/dark/system selection and seven original accent palettes in Profile → Appearance; per-user persistence via the existing profile PATCH and one additive nullable JSON column (`User.appearance`). Contrast measured (WCAG 2.1 AA, both surfaces, both roles) before any palette shipped; verified live at 390/768/1366 in light+dark, keyboard, reload, ≥44px targets.
- [x] Phase 2 shell (part 1): touch-target sizing. Root font is 14px, so `h-10` = 35px; `default`/`lg`/`icon` buttons, `Input`, `SelectTrigger` and the top bar's two overrides are now absolute 44px. Deliberately left (design decisions, each its own unit): rich-text toolbar 32px, table-header sort/group text controls, the date picker, `size="sm"` callers.
- [x] Phase 2 shell (part 2a): `components/PageHeader.tsx` — title block + breadcrumb DERIVED from `nav` via the sidebar's `matchPath`/`end` rule; migrated Tickets (icon + actions slot) and Profile (plain). Date-picker triggers → 44px; range picker `h-9` kept (filter control).
- [x] Phase 2 shell (part 2b, slice 1): Timesheet, History, Changes, ChangeCalendar, Team, Dashboard (`breadcrumb={false}` — the landmark) on PageHeader; actions cells moved verbatim; verified live 390/1366 + dark.
- [x] Phase 2 shell (part 2b, slice 2): AIActivityLog, AuditLog, EmailTemplates (+BulkTestButton action), Help, Insights, SecurityInsights, WhatsNew, WorkspaceSettings, and AdminPages via its `Workspace` wrapper (Users/Projects/Approvals/Reports). PageHeader.icon accepts component OR node. Help/WhatsNew: no nav entry → no crumb, by design. Header rollout COMPLETE.
- [x] Phase 2 shell (part 3a): sidebar Project → Module tree (`ProjectTree` in Sidebar.tsx, under Work; drawer too; not in slim). Rows deep-link to Tickets via `lib/project-tree.ts` (`?project=&module=`); Tickets reads them, gains a Module select, and both `/tickets` + `/tickets/metrics` accept `moduleId`. NO submodule tier: `Ticket` has no submodule column (only `Timesheet`) — the earlier "Project → Module → Submodule" wording was an assumption, corrected here.
- [ ] Phase 2 shell (part 3b): density preference — `comfortable` (today's 14px root) / `compact`; add to `AppearancePreference` + PATCH schema + `readAppearance` + theme.ts + Profile → Appearance; `data-density` on `<html>`. Touch targets stay absolute 44px.
- [ ] Phase 2 shell (part 3c): responsive containment audit — run `tests/e2e/responsive.spec.ts` (phone + tablet projects) over the app routes and fix any measured overflow; each fix its own commit.
- [ ] Phase 3: implement verified gaps by priority, with tests and shipping surfaces updated.
- [ ] Phase 4: responsive/accessibility/workflow checks and continuous hardening.
- [ ] Phase 5: branch-only release preparation and clean install/update validation.

## In Progress / Half-done
- Nothing half-finished. Six units complete and verified. `v12-slice2-*.png` at repo root are artefacts — deleted before commit. The only remaining `text-2xl font-black tracking-tight` matches are non-candidates (public/auth pages, platform console shell, ChangeDetail's record-key title, EmailTemplates' stat tile) — do not migrate them.
- Final verification commands: `npm run lint`, `npm run test -w apps/api`, `npm run test -w apps/web`, `git diff --check` — run SEQUENTIALLY (parallel runs starve the workers) and AFTER the last edit, including any version bump (the 5.2.0 lesson in CONTRIBUTING).
- Local ignored artefacts: `test-results/run-shots/v12-appearance-*.png` (five frames: before, indigo light, indigo dark, phone dark, tablet dark). Do not commit them.

## Codebase Map (verified facts only, with file paths)
- Stack: npm workspace TypeScript monorepo (`package.json`, `apps/*`, `packages/*`). Manifest ranges: React ^19.2.8, React Router ^8.3.0, Vite ^8.1.5, Express ^5.1.0, Prisma ^6.7.0, TypeScript ^5.8.3. These are declared ranges, not a claim about every installed version.
- Package manager: npm, root `package-lock.json`; do not mix managers.
- Commands: `npm run dev`, `npm run build`, `npm run lint`, `npm test`; lint includes API/web TypeScript checks, SonarJS ESLint and warning ratchet. Shared TypeScript is checked by its build. No root standalone typecheck script.
- Styling & theming: `apps/web/src/index.css` CSS variables, `apps/web/tailwind.config.ts` Tailwind 3/class dark mode, Radix UI wrappers in `apps/web/src/components/ui/`. Existing primary/accent/status/planning tokens and radius. `apps/web/src/lib/theme.ts` renders a three-way mode (`system` = absence of a stored choice, never a persisted string) plus an accent from `packages/shared/src/appearance.ts`, painting `--primary`/`--primary-foreground`/`--ring` per theme on every render; boot reads both keys; `adoptSavedAppearance` is called from the auth store's two setters (the single choke point for cold-load, password login and SSO). IMPORTANT for every future touch target: `index.css:240` sets root font-size to 14px at ALL widths, so `h-11` is 38.5px, not 44 — use absolute `[44px]` for anything the touch rule covers.
- Icons: existing `lucide-react` dependency; reuse it.
- Routing: `apps/web/src/App.tsx`, lazy pages, `/app` and `/platform-admin` layouts, permission/role guards, separate public request/approval/attestation routes.
- State: TanStack React Query client in App.tsx; Zustand session store `apps/web/src/store/auth.ts`; Axios API service `apps/web/src/services/api.ts`. Access token is in memory; refresh token is an httpOnly cookie (store contract).
- DB/ORM & migrations: MySQL with Prisma; tenant schema `apps/api/prisma/schema.prisma`, control schema `apps/api/prisma/control/schema.prisma`. Separate database per organization (architecture reference). Migration directories beside each schema; preserve additive migration policy and tenant fan-out.
- API layer: `apps/api/src/app.ts` mounts controller routers, tenant/auth/security middleware; `apps/api/src/server.ts` starts HTTP, workers and runtime lifecycle.
- Background jobs: server.ts imports mail queue, reminders/escalations, digests, inbound mail/chat, webhook retries, scheduled automations, AI runs/evals, retention, backup and platform monitoring workers.
- AI integrations: API manifests include Anthropic and OpenAI SDKs; `server.ts` starts optional native runtime; existing UI `AskAi.tsx`, `Agents.tsx`, `Studio.tsx`, `AiOverview.tsx`, `AIActivityLog.tsx`, `Proposals.tsx`, settings AI/provider/runtime panels. See `docs/AGENTIC_UX_PLAN.md` for earlier shipped work, not a replacement V12 handoff.
- MCP: existing `apps/api/src/controllers/mcp.controller.ts` mounted by app.ts; `apps/web/src/pages/settings/McpServerSettingsCard.tsx`. README describes disabled-by-default server, write latch and individual tool switches. Audit code before modifying permissions.
- Install script: `install.sh`, `install.ps1`, `install.cmd` (Docker Compose installers, architecture reference). `scripts/bootstrap-dev.mjs`, `ensure-deps.mjs`, `ensure-migrations.mjs` support local setup. Clean install was not executed.
- Update script: `update.sh`, `update.ps1`, `update.cmd`; PowerShell updater checks tenant/control migration status and documents rerunnable P3009 recovery. Clean update was not executed.
- Build/deploy: API/web Dockerfiles, Helm `deploy/helm/timesphere`, `.github/workflows/ci.yml` and `cd.yml`; details in `docs/ARCHITECTURE.md` and `docs/DEPLOYMENT.md`.
- Version locations: authoritative root `VERSION` = 5.2.1, `apps/api/src/config/version.ts` resolves build env/file, web Vite config consumes version per that module's documentation; Helm Chart.yaml. Workspace package versions remain 1.0.0 by design. Do not infer branch V12 means product version 12.
- Changelog: root `CHANGELOG.md`; documentation in README and docs; existing Help route and pitch/export scripts must be inspected with ship-feature skill before a feature lands.
- Tests: API Vitest node unit tests (`apps/api/vitest.config.ts`), separate DB integration config; web Vitest/jsdom (`apps/web/vitest.config.ts`); Playwright at root (`playwright.config.ts`, `tests/e2e`). Integration and browser suites not run during discovery.
- Existing feature modules (route/page inventory verified in App.tsx; parity not yet audited):
  - Work/time/tickets: `pages/Timesheet.tsx`, `Tickets.tsx`, `History.tsx`, `MyWork.tsx`, `AdminPages.tsx` (approvals/projects/reports/users).
  - Planning: `pages/Timeline.tsx`, `Portfolio.tsx`, `Workload.tsx`, `Goals.tsx`, `Requests.tsx`, `PublicRequestForm.tsx`, `Blueprints.tsx`.
  - Change governance: `pages/Changes.tsx`, `ChangeDetail.tsx`, `ChangeCalendar.tsx`, `GuestApproval.tsx`.
  - Collaboration/reporting: `pages/Inbox.tsx`, `Dashboard.tsx`, `Dashboards.tsx`, `Insights.tsx`, `Team.tsx`, `PracticeUpdate.tsx`, `RequirementsStudio.tsx`, `RequirementsDocView.tsx`.
  - Account/admin: `pages/Profile.tsx`, `WorkspaceSettings.tsx`, `AuditLog.tsx`, `SecurityInsights.tsx`, `EmailTemplates.tsx`, `Help.tsx`, `WhatsNew.tsx`, platform-admin pages.
  - Shell/search/onboarding: `layouts/AppLayout.tsx`, `components/command-palette.tsx`, `NotificationsBell.tsx`, `ProductTour.tsx`, `OnboardingGate.tsx` (inventory only; behavior audit pending).
  - All page/component paths above are relative to `apps/web/src/`.

## ClickUp Feature Matrix
| Area | ClickUp capability (source URL) | Our app (paths) | Status | Action | Priority | Done |
|------|------|------|------|------|------|------|
| Projects/Spaces/Folders/Lists | [Nested hierarchy][cu-hierarchy] | Prisma Project/ProjectModule/ProjectSubmodule; `ProjectTree` in Sidebar.tsx (Project → Module, deep-links to Tickets) | Near-identical core (2 tiers; submodules are timesheet-only, no ticket carries one) | Done for tickets; a timesheet-history deep link is the only conceivable 3rd tier | P1 | Shipped |
| Tasks/subtasks | [Nested tasks][cu-hierarchy] | Prisma Ticket.parentId/checklists; pages/Tickets.tsx | Near-identical core | Enhance existing child navigation; no second task table | P1 | Audit complete |
| Custom fields/statuses | [Configurable fields and workflow][cu-fields] | services/custom-field.service.ts; Prisma Workflow/WorkflowStatus; PlanningSettingsCard.tsx | Partial | Enhance field columns and workflow visibility; also see [statuses][cu-statuses] | P1 | Audit complete |
| Tickets/issues | [Task workflows][cu-statuses] | controllers/ticket.controller.ts: assignment, SLA, comments, labels, links, attachments | Near-identical core | Enhance existing tickets; preserve SLA and CI gates | P1 | Audit complete |
| List | [Grouped/sorted lists][cu-views] | pages/Tickets.tsx: filters, saved views, desktop table/mobile cards | Partial | Enhance grouping and accessible view selection | P1 | Audit complete |
| Board/Kanban | [Drag between states][cu-views] | components/TicketKanban.tsx; Tickets board mode | Near-identical core | Enhance board; verify keyboard move parity | P1 | Audit complete |
| Calendar | [Scheduled tasks][cu-views] | Tickets calendar mode; components/PlanCalendar.tsx | Partial | Enhance scheduling in existing planning flag | P2 | Audit complete |
| Gantt | [Dependencies on a schedule][cu-views] | components/PlanTimeline.tsx; Ticket planning dates/baselines | Near-identical core | Enhance existing timeline | P2 | Audit complete |
| Timeline | [Linear schedule][cu-views] | pages/Timeline.tsx; shared PlanTimeline in Tickets | Partial | Enhance schedule grouping; no parallel module | P2 | Audit complete |
| Table | [Uniform rows/field columns][cu-views] | Tickets DataTable has fixed columns | Partial | Enhance existing table with custom-field visibility | P1 | Audit complete |
| Workload | [Capacity in points/tasks/hours][cu-workload] | pages/Workload.tsx; ResourceBooking; planned/actual hours | Partial | Preserve approved-hour comparison; add modes only with supporting data | P2 | Audit complete |
| Sprints/points/burndown | [Sprint cycles][cu-sprints] | No Sprint/storyPoints model or route found; dashboard VELOCITY is not sprint burndown | Missing | Add default-off sprint membership and history on Ticket; see [points][cu-points] and [burndown][cu-burndown] | P2 | Audit complete |
| Time tracking | [Entries/timesheets/reports][cu-time] | pages/Timesheet.tsx, History.tsx, AdminPages.tsx; Timesheet.ticketId | Near-identical core | Skip replacement; audit timer ergonomics separately | P2 | Audit complete |
| Goals/OKRs | [Objectives and key results][cu-goals] | Prisma Goal.parentId; services/goal-progress.service.ts measured sources | Near-identical core | Skip replacement; preserve measured outcomes | P2 | Audit complete |
| Forms → task | [Conditional intake creates tasks][cu-forms] | services/request-form.service.ts; public controller; Requests/PublicRequestForm; blueprint intake | Near-identical core | Enhance builder on existing schema | P2 | Audit complete |
| Dashboards/cards | [Configurable reporting cards][cu-dashboards] | services/dashboard.service.ts: ten widget types and scope filtering; pages/Dashboards.tsx | Partial | Enhance closed widget catalog, not arbitrary query execution | P2 | Audit complete |
| Automations | [Triggers/conditions/actions][cu-automations] | Studio/FlowCanvas; automation-dispatch.service.ts: events, schedules, manual AND form submissions | Partial | Enhance branch visualization; form dispatch already exists | P2 | Audit complete |
| Universal search/palette | [Command and connected search][cu-search] | components/command-palette.tsx: permission-filtered routes/actions and AI ticket search | Partial | Add scoped deterministic record search; external indexing deferred | P1 | Audit complete |
| Docs/wikis | [Collaborative Docs/wiki views][cu-views] | services/requirements-doc.service.ts: PRD/BRD interview/materialization; no general wiki model found | Partial | Extend existing documents after permissions/versioning design | P3 | Audit complete |
| Whiteboards | [Collaborative canvases][cu-views] | No Whiteboard model/route found; FlowCanvas edits automations | Missing | Defer until core work views; default-off when added | P3 | Audit complete |
| Chat/comments/mentions | [Channels/direct messages][cu-chat] | Ticket comments/watchers/collaborators, external chat intake; no in-app team-chat route | Partial; mention parity Unverified | Enhance ticket collaboration first; defer standalone messaging | P3 | Audit complete |
| Inbox/notifications | [Inbox triage][cu-inbox] | pages/Inbox.tsx day brief/queue; NotificationsBell.tsx read actions | Partial | Enhance existing inbox; audit snooze/shortcut behavior | P2 | Audit complete |
| AI assistant | [Ask/create in AI Hub][cu-ai] | AskAi/Proposals and role-scoped chat tools | Partial | Enhance existing assistant with review/permission rules | P2 | Audit complete |
| AI agents | [Agent catalog/profiles][cu-ai] | Agents, AgentProfile/AgentWorkEntry, runtime queue and cost/authority limits | Partial | Enhance existing roster/flows | P2 | Audit complete |
| MCP | [Server tools][cu-mcp] | controllers/mcp.controller.ts, services/mcp.service.ts: own gated server; external client not found | Partial | Preserve server; separately design [external connections][cu-mcpclient] if prioritized | P3 | Audit complete |
| Integrations | [Connected applications][cu-search] | app.ts mounts GitHub, chat webhooks, SSO, public API, SCIM; no connected-search index found | Partial | Enhance supported connectors; do not claim unsupported ones | P3 | Audit complete |
| Templates | [Reusable item templates][cu-templates] | services/blueprint.service.ts offsets/dependencies/custom fields; requirements templates; SavedView | Partial | Enhance Blueprints/saved views | P2 | Audit complete |
| Permissions/guests | [Shared-item access][cu-guests] | Role/permission/project guards; token guest approvals; no generic guest RoleName | Partial | Keep narrow guest links; design scoped membership before adding | P3 | Audit complete |
| Themes/color/icons/density | [Personal colors/light/dark/auto][cu-settings] | lib/theme.ts + shared/appearance.ts; Profile → Appearance card; `User.appearance` JSON | Near-identical core (mode + 7 accents, per user); density not yet | Density remains; then shell | P0 | Mode + accents shipped |
| Keyboard shortcuts | [Palette/contextual shortcuts][cu-shortcuts] | Ctrl/Cmd+K in command-palette.tsx; broader inventory unverified | Partial | Discoverable shortcuts that respect editable fields | P1 | Audit complete |
| Mobile/responsive | [Mobile task/inbox access][cu-mobile] | AppLayout/Sidebar drawer/bottom nav; Tickets mobile cards; no native app | Partial | Verify current responsive views; native app out of scope | P1 | Audit complete |
| Onboarding/empty states | [Individual workspace setup][cu-onboarding] | OnboardingGate/ProductTour/setup checklist; empty-state coverage not fully audited | Partial | Enhance existing tour/empty states; preserve required gate | P1 | Audit complete |

Research checked 2026-09-16 against official sources. Status is a source-level engineering comparison, not end-to-end certification. Near-identical core covers the narrow capability named, not every vendor option. API paths are under `apps/api/src/`; UI paths under `apps/web/src/`. Missing means absent from inspected routes/schema and targeted search.

[cu-hierarchy]: https://help.clickup.com/hc/en-us/articles/13856392825367-Intro-to-the-Hierarchy
[cu-statuses]: https://help.clickup.com/hc/en-us/articles/6309452618647-Manage-task-statuses
[cu-fields]: https://help.clickup.com/hc/en-us/articles/6330455628439-Show-Custom-Fields-in-tasks-and-views
[cu-views]: https://help.clickup.com/hc/en-us/articles/6329880717719-Intro-to-views
[cu-workload]: https://help.clickup.com/hc/en-us/articles/30799933602327-Customize-your-Workload-view
[cu-sprints]: https://help.clickup.com/hc/en-us/articles/40976121279639-How-to-set-up-Sprint-planning-for-Agile-teams
[cu-points]: https://help.clickup.com/hc/en-us/articles/6303883602327-Use-Sprint-Points
[cu-burndown]: https://help.clickup.com/hc/en-us/articles/13352818283671-Sprint-Burndown-cards
[cu-time]: https://help.clickup.com/hc/en-us/articles/6304291811479-Intro-to-time-tracking
[cu-goals]: https://help.clickup.com/hc/en-us/articles/30806266190103-Organize-your-Hierarchy-for-goals-and-OKRs
[cu-forms]: https://help.clickup.com/hc/en-us/articles/6310233090711-Intro-to-Forms-and-Form-view
[cu-dashboards]: https://help.clickup.com/hc/en-us/articles/6312197753239-Intro-to-Dashboards
[cu-automations]: https://help.clickup.com/hc/en-us/articles/6312102752791-Intro-to-Automations
[cu-shortcuts]: https://help.clickup.com/hc/en-us/articles/6309030550167-Use-keyboard-shortcuts
[cu-search]: https://help.clickup.com/hc/en-us/articles/24640565638935-Connected-Search-and-Brain-AI
[cu-chat]: https://help.clickup.com/hc/en-us/articles/25790737416855-What-is-Chat
[cu-inbox]: https://help.clickup.com/hc/en-us/articles/15147158275735-Intro-to-Inbox-on-mobile
[cu-ai]: https://help.clickup.com/hc/en-us/articles/36954958035863-AI-Hub
[cu-mcp]: https://help.clickup.com/hc/en-us/articles/33335772678423-What-is-ClickUp-MCP
[cu-mcpclient]: https://help.clickup.com/hc/en-us/articles/38503227973655-Connect-an-MCP-server-to-your-Workspace
[cu-templates]: https://help.clickup.com/hc/en-us/articles/6326066114455-Create-a-template
[cu-guests]: https://help.clickup.com/hc/en-us/articles/6311803642903-Use-ClickUp-as-a-guest-or-limited-member
[cu-settings]: https://help.clickup.com/hc/en-us/articles/6311968998167-My-Settings
[cu-mobile]: https://help.clickup.com/hc/en-us/articles/15145935126679-Intro-to-the-mobile-app
[cu-onboarding]: https://help.clickup.com/hc/en-us/articles/9563959684119-Set-up-your-individual-Workspace

The matrix covers every requested area. Remaining Unverified details are explicitly called out; validate them at the start of the corresponding implementation unit.

## Design System Decisions
- Tokens: extend existing CSS variables/Tailwind mapping.
- Themes: three-way mode. `system` is stored as the ABSENCE of a choice (localStorage key removed; a saved profile `mode: "system"` is adopted by clearing) — following the OS is never a persisted value. Explicit light/dark persist per browser AND per profile; a saved profile choice wins over browser leftovers on sign-in.
- Accents: seven original palettes, each a per-theme pair (`primary` + `foreground`). MEASURED FACT that shaped the design: no hue passes WCAG AA as white-on-fill in dark mode — not one of eight candidates, not the brand teal (2.41:1) — so dark-theme fills carry dark text. Default `teal` writes the EXACT existing primary values, so "never chose" is pixel-identical to before. Ratios recorded beside each palette in appearance.ts. Planning/chart tokens deliberately do NOT follow the accent (a chart's palette is not the chrome's).
- Density: not shipped; the JSON column was chosen so it needs no migration.
- Shipping review: current unit fixes existing behavior, adds no data capability/env/migration/dependency, so landing/pitch/install/version remain unchanged. Help/Ask AI's shared article and Unreleased changelog updated. Read `.agents/skills/ship-feature/SKILL.md`; its main/V10 release push instruction is superseded by the V12 branch-only rule.
- Icon set: reuse Lucide.
- Breakpoints: target specification mobile ≤640, tablet 641–1024, laptop 1025–1440, wide >1440; actual component behavior still needs browser checks.

## Dependencies Added
| Package | Version | Reason | Date |
|---|---|---|---|
| None | — | Discovery/test isolation only | 2026-09-16 |

## Feature Flags
| Flag | Default | Controls |
|---|---|---|
| No new flags | — | Existing settings gates must be audited before feature work |

## Auto-Heal Log
| Date | Symptom | Root cause | Fix | Commit |
|---|---|---|---|---|
| 2026-09-16 | Agent mixed-recipient mail unit test timed out at 10s, including isolated run | Real nodemailer transport plus fallback to developer SMTP env; mocked EmailLog returned only id | Mock transport and explicit fake mail settings; return created data from log mock; assert SENT and exact recipient list | Same commit as this handoff |
| 2026-09-16 | Device theme stopped being automatic after first load; theme button label stale after palette changes | Bootstrap persisted inferred theme; toggle kept isolated React state; storage read unguarded | Non-persisting initialization with OS/storage subscriptions; shared external-store toggle; safe reads and session fallback; eight regression tests | Theme foundation checkpoint |
| 2026-09-16 | Accent swatches measured 38.5px at every width — under the 44px touch rule — while mode buttons beside them passed | Root font-size is 14px globally (`index.css:240`), so rem-based `h-11` = 38.5px; `min-h-[44px]` on the mode buttons is absolute and passed. First guess (phones only) was wrong; measured at 390/768/1366 | Swatches sized `h-[44px] w-[44px]`. App-wide implication logged in Codebase Map: every `h-11` touch target has this property — audit in the shell unit | Appearance unit commit |
| 2026-09-16 | `prisma generate` EPERM on the query-engine DLL after the schema edit | The running API dev server maps the DLL; the repo's `prisma-generate.mjs` documents exactly this and tolerates it (types are written first) | Stopped the listener, regenerated; `tsx watch` respawned the child onto the fresh client — proven by a live PATCH writing the new column, not assumed | — (process, not code) |
| 2026-09-16 | Falsification harness reported 7/7 breaks GREEN on first pass | Detector parsed vitest text, and a cp1252 encode crash truncated the read; the tests were RED the whole time | Detect red by process exit code, never by text. Re-run: 7/7 RED, then restored | — (harness only) |
| 2026-09-16 | Every `h-10` control (default button, input, select) measured 35px at every width; audit of `h-11` sites found the same | Root font-size 14px globally; rem utilities render at 14/16. `button.tsx` variants, `input.tsx`, `select.tsx`, Topbar overrides | Absolute `44px` on the primitives. Verified live on Tickets + Log timesheet at 390/1366, both themes, zero overflow | Touch-target unit commit |
| 2026-09-16 | Dark-mode frame showed grey select boxes on the dark surface | Test forced the `dark` class without `theme.ts`'s repaint — an artefact, not a defect. Through the real toggle the combobox bg is rgb(17,20,29) | None needed. Lesson recorded: force theme through `toggleTheme`/`applyMode`, never by class | — |
| 2026-09-16 | Live frame showed a GREEN accent while the profile was NULL | The test browser's localStorage still held a previous session's `timesheet:accent` — exactly the 'browser leftover' the profile preference is designed to override, and a NULL profile correctly changes nothing | None. Design working as intended; noted so nobody chases it | — |
| 2026-09-16 | `PageHeader` import in Timesheet.tsx typechecked as 'cannot find name' though the line was present | The migration script inserted after the first line beginning `import ` — which in that file was INSIDE the leading `/** … */` doc comment, so the statement was a comment | Moved the import below the comment; the other five pages had landed as real statements and were checked by grep, not assumed | Slice 1 commit |
| 2026-09-16 | Live probe reported every slice-2 page as 'h1 not found', then later runs died mid-flight with 'browser closed' after 5+ min | Three separate probe faults, zero page faults: (a) `isVisible()` does not auto-wait — use `toBeVisible`; (b) I hand-typed a crumb section ('Analytics') the nav table files under Administration — derive expectations from `nav`, read as text since importing Sidebar.tsx drags in `import.meta`; (c) the shared auth snapshot's refresh secret rotates and a long run is revoked mid-flight (auth.setup.ts documents this) — log in fresh via the API per test, as responsive.spec.ts does | Probe rewritten three times; pages unchanged. 19 route×width checks green with crumbs matching nav exactly before the session-rotation kill | — (probe only) |
| 2026-09-16 | State file promised a "Project → Module → Submodule" sidebar; probe of the schema showed `Ticket` has `moduleId` but no submodule column | The plan line was written from the Prisma model list, not from the Ticket relation. A submodule row would have linked to an empty Tickets page | Tree built with two tiers; reason recorded in `lib/project-tree.ts`, the Sidebar comment and the Feature Matrix row | — |
| 2026-09-16 | Tree probe: strict-mode collision — the tree's "Projects" heading and the Administration "Projects" link both match `getByText("Projects")`; employee check read `undefined` projects | (a) A heading that shares a word with a nav label is legitimate UI; the probe selector was the fault — scoped to `[data-tour=project-tree] > p`. (b) `page.request` after a cookie login is unauthenticated for bearer routes — pass the login's `accessToken` | Probe fixed twice; product unchanged. Desktop, phone drawer, and employee scope (3 of 5 projects, matching the API exactly) all green | — (probe only) |

## Open Questions / Blockers
- `RTK.md` referenced by user AGENTS instructions is absent; no matching repository file found.
- Graph query works on resume (package 0.9.30, installed skill 0.9.53 warning); prior missing-module blocker is resolved. `python -m graphify update .` passed: 9294 nodes, 21676 edges, 572 communities. Semantic documentation refresh remains pending; use this state file directly for current research.
- `.Codex/skills/ship-feature/SKILL.md` remains absent; read the available `.agents/skills/ship-feature/SKILL.md` instead. Run-timesphere driver paths have the same stale prefix; actual tools are in `.agents/skills/run-timesphere/`.
- Only MySQL was running. Started Vite frontend for a mocked-API browser check; did not start production cron workers or send mail. Full real-backend workflow, accessibility certification and new color palettes are not claimed by this unit.
- `docs/AGENTIC_UX_PLAN.md` says FORM_SUBMISSION was not wired; inspected current public controller and dispatcher prove it now is. Treat current source as authoritative.
- Branch was created from locally available origin/main. No network fetch was performed; upstream freshness is unverified. Removed inherited origin/main tracking to avoid accidental pushes to main; no remote branch published.
- User-owned pre-existing untracked `.claude/settings.local.json`, `.codex/`, `AGENTS.md`, `SYSTEM_PROMPT_V12_UiUx_ClickUp.md` were preserved and excluded from commits.
- `.agents/skills/dataviz` does NOT exist in this repo (the `.agents` tree is an unrelated infra skill pack). No contrast tooling exists anywhere in the repo; this session wrote and ran its own WCAG 2.1 validator (throwaway, removed). If AA gating recurs, promote that validator to `scripts/` rather than re-deriving it.
- The graphify pre-grep hook fires on every Grep. Query first; it is faster than the refusal.

## Session Log (newest first)
### 2026-09-16 — Claude Code (Fable 5.1), shell part 3a — sidebar Project → Module tree
- Did: `ProjectTree` under Work in Sidebar.tsx (desktop + drawer, not slim), collapsed by default, fold state per browser (`ts.sidebar.projects.open`), rows highlight from the URL; `lib/project-tree.ts` (URL keys, pure); Tickets reads `?project=&module=`, grows a Module select, clears the params on a manual change; API `/tickets` + `/tickets/metrics` accept `moduleId`; `TicketFilters.moduleId`. Tests: 6 web (helper), 3 API (both endpoints send `moduleId` to Prisma; absent = no clause). No dependency, env var, flag or migration.
- Verified with: live Playwright at 1366 + 390 — heading visible with every static link still visible; collapsed by default; expand → module link → URL, h1, Project AND Module selects, `aria-current`, list request carries `moduleId`; manual "All projects" clears the URL and hides the Module select; fold survives reload; drawer closes on navigate; overflow −10; employee sees exactly the 3 API-scoped projects.
- Gates AFTER the last edit, sequential: lint 701 warnings / 0 errors (ratchet passes); API 3150/3150 (+3); web 214/214 (+6); `git diff --check` clean.
- Left off at: part 3b density, then 3c containment audit.

### 2026-09-16 — Claude Code (Fable 5.1), shell part 2b slice 2 — header rollout complete
- Did: resumed per §3 (git matched; baseline 701/0, 3147, 208). Extended PageHeader.icon to accept a rendered node; migrated the nine remaining in-app pages (AdminPages via its `Workspace` wrapper = 4 routes in one edit); confirmed the leftover grep matches are non-candidates. Changelog updated. No dependency, env var, flag or migration.
- Verified with: typecheck clean; live Playwright with nav-DERIVED crumb expectations — 19 route×width checks green (every crumb exactly [section, label]; Help/WhatsNew correctly crumb-less; zero overflow) before the shared snapshot's rotation killed the session. Final fresh-login probe: all 10 routes × 2 widths green (the 11-minute run reached 9; What's new confirmed in a separate 24 s run — h1 present, no crumb, overflow −10). Gates AFTER the last edit, sequential: lint 701 warnings / 0 errors (ratchet passes); API 3147/3147; web 208/208; `git diff --check` clean.
- Left off at: shell part 3 — sidebar hierarchy (Project → Module → Submodule), density, containment audit.

### 2026-09-16 — Claude Code (Fable 5.1), shell part 2b slice 1
- Did: resumed per §3 (git matched; baseline 701/0, 3147, 208). Classified the 24 old-header files: 17 in-app pages are candidates, 7 public/auth/console pages and the change detail page are not. Migrated the six Work-section pages to PageHeader, moving every actions cell verbatim; Dashboard gets no crumb (landmark). Changelog updated. No dependency, env var, flag or migration.
- Verified with: live Playwright over all six at 390/1366 — right crumb section or none, h1 present, Dashboard actions intact, zero overflow — plus a real-dark frame of Changes with its four kept actions. Sequential gates after the last edit: lint 701/0 + ratchet, API 3147/3147, web 208/208, diff-check clean.
- Left off at: slice 2 — the nine remaining in-app pages (list in Next Actions), AdminPages first-read required.

### 2026-09-16 — Claude Code (Fable 5.1), shell part 2a: PageHeader + derived breadcrumb
- Did: resumed per §3 (git matched; baseline 701/0, 3147, 208). Date-picker triggers → 44px. Built `PageHeader` with `navItemFor`/`crumbsFor` deriving Section › Page from the exported `nav` table using the sidebar's own active rule; migrated Tickets and Profile; 6 pure tests including one over the REAL table (every sectioned route → two crumbs). Changelog updated. No dependency, env var, flag or migration.
- Verified with: live Playwright at 390/1366, light + real dark: crumb renders on Tickets, current page unlinked, absent on Profile (not in nav), switcher + New ticket intact, zero overflow. Sequential gates after the last edit: lint 701/0 + ratchet, API 3147/3147, web 208/208, diff-check clean.
- Left off at: shell part 2b — migrate the remaining 24 pages in slices, then sidebar hierarchy and density.

### 2026-09-16 — Claude Code (Fable 5.1), shell part 1: touch targets
- Did: resumed per §3 (git matched the file; baseline 701/0, 3147, 202). Audited every `h-11` site: most decorative; the real finding is broader — root font 14px makes `h-10` 35px, so default/lg/icon buttons, Input, SelectTrigger and two Topbar overrides were all under 44px. Fixed with absolute px; `sm` and the compact toolbar/table controls deliberately kept, with reasons in the changelog. No dependency, env var, flag or migration.
- Verified with: live Playwright on Tickets + Log timesheet at 390 and 1366, light and real dark: zero overflow, primitives at 44px, top bar holds them; remaining sub-44 controls enumerated and each classified as a design decision. Sequential gates after the last edit: lint 701/0 + ratchet, API 3147/3147, web 202/202, diff-check clean.
- Left off at: shell part 2 — hierarchy nav, breadcrumb/view tabs, density, responsive containment. Date-picker height is the first candidate.

### 2026-09-16 — Claude Code (Fable 5.1), explicit mode + per-user accents
- Did: resumed per §3 (branch/log/status agreed with this file; baseline matched). Shipped the Phase 2 accent unit: `packages/shared/src/appearance.ts` (3 modes, 7 measured accents, guards); additive `User.appearance` JSON column + idempotent migration (MySQL/MariaDB); profile PATCH validates against the SHARED enum and reads back through guards; `theme.ts` gains `applyMode`/`applyAccent`/`adoptSavedAppearance`/`currentMode`/`currentAccent`; auth store adopts a saved preference at its two setters; Profile → Appearance card (saves on click, radio semantics, ≥44px); Help article + Unreleased changelog. No dependency added, no env var, no flag (the column is nullable and NULL renders as today's screens).
- Verified with: 11 new web unit regressions + 7 API contract tests; 7/7 deliberate breaks RED (after fixing the harness detector); live Playwright at 390/768/1366 in light+dark: paint-before-network, PATCH 200 with the saved shape, dark re-paint with dark foreground, reload restores from profile, no horizontal overflow, all targets ≥44px, keyboard Enter selects. Migration applied and recorded on the dev DB; column confirmed; dev account restored to NULL. Sequential gates after the last edit: lint 701/0 + ratchet, API 3147/3147, web 202/202, diff-check clean.
- Left off at: (superseded by the entry above — the touch-target audit is done.)

### 2026-09-16 — Codex, ClickUp research and theme foundation
- Did: resumed branch/checks; compared 32 capability areas with official ClickUp sources; prioritized existing-surface improvements; fixed theme lifecycle/label synchronization; updated shared Help and Unreleased notes.
- Verified with: eight new unit regressions plus full suites (3140 API, 191 web), build, lint/types (unchanged warning count), diff check and AST graph update; browser fixture uses real app shell with mocked API, six viewport/mode combinations, OS/palette/reload checks. Screenshots and fixture in ignored `test-results/run-shots/v12-theme-*.png` and `test-results/v12-theme-browser.mjs`.
- Left off at: explicit System mode and per-user accent preferences on Profile, then shell improvements. Current fix is not full Phase 2 completion.

### 2026-09-16 — Codex
- Did: read project instructions; created required branch; discovered no prior V12 state; recorded architecture/module map; reproduced and corrected test-only SMTP isolation defect.
- Verified with: baseline build/lint/API/web test runs; isolated identity test reproduced baseline timeout. After fix, `npm run build`, `npm run lint`, `npm test`, and `git diff --check` all passed. Graph update attempted but unavailable as recorded above.
- Left off at: official ClickUp research and full matrix. No UI parity claim, feature release, schema change or deployment performed.
