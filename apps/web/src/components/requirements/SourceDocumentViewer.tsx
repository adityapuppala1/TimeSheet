/**
 * WHAT: previews the uploaded PRD/BRD, choosing the viewer that fits the file rather than showing
 * everything as plain text.
 *
 *   PDF       → the browser's own viewer, over the real bytes. Nothing renders a PDF better, and
 *               anything we built would be a worse copy of it.
 *   Word      → the server converts it with `mammoth`, so headings, lists, bold and tables survive
 *               — the difference between "a wall of text" and "the document".
 *   Text / MD → rendered through the same rich renderer the rest of the app's AI content uses, so
 *               a markdown spec looks like a spec.
 *   No stored file → the extracted text, with a line saying so. Documents imported before the
 *               original was kept still preview rather than erroring.
 *
 * The server decides which of those applies (it knows the extension and did the conversion); this
 * component just mounts the right thing. That keeps the decision in one place instead of split
 * across a filename check here and a conversion there.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Info } from "lucide-react";
import { AiRichContent } from "../ui/ai-rich-content";
import { Skeleton } from "../ui/skeleton";
import { safeHtml } from "../../lib/safe-html";
import { requirementsDocApi } from "../../services/api";

/** The .docx conversion's own prose styling — mammoth emits a small fixed tag vocabulary, and this
 *  gives it the same typography the rest of the app's rendered content has. */
const DOCX_PROSE = [
  "prose-sm max-w-none break-words text-sm leading-relaxed",
  "[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-bold",
  "[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-bold",
  "[&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold",
  "[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
  "[&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left"
].join(" ");

/** The PDF viewer. The bytes come through the API client (the access token lives in memory, so a
 *  bare `src` URL would be unauthenticated), become an object URL, and get revoked on unmount —
 *  without that a few previews leak the whole file each into the tab's memory. */
function PdfPreview({ docId }: { docId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    requirementsDocApi
      .sourceFileBlob(docId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [docId]);

  if (failed) return <p className="text-sm text-muted-foreground">That file could not be loaded — it may have been removed from storage.</p>;
  if (!url) return <Skeleton className="h-[60vh] w-full" />;
  // `title` is what a screen reader announces for the frame; without it this is an unlabelled
  // region. Sandboxed on the server side too via the response's own CSP header.
  return <iframe src={url} title="Uploaded document" className="h-[60vh] w-full rounded-md border border-border" />;
}

export function SourceDocumentViewer({ docId, enabled }: { docId: string; enabled: boolean }) {
  const view = useQuery({
    queryKey: ["requirements-docs", docId, "source-view"],
    queryFn: () => requirementsDocApi.sourceView(docId),
    enabled
  });

  if (view.isLoading) return <Skeleton className="h-64 w-full" />;
  if (view.isError || !view.data) {
    return <p className="text-sm text-muted-foreground">Could not load this document.</p>;
  }

  const data = view.data;

  return (
    <div className="grid gap-2">
      {!data.hasOriginalFile && (
        // Said plainly rather than implied: this is what the AI read, not the file itself.
        <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This document was imported before the original file was kept, so only the extracted text is available — formatting,
          images and layout aren&rsquo;t shown.
        </p>
      )}

      {data.kind === "pdf" && <PdfPreview docId={docId} />}

      {data.kind === "html" && (
        <div
          className={`max-h-[60vh] overflow-auto rounded-md border border-border p-4 ${DOCX_PROSE}`}
          // Converted by mammoth (a small fixed tag vocabulary, no scripts or styles) and still run
          // through the app's sanitizer — two layers, because somebody else wrote this file.
          dangerouslySetInnerHTML={safeHtml(data.html ?? "")}
        />
      )}

      {(data.kind === "markdown" || data.kind === "text") &&
        (data.text?.trim() ? (
          <div className="max-h-[60vh] overflow-auto rounded-md border border-border p-4">
            {data.kind === "markdown" ? (
              <AiRichContent content={data.text} />
            ) : (
              <pre className="whitespace-pre-wrap text-xs leading-relaxed">{data.text}</pre>
            )}
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <FileText className="h-4 w-4" />
            Nothing readable was stored for this document.
          </p>
        ))}
    </div>
  );
}
