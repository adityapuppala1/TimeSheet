/**
 * 7.0.0 kiosk / QR punch (apps/api/src/services/attendance-kiosk.service.ts has the rules).
 *
 *   KioskDevicesSection  Settings → Attendance → Kiosk: create a device (token shown once), rotate,
 *                        revoke, bind to a work site.
 *   KioskDisplayPage     /kiosk — PUBLIC. The device token is pasted once and kept on this device;
 *                        the page shows a QR that changes about every 30 seconds.
 *   KioskPunchPage       /app/attendance/kiosk-punch?c=… — the person's own phone, signed in. Runs
 *                        the face check first when the workspace requires it, then punches.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { CheckCircle2, KeyRound, MonitorSmartphone, RotateCw, ShieldOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { runInBackground } from "../../lib/run-in-background";
import { api } from "../../services/api";
import { attendanceApi } from "../../services/attendance-api";
import { FaceVerificationDialog } from "../FaceVerificationDialog";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Skeleton } from "../ui/skeleton";
import { toast } from "../ui/toaster";
import { sitesApi } from "./WorkSites";
import { CardError } from "./attendance-ui";

export interface KioskDevice {
  id: string;
  name: string;
  siteId: string | null;
  siteName: string | null;
  tokenHint: string;
  revoked: boolean;
  lastSeenAt: string | null;
}

export const kioskApi = {
  list: async () => (await api.get<{ items: KioskDevice[]; enabled: boolean }>("/attendance/admin/kiosks")).data,
  create: async (body: { name: string; siteId: string | null }) => (await api.post<{ kiosk: KioskDevice; token: string }>("/attendance/admin/kiosks", body)).data,
  update: async (id: string, body: { name?: string; siteId?: string | null }) => (await api.put<KioskDevice>(`/attendance/admin/kiosks/${id}`, body)).data,
  rotate: async (id: string) => (await api.post<{ kiosk: KioskDevice; token: string }>(`/attendance/admin/kiosks/${id}/rotate`)).data,
  revoke: async (id: string) => {
    await api.post(`/attendance/admin/kiosks/${id}/revoke`);
  },
  punch: async (body: { code: string; verificationId?: string | null }) =>
    (await api.post<{ created: boolean; workDate: string; punchInAt: string; kioskName: string; siteName: string | null }>("/attendance/kiosk/punch", body)).data
};

/** The kiosk device is not signed in: a plain client, no cookies, no 401 refresh redirect. */
const deviceClient = axios.create({ baseURL: api.defaults.baseURL, withCredentials: false });
export async function fetchKioskCode(token: string) {
  return (await deviceClient.get<{ code: string; nonce: string; refreshInMs: number; kioskName: string; siteName: string | null }>("/attendance/kiosk/device/code", { headers: { "X-Kiosk-Token": token } })).data;
}
/** Has the code on screen been used? A used code is dead for everyone, so the screen replaces it. */
export async function fetchKioskCodeUsed(token: string, nonce: string) {
  return (await deviceClient.get<{ used: boolean }>("/attendance/kiosk/device/code/used", { headers: { "X-Kiosk-Token": token }, params: { nonce } })).data.used;
}
/** How often the screen checks whether its code has been scanned. */
export const KIOSK_USED_POLL_MS = 3000;

/** Pure: the URL the QR carries — the punch page on this same host (the host IS the workspace). */
export function kioskPunchUrl(origin: string, code: string): string {
  return `${origin}/app/attendance/kiosk-punch?c=${encodeURIComponent(code)}`;
}

/** Pure: revoked / last seen / never connected. */
export function kioskStatusText(k: Pick<KioskDevice, "revoked" | "lastSeenAt">): string {
  if (k.revoked) return "Revoked";
  if (k.lastSeenAt) return `last seen ${new Date(k.lastSeenAt).toLocaleString()}`;
  return "never connected";
}

const KIOSKS_KEY = ["attendance-admin", "kiosks"] as const;
const TOKEN_STORE = "timesphere.kioskToken";
const serverMessage = (err: unknown, fallback: string) => (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

function readStoredToken(): string {
  try {
    return localStorage.getItem(TOKEN_STORE) ?? "";
  } catch {
    return "";
  }
}
function storeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_STORE, token);
    else localStorage.removeItem(TOKEN_STORE);
  } catch {
    /* storage blocked: the token lives for this page only */
  }
}

