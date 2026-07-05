/**
 * WHAT: the Cmd/Ctrl-K command palette — permission-filtered route search/navigation, quick
 * actions, and an "Ask AI" natural-language search dialog over the ticket backlog. Also exports
 * `useCommandPaletteHotkey`, the keyboard-shortcut listener that opens it.
 * WHY permission-filtered: the same palette renders for every role, but a route/action a user
 * can't actually use (e.g. Admin Pages for an EMPLOYEE) is filtered out entirely rather than
 * shown-disabled — a command palette listing things you can't do isn't useful.
 * WHO renders this: `components/Topbar.tsx`.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BarChart3,
  CalendarDays,
  CalendarPlus2,
  FileClock,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  Mail,
  Moon,
  ScrollText,
  Settings,
  Shield,
  Sparkles,
  Sun,
  Ticket,
  TicketPlus,
  TrendingUp,
  UserRound,
  Users,
  Users2
} from "lucide-react";
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
import { Skeleton } from "./ui/skeleton";
import { useAuthStore } from "../store/auth";
import { aiApi, authApi } from "../services/api";
import { toast } from "./ui/toaster";

function serverMessage(err: any, fallback: string) {
  return err?.response?.data?.message ?? fallback;
}

const THEME_KEY = "timesheet:theme";

interface NavRoute {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: string;
  role?: "SUPER_ADMIN";
  hint?: string;
}

const navRoutes: NavRoute[] = [
  { label: "Dashboard", to: "/app", icon: LayoutDashboard, hint: "Home" },
  { label: "Log Timesheet", to: "/app/timesheet", icon: CalendarDays, permission: permissions.TIMESHEETS_WRITE, hint: "New entry" },
  { label: "Tickets", to: "/app/tickets", icon: Ticket, permission: permissions.TICKETS_VIEW, hint: "Bugs & tasks" },
  { label: "History", to: "/app/history", icon: FileClock },
  { label: "Approvals", to: "/app/approvals", icon: Shield, permission: permissions.TIMESHEETS_APPROVE },
  { label: "My team", to: "/app/team", icon: Users2, permission: permissions.TIMESHEETS_APPROVE, hint: "SLA & reports" },
  { label: "Users", to: "/app/users", icon: Users, permission: permissions.USERS_MANAGE },
  { label: "Projects", to: "/app/projects", icon: FolderKanban, permission: permissions.PROJECTS_MANAGE },
  { label: "Reports & Analytics", to: "/app/reports", icon: BarChart3, permission: permissions.REPORTS_VIEW },
  { label: "Insights", to: "/app/insights", icon: TrendingUp, permission: permissions.REPORTS_VIEW, hint: "Velocity, SLA, workload" },
  { label: "Audit Log", to: "/app/audit", icon: ScrollText, permission: permissions.AUDIT_VIEW },
  { label: "AI Activity Log", to: "/app/ai-activity", icon: Sparkles, permission: permissions.TICKETS_ASSIGN, hint: "AI-created tickets" },
  { label: "Email templates", to: "/app/email-templates", icon: Mail, role: "SUPER_ADMIN", hint: "Edit & test" },
  { label: "Workspace settings", to: "/app/settings", icon: Settings }
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logoutStore = useAuthStore((s) => s.logout);
  const [, force] = useState(0);
  const [askOpen, setAskOpen] = useState(false);
  const canAskAI = Boolean(user?.permissions.includes(permissions.TICKETS_VIEW));

  const visibleRoutes = useMemo(
    () =>
      navRoutes.filter((route) => {
        if (route.role && user?.role !== route.role) return false;
        if (route.permission && !user?.permissions.includes(route.permission as any)) return false;
        return true;
      }),
    [user]
  );

  function jump(to: string) {
    onOpenChange(false);
    navigate(to);
  }

  function toggleTheme() {
    const isDark = document.documentElement.classList.toggle("dark");
    localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
    force((value) => value + 1);
    onOpenChange(false);
    toast.success(`Switched to ${isDark ? "dark" : "light"} mode`);
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
    navigate("/login");
  }

  return (
    <>
      <CommandDialog open={open} onOpenChange={onOpenChange}>
        <CommandInput placeholder="Type a command, search a page or action..." />
        <CommandList>
        <CommandEmpty>No matching commands.</CommandEmpty>
        <CommandGroup heading="Navigate">
          {visibleRoutes.map((route) => (
            <CommandItem key={route.to} value={`${route.label} ${route.hint ?? ""}`} onSelect={() => jump(route.to)}>
              <route.icon className="text-muted-foreground" />
              <span>{route.label}</span>
              {route.hint && <span className="text-xs text-muted-foreground">{route.hint}</span>}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Quick actions">
          <CommandItem value="new timesheet entry" onSelect={() => jump("/app/timesheet")}>
            <CalendarPlus2 className="text-muted-foreground" />
            <span>New timesheet entry</span>
            <CommandShortcut>⌘ N</CommandShortcut>
          </CommandItem>
          <CommandItem value="new ticket bug task" onSelect={() => jump("/app/tickets")}>
            <TicketPlus className="text-muted-foreground" />
            <span>New ticket</span>
          </CommandItem>
          {canAskAI && (
            <CommandItem
              value="ask ai search tickets question chat"
              onSelect={() => {
                onOpenChange(false);
                setAskOpen(true);
              }}
            >
              <Sparkles className="text-muted-foreground" />
              <span>Ask AI</span>
            </CommandItem>
          )}
          <CommandItem value="toggle theme dark light" onSelect={toggleTheme}>
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
      <AskAIDialog open={askOpen} onOpenChange={setAskOpen} />
    </>
  );
}

function AskAIDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Array<{ id: string; question: string; answer: string }>>([]);

  const ask = useMutation({
    mutationFn: (q: string) => aiApi.ask(q),
    onSuccess: (res, q) => {
      setHistory((h) => [...h, { id: `${Date.now()}-${h.length}`, question: q, answer: res.answer }]);
      setQuestion("");
    },
    onError: (err: any) => toast.error("Could not get an answer", { description: serverMessage(err, "AI may be disabled for this workspace.") })
  });

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
        <ScrollArea className="max-h-80 rounded-md border border-border">
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
            {ask.isPending && <Skeleton className="h-4 w-full" />}
          </div>
        </ScrollArea>
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
      </DialogContent>
    </Dialog>
  );
}

export function useCommandPaletteHotkey(onOpen: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.key === "k" || event.key === "K") && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onOpen();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpen]);
}
