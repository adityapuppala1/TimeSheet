/**
 * WHAT: admin-defined extra fields on tickets and projects — definition CRUD, plus the
 * normalise-and-validate step every value write goes through.
 *
 * WHY VALUES ARE VALIDATED HERE AND NOT AT THE EDGE: `CustomFieldValue.value` is a JSON column,
 * so the database will accept literally anything. The declared `CustomFieldType` is the only
 * thing that makes a NUMBER field actually numeric, and if that check lived in the controller it
 * would have to be repeated in the request-form intake path, the blueprint expander, the public
 * API and the AI proposal applier — four more chances to forget. One choke point, same shape as
 * `ai.service.ts#preflight`.
 *
 * WHO CALLS THIS: `controllers/planning.controller.ts` today; from Phase 2 on, the ticket and
 * project write paths, request-form submission, and blueprint instantiation.
 */
import { customFieldTypes, type CustomFieldType, type CustomFieldValue } from "@timesheet/shared";
import { prisma } from "../config/prisma.js";
import { requireTenantContext } from "../config/tenant-context.js";
import { AppError } from "../middleware/error.js";
import { getPlanningQuota } from "./plan-limits.service.js";

/** Machine keys are used in request-form payloads, blueprint payloads and the public API, so they
 *  are constrained to something safe to put in a URL or a JSON key. */
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;

export async function listCustomFields(options: { includeInactive?: boolean } = {}) {
  return prisma.customField.findMany({
    where: options.includeInactive ? {} : { isActive: true },
    orderBy: [{ appliesTo: "asc" }, { order: "asc" }]
  });
}

export interface CustomFieldInput {
  key: string;
  label: string;
  type: CustomFieldType;
  description?: string | null;
  options?: string[];
  isRequired?: boolean;
  appliesTo?: "TICKET" | "PROJECT";
  ticketTypeFilter?: string | null;
  showOnRequestForm?: boolean;
  order?: number;
  isActive?: boolean;
}

function validateDefinition(input: CustomFieldInput): void {
  if (!KEY_PATTERN.test(input.key)) {
    throw new AppError(400, "Field key must start with a lowercase letter and contain only lowercase letters, digits and underscores.");
  }
  if (!customFieldTypes.includes(input.type)) {
    throw new AppError(400, `"${input.type}" is not a valid field type.`);
  }
  const needsOptions = input.type === "SINGLE_SELECT" || input.type === "MULTI_SELECT";
  if (needsOptions && (!input.options || input.options.length === 0)) {
    throw new AppError(400, "A select field needs at least one option.");
  }
  if (!needsOptions && input.options && input.options.length > 0) {
    throw new AppError(400, "Only select fields can have options.");
  }
  if (input.options && new Set(input.options).size !== input.options.length) {
    throw new AppError(400, "Options must be unique.");
  }
}

export async function createCustomField(input: CustomFieldInput) {
  validateDefinition(input);

  // Quota is checked against ACTIVE fields only: deactivating a field you no longer use should
  // free the slot, otherwise an org hits its ceiling permanently through normal iteration.
  const quota = await getPlanningQuota(requireTenantContext().orgId, "maxCustomFields");
  const used = await prisma.customField.count({ where: { isActive: true } });
  if (used >= quota) {
    throw new AppError(
      403,
      quota === 0
        ? "Custom fields are not included in this plan."
        : `This plan allows ${quota} custom field(s) and ${used} are in use. Deactivate one or upgrade.`
    );
  }

  return prisma.customField.create({
    data: {
      key: input.key,
      label: input.label,
      type: input.type,
      description: input.description ?? null,
      options: input.options ?? undefined,
      isRequired: input.isRequired ?? false,
      appliesTo: input.appliesTo ?? "TICKET",
      ticketTypeFilter: input.ticketTypeFilter ?? null,
      showOnRequestForm: input.showOnRequestForm ?? false,
      order: input.order ?? 0,
      isActive: input.isActive ?? true
    }
  });
}

export async function updateCustomField(id: string, input: CustomFieldInput) {
  validateDefinition(input);
  const existing = await prisma.customField.findUniqueOrThrow({ where: { id } });

  // Changing a field's TYPE would silently invalidate every value already stored under it — a
  // TEXT value does not become a NUMBER because the definition changed its mind. Rather than
  // attempt a lossy coercion, refuse while data exists and let the admin decide.
  if (existing.type !== input.type) {
    const valueCount = await prisma.customFieldValue.count({ where: { fieldId: id } });
    if (valueCount > 0) {
      throw new AppError(
        400,
        `This field's type can't change while ${valueCount} value(s) are stored under it. Create a new field instead.`
      );
    }
  }

  return prisma.customField.update({
    where: { id },
    data: {
      key: input.key,
      label: input.label,
      type: input.type,
      description: input.description ?? null,
      options: input.options ?? undefined,
      isRequired: input.isRequired ?? false,
      appliesTo: input.appliesTo ?? existing.appliesTo,
      ticketTypeFilter: input.ticketTypeFilter ?? null,
      showOnRequestForm: input.showOnRequestForm ?? false,
      order: input.order ?? existing.order,
      isActive: input.isActive ?? existing.isActive
    }
  });
}

/** Deactivates rather than deletes when values exist — a hard delete cascades the values away,
 *  which quietly destroys data an admin may only have meant to hide. */
export async function deleteCustomField(id: string): Promise<{ deleted: boolean }> {
  const valueCount = await prisma.customFieldValue.count({ where: { fieldId: id } });
  if (valueCount > 0) {
    await prisma.customField.update({ where: { id }, data: { isActive: false } });
    return { deleted: false };
  }
  await prisma.customField.delete({ where: { id } });
  return { deleted: true };
}

