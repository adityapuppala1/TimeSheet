/**
 * The snapshots the retention programme takes before it drops a workspace — what exists, how big,
 * whose it was, and the three things an operator can do with one: download it, restore it, delete
 * it.
 *
 * WHY THIS PAGE EXISTS. 3.12.0 shipped the snapshot and nothing else: the file was written and then
 * nobody could see it, get it back to a customer who changed their mind, or restore it. A backup
 * you cannot list or restore is not a backup, it is a file.
 *
 * WHAT THE PAGE HAS TO BE HONEST ABOUT, because all three facts change what an operator should do:
 *  - whether a snapshot directory is configured at all (no directory = no snapshots are being
 *    taken, and the deletions still happen);
 *  - whether `mysqldump` and `mysql` actually exist on the API host — the snapshot is best-effort
 *    and a missing binary is recorded rather than fatal, so a directory can be empty for a reason
 *    that has nothing to do with the policy;
 *  - whether a given file can be restored, which is not a property of the file but of its
 *    workspace: a restore refuses if the organisation still has a database, because overwriting a
 *    live tenant is the one mistake nobody recovers from.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, CalendarClock, CheckCircle2, Database, Download, HardDrive, RotateCcw, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { platformAdminConsoleApi, type SnapshotFile } from "../../services/platform-admin-api";
import { BackupSchedulesTab } from "./BackupSchedules";
import { ConsolePage, ConsoleSection, ConsoleTable, EmptyState, Field, formatBytes, KpiCard, KpiGrid, Num, PRIMARY_BTN, shortDateTime } from "./console-ui";

const errorMessageOf = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message;

function ToolBadge({ ok, name, path }: { ok: boolean; name: string; path: string }) {
  return (
    <Badge variant={ok ? "success" : "warning"} className="gap-1.5" title={path}>
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {name} {ok ? "available" : "missing"}
    </Badge>
  );
}

function RestoreDialog({ file, onClose }: { file: SnapshotFile | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [confirmSlug, setConfirmSlug] = useState("");
  const restore = useMutation({
    mutationFn: () => platformAdminConsoleApi.restoreBackup(file!.id, file!.organizationId!, confirmSlug),
    onSuccess: (r) => {
      toast.success(`${r.slug} restored`, { description: `Database ${r.databaseName} recreated. The workspace is ${r.status} with its deletion held.` });
      setConfirmSlug("");
      onClose();
      void queryClient.invalidateQueries({ queryKey: ["platform-admin"] });
    },
    onError: (e) => toast.error("Not restored", { description: errorMessageOf(e) })
  });

  if (!file) return null;
  const slug = file.slug ?? "";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore {file.organizationName ?? slug}</DialogTitle>
          <DialogDescription>
            Recreates the workspace's database from this snapshot ({formatBytes(file.bytes)}, taken {shortDateTime(file.modifiedAt)}) and reopens the workspace in its
            grace state — reachable, billing open, nothing else. It does <strong>not</strong> sign anyone in, restore a plan, or take a payment, and the deletion is put
            on hold so the daily pass cannot remove what you have just restored.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
            A restore is refused if this workspace already has a database — overwriting a live tenant is not reachable from here.
          </p>
          <Field label={<>Type <span className="font-mono text-foreground">{slug}</span> to confirm</>} htmlFor="restore-confirm">
            <Input id="restore-confirm" value={confirmSlug} onChange={(e) => setConfirmSlug(e.target.value)} placeholder={slug} autoComplete="off" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button className={PRIMARY_BTN} disabled={confirmSlug.trim().toLowerCase() !== slug || restore.isPending} onClick={() => restore.mutate()}>
            {restore.isPending ? "Restoring…" : "Restore workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ file, onClose }: { file: SnapshotFile | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => platformAdminConsoleApi.deleteBackup(file!.id),
    onSuccess: () => {
      toast.success("Snapshot deleted");
      onClose();
      void queryClient.invalidateQueries({ queryKey: ["platform-admin", "backups"] });
    },
    onError: (e) => toast.error("Not deleted", { description: errorMessageOf(e) })
  });
  if (!file) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />Delete this snapshot
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono">{file.id}</span> ({formatBytes(file.bytes)}) is removed from disk. If its workspace has already been deleted, this is the last
            copy of that customer's data — there is no undo.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? "Deleting…" : "Delete permanently"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PlatformAdminBackups() {
  const backups = useQuery({ queryKey: ["platform-admin", "backups"], queryFn: platformAdminConsoleApi.backups });
  const [restoring, setRestoring] = useState<SnapshotFile | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  /** Fetch with the bearer token, then hand the bytes to the browser as a save. */
  const download = async (file: SnapshotFile) => {
    setDownloading(file.id);
    try {
      const blob = await platformAdminConsoleApi.downloadBackup(file.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.id;
      anchor.click();
      // Revoked on the next tick, not immediately: Safari has not started reading the blob when
      // click() returns, and revoking synchronously gives it an empty file.
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (error) {
      toast.error("Could not download", { description: errorMessageOf(error) });
    } finally {
      setDownloading(null);
    }
  };
  const [deleting, setDeleting] = useState<SnapshotFile | null>(null);
  const d = backups.data;
  const restorable = d?.files.filter((f) => f.restorable).length ?? 0;

  return (
    <ConsolePage
      eyebrow="Platform"
      title="Backups"
      description="Scheduled backups for every workspace — where they go, how long they are kept, and whether they came back — plus the one-off snapshots the retention programme takes before it deletes a workspace."
    >
      <Tabs defaultValue="scheduled" className="grid min-w-0 grid-cols-1 gap-4">
        <TabsList className="w-fit max-w-full overflow-x-auto">
          <TabsTrigger value="scheduled" className="gap-1.5">
            <CalendarClock className="h-3.5 w-3.5" />Scheduled backups
          </TabsTrigger>
          <TabsTrigger value="snapshots" className="gap-1.5">
            <Archive className="h-3.5 w-3.5" />Pre-deletion snapshots
          </TabsTrigger>
        </TabsList>

        <TabsContent value="scheduled" className="mt-0 min-w-0">
          <BackupSchedulesTab />
        </TabsContent>

        <TabsContent value="snapshots" className="mt-0 grid min-w-0 gap-6">
      {backups.isLoading && <Skeleton className="h-64 w-full" />}

      {d && !d.configured && (
        <ConsoleSection title="No snapshot directory configured">
          <EmptyState
            icon={HardDrive}
            title="Snapshots are switched off"
            description={
              <>
                {d.problem} Until one is set, a workspace deleted under the retention policy leaves nothing behind — the deletion still happens, there is simply no copy
                of it.
              </>
            }
          />
        </ConsoleSection>
      )}

      {d?.configured && (
        <>
          <KpiGrid>
            <KpiCard label="Snapshots" value={d.files.length} icon={Archive} tone="accent" hint={d.directory ?? undefined} />
            <KpiCard label="On disk" value={d.totalBytes} icon={HardDrive} format={(n) => formatBytes(n)} delay={0.05} />
            <KpiCard label="Restorable" value={restorable} icon={RotateCcw} tone={restorable > 0 ? "success" : "default"} hint="Their workspace exists and has no database" delay={0.1} />
          </KpiGrid>

          <ConsoleSection
            title="On this host"
            description={
              <>
                Written to <span className="font-mono text-foreground">{d.directory}</span> by the retention worker. Snapshots are best-effort: a missing binary is
                recorded and never blocks the deletion it was meant to precede.
              </>
            }
            actions={
              <span className="flex flex-wrap gap-1.5">
                <ToolBadge ok={d.tools.mysqldump} name="mysqldump" path={d.tools.mysqldumpPath} />
                <ToolBadge ok={d.tools.mysql} name="mysql" path={d.tools.mysqlPath} />
              </span>
            }
            flush
          >
            {d.problem && <p className="px-4 py-3 text-sm text-warning sm:px-5">{d.problem}</p>}
            {!d.problem && d.files.length === 0 && (
              <div className="p-4 sm:p-5">
                <EmptyState
                  icon={Database}
                  title="No snapshots yet"
                  description="One is written each time the retention programme deletes a workspace. Nothing has been deleted under the policy on this deployment."
                />
              </div>
            )}
            {d.files.length > 0 && (
              <ConsoleTable minWidth={860} className="rounded-none border-x-0 border-b-0">
                <TableHeader>
                  <TableRow>
                    <TableHead>Snapshot</TableHead>
                    <TableHead>Workspace</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead className="text-right">Taken</TableHead>
                    <TableHead>Restorable</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.files.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell className="max-w-[20rem]">
                        <span className="block truncate font-mono text-xs text-foreground" title={f.id}>
                          {f.id}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[14rem]">
                        {f.organizationName ? (
                          <>
                            <span className="block truncate font-medium text-foreground">{f.organizationName}</span>
                            <span className="block truncate font-mono text-[11px] text-muted-foreground">{f.slug}</span>
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">{f.slug ? `${f.slug} — no longer registered` : "Not written by the retention worker"}</span>
                        )}
                      </TableCell>
                      <Num>{formatBytes(f.bytes)}</Num>
                      <Num className="text-muted-foreground">{shortDateTime(f.modifiedAt)}</Num>
                      <TableCell>
                        {f.restorable ? (
                          <Badge variant="success">Yes</Badge>
                        ) : (
                          <Badge variant="muted" title={f.organizationId ? "That workspace still has a database — restoring would overwrite live data." : "No organization with that slug exists any more."}>
                            No
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {/* A fetch, never an <a href>: the route needs the console's in-memory
                              bearer token, and a plain link would silently download a 401 page
                              named like a backup — the worst kind of failure, one that looks like
                              it worked. */}
                          <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={downloading === f.id} onClick={() => void download(f)}>
                            <Download className="h-3.5 w-3.5" />
                            <span className="sr-only sm:not-sr-only">{downloading === f.id ? "Preparing…" : "Download"}</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1.5"
                            disabled={!f.restorable || !d.tools.mysql}
                            title={!d.tools.mysql ? `${d.tools.mysqlPath} is not on this host — a restore cannot import the dump.` : undefined}
                            onClick={() => setRestoring(f)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            <span className="sr-only sm:not-sr-only">Restore</span>
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground hover:text-destructive" onClick={() => setDeleting(f)} aria-label={`Delete ${f.id}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </ConsoleTable>
            )}
          </ConsoleSection>

          <ConsoleSection title="What this is, and what it is not">
            <ul className="grid gap-2 text-sm text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">These are retention snapshots, not platform backups.</span> One is written immediately before the
                retention programme drops a workspace's database, so the set only ever covers customers who lapsed and were deleted.
              </li>
              <li>
                <span className="font-medium text-foreground">Live workspaces are your database's job.</span> A per-tenant dump loop from inside the app would compete
                with the real backup for I/O and be worse at it — see <span className="font-mono text-foreground">docs/NEW_ORGANIZATION_SETUP.md § 7</span>.
              </li>
              <li>
                <span className="font-medium text-foreground">A restore rebuilds the schema as it was.</span> The dump carries the tables the workspace had on the day
                it was deleted, so run <span className="font-mono text-foreground">npm run db:migrate:tenants</span> afterwards if the platform has moved on since.
              </li>
              <li>
                <span className="font-medium text-foreground">Nothing prunes this directory.</span> Snapshots are kept until you delete them, deliberately — an
                automatic sweep of the last copy of a customer's data is not a default anybody should get.
              </li>
            </ul>
          </ConsoleSection>
        </>
      )}

          <RestoreDialog file={restoring} onClose={() => setRestoring(null)} />
          <DeleteDialog file={deleting} onClose={() => setDeleting(null)} />
        </TabsContent>
      </Tabs>
    </ConsolePage>
  );
}
