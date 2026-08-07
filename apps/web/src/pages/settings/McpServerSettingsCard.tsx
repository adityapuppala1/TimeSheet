/**
 * WHAT: the "MCP server" tab in Workspace Settings — turn TimeSphere's Model Context Protocol
 * endpoint on, choose which tools an external AI client may call, and issue/revoke the bearer
 * credentials it authenticates with.
 * WHY split into its own file: same reasoning as PublicApiSettingsCard.tsx's header — each
 * settings domain gets its own file rather than growing WorkspaceSettings.tsx.
 * WHY the warnings are this prominent: the thing on the other end of this connection is a language
 * model, and a large share of the text it will read (ticket titles, descriptions, comments) is
 * written by people outside this workspace, because email and chat intake turn strangers' messages
 * into tickets. An admin switching on a write tool is accepting that an instruction hidden in one
 * of those messages could reach it. That trade-off has to be visible at the moment of the click,
 * not buried in documentation.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, Eye, KeyRound, Plug, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Switch } from "../../components/ui/switch";
import { toast } from "../../components/ui/toaster";
import { SERVER_ORIGIN, settingsApi, userApi, type McpToolRow } from "../../services/api";
import { copyText } from "../../lib/clipboard";

function CopyableSecret({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          copyText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

function ToolRow({
  tool,
  readOnly,
  writesAllowed,
  onToggle
}: {
  tool: McpToolRow;
  readOnly: boolean;
  writesAllowed: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  // A write tool while the workspace is read-only can't be switched on from here: flipping it
  // would look like it took effect while the server still refused every call. Turn writes on
  // first — one decision at a time, in the order that makes the second one meaningful.
  const blockedByReadOnly = tool.mutating && !writesAllowed;
  const checked = tool.override ?? tool.defaultEnabled;

  return (
    <div className="flex items-start gap-3 rounded-md border border-border px-3 py-2.5">
      <Switch
        id={`mcp-tool-${tool.name}`}
        checked={checked}
        disabled={readOnly || blockedByReadOnly}
        onCheckedChange={onToggle}
      />
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Label htmlFor={`mcp-tool-${tool.name}`} className={readOnly || blockedByReadOnly ? "" : "cursor-pointer"}>
            <code className="text-xs font-semibold">{tool.name}</code>
          </Label>
          {tool.mutating ? <Badge variant="warning">Writes</Badge> : <Badge variant="muted">Read-only</Badge>}
          {tool.destructive && (
            <Badge variant="destructive">
              <ShieldAlert className="mr-1 h-3 w-3" />
              Hard to undo
            </Badge>
          )}
          {tool.untrustedContent && (
            <Badge variant="muted" title="Results can contain text written by people outside this workspace">
              <Eye className="mr-1 h-3 w-3" />
              External text
            </Badge>
          )}
          {tool.permission && <code className="text-[11px] text-muted-foreground">needs {tool.permission}</code>}
        </div>
        <p className="text-xs text-muted-foreground">{tool.description}</p>
        {blockedByReadOnly && (
          <p className="text-xs text-warning">Turn on "Allow write tools" above before enabling this.</p>
        )}
      </div>
    </div>
  );
}

export function McpServerSettingsCard({ readOnly }: { readOnly: boolean }) {
  const queryClient = useQueryClient();
  const mcp = useQuery({ queryKey: ["settings", "mcp"], queryFn: settingsApi.getMcp });
  // Only rendered inside the credential form, but the list is small and already cached by the
  // Users page in most sessions.
  const users = useQuery({ queryKey: ["users", "list"], queryFn: userApi.list });

  const [newName, setNewName] = useState("");
  const [newUserId, setNewUserId] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: settingsApi.updateMcp,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings", "mcp"] }),
    onError: (err: any) => toast.error("Could not save", { description: err?.response?.data?.message ?? "Try again." })
  });
  const createCredential = useMutation({
    mutationFn: () => settingsApi.createMcpCredential({ name: newName.trim(), userId: newUserId }),
    onSuccess: (created) => {
      setRevealedToken(created.token);
      setNewName("");
      setNewUserId("");
      queryClient.invalidateQueries({ queryKey: ["settings", "mcp"] });
    },
    onError: (err: any) =>
      toast.error("Could not create credential", { description: err?.response?.data?.message ?? "Try again." })
  });
  const revokeCredential = useMutation({
    mutationFn: (id: string) => settingsApi.revokeMcpCredential(id),
    onSuccess: () => {
      toast.success("Credential revoked");
      queryClient.invalidateQueries({ queryKey: ["settings", "mcp"] });
    },
    onError: () => toast.error("Could not revoke", { description: "Try again." })
  });

  const settings = mcp.data;
  const connectionUrl = `${SERVER_ORIGIN || window.location.origin}/api/mcp`;
  const readTools = (settings?.tools ?? []).filter((t) => !t.mutating);
  const writeTools = (settings?.tools ?? []).filter((t) => t.mutating);
  const activeUsers = (users.data ?? []).filter((u) => u.status === "ACTIVE");

  const toggleTool = (tool: McpToolRow, enabled: boolean) => {
    // Sent as a full map, not a single key: the server replaces `toolOverrides` wholesale, so a
    // partial patch would silently clear every other tool's choice.
    const overrides: Record<string, boolean> = {};
    for (const t of settings?.tools ?? []) overrides[t.name] = t.override ?? t.defaultEnabled;
    overrides[tool.name] = enabled;
    update.mutate({ toolOverrides: overrides });
  };

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plug className="h-4 w-4 text-primary" />
            MCP server
          </CardTitle>
          <CardDescription>
            Lets an external AI client — Claude Desktop, Claude Code, the Anthropic MCP connector, a
            managed agent — read and act on this workspace over the Model Context Protocol. Every
            call runs as the specific person its credential was issued to and is refused anything
            that person could not do in the app. Off by default.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {mcp.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <>
              <div className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <p className="text-xs text-muted-foreground">
                  <span className="font-semibold text-warning">Read this before enabling a write tool.</span> Tickets in
                  this workspace can be created from inbound email and chat messages, so their titles, descriptions and
                  comments may be written by people outside your organisation. An AI client reads that text. Instructions
                  hidden inside it can try to make the model call a tool. Keep the server read-only unless you have a
                  reason not to, and enable write tools one at a time.
                </p>
              </div>

              <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
                <Switch
                  id="mcp-enabled"
                  checked={settings?.enabled ?? false}
                  disabled={readOnly || update.isPending}
                  onCheckedChange={(enabled) => update.mutate({ enabled })}
                />
                <div className="grid gap-0.5">
                  <Label htmlFor="mcp-enabled" className={readOnly ? "" : "cursor-pointer"}>
                    Enable the MCP endpoint
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    While this is off, the endpoint refuses every caller — including a valid credential.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5">
                <Switch
                  id="mcp-writes"
                  checked={settings?.allowWrites ?? false}
                  disabled={readOnly || update.isPending}
                  onCheckedChange={(allowWrites) => update.mutate({ allowWrites })}
                />
                <div className="grid gap-0.5">
                  <Label htmlFor="mcp-writes" className={readOnly ? "" : "cursor-pointer"}>
                    Allow write tools
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    The one switch that stops an AI client changing anything. While off, no write tool is offered or
                    accepted, whatever the individual toggles below say.
                  </p>
                </div>
              </div>

              <div className="grid gap-1.5">
                <Label>Connection URL</Label>
                <CopyableSecret value={connectionUrl} />
                <p className="text-xs text-muted-foreground">
                  Paste this into your client as an HTTP (streamable) MCP server, with a credential below as the bearer
                  token.
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {!mcp.isLoading && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tools</CardTitle>
            <CardDescription>
              Each tool is offered to the client only if it is on here AND the acting user holds the permission it
              names. Read tools are on by default; write tools are not, and a write tool added by a future release
              arrives switched off.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Read</p>
              {readTools.map((tool) => (
                <ToolRow
                  key={tool.name}
                  tool={tool}
                  readOnly={readOnly}
                  writesAllowed={settings?.allowWrites ?? false}
                  onToggle={(enabled) => toggleTool(tool, enabled)}
                />
              ))}
            </div>
            <div className="grid gap-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Write</p>
              {writeTools.map((tool) => (
                <ToolRow
                  key={tool.name}
                  tool={tool}
                  readOnly={readOnly}
                  writesAllowed={settings?.allowWrites ?? false}
                  onToggle={(enabled) => toggleTool(tool, enabled)}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {!mcp.isLoading && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-primary" />
              Credentials
            </CardTitle>
            <CardDescription>
              A credential is bound to one person and carries exactly their permissions — issue it to the individual who
              will use the AI client, not to an admin account "so it works". Revoking is immediate.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {revealedToken && (
              <div className="grid gap-1.5 rounded-md border border-warning/40 bg-warning/5 p-3">
                <p className="text-xs font-semibold text-warning">Copy this token now — it won't be shown again.</p>
                <CopyableSecret value={revealedToken} />
              </div>
            )}

            <div className="grid gap-1.5">
              {(settings?.credentials ?? []).map((c) => (
                <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <span className="font-medium">{c.name}</span>
                  <code className="text-xs text-muted-foreground">{c.tokenPrefix}…</code>
                  <Badge variant="muted">
                    acts as {c.actingAs.name} ({c.actingAs.role})
                  </Badge>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {c.lastUsedAt ? `Last used ${new Date(c.lastUsedAt).toLocaleString()}` : "Never used"}
                  </span>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-destructive"
                      onClick={() => revokeCredential.mutate(c.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
              {(settings?.credentials ?? []).length === 0 && (
                <p className="py-2 text-center text-sm text-muted-foreground">No MCP credentials yet.</p>
              )}
            </div>

            {!readOnly && (
              <div className="flex flex-wrap gap-2">
                <Input
                  className="min-w-[12rem] flex-1"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Credential name (e.g. Priya's Claude Desktop)"
                />
                <Select value={newUserId} onValueChange={setNewUserId}>
                  <SelectTrigger className="w-64">
                    <SelectValue placeholder="Acts as…" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeUsers.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.name} — {u.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  disabled={!newName.trim() || !newUserId || createCredential.isPending}
                  onClick={() => createCredential.mutate()}
                >
                  <Plus className="h-4 w-4" />
                  Issue
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
