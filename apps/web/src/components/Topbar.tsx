/**
 * WHAT: the top app bar — mobile menu toggle, search/command-palette trigger, theme toggle, and
 * the user menu (profile/logout), composing `NotificationsBell` and `CommandPalette`.
 * WHY it composes rather than the pages doing so individually: every authenticated page shares
 * this exact bar (rendered once by `AppLayout`), so cross-page concerns like "is the command
 * palette open" and "which theme is active" live here instead of being duplicated per page.
 * WHO renders this: `layouts/AppLayout.tsx`.
 */
import { useQuery } from "@tanstack/react-query";
import { Command, Menu, Moon, Search, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { AccountMenuContent, initialsFor } from "./AccountMenu";
import { MobileDrawerNav } from "./Sidebar";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { NotificationsBell } from "./NotificationsBell";
import { CommandPalette, useCommandPaletteHotkey } from "./command-palette";
import { ProductTour, shouldAutoStartTour, useTourController } from "./ProductTour";
import { authApi, fileUrl } from "../services/api";
import { useAuthStore } from "../store/auth";

const THEME_KEY = "timesheet:theme";

export function Topbar() {
  const user = useAuthStore((s) => s.user);
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
  // The tour's state is a shared store (see ProductTour.tsx) precisely because the account menu
  // that offers "Take the tour" now renders in two places while only this one renders the tour.
  const { running: tourRunning, start: startTour, stop: stopTour } = useTourController();

  useEffect(() => {
    if (!user || !shouldAutoStartTour(onboarding.data?.completedAt)) return;
    // Deferred so it measures a settled layout rather than a half-rendered dashboard.
    const timer = window.setTimeout(() => startTour(), 900);
    return () => window.clearTimeout(timer);
  }, [user, onboarding.data?.completedAt, startTour]);

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
            <AccountMenuContent />
          </DropdownMenu>
        </div>
      </header>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <MobileDrawerNav open={drawerOpen} onOpenChange={setDrawerOpen} />
      <ProductTour running={tourRunning} onClose={stopTour} />
    </>
  );
}
