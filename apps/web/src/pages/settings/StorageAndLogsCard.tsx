/**
 * WHAT: the "Storage & logs" tab in Workspace Settings — where uploaded files and rotating log
 * files are actually going on this server right now, whether each directory is writable, and a
 * validator that dry-runs a candidate path before an operator commits to it.
 *
 * WHY IT IS READ-ONLY (this is the interesting design decision, not an omission):
 * the paths are process-wide but SUPER_ADMIN is a per-tenant role, and this deployment runs a
 * database per organization behind one Node process — a super admin of org A persisting a
 * storage root would silently redirect org B's uploads. Beyond tenancy, a text box that sets an
 * absolute path the server then writes to is arbitrary file write scoped to the service account,
 * and the /uploads static mounts turn parts of it into arbitrary file read; validation catches
 * mistakes, not intent (`/etc/cron.d` is absolute, existing and writable). So the values live in
 * .env, and this card gives the two things an admin genuinely needs and cannot get from a config
 * file: the LIVE resolved paths with real writability, and a way to test a new path before a
 * restart. The full reasoning is on the `/settings/storage` route in
 * api/src/controllers/settings.controller.ts.
 *
 * WHO renders this: WorkspaceSettings.tsx's "Storage & logs" tab.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileArchive, FolderOpen, HardDrive, Image as ImageIcon, ScanFace, ScrollText, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Skeleton } from "../../components/ui/skeleton";
import type { DirectoryProbe } from "../../services/api";
import { settingsApi } from "../../services/api";

/** One resolved subtree: what it holds, where it is, and whether it works. `envVar` names the
 *  variable that pins it, or is null when the path is derived from the root. */
function DirectoryRow({
  icon,
  title,
  purpose,
  probe,
  envVar
}: {
  icon: ReactNode;
  title: string;
  purpose: string;
  probe: DirectoryProbe;
  envVar: string | null;
}) {
  const healthy = probe.exists && probe.writable;
  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">{icon}</span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{title}</span>
            <span className="block text-xs text-muted-foreground">{purpose}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {envVar && <Badge variant="outline" className="font-mono text-[10px]">{envVar}</Badge>}
          <Badge variant={healthy ? "success" : "destructive"}>
            {healthy ? "Writable" : probe.exists ? "Not writable" : "Missing"}
          </Badge>
        </div>
      </div>
      {/* Selectable and wrapping: the single most common action here is copying this path into a
          backup job or an RDP session, and a truncated path can't be copied. */}
      <p className="mt-3 select-all break-all rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs">{probe.path}</p>
      {probe.problem && <p className="mt-2 text-xs text-destructive">{probe.problem}</p>}
    </div>
  );
}

