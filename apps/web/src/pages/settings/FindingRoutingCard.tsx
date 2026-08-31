/**
 * WHAT: the two rule sets that decide where an ingested security finding belongs — a repository
 * pattern picks the PROJECT, a file-path pattern picks the MODULE (and optionally the submodule) —
 * plus a dry-run that answers "where would this path go?" without waiting for a scan.
 * WHY BOTH LIVE ON THE SECURITY & DEVOPS TAB, and specifically directly under "Auto-create tickets
 * from findings": that card's fallback project is literally the else-branch of the repository rules
 * below it, so the two have to be readable together or neither makes sense. The path rules follow
 * the repository rules for the same reason — they are the second half of one decision, they only
 * ever fire on a finding's `filePath`, and splitting them onto another tab would make the dry-run
 * (which needs a repository AND a path to say anything) impossible to present in one place.
 * WHY ITS OWN FILE rather than more of SecurityDevOpsSettingsCard.tsx: that file's own header sets
 * the rule — Workspace Settings is large, each settings domain gets a file. It is rendered inside
 * that card, so an admin still finds it exactly where the header above says.
 * WHO calls the backing API: `controllers/finding-routing.controller.ts`.
 *
 * ── WHY THE DRY-RUN IS NOT DECORATION ─────────────────────────────────────────────────────────
 *
 * These rules are FIRST MATCH WINS in `order` ascending — the same semantics ticket automation and
 * email routing already use. That means the answer depends on rules an admin is not looking at
 * while writing the one in front of them, and a rule set you cannot dry-run is a rule set people
 * get wrong silently: the only other feedback is a ticket that opened in the wrong project a week
 * later. The test panel runs the real resolver on the server and reports WHICH rule won, so an
 * overlapping rule with a lower order is visible rather than mysterious.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderTree, Play, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { toast } from "../../components/ui/toaster";
import { findingRoutingApi, projectApi } from "../../services/api";

/** The slice of a project this card needs. `projectApi.list` is untyped and already returns modules
 *  with their submodules (see the API's project.controller.ts), so this narrows rather than fetches. */
interface ProjectOption {
  id: string;
  name: string;
  modules: Array<{ id: string; name: string; submodules: Array<{ id: string; name: string }> }>;
}

/** Radix's Select has no concept of "no value" — an empty string throws — so the optional
 *  submodule picker needs a sentinel, the same `__off__`/`none` trick the cards around this one use. */
const NO_SUBMODULE = "__none__";

/** Shown under both rule lists. Written once because both lists take the SAME dialect from the same
 *  matcher: two explanations would eventually become two dialects. */
function PatternHelp({ example }: { example: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      <code>*</code> matches within one path segment, <code>**</code> matches across segments, a trailing <code>/</code> means "this
      and everything under it", and a pattern with no wildcard is a plain <strong>prefix</strong> — so <code>{example}</code> also
      matches anything starting with it. Matching is <strong>case-sensitive</strong>, like the file system your scanner reads.
    </p>
  );
}

