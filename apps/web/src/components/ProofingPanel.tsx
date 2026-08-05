/**
 * WHAT: proofing — click a spot on an attached image and leave a comment pinned to it.
 *
 * WHY THIS EXISTS SEPARATELY FROM COMMENTS: a review comment on a design says "the padding is
 * wrong"; the reply is "which padding?". A pin removes that round trip entirely. It is the whole
 * value of the feature, so the pin has to be exact and it has to survive a different screen.
 *
 * COORDINATES ARE NORMALISED 0-1, matching the API. The click handler divides by the rendered
 * box's own size, so the same annotation lands on the same spot on a phone, on a 4K monitor and
 * in a PDF export — three different render sizes. Storing pixels would store whichever viewport
 * happened to be open when someone clicked, and every other viewer would see the pin elsewhere.
 * The image is `object-contain` inside a fixed-aspect frame for the same reason: the box being
 * measured must be the box the image actually occupies, or every pin drifts by the letterboxing.
 *
 * WHY IMAGES ONLY, FOR NOW: the API accepts a `pageIndex` for PDFs, but rendering a PDF page in
 * the browser needs a worker bundle, and a proofing UI that half-renders a PDF is worse than one
 * that says plainly it does not do PDFs yet. Non-image attachments are listed as unsupported
 * rather than hidden — hiding them reads as "this file has no comments", which is a different
 * claim from "this file cannot take comments".
 *
 * WHY RESOLVE IS A TOGGLE AND NOT A DELETE: matching the API's reasoning — a resolved note is the
 * record of a review round, and deleting it loses why a change was made.
 */
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MessageSquarePlus, Trash2, Undo2 } from "lucide-react";
import { toast } from "./ui/toaster";

import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { Textarea } from "./ui/textarea";
import { usePlanningFeatures } from "../lib/use-planning";
import { fileUrl, proofApi, type ProofAnnotationRow, type TicketAttachmentRow } from "../services/api";

// Local rather than imported from Tickets.tsx: this panel is rendered BY that page, so importing
// back into it would close an import cycle. Same one-liner the approvals panel keeps for the same
// reason.
const serverMessage = (err: any, fallback: string) => err?.response?.data?.message ?? fallback;

const IMAGE_TYPES = /^image\//i;

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function authorLabel(a: ProofAnnotationRow) {
  return a.author?.name ?? a.guestEmail ?? "Someone";
}

