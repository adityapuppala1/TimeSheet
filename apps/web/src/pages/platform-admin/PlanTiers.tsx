/**
 * WHAT: the platform-admin console's plan-tier configuration screen — everything
 * `services/plan-limits.service.ts` reads as a tier DEFAULT: seat limit, AI budget ceiling, the
 * SSO and chat allow-lists, ten boolean capabilities and seven quotas.
 *
 * WHY IT IS GENERATED RATHER THAN HAND-LISTED: this screen used to render four knobs and one
 * feature checkbox while the platform enforced twenty-one entitlements. The gap was structural,
 * not an oversight anyone could see — the PATCH body schema was `.strict()` and had never been
 * widened either, so the fifteen missing ones returned 400 even if a client sent them. V6's
 * planning layer, V8's goals and change management and 3.5.0's practice update were all
 * reachable only through a database migration.
 *
 * The form now renders from `PLAN_CAPABILITIES` / `PLAN_QUOTAS` in `platform-admin-api.ts`, so
 * adding an entitlement to that list is what puts it on this page. A per-field `useState` is
 * exactly the shape that stopped anyone adding the sixteenth.
 *
 * WHY IT IS A COMPARISON MATRIX (3.12.x): the previous layout was three independent long forms
 * side by side. Every fact a reader wants here is a COMPARISON — "does Team get proofing, and how
 * many dashboards more than Starter?" — and three separate forms answer it only by eye, across
 * 600px of scroll, with the same ten hint paragraphs repeated three times. The entitlements now
 * come from one `ENTITLEMENT_GROUPS` list and render as a matrix: one row per entitlement, one
 * column per tier, the label and hint written ONCE per row. Rows cannot drift out of alignment
 * because a row IS one row, and the hint cannot push one tier's controls below another's because
 * no tier owns it. Each column still saves on its own, exactly as before.
 *
 * WHY THERE ARE TWO LAYOUTS: a four-column matrix needs ~900px to stay legible, so below `xl` it
 * is replaced by one card per tier (the same rows, the same order, the same controls, generated
 * from the same list) rather than by a matrix that has to be scrolled sideways to be edited on a
 * phone. Both read from ONE draft per tier held here, so an edit survives a resize across the
 * breakpoint instead of being stranded in whichever copy was visible when it was typed.
 *
 * SCOPE, unchanged: an individual org can still override seat limit and AI budget on its own
 * record (see `Organizations.tsx`); everything else here is tier-only, with no per-org override.
 *
 * WHO calls the backing API: `controllers/platform-admin.controller.ts`'s plan-tier-limits
 * routes, via `platformAdminPlanTierApi`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { BACKUP_FREQUENCY_LABEL, UNLIMITED_PLAN_ITEMS, type BackupFrequency } from "@timesheet/shared";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
/* The same marks the tenant app uses, so a platform admin ticking "Slack" here sees the mark the
   workspace admin will see when they configure it. */
import { CHAT_PLATFORM_MARKS, SSO_PROVIDER_MARKS, type Mark } from "../../components/ui/connector-marks";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { cn } from "../../lib/utils";
import { ConsolePage, ConsoleSection, ConsoleTable, EmptyState, Field, FieldGrid, Num, PRIMARY_BTN, Toolbar } from "./console-ui";
import { PLAN_CAPABILITIES, PLAN_QUOTAS, platformAdminBillingApi, platformAdminPlanTierApi, type ChatPlatform, type PlanCapabilityKey, type PlanQuotaKey, type PlanTierLimitRow, type SsoProvider } from "../../services/platform-admin-api";

type PlanTier = PlanTierLimitRow["tier"];

const TIER_LABEL: Record<PlanTier, string> = { STARTER: "Starter", TEAM: "Team", ENTERPRISE: "Enterprise" };
const ALL_PROVIDERS: SsoProvider[] = ["GOOGLE", "MICROSOFT", "SAML", "LDAP"];
const PROVIDER_LABEL: Record<SsoProvider, string> = { GOOGLE: "Google", MICROSOFT: "Microsoft / Azure AD", SAML: "SAML", LDAP: "LDAP / Active Directory" };
const ALL_CHAT_PLATFORMS: ChatPlatform[] = ["SLACK", "MICROSOFT_TEAMS", "GOOGLE_CHAT", "TELEGRAM"];
const CHAT_PLATFORM_LABEL: Record<ChatPlatform, string> = {
  SLACK: "Slack",
  MICROSOFT_TEAMS: "Microsoft Teams",
  GOOGLE_CHAT: "Google Chat",
  TELEGRAM: "Telegram"
};

