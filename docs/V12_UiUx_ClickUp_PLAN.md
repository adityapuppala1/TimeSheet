# V12_UiUx_ClickUp — Living Plan & Handoff State
> Any agent: read §3 of SYSTEM_PROMPT_V12_UiUx_ClickUp.md, then this file before working.
> Branch: V12_UiUx_ClickUp — NEVER merge to main.

## Current Status
- Phase: 1 source-based gap analysis complete; Phase 2 theme lifecycle foundation implemented.
- Last updated: 2026-09-16 by Codex.
- Resumed baseline: build PASS (existing large-chunk warning); lint/types PASS (701 warnings, zero errors, ratchet passes); API 3140/3140 and web 183/183 PASS.
- Post-change checks: build PASS; lint/types PASS (701 warnings, zero errors, ratchet passes); API 3140/3140 and web 191/191 PASS; diff check PASS. Browser: actual app shell with mocked API passed at 390/820/1440 pixels in light/dark, no horizontal overflow/page errors; OS changes, palette/toggle synchronization and explicit reload verified.
- Starting commit: `0be01b8` (5.2.1). Branch created from `origin/main`, which matched the original V11 checkout. No main changes or remote push.
- Prior checkpoint: `ff683c1` baseline test isolation. Resolve current checkpoint with `git log -1`.

## Next Actions (ordered; first unchecked = resume point)
- [x] Phase 0: inventory architecture, commands, existing modules and design foundation.
- [x] Reproduce baseline test timeout and isolate the unit test from developer SMTP configuration.
- [x] Phase 1: research official ClickUp sources and fill every required Feature Matrix area; inspect existing implementations before assigning parity status.
- [x] Phase 2 plan: repair theme lifecycle first; next extend existing tokens/preferences, then shell navigation. Preserve current defaults and existing styling system.
- [x] Phase 2 first unit: preserve implicit OS preference and synchronize existing theme controls, with regression tests.
- [ ] Phase 2 next unit: add explicit light/dark/system selection and original accent palettes in Profile; design per-user persistence using existing profile API with an additive migration if needed. Verify contrast before enabling palettes, plus phone/tablet/desktop and keyboard use.
- [ ] Phase 2 shell: audit hierarchy navigation, breadcrumb/view tabs, density, focus/touch-target sizing and responsive containment on existing components.
- [ ] Phase 3: implement verified gaps by priority, with tests and shipping surfaces updated.
- [ ] Phase 4: responsive/accessibility/workflow checks and continuous hardening.
- [ ] Phase 5: branch-only release preparation and clean install/update validation.

## In Progress / Half-done
- Phase 2 first unit plan: separate implicit OS theme from an explicit saved choice in `lib/theme.ts`.
- Subscribe to OS/storage changes with cleanup; preserve explicit choices even when storage is blocked.
- Make the existing theme toggle subscribe to the shared rendered theme so palette changes cannot leave its label stale.
- Add regression coverage for reloads, OS changes, storage failure, subscription cleanup and the actual toggle; verify in browser. New palettes and per-user persistence remain subsequent units.
- Theme lifecycle code/test/help/changelog edits complete and verified. No half-finished code. Full Phase 2 remains open.
- Final verification commands: `npm run build`, `npm run lint`, `npm test`.
- Local ignored logs: `baseline-v12-*.log`; do not commit them.

