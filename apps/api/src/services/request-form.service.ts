/**
 * WHAT: dynamic request forms — the schema people author, the conditional rules that decide which
 * questions are actually being asked, and the validation a submission must pass.
 *
 * WHY THE VISIBILITY RULES ARE EVALUATED SERVER-SIDE TOO, not just in the builder's preview: a
 * form's "required" fields are only required when they are VISIBLE. A conditional question nobody
 * was shown must not block a submission, and — the direction that actually matters — a hidden
 * question's answer must not be accepted either, or anyone can POST past the branch they were
 * routed away from. The browser decides what to draw; this decides what counts.
 *
 * WHY THE SCHEMA IS ONE JSON COLUMN rather than field rows: a form is authored, versioned and
 * rendered whole, and nothing queries across individual questions. That is the same test the rest
 * of this layer uses (custom field VALUES are rows because saved views filter on them; form
 * schemas are JSON because nothing does).
 *
 * WHO CALLS THIS: `controllers/request-form.controller.ts` (authoring) and
 * `controllers/request-form-public.controller.ts` (unauthenticated submission).
 */
import { AppError } from "../middleware/error.js";

/* ================================================================== *
 * The authored schema
 * ================================================================== */

export const REQUEST_FIELD_TYPES = [
  "TEXT",
  "TEXTAREA",
  "NUMBER",
  "DATE",
  "SELECT",
  "MULTISELECT",
  "CHECKBOX",
  "EMAIL"
] as const;
export type RequestFieldType = (typeof REQUEST_FIELD_TYPES)[number];

export type VisibilityOperator = "equals" | "notEquals" | "contains" | "isAnswered";

export interface VisibilityRule {
  /** `key` of another field in this form. */
  field: string;
  operator: VisibilityOperator;
  value?: string;
}

export interface RequestFormField {
  key: string;
  label: string;
  type: RequestFieldType;
  help?: string;
  required?: boolean;
  options?: string[];
  /** Shown only when EVERY rule passes. Empty/absent = always shown. */
  showWhen?: VisibilityRule[];
  /** Copies this answer into the created ticket's title/description, or into a custom field. */
  mapsTo?: "title" | "description" | `custom:${string}`;
}

export interface RequestFormSchema {
  fields: RequestFormField[];
  /** Shown above the form. Plain text — a public page must not render authored HTML. */
  intro?: string;
  /** Shown after a successful submission. */
  confirmation?: string;
}

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;

/**
 * Rejects a form that cannot work. Every rule here exists because the alternative is a form that
 * looks fine in the builder and misbehaves for a real submitter, who has no way to report it.
 */
export function validateFormSchema(schema: RequestFormSchema): void {
  if (!schema || !Array.isArray(schema.fields)) throw new AppError(400, "A form needs a list of fields.");
  if (schema.fields.length === 0) throw new AppError(400, "A form needs at least one question.");
  if (schema.fields.length > 60) throw new AppError(400, "A form can have at most 60 questions.");

  const seen = new Set<string>();
  for (const field of schema.fields) {
    if (!KEY_PATTERN.test(field.key)) {
      throw new AppError(400, `"${field.key}" is not a valid field key — start with a lowercase letter, then letters, digits or underscores.`);
    }
    if (seen.has(field.key)) throw new AppError(400, `Two questions share the key "${field.key}".`);
    seen.add(field.key);

    if (!field.label?.trim()) throw new AppError(400, `The question "${field.key}" needs a label.`);
    if (!REQUEST_FIELD_TYPES.includes(field.type)) throw new AppError(400, `"${field.type}" is not a valid question type.`);

    const needsOptions = field.type === "SELECT" || field.type === "MULTISELECT";
    if (needsOptions && (!field.options || field.options.length === 0)) {
      throw new AppError(400, `"${field.label}" is a choice question, so it needs at least one option.`);
    }
    if (field.options && new Set(field.options).size !== field.options.length) {
      throw new AppError(400, `"${field.label}" has duplicate options.`);
    }
  }

  // A rule can only reference a field DECLARED EARLIER. That single constraint makes cycles
  // impossible by construction — no "A shows if B, B shows if A" deadlock to detect at runtime —
  // and it matches how anyone reading the form top to bottom already understands it.
  const declared = new Set<string>();
  for (const field of schema.fields) {
    for (const rule of field.showWhen ?? []) {
      if (!declared.has(rule.field)) {
        throw new AppError(
          400,
          `"${field.label}" is shown based on "${rule.field}", which is not a question above it. A question can only depend on an earlier one.`
        );
      }
      if (rule.operator !== "isAnswered" && (rule.value === undefined || rule.value === "")) {
        throw new AppError(400, `The rule on "${field.label}" needs a value to compare against.`);
      }
    }
    declared.add(field.key);
  }

  // Something has to become the ticket's title, or every request arrives called "Untitled".
  if (!schema.fields.some((f) => f.mapsTo === "title")) {
    throw new AppError(400, "One question must be mapped to the ticket title.");
  }
}

/* ================================================================== *
 * Conditional visibility
 * ================================================================== */

const asText = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(",");
  return String(value);
};

