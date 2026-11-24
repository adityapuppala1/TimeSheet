/**
 * An in-memory tenant database for the V17 Phase B leave tests — just enough of Prisma's surface
 * (where / in / not / lte / gte / OR / groupBy / createMany skipDuplicates / unique keys) for
 * leave.service.ts, leave-external.service.ts and the accrual worker to run UNMODIFIED.
 *
 * Two properties matter more than the rest, because the concurrency tests lean on them:
 *   - UNIQUE KEYS are enforced (LeaveBalanceLedger.idempotencyKey, LeaveRequest.dedupeKey,
 *     LeaveType.code) with a P2002 error, the way MySQL does;
 *   - $transaction is SERIALISED (one at a time, like the service's FOR UPDATE row lock) and
 *     ROLLED BACK on throw (the world is restored from a snapshot), so a failed decision leaves
 *     no trace — exactly what the database guarantees.
 */
type Row = Record<string, any>;

export interface LeaveWorld {
  users: Row[];
  leaveType: Row[];
  leaveRequest: Row[];
  leaveBalanceLedger: Row[];
  holidayCalendar: Row[];
  holiday: Row[];
  settings: Row;
  notifications: Row[];
  /** 7.0.0 */
  compOffRequest: Row[];
  timesheet: Row[];
  approvalDelegation: Row[];
  calendarFeedToken: Row[];
  /** 7.0.0 regularisation */
  attendanceRegularizationRequest: Row[];
  /** 7.0.0 overtime */
  overtimeClaim: Row[];
}

let seq = 0;
const id = (p: string) => `${p}-${String(++seq).padStart(4, "0")}-0000`;

export function emptyWorld(): LeaveWorld {
  return {
    users: [],
    leaveType: [],
    leaveRequest: [],
    leaveBalanceLedger: [],
    holidayCalendar: [],
    holiday: [],
    settings: {
      id: "global",
      attendanceEnabled: false,
      leaveEnabled: true,
      leaveYearStartMonth: 1,
      trustExternalApprovals: false,
      leaveApprovalFallback: "ADMINS",
      compOffEnabled: true,
      compOffHalfDayHours: 4,
      compOffFullDayHours: 8,
      compOffLeaveTypeCode: "CO",
      compOffExpiryDays: null
    },
    notifications: [],
    compOffRequest: [],
    timesheet: [],
    approvalDelegation: [],
    calendarFeedToken: [],
    attendanceRegularizationRequest: [],
    overtimeClaim: []
  };
}

const isPlainObject = (v: unknown) => v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v);
const cmp = (a: unknown) => (a instanceof Date ? a.getTime() : a);
/** The range operators, as predicates (NaN fails every one, as SQL NULL does). */
const RANGE: Record<string, (a: number, b: number) => boolean> = { lte: (a, b) => a <= b, gte: (a, b) => a >= b, lt: (a, b) => a < b, gt: (a, b) => a > b };

function matchValue(value: unknown, cond: unknown, row: Row, key: string, world: LeaveWorld): boolean {
  if (cond === undefined) return true;
  if (cond === null) return value === null || value === undefined;
  if (isPlainObject(cond)) {
    const c = cond as Record<string, unknown>;
    // Relation filters used by the code under test.
    if (key === "role") return matchWhere({ name: row.role?.name }, c, world);
    if (key === "user") {
      const u = world.users.find((x) => x.id === row.userId);
      return Boolean(u) && matchWhere(u!, c, world);
    }
    for (const [op, arg] of Object.entries(c)) {
      // SQL: NULL compares false with every range operator.
      if ((op === "lte" || op === "gte" || op === "lt" || op === "gt") && (value === null || value === undefined)) return false;
      if (op === "in" && !(arg as unknown[]).map(cmp).includes(cmp(value))) return false;
      if (op === "notIn" && (arg as unknown[]).map(cmp).includes(cmp(value))) return false;
      if (op === "not") {
        if (arg === null ? value === null || value === undefined : isPlainObject(arg) ? matchValue(value, arg, row, key, world) : cmp(value) === cmp(arg)) return false;
      }
      if (RANGE[op] && !RANGE[op](cmp(value) as number, cmp(arg) as number)) return false;
      if (op === "startsWith" && !String(value ?? "").startsWith(String(arg))) return false;
    }
    return true;
  }
  return cmp(value) === cmp(cond);
}

