/**
 * Evaluates the approval-SLA breach count the API sends as raw SQL
 * (services/approval-sla-breaches.service.ts) over an in-memory table, so a unit test can assert the
 * COUNT it gets back rather than only the SQL text.
 *
 * Deliberately narrow: it understands that one query's shape — the window bounds as the first two
 * parameters, then optional `t.userId IN (…)` and `t.projectId IN (…)` lists, then an optional
 * `GROUP BY` — and it THROWS unless the SQL states the breach rule itself, so a query that drops the
 * rule cannot be "evaluated" into a plausible number.
 */
export interface SlaRow {
  userId?: string;
  projectId?: string;
  deletedAt?: Date | null;
  approvalDeadline: Date | null;
  reviewedAt: Date | null;
}

type RawSql = { sql: string; values: unknown[] };

export function isApprovalSlaQuery(query: unknown): query is RawSql {
  return typeof query === "object" && query !== null && typeof (query as RawSql).sql === "string" && (query as RawSql).sql.includes("approvalDeadline");
}

export function evaluateApprovalSlaQuery(query: RawSql, rows: SlaRow[]): Array<{ k?: string; n: bigint }> {
  const { sql, values } = query;
  if (!/t\.reviewedAt IS NULL OR t\.reviewedAt > t\.approvalDeadline/.test(sql)) {
    throw new Error(`the approval-SLA query does not state the breach rule: ${sql}`);
  }
  if (!/t\.deletedAt IS NULL/.test(sql)) throw new Error("the approval-SLA query counts deleted entries");

  const [gte, upper] = values as [Date, Date];
  let next = 2;
  const idsAfter = (marker: string): string[] | null => {
    const at = sql.indexOf(marker);
    if (at < 0) return null;
    const count = (sql.slice(at, sql.indexOf(")", at)).match(/\?/g) ?? []).length;
    const ids = values.slice(next, next + count) as string[];
    next += count;
    return ids;
  };
  const userIds = idsAfter("t.userId IN (");
  const projectIds = idsAfter("t.projectId IN (");

  const hits = rows.filter((r) => {
    if ((r.deletedAt ?? null) !== null || !r.approvalDeadline) return false;
    if (r.approvalDeadline < gte || r.approvalDeadline >= upper) return false;
    if (r.reviewedAt !== null && r.reviewedAt <= r.approvalDeadline) return false;
    if (userIds && !userIds.includes(r.userId ?? "")) return false;
    return !projectIds || projectIds.includes(r.projectId ?? "");
  });

  const key = /GROUP BY t\.(userId|projectId)/.exec(sql)?.[1] as "userId" | "projectId" | undefined;
  if (!key) return [{ n: BigInt(hits.length) }];
  const counts = new Map<string, number>();
  for (const r of hits) counts.set(r[key] ?? "", (counts.get(r[key] ?? "") ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => ({ k, n: BigInt(n) }));
}
