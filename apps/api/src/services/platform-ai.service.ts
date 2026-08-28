/**
 * WHAT: the platform operator's AI advisor — it reads the metrics the console already shows for one
 * workspace and writes back a ranked, plain-English list of what is worth doing about them.
 *
 * WHY AN ADVISOR AND NOT AN AGENT. Everything on the monitoring page is already true; what is
 * missing is the reading. An operator with forty workspaces has forty pages of numbers and no time,
 * and the judgement they want — "this one's index growth is the real problem, that one's connection
 * spike is the shared box and not them" — is exactly what a model is good at and a threshold rule is
 * not. What a model is NOT good at is being trusted with a database, which is why nothing here
 * executes anything.
 *
 * THE GUARDRAILS, each one a decision rather than a precaution:
 *
 *  1. AGGREGATE FACTS ONLY. `buildAdvisorFacts` assembles sizes, counts, rates and TABLE NAMES —
 *     the shape of the schema, which is the platform's own product — and never a row, a column
 *     value, a person, or an email address. Running statements arrive already reduced to their
 *     shape by `redactStatement`. A test asserts the fact sheet contains nothing but the fields
 *     this function puts there.
 *  2. NOTHING EXECUTES. A finding may name an action, and only from a closed allowlist compiled
 *     into this file. `sanitiseAdvice` drops any action id it does not recognise rather than
 *     passing it through for the UI to puzzle over. Running one is a separate, human-initiated
 *     call to the same guarded endpoint an operator could have used by hand.
 *  3. HUMAN IN THE LOOP, RECORDED. Every advisory is stored `PENDING` and stays that way until a
 *     person marks it applied or dismissed, with a note. The dismissals are the point: an advisor
 *     nobody can disagree with in writing is one nobody can evaluate.
 *  4. THE OUTPUT IS PARSED, NOT TRUSTED. Malformed JSON, missing fields, forty findings, a
 *     three-page summary — all handled by clamping and dropping, never by throwing the whole answer
 *     away and never by showing the raw text. If nothing survives, the advisor says it has no
 *     advice, which is a legitimate answer.
 *  5. IT IS OFF BY DEFAULT AND USES THE PLATFORM'S OWN KEY. There is no fallback to a workspace's
 *     provider: that would spend a customer's money on another customer's problem and route one
 *     tenant's operational detail through another tenant's vendor. A self-hosted OpenAI-compatible
 *     endpoint is a first-class choice for an operator who will not send fleet metrics anywhere.
 *  6. A DAILY CEILING. An advisor that can be re-run in a loop is a bill with a user interface.
 */
import { controlPrisma } from "../config/control-prisma.js";
import { AppError } from "../middleware/error.js";
import { decryptSecret, encryptSecret } from "../utils/encryption.js";
import { callAnthropic, callOpenAICompatible } from "./ai.service.js";
import { getTenantHealth } from "./platform-tenant-health.service.js";
import { getTenantDbTrend } from "./tenant-db-metrics.service.js";
import { platformAudit } from "./platform-audit.service.js";

/* ------------------------------------------------------------------------------------------ */
/* Settings                                                                                    */
/* ------------------------------------------------------------------------------------------ */

const SETTINGS_ID = "global";

export interface PlatformAiSettingsView {
  enabled: boolean;
  provider: string;
  baseUrl: string | null;
  model: string;
  /** Whether a key exists — never the key. */
  apiKeySet: boolean;
  dailyCallLimit: number;
  updatedAt: string | null;
  updatedBy: string | null;
  /** How many generations have run today, so the console can show the ceiling being approached. */
  usedToday: number;
}

export async function getPlatformAiSettings(): Promise<PlatformAiSettingsView> {
  const row = await controlPrisma.platformAiSettings.upsert({ where: { id: SETTINGS_ID }, update: {}, create: { id: SETTINGS_ID } });
  return {
    enabled: row.enabled,
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    apiKeySet: Boolean(row.encryptedApiKey),
    dailyCallLimit: row.dailyCallLimit,
    updatedAt: row.updatedAt?.toISOString() ?? null,
    updatedBy: row.updatedBy,
    usedToday: await countToday()
  };
}

