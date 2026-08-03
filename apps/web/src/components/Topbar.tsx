/**
 * WHAT: the top app bar — mobile menu toggle, search/command-palette trigger, theme toggle, and
 * the user menu (profile/logout), composing `NotificationsBell` and `CommandPalette`.
 * WHY it composes rather than the pages doing so individually: every authenticated page shares
 * this exact bar (rendered once by `AppLayout`), so cross-page concerns like "is the command
 * palette open" and "which theme is active" live here instead of being duplicated per page.
 * WHO renders this: `layouts/AppLayout.tsx`.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Command, Compass, LogOut, Menu, Moon, Search, Sparkles, Sun, UserRound, FileClock } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { MobileDrawerNav } from "./Sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "./ui/dropdown-menu";
import { Badge } from "./ui/badge";
import { toast } from "./ui/toaster";
import { NotificationsBell } from "./NotificationsBell";
import { CommandPalette, useCommandPaletteHotkey } from "./command-palette";
import { ProductTour, shouldAutoStartTour, useTourController } from "./ProductTour";
import { authApi, fileUrl, systemApi } from "../services/api";
import { hasUnseenRelease } from "../lib/whats-new-seen";
import { useAuthStore } from "../store/auth";

const THEME_KEY = "timesheet:theme";

function initialsFor(name?: string) {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function Topbar() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logoutStore = useAuthStore((s) => s.logout);
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return false;
    return document.documentElement.classList.contains("dark");
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  }, [dark]);

  useCommandPaletteHotkey(() => setPaletteOpen(true));

  // The guided tour. Opens itself once, for a genuinely new account, in a browser session that
  // hasn't seen it — and is available on demand from the profile menu below for everyone else.
  //
  // Shares OnboardingGate's query key, so this costs no extra request: the gate decides whether
  // setup is still owed, and `completedAt` tells the tour whether this is someone's first day.
  const onboarding = useQuery({
    queryKey: ["auth", "onboarding-status"],
    queryFn: authApi.onboardingStatus,
    enabled: Boolean(user),
    staleTime: 5_000
  });
  const { running: tourRunning, start: startTour, stop: stopTour } = useTourController();

  // Drives the "What's new" dot. Cheap by construction: the server answers from an hourly cache,
  // and staleTime keeps this tab from asking more than once per session anyway.
  const updates = useQuery({ queryKey: ["system", "updates"], queryFn: systemApi.updates, staleTime: 60 * 60 * 1000, enabled: Boolean(user) });
  const unseenRelease = hasUnseenRelease(updates.data?.latestVersion);
  useEffect(() => {
    if (!user || !shouldAutoStartTour(onboarding.data?.completedAt)) return;
    // Deferred so it measures a settled layout rather than a half-rendered dashboard.
    const timer = window.setTimeout(() => startTour(), 900);
    return () => window.clearTimeout(timer);
  }, [user, onboarding.data?.completedAt, startTour]);

  const queryClient = useQueryClient();
  async function handleLogout() {
    try {
      await authApi.logout();
    } catch {
      // ignore — we still want local cleanup
    }
    logoutStore();
    // Drop every cached server response so the next sign-in starts clean and
    // we don't briefly flash the previous user's data.
    queryClient.clear();
    toast.success("Signed out");
    navigate("/login");
  }

  const avatarSrc = fileUrl(user?.avatarUrl);

  return (
    <>
      <header className="sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur-xl lg:px-6">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 lg:hidden"
          onClick={() => setDrawerOpen(true)}
          aria-label="Menu"
        >
          <Menu className="h-5 w-5" />
        </Button>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="focus-ring group relative flex h-10 min-w-0 flex-1 max-w-xl items-center gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
          aria-label="Open command palette"
          data-tour="command-search"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate text-left">Search users, projects, actions...</span>
          <kbd className="hidden items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider sm:inline-flex">
            <Command className="h-3 w-3" /> K
          </kbd>
        </button>

        <div className="ml-auto flex items-center gap-1">
          {/* inline-flex, NOT `contents`: an element with `display: contents` generates no box, so
              getBoundingClientRect() returns zeros and the tour spotlight would have nothing to
              measure. */}
          <span data-tour="notifications" className="inline-flex">
            <NotificationsBell />
          </span>

          <Button
            variant="ghost"
            size="icon"
            onClick={() => setDark((value) => !value)}
            aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
            title="Toggle theme"
          >
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>

          {/* modal={false}: a menu doesn't need to freeze page scroll, and the scroll lock is
              what interacted badly with sticky positioning (see index.css's html comment). */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button data-tour="user-menu" variant="ghost" className="h-10 gap-2 rounded-full border border-border px-2 pr-3">
                <Avatar className="h-7 w-7">
                  {avatarSrc ? <AvatarImage src={avatarSrc} alt={user?.name ?? "Profile photo"} /> : null}
                  <AvatarFallback>{initialsFor(user?.name)}</AvatarFallback>
                </Avatar>
                <span className="hidden text-sm font-semibold sm:inline">{user?.name?.split(" ")[0] ?? "Account"}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-64" align="end">
              <DropdownMenuLabel>
                <div className="flex items-center gap-3 normal-case">
                  <Avatar className="h-10 w-10">
                    {avatarSrc ? <AvatarImage src={avatarSrc} alt={user?.name ?? "Profile photo"} /> : null}
                    <AvatarFallback>{initialsFor(user?.name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="text-sm font-bold tracking-tight">{user?.name}</p>
                    <p className="truncate text-xs font-normal text-muted-foreground">{user?.email}</p>
                    <Badge variant="info" className="mt-1 w-fit">{user?.role}</Badge>
                  </div>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link to="/app/profile"><UserRound /> Profile</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/app/history"><FileClock /> My history</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/app/whats-new" className="relative">
                  <Sparkles /> What's new
                  {/* Re-arms once per release (keyed by version, see lib/whats-new-seen.ts) —
                      a dot that never clears trains people to ignore it. */}
                  {unseenRelease && <span aria-hidden className="absolute right-2 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-primary" />}
                </Link>
              </DropdownMenuItem>
              {/* Sits with Profile and My history because that's where people look for "things
                  about me and how I use this", and because the tour is the one feature someone
                  goes hunting for AFTER dismissing it. */}
              <DropdownMenuItem onSelect={() => startTour()}>
                <Compass /> Take the tour
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={handleLogout} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
                <LogOut /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <MobileDrawerNav open={drawerOpen} onOpenChange={setDrawerOpen} />
      <ProductTour running={tourRunning} onClose={stopTour} />
    </>
  );
}
