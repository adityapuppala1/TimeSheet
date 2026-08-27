import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import {
  Bold,
  Code,
  SquareCode,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  Underline as UnderlineIcon,
  Undo2,
  AlignLeft,
  AlignCenter,
  AlignRight
} from "lucide-react";
import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils";

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
  minHeight?: string;
  /**
   * Where the writing area stops growing and starts scrolling. Any Tailwind max-height class.
   *
   * WHY THERE IS A DEFAULT AT ALL: an editor with no ceiling grows a pixel per line forever. In a
   * centre-anchored dialog that pushes the title off the top of the screen and the submit button
   * off the bottom — which is exactly what typing a long ticket description used to do — and on a
   * long form it walks the field you are typing in off the bottom of the page. `24rem` is roughly
   * fifteen lines: enough that scrolling is rare, small enough that the surrounding form stays
   * put when it isn't.
   */
  maxHeight?: string;
  ariaLabel?: string;
  /**
   * How much of the toolbar to show.
   *
   * `"inline"` keeps the marks that make sense inside ONE line — bold, italic, code, link — and
   * drops headings, lists, blockquote and alignment. It exists for fields that are a single item in
   * a list somebody else renders: a heading inside a bullet point is not a formatting choice, it is
   * a broken document, and offering the button invites it.
   */
  toolbar?: "full" | "inline";
}

