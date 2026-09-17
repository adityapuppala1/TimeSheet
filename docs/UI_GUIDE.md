# UI guide — personalisation, navigation and working faster

> Written for people who use TimeSphere every day. Every feature below exists in the app as of the
> V12 line; the file and route it lives at is named so an engineer can find it too. Where a
> behaviour was measured rather than assumed, the measurement is stated.

Related: [ONBOARDING_AND_TOUR.md](ONBOARDING_AND_TOUR.md) (first sign-in, the tour) ·
[API.md](API.md) (the endpoints behind these screens) · the in-app manual at `/app/help`, which
also answers Ask AI.

---

## 1. Appearance — theme, accent, density

**Where:** `/app/profile` → the **Appearance** card. Saved to your profile, so every device you
sign in on matches; a saved choice wins over whatever a shared browser had before.

| Setting | Choices | Notes |
|---|---|---|
| Theme | System · Light · Dark | *System* follows your OS and is stored as "no choice", never as a value — so it keeps following the OS after a reload. |
| Accent | Teal (default) · Indigo · Violet · Rose · Amber · Emerald · Sky | Every accent was measured against WCAG 2.1 AA on both themes, as a fill with text on it and as text on the page. Dark-theme fills carry dark text because no hue passes AA as white-on-dark. Teal is the app's original colour, pixel-identical to before the setting existed. |
| Density | Comfortable · Compact | Compact moves the root font from 14px to 13px, the same lever the app has always used for density; every rem-based size follows. Buttons, inputs and selects stay at 44px in both. |

The top-bar moon/sun toggle and the command palette's "Toggle theme" change the same setting.

Engineering: `packages/shared/src/appearance.ts` (the one definition both apps compile against),
`apps/web/src/lib/theme.ts`, `User.appearance` JSON column, `PATCH /api/auth/profile`.

## 2. Command palette and record search

**Open it:** `Ctrl K` (`⌘ K` on a Mac) from anywhere, even while typing in a field, or click the
search box in the top bar.

- **Pages and actions** you can use, filtered by your role — a page you cannot open is not listed.
- **Records as you type:** two or more characters return up to five **tickets** (by key or title)
  and five **projects** (by code or name). A ticket opens straight into its detail sheet; a project
  opens Tickets filtered to it. Key-prefix matches rank first, so `WEB-1` finds `WEB-1x` before a
  ticket whose title merely mentions it. One request per pause in typing.
- **Ask AI** stays a separate item for natural-language questions over the backlog.

Record search reads through the same project scope every ticket route enforces, so it can never
show you a ticket you could not open. Engineering: `GET /api/search?q=`,
`apps/api/src/services/search.service.ts`, `apps/web/src/components/command-palette.tsx`.

The palette also finds **Changes** by key or title and **Documents** (requirements documents) by title,
each opening its own page. If you manage users, it also lists **People** by name or email; choosing one opens
Administration → Users with the search box pre-filled (`/app/users?search=…`).

## 3. Keyboard shortcuts

Press `?` anywhere for the full list **for your role and the page you are on**. Single keys and
sequences are ignored while you are typing in a field, an editor or an open dialog; the palette
chord works everywhere.

| Keys | Does |
|---|---|
| `Ctrl K` / `⌘ K` | Command palette |
| `?` | Shortcuts dialog |
| `N` | Log time |
| `C` | Create a ticket (the dialog opens on arrival) |
| `G` then `H` / `L` / `T` / `W` / `I` / `P` | Go to Home / Log timesheet / Tickets / My work / Inbox / Profile |
| **Inbox only:** `J` / `K` | Next / previous item (marks it read, keeps it in view) |
| **Inbox only:** `E` | Mark the selected item done — on the To-do tab the item leaves the queue and the selection advances; on the Done tab, `E` undoes |
| **Inbox only:** `S` | Snooze until later today |

