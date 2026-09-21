/**
 * The capability grid, rebuilt so it can be READ.
 *
 * THE MEASUREMENT THAT PROMPTED THIS (2026-09-21, Playwright, 1440px): the landing page carried
 * 5,232 words, and 3,119 of them — sixty per cent of the entire page — were in this one section:
 * forty-five cards, each printing a full paragraph of body copy at once. Nobody reads forty-five
 * paragraphs. The section that was supposed to prove breadth was the section people scrolled past.
 *
 * WHAT CHANGED, AND WHAT DELIBERATELY DID NOT. Not one claim was deleted. docs/MARKETING_PAGES.md
 * is explicit that every clause on these pages is audited against shipped code, so removing a
 * sentence to make the page shorter would quietly destroy that audit trail — and the sentences are
 * the careful part (see that file's notes on the V8 wording). Instead each card shows its icon,
 * its title and its plan gate, and keeps the paragraph one press away behind a native
 * `<details>`. Visible words in this section drop by roughly nine tenths; available words are
 * unchanged.
 *
 * WHY `<details>` AND NOT A HOVER CARD: hover is not available on a phone and is not reachable by
 * keyboard. `<details>` is a real disclosure widget — it is focusable, it toggles on Enter and on
 * tap, it is announced correctly, and it prints open. The rotation on the chevron is the only part
 * that is decoration, and it is `motion-safe:`.
 *
 * THE SCREENSHOT BESIDE THE TILES is the device every strong SaaS page uses and this one was
 * missing: show the software. Each group names one real screen — generated from the running app by
 * tests/e2e/screenshots.spec.ts, never mocked up — so choosing a group changes the picture as well
 * as the list.
 */
import { ChevronRight, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { ScreenshotFrame } from "./ScreenshotFrame";

export interface ExplorerFeature {
  icon: LucideIcon;
  title: string;
  body: string;
  group: string;
  /** Rendered as "<tier>+" when the capability is genuinely plan-gated. */
  gateLabel?: string;
}

export interface ExplorerGroup {
  name: string;
  /** One line. The group's promise, not a summary of its cards. */
  blurb: string;
  /** A real screen from this area of the product. */
  shot: { src: string; alt: string };
}

export function FeatureExplorer({ features, groups }: { features: ExplorerFeature[]; groups: ExplorerGroup[] }) {
  const [active, setActive] = useState(groups[0]?.name ?? "");
  const group = groups.find((g) => g.name === active) ?? groups[0];
  const shown = features.filter((f) => f.group === active);

  return (
    <div className="mt-8 grid gap-6">
      {/* The groups, as tiles. Five choices with a count each, rather than a filter row that
          quietly governs a wall of 45 cards below it. */}
      {/* TOGGLE BUTTONS, not a tablist. The first build gave these `role="tab"`, which was wrong
          twice over: nothing here implements the tab pattern's keyboard contract (arrow keys, a
          roving tabindex) so the role promised behaviour that did not exist, and the page already
          has a real tablist in the product tour — two tablists made `getByRole("tab", { selected:
          true })` ambiguous, which is exactly the confusion a screen-reader user would have hit.
          `aria-pressed` is what a filter is, and it is what the chips this replaced used. */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {groups.map((g) => {
          const count = features.filter((f) => f.group === g.name).length;
          const selected = g.name === active;
          return (
            <button
              key={g.name}
              type="button"
              aria-pressed={selected}
              onClick={() => setActive(g.name)}
              data-feature-group={g.name}
              className={cn(
                "focus-ring group rounded-xl border p-3.5 text-left transition-all duration-200 motion-safe:hover:-translate-y-0.5",
                selected ? "border-primary bg-primary/5 shadow-soft" : "border-border hover:border-primary/40"
              )}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className={cn("text-sm font-bold", selected && "text-primary")}>{g.name}</span>
                <span className="text-xs font-semibold tabular-nums text-muted-foreground">{count}</span>
              </span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">{g.blurb}</span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-start">
        {/* Re-keyed on the group so the tiles re-enter as a set; mutating a list in place while its
            contents change reads as a glitch rather than as an answer. */}
        <div key={active} className="grid gap-2 sm:grid-cols-2">
          {shown.map((feature, i) => (
            <details
              key={feature.title}
              style={{ animationDelay: `${Math.min(i, 10) * 35}ms` }}
              className="group rounded-xl border border-border bg-card p-3.5 transition-colors open:border-primary/40 hover:border-primary/40 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-500 motion-safe:fill-mode-backwards"
            >
              <summary className="focus-ring flex cursor-pointer list-none items-start gap-2.5 rounded-md [&::-webkit-details-marker]:hidden">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition-colors group-open:bg-primary group-open:text-primary-foreground">
                  <feature.icon className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  {/* An h3 under the section's h2: 45 capability titles are the page's real
                      outline, and the e2e suite counts them to prove a group never shows nothing. */}
                  <h3 className="text-sm font-semibold leading-snug">{feature.title}</h3>
                  {feature.gateLabel && <span className="mt-0.5 block text-[11px] font-medium text-muted-foreground">{feature.gateLabel}</span>}
                </span>
                <ChevronRight
                  className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-safe:duration-200 group-open:rotate-90 motion-reduce:transition-none"
                  aria-hidden
                />
              </summary>
              <p className="mt-2.5 pl-[2.625rem] text-sm leading-6 text-muted-foreground">{feature.body}</p>
            </details>
          ))}
        </div>

        {group && (
          <div className="lg:sticky lg:top-24">
            <ScreenshotFrame key={group.shot.src} src={group.shot.src} alt={group.shot.alt} caption={`${group.name} — generated from the running app.`} />
          </div>
        )}
      </div>
    </div>
  );
}
