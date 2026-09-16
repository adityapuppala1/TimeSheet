/**
 * WHAT: the app's keyboard shortcuts — ONE table, one matcher, one listener. The palette, the
 * "?" dialog and the Help manual all read this table, so a shortcut cannot be advertised in one
 * place and dead in another.
 *
 * WHY THIS EXISTS: the palette showed "⌘ N" beside "New timesheet entry" and nothing listened for
 * it. It could not have: Chrome reserves Ctrl/⌘+N (new window) and does not let a page prevent
 * it, along with Ctrl+T and Ctrl+W. So every shortcut here is one a browser actually delivers:
 * `mod+k` (the one that already worked), single letters, and two-key sequences — none of which
 * fire while a person is typing in a field, which is the guard `isEditableTarget` provides.
 *
 * WHY SEQUENCES ("g" then "t"): they are the convention most people already carry from other
 * tools, they leave every letter free for typing, and they read aloud ("go to tickets"). The
 * window is one second; any other key, or the timeout, clears the pending "g".
 *
 * WHY THE LABELS COME FROM THE SIDEBAR'S `nav` TABLE: a "go to" shortcut names a page, and the
 * page already has exactly one name — the one the sidebar renders. Typing it again here is the
 * drift this repo keeps removing (connectors, proposal types, pitch exports, the breadcrumb).
 */
import { permissions } from "@timesheet/shared";

// A combo is a plain string: "mod+k" (Ctrl on Windows/Linux, ⌘ on Mac), a single key like "n" or
// "?", or a two-key sequence written with a space: "g t".

export interface ShortcutDef {
  id: string;
  combo: string;
  /** Shown in the "?" dialog and the palette. For a `to` shortcut, left undefined here and read
   *  from the sidebar's nav table at render time so the page name has one source. */
  label?: string;
  group: "General" | "Create" | "Go to" | "Inbox";
  /** Navigate here when pressed. */
  to?: string;
  /** A route prefix. Scoped rows fire only on that route (the page subscribes with
   *  `useScopedShortcuts`), never from the global listener, and the "?" dialog lists them only
   *  while the person is there — a shortcut for a page you are not on is noise. */
  scope?: string;
  /** A permission the person must hold, mirroring the route's own gate. */
  permission?: string;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "palette", combo: "mod+k", label: "Command palette", group: "General" },
  { id: "help", combo: "?", label: "Show keyboard shortcuts", group: "General" },
  { id: "new-timesheet", combo: "n", label: "Log time", group: "Create", to: "/app/timesheet", permission: permissions.TIMESHEETS_WRITE },
  // `?new=1` opens the create dialog on arrival — see pages/Tickets.tsx.
  { id: "new-ticket", combo: "c", label: "Create a ticket", group: "Create", to: "/app/tickets?new=1", permission: permissions.TICKETS_WRITE },
  { id: "go-home", combo: "g h", group: "Go to", to: "/app" },
  { id: "go-timesheet", combo: "g l", group: "Go to", to: "/app/timesheet", permission: permissions.TIMESHEETS_WRITE },
  { id: "go-tickets", combo: "g t", group: "Go to", to: "/app/tickets", permission: permissions.TICKETS_VIEW },
  { id: "go-my-work", combo: "g w", group: "Go to", to: "/app/my-work" },
  { id: "go-inbox", combo: "g i", group: "Go to", to: "/app/inbox" },
  { id: "go-profile", combo: "g p", label: "My profile", group: "Go to", to: "/app/profile" },
  // Inbox triage: "read one, decide, next" without leaving the keyboard. Single letters are safe
  // here because the editable-field guard applies, and they never fire on another page.
  { id: "inbox-next", combo: "j", label: "Next item", group: "Inbox", scope: "/app/inbox" },
  { id: "inbox-prev", combo: "k", label: "Previous item", group: "Inbox", scope: "/app/inbox" },
  { id: "inbox-done", combo: "e", label: "Mark done / undo", group: "Inbox", scope: "/app/inbox" },
  { id: "inbox-snooze", combo: "s", label: "Snooze until later today", group: "Inbox", scope: "/app/inbox" }
];

/** The rows the GLOBAL listener owns — everything without a scope. */
export function globalShortcuts(defs: readonly ShortcutDef[]): ShortcutDef[] {
  return defs.filter((d) => !d.scope);
}