export function StorageAndLogsCard() {
  const status = useQuery({ queryKey: ["settings", "storage"], queryFn: settingsApi.getStorage });
  const [candidate, setCandidate] = useState("");

  const check = useMutation({
    mutationFn: () => settingsApi.validateStorageDirectory(candidate.trim()),
    // No toast: the verdict belongs next to the box it was typed into, where it can be read
    // twice and compared against the path, not in something that fades after four seconds.
    onError: () => undefined
  });

  if (status.isLoading) return <Skeleton className="h-96 w-full" />;
  if (!status.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4 text-primary" /> Storage & logs
          </CardTitle>
          <CardDescription>Couldn't read the server's storage configuration.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { storage, logging } = status.data;
  const verdict = check.data;

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="h-4 w-4 text-primary" /> File storage
          </CardTitle>
          <CardDescription>
            Where this API instance is writing uploaded files right now, probed live. Set{" "}
            <code className="font-mono text-xs">STORAGE_ROOT</code> in <code className="font-mono text-xs">.env</code> to move all
            three onto their own volume — keeping uploads outside the application directory is what stops a redeploy or{" "}
            <code className="font-mono text-xs">git checkout</code> from destroying them.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <DirectoryRow
            icon={<FolderOpen className="h-4 w-4" />}
            title="Storage root"
            purpose="The volume the three subtrees below hang off."
            probe={storage.root}
            envVar={storage.configuredBy.root}
          />
          <DirectoryRow
            icon={<FileArchive className="h-4 w-4" />}
            title="Documents"
            purpose="Ticket and timesheet attachments, and files arriving by email intake."
            probe={storage.documents}
            envVar={storage.configuredBy.documents}
          />
          <DirectoryRow
            icon={<ImageIcon className="h-4 w-4" />}
            title="Avatars"
            purpose="Profile pictures, one directory per user."
            probe={storage.avatars}
            envVar={storage.configuredBy.avatars}
          />
          <DirectoryRow
            icon={<ScanFace className="h-4 w-4" />}
            title="Face (biometric) images"
            purpose="Enrollment and verification captures, per org and user. Never served publicly; purged on its own retention schedule."
            probe={storage.face}
            envVar={storage.configuredBy.face}
          />

          {storage.documentFallbacks.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Documents were relocated. Reads still fall back to{" "}
              {storage.documentFallbacks.map((dir) => (
                <code key={dir} className="mx-1 break-all font-mono">
                  {dir}
                </code>
              ))}
              so nothing uploaded before the move is lost — copy that tree across when convenient.
            </p>
          )}

          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <p>
              <span className="font-medium">Changing a path affects NEW files only.</span> Existing files are never moved or
              deleted, and rows in the database keep pointing at where they already are. To complete a move, stop the API, copy
              the old directory across, then restart.
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-lg border p-3 text-xs text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <p>
              These paths are set in <code className="font-mono">.env</code> and cannot be edited here on purpose. They apply to
              the whole server, not just this workspace, and a field that points the application at any absolute directory would
              be a filesystem-level capability handed to a workspace-level role. Use the checker below, then edit{" "}
              <code className="font-mono">.env</code> and restart the API.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 className="h-4 w-4 text-primary" /> Check a directory
          </CardTitle>
          <CardDescription>
            Runs the exact checks the server runs at startup — absolute, no <code className="font-mono text-xs">..</code>,
            exists, and genuinely writable by the service account (a real write, not a permission flag). Nothing is saved or
            changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="storage-candidate">Candidate path</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="storage-candidate"
                className="min-w-64 flex-1 font-mono"
                placeholder="C:\TimeSphere_Uploads"
                value={candidate}
                onChange={(event) => setCandidate(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && candidate.trim()) check.mutate();
                }}
              />
              <Button onClick={() => check.mutate()} disabled={!candidate.trim() || check.isPending}>
                {check.isPending ? "Checking…" : "Check"}
              </Button>
            </div>
          </div>

          {verdict && (
            <div
              className={`flex items-start gap-2 rounded-lg border p-3 text-xs ${
                verdict.ok ? "border-success/40 bg-success/5" : "border-destructive/40 bg-destructive/5"
              }`}
            >
              {verdict.ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              )}
              <div className="min-w-0">
                {verdict.ok ? (
                  <>
                    <p className="font-medium">This directory will work.</p>
                    <p className="mt-1 break-all font-mono">{verdict.path}</p>
                    <p className="mt-2">
                      Add <code className="select-all font-mono">STORAGE_ROOT={verdict.path}</code> (or{" "}
                      <code className="select-all font-mono">LOG_DIR={verdict.path}</code>) to <code className="font-mono">.env</code>{" "}
                      and restart the API.
                    </p>
                  </>
                ) : (
                  <p>{verdict.message}</p>
                )}
              </div>
            </div>
          )}
          {check.isError && (
            <p className="text-xs text-destructive">Couldn't reach the server to run the check. Try again.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <ScrollText className="h-4 w-4 text-primary" /> Rotating file logs
            </CardTitle>
            <Badge variant={logging.enabled ? "success" : logging.degraded ? "destructive" : "outline"}>
              {logging.enabled ? "Writing to disk" : logging.degraded ? "Degraded — console only" : "Console only"}
            </Badge>
          </div>
          <CardDescription>
            Everything the server prints is always written to the console. When{" "}
            <code className="font-mono text-xs">LOG_DIR</code> is set it is additionally mirrored into rotating files.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!logging.directory && (
            <p className="text-sm text-muted-foreground">
              File logging is off. Set <code className="font-mono text-xs">LOG_DIR</code> to an absolute directory (e.g.{" "}
              <code className="font-mono text-xs">C:\TimeSphere_Logs</code>) in <code className="font-mono text-xs">.env</code> and
              restart to turn it on.
            </p>
          )}

          {logging.degraded && logging.degradedReason && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
              <p>
                File logging stopped and the server continued on console output alone — {logging.degradedReason}. Fix the
                directory and restart to resume writing files.
              </p>
            </div>
          )}

          {logging.directory && (
            <>
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <Fact label="Log directory" value={logging.directory} mono />
                <Fact label="Rotates every" value={`${logging.rotateHours} hour${logging.rotateHours === 1 ? "" : "s"}`} />
                <Fact label="Retention" value={`${logging.retentionDays} days`} />
                <Fact label="Compress previous days" value={logging.compressOnRollover ? "Yes (gzip)" : "No"} />
              </dl>
              <div>
                <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {logging.currentFile ? "Currently writing to" : "Next file"}
                </p>
                <p className="select-all break-all rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs">
                  {logging.currentFile ?? logging.namingExample}
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                One directory per calendar date, with {logging.rotateHours}-hour files inside it. At midnight the previous day's
                files are gzipped, then day-directories older than {logging.retentionDays} days are deleted.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={`mt-0.5 break-all text-sm font-medium ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