export function matchWhere(row: Row, where: Record<string, unknown> | undefined, world: LeaveWorld): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as Record<string, unknown>[]).some((w) => matchWhere(row, w, world))) return false;
      continue;
    }
    if (key === "AND") {
      if (!(cond as Record<string, unknown>[]).every((w) => matchWhere(row, w, world))) return false;
      continue;
    }
    if (!matchValue(row[key], cond, row, key, world)) return false;
  }
  return true;
}

function p2002(target: string) {
  return Object.assign(new Error(`Unique constraint failed on ${target}`), { code: "P2002" });
}

function uniqueCheck(table: Row[], row: Row, keys: string[]) {
  for (const k of keys) {
    if (row[k] == null) continue;
    if (table.some((r) => r !== row && r[k] === row[k])) throw p2002(k);
  }
}

const UNIQUE: Record<string, string[]> = { leaveBalanceLedger: ["idempotencyKey"], leaveRequest: ["dedupeKey"], leaveType: ["code"], calendarFeedToken: ["tokenHash"] };

function project(row: Row | undefined, select: unknown): Row | undefined {
  if (!row || !isPlainObject(select)) return row;
  const inner = (select as { select?: unknown }).select ?? select;
  return Object.fromEntries(Object.entries(inner as Row).filter(([, v]) => v).map(([k]) => [k, row[k]]));
}

/** include = whole related rows; select = ONLY the named fields (as Prisma does — a field that is not
 *  selected must not appear, or a "never returns X" test would prove nothing). */
function withIncludes(world: LeaveWorld, table: string, row: Row | undefined, include?: Record<string, unknown>, select?: Record<string, unknown>) {
  if (!row) return null;
  const related = (key: string): Row | undefined => {
    if (key === "leaveType" && (table === "leaveRequest" || table === "leaveBalanceLedger")) return world.leaveType.find((t) => t.id === row.leaveTypeId);
    if (key === "user" && (table === "leaveRequest" || table === "compOffRequest" || table === "calendarFeedToken" || table === "attendanceRegularizationRequest" || table === "overtimeClaim")) return world.users.find((u) => u.id === row.userId);
    if (key === "delegate" && table === "approvalDelegation") return world.users.find((u) => u.id === row.delegateId);
    if (key === "delegator" && table === "approvalDelegation") return world.users.find((u) => u.id === row.delegatorId);
    return undefined;
  };
  if (select) {
    const out: Row = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      const rel = related(k);
      out[k] = rel ? project(rel, v) : row[k];
    }
    return out;
  }
  const out: Row = { ...row };
  for (const [k, v] of Object.entries(include ?? {})) {
    const rel = related(k);
    if (rel) out[k] = v === true ? rel : project(rel, v);
  }
  return out;
}

