# TimeSphere documentation

> **Audience:** everyone · **Type:** index · Start at the [project README](../README.md) for what
> the product is.

Every markdown document in this repository, what it is for, and who it is written for. **Each topic
has exactly one home.** If a topic is listed against a file below, that file owns it, and every other
document links there rather than explaining it again. A second copy of an explanation goes out of
date on its own, and then the two copies disagree.

## Start here

| I want to… | Read |
|---|---|
| Understand what TimeSphere does | [README.md](../README.md): overview, feature table, quick start |
| Install it: one-click Docker, local without Docker, or Kubernetes | [INSTALLATION.md](INSTALLATION.md) |
| Run it in production, update it, or look up an environment variable | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Harden a deployment, bring a new organization online, or run the platform-admin console | [NEW_ORGANIZATION_SETUP.md](NEW_ORGANIZATION_SETUP.md) |
| Learn the app as a user | The in-app manual at **`/app/help`** (it also answers Ask AI), plus [UI_GUIDE.md](UI_GUIDE.md) |
| Understand how the system is built | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Call the REST API, receive webhooks, or connect an AI assistant over MCP | [API.md](API.md) |
| Change the code and get it merged | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| See what changed, or what is coming | [CHANGELOG.md](../CHANGELOG.md), then [ROADMAP.md](ROADMAP.md) |
| Report a vulnerability | [.github/SECURITY.md](../.github/SECURITY.md). Report privately, not as an issue |

## All documents