/**
 * Coerces and validates one value against its field's declared type. Returns what should be
 * stored in the JSON column; throws `AppError(400)` on anything the type can't accept.
 *
 * `null`/`""` always clears the value — except on a required field, where it is refused. That
 * asymmetry is deliberate: "not answered" and "answered with nothing" are the same fact, and
 * making them two states would put empty strings in reports.
 */
export function normaliseValue(
  field: { key: string; label: string; type: CustomFieldType; isRequired: boolean; options: unknown },
  raw: unknown
): CustomFieldValue {
  const isEmpty = raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0);
  if (isEmpty) {
    if (field.isRequired) throw new AppError(400, `"${field.label}" is required.`);
    return null;
  }

  const options = Array.isArray(field.options) ? (field.options as string[]) : [];

  switch (field.type) {
    case "TEXT":
    case "USER":
      return String(raw);

    case "URL": {
      const url = String(raw);
      try {
        const parsed = new URL(url);
        // http(s) only. A stored `javascript:` URL becomes an XSS vector the moment any surface
        // renders it as a link, and there is no legitimate use for one in a custom field.
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
      } catch {
        throw new AppError(400, `"${field.label}" must be a valid http(s) URL.`);
      }
      return url;
    }

    case "NUMBER":
    case "CURRENCY": {
      const num = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(num)) throw new AppError(400, `"${field.label}" must be a number.`);
      return num;
    }

    case "CHECKBOX":
      return raw === true || raw === "true" || raw === 1 || raw === "1";

    case "DATE": {
      const date = new Date(String(raw));
      if (Number.isNaN(date.getTime())) throw new AppError(400, `"${field.label}" must be a valid date.`);
      // Stored as a plain YYYY-MM-DD string, not an ISO instant: a custom DATE field is a
      // calendar day, and keeping a time-of-day on it would make the same value render as two
      // different days either side of a timezone boundary.
      return date.toISOString().slice(0, 10);
    }

    case "SINGLE_SELECT": {
      const value = String(raw);
      if (!options.includes(value)) {
        throw new AppError(400, `"${value}" is not an option for "${field.label}".`);
      }
      return value;
    }

    case "MULTI_SELECT": {
      const values = (Array.isArray(raw) ? raw : [raw]).map(String);
      const unknown = values.filter((v) => !options.includes(v));
      if (unknown.length > 0) {
        throw new AppError(400, `${unknown.map((v) => `"${v}"`).join(", ")} not an option for "${field.label}".`);
      }
      return Array.from(new Set(values));
    }

    default:
      throw new AppError(400, `Unsupported field type "${field.type}".`);
  }
}

/**
 * Writes a whole map of `{ fieldKey: value }` onto one ticket or project.
 *
 * Runs in a single transaction and validates EVERY value before writing ANY of them, so a form
 * with one bad field leaves nothing half-saved. Required fields that are absent from the map are
 * left alone rather than cleared — a partial update ("just change the priority") must not wipe
 * fields the caller never mentioned.
 */
export async function setCustomFieldValues(
  target: { ticketId?: string; projectId?: string },
  values: Record<string, unknown>,
  context?: { ticketType?: string }
): Promise<void> {
  if (!target.ticketId === !target.projectId) {
    throw new AppError(400, "Custom field values attach to exactly one ticket or project.");
  }
  const keys = Object.keys(values);
  if (keys.length === 0) return;

  const fields = await prisma.customField.findMany({
    where: { key: { in: keys }, isActive: true, appliesTo: target.ticketId ? "TICKET" : "PROJECT" }
  });

  const normalised: Array<{ fieldId: string; value: CustomFieldValue }> = [];
  for (const field of fields) {
    // A field scoped to one ticket type is silently skipped for other types rather than
    // rejected — the caller is often a generic form posting everything it knows.
    if (field.ticketTypeFilter && context?.ticketType && field.ticketTypeFilter !== context.ticketType) continue;
    normalised.push({
      fieldId: field.id,
      value: normaliseValue(
        { key: field.key, label: field.label, type: field.type as CustomFieldType, isRequired: field.isRequired, options: field.options },
        values[field.key]
      )
    });
  }

  await prisma.$transaction(
    normalised.map((n) =>
      target.ticketId
        ? prisma.customFieldValue.upsert({
            where: { fieldId_ticketId: { fieldId: n.fieldId, ticketId: target.ticketId } },
            update: { value: n.value ?? undefined },
            create: { fieldId: n.fieldId, ticketId: target.ticketId, value: n.value ?? undefined }
          })
        : prisma.customFieldValue.upsert({
            where: { fieldId_projectId: { fieldId: n.fieldId, projectId: target.projectId! } },
            update: { value: n.value ?? undefined },
            create: { fieldId: n.fieldId, projectId: target.projectId!, value: n.value ?? undefined }
          })
    )
  );
}

/** `{ fieldKey: value }` for one ticket or project — the shape the UI and public API render. */
export async function getCustomFieldValues(target: { ticketId?: string; projectId?: string }) {
  const rows = await prisma.customFieldValue.findMany({
    where: target.ticketId ? { ticketId: target.ticketId } : { projectId: target.projectId },
    include: { field: true }
  });
  const out: Record<string, CustomFieldValue> = {};
  for (const row of rows) out[row.field.key] = (row.value ?? null) as CustomFieldValue;
  return out;
}