/** The rows that apply on this route: every global row plus the scoped rows whose prefix matches. */
export function shortcutsForRoute(pathname: string, defs: readonly ShortcutDef[]): ShortcutDef[] {
  return defs.filter((d) => !d.scope || pathname === d.scope || pathname.startsWith(d.scope + "/"));
}

/** The shortcuts this person may use — the same gate the routes apply, so "g t" cannot take an
 *  EMPLOYEE without tickets:view to a page that would 403. */
export function visibleShortcuts(user: { permissions: string[] } | null | undefined, defs: readonly ShortcutDef[] = SHORTCUTS): ShortcutDef[] {
  return defs.filter((d) => !d.permission || Boolean(user?.permissions.includes(d.permission)));
}

/** True when a keystroke is somebody TYPING — in a field, an editor, a select, a combobox, or
 *  inside an open dialog (whose own controls own the keyboard). Single-key shortcuts must never
 *  fire there; "c" in a comment box is a letter. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if ((target as HTMLElement).isContentEditable) return true;
  const role = target.getAttribute("role");
  if (role === "textbox" || role === "combobox" || role === "searchbox") return true;
  if (target.closest('[role="dialog"], [cmdk-root], [contenteditable="true"]')) return true;
  return false;
}

interface ComboParts {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parseCombo(combo: string): ComboParts {
  const parts = combo.toLowerCase().split("+");
  const key = parts.pop() ?? "";
  return { mod: parts.includes("mod"), shift: parts.includes("shift"), alt: parts.includes("alt"), key };
}

/**
 * Does this keystroke match a single-chord combo? Exact on modifiers: "n" does NOT match Ctrl+N
 * (which the browser owns anyway) and "mod+k" does NOT match a bare "k". `event.key` is compared
 * case-insensitively so Caps Lock does not disable the app. "?" arrives as `key: "?"` with Shift
 * held, so Shift is ignored for keys that are themselves shifted characters.
 */
export function matchesCombo(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">, combo: string): boolean {
  if (combo.includes(" ")) return false;
  const want = parseCombo(combo);
  const key = event.key.toLowerCase();
  if (key !== want.key) return false;
  const hasMod = event.ctrlKey || event.metaKey;
  if (want.mod !== hasMod) return false;
  if (want.alt !== event.altKey) return false;
  const shiftedChar = want.key.length === 1 && /[^a-z0-9]/.test(want.key);
  if (!shiftedChar && want.shift !== event.shiftKey) return false;
  return true;
}

/**
 * Two-key sequences. Feed every keystroke; it returns the matched definition, or null. Stateful
 * by necessity, but tiny: the only state is "which first key is pending and until when".
 */
export function createSequenceMatcher(defs: readonly ShortcutDef[], windowMs = 1000, now: () => number = () => Date.now()) {
  const sequences = defs.filter((d) => d.combo.includes(" ")).map((d) => ({ def: d, first: d.combo.split(" ")[0], second: d.combo.split(" ")[1] }));
  let pending: { first: string; until: number } | null = null;
  return {
    feed(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): ShortcutDef | null {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        pending = null;
        return null;
      }
      const key = event.key.toLowerCase();
      if (pending && now() <= pending.until) {
        const hit = sequences.find((s) => s.first === pending!.first && s.second === key);
        pending = null;
        if (hit) return hit.def;
      } else {
        pending = null;
      }
      if (sequences.some((s) => s.first === key)) pending = { first: key, until: now() + windowMs };
      return null;
    },
    /** For tests and for a UI that wants to show "g …" while a sequence is pending. */
    isPending(): boolean {
      return pending !== null && now() <= pending.until;
    }
  };
}

export function isMacLike(platform: string = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** "mod+k" → "⌘ K" on a Mac, "Ctrl K" elsewhere; "g t" → "G then T"; "?" → "?". */
export function formatCombo(combo: string, mac: boolean = isMacLike()): string {
  if (combo.includes(" ")) return combo.split(" ").map((k) => k.toUpperCase()).join(" then ");
  return combo
    .split("+")
    .map((part) => {
      if (part === "mod") return mac ? "⌘" : "Ctrl";
      if (part === "shift") return mac ? "⇧" : "Shift";
      if (part === "alt") return mac ? "⌥" : "Alt";
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(" ");
}

/** The combo that opens a route, for the palette to print beside a Navigate item. */
export function comboForRoute(to: string, defs: readonly ShortcutDef[] = SHORTCUTS): string | undefined {
  return defs.find((d) => d.group === "Go to" && d.to === to)?.combo;
}