/* ------------------------------------------------------------------------------------------- */
/* One tier's unsaved edits                                                                     */
/* ------------------------------------------------------------------------------------------- */

/** Numbers are held as strings because they are held by `<input type="number">`; an empty box has
 *  to survive being empty while it is being retyped, and `Number("")` is 0. */
type TierDraft = {
  seatLimit: string;
  budget: string;
  providers: SsoProvider[];
  chatPlatforms: ChatPlatform[];
  capabilities: Record<PlanCapabilityKey, boolean>;
  quotas: Record<PlanQuotaKey, string>;
  backupFrequency: BackupFrequency;
  maxBackupDestinations: string;
  backupPitrEnabled: boolean;
};

const draftFromRow = (row: PlanTierLimitRow): TierDraft => ({
  seatLimit: row.seatLimit.toString(),
  budget: row.aiMonthlyBudgetCeilingUsd,
  providers: row.allowedSsoProviders,
  chatPlatforms: row.allowedChatPlatforms,
  capabilities: Object.fromEntries(PLAN_CAPABILITIES.map((c) => [c.key, row[c.key]])) as Record<PlanCapabilityKey, boolean>,
  quotas: Object.fromEntries(PLAN_QUOTAS.map((q) => [q.key, String(row[q.key] ?? 0)])) as Record<PlanQuotaKey, string>,
  backupFrequency: row.backupFrequency ?? "NONE",
  maxBackupDestinations: String(row.maxBackupDestinations ?? 0),
  backupPitrEnabled: row.backupPitrEnabled ?? false
});

const payloadFromDraft = (draft: TierDraft) => ({
  seatLimit: Number(draft.seatLimit),
  aiMonthlyBudgetCeilingUsd: Number(draft.budget),
  allowedSsoProviders: draft.providers,
  allowedChatPlatforms: draft.chatPlatforms,
  ...draft.capabilities,
  ...(Object.fromEntries(PLAN_QUOTAS.map((q) => [q.key, Number(draft.quotas[q.key]) || 0])) as Record<PlanQuotaKey, number>),
  backupFrequency: draft.backupFrequency,
  maxBackupDestinations: Number(draft.maxBackupDestinations) || 0,
  backupPitrEnabled: draft.backupPitrEnabled
});

/* ------------------------------------------------------------------------------------------- */
/* The shared row list both layouts render                                                      */
/* ------------------------------------------------------------------------------------------- */

/**
 * A row is a label plus a lens onto the draft, never a piece of JSX. That is what lets the matrix
 * and the stacked cards render THE SAME rows in THE SAME order without either one being able to
 * grow a control the other does not have.
 */
type NumberRow = {
  kind: "number";
  id: string;
  label: string;
  hint?: string;
  min?: number;
  max?: number;
  get: (draft: TierDraft) => string;
  set: (draft: TierDraft, value: string) => TierDraft;
};
type ToggleRow = {
  kind: "toggle";
  id: string;
  label: string;
  hint?: string;
  icon?: Mark;
  get: (draft: TierDraft) => boolean;
  set: (draft: TierDraft, value: boolean) => TierDraft;
};
/**
 * A row whose value is one of a fixed set rather than a number or a tick. Added for the backup
 * cadence, which is neither: "weekly" is not a quantity, and rendering it as a checkbox would lose
 * the difference between hourly, daily and weekly — the whole point of the entitlement.
 */
type SelectRow = {
  kind: "select";
  id: string;
  label: string;
  hint?: string;
  options: Array<{ value: string; label: string }>;
  get: (draft: TierDraft) => string;
  set: (draft: TierDraft, value: string) => TierDraft;
};
type EntitlementRow = NumberRow | ToggleRow | SelectRow;
type EntitlementGroup = { id: string; title: string; note?: ReactNode; rows: EntitlementRow[] };

/** How every control writes back: name the tier, hand over a pure draft transform. */
type TierEdit = (tier: PlanTier, next: (draft: TierDraft) => TierDraft) => void;

const isNumberRow = (row: EntitlementRow): row is NumberRow => row.kind === "number";
const isToggleRow = (row: EntitlementRow): row is ToggleRow => row.kind === "toggle";
const isSelectRow = (row: EntitlementRow): row is SelectRow => row.kind === "select";