function model(world: LeaveWorld, table: keyof LeaveWorld & string) {
  const rows = () => world[table] as Row[];
  const sortBy = (list: Row[], orderBy: unknown) => {
    const orders = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, "asc" | "desc">[];
    return [...list].sort((a, b) => {
      for (const o of orders) {
        const [k, dir] = Object.entries(o)[0];
        const x = cmp(a[k]) as number;
        const y = cmp(b[k]) as number;
        if (x === y) continue;
        return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1);
      }
      return 0;
    });
  };
  return {
    findUnique: async (args: { where: Row; include?: Row; select?: Row }) =>
      withIncludes(world, table, rows().find((r) => matchWhere(r, args.where, world)), args.include, args.select),
    findUniqueOrThrow: async (args: { where: Row; include?: Row }) => {
      const r = rows().find((x) => matchWhere(x, args.where, world));
      if (!r) throw new Error("not found");
      return withIncludes(world, table, r, args.include);
    },
    findFirst: async (args: { where?: Row; include?: Row; select?: Row } = {}) =>
      withIncludes(world, table, rows().find((r) => matchWhere(r, args.where, world)), args.include, args.select),
    findMany: async (args: { where?: Row; include?: Row; select?: Row; orderBy?: unknown; take?: number; skip?: number; distinct?: string[] } = {}) => {
      let list = sortBy(rows().filter((r) => matchWhere(r, args.where, world)), args.orderBy);
      if (args.distinct) {
        const seen = new Set<string>();
        list = list.filter((r) => {
          const k = args.distinct!.map((d) => String(r[d])).join("|");
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      list = list.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 1e9));
      return list.map((r) => withIncludes(world, table, r, args.include, args.select));
    },
    count: async (args: { where?: Row } = {}) => rows().filter((r) => matchWhere(r, args.where, world)).length,
    create: async (args: { data: Row; include?: Row }) => {
      const row = { id: args.data.id ?? id(table), createdAt: new Date(), updatedAt: new Date(), ...args.data };
      for (const [k, v] of Object.entries(row)) if (typeof v === "object" && v && "toNumber" in v) row[k] = Number(v);
      uniqueCheck(rows(), row, UNIQUE[table] ?? []);
      rows().push(row);
      return withIncludes(world, table, row, args.include);
    },
    createMany: async (args: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const d of args.data) {
        const row = { id: id(table), createdAt: new Date(), ...d };
        try {
          uniqueCheck(rows(), row, UNIQUE[table] ?? []);
        } catch (e) {
          if (args.skipDuplicates) continue;
          throw e;
        }
        rows().push(row);
        count += 1;
      }
      return { count };
    },
    update: async (args: { where: Row; data: Row }) => {
      const r = rows().find((x) => matchWhere(x, args.where, world));
      if (!r) throw Object.assign(new Error("not found"), { code: "P2025" });
      Object.assign(r, args.data, { updatedAt: new Date() });
      uniqueCheck(rows(), r, UNIQUE[table] ?? []);
      return r;
    },
    deleteMany: async (args: { where?: Row } = {}) => {
      const keep = rows().filter((x) => !matchWhere(x, args.where, world));
      const count = rows().length - keep.length;
      rows().splice(0, rows().length, ...keep);
      return { count };
    },
    updateMany: async (args: { where: Row; data: Row }) => {
      const hit = rows().filter((x) => matchWhere(x, args.where, world));
      for (const r of hit) Object.assign(r, args.data, { updatedAt: new Date() });
      return { count: hit.length };
    },
    upsert: async (args: { where: Row; create: Row; update: Row }) => {
      const r = rows().find((x) => matchWhere(x, args.where, world));
      if (r) return Object.assign(r, args.update);
      const row = { id: id(table), ...args.create };
      rows().push(row);
      return row;
    },
    groupBy: async (args: { by: string[]; where?: Row; _sum?: Record<string, boolean>; _count?: { _all?: boolean } }) => {
      const groups = new Map<string, Row>();
      for (const r of rows().filter((x) => matchWhere(x, args.where, world))) {
        const k = args.by.map((b) => String(r[b])).join("|");
        const g = groups.get(k) ?? { ...Object.fromEntries(args.by.map((b) => [b, r[b]])), _sum: Object.fromEntries(Object.keys(args._sum ?? {}).map((f) => [f, 0])), ...(args._count ? { _count: { _all: 0 } } : {}) };
        if (args._count) g._count._all += 1;
        for (const f of Object.keys(args._sum ?? {})) g._sum[f] = Math.round((g._sum[f] + Number(r[f] ?? 0)) * 100) / 100;
        groups.set(k, g);
      }
      return [...groups.values()];
    }
  };
}

