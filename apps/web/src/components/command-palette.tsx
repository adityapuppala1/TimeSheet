/**
 * WHAT: the Cmd/Ctrl-K command palette — permission-filtered route search/navigation, quick
 * actions, a deterministic record search over tickets and projects (by key, code, title or name,
 * under the caller's scope — see api/services/search.service.ts), and an "Ask AI"
 * natural-language search dialog over the ticket backlog. Also exports
 * `useCommandPaletteHotkey`, the keyboard-shortcut listener that opens it.
 *
 * WHY TWO SEARCHES: "WEB-123" wants the record, now, with no model in the loop; "that ticket
 * about the login loop" wants the model. Record hits appear as you type; Ask AI stays a choice.
 * WHY permission-filtered: the same palette renders for every role, but a route/action a user
 * can't actually use (e.g. Admin Pages for an EMPLOYEE) is filtered out entirely rather than
 * shown-disabled — a command palette listing things you can't do isn't useful.
 * WHO renders this: `components/Topbar.tsx`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  BarChart3,
  Bot,
  BrainCircuit,
  Briefcase,
  CalendarDays,
  CalendarPlus2,
  FileClock,
  FolderKanban,
  GanttChartSquare,
  Gauge,
  Inbox,
  Mailbox,
  LayoutDashboard,
  ListTodo,
  LogOut,
  Mail,
  Moon,
  ScrollText,
  Settings,
  Shield,
  ShieldAlert,
  Sparkles,
  Target,
  Sun,
  Ticket,
  Workflow,
  TicketPlus,
  TrendingUp,
  UserRound,
  Users,
  Users2,
  CircleHelp,
  Keyboard,
  BookOpen } from "lucide-react";
import { ticketsHref } from "../lib/project-tree";
import { comboForRoute, formatCombo, SHORTCUTS } from "../lib/shortcuts";
import { permissions } from "@timesheet/shared";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
} from "./ui/command";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";
import { AiStrands } from "./ui/ai-strands";
import { BorderGlow } from "./ui/border-glow";
import { useAuthStore } from "../store/auth";
import { usePlanningFeatures } from "../lib/use-planning";
import { askAiApi, authApi, searchApi, type PlanningEffective } from "../services/api";
import { toast } from "./ui/toaster";
import { toggleTheme as switchTheme } from "../lib/theme";

function serverMessage(err: any, fallback: string) {
  return err?.response?.data?.message ?? fallback;
}

interface NavRoute {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: string;
  role?: "SUPER_ADMIN";
  hint?: string;
  /** Planning capability this route needs, matching the sidebar's  key. Kept in sync
   *  with Sidebar.tsx by hand — gating only the sidebar would leave the page reachable here,
   *  which is the same bug the Workspace settings comment below warns about. */
  feature?: keyof PlanningEffective;
}