function TokenOnce({ token, onDone }: Readonly<{ token: string; onDone: () => void }>) {
  return (
    <Alert variant="warning">
      <KeyRound className="h-4 w-4" />
      <div className="grid min-w-0 gap-2">
        <p className="text-sm font-medium">Device token — shown once</p>
        <p className="text-sm">Open /kiosk on the kiosk device and paste this token. It is not stored anywhere you can see it again; rotate to get a new one.</p>
        <code className="break-all rounded bg-muted px-2 py-1 text-xs">{token}</code>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => runInBackground(navigator.clipboard?.writeText(token) ?? Promise.resolve())}>
            Copy
          </Button>
          <Button size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </Alert>
  );
}

export function KioskDevicesSection({ readOnly }: Readonly<{ readOnly: boolean }>) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: KIOSKS_KEY, queryFn: kioskApi.list });
  const sites = useQuery({ queryKey: ["attendance-admin", "sites"], queryFn: sitesApi.list });
  const [name, setName] = useState("");
  const [siteId, setSiteId] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const refresh = () => runInBackground(qc.invalidateQueries({ queryKey: KIOSKS_KEY }));
  const onError = (title: string) => (err: unknown) => toast.error(title, { description: serverMessage(err, "Try again.") });
  const create = useMutation({
    mutationFn: () => kioskApi.create({ name: name.trim(), siteId: siteId || null }),
    onSuccess: (r) => {
      setToken(r.token);
      setName("");
      refresh();
    },
    onError: onError("Could not add the kiosk")
  });
  const rotate = useMutation({ mutationFn: kioskApi.rotate, onSuccess: (r) => {
      setToken(r.token);
      refresh();
    }, onError: onError("Could not rotate the token") });
  const revoke = useMutation({ mutationFn: kioskApi.revoke, onSuccess: () => {
      toast.success("Kiosk revoked");
      refresh();
    }, onError: onError("Could not revoke the kiosk") });

  return (
    <div className="grid min-w-0 gap-4">
      <p className="text-sm text-muted-foreground">
        A kiosk is a screen at the door that shows a QR code. People scan it with their own phone while signed in. A kiosk bound to a work site counts as being at that site; face checks apply as for any punch.
      </p>
      {token && <TokenOnce token={token} onDone={() => setToken(null)} />}
      {list.isLoading && <Skeleton className="h-16 w-full" />}
      {list.isError && <CardError message="Kiosks could not be loaded." onRetry={() => runInBackground(list.refetch())} />}
      {list.data && list.data.items.length === 0 && <EmptyState compact icon={MonitorSmartphone} title="No kiosks yet" description="Add one, then open /kiosk on the device." />}
      {list.data && list.data.items.length > 0 && (
        <ul className="grid gap-2" aria-label="Kiosk devices">
          {list.data.items.map((k) => (
            <li key={k.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border p-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{k.name}</p>
                <p className="text-xs text-muted-foreground">
                  {k.siteName ? `At ${k.siteName}` : "No site"} · token {k.tokenHint}… · {kioskStatusText(k)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={readOnly || rotate.isPending} onClick={() => rotate.mutate(k.id)}>
                  <RotateCw className="mr-1 h-4 w-4" aria-hidden />
                  {k.revoked ? "Re-enable with new token" : "Rotate token"}
                </Button>
                {!k.revoked && (
                  <Button size="sm" variant="ghost" disabled={readOnly || revoke.isPending} onClick={() => revoke.mutate(k.id)}>
                    <ShieldOff className="mr-1 h-4 w-4" aria-hidden />
                    Revoke
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="grid gap-1">
            <Label htmlFor="kiosk-name">Name</Label>
            <Input id="kiosk-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Front door" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="kiosk-site">Work site</Label>
            <select id="kiosk-site" className="h-10 rounded-md border bg-background px-2 text-sm" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">No site</option>
              {(sites.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            Add kiosk
          </Button>
        </div>
      )}
    </div>
  );
}

function useQrDataUrl(text: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!text) return;
    import("qrcode")
      .then((qr) => qr.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: "M" }))
      .then((dataUrl) => live && setUrl(dataUrl))
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [text]);
  return url;
}

/** /kiosk — the device screen. */
export function KioskDisplayPage() {
  const [token, setToken] = useState(readStoredToken);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<{ code: string; kioskName: string; siteName: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!token) return;
    let live = true;
    const tick = () => {
      fetchKioskCode(token)
        .then((r) => {
          if (!live) return;
          setError(null);
          setState({ code: r.code, kioskName: r.kioskName, siteName: r.siteName });
          watch(r.nonce, Date.now() + Math.min(30_000, r.refreshInMs + 250));
        })
        .catch((err: unknown) => {
          if (!live) return;
          const status = (err as { response?: { status?: number } })?.response?.status;
          setError(serverMessage(err, "Cannot reach the server. Retrying…"));
          if (status === 401) {
            storeToken(null);
            setToken("");
            return;
          }
          timer.current = window.setTimeout(tick, 10_000);
        });
    };
    // Until the code rotates, ask every few seconds whether someone has used it; a used code is
    // refused for everyone else, so the next person needs a fresh one straight away.
    const watch = (nonce: string, rotateAt: number) => {
      const wait = rotateAt - Date.now();
      if (wait <= KIOSK_USED_POLL_MS) {
        timer.current = window.setTimeout(tick, Math.max(0, wait));
        return;
      }
      timer.current = window.setTimeout(() => {
        fetchKioskCodeUsed(token, nonce)
          .then((used) => {
            if (!live) return;
            if (used) tick();
            else watch(nonce, rotateAt);
          })
          .catch(() => {
            if (live) watch(nonce, rotateAt);
          });
      }, KIOSK_USED_POLL_MS);
    };
    tick();
    return () => {
      live = false;
      window.clearTimeout(timer.current);
    };
  }, [token]);

  const qr = useQrDataUrl(state ? kioskPunchUrl(window.location.origin, state.code) : null);

  if (!token) {
    return (
      <main className="mx-auto grid min-h-screen max-w-md content-center gap-4 p-4">
        <h1 className="text-xl font-semibold">Set up this kiosk</h1>
        {error && <Alert variant="destructive">{error}</Alert>}
        <p className="text-sm text-muted-foreground">Paste the device token an administrator created in Settings → Attendance → Kiosk.</p>
        <Label htmlFor="kiosk-token">Device token</Label>
        <Input id="kiosk-token" value={draft} onChange={(e) => setDraft(e.target.value.trim())} autoComplete="off" />
        <Button
          disabled={!draft}
          onClick={() => {
            storeToken(draft);
            setToken(draft);
          }}
        >
          Start kiosk
        </Button>
      </main>
    );
  }
  return (
    <main className="grid min-h-screen place-items-center gap-4 bg-background p-4 text-center">
      <div className="grid justify-items-center gap-3">
        <h1 className="text-2xl font-semibold">Scan to punch in</h1>
        <p className="text-muted-foreground">{state ? [state.kioskName, state.siteName].filter(Boolean).join(" · ") : "Loading…"}</p>
        {qr ? <img src={qr} alt="Punch-in QR code. Scan it with your phone's camera while signed in." className="h-[min(80vw,360px)] w-[min(80vw,360px)] rounded-lg bg-white p-2" /> : <Skeleton className="h-[min(80vw,360px)] w-[min(80vw,360px)]" />}
        <p className="text-sm text-muted-foreground">Use your own phone. The code changes every 30 seconds.</p>
        {error && (
          <p role="status" className="text-sm text-muted-foreground">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

/** /app/attendance/kiosk-punch?c=… — the person's phone. */
export function KioskPunchPage() {
  const [params] = useSearchParams();
  const code = params.get("c") ?? "";
  const today = useQuery({ queryKey: ["attendance", "me", "today"], queryFn: attendanceApi.myToday, enabled: Boolean(code) });
  const [faceOpen, setFaceOpen] = useState(false);
  const punch = useMutation({ mutationFn: (verificationId: string | null) => kioskApi.punch({ code, verificationId }) });

  const start = () => {
    if (today.data?.faceRequired) setFaceOpen(true);
    else punch.mutate(null);
  };

  if (!code) return <EmptyState icon={MonitorSmartphone} title="No kiosk code" description="Scan the QR code on the kiosk with your phone's camera." />;
  return (
    <div className="mx-auto grid max-w-md gap-4 p-4">
      <h1 className="text-xl font-semibold">Punch in at the kiosk</h1>
      {punch.isSuccess ? (
        <div role="status" aria-live="polite" className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" aria-hidden />
          <span>
            {punch.data.created ? "Punched in" : "Already punched in"} {new Date(punch.data.punchInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {punch.data.siteName ? ` · ${punch.data.siteName}` : ""}
          </span>
        </div>
      ) : (
        <>
          {punch.isError && <Alert variant="destructive">{serverMessage(punch.error, "Could not punch in. Scan the code again.")}</Alert>}
          <Button className="h-14 text-base" disabled={punch.isPending || today.isLoading} onClick={start}>
            Punch in
          </Button>
        </>
      )}
      <FaceVerificationDialog open={faceOpen} onOpenChange={setFaceOpen} context="PUNCH_IN" actionLabel="punch in" onVerified={(id) => {
          setFaceOpen(false);
          punch.mutate(id);
        }} />
    </div>
  );
}
