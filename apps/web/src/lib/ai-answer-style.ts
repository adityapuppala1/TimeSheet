import { useSyncExternalStore } from "react";
import { AI_ANSWER_STYLES, type AiAnswerStyle } from "@timesheet/shared";

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
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(changed, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(changed, listener);
  };
}
export function useAnswerStyle(userId?: string) {
  return useSyncExternalStore(subscribe, () => readAnswerStyle(userId), () => "default" as AiAnswerStyle);
}
