/**
 * Turning whatever the model actually said into the answer a person should read.
 *
 * WHY THIS IS ITS OWN MODULE. This is the third pass at the same class of bug, and the first two
 * were regexes bolted onto the loop. The shapes below were all collected from real runs against an
 * 8B model, and the only way to stop guessing at them was to give them one place to live with a
 * test per shape.
 *
 * THE FOUR SHAPES, all observed:
 *
 *  1. A clean envelope. `parseJsonResponse` handles it; nothing here is needed.
 *
 *  2. An UNTERMINATED envelope — `{ "action": "answer", "markdown": "Here are the user statistics
 *     \n\n``` table…` that simply stops. Strict parsing fails, and because the text starts with `{`
 *     but never ends with `}`, the loop's `looksLikeToolAttempt` check missed it too, so the whole
 *     envelope was published verbatim with the answer visible inside it. This is the commonest
 *     failure and the ugliest.
 *
 *  3. Prose wrapping a fenced envelope — "Here is the markdown object that includes the ticket
 *     metrics:" followed by a ```-fence containing `{ "action": "answer", "markdown": "…` that
 *     never closes either. The real content is inside the fence.
 *
 *  4. Prose narrating the whole protocol — several fenced blocks showing `{"action":"tool"…}` and
 *     `{"action":"refuse"}`, with genuine prose between them. Here the prose IS the answer and only
 *     the blocks have to go.
 *
 * THE ORDER MATTERS: recover before stripping. Shape 2 and 3 carry the answer INSIDE the envelope,
 * so stripping first would delete the very thing being recovered. Shape 4 has no envelope worth
 * recovering, so recovery declines and stripping runs.
 *
 * WHAT IS NEVER TOUCHED: a chart fence, a `json` fence holding workspace data, tables, headings,
 * bold. Those are the output, and a cleaner that eats them is worse than the bug it fixes — every
 * one of them is pinned as a negative test.
 */

/** The envelope's own key, escaped or not — a model that echoes its protocol usually escapes it. */
const ACTION_KEY = /\\?"action\\?"\s*:\s*\\?"(tool|answer|refuse)\\?"/;

/** Decodes a JSON string body that was never parsed, because its envelope was malformed. */
function unescapeJsonBody(body: string): string {
  return body
    .replace(/\\r\\n|\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/**
 * Pulls the `markdown` value out of an envelope that never parsed.
 *
 * Deliberately tolerant about the END: the observed failures simply stop mid-string, so requiring a
 * closing quote and brace would reject exactly the cases this exists for. It takes everything after
 * `"markdown":"` and trims a trailing `"}` if one happens to be there.
 *
 * Returns null when there is no envelope, so the caller can fall through to stripping.
 */
export function recoverEnvelopeMarkdown(raw: string): string | null {
  if (!ACTION_KEY.test(raw)) return null;

  const start = /\\?"markdown\\?"\s*:\s*\\?"/.exec(raw);
  if (!start) return null;

  let body = raw.slice(start.index + start[0].length);

  // Trim a closing `" }` / `"}` when the model did finish, plus any fence the prose wrapped it in.
  body = body.replace(/\s*\\?"\s*\}\s*(```)?\s*$/, "").replace(/\s*```\s*$/, "");

  let out = unescapeJsonBody(body).trim();

  /*
   * Adjacent-string joins. Observed after the first recovery shipped: a table arrived as
   * `| Status | LOW |" "| --- | --- |" "| OPEN | 26 |` — the model wrote its markdown as several
   * quoted fragments side by side, the way adjacent string literals concatenate in Python. Inside
   * a JSON string an unescaped quote would have ENDED the string, so within a recovered body a
   * quote-whitespace-quote run can only be that join — never content — and becomes the newline it
   * stood for. Only here: this rewrite would be unsafe on prose that was never inside an envelope.
   */
  out = out
    .replace(/"\s+"/g, "\n")
    // The stray quote each fragment run leaves at a line's edge once its partner was consumed.
    .split("\n")
    .map((line) => line.replace(/^\s*"\s?/, "").replace(/\s?"\s*$/, ""))
    .join("\n")
    .trim();

  // A recovery that yields almost nothing is worse than leaving the original alone — the caller
  // treats null as "not an envelope" and keeps what it had.
  return out.length > 1 ? out : null;
}

/**
 * Removes the protocol from prose that is otherwise a real answer (shape 4).
 *
 * Fences are matched WITHOUT requiring a closing fence, because the observed blocks frequently have
 * none — an unterminated block runs to the end of the message, which is exactly what made the first
 * version of this miss them.
 */
export function stripProtocolEcho(markdown: string): string {
  let out = markdown;

  // A fenced block whose body carries the envelope. The closing fence is optional; when it is
  // missing the block runs to the end, which is the shape that was slipping through.
  out = out.replace(/```[a-zA-Z]*\s*\n[\s\S]*?(?:\n```|$)/g, (block) => (ACTION_KEY.test(block) ? "" : block));

  // A bare envelope on its own line, with or without a closing brace.
  out = out
    .split("\n")
    .filter((line) => !(ACTION_KEY.test(line) && line.trim().startsWith("{")))
    .join("\n");

  // The narration that introduces one of those blocks reads as a stray fragment once it is gone.
  // Anchored and length-capped, so a sentence REPORTING a finding while naming a tool survives.
  out = out
    .split("\n")
    .filter(
      (line) =>
        !/^\s*(and\s+|now,?\s+|first,?\s+|then,?\s+)*i(?:'| a|'l|\s+w|\s+a)\w*\s+(use|call|consult|check|answer)\b.{0,110}$/i.test(line) &&
        !/^\s*here is the (json object|markdown object|answer)\b.{0,80}$/i.test(line) &&
        !/^\s*if this is a general-knowledge question\b.{0,120}$/i.test(line)
    )
    .join("\n");

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The one entry point the loop uses. `parsedMarkdown` is present when strict parsing succeeded; the
 * raw text is always passed so a malformed envelope can still be recovered from it.
 *
 * It never returns empty: if every stage strips the message down to nothing, the original comes
 * back, because an empty answer bubble tells a person less than an ugly one.
 */
export function cleanAnswer(raw: string, parsedMarkdown?: string): string {
  const source = parsedMarkdown ?? raw;

  // Shape 2 and 3: the answer is inside an envelope that did not parse. Recover, then strip — a
  // recovered body can itself still contain a second echoed block.
  const recovered = parsedMarkdown === undefined ? recoverEnvelopeMarkdown(raw) : null;
  const candidate = recovered ?? source;

  const cleaned = stripProtocolEcho(candidate);
  return cleaned || candidate.trim() || raw.trim();
}