The **Type** column follows [Diátaxis](https://diataxis.fr/): a *how-to* gets a task done, a
*reference* is looked up, an *explanation* says why, and a *record* says what happened.

### Getting started

| Document | Type | For | Covers |
|---|---|---|---|
| [README.md](../README.md) | Overview | Everyone | What the product is, the feature table, "By the numbers", the quick start, links here |
| [INSTALLATION.md](INSTALLATION.md) | How-to | Anyone installing | One-click install, manual local install, demo credentials, `npm run doctor`, configuring things after install (including AI providers), FAQ, troubleshooting |

### Using the product

| Document | Type | For | Covers |
|---|---|---|---|
| In-app manual, `/app/help` (source: `packages/shared/src/help-articles.ts`) | How-to | Every user, filtered by role | Task-by-task help with the real navigation path. Ask AI answers how-to questions from the same articles. It is not markdown, but it is the user manual |
| [UI_GUIDE.md](UI_GUIDE.md) | How-to + reference | Everyday users | Appearance, the command palette, keyboard shortcuts, navigation, ticket views and saved views, custom fields, sprints, dashboards, workspace settings layout |
| [FACE_VERIFICATION.md](FACE_VERIFICATION.md) | How-to + explanation | Super admins and operators | The server-side identity check, the biometric-data obligations it carries, setup, threshold calibration, retention and deletion, failure handling |
| [SECURITY_DEVOPS_INTEGRATIONS.md](SECURITY_DEVOPS_INTEGRATIONS.md) | How-to | DevOps and security engineers | Sending scanner findings from any CI, SonarQube and ESLint, VAPT uploads, verified remediation, routing findings to projects, error trackers, git webhooks |

### Operating a deployment

| Document | Type | For | Covers |
|---|---|---|---|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Reference + how-to | Operators | The two deployment shapes, environment profiles, HTTPS, reverse proxies, outbound and header security, CI/CD, **updating, with version-specific upgrade notes**, telemetry, the MCP server, storage and logs, Kubernetes, sizing, a self-hosted model, **the environment variable reference** |
| [NEW_ORGANIZATION_SETUP.md](NEW_ORGANIZATION_SETUP.md) | Runbook | Platform operators | The one-time production-hardening checklist (secrets, TLS, patching, backups, logs), then the repeatable steps to bring an organization online, configure it and verify go-live |

### Understanding and changing the code

| Document | Type | For | Covers |
|---|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Explanation + reference | Engineers and AI coding assistants | Core concepts (database-per-tenant, auth, the AI choke point, the planning and agentic layers…), the request lifecycle, a module reference, data-flow diagrams, the glossary |
| [API.md](API.md) | Reference | Integrators and engineers | Every endpoint group, the public REST API and outbound webhooks, the MCP server |
| [DATABASE.md](DATABASE.md) | How-to + reference | Engineers writing migrations | The migration workflow (replay into an empty database, fan out to every tenant, backfills), then schema notes by domain. `apps/api/prisma/schema.prisma` is the source of truth |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How-to | Contributors | Getting a checkout, testing, reading the lint ratchet, how the codebase expects to be extended, keeping docs current, releasing a version |
| [MARKETING_PAGES.md](MARKETING_PAGES.md) | Explanation + rules | Anyone editing `/`, `/pitch` or `/login` | Every claim maps to shipped code, the animation budget, generated screenshots, layout constraints |
| [ONBOARDING_AND_TOUR.md](ONBOARDING_AND_TOUR.md) | Explanation | Engineers | The first-run gate and the product tour, and how to test them |
| [ship-feature skill](../.claude/skills/ship-feature/SKILL.md) | Checklist | Anyone landing a feature | Every surface that must move with a new feature, and the test that fails when one is forgotten |
| [run-timesphere skill](../.claude/skills/run-timesphere/SKILL.md) | How-to | Anyone verifying a change | Starting the app, signing in, and checking a page in the real UI |

### Plans, history and records

| Document | Type | Status | Covers |
|---|---|---|---|
| [ROADMAP.md](ROADMAP.md) | Plan | Living | What differentiates the product, next-feature themes, plan-tier mapping, open dependency advisories, out of scope, and the production-readiness backlog (resolved items stay, struck through) |
| [V12_UiUx_ClickUp_PLAN.md](V12_UiUx_ClickUp_PLAN.md) | Plan + hand-off state | Living | The current work plan, next actions, and the session log that AI coding tools hand off through. Keep its format exactly |
| [SIGNUP_AND_DOMAINS_PLAN.md](SIGNUP_AND_DOMAINS_PLAN.md) | Plan + design record | Phases 0 and 1 built (unmerged) | Self-serve signup: the off switch, refused domains, operator notifications, and one workspace per company domain (join requests, domain claims, signup analytics) |
| [SIGNUP_PHASE1_BUILD_PLAN.md](SIGNUP_PHASE1_BUILD_PLAN.md) | Implementation plan | Built (all 15 tasks) | Phase 1 of the signup plan as 15 tasks, each with its files, interfaces, tests first, and its commit |
| [AUDIT_2026-10.md](AUDIT_2026-10.md) | Explanation + record | Fixes built (unmerged) | The 2026-10-02 whole-application audit: the verdict per area, each decision with the standard behind it, what changed for organizations already using Google/Microsoft/SAML sign-in, analytics metric definitions, proposals in priority order, upgrade notes |
| [ENGINEERING_LOG.md](ENGINEERING_LOG.md) | Record | Append-only | Dated write-ups of each unit of work: what was found, measured, decided and fixed |
| [CHANGELOG.md](../CHANGELOG.md) | Record | Per release | User-facing release notes. The in-app **What's new** page parses this file, so its heading format matters |
| [AGENTIC_WORK_MANAGEMENT.md](AGENTIC_WORK_MANAGEMENT.md) | Design record | Built (2.5.0) | V8: Goals, the Inbox, the agent roster, the Workflow Studio, the agent ledger. Why each was shaped the way it was |
| [AGENTIC_UX_PLAN.md](AGENTIC_UX_PLAN.md) | Design record | Complete | V8's screens: the flow canvas, dispatch, run visibility, mobile |
| [AI_AND_AUTOMATION_FOR_CHANGE.md](AI_AND_AUTOMATION_FOR_CHANGE.md) | Design record | Built | AI, agents and workflows for tickets and change management, and the one thing that must never be automated |

### Policies, templates and tool instructions

| File | Purpose |
|---|---|
| [.github/SECURITY.md](../.github/SECURITY.md) | How to report a vulnerability privately, the protections already in place, and two design points to understand before deploying |
| [.github/pull_request_template.md](../.github/pull_request_template.md) | What a PR states about its verification and the docs it updated |
| [.github/ISSUE_TEMPLATE/](../.github/ISSUE_TEMPLATE/) | Bug report and feature request forms |
| [CLAUDE.md](../CLAUDE.md) | Instructions Claude Code loads automatically: the knowledge-graph commands and the ship-feature pointer |

## Where new documentation goes

| You are adding… | Write it in |
|---|---|
| An install or first-run step | [INSTALLATION.md](INSTALLATION.md) |
| An environment variable | [DEPLOYMENT.md § Environment variable reference](DEPLOYMENT.md#environment-variable-reference), and `.env.example`. Forward it in both compose files and the Helm chart too, or it does not exist inside a container |
| An upgrade an operator must act on | A `CHANGELOG.md` entry, plus a line in DEPLOYMENT.md's version-specific upgrade notes |
| A module, service, worker or data flow | [ARCHITECTURE.md](ARCHITECTURE.md), in the same PR. An out-of-date ARCHITECTURE.md is a bug |
| An endpoint | [API.md](API.md) |
| A schema change | [DATABASE.md](DATABASE.md) |
| A user-facing feature | A help article in `packages/shared/src/help-articles.ts`. Also update the README feature table if it is a headline capability, and [UI_GUIDE.md](UI_GUIDE.md) if it changes how the interface works. The [ship-feature skill](../.claude/skills/ship-feature/SKILL.md) lists every other surface |
| Something you found, measured or fixed that is worth keeping | An entry appended to [ENGINEERING_LOG.md](ENGINEERING_LOG.md). If it stays open, also add an item to the backlog in [ROADMAP.md](ROADMAP.md) |
| A subject with no home above | A new file in this folder, plus a row in this index |

## Conventions

- **The folder is flat, and file names never change.** Doc paths are cited from code comments, CI
  workflows, the Dockerfile, `.env.example`, text shown in the app, and applied Prisma migrations,
  which cannot be edited without breaking their checksums. Renaming or moving a doc would strand
  those references, so add a new file rather than reorganising an old one. Existing heading text is
  just as load-bearing, because many references are `#anchor` links. Add new headings rather than
  renaming old ones.
- **Every document opens with who it is for and what type it is**, and links back to this index.
- **Link, don't restate.** One or two sentences of context and a link beat a paragraph that has to
  be kept in step.
- **Claims are checkable.** Name the file and function, date anything that can go stale, and say
  whether a figure was measured or assumed. That is the standard the existing documents hold
  themselves to.
- **Records are not rewritten.** A CHANGELOG section or an ENGINEERING_LOG entry describes the code
  on its date. When later work changes the picture, write a new entry.