export function fakePrisma(world: LeaveWorld) {
  let lock: Promise<unknown> = Promise.resolve();
  const client: Record<string, unknown> = {
    user: model(world, "users" as never),
    leaveType: model(world, "leaveType"),
    leaveRequest: model(world, "leaveRequest"),
    leaveBalanceLedger: model(world, "leaveBalanceLedger"),
    holidayCalendar: model(world, "holidayCalendar"),
    holiday: model(world, "holiday"),
    compOffRequest: model(world, "compOffRequest"),
    timesheet: model(world, "timesheet"),
    approvalDelegation: model(world, "approvalDelegation"),
    calendarFeedToken: model(world, "calendarFeedToken"),
    attendanceRegularizationRequest: model(world, "attendanceRegularizationRequest"),
    overtimeClaim: model(world, "overtimeClaim"),
    holidayOptIn: { findMany: async () => [] },
    attendanceShiftAssignment: { findMany: async () => [] },
    globalAttendanceSettings: {
      upsert: async (args: { update?: Row; create?: Row }) => Object.assign(world.settings, args.update ?? {}),
      findUnique: async () => world.settings
    },
    $queryRaw: async () => [],
    // Serialised + rolled back on throw: the database's guarantees, in miniature.
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => {
      const run = lock.then(async () => {
        const snapshot = structuredClone({ r: world.leaveRequest, l: world.leaveBalanceLedger, t: world.leaveType, c: world.compOffRequest, g: world.attendanceRegularizationRequest, o: world.overtimeClaim });
        try {
          return await fn(client);
        } catch (error) {
          world.leaveRequest.splice(0, world.leaveRequest.length, ...snapshot.r);
          world.leaveBalanceLedger.splice(0, world.leaveBalanceLedger.length, ...snapshot.l);
          world.leaveType.splice(0, world.leaveType.length, ...snapshot.t);
          world.compOffRequest.splice(0, world.compOffRequest.length, ...snapshot.c);
          world.attendanceRegularizationRequest.splice(0, world.attendanceRegularizationRequest.length, ...snapshot.g);
          world.overtimeClaim.splice(0, world.overtimeClaim.length, ...snapshot.o);
          throw error;
        }
      });
      lock = run.catch(() => undefined);
      return run;
    }
  };
  return client;
}

/* ------------------------------ builders ------------------------------ */

export function addUser(world: LeaveWorld, u: Partial<Row> & { id: string; role?: string }): Row {
  const row = {
    name: u.id,
    email: `${u.id}@x.io`,
    status: "ACTIVE",
    deletedAt: null,
    isAgent: false,
    timezone: "UTC",
    holidayCalendarId: null,
    employmentType: null,
    siteId: null,
    managerId: null,
    employeeCode: null,
    scimExternalId: null,
    avatarUrl: null,
    weeklyCapacityHours: 40,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    ...u,
    role: { name: u.role ?? "EMPLOYEE" }
  };
  world.users.push(row);
  return row;
}

export function addType(world: LeaveWorld, t: Partial<Row> & { code: string }): Row {
  const row = {
    id: `type-${t.code}`,
    name: `${t.code} leave`,
    colour: "primary",
    annualQuota: 12,
    accrual: "YEARLY_UPFRONT",
    carryForwardMax: 0,
    allowHalfDay: true,
    isPaid: true,
    requiresApproval: true,
    requiresDocumentAfterDays: null,
    allowNegative: false,
    enabled: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...t
  };
  world.leaveType.push(row);
  return row;
}

export function credit(world: LeaveWorld, userId: string, leaveTypeId: string, leaveYear: number, delta: number, kind = "ACCRUAL", key?: string) {
  world.leaveBalanceLedger.push({ id: id("led"), userId, leaveTypeId, leaveYear, delta, kind, idempotencyKey: key ?? null, createdAt: new Date() });
}

export function balanceOf(world: LeaveWorld, userId: string, leaveTypeId: string, leaveYear: number): number {
  return Math.round(
    world.leaveBalanceLedger.filter((l) => l.userId === userId && l.leaveTypeId === leaveTypeId && l.leaveYear === leaveYear).reduce((s, l) => s + Number(l.delta), 0) * 100
  ) / 100;
}
