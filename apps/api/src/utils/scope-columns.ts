/**
 * 7.0.0 policy scopes (leave types, holiday calendars): a scope list as a JSON column. Empty or null
 * clears it (SQL NULL = everyone on that axis); undefined leaves the column untouched on an update.
 */
import { Prisma } from "@prisma/client";

export function scopeColumns<T extends { scopeEmploymentTypes?: string[] | null; scopeSiteIds?: string[] | null }>(body: T) {
  const col = (v: string[] | null | undefined) => {
    if (v === undefined) return undefined;
    return v?.length ? [...new Set(v)] : Prisma.DbNull;
  };
  return { ...body, scopeEmploymentTypes: col(body.scopeEmploymentTypes), scopeSiteIds: col(body.scopeSiteIds) };
}
