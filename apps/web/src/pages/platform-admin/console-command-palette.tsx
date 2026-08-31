/**
 * WHAT: the console's Cmd/Ctrl-K palette — every destination in the control plane, plus the two or
 * three things an operator does without going anywhere.
 *
 * WHY THE CONSOLE NEEDED ONE. Sixteen destinations across five groups is past the point where a
 * sidebar is navigation and into the point where it is a menu you read. The tenant app has had a
 * palette since well before the console had ten pages; the console is now the denser of the two.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SECOND COMPONENT AND NOT A GENERIC ONE.
 *
 * `components/command-palette.tsx` is the tenant palette. It reads `useAuthStore`, filters routes by
 * tenant PERMISSIONS and planning features, and offers "Ask AI" over the ticket backlog — none of
 * which exists here, and all of which would have to be parameterised away to share it. App.tsx's
 * header states the rule this obeys: the two auth stores are deliberately distinct with zero shared
 * state, so a leaked tenant token can never be usable against `/platform-admin` and vice versa, and
 * making the guards generic over "which store" is exactly how that separation gets quietly undone.
 * A palette that took a store as a prop would be one refactor away from a component that can render
 * the console's destinations for a tenant session.
 *
 * The keyboard listener below is the same nine lines as the tenant palette's `useCommandPaletteHotkey`
 * and is duplicated for the same reason rather than imported: importing that hook pulls its whole
 * module — the tenant auth store, the planning-features hook, the AI client — into the console
 * bundle. Nine lines of `keydown` is the cheaper copy, and the INTERACTION is what has to match,
 * which it does exactly: Cmd-K on a Mac, Ctrl-K elsewhere, preventDefault so the browser's own
 * search bar does not open on top of it.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT IT DOES NOT DO. It does not act on a customer. Everything here is navigation, a theme toggle
 * and sign-out — no rescue, no deletion, no broadcast. Every one of those needs a reason typed at
 * the moment of the action (`requirePlatformReason`), and a two-keystroke shortcut to something
 * that demands a written justification is a contradiction in interface terms.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { LogOut, Moon, Sun } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
} from "../../components/ui/command";
import { toggleTheme as switchTheme } from "../../lib/theme";
import { toast } from "../../components/ui/toaster";
import { CONSOLE_NAV } from "../../layouts/PlatformAdminLayout";
import { usePlatformAdminAuthStore } from "../../store/platform-admin-auth";

/** Cmd/Ctrl-K. See the header for why this is not imported from the tenant palette. */
export function useConsolePaletteHotkey(onOpen: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
}

export function ConsoleCommandPalette({ open, onOpenChange, onSignOut }: { open: boolean; onOpenChange: (open: boolean) => void; onSignOut: () => void }) {
  const navigate = useNavigate();
  const role = usePlatformAdminAuthStore((s) => s.admin?.role);
  // A counter, only so the theme item re-renders with the icon that now applies. `switchTheme`
  // writes to the document rather than to React state, so nothing else here observes it.
  const [, force] = useState(0);

  /* Filtered the same way the sidebar filters, from the same list: an `ownerOnly` destination that
     answers 403 must not be offered here either. This HIDES rather than enforces — the route guard
     and the server do the enforcing. */
  const groups = useMemo(
    () => CONSOLE_NAV.map((group) => ({ ...group, items: group.items.filter((item) => !item.ownerOnly || role === "OWNER") })).filter((group) => group.items.length > 0),
    [role]
  );

  const jump = (to: string) => {
    onOpenChange(false);
    navigate(to);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Jump to a page, or type a command..." />
      <CommandList>
        <CommandEmpty>No matching commands.</CommandEmpty>
        {groups.map((group, index) => (
          <CommandGroup key={group.heading ?? `group-${index}`} heading={group.heading ?? "Console"}>
            {group.items.map((item) => (
              /* `value` carries the group heading too, so typing "operations" finds Alerts,
                 Monitoring and Backups — the way an operator remembers where something lives is
                 usually the group rather than the page's name. */
              <CommandItem key={item.to} value={`${item.label} ${group.heading ?? ""}`} onSelect={() => jump(item.to)}>
                <item.icon className="text-muted-foreground" />
                <span>{item.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        <CommandSeparator />
        <CommandGroup heading="Session">
          <CommandItem
            value="toggle theme dark light"
            onSelect={() => {
              /* No origin passed, on purpose and for the reason the tenant palette gives: this path
                 is reached from a keyboard, where there is no click point for the wipe to spread
                 from, and `switchTheme` degrades to an instant change rather than inventing one. */
              const next = switchTheme();
              force((value) => value + 1);
              onOpenChange(false);
              toast.success(`Switched to ${next} mode`);
            }}
          >
            <Sun className="text-muted-foreground dark:hidden" />
            <Moon className="hidden text-muted-foreground dark:block" />
            <span>Toggle theme</span>
            <CommandShortcut>⌘ K</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="sign out log out"
            onSelect={() => {
              onOpenChange(false);
              onSignOut();
            }}
          >
            <LogOut className="text-muted-foreground" />
            <span>Sign out of the console</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