## Codebase Map (verified facts only, with file paths)
- Stack: npm workspace TypeScript monorepo (`package.json`, `apps/*`, `packages/*`). Manifest ranges: React ^19.2.8, React Router ^8.3.0, Vite ^8.1.5, Express ^5.1.0, Prisma ^6.7.0, TypeScript ^5.8.3. These are declared ranges, not a claim about every installed version.
- Package manager: npm, root `package-lock.json`; do not mix managers.
- Commands: `npm run dev`, `npm run build`, `npm run lint`, `npm test`; lint includes API/web TypeScript checks, SonarJS ESLint and warning ratchet. Shared TypeScript is checked by its build. No root standalone typecheck script.
- Styling & theming: `apps/web/src/index.css` CSS variables, `apps/web/tailwind.config.ts` Tailwind 3/class dark mode, Radix UI wrappers in `apps/web/src/components/ui/`. Existing primary/accent/status/planning tokens and radius. `apps/web/src/lib/theme.ts` resolves OS theme initially and persists explicit light/dark choice in localStorage; shared transition helper handles reduced motion. Per-user accents/system subscription still need detailed audit.
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
| Projects/Spaces/Folders/Lists | [Nested hierarchy][cu-hierarchy] | Prisma Project/ProjectModule/ProjectSubmodule; Sidebar.tsx flat sections | Partial | Enhance navigation over existing project hierarchy | P1 | Audit complete |
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
| Themes/color/icons/density | [Personal colors/light/dark/auto][cu-settings] | lib/theme.ts, CSS tokens, Lucide; browser-wide light/dark only, no user accent/density fields found | Partial | Extend existing foundation/per-user preferences; original palettes | P0 | Audit complete |
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
- Themes: absence of a saved choice follows device changes; explicit browser choice persists. All controls subscribe to the same rendered theme. Explicit system selection/per-user palettes remain next; no additional palettes or density options shipped yet.
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

## Open Questions / Blockers
- `RTK.md` referenced by user AGENTS instructions is absent; no matching repository file found.
- Graph query works on resume (package 0.9.30, installed skill 0.9.53 warning); prior missing-module blocker is resolved. `python -m graphify update .` passed: 9294 nodes, 21676 edges, 572 communities. Semantic documentation refresh remains pending; use this state file directly for current research.
- `.Codex/skills/ship-feature/SKILL.md` remains absent; read the available `.agents/skills/ship-feature/SKILL.md` instead. Run-timesphere driver paths have the same stale prefix; actual tools are in `.agents/skills/run-timesphere/`.
- Only MySQL was running. Started Vite frontend for a mocked-API browser check; did not start production cron workers or send mail. Full real-backend workflow, accessibility certification and new color palettes are not claimed by this unit.
- `docs/AGENTIC_UX_PLAN.md` says FORM_SUBMISSION was not wired; inspected current public controller and dispatcher prove it now is. Treat current source as authoritative.
- Branch was created from locally available origin/main. No network fetch was performed; upstream freshness is unverified. Removed inherited origin/main tracking to avoid accidental pushes to main; no remote branch published.
- User-owned pre-existing untracked `.claude/settings.local.json`, `.codex/`, `AGENTS.md`, `SYSTEM_PROMPT_V12_UiUx_ClickUp.md` were preserved and excluded from commits.

## Session Log (newest first)
### 2026-09-16 — Codex, ClickUp research and theme foundation
- Did: resumed branch/checks; compared 32 capability areas with official ClickUp sources; prioritized existing-surface improvements; fixed theme lifecycle/label synchronization; updated shared Help and Unreleased notes.
- Verified with: eight new unit regressions plus full suites (3140 API, 191 web), build, lint/types (unchanged warning count), diff check and AST graph update; browser fixture uses real app shell with mocked API, six viewport/mode combinations, OS/palette/reload checks. Screenshots and fixture in ignored `test-results/run-shots/v12-theme-*.png` and `test-results/v12-theme-browser.mjs`.
- Left off at: explicit System mode and per-user accent preferences on Profile, then shell improvements. Current fix is not full Phase 2 completion.

### 2026-09-16 — Codex
- Did: read project instructions; created required branch; discovered no prior V12 state; recorded architecture/module map; reproduced and corrected test-only SMTP isolation defect.
- Verified with: baseline build/lint/API/web test runs; isolated identity test reproduced baseline timeout. After fix, `npm run build`, `npm run lint`, `npm test`, and `git diff --check` all passed. Graph update attempted but unavailable as recorded above.
- Left off at: official ClickUp research and full matrix. No UI parity claim, feature release, schema change or deployment performed.
