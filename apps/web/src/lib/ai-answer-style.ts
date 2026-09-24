import { useSyncExternalStore } from "react";
import { AI_ANSWER_STYLES, isAiAnswerStyle, type AiAnswerStyle } from "@timesheet/shared";

const changed = "timesphere:ai-answer-style";
export function readAnswerStyle(userId?: string): AiAnswerStyle {
  if (!userId) return "default";
  try {
    const value = localStorage.getItem(`ai-answer-style:${userId}`);
    return AI_ANSWER_STYLES.find((style) => style === value) ?? "default";
  } catch {
    return "default";
  }
}
export function saveAnswerStyle(userId: string, style: AiAnswerStyle): boolean {
  try {
    const key = `ai-answer-style:${userId}`;
    if (style === "default") localStorage.removeItem(key);
    else localStorage.setItem(key, style);
    window.dispatchEvent(new Event(changed));
    return true;
  } catch {
    return false;
  }
}
/**
 * The choice now lives in two places — the person's profile (so it travels) and this browser (so
 * it answers before the profile has loaded, and still answers when a save failed). Two stores need
 * a rule, and this is it, as a pure function rather than an `if` inside a component.
 *
 * The PROFILE wins whenever it holds a real style, because that is the copy that followed the
 * person here. "default" is not a real style — it is what no choice looks like — so it never
 * overrides a browser that does hold one. Anything neither side can honour reads as default.
 */
export function resolveAnswerStyle(saved: AiAnswerStyle | null | undefined, local: AiAnswerStyle): AiAnswerStyle {
  if (isAiAnswerStyle(saved) && saved !== "default") return saved;
  return isAiAnswerStyle(local) ? local : "default";
}

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(changed, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(changed, listener);
  };
}
/** `saved` is the profile's copy; omit it and this is the browser-only behaviour it had before. */
export function useAnswerStyle(userId?: string, saved?: AiAnswerStyle | null) {
  const local = useSyncExternalStore(subscribe, () => readAnswerStyle(userId), () => "default" as AiAnswerStyle);
  return resolveAnswerStyle(saved, local);
}
