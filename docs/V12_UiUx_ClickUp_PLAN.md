# V12_UiUx_ClickUp — Living Plan & Handoff State
> Any agent: read §3 of SYSTEM_PROMPT_V12_UiUx_ClickUp.md, then this file before working.
> Branch: V12_UiUx_ClickUp — NEVER merge to main.

## Current Status
- Phase: 0 discovery and baseline hardening complete. Phase 1 research next.
- Last updated: 2026-09-16 by Codex.
- Baseline checks: build PASS (existing large-chunk warning); lint/types PASS (701 warnings, zero errors, ratchet passes); API tests 3139/3140, one reproducible SMTP timeout; web tests 183/183 PASS.
- Post-fix checks: build PASS; lint/types PASS (701 warnings, zero errors, ratchet passes); API 3140/3140 and web 183/183 PASS; `git diff --check` PASS.
- Starting commit: `0be01b8` (5.2.1). Branch created from `origin/main`, which matched the original V11 checkout. No main changes or remote push.
- Last commit: resolve with `git log -1`; this handoff is committed alongside the baseline test fix.

## Next Actions (ordered; first unchecked = resume point)
- [x] Phase 0: inventory architecture, commands, existing modules and design foundation.
- [x] Reproduce baseline test timeout and isolate the unit test from developer SMTP configuration.
- [ ] Phase 1: research official ClickUp sources and fill every required Feature Matrix area; inspect existing implementations before assigning parity status.
- [ ] Phase 2: plan enhancements to the existing theme module/tokens and shell; preserve current defaults, introduce no competing styling system.
- [ ] Phase 3: implement verified gaps by priority, with tests and shipping surfaces updated.
- [ ] Phase 4: responsive/accessibility/workflow checks and continuous hardening.
- [ ] Phase 5: branch-only release preparation and clean install/update validation.

## In Progress / Half-done
- No half-finished application edits. Completed test-only fix in `apps/api/tests/unit/agent-identity-invariants.test.ts` plus this state file.
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
| Full required inventory | Unverified; official research pending | See module map above | Unverified | Audit before selecting additions | P0 | No |

Research must cover hierarchy, tasks/subtasks, custom fields/statuses, tickets, all requested views, sprints, time, goals, forms, dashboards, automations, search, docs, whiteboards, collaboration, inbox, AI/agents/MCP, integrations, templates, permissions, personalization, shortcuts, responsive behavior, onboarding. Record official source URLs per row; route presence alone does not establish parity.

## Design System Decisions
- Tokens: extend existing CSS variables/Tailwind mapping.
- Themes: preserve current light/dark defaults; audit preference persistence before adding palettes.
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

## Open Questions / Blockers
- `RTK.md` referenced by user AGENTS instructions is absent; no matching repository file found.
- `python -m graphify query ...` and `python -m graphify update .` fail: `No module named graphify`. Recorded `graphify-out/.graphify_python` points to the same `C:\Python314\python.exe`. Graph is not refreshed; used direct source/document reads. Restore tool installation before relying on graph freshness.
- `.Codex/skills/ship-feature/SKILL.md` is absent. Available catalog points to `.agents/skills/ship-feature/SKILL.md`; read that or locate `.claude` copy before landing a feature. This session changes no product feature or release version.
- Branch was created from locally available origin/main. No network fetch was performed; upstream freshness is unverified. Removed inherited origin/main tracking to avoid accidental pushes to main; no remote branch published.
- User-owned pre-existing untracked `.claude/settings.local.json`, `.codex/`, `AGENTS.md`, `SYSTEM_PROMPT_V12_UiUx_ClickUp.md` were preserved and excluded from commits.

## Session Log (newest first)
### 2026-09-16 — Codex
- Did: read project instructions; created required branch; discovered no prior V12 state; recorded architecture/module map; reproduced and corrected test-only SMTP isolation defect.
- Verified with: baseline build/lint/API/web test runs; isolated identity test reproduced baseline timeout. After fix, `npm run build`, `npm run lint`, `npm test`, and `git diff --check` all passed. Graph update attempted but unavailable as recorded above.
- Left off at: official ClickUp research and full matrix. No UI parity claim, feature release, schema change or deployment performed.