const FREQUENCY_OPTIONS = (["NONE", "WEEKLY", "DAILY", "HOURLY"] as BackupFrequency[]).map((value) => ({ value, label: BACKUP_FREQUENCY_LABEL[value] }));

const BACKUP_GROUP: EntitlementGroup = {
  id: "backups",
  title: "Managed backups",
  note: (
    <>
      The cadence is a <strong className="text-foreground">ceiling</strong>, not a setting: a workspace picks its own schedule under
      Platform → Backups and the scheduler clamps it to the tier on every tick, so a downgrade takes effect without anybody editing a
      policy. The pre-deletion snapshot the retention programme takes is separate and applies on every plan, including Starter.
    </>
  ),
  rows: [
    {
      kind: "select",
      id: "backupFrequency",
      label: "Automatic backups",
      hint: "The most frequent schedule this tier may ask for. “No automatic backups” switches the module off for the tier entirely.",
      options: FREQUENCY_OPTIONS,
      get: (d) => d.backupFrequency,
      set: (d, v) => ({ ...d, backupFrequency: v as BackupFrequency })
    },
    {
      kind: "number",
      id: "maxBackupDestinations",
      label: "Backup destinations",
      hint: "How many places this tier may write to at once — a primary bucket plus an off-site copy is two.",
      min: 0,
      max: 50,
      get: (d) => d.maxBackupDestinations,
      set: (d, v) => ({ ...d, maxBackupDestinations: v })
    },
    {
      kind: "toggle",
      id: "backupPitrEnabled",
      label: "Test restores & point-in-time recovery",
      hint: "The expensive half — a test restore materialises a whole database to prove the dump reads back.",
      get: (d) => d.backupPitrEnabled,
      set: (d, v) => ({ ...d, backupPitrEnabled: v })
    }
  ]
};

const ENTITLEMENT_GROUPS: EntitlementGroup[] = [
  {
    id: "limits",
    title: "Plan limits",
    rows: [
      { kind: "number", id: "seatLimit", label: "Seat limit", get: (d) => d.seatLimit, set: (d, v) => ({ ...d, seatLimit: v }) },
      { kind: "number", id: "aiBudget", label: "AI budget ceiling ($/mo)", get: (d) => d.budget, set: (d, v) => ({ ...d, budget: v }) }
    ]
  },
  {
    id: "sso",
    title: "Allowed SSO providers",
    rows: ALL_PROVIDERS.map((provider) => ({
      kind: "toggle" as const,
      id: `sso-${provider}`,
      label: PROVIDER_LABEL[provider],
      icon: SSO_PROVIDER_MARKS[provider],
      get: (d: TierDraft) => d.providers.includes(provider),
      set: (d: TierDraft, v: boolean): TierDraft => ({ ...d, providers: v ? [...d.providers, provider] : d.providers.filter((p) => p !== provider) })
    }))
  },
  {
    id: "chat",
    title: "Allowed chat platforms",
    rows: ALL_CHAT_PLATFORMS.map((platform) => ({
      kind: "toggle" as const,
      id: `chat-${platform}`,
      label: CHAT_PLATFORM_LABEL[platform],
      icon: CHAT_PLATFORM_MARKS[platform],
      get: (d: TierDraft) => d.chatPlatforms.includes(platform),
      set: (d: TierDraft, v: boolean): TierDraft => ({ ...d, chatPlatforms: v ? [...d.chatPlatforms, platform] : d.chatPlatforms.filter((p) => p !== platform) })
    }))
  },
  {
    id: "features",
    title: "Features",
    note: (
      <>
        Every capability here <strong className="text-muted-foreground">fails closed</strong> except face verification's enforcement leg, which fails open on
        purpose — a lapsed plan must stop demanding identity checks, never lock a workforce out of logging their own time. Unchecking face verification also
        starts each affected org's 30-day biometric-data purge grace window.
      </>
    ),
    rows: PLAN_CAPABILITIES.map((capability) => ({
      kind: "toggle" as const,
      id: capability.key,
      label: capability.label,
      hint: capability.hint,
      get: (d: TierDraft) => d.capabilities[capability.key],
      set: (d: TierDraft, v: boolean): TierDraft => ({ ...d, capabilities: { ...d.capabilities, [capability.key]: v } })
    }))
  },
  {
    id: "quotas",
    title: "Quotas",
    note: (
      <>
        <strong className="text-muted-foreground">0</strong> means the tier cannot use that resource at all — it is a real ceiling, not "unlimited".{" "}
        {UNLIMITED_PLAN_ITEMS.toLocaleString()} is the sentinel for no limit.
      </>
    ),
    rows: PLAN_QUOTAS.map((quota) => ({
      kind: "number" as const,
      id: quota.key,
      label: quota.label,
      min: 0,
      max: UNLIMITED_PLAN_ITEMS,
      get: (d: TierDraft) => d.quotas[quota.key],
      set: (d: TierDraft, v: string): TierDraft => ({ ...d, quotas: { ...d.quotas, [quota.key]: v } })
    }))
  }
,
  BACKUP_GROUP
];

