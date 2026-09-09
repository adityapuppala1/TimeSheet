/**
 * The sentence a per-person chart uses to admit that somebody is missing from it.
 *
 * WHY THIS IS A FUNCTION AND NOT INLINE JSX: it is the only part of `InactivePeopleNote` that can
 * be wrong. The rest is a paragraph. This decides whether the note appears at all — which depends
 * on a field older API builds do not send — and picks singular or plural, which is the kind of
 * detail that ships as "1 inactive people" and undermines a message whose entire job is to make a
 * chart look deliberate rather than broken.
 */

/**
 * `null` when nothing was hidden and the caller should render nothing.
 *
 * `undefined` is treated as "nothing hidden" rather than as an error: the API fields are optional
 * so that a browser holding a newer SPA against an older server degrades to no note at all, which
 * is exactly the behaviour before this feature existed. A negative is treated the same way — a
 * count below zero is a bug upstream, and repeating it on screen helps nobody.
 */
export function describeHiddenPeople(count: number | undefined | null): string | null {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return null;
  const people = count === 1 ? "1 inactive person is" : `${count} inactive people are`;
  return (
    `${people} hidden from this breakdown. Their work still counts towards the totals, ` +
    "and exported reports still include them."
  );
}
