import { useQueryClient } from "@tanstack/react-query";
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
  Sun,
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
import { useAuthStore } from "../store/auth";
import { authApi } from "../services/api";
import { toast } from "./ui/toaster";

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
  { label: "History", to: "/app/history", icon: FileClock },
  { label: "Approvals", to: "/app/approvals", icon: Shield, permission: permissions.TIMESHEETS_APPROVE },
  { label: "My team", to: "/app/team", icon: Users2, permission: permissions.TIMESHEETS_APPROVE, hint: "SLA & reports" },
  { label: "Users", to: "/app/users", icon: Users, permission: permissions.USERS_MANAGE },
  { label: "Projects", to: "/app/projects", icon: FolderKanban, permission: permissions.PROJECTS_MANAGE },
  { label: "Reports & Analytics", to: "/app/reports", icon: BarChart3, permission: permissions.REPORTS_VIEW },
  { label: "Audit Log", to: "/app/audit", icon: ScrollText, permission: permissions.AUDIT_VIEW },
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
