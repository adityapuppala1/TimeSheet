/**
 * Back-compat alias for the app's single model-output renderer, which now lives in
 * `ai-rich-content.tsx` and handles diagrams, charts, JSON, code and callouts alongside markdown.
 *
 * Kept as a named export rather than renaming every call site in one go: `AiMarkdown` reads
 * correctly where the content really is just markdown (the Ask AI answer stream), and both names
 * resolve to the same component, so there is still exactly one sanitisation path.
 */
export { AiRichContent as AiMarkdown } from "./ai-rich-content";
