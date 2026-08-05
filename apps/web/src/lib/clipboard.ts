/**
 * WHAT: copy text to the clipboard, everywhere, and say honestly whether it worked.
 *
 * WHY THIS EXISTS. `navigator.clipboard` is only defined in a **secure context** — HTTPS, or
 * localhost. Every on-premise install reached over plain HTTP on a LAN address, and every phone
 * pointed at `http://192.168.x.x`, therefore has no `navigator.clipboard` at all. The call sites
 * this replaces split two ways, and both were wrong:
 *
 *   navigator.clipboard.writeText(url)      -> TypeError, an actual crash in the handler
 *   navigator.clipboard?.writeText(url)     -> silently does nothing, then toasts "Copied!"
 *
 * The second is worse than the first. Telling somebody a share link is on their clipboard when it
 * is not means they paste whatever was there before — and the thing they were copying was usually
 * a token or a one-time URL they now have to go back and find again.
 *
 * THE FALLBACK is the old `document.execCommand("copy")` path. It is deprecated, and it is also
 * the only thing that works on an insecure origin and in older Safari. Deprecated-but-working
 * beats correct-but-unavailable when the alternative is a button that does nothing.
 *
 * Returns a boolean rather than throwing, because every caller's real question is "should I show
 * the success toast", and a helper that throws just moves the try/catch into ten components.
 */
export async function copyText(text: string): Promise<boolean> {
  // The modern path. Also fails when the document is not focused (Safari is strict here), which
  // is why it is wrapped rather than trusted.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through — a permission refusal or an unfocused document is exactly when the legacy
      // path still works.
    }
  }

  if (typeof document === "undefined") return false;

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Off-screen rather than hidden: `display:none` and `visibility:hidden` elements cannot be
    // selected, so the copy silently produces an empty string.
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);

    // iOS ignores .select() on a readonly field unless the range is set explicitly.
    textarea.select();
    textarea.setSelectionRange(0, text.length);

    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/** True when this page can use the browser APIs that require HTTPS — the clipboard, the camera,
 *  service workers. `localhost` counts as secure, which is why development never sees this. */
export function isSecureContext(): boolean {
  if (typeof window === "undefined") return true;
  return window.isSecureContext === true;
}
