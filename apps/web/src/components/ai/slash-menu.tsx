/**
 * The `/` menu in the Ask AI composer — every capability this person's assistant can actually use,
 * pickable without knowing its name.
 *
 * WHY IT EXISTS: the assistant has around twenty capabilities and the only way to discover them was
 * a dialog behind "What can it do?", which you have to already suspect exists. A slash menu puts the
 * list where the question is being typed, which is the moment somebody wants it.
 *
 * IT LISTS THE SAME SET THE PROMPT IS BUILT FROM. `askAiApi.capabilities()` is the server's own
 * answer for this caller, filtered through the identical predicate that decides what the model is
 * shown (`visibleTools` in ai-chat-guardrails.ts). The menu therefore cannot advertise something the
 * assistant would then refuse — which is exactly what a hand-written list would eventually do.
 *
 * LOCKED ENTRIES ARE SHOWN, GREYED, WITH THEIR GATE. Hiding them would leave somebody wondering why
 * a colleague can ask about AI spend and they cannot; showing "Super admin" beside it answers that
 * without a support ticket. They cannot be selected.
 *
 * PICKING ONE INSERTS A PROMPT, NOT A COMMAND. There is no `/ai_spend` syntax on the server — the
 * loop chooses its own tools. A pick therefore writes plain English that reliably routes to that
 * capability, leaving the model free to consult something else as well if the question needs it.
 *
 * ONE SOURCE FOR THE MATCH LIST. The hook owns the filtering, the highlight and the keyboard, and
 * the component renders what the hook returns. An earlier draft computed `matches` in both, which is
 * the same duplicate-list shape that has caused two separate bugs in this codebase already — the
 * arrow keys and the visible list would eventually have disagreed about which row Enter picks.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Lock } from "lucide-react";
import type { AiChatCapabilities, AiChatCapability } from "../../services/api";
import { cn } from "../../lib/utils";

type Match = AiChatCapability & { group: string };

/** What a pick leaves in the box. A question, because that is the shape the assistant answers — a
 *  bare capability name is the one input it is not built for. */
function promptFor(cap: AiChatCapability): string {
  const readable = cap.name.replace(/_/g, " ");
  return cap.acts ? `Using ${readable}, ` : `Show me ${readable} — `;
}

/** Open only when the box STARTS with "/" — a slash mid-sentence is a date or a file path. A space
 *  after it means they have moved on to writing the real question, so the menu gets out of the way. */
export function slashQuery(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const q = value.slice(1);
  return q.includes(" ") ? null : q;
}

export function useSlashMenu(args: {
  value: string;
  capabilities: AiChatCapabilities | undefined;
  onPick: (next: string) => void;
}) {
  const [active, setActive] = useState(0);
  const query = slashQuery(args.value);

  const matches = useMemo<Match[]>(() => {
    if (query === null || !args.capabilities) return [];
    const q = query.toLowerCase();
    return args.capabilities.groups
      .flatMap((g) => g.tools.map((t) => ({ ...t, group: g.group })))
      .filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.group.toLowerCase().includes(q))
      // Usable first: a menu that opens on four locked rows reads as a wall of refusals.
      .sort((a, b) => Number(b.allowed) - Number(a.allowed))
      .slice(0, 40);
  }, [args.capabilities, query]);

  // The highlight resets whenever the filter changes, or it would point at a row that has gone.
  useEffect(() => setActive(0), [query]);

  const pick = (cap: Match | undefined) => {
    if (!cap?.allowed) return;
    args.onPick(promptFor(cap));
  };

  return {
    open: query !== null && matches.length > 0,
    query,
    matches,
    active,
    setActive,
    pick,
    /** True when the key was consumed, so the composer knows not to also send the message. */
    handleKey(e: ReactKeyboardEvent): boolean {
      if (query === null || matches.length === 0) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % matches.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + matches.length) % matches.length);
        return true;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        const cap = matches[active];
        if (cap?.allowed) {
          e.preventDefault();
          pick(cap);
          return true;
        }
      }
      return false;
    }
  };
}

export function SlashMenu({ menu }: { menu: ReturnType<typeof useSlashMenu> }) {
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${menu.active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [menu.active]);

  if (!menu.open) return null;

  return (
    <div
      // Above the composer, not below it: the composer sits at the bottom of the page, so a menu
      // underneath would open off-screen.
      className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-150"
      role="listbox"
      aria-label="Assistant capabilities"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2">
        <p className="text-xs font-semibold">
          {menu.matches.length} capabilit{menu.matches.length === 1 ? "y" : "ies"}
          {menu.query ? ` matching “${menu.query}”` : ""}
        </p>
        <p className="hidden text-[10px] text-muted-foreground sm:block">↑↓ move · Enter pick · Esc close</p>
      </div>
      <div ref={listRef} className="max-h-72 overflow-y-auto overscroll-contain">
        {menu.matches.map((cap, i) => (
          <button
            key={cap.name}
            type="button"
            data-index={i}
            role="option"
            aria-selected={i === menu.active}
            aria-disabled={!cap.allowed}
            onMouseEnter={() => menu.setActive(i)}
            onClick={() => menu.pick(cap)}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
              i === menu.active && cap.allowed && "bg-primary/10",
              !cap.allowed && "cursor-not-allowed opacity-55"
            )}
          >
            <span className="shrink-0">
              {cap.allowed ? (
                <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold">{cap.name}</code>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold">{cap.name}</code>
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{cap.description}</span>
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {cap.allowed ? cap.group : cap.requires}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