function ruleHolds(rule: VisibilityRule, answers: Record<string, unknown>): boolean {
  const raw = answers[rule.field];
  const text = asText(raw).toLowerCase();
  const target = (rule.value ?? "").toLowerCase();

  switch (rule.operator) {
    case "isAnswered":
      return Array.isArray(raw) ? raw.length > 0 : raw !== undefined && raw !== null && raw !== "";
    case "equals":
      // A multi-select "equals" reads as "includes" — a submitter who ticked three boxes
      // including the one the rule names has plainly met the condition, and requiring an exact
      // list match would make the rule impossible to satisfy in practice.
      return Array.isArray(raw) ? raw.map((v) => asText(v).toLowerCase()).includes(target) : text === target;
    case "notEquals":
      return Array.isArray(raw) ? !raw.map((v) => asText(v).toLowerCase()).includes(target) : text !== target;
    case "contains":
      return text.includes(target);
    default:
      return true;
  }
}

/**
 * Which fields are actually being asked, given the answers so far.
 *
 * Evaluated in declaration order, and a field whose controller is itself hidden is hidden too —
 * otherwise answering a question, then hiding the branch that contained it, would leave its
 * children visible and orphaned.
 */
export function visibleFields(schema: RequestFormSchema, answers: Record<string, unknown>): RequestFormField[] {
  const visible: RequestFormField[] = [];
  const visibleKeys = new Set<string>();

  for (const field of schema.fields) {
    const rules = field.showWhen ?? [];
    const shown =
      rules.length === 0 ||
      rules.every((rule) => visibleKeys.has(rule.field) && ruleHolds(rule, answers));
    if (shown) {
      visible.push(field);
      visibleKeys.add(field.key);
    }
  }
  return visible;
}

/* ================================================================== *
 * Submission
 * ================================================================== */

export interface NormalisedSubmission {
  answers: Record<string, unknown>;
  title: string;
  description: string | null;
  /** `{ customFieldKey: value }` for fields mapped to a custom field. */
  customFields: Record<string, unknown>;
}

/**
 * Validates and normalises what a submitter sent.
 *
 * Answers to questions that were NOT visible are DROPPED, not rejected. Rejecting would fail an
 * honest submitter whose browser posted a stale answer after they changed an earlier choice;
 * keeping them would let anyone POST past a branch they were routed away from. Dropping is the
 * only option that is both forgiving to people and closed to abuse.
 */
export function normaliseSubmission(schema: RequestFormSchema, raw: Record<string, unknown>): NormalisedSubmission {
  const shown = visibleFields(schema, raw);
  const answers: Record<string, unknown> = {};
  const customFields: Record<string, unknown> = {};
  let title = "";
  let description: string | null = null;

  for (const field of shown) {
    const value = raw[field.key];
    const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

    if (empty) {
      if (field.required) throw new AppError(400, `"${field.label}" is required.`);
      continue;
    }

    let normalised: unknown;
    switch (field.type) {
      case "NUMBER": {
        const num = Number(String(value).replace(/,/g, ""));
        if (!Number.isFinite(num)) throw new AppError(400, `"${field.label}" must be a number.`);
        normalised = num;
        break;
      }
      case "CHECKBOX":
        normalised = value === true || value === "true" || value === 1 || value === "1";
        break;
      case "DATE": {
        const date = new Date(String(value));
        if (Number.isNaN(date.getTime())) throw new AppError(400, `"${field.label}" must be a valid date.`);
        // A calendar day, not an instant — same rule as every other date in the planning layer.
        normalised = date.toISOString().slice(0, 10);
        break;
      }
      case "EMAIL": {
        const email = String(value).trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, `"${field.label}" must be an email address.`);
        normalised = email;
        break;
      }
      case "SELECT": {
        const picked = String(value);
        if (!(field.options ?? []).includes(picked)) throw new AppError(400, `"${picked}" is not an option for "${field.label}".`);
        normalised = picked;
        break;
      }
      case "MULTISELECT": {
        const picked = (Array.isArray(value) ? value : [value]).map(String);
        const unknown = picked.filter((v) => !(field.options ?? []).includes(v));
        if (unknown.length > 0) throw new AppError(400, `${unknown.map((v) => `"${v}"`).join(", ")} not an option for "${field.label}".`);
        normalised = Array.from(new Set(picked));
        break;
      }
      default:
        // Length-capped: this is an unauthenticated endpoint, and an unbounded string is a cheap
        // way to fill a database.
        normalised = String(value).slice(0, field.type === "TEXTAREA" ? 20_000 : 500);
    }

    answers[field.key] = normalised;

    if (field.mapsTo === "title") title = String(normalised).slice(0, 200);
    else if (field.mapsTo === "description") description = String(normalised);
    else if (field.mapsTo?.startsWith("custom:")) customFields[field.mapsTo.slice(7)] = normalised;
  }

  if (!title.trim()) {
    // The title field is required by validateFormSchema to EXIST, but it can still be optional
    // and unanswered, or hidden behind a rule the submitter didn't trigger.
    throw new AppError(400, "The question that becomes the request's title wasn't answered.");
  }

  return { answers, title: title.trim(), description, customFields };
}

/**
 * Renders the answers as readable text for the ticket body.
 *
 * Plain text, never HTML: the content is written by an unauthenticated stranger, and the one
 * reliable way to keep it from becoming stored XSS on a ticket page is never to treat it as
 * markup in the first place. Everything else in this app sanitises; this simply doesn't parse.
 */
export function renderAnswers(schema: RequestFormSchema, answers: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const field of schema.fields) {
    if (!(field.key in answers)) continue;
    if (field.mapsTo === "title") continue;
    const value = answers[field.key];
    lines.push(`${field.label}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  }
  return lines.join("\n");
}
