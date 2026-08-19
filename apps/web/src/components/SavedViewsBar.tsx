/**
 * WHAT: saved views — name the filter set you keep re-typing, and get it back in one click.
 *
 * WHY IT SAVES THE FILTERS AND NOT THE RESULTS: a view is a QUESTION ("my team's open criticals"),
 * not an answer. Storing rows would mean a shared view showing a colleague work they cannot open,
 * and going stale the moment anything changed. Because it stores the question, applying one still
 * runs every normal project-scope check on the server — which is what makes SHARED safe, and why
 * sharing needs only `dashboards:share` rather than any data-granting right.
 *
 * WHY SCOPE IS A TWO-WAY CHOICE AND NOT A SHARE DIALOG: the decision is binary and made once, at
 * save time. A dialog implies picking recipients, which would suggest the view carries data to
 * them. It does not.
 *
 * WHY THE VIEW TYPE IS PART OF THE ROW: a filter set that makes sense on a board ("group by
 * status") is meaningless on a timeline. Views are listed for the mode you are actually in, so
 * the picker never offers something that cannot be applied.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookmarkPlus, Check, Trash2, Users } from "lucide-react";
import { permissions } from "@timesheet/shared";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";
import { toast } from "./ui/toaster";
import { usePlanningFeatures } from "../lib/use-planning";
import { planApi, type SavedViewRow } from "../services/api";
import { useAuthStore } from "../store/auth";

const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

/**
 * The Tickets page's filter state, saved verbatim into a saved view.
 *
 * VIEWS SAVED BEFORE A FIELD EXISTED still apply cleanly: `Tickets.tsx` merges what it reads over
 * the default shape rather than replacing state with it, so an older view carrying the retired
 * `labelId` simply contributes nothing and the newer axes keep their "all" default instead of
 * becoming `undefined` and filtering on the string "undefined".
 */
export type TicketFilters = {
  projectId: string;
  status: string;
  priority: string;
  type: string;
  reporterId: string;
  onlyMine: boolean;
};

const VIEW_TYPE: Record<string, SavedViewRow["viewType"]> = {
  list: "LIST",
  board: "BOARD",
  timeline: "TIMELINE",
  calendar: "CALENDAR"
};

export function SavedViewsBar({
  viewMode,
  filters,
  onApply
}: {
  viewMode: keyof typeof VIEW_TYPE;
  filters: TicketFilters;
  onApply: (filters: TicketFilters) => void;
}) {
  const { features } = usePlanningFeatures();
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const canShare = Boolean(user?.permissions.includes(permissions.DASHBOARDS_SHARE));

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);

  const viewType = VIEW_TYPE[viewMode];

  const views = useQuery({
    queryKey: ["plan", "views"],
    queryFn: planApi.listViews,
    enabled: features.planning
  });

  const create = useMutation({
    mutationFn: () =>
      planApi.createView({
        name: name.trim(),
        viewType,
        scope: shared ? "SHARED" : "PERSONAL",
        filters: filters as unknown as Record<string, unknown>
      }),
    onSuccess: () => {
      setName("");
      setShared(false);
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["plan", "views"] });
      toast.success("View saved");
    },
    onError: (err: any) => toast.error("Could not save the view", { description: serverMessage(err, "Try again.") })
  });

  const remove = useMutation({
    mutationFn: (id: string) => planApi.deleteView(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["plan", "views"] }),
    onError: (err: any) => toast.error("Could not delete", { description: serverMessage(err, "Try again.") })
  });

  // Off entirely when planning is off, so a workspace that never enabled it sees today's page.
  if (!features.planning) return null;

  const mine = (views.data ?? []).filter((v) => v.viewType === viewType);

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
      {mine.map((v) => (
        <span key={v.id} className="group inline-flex shrink-0 items-center">
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-r-none pr-2"
            onClick={() => {
              onApply({ ...(v.filters as unknown as TicketFilters) });
              toast.success(`Applied "${v.name}"`);
            }}
          >
            {v.scope === "SHARED" && <Users className="h-3 w-3 text-muted-foreground" />}
            <span className="max-w-[10rem] truncate">{v.name}</span>
          </Button>
          {v.ownerId === user?.id && (
            <Button
              size="icon"
              variant="outline"
              className="h-8 w-8 rounded-l-none border-l-0 text-muted-foreground hover:text-destructive"
              title={`Delete "${v.name}"`}
              onClick={() => remove.mutate(v.id)}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </span>
      ))}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" className="h-8 shrink-0 text-muted-foreground">
            <BookmarkPlus className="h-3.5 w-3.5" />
            Save view
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="grid w-72 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="saved-view-name">Name this view</Label>
            <Input
              id="saved-view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My team's open criticals"
            />
            <p className="text-xs text-muted-foreground">
              Saves the filters currently applied, not the results — so it stays right as work moves.
            </p>
          </div>
          {canShare && (
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="saved-view-shared" className="text-sm font-normal">
                Share with the workspace
              </Label>
              <Switch id="saved-view-shared" checked={shared} onCheckedChange={setShared} />
            </div>
          )}
          <Button size="sm" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            <Check className="h-3.5 w-3.5" />
            Save
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
