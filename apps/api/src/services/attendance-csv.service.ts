/**
 * CSV attendance import (V17 A3): upload → preview (per-row errors, who each row matched) →
 * commit. The commit re-validates from the same text rather than trusting a preview the client
 * could have edited, then sends every valid row through attendance-ingest.service.ts as a CSV
 * event — CSV ranks lowest by default, so an import never silently overrides a device punch.
 *
 * Columns (header row required, any order): identifier, date, punch_in, punch_out?, external_ref?
 *   date       YYYY-MM-DD, the person's local day
 *   punch_in   HH:mm (the person's local time on `date`) or a full ISO instant with a zone
 *   punch_out  same forms, optional
 * Without external_ref the row's own content is hashed into one, so importing the same file twice
 * is a no-op (DUPLICATE) instead of a second set of events.
 */
import crypto from "node:crypto";
import type { AttendanceMatchField } from "@prisma/client";
import { prisma } from "../config/prisma.js";
import { serverTimezone } from "../config/env.js";
import { AppError } from "../middleware/error.js";
import { zonedWallTimeToUtc } from "../utils/recipient-time.js";
import { ingestPunch, parseInstant, type IngestResult } from "./attendance-ingest.service.js";

export const CSV_MAX_ROWS = 5000;
export const CSV_MAX_CHARS = 1_000_000;

const REQUIRED = ["identifier", "date", "punch_in"] as const;
const KNOWN = new Set(["identifier", "date", "punch_in", "punch_out", "external_ref"]);

