/**
 * WHAT: filterable table over the tenant `AuditLog` (action/entity/actor), the admin-facing
 * view of everything `services/audit.service.ts#audit()` writes across the whole backend.
 * WHY it's just a filter UI and not much else: the log itself is append-only and already
 * structured (action/entity/entityId/metadata) — this page's job is presentation, not logic.
 * WHO calls the backing API: `controllers/audit.controller.ts` via `auditApi.list`.
 */
import { useQuery } from "@tanstack/react-query";
import { RotateCcw, Search, ShieldAlert, ShieldCheck, UserCog } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { auditApi } from "../services/api";

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
  const [search, setSearch] = useState("");

  const filterAction = action === "all" ? undefined : action;
  const filterEntity = entity === "all" ? undefined : entity;

  const { data, isLoading, isError } = useQuery({
    queryKey: ["audit", { action: filterAction, entity: filterEntity }],
    queryFn: () => auditApi.list({ action: filterAction, entity: filterEntity, take: 200 })
  });

  const rows = useMemo(() => {
    const list = data ?? [];
    if (!search) return list;
    const needle = search.toLowerCase();
    return list.filter((row) =>
      [row.action, row.entity, row.entityId, row.actor?.name, row.actor?.email]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle))
    );
  }, [data, search]);

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
          <Button variant="ghost" size="sm" onClick={() => { setAction("all"); setEntity("all"); setSearch(""); }}>
            <RotateCcw className="h-3.5 w-3.5" />Reset
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
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
            <div className="grid gap-1.5 md:col-span-2">
              <Label>Search actor or entityId</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="user name, email, entity id..." />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Entity ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`skel-${i}`}>
                  {Array.from({ length: 5 }).map((__, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))}
              {isError && (
                <TableRow><TableCell colSpan={5} className="py-10 text-center text-destructive">Unable to load audit log.</TableCell></TableRow>
              )}
              {!isLoading && !isError && rows.map((row) => {
                const Icon = actionIcon[row.action] ?? ShieldCheck;
                return (
                  <TableRow key={row.id} className="align-top">
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(row.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">{row.actor?.name ?? "System"}</p>
                      <p className="text-xs text-muted-foreground">{row.actor?.email ?? "—"}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant={variantFor(row.action)} className="gap-1">
                        <Icon className="h-3 w-3" /> {row.action}
                      </Badge>
                    </TableCell>
                    <TableCell>{row.entity}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{row.entityId ?? "—"}</TableCell>
                  </TableRow>
                );
              })}
              {!isLoading && !isError && rows.length === 0 && (
                <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">No audit entries match the filters.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
