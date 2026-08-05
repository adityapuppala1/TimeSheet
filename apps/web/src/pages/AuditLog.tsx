/**
 * WHAT: filterable table over the tenant `AuditLog` (action/entity/actor), the admin-facing
 * view of everything `services/audit.service.ts#audit()` writes across the whole backend.
 * WHY it's just a filter UI and not much else: the log itself is append-only and already
 * structured (action/entity/entityId/metadata) — this page's job is presentation, not logic.
 * WHO calls the backing API: `controllers/audit.controller.ts` via `auditApi.list`.
 */
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { RotateCcw, ShieldAlert, ShieldCheck, UserCog } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { DataTable } from "../components/ui/data-table";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { auditApi, type AuditEntry } from "../services/api";

const actionIcon: Record<string, typeof ShieldCheck> = {
  "timesheet.approved": ShieldCheck,
  "timesheet.rejected": ShieldAlert,
  "user.created": UserCog,
  "user.updated": UserCog,
  "user.deleted": UserCog,
  "user.password_reset": UserCog
};

export function AuditLog() {
  const [action, setAction] = useState("all");
  const [entity, setEntity] = useState("all");

  const filterAction = action === "all" ? undefined : action;
  const filterEntity = entity === "all" ? undefined : entity;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["audit", { action: filterAction, entity: filterEntity }],
    queryFn: () => auditApi.list({ action: filterAction, entity: filterEntity, take: 200 })
  });

  const rows = data ?? [];

  const knownActions = useMemo(() => {
    const set = new Set<string>();
    (data ?? []).forEach((row) => set.add(row.action));
    return Array.from(set).sort();
  }, [data]);

  const knownEntities = useMemo(() => {
    const set = new Set<string>();
    (data ?? []).forEach((row) => set.add(row.entity));
    return Array.from(set).sort();
  }, [data]);

  function variantFor(action: string): "success" | "destructive" | "info" | "muted" {
    if (action.endsWith(".approved")) return "success";
    if (action.endsWith(".rejected") || action.endsWith(".deleted")) return "destructive";
    if (action.startsWith("user.") || action.startsWith("timesheet.")) return "info";
    return "muted";
  }

  const auditColumns = useMemo<ColumnDef<AuditEntry, any>[]>(
    () => [
      {
        id: "when",
        accessorFn: (row) => row.createdAt,
        header: "When",
        cell: ({ row }) => <span className="whitespace-nowrap text-xs text-muted-foreground">{new Date(row.original.createdAt).toLocaleString()}</span>
      },
      {
        id: "actor",
        accessorFn: (row) => row.actor?.name ?? "System",
        header: "Actor",
        cell: ({ row }) => (
          <div>
            <p className="font-medium">{row.original.actor?.name ?? "System"}</p>
            <p className="text-xs text-muted-foreground">{row.original.actor?.email ?? "—"}</p>
          </div>
        )
      },
      {
        accessorKey: "action",
        header: "Action",
        cell: ({ row }) => {
          const Icon = actionIcon[row.original.action] ?? ShieldCheck;
          return (
            <Badge variant={variantFor(row.original.action)} className="gap-1">
              <Icon className="h-3 w-3" /> {row.original.action}
            </Badge>
          );
        }
      },
      { accessorKey: "entity", header: "Entity" },
      {
        id: "entityId",
        accessorFn: (row) => row.entityId ?? "",
        header: "Entity ID",
        cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.entityId ?? "—"}</span>
      }
    ],
    []
  );

  return (
    <div className="grid gap-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tamper-evident trail of administrative and approval actions across the workspace.
        </p>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => { setAction("all"); setEntity("all"); }}>
            <RotateCcw className="h-3.5 w-3.5" />Reset
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Action</Label>
              <Select value={action} onValueChange={setAction}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All actions</SelectItem>
                  {knownActions.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Entity</Label>
              <Select value={entity} onValueChange={setEntity}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All entities</SelectItem>
                  {knownEntities.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          {isError ? (
            <p className="py-10 text-center text-destructive">Unable to load audit log.</p>
          ) : (
            <DataTable
              columns={auditColumns}
              data={rows}
              isLoading={isLoading}
              searchPlaceholder="Search actor, entity, entity ID..."
              emptyMessage="No audit entries match the filters."
              pageSize={20}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