const navRoutes: NavRoute[] = [
  { label: "Dashboard", to: "/app", icon: LayoutDashboard, hint: "Home" },
  { label: "Help & how-to", to: "/app/help", icon: CircleHelp, hint: "The manual, searchable" },
  { label: "Log Timesheet", to: "/app/timesheet", icon: CalendarDays, permission: permissions.TIMESHEETS_WRITE, hint: "New entry" },
  { label: "Tickets", to: "/app/tickets", icon: Ticket, permission: permissions.TICKETS_VIEW, hint: "Bugs & tasks" },
  { label: "History", to: "/app/history", icon: FileClock },
  { label: "Inbox", to: "/app/inbox", icon: Mailbox, hint: "Today's brief & notifications" },
  { label: "Intelligence", to: "/app/intelligence", icon: BrainCircuit, hint: "Attention, AI actions, risks and readiness" },
  { label: "My work", to: "/app/my-work", icon: ListTodo, hint: "Your queue, all projects" },
  { label: "Goals", to: "/app/goals", icon: Target, feature: "goals", hint: "Objectives with measured progress" },
  { label: "Requests", to: "/app/requests", icon: Inbox, permission: permissions.TICKETS_VIEW, feature: "requestForms", hint: "Intake forms & inbox" },
  { label: "Timeline", to: "/app/timeline", icon: GanttChartSquare, permission: permissions.TICKETS_VIEW, feature: "timeline", hint: "Gantt & dependencies" },
  { label: "Portfolio", to: "/app/portfolio", icon: Briefcase, permission: permissions.REPORTS_VIEW, feature: "planning", hint: "Budget, burn, health" },
  { label: "Workload", to: "/app/workload", icon: Gauge, permission: permissions.RESOURCES_MANAGE, feature: "resourceManagement", hint: "Capacity & bookings" },
  { label: "Agents", to: "/app/agents", icon: Bot, permission: permissions.TICKETS_VIEW, hint: "Your AI teammates" },
  { label: "Workflows", to: "/app/studio", icon: Workflow, permission: permissions.TICKETS_VIEW, hint: "Triggers, steps, and what they may do" },
  { label: "AI overview", to: "/app/ai", icon: Sparkles, hint: "How the AI surfaces relate, and what they cost" },
  { label: "AI suggestions", to: "/app/proposals", icon: Sparkles, permission: permissions.TICKETS_VIEW, feature: "planning", hint: "Review before anything applies" },
  { label: "Approvals", to: "/app/approvals", icon: Shield, permission: permissions.TIMESHEETS_APPROVE },
  { label: "My team", to: "/app/team", icon: Users2, permission: permissions.TIMESHEETS_APPROVE, hint: "SLA & reports" },
  { label: "Users", to: "/app/users", icon: Users, permission: permissions.USERS_MANAGE },
  { label: "Projects", to: "/app/projects", icon: FolderKanban, permission: permissions.PROJECTS_MANAGE },
  { label: "Dashboards", to: "/app/dashboards", icon: LayoutDashboard, feature: "planning", hint: "Build your own view" },
  { label: "Reports & Analytics", to: "/app/reports", icon: BarChart3, permission: permissions.REPORTS_VIEW },
  { label: "Insights", to: "/app/insights", icon: TrendingUp, permission: permissions.REPORTS_VIEW, hint: "Velocity, SLA, workload" },
  { label: "Security insights", to: "/app/security-insights", icon: ShieldAlert, permission: permissions.REPORTS_VIEW, hint: "Findings, risk score, MTTR" },
  { label: "Audit Log", to: "/app/audit", icon: ScrollText, permission: permissions.AUDIT_VIEW },
  { label: "AI Activity Log", to: "/app/ai-activity", icon: Sparkles, permission: permissions.TICKETS_ASSIGN, hint: "AI-created tickets" },
  { label: "Email templates", to: "/app/email-templates", icon: Mail, role: "SUPER_ADMIN", hint: "Edit & test" },
  { label: "Practice update", to: "/app/practice-update", icon: Mail, role: "SUPER_ADMIN", hint: "Weekly AI/ML leadership digest" },
  // SUPER_ADMIN-only — must stay in sync with the same entry in Sidebar.tsx and the RequireRole
  // gate on the route in App.tsx. Gating only the sidebar would still leave it reachable here.
  { label: "Workspace settings", to: "/app/settings", icon: Settings, role: "SUPER_ADMIN" }
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens the "?" shortcuts dialog Topbar owns. */
  onOpenShortcuts?: () => void;
}