export async function updatePlatformAiSettings(input: {
  enabled: boolean;
  provider: string;
  baseUrl: string | null;
  model: string;
  /** Undefined keeps the stored key; "" clears it. Never echoed back. */
  apiKey?: string;
  dailyCallLimit: number;
  actorLabel: string;
}): Promise<PlatformAiSettingsView> {
  if (!["ANTHROPIC", "OPENAI_COMPATIBLE"].includes(input.provider)) throw new AppError(422, "Unknown provider.");
  if (input.provider === "OPENAI_COMPATIBLE" && input.enabled && !input.baseUrl) {
    throw new AppError(422, "An OpenAI-compatible provider needs a base URL — that is the whole address the advisor will call.");
  }
  const dailyCallLimit = Math.min(1000, Math.max(1, Math.round(input.dailyCallLimit)));

  const key = input.apiKey === undefined ? {} : { encryptedApiKey: input.apiKey ? encryptSecret(input.apiKey) : null };
  await controlPrisma.platformAiSettings.upsert({
    where: { id: SETTINGS_ID },
    update: { enabled: input.enabled, provider: input.provider, baseUrl: input.baseUrl, model: input.model, dailyCallLimit, updatedBy: input.actorLabel, ...key },
    create: { id: SETTINGS_ID, enabled: input.enabled, provider: input.provider, baseUrl: input.baseUrl, model: input.model, dailyCallLimit, updatedBy: input.actorLabel, ...key }
  });
  // The KEY is never in the audit payload — only that one was set or cleared.
  await platformAudit("PLATFORM_ADMIN", input.actorLabel, "platform_ai.settings_updated", "PlatformAiSettings", SETTINGS_ID, {
    enabled: input.enabled,
    provider: input.provider,
    model: input.model,
    apiKeyChanged: input.apiKey !== undefined
  });
  return getPlatformAiSettings();
}

async function countToday(): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  return controlPrisma.platformAiAdvice.count({ where: { createdAt: { gte: start } } });
}

/* ------------------------------------------------------------------------------------------ */
/* The closed action allowlist                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * Every action a finding may name.
 *
 * `executable` marks the two the console can actually run, and both of them run the SAME guarded
 * endpoint an operator reaches by hand — `runMaintenanceOperation`, which validates table names
 * against the live schema and refuses OPTIMIZE outside a maintenance window. The rest are
 * destinations, not buttons: they take the operator to the page where a human makes the decision.
 *
 * A model that invents an action id gets it dropped. That is a deliberate silent failure: the
 * alternative — surfacing an unknown action so somebody can wonder what it means — is worse.
 */
export const ADVISOR_ACTIONS = {
  ANALYZE_TABLES: { label: "Refresh table statistics", executable: true, description: "Runs ANALYZE TABLE. Online and cheap; corrects a query plan that has drifted as the data changed shape." },
  OPTIMIZE_TABLES: { label: "Reclaim fragmented space", executable: true, description: "Runs OPTIMIZE TABLE. Rebuilds the table and blocks writes to it, so it is refused outside an active maintenance window." },
  ARM_MAINTENANCE_WINDOW: { label: "Arm a maintenance window", executable: false, description: "Opens Maintenance with this workspace selected." },
  REVIEW_BACKUP_POLICY: { label: "Review the backup policy", executable: false, description: "Opens this workspace's managed-backup schedule." },
  REVIEW_INDEXES: { label: "Review the schema's indexes", executable: false, description: "A product decision, not an operations one — it belongs in the engineering backlog." },
  CONTACT_WORKSPACE: { label: "Talk to the customer", executable: false, description: "Some findings are conversations: an import that doubled their data, a plan that no longer fits." },
  MONITOR: { label: "Watch it", executable: false, description: "Real but not yet actionable. The trend will say whether it becomes one." }
} as const;