export function RichTextEditor({
  value,
  onChange,
  placeholder = "Start typing...",
  className,
  minHeight = "min-h-32",
  maxHeight = "max-h-96",
  ariaLabel,
  toolbar = "full"
}: RichTextEditorProps) {
  /** `editorProps` is captured when the editor is constructed, at which point the `editor` const
   *  below is still being initialised — so the paste handler reaches the instance through a ref
   *  rather than closing over a binding that is `null` for the lifetime of the component. */
  const editorRef = useRef<Editor | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Underline,
      Link.configure({ openOnClick: false, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }),
      Placeholder.configure({ placeholder }),
      TextAlign.configure({ types: ["heading", "paragraph"] })
    ],
    content: value,
    editorProps: {
      attributes: {
        class: cn("tiptap focus:outline-none", minHeight),
        "aria-label": ariaLabel ?? "Rich text editor"
      },
      handlePaste: (_view, event) => handleSmartPaste(editorRef.current, event)
    },
    onUpdate: ({ editor }) => onChange(editor.getHTML())
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (value !== current) editor.commands.setContent(value || "", false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  if (!editor) return null;

  return (
    <div className={cn("flex flex-col overflow-hidden rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background", className)}>
      <Toolbar editor={editor} variant={toolbar} />
      {/* The scroll lives HERE, not on the editor node, so the toolbar stays put while the text
          moves — a toolbar that scrolls away is a toolbar you have to scroll back to in order to
          make the next heading. `overscroll-contain` keeps a flick at the end of the text from
          scrolling the dialog (or the page) behind it. */}
      <div className={cn("overflow-y-auto overscroll-contain", maxHeight)}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

/* ============================ Paste-time auto-formatting ============================ */

/**
 * What the editor does when you paste something that isn't prose.
 *
 * THE PROBLEM: people paste stack traces, SQL, YAML and shell sessions into ticket descriptions
 * and timesheet notes constantly, and a plain-text paste turned every one of them into a wall of
 * single-spaced paragraphs — indentation collapsed, line breaks merged, unreadable to whoever
 * picked the ticket up. The formatting existed (the code-block node has shipped since the first
 * version); nothing ever reached for it, because doing so meant noticing the toolbar button
 * first.
 *
 * WHY THIS IS DETERMINISTIC AND NOT A MODEL CALL: it has to run on every paste, in the time
 * between Ctrl+V and the caret moving, offline, and identically every time. A round trip to a
 * language model is none of those things, and "sometimes it reformats your paste, sometimes it
 * doesn't" is worse than never doing it. The AI's half of this job is the "Refine with AI"
 * button, which is explicit, previewed and reversible — and which now preserves code blocks
 * rather than flattening them (see `sanitize.ts`'s fence round trip). Between the two, code ends
 * up formatted whether it arrives by paste or by refinement.
 *
 * NOTHING HERE IS DESTRUCTIVE: every branch inserts exactly the characters that were on the
 * clipboard. The only thing being decided is which node they land in, and Ctrl+Z undoes the whole
 * paste in one step, as it always did.
 */
function handleSmartPaste(editor: Editor | null, event: ClipboardEvent): boolean {
  if (!editor) return false;
  // Rich HTML on the clipboard (copied from a web page, a doc, another editor) already carries
  // its own structure — Tiptap's own handler maps it onto the allowed nodes far better than
  // guessing from the plain-text twin would.
  const html = event.clipboardData?.getData("text/html");
  if (html && html.trim()) return false;

  const text = event.clipboardData?.getData("text/plain");
  if (!text) return false;

  // Returning `true` is what stops the default paste — ProseMirror calls `preventDefault()` for a
  // handler that reports it handled the event, so doing it here as well would be noise.

  // Already inside a code block: the paste is more code. Insert it raw and skip every heuristic —
  // interpreting "# comment" as a heading inside a shell script is exactly the wrong answer.
  if (editor.isActive("codeBlock")) {
    editor.chain().focus().insertContent({ type: "text", text }).run();
    return true;
  }

  if (looksLikeCode(text)) {
    // A `{ type: "text" }` node, not an HTML string: `insertContent` parses strings as HTML, so a
    // snippet containing `<div>` would be inserted as an element instead of as the four
    // characters the author copied.
    editor.chain().focus().setNode("codeBlock").insertContent({ type: "text", text: stripFences(text) }).run();
    return true;
  }

  const structured = markdownToNodes(text);
  if (structured) {
    editor.chain().focus().insertContent(structured).run();
    return true;
  }

  return false;
}

/** A paste that is already fenced is code by the author's own say-so; the fence markers
 *  themselves are notation, not content, so they don't belong in the block. */
function stripFences(text: string): string {
  const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return fenced ? fenced[1] : text;
}

/**
 * Lines that are structurally code rather than sentences. Deliberately narrow — each pattern is
 * something that essentially never appears in a sentence someone typed.
 *
 * EVERY NEGATED CLASS HERE MUST EXCLUDE `\n`, and `\s` runs meant to stay on one line are written
 * `[^\S\n]`. These are LINE patterns — `/m` anchors them to line boundaries — but a negated class
 * that does not exclude the newline matches straight through it, so `[^.!?]*` let a single "line"
 * run to the end of the paste. Two consequences, both observed: a paragraph of prose was
 * classified as code whenever one of these keywords appeared anywhere above a line ending in `{`,
 * and the same crossing turned the match into a quadratic backtrack — ~350ms on a 20k-character
 * paste, which in an editor is a visible freeze while someone is typing.
 */
const CODE_SIGNALS: RegExp[] = [
  /^\s*(?:at\s+[\w$.<>]+\s*\(|Traceback \(most recent call last\)|Caused by:|Exception in thread)/m, // stack traces
  /^[^\S\n]*(?:function|class|const|let|var|def|public|private|protected|import|export|return|if|for|while|switch|try|catch|async|await)\b[^.!?\n]*[{();:][^\S\n]*$/m,
  /^\s*(?:SELECT|INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE|JOIN|WHERE|GROUP BY)\b/im, // SQL
  /^\s*[$#>]\s+\S+/m, // shell prompts
  /^\s*(?:npm|npx|yarn|pnpm|git|docker|kubectl|curl|sudo|apt|pip|python|node|mvn|gradle)\s+\S+/m, // commands
  /^\s*(?:<\/?[a-z][\w-]*(?:\s[^>]*)?>|<\?xml|<!DOCTYPE)/im, // markup
  /^[^\S\n]*[\w"'-]+[^\S\n]*:[^\S\n]*(?:[|>]|\S)[^.!?\n]*$/m, // YAML / JSON-ish key: value
  /^\s*[{}[\]]\s*[,;]?\s*$/m, // a lone brace or bracket on its own line
  /^\s*(?:\/\/|\/\*|#!|--\s)/m // comment openers and shebangs
];

/**
 * Is this paste code?
 *
 * Two independent ways to qualify, because the two kinds of paste look nothing alike:
 *   • an explicit ``` fence — the author already said so, no guessing needed;
 *   • multi-line text where a MAJORITY of non-blank lines trip a code signal, or where the
 *     indentation is structural (leading whitespace on a third of the lines).
 *
 * The majority rule is what keeps a prose paragraph that happens to mention `git push` out of a
 * code block. One matching line out of twelve is a sentence about code; eight out of twelve is
 * code. A single line is never treated as a block — inline code is a different gesture, and
 * turning every pasted file path into a full-width block would be obnoxious.
 */
function looksLikeCode(text: string): boolean {
  if (/^\s*```/.test(text)) return true;

  const lines = text.split(/\r?\n/);
  const meaningful = lines.filter((line) => line.trim().length > 0);
  if (meaningful.length < 2) return false;

  const signalled = meaningful.filter((line) => CODE_SIGNALS.some((pattern) => pattern.test(line))).length;
  if (signalled * 2 > meaningful.length) return true;

  // Structural indentation: prose wraps at the margin, code steps in and out. Requires a couple
  // of corroborating signals too, so an indented quotation isn't mistaken for a program.
  const indented = meaningful.filter((line) => /^[ \t]{2,}\S/.test(line)).length;
  return indented * 3 >= meaningful.length && signalled > 0;
}

/**
 * Markdown-ish plain text -> the HTML Tiptap parses into real nodes.
 *
 * Returns null when the paste has no structure worth converting, so the editor's own handler runs
 * and the paste behaves exactly as it always has. That null is important: this function must
 * improve pastes it understands and stay out of the way of every other one.
 *
 * Deliberately block-level only — headings, lists, quotes, fences. Inline `**bold**` is left
 * alone: people write `*` mid-sentence for other reasons, and silently eating asterisks out of a
 * bug report is the kind of "help" that loses information.
 */
function markdownToNodes(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const hasStructure = lines.some((line) => /^\s*(?:#{1,3}\s|[-*•]\s|\d+[.)]\s|>\s)/.test(line));
  if (!hasStructure) return null;

  const blocks: string[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  let ordered = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${paragraph.map(escapeHtml).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (items.length === 0) return;
    const tag = ordered ? "ol" : "ul";
    blocks.push(`<${tag}>${items.map((item) => `<li><p>${escapeHtml(item)}</p></li>`).join("")}</${tag}>`);
    items = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(`<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>`);
      continue;
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const isOrdered = Boolean(numbered);
      if (items.length > 0 && isOrdered !== ordered) flushList();
      ordered = isOrdered;
      items.push((bullet?.[1] ?? numbered?.[1] ?? "").trim());
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote><p>${escapeHtml(quote[1])}</p></blockquote>`);
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();

  return blocks.length > 0 ? blocks.join("") : null;
}

/** The pasted text is being put INTO an HTML string here, so anything tag-shaped in it has to
 *  stop being tag-shaped first — otherwise pasting a bug report that quotes `<img onerror=…>`
 *  would insert the element instead of the text. Tiptap's schema would strip most of it on the
 *  way in; this makes that a second line of defence rather than the only one. */
function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function Toolbar({ editor, variant }: { editor: Editor; variant: "full" | "inline" }) {
  const promptLink = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL (leave empty to remove)", previous ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-muted/40 p-1.5">
      <Group>
        <Btn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} label="Bold">
          <Bold className="h-3.5 w-3.5" />
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} label="Italic">
          <Italic className="h-3.5 w-3.5" />
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive("underline")} label="Underline">
          <UnderlineIcon className="h-3.5 w-3.5" />
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive("strike")} label="Strikethrough">
          <Strikethrough className="h-3.5 w-3.5" />
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleCode().run()} active={editor.isActive("code")} label="Inline code">
          <Code className="h-3.5 w-3.5" />
        </Btn>
        {/* StarterKit has shipped the CodeBlock node all along — it was reachable only by pasting
            or typing ``` and there was no button, so nobody discovered it. Now pasted stack traces
            and snippets get monospace, their own scroll box, and preserved whitespace. */}
        <Btn onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive("codeBlock")} label="Code block">
          <SquareCode className="h-3.5 w-3.5" />
        </Btn>
      </Group>
      {variant === "full" && (
        <>
      <Divider />
      <Group>
        <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive("heading", { level: 1 })} label="Heading 1">
          <Heading1 className="h-3.5 w-3.5" />
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })} label="Heading 2">
          <Heading2 className="h-3.5 w-3.5" />
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive("heading", { level: 3 })} label="Heading 3">
          <Heading3 className="h-3.5 w-3.5" />
        </Btn>
      </Group>
      <Divider />
      <Group>
        <Btn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} label="Bullet list">
          <List className="h-3.5 w-3.5" />
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")} label="Ordered list">
          <ListOrdered className="h-3.5 w-3.5" />
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive("blockquote")} label="Quote">
          <Quote className="h-3.5 w-3.5" />
        </Btn>
      </Group>
      <Divider />
      <Group>
        <Btn onClick={() => editor.chain().focus().setTextAlign("left").run()} active={editor.isActive({ textAlign: "left" })} label="Align left">
          <AlignLeft className="h-3.5 w-3.5" />
        </Btn>
        <Btn onClick={() => editor.chain().focus().setTextAlign("center").run()} active={editor.isActive({ textAlign: "center" })} label="Align center">
          <AlignCenter className="h-3.5 w-3.5" />
        </Btn>
        <Btn onClick={() => editor.chain().focus().setTextAlign("right").run()} active={editor.isActive({ textAlign: "right" })} label="Align right">
          <AlignRight className="h-3.5 w-3.5" />
        </Btn>
      </Group>
        </>
      )}
      <Divider />
      <Group>
        <Btn onClick={promptLink} active={editor.isActive("link")} label="Link">
          <Link2 className="h-3.5 w-3.5" />
        </Btn>
      </Group>
      <div className="ml-auto flex items-center gap-0.5">
        <Btn onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} label="Undo">
          <Undo2 className="h-3.5 w-3.5" />
        </Btn>
        <Btn onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} label="Redo">
          <Redo2 className="h-3.5 w-3.5" />
        </Btn>
      </div>
    </div>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center">{children}</div>;
}
function Divider() {
  return <span className="mx-1 h-5 w-px bg-border" />;
}
function Btn({
  children,
  active,
  onClick,
  disabled,
  label
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-background hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
        active && "bg-background text-primary shadow-sm"
      )}
    >
      {children}
    </button>
  );
}