/* ------------------------------------------------------------------------------------------- */
/* Page                                                                                         */
/* ------------------------------------------------------------------------------------------- */

export function PlatformAdminPlanTiers() {
  const queryClient = useQueryClient();
  const limits = useQuery({ queryKey: ["platform-admin", "plan-tier-limits"], queryFn: platformAdminPlanTierApi.list });

  // One draft per tier, held here rather than inside a per-tier card, because the matrix needs all
  // three at once and because the two layouts must share a draft — see the file header.
  const [drafts, setDrafts] = useState<Record<string, TierDraft>>({});
  useEffect(() => {
    // Re-sync when the list changes under us (another admin saved, or the query refetched). Same
    // trade the per-card version made: a refetch wins over unsaved edits.
    if (!limits.data) return;
    setDrafts(Object.fromEntries(limits.data.map((row) => [row.tier, draftFromRow(row)])));
  }, [limits.data]);

  const save = useMutation({
    mutationFn: (row: PlanTierLimitRow) => platformAdminPlanTierApi.update(row.tier, payloadFromDraft(drafts[row.tier] ?? draftFromRow(row))),
    onSuccess: () => {
      toast.success("Saved");
      queryClient.invalidateQueries({ queryKey: ["platform-admin", "plan-tier-limits"] });
    },
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });
  const savingTier = save.isPending ? (save.variables?.tier ?? null) : null;

  const editRow = (tier: PlanTier, next: (draft: TierDraft) => TierDraft) =>
    setDrafts((prev) => (prev[tier] ? { ...prev, [tier]: next(prev[tier]) } : prev));

  const tiers = limits.data ?? [];
  const ready = tiers.filter((row) => drafts[row.tier]);

  return (
    <ConsolePage
      eyebrow="Tenants"
      title="Plan tiers"
      description="Every entitlement the platform enforces, per tier — seats, AI budget, the SSO and chat allow-lists, ten capabilities and seven quotas. Seat limit and AI budget can be overridden per organization on its own record; everything else here is tier-only."
    >
      <StripeBillingCard />

      {limits.isLoading && <Skeleton className="h-64 w-full" />}
      {!limits.isLoading && tiers.length === 0 && (
        <ConsoleSection title="Entitlements by tier">
          <EmptyState title="No plan tiers" description="The platform returned no tier rows, so there is nothing to configure yet." />
        </ConsoleSection>
      )}

      {ready.length > 0 && (
        <>
          <TierMatrix rows={ready} drafts={drafts} onEdit={editRow} onSave={(row) => save.mutate(row)} savingTier={savingTier} />
          {/* Below `xl` the matrix is too narrow to edit, so the same rows become one card per
              tier. Only one of the two is ever in the layout (and in the a11y tree) at a time. */}
          <div className="grid grid-cols-1 gap-6 xl:hidden">
            {ready.map((row) => (
              <TierCard key={row.tier} row={row} draft={drafts[row.tier]} onEdit={editRow} onSave={() => save.mutate(row)} saving={savingTier === row.tier} />
            ))}
          </div>
        </>
      )}
    </ConsolePage>
  );
}

/* ------------------------------------------------------------------------------------------- */
/* xl+ : the comparison matrix                                                                  */
/* ------------------------------------------------------------------------------------------- */

/** The label column of one matrix row: the mark (SSO/chat only), the entitlement, and the hint
 *  written once for all three tiers. The hint is clamped with the full text on hover so one long
 *  sentence cannot turn a scannable matrix into a wall of prose. */