export type AdvisorActionId = keyof typeof ADVISOR_ACTIONS;

const ACTION_IDS = Object.keys(ADVISOR_ACTIONS) as AdvisorActionId[];

/* ------------------------------------------------------------------------------------------ */
/* The fact sheet                                                                              */
/* ------------------------------------------------------------------------------------------ */

export interface AdvisorFacts {
  workspace: { slug: string; planTier: string; status: string };
  database: {
    tableCount: number;
    totalMb: number;
    dataMb: number;
    indexMb: number;
    freeMb: number;
    indexSharePercent: number | null;
    estimatedRows: number;
    metadataQueryMs: number;
    tablesWithoutPrimaryKey: string[];
    indexHeavyTables: string[];
    largestTables: Array<{ name: string; totalMb: number; rows: number; fragmentationPercent: number | null; indexes: number; autoIncrementUsePercent: number | null }>;
  } | null;
  server: {
    note: string;
    connectionUsePercent: number | null;
    bufferPoolHitRatePercent: number | null;
    tmpDiskTablePercent: number | null;
    rowsExaminedPerSelect: number | null;
    slowQueries: number | null;
  } | null;
  trend: { days: number; samples: number; percentChange: number | null; mbPerDay: number | null; daysToTarget: number | null } | null;
  api: { windowHours: number; requests: number; errorRatePercent: number | null; p95Ms: number | null; slowestEndpoints: Array<{ name: string; p95Ms: number; calls: number; errorRatePercent: number }> } | null;
  services: { down: string[]; degraded: string[]; openIncidents: number } | null;
  maintenance: { phase: string; managedByPlatform: boolean } | null;
  /** Statement SHAPES only — literals were stripped before they reached this service. */
  longRunningQueries: Array<{ seconds: number; shape: string | null }>;
  /** The thresholds the console already crossed, so the model is not asked to re-derive them. */
  existingAlerts: Array<{ severity: string; title: string; detail: string }>;
}

const mb = (bytes: number | null | undefined) => (bytes === null || bytes === undefined ? 0 : Math.round((bytes / 1024 / 1024) * 10) / 10);
const round = (value: number | null | undefined, digits = 1) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

/**
 * Build the fact sheet, from data the console already has.
 *
 * PURE, and separated from the model call for exactly one reason: this is the function that decides
 * what leaves the deployment, so it has to be readable in one screen and assertable in a test. Every
 * field is a number, a name from the SCHEMA, or a string this codebase wrote. There is no path here
 * for a row of anybody's data.
 */
