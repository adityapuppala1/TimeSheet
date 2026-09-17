/**
 * WHAT: the editor's @mention behaviour — TipTap's Mention node plus a suggestion popup drawn
 * with plain DOM, no popover library. Typing "@" filters the candidates the caller passed; arrows
 * move, Enter/Tab pick, Escape closes; a pick inserts a mention node that serialises as
 * `<span data-mention-id="…" data-mention-label="…">@Name</span>` — the exact shape the server's
 * sanitiser keeps and `extractMentionIds` reads.
 *
 * WHY PLAIN DOM FOR THE POPUP: the suggestion API hands us the caret's client rect on every
 * keystroke; positioning one absolutely-placed list from that is a few lines, and it avoids
 * adding a positioning dependency for one list. It is portalled to `document.body` so a
 * scrolling comment panel or a dialog's overflow never clips it.
 *
 * WHY CANDIDATES COME FROM THE CALLER: who may be mentioned is a role question (the project's
 * members), and the editor must not decide it. See the comments panel in pages/Tickets.tsx.
 */
import Mention from "@tiptap/extension-mention";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";

export interface MentionCandidate {
  id: string;
  label: string;
}

const MAX_SHOWN = 6;

function filterCandidates(all: MentionCandidate[], query: string): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  const hits = q ? all.filter((c) => c.label.toLowerCase().includes(q)) : all;
  return hits.slice(0, MAX_SHOWN);
}

/** The popup: a listbox of buttons the keyboard handler drives; the mouse works too. */
class MentionList {
  private el: HTMLDivElement;
  private items: MentionCandidate[] = [];
  private index = 0;
  private command: SuggestionProps<MentionCandidate>["command"];

  constructor(props: SuggestionProps<MentionCandidate>) {
    this.command = props.command;
    this.el = document.createElement("div");
    this.el.setAttribute("role", "listbox");
    this.el.setAttribute("aria-label", "Mention a person");
    this.el.dataset.mentionList = "";
    this.el.className =
      "fixed z-[60] min-w-[200px] max-w-[280px] overflow-hidden rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md";
    document.body.appendChild(this.el);
    this.update(props);
  }

  update(props: SuggestionProps<MentionCandidate>) {
    this.command = props.command;
    this.items = props.items;
    this.index = Math.min(this.index, Math.max(0, this.items.length - 1));
    const rect = props.clientRect?.();
    if (rect) {
      // Below the caret; flip above when there is no room.
      const top = rect.bottom + 6 + this.el.offsetHeight > window.innerHeight ? rect.top - 6 - this.el.offsetHeight : rect.bottom + 6;
      this.el.style.top = `${Math.max(8, top)}px`;
      this.el.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
    }
    this.render();
  }

  private render() {
    this.el.replaceChildren();
    if (this.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "px-2 py-1.5 text-xs text-muted-foreground";
      empty.textContent = "No one matches";
      this.el.appendChild(empty);
      return;
    }
    this.items.forEach((item, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(i === this.index));
      button.dataset.mentionOption = item.id;
      button.className =
        "flex h-[36px] w-full items-center gap-2 rounded-sm px-2 text-left " + (i === this.index ? "bg-accent text-accent-foreground" : "hover:bg-muted");
      button.textContent = item.label;
      button.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor's focus
      button.addEventListener("click", () => this.select(i));
      this.el.appendChild(button);
    });
  }

  private select(i: number) {
    const item = this.items[i];
    if (item) this.command({ id: item.id, label: item.label });
  }

  onKeyDown({ event }: SuggestionKeyDownProps): boolean {
    if (event.key === "ArrowDown") {
      this.index = (this.index + 1) % Math.max(1, this.items.length);
      this.render();
      return true;
    }
    if (event.key === "ArrowUp") {
      this.index = (this.index - 1 + Math.max(1, this.items.length)) % Math.max(1, this.items.length);
      this.render();
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      this.select(this.index);
      return true;
    }
    if (event.key === "Escape") {
      this.destroy();
      return true;
    }
    return false;
  }

  destroy() {
    this.el.remove();
  }
}

/** The configured Mention extension. `candidates` is read on every keystroke, so a refetched list is seen. */
export function mentionExtension(candidates: () => MentionCandidate[]) {
  return Mention.configure({
    HTMLAttributes: { class: "mention" },
    renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
    renderHTML: ({ node }) => [
      "span",
      { "data-mention-id": node.attrs.id, "data-mention-label": node.attrs.label, class: "mention" },
      `@${node.attrs.label ?? node.attrs.id}`
    ],
    suggestion: {
      char: "@",
      items: ({ query }) => filterCandidates(candidates(), query),
      render: () => {
        let list: MentionList | null = null;
        return {
          onStart: (props) => {
            list = new MentionList(props as SuggestionProps<MentionCandidate>);
          },
          onUpdate: (props) => list?.update(props as SuggestionProps<MentionCandidate>),
          onKeyDown: (props) => list?.onKeyDown(props) ?? false,
          onExit: () => {
            list?.destroy();
            list = null;
          }
        };
      }
    }
  }).extend({
    // Read the two data attributes back, so a saved comment re-edits (and re-serialises) intact.
    parseHTML() {
      return [{ tag: "span[data-mention-id]" }];
    },
    addAttributes() {
      return {
        id: { default: null, parseHTML: (el) => el.getAttribute("data-mention-id"), renderHTML: (attrs) => ({ "data-mention-id": attrs.id }) },
        label: { default: null, parseHTML: (el) => el.getAttribute("data-mention-label"), renderHTML: (attrs) => ({ "data-mention-label": attrs.label }) }
      };
    }
  });
}
