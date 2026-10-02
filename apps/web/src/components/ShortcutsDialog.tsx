/**
 * WHAT: the "?" dialog — every keyboard shortcut this person can use, grouped, rendered from the
 * one table in lib/shortcuts.ts. Also exports `useGlobalShortcuts`, the single keydown listener
 * that makes the table real; Topbar installs it once.
 *
 * WHY THE LISTENER LIVES BESIDE THE DIALOG: the dialog is what a shortcut has to be discoverable
 * from, and the listener is what makes what it says true. Splitting them across files is how one
 * of them drifts.
 */
import { useEffect, useMemo, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { Keyboard } from "lucide-react";
import {
  createSequenceMatcher,
  formatCombo,
  globalShortcuts,
  isEditableTarget,
  matchesCombo,
  SHORTCUTS,
  shortcutsForRoute,
  visibleShortcuts,
  type ShortcutDef
} from "../lib/shortcuts";
import { nav } from "./Sidebar";
import { useAuthStore } from "../store/auth";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

/** A "go to" shortcut's label is the sidebar's own name for that page. */
export function shortcutLabel(def: ShortcutDef): string {
  if (def.label) return def.label;
  const path = def.to?.split("?")[0];
  return nav.find((item) => item.to === path)?.label ?? def.to ?? def.id;
}

export function useGlobalShortcuts(handlers: { onPalette: () => void; onHelp: () => void }) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  // Scoped rows belong to their page's own listener, never to this one.
  const defs = useMemo(() => globalShortcuts(visibleShortcuts(user)), [user]);

  useEffect(() => {
    const sequences = createSequenceMatcher(defs);
    const run = (def: ShortcutDef) => {
      if (def.id === "palette") handlersRef.current.onPalette();
      else if (def.id === "help") handlersRef.current.onHelp();
      else if (def.to) void navigate(def.to);
    };
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // The palette chord works everywhere, fields included — that is what makes it a launcher.
      const palette = defs.find((d) => d.id === "palette");
      if (palette && matchesCombo(event, palette.combo)) {
        event.preventDefault();
        run(palette);
        return;
      }
      if (isEditableTarget(event.target)) return;
      const chord = defs.find((d) => !d.combo.includes(" ") && d.id !== "palette" && matchesCombo(event, d.combo));
      if (chord) {
        event.preventDefault();
        run(chord);
        return;
      }
      const seq = sequences.feed(event);
      if (seq) {
        event.preventDefault();
        run(seq);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [defs, navigate]);
}

/**
 * A page's OWN shortcuts — the rows in the table whose `scope` is this route. Same matchers, same
 * editable-field guard as the global listener; the page supplies a handler per row id. Rows the
 * page does not handle are simply inert, so the table can grow ahead of the pages.
 */
export function useScopedShortcuts(scope: string, handlers: Record<string, () => void>) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  useEffect(() => {
    const defs = SHORTCUTS.filter((d) => d.scope === scope && !d.combo.includes(" "));
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isEditableTarget(event.target)) return;
      const hit = defs.find((d) => matchesCombo(event, d.combo));
      const run = hit && handlersRef.current[hit.id];
      if (!run) return;
      event.preventDefault();
      run();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [scope]);
}

const GROUP_ORDER: ShortcutDef["group"][] = ["General", "Create", "Go to", "Inbox"];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const user = useAuthStore((s) => s.user);
  const { pathname } = useLocation();
  const defs = shortcutsForRoute(pathname, visibleShortcuts(user));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-5 w-5 text-primary" aria-hidden="true" />
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            Single keys and sequences work anywhere you are not typing in a field. The palette chord works everywhere.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          {GROUP_ORDER.map((group) => {
            const items = defs.filter((d) => d.group === group);
            if (items.length === 0) return null;
            return (
              <section key={group} className="grid gap-1.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group}</h3>
                <dl className="grid gap-1">
                  {items.map((d) => (
                    <div key={d.id} className="flex items-center justify-between gap-3 text-sm">
                      <dt className="min-w-0 truncate">{shortcutLabel(d)}</dt>
                      <dd className="shrink-0">
                        <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{formatCombo(d.combo)}</kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { SHORTCUTS };