export function buildAdvisorFacts(input: {
  health: Awaited<ReturnType<typeof getTenantHealth>>;
  trend: Awaited<ReturnType<typeof getTenantDbTrend>>;
  trendDays: number;
}): AdvisorFacts {
  const { health, trend } = input;
  const db = health.database.data;
  const api = health.api.data;
  const status = health.status.data;

  return {
    workspace: { slug: health.organization.slug, planTier: health.organization.planTier, status: health.organization.status },
    database: db
      ? {
          tableCount: db.schema.tableCount,
          totalMb: mb(db.schema.totalBytes),
          dataMb: mb(db.schema.dataBytes),
          indexMb: mb(db.schema.indexBytes),
          freeMb: mb(db.schema.freeBytes),
          indexSharePercent: round(db.schema.indexShare === null ? null : db.schema.indexShare * 100),
          estimatedRows: db.schema.estimatedRows,
          metadataQueryMs: db.queryMs,
          tablesWithoutPrimaryKey: db.schema.tablesWithoutPrimaryKey.slice(0, 20),
          indexHeavyTables: db.schema.indexHeavyTables.slice(0, 20),
          largestTables: db.schema.largestTables.slice(0, 10).map((table) => ({
            name: table.name,
            totalMb: mb(table.totalBytes),
            rows: table.estimatedRows,
            fragmentationPercent: round(table.fragmentation === null ? null : table.fragmentation * 100),
            indexes: table.indexCount,
            autoIncrementUsePercent: round(table.autoIncrementUsePercent)
          }))
        }
      : null,
    server: db
      ? {
          note: "These counters belong to the MySQL server, which other workspaces may share. Do not attribute them to this workspace alone.",
          connectionUsePercent: round(db.server.connectionUsePercent),
          bufferPoolHitRatePercent: round(db.server.bufferPoolHitRate, 2),
          tmpDiskTablePercent: round(db.server.tmpDiskTablePercent),
          rowsExaminedPerSelect: round(db.server.rowsExaminedPerReturned),
          slowQueries: db.server.slowQueries
        }
      : null,
    trend: trend.points.length
      ? {
          days: input.trendDays,
          samples: trend.growth.samples,
          percentChange: round(trend.growth.percentChange),
          mbPerDay: trend.growth.bytesPerDay === null ? null : mb(trend.growth.bytesPerDay),
          daysToTarget: trend.growth.daysToTarget === null ? null : Math.round(trend.growth.daysToTarget)
        }
      : null,
    api: api
      ? {
          windowHours: api.window.hours,
          requests: api.totals.total,
          errorRatePercent: round(api.totals.errorRate),
          p95Ms: round(api.totals.p95Ms, 0),
          slowestEndpoints: api.endpoints.slice(0, 8).map((endpoint) => ({
            name: endpoint.apiName,
            p95Ms: Math.round(endpoint.p95Ms),
            calls: endpoint.total,
            errorRatePercent: round(endpoint.errorRate) ?? 0
          }))
        }
      : null,
    services: status
      ? {
          down: status.services.filter((service) => service.current === "DOWN").map((service) => service.label),
          degraded: status.services.filter((service) => service.current === "DEGRADED").map((service) => service.label),
          openIncidents: status.incidents.filter((incident) => !incident.endedAt).length
        }
      : null,
    // The workspace's own maintenance NOTE is deliberately not carried: it is free text an admin
    // wrote, and free text an admin wrote is the one field on this payload that can contain a
    // person, a phone number or a customer's name. `platform-ai-guardrails.test.ts` plants exactly
    // that string in the input and fails if it appears in the fact sheet.
    maintenance: health.maintenance.data ? { phase: health.maintenance.data.phase, managedByPlatform: false } : null,
    longRunningQueries: (db?.activeQueries ?? []).filter((query) => query.seconds >= 10).slice(0, 5).map((query) => ({ seconds: query.seconds, shape: query.digest })),
    existingAlerts: health.alerts.map((alert) => ({ severity: alert.severity, title: alert.title, detail: alert.detail }))
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The prompt, and the sanitiser                                                               */
/* ------------------------------------------------------------------------------------------ */

export interface AdvisorFinding {
  severity: "critical" | "warning" | "info";
  title: string;
  /** Why this is a finding — the reasoning, in a sentence or two. */
  rationale: string;
  /** What to do, from the allowlist. */
  action: AdvisorActionId;
  /** Table names the action applies to, when it is a table-level one. */
  tables: string[];
  /** How sure the model is. Rendered, because a hedge is information. */
  confidence: "high" | "medium" | "low";
}

export interface AdvisorResult {
  summary: string;
  findings: AdvisorFinding[];
}

const MAX_FINDINGS = 8;
const MAX_SUMMARY_CHARS = 900;
const MAX_RATIONALE_CHARS = 400;
const MAX_TITLE_CHARS = 90;

const RESPONSE_SCHEMA = {
  name: "workspace_advice",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "findings"],
    properties: {
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "title", "rationale", "action", "tables", "confidence"],
          properties: {
            severity: { type: "string", enum: ["critical", "warning", "info"] },
            title: { type: "string" },
            rationale: { type: "string" },
            action: { type: "string", enum: ACTION_IDS },
            tables: { type: "array", items: { type: "string" } },
            confidence: { type: "string", enum: ["high", "medium", "low"] }
          }
        }
      }
    }
  }
} as const;

