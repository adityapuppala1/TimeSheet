/**
 * WHAT: the bell icon + popover showing the signed-in user's own in-app notifications, with
 * mark-read/mark-all-read actions.
 * WHY separate from the workspace notification *settings* page: this is purely "what's in my
 * inbox," backed by `controllers/notification.controller.ts`'s user-scoped routes — it has
 * nothing to do with which categories are allowed to email at all (that's SUPER_ADMIN-only,
 * configured elsewhere).
 * WHO renders this: `components/Topbar.tsx`.
 *
 * A notification WITH a link is a real `<Link>`, not a button that calls `navigate()`: it opens in a
 * new tab, reads as a link to a screen reader, and leaves no promise floating. Opening one closes
 * the popover — it is uncontrolled by default and would otherwise sit over the page it opened.
 * Read state is shared with the Inbox, so both caches refresh together (lib/notification-queries.ts).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, MailOpen } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "./ui/button";
import { EmptyState } from "./ui/empty-state";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { ScrollArea } from "./ui/scroll-area";
import { Separator } from "./ui/separator";
import { toast } from "./ui/toaster";
import { notificationApi, type Notification } from "../services/api";
import { refreshNotificationQueries } from "../lib/notification-queries";
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
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: notificationApi.list,
    refetchInterval: 60_000,
    staleTime: 30_000
  });

  const markRead = useMutation({
    mutationFn: (id: string) => notificationApi.read(id),
    onSuccess: () => refreshNotificationQueries(queryClient),
    onError: () => toast.error("Couldn't mark that as read", { description: "It is still unread — try again in a moment." })
  });
  const markAll = useMutation({
    mutationFn: () => notificationApi.readAll(),
    // Awaited, so "All caught up" appears once the badge has actually cleared.
    onSuccess: async () => {
      await refreshNotificationQueries(queryClient);
      toast.success("All caught up");
    },
    onError: () => toast.error("Couldn't mark everything as read", { description: "Nothing was changed — try again in a moment." })
  });

  const unread = data?.unread ?? 0;
  const items: Notification[] = data?.items ?? [];
  const markIfUnread = (item: Notification) => {
    if (!item.readAt) markRead.mutate(item.id);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* The label carries the count: it replaces the button's content for a screen reader, which
            otherwise heard "Notifications" whatever the badge said. */}
        <Button variant="ghost" size="icon" aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"} className="relative">
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
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline disabled:opacity-60"
              onClick={() => markAll.mutate()}
              disabled={markAll.isPending}
            >
              <CheckCheck className="h-3 w-3" /> Mark all read
            </button>
          )}
        </div>
        <Separator />
        <ScrollArea className="max-h-96">
          {items.length === 0 && (
            <EmptyState compact icon={MailOpen} title="You're all caught up" className="m-2" />
          )}
          {items.map((item) => {
            const className = cn(
              "block w-full border-b border-border px-4 py-3 text-left transition hover:bg-muted last:border-b-0",
              !item.readAt && "bg-primary/5"
            );
            const content = (
              <>
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 break-words text-sm font-semibold">{item.title}</p>
                  {!item.readAt && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />}
                </div>
                <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{item.body}</p>
                <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground/80">{formatRelative(item.createdAt)}</p>
              </>
            );
            return item.link ? (
              <Link
                key={item.id}
                to={item.link}
                className={className}
                onClick={() => {
                  markIfUnread(item);
                  setOpen(false);
                }}
              >
                {content}
              </Link>
            ) : (
              <button key={item.id} type="button" className={className} onClick={() => markIfUnread(item)}>
                {content}
              </button>
            );
          })}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
