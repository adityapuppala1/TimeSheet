/**
 * WHAT: a generic "upload a CSV, preview parsed rows, submit, see per-row results" dialog —
 * shared shell for every bulk-import feature in this app (bulk users, bulk projects/modules/
 * submodules, and any future one). Parsing happens client-side (papaparse) so a malformed file
 * is caught before it ever reaches the API — the backend only ever sees already-structured rows.
 * WHY one shared component instead of one per feature: the upload/preview/submit/results flow is
 * identical across every bulk-import feature — only the column list, sample data, and the
 * upload call differ, so those are the only things each caller passes in.
 */
import Papa from "papaparse";
import { Download, FileUp, Loader2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

export interface BulkUploadResult {
  row: number;
  success: boolean;
  error?: string;
  email?: string;
}

interface CsvBulkUploadDialogProps<TRow extends Record<string, string>> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  /** Column headers the CSV must have — also drives the preview table's columns. */
  columns: Array<{ key: keyof TRow & string; label: string; required?: boolean }>;
  /** Full sample-sheet content (instructions as leading `#` comment lines, then the real header
   *  row + example data) offered as a "Download sample" button. */
  sampleCsv: string;
  sampleFileName: string;
  /** Validates one parsed row before it's eligible for upload — return an error string to flag
   *  it in the preview (still shown, just not counted toward "N ready to upload"). */
  validateRow: (row: TRow) => string | null;
  onUpload: (rows: TRow[]) => Promise<{ results: BulkUploadResult[] }>;
  onUploaded?: () => void;
}

export function CsvBulkUploadDialog<TRow extends Record<string, string>>({
  open,
  onOpenChange,
  title,
  description,
  columns,
  sampleCsv,
  sampleFileName,
  validateRow,
  onUpload,
  onUploaded
}: CsvBulkUploadDialogProps<TRow>) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<TRow[]>([]);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [fileName, setFileName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<BulkUploadResult[] | null>(null);

  function reset() {
    setRows([]);
    setRowErrors({});
    setFileName(null);
    setResults(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleFile(file: File) {
    setFileName(file.name);
    setResults(null);
    Papa.parse<TRow>(file, {
      header: true,
      skipEmptyLines: true,
      // Comment lines (instructions in the sample sheet) start with # — real uploads built from
      // the sample by an end user may still have these leading rows if they didn't delete them.
      comments: "#",
      transformHeader: (h) => h.trim(),
      complete: (parsed) => {
        const parsedRows = parsed.data.filter((r) => Object.values(r).some((v) => String(v ?? "").trim().length > 0));
        const errors: Record<number, string> = {};
        parsedRows.forEach((row, i) => {
          const missing = columns.filter((c) => c.required && !String(row[c.key] ?? "").trim());
          if (missing.length > 0) {
            errors[i] = `Missing ${missing.map((c) => c.label).join(", ")}`;
            return;
          }
          const err = validateRow(row);
          if (err) errors[i] = err;
        });
        setRows(parsedRows);
        setRowErrors(errors);
      }
    });
  }

  async function handleSubmit() {
    setUploading(true);
    try {
      const validRows = rows.filter((_, i) => !rowErrors[i]);
      const response = await onUpload(validRows);
      setResults(response.results);
      onUploaded?.();
    } finally {
      setUploading(false);
    }
  }

  function downloadSample() {
    const blob = new Blob([sampleCsv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sampleFileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  const validCount = rows.length - Object.keys(rowErrors).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] w-[min(96vw,900px)] max-w-none overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={downloadSample}>
              <Download className="h-3.5 w-3.5" />Download sample CSV
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
              <FileUp className="h-3.5 w-3.5" />Choose file
            </Button>
            {fileName && <span className="text-xs text-muted-foreground">{fileName}</span>}
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
            />
          </div>

          {rows.length > 0 && !results && (
            <>
              <div className="flex items-center gap-2 text-sm">
                <Badge variant={validCount === rows.length ? "success" : "warning"}>
                  {validCount} of {rows.length} rows ready
                </Badge>
                {validCount < rows.length && <span className="text-xs text-muted-foreground">Rows with errors are skipped on upload.</span>}
              </div>
              <div className="max-h-80 overflow-auto rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      {columns.map((c) => (
                        <TableHead key={c.key}>{c.label}</TableHead>
                      ))}
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row, i) => (
                      <TableRow key={i} className={rowErrors[i] ? "bg-destructive/5" : undefined}>
                        <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                        {columns.map((c) => (
                          <TableCell key={c.key} className="text-sm">{row[c.key] || <span className="text-muted-foreground">—</span>}</TableCell>
                        ))}
                        <TableCell>
                          {rowErrors[i] ? (
                            <span className="text-xs text-destructive">{rowErrors[i]}</span>
                          ) : (
                            <Badge variant="success">Ready</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}

          {results && (
            <Alert>
              <AlertTitle>
                {results.filter((r) => r.success).length} of {results.length} rows imported
              </AlertTitle>
              <AlertDescription>
                <div className="mt-2 grid max-h-60 gap-1 overflow-y-auto">
                  {results
                    .filter((r) => !r.success)
                    .map((r) => (
                      <p key={r.row} className="text-xs text-destructive">
                        Row {r.row + 1}{r.email ? ` (${r.email})` : ""}: {r.error}
                      </p>
                    ))}
                </div>
              </AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {!results && (
            <Button type="button" disabled={validCount === 0 || uploading} onClick={handleSubmit}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload {validCount > 0 ? validCount : ""} row{validCount === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