export function FindingRoutingCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => projectApi.list() });
  const repositoryMaps = useQuery({ queryKey: ["finding-routing", "repository-maps"], queryFn: findingRoutingApi.repositoryMaps.list });
  const pathRules = useQuery({ queryKey: ["finding-routing", "module-path-rules"], queryFn: findingRoutingApi.modulePathRules.list });

  const projectOptions = (projects.data ?? []) as ProjectOption[];

  function invalidateRepositoryMaps() {
    queryClient.invalidateQueries({ queryKey: ["finding-routing", "repository-maps"] });
  }
  function invalidatePathRules() {
    queryClient.invalidateQueries({ queryKey: ["finding-routing", "module-path-rules"] });
  }
  /** Every mutation below reports the server's own message when there is one — the 422 for an
   *  unusable pattern names the limit it broke, and swallowing that would leave an admin guessing. */
  function failed(action: string) {
    return (err: any) => toast.error(action, { description: err?.response?.data?.message ?? "Try again." });
  }

  /* ---------- Repository → project ---------- */

  const [newRepo, setNewRepo] = useState({ pattern: "", projectId: "", order: "0" });
  const createRepositoryMap = useMutation({
    mutationFn: () =>
      findingRoutingApi.repositoryMaps.create({
        pattern: newRepo.pattern.trim(),
        projectId: newRepo.projectId,
        order: Number(newRepo.order) || 0
      }),
    onSuccess: () => {
      toast.success("Repository rule added");
      setNewRepo({ pattern: "", projectId: "", order: "0" });
      invalidateRepositoryMaps();
    },
    onError: failed("Could not add the rule")
  });
  const updateRepositoryMap = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<{ pattern: string; projectId: string; order: number; isActive: boolean }> }) =>
      findingRoutingApi.repositoryMaps.update(id, payload),
    onSuccess: invalidateRepositoryMaps,
    onError: failed("Could not update the rule")
  });
  const removeRepositoryMap = useMutation({
    mutationFn: (id: string) => findingRoutingApi.repositoryMaps.remove(id),
    onSuccess: invalidateRepositoryMaps,
    onError: failed("Could not remove the rule")
  });

  /* ---------- File path → module ---------- */

  const [newPath, setNewPath] = useState({ pattern: "", projectId: "", moduleId: "", submoduleId: NO_SUBMODULE, order: "0" });
  const newPathProject = projectOptions.find((p) => p.id === newPath.projectId);
  const newPathModule = newPathProject?.modules.find((m) => m.id === newPath.moduleId);

  const createPathRule = useMutation({
    mutationFn: () =>
      findingRoutingApi.modulePathRules.create({
        projectId: newPath.projectId,
        pattern: newPath.pattern.trim(),
        moduleId: newPath.moduleId,
        submoduleId: newPath.submoduleId === NO_SUBMODULE ? null : newPath.submoduleId,
        order: Number(newPath.order) || 0
      }),
    onSuccess: () => {
      toast.success("Path rule added");
      setNewPath({ pattern: "", projectId: "", moduleId: "", submoduleId: NO_SUBMODULE, order: "0" });
      invalidatePathRules();
    },
    onError: failed("Could not add the rule")
  });
  const updatePathRule = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<{ pattern: string; order: number; isActive: boolean }> }) =>
      findingRoutingApi.modulePathRules.update(id, payload),
    onSuccess: invalidatePathRules,
    onError: failed("Could not update the rule")
  });
  const removePathRule = useMutation({
    mutationFn: (id: string) => findingRoutingApi.modulePathRules.remove(id),
    onSuccess: invalidatePathRules,
    onError: failed("Could not remove the rule")
  });

  /* ---------- The dry-run ---------- */

  const [test, setTest] = useState({ repository: "", filePath: "" });
  const runTest = useMutation({
    mutationFn: () => findingRoutingApi.test({ repository: test.repository.trim(), filePath: test.filePath.trim() }),
    onError: failed("Could not run the test")
  });

  const loading = projects.isLoading || repositoryMaps.isLoading || pathRules.isLoading;

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FolderTree className="h-4 w-4 text-primary" />
            Route findings by repository
          </CardTitle>
          <CardDescription>
            Which project owns a repository. A finding arrives carrying a repository name from your scanner; the first active rule
            whose pattern matches it decides where its ticket opens — and the ticket then takes that project's own key prefix.
            Rules are evaluated in <strong>order</strong>, lowest first, and the <strong>first match wins</strong> — the same way
            ticket automation rules work. No match falls back to the project set above, exactly as it always has.{" "}
            <strong>These rules route CI-failure tickets too</strong>, matched against the repository named in the failed run's
            pull-request URL — a run without one falls back like anything else.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {loading && <Skeleton className="h-24 w-full" />}
          {!loading && (
            <>
              {!readOnly && (
                <div className="grid gap-2 sm:grid-cols-[5rem_1fr_1fr_auto] sm:items-end">
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Order</Label>
                    <Input type="number" min={0} value={newRepo.order} onChange={(e) => setNewRepo({ ...newRepo, order: e.target.value })} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Repository pattern</Label>
                    <Input
                      className="font-mono text-xs"
                      value={newRepo.pattern}
                      onChange={(e) => setNewRepo({ ...newRepo, pattern: e.target.value })}
                      placeholder="acme/web-*"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Project</Label>
                    <Select value={newRepo.projectId} onValueChange={(v) => setNewRepo({ ...newRepo, projectId: v })}>
                      <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>
                        {projectOptions.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    size="sm"
                    disabled={!newRepo.pattern.trim() || !newRepo.projectId || createRepositoryMap.isPending}
                    onClick={() => createRepositoryMap.mutate()}
                  >
                    <Plus className="h-3.5 w-3.5" />Add
                  </Button>
                </div>
              )}

              <PatternHelp example="acme/web" />

              {(repositoryMaps.data ?? []).length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  No repository rules yet — every finding lands in the fallback project above.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-24">Order</TableHead>
                        <TableHead>Repository pattern</TableHead>
                        <TableHead>Project</TableHead>
                        <TableHead className="w-24">Active</TableHead>
                        <TableHead className="w-16" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(repositoryMaps.data ?? []).map((rule) => (
                        <TableRow key={rule.id}>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              className="h-8 w-20"
                              defaultValue={rule.order}
                              disabled={readOnly}
                              // Saved on blur rather than on every keystroke: `order` is the whole
                              // rule set's meaning, and a PATCH per digit typed would reorder the
                              // list under the admin's cursor.
                              onBlur={(e) => {
                                const order = Number(e.target.value);
                                if (Number.isFinite(order) && order !== rule.order) updateRepositoryMap.mutate({ id: rule.id, payload: { order } });
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              className="h-8 font-mono text-xs"
                              defaultValue={rule.pattern}
                              disabled={readOnly}
                              onBlur={(e) => {
                                const pattern = e.target.value.trim();
                                if (pattern && pattern !== rule.pattern) updateRepositoryMap.mutate({ id: rule.id, payload: { pattern } });
                              }}
                            />
                          </TableCell>
                          <TableCell className="text-sm">{rule.project.name}</TableCell>
                          <TableCell>
                            <Switch
                              checked={rule.isActive}
                              disabled={readOnly}
                              onCheckedChange={(isActive) => updateRepositoryMap.mutate({ id: rule.id, payload: { isActive } })}
                            />
                          </TableCell>
                          <TableCell>
                            {!readOnly && (
                              <Button size="sm" variant="ghost" onClick={() => removeRepositoryMap.mutate(rule.id)}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FolderTree className="h-4 w-4 text-primary" />
            Route findings by file path
          </CardTitle>
          <CardDescription>
            Which module of that project owns a path. Only the rules belonging to the project the repository step resolved are
            considered, so <code>src/api/**</code> can mean different things in two products. First match by order wins. The module's
            own assignee rule (Workspace Settings → Email intake) then decides who the ticket goes to; with no match it falls through
            to CODEOWNERS, exactly as before.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {loading && <Skeleton className="h-24 w-full" />}
          {!loading && (
            <>
              {!readOnly && (
                <div className="grid gap-2 sm:grid-cols-[5rem_1fr_1fr_1fr_1fr_auto] sm:items-end">
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Order</Label>
                    <Input type="number" min={0} value={newPath.order} onChange={(e) => setNewPath({ ...newPath, order: e.target.value })} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Path pattern</Label>
                    <Input
                      className="font-mono text-xs"
                      value={newPath.pattern}
                      onChange={(e) => setNewPath({ ...newPath, pattern: e.target.value })}
                      placeholder="apps/api/src/services/billing-*"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Project</Label>
                    <Select
                      value={newPath.projectId}
                      onValueChange={(v) => setNewPath({ ...newPath, projectId: v, moduleId: "", submoduleId: NO_SUBMODULE })}
                    >
                      <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>
                        {projectOptions.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">Module</Label>
                    <Select
                      value={newPath.moduleId}
                      onValueChange={(v) => setNewPath({ ...newPath, moduleId: v, submoduleId: NO_SUBMODULE })}
                      disabled={!newPathProject}
                    >
                      <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                      <SelectContent>
                        {(newPathProject?.modules ?? []).map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">
                      Submodule <span className="text-muted-foreground">(optional)</span>
                    </Label>
                    <Select
                      value={newPath.submoduleId}
                      onValueChange={(v) => setNewPath({ ...newPath, submoduleId: v })}
                      disabled={!newPathModule || newPathModule.submodules.length === 0}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_SUBMODULE}>Module only</SelectItem>
                        {(newPathModule?.submodules ?? []).map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    size="sm"
                    disabled={!newPath.pattern.trim() || !newPath.projectId || !newPath.moduleId || createPathRule.isPending}
                    onClick={() => createPathRule.mutate()}
                  >
                    <Plus className="h-3.5 w-3.5" />Add
                  </Button>
                </div>
              )}

              <PatternHelp example="apps/api/src/services/billing-" />

              {(pathRules.data ?? []).length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  No path rules yet — findings are stored without a module, and auto-created tickets fall through to CODEOWNERS for
                  their assignee.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-24">Order</TableHead>
                        <TableHead>Path pattern</TableHead>
                        <TableHead>Project</TableHead>
                        <TableHead>Routes to</TableHead>
                        <TableHead className="w-24">Active</TableHead>
                        <TableHead className="w-16" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(pathRules.data ?? []).map((rule) => (
                        <TableRow key={rule.id}>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              className="h-8 w-20"
                              defaultValue={rule.order}
                              disabled={readOnly}
                              onBlur={(e) => {
                                const order = Number(e.target.value);
                                if (Number.isFinite(order) && order !== rule.order) updatePathRule.mutate({ id: rule.id, payload: { order } });
                              }}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              className="h-8 font-mono text-xs"
                              defaultValue={rule.pattern}
                              disabled={readOnly}
                              onBlur={(e) => {
                                const pattern = e.target.value.trim();
                                if (pattern && pattern !== rule.pattern) updatePathRule.mutate({ id: rule.id, payload: { pattern } });
                              }}
                            />
                          </TableCell>
                          <TableCell className="text-sm">{rule.project.name}</TableCell>
                          <TableCell className="text-sm">
                            {rule.module.name}
                            {rule.submodule && <span className="text-muted-foreground"> › {rule.submodule.name}</span>}
                          </TableCell>
                          <TableCell>
                            <Switch
                              checked={rule.isActive}
                              disabled={readOnly}
                              onCheckedChange={(isActive) => updatePathRule.mutate({ id: rule.id, payload: { isActive } })}
                            />
                          </TableCell>
                          <TableCell>
                            {!readOnly && (
                              <Button size="sm" variant="ghost" onClick={() => removePathRule.mutate(rule.id)}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Play className="h-4 w-4 text-primary" />
            Test a path
          </CardTitle>
          <CardDescription>
            First-match-wins rules depend on rules you are not looking at. Type a repository and a file path and see exactly where a
            finding would land — and which rule decided it — instead of finding out from a ticket that opened in the wrong place next
            week. This runs the same resolver the ingestion does; it changes nothing.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label className="text-xs">Repository</Label>
              <Input
                className="font-mono text-xs"
                value={test.repository}
                onChange={(e) => setTest({ ...test, repository: e.target.value })}
                placeholder="acme/web-app"
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">File path</Label>
              <Input
                className="font-mono text-xs"
                value={test.filePath}
                onChange={(e) => setTest({ ...test, filePath: e.target.value })}
                placeholder="apps/api/src/services/billing-rate.service.ts"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={(!test.repository.trim() && !test.filePath.trim()) || runTest.isPending}
              onClick={() => runTest.mutate()}
            >
              <Play className="h-3.5 w-3.5" />
              {runTest.isPending ? "Testing…" : "Test"}
            </Button>
          </div>

          {runTest.data && (
            <Alert>
              <AlertTitle className="flex items-center gap-2 text-sm">
                {runTest.data.project ? (
                  <>
                    <span>
                      {runTest.data.project.name}
                      {runTest.data.module ? ` › ${runTest.data.module.name}` : ""}
                      {runTest.data.submodule ? ` › ${runTest.data.submodule.name}` : ""}
                    </span>
                    {runTest.data.usedFallbackProject && <Badge variant="muted">fallback project</Badge>}
                    {!runTest.data.module && <Badge variant="muted">no module</Badge>}
                  </>
                ) : (
                  <>
                    <X className="h-4 w-4" />
                    Nowhere — no repository rule matched and no fallback project is set.
                  </>
                )}
              </AlertTitle>
              <AlertDescription className="text-xs">
                {/* Naming the winning rule ids is the point of the panel: with several overlapping
                    patterns, "which one won" is the only question worth answering. */}
                {runTest.data.matchedRepositoryMapId
                  ? `Matched repository rule ${runTest.data.matchedRepositoryMapId}.`
                  : "No repository rule matched."}{" "}
                {runTest.data.matchedModulePathRuleId
                  ? `Matched path rule ${runTest.data.matchedModulePathRuleId}.`
                  : "No path rule matched — the finding would be stored without a module."}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