export function ProofingPanel({ attachments }: { attachments: TicketAttachmentRow[] }) {
  const { features } = usePlanningFeatures();
  const queryClient = useQueryClient();

  const images = useMemo(() => attachments.filter((a) => IMAGE_TYPES.test(a.mimeType)), [attachments]);
  const unsupported = attachments.length - images.length;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = images.find((a) => a.id === selectedId) ?? images[0] ?? null;

  // A pin being placed but not yet saved. Held separately from the saved list so an abandoned
  // click leaves nothing behind.
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const frameRef = useRef<HTMLDivElement | null>(null);

  const annotations = useQuery({
    queryKey: ["proofs", selected?.id],
    queryFn: () => proofApi.list(selected!.id),
    enabled: Boolean(selected?.id) && features.proofing
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["proofs", selected?.id] });
  }

  const add = useMutation({
    mutationFn: (payload: { x: number; y: number; body: string; parentId?: string | null }) =>
      proofApi.add(selected!.id, payload),
    onSuccess: () => {
      setDraft(null);
      setDraftBody("");
      setReplyBody("");
      refresh();
    },
    onError: (err: any) => toast.error("Could not add the comment", { description: serverMessage(err, "Try again.") })
  });

  const resolve = useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) => proofApi.resolve(id, resolved),
    onSuccess: refresh,
    onError: (err: any) => toast.error("Could not update", { description: serverMessage(err, "Try again.") })
  });

  const remove = useMutation({
    mutationFn: (id: string) => proofApi.remove(id),
    onSuccess: () => {
      setOpenThreadId(null);
      refresh();
    },
    onError: (err: any) => toast.error("Could not delete", { description: serverMessage(err, "Try again.") })
  });

  if (!features.proofing) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center">
        <MessageSquarePlus className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">Proofing isn&apos;t switched on</p>
        <p className="mt-1 text-xs text-muted-foreground">
          A super admin can enable it in Workspace Settings → Planning. Ordinary file comments are unaffected.
        </p>
      </div>
    );
  }

  if (images.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center">
        <MessageSquarePlus className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 text-sm font-medium">No image to review</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {unsupported > 0
            ? `Attach a PNG, JPG or WebP to pin comments to it. ${unsupported} attached file(s) can't take pins yet — PDFs are not supported here.`
            : "Attach a PNG, JPG or WebP to pin comments to it."}
        </p>
      </div>
    );
  }

  /** Turn a click anywhere on the frame into normalised coordinates. */
  function placePin(event: React.MouseEvent<HTMLDivElement>) {
    const box = frameRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    // Clamped rather than rejected, matching the API: a click a pixel outside is a click on it.
    const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    setDraft({ x, y });
    setOpenThreadId(null);
  }

  const roots = annotations.data ?? [];
  const openThread = roots.find((r) => r.id === openThreadId) ?? null;

  return (
    <div className="grid gap-3">
      {images.length > 1 && (
        <div className="flex max-w-full flex-wrap gap-1.5 overflow-x-auto">
          {images.map((a) => (
            <Button
              key={a.id}
              size="sm"
              variant={selected?.id === a.id ? "default" : "outline"}
              className="shrink-0"
              onClick={() => {
                setSelectedId(a.id);
                setDraft(null);
                setOpenThreadId(null);
              }}
            >
              <span className="max-w-[12rem] truncate">{a.fileName}</span>
            </Button>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Click anywhere on the image to pin a comment to that spot.
      </p>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        {/* The frame IS the measured box, so `object-contain` letterboxing can't shift a pin. */}
        <div
          ref={frameRef}
          onClick={placePin}
          className="relative aspect-video w-full cursor-crosshair overflow-hidden rounded-lg border border-border bg-muted/40"
        >
          {selected && (
            <img
              src={fileUrl(selected.url)}
              alt={selected.fileName}
              className="pointer-events-none h-full w-full object-contain"
            />
          )}

          {roots.map((a, i) => (
            <button
              key={a.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setDraft(null);
                setOpenThreadId(a.id === openThreadId ? null : a.id);
              }}
              style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }}
              className={`absolute grid h-6 w-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 text-[11px] font-semibold shadow-sm transition ${
                a.resolvedAt
                  ? "border-border bg-muted text-muted-foreground"
                  : "border-background bg-primary text-primary-foreground"
              } ${openThreadId === a.id ? "ring-2 ring-ring" : ""}`}
              title={`${authorLabel(a)}: ${a.body.slice(0, 60)}`}
            >
              {i + 1}
            </button>
          ))}

          {draft && (
            <span
              style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%` }}
              className="absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full border-2 border-dashed border-primary bg-primary/20"
            />
          )}
        </div>

        <div className="grid content-start gap-2">
          {draft && (
            <div className="grid gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
              <p className="text-xs font-medium">New comment at this pin</p>
              <Textarea
                autoFocus
                rows={3}
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                placeholder="What needs changing here?"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={!draftBody.trim() || add.isPending}
                  onClick={() => add.mutate({ x: draft.x, y: draft.y, body: draftBody.trim() })}
                >
                  Add comment
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setDraftBody(""); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {annotations.isLoading && <Skeleton className="h-24 w-full" />}

          {!annotations.isLoading && roots.length === 0 && !draft && (
            <p className="text-sm text-muted-foreground">No pinned comments on this file yet.</p>
          )}

          {roots.map((a, i) => (
            <div
              key={a.id}
              className={`grid gap-2 rounded-lg border p-3 text-sm transition ${
                openThreadId === a.id ? "border-primary/50 bg-primary/5" : "border-border"
              }`}
            >
              <button type="button" className="grid gap-1 text-left" onClick={() => setOpenThreadId(a.id === openThreadId ? null : a.id)}>
                <span className="flex items-center gap-2">
                  <Badge variant={a.resolvedAt ? "muted" : "default"} className="h-5 shrink-0 px-1.5">{i + 1}</Badge>
                  <Avatar className="h-5 w-5">
                    <AvatarImage src={a.author?.avatarUrl ?? undefined} />
                    <AvatarFallback className="text-[10px]">{initials(authorLabel(a))}</AvatarFallback>
                  </Avatar>
                  <span className="truncate text-xs font-medium">{authorLabel(a)}</span>
                  {a.resolvedAt && <span className="ml-auto text-[11px] text-muted-foreground">Resolved</span>}
                </span>
                <span className="whitespace-pre-wrap break-words">{a.body}</span>
              </button>

              {(a.replies?.length ?? 0) > 0 && (
                <div className="grid gap-1.5 border-l-2 border-border pl-2">
                  {a.replies!.map((r) => (
                    <div key={r.id} className="text-xs">
                      <span className="font-medium">{authorLabel(r)}</span>{" "}
                      <span className="whitespace-pre-wrap break-words text-muted-foreground">{r.body}</span>
                    </div>
                  ))}
                </div>
              )}

              {openThread?.id === a.id && (
                <div className="grid gap-2">
                  <Textarea
                    rows={2}
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                    placeholder="Reply…"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      disabled={!replyBody.trim() || add.isPending}
                      onClick={() => add.mutate({ x: a.x, y: a.y, body: replyBody.trim(), parentId: a.id })}
                    >
                      Reply
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resolve.mutate({ id: a.id, resolved: !a.resolvedAt })}
                    >
                      {a.resolvedAt ? <><Undo2 className="h-3.5 w-3.5" />Reopen</> : <><Check className="h-3.5 w-3.5" />Resolve</>}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove.mutate(a.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
