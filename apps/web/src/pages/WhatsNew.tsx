/**
 * WHAT: /app/whats-new — the version details page. What this server is running (version, git SHA,
 * build date), whether a newer release exists, and the release-note history.
 *
 * WHO SEES WHAT, and why the split matters:
 *  - Release notes and the current version: EVERYONE. Notes describe features people use; hiding
 *    them from non-admins would just mean users asking admins what changed.
 *  - The "update available" card with upgrade instructions: SUPER_ADMIN only. A regular employee
 *    can do nothing with `./update.sh` except worry — showing them an action they can't take is
 *    noise at best and a support ticket at worst.
 *
 * SECURITY NOTE THAT MUST OUTLIVE REFACTORS: `release.notes` is markdown fetched from the GitHub
 * API — REMOTE content, same trust level as an inbound email. It is rendered exclusively through
 * `marked` piped into `safeHtml` (DOMPurify). Rendering it any other way reopens XSS from anyone
 * who can edit a GitHub release.
 *
 * WHO renders this: App.tsx's /app/whats-new route; linked from the profile menu ("What's new")
 * and the Workspace Settings About card.
 */
import { useQuery } from "@tanstack/react-query";
import { marked } from "marked";
import {
  ArrowUpCircle,
  Bug,
  CheckCircle2,
  Copy,
  ExternalLink,
  GitCommitHorizontal,
  History,
  Package,
  ShieldCheck,
  Sparkles,
  Wrench,
  Zap,
  type LucideIcon
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { toast } from "../components/ui/toaster";
import { markReleaseSeen } from "../lib/whats-new-seen";
import { safeHtml } from "../lib/safe-html";
import { systemApi, type ReleaseInfo } from "../services/api";
import { useAuthStore } from "../store/auth";
import { copyText } from "../lib/clipboard";

/** Markdown → sanitized HTML. `async: false` keeps marked synchronous (no highlighting plugins),
 *  and safeHtml strips anything DOMPurify's allowlist doesn't recognise — the load-bearing step. */
function renderNotes(markdown: string): { __html: string } {
  return safeHtml(marked.parse(markdown, { async: false }) as string);
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/* ------------------------------------------------------------------ release-note structure */

/**
 * The industry-standard changelog taxonomy (Keep-a-Changelog / GitHub releases), matched by
 * keyword so it works whether a section was written "### ✨ Features", "### Fixes" or
 * "### 🔐 Password and camera-policy hardening". Order in this list is match priority —
 * "security hardening" must land on security before "hardening" could mean anything else.
 */
const NOTE_CATEGORIES: Array<{ match: RegExp; label: string; tone: string; icon: LucideIcon }> = [
  { match: /security|hardening|password|privacy/i, label: "Security", tone: "bg-destructive/10 text-destructive", icon: ShieldCheck },
  { match: /fix|bug/i, label: "Fixes", tone: "bg-warning/10 text-warning", icon: Bug },
  {
    match: /feature|new|planning layer|release history|calendar|report|profile|user management|status page|everything else/i,
    label: "Features",
    tone: "bg-success/10 text-success",
    icon: Sparkles
  },
  { match: /performance|install|infra|https|deploy|docker/i, label: "Infrastructure", tone: "bg-info/10 text-info", icon: Zap },
  { match: /dependenc|packages|upgrade/i, label: "Dependencies", tone: "bg-muted text-muted-foreground", icon: Package },
  { match: /under the hood|internal|polish|dev/i, label: "Internal", tone: "bg-muted text-muted-foreground", icon: Wrench }
];
const FALLBACK_CATEGORY = { label: "Changes", tone: "bg-muted text-muted-foreground", icon: History };

interface NoteSection {
  /** The heading as written, minus its emoji — the author's words stay the headline. */
  title: string;
  category: (typeof NOTE_CATEGORIES)[number] | typeof FALLBACK_CATEGORY;
  markdown: string;
  /** Top-level bullets — the number shown on the collapsed chip. */
  items: number;
}

/**
 * Splits a release body on its `###` section headings. `##`+`####` stay inside content (the
 * planning-layer section uses #### for phases). Anything before the first heading is the intro.
 */
function parseReleaseSections(notes: string): { intro: string; sections: NoteSection[] } {
  const lines = notes.split(/\r?\n/);
  const sections: NoteSection[] = [];
  let intro: string[] = [];
  let current: { title: string; body: string[] } | null = null;

  const push = () => {
    if (!current) return;
    const cleanTitle = current.title.replace(/[\p{Extended_Pictographic}️]/gu, "").trim();
    const category = NOTE_CATEGORIES.find((c) => c.match.test(cleanTitle)) ?? FALLBACK_CATEGORY;
    const markdown = current.body.join("\n").trim();
    sections.push({ title: cleanTitle, category, markdown, items: current.body.filter((l) => /^- /.test(l)).length });
  };

  for (const line of lines) {
    const heading = line.match(/^###\s+(.*)$/);
    if (heading) {
      push();
      current = { title: heading[1], body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      intro.push(line);
    }
  }
  push();
  return { intro: intro.join("\n").trim(), sections };
}

/** Collapsed-state summary: one chip per distinct category with its bullet count — the shape of
 *  a release at a glance, before anyone expands anything. */
function categoryChips(sections: NoteSection[]) {
  const byLabel = new Map<string, { tone: string; icon: LucideIcon; items: number }>();
  for (const s of sections) {
    const existing = byLabel.get(s.category.label);
    if (existing) existing.items += s.items;
    else byLabel.set(s.category.label, { tone: s.category.tone, icon: s.category.icon, items: s.items });
  }
  return [...byLabel.entries()].map(([label, v]) => ({ label, ...v }));
}

export function WhatsNewPage() {
  const user = useAuthStore((s) => s.user);
  const isSuperAdmin = user?.role === "SUPER_ADMIN";

  const version = useQuery({ queryKey: ["system", "version"], queryFn: systemApi.version, staleTime: 60_000 });
  const updates = useQuery({ queryKey: ["system", "updates"], queryFn: systemApi.updates, staleTime: 60_000 });

  // The newest release is expanded by default — it's what someone came here to read. The rest
  // start collapsed so the page is a changelog, not a wall.
  const [expanded, setExpanded] = useState<string | null>(null);

  // Visiting IS reading: clear the menu dot for this release the moment we know what it is.
  useEffect(() => {
    markReleaseSeen(updates.data?.latestVersion);
  }, [updates.data?.latestVersion]);

  const releases = updates.data?.releases ?? [];
  const current = version.data?.version ?? "…";
  const updateAvailable = Boolean(updates.data?.updateAvailable);

  return (
    <div className="grid gap-5">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight">What's new</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The version this workspace is running, and what each release changed.
          </p>
        </div>
      </div>

      {/* ------------------------------------------------ current version */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Package className="h-4 w-4 text-primary" />
            This installation
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Version</p>
              <p className="mt-0.5 flex items-center gap-2 font-mono text-lg font-bold">
                v{current}
                {/* Only claimed when there is a known latest release to be up to date WITH. With
                    zero release info (GitHub unreachable, or no releases published yet) the badge
                    would be an assertion the page has no evidence for. */}
                {!updates.isLoading && !updateAvailable && updates.data?.latestVersion && (
                  <Badge variant="success" className="font-sans">
                    <CheckCircle2 className="mr-1 h-3 w-3" />
                    Up to date
                  </Badge>
                )}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Build</p>
              <p className="mt-0.5 flex items-center gap-1.5 font-mono text-sm">
                <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {version.data?.gitSha ?? "unknown"}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">Built</p>
              <p className="mt-0.5 text-sm">{formatDate(version.data?.builtAt ?? null)}</p>
            </div>
          </div>

          {!updates.data?.checkEnabled && !updates.isLoading && (
            <p className="text-xs text-muted-foreground">
              Update checks are switched off for this deployment (UPDATE_CHECK=off), so this page can't say whether a
              newer version exists.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------------------------ update available (admins only) */}
      {updateAvailable && isSuperAdmin && (
        <Card className="border-primary/40 bg-primary/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ArrowUpCircle className="h-4 w-4 text-primary" />
              Version {updates.data?.latestVersion} is available
            </CardTitle>
            <CardDescription>
              Released {formatDate(releases[0]?.publishedAt ?? null)}. Read the notes below, then update from the
              server that runs this workspace — the command backs up, migrates, verifies, and rolls itself back if
              anything fails.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            <UpdateCommand />
            <p className="text-xs text-muted-foreground">
              Kubernetes deployments upgrade with <code className="rounded bg-muted px-1 py-0.5">helm upgrade</code>{" "}
              instead — see docs/DEPLOYMENT.md. Everyone with the app open is offered a refresh automatically once the
              server comes back on the new version.
            </p>
          </CardContent>
        </Card>
      )}

      {updateAvailable && !isSuperAdmin && (
        <p className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          A newer version ({updates.data?.latestVersion}) exists. Your workspace admin decides when to install updates —
          you'll be prompted to refresh when it happens.
        </p>
      )}

      {/* ------------------------------------------------ release history */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4 text-primary" />
            Release history
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {updates.isLoading && <Skeleton className="h-24 w-full" />}

          {/* Bundled history is complete UP TO this build but can't know about anything newer —
              said out loud, so it never masquerades as a live feed. */}
          {!updates.isLoading && updates.data?.releasesSource === "changelog" && (
            <p className="text-xs text-muted-foreground">
              Shown from this build's own changelog{updates.data?.checkEnabled ? " — GitHub release data isn't reachable from this server" : ""}.
              Versions newer than this installation won't appear here.
            </p>
          )}

          {!updates.isLoading && releases.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              {updates.data?.checkEnabled
                ? "No release information available — either no releases have been published yet, or the server can't reach GitHub right now."
                : "Release history needs update checks enabled."}
            </p>
          )}

          {releases.map((release, index) => (
            <ReleaseCard
              key={release.version}
              release={release}
              isCurrent={release.version === current}
              // First card follows the page default (open); the rest follow clicks.
              open={expanded === null ? index === 0 : expanded === release.version}
              onToggle={() => setExpanded(expanded === release.version ? "__none__" : release.version)}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

/** The upgrade one-liner with a copy button — the admin's actual next step, so it earns the
 *  biggest visual weight on the page. */
function UpdateCommand() {
  // .cmd on Windows, not .ps1: the launcher sidesteps PowerShell's default Restricted
  // execution policy, which blocks .ps1 files outright on stock Windows.
  const command = "./update.sh          # or  .\\update.cmd  on Windows";
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-background p-2 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-sm">{command}</code>
      <Button
        size="sm"
        variant="outline"
        className="h-8 shrink-0"
        onClick={() => {
          void copyText("./update.sh");
          toast.success("Copied");
        }}
      >
        <Copy className="h-3.5 w-3.5" />
        Copy
      </Button>
    </div>
  );
}

function ReleaseCard({
  release,
  isCurrent,
  open,
  onToggle
}: {
  release: ReleaseInfo;
  isCurrent: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const parsed = useMemo(() => parseReleaseSections(release.notes), [release.notes]);
  const chips = useMemo(() => categoryChips(parsed.sections), [parsed.sections]);
  /** The release NAME, when it has one beyond "vX.Y.Z" — "the planning layer" is information. */
  const displayName = release.name && release.name !== `v${release.version}` ? release.name : null;

  return (
    <div className={`rounded-lg border ${isCurrent ? "border-primary/40 bg-primary/5" : "border-border"}`}>
      <button type="button" onClick={onToggle} className="grid w-full gap-1.5 p-3 text-left" aria-expanded={open}>
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-bold">v{release.version}</span>
          {displayName && <span className="text-sm font-semibold">— {displayName}</span>}
          {isCurrent && <Badge variant="success">running</Badge>}
          <span className="ml-auto flex shrink-0 items-center gap-3">
            <span className="text-xs tabular-nums text-muted-foreground">{formatDate(release.publishedAt)}</span>
            <span className="text-xs font-semibold text-primary">{open ? "Hide" : "Details"}</span>
          </span>
        </span>
        {/* The shape of the release at a glance — category chips with bullet counts, visible
            without expanding anything. */}
        {chips.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5">
            {chips.map((chip) => (
              <span key={chip.label} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${chip.tone}`}>
                <chip.icon className="h-3 w-3" />
                {chip.label}
                {chip.items > 0 && <span className="tabular-nums opacity-70">{chip.items}</span>}
              </span>
            ))}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-border p-3 pt-3">
          {parsed.intro && (
            // REMOTE markdown — sanitized in renderNotes, never rendered raw. See the file header.
            <div className={`${NOTES_PROSE} mb-4`} dangerouslySetInnerHTML={renderNotes(parsed.intro)} />
          )}

          {parsed.sections.length > 0 ? (
            <div className="grid gap-4">
              {parsed.sections.map((section) => (
                <section key={section.title} className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${section.category.tone}`}>
                      <section.category.icon className="h-3 w-3" />
                      {section.category.label}
                    </span>
                    <h3 className="text-sm font-semibold">{section.title}</h3>
                  </div>
                  <div
                    className={`${NOTES_PROSE} border-l-2 border-border pl-3`}
                    dangerouslySetInnerHTML={renderNotes(section.markdown)}
                  />
                </section>
              ))}
            </div>
          ) : (
            !parsed.intro && <p className="text-sm text-muted-foreground">No notes were written for this release.</p>
          )}

          <a
            href={release.url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
          >
            View on GitHub <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}
    </div>
  );
}

/** One prose style for every rendered note fragment, so intro and sections cannot drift apart. */
const NOTES_PROSE =
  "prose-sm max-w-none text-sm leading-6 [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-base [&_h1]:font-bold [&_h2]:text-sm [&_h2]:font-bold [&_h4]:mt-2 [&_h4]:text-sm [&_h4]:font-semibold [&_li]:ml-4 [&_li]:mt-1 [&_ul]:list-disc [&_ol]:list-decimal [&_p]:mt-2 [&_p:first-child]:mt-0 [&_strong]:font-semibold";
