/**
 * WHAT: the pure rules behind rendering custom fields on a ticket — which definitions apply to a
 * ticket of a given type, and how a stored value reads as text.
 *
 * WHY THEY ARE HERE AND NOT IN THE COMPONENT: the same "does this field apply" rule is what the
 * API's `setCustomFieldValues` uses to SKIP type-scoped fields silently. If the form showed a
 * field the server would then ignore, a person could type a value and watch it vanish on save.
 * Keeping the rule in one small file, tested, is how the two stay aligned.
 */
import type { CustomFieldRow } from "../services/api";

/** Active TICKET fields that apply to this ticket type, in the admin's order. */
export function fieldsForTicket(defs: readonly CustomFieldRow[] | undefined, ticketType: string | null | undefined): CustomFieldRow[] {
  return (defs ?? [])
    .filter((d) => d.isActive && d.appliesTo === "TICKET")
    .filter((d) => !d.ticketTypeFilter || !ticketType || d.ticketTypeFilter === ticketType)
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/** The text a read-only surface shows for a stored value. */
export function displayValue(def: Pick<CustomFieldRow, "type">, value: unknown, users?: ReadonlyArray<{ id: string; name: string }>): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (def.type) {
    case "CHECKBOX":
      return value ? "Yes" : "No";
    case "MULTI_SELECT": {
      if (!Array.isArray(value)) return String(value);
      return value.length ? value.join(", ") : "—";
    }
    case "USER":
      return users?.find((u) => u.id === value)?.name ?? String(value);
    case "CURRENCY":
    case "NUMBER":
      return typeof value === "number" ? value.toLocaleString() : String(value);
    default:
      return String(value);
  }
}

/** What the editor should hold for a stored value — arrays for multi-select, strings otherwise. */
export function editorValue(def: Pick<CustomFieldRow, "type">, value: unknown): string | string[] | boolean {
  if (def.type === "CHECKBOX") return Boolean(value);
  if (def.type === "MULTI_SELECT") return Array.isArray(value) ? value.map(String) : [];
  return value === null || value === undefined ? "" : String(value);
}