export function CommandPalette({ open, onOpenChange, onOpenShortcuts }: Props) {
  const navigate = useNavigate();
  const combo = (id: string) => {
    const def = SHORTCUTS.find((d) => d.id === id);
    return def ? formatCombo(def.combo) : undefined;
  };
  const user = useAuthStore((s) => s.user);
  const logoutStore = useAuthStore((s) => s.logout);
  const [, force] = useState(0);
  const [askOpen, setAskOpen] = useState(false);
  const [askSeed, setAskSeed] = useState("");
  const canAskAI = Boolean(user?.permissions.includes(permissions.TICKETS_VIEW));
  const { features } = usePlanningFeatures();

  // Record search. The input is controlled so the query can be read; it is DEBOUNCED so a person
  // typing "PropTech" costs one request, not eight. Below two characters nothing is asked — the
  // server returns nothing for that anyway, and the static commands already fill the list.
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
    }
  }, [open]);
  const records = useQuery({
    queryKey: ["quick-search", debounced],
    queryFn: () => searchApi.quick(debounced),
    enabled: open && debounced.length >= 2,
    staleTime: 30_000,
    // Keep the previous hits on screen while the next keystroke's results load, so the list does
    // not blink empty between letters.
    placeholderData: (prev) => prev
  });
  const ticketHits = records.data?.tickets ?? [];
  const projectHits = records.data?.projects ?? [];
  const peopleHits = records.data?.people ?? [];
  const changeHits = records.data?.changes ?? [];
  const docHits = records.data?.docs ?? [];
  const anyHit = ticketHits.length + projectHits.length + peopleHits.length + changeHits.length + docHits.length > 0;

  const visibleRoutes = useMemo(
    () =>
      navRoutes.filter((route) => {
        if (route.role && user?.role !== route.role) return false;
        if (route.permission && !user?.permissions.includes(route.permission as any)) return false;
        if (route.feature && !features[route.feature]) return false;
        return true;
      }),
    [user, features]
  );

  function jump(to: string) {
    onOpenChange(false);
    void navigate(to);
  }

  /* No origin passed, and that is on purpose: this path is reached from a keyboard-driven palette,
     where there is no click point for the wipe to spread from. `switchTheme` degrades to an instant
     change rather than inventing a centre — see lib/theme.ts. */
  function handleToggleTheme() {
    const next = switchTheme();
    force((value) => value + 1);
    onOpenChange(false);
    toast.success(`Switched to ${next} mode`);
  }

  const queryClient = useQueryClient();
  async function logout() {
    onOpenChange(false);
    try {
      await authApi.logout();
    } catch {
      // swallow — we still want local cleanup
    }
    logoutStore();
    queryClient.clear();
    toast.success("Signed out. See you again soon.");
    void navigate("/login");
  }

  return (
    <>
      <CommandDialog open={open} onOpenChange={onOpenChange}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search tickets, projects, pages or actions..."
        />
        <CommandList>
        <CommandEmpty>{records.isFetching ? "Searching…" : "No matching commands or records."}</CommandEmpty>
        {/* Server hits carry the live query as a cmdk keyword: cmdk filters every item against the
            input text, and a ticket found by its title would otherwise be hidden by its own key
            failing that client-side match. The keyword makes a server match a client match. */}
        {ticketHits.length > 0 && (
          <CommandGroup heading="Tickets">
            {ticketHits.map((t) => (
              <CommandItem key={t.id} value={`ticket ${t.key} ${t.title}`} keywords={[debounced]} onSelect={() => jump(`/app/tickets?open=${t.id}`)}>
                <Ticket className="text-muted-foreground" />
                {/* nowrap: a key is one token; "E2EARCH90096-635" split over three lines read as three tickets. */}
                <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground">{t.key}</span>
                <span className="truncate">{t.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t.projectName}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {projectHits.length > 0 && (
          <CommandGroup heading="Projects">
            {projectHits.map((p) => (
              <CommandItem key={p.id} value={`project ${p.code} ${p.name}`} keywords={[debounced]} onSelect={() => jump(ticketsHref(p.id))}>
                <FolderKanban className="text-muted-foreground" />
                <span className="truncate">{p.name}</span>
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{p.code}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {peopleHits.length > 0 && (
          <CommandGroup heading="People">
            {peopleHits.map((p) => (
              <CommandItem key={p.id} value={`person ${p.name} ${p.email}`} keywords={[debounced]} onSelect={() => jump(`/app/users?search=${encodeURIComponent(p.name)}`)}>
                <UserRound className="text-muted-foreground" />
                <span className="truncate">{p.name}</span>
                <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">{p.email}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {changeHits.length > 0 && (
          <CommandGroup heading="Changes">
            {changeHits.map((c) => (
              <CommandItem key={c.id} value={`change ${c.key} ${c.title}`} keywords={[debounced]} onSelect={() => jump(`/app/changes/${c.id}`)}>
                <Workflow className="text-muted-foreground" />
                <span className="shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground">{c.key}</span>
                <span className="truncate">{c.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{c.state.replace(/_/g, " ").toLowerCase()}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {docHits.length > 0 && (
          <CommandGroup heading="Documents">
            {docHits.map((d) => (
              <CommandItem key={d.id} value={`doc ${d.title}`} keywords={[debounced]} onSelect={() => jump(`/app/requirements/${d.id}`)}>
                <BookOpen className="text-muted-foreground" />
                <span className="truncate">{d.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{d.status.replace(/_/g, " ").toLowerCase()}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {anyHit && <CommandSeparator />}
        {canAskAI && query.trim().length >= 3 && (
          <CommandGroup heading="Ask AI">
            <CommandItem
              value={`ask ai ${query}`}
              keywords={[query]}
              onSelect={() => {
                setAskSeed(query.trim());
                onOpenChange(false);
                setAskOpen(true);
              }}
            >
              <Sparkles className="text-primary" />
              <span className="min-w-0 truncate">Ask “{query.trim()}”</span>
              <CommandShortcut>AI</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        )}
        <CommandGroup heading="Navigate">
          {visibleRoutes.map((route) => (
            <CommandItem key={route.to} value={`${route.label} ${route.hint ?? ""}`} onSelect={() => jump(route.to)}>
              <route.icon className="text-muted-foreground" />
              <span>{route.label}</span>
              {route.hint && <span className="text-xs text-muted-foreground">{route.hint}</span>}
              {/* The same key the "?" dialog shows, from the same table — never typed here. */}
              {comboForRoute(route.to) && <CommandShortcut>{formatCombo(comboForRoute(route.to)!)}</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Quick actions">
          {/* "⌘ N" used to be printed here with nothing listening — and Chrome reserves Ctrl/⌘+N
              regardless. The hint now comes from lib/shortcuts.ts, where a listener exists for it. */}
          <CommandItem value="new timesheet entry log time" onSelect={() => jump("/app/timesheet")}>
            <CalendarPlus2 className="text-muted-foreground" />
            <span>New timesheet entry</span>
            {combo("new-timesheet") && <CommandShortcut>{combo("new-timesheet")}</CommandShortcut>}
          </CommandItem>
          <CommandItem value="new ticket bug task create" onSelect={() => jump("/app/tickets?new=1")}>
            <TicketPlus className="text-muted-foreground" />
            <span>New ticket</span>
            {combo("new-ticket") && <CommandShortcut>{combo("new-ticket")}</CommandShortcut>}
          </CommandItem>
          {canAskAI && (
            <CommandItem
              value="ask ai search tickets question chat"
              onSelect={() => {
                setAskSeed("");
                onOpenChange(false);
                setAskOpen(true);
              }}
            >
              <Sparkles className="text-muted-foreground" />
              <span className="ai-gradient-text">Ask AI</span>
            </CommandItem>
          )}
          <CommandItem
            value="keyboard shortcuts keys hotkeys"
            onSelect={() => {
              onOpenChange(false);
              onOpenShortcuts?.();
            }}
          >
            <Keyboard className="text-muted-foreground" />
            <span>Keyboard shortcuts</span>
            <CommandShortcut>?</CommandShortcut>
          </CommandItem>
          <CommandItem value="toggle theme dark light" onSelect={handleToggleTheme}>
            <Sun className="text-muted-foreground dark:hidden" />
            <Moon className="hidden text-muted-foreground dark:block" />
            <span>Toggle theme</span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Account">
          <CommandItem value="profile settings" onSelect={() => jump("/app/profile")}>
            <UserRound className="text-muted-foreground" />
            <span>My profile</span>
          </CommandItem>
          <CommandItem value="sign out logout" onSelect={logout}>
            <LogOut className="text-muted-foreground" />
            <span>Sign out</span>
          </CommandItem>
        </CommandGroup>
        </CommandList>
      </CommandDialog>
      <AskAIDialog open={askOpen} onOpenChange={setAskOpen} initialQuestion={askSeed} />
    </>
  );
}

function AskAIDialog({ open, onOpenChange, initialQuestion }: { open: boolean; onOpenChange: (open: boolean) => void; initialQuestion?: string }) {
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Array<{ id: string; question: string; answer: string }>>([]);

  const ask = useMutation({
    mutationFn: (q: string) => askAiApi.ask(q),
    onSuccess: (res, q) => {
      setHistory((h) => [...h, { id: `${Date.now()}-${h.length}`, question: q, answer: res.answer ?? res.error ?? "No answer was returned." }]);
      setQuestion("");
    },
    onError: (err: any) => toast.error("Could not get an answer", { description: serverMessage(err, "AI may be disabled for this workspace.") })
  });

  useEffect(() => {
    if (open && initialQuestion) setQuestion(initialQuestion);
  }, [open, initialQuestion]);

  function submit() {
    const q = question.trim();
    if (q.length < 3 || ask.isPending) return;
    ask.mutate(q);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setHistory([]);
          setQuestion("");
        }
      }}
    >
      <DialogContent className="w-[min(95vw,560px)] max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" />Ask AI</DialogTitle>
          <DialogDescription>Ask a question about your accessible tickets — answers cite ticket keys.</DialogDescription>
        </DialogHeader>
        <BorderGlow>
          <ScrollArea className="max-h-80">
            <div className="grid gap-4 p-3">
              {history.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  Try "What's overdue in Payments?" or "Summarize open critical bugs."
                </p>
              )}
              {history.map((turn) => (
                <div key={turn.id} className="grid gap-1.5">
                  <p className="text-sm font-semibold">{turn.question}</p>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{turn.answer}</p>
                </div>
              ))}
              {ask.isPending && <AiStrands label="Searching your tickets…" />}
            </div>
          </ScrollArea>
        </BorderGlow>
        <div className="flex gap-2">
          <Input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about your tickets..."
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <Button onClick={submit} disabled={question.trim().length < 3 || ask.isPending}>Ask</Button>
        </div>
        {/* The dialog answers one question and forgets it. The page keeps the history, rates the
            answers, and can consult timesheets and changes too — say so where the question is asked. */}
        <Link
          to="/app/ask-ai"
          onClick={() => onOpenChange(false)}
          className="text-center text-xs font-medium text-primary hover:underline"
        >
          Open the full Ask AI page — history, charts, timesheets and changes →
        </Link>
      </DialogContent>
    </Dialog>
  );
}

// The Ctrl/⌘+K listener that used to live here moved into lib/shortcuts.ts + ShortcutsDialog.tsx's
// `useGlobalShortcuts`, so the palette chord and every other shortcut share one table and one
// listener.