export function buildAdvisorPrompt(facts: AdvisorFacts): string {
  const actions = ACTION_IDS.map((id) => `- ${id}: ${ADVISOR_ACTIONS[id].description}`).join("\n");
  return [
    "You are advising the operator of a multi-tenant SaaS platform about ONE customer workspace's database and API health.",
    "You are given aggregate metrics only. You cannot see any customer data and must not speculate about any.",
    "",
    "Write for an experienced operator who is short of time. Rank ruthlessly: three findings that matter beat eight that are true.",
    "",
    "RULES:",
    "- Anything the facts label as server-wide belongs to the MySQL server, which other workspaces share. Never present it as this workspace's fault; say plainly that it is the box.",
    "- Do not repeat a threshold alert back as a finding unless you can add something it does not say — a cause, a consequence, or a link between two of them.",
    "- Prefer no finding to a speculative one. An empty list is a valid, useful answer.",
    "- Every finding must name one action from this list, using the id exactly:",
    actions,
    "- `tables` may only contain table names that appear in the facts. Leave it empty when the action is not table-level.",
    "- Use `confidence: low` when the data is thin (few trend samples, no API traffic). Do not hide uncertainty.",
    "- The summary is one short paragraph: what state this workspace is in, and what you would do first.",
    "",
    "FACTS (JSON):",
    JSON.stringify(facts, null, 1)
  ].join("\n");
}

const clamp = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

/**
 * Turn whatever the model returned into something the console can render, or into nothing.
 *
 * PURE, and the most important function in this file. Every rule here exists because the failure it
 * prevents is worse than the advice it discards:
 *  - an unknown action id is DROPPED, not passed through — a button nobody can explain is worse
 *    than a missing one;
 *  - a table name the facts never mentioned is dropped from the finding, because the executable
 *    actions take table lists and a hallucinated name would be an operator's confusing 422;
 *  - forty findings are cut to eight, a three-page rationale to a paragraph;
 *  - malformed JSON yields an empty result rather than an exception, because "the advisor had
 *    nothing to say" is a state the UI already handles and a 500 is not.
 */
export function sanitiseAdvice(raw: string, knownTables: string[]): AdvisorResult {
  const known = new Set(knownTables);
  let parsed: unknown;
  try {
    // Models occasionally wrap JSON in prose or a fence even when asked not to. Take the outermost
    // object rather than failing on the wrapper.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    parsed = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object") return { summary: "", findings: [] };

  const record = parsed as Record<string, unknown>;
  const rawFindings = Array.isArray(record.findings) ? record.findings : [];

  const findings: AdvisorFinding[] = [];
  for (const entry of rawFindings) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const action = String(item.action ?? "") as AdvisorActionId;
    if (!ACTION_IDS.includes(action)) continue;

    const title = clamp(item.title, MAX_TITLE_CHARS);
    const rationale = clamp(item.rationale, MAX_RATIONALE_CHARS);
    if (!title || !rationale) continue;

    const severity = ["critical", "warning", "info"].includes(String(item.severity)) ? (item.severity as AdvisorFinding["severity"]) : "info";
    const confidence = ["high", "medium", "low"].includes(String(item.confidence)) ? (item.confidence as AdvisorFinding["confidence"]) : "low";
    const tables = Array.isArray(item.tables) ? item.tables.map((table) => String(table)).filter((table) => known.has(table)).slice(0, 20) : [];

    findings.push({ severity, title, rationale, action, tables, confidence });
    if (findings.length >= MAX_FINDINGS) break;
  }

  // Critical first, then warning, then info — the order an operator reads in.
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return { summary: clamp(record.summary, MAX_SUMMARY_CHARS), findings };
}

/* ------------------------------------------------------------------------------------------ */
/* Generating, and the human decision that follows                                             */
/* ------------------------------------------------------------------------------------------ */

