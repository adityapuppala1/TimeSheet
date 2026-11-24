/**
 * 7.0.0 work sites (Workspace settings → Attendance → Work sites): named circles a punch is matched
 * against, so attendance says "At Head office" or "Outside work sites" — never a coordinate. The
 * centre is typed as numbers, or taken from the admin's own device with "Use my current location"
 * (here only: nobody else's location is ever read to build a site).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LocateFixed, MapPin, Trash2 } from "lucide-react";
import { useState } from "react";
import { runInBackground } from "../../lib/run-in-background";
import { api } from "../../services/api";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toaster";
import { CardError } from "./attendance-ui";

export interface WorkSite {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusM: number;
  enabled: boolean;
}

type SiteInput = Omit<WorkSite, "id">;

export const sitesApi = {
  list: async () => (await api.get<{ sites: WorkSite[] }>("/attendance/admin/sites")).data.sites,
  create: async (body: SiteInput) => (await api.post<WorkSite>("/attendance/admin/sites", body)).data,
  update: async (id: string, body: SiteInput) => (await api.put<WorkSite>(`/attendance/admin/sites/${id}`, body)).data,
  remove: async (id: string) => {
    await api.delete(`/attendance/admin/sites/${id}`);
  }
};

const SITES_KEY = ["attendance-admin", "sites"] as const;
const serverMessage = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

/** Why the draft cannot be saved, or null. Pure. */
export function siteDraftProblem(d: { name: string; latitude: string; longitude: string; radiusM: string }): string | null {
  if (!d.name.trim()) return "Give the site a name.";
  const lat = Number(d.latitude);
  const lng = Number(d.longitude);
  const r = Number(d.radiusM);
  if (d.latitude.trim() === "" || !Number.isFinite(lat) || lat < -90 || lat > 90) return "Latitude must be a number from -90 to 90.";
  if (d.longitude.trim() === "" || !Number.isFinite(lng) || lng < -180 || lng > 180) return "Longitude must be a number from -180 to 180.";
  if (!Number.isInteger(r) || r < 25 || r > 50_000) return "Radius must be whole metres from 25 to 50000.";
  return null;
}

const EMPTY = { name: "", latitude: "", longitude: "", radiusM: "200" };

export function WorkSitesSection({ readOnly }: Readonly<{ readOnly: boolean }>) {
  const qc = useQueryClient();
  const sites = useQuery({ queryKey: SITES_KEY, queryFn: sitesApi.list });
  const [draft, setDraft] = useState(EMPTY);
  const [locating, setLocating] = useState(false);
  const refresh = () => runInBackground(qc.invalidateQueries({ queryKey: SITES_KEY }));
  const create = useMutation({
    mutationFn: () => sitesApi.create({ name: draft.name.trim(), latitude: Number(draft.latitude), longitude: Number(draft.longitude), radiusM: Number(draft.radiusM), enabled: true }),
    onSuccess: () => {
      toast.success("Work site added");
      setDraft(EMPTY);
      refresh();
    },
    onError: (err) => toast.error("Could not add the site", { description: serverMessage(err, "Try again.") })
  });
  const toggle = useMutation({
    mutationFn: (s: WorkSite) => sitesApi.update(s.id, { name: s.name, latitude: s.latitude, longitude: s.longitude, radiusM: s.radiusM, enabled: !s.enabled }),
    onSuccess: refresh,
    onError: (err) => toast.error("Could not update the site", { description: serverMessage(err, "Try again.") })
  });
  const remove = useMutation({
    mutationFn: (id: string) => sitesApi.remove(id),
    onSuccess: () => {
      toast.success("Work site removed");
      refresh();
    },
    onError: (err) => toast.error("Could not remove the site", { description: serverMessage(err, "Try again.") })
  });

  const fillFromMyLocation = () => {
    if (!navigator.geolocation) {
      toast.error("This browser cannot share a location");
      return;
    }
    setLocating(true);
    // Only on the admin's click, to fill in a site's centre; nobody else's location is read here.
    // eslint-disable-next-line sonarjs/no-intrusive-permissions
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setDraft((d) => ({ ...d, latitude: pos.coords.latitude.toFixed(6), longitude: pos.coords.longitude.toFixed(6) }));
      },
      () => {
        setLocating(false);
        toast.error("Could not read your location", { description: "Allow location access, or type the numbers in." });
      },
      { enableHighAccuracy: true, timeout: 15_000 }
    );
  };

  const problem = siteDraftProblem(draft);
  const disabled = readOnly;
  return (
    <div className="grid min-w-0 gap-4">
      <p className="text-sm text-muted-foreground">
        A punch with a location is matched to the nearest site whose circle contains it, and shows as “At &lt;site&gt;” or “Outside work sites”. People and managers see only that label.
      </p>
      {sites.isLoading && <Skeleton className="h-16 w-full" />}
      {sites.isError && <CardError message="Work sites could not be loaded." onRetry={() => runInBackground(sites.refetch())} />}
      {sites.data && sites.data.length === 0 && <EmptyState compact icon={MapPin} title="No work sites yet" description="Without sites, punches keep their usual labels." />}
      {sites.data && sites.data.length > 0 && (
        <ul className="grid gap-2" aria-label="Work sites">
          {sites.data.map((s) => (
            <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-border p-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium">{s.name}</p>
                <p className="text-xs text-muted-foreground">
                  {s.radiusM} m radius{s.enabled ? "" : " · paused"}
                </p>
              </div>
              <Switch aria-label={`Use ${s.name}`} checked={s.enabled} disabled={disabled || toggle.isPending} onCheckedChange={() => toggle.mutate(s)} />
              <Button variant="ghost" size="sm" className="min-h-[44px] sm:min-h-8" aria-label={`Remove ${s.name}`} disabled={disabled || remove.isPending} onClick={() => remove.mutate(s.id)}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="grid min-w-0 gap-3 rounded-lg border border-border p-3">
          <p className="text-sm font-medium">Add a site</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid min-w-0 gap-1.5 sm:col-span-2">
              <Label htmlFor="site-name">Name</Label>
              <Input id="site-name" maxLength={120} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Head office" />
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="site-lat">Latitude</Label>
              <Input id="site-lat" inputMode="decimal" value={draft.latitude} onChange={(e) => setDraft({ ...draft, latitude: e.target.value })} placeholder="12.971600" />
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="site-lng">Longitude</Label>
              <Input id="site-lng" inputMode="decimal" value={draft.longitude} onChange={(e) => setDraft({ ...draft, longitude: e.target.value })} placeholder="77.594600" />
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="site-radius">Radius (metres)</Label>
              <Input id="site-radius" type="number" min={25} max={50000} step={1} value={draft.radiusM} onChange={(e) => setDraft({ ...draft, radiusM: e.target.value })} />
            </div>
            <div className="flex items-end">
              <Button type="button" variant="outline" className="min-h-[44px] w-full sm:w-auto" disabled={locating} onClick={fillFromMyLocation}>
                <LocateFixed className="mr-2 h-4 w-4" aria-hidden="true" />
                {locating ? "Finding you…" : "Use my current location"}
              </Button>
            </div>
          </div>
          {problem && draft.name && <p className="text-xs text-muted-foreground">{problem}</p>}
          <Button className="min-h-[44px] justify-self-start" disabled={Boolean(problem) || create.isPending} onClick={() => create.mutate()}>
            Add site
          </Button>
        </div>
      )}
    </div>
  );
}