None of the app's shortcuts use `Ctrl N`, `Ctrl T` or `Ctrl W`: browsers reserve those and a page
cannot intercept them. Engineering: one table in `apps/web/src/lib/shortcuts.ts`; the `?` dialog,
the palette's hints and the Help article all render from it.

## 4. Getting around

- **Breadcrumb.** Every in-app page shows *Section › Page* under the top bar, derived from the
  sidebar's own navigation table — never typed per page, so it cannot drift from the sidebar.
- **Projects tree** in the sidebar (under *Work*): the projects you can see, each with a colour
  mark, folding open to its modules. The mark's colour is chosen per project under Administration
  → Projects → Edit (eight measured colours, or "Auto" for one derived from the project) and is
  the same wherever the project is named. A row opens Tickets filtered to that project or module; which projects you left
  open is remembered per browser. There is no submodule tier because a ticket carries a project
  and optionally a module, never a submodule. Not shown in the slim 68px rail.
- **Phone and tablet:** the sidebar becomes a drawer (menu button, top left) and the five
  everyday destinations sit in a bottom bar. Every table scrolls inside its own container; the page
  itself never scrolls sideways (measured at 390 and 768px across every app route).

## 5. Tickets — views, grouping, columns, saved views

**Views bar:** List · Board · Timeline · Calendar as tabs directly under the page title, with your
saved views after them. Filters carry across all four. The toolbar under the bar leads with the
**Group by** menu, which shows the current grouping.

**Group by** (List view): Status, Priority, Type, Project, Assignee or Sprint. Each group gets a
heading with its size across *everything the filters match*, not just the page on screen, and
collapses on click. Status and priority headings carry the same colour as the pills in their rows;
project headings carry the project's mark. Your column sort still applies within each group. Phone cards group the same way.

**Columns:** the **Columns** button on the table lets you hide built-in columns and show one for
any custom field. Custom-field columns start hidden, so a table never widens because an admin
added a field; S.No and Title always stay. The button counts what is hidden.

**Saved views** remember filters, grouping *and* columns. Views saved before these existed keep
their look. A column for a field that was later deleted is simply ignored.

**Status from the list:** the status pill on every row (table and phone cards) is a menu; pick the
next status without opening the ticket. The server decides what is legal, exactly as it does from
the ticket sheet, and a refusal shows its reason and points you to the sheet. Board columns wear
the same status colour as a top border.

