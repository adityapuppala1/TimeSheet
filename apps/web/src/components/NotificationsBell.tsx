/**
 * WHAT: the bell icon + popover showing the signed-in user's own in-app notifications, with
 * mark-read/mark-all-read actions.
 * WHY separate from the workspace notification *settings* page: this is purely "what's in my
 * inbox," backed by `controllers/notification.controller.ts`'s user-scoped routes — it has
 * nothing to do with which categories are allowed to email at all (that's SUPER_ADMIN-only,
 * configured elsewhere).
 * WHO renders this: `components/Topbar.tsx`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, MailOpen } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { toast } from "./ui/toaster";
import { notificationApi, type Notification } from "../services/api";
import { cn } from "../lib/utils";

function formatRelative(value: string) {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return date.toLocaleDateString();
}

export function NotificationsBell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: notificationApi.list,
    refetchInterval: 60_000,
    staleTime: 30_000
  });

  const markRead = useMutation({
    mutationFn: (id: string) => notificationApi.read(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] })
  });
  const markAll = useMutation({
    mutationFn: () => notificationApi.readAll(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
      toast.success("All caught up");
    }
  });

  const unread = data?.unread ?? 0;
  const items: Notification[] = data?.items ?? [];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute right-1 top-1 grid h-4 min-w-[1rem] place-items-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-4 py-3">
          <p className="text-sm font-bold">Notifications</p>
          {unread > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
              onClick={() => markAll.mutate()}
            >
              <CheckCheck className="h-3 w-3" /> Mark all read
            </button>
          )}
        </div>
        <Separator />
        <ScrollArea className="max-h-96">
          {items.length === 0 && (
            <div className="grid place-items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
              <MailOpen className="h-6 w-6" />
              You're all caught up.
            </div>
          )}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (!item.readAt) markRead.mutate(item.id);
                if (item.link) navigate(item.link);
              }}
              className={cn(
                "block w-full border-b border-border px-4 py-3 text-left transition hover:bg-muted last:border-b-0",
                !item.readAt && "bg-primary/5"
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 flex-1 break-words text-sm font-semibold">{item.title}</p>
                {!item.readAt && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />}
              </div>
              <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{item.body}</p>
              <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground/80">{formatRelative(item.createdAt)}</p>
            </button>
          ))}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
