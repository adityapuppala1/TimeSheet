/**
 * WHAT: the account dropdown's CONTENT — avatar/name/email/role, the role switcher for anyone
 * holding more than one role, and the Profile / My history / What's new / Take the tour / Sign out
 * actions.
 *
 * WHY IT'S ITS OWN COMPONENT: two places open this exact menu — the top bar's avatar button and
 * the sidebar's account card at the bottom. Sharing the DATA (both read `useAuthStore`) would not
 * be enough: two copies of the menu itself would drift the first time an item is added to one of
 * them. This is the single definition; each caller supplies only its own trigger.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Compass, FileClock, LogOut, Repeat, Sparkles, UserRound, CircleHelp } from "lucide-react";
import { Link, useNavigate } from "react-router";
import type { RoleName } from "@timesheet/shared";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Badge } from "./ui/badge";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from "./ui/dropdown-menu";
import { toast } from "./ui/toaster";
import { useTourController } from "./ProductTour";
import { authApi, fileUrl, systemApi } from "../services/api";
import { hasUnseenRelease } from "../lib/whats-new-seen";
import { useAuthStore } from "../store/auth";

export function initialsFor(name?: string) {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function AccountMenuContent() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const logoutStore = useAuthStore((s) => s.logout);
  const { start: startTour } = useTourController();

  // Drives the "What's new" dot. Cheap by construction: the server answers from an hourly cache,
  // and staleTime keeps this tab from asking more than once per session anyway.
  const updates = useQuery({ queryKey: ["system", "updates"], queryFn: systemApi.updates, staleTime: 60 * 60 * 1000, enabled: Boolean(user) });
  // Keyed on the version this workspace is RUNNING, not the newest one GitHub knows about. Those
  // differ for days after a release — the tag is pushed later — and keying on the remote value
  // meant the dot stayed dark through exactly the upgrade it exists to announce.
  const unseenRelease = hasUnseenRelease(updates.data?.currentVersion);

  // Only ever shown when a super admin has explicitly granted this account more than one role
  // (the Users page) — the common case renders nothing here at all.
  const switchRole = useMutation({
    mutationFn: (role: RoleName) => authApi.switchRole(role),
    onSuccess: (updated) => {
      setUser(updated);
      // Every permission check in the app re-derives from this cached response, so cached pages
      // built under the old role (e.g. an admin-only list) must not be shown stale.
      queryClient.invalidateQueries();
      toast.success(`Switched to ${updated.role.replace("_", " ")}`);
    },
    onError: (err: any) => toast.error("Could not switch role", { description: err?.response?.data?.message ?? "Try again." })
  });

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
      {user && user.heldRoles.length > 1 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
            <Repeat className="h-3 w-3" /> Switch role
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={user.role}
            onValueChange={(value) => {
              if (value !== user.role) switchRole.mutate(value as RoleName);
            }}
          >
            {user.heldRoles.map((role) => (
              <DropdownMenuRadioItem key={role} value={role} disabled={switchRole.isPending}>
                {role.replace("_", " ")}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link to="/app/profile"><UserRound /> Profile</Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link to="/app/history"><FileClock /> My history</Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link to="/app/help"><CircleHelp /> Help &amp; how-to</Link>
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
  );
}