**Calendar.** The Calendar view has **Day**, **4 days**, **Week** and **Month** periods (the segmented
control beside prev | Today | next; prev and next step by the period's length). If you can plan, drag a chip onto another day to reschedule it: a scheduled
item keeps its length, an unscheduled one (dashed, shown on its SLA date) becomes scheduled on the
day you drop it. The target day shows a ring while you hover. Drag is a pointer gesture; from the
keyboard, change dates in the ticket sheet's **Plan** tab.

**Mentions.** In a ticket comment, type **@** and pick a project member; they get an inbox item that
opens the ticket. Arrow keys move the list, Enter picks, Escape closes. Only people on the project
are offered, so a mention cannot reach someone the ticket would not.

**Assigned comments.** "Assign to" beside Post comment turns the comment into an action item for a
project member: they get an inbox item and the comment is listed under **Comments assigned to you**
at the top of My work. Anyone who can see the ticket may tick **Resolve**; the resolver's name shows
beside the tick and the assigner hears. The Comments tab badge counts unresolved assigned comments.

**Related documents.** The ticket's **Linked** tab also lists requirements documents; pick one from
the Studio's list to relate it. A document page shows **Related tickets** (add by key, open, unlink),
reading through the same project scope as the Tickets page.

**From a document to tickets.** When you accept tickets proposed from a requirements document,
each one comes back already related to that document — see it on the document's **Related tickets**
card and on the ticket's **Linked** tab.

**Motion.** Board columns arrive with a short staggered rise and controls give way under the
pointer. If your system asks for reduced motion you get none of it — the effects are not defined at
all in that case.

**Instant feedback.** Dragging a card between board columns, ticking a checklist item and resolving
an assigned comment all change immediately rather than after a round trip. If the server refuses,
the change is undone and the error explains why.

**Flow runs.** In the **Workflow Studio**, "What they have done" filters by flow and by status and
groups runs under Today, Yesterday or the date. Clearing the filters restores the whole feed.

**Agent runs.** Under **Workspace settings → AI**, the Agent runs list filters by status and by
when a run happened, and groups what it finds under Today, Yesterday or the date. Clearing the
filters restores the full list.

**Your stand-up.** At the top of **My work**, pick a period and press **Write it**: the AI phrases
your own recent tickets, comments and logged hours as a short first-person stand-up you can copy.
Nothing is invented — an empty period says so instead. The card is only there when the workspace has
AI status writing switched on. If you manage people, a picker beside the period offers your direct
reports (an admin sees everyone): their stand-up is written **about** them in the third person, from
the work you can already see.

**Studio list.** The Requirements Studio list has a search box, a **Show** menu (All documents,
Created by me, Archived), a type filter and a sort. Show, type and sort are remembered in this
browser. Rows name the creator and count related tickets.

**Colour.** The ticket sheet's header is tinted with the project's colour; phone cards carry a
left rail in the status colour; views fade in as they change unless your system asks for reduced
motion. All of it is measured by the contrast check, none of it is animation you cannot switch off.

**The ticket sheet in two columns.** The sheet still opens at its remembered width. Drag its left
edge out to 960px or wider, or press **Maximize** (top-right; `Home` on the resize handle), and it
becomes two columns: status, assignee, collaborators, labels, description, watchers, sprint and
custom fields on the left; the Comments · Files · Checklist · … · Activity tabs on the right, in
their own scroll. **Hide activity** at the end of the badge row closes the right column so the
details and description have the whole width at a readable measure; **Show activity** brings it
back. The choice is remembered in this browser. Below 960px, and on a phone, the sheet is the
single column it always was.

**Empty states** say why: with filters narrowing the list, "No tickets match these filters" and a
**Clear filters** button; with nothing applied, "No tickets yet" and no button it cannot honour.

## 6. Custom fields on a ticket

Admins define fields under **Workspace settings → Planning**. Every ticket whose type the field
applies to shows a **Fields** section in its detail sheet, above the tabs:

- Editors by type: text · number and currency · date · URL · single select · multi-select chips ·
  checkbox · people picker.
- Each field saves on its own (change for selects and chips, blur or Enter for typed fields), then
  shows what the server *kept* — `12,000` typed into a number field comes back as `12000`.
- A rejected value (required, bad URL, unknown option) shows the reason beside the field and keeps
  your input to fix. Clearing a field really clears it.
- People who can see but not work on the ticket get the values as text. Tickets in a workspace
  with no fields look exactly as before.

Engineering: `GET`/`PUT /api/tickets/:id/custom-fields`, `apps/web/src/components/TicketCustomFields.tsx`.

## 7. Sprints

**Where:** `/app/sprints` (under *Plan* in the sidebar) once a super admin turns on **Workspace
Settings → Planning → Sprints**; sprints need the planning layer on as well. Off by default, and
turning it off hides the pages without touching data.

- **Per project:** pick a project, create iterations (name, optional goal, start and end dates),
  start one, complete it. One sprint is active per project at a time; the API refuses a second.
- **Tickets join from their detail sheet** (Sprint and Story points fields; whole or half points)
  and can only join a sprint of their own project. The Tickets list filters and groups by sprint.
- **Burndown:** remaining points per day against the ideal line, replayed from the audited status
  changes — exact for days that have happened, blank for days that have not. With no estimates it
  reads open tickets instead and says so. Deleting a sprint un-plans its tickets, never deletes.
- **Creating into a sprint:** filter the Tickets list by a sprint, or group it by sprint, and both
  **New ticket** and the **Add ticket** row under a group open the dialog with that sprint chosen
  in a **Sprint** field (shown only when sprints are on and a project is picked). The new ticket
  lands in the group you were looking at. The Sprint column exists too — hidden until you tick it
  under **Columns**.

Engineering: `apps/api/src/controllers/sprint.controller.ts`, `apps/api/src/services/sprint.service.ts`
(pure `burndown`), `apps/web/src/pages/Sprints.tsx`, `apps/web/src/components/TicketSprintFields.tsx`.

## 8. Custom dashboards

**Where:** `/app/dashboards` (planning feature on). Build a grid from a **closed catalogue** of
widgets — every tile is one server-defined query, so two dashboards showing "Open work" can never
disagree, and a shared dashboard shows each viewer only their own permitted projects. Twelve
widgets: open items, overdue, hours logged, budget burn, created vs resolved, status mix,
**priority mix**, **open work by project**, project risk, capacity, upcoming milestones, my queue.
The two in bold arrived with V12 and use exactly the definition of "open" the status mix uses.

Engineering: `apps/api/src/services/dashboard.service.ts` (`WIDGET_CATALOGUE`, `resolveWidget`).

## 9. Empty states everywhere

Lists and panels that have nothing to show use one design: an icon, a title, a line of explanation
and, where one honestly exists, a next action. Where the input sits right beside the list (ticket
comments, checklist, links) there is deliberately no button. A search or filter that matches
nothing offers **Clear** (Email templates analytics, API performance, AI capabilities), and the
Face verification review queue offers **Show all attempts** when only flagged ones are shown.
Engineering:
`apps/web/src/components/ui/empty-state.tsx`, promoted from the platform console's kit.

---

## 10. Portfolio in 3D

On Plan → Portfolio, **Show 3D** (above the Projects table) draws the projects as spheres: bigger
for more open work, in each project's colour. Hover one for its name and numbers, click to open its
tickets. It is off until you switch it on, remembered in this browser, still under reduced motion,
and absent without WebGL — the table always has everything.

## 11. Timeline zoom

The Timeline (Plan → Timeline) zooms Day, Week, Month, **Quarter** and **Year**. Quarter shows month
ticks with the quarter named on its first month ("Q4 26"); Year shows quarter ticks only and is an
overview, not a place to read dates; a one-day task still draws as a mark at every zoom.
Dragging, dependencies, baselines and the critical path work at every zoom. If you can plan, **Add
work item** at the foot of the tree opens the New ticket dialog for the project you are viewing.

## 12. Workload measures

The Workload board (Plan → Workload, needs the resource permission) has a **Measure** control:
**Hours booked** (the original: bookings against capacity, with logged hours for comparison),
**By person / By project** (a project row with its people inside; the project row totals hours,
tickets and points and carries no capacity, because capacity belongs to a person),
**Tickets** and **Story points**. The two new measures count each person's open assigned tickets
in the weeks their scheduled span covers, or the week of the SLA date when nobody has scheduled
them, exactly as the Calendar places them. Row totals count each ticket once. The cell colour
always shows hours against capacity, because only hours have a capacity to compare against; the
tooltip carries the tickets and points under every measure.

Engineering: `apps/api/src/services/workload.service.ts` (`ticketLoadForBucket`), `apps/web/src/pages/Workload.tsx`.

## Verifying a change to any of this

Colour first: `npm run check:contrast` measures every pair listed in `scripts/contrast-check.mjs`
(identity marks, accents, status dots, plan marks, the capacity ramp, buttons) against WCAG 2.1 AA
in both themes, straight from `index.css` and the shared palettes, and exits non-zero on a failure.
Redundant indicators (a dot beside its label) are reported, not gating.


The V12 branch's state file, `docs/V12_UiUx_ClickUp_PLAN.md`, records for each unit how it was
verified (live Playwright at 390 and 1366px, light and dark, plus unit tests), what was measured,
and every probe or product fault found along the way in its Auto-Heal Log.