const BOM = 0xfeff;

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. No dependency for 40 lines of grammar. */
// eslint-disable-next-line sonarjs/cognitive-complexity -- a CSV tokenizer is one state machine; splitting its branches across functions makes the quote rules harder to follow, not easier
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === BOM ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export interface CsvRow {
  line: number;
  identifier: string;
  date: string;
  punchIn: string;
  punchOut: string | null;
  externalRef: string;
  errors: string[];
  /** Admin-only preview: whom the row matched. Never returned to an external caller. */
  person: { id: string; name: string; timezone: string | null } | null;
  punchInAt: string | null;
  punchOutAt: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function realDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** "09:05" on `date` in the person's zone, or an ISO instant with a zone. */
export function csvTimeToInstant(value: string, date: string, timeZone: string | null): Date | null {
  const t = value.trim();
  const m = TIME_RE.exec(t);
  if (m) return zonedWallTimeToUtc(date, Number(m[1]), Number(m[2]), timeZone, serverTimezone);
  return parseInstant(t);
}

function personWhere(identifier: string, matchField: AttendanceMatchField) {
  if (matchField === "EMAIL") return { email: identifier.toLowerCase() };
  if (matchField === "EMPLOYEE_CODE") return { employeeCode: identifier };
  return { scimExternalId: identifier };
}

async function findPerson(identifier: string, matchField: AttendanceMatchField) {
  const where = personWhere(identifier, matchField);
  return prisma.user.findFirst({ where: { ...where, status: "ACTIVE", deletedAt: null }, select: { id: true, name: true, timezone: true } });
}

interface RawRow {
  identifier: string;
  date: string;
  punchIn: string;
  punchOut: string | null;
  externalRef: string;
}

/** One row's checks, given whom its identifier matched (looked up by the caller, once per person). */
function validateRow(line: number, f: RawRow, person: CsvRow["person"]): CsvRow {
  const errors: string[] = [];
  if (!f.identifier) errors.push("identifier is empty");
  else if (!person) errors.push("no active person matches this identifier");
  const dateOk = realDate(f.date);
  if (!dateOk) errors.push("date must be YYYY-MM-DD");
  if (!f.punchIn) errors.push("punch_in is empty");
  const zone = person?.timezone ?? null;
  const punchInAt = f.punchIn && dateOk ? csvTimeToInstant(f.punchIn, f.date, zone) : null;
  if (f.punchIn && dateOk && !punchInAt) errors.push("punch_in must be HH:mm or an ISO timestamp with a zone");
  const punchOutAt = f.punchOut && dateOk ? csvTimeToInstant(f.punchOut, f.date, zone) : null;
  if (f.punchOut && dateOk && !punchOutAt) errors.push("punch_out must be HH:mm or an ISO timestamp with a zone");
  if (punchInAt && punchOutAt && punchOutAt < punchInAt) errors.push("punch_out is before punch_in");
  const digest = crypto.createHash("sha256").update([f.identifier, f.date, f.punchIn, f.punchOut ?? ""].join("|")).digest("hex").slice(0, 40);
  return {
    line,
    identifier: f.identifier,
    date: f.date,
    punchIn: f.punchIn,
    punchOut: f.punchOut,
    externalRef: f.externalRef || "csv:" + digest,
    errors,
    person,
    punchInAt: punchInAt?.toISOString() ?? null,
    punchOutAt: punchOutAt?.toISOString() ?? null
  };
}

function checkHeader(header: string[]): string[] {
  const errors: string[] = [];
  for (const col of REQUIRED) if (!header.includes(col)) errors.push(`Missing column "${col}".`);
  for (const col of header) if (col && !KNOWN.has(col)) errors.push(`Unknown column "${col}".`);
  return errors;
}

export async function validateCsv(text: string, matchField: AttendanceMatchField): Promise<{ rows: CsvRow[]; headerErrors: string[] }> {
  if (text.length > CSV_MAX_CHARS) throw new AppError(413, `The file is over ${CSV_MAX_CHARS.toLocaleString()} characters. Split it and import in parts.`);
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], headerErrors: ["The file is empty."] };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const headerErrors = checkHeader(header);
  if (headerErrors.length) return { rows: [], headerErrors };
  if (table.length - 1 > CSV_MAX_ROWS) throw new AppError(413, `At most ${CSV_MAX_ROWS} rows per import.`);

  const col = (r: string[], name: string) => {
    const at = header.indexOf(name);
    return at >= 0 ? (r[at] ?? "").trim() : "";
  };
  const people = new Map<string, Awaited<ReturnType<typeof findPerson>>>();
  const seenRefs = new Set<string>();
  const rows: CsvRow[] = [];
  for (const [i, r] of table.slice(1).entries()) {
    const fields = {
      identifier: col(r, "identifier"),
      date: col(r, "date"),
      punchIn: col(r, "punch_in"),
      punchOut: col(r, "punch_out") || null,
      externalRef: col(r, "external_ref")
    };
    let person = null;
    if (fields.identifier) {
      const key = fields.identifier.toLowerCase();
      if (!people.has(key)) people.set(key, await findPerson(fields.identifier, matchField));
      person = people.get(key) ?? null;
    }
    const row = validateRow(i + 2, fields, person);
    if (seenRefs.has(row.externalRef)) row.errors.push("duplicate row in this file");
    seenRefs.add(row.externalRef);
    rows.push(row);
  }
  return { rows, headerErrors };
}

/** Ingests the valid rows only; invalid ones are reported back, never half-imported. */
export async function commitCsv(text: string, matchField: AttendanceMatchField, sourceId: string | null) {
  const { rows, headerErrors } = await validateCsv(text, matchField);
  if (headerErrors.length) throw new AppError(422, headerErrors.join(" "));
  const counts: Record<IngestResult["status"], number> = { ACCEPTED: 0, DUPLICATE: 0, SUPERSEDED: 0, UNMATCHED: 0, REJECTED: 0 };
  let skipped = 0;
  for (const row of rows) {
    if (row.errors.length || !row.punchInAt) {
      skipped++;
      continue;
    }
    const result = await ingestPunch({
      kind: "CSV",
      sourceId,
      person: row.person ? { id: row.person.id, timezone: row.person.timezone } : null,
      identifier: row.identifier,
      matchField,
      punchInAt: row.punchInAt,
      punchOutAt: row.punchOutAt,
      externalRef: row.externalRef,
      rawPayload: { line: row.line, identifier: row.identifier, date: row.date, punch_in: row.punchIn, punch_out: row.punchOut },
      gateChecked: true
    });
    counts[result.status]++;
  }
  return { total: rows.length, skipped, ...counts };
}