function RowLabel({ row }: { row: EntitlementRow }) {
  const Icon = isToggleRow(row) ? row.icon : undefined;
  return (
    <span className="flex items-start gap-2">
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0" />}
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{row.label}</span>
        {row.hint && (
          <span className="line-clamp-2 text-xs leading-snug text-muted-foreground" title={row.hint}>
            {row.hint}
          </span>
        )}
      </span>
    </span>
  );
}

function TierMatrix({
  rows,
  drafts,
  onEdit,
  onSave,
  savingTier
}: {
  rows: PlanTierLimitRow[];
  drafts: Record<string, TierDraft>;
  onEdit: TierEdit;
  onSave: (row: PlanTierLimitRow) => void;
  savingTier: PlanTier | null;
}) {
  const span = rows.length + 1;
  return (
    <ConsoleSection
      className="hidden xl:block"
      flush
      title="Entitlements by tier"
      description="One row per entitlement, one column per tier — read across to compare, edit in place. Each column saves on its own."
    >
      <ConsoleTable minWidth={940} className="rounded-none border-x-0 border-b-0">
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40%]">Entitlement</TableHead>
            {rows.map((row) => (
              <TableHead key={row.tier} className="w-[20%] text-right">
                <span className="inline-flex items-center gap-2">
                  {TIER_LABEL[row.tier]}
                  {row.tier === "ENTERPRISE" && <Badge variant="info">Highest</Badge>}
                </span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {ENTITLEMENT_GROUPS.map((group) => (
            <Fragment key={group.id}>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableCell colSpan={span} className="py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.title}
                </TableCell>
              </TableRow>
              {group.rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="align-top">
                    <RowLabel row={row} />
                  </TableCell>
                  {rows.map((tierRow) => (
                    <MatrixCell key={tierRow.tier} row={row} tier={tierRow.tier} draft={drafts[tierRow.tier]} onEdit={onEdit} />
                  ))}
                </TableRow>
              ))}
              {group.note && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={span} className="pt-0 text-xs leading-relaxed text-muted-foreground">
                    {group.note}
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow className="hover:bg-transparent">
            <TableCell className="text-xs font-normal text-muted-foreground">Defaults applied to every organization on that tier.</TableCell>
            {rows.map((tierRow) => (
              <TableCell key={tierRow.tier} className="text-right">
                <Button
                  size="sm"
                  className={PRIMARY_BTN}
                  aria-label={`Save ${TIER_LABEL[tierRow.tier]} tier`}
                  disabled={savingTier === tierRow.tier}
                  onClick={() => onSave(tierRow)}
                >
                  Save
                </Button>
              </TableCell>
            ))}
          </TableRow>
        </TableFooter>
      </ConsoleTable>
    </ConsoleSection>
  );
}

function MatrixCell({ row, tier, draft, onEdit }: { row: EntitlementRow; tier: PlanTier; draft: TierDraft; onEdit: TierEdit }) {
  const tierLabel = TIER_LABEL[tier];
  if (isSelectRow(row)) {
    return (
      <TableCell className="align-top">
        <Select value={row.get(draft)} onValueChange={(v) => onEdit(tier, (d) => row.set(d, v))}>
          <SelectTrigger className="h-9" aria-label={`${row.label} — ${tierLabel}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {row.options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
    );
  }
  if (isNumberRow(row)) {
    return (
      <Num className="align-top">
        <Input
          type="number"
          min={row.min}
          max={row.max}
          aria-label={`${row.label} — ${tierLabel}`}
          value={row.get(draft)}
          onChange={(e) => onEdit(tier, (d) => row.set(d, e.target.value))}
          className="h-9 border-border bg-background text-right font-mono tabular-nums text-foreground"
        />
      </Num>
    );
  }
  return (
    /* `TableCell` drops its right padding when it contains a `[role=checkbox]` — the shadcn
       select-column convention — which would shove the box against the card edge. The inner
       `pr-3` puts it back, so a tick lines up with the right edge of the number inputs above it. */
    <TableCell className="align-top">
      <span className="flex justify-end pr-3">
        <Checkbox
          className="mt-0.5"
          aria-label={`${row.label} — ${tierLabel}`}
          checked={row.get(draft)}
          onCheckedChange={(checked) => onEdit(tier, (d) => row.set(d, Boolean(checked)))}
        />
      </span>
    </TableCell>
  );
}

/* ------------------------------------------------------------------------------------------- */
/* < xl : one card per tier, same rows                                                          */
/* ------------------------------------------------------------------------------------------- */

function TierCard({
  row,
  draft,
  onEdit,
  onSave,
  saving
}: {
  row: PlanTierLimitRow;
  draft: TierDraft;
  onEdit: TierEdit;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <ConsoleSection
      bodyClassName="grid gap-6"
      title={
        <span className="flex items-center gap-2">
          {TIER_LABEL[row.tier]}
          {row.tier === "ENTERPRISE" && <Badge variant="info">Highest</Badge>}
        </span>
      }
      description="Defaults applied to every organization on this tier."
    >
      {ENTITLEMENT_GROUPS.map((group) => {
        const numbers = group.rows.filter(isNumberRow);
        const toggles = group.rows.filter(isToggleRow);
        const selects = group.rows.filter(isSelectRow);
        // Ticks with a hint get a column to themselves; the bare allow-lists pair up at `sm+`.
        const hinted = toggles.some((toggle) => toggle.hint);
        return (
          <div key={group.id} className="grid gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.title}</h3>
            {(numbers.length > 0 || selects.length > 0) && (
              <FieldGrid cols={2}>
                {selects.map((selectRow) => (
                  <Field key={selectRow.id} label={selectRow.label} hint={selectRow.hint}>
                    <Select value={selectRow.get(draft)} onValueChange={(v) => onEdit(row.tier, (d) => selectRow.set(d, v))}>
                      <SelectTrigger aria-label={`${selectRow.label} — ${TIER_LABEL[row.tier]}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {selectRow.options.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ))}
                {numbers.map((numberRow) => (
                  <CardNumberField key={numberRow.id} row={numberRow} tier={row.tier} draft={draft} onEdit={onEdit} />
                ))}
              </FieldGrid>
            )}
            {toggles.length > 0 && (
              <div className={cn("grid grid-cols-1 gap-2.5", !hinted && "sm:grid-cols-2")}>
                {toggles.map((toggleRow) => (
                  <CardToggle key={toggleRow.id} row={toggleRow} tier={row.tier} draft={draft} onEdit={onEdit} />
                ))}
              </div>
            )}
            {group.note && <p className="text-xs leading-relaxed text-muted-foreground">{group.note}</p>}
          </div>
        );
      })}
      {/* Same place on every card, and the same place as the matrix's footer row. */}
      <div className="flex justify-end border-t border-border pt-4">
        <Button size="sm" className={PRIMARY_BTN} aria-label={`Save ${TIER_LABEL[row.tier]} tier`} disabled={saving} onClick={onSave}>
          Save
        </Button>
      </div>
    </ConsoleSection>
  );
}