export async function adviseWorkspace(orgId: string, actorLabel: string, trendDays = 30): Promise<{ id: string } & AdvisorResult & { model: string; factsDigest: AdvisorFacts }> {
  const row = await controlPrisma.platformAiSettings.upsert({ where: { id: SETTINGS_ID }, update: {}, create: { id: SETTINGS_ID } });
  if (!row.enabled) throw new AppError(409, "The advisor is switched off. Turn it on and give it a provider under Settings → AI advisor.");

  const used = await countToday();
  if (used >= row.dailyCallLimit) {
    throw new AppError(429, `The advisor's daily ceiling of ${row.dailyCallLimit} generations has been reached. It resets at midnight UTC, and the limit is editable in Settings.`);
  }

  const apiKey = row.encryptedApiKey ? decryptSecret(row.encryptedApiKey) : "";
  if (row.provider === "ANTHROPIC" && !apiKey) throw new AppError(409, "The advisor has no API key. Add one under Settings → AI advisor.");

  const [health, trend] = await Promise.all([getTenantHealth(orgId, trendDays), getTenantDbTrend(orgId, trendDays)]);
  const facts = buildAdvisorFacts({ health, trend, trendDays });
  const prompt = buildAdvisorPrompt(facts);

  const params = {
    feature: "platform_advisor",
    model: row.model,
    maxTokens: 1600,
    prompt,
    jsonSchema: RESPONSE_SCHEMA as unknown as { name: string; schema: Record<string, unknown> }
  };

  const result = row.provider === "ANTHROPIC" ? await callAnthropic(apiKey, params) : await callOpenAICompatible({ baseUrl: row.baseUrl }, apiKey, params);

  const knownTables = facts.database?.largestTables.map((table) => table.name) ?? [];
  const advice = sanitiseAdvice(result.text, [...knownTables, ...(facts.database?.tablesWithoutPrimaryKey ?? []), ...(facts.database?.indexHeavyTables ?? [])]);

  const record = await controlPrisma.platformAiAdvice.create({
    data: {
      organizationId: orgId,
      actorLabel,
      model: row.model,
      summary: advice.summary,
      findings: JSON.parse(JSON.stringify(advice.findings)),
      factsDigest: JSON.parse(JSON.stringify(facts)),
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens
    }
  });

  await platformAudit("PLATFORM_ADMIN", actorLabel, "platform_ai.advice_generated", "PlatformAiAdvice", record.id, {
    organizationId: orgId,
    findings: advice.findings.length,
    model: row.model
  });

  return { id: record.id, ...advice, model: row.model, factsDigest: facts };
}

export async function listAdvice(orgId: string, limit = 10) {
  return controlPrisma.platformAiAdvice.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: "desc" }, take: limit });
}

/**
 * The human half of the loop.
 *
 * A decision is required before an advisory leaves `PENDING`, and a dismissal takes a note. That
 * note is the most valuable row in the table: it is the only record of the advisor being WRONG,
 * and an advisor whose failures are not written down cannot be evaluated, only believed.
 */
export async function decideAdvice(input: { adviceId: string; status: "APPLIED" | "DISMISSED"; note: string | null; actorLabel: string }) {
  const advice = await controlPrisma.platformAiAdvice.findUnique({ where: { id: input.adviceId } });
  if (!advice) throw new AppError(404, "That advisory no longer exists.");
  if (input.status === "DISMISSED" && !input.note?.trim()) {
    throw new AppError(422, "Say why you are dismissing it — a dismissal without a reason teaches the next operator nothing.");
  }

  const updated = await controlPrisma.platformAiAdvice.update({
    where: { id: input.adviceId },
    data: { status: input.status, decidedAt: new Date(), decidedBy: input.actorLabel, decisionNote: input.note?.trim() || null }
  });
  await platformAudit("PLATFORM_ADMIN", input.actorLabel, `platform_ai.advice_${input.status.toLowerCase()}`, "PlatformAiAdvice", input.adviceId, {
    organizationId: advice.organizationId
  });
  return updated;
}