/** One editable quota/limit inside a tier card. A component rather than an inline `.map` body so
 *  the write-back closure is one level deep instead of four. */
function CardNumberField({ row, tier, draft, onEdit }: { row: NumberRow; tier: PlanTier; draft: TierDraft; onEdit: TierEdit }) {
  const id = `${tier}-${row.id}`;
  return (
    <Field label={row.label} htmlFor={id}>
      <Input
        id={id}
        type="number"
        min={row.min}
        max={row.max}
        value={row.get(draft)}
        onChange={(e) => onEdit(tier, (d) => row.set(d, e.target.value))}
        className="border-border bg-background text-right font-mono tabular-nums text-foreground"
      />
    </Field>
  );
}

/** One capability/allow-list tick inside a tier card. The hint is clamped with the full sentence
 *  on hover: a card is narrower than a matrix row, and three-line hints turn ten ticks into prose. */
function CardToggle({ row, tier, draft, onEdit }: { row: ToggleRow; tier: PlanTier; draft: TierDraft; onEdit: TierEdit }) {
  const Icon = row.icon;
  return (
    <label className="flex min-w-0 items-start gap-2 text-sm text-foreground">
      <Checkbox className="mt-0.5" checked={row.get(draft)} onCheckedChange={(checked) => onEdit(tier, (d) => row.set(d, Boolean(checked)))} />
      {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0" />}
      <span className="min-w-0">
        {row.label}
        {row.hint && (
          <span className="line-clamp-2 text-xs leading-snug text-muted-foreground" title={row.hint}>
            {row.hint}
          </span>
        )}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------------------------------- */
/* Stripe                                                                                       */
/* ------------------------------------------------------------------------------------------- */

/** Platform-wide Stripe configuration — one merchant-of-record account across every org (see
 *  billing.controller.ts's header comment). Secret key/webhook signing secret are masked
 *  write-only fields, same convention as every other credential in this app. */
function StripeBillingCard() {
  const queryClient = useQueryClient();
  const billing = useQuery({ queryKey: ["platform-admin", "billing-settings"], queryFn: platformAdminBillingApi.get });
  const [secretKey, setSecretKey] = useState("");
  const [webhookSigningSecret, setWebhookSigningSecret] = useState("");
  const [priceIdTeam, setPriceIdTeam] = useState("");
  const [priceIdEnterprise, setPriceIdEnterprise] = useState("");

  useEffect(() => {
    if (billing.data) {
      setPriceIdTeam(billing.data.priceIdTeam ?? "");
      setPriceIdEnterprise(billing.data.priceIdEnterprise ?? "");
    }
  }, [billing.data]);

  const save = useMutation({
    mutationFn: () =>
      platformAdminBillingApi.update({
        ...(secretKey ? { secretKey } : {}),
        ...(webhookSigningSecret ? { webhookSigningSecret } : {}),
        priceIdTeam: priceIdTeam || null,
        priceIdEnterprise: priceIdEnterprise || null
      }),
    onSuccess: () => {
      setSecretKey("");
      setWebhookSigningSecret("");
      queryClient.invalidateQueries({ queryKey: ["platform-admin", "billing-settings"] });
      toast.success("Billing settings saved");
    },
    onError: () => toast.error("Could not save", { description: "Try again." })
  });

  return (
    <ConsoleSection
      title="Stripe billing"
      description={
        <>
          One Stripe account across every org on this deployment — orgs never bring their own key. Create a Restricted API Key (Checkout Sessions + Customers +
          Subscriptions, write) and a webhook endpoint pointed at <code className="text-xs">/api/billing/webhook</code>, then paste both here alongside the two
          Price IDs created for the Team and Enterprise tiers.
        </>
      }
      actions={
        billing.data && (
          <Toolbar>
            <Badge variant={billing.data.secretKeySet ? "success" : "muted"}>{billing.data.secretKeySet ? "Secret key set" : "No secret key"}</Badge>
            <Badge variant={billing.data.webhookSigningSecretSet ? "success" : "muted"}>
              {billing.data.webhookSigningSecretSet ? "Webhook secret set" : "No webhook secret"}
            </Badge>
          </Toolbar>
        )
      }
      bodyClassName="grid gap-4"
    >
      {billing.isLoading && <Skeleton className="h-32 w-full" />}
      {!billing.isLoading && billing.data && (
        <>
          <FieldGrid cols={2}>
            <Field label="Secret key" htmlFor="stripe-secret-key" hint="Write-only — the stored key is never sent back to this page.">
              <Input
                id="stripe-secret-key"
                type="password"
                placeholder="sk_live_..."
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                className="border-border bg-background text-foreground"
              />
            </Field>
            <Field label="Webhook signing secret" htmlFor="stripe-webhook-secret" hint="Write-only — leave blank to keep the current one.">
              <Input
                id="stripe-webhook-secret"
                type="password"
                placeholder="whsec_..."
                value={webhookSigningSecret}
                onChange={(e) => setWebhookSigningSecret(e.target.value)}
                className="border-border bg-background text-foreground"
              />
            </Field>
            <Field label="Team tier Price ID" htmlFor="stripe-price-team">
              <Input
                id="stripe-price-team"
                placeholder="price_..."
                value={priceIdTeam}
                onChange={(e) => setPriceIdTeam(e.target.value)}
                className="border-border bg-background text-foreground"
              />
            </Field>
            <Field label="Enterprise tier Price ID" htmlFor="stripe-price-enterprise">
              <Input
                id="stripe-price-enterprise"
                placeholder="price_..."
                value={priceIdEnterprise}
                onChange={(e) => setPriceIdEnterprise(e.target.value)}
                className="border-border bg-background text-foreground"
              />
            </Field>
          </FieldGrid>
          <div className="flex justify-end border-t border-border pt-4">
            <Button size="sm" className={PRIMARY_BTN} onClick={() => save.mutate()} disabled={save.isPending}>
              Save
            </Button>
          </div>
        </>
      )}
    </ConsoleSection>
  );
}
